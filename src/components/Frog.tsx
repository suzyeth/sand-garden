import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../sim/store';

/**
 * A small frog perched on the central moss island. Mostly still —
 * the value is its presence on the moss, not its motion.
 *
 * Behaviour:
 *   - Sits on the moss centre.
 *   - Random short hop every 8-25s: a low parabolic arc landing
 *     within a small radius of home, then resettles.
 *   - Slow blink every 4-8s — eye scale dips to zero for ~0.16s.
 *   - More active (shorter hop interval) during 'cloudy' weather;
 *     less active during 'rain' (huddles, no hops, occasional croak
 *     suggestion via slight pulse). Hidden at night so it doesn't
 *     compete with fireflies.
 *
 * The "croak" is just a body-pulse cue rather than audio — the audio
 * layer would need a frog-specific sample. Mentioned in BACKLOG.
 */

// Position picked to land on the central moss island (1.6, -1.7).
const HOME: [number, number] = [1.55, -1.7];
const HOP_INTERVAL_MIN = 8;
const HOP_INTERVAL_MAX = 25;
const HOP_RADIUS = 0.18; // metres from home
const HOP_HEIGHT = 0.085;
const HOP_DURATION = 0.5;
const BLINK_INTERVAL_MIN = 4;
const BLINK_INTERVAL_MAX = 8;
const BLINK_DURATION = 0.16;
// Frogs are diurnal in this scene — hide once it's properly night.
const NIGHT_HIDE_T = 0.55;

export function Frog() {
  const group = useRef<THREE.Group>(null);
  const eyeL = useRef<THREE.Mesh>(null);
  const eyeR = useRef<THREE.Mesh>(null);
  const body = useRef<THREE.Mesh>(null);

  // Hop state — when hopT < HOP_DURATION the frog is mid-arc; once
  // it lands we wait nextHopIn seconds before the next jump.
  const hopT = useRef(HOP_DURATION); // start landed
  const nextHopIn = useRef(3 + Math.random() * 5);
  const fromX = useRef(HOME[0]);
  const fromZ = useRef(HOME[1]);
  const toX = useRef(HOME[0]);
  const toZ = useRef(HOME[1]);
  // Blink state — eyeScale at 1 normally, drops to 0 during blink.
  const blinkT = useRef(0);
  const nextBlinkIn = useRef(2 + Math.random() * 4);
  // Croak pulse — slight body swell during rain that suggests vocal
  // sac inflation without spawning audio.
  const croakPhase = useRef(0);

  const bodyMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#4f6b3a',
        roughness: 0.85,
        flatShading: true,
      }),
    [],
  );
  const eyeMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#1a1410',
        roughness: 0.3,
        metalness: 0.2,
      }),
    [],
  );

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const state = useStore.getState();
    const t = state.cycleT;
    const isNight = t > NIGHT_HIDE_T;
    if (isNight) {
      if (g.visible) g.visible = false;
      return;
    }
    g.visible = true;

    const isRain = state.weather === 'rain';
    const isCloudy = state.weather === 'cloudy';

    // ---- hop FSM ----
    if (hopT.current < HOP_DURATION) {
      hopT.current += dt;
      const u = THREE.MathUtils.clamp(hopT.current / HOP_DURATION, 0, 1);
      const px = THREE.MathUtils.lerp(fromX.current, toX.current, u);
      const pz = THREE.MathUtils.lerp(fromZ.current, toZ.current, u);
      // Parabolic arc — sin shape gives a soft up-and-down.
      const py = Math.sin(u * Math.PI) * HOP_HEIGHT;
      g.position.set(px, py + 0.04, pz);
      // Face the direction of travel.
      const dx = toX.current - fromX.current;
      const dz = toZ.current - fromZ.current;
      if (dx * dx + dz * dz > 1e-5) {
        g.rotation.y = Math.atan2(dx, dz);
      }
    } else {
      nextHopIn.current -= dt;
      // Tweak hop interval by weather — cloudy frogs are more active;
      // rainy frogs stay put.
      if (nextHopIn.current <= 0 && !isRain) {
        // Pick a new landing spot within HOP_RADIUS of home.
        fromX.current = g.position.x;
        fromZ.current = g.position.z;
        const angle = Math.random() * Math.PI * 2;
        const r = HOP_RADIUS * (0.4 + Math.random() * 0.6);
        toX.current = HOME[0] + Math.cos(angle) * r;
        toZ.current = HOME[1] + Math.sin(angle) * r;
        hopT.current = 0;
        const intervalMul = isCloudy ? 0.6 : 1.0;
        nextHopIn.current =
          (HOP_INTERVAL_MIN +
            Math.random() * (HOP_INTERVAL_MAX - HOP_INTERVAL_MIN)) *
          intervalMul;
      }
    }

    // ---- blink ----
    if (blinkT.current > 0) {
      blinkT.current -= dt;
      const u = 1 - blinkT.current / BLINK_DURATION;
      // Symmetric down-then-up over BLINK_DURATION.
      const lidOpen = Math.abs(u * 2 - 1);
      if (eyeL.current) eyeL.current.scale.y = lidOpen;
      if (eyeR.current) eyeR.current.scale.y = lidOpen;
    } else {
      nextBlinkIn.current -= dt;
      if (nextBlinkIn.current <= 0) {
        blinkT.current = BLINK_DURATION;
        nextBlinkIn.current =
          BLINK_INTERVAL_MIN +
          Math.random() * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN);
      }
    }

    // ---- rain croak pulse ----
    if (isRain && body.current) {
      croakPhase.current += dt * 1.6;
      const pulse = 1 + Math.sin(croakPhase.current * Math.PI * 2) * 0.045;
      body.current.scale.set(pulse, pulse * 0.95, pulse);
    } else if (body.current) {
      body.current.scale.set(1, 1, 1);
    }
  });

  return (
    <group ref={group} position={[HOME[0], 0.04, HOME[1]]}>
      {/* squat body — sphere flattened along Y for the karesansui
          carving feel (less cartoon, more zen) */}
      <mesh
        ref={body}
        castShadow
        scale={[1, 0.7, 1.05]}
      >
        <sphereGeometry args={[0.085, 14, 10]} />
        <primitive object={bodyMat} attach="material" />
      </mesh>
      {/* eyes — two small black spheres on top of the head, set
          forward so the frog reads as alert from the iso angle */}
      <mesh ref={eyeL} position={[-0.035, 0.075, 0.045]}>
        <sphereGeometry args={[0.018, 8, 8]} />
        <primitive object={eyeMat} attach="material" />
      </mesh>
      <mesh ref={eyeR} position={[0.035, 0.075, 0.045]}>
        <sphereGeometry args={[0.018, 8, 8]} />
        <primitive object={eyeMat} attach="material" />
      </mesh>
    </group>
  );
}
