import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { STONES } from '../sim/stones';
import { SAND_HALF } from '../sim/constants';
import { useStore } from '../sim/store';

/**
 * A small sparrow / wagtail. Same FSM as the butterfly — arrives via
 * Catmull-Rom curve, perches on a stone, "sings" (tail wags), then
 * departs along a second curve. Quieter event than the butterfly:
 * smaller wingspan, slower wing flap on entry, and a more frequent
 * but shorter visit so multiple brief appearances pepper the day.
 *
 * Why a separate component instead of generalising Butterfly: the
 * silhouette, motion frequency, and perch behaviour are all
 * different enough that a generic "winged creature" abstraction
 * would have more conditionals than shared code.
 *
 * Hidden at night so it doesn't compete with fireflies.
 */

type State = 'hidden' | 'flying-in' | 'perching' | 'flying-out';

const BODY_LENGTH = 0.085;
const WINGSPAN = 0.20;

const FLIGHT_ALT_MIN = 0.7;
const FLIGHT_ALT_MAX = 1.4;

const FLY_IN_DUR = 5.5;
const PERCH_DUR = 6.0;
const FLY_OUT_DUR = 5.0;

const FIRST_SLEEP_MIN = 22;
const FIRST_SLEEP_MAX = 50;
const RESPAWN_SLEEP_MIN = 75;
const RESPAWN_SLEEP_MAX = 160;

