import { useMemo } from 'react';
import * as THREE from 'three';
import { SAND_HALF } from '../sim/constants';

/**
 * Sparse pebble accents tucked along the inside of the wooden engawa
 * border. Not a perfect line of identical rocks (that read as a
 * fence in the previous iteration) — instead a handful of small,
 * irregular clumps with random gaps in between, sized across a wide
 * range so no two look the same.
 *
 * Placed along the FRONT (+Z) edge and the RIGHT (+X) edge — the two
 * sides not hidden by the clay back/left walls.
 */

// Pebble clumps live just inside the wall. The engawa border occupies
// ~7.8-8.0; we put pebbles around 7.4 (slight per-pebble jitter).
const EDGE_INSET = 0.55;
const EDGE_LIMIT = SAND_HALF - EDGE_INSET;

// 4 clumps per edge, each with 1-3 pebbles. Way sparser than the
// 18-in-a-row line — sand stays visible between clumps.
const CLUMPS_PER_EDGE = 4;

type Pebble = {
  pos: [number, number, number];
  scale: number;
  rotY: number;
  seed: number;
};

function hash(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function hash3(x: number, y: number, z: number, seed: number): number {
  const s =
    Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.523) *
    43758.5453;
  return s - Math.floor(s);
}

function buildPebbleGeom(seed: number): THREE.BufferGeometry {
  // detail 1 = 80 faces — smoother than detail 0 (20 faces) so each
  // pebble reads as a rounded river stone rather than an obvious
  // 20-sided die.
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y, z) || 1;
    const n1 = hash3(x * 2.5, y * 2.5, z * 2.5, seed);
    const n2 = hash3(x * 6.1, y * 6.1, z * 6.1, seed + 11);
    const offset = (n1 - 0.5) * 0.35 + (n2 - 0.5) * 0.12;
    const k = 1 + offset;
    pos.setXYZ(i, (x / r) * k, (y / r) * k, (z / r) * k);
  }
  g.computeVertexNormals();
  return g;
}

function buildEdge(axis: 'x' | 'z', sideSign: 1 | -1, edgeSeed: number): Pebble[] {
  const out: Pebble[] = [];
  for (let c = 0; c < CLUMPS_PER_EDGE; c++) {
    // Pick clump centre along the edge with a random offset so they
    // don't sit at perfectly equal spacing.
    const baseAlong =
      ((c + 0.5) / CLUMPS_PER_EDGE - 0.5) * 2 * (SAND_HALF - 1.0);
    const clumpJitter =
      (hash(c * 2.31 + edgeSeed * 5) - 0.5) * (SAND_HALF / CLUMPS_PER_EDGE) *
      0.35;
    const clumpAlong = baseAlong + clumpJitter;
    const clumpPerp =
      sideSign * (EDGE_LIMIT + (hash(c * 3.79 + edgeSeed * 7) - 0.5) * 0.15);

    // 1-3 pebbles per clump.
    const pebbleCount = 1 + Math.floor(hash(c * 4.13 + edgeSeed * 9) * 3);
    for (let p = 0; p < pebbleCount; p++) {
      const seedID = c * 17 + p * 3 + edgeSeed * 113;
      const localAlong = (hash(seedID * 1.71) - 0.5) * 0.45;
      const localPerp = (hash(seedID * 2.41) - 0.5) * 0.18;
      const along = clumpAlong + localAlong;
      const perp = clumpPerp + localPerp;
      const px = axis === 'x' ? perp : along;
      const pz = axis === 'x' ? along : perp;
      // Wider size range — some small dust pebbles, some chunkier
      // anchor stones.
      const scaleBase = hash(seedID * 5.33);
      const scale = 0.045 + Math.pow(scaleBase, 1.8) * 0.18;
      out.push({
        pos: [px, scale * 0.35, pz],
        scale,
        rotY: hash(seedID * 7.13) * Math.PI * 2,
        seed: seedID,
      });
    }
  }
  return out;
}

export function SandEdgePebbles() {
  const pebbles = useMemo<Pebble[]>(
    () => [...buildEdge('z', 1, 7), ...buildEdge('x', 1, 23)],
    [],
  );

  const geoms = useMemo(
    () => pebbles.map((p) => buildPebbleGeom(p.seed)),
    [pebbles],
  );

  const mat = useMemo(() => {
    // Tone closer to sand colour with subtle variation — pebbles
    // should look like the sand grain "promoted" to larger stones,
    // not a foreign material dumped on the edge.
    const m = new THREE.MeshStandardMaterial({
      color: '#8a8174',
      roughness: 0.95,
      flatShading: false,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vPebW;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _pw = modelMatrix * vec4(transformed, 1.0);
vPebW = _pw.xyz;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vPebW;
float pebH(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
float n1 = pebH(vPebW.xz * 14.0 + vPebW.y * 5.0);
float n2 = pebH(vPebW.xz * 3.0 + 9.0);
diffuseColor.rgb *= 1.0 + (n1 - 0.5) * 0.22 + (n2 - 0.5) * 0.14;`,
      );
    };
    return m;
  }, []);

  return (
    <>
      {pebbles.map((p, i) => (
        <mesh
          key={i}
          position={p.pos}
          rotation={[0, p.rotY, 0]}
          scale={p.scale}
          castShadow
          receiveShadow
          geometry={geoms[i]}
        >
          <primitive object={mat} attach="material" />
        </mesh>
      ))}
    </>
  );
}
