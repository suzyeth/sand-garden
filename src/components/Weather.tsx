import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore, type RainType } from '../sim/store';
import { ambientAudio } from '../sim/audio';
import { SAND_HALF } from '../sim/constants';

/**
 * Weather system. Two pieces in one component:
 *   1. WeatherDriver — a state machine that cycles store.weather:
 *      clear → cloudy → rain → clearing → clear.
 *      Dragonflies gate on 'cloudy'; rain particles render whenever
 *      store.weatherIntensity > 0 (driven by phase, smoothed for ramp).
 *
 *   2. Rain particles — instanced thin streaks falling from sky height
 *      down to sand level, repositioned to the top once they hit
 *      ground. Count + opacity scale with store.weatherIntensity so
 *      the rain ramps up and down smoothly with the phase changes.
 *
 * Implemented as one component so the driver effect and the visuals
 * share the same lifecycle and the rain mesh ref stays scoped.
 */

const RAIN_COUNT = 1100; // pool size — visible count varies by rain type
const RAIN_AREA = SAND_HALF + 1.4; // a bit beyond sand for natural feel
const RAIN_HEIGHT_MIN = 0.2;
const RAIN_HEIGHT_MAX = 5.2;
const RAIN_FALL_SPEED = 12.0; // m/s — fast enough to streak convincingly
// Wind tilt — every drop drifts a bit along world +X as it falls, so
// the rain reads as angled sheets, not a vertical curtain of pixels.
const RAIN_WIND_X = 1.6; // m/s lateral
const RAIN_WIND_Z = 0.4;
// Phase durations (seconds) — sampled in a range so the weather
// doesn't feel metronomic. Rain budget intentionally low: the
// karesansui mood is mostly clear sky, with rain as an occasional
// event, not the default state. Earlier tuning had ~41% rain time
// which felt oppressive; this dials it back to ~22%.
const CLEAR_MIN = 160;
const CLEAR_MAX = 280;
const CLOUDY_MIN = 30;
const CLOUDY_MAX = 55;
const RAIN_MIN = 35;
const RAIN_MAX = 75;
const CLEARING_MIN = 22;
const CLEARING_MAX = 40;

// Per-tier parameters — picked once per rain phase. Visible count
// scales the InstancedMesh.count so drizzle is genuinely sparse;
// streakLen + fallMul + opacityMul give the three a different feel
// at a glance. targetIntensity is what the smoothed intensity ramps
// toward (used by ambient/audio/wetness all downstream).
const RAIN_PARAMS: Record<RainType, {
  count: number;
  streakLen: number;
  fallMul: number;
  opacityMul: number;
  targetIntensity: number;
}> = {
  drizzle:  { count: 380,  streakLen: 0.28, fallMul: 0.75, opacityMul: 0.55, targetIntensity: 0.35 },
  moderate: { count: 820,  streakLen: 0.46, fallMul: 1.00, opacityMul: 1.00, targetIntensity: 0.70 },
  heavy:    { count: 1100, streakLen: 0.70, fallMul: 1.25, opacityMul: 1.35, targetIntensity: 1.00 },
};

// Heavy is rarer — most rain is just rain. Cumulative weights.
function pickRainType(): RainType {
  const r = Math.random();
  if (r < 0.35) return 'drizzle';
  if (r < 0.82) return 'moderate';
  return 'heavy';
}

