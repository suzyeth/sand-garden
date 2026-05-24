import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../sim/store';

/**
 * Fireflies — small emissive dots that appear only at night. Each
 * firefly drifts slowly along a random Lissajous-ish path, blinking
 * via emissive intensity. Together they read as the karesansui's
 * night version of the daytime butterfly / leaf life.
 *
 * Visibility is gated on cycleT — fireflies only render when the
 * day/night cycle is in the dusk-through-pre-dawn band (cycleT in
 * roughly [0.55, 0.95]). Outside that window each slot stays hidden.
 */

const FIREFLY_COUNT = 5;
const FLY_RADIUS = 6.5; // wander zone around the sand centre
const FLY_HEIGHT_MIN = 0.4;
const FLY_HEIGHT_MAX = 2.4;

const NIGHT_T_MIN = 0.55; // just past dusk
const NIGHT_T_MAX = 0.95; // pre-dawn fade

type Spec = {
  baseX: number;
  baseZ: number;
  driftAx: number; // X amplitude
  driftAz: number; // Z amplitude
  driftYAmp: number;
  freqX: number;
  freqZ: number;
  freqY: number;
  phaseX: number;
  phaseZ: number;
  phaseY: number;
  blinkRate: number;
  blinkPhase: number;
  hue: number; // greenish-yellow tint
};

