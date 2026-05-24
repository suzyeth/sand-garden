import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { STONES } from '../sim/stones';
import { SAND_HALF } from '../sim/constants';

/**
 * A small butterfly that occasionally drifts through the garden,
 * perches briefly on a stone, then flies off. Self-contained state
 * machine — no global driver, no store entry.
 *
 * Lifecycle:
 *   hidden       — invisible, counting down sleepFor
 *   flying-in    — Catmull-Rom curve from a random spawn point on a
 *                  circle outside the sand to a random stone's top
 *   perching     — frozen on the stone, wing flap slows to ~1.5Hz
 *   flying-out   — second Catmull-Rom from the stone to a random
 *                  exit point on the opposite side
 *   (back to hidden, schedule the next appearance)
 *
 * Visuals: 2 paper-white planes on hinge groups so we can flap them
 * around the body's forward (Z) axis. Body is a tiny dark slab. No
 * external assets, no textures — keeps the project asset-free.
 */

type State = 'hidden' | 'flying-in' | 'perching' | 'flying-out';

// Geometry — wingspan ~22cm, body ~5cm, sized so that on the iso
// camera (zoom 42) the butterfly is ~9 screen pixels across. Smaller
// disappears into pixel noise.
const WINGSPAN = 0.22;
const BODY_LENGTH = 0.05;

// Flight altitude range above ground for the entry/exit waypoints.
const FLIGHT_ALT_MIN = 0.6;
const FLIGHT_ALT_MAX = 1.1;

// Durations (seconds).
const FLY_IN_DUR = 7;
const PERCH_DUR = 4.5;
const FLY_OUT_DUR = 6;

// Sleep windows between appearances. The first one is short so the
// user sees the butterfly while still exploring the scene; subsequent
// ones are longer so it stays a quiet little event.
const FIRST_SLEEP_MIN = 12;
const FIRST_SLEEP_MAX = 35;
const RESPAWN_SLEEP_MIN = 60;
const RESPAWN_SLEEP_MAX = 150;

