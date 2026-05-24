import { useMemo } from 'react';
import * as THREE from 'three';

/**
 * Sand islands — two large moss "continents" floating in the gravel
 * sea, joined by a narrow moss bridge. Each island has 1-2 small
 * stones nestled in the moss, matching the canonical Ryōan-ji style
 * where stone clusters live inside shapely moss beds rather than
 * sitting bare on the gravel.
 *
 * Composition rules:
 *   - Islands are built from 2-3 overlapping moss circles so the
 *     silhouette reads as one organic shape, not a perfect disc.
 *   - The shader uses 3-octave fbm noise for colour and edge
 *     breakup — gives a soft mossy gradient (deep shadow in clumps,
 *     sunlit highlights) instead of the previous flat hash pattern.
 *   - Small island stones are NOT in VISITED_STONES, so the robot
 *     doesn't try to rake around them.
 *
 * All circle / stone positions are hand-verified to clear the main
 * stones' outermost spiral rings (SPIRAL_OUTER = 1.85).
 */

const MOSS_LIFT = 0.0045;

type Patch = { pos: [number, number]; radius: number };

// One unified moss island spanning ~3m × 2m, built from 6 overlapping
// circles. Shifted ~(+0.8, −1.0) from its previous centred location
// so the island sits visibly to the screen-right of the iso camera.
// All positions verified to clear the outermost spiral ring of every
// main stone (SPIRAL_OUTER = 1.85).
const MOSS_CIRCLES: Patch[] = [
  // Central body — biggest disc, bridges the SW and NE lobes.
  { pos: [1.6, -1.7], radius: 1.15 },
  // SW lobe — moss extends back toward the centre.
  { pos: [0.3, -2.2], radius: 0.8 },
  { pos: [0.8, -2.55], radius: 0.6 },
  // NW filler — softens the boundary between SW and central body.
  { pos: [1.2, -1.2], radius: 0.6 },
  // NE lobe — moss extends toward stone 3 side without colliding.
  { pos: [2.5, -1.0], radius: 0.8 },
  { pos: [3.0, -1.3], radius: 0.55 },
];

type IslandStone = {
  pos: [number, number];
  scale: [number, number, number];
  rotY: number;
  seed: number;
};

const ISLAND_STONES: IslandStone[] = [
  // Hero stone — anchors the central moss body after the right-shift.
  { pos: [1.2, -1.9], scale: [0.85, 0.55, 0.95], rotY: 0.4, seed: 31 },
  // Small vertical accent in the SW lobe.
  { pos: [0.3, -2.3], scale: [0.28, 0.7, 0.3], rotY: 1.6, seed: 32 },
  // Standing stone in the NE lobe.
  { pos: [2.5, -1.0], scale: [0.35, 0.55, 0.38], rotY: 2.1, seed: 33 },
];

// ---- displaced rock geometry (same idea as Stones.tsx) ----
function hash3(x: number, y: number, z: number, seed: number): number {
  const s =
    Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.523) *
    43758.5453;
  return s - Math.floor(s);
}

function buildIslandStoneGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y, z) || 1;
    const n1 = hash3(x * 2.3, y * 2.3, z * 2.3, seed);
    const n2 = hash3(x * 6.1, y * 6.1, z * 6.1, seed + 13);
    const offset = (n1 - 0.5) * 0.32 + (n2 - 0.5) * 0.12;
    const k = 1 + offset;
    pos.setXYZ(i, (x / r) * k, (y / r) * k, (z / r) * k);
  }
  g.computeVertexNormals();
  return g;
}

