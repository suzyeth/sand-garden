import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../sim/store';
import { SAND_HALF } from '../sim/constants';

/**
 * Tiny dark-tan dust puffs that briefly bloom at random ground
 * points when it's raining. Each puff lives ~0.22s — quickly darkens
 * a small patch of sand (as if briefly wet) and fades. Reads as a
 * drop landing on dry sand, NOT as a water ripple.
 *
 * Earlier version used additive ring sprites which looked like water
 * ripples — wrong reading for a dry karesansui surface. Replaced
 * with a flat alpha-blended disc the sand-colour of the wet patch
 * left by a drop. Concentric rings only make sense if a real puddle
 * exists; we don't simulate one.
 *
 * Implementation:
 *   - Fixed pool of POOL_SIZE flat discs (instanced) so no per-frame
 *     allocations.
 *   - Spawn budget per frame derived from store.weatherIntensity —
 *     drizzle barely sprinkles, heavy rain blankets the plane.
 *   - Each slot stores its lifetime; expired slots are immediately
 *     reusable, no compaction needed.
 *   - Tier-aware: drizzle's puffs are smaller + sparser so the
 *     three rain types feel distinct on the ground, not just in the
 *     air.
 */

const POOL_SIZE = 48;
// Per-second spawn rate scales linearly with intensity. Heavy rain
// hits the upper bound; drizzle barely reaches half.
const SPAWN_RATE_MAX = 90;
const SPLASH_LIFETIME = 0.22;
// Much smaller than before — these are dark patches the size of a
// drop's wet footprint, not water ripples. ~3-5cm reads as a real
// raindrop impact at the iso camera's scale.
const SPLASH_START_R = 0.018;
const SPLASH_END_R = 0.045;
// Just inside the sand bounds — splashes outside the sand wouldn't
// land on a visible surface.
const SPAWN_AREA = SAND_HALF - 0.3;
// Hover the discs a hair above the sand to avoid z-fighting with the
// sand displacement.
const SPLASH_Y = 0.012;

type Splash = {
  x: number;
  z: number;
  life: number; // remaining seconds; <=0 means slot is free
};

export function RainSplashes() {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const splashes = useMemo<Splash[]>(
    () => Array.from({ length: POOL_SIZE }, () => ({ x: 0, z: 0, life: 0 })),
    [],
  );
  // Carry over fractional spawns between frames so low spawn rates
  // still trigger eventually (otherwise drizzle would never fire).
  const spawnAccum = useRef(0);
  // Reusable matrix to avoid per-frame allocation in the spawn loop.
  const scratchMatrix = useMemo(() => new THREE.Matrix4(), []);

  // Filled disc — a flat circle (not a ring) so it reads as a wet
  // patch on sand, not a ripple.
  const ringGeom = useMemo(() => {
    const g = new THREE.CircleGeometry(1, 14);
    g.rotateX(-Math.PI / 2);
    return g;
  }, []);
  // Dark warm tan (slightly darker than the sand colour) with normal
  // blending — emulates the visual of a drop briefly wetting + darkening
  // sand. Additive blending would re-introduce the "glowing ripple"
  // look that was the original problem.
  const ringMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#7a6438',
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [],
  );

  // Park all instances at origin with zero scale so nothing is
  // visible until spawned.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    m.makeScale(0, 0, 0);
    for (let i = 0; i < POOL_SIZE; i++) mesh.setMatrixAt(i, m);
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  useFrame((_, dt) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const state = useStore.getState();
    const intensity = state.weatherIntensity;

    // Tier sets the upper bound for size + sprite count — drizzle
    // tops out smaller than heavy even at peak intensity.
    const tier = state.rainType;
    const sizeMul = tier === 'drizzle' ? 0.7 : tier === 'heavy' ? 1.15 : 1.0;
    const spawnMul = tier === 'drizzle' ? 0.6 : tier === 'heavy' ? 1.15 : 1.0;

    // Spawn budget for this frame. Intensity² gives more contrast
    // between drizzle and heavy than a linear falloff.
    const spawnRate = SPAWN_RATE_MAX * intensity * intensity * spawnMul;
    spawnAccum.current += spawnRate * dt;
    let toSpawn = Math.floor(spawnAccum.current);
    spawnAccum.current -= toSpawn;

    const m = scratchMatrix;
    let dirty = false;
    for (let i = 0; i < POOL_SIZE; i++) {
      const s = splashes[i];
      // Spawn into free slot if we still have budget.
      if (s.life <= 0 && toSpawn > 0) {
        s.x = (Math.random() - 0.5) * 2 * SPAWN_AREA;
        s.z = (Math.random() - 0.5) * 2 * SPAWN_AREA;
        s.life = SPLASH_LIFETIME;
        toSpawn--;
      }
      if (s.life > 0) {
        s.life -= dt;
        // 0 at birth, 1 at death.
        const u = 1 - s.life / SPLASH_LIFETIME;
        // Impact phase (first 15%): grow from START to END as the
        // drop "lands". Drying phase (remaining 85%): linearly
        // shrink back to 0 as the wet patch dries off — same shape
        // the user would see watching a drop on real sand.
        let r: number;
        if (u < 0.15) {
          r = SPLASH_START_R + (SPLASH_END_R - SPLASH_START_R) * (u / 0.15);
        } else {
          r = SPLASH_END_R * (1 - (u - 0.15) / 0.85);
        }
        r *= sizeMul;
        m.makeScale(r, 1, r);
        m.setPosition(s.x, SPLASH_Y, s.z);
        mesh.setMatrixAt(i, m);
        dirty = true;
      } else {
        // Free slot — collapse to zero scale so it isn't visible.
        m.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, m);
        dirty = true;
      }
    }
    if (dirty) mesh.instanceMatrix.needsUpdate = true;
    // Overall opacity follows intensity so the wet-patch tone is
    // darker during heavy rain (more saturated wetness) and lighter
    // during drizzle. Kept under 0.6 so puffs never become opaque
    // blobs that hide the sand pattern.
    ringMat.opacity = 0.30 + 0.25 * intensity;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[ringGeom, ringMat, POOL_SIZE]}
      frustumCulled={false}
    />
  );
}
