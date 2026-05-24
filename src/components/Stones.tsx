import { useMemo } from 'react';
import * as THREE from 'three';
import { STONES } from '../sim/stones';

/**
 * Five zen stones placed in an asymmetric karesansui composition.
 * Positions live in src/sim/stones.ts so the sand shader can see
 * them and draw concentric ripples around each one.
 *
 * In real karesansui, stone placement follows "triangle rules":
 * groups of 3 or 5 stones arranged so no three are collinear.
 *
 * Each stone gets its OWN displaced icosahedron geometry — vertices
 * are pushed in/out along the radial direction by hashed noise so
 * each rock has angular cleaves and an irregular silhouette. The
 * unit radius is preserved on average so the patterns.ts ring radii
 * still feel correct.
 */

// Cheap deterministic 3D hash. Same input -> same output, so each
// stone keeps its identity across reloads.
function hash3(x: number, y: number, z: number, seed: number): number {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 4.523) * 43758.5453;
  return s - Math.floor(s);
}

function buildRoughStoneGeometry(seed: number): THREE.BufferGeometry {
  // detail 1 = 80 faces — enough surface to show cleaves without
  // costing much.
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, y, z) || 1;
    // Mix two octaves of noise — broad cleaves + fine pits.
    const n1 = hash3(x * 2.3, y * 2.3, z * 2.3, seed);
    const n2 = hash3(x * 6.1, y * 6.1, z * 6.1, seed + 13);
    const offset = (n1 - 0.5) * 0.34 + (n2 - 0.5) * 0.12;
    const k = 1 + offset;
    pos.setXYZ(i, (x / r) * k, (y / r) * k, (z / r) * k);
  }
  g.computeVertexNormals();
  return g;
}

export function Stones() {
  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: '#5a5650',
      roughness: 0.9,
      flatShading: true,
    });

    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vStoneWorld;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _stoneWorld = modelMatrix * vec4(transformed, 1.0);
vStoneWorld = _stoneWorld.xyz;`,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vStoneWorld;

float stoneHash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
// Two octaves of world-space hash noise. High frequency drives the
// grain texture; lower frequency picks broader light/dark patches.
float n1 = stoneHash21(vStoneWorld.xz * 11.0 + vStoneWorld.y * 4.0);
float n2 = stoneHash21(vStoneWorld.xz * 2.7 + 13.0);
float weather = (n1 - 0.5) * 0.22 + (n2 - 0.5) * 0.14;
diffuseColor.rgb *= 1.0 + weather;
// Soft greenish moss tint where n2 happens to be high — biased so it
// only shows in a few patches rather than washing the whole stone.
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

  // Build one displaced geometry per stone so each has a distinct
  // silhouette. Memoised so we don't rebuild on every render.
  const geometries = useMemo(
    () => STONES.map((_, i) => buildRoughStoneGeometry(i)),
    [],
  );

  return (
    <>
      {STONES.map((s, i) => (
        <mesh
          key={i}
          position={[s.pos[0], s.scale[1] * 0.5, s.pos[1]]}
          rotation={[0, s.rotY, 0]}
          scale={s.scale}
          castShadow
          geometry={geometries[i]}
        >
          <primitive object={material} attach="material" />
        </mesh>
      ))}
    </>
  );
}
