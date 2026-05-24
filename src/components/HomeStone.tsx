import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../sim/store';

type Props = {
  position: [number, number, number];
};

/**
 * Open-air charging dock — second redesign. Earlier iterations tried
 * a closed garage with a pitched roof; both felt boxy and obscured
 * the actual charging action. This version drops the roof entirely
 * and stages the charging itself as the visual centrepiece:
 *
 *   - Stone foundation apron (low slab around base, decorative)
 *   - Low side flanks + back wall (~25cm tall, just enough to
 *     define a docking bay — robot is visible from any angle)
 *   - Floor pad (the actual charging surface)
 *   - Bronze contact pads on back wall
 *   - VERTICAL CHARGE BEAM — bright additive cylinder + halo
 *     that pulses upward from the dock while robot is in DOCK
 *     state. This is the "charging effect" the user wanted to
 *     read clearly.
 *   - Status finial (small antenna + LED on a stone post in the
 *     back of the bay)
 */
// Rotated 90° clockwise from the previous +Z-facing orientation —
// opening now faces -X (west, toward the garden interior). With the
// home stone at SE corner (6.2, -6.2), opening west means the
// robot enters from the open garden side. Still axis-aligned, just
// a different cardinal face.
const GARAGE_YAW = -Math.PI / 2;
const GARAGE_INTERIOR_W = 1.0;
const GARAGE_INTERIOR_D = 1.4;
const GARAGE_WALL_THICK = 0.14;
// Low walls only — was 0.52, now 0.25 so the dock reads as an
// open platform rather than an enclosed box.
const GARAGE_HEIGHT = 0.25;
const GARAGE_FLOOR_H = 0.05;
const PLINTH_H = 0.025;
const PLINTH_EXTEND = 0.18;
const MOSS_LIFT = 0.005;
const MOSS_OUTER_R = 1.45;

// Charge beam — only visible while robot.state === 'DOCK'.
const BEAM_HEIGHT = 1.8;
const BEAM_RADIUS = 0.42;
const BEAM_COLOR = '#a4d6ff';

