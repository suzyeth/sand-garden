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
const DASH_SPEED_MIN = 0.55;
const DASH_SPEED_MAX = 1.15;
const DASH_DUR_MIN = 0.45;
const DASH_DUR_MAX = 1.2;
const FREEZE_DUR_MIN = 0.55;
const FREEZE_DUR_MAX = 1.8;
const LOOK_DUR_MIN = 0.7;
const LOOK_DUR_MAX = 1.6;
const SAFE_INSET = 1.6; // distance from outer wall to start steering inward
// Body yaw smoothing — the kinematic heading can change abruptly
// when a new dash starts or when wall/stone steering kicks in. The
// rendered body yaw catches up over time at this rate so we never
// see the gecko snap to a new orientation in a single frame. Higher
// values = snappier turns; ~7 reads as a real lizard's quick pivot.
const BODY_YAW_RATE = 7.0;
// Stronger pre-dash orient: when a new dash heading is more than
// this many radians away from the current body yaw, the gecko spends
// a fraction of its dash budget rotating in place first. Reads as
// "decide → turn → go", not "vector-jump-and-translate".
const ORIENT_THRESHOLD = 0.6;
// Speed target lerp — currentSpeed eases toward targetSpeed at this
// rate so dashes ramp up like muscle effort rather than snapping on.
// 6/s means the speed reaches ~95% in ~0.5s; combined with the dash
// envelope this gives a believable accelerate-cruise-decelerate arc.
const SPEED_RAMP_RATE = 6.0;
// Heading lerp — `heading` (motion vector) eases toward
// `headingTarget` (intent set by the FSM + wall/stone steering)
// at this rate. Combined with the body-yaw lerp this gives two
// stages of smoothing so even rapid intent changes look like a
// graceful curve, not a snap.
const HEADING_RATE = 8.0;
// Head leads body: when the body is mid-pivot, the head looks farther
// ahead than the chassis is pointing — a real lizard's head turns
// first, then the body follows. Fraction of the remaining yaw delta.
const HEAD_LEAD_FRAC = 0.35;
const HEAD_LEAD_MAX = 0.55; // rad — cap so the head doesn't twist absurdly
// Breathing bob — subtle vertical sinusoid during freeze/look so the
// gecko doesn't feel statue-frozen. ~1.3 Hz, ±5mm.
const BREATH_HZ = 1.3;
const BREATH_AMP = 0.005;
// Gait stride — one full leg cycle per this much distance walked.
// Tuned to ~0.07m so a slow dash shows a slow gait and a fast dash
// shows a brisk one, but both have ONE leg cycle per ~body length
// of travel. Reads as "stepping" instead of "leg-paddling".
const GAIT_STRIDE = 0.07;
// Body S-bend wave amplitude — lateral X offset (perpendicular to
// body Z axis) per segment. The mid segment lags the front by
// ~half wavelength; back lags front by ~full wavelength.
const BODY_WAVE_AMP = 0.011;
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
// Arrival fade-in: when the gecko appears it scales up from 0 → 1
// over this many seconds, so the new visit doesn't pop in.
const ARRIVE_FADE_SEC = 0.8;

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

  const modeRef = useRef<Mode>('freeze');
  const modeTimer = useRef(0.3); // brief initial pause
  const elapsed = useRef(0);
  const heading = useRef(Math.random() * Math.PI * 2);
  // Kinematic heading TARGET — the FSM and wall/stone steering
  // mutate this, and `heading` lerps toward it each frame at
  // HEADING_RATE. Decouples "intent" (target) from "current
  // motion direction" (heading) so even direction changes ease in.
  const headingTarget = useRef(heading.current);
  // Smoothed body yaw — what we actually write to rotation.y. Lerps
  // toward `heading` at BODY_YAW_RATE so direction changes look like
  // a pivot, not a teleport.
  const bodyYaw = useRef(Math.random() * Math.PI * 2);
  // Pre-dash orient flag — when set, the dash hasn't started moving
  // yet; we're still rotating in place. Cleared once body yaw
  // catches up within ~0.15 rad of heading.
  const orienting = useRef(false);
  // Visit cycle — start absent with a short delay so the user doesn't
  // see the gecko immediately on page load. 'leaving' is the
  // wind-down state: the gecko dashes toward a chosen hide stone
  // and only flips to 'absent' once it gets there (or after a
  // fallback timeout, so it can't get stuck if it's blocked).
  const visitMode = useRef<'absent' | 'present' | 'leaving'>('absent');
  const visitTimer = useRef(8 + Math.random() * 25);
  // Stone the gecko is currently retreating toward, if any.
  const hideStone = useRef<{ pos: [number, number]; radius: number } | null>(
    null,
  );
  const leaveTimeout = useRef(0);
  // Arrival scale ramp — 0 on spawn, eases up to 1 over ARRIVE_FADE_SEC.
  // When entering 'leaving' it stays at 1; on leave-completion it
  // reverts to 0 via group.visible toggle. The fade is purely scale,
  // no opacity, since the gecko has multiple sub-materials and
  // toggling each one's opacity is fragile.
  const arriveTimer = useRef(0);
  const currentSpeed = useRef(0);
  // Target speed the FSM sets at decision time; currentSpeed lerps
  // toward it so accelerations aren't step-functions.
  const targetSpeed = useRef(0);
  // Look-mode head sweep — phase ramps 0 → 1 over the look duration.
  const lookPhase = useRef(0);
  const lookAmp = useRef(0);
  // Per-blink schedule + transient eye scale.
  const nextBlinkAt = useRef(2 + Math.random() * 4);
  const blinkT = useRef(0); // 0 = no blink, 1 = fully closed
  // Previous tail-tip world position so we can etchLine between frames.
  const prevTailPos = useRef<[number, number] | null>(null);
  // Scratch Vector3 + Euler reused by the tail-tip etch math so we
  // don't allocate two THREE objects per frame during dashes.
  const tipScratch = useMemo(() => new THREE.Vector3(), []);
  const eulerScratch = useMemo(() => new THREE.Euler(), []);

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
  // Body split into THREE segments (front / mid / back) so the
  // chassis can S-bend laterally as the gecko walks — single-mesh
  // body was rigid and made the motion read as "swimming" rather
  // than "walking". Each segment is a short capsule + per-frame X
  // offset with phase lag so the wave propagates from head to tail.
  const bodyFrontGeom = useMemo(() => {
    const g = new THREE.CapsuleGeometry(0.024, 0.022, 4, 10);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);
  const bodyMidGeom = useMemo(() => {
    const g = new THREE.CapsuleGeometry(0.026, 0.024, 4, 10);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);
  const bodyBackGeom = useMemo(() => {
    const g = new THREE.CapsuleGeometry(0.022, 0.022, 4, 10);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);
  // Dorsal hump — flattened sphere sitting on top of bodyMid for a
  // visible spine ridge. Without it the gecko silhouette from iso
  // reads as a flat blob.
  const dorsalGeom = useMemo(() => new THREE.SphereGeometry(0.018, 10, 8), []);
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
  const eyeLRef = useRef<THREE.Mesh>(null);
  const eyeRRef = useRef<THREE.Mesh>(null);
  // Body segment refs — driven by per-frame X-offset wave for the
  // S-bend.
  const bodyFrontRef = useRef<THREE.Mesh>(null);
  const bodyMidRef = useRef<THREE.Mesh>(null);
  const bodyBackRef = useRef<THREE.Mesh>(null);
  // Distance walked since last frame — accumulates to drive the gait
  // phase. Real lizards take one full leg cycle per ~one body length
  // of travel; the GAIT_STRIDE constant maps distance to phase.
  const distanceWalked = useRef(0);
  // Previous-frame position so we can compute the per-frame delta.
  const prevPos = useRef<[number, number]>([0, 0]);
  // Legs — each is a small <group> at the leg's anchor so we can
  // rotate around Y to swing the leg forward/back as the gecko
  // walks. Trot gait: front-left + back-right swing together,
  // opposite of front-right + back-left.
  const legFLRef = useRef<THREE.Group>(null);
  const legFRRef = useRef<THREE.Group>(null);
  const legBLRef = useRef<THREE.Group>(null);
  const legBRRef = useRef<THREE.Group>(null);

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
      if (visitMode.current === 'present') {
        // Don't vanish in place — switch to 'leaving' and pick the
        // nearest stone as the hide target. The gecko stays visible
        // and ACTIVE; the per-frame block below will bias its
        // heading toward the stone every tick.
        const here2 = groupRef.current.position;
        let best: { pos: [number, number]; radius: number } | null = null;
        let bestDist = Infinity;
        for (const stone of SHADER_STONES) {
          const d2 = Math.hypot(here2.x - stone.pos[0], here2.z - stone.pos[1]);
          if (d2 < bestDist) {
            bestDist = d2;
            best = { pos: stone.pos, radius: stone.radius };
          }
        }
        hideStone.current = best;
        visitMode.current = 'leaving';
        // Fallback timeout — if it can't reach the stone in 12s
        // (blocked, weird angle, etc.) it vanishes anyway so it
        // can't get stuck forever in the leaving state.
        leaveTimeout.current = 12;
        // Reset visitTimer to a small value so this block won't
        // re-fire unexpectedly while leaving.
        visitTimer.current = 999;
        return;
      }
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
        // Initial heading + bodyYaw alignment so the spawn doesn't
        // pop in mid-pivot.
        headingTarget.current = heading.current;
        bodyYaw.current = heading.current;
        // Reset arrival fade — gecko scales up from 0 over the next
        // ARRIVE_FADE_SEC seconds rather than popping in full size.
        arriveTimer.current = 0;
        visitMode.current = 'present';
        visitTimer.current =
          PRESENT_MIN + Math.random() * (PRESENT_MAX - PRESENT_MIN);
      }
      // No 'else' — the leaving-state handler above is what flips
      // present → absent (via the stone-hide check), not the visit
      // timer expiry.
    }

    if (visitMode.current === 'absent') {
      groupRef.current.visible = false;
      prevTailPos.current = null;
      return;
    }
    groupRef.current.visible = true;

    const here = groupRef.current.position;

    // ----- leaving: bias toward the hide stone every frame ----------
    if (visitMode.current === 'leaving') {
      leaveTimeout.current -= dt;
      const stone = hideStone.current;
      if (stone) {
        const dx = stone.pos[0] - here.x;
        const dz = stone.pos[1] - here.z;
        const distToStone = Math.hypot(dx, dz);
        // Hide when we get within the stone's "tucked under" range.
        // Slightly inside the stone's radius so the gecko visibly
        // disappears into the stone's silhouette rather than next
        // to it.
        const hideRadius = stone.radius + 0.05;
        if (distToStone < hideRadius || leaveTimeout.current <= 0) {
          visitMode.current = 'absent';
          visitTimer.current =
            ABSENT_MIN + Math.random() * (ABSENT_MAX - ABSENT_MIN);
          groupRef.current.visible = false;
          prevTailPos.current = null;
          hideStone.current = null;
          return;
        }
        // Steer the heading target toward the stone every frame.
        // The headingTarget → heading → bodyYaw chain smooths it.
        headingTarget.current = Math.atan2(dx, dz);
        // Force more dashes than freezes during the retreat so the
        // gecko actually arrives. Bump the FSM toward dash if it's
        // currently freezing or looking and modeTimer is comfortable.
        if (modeRef.current !== 'dash' && modeTimer.current > 0.3) {
          // Cut the current mode short — encourage faster transition
          // into a dash on the next decision tick.
          modeTimer.current = 0.05;
        }
      }
    }

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
          // Set the TARGET — `heading` lerps toward it so the
          // motion vector itself eases through the change.
          if (Math.random() < 0.7) {
            headingTarget.current += (Math.random() - 0.5) * 0.8;
          } else {
            headingTarget.current +=
              (Math.random() < 0.5 ? -1 : 1) * (0.8 + Math.random() * 1.4);
          }
          // If the new heading target requires a big rotation, enter
          // orient mode so the body finishes pivoting before any
          // forward motion. The body yaw smoothing then takes
          // ~0.1-0.25s to catch up, during which currentSpeed
          // effectively stays 0.
          let dh = headingTarget.current - bodyYaw.current;
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          orienting.current = Math.abs(dh) > ORIENT_THRESHOLD;
          // Set TARGET speed; actual currentSpeed eases toward it
          // below. The dash envelope still scales the realised speed
          // for anticipation/follow-through on top of the lerp.
          targetSpeed.current =
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
        // After a look, commit the body toward where the head was
        // pointing — set the heading target half-way to the look
        // amplitude so the next dash naturally faces the inspected
        // direction. Reads as "decided after looking" rather than
        // "looked, forgot, picked a random direction".
        headingTarget.current += lookAmp.current * 0.5;
        modeRef.current = 'freeze';
        modeTimer.current = 0.2 + Math.random() * 0.6;
      }
      // Whenever we leave a dash (into freeze or look), zero the
      // target so currentSpeed eases down instead of cliff-falling.
      if (modeRef.current !== 'dash') {
        targetSpeed.current = 0;
      }
    }

    // Ease currentSpeed toward target every frame regardless of
    // mode — this is what produces the smooth accel/decel curve.
    const speedStep = 1 - Math.exp(-SPEED_RAMP_RATE * dt);
    currentSpeed.current +=
      (targetSpeed.current - currentSpeed.current) * speedStep;

    // ----- continuous motion per mode -----------------------------
    // Head offset is added on top of the smoothed body yaw — look
    // mode only swivels the head, not the entire body.
    let headOffset = 0;
    if (modeRef.current === 'dash') {
      // Burst envelope: fast rise to peak in first ~12% of the dash
      // (the "push"), then long decay via (1-t)^0.8. Reads as a real
      // lizard burst — explosive start, glide-and-slow tail —
      // instead of a symmetric smoothstep ramp.
      const t = THREE.MathUtils.clamp(
        1 - modeTimer.current / ((DASH_DUR_MIN + DASH_DUR_MAX) * 0.5),
        0,
        1,
      );
      const envelope =
        THREE.MathUtils.smoothstep(t, 0, 0.12) * Math.pow(1 - t, 0.8);
      // While orienting, hold position — the body is still rotating
      // into place. Clear orient flag once the smoothed yaw is close
      // enough to the kinematic heading.
      let dh = heading.current - bodyYaw.current;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      if (orienting.current && Math.abs(dh) < 0.15) {
        orienting.current = false;
      }
      const speed = orienting.current ? 0 : currentSpeed.current * envelope;
      here.x += Math.sin(heading.current) * speed * dt;
      here.z += Math.cos(heading.current) * speed * dt;
    } else if (modeRef.current === 'look') {
      // Look — head only. Body stays facing heading.current; the
      // head swings to one side, holds briefly, returns. Bell curve
      // is keyed to the ACTUAL remaining modeTimer (not a constant
      // average) so the swing always lasts exactly as long as the
      // look mode itself, regardless of which random duration was
      // picked. Previously used a constant which made the head
      // sometimes finish swinging before the mode ended, then snap.
      const lookDur =
        LOOK_DUR_MIN + (LOOK_DUR_MAX - LOOK_DUR_MIN) * 0.5;
      lookPhase.current += dt / lookDur;
      const phase = Math.min(1, lookPhase.current);
      const bell = Math.sin(phase * Math.PI); // 0 → 1 → 0
      headOffset = lookAmp.current * bell;
    }

    // Stone repulsion — was direct position push + heading nudge,
    // which could jerk the chassis. Now we ONLY nudge the heading
    // target (and the heading lerp smooths the change) UNLESS the
    // gecko is actually overlapping the stone, in which case we
    // still push it out. Reads as a slow steer-around instead of
    // a hard bump.
    // (Real stone-repulsion code is below; this comment frames why
    // the math is split between target nudge + emergency push.)

    // Steer back to the safe zone if drifting too close to the wall.
    // Mutates the TARGET so the heading lerp smooths the correction.
    const wallLimit = SAND_HALF - SAFE_INSET;
    if (Math.abs(here.x) > wallLimit || Math.abs(here.z) > wallLimit) {
      const inward = Math.atan2(-here.x, -here.z);
      let dh = inward - headingTarget.current;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      headingTarget.current += dh * Math.min(1, 1.6 * dt);
    }

    // Stay away from stones — split into a smooth "steer around"
    // zone and a hard "actually overlapping, push out" zone. In the
    // steer zone (within 1.5x safe distance) we only nudge the
    // heading target. Position is only force-pushed when the gecko
    // is literally inside the stone's safe radius — that's the only
    // case where direct kinematic correction is justified.
    for (const stone of SHADER_STONES) {
      const dx = here.x - stone.pos[0];
      const dz = here.z - stone.pos[1];
      const d = Math.hypot(dx, dz);
      if (d <= 0.01) continue;
      const safe = stone.radius + CHASSIS_SAFETY * 0.5;
      const steerZone = safe * 1.5;
      if (d < steerZone) {
        const away = Math.atan2(dx, dz);
        let dh = away - headingTarget.current;
        while (dh > Math.PI) dh -= Math.PI * 2;
        while (dh < -Math.PI) dh += Math.PI * 2;
        // Steer strength grows as we get closer.
        const closeness = 1 - d / steerZone;
        headingTarget.current += dh * Math.min(1, 2.0 * closeness * dt);
      }
      if (d < safe) {
        // Emergency push — gecko has overlapped, eject outward.
        const push = (safe - d) * 0.6;
        here.x += (dx / d) * push;
        here.z += (dz / d) * push;
      }
    }

    // Lerp heading toward headingTarget — the second smoothing
    // stage. Wrap-aware delta so 2π wraps don't cause long spins.
    let headDelta = headingTarget.current - heading.current;
    while (headDelta > Math.PI) headDelta -= Math.PI * 2;
    while (headDelta < -Math.PI) headDelta += Math.PI * 2;
    const headStep = 1 - Math.exp(-HEADING_RATE * dt);
    heading.current += headDelta * headStep;

    // Breathing bob — subtle vertical lift during freeze / look so
    // the gecko doesn't feel petrified. Disabled during dashes (the
    // wiggle + stride bob are doing the alive-work) and during
    // orient (committing to a turn, body steady).
    const stillForBreath =
      modeRef.current !== 'dash' || orienting.current;
    const breathBob = stillForBreath
      ? Math.sin(elapsed.current * BREATH_HZ * Math.PI * 2) * BREATH_AMP
      : 0;
    // Stride bob — vertical body bump synced to the gait. Each leg
    // pair plant pushes the body up; the recover-and-swing phase
    // lets it drop. Without this the gecko slides forward at a
    // constant Y and reads as "swimming" instead of "walking".
    // 2× wigglePhase because the body cycle is half the leg cycle
    // (full leg cycle = one full bob — left-plant up + right-plant up).
    const moving0 = modeRef.current === 'dash' && !orienting.current;
    const strideBob = moving0
      ? Math.abs(Math.sin(elapsed.current * (10.0 + currentSpeed.current * 2) * 0.6)) *
        0.012
      : 0;
    here.y = 0.025 + breathBob + strideBob;

    // Smooth the body yaw — never assigned directly to the group.
    // Wrap-aware delta keeps the lerp going the short way around the
    // 2π wrap (otherwise a heading just above +π and a body yaw just
    // below -π would spin the long way).
    let yawDelta = heading.current - bodyYaw.current;
    while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
    while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
    const yawStep = 1 - Math.exp(-BODY_YAW_RATE * dt);
    bodyYaw.current += yawDelta * yawStep;
    groupRef.current.rotation.y = bodyYaw.current;

    // Arrival fade — scale up from 0 → 1 over ARRIVE_FADE_SEC after
    // spawn so the new visit doesn't pop in. Outer group scale is
    // already set to 1.6 in the JSX (we keep that base scale), so
    // we multiply by an arrive factor that eases in.
    if (arriveTimer.current < ARRIVE_FADE_SEC) {
      arriveTimer.current += dt;
      const f = THREE.MathUtils.clamp(
        arriveTimer.current / ARRIVE_FADE_SEC,
        0,
        1,
      );
      const ease = f * f * (3 - 2 * f); // smoothstep
      groupRef.current.scale.setScalar(1.6 * ease);
    } else if (groupRef.current.scale.x !== 1.6) {
      groupRef.current.scale.setScalar(1.6);
    }

    // Head lead: when the body is still rotating toward the
    // kinematic heading (yawDelta non-zero), the head turns ahead
    // by a fraction of the remaining delta. Reads as "head turns
    // first, body follows" — characteristic of real lizards
    // committing to a new direction.
    const headLead = THREE.MathUtils.clamp(
      yawDelta * HEAD_LEAD_FRAC,
      -HEAD_LEAD_MAX,
      HEAD_LEAD_MAX,
    );

    // ----- body wiggle, head idle micro-turn, blinks ---------------
    const moving = modeRef.current === 'dash' && !orienting.current;

    // Distance walked this frame — drives the gait phase so leg
    // cycle frequency = walk speed / stride. One full leg cycle per
    // GAIT_STRIDE metres of travel; a slow dash has a slow gait, a
    // fast dash has a brisk one, never paddling-in-place.
    const dx = here.x - prevPos.current[0];
    const dz = here.z - prevPos.current[1];
    const stepDist = Math.hypot(dx, dz);
    distanceWalked.current += stepDist;
    prevPos.current[0] = here.x;
    prevPos.current[1] = here.z;

    // Gait phase keyed to distance for moving; freeze/look fall back
    // to a slow time-driven idle so head + tail still micro-sway.
    let wigglePhase = 0;
    let wiggleAmp = 0;
    if (moving) {
      wigglePhase = (distanceWalked.current / GAIT_STRIDE) * Math.PI * 2;
      wiggleAmp = 0.32;
    } else if (modeRef.current === 'look') {
      wigglePhase = elapsed.current * 1.6;
      wiggleAmp = 0.03;
    }
    // Head additionally micro-turns randomly at rest (slow noise) —
    // but only when NOT in look mode (look already drives the head).
    const idleHeadNoise =
      !moving && modeRef.current !== 'look'
        ? Math.sin(elapsed.current * 1.7) * 0.10 +
          Math.sin(elapsed.current * 0.6 + 1.2) * 0.06
        : 0;
    if (headRef.current) {
      headRef.current.rotation.y =
        Math.sin(wigglePhase) * wiggleAmp * 0.55 +
        idleHeadNoise +
        headOffset +
        headLead;
      // Head pitch bob — vertical micro-bob synced to the stride so
      // the gecko "head-bobs" while walking. Half the body bob
      // amplitude (~4mm angle equivalent) so it's noticeable but
      // not exaggerated.
      headRef.current.rotation.x = moving
        ? Math.abs(Math.sin(wigglePhase)) * 0.18
        : 0;
    }

    // Body S-bend wave — each segment is offset laterally (local X,
    // perpendicular to body Z axis) by a phase-lagged sin. Wave
    // propagates head-to-tail so the body reads as a snake-like
    // ripple, not a rigid plank. Only active while moving; freeze
    // returns segments to centreline.
    const bodyWaveAmp = moving ? BODY_WAVE_AMP : 0;
    if (bodyFrontRef.current) {
      bodyFrontRef.current.position.x = Math.sin(wigglePhase) * bodyWaveAmp;
    }
    if (bodyMidRef.current) {
      bodyMidRef.current.position.x =
        Math.sin(wigglePhase - Math.PI * 0.6) * bodyWaveAmp;
    }
    if (bodyBackRef.current) {
      bodyBackRef.current.position.x =
        Math.sin(wigglePhase - Math.PI * 1.2) * bodyWaveAmp * 1.15;
    }
    if (tail1Ref.current) {
      tail1Ref.current.rotation.y =
        -Math.sin(wigglePhase + Math.PI * 0.4) * wiggleAmp;
    }
    if (tail2Ref.current) {
      // Larger phase lag (0.95π vs 0.7π) so the tip trails the base
      // by almost half a wave — wave reads as a snake-like ripple
      // travelling down the tail instead of two segments swinging
      // in near-unison.
      tail2Ref.current.rotation.y =
        -Math.sin(wigglePhase + Math.PI * 0.95) * wiggleAmp * 1.6;
    }

    // Leg gait — diagonal trot pattern (FR+BL ↔ FL+BR alternate).
    // Swing amplitude (Y rotation) scales with realised speed.
    // The LIFT (X rotation) only fires during the forward half of
    // each leg's swing cycle so the leg visibly lifts off the sand,
    // recovers forward, then plants back down. Without lift the
    // animation was a pure lateral swing — legs slid sideways, not
    // a walking gait.
    const gaitPhase = wigglePhase * 0.6;
    const legSwing = moving
      ? Math.sin(gaitPhase) * (0.35 + currentSpeed.current * 0.08)
      : 0;
    // Lift envelope: positive half of sin lifts that pair, negative
    // half plants the opposite pair. Using max(0, sin) gives a
    // half-wave per pair.
    const liftAmp = 0.55;
    const liftAB = moving ? Math.max(0, Math.sin(gaitPhase)) * liftAmp : 0;
    const liftCD = moving ? Math.max(0, -Math.sin(gaitPhase)) * liftAmp : 0;
    if (legFRRef.current) {
      legFRRef.current.rotation.y = legSwing;
      legFRRef.current.rotation.x = liftAB;
    }
    if (legBLRef.current) {
      legBLRef.current.rotation.y = legSwing;
      legBLRef.current.rotation.x = liftAB;
    }
    if (legFLRef.current) {
      legFLRef.current.rotation.y = -legSwing;
      legFLRef.current.rotation.x = liftCD;
    }
    if (legBRRef.current) {
      legBRRef.current.rotation.y = -legSwing;
      legBRRef.current.rotation.x = liftCD;
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
      tipScratch.set(wigOffsetX, 0, tailLocalZ);
      eulerScratch.set(0, heading.current, 0);
      tipScratch.applyEuler(eulerScratch);
      const tipWorldX = here.x + tipScratch.x;
      const tipWorldZ = here.z + tipScratch.z;
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
      <group>
        {/* body — 3 segments so the chassis can S-bend laterally
            as the gecko walks. Each segment's X offset is driven
            per-frame from a phase-lagged sin wave (see useFrame). */}
        <mesh
          ref={bodyFrontRef}
          geometry={bodyFrontGeom}
          material={bodyMat}
          position={[0, 0, 0.038]}
          castShadow
        />
        <mesh
          ref={bodyMidRef}
          geometry={bodyMidGeom}
          material={bodyMat}
          position={[0, 0, 0]}
          castShadow
        />
        <mesh
          ref={bodyBackRef}
          geometry={bodyBackGeom}
          material={bodyMat}
          position={[0, 0, -0.036]}
          castShadow
        />
        {/* dorsal hump — flattened sphere over the mid segment for
            a visible spine ridge. Lifts the silhouette from "flat
            blob" to "low-slung lizard". */}
        <mesh
          geometry={dorsalGeom}
          material={bodyMat}
          position={[0, 0.018, 0]}
          scale={[0.85, 0.55, 1.3]}
        />
        {/* belly tint — single piece spanning roughly the whole
            body length; the lateral wave on the body segments
            isn't carried by the belly, which is fine since the
            belly is barely visible from iso. */}
        <mesh
          geometry={bodyMidGeom}
          material={bellyMat}
          position={[0, -0.011, 0]}
          scale={[0.96, 0.55, 3.4]}
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
        {/* legs — each wrapped in a group at its anchor so we can
            swing the group's Y rotation as the gait cycle runs.
            The inner mesh keeps its Z-axis rotation (which splays
            the capsule out sideways along world X). */}
        <group ref={legFRRef} position={[0.030, -0.011, 0.038]}>
          <mesh geometry={legGeom} material={bodyMat} rotation={[0, 0, -1.0]} />
        </group>
        <group ref={legFLRef} position={[-0.030, -0.011, 0.038]}>
          <mesh geometry={legGeom} material={bodyMat} rotation={[0, 0, 1.0]} />
        </group>
        <group ref={legBRRef} position={[0.030, -0.011, -0.038]}>
          <mesh geometry={legGeom} material={bodyMat} rotation={[0, 0, -1.0]} />
        </group>
        <group ref={legBLRef} position={[-0.030, -0.011, -0.038]}>
          <mesh geometry={legGeom} material={bodyMat} rotation={[0, 0, 1.0]} />
        </group>
      </group>
    </group>
  );
}

// Re-export so other modules referencing STONES via this file (if any)
// stay consistent — unused otherwise.
export { STONES };
