import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrthographicCamera } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { Garden } from './components/Garden';
import { HUD } from './components/HUD';
import { ambientAudio } from './sim/audio';
import { useStore } from './sim/store';

/**
 * Day / night cycle.
 *
 * A single component owns the directional + ambient lights, the sky
 * CanvasTexture, and the fog colour, so all atmospheric values stay
 * in lockstep. Four keyframes (dawn → noon → dusk → night → dawn)
 * are interpolated with smoothstep so transitions don't look linear.
 *
 * The full cycle is 3 minutes — short enough to see the change while
 * watching, long enough that the scene reads as still on any given
 * glance. The colour math runs at 10Hz, not every frame; light
 * objects and the 1x256 sky canvas are cheap to re-poke at that rate.
 */

type SceneKeyframe = {
  skyTop: string;
  skyHorizon: string;
  skyBottom: string;
  fog: string;
  /**
   * Fog near/far distances. Dawn keeps a thick low-visibility mist;
   * noon and dusk push fog effectively off (very large near/far so it
   * doesn't tint anything visible); night keeps a light atmospheric
   * fade.
   */
  fogNear: number;
  fogFar: number;
  dirColor: string;
  dirIntensity: number;
  ambColor: string;
  ambIntensity: number;
};

const KEYFRAMES: SceneKeyframe[] = [
  // dawn — low warm sun against a cool indigo top. ONLY phase with
  // thick mist; the night→dawn transition crossfades fog up to this.
  {
    skyTop: '#9aa8c4',
    skyHorizon: '#f0c898',
    skyBottom: '#3a3850',
    fog: '#c8a888',
    fogNear: 14,
    fogFar: 34,
    dirColor: '#ffc890',
    dirIntensity: 0.9,
    ambColor: '#8088a0',
    ambIntensity: 0.4,
  },
  // noon — overcast karesansui daylight; fog effectively pushed off.
  {
    skyTop: '#c2d8e4',
    skyHorizon: '#d8c8b4',
    skyBottom: '#7c8a94',
    fog: '#d8c8b4',
    fogNear: 240,
    fogFar: 320,
    dirColor: '#fff5e0',
    dirIntensity: 1.05,
    ambColor: '#b0c0d0',
    ambIntensity: 0.7,
  },
  // dusk — orange sunset, long shadows; still no mist.
  {
    skyTop: '#a89098',
    skyHorizon: '#f09060',
    skyBottom: '#382838',
    fog: '#c88868',
    fogNear: 240,
    fogFar: 320,
    dirColor: '#ff8050',
    dirIntensity: 0.85,
    ambColor: '#785868',
    ambIntensity: 0.38,
  },
  // night — moonlit deep blue. No mist yet; the night→dawn crossfade
  // pulls fogNear/fogFar in toward dawn values as time advances.
  {
    skyTop: '#1a2438',
    skyHorizon: '#283448',
    skyBottom: '#0c1018',
    fog: '#283448',
    fogNear: 240,
    fogFar: 320,
    dirColor: '#6088b8',
    dirIntensity: 0.35,
    ambColor: '#28344c',
    ambIntensity: 0.22,
  },
];