function pickDuration(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function Weather() {
  const setWeather = useStore((s) => s.setWeather);
  const setWeatherIntensity = useStore((s) => s.setWeatherIntensity);
  const setRainType = useStore((s) => s.setRainType);
  const phaseTimer = useRef(pickDuration(CLEAR_MIN, CLEAR_MAX));
  const intensityRef = useRef(0);
  // Cache the active tier so changes propagate to the geometry length
  // exactly when the phase flips (not every frame). Initialise to
  // moderate so the mesh has a real geometry before the first rain.
  const activeTypeRef = useRef<RainType>('moderate');
  // Track previous debug override values so we can detect edges
  // (off → on, tier swap) and apply the geometry rebuild + setters
  // exactly once on change rather than every frame.
  const prevForceWeatherRef = useRef<ReturnType<typeof useStore.getState>['forceWeather']>(null);
  const prevForceRainTypeRef = useRef<RainType | null>(null);
  // Reused scratch matrix for per-drop transform writes. Reusing
  // avoids allocating a Matrix4 every frame and every initial seed.
  const scratchMatrix = useMemo(() => new THREE.Matrix4(), []);

  // Rain instanced streaks.
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const drops = useMemo(() => {
    return Array.from({ length: RAIN_COUNT }, () => ({
      x: (Math.random() - 0.5) * 2 * RAIN_AREA,
      y:
        RAIN_HEIGHT_MIN +
        Math.random() * (RAIN_HEIGHT_MAX - RAIN_HEIGHT_MIN),
      z: (Math.random() - 0.5) * 2 * RAIN_AREA,
      // Tiny per-drop speed variance so the column doesn't fall
      // uniformly like a curtain.
      speedMul: 0.85 + Math.random() * 0.4,
    }));
  }, []);

  // Streak geometry is rebuilt when the rain tier changes so drizzle
  // shows obviously shorter streaks than heavy. Rotation toward wind
  // direction is baked in here so we don't pay a per-frame transform.
  const buildStreakGeom = (lenY: number): THREE.BoxGeometry => {
    const g = new THREE.BoxGeometry(0.004, lenY, 0.004);
    g.rotateZ(Math.atan2(RAIN_WIND_X, RAIN_FALL_SPEED));
    g.rotateX(Math.atan2(RAIN_WIND_Z, RAIN_FALL_SPEED));
    return g;
  };
  const streakGeomRef = useRef<THREE.BoxGeometry>(
    buildStreakGeom(RAIN_PARAMS.moderate.streakLen),
  );
  const streakMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#cfdbeb',
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    [],
  );

  // Set initial instance matrices once. We seed all RAIN_COUNT slots
  // even though mesh.count may be lower for drizzle — the unused
  // slots are simply not drawn, but having them positioned means we
  // never see a stale fragment when the tier bumps up.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    for (let i = 0; i < RAIN_COUNT; i++) {
      const d = drops[i];
      m.makeTranslation(d.x, d.y, d.z);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // Start hidden — intensity is 0 in 'clear' phase.
    mesh.visible = false;
    mesh.count = RAIN_PARAMS.moderate.count;
  }, [drops]);

  // Apply a tier change immediately — rebuilds streak geometry and
  // updates mesh.count. Used both by the natural FSM and by the
  // debug force-override path.
  const applyTier = (tier: RainType) => {
    activeTypeRef.current = tier;
    setRainType(tier);
    const mesh = meshRef.current;
    if (mesh) {
      const oldGeom = streakGeomRef.current;
      const newGeom = buildStreakGeom(RAIN_PARAMS[tier].streakLen);
      streakGeomRef.current = newGeom;
      mesh.geometry = newGeom;
      mesh.count = RAIN_PARAMS[tier].count;
      oldGeom.dispose();
    }
  };

  useFrame((_, dt) => {
    // ----- driver -----
    const state = useStore.getState();
    const force = state.forceWeather;
    const forceTier = state.forceRainType;

    // Apply debug overrides on the edge they change. While force is
    // active the natural FSM timer is paused so the override holds
    // indefinitely; releasing force (set to null) lets the FSM
    // resume from the current state with a fresh timer.
    if (force !== prevForceWeatherRef.current) {
      if (force !== null) {
        setWeather(force);
      } else {
        // Reset timer so the FSM doesn't immediately advance the
        // moment the user releases the override.
        phaseTimer.current =
          force === null ? 30 + Math.random() * 60 : phaseTimer.current;
      }
      prevForceWeatherRef.current = force;
    }
    if (forceTier !== prevForceRainTypeRef.current) {
      if (forceTier !== null) {
        applyTier(forceTier);
      }
      prevForceRainTypeRef.current = forceTier;
    }

    // FSM only advances when no debug override is pinning the
    // weather state. While forced, the rain/clearing tier still
    // animates the smoothed intensity below — we just skip choosing
    // the next phase.
    if (force === null) {
      phaseTimer.current -= dt;
    }
    const phase = state.weather;
    if (force === null && phaseTimer.current <= 0) {
      let next: typeof phase;
      let dur: number;
      if (phase === 'clear') {
        next = 'cloudy';
        dur = pickDuration(CLOUDY_MIN, CLOUDY_MAX);
      } else if (phase === 'cloudy') {
        next = 'rain';
        dur = pickDuration(RAIN_MIN, RAIN_MAX);
        // Pick a tier for this rain phase BEFORE the intensity starts
        // ramping, so ambient/audio/wetness all read the same params.
        applyTier(pickRainType());
      } else if (phase === 'rain') {
        next = 'clearing';
        dur = pickDuration(CLEARING_MIN, CLEARING_MAX);
      } else {
        next = 'clear';
        dur = pickDuration(CLEAR_MIN, CLEAR_MAX);
      }
      setWeather(next);
      phaseTimer.current = dur;
    }
    // Smoothed intensity target — drives ambient, audio, wetness all
    // off the same number. During 'rain' the target comes from the
    // tier (drizzle 0.35 / moderate 0.7 / heavy 1.0); clearing trails
    // off proportional to whatever just finished. Cloudy is genuinely
    // 0 — earlier versions used 0.05 here as a dragonfly gate, but
    // Dragonflies.tsx now gates on phase === 'cloudy' directly and
    // any non-zero intensity here makes rain drops show up during
    // cloudy phases (visibility threshold is 0.02).
    const tier = activeTypeRef.current;
    const tierP = RAIN_PARAMS[tier];
    const targetIntensity =
      phase === 'rain'
        ? tierP.targetIntensity
        : phase === 'clearing'
        ? tierP.targetIntensity * 0.35
        : 0;
    const ease = 1 - Math.exp(-0.6 * dt); // ~3s smoothing
    intensityRef.current += (targetIntensity - intensityRef.current) * ease;
    setWeatherIntensity(intensityRef.current);
    // Drive the rain audio gain off the same intensity so the audio
    // ramps up + tails off with the visuals.
    ambientAudio.setWeatherIntensity(intensityRef.current);
    // Frog croak gating — only croaks while it's actively raining
    // (not during 'clearing'). Calling the setter every frame is
    // cheap (one boolean write) and avoids syncing edge transitions.
    ambientAudio.setIsRaining(phase === 'rain');

    // ----- rain visuals -----
    const mesh = meshRef.current;
    if (!mesh) return;
    const visible = intensityRef.current > 0.02;
    mesh.visible = visible;
    if (!visible) return;

    const m = scratchMatrix;
    const fall = RAIN_FALL_SPEED * tierP.fallMul * dt;
    const driftX = RAIN_WIND_X * dt;
    const driftZ = RAIN_WIND_Z * dt;
    // Only iterate as many slots as are actually drawn — drizzle
    // saves ~65% of the per-frame matrix work this way.
    const activeCount = mesh.count;
    for (let i = 0; i < activeCount; i++) {
      const d = drops[i];
      d.y -= fall * d.speedMul;
      d.x += driftX;
      d.z += driftZ;
      if (
        d.y < 0.05 ||
        d.x > RAIN_AREA ||
        d.x < -RAIN_AREA ||
        d.z > RAIN_AREA ||
        d.z < -RAIN_AREA
      ) {
        d.x = (Math.random() - 0.5) * 2 * RAIN_AREA;
        d.z = (Math.random() - 0.5) * 2 * RAIN_AREA;
        d.y = RAIN_HEIGHT_MAX - Math.random() * 0.5;
      }
      m.makeTranslation(d.x, d.y, d.z);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    // Opacity follows tier-scaled intensity so heavy looks denser
    // than drizzle even at the same smoothed level.
    streakMat.opacity = (0.28 + 0.45 * intensityRef.current) * tierP.opacityMul;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[streakGeomRef.current, streakMat, RAIN_COUNT]}
      frustumCulled={false}
    />
  );
}
