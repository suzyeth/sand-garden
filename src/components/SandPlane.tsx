import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { sandField } from '../sim/sandField';
import { SHADER_STONES, SHADER_STONE_COUNT } from '../sim/stones';
import {
  SAND_SIZE,
  SAND_THICKNESS,
  EARTH_DEPTH,
} from '../sim/constants';
import { useStore } from '../sim/store';

/**
 * The sand garden floor.
 *
 * Three layers stacked along Y:
 *   1. A flat physics cuboid (also visible as the sand body's sides) -
 *      this is what the robot rolls on. Top at Y = 0.
 *   2. A flat shader plane just barely above (Y = 0.001) whose fragment
 *      shader samples the sandField height texture and darkens diffuse
 *      colour where height is low. This is where the visible "rake
 *      grooves" appear. Geometry is FLAT - no displacement - which
 *      keeps things z-fighting-free and avoids needing to recompute
 *      normals. The visual depth illusion comes from colour darkening
 *      alone, which is plenty given the iso lighting.
 *   3. The brown earth block underneath, purely cosmetic, gives the
 *      lifted diorama silhouette in the iso view.
 *
 * The diffusion + drift sim ticks at 10Hz from this component's
 * useFrame; the actual etching is driven by the robot in Robot.tsx.
 */

const SIZE = SAND_SIZE;
const SAND_TOP_Y = 0.0;

// Sand decay parameters.
// Diffusion off so 5-tooth lines stay crisp; drift slow so fresh
// trails linger for several minutes before fading back into the bg.
const DIFFUSE_RATE = 0;
const DRIFT_RATE = 0.00075; // exponential decay, half-life ~92s
const SIM_INTERVAL_SEC = 0.1;

// Heightfield gradient shading. The trail wants to read as karesansui
// gravel grooves (crisp, ordered) rather than soft loose-sand
// depressions, so we crank the relief amplitude and let the slope-
// shading clamp to a fairly contrasty range. GRID_RES is in lockstep
// with sandField.GRID_SIZE.
const GRID_RES = 1024;
const SHADING_AMP = 38.0;
const SHADING_MIN = -0.55;
const SHADING_MAX = 0.42;
const DEPRESSION_TINT = 0.12;

// PROCEDURAL BG KARESANSUI PATTERN (always visible)
// Concentric ripples DOMINATE near stones, parallel fills the rest.
// Where a stone has any meaningful influence, parallel is fully
// suppressed so the two layers don't interfere visually.
const BG_FREQ_PER_METRE = 4.5;
const BG_WIGGLE = 1.6;
const BG_SHARPNESS = 0.7;
const BG_LIGHT_STRENGTH = 0.18;
const BG_DARK_STRENGTH = 0.4;
const RIPPLE_EXTENT_M = 3.2; // tuned so no stone's outer ring clips the wall
const CONCENTRIC_BOOST = 1.3; // amplify concentric so it doesn't look weaker than parallel

