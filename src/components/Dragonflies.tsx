import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../sim/store';

/**
 * Dragonflies — daytime fauna. Quick darting flight contrasting with
 * the butterflies' slow flutter. Each dragonfly is a thin capsule body
 * with two pairs of static-but-fast-flapping transparent wings. Motion
 * is a hover / dart FSM so they read as real insects, not drifting
 * particles.
 *
 * Visibility gated on cycleT — fully visible through midday, fading
 * out at dusk so they don't share the night with fireflies.
 */

const DRAGONFLY_COUNT = 2;
const FLY_RADIUS = 5.5;
const FLY_HEIGHT_MIN = 0.28;
const FLY_HEIGHT_MAX = 1.6;

const DAY_T_MAX = 0.46;
const DAY_T_FADE = 0.06; // last 0.06 of daytime fades out

function hash(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function dayWeight(t: number): number {
  const u = ((t % 1) + 1) % 1;
  if (u > DAY_T_MAX) return 0;
  if (u < DAY_T_MAX - DAY_T_FADE) return 1;
  return 1 - THREE.MathUtils.smoothstep(u, DAY_T_MAX - DAY_T_FADE, DAY_T_MAX);
}

type Spec = {
  bodyColour: THREE.Color;
  wingTint: THREE.Color;
  wingBeat: number; // Hz
};

type FlyState = {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  vy: number;
  nextDecisionIn: number;
  turnRate: number;
};

// Unified muted blue-grey palette — the earlier rainbow (electric
// blue / crimson / violet / amber) was the single biggest colour
// noise in the daytime scene. Three close variants give individual
// distinction without competing with the cool sand/stone palette.
const DRAGONFLY_COLOURS = [
  '#6e7c8c', // slate blue-grey
  '#8a8f95', // pale steel
  '#586470', // deep grey-blue
  '#7a8888',
  '#677380',
];

const WING_TINTS = [
  '#dfe6ee',
  '#e9ecf0',
  '#d6dde5',
  '#e2e6eb',
  '#dbe1e8',
];

export function Dragonflies() {
  const specs = useMemo<Spec[]>(
    () =>
      Array.from({ length: DRAGONFLY_COUNT }, (_, i) => ({
        bodyColour: new THREE.Color(DRAGONFLY_COLOURS[i % DRAGONFLY_COLOURS.length]),
        wingTint: new THREE.Color(WING_TINTS[i % WING_TINTS.length]),
        wingBeat: 18 + hash(i * 5.7) * 12,
      })),
    [],
  );

  const yMid = (FLY_HEIGHT_MIN + FLY_HEIGHT_MAX) / 2;
  const states = useMemo<FlyState[]>(
    () =>
      Array.from({ length: DRAGONFLY_COUNT }, (_, i) => ({
        x: (hash(i * 3.7) - 0.5) * FLY_RADIUS * 1.4,
        y: yMid + (hash(i * 7.1) - 0.5) * 0.6,
        z: (hash(i * 11.3) - 0.5) * FLY_RADIUS * 1.4,
        heading: hash(i * 17.9) * Math.PI * 2,
        speed: 0.0,
        vy: 0,
        nextDecisionIn: 0.1,
        turnRate: 0,
      })),
    [yMid],
  );

  // ---- geometry / materials ---------------------------------------
  const bodyGeom = useMemo(() => {
    // Long thin capsule, +Z forward. Slimmer + longer than before so
    // the dragonfly reads as a slender bug, not a fat sausage.
    const g = new THREE.CapsuleGeometry(0.010, 0.18, 4, 8);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);
  const headGeom = useMemo(() => new THREE.SphereGeometry(0.022, 12, 10), []);
  const eyeGeom = useMemo(() => new THREE.SphereGeometry(0.012, 8, 8), []);
  const wingGeom = useMemo(() => {
    // Plane scaled per-wing via instance transform; default size 1.
    const g = new THREE.PlaneGeometry(1, 1);
    // Default plane normal is +Z. Re-orient so wing surface faces +Y
    // (horizontal wings).
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);

  const wingMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        roughness: 0.2,
        metalness: 0.05,
        depthWrite: false,
      }),
    [],
  );

  // refs
  const groupRefs = useRef<(THREE.Group | null)[]>([]);
  const bodyRefs = useRef<(THREE.Mesh | null)[]>([]);
  const headRefs = useRef<(THREE.Mesh | null)[]>([]);
  const eyeLRefs = useRef<(THREE.Mesh | null)[]>([]);
  const eyeRRefs = useRef<(THREE.Mesh | null)[]>([]);
  const wingFLRef = useRef<(THREE.Mesh | null)[]>([]);
  const wingFRRef = useRef<(THREE.Mesh | null)[]>([]);
  const wingBLRef = useRef<(THREE.Mesh | null)[]>([]);
  const wingBRRef = useRef<(THREE.Mesh | null)[]>([]);

  const elapsed = useRef(0);

  useEffect(() => {
    // Apply per-dragonfly body colour once.
    for (let i = 0; i < DRAGONFLY_COUNT; i++) {
      const body = bodyRefs.current[i];
      const head = headRefs.current[i];
      if (body && body.material instanceof THREE.MeshStandardMaterial) {
        body.material.color.copy(specs[i].bodyColour);
      }
      if (head && head.material instanceof THREE.MeshStandardMaterial) {
        head.material.color.copy(specs[i].bodyColour).multiplyScalar(0.85);
      }
    }
  }, [specs]);

  useFrame((_, dt) => {
    elapsed.current += dt;
    const state = useStore.getState();
    const t = state.cycleT;
    const w = dayWeight(t);
    // Dragonflies only emerge in the pre-rain lull — when the
    // weather state is 'cloudy'. Outside of that we keep them hidden,
    // which makes their appearance feel like a weather signal.
    const weatherGate = state.weather === 'cloudy';

    for (let i = 0; i < DRAGONFLY_COUNT; i++) {
      const g = groupRefs.current[i];
      if (!g) continue;
      if (w <= 0.001 || !weatherGate) {
        if (g.visible) g.visible = false;
        continue;
      }
      g.visible = true;

      const st = states[i];
      const sp = specs[i];

      // --- FSM ----------------------------------------------------
      st.nextDecisionIn -= dt;
      if (st.nextDecisionIn <= 0) {
        const r = Math.random();
        if (r < 0.45) {
          // hover with mild turning
          st.speed = 0.02 + Math.random() * 0.08;
          st.turnRate = (Math.random() - 0.5) * 1.2;
          st.nextDecisionIn = 0.4 + Math.random() * 0.9;
        } else if (r < 0.85) {
          // dart in chosen direction
          st.speed = 1.0 + Math.random() * 1.4;
          // Mostly straight darts; small heading change at start.
          st.heading += (Math.random() - 0.5) * 1.6;
          st.turnRate = (Math.random() - 0.5) * 0.4;
          st.nextDecisionIn = 0.25 + Math.random() * 0.45;
        } else {
          // sharp 90° turn while still moving
          st.speed = 0.4 + Math.random() * 0.6;
          st.heading += (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 2 + Math.random() * 0.6);
          st.turnRate = (Math.random() - 0.5) * 1.0;
          st.nextDecisionIn = 0.2 + Math.random() * 0.3;
        }
      }

      // --- continuous update ---------------------------------------
      st.heading += st.turnRate * dt;
      const vx = Math.cos(st.heading) * st.speed;
      const vz = Math.sin(st.heading) * st.speed;
      st.x += vx * dt;
      st.z += vz * dt;

      // Bounds: smoothly steer back toward centre.
      const distSq = st.x * st.x + st.z * st.z;
      if (distSq > FLY_RADIUS * FLY_RADIUS) {
        const toCentre = Math.atan2(-st.z, -st.x);
        let delta = toCentre - st.heading;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        st.heading += delta * dt * 3.0;
      }

      // Vertical: soft spring + noise.
      st.vy += (yMid - st.y) * dt * 0.5;
      st.vy += (Math.random() - 0.5) * dt * 0.6;
      st.vy *= Math.pow(0.05, dt);
      st.y += st.vy * dt;
      st.y = THREE.MathUtils.clamp(st.y, FLY_HEIGHT_MIN, FLY_HEIGHT_MAX);

      // --- write to scene ------------------------------------------
      g.position.set(st.x, st.y, st.z);
      g.rotation.y = Math.atan2(Math.cos(st.heading), Math.sin(st.heading));

      // Wing flap — fast sinusoidal pitch around the wing's
      // attachment axis. Front and back wings beat ~π out of phase.
      const beat = Math.sin(elapsed.current * sp.wingBeat * Math.PI * 2);
      const beatLag = Math.sin(elapsed.current * sp.wingBeat * Math.PI * 2 + Math.PI);
      const fl = wingFLRef.current[i];
      const fr = wingFRRef.current[i];
      const bl = wingBLRef.current[i];
      const br = wingBRRef.current[i];
      const flapAmp = 0.35;
      if (fl) fl.rotation.z = beat * flapAmp;
      if (fr) fr.rotation.z = -beat * flapAmp;
      if (bl) bl.rotation.z = beatLag * flapAmp;
      if (br) br.rotation.z = -beatLag * flapAmp;
    }
  });

  return (
    <>
      {specs.map((sp, i) => (
        <group
          key={i}
          ref={(el) => {
            groupRefs.current[i] = el;
          }}
          visible={false}
        >
          {/* body — long thin capsule pointing +Z */}
          <mesh
            ref={(el) => {
              bodyRefs.current[i] = el;
            }}
            geometry={bodyGeom}
            castShadow
          >
            <meshStandardMaterial
              color={sp.bodyColour}
              roughness={0.55}
              metalness={0.15}
            />
          </mesh>
          {/* head — slightly fatter sphere at the front (+Z) */}
          <mesh
            ref={(el) => {
              headRefs.current[i] = el;
            }}
            geometry={headGeom}
            position={[0, 0.002, 0.118]}
            castShadow
          >
            <meshStandardMaterial
              color={sp.bodyColour}
              roughness={0.4}
              metalness={0.1}
            />
          </mesh>
          {/* compound eyes — dark, slightly to the sides */}
          <mesh
            ref={(el) => {
              eyeLRefs.current[i] = el;
            }}
            geometry={eyeGeom}
            position={[-0.015, 0.008, 0.130]}
          >
            <meshStandardMaterial color="#1a1410" roughness={0.2} metalness={0.4} />
          </mesh>
          <mesh
            ref={(el) => {
              eyeRRefs.current[i] = el;
            }}
            geometry={eyeGeom}
            position={[0.015, 0.008, 0.130]}
          >
            <meshStandardMaterial color="#1a1410" roughness={0.2} metalness={0.4} />
          </mesh>
          {/* wings — 4 thin transparent panes attached at the thorax.
              Each wing's transform: an inner group hinged at attachment
              point so flap rotation pivots correctly. Wing extends
              outward (±X) from the hinge. Sized for visibility from
              iso camera. */}
          {/* front-left */}
          <group position={[0.015, 0.015, 0.012]}>
            <mesh
              ref={(el) => {
                wingFLRef.current[i] = el;
              }}
              geometry={wingGeom}
              position={[0.045, 0, 0]}
              scale={[0.10, 1, 0.030]}
              material={wingMat}
            />
          </group>
          {/* front-right */}
          <group position={[-0.015, 0.015, 0.012]}>
            <mesh
              ref={(el) => {
                wingFRRef.current[i] = el;
              }}
              geometry={wingGeom}
              position={[-0.045, 0, 0]}
              scale={[0.10, 1, 0.030]}
              material={wingMat}
            />
          </group>
          {/* back-left */}
          <group position={[0.015, 0.012, -0.030]}>
            <mesh
              ref={(el) => {
                wingBLRef.current[i] = el;
              }}
              geometry={wingGeom}
              position={[0.045, 0, 0]}
              scale={[0.095, 1, 0.033]}
              material={wingMat}
            />
          </group>
          {/* back-right */}
          <group position={[-0.015, 0.012, -0.030]}>
            <mesh
              ref={(el) => {
                wingBRRef.current[i] = el;
              }}
              geometry={wingGeom}
              position={[-0.045, 0, 0]}
              scale={[0.095, 1, 0.033]}
              material={wingMat}
            />
          </group>
        </group>
      ))}
    </>
  );
}
