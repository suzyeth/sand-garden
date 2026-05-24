import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../sim/store';

/**
 * Japanese stone lantern (tōrō) — yukimi-style with four corner posts
 * around an open fire chamber. Dark by day, glows warm orange at
 * night. Drives intensity off store.cycleT so it stays in sync with
 * the day/night atmosphere everything else already obeys.
 *
 * Stack (bottom → top):
 *   foot stone        wide low drum
 *   shaft             tall thin pillar
 *   middle stone      thin disc
 *   fire chamber      4 corner posts + roof + floor slab, lamp inside
 *   roof              pyramidal hat
 *   finial            small sphere on top
 */

const STONE_COLOR = '#6a655c';
const STONE_ROUGH = 0.96;
const FIRE_COLOR = '#ff9444';

// Night brightness window — match Fireflies' band so the lantern lights
// up at the same dusk threshold the fireflies emerge at.
const NIGHT_T_MIN = 0.5;
const NIGHT_T_MAX = 0.98;
const NIGHT_RAMP = 0.12;

function lanternWeight(t: number): number {
  const u = ((t % 1) + 1) % 1;
  if (u < NIGHT_T_MIN || u > NIGHT_T_MAX) return 0;
  const rampUp = THREE.MathUtils.smoothstep(u, NIGHT_T_MIN, NIGHT_T_MIN + NIGHT_RAMP);
  const rampDown =
    1 - THREE.MathUtils.smoothstep(u, NIGHT_T_MAX - 0.06, NIGHT_T_MAX);
  return rampUp * rampDown;
}

interface StoneLanternProps {
  position: [number, number, number];
  scale?: number;
}

export function StoneLantern({ position, scale = 1 }: StoneLanternProps) {
  const fireMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const haloRef = useRef<THREE.Sprite>(null);
  const haloMatRef = useRef<THREE.SpriteMaterial>(null);
  const pointLightRef = useRef<THREE.PointLight>(null);
  const flickerSeed = useMemo(() => Math.random() * 100, []);
  const elapsed = useRef(0);

  // Soft additive halo around the fire chamber.
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
    gradient.addColorStop(0.3, 'rgba(255,200,140,0.5)');
    gradient.addColorStop(0.6, 'rgba(255,160,80,0.18)');
    gradient.addColorStop(1.0, 'rgba(255,150,60,0.0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }, []);

  // All Y values below are pre-scale; the outer group scales the whole
  // assembly. Lantern is about 1.2m tall at scale=1, sitting on the
  // ground.
  useFrame((_, dt) => {
    elapsed.current += dt;
    const t = useStore.getState().cycleT;
    const w = lanternWeight(t);
    // Gentle flicker — slow noisy modulation so a candle lives inside
    // the chamber rather than a steady bulb.
    const flicker =
      0.88 +
      0.12 * Math.sin(elapsed.current * 7.3 + flickerSeed) +
      0.05 * Math.sin(elapsed.current * 17.1 + flickerSeed * 1.7);
    const lit = w * flicker;
    if (fireMatRef.current) fireMatRef.current.emissiveIntensity = 1.8 * lit;
    if (haloRef.current) {
      const visible = lit > 0.005;
      haloRef.current.visible = visible;
      if (visible) {
        const s = (0.55 + lit * 0.35) * scale;
        haloRef.current.scale.setScalar(s);
      }
    }
    if (haloMatRef.current) haloMatRef.current.opacity = 0.7 * lit;
    if (pointLightRef.current) pointLightRef.current.intensity = 1.6 * lit;
  });

  return (
    <group position={position} scale={scale}>
      {/* foot stone — wide low drum */}
      <mesh position={[0, 0.08, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.27, 0.32, 0.16, 10]} />
        <meshStandardMaterial color={STONE_COLOR} roughness={STONE_ROUGH} />
      </mesh>

      {/* shaft — tall thin octagonal pillar (using 8-segment cylinder) */}
      <mesh position={[0, 0.42, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.07, 0.085, 0.52, 8]} />
        <meshStandardMaterial color={STONE_COLOR} roughness={STONE_ROUGH} />
      </mesh>

      {/* middle stone — flat disc supporting the fire chamber */}
      <mesh position={[0, 0.71, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.19, 0.20, 0.05, 10]} />
        <meshStandardMaterial color={STONE_COLOR} roughness={STONE_ROUGH} />
      </mesh>

      {/* fire chamber floor */}
      <mesh position={[0, 0.755, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.24, 0.025, 0.24]} />
        <meshStandardMaterial color={STONE_COLOR} roughness={STONE_ROUGH} />
      </mesh>

      {/* 4 corner posts — leave the 4 sides open so the lamp inside is
          visible from any angle (the classic tōrō window look) */}
      {[
        [0.095, 0.095],
        [-0.095, 0.095],
        [0.095, -0.095],
        [-0.095, -0.095],
      ].map(([px, pz], i) => (
        <mesh key={i} position={[px, 0.875, pz]} castShadow>
          <boxGeometry args={[0.03, 0.21, 0.03]} />
          <meshStandardMaterial color={STONE_COLOR} roughness={STONE_ROUGH} />
        </mesh>
      ))}

      {/* lamp — the actual emissive glow inside the chamber */}
      <mesh position={[0, 0.875, 0]}>
        <boxGeometry args={[0.10, 0.14, 0.10]} />
        <meshStandardMaterial
          ref={fireMatRef}
          color={FIRE_COLOR}
          emissive={FIRE_COLOR}
          emissiveIntensity={0.0}
          roughness={0.4}
          toneMapped={false}
        />
      </mesh>

      {/* fire chamber ceiling slab (caps the corner posts) */}
      <mesh position={[0, 0.995, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.24, 0.025, 0.24]} />
        <meshStandardMaterial color={STONE_COLOR} roughness={STONE_ROUGH} />
      </mesh>

      {/* roof — pyramidal hat with slightly flared base */}
      <mesh position={[0, 1.08, 0]} castShadow receiveShadow>
        <coneGeometry args={[0.21, 0.16, 4]} />
        <meshStandardMaterial
          color={STONE_COLOR}
          roughness={STONE_ROUGH}
          flatShading
        />
      </mesh>

      {/* finial — small ball */}
      <mesh position={[0, 1.185, 0]} castShadow>
        <sphereGeometry args={[0.028, 10, 8]} />
        <meshStandardMaterial color={STONE_COLOR} roughness={STONE_ROUGH} />
      </mesh>

      {/* additive halo around the fire chamber */}
      <sprite ref={haloRef} position={[0, 0.875, 0]} visible={false}>
        <spriteMaterial
          ref={haloMatRef}
          map={haloTexture ?? undefined}
          color={FIRE_COLOR}
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </sprite>

      {/* warm point light spilling onto nearby sand at night */}
      <pointLight
        ref={pointLightRef}
        position={[0, 0.875, 0]}
        color={FIRE_COLOR}
        intensity={0}
        distance={3.5}
        decay={1.7}
        castShadow={false}
      />
    </group>
  );
}
