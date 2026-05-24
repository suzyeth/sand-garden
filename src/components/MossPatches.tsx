import { useMemo } from 'react';
import * as THREE from 'three';
import { STONES } from '../sim/stones';

/**
 * Per-stone moss carpets. Each stone gets a main patch + 1 satellite
 * blob offset deterministically, so the two overlap into an oblong
 * kidney-bean shape rather than a perfect circle.
 *
 * Standalone "sand islands" (the bigger moss compositions in the
 * middle of the sand with their own small stones) are owned by
 * SandIsland.tsx; this component handles only the moss attached to
 * the five main raked stones.
 *
 * The shader uses 3-octave fbm noise for both edge breakup and body
 * colour gradient — reads as real moss with shadow + sunlit + bloom
 * variations, not the flat-green-with-hash-grain look it had before.
 */
const MOSS_LIFT = 0.004;

type Patch = { pos: [number, number]; radius: number };

function buildPatches(): Patch[] {
  const patches: Patch[] = [];
  for (let i = 0; i < STONES.length; i++) {
    const s = STONES[i];
    const xz = Math.max(s.scale[0], s.scale[2]);
    patches.push({ pos: [s.pos[0], s.pos[1]], radius: xz * 1.55 });
    const angle = i * 1.71 + 0.4;
    const off = xz * 1.05;
    patches.push({
      pos: [
        s.pos[0] + Math.cos(angle) * off,
        s.pos[1] + Math.sin(angle) * off,
      ],
      radius: xz * 0.85,
    });
  }
  return patches;
}

export function MossPatches() {
  const patches = useMemo(buildPatches, []);

  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: '#3c5a2a',
      roughness: 0.95,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec2 vMossDiscUv;
varying vec3 vMossDiscWorld;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
vMossDiscUv = uv;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _mossW = modelMatrix * vec4(transformed, 1.0);
vMossDiscWorld = _mossW.xyz;`,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
varying vec2 vMossDiscUv;
varying vec3 vMossDiscWorld;
float mhash2(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float mfbm(vec2 p) {
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 3; i++) {
    v += mhash2(p) * a;
    p *= 2.07;
    a *= 0.55;
  }
  return v;
}`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );

float radial = length(vMossDiscUv - 0.5) * 2.0;

// Edge: chunky fbm picks which rim pixels survive.
float edgeN = mfbm(vMossDiscWorld.xz * 3.5);
float threshold = smoothstep(0.5, 0.95, radial);
if (edgeN < threshold) discard;

// Body colour: two fbm samples drive luma + slight hue.
float fA = mfbm(vMossDiscWorld.xz * 1.8);
float fB = mfbm(vMossDiscWorld.xz * 9.0 + 7.13);

vec3 deep   = vec3(0.16, 0.27, 0.13);
vec3 base   = vec3(0.27, 0.42, 0.20);
vec3 sunlit = vec3(0.46, 0.60, 0.27);
vec3 bloom  = vec3(0.62, 0.62, 0.32);

vec3 col = mix(deep, base, smoothstep(0.15, 0.55, fA));
col = mix(col, sunlit, smoothstep(0.55, 0.90, fA));
col = mix(col, bloom, smoothstep(0.88, 1.00, fA) * 0.55);
col *= 1.0 + (fB - 0.5) * 0.18;
diffuseColor.rgb = col;`,
      );
    };
    return m;
  }, []);

  return (
    <>
      {patches.map((p, i) => (
        <mesh
          key={i}
          position={[p.pos[0], MOSS_LIFT, p.pos[1]]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
        >
          <circleGeometry args={[p.radius, 36]} />
          <primitive object={material} attach="material" />
        </mesh>
      ))}
    </>
  );
}