// Spawn radius — outside the sand so the butterfly visibly enters
// from off-frame.
const SPAWN_RADIUS = SAND_HALF + 2.5;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// Butterfly half-wing silhouette texture. Drawn as one side (right
// wing) — the left wing reuses the same texture mirrored on its plane
// scale.
function buildButterflyWingTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.CanvasTexture(canvas);
  ctx.clearRect(0, 0, w, h);

  // Outline: forewing (upper, larger, pointed) + hindwing (lower,
  // rounded). Drawn as one continuous shape attached at the body axis
  // (left edge of canvas, vertical centre).
  const cx = 8; // body axis position (small inset)
  const cy = h / 2;

  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 5);
  // Top of forewing: arc up and outward.
  ctx.bezierCurveTo(cx + 30, cy - 95, cx + 130, cy - 110, cx + 200, cy - 60);
  // Outer edge of forewing (slight scallop).
  ctx.bezierCurveTo(cx + 230, cy - 30, cx + 220, cy - 5, cx + 175, cy + 6);
  // Notch between forewing & hindwing.
  ctx.bezierCurveTo(cx + 145, cy + 10, cx + 140, cy + 12, cx + 130, cy + 20);
  // Outer edge of hindwing — wider, more rounded.
  ctx.bezierCurveTo(cx + 175, cy + 40, cx + 175, cy + 95, cx + 120, cy + 115);
  // Bottom of hindwing (slight tail-tip).
  ctx.bezierCurveTo(cx + 70, cy + 130, cx + 30, cy + 110, cx + 18, cy + 65);
  // Back to body axis.
  ctx.bezierCurveTo(cx + 12, cy + 30, cx + 8, cy + 12, cx, cy + 5);
  ctx.closePath();
  ctx.fill();

  // Subtle dark pattern band along the outer edge of the forewing.
  ctx.fillStyle = 'rgba(70, 45, 30, 0.65)';
  ctx.beginPath();
  ctx.moveTo(cx + 200, cy - 60);
  ctx.bezierCurveTo(cx + 230, cy - 30, cx + 220, cy - 5, cx + 175, cy + 6);
  ctx.bezierCurveTo(cx + 200, cy - 5, cx + 215, cy - 25, cx + 195, cy - 50);
  ctx.closePath();
  ctx.fill();

  // Two dark eye-spots on the hindwing.
  ctx.fillStyle = 'rgba(50, 30, 20, 0.8)';
  ctx.beginPath();
  ctx.ellipse(cx + 110, cy + 70, 9, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(220, 170, 60, 0.9)';
  ctx.beginPath();
  ctx.ellipse(cx + 110, cy + 70, 4, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Wing veins — thin curved lines from body to outer edge.
  ctx.strokeStyle = 'rgba(80, 55, 35, 0.42)';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  const veins: Array<[number, number, number, number, number, number]> = [
    [cx + 4, cy - 5, cx + 50, cy - 60, cx + 120, cy - 85],
    [cx + 4, cy - 2, cx + 70, cy - 30, cx + 180, cy - 40],
    [cx + 4, cy + 4, cx + 60, cy + 30, cx + 150, cy + 10],
    [cx + 4, cy + 8, cx + 50, cy + 60, cx + 130, cy + 90],
    [cx + 4, cy + 10, cx + 35, cy + 75, cx + 60, cy + 115],
  ];
  for (const [x0, y0, cx2, cy2, x1, y1] of veins) {
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(cx2, cy2, x1, y1);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function Butterfly() {
  const group = useRef<THREE.Group>(null);
  const leftWing = useRef<THREE.Group>(null);
  const rightWing = useRef<THREE.Group>(null);

  const stateRef = useRef<State>('hidden');
  const timer = useRef(0);
  const sleepFor = useRef(rand(FIRST_SLEEP_MIN, FIRST_SLEEP_MAX));
  const wingPhase = useRef(0);

  const wingTexture = useMemo(() => buildButterflyWingTexture(), []);
  // Wing plane sized: width = half wingspan, length = body-length × 2
  // so the hindwing notch sits behind the body midline as drawn in the
  // texture. The body axis is at the left edge of the canvas, so the
  // plane is anchored at its -X edge instead of the centre — we offset
  // the mesh by half the width.
  const wingWidth = WINGSPAN * 0.5;
  const wingLength = BODY_LENGTH * 2.0;

  const inCurve = useRef<THREE.CatmullRomCurve3 | null>(null);
  const outCurve = useRef<THREE.CatmullRomCurve3 | null>(null);

  // Reusable scratch vectors so per-frame sampling doesn't allocate.
  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpAhead = useMemo(() => new THREE.Vector3(), []);

  const startCycle = () => {
    const stone = STONES[Math.floor(Math.random() * STONES.length)];
    // Stone top: mesh is positioned at y = scale[1] * 0.5 and the
    // icosahedron's unit radius is scaled by scale[1], so the top sits
    // at scale[1] * 1.5. Hover the perch ~15cm above that.
    const perchY = stone.scale[1] * 1.5 + 0.15;
    const perch = new THREE.Vector3(stone.pos[0], perchY, stone.pos[1]);

    const inAngle = rand(0, Math.PI * 2);
    const entry = new THREE.Vector3(
      Math.cos(inAngle) * SPAWN_RADIUS,
      rand(FLIGHT_ALT_MIN, FLIGHT_ALT_MAX),
      Math.sin(inAngle) * SPAWN_RADIUS,
    );
    // Exit roughly opposite of entry (±0.4 rad jitter) so the
    // butterfly visibly crosses the garden.
    const exitAngle = inAngle + Math.PI + rand(-0.4, 0.4);
    const exit = new THREE.Vector3(
      Math.cos(exitAngle) * SPAWN_RADIUS,
      rand(FLIGHT_ALT_MIN, FLIGHT_ALT_MAX),
      Math.sin(exitAngle) * SPAWN_RADIUS,
    );

    // Lift the mid control points to make the curves arc instead of
    // running flat across the scene.
    const inMid = entry.clone().lerp(perch, 0.5).add(
      new THREE.Vector3(rand(-0.4, 0.4), 0.4, rand(-0.4, 0.4)),
    );
    inCurve.current = new THREE.CatmullRomCurve3([entry, inMid, perch]);

    const outMid = perch.clone().lerp(exit, 0.5).add(
      new THREE.Vector3(rand(-0.4, 0.4), 0.4, rand(-0.4, 0.4)),
    );
    outCurve.current = new THREE.CatmullRomCurve3([perch, outMid, exit]);

    stateRef.current = 'flying-in';
    timer.current = 0;
    if (group.current) {
      group.current.visible = true;
      group.current.position.copy(entry);
    }
  };

  useFrame((_, dt) => {
    if (!group.current) return;
    timer.current += dt;

    // ---- wing flap ----
    let flapHz = 0;
    if (
      stateRef.current === 'flying-in' ||
      stateRef.current === 'flying-out'
    ) {
      flapHz = 7;
    } else if (stateRef.current === 'perching') {
      flapHz = 1.4;
    }
    wingPhase.current += dt * flapHz * Math.PI * 2;
    const flap = Math.sin(wingPhase.current) * 0.65;
    if (leftWing.current) leftWing.current.rotation.z = -flap;
    if (rightWing.current) rightWing.current.rotation.z = flap;

    switch (stateRef.current) {
      case 'hidden':
        if (group.current.visible) group.current.visible = false;
        if (timer.current >= sleepFor.current) startCycle();
        return;
      case 'flying-in': {
        if (!inCurve.current) return;
        const t = Math.min(1, timer.current / FLY_IN_DUR);
        inCurve.current.getPointAt(t, tmpPos);
        group.current.position.copy(tmpPos);
        if (t < 0.96) {
          inCurve.current.getPointAt(Math.min(1, t + 0.02), tmpAhead);
          group.current.lookAt(tmpAhead);
        }
        if (t >= 1) {
          stateRef.current = 'perching';
          timer.current = 0;
        }
        return;
      }
      case 'perching':
        if (timer.current >= PERCH_DUR) {
          stateRef.current = 'flying-out';
          timer.current = 0;
        }
        return;
      case 'flying-out': {
        if (!outCurve.current) return;
        const t = Math.min(1, timer.current / FLY_OUT_DUR);
        outCurve.current.getPointAt(t, tmpPos);
        group.current.position.copy(tmpPos);
        if (t < 0.96) {
          outCurve.current.getPointAt(Math.min(1, t + 0.02), tmpAhead);
          group.current.lookAt(tmpAhead);
        }
        if (t >= 1) {
          stateRef.current = 'hidden';
          timer.current = 0;
          sleepFor.current = rand(RESPAWN_SLEEP_MIN, RESPAWN_SLEEP_MAX);
          group.current.visible = false;
        }
        return;
      }
    }
  });

  return (
    <group ref={group} visible={false}>
      {/* tiny dark body slab pointing along local -Z (= forward) */}
      <mesh>
        <boxGeometry args={[0.012, 0.012, BODY_LENGTH]} />
        <meshStandardMaterial color="#241612" roughness={0.5} />
      </mesh>

      {/* antennae — two thin lines from head, curving forward & out */}
      <mesh position={[0.004, 0.004, -BODY_LENGTH * 0.45]} rotation={[0, 0.3, 0.4]}>
        <cylinderGeometry args={[0.0005, 0.0005, 0.022, 4, 1]} />
        <meshStandardMaterial color="#241612" />
      </mesh>
      <mesh position={[-0.004, 0.004, -BODY_LENGTH * 0.45]} rotation={[0, -0.3, -0.4]}>
        <cylinderGeometry args={[0.0005, 0.0005, 0.022, 4, 1]} />
        <meshStandardMaterial color="#241612" />
      </mesh>

      {/* right wing — hinges around body's Z axis. Plane lies flat on
          XZ; texture's body axis is at the plane's -X edge so we offset
          the mesh by +wingWidth/2 so the hinge sits on the body. */}
      <group ref={rightWing}>
        <mesh
          position={[wingWidth / 2, 0, 0]}
          rotation={[Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[wingWidth, wingLength]} />
          <meshStandardMaterial
            map={wingTexture}
            color="#f4ecdc"
            side={THREE.DoubleSide}
            transparent
            alphaTest={0.4}
            roughness={0.75}
            emissive="#f4ecdc"
            emissiveIntensity={0.04}
          />
        </mesh>
      </group>

      {/* left wing — mirror of right via negative X scale */}
      <group ref={leftWing}>
        <mesh
          position={[-wingWidth / 2, 0, 0]}
          rotation={[Math.PI / 2, 0, 0]}
          scale={[-1, 1, 1]}
        >
          <planeGeometry args={[wingWidth, wingLength]} />
          <meshStandardMaterial
            map={wingTexture}
            color="#f4ecdc"
            side={THREE.DoubleSide}
            transparent
            alphaTest={0.4}
            roughness={0.75}
            emissive="#f4ecdc"
            emissiveIntensity={0.04}
          />
        </mesh>
      </group>
    </group>
  );
}