function hash(seed: number): number {
  const s = Math.sin(seed * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function buildSpec(i: number): Spec {
  return {
    baseX: (hash(i * 1.31) - 0.5) * FLY_RADIUS * 1.6,
    baseZ: (hash(i * 2.47) - 0.5) * FLY_RADIUS * 1.6,
    driftAx: 0.8 + hash(i * 3.19) * 1.2,
    driftAz: 0.8 + hash(i * 4.07) * 1.2,
    driftYAmp: 0.4 + hash(i * 5.53) * 0.7,
    freqX: 0.25 + hash(i * 6.71) * 0.35,
    freqZ: 0.27 + hash(i * 7.31) * 0.35,
    freqY: 0.35 + hash(i * 8.13) * 0.4,
    phaseX: hash(i * 9.41) * Math.PI * 2,
    phaseZ: hash(i * 10.83) * Math.PI * 2,
    phaseY: hash(i * 11.97) * Math.PI * 2,
    // Slow blink — 0.4-0.9 Hz feels right for a firefly.
    blinkRate: 0.4 + hash(i * 13.11) * 0.5,
    blinkPhase: hash(i * 14.71) * Math.PI * 2,
    hue: 0.45 + hash(i * 15.27) * 0.3, // 0..1 for color lerp
  };
}

function nightWeight(t: number): number {
  // Asymmetric envelope so dusk reads as "faint glimmer" and deep night
  // reads as "bright". Slow ramp up across the first ~0.23 of the
  // window (dusk → deep night), held flat through the middle, then a
  // tapered fade-out toward dawn.
  //
  // Approximate brightness curve:
  //   u = 0.55  → 0.00  (window just opened)
  //   u = 0.60  → 0.08  (early dusk — barely visible)
  //   u = 0.65  → 0.27  (dusk)
  //   u = 0.72  → 0.67  (settling in)
  //   u = 0.78  → 1.00  (deep night)
  //   u = 0.88  → 1.00  (still deep)
  //   u = 0.92  → 0.39  (pre-dawn fade)
  //   u = 0.95  → 0.00  (window closes)
  const u = ((t % 1) + 1) % 1;
  if (u < NIGHT_T_MIN || u > NIGHT_T_MAX) return 0;
  const rampUp = THREE.MathUtils.smoothstep(u, NIGHT_T_MIN, NIGHT_T_MIN + 0.23);
  const fadeOut =
    1 - THREE.MathUtils.smoothstep(u, NIGHT_T_MAX - 0.07, NIGHT_T_MAX);
  return rampUp * fadeOut;
}

const COLOR_WARM = new THREE.Color('#ffe082');
const COLOR_COOL = new THREE.Color('#caffae');

export function Fireflies() {
  const specs = useMemo<Spec[]>(
    () => Array.from({ length: FIREFLY_COUNT }, (_, i) => buildSpec(i + 17)),
    [],
  );
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const matRefs = useRef<(THREE.MeshStandardMaterial | null)[]>([]);
  const bodyRefs = useRef<(THREE.Mesh | null)[]>([]);
  const haloRefs = useRef<(THREE.Sprite | null)[]>([]);
  const haloMatRefs = useRef<(THREE.SpriteMaterial | null)[]>([]);
  const elapsed = useRef(0);

  // Reusable Color object so we don't allocate per frame.
  const tmpColor = useMemo(() => new THREE.Color(), []);

  // Capsule geometry for the firefly body. Baked X-rotation so its long
  // axis runs along local +Z — that way a single rotation.y aligns the
  // body with its flight direction.
  const bodyGeom = useMemo(() => {
    const g = new THREE.CapsuleGeometry(0.014, 0.05, 4, 8);
    g.rotateX(Math.PI / 2);
    return g;
  }, []);

  // Radial gradient halo texture — built once. Additive-blended sprites
  // wearing this map fake the bloom we don't have via post-processing.
  const haloTexture = useMemo(() => {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const r = size / 2;
    const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
    gradient.addColorStop(0.0, 'rgba(255,255,255,1.0)');
    gradient.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.18)');
    gradient.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  // Stateful per-firefly wander — replaces the analytical Lissajous
  // path so motion reads as a bug exploring the air, not a drone on a
  // preprogrammed track. Each firefly drifts → occasionally turns
  // sharply → sometimes hovers → very occasionally darts. Heading
  // changes are discrete events; in between segments the heading does
  // a slow random walk.
  type FlyState = {
    x: number;
    y: number;
    z: number;
    heading: number; // angle in xz plane (0 = +X axis)
    speed: number; // m/s
    vy: number;
    nextDecisionIn: number; // seconds until next behavior pick
    turnRate: number; // rad/s applied to heading this segment
  };

  const yMid = (FLY_HEIGHT_MIN + FLY_HEIGHT_MAX) / 2;
  const states = useMemo<FlyState[]>(
    () =>
      specs.map((s, i) => ({
        x: s.baseX,
        y: yMid + (hash(i * 17.3) - 0.5) * 0.8,
        z: s.baseZ,
        heading: hash(i * 23.7) * Math.PI * 2,
        speed: 0.18 + hash(i * 31.1) * 0.2,
        vy: 0,
        nextDecisionIn: 0.3 + hash(i * 41.7) * 0.8,
        turnRate: (hash(i * 53.1) - 0.5) * 0.4,
      })),
    [specs, yMid],
  );

  useFrame((_, dt) => {
    elapsed.current += dt;
    const t = useStore.getState().cycleT;
    const w = nightWeight(t);

    for (let i = 0; i < FIREFLY_COUNT; i++) {
      const m = meshRefs.current[i];
      const mat = matRefs.current[i];
      const body = bodyRefs.current[i];
      const halo = haloRefs.current[i];
      const haloMat = haloMatRefs.current[i];
      if (!m || !mat || !body || !halo || !haloMat) continue;
      if (w <= 0.001) {
        if (m.visible) m.visible = false;
        if (body.visible) body.visible = false;
        if (halo.visible) halo.visible = false;
        continue;
      }
      m.visible = true;
      body.visible = true;
      halo.visible = true;

      const s = specs[i];
      const st = states[i];
      const time = elapsed.current;

      // --- behavior FSM ticked at decision boundaries --------------
      st.nextDecisionIn -= dt;
      if (st.nextDecisionIn <= 0) {
        const r = Math.random();
        if (r < 0.28) {
          // hover: near stand-still, light wobble
          st.speed = 0.02 + Math.random() * 0.06;
          st.turnRate = (Math.random() - 0.5) * 0.6;
          st.nextDecisionIn = 0.5 + Math.random() * 1.2;
        } else if (r < 0.5) {
          // sharp turn: brief moment with high angular velocity
          st.speed = 0.1 + Math.random() * 0.1;
          st.turnRate = (Math.random() < 0.5 ? -1 : 1) * (1.8 + Math.random() * 1.8);
          st.nextDecisionIn = 0.18 + Math.random() * 0.25;
        } else if (r < 0.62) {
          // dart: brief burst forward
          st.speed = 0.55 + Math.random() * 0.4;
          st.turnRate = (Math.random() - 0.5) * 0.5;
          st.nextDecisionIn = 0.25 + Math.random() * 0.35;
        } else {
          // drift: easy cruise, gentle meander
          st.speed = 0.18 + Math.random() * 0.18;
          st.turnRate = (Math.random() - 0.5) * 0.5;
          st.nextDecisionIn = 0.6 + Math.random() * 1.4;
        }
      }

      // --- continuous update ---------------------------------------
      // Tiny per-frame heading noise so even straight cruises wobble
      // a bit instead of looking laser-guided.
      const headingNoise = (Math.random() - 0.5) * 1.4 * dt;
      st.heading += st.turnRate * dt + headingNoise;

      const vx = Math.cos(st.heading) * st.speed;
      const vz = Math.sin(st.heading) * st.speed;
      st.x += vx * dt;
      st.z += vz * dt;

      // Softly pull back when wandering past the radius.
      const distSq = st.x * st.x + st.z * st.z;
      const limit = FLY_RADIUS;
      if (distSq > limit * limit) {
        const toCentre = Math.atan2(-st.z, -st.x);
        let delta = toCentre - st.heading;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        st.heading += delta * dt * 2.2;
      }

      // Vertical: spring toward mid-band + light noise.
      st.vy += (yMid - st.y) * dt * 0.6;
      st.vy += (Math.random() - 0.5) * dt * 1.4;
      st.vy *= Math.pow(0.05, dt); // ~95% damping/s
      st.y += st.vy * dt;
      if (st.y < FLY_HEIGHT_MIN) {
        st.y = FLY_HEIGHT_MIN;
        st.vy = Math.abs(st.vy) * 0.4;
      } else if (st.y > FLY_HEIGHT_MAX) {
        st.y = FLY_HEIGHT_MAX;
        st.vy = -Math.abs(st.vy) * 0.4;
      }

      // --- write to scene ------------------------------------------
      const dirX = Math.cos(st.heading);
      const dirZ = Math.sin(st.heading);
      // Abdomen (lantern) at the rear of the bug — drop it slightly
      // behind the centre so the body extends visibly forward.
      const lanternX = st.x - dirX * 0.025;
      const lanternZ = st.z - dirZ * 0.025;
      m.position.set(lanternX, st.y, lanternZ);
      halo.position.set(lanternX, st.y, lanternZ);
      // Body sits forward of the lantern; oriented to face heading.
      const bodyX = st.x + dirX * 0.02;
      const bodyZ = st.z + dirZ * 0.02;
      body.position.set(bodyX, st.y + 0.003, bodyZ);
      body.rotation.y = Math.atan2(dirX, dirZ);

      // Slow blink.
      const blink =
        0.5 + 0.5 * Math.sin(time * s.blinkRate * Math.PI * 2 + s.blinkPhase);
      mat.emissiveIntensity = (0.8 + blink * 2.4) * w;
      tmpColor.copy(COLOR_COOL).lerp(COLOR_WARM, s.hue);
      mat.color.copy(tmpColor);
      mat.emissive.copy(tmpColor);
      // Halo: scale and opacity track the blink.
      const haloScale = (0.45 + blink * 0.55) * (0.85 + 0.3 * w);
      halo.scale.setScalar(haloScale);
      haloMat.color.copy(tmpColor);
      haloMat.opacity = (0.55 + blink * 0.45) * w;
    }
  });

  return (
    <>
      {specs.map((_, i) => (
        <group key={i}>
          {/* Abdomen / lantern — the only emissive part. Smaller than
              before so the body is visible alongside it. */}
          <mesh
            ref={(el) => {
              meshRefs.current[i] = el;
            }}
            visible={false}
          >
            <sphereGeometry args={[0.028, 10, 10]} />
            <meshStandardMaterial
              ref={(el) => {
                matRefs.current[i] = el;
              }}
              color={COLOR_WARM}
              emissive={COLOR_WARM}
              emissiveIntensity={0.0}
              roughness={0.4}
              toneMapped={false}
            />
          </mesh>
          {/* Body / thorax — dark matte capsule oriented along motion. */}
          <mesh
            ref={(el) => {
              bodyRefs.current[i] = el;
            }}
            geometry={bodyGeom}
            visible={false}
            castShadow={false}
          >
            <meshStandardMaterial
              color="#231a0c"
              roughness={0.95}
              metalness={0.0}
            />
          </mesh>
          <sprite
            ref={(el) => {
              haloRefs.current[i] = el;
            }}
            visible={false}
          >
            <spriteMaterial
              ref={(el) => {
                haloMatRefs.current[i] = el;
              }}
              map={haloTexture ?? undefined}
              color={COLOR_WARM}
              transparent
              depthWrite={false}
              blending={THREE.AdditiveBlending}
              toneMapped={false}
            />
          </sprite>
        </group>
      ))}
    </>
  );
}
