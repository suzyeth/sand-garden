import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../sim/store';
import { sandField } from '../sim/sandField';
import { SAND_HALF } from '../sim/constants';

/**
 * A slow black beetle that occasionally walks across the sand,
 * leaving a thin etched scrape behind it (same sandField API as the
 * gecko but smaller and slower). Rarer than the gecko: visits last
 * ~30s and respawn intervals are several minutes.
 *
 * FSM:
 *   hidden       — invisible, counting down sleepFor
 *   crossing     — walks along a slowly-changing heading from one
 *                  edge of the sand to roughly the opposite edge
 *   (back to hidden once it leaves the sand bounds)
 *
 * No perch behaviour, no climbing — beetles are pure pavement
 * cinematography, the unhurried punctuation of an afternoon.
 *
 * Hidden at night so this stays a daytime cue.
 */

type State = 'hidden' | 'crossing';

const SPEED = 0.18; // m/s — much slower than the gecko (~0.7)
const HEADING_NOISE = 0.5; // radians/sec drift in heading
const BODY_LENGTH = 0.075;
const BODY_WIDTH = 0.05;
const BODY_HEIGHT = 0.022;
const LEG_PHASE_HZ = 6;

const ETCH_RADIUS = 0.012;
const ETCH_DEPTH_PER_SEC = 1.4;
const DISTURB_RADIUS = 0.04;
const DISTURB_STRENGTH = 0.6;

const SLEEP_FIRST_MIN = 35;
const SLEEP_FIRST_MAX = 90;
const SLEEP_RESPAWN_MIN = 180;
const SLEEP_RESPAWN_MAX = 360;
const NIGHT_HIDE_T = 0.55;

