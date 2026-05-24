import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../sim/store';

/**
 * Drifting leaves / blossoms. Five independent particle slots, each
 * running its own staggered lifecycle, so the scene typically has
 * 3-5 drifting things on screen at once.
 *
 * Each spawn picks a TYPE based on the current day/night cycle:
 *   morning (cycleT 0.0–0.25)  → orange/red maple leaf
 *   afternoon (cycleT 0.25–0.5) → pink sakura blossom
 *   dusk/night (cycleT 0.5–1.0) → leaves (low key)
 *
 * One slot's logic is encapsulated in <DriftingParticle/>. The outer
 * component just renders SLOT_COUNT of them with staggered initial
 * delays so they don't all spawn together.
 */

const SLOT_COUNT = 5;

const LEAF_WIDTH = 0.16;
const LEAF_HEIGHT = 0.22;
const FLOWER_SIZE = 0.13;

const RESPAWN_DELAY: [number, number] = [2.5, 7.5];
const DRIFT_DURATION: [number, number] = [10, 16];

const SPAWN_RADIUS = 12;
const ISO_CAM_X = 20;
const ISO_CAM_Z = 20;

// Wind direction is no longer a static constant. We compute a base
// angle plus a slow sine drift so the wind feels like it's gently
// shifting over time — "today's breeze is changing direction".
const WIND_BASE_ANGLE = Math.atan2(-0.55, -1.0); // ≈ -2.64 rad (SW)
const WIND_DRIFT_AMP = 0.55; // ±0.55 rad (~ ±31°)
const WIND_DRIFT_PERIOD_SEC = 220; // ~3.5 min for one drift cycle

function currentWindAngle(): number {
  // Use performance.now to keep wind consistent across re-renders.
  const t = performance.now() / 1000;
  return (
    WIND_BASE_ANGLE +
    Math.sin((t / WIND_DRIFT_PERIOD_SEC) * Math.PI * 2) * WIND_DRIFT_AMP
  );
}

const LEAF_COLORS = ['#c87030', '#a05022', '#d88638', '#8a4622'];
const FLOWER_COLORS = ['#f5c0c8', '#ffd4d8', '#ffb8c0', '#f8e8e8'];

type ParticleType = 'leaf' | 'flower';

type Flight = {
  startPos: [number, number, number];
  endPos: [number, number, number];
  duration: number;
  spinAxis: 'x' | 'z';
  swayAmp: number;
  type: ParticleType;
};

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function typeForCycle(_t: number): ParticleType {
  // Single species — maple leaves only. The earlier sakura-blossom
  // afternoon felt botanically confused (three species rotating
  // through the same garden); committing to one species anchors the
  // scene to a single season (late autumn) and lets every other
  // muted-palette element sing without competition.
  return 'leaf';
}

function buildLeafMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: '#c87030',
    roughness: 0.9,
    side: THREE.DoubleSide,
    transparent: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
varying vec2 vLeafUv;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
vLeafUv = uv;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
varying vec2 vLeafUv;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      `vec4 diffuseColor = vec4( diffuse, opacity );
float u = (vLeafUv.x - 0.5) * 2.0;
float v = (vLeafUv.y - 0.5) * 2.0;
float r = sqrt(u*u + v*v);
float theta = atan(v, u);
float lobeR = 0.55 + 0.32 * abs(cos(theta * 2.5));
if (r > lobeR) discard;
diffuseColor.rgb *= 0.7 + 0.4 * smoothstep(0.0, 0.7, r);`,
    );
  };
  return m;
}

function buildFlowerMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: '#f5c0c8',
    roughness: 0.85,
    side: THREE.DoubleSide,
    transparent: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>
varying vec2 vFlowerUv;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
vFlowerUv = uv;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
varying vec2 vFlowerUv;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec4 diffuseColor = vec4( diffuse, opacity );',
      `vec4 diffuseColor = vec4( diffuse, opacity );
float u = (vFlowerUv.x - 0.5) * 2.0;
float v = (vFlowerUv.y - 0.5) * 2.0;
float r = sqrt(u*u + v*v);
float theta = atan(v, u);
float petalR = 0.42 + 0.48 * abs(cos(theta * 2.5));
if (r > petalR) discard;
float tipBoost = smoothstep(0.5, 0.95, r);
diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.92, 0.78, 0.82), diffuseColor.rgb, 1.0 - tipBoost * 0.45);
float centre = 1.0 - smoothstep(0.0, 0.18, r);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.78, 0.45), centre * 0.55);`,
    );
  };
  return m;
}

const LAND_DURATION: [number, number] = [3.0, 5.5];