const SPAWN_RADIUS = SAND_HALF + 2.5;
const NIGHT_HIDE_T = 0.55;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function Sparrow() {
  const group = useRef<THREE.Group>(null);
  // Wings are grouped meshes (we hinge the group, the mesh stays
  // anchored at its inner edge), so these refs are Groups, not Meshes.
  const leftWing = useRef<THREE.Group>(null);
  const rightWing = useRef<THREE.Group>(null);
  const tail = useRef<THREE.Mesh>(null);

  const stateRef = useRef<State>('hidden');
  const timer = useRef(0);
  const sleepFor = useRef(rand(FIRST_SLEEP_MIN, FIRST_SLEEP_MAX));
  const wingPhase = useRef(0);
  const tailPhase = useRef(0);

  const inCurve = useRef<THREE.CatmullRomCurve3 | null>(null);
  const outCurve = useRef<THREE.CatmullRomCurve3 | null>(null);

  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpAhead = useMemo(() => new THREE.Vector3(), []);

  const bodyMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#6d5a48',
        roughness: 0.75,
      }),
    [],
  );
  const bellyMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#e6d8c2',
        roughness: 0.7,
      }),
    [],
  );
  const wingMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#4a3a30',
        roughness: 0.7,
        side: THREE.DoubleSide,
      }),
    [],
  );
  const eyeMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#101010',
        roughness: 0.3,
        metalness: 0.3,
      }),
    [],
  );

  const startCycle = () => {
    const stone = STONES[Math.floor(Math.random() * STONES.length)];
    const perchY = stone.scale[1] * 1.5 + 0.06;
    const perch = new THREE.Vector3(stone.pos[0], perchY, stone.pos[1]);

    const inAngle = rand(0, Math.PI * 2);
    const entry = new THREE.Vector3(
      Math.cos(inAngle) * SPAWN_RADIUS,
      rand(FLIGHT_ALT_MIN, FLIGHT_ALT_MAX),
      Math.sin(inAngle) * SPAWN_RADIUS,
    );
    // Exit roughly opposite of entry so the sparrow visibly crosses
    // the garden, like the butterfly — but tighter jitter so the path
    // feels more deliberate (sparrows know where they're going).
    const exitAngle = inAngle + Math.PI + rand(-0.25, 0.25);
    const exit = new THREE.Vector3(
      Math.cos(exitAngle) * SPAWN_RADIUS,
      rand(FLIGHT_ALT_MIN, FLIGHT_ALT_MAX),
      Math.sin(exitAngle) * SPAWN_RADIUS,
    );

    // Mid control points slightly lifted so the curves arc — but less
    // pronounced than the butterfly's curves; sparrows fly straighter.
    const inMid = entry.clone().lerp(perch, 0.5).add(
      new THREE.Vector3(rand(-0.3, 0.3), 0.2, rand(-0.3, 0.3)),
    );
    inCurve.current = new THREE.CatmullRomCurve3([entry, inMid, perch]);

    const outMid = perch.clone().lerp(exit, 0.5).add(
      new THREE.Vector3(rand(-0.3, 0.3), 0.3, rand(-0.3, 0.3)),
    );
    outCurve.current = new THREE.CatmullRomCurve3([perch, outMid, exit]);

    stateRef.current = 'flying-in';
    timer.current = 0;
    if (group.current) {
      group.current.visible = true;
      group.current.position.copy(entry);
    }
  };

  useFrame((_, dt) => {
    if (!group.current) return;
    // Hide at night — sparrows roost. Override any in-progress
    // animation by snapping back to hidden state.
    const cycleT = useStore.getState().cycleT;
    if (cycleT > NIGHT_HIDE_T) {
      if (stateRef.current !== 'hidden') {
        stateRef.current = 'hidden';
        timer.current = 0;
        sleepFor.current = rand(RESPAWN_SLEEP_MIN, RESPAWN_SLEEP_MAX);
        group.current.visible = false;
      }
      return;
    }
    timer.current += dt;

    // Wing flap — fast on flights, near-zero perched (just micro
    // settle). Tail wag picks up during perch as the "song" cue.
    let flapHz = 0;
    let tailHz = 0;
    if (
      stateRef.current === 'flying-in' ||
      stateRef.current === 'flying-out'
    ) {
      flapHz = 9;
    } else if (stateRef.current === 'perching') {
      flapHz = 0.7;
      tailHz = 3.5;
    }
    wingPhase.current += dt * flapHz * Math.PI * 2;
    tailPhase.current += dt * tailHz * Math.PI * 2;
    const flap = Math.sin(wingPhase.current) * 0.85;
    if (leftWing.current) leftWing.current.rotation.z = -flap;
    if (rightWing.current) rightWing.current.rotation.z = flap;
    if (tail.current) {
      // Tail wag in Y axis like a wagtail — left/right not up/down.
      tail.current.rotation.y = Math.sin(tailPhase.current) * 0.3;
    }

    switch (stateRef.current) {
      case 'hidden':
        if (group.current.visible) group.current.visible = false;
        if (timer.current >= sleepFor.current) startCycle();
        return;
      case 'flying-in': {
        if (!inCurve.current) return;
        const t = Math.min(1, timer.current / FLY_IN_DUR);
        inCurve.current.getPointAt(t, tmpPos);
        group.current.position.copy(tmpPos);
        if (t < 0.96) {
          inCurve.current.getPointAt(Math.min(1, t + 0.02), tmpAhead);
          group.current.lookAt(tmpAhead);
        }
        if (t >= 1) {
          stateRef.current = 'perching';
          timer.current = 0;
        }
        return;
      }
      case 'perching':
        if (timer.current >= PERCH_DUR) {
          stateRef.current = 'flying-out';
          timer.current = 0;
        }
        return;
      case 'flying-out': {
        if (!outCurve.current) return;
        const t = Math.min(1, timer.current / FLY_OUT_DUR);
        outCurve.current.getPointAt(t, tmpPos);
        group.current.position.copy(tmpPos);
        if (t < 0.96) {
          outCurve.current.getPointAt(Math.min(1, t + 0.02), tmpAhead);
          group.current.lookAt(tmpAhead);
        }
        if (t >= 1) {
          stateRef.current = 'hidden';
          timer.current = 0;
          sleepFor.current = rand(RESPAWN_SLEEP_MIN, RESPAWN_SLEEP_MAX);
          group.current.visible = false;
        }
        return;
      }
    }
  });

  const wingW = WINGSPAN * 0.5;
  const wingL = BODY_LENGTH * 0.95;

  return (
    <group ref={group} visible={false}>
      {/* body — small capsule oriented along -Z (forward) */}
      <mesh castShadow>
        <capsuleGeometry args={[0.024, BODY_LENGTH * 0.7, 4, 8]} />
        <primitive object={bodyMat} attach="material" />
      </mesh>
      {/* head — slightly forward of body (-Z is forward after lookAt) */}
      <mesh position={[0, 0.018, -BODY_LENGTH * 0.55]} castShadow>
        <sphereGeometry args={[0.028, 12, 10]} />
        <primitive object={bodyMat} attach="material" />
      </mesh>
      {/* belly highlight — paler sphere below */}
      <mesh position={[0, -0.012, 0]} scale={[1, 0.55, 1]}>
        <sphereGeometry args={[0.024, 10, 8]} />
        <primitive object={bellyMat} attach="material" />
      </mesh>
      {/* eyes */}
      <mesh position={[-0.018, 0.024, -BODY_LENGTH * 0.62]}>
        <sphereGeometry args={[0.005, 6, 6]} />
        <primitive object={eyeMat} attach="material" />
      </mesh>
      <mesh position={[0.018, 0.024, -BODY_LENGTH * 0.62]}>
        <sphereGeometry args={[0.005, 6, 6]} />
        <primitive object={eyeMat} attach="material" />
      </mesh>
      {/* beak — tiny cone */}
      <mesh
        position={[0, 0.012, -BODY_LENGTH * 0.78]}
        rotation={[Math.PI / 2, 0, 0]}
      >
        <coneGeometry args={[0.008, 0.018, 6]} />
        <meshStandardMaterial color="#3a2a18" roughness={0.5} />
      </mesh>
      {/* wings — hinge on body's Z axis, flap symmetrically */}
      <group ref={rightWing}>
        <mesh
          position={[wingW / 2, 0, 0.005]}
          rotation={[Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[wingW, wingL]} />
          <primitive object={wingMat} attach="material" />
        </mesh>
      </group>
      <group ref={leftWing}>
        <mesh
          position={[-wingW / 2, 0, 0.005]}
          rotation={[Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[wingW, wingL]} />
          <primitive object={wingMat} attach="material" />
        </mesh>
      </group>
      {/* tail — flat wedge behind the body that wags during the
          "song" perch state */}
      <mesh ref={tail} position={[0, 0.004, BODY_LENGTH * 0.55]}>
        <boxGeometry args={[0.035, 0.005, 0.06]} />
        <primitive object={bodyMat} attach="material" />
      </mesh>
    </group>
  );
}