// Spawn just outside the sand bounds so the beetle visibly walks in.
const SPAWN_OUTSIDE = SAND_HALF + 0.4;
// Once the beetle wanders this far past the sand on the far side,
// the FSM hides it and schedules the next visit. Two values: the
// open sides (+X, +Z) let the beetle wander a bit past the edge so
// it visibly walks off; the wall sides (-X, -Z) hide it BEFORE it
// reaches the wall body at ~-7.89 so the chassis never clips through.
const EXIT_OUTSIDE_OPEN = SAND_HALF + 0.6;
const EXIT_INSIDE_WALL = SAND_HALF - 0.5;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function Beetle() {
  const group = useRef<THREE.Group>(null);
  const legL = useRef<THREE.Group>(null);
  const legR = useRef<THREE.Group>(null);

  const stateRef = useRef<State>('hidden');
  const sleepFor = useRef(rand(SLEEP_FIRST_MIN, SLEEP_FIRST_MAX));
  const timer = useRef(0);
  const heading = useRef(0);
  const prevPos = useRef<[number, number] | null>(null);
  const legPhase = useRef(0);

  const bodyMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#15110d',
        roughness: 0.45,
        metalness: 0.3,
      }),
    [],
  );
  const legMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#0d0908',
        roughness: 0.6,
      }),
    [],
  );

  const startCycle = () => {
    if (!group.current) return;
    // Spawn ONLY from the two wall-free edges (+X right, +Z front).
    // Spawning from -X or -Z used to put the beetle behind the
    // back/left walls and the walk-in straight-line would clip
    // through the wall body. From +X/+Z the beetle enters across
    // visible sand and the same exit logic handles departure.
    const side = Math.floor(Math.random() * 2);
    let x = 0;
    let z = 0;
    let h = 0;
    if (side === 0) {
      // East edge (+X) heading west (-X)
      x = SPAWN_OUTSIDE;
      z = rand(-SAND_HALF * 0.8, SAND_HALF * 0.8);
      h = Math.PI;
    } else {
      // Front edge (+Z) heading toward back (-Z), but not deep enough
      // to clip the back wall — the per-frame EXIT check below stops
      // the walk well before z = -SAND_HALF.
      x = rand(-SAND_HALF * 0.8, SAND_HALF * 0.8);
      z = SPAWN_OUTSIDE;
      h = -Math.PI / 2;
    }
    group.current.position.set(x, 0.015, z);
    heading.current = h + rand(-0.4, 0.4); // small jitter so it's not perfectly axial
    prevPos.current = [x, z];
    stateRef.current = 'crossing';
    timer.current = 0;
    group.current.visible = true;
  };

  useFrame((_, dt) => {
    if (!group.current) return;
    const cycleT = useStore.getState().cycleT;
    if (cycleT > NIGHT_HIDE_T) {
      if (stateRef.current !== 'hidden') {
        stateRef.current = 'hidden';
        sleepFor.current = rand(SLEEP_RESPAWN_MIN, SLEEP_RESPAWN_MAX);
        timer.current = 0;
        group.current.visible = false;
      }
      return;
    }

    timer.current += dt;
    if (stateRef.current === 'hidden') {
      if (group.current.visible) group.current.visible = false;
      if (timer.current >= sleepFor.current) startCycle();
      return;
    }

    // ---- crossing ----
    // Slow random walk: heading drifts a little each frame so the
    // path isn't perfectly straight.
    heading.current += (Math.random() - 0.5) * HEADING_NOISE * dt;
    const here = group.current.position;
    here.x += Math.cos(heading.current) * SPEED * dt;
    here.z += Math.sin(heading.current) * SPEED * dt;
    group.current.rotation.y = -heading.current + Math.PI / 2;

    // Leg shuffle — small alternating Y-axis sway. Beetle leg cycle
    // is small but obvious enough at iso scale.
    legPhase.current += dt * LEG_PHASE_HZ * Math.PI * 2;
    const leg = Math.sin(legPhase.current) * 0.18;
    if (legL.current) legL.current.rotation.y = leg;
    if (legR.current) legR.current.rotation.y = -leg;

    // Etch a thin line behind the beetle and gently disturb the
    // rake grooves it crosses. Same API as Gecko, smaller numbers.
    if (prevPos.current) {
      const [px, pz] = prevPos.current;
      sandField.etchLine(
        px,
        pz,
        here.x,
        here.z,
        ETCH_RADIUS,
        ETCH_DEPTH_PER_SEC,
        dt,
      );
      sandField.disturb(here.x, here.z, DISTURB_RADIUS, DISTURB_STRENGTH, dt);
    }
    prevPos.current = [here.x, here.z];

    // Exit when it wanders far enough past any sand edge. The wall
    // sides (-X / -Z) use a tighter limit INSIDE the wall so the
    // beetle disappears before clipping through the wall body.
    if (
      here.x > EXIT_OUTSIDE_OPEN ||
      here.x < -EXIT_INSIDE_WALL ||
      here.z > EXIT_OUTSIDE_OPEN ||
      here.z < -EXIT_INSIDE_WALL
    ) {
      stateRef.current = 'hidden';
      sleepFor.current = rand(SLEEP_RESPAWN_MIN, SLEEP_RESPAWN_MAX);
      timer.current = 0;
      group.current.visible = false;
    }
  });

  return (
    <group ref={group} visible={false}>
      {/* main body — flat oval. Sphere stretched along Z and
          flattened on Y reads as a beetle shell from the iso angle. */}
      <mesh castShadow scale={[BODY_WIDTH * 10, BODY_HEIGHT * 10, BODY_LENGTH * 10]}>
        <sphereGeometry args={[0.1, 16, 12]} />
        <primitive object={bodyMat} attach="material" />
      </mesh>
      {/* elytra split — thin line down the middle hinting at the
          two wing covers without modelling them */}
      <mesh position={[0, BODY_HEIGHT * 0.95, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.002, BODY_LENGTH * 1.55]} />
        <meshStandardMaterial color="#080606" />
      </mesh>
      {/* legs — two grouped clusters, animated as a single sway each */}
      <group ref={legL} position={[-BODY_WIDTH * 0.55, 0, 0]}>
        <mesh position={[0, -0.005, BODY_LENGTH * 0.3]} rotation={[0, 0, Math.PI / 2]}>
          <boxGeometry args={[0.003, 0.05, 0.003]} />
          <primitive object={legMat} attach="material" />
        </mesh>
        <mesh position={[0, -0.005, 0]} rotation={[0, 0, Math.PI / 2]}>
          <boxGeometry args={[0.003, 0.05, 0.003]} />
          <primitive object={legMat} attach="material" />
        </mesh>
        <mesh position={[0, -0.005, -BODY_LENGTH * 0.3]} rotation={[0, 0, Math.PI / 2]}>
          <boxGeometry args={[0.003, 0.05, 0.003]} />
          <primitive object={legMat} attach="material" />
        </mesh>
      </group>
      <group ref={legR} position={[BODY_WIDTH * 0.55, 0, 0]}>
        <mesh position={[0, -0.005, BODY_LENGTH * 0.3]} rotation={[0, 0, Math.PI / 2]}>
          <boxGeometry args={[0.003, 0.05, 0.003]} />
          <primitive object={legMat} attach="material" />
        </mesh>
        <mesh position={[0, -0.005, 0]} rotation={[0, 0, Math.PI / 2]}>
          <boxGeometry args={[0.003, 0.05, 0.003]} />
          <primitive object={legMat} attach="material" />
        </mesh>
        <mesh position={[0, -0.005, -BODY_LENGTH * 0.3]} rotation={[0, 0, Math.PI / 2]}>
          <boxGeometry args={[0.003, 0.05, 0.003]} />
          <primitive object={legMat} attach="material" />
        </mesh>
      </group>
    </group>
  );
}
