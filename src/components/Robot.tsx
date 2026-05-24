import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../sim/store';
import {
  generateKaresansuiPath,
  PathPlayback,
} from '../sim/patterns';
import { sandField } from '../sim/sandField';
import { ambientAudio } from '../sim/audio';
import { HOME_STONE_POS } from '../sim/stones';

/**
 * The rake robot - kinematic playback of a precomputed path with a
 * single behaviour: lift the rake during inter-ring / inter-stone
 * transits so the trail doesn't slice across the garden.
 *
 * Phases:
 *   - 'rake'    : normal speed, rake down, etching active. Default.
 *   - 'transit' : rake lifted, no etching, 1.4x speed. Active whenever
 *                 the current path segment is tagged 'transit-ring' or
 *                 'transit-stone'.
 *
 * The path itself comes pre-tagged from patterns.ts: every segment
 * carries a 'ring' / 'transit-ring' / 'transit-stone' flag. This
 * component only has to react to flag changes.
 */

type Props = {
  startPosition: [number, number, number];
};

type Phase = 'rake' | 'transit';

// Zen pace — monk pushing a rake. Transit (rake up) is faster but
// still unhurried.
const SPEED = 0.85; // m/s
const TRANSIT_SPEED_MULT = 1.4;
// Subtle wabi-sabi breathing of the forward speed so the robot doesn't
// feel cadence-perfect. Driven by arc-length so the rhythm tracks the
// path geometry, not wall-clock.
const SPEED_WOBBLE_AMP = 0.12;

