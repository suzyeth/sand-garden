import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../sim/store';
import { sandField } from '../sim/sandField';
import { SHADER_STONES, STONES } from '../sim/stones';
import { SAND_HALF, CHASSIS_SAFETY } from '../sim/constants';

/**
 * A small gecko that crawls across the karesansui sand, leaving a
 * tiny etched trail behind it. Visible during the daytime window;
 * picks a new random target on the sand every few seconds and walks
 * toward it. The body wiggles side-to-side as it moves, like a real
 * gecko's gait, and the tail tip traces a thin groove into the sand.
 *
 * Differs from Lizard.tsx (now removed):
 *   - moves over the sand, not perched on stones
 *   - tail tip etches a real groove via sandField.etchLine
 *   - body S-curves while walking for biological motion
 */

const GECKO_BODY = '#5b4a2c';
const GECKO_BELLY = '#7a6638';
// Bursty motion: dashes are fast, freezes are short, looks are
// occasional head swivels with no forward motion. Tuned so the
// gecko reads "alive and twitchy", not "vehicle on a path".
const DASH_SPEED_MIN = 0.7;
const DASH_SPEED_MAX = 1.4;
const DASH_DUR_MIN = 0.35;
const DASH_DUR_MAX = 1.1;
const FREEZE_DUR_MIN = 0.4;
const FREEZE_DUR_MAX = 1.6;
const LOOK_DUR_MIN = 0.6;
const LOOK_DUR_MAX = 1.5;
const SAFE_INSET = 1.6; // distance from outer wall to start steering inward
// Sand etch parameters — much smaller than the rake's tooth.
const ETCH_RADIUS = 0.018;
const ETCH_DEPTH_PER_SEC = 2.2;
// Foot scuff — disturb (push back toward pristine) a wider area
// around the body so when the gecko crosses an existing rake groove
// it visibly disrupts the pattern, instead of disappearing into it.
const SCUFF_RADIUS = 0.08;
const SCUFF_STRENGTH = 3.5; // depth/sec removed at falloff = 1

const DAY_T_MIN = 0.02;
const DAY_T_MAX = 0.45;

// Visit cycle — gecko is only present in random windows during the
// day, not every daytime second. Absent stretches are intentionally
// long so re-appearance feels like a small event.
const ABSENT_MIN = 70;
const ABSENT_MAX = 180;
const PRESENT_MIN = 25;
const PRESENT_MAX = 75;

function dayWeight(t: number): number {
  const u = ((t % 1) + 1) % 1;
  if (u < DAY_T_MIN || u > DAY_T_MAX) return 0;
  const fadeIn = THREE.MathUtils.smoothstep(u, DAY_T_MIN, DAY_T_MIN + 0.05);
  const fadeOut =
    1 - THREE.MathUtils.smoothstep(u, DAY_T_MAX - 0.05, DAY_T_MAX);
  return fadeIn * fadeOut;
}

type Mode = 'dash' | 'freeze' | 'look';