export function SandPlane() {
  const heightTexture = sandField.texture;
  const simAcc = useRef(0);
  const bgEnabledUniform = useRef<{ value: number }>({ value: 1.0 });
  const showGarden = useStore((s) => s.showGarden);

  // Push the React-side showGarden state into the shader uniform on change.
  useEffect(() => {
    bgEnabledUniform.current.value = showGarden ? 1.0 : 0.0;
  }, [showGarden]);

  useFrame((_, dt) => {
    simAcc.current += dt;
    if (simAcc.current > SIM_INTERVAL_SEC) {
      sandField.diffuse(DIFFUSE_RATE);
      sandField.drift(DRIFT_RATE);
      simAcc.current = 0;
    }
    // mark dirty every frame so the robot's continuous etches show
    // without waiting for the next sim step
    sandField.upload();
  });

  /**
   * MeshStandardMaterial with a tiny fragment-shader injection that
   * reads our heightmap and modulates the diffuse colour.
   *
   * We deliberately use Three's standard material (rather than a fully
   * custom ShaderMaterial) so we keep PBR lighting, shadows, and fog
   * for free - we only override the colour computation.
   */
  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: '#d2d4c8',
      roughness: 1.0,
    });

    m.onBeforeCompile = (shader) => {
      shader.uniforms.uSandData = { value: heightTexture };
      shader.uniforms.uTexel = { value: 1 / GRID_RES };
      shader.uniforms.uShadingAmp = { value: SHADING_AMP };
      shader.uniforms.uShadingMin = { value: SHADING_MIN };
      shader.uniforms.uShadingMax = { value: SHADING_MAX };
      shader.uniforms.uDepressionTint = { value: DEPRESSION_TINT };
      shader.uniforms.uLightDirXZ = {
        value: new THREE.Vector2(12, 8).normalize(),
      };
      shader.uniforms.uSandWorldSize = { value: SIZE };
      shader.uniforms.uBgFreq = { value: BG_FREQ_PER_METRE };
      shader.uniforms.uBgWiggle = { value: BG_WIGGLE };
      shader.uniforms.uBgSharpness = { value: BG_SHARPNESS };
      shader.uniforms.uBgLight = { value: BG_LIGHT_STRENGTH };
      shader.uniforms.uBgDark = { value: BG_DARK_STRENGTH };
      shader.uniforms.uRippleExtent = { value: RIPPLE_EXTENT_M };
      shader.uniforms.uConcentricBoost = { value: CONCENTRIC_BOOST };
      // Live-toggled by HUD. Share the SAME object ref bgEnabledUniform
      // holds so React-side updates flow into the shader without a
      // recompile.
      shader.uniforms.uBgEnabled = bgEnabledUniform.current;
      shader.uniforms.uStonePos = {
        value: SHADER_STONES.map(
          (s) => new THREE.Vector2(s.pos[0], s.pos[1]),
        ),
      };
      shader.uniforms.uStoneRadius = {
        value: new Float32Array(SHADER_STONES.map((s) => s.radius)),
      };

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec2 vSandUv;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
vSandUv = uv;`,
      );

      // Fragment shader: TWO LAYERS combined into one diffuse modulation.
      //
      //   Layer 1 — procedural background karesansui (always present):
      //     concentric ripples around each stone, parallel waves
      //     between. Rendered as 3D relief: light crests, dark
      //     troughs.
      //
      //   Layer 2 — fresh rake trail (where the robot has been):
      //     gradient-based shading of the sandField heightmap.
      //     5 tooth lines per pass, sunlit/shadow sides.
      //
      // Both layers feed into a single brightness multiplier; PBR
      // lighting + fog + shadows remain unaffected.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uSandData;
uniform float uTexel;
uniform float uShadingAmp;
uniform float uShadingMin;
uniform float uShadingMax;
uniform float uDepressionTint;
uniform vec2 uLightDirXZ;
uniform float uSandWorldSize;
uniform float uBgFreq;
uniform float uBgWiggle;
uniform float uBgSharpness;
uniform float uBgLight;
uniform float uBgDark;
uniform float uRippleExtent;
uniform float uConcentricBoost;
uniform float uBgEnabled;
uniform vec2 uStonePos[${SHADER_STONE_COUNT}];
uniform float uStoneRadius[${SHADER_STONE_COUNT}];
varying vec2 vSandUv;

float spow(float x, float p) { return sign(x) * pow(abs(x), p); }

// Cheap 2D hash for sand-grain noise. World-XZ driven so the grain
// is stable regardless of camera zoom.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `float TWO_PI = 6.28318;

// ----- BG LAYER -----
// IMPORTANT: PlaneGeometry rotated -π/2 around X means UV.y INCREASES
// in the -Z world direction. We negate uv.y so worldXZ.y is true
// world Z; otherwise the concentric rings get drawn at z-mirrored
// stone positions (looked correct only by coincidence when stones
// happened to sit near the Z=0 line).
vec2 worldXZ = vec2((vSandUv.x - 0.5) * uSandWorldSize,
                    (0.5 - vSandUv.y) * uSandWorldSize);

// Parallel waves with layered wiggle (more organic than single sin)
float parallelPhase = worldXZ.y * TWO_PI * uBgFreq
  + cos(worldXZ.x * 0.9) * uBgWiggle
  + sin(worldXZ.x * 2.3) * 0.35;
float parallelW = sin(parallelPhase);

// Concentric: weighted-sum blending across stones so overlapping
// influence zones merge smoothly, not by max() which is discontinuous
float concentricNum = 0.0;
float concentricDen = 0.0;
float concentricInfl = 0.0;
for (int i = 0; i < ${SHADER_STONE_COUNT}; i++) {
  vec2 d = worldXZ - uStonePos[i];
  float dist = length(d);
  float r = uStoneRadius[i];
  float phase = (dist - r) * TWO_PI * uBgFreq;
  float infl = 1.0 - smoothstep(r + 0.15, r + uRippleExtent, dist);
  infl *= step(r + 0.05, dist);
  concentricNum += sin(phase) * infl * infl;
  concentricDen += infl * infl;
  concentricInfl = max(concentricInfl, infl);
}
float concentricW = concentricDen > 0.001 ? concentricNum / concentricDen : 0.0;
concentricW *= uConcentricBoost;

// Mix: parallel FADES OUT where concentric is meaningfully active.
// smoothstep curve so the transition is gradual but ends in pure
// concentric near each stone (no more lines fighting each other).
float concentricMix = smoothstep(0.12, 0.55, concentricInfl);
float bgW = parallelW * (1.0 - concentricMix) + concentricW * concentricMix;
bgW = spow(bgW, uBgSharpness);
// uBgEnabled toggles the procedural karesansui pattern off (散沙
// state) without touching the fresh-trail layer.
float bgBright = max(0.0, bgW) * uBgLight * uBgEnabled;
float bgDark = max(0.0, -bgW) * uBgDark * uBgEnabled;

// ----- FRESH TRAIL LAYER -----
float d  = texture2D(uSandData, vSandUv).r;
float dL = texture2D(uSandData, vSandUv - vec2(uTexel, 0.0)).r;
float dR = texture2D(uSandData, vSandUv + vec2(uTexel, 0.0)).r;
float dU = texture2D(uSandData, vSandUv + vec2(0.0, uTexel)).r;
float dD = texture2D(uSandData, vSandUv - vec2(0.0, uTexel)).r;
vec2 gradHeight = vec2(-(dR - dL) * 0.5, (dD - dU) * 0.5);
float freshShading = dot(gradHeight, uLightDirXZ) * uShadingAmp;
freshShading = clamp(freshShading, uShadingMin, uShadingMax);
float freshTint = d * uDepressionTint;

// ----- SAND GRAIN NOISE -----
// Two-octave hash noise gives a granule-like texture instead of the
// flat-paint base. ~3.5cm and ~11cm wavelengths read as gravel under
// the iso camera; total amplitude ~3% so PBR lighting stays readable.
float n1 = hash21(worldXZ * 28.0);
float n2 = hash21(worldXZ * 9.0 + 17.0);
float grainNoise = ((n1 - 0.5) * 0.55 + (n2 - 0.5) * 0.45) * 0.06;

// ----- COMPOSITE -----
float colorMul = clamp(1.0 + bgBright - bgDark + freshShading - freshTint + grainNoise, 0.25, 1.3);
vec4 diffuseColor = vec4(diffuse * colorMul, opacity);`,
      );
    };

    return m;
  }, [heightTexture]);

  return (
    <>
      {/* Sand body - just a thin box. Top is covered by the shader plane. */}
      <mesh
        receiveShadow
        position={[0, SAND_TOP_Y - SAND_THICKNESS / 2, 0]}
      >
        <boxGeometry args={[SIZE, SAND_THICKNESS, SIZE]} />
        <meshStandardMaterial color="#d2d4c8" roughness={1} />
      </mesh>

      {/* Visible shader plane - the grooves live here */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, SAND_TOP_Y + 0.001, 0]}
        receiveShadow
      >
        <planeGeometry args={[SIZE, SIZE]} />
        <primitive object={material} attach="material" />
      </mesh>

      {/* Earth block underneath, cosmetic only */}
      <mesh
        position={[0, SAND_TOP_Y - SAND_THICKNESS - EARTH_DEPTH / 2, 0]}
      >
        <boxGeometry args={[SIZE, EARTH_DEPTH, SIZE]} />
        <meshStandardMaterial color="#6b4f3a" roughness={1} />
      </mesh>
    </>
  );
}
