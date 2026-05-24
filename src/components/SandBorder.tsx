import { useMemo } from 'react';
import * as THREE from 'three';
import { SAND_SIZE, SAND_HALF } from '../sim/constants';

/**
 * Wooden frame around the sand — 4 boards styled as engawa-like
 * planking. Each side gets a shader-driven plank pattern (dark seams
 * roughly every 0.6m) plus subtle hash noise to break up the flat
 * brown paint, so the border reads as weathered timber rather than a
 * solid bar.
 */

const WALL_HEIGHT = 0.35;
const WALL_THICKNESS = 0.2;
const WALL_Y = WALL_HEIGHT / 2;
const COLOR = '#3a2a1f';

type Wall = {
  pos: [number, number, number];
  size: [number, number, number];
};

const WALLS: Wall[] = [
  {
    pos: [0, WALL_Y, SAND_HALF - WALL_THICKNESS / 2],
    size: [SAND_SIZE, WALL_HEIGHT, WALL_THICKNESS],
  },
  {
    pos: [0, WALL_Y, -SAND_HALF + WALL_THICKNESS / 2],
    size: [SAND_SIZE, WALL_HEIGHT, WALL_THICKNESS],
  },
  {
    pos: [SAND_HALF - WALL_THICKNESS / 2, WALL_Y, 0],
    size: [WALL_THICKNESS, WALL_HEIGHT, SAND_SIZE],
  },
  {
    pos: [-SAND_HALF + WALL_THICKNESS / 2, WALL_Y, 0],
    size: [WALL_THICKNESS, WALL_HEIGHT, SAND_SIZE],
  },
];

export function SandBorder() {
  const material = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: COLOR,
      roughness: 0.95,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vBorderWorld;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _bw = modelMatrix * vec4(transformed, 1.0);
vBorderWorld = _bw.xyz;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vBorderWorld;
float bHash(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );

// Plank seams: pick whichever axis is "along" this board. The board
// is long along whichever world axis varies more. We approximate by
// taking the world coord with the larger |value| as the cross axis,
// and use the OTHER horizontal axis as the along-plank coord. For
// the 4 walls one horizontal coord is bounded near ±SAND_HALF (the
// cross axis) and the other ranges across the full sand width; this
// picks the long axis automatically.
float ax = abs(vBorderWorld.x);
float az = abs(vBorderWorld.z);
float along = ax > az ? vBorderWorld.x : vBorderWorld.z;

// Dark seam every ~0.7m. smoothstep gives a soft seam edge instead
// of a hard pixel line.
float seam = abs(fract(along / 0.7 + 0.5) - 0.5);
float seamMask = 1.0 - smoothstep(0.0, 0.04, seam);
// Per-plank colour jitter so consecutive boards aren't identical.
float plankIdx = floor(along / 0.7);
float plankShade = bHash(vec2(plankIdx, 0.5)) * 0.18 - 0.08;

// Grain noise within each plank.
float n = bHash(vBorderWorld.xz * 11.0 + vBorderWorld.y * 3.0);

diffuseColor.rgb *= 1.0 + plankShade + (n - 0.5) * 0.14;
diffuseColor.rgb *= 1.0 - seamMask * 0.45;`,
      );
    };
    return m;
  }, []);

  return (
    <>
      {WALLS.map((w, i) => (
        <mesh key={i} position={w.pos} castShadow receiveShadow>
          <boxGeometry args={w.size} />
          <primitive object={material} attach="material" />
        </mesh>
      ))}
    </>
  );
}
