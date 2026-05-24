import { useMemo } from 'react';
import * as THREE from 'three';
import { SAND_SIZE, SAND_HALF } from '../sim/constants';

/**
 * Back / left clay walls + tree canopies behind them — the
 * karesansui "tsuiji-bei" backdrop. Without these the sand platform
 * reads as floating in nothing; with them it reads as the courtyard
 * of a temple, with a low wall enclosing the dry garden and
 * canopies of pine and autumn maple visible beyond.
 *
 * The walls sit ON the existing wooden engawa border (Y starts at
 * the border's top surface) and form an L-shape on the BACK and
 * LEFT sides — the far sides in iso framing, leaving the front /
 * right open for camera view. Trees are dome blobs without trunks;
 * the wall hides their lower half so we don't have to worry about
 * where they "root".
 */

const BORDER_TOP = 0.35; // matches WALL_HEIGHT in SandBorder
const WALL_HEIGHT = 1.05;
const WALL_THICKNESS = 0.22;
const WALL_Y = BORDER_TOP + WALL_HEIGHT / 2;

const CAP_HEIGHT = 0.1;
const CAP_OVERHANG = 0.08;
const CAP_Y = BORDER_TOP + WALL_HEIGHT + CAP_HEIGHT / 2;

// Back wall along Z = -SAND_HALF (in front of the wooden border on
// that side). Left wall mirrors on X.
const BACK_WALL_Z = -SAND_HALF + WALL_THICKNESS / 2;
const LEFT_WALL_X = -SAND_HALF + WALL_THICKNESS / 2;

// Tree silhouettes also removed — 2D plane cutouts read just as
// fake-looking as the 3D domes from iso. Keeping just the L-shape
// clay walls as the backdrop. A "trees behind the wall" pass would
// need either a textured sprite atlas or a fully-painted skybox plane.

export function BackWall() {
  const wallMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: '#c8b89c',
      roughness: 0.95,
    });
    // Subtle clay-grain noise so the wall isn't a flat paint slab.
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vWallWorld;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _ww = modelMatrix * vec4(transformed, 1.0);
vWallWorld = _ww.xyz;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vWallWorld;
float wHash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
float n = wHash(vWallWorld.xy * 14.0 + vWallWorld.z * 6.0);
float n2 = wHash(vWallWorld.xz * 2.5);
diffuseColor.rgb *= 1.0 + (n - 0.5) * 0.10 + (n2 - 0.5) * 0.16;`,
      );
    };
    return m;
  }, []);

  const capMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({ color: '#4a3a2c', roughness: 0.85 }),
    [],
  );

  return (
    <>
      {/* back wall body */}
      <mesh
        position={[0, WALL_Y, BACK_WALL_Z]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[SAND_SIZE, WALL_HEIGHT, WALL_THICKNESS]} />
        <primitive object={wallMat} attach="material" />
      </mesh>
      {/* back wall tile cap */}
      <mesh
        position={[0, CAP_Y, BACK_WALL_Z]}
        castShadow
        receiveShadow
      >
        <boxGeometry
          args={[
            SAND_SIZE + CAP_OVERHANG * 2,
            CAP_HEIGHT,
            WALL_THICKNESS + CAP_OVERHANG * 2,
          ]}
        />
        <primitive object={capMat} attach="material" />
      </mesh>

      {/* left wall body */}
      <mesh
        position={[LEFT_WALL_X, WALL_Y, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[WALL_THICKNESS, WALL_HEIGHT, SAND_SIZE]} />
        <primitive object={wallMat} attach="material" />
      </mesh>
      {/* left wall tile cap */}
      <mesh
        position={[LEFT_WALL_X, CAP_Y, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry
          args={[
            WALL_THICKNESS + CAP_OVERHANG * 2,
            CAP_HEIGHT,
            SAND_SIZE + CAP_OVERHANG * 2,
          ]}
        />
        <primitive object={capMat} attach="material" />
      </mesh>

    </>
  );
}