// Improved moss shader — 3-octave fbm for colour + multi-frequency
// noise for organic edge breakup. Reads as gradient-mossy rather
// than flat-green-with-pixel-noise.
const MOSS_SHADER_COMMON = `
varying vec2 vMossDiscUv;
varying vec3 vMossDiscWorld;
`;
const MOSS_SHADER_VERTEX_BEGIN = `
vec4 _mossW = modelMatrix * vec4(transformed, 1.0);
vMossDiscWorld = _mossW.xyz;
`;
const MOSS_SHADER_FRAG_COMMON = `
varying vec2 vMossDiscUv;
varying vec3 vMossDiscWorld;
float mhash2(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float mfbm(vec2 p) {
  // 3-octave value noise — coherent gradients with finer grain on top.
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 3; i++) {
    v += mhash2(p) * a;
    p *= 2.07;
    a *= 0.55;
  }
  return v;
}
`;
const MOSS_SHADER_FRAG_DIFFUSE = `
vec4 diffuseColor = vec4( diffuse, opacity );

float radial = length(vMossDiscUv - 0.5) * 2.0;

// Edge noise: a SMOOTH low-frequency fbm decides whether the rim
// pixel survives. Smoother and chunkier than the old single-hash
// version — boundaries look like real moss patch outlines.
float edgeN = mfbm(vMossDiscWorld.xz * 3.5);
float threshold = smoothstep(0.5, 0.95, radial);
if (edgeN < threshold) discard;

// Body colour: two fbm samples drive luma + slight hue.
float fA = mfbm(vMossDiscWorld.xz * 1.8);          // big slow patches
float fB = mfbm(vMossDiscWorld.xz * 9.0 + 7.13);   // grain

vec3 deep   = vec3(0.16, 0.27, 0.13); // wet-shaded moss base
vec3 base   = vec3(0.27, 0.42, 0.20); // mid moss
vec3 sunlit = vec3(0.46, 0.60, 0.27); // lighter dry tips
vec3 bloom  = vec3(0.62, 0.62, 0.32); // rare yellow-green spot

vec3 col = mix(deep, base, smoothstep(0.15, 0.55, fA));
col = mix(col, sunlit, smoothstep(0.55, 0.90, fA));
col = mix(col, bloom, smoothstep(0.88, 1.00, fA) * 0.55);

// Grain texture — fine variation on top.
col *= 1.0 + (fB - 0.5) * 0.18;

diffuseColor.rgb = col;
`;

function makeMossMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: '#3c5a2a',
    roughness: 0.95,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n${MOSS_SHADER_COMMON}`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>\nvMossDiscUv = uv;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>\n${MOSS_SHADER_VERTEX_BEGIN}`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\n${MOSS_SHADER_FRAG_COMMON}`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      MOSS_SHADER_FRAG_DIFFUSE,
    );
  };
  return m;
}

export function SandIsland() {
  const mossMat = useMemo(makeMossMaterial, []);

  const stoneMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: '#5a5650',
      roughness: 0.9,
      flatShading: true,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vIslandStoneWorld;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _isw = modelMatrix * vec4(transformed, 1.0);
vIslandStoneWorld = _isw.xyz;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vIslandStoneWorld;
float islStoneHash(vec2 p){
  p = fract(p*vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x*p.y);
}`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
float n1 = islStoneHash(vIslandStoneWorld.xz * 11.0 + vIslandStoneWorld.y * 4.0);
float n2 = islStoneHash(vIslandStoneWorld.xz * 2.7 + 13.0);
float weather = (n1 - 0.5) * 0.22 + (n2 - 0.5) * 0.14;
diffuseColor.rgb *= 1.0 + weather;
float moss = smoothstep(0.62, 0.92, n2);
diffuseColor.rgb = mix(
  diffuseColor.rgb,
  diffuseColor.rgb * vec3(0.78, 1.05, 0.72),
  moss * 0.4
);`,
      );
    };
    return m;
  }, []);

  const stoneGeometries = useMemo(
    () => ISLAND_STONES.map((s) => buildIslandStoneGeometry(s.seed)),
    [],
  );

  return (
    <>
      {MOSS_CIRCLES.map((c, i) => (
        <mesh
          key={`moss-${i}`}
          position={[c.pos[0], MOSS_LIFT, c.pos[1]]}
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow
        >
          <circleGeometry args={[c.radius, 36]} />
          <primitive object={mossMat} attach="material" />
        </mesh>
      ))}

      {ISLAND_STONES.map((s, i) => (
        <mesh
          key={`is-${i}`}
          position={[s.pos[0], s.scale[1] * 0.5, s.pos[1]]}
          rotation={[0, s.rotY, 0]}
          scale={s.scale}
          castShadow
          geometry={stoneGeometries[i]}
        >
          <primitive object={stoneMat} attach="material" />
        </mesh>
      ))}
    </>
  );
}