const WALL_COLOR = '#5a4632';
const FLOOR_COLOR = '#6e655a';
const PLINTH_COLOR = '#7a7066';
const LINTEL_COLOR = '#4a3a2c';
const CONTACT_COLOR = '#c89060';

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

  // Cedar wall material with vertical grain
  const wallMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: WALL_COLOR,
      roughness: 0.78,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vGarageWallWorld;`,
      );
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec4 _gww = modelMatrix * vec4(transformed, 1.0);
vGarageWallWorld = _gww.xyz;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
varying vec3 vGarageWallWorld;
float gwHash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
float boardCoord = (abs(vGarageWallWorld.x) + abs(vGarageWallWorld.z)) * 28.0;
float boardSeam = smoothstep(0.94, 1.0, fract(boardCoord)) +
                  smoothstep(0.94, 1.0, 1.0 - fract(boardCoord));
diffuseColor.rgb *= 1.0 - boardSeam * 0.35;
float g1 = gwHash(vec2(vGarageWallWorld.x * 18.0, vGarageWallWorld.y * 4.0));
float g2 = gwHash(vec2(vGarageWallWorld.z * 11.0 + 5.0, vGarageWallWorld.y * 7.0));
diffuseColor.rgb *= 1.0 + (g1 - 0.5) * 0.10 + (g2 - 0.5) * 0.08;`,
      );
    };
    return m;
  }, []);
  const floorMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: FLOOR_COLOR, roughness: 0.85 }),
    [],
  );
  const plinthMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: PLINTH_COLOR, roughness: 0.9 }),
    [],
  );
  const lintelMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: LINTEL_COLOR, roughness: 0.7 }),
    [],
  );

  // Refs for the charge-effect materials we animate per frame.
  const contactPadMatL = useRef<THREE.MeshStandardMaterial>(null);
  const contactPadMatR = useRef<THREE.MeshStandardMaterial>(null);
  const beamMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const beamMeshRef = useRef<THREE.Mesh>(null);
  const haloMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const haloMeshRef = useRef<THREE.Mesh>(null);
  const beamPointRef = useRef<THREE.PointLight>(null);
  const chargeClock = useRef(0);

  useFrame((_, dt) => {
    chargeClock.current += dt;
    const robotState = useStore.getState().state;
    const isCharging = robotState === 'DOCK';

    // Contact pad pulse — strong glow while charging, low ambient
    // glow otherwise so the pads always read as metallic.
    const padPulse = isCharging
      ? 0.6 + 0.8 * (0.5 + 0.5 * Math.sin(chargeClock.current * Math.PI * 1.4))
      : 0.18;
    if (contactPadMatL.current)
      contactPadMatL.current.emissiveIntensity = padPulse;
    if (contactPadMatR.current)
      contactPadMatR.current.emissiveIntensity = padPulse;

    // Charge beam — vertical pulsing cylinder, only visible while
    // docked. Opacity oscillates with the same phase as the pads
    // so the whole effect feels synchronised. Beam scale Y pumps
    // gently to suggest energy flowing upward.
    const beamPulse = isCharging
      ? 0.5 + 0.5 * Math.sin(chargeClock.current * Math.PI * 1.4)
      : 0;
    if (beamMeshRef.current) {
      const visible = beamPulse > 0.001;
      beamMeshRef.current.visible = visible;
      if (visible) {
        const sy = 0.9 + beamPulse * 0.2;
        beamMeshRef.current.scale.y = sy;
      }
    }
    if (beamMatRef.current) {
      beamMatRef.current.opacity = 0.18 + beamPulse * 0.32;
    }
    // Halo at the base of the beam — soft additive disc, scales
    // outward with the pulse to reinforce the "energy radiating"
    // reading.
    if (haloMeshRef.current) {
      const visible = beamPulse > 0.001;
      haloMeshRef.current.visible = visible;
      if (visible) {
        const s = 0.7 + beamPulse * 0.35;
        haloMeshRef.current.scale.set(s, 1, s);
      }
    }
    if (haloMatRef.current) {
      haloMatRef.current.opacity = 0.25 + beamPulse * 0.45;
    }
    // Tinted point light spilling onto the surrounding sand.
    if (beamPointRef.current) {
      beamPointRef.current.intensity = isCharging ? 1.6 + beamPulse * 1.4 : 0;
    }
  });

  // Layout
  const halfW = GARAGE_INTERIOR_W / 2;
  const halfD = GARAGE_INTERIOR_D / 2;
  const sideOuterW = GARAGE_INTERIOR_W + GARAGE_WALL_THICK * 2;
  const sideOuterD = GARAGE_INTERIOR_D + GARAGE_WALL_THICK;
  const sideWallX = halfW + GARAGE_WALL_THICK / 2;
  const backWallZ = -(halfD + GARAGE_WALL_THICK / 2);
  const plinthW = sideOuterW + PLINTH_EXTEND * 2;
  const plinthD =
    GARAGE_INTERIOR_D + GARAGE_WALL_THICK * 2 + PLINTH_EXTEND * 2;
  // Finial post — short cylinder behind the back wall holding the
  // status LED. Replaces the previous tall roof-apex antenna so
  // the structure still has a visible status indicator without
  // needing a roof.
  const finialY = GARAGE_HEIGHT + 0.18;

  return (
    <group position={[position[0], 0, position[2]]} rotation={[0, GARAGE_YAW, 0]}>
      {/* moss skirt */}
      <mesh
        position={[0, MOSS_LIFT, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
      >
        <circleGeometry args={[MOSS_OUTER_R, 36]} />
        <primitive object={mossMat} attach="material" />
      </mesh>

      {/* stone apron — decorative skirt at sand level */}
      <mesh position={[0, PLINTH_H / 2, 0]} receiveShadow>
        <boxGeometry args={[plinthW, PLINTH_H, plinthD]} />
        <primitive object={plinthMat} attach="material" />
      </mesh>

      {/* floor pad */}
      <mesh position={[0, GARAGE_FLOOR_H / 2, 0]} receiveShadow>
        <boxGeometry args={[GARAGE_INTERIOR_W, GARAGE_FLOOR_H, GARAGE_INTERIOR_D]} />
        <primitive object={floorMat} attach="material" />
      </mesh>

      {/* low side flanks (left, right) */}
      <mesh
        position={[-sideWallX, GARAGE_HEIGHT / 2, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[GARAGE_WALL_THICK, GARAGE_HEIGHT, sideOuterD]} />
        <primitive object={wallMat} attach="material" />
      </mesh>
      <mesh
        position={[sideWallX, GARAGE_HEIGHT / 2, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[GARAGE_WALL_THICK, GARAGE_HEIGHT, sideOuterD]} />
        <primitive object={wallMat} attach="material" />
      </mesh>

      {/* back wall — slightly taller than the side flanks (~+10cm)
          so the contact pads + finial have a visual anchor */}
      <mesh
        position={[0, (GARAGE_HEIGHT + 0.10) / 2, backWallZ]}
        castShadow
        receiveShadow
      >
        <boxGeometry
          args={[sideOuterW, GARAGE_HEIGHT + 0.10, GARAGE_WALL_THICK]}
        />
        <primitive object={wallMat} attach="material" />
      </mesh>

      {/* thin lintel cap across the top of the back wall */}
      <mesh
        position={[0, GARAGE_HEIGHT + 0.10 + 0.025, backWallZ]}
        castShadow
      >
        <boxGeometry args={[sideOuterW + 0.04, 0.05, GARAGE_WALL_THICK + 0.04]} />
        <primitive object={lintelMat} attach="material" />
      </mesh>

      {/* contact pads — pulse strongly when charging (see useFrame) */}
      <mesh position={[-0.18, 0.16, -halfD + 0.02]}>
        <boxGeometry args={[0.12, 0.06, 0.02]} />
        <meshStandardMaterial
          ref={contactPadMatL}
          color={CONTACT_COLOR}
          emissive={CONTACT_COLOR}
          emissiveIntensity={0.18}
          roughness={0.35}
          metalness={0.75}
        />
      </mesh>
      <mesh position={[0.18, 0.16, -halfD + 0.02]}>
        <boxGeometry args={[0.12, 0.06, 0.02]} />
        <meshStandardMaterial
          ref={contactPadMatR}
          color={CONTACT_COLOR}
          emissive={CONTACT_COLOR}
          emissiveIntensity={0.18}
          roughness={0.35}
          metalness={0.75}
        />
      </mesh>

      {/* CHARGE BEAM — vertical additive cylinder rising from the
          dock floor. Only visible while robot.state === 'DOCK'.
          This is the most visible read of "charging happening". */}
      <mesh
        ref={beamMeshRef}
        position={[0, BEAM_HEIGHT / 2 + GARAGE_FLOOR_H, 0]}
        visible={false}
      >
        <cylinderGeometry args={[BEAM_RADIUS, BEAM_RADIUS * 0.6, BEAM_HEIGHT, 12, 1, true]} />
        <meshBasicMaterial
          ref={beamMatRef}
          color={BEAM_COLOR}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>

      {/* HALO disc at the base of the beam */}
      <mesh
        ref={haloMeshRef}
        position={[0, GARAGE_FLOOR_H + 0.01, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        visible={false}
      >
        <circleGeometry args={[BEAM_RADIUS * 1.4, 24]} />
        <meshBasicMaterial
          ref={haloMatRef}
          color={BEAM_COLOR}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>

      {/* point light spilling the beam onto surrounding sand */}
      <pointLight
        ref={beamPointRef}
        position={[0, 0.4, 0]}
        color={BEAM_COLOR}
        intensity={0}
        distance={3.2}
        decay={1.5}
        castShadow={false}
      />

      {/* finial — small status LED on a short post behind the back
          wall. Replaces the old roof-apex antenna; visible from
          iso, doesn't need the roof to anchor it. */}
      <mesh position={[0, finialY * 0.5, backWallZ - 0.06]} castShadow>
        <cylinderGeometry args={[0.022, 0.022, finialY, 8]} />
        <meshStandardMaterial color="#7a7a7a" roughness={0.6} />
      </mesh>
      <mesh position={[0, finialY + 0.045, backWallZ - 0.06]}>
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
