import { useMemo } from 'react';
import * as THREE from 'three';

type Props = {
  position: [number, number, number];
};

/**
 * The charging dock — "buried in moss". A karesansui dry garden has
 * no place for a black plastic charging station, so we hide it: the
 * dock proper is a low slab partially obscured by a moss carpet, and
 * only a thin antenna with the status LED breaks the natural surface.
 *
 * Reads as "the machine has been here long enough that the garden has
 * grown over it" — keeps the cozy-sci-fi-meets-zen contradiction
 * tasteful instead of violating karesansui form outright.
 */
const MOSS_LIFT = 0.005;
const DOCK_HEIGHT = 0.22;
const DOCK_FOOTPRINT = 1.05;
const MOSS_RADIUS = 1.1;

export function HomeStone({ position }: Props) {
  const mossMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: '#3f5f34',
      roughness: 0.95,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec2 vHomeMossUv;
varying vec3 vHomeMossWorld;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
vHomeMossUv = uv;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _hmw = modelMatrix * vec4(transformed, 1.0);
vHomeMossWorld = _hmw.xyz;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
varying vec2 vHomeMossUv;
varying vec3 vHomeMossWorld;
float hmHash(vec2 p){
  p = fract(p*vec2(123.34,456.21));
  p += dot(p, p+45.32);
  return fract(p.x*p.y);
}`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
float r = length(vHomeMossUv - 0.5) * 2.0;
float n = hmHash(vHomeMossWorld.xz * 7.0);
float threshold = smoothstep(0.55, 0.98, r);
if (n < threshold) discard;
float n2 = hmHash(vHomeMossWorld.xz * 17.0 + 5.0);
float shade = (n - 0.5) * 0.30 + (n2 - 0.5) * 0.18;
diffuseColor.rgb *= 1.0 + shade;
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.05, 1.0, 0.78), smoothstep(0.55,0.95,n)*0.32);`,
      );
    };
    return m;
  }, []);

  return (
    <group position={[position[0], 0, position[2]]}>
      {/* low dock slab, sitting flush with the sand */}
      <mesh
        position={[0, DOCK_HEIGHT / 2, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[DOCK_FOOTPRINT, DOCK_HEIGHT, DOCK_FOOTPRINT]} />
        <meshStandardMaterial color="#2a2a2a" roughness={0.8} />
      </mesh>

      {/* moss carpet that visually swallows most of the dock */}
      <mesh
        position={[0, MOSS_LIFT, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <circleGeometry args={[MOSS_RADIUS, 36]} />
        <primitive object={mossMat} attach="material" />
      </mesh>

      {/* thin antenna poking through the moss */}
      <mesh position={[0, DOCK_HEIGHT + 0.22, 0]} castShadow>
        <cylinderGeometry args={[0.025, 0.025, 0.42, 8]} />
        <meshStandardMaterial color="#7a7a7a" roughness={0.6} />
      </mesh>

      {/* status LED on the antenna tip — the only visibly "technical"
          element left to read above the moss */}
      <mesh position={[0, DOCK_HEIGHT + 0.46, 0]}>
        <sphereGeometry args={[0.045, 8, 8]} />
        <meshStandardMaterial
          color="#3ad97e"
          emissive="#3ad97e"
          emissiveIntensity={1.2}
        />
      </mesh>
    </group>
  );
}