export function Gecko() {
  const groupRef = useRef<THREE.Group>(null);
  const bodyGroupRef = useRef<THREE.Group>(null);

  const modeRef = useRef<Mode>('freeze');
  const modeTimer = useRef(0.3); // brief initial pause
  const elapsed = useRef(0);
  const heading = useRef(Math.random() * Math.PI * 2);
  // Visit cycle — start absent with a short delay so the user doesn't
  // see the gecko immediately on page load.
  const visitMode = useRef<'absent' | 'present'>('absent');
  const visitTimer = useRef(8 + Math.random() * 25);
  const currentSpeed = useRef(0);
  // Look-mode head sweep — phase ramps 0 → 1 over the look duration.
  const lookPhase = useRef(0);
  const lookAmp = useRef(0);
  // Per-blink schedule + transient eye scale.
  const nextBlinkAt = useRef(2 + Math.random() * 4);
  const blinkT = useRef(0); // 0 = no blink, 1 = fully closed
  // Previous tail-tip world position so we can etchLine between frames.
  const prevTailPos = useRef<[number, number] | null>(null);

  // Materials.
  const bodyMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: GECKO_BODY,
        roughness: 0.78,
        metalness: 0.05,
      }),
    [],
  );
  const bellyMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: GECKO_BELLY,
        roughness: 0.85,
      }),
    [],
  );
  const eyeMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#0a0808',
        roughness: 0.3,
        metalness: 0.2,
      }),
    [],
  );

  // Geometries.
  const headGeom = useMemo(() => {
    const g = new THREE.CapsuleGeometry(0.018, 0.028, 4, 10);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);
  const bodyGeom = useMemo(() => {
    const g = new THREE.CapsuleGeometry(0.024, 0.072, 4, 10);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);
  const tailGeom1 = useMemo(() => {
    const g = new THREE.CapsuleGeometry(0.016, 0.055, 4, 8);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);
  const tailGeom2 = useMemo(() => {
    const g = new THREE.CapsuleGeometry(0.008, 0.045, 4, 8);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);
  const legGeom = useMemo(
    () => new THREE.CapsuleGeometry(0.005, 0.018, 4, 6),
    [],
  );

  // Refs for the wiggling body parts so we can sway them with elapsed.
  const headRef = useRef<THREE.Mesh>(null);
  const tail1Ref = useRef<THREE.Mesh>(null);
  const tail2Ref = useRef<THREE.Mesh>(null);
  const tailTipRef = useRef<THREE.Object3D>(null);
  const eyeLRef = useRef<THREE.Mesh>(null);
  const eyeRRef = useRef<THREE.Mesh>(null);

  useFrame((_, dt) => {
    if (!groupRef.current) return;
    elapsed.current += dt;

    const w = dayWeight(useStore.getState().cycleT);
    if (w <= 0.001) {
      // Outside the daytime window — force absent and hide.
      groupRef.current.visible = false;
      prevTailPos.current = null;
      visitMode.current = 'absent';
      return;
    }

    // ----- visit cycle ----------------------------------------------
    visitTimer.current -= dt;
    if (visitTimer.current <= 0) {
      if (visitMode.current === 'absent') {
        // Arrive: pick a random safe spawn point inside the sand area.
        const limit = SAND_HALF - SAFE_INSET;
        let sx = 0;
        let sz = 0;
        for (let tries = 0; tries < 14; tries++) {
          const cx = (Math.random() - 0.5) * 2 * limit;
          const cz = (Math.random() - 0.5) * 2 * limit;
          let ok = true;
          for (const stone of SHADER_STONES) {
            const d = Math.hypot(cx - stone.pos[0], cz - stone.pos[1]);
            if (d < stone.radius + CHASSIS_SAFETY) {
              ok = false;
              break;
            }
          }
          if (ok) {
            sx = cx;
            sz = cz;
            break;
          }
        }
        groupRef.current.position.set(sx, 0.025, sz);
        heading.current = Math.random() * Math.PI * 2;
        prevTailPos.current = null;
        // Start in freeze so it sits a moment before darting off.
        modeRef.current = 'freeze';
        modeTimer.current = 0.6 + Math.random() * 1.2;
        visitMode.current = 'present';
        visitTimer.current =
          PRESENT_MIN + Math.random() * (PRESENT_MAX - PRESENT_MIN);
      } else {
        visitMode.current = 'absent';
        visitTimer.current =
          ABSENT_MIN + Math.random() * (ABSENT_MAX - ABSENT_MIN);
      }
    }

    if (visitMode.current === 'absent') {
      groupRef.current.visible = false;
      prevTailPos.current = null;
      return;
    }
    groupRef.current.visible = true;

    const here = groupRef.current.position;

    // ----- bursty FSM --------------------------------------------
    modeTimer.current -= dt;
    if (modeTimer.current <= 0) {
      // Time to transition. Choose next mode based on current.
      const prev = modeRef.current;
      const r = Math.random();
      if (prev === 'dash') {
        // After a dash, almost always freeze.
        modeRef.current = 'freeze';
        modeTimer.current =
          FREEZE_DUR_MIN + Math.random() * (FREEZE_DUR_MAX - FREEZE_DUR_MIN);
      } else if (prev === 'freeze') {
        if (r < 0.55) {
          // dash with possibly big direction change
          modeRef.current = 'dash';
          // 70% small jitter ±0.4 rad, 30% sharp turn ±0.8-2.2 rad.
          if (Math.random() < 0.7) {
            heading.current += (Math.random() - 0.5) * 0.8;
          } else {
            heading.current +=
              (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 1.4);
          }
          currentSpeed.current =
            DASH_SPEED_MIN + Math.random() * (DASH_SPEED_MAX - DASH_SPEED_MIN);
          modeTimer.current =
            DASH_DUR_MIN + Math.random() * (DASH_DUR_MAX - DASH_DUR_MIN);
        } else {
          // look around — pick an amplitude + duration
          modeRef.current = 'look';
          lookPhase.current = 0;
          lookAmp.current = 0.5 + Math.random() * 0.8;
          if (Math.random() < 0.5) lookAmp.current = -lookAmp.current;
          modeTimer.current =
            LOOK_DUR_MIN + Math.random() * (LOOK_DUR_MAX - LOOK_DUR_MIN);
        }
      } else {
        // After a look, go back to freeze briefly before next dash —
        // gives a "decided, then went" feel.
        modeRef.current = 'freeze';
        modeTimer.current = 0.2 + Math.random() * 0.6;
      }
    }

    // ----- continuous motion per mode -----------------------------
    let bodyHeading = heading.current;
    if (modeRef.current === 'dash') {
      // Speed ramps up over the first 0.15s of the dash, then taper
      // toward the end (anticipation + follow-through, no slam-stop).
      const t = 1 - modeTimer.current /
        ((DASH_DUR_MIN + DASH_DUR_MAX) * 0.5);
      const envelope = THREE.MathUtils.smoothstep(t, 0, 0.18) *
        (1 - THREE.MathUtils.smoothstep(t, 0.7, 1.0) * 0.5);
      const speed = currentSpeed.current * envelope;
      here.x += Math.sin(heading.current) * speed * dt;
      here.z += Math.cos(heading.current) * speed * dt;
    } else if (modeRef.current === 'look') {
      // Look — head/body yaws to one side, holds, returns. Use a
      // smooth bell over the look duration for the head sweep.
      const lookDur =
        LOOK_DUR_MIN + (LOOK_DUR_MAX - LOOK_DUR_MIN) * 0.5;
      lookPhase.current += dt / lookDur;
      const phase = Math.min(1, lookPhase.current);
      const bell = Math.sin(phase * Math.PI); // 0 → 1 → 0
      bodyHeading = heading.current + lookAmp.current * bell;
    }

    // Steer back to the safe zone if drifting too close to the wall.
    const wallLimit = SAND_HALF - SAFE_INSET;
    if (Math.abs(here.x) > wallLimit || Math.abs(here.z) > wallLimit) {
      const inward = Math.atan2(-here.x, -here.z);
      let dh = inward - heading.current;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      heading.current += dh * Math.min(1, 1.6 * dt);
    }

    // Stay away from stones — soft repulsion if too close.
    for (const stone of SHADER_STONES) {
      const dx = here.x - stone.pos[0];
      const dz = here.z - stone.pos[1];
      const d = Math.hypot(dx, dz);
      const safe = stone.radius + CHASSIS_SAFETY * 0.5;
      if (d < safe && d > 0.01) {
        // Push position outward, also nudge heading away.
        const push = (safe - d) * 0.6;
        here.x += (dx / d) * push;
        here.z += (dz / d) * push;
        const away = Math.atan2(dx, dz);
        let dh = away - heading.current;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        heading.current += dh * Math.min(1, 3.0 * dt);
      }
    }

    here.y = 0.025;
    groupRef.current.rotation.y = bodyHeading;

    // ----- body wiggle, head idle micro-turn, blinks ---------------
    const moving = modeRef.current === 'dash';
    // Wiggle freq scales with dash speed; small ambient sway at rest.
    const wiggleFreq = moving ? 10.0 + currentSpeed.current * 2 : 2.0;
    const wiggleAmp = moving ? 0.32 : 0.06;
    const wigglePhase = elapsed.current * wiggleFreq;
    // Head additionally micro-turns randomly at rest (slow noise).
    const idleHeadNoise =
      !moving && modeRef.current !== 'look'
        ? Math.sin(elapsed.current * 1.7) * 0.12 +
          Math.sin(elapsed.current * 0.6 + 1.2) * 0.08
        : 0;
    if (headRef.current) {
      headRef.current.rotation.y =
        Math.sin(wigglePhase) * wiggleAmp * 0.55 + idleHeadNoise;
    }
    if (tail1Ref.current) {
      tail1Ref.current.rotation.y =
        -Math.sin(wigglePhase + Math.PI * 0.4) * wiggleAmp;
    }
    if (tail2Ref.current) {
      tail2Ref.current.rotation.y =
        -Math.sin(wigglePhase + Math.PI * 0.7) * wiggleAmp * 1.6;
    }

    // Eye blink — occasional, very quick (~0.12s).
    nextBlinkAt.current -= dt;
    if (nextBlinkAt.current <= 0) {
      blinkT.current = 1;
      nextBlinkAt.current = 3 + Math.random() * 6;
    }
    blinkT.current = Math.max(0, blinkT.current - dt * 8);
    if (eyeLRef.current && eyeRRef.current) {
      const sy = 1 - blinkT.current * 0.92;
      eyeLRef.current.scale.set(1, sy, 1);
      eyeRRef.current.scale.set(1, sy, 1);
    }

    // ----- tail-tip etch (only while actually moving) --------------
    if (moving) {
      const tailLocalZ = -0.18;
      const wigOffsetX = Math.sin(wigglePhase + Math.PI * 0.7) * 0.035;
      const tipLocal = new THREE.Vector3(wigOffsetX, 0, tailLocalZ);
      tipLocal.applyEuler(new THREE.Euler(0, heading.current, 0));
      const tipWorldX = here.x + tipLocal.x;
      const tipWorldZ = here.z + tipLocal.z;
      if (prevTailPos.current) {
        const [px, pz] = prevTailPos.current;
        sandField.etchLine(
          px,
          pz,
          tipWorldX,
          tipWorldZ,
          ETCH_RADIUS,
          ETCH_DEPTH_PER_SEC,
          dt,
        );
      }
      prevTailPos.current = [tipWorldX, tipWorldZ];

      // Body scuff — push the sand back toward pristine in a wider
      // circle around the gecko's body. This is what makes the gecko
      // visibly disrupt the robot's neat rake grooves where it walks
      // across them: existing depth gets erased proportional to its
      // depth, so rake lines fade into "scuffed" patches behind it.
      sandField.disturb(
        here.x,
        here.z,
        SCUFF_RADIUS,
        SCUFF_STRENGTH,
        dt,
      );
    } else {
      prevTailPos.current = null;
    }
  });

  return (
    <group ref={groupRef} visible={false} scale={1.6}>
      <group ref={bodyGroupRef}>
        {/* body */}
        <mesh geometry={bodyGeom} material={bodyMat} castShadow />
        {/* belly tint */}
        <mesh
          geometry={bodyGeom}
          material={bellyMat}
          position={[0, -0.011, 0]}
          scale={[0.96, 0.55, 0.96]}
        />
        {/* head */}
        <mesh
          ref={headRef}
          geometry={headGeom}
          material={bodyMat}
          position={[0, 0.003, 0.078]}
          castShadow
        />
        {/* eyes — refs let useFrame squash them on blink */}
        <mesh ref={eyeLRef} position={[0.012, 0.011, 0.094]} material={eyeMat}>
          <sphereGeometry args={[0.005, 6, 6]} />
        </mesh>
        <mesh ref={eyeRRef} position={[-0.012, 0.011, 0.094]} material={eyeMat}>
          <sphereGeometry args={[0.005, 6, 6]} />
        </mesh>
        {/* tail segment 1 */}
        <mesh
          ref={tail1Ref}
          geometry={tailGeom1}
          material={bodyMat}
          position={[0, -0.001, -0.072]}
          castShadow
        />
        {/* tail segment 2 (tip) */}
        <mesh
          ref={tail2Ref}
          geometry={tailGeom2}
          material={bodyMat}
          position={[0, -0.004, -0.130]}
          castShadow
        />
        <object3D ref={tailTipRef} position={[0, 0, -0.16]} />
        {/* legs */}
        <mesh
          geometry={legGeom}
          material={bodyMat}
          position={[0.030, -0.011, 0.038]}
          rotation={[0, 0, -1.0]}
        />
        <mesh
          geometry={legGeom}
          material={bodyMat}
          position={[-0.030, -0.011, 0.038]}
          rotation={[0, 0, 1.0]}
        />
        <mesh
          geometry={legGeom}
          material={bodyMat}
          position={[0.030, -0.011, -0.038]}
          rotation={[0, 0, -1.0]}
        />
        <mesh
          geometry={legGeom}
          material={bodyMat}
          position={[-0.030, -0.011, -0.038]}
          rotation={[0, 0, 1.0]}
        />
      </group>
    </group>
  );
}

// Re-export so other modules referencing STONES via this file (if any)
// stay consistent — unused otherwise.
export { STONES };
