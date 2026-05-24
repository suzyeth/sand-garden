import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../sim/store';
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

const RAIN_COUNT = 1100;
const RAIN_AREA = SAND_HALF + 1.4; // a bit beyond sand for natural feel
const RAIN_HEIGHT_MIN = 0.2;
const RAIN_HEIGHT_MAX = 5.2;
const RAIN_FALL_SPEED = 12.0; // m/s — fast enough to streak convincingly
// Wind tilt — every drop drifts a bit along world +X as it falls, so
// the rain reads as angled sheets, not a vertical curtain of pixels.
const RAIN_WIND_X = 1.6; // m/s lateral
const RAIN_WIND_Z = 0.4;
// Phase durations (seconds) — sampled in a range so the weather
// doesn't feel metronomic.
const CLEAR_MIN = 70;
const CLEAR_MAX = 150;
const CLOUDY_MIN = 35;
const CLOUDY_MAX = 70;
const RAIN_MIN = 50;
const RAIN_MAX = 100;
const CLEARING_MIN = 28;
const CLEARING_MAX = 50;

function pickDuration(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function Weather() {
  const setWeather = useStore((s) => s.setWeather);
  const setWeatherIntensity = useStore((s) => s.setWeatherIntensity);
  const phaseTimer = useRef(pickDuration(CLEAR_MIN, CLEAR_MAX));
  const intensityRef = useRef(0);

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

  const streakGeom = useMemo(() => {
    // Long thin streak — reads as motion-blurred raindrop. Rotated
    // slightly toward the wind direction so the column looks angled
    // instead of a vertical curtain.
    const g = new THREE.BoxGeometry(0.004, 0.42, 0.004);
    g.rotateZ(Math.atan2(RAIN_WIND_X, RAIN_FALL_SPEED));
    g.rotateX(Math.atan2(RAIN_WIND_Z, RAIN_FALL_SPEED));
    return g;
  }, []);
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

  // Set initial instance matrices once.
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
  }, [drops]);

  useFrame((_, dt) => {
    // ----- driver -----
    phaseTimer.current -= dt;
    const state = useStore.getState();
    const phase = state.weather;
    if (phaseTimer.current <= 0) {
      let next: typeof phase;
      let dur: number;
      if (phase === 'clear') {
        next = 'cloudy';
        dur = pickDuration(CLOUDY_MIN, CLOUDY_MAX);
      } else if (phase === 'cloudy') {
        next = 'rain';
        dur = pickDuration(RAIN_MIN, RAIN_MAX);
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
    // Smoothed intensity target per phase — rain has the strongest,
    // clearing trails off, cloudy and clear are near-zero (cloudy gets
    // a tiny value so dragonflies could share the same intensity gate
    // if needed; the actual dragonfly gating is on phase === 'cloudy').
    const targetIntensity =
      phase === 'rain'
        ? 1.0
        : phase === 'clearing'
        ? 0.35
        : phase === 'cloudy'
        ? 0.05
        : 0;
    const ease = 1 - Math.exp(-0.6 * dt); // ~3s smoothing
    intensityRef.current += (targetIntensity - intensityRef.current) * ease;
    setWeatherIntensity(intensityRef.current);

    // ----- rain visuals -----
    const mesh = meshRef.current;
    if (!mesh) return;
    const visible = intensityRef.current > 0.02;
    mesh.visible = visible;
    if (!visible) return;

    const m = new THREE.Matrix4();
    const fall = RAIN_FALL_SPEED * dt;
    const driftX = RAIN_WIND_X * dt;
    const driftZ = RAIN_WIND_Z * dt;
    for (let i = 0; i < RAIN_COUNT; i++) {
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
    // Opacity tracks intensity so the rain ramps up + tails off
    // smoothly between phase transitions. Additive blending means we
    // can keep opacity lower than non-additive and still read clearly.
    streakMat.opacity = 0.28 + 0.45 * intensityRef.current;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[streakGeom, streakMat, RAIN_COUNT]}
      frustumCulled={false}
    />
  );
}