function speedWobble(distance: number): number {
  return (
    0.55 * Math.sin(distance * 0.41 + 0.7) +
    0.45 * Math.sin(distance * 1.13 + 2.1)
  );
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// %/sec (Robin Reiter's mower drops 99->97 in ~9s, i.e. 0.22/s).
// Full battery (97 → 18) lasts ~6 min before the robot heads back to
// dock.
const BATTERY_DRAIN_PER_SEC = 0.22;

// Battery FSM thresholds + dock kinematics.
const LOW_BATTERY_THRESHOLD = 18; // below this, head home
const CHARGED_THRESHOLD = 96; // above this, resume raking
// Slower charge — dock visit now lasts ~26s from 18 → 96, which gives
// the user time to notice the LED colour change and feel a real pause.
const CHARGE_RATE_PER_SEC = 3.0; // %/s while docked
// While docked we also pause briefly at the start (settling) and at
// the end (powering up) so the sequence reads as ceremony, not a
// pit-stop.
const DOCK_SETTLE_TIME = 1.4; // s before charging starts
const DOCK_DEPART_TIME = 1.1; // s after fully charged before leaving
// Park INSIDE the garage at the home stone position. HOME_STONE_POS
// is the dock structure at SE corner (6.2, -6.2). The garage is now
// axis-aligned with opening facing world +Z, so the robot's parked
// centre sits 0.25m north of the stone, chassis fully inside and
// nose pointing toward the back wall (-Z direction).
const DOCK_POS: [number, number] = [
  HOME_STONE_POS[0],
  HOME_STONE_POS[1] + 0.25,
];
// Yaw the robot should hold while parked — nose pointing into the
// back of the garage (local -Z direction in world coords with
// GARAGE_YAW=0). atan2(0, +0.25) = 0, meaning the robot's local
// axes match world, with local -Z (front, LED end) facing -Z (back
// of garage). Kept as the formula so any DOCK_POS tweak stays in
// sync automatically.
const DOCK_YAW = Math.atan2(
  HOME_STONE_POS[0] - DOCK_POS[0],
  -(HOME_STONE_POS[1] - DOCK_POS[1]),
);
// Intermediate approach waypoint — sits 0.85m north of DOCK_POS,
// just outside the garage opening on the centreline. Seek-home
// always reaches this point first, then drives straight south into
// the dock. Without it, a low-battery event triggered while raking
// near the home stone made the robot approach from the side and
// clip the garage's flank on the way in.
const APPROACH_POS: [number, number] = [
  DOCK_POS[0],
  DOCK_POS[1] + 0.85,
];
const APPROACH_REACHED_EPS = 0.18;
const SEEK_SPEED = 1.25; // m/s — decisive but not panicked
const RETURN_SPEED = 1.0; // m/s leaving dock back to path
const ARRIVAL_EPS = 0.04; // metres
const YAW_LERP_RATE = 4.5; // s^-1 — angular smoothing during transit
// Decelerate as we approach the dock so the robot doesn't snap into
// place. Within DECEL_RADIUS metres of the target the effective speed
// scales by (dist / DECEL_RADIUS).
const DECEL_RADIUS = 1.0;
const MIN_TRANSIT_SPEED = 0.18;
const LED_COLOR_CHARGE = new THREE.Color('#48d8a8'); // soft green-teal
const LED_COLOR_LOW = new THREE.Color('#ffb040'); // amber when battery low

// Rake bar sits BEHIND the chassis along the robot's local +Z direction
// (forward is local -Z). The 5 teeth are spaced along local X.
const RAKE_OFFSET_BACK = 0.5;
const TEETH_OFFSETS_X = [-0.24, -0.12, 0, 0.12, 0.24] as const;
// Tooth radius 0.035 → ~7cm groove. At iso zoom ~42 that's ~3 screen
// pixels wide; narrower disappears, wider stops looking like karesansui
// rake lines.
const TOOTH_RADIUS = 0.035;
const ETCH_DEPTH_PER_SEC = 9.0;

const ROBOT_BODY_Y = 0.16; // chassis half-height above the sand surface

// Rake lift visual amount + how snappy the lerp into/out of lifted is.
// 1 - exp(-k*dt) -> at k=8 the rake settles 95% in ~0.4s, which reads
// as "deliberate" not "snapping".
const RAKE_LIFT_AMOUNT = 0.07;
const RAKE_LIFT_RATE = 8;

// LED breathing: ~2.5s period, base 0.9 ± 0.8 so the peak hits ~1.7
// (clearly hot) and the trough hits ~0.1 (visibly dim but not off).
const LED_PULSE_OMEGA = (2 * Math.PI) / 2.5;
const LED_BASE = 0.9;
const LED_AMP = 0.8;

// Chassis tilt — pitches the visual rig forward/back in response to
// effective-speed change. Reads as inertia (nose-up when accelerating
// out of a ring, nose-down when settling back to rake speed). The
// rake group lives inside the same visualGroup so it tilts with the
// body, not against it.
const TILT_SMOOTHING_RATE = 5; // s^-1; how fast smoothedSpeed catches up
const TILT_RESPONSE_RATE = 7; // s^-1; how fast chassisTilt eases to target
const TILT_GAIN = 0.18; // (rad per m/s of speed delta)
const TILT_MAX = 0.045; // ~2.6 deg cap
// Color saturation pulse — at peak the LED reads as bright red, at
// trough it reads as a darker cherry. Subtle but reinforces the
// "alive" feel beyond just intensity.
const LED_COLOR_HOT = new THREE.Color('#ff4040');
const LED_COLOR_COLD = new THREE.Color('#a01818');

export function Robot({ startPosition }: Props) {
  // Build the path ONCE per component instance. generateKaresansuiPath
  // is itself pure - same stones in -> same waypoints out.
  const playback = useMemo(
    () => new PathPlayback(generateKaresansuiPath()),
    [],
  );

  const group = useRef<THREE.Group>(null);
  const visualGroup = useRef<THREE.Group>(null);
  const rakeGroup = useRef<THREE.Group>(null);
  const ledMat = useRef<THREE.MeshStandardMaterial>(null);

  const distance = useRef(0);
  const batteryAcc = useRef(0);
  const ledClock = useRef(0);
  const smoothedSpeed = useRef(SPEED);
  const chassisTilt = useRef(0);
  const audioAcc = useRef(0);
  const setRobotPos = useStore((s) => s.setRobotPos);
  const setBattery = useStore((s) => s.setBattery);

  // State-machine state — kept in refs so frame-to-frame updates don't
  // re-render the React tree.
  const phase = useRef<Phase>('rake');
  const rakeLift = useRef(0); // current Y offset of the rake sub-group
  // Previous-frame world positions for the 5 teeth, so etching can
  // paint a continuous LINE instead of a sequence of disconnected
  // blobs. Null when rake was up last frame (we then stamp the first
  // frame of contact instead of dragging from old position).
  const prevTeeth = useRef<Array<[number, number]> | null>(null);

  // ---- battery FSM ----
  // 'rake'      — following the karesansui path; etching active
  // 'seek-home' — straight transit toward the dock; rake up
  // 'dock'      — parked at home stone; battery refilling
  // 'return'    — straight transit back to the path waypoint we left
  type Mode = 'rake' | 'seek-home' | 'dock' | 'return';
  const mode = useRef<Mode>('rake');
  // Playback distance we paused at, used to compute the return target
  // and to restore exactly where we left off.
  const resumeDistance = useRef(0);
  // Cached world position to return to (the path point at
  // resumeDistance — pre-sampled when we leave 'rake').
  const resumeTarget = useRef<[number, number]>([0, 0]);
  const resumeYaw = useRef(0);
  // Dock sub-phase timers — settle (just arrived), charging, depart
  // (fully charged, brief pause before leaving).
  const dockSettleAcc = useRef(0);
  const dockDepartAcc = useRef(0);
  const dockFullyCharged = useRef(false);
  // Two-leg approach flag — false until the robot hits APPROACH_POS,
  // then true for the straight-in entry. Reset whenever seek-home
  // starts.
  const approachReached = useRef(false);
  const setRobotState = useStore((s) => s.setState);

  useFrame((_, dt) => {
    if (!group.current || !rakeGroup.current) return;
    // Clamp dt so a paused tab / dropped frame doesn't push the path
    // playback forward by metres in one step. Anything past 1/15s is
    // treated as 1/15s — the visuals will momentarily lag instead of
    // teleporting + dragging an etch line across the garden.
    if (dt > 1 / 15) dt = 1 / 15;

    // ---- battery FSM dispatch ----------------------------------------
    // While docking / transiting, we steer the chassis manually instead
    // of playback.sample(). Etching is disabled, rake stays lifted, and
    // LED + audio still update at the bottom.
    if (mode.current !== 'rake') {
      // Force rake up.
      const a = 1 - Math.exp(-RAKE_LIFT_RATE * dt);
      rakeLift.current += (RAKE_LIFT_AMOUNT - rakeLift.current) * a;
      rakeGroup.current.position.y = rakeLift.current;
      prevTeeth.current = null;

      // Mode-specific movement.
      const here = group.current.position;
      if (mode.current === 'seek-home') {
        // Two-leg approach: head to APPROACH_POS first (just outside
        // the garage opening), then to DOCK_POS for the straight-in
        // entry. The opening faces NW and DOCK_POS sits inside the
        // garage, so a direct straight-line from any point in the
        // garden would risk clipping a side wall — the waypoint
        // forces a clean centre-axis approach.
        const tx = approachReached.current ? DOCK_POS[0] : APPROACH_POS[0];
        const tz = approachReached.current ? DOCK_POS[1] : APPROACH_POS[1];
        const dx = tx - here.x;
        const dz = tz - here.z;
        const distLeft = Math.hypot(dx, dz);
        const arriveEps = approachReached.current
          ? ARRIVAL_EPS
          : APPROACH_REACHED_EPS;
        if (distLeft < arriveEps) {
          if (!approachReached.current) {
            // Hit the approach waypoint — switch target to DOCK_POS
            // without changing mode. Position is left as-is so the
            // next frame computes a fresh delta toward the dock.
            approachReached.current = true;
          } else {
            // Settle into dock.
            group.current.position.set(tx, ROBOT_BODY_Y, tz);
            mode.current = 'dock';
            dockSettleAcc.current = 0;
            dockDepartAcc.current = 0;
            dockFullyCharged.current = false;
            setRobotState('DOCK');
          }
        } else {
          // Decelerate as we approach so the arrival is not a slam-cut.
          const decel = Math.min(1, distLeft / DECEL_RADIUS);
          const speed = Math.max(
            MIN_TRANSIT_SPEED,
            SEEK_SPEED * (0.35 + 0.65 * decel),
          );
          const step = Math.min(distLeft, speed * dt);
          group.current.position.x += (dx / distLeft) * step;
          group.current.position.z += (dz / distLeft) * step;
          // Smoothly yaw toward motion direction.
          const targetYaw = Math.atan2(dx, -dz);
          const dyaw = wrapAngle(targetYaw - (-group.current.rotation.y));
          group.current.rotation.y =
            -((-group.current.rotation.y) + dyaw * Math.min(1, YAW_LERP_RATE * dt));
          // Slow chassis tilt back to neutral.
          if (visualGroup.current) {
            visualGroup.current.rotation.x *= Math.pow(0.05, dt);
          }
        }
      } else if (mode.current === 'dock') {
        // Snap to dock pose exactly + yaw faces the home stone.
        group.current.position.set(DOCK_POS[0], ROBOT_BODY_Y, DOCK_POS[1]);
        const dyaw = wrapAngle(DOCK_YAW - (-group.current.rotation.y));
        group.current.rotation.y =
          -((-group.current.rotation.y) + dyaw * Math.min(1, YAW_LERP_RATE * dt));
        if (visualGroup.current) {
          visualGroup.current.rotation.x *= Math.pow(0.05, dt);
        }
        // Three sub-phases inside dock:
        //   1. settle  — short pause before any charging begins
        //   2. charging — battery refills at CHARGE_RATE_PER_SEC
        //   3. depart  — brief held pause at full charge before leaving
        if (dockSettleAcc.current < DOCK_SETTLE_TIME) {
          dockSettleAcc.current += dt;
        } else if (!dockFullyCharged.current) {
          const current = useStore.getState().battery;
          const next = Math.min(100, current + CHARGE_RATE_PER_SEC * dt);
          setBattery(next);
          if (next >= CHARGED_THRESHOLD) {
            dockFullyCharged.current = true;
            dockDepartAcc.current = 0;
          }
        } else {
          dockDepartAcc.current += dt;
          if (dockDepartAcc.current >= DOCK_DEPART_TIME) {
            mode.current = 'return';
            setRobotState('SEEK_HOME');
          }
        }
      } else if (mode.current === 'return') {
        const tx = resumeTarget.current[0];
        const tz = resumeTarget.current[1];
        const dx = tx - here.x;
        const dz = tz - here.z;
        const distLeft = Math.hypot(dx, dz);
        if (distLeft < ARRIVAL_EPS) {
          group.current.position.set(tx, ROBOT_BODY_Y, tz);
          // Restore playback distance and resume raking.
          distance.current = resumeDistance.current;
          mode.current = 'rake';
          setRobotState('RAKE');
        } else {
          const step = Math.min(distLeft, RETURN_SPEED * dt);
          group.current.position.x += (dx / distLeft) * step;
          group.current.position.z += (dz / distLeft) * step;
          const targetYaw = Math.atan2(dx, -dz);
          const dyaw = wrapAngle(targetYaw - (-group.current.rotation.y));
          group.current.rotation.y =
            -((-group.current.rotation.y) + dyaw * Math.min(1, YAW_LERP_RATE * dt));
        }
      }

      // Sync store, run LED + audio. During dock the LED switches to a
      // calmer green-teal pulse (charging indicator); during seek-home
      // / return it warms toward amber to read as "low-power transit".
      setRobotPos([group.current.position.x, ROBOT_BODY_Y, group.current.position.z]);
      ledClock.current += dt;
      if (ledMat.current) {
        let cold: THREE.Color;
        let hot: THREE.Color;
        let omegaMul = 1.0;
        if (mode.current === 'dock') {
          cold = LED_COLOR_COLD;
          hot = LED_COLOR_CHARGE;
          // Slow, deliberate breath while charging — half the rake pulse.
          omegaMul = 0.5;
        } else {
          // seek-home / return — warm amber, faster pulse to read as alert.
          cold = LED_COLOR_COLD;
          hot = LED_COLOR_LOW;
          omegaMul = 1.3;
        }
        const s = Math.sin(ledClock.current * LED_PULSE_OMEGA * omegaMul);
        const u = 0.5 + 0.5 * s;
        ledMat.current.emissiveIntensity = LED_BASE + LED_AMP * s;
        ledMat.current.emissive.lerpColors(cold, hot, u);
        ledMat.current.color.lerpColors(cold, hot, u);
      }
      audioAcc.current += dt;
      if (audioAcc.current > 0.1) {
        audioAcc.current = 0;
        const audioSpeed = mode.current === 'dock' ? 0 : 0.55;
        ambientAudio.setSpeedNorm(audioSpeed);
      }
      return;
    }

    // ---- advance + sample chassis AND rake separately ----
    // The rake teeth are physically 0.5m behind the chassis. Decisions
    // about phase / etch / lift must follow the RAKE's path position,
    // not the chassis's — otherwise the chassis-side trail starts
    // etching at the chassis's new orientation 0.5m into the next ring,
    // which paints over the transit ("穿过痕迹"). Sampling at
    // (distance - RAKE_OFFSET_BACK) gives us the path point the rake
    // is currently physically over.
    const liftFrac = Math.min(1, rakeLift.current / RAKE_LIFT_AMOUNT);
    const speedMul = 1 + (TRANSIT_SPEED_MULT - 1) * liftFrac;
    const wobble = 1 + SPEED_WOBBLE_AMP * speedWobble(distance.current);
    const effectiveSpeed = SPEED * speedMul * wobble;
    distance.current += effectiveSpeed * dt;

    const sampled = playback.sample(distance.current);
    const rakeSampled = playback.sample(distance.current - RAKE_OFFSET_BACK);
    const rakeOnTransit =
      rakeSampled.flag === 'transit-ring' ||
      rakeSampled.flag === 'transit-stone';

    // Phase tracks the RAKE, not the chassis. This is what makes the
    // chassis "wait" for its rake to clear the ring before accelerating
    // away, and "wait" for its rake to reach the new ring before
    // dropping it back down.
    phase.current = rakeOnTransit ? 'transit' : 'rake';

    // ---- compute current chassis pose for the visual rig ----
    const { pos, yaw } = sampled;
    group.current.position.set(pos[0], ROBOT_BODY_Y, pos[1]);
    group.current.rotation.y = -yaw;
    setRobotPos([pos[0], ROBOT_BODY_Y, pos[1]]);

    // ---- animate rake lift ----
    const targetLift = phase.current === 'transit' ? RAKE_LIFT_AMOUNT : 0;
    const a = 1 - Math.exp(-RAKE_LIFT_RATE * dt);
    rakeLift.current += (targetLift - rakeLift.current) * a;
    rakeGroup.current.position.y = rakeLift.current;

    // ---- chassis tilt (inertia mock) ----
    // Lag a smoothed speed behind the instantaneous one, then read the
    // gap as "acceleration" and use it as target pitch. Negative tilt
    // = nose up (accelerating out of a ring); positive = nose down
    // (settling). Capped so the wobble can't go cartoony.
    const sA = 1 - Math.exp(-TILT_SMOOTHING_RATE * dt);
    smoothedSpeed.current += (effectiveSpeed - smoothedSpeed.current) * sA;
    const speedDelta = effectiveSpeed - smoothedSpeed.current;
    let targetTilt = -speedDelta * TILT_GAIN;
    if (targetTilt > TILT_MAX) targetTilt = TILT_MAX;
    else if (targetTilt < -TILT_MAX) targetTilt = -TILT_MAX;
    const tA = 1 - Math.exp(-TILT_RESPONSE_RATE * dt);
    chassisTilt.current += (targetTilt - chassisTilt.current) * tA;
    if (visualGroup.current) {
      visualGroup.current.rotation.x = chassisTilt.current;
    }

    // ---- etch sand under each rake tooth ----
    // We etch at the RAKE's path position (rakeSampled.pos / .yaw), not
    // the chassis-derived position. This guarantees the trail follows
    // the actual ring geometry — at a chunk boundary the chassis can
    // already be in the transit segment while the rake's path position
    // is still finishing the ring, so we correctly keep etching until
    // the rake itself crosses the boundary.
    //
    // Etch DEPTH scales by (1 - liftFrac): a fully-down rake digs at
    // full depth, a fully-lifted rake digs nothing, and the lerp in
    // between gives a smooth taper at ring boundaries. Replaces the
    // old binary 25%-lift cutoff that produced abrupt trail ends.
    const liftFracForEtch = Math.min(
      1,
      Math.max(0, rakeLift.current / RAKE_LIFT_AMOUNT),
    );
    const downFrac = 1 - liftFracForEtch;
    const etchActive = !rakeOnTransit && downFrac > 0.02;
    if (etchActive) {
      const ry = rakeSampled.yaw;
      const rfx = Math.sin(ry);
      const rfz = -Math.cos(ry);
      const rakeCenterX = rakeSampled.pos[0];
      const rakeCenterZ = rakeSampled.pos[1];
      const rightX = -rfz;
      const rightZ = rfx;
      const depth = ETCH_DEPTH_PER_SEC * downFrac;
      // Snap the WHOLE rake as a rigid bar, not each tooth
      // independently. Per-tooth snap was making each tooth chase a
      // different groove centroid, which produced jittery dotted
      // lines instead of clean continuous arcs. Snapping the rake
      // centre once and applying the same delta to every tooth keeps
      // the rake geometry rigid while still letting re-passes drift
      // onto established grooves.
      const SNAP_SEARCH_M = 0.035;
      const SNAP_MIN_DEPTH = 0.3;
      const SNAP_STRENGTH = 0.4;
      const [snapCx, snapCz] = sandField.snapToGroove(
        rakeCenterX,
        rakeCenterZ,
        SNAP_SEARCH_M,
        SNAP_MIN_DEPTH,
      );
      const deltaX = (snapCx - rakeCenterX) * SNAP_STRENGTH;
      const deltaZ = (snapCz - rakeCenterZ) * SNAP_STRENGTH;
      const adjustedCx = rakeCenterX + deltaX;
      const adjustedCz = rakeCenterZ + deltaZ;
      const currTeeth: Array<[number, number]> = [];
      for (const off of TEETH_OFFSETS_X) {
        const tx = adjustedCx + rightX * off;
        const tz = adjustedCz + rightZ * off;
        currTeeth.push([tx, tz]);
      }
      if (prevTeeth.current) {
        // Drag each tooth from its previous world position to the
        // current one as a thin groove. This is what gives the trail
        // continuous-line crispness instead of a stamp pattern.
        //
        // Discontinuity guard: a normal per-frame step is ~1-2cm. If
        // the gap is much larger, the frame was a hiccup or we just
        // crossed a sampling discontinuity (e.g. transit boundary
        // sneak-through). Skip the drag, do a point-stamp instead,
        // so we never paint a long ghost line between two unrelated
        // rake positions.
        const MAX_VALID_STEP = 0.12; // m
        const [px0, pz0] = prevTeeth.current[0];
        const [cx0, cz0] = currTeeth[0];
        const stepDist = Math.hypot(cx0 - px0, cz0 - pz0);
        if (stepDist > MAX_VALID_STEP) {
          for (const [tx, tz] of currTeeth) {
            sandField.etch(tx, tz, TOOTH_RADIUS, depth, dt);
          }
        } else {
          for (let k = 0; k < TEETH_OFFSETS_X.length; k++) {
            const [px, pz] = prevTeeth.current[k];
            const [cx, cz] = currTeeth[k];
            sandField.etchLine(px, pz, cx, cz, TOOTH_RADIUS, depth, dt);
          }
        }
      } else {
        // First frame of fresh contact: stamp once at the current pose
        // so we don't draw a line across the transit gap.
        for (const [tx, tz] of currTeeth) {
          sandField.etch(tx, tz, TOOTH_RADIUS, depth, dt);
        }
      }
      prevTeeth.current = currTeeth;
    } else {
      // Rake is up enough that we'd be etching nothing — forget the
      // last tooth positions so re-contact starts as a stamp, not a
      // long drag across the transit gap.
      prevTeeth.current = null;
    }

    // ---- LED breathing ----
    ledClock.current += dt;
    if (ledMat.current) {
      const s = Math.sin(ledClock.current * LED_PULSE_OMEGA);
      // s in [-1, 1] -> u in [0, 1]
      const u = 0.5 + 0.5 * s;
      ledMat.current.emissiveIntensity = LED_BASE + LED_AMP * s;
      ledMat.current.emissive.lerpColors(LED_COLOR_COLD, LED_COLOR_HOT, u);
      ledMat.current.color.lerpColors(LED_COLOR_COLD, LED_COLOR_HOT, u);
    }

    // ---- ambient hum driven by effective speed (throttled to ~10Hz) ----
    audioAcc.current += dt;
    if (audioAcc.current > 0.1) {
      audioAcc.current = 0;
      ambientAudio.setSpeedNorm(effectiveSpeed / SPEED);
    }

    // ---- battery drain (throttled to ~20Hz so the HUD doesn't churn) ----
    batteryAcc.current += dt * BATTERY_DRAIN_PER_SEC;
    if (batteryAcc.current > 0.05) {
      const current = useStore.getState().battery;
      const next = Math.max(0, current - batteryAcc.current);
      setBattery(next);
      batteryAcc.current = 0;
      // If we just crossed the low-battery threshold, kick into
      // seek-home. Cache the current playback distance + world point so
      // we can resume the same arc on the way back.
      if (next < LOW_BATTERY_THRESHOLD && mode.current === 'rake') {
        resumeDistance.current = distance.current;
        const resumeSample = playback.sample(distance.current);
        resumeTarget.current = [resumeSample.pos[0], resumeSample.pos[1]];
        resumeYaw.current = resumeSample.yaw;
        mode.current = 'seek-home';
        approachReached.current = false;
        setRobotState('SEEK_HOME');
      }
    }
  });

  return (
    <group ref={group} position={startPosition}>
      {/* Visual rig is nested so chassis pitch (tilt) doesn't fight
          the outer group's yaw. Yaw is set on `group`; pitch is set
          on `visualGroup`. */}
      <group ref={visualGroup}>
        {/* main chassis */}
        <mesh castShadow>
          <boxGeometry args={[0.7, 0.32, 0.9]} />
          <meshStandardMaterial
            color="#181818"
            roughness={0.45}
            metalness={0.25}
          />
        </mesh>

        {/* rake bar + teeth in their own sub-group so we can lift
            ONLY the rake during transits. */}
        <group ref={rakeGroup}>
          <mesh position={[0, -0.07, 0.5]} castShadow>
            <boxGeometry args={[0.62, 0.06, 0.04]} />
            <meshStandardMaterial color="#3a3a3a" roughness={0.8} />
          </mesh>
          {TEETH_OFFSETS_X.map((x) => (
            <mesh key={x} position={[x, -0.13, 0.52]} castShadow>
              <boxGeometry args={[0.025, 0.07, 0.025]} />
              <meshStandardMaterial color="#222" />
            </mesh>
          ))}
        </group>

        {/* forward direction LED */}
        <mesh position={[0, 0.05, -0.46]}>
          <boxGeometry args={[0.18, 0.04, 0.02]} />
          <meshStandardMaterial
            ref={ledMat}
            color="#ff3030"
            emissive="#ff3030"
            emissiveIntensity={LED_BASE}
          />
        </mesh>
      </group>
    </group>
  );
}