const CYCLE_DURATION_SEC = 180; // 3 minutes
const SKY_UPDATE_HZ = 10;

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function SceneLighting() {
  const dirLight = useRef<THREE.DirectionalLight>(null);
  const ambLight = useRef<THREE.AmbientLight>(null);
  const cycleClock = useRef(0);
  const updateAccum = useRef(Infinity); // force update on first frame

  const { scene } = useThree();

  // Reusable scratch colours — avoids allocating four Color objects per
  // update tick.
  const tmpA = useMemo(() => new THREE.Color(), []);
  const tmpB = useMemo(() => new THREE.Color(), []);
  const tmpC = useMemo(() => new THREE.Color(), []);

  // Sky texture: 1x256 canvas. We KEEP the ctx + canvas around and
  // redraw the same texture, then flag needsUpdate, so the GPU sees a
  // smooth fade rather than a discrete swap.
  const sky = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return { canvas, ctx, texture };
  }, []);

  // Make sure the scene has a fog object we can poke each tick. We
  // don't expose it as JSX because the colour will be reassigned every
  // update; a plain ref is cleaner.
  useEffect(() => {
    if (!scene.fog || !(scene.fog instanceof THREE.Fog)) {
      // Initial fog is pushed effectively off; the keyframe loop
      // brings it in only around dawn.
      scene.fog = new THREE.Fog('#d8c8b4', 240, 320);
    }
    if (sky) {
      scene.background = sky.texture;
    }
    return () => {
      // Don't tear down: HMR re-runs this; downstream code expects
      // scene.background to remain valid.
    };
  }, [scene, sky]);

  useFrame((_, dt) => {
    cycleClock.current += dt;
    updateAccum.current += dt;
    if (updateAccum.current < 1 / SKY_UPDATE_HZ) return;
    updateAccum.current = 0;

    const t =
      (cycleClock.current % CYCLE_DURATION_SEC) / CYCLE_DURATION_SEC;
    const phaseF = t * KEYFRAMES.length;
    const idx = Math.floor(phaseF) % KEYFRAMES.length;
    const next = (idx + 1) % KEYFRAMES.length;
    const uRaw = phaseF - Math.floor(phaseF);
    const u = smoothstep(uRaw);

    const a = KEYFRAMES[idx];
    const b = KEYFRAMES[next];

    // Sky gradient redraw.
    if (sky) {
      tmpA.set(a.skyTop).lerp(tmpC.set(b.skyTop), u);
      tmpB.set(a.skyHorizon).lerp(tmpC.set(b.skyHorizon), u);
      const skyTopCss = `#${tmpA.getHexString()}`;
      const skyHorizonCss = `#${tmpB.getHexString()}`;
      tmpA.set(a.skyBottom).lerp(tmpC.set(b.skyBottom), u);
      const skyBottomCss = `#${tmpA.getHexString()}`;
      const grad = sky.ctx.createLinearGradient(0, 0, 0, 256);
      grad.addColorStop(0.0, skyTopCss);
      grad.addColorStop(0.65, skyHorizonCss);
      grad.addColorStop(1.0, skyBottomCss);
      sky.ctx.fillStyle = grad;
      sky.ctx.fillRect(0, 0, 1, 256);
      sky.texture.needsUpdate = true;
    }

    // Fog — colour + near/far. Dawn is the only phase with thick
    // mist, so noon/dusk/night keyframes push the near/far out to
    // essentially-disabled values, and the cycle naturally crossfades
    // the fog in around dawn.
    const fog = scene.fog as THREE.Fog | null;
    if (fog) {
      tmpA.set(a.fog).lerp(tmpC.set(b.fog), u);
      fog.color.copy(tmpA);
      fog.near = a.fogNear + (b.fogNear - a.fogNear) * u;
      fog.far = a.fogFar + (b.fogFar - a.fogFar) * u;
    }

    // Lights.
    if (dirLight.current) {
      tmpA.set(a.dirColor).lerp(tmpC.set(b.dirColor), u);
      dirLight.current.color.copy(tmpA);
      dirLight.current.intensity =
        a.dirIntensity + (b.dirIntensity - a.dirIntensity) * u;

      // Sun / moon arc — the directional light follows the cycle.
      // Day half (t < 0.5): sun arcs from east (+X, low) through high
      // overhead (centre) to west (-X, low).
      // Night half (t >= 0.5): "moon" arcs back from west to east at a
      // lower peak. Shadows on the sand follow accordingly.
      let lx: number, ly: number, lz: number;
      if (t < 0.5) {
        const dDay = t * 2; // 0..1 across the day half
        lx = 15 * (1 - 2 * dDay);
        ly = 6 + 19 * Math.sin(dDay * Math.PI);
        lz = 8;
      } else {
        const dNight = (t - 0.5) * 2; // 0..1 across the night half
        lx = -15 + 30 * dNight;
        ly = 5 + 13 * Math.sin(dNight * Math.PI);
        lz = -2;
      }
      dirLight.current.position.set(lx, ly, lz);
      dirLight.current.target.updateMatrixWorld();
    }
    if (ambLight.current) {
      tmpA.set(a.ambColor).lerp(tmpC.set(b.ambColor), u);
      ambLight.current.color.copy(tmpA);
      ambLight.current.intensity =
        a.ambIntensity + (b.ambIntensity - a.ambIntensity) * u;
    }

    // Drive day/night tone shift of the ambient music from the same
    // cycle clock as the lights, so audio mood crossfades exactly
    // with the visual time-of-day.
    ambientAudio.setTimeOfDay(t);

    // Push the cycle position into the store so the HUD's time-of-day
    // icon can render the matching phase symbol.
    useStore.getState().setCycleT(t);
  });

  return (
    <>
      <ambientLight ref={ambLight} intensity={0.5} />
      {/* Hemisphere fill gives a slight blue-on-top, brown-from-below
          cast. Mimics the sky/ground bounce that pure ambient can't
          render; reads as "overcast" without dimming the directional
          light too far. */}
      <hemisphereLight args={['#cfe0e8', '#5a4a3a', 0.35]} />
      <directionalLight
        ref={dirLight}
        position={[12, 22, 8]}
        intensity={1.25}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={18}
        shadow-camera-bottom={-18}
        shadow-camera-near={0.5}
        shadow-camera-far={60}
        shadow-bias={-0.0005}
      />
    </>
  );
}

/**
 * drei's <OrthographicCamera> sets the camera position but does NOT
 * auto-orient it toward the origin - by default it faces -Z. From
 * (18, 18, 18) looking -Z you're staring at empty sky. We have to
 * call lookAt(0, 0, 0) once after mount.
 */
function IsoCamera() {
  const ref = useRef<THREE.OrthographicCamera>(null);
  useEffect(() => {
    ref.current?.lookAt(0, 0, 0);
    ref.current?.updateProjectionMatrix();
  }, []);
  return (
    <OrthographicCamera
      ref={ref}
      makeDefault
      position={[20, 20, 20]}
      zoom={42}
      near={0.1}
      far={200}
    />
  );
}

export default function App() {
  return (
    <>
      <Canvas shadows gl={{ antialias: true }} dpr={[1, 2]}>
        {/* classic 35.26 deg isometric camera, fixed (no orbit) */}
        <IsoCamera />

        {/* Owns sky gradient, fog, directional + ambient lights, and
            cycles them across the day/night loop. */}
        <SceneLighting />

        <Garden />
      </Canvas>

      {/* HUD lives outside the Canvas so it's plain DOM */}
      <HUD />
    </>
  );
}