function DriftingParticle({ initialDelay }: { initialDelay: number }) {
  const group = useRef<THREE.Group>(null);
  const leafMesh = useRef<THREE.Mesh>(null);
  const flowerMesh = useRef<THREE.Mesh>(null);

  const stateRef = useRef<'hidden' | 'flying' | 'landed'>('hidden');
  const timer = useRef(0);
  const sleepFor = useRef(initialDelay);
  const flight = useRef<Flight | null>(null);
  const spinPhase = useRef(0);
  const landDur = useRef(0);

  // Per-particle material instances so each can have its own colour
  // without bleeding into siblings.
  const leafMat = useMemo(buildLeafMaterial, []);
  const flowerMat = useMemo(buildFlowerMaterial, []);

  const beginFlight = () => {
    const cycleT = useStore.getState().cycleT;
    const type = typeForCycle(cycleT);
    // Sample the slowly-drifting wind angle at spawn time so different
    // leaves all share the wind direction of their epoch.
    const angle = currentWindAngle();
    const windUx = Math.cos(angle);
    const windUz = Math.sin(angle);
    const perpX = -windUz;
    const perpZ = windUx;
    const lat = rand(-5, 5);
    const latDrift = rand(-0.6, 0.6);
    const startY = rand(2.5, 3.8);
    const endY = 0.05;
    const startX = -windUx * SPAWN_RADIUS + perpX * lat;
    const startZ = -windUz * SPAWN_RADIUS + perpZ * lat;
    const endX = windUx * SPAWN_RADIUS + perpX * (lat + latDrift);
    const endZ = windUz * SPAWN_RADIUS + perpZ * (lat + latDrift);
    flight.current = {
      startPos: [startX, startY, startZ],
      endPos: [endX, endY, endZ],
      duration: rand(DRIFT_DURATION[0], DRIFT_DURATION[1]),
      spinAxis: Math.random() < 0.5 ? 'x' : 'z',
      // Small sway perpendicular to wind for organic flutter.
      swayAmp: 0.2 + Math.random() * 0.15,
      type,
    };
    if (type === 'leaf') {
      const idx = Math.floor(Math.random() * LEAF_COLORS.length);
      leafMat.color.set(LEAF_COLORS[idx]);
    } else {
      const idx = Math.floor(Math.random() * FLOWER_COLORS.length);
      flowerMat.color.set(FLOWER_COLORS[idx]);
    }
    if (leafMesh.current && flowerMesh.current) {
      leafMesh.current.visible = type === 'leaf';
      flowerMesh.current.visible = type === 'flower';
    }
    // Reset opacity in case the previous cycle ended on a faded-out
    // landed state.
    leafMat.opacity = 1.0;
    flowerMat.opacity = 1.0;
    stateRef.current = 'flying';
    timer.current = 0;
    if (group.current) group.current.visible = true;
  };

  const beginLanding = () => {
    if (!flight.current || !group.current) return;
    // Snap to ground at the end position, lay flat on the sand.
    const [ex, , ez] = flight.current.endPos;
    group.current.position.set(ex, 0.006, ez);
    // Rotate so the plane lies on the ground (face up).
    group.current.rotation.x = -Math.PI / 2;
    group.current.rotation.z = 0;
    // Random yaw on the ground for variety.
    group.current.rotation.y = Math.random() * Math.PI * 2;
    landDur.current = rand(LAND_DURATION[0], LAND_DURATION[1]);
    timer.current = 0;
    stateRef.current = 'landed';
  };

  useFrame((_, dt) => {
    if (!group.current) return;
    timer.current += dt;

    if (stateRef.current === 'hidden') {
      if (group.current.visible) group.current.visible = false;
      if (timer.current >= sleepFor.current) beginFlight();
      return;
    }

    if (stateRef.current === 'landed') {
      // Stay lying on the sand, fade alpha to zero, then hide.
      const lt = Math.min(1, timer.current / landDur.current);
      const alpha = 1.0 - lt;
      if (flight.current?.type === 'leaf') leafMat.opacity = alpha;
      else flowerMat.opacity = alpha;
      if (lt >= 1) {
        stateRef.current = 'hidden';
        timer.current = 0;
        sleepFor.current = rand(RESPAWN_DELAY[0], RESPAWN_DELAY[1]);
        group.current.visible = false;
      }
      return;
    }

    if (!flight.current) return;
    const t = Math.min(1, timer.current / flight.current.duration);
    // Sway: ONE half-cycle across the drop, not two full loops — leaves
    // arc gently sideways once instead of looping wildly.
    const sx =
      flight.current.startPos[0] +
      (flight.current.endPos[0] - flight.current.startPos[0]) * t +
      Math.sin(t * Math.PI) * flight.current.swayAmp;
    const sy =
      flight.current.startPos[1] +
      (flight.current.endPos[1] - flight.current.startPos[1]) * t;
    const sz =
      flight.current.startPos[2] +
      (flight.current.endPos[2] - flight.current.startPos[2]) * t +
      Math.sin(t * Math.PI) * flight.current.swayAmp * 0.4;
    group.current.position.set(sx, sy, sz);

    // Slow single-axis tumble (was double-axis at 1.7 rad/s, way too
    // chaotic). Now ~0.7 rad/s on the chosen axis only.
    spinPhase.current += dt * 0.7;
    if (flight.current.spinAxis === 'x') {
      group.current.rotation.x = spinPhase.current;
      group.current.rotation.z = 0;
    } else {
      group.current.rotation.z = spinPhase.current;
      group.current.rotation.x = 0;
    }
    const dx = ISO_CAM_X - sx;
    const dz = ISO_CAM_Z - sz;
    group.current.rotation.y = Math.atan2(dx, dz);

    if (t >= 1) {
      // Don't hide yet — switch to landed state so the petal rests
      // on the sand briefly before fading out.
      beginLanding();
    }
  });

  return (
    <group ref={group} visible={false}>
      <mesh ref={leafMesh}>
        <planeGeometry args={[LEAF_WIDTH, LEAF_HEIGHT]} />
        <primitive object={leafMat} attach="material" />
      </mesh>
      <mesh ref={flowerMesh} visible={false}>
        <planeGeometry args={[FLOWER_SIZE, FLOWER_SIZE]} />
        <primitive object={flowerMat} attach="material" />
      </mesh>
    </group>
  );
}

export function FallingLeaves() {
  // Staggered initial delays so the slots don't all spawn together
  // when the scene first loads.
  const initialDelays = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      out.push(1 + i * 2.2 + Math.random() * 1.5);
    }
    return out;
  }, []);

  return (
    <>
      {initialDelays.map((d, i) => (
        <DriftingParticle key={i} initialDelay={d} />
      ))}
    </>
  );
}
