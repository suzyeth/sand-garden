import { SHADER_STONES, STONES, type ShaderStone } from './stones';
import { WALL_LIMIT, CHASSIS_SAFETY } from './constants';

/**
 * Robot maintenance route.
 *
 * The karesansui pattern lives in the SHADER as a fixed background:
 * procedural concentric ripples around each stone (frequency =
 * BG_FREQ_PER_METRE = 4.5 cycles/m, so dark lines at distances
 * stone.radius + 0.111 + n*0.222 from each stone centre).
 *
 * The robot's path is designed to OVERLAP those existing dark
 * lines, not cut across them. So we trace concentric CIRCLES
 * around each stone at radii matching the bg dark-line positions.
 * The fresh trail then aligns pixel-for-pixel with the bg pattern
 * and reads as "maintenance / deepening the existing line"
 * rather than as "drawing something new".
 *
 * Between stones, we walk a direct safe transit. This is the only
 * place a fresh line briefly cuts across bg, but it's a short pass
 * and drift erases it within ~45s.
 *
 * Path is computed once at module load. Every waypoint is guaranteed
 * inside the safe sand area and outside every stone's chassis-
 * clearance circle. There are NO radius jumps - each ring is dense
 * enough that consecutive waypoints are tens of centimetres apart.
 */

export type Waypoint = [number, number];

/**
 * Tags the segment FROM waypoint[i] TO waypoint[i+1].
 *
 * - 'ring'           : both endpoints belong to the same ring; rake DOWN.
 * - 'transit-ring'   : crossing from one ring to another of the same stone; rake UP.
 * - 'transit-stone'  : crossing to a different stone (or wrapping at loop end); rake UP, longer pause.
 */
export type SegmentFlag = 'ring' | 'transit-ring' | 'transit-stone';

export interface KaresansuiPath {
  waypoints: Waypoint[];
  /** flags[i] describes the segment from waypoints[i] to waypoints[(i+1) % N]. */
  flags: SegmentFlag[];
}

// WALL_LIMIT and CHASSIS_SAFETY come from sim/constants.ts

// Bg ripple wavelength = 1 / 4.5 = 0.2222m.
// Bg dark lines are at offset (2k+1) * 0.1111 from each stone surface.
// We pick k = 3, 5, 7, 9 -> offsets 0.777, 1.221, 1.665, 2.109.
// These are evenly spaced (0.444m apart) and all sit comfortably
// outside the chassis-safety circle.
const RING_OFFSETS = [0.777, 1.221, 1.665, 2.109] as const;
const POINTS_PER_RING = 64;

// Virtual rake target: the central moss island. It's not a real
// shader stone (no BG ripple, not in SHADER_STONES), but the robot
// includes it in its visit schedule so the island gets its own
// concentric spiral pattern too. Radius 1.0 picks an inner spiral
// edge (1.0 + 0.45 = 1.45) that sits outside the moss island's
// furthest embedded stone (~1.43 from island centre), so the robot
// orbits the whole island rather than crashing through it.
const ISLAND_TARGET: ShaderStone = { pos: [1.6, -1.7], radius: 1.0 };

// Robot draws spirals around the main zen stones AND the moss
// island. Home stone stays out of the visit list (charging dock,
// not for raking). Island is appended after the last main stone so
// the loop ends with a transit from island back to stone 0.
const VISITED_STONES: ShaderStone[] = [
  ...SHADER_STONES.slice(0, STONES.length),
  ISLAND_TARGET,
];

// ----- helpers -----

function isWaypointSafe(
  x: number,
  z: number,
  currentStone: ShaderStone,
): boolean {
  if (Math.abs(x) >= WALL_LIMIT || Math.abs(z) >= WALL_LIMIT) return false;
  for (const other of SHADER_STONES) {
    if (other === currentStone) continue;
    const d = Math.hypot(x - other.pos[0], z - other.pos[1]);
    if (d < other.radius + CHASSIS_SAFETY) return false;
  }
  return true;
}

function ringForStone(stone: ShaderStone, offset: number): Waypoint[] {
  const points: Waypoint[] = [];
  const r = stone.radius + offset;
  for (let p = 0; p < POINTS_PER_RING; p++) {
    const angle = (p / POINTS_PER_RING) * Math.PI * 2;
    const wx = stone.pos[0] + Math.cos(angle) * r;
    const wz = stone.pos[1] + Math.sin(angle) * r;
    if (isWaypointSafe(wx, wz, stone)) {
      points.push([wx, wz]);
    }
  }
  return points;
}

/**
 * Stepped concentric rings around one stone — three clearly distinct
 * circles at fixed radii, joined by short radial bridges. This is the
 * authentic karesansui pattern (the rake bar moves at constant radius
 * around a stone; the monk lifts and shifts to start the next ring).
 *
 * We give up the previous "perfectly continuous spiral" idea because
 * a spiral with N turns + visible width-of-trail has every pass
 * landing right next to the previous one — the sand looks like a
 * single fat smear instead of cleanly nested rings. With stepped
 * rings each pass is a full circle at a unique radius, then a tiny
 * bridge swings to the next radius.
 *
 * Path shape:
 *   ring 1 at radius r1 (≈92% of a revolution) →
 *   short radial bridge →
 *   ring 2 at radius r2 (≈92%) →
 *   bridge →
 *   ring 3 at radius r3 (extended to end pointing at next stone)
 *
 * Angle convention:
 *   - entry angle: angle from THIS stone toward the PREVIOUS stone
 *     (so inner-ring start is on the prev-facing side, the rake
 *     arrives without a long detour).
 *   - exit angle: angle from THIS stone toward the NEXT stone. The
 *     last ring's sweep is extended so it lands here at outer radius
 *     → next transit is the shortest possible straight line.
 */
// Tight Archimedean spiral params — pitch chosen so consecutive
// passes are visibly separate bands but the cluster reads as a dense
// ripple field, not a sparse few rings.
const SPIRAL_INNER = 0.45;
const SPIRAL_OUTER = 1.85;
const SPIRAL_TURNS = 7; // pitch ≈ (1.85 − 0.45) / 7 ≈ 0.2m

function archimedeanSpiral(
  stone: ShaderStone,
  entryAngle: number,
  exitAngle: number,
): Waypoint[] {
  const innerR = stone.radius + SPIRAL_INNER;
  const outerR = stone.radius + SPIRAL_OUTER;
  let delta = exitAngle - entryAngle;
  while (delta < 0) delta += 2 * Math.PI;
  const totalSweep = 2 * Math.PI * SPIRAL_TURNS + delta;

  const points: Waypoint[] = [];
  // 14 points per radian keeps the outermost loop visibly smooth.
  const N = Math.max(280, Math.ceil(totalSweep * 14));
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const angle = entryAngle + totalSweep * t;
    const r = innerR + (outerR - innerR) * t;
    const wx = stone.pos[0] + Math.cos(angle) * r;
    const wz = stone.pos[1] + Math.sin(angle) * r;
    if (isWaypointSafe(wx, wz, stone)) {
      points.push([wx, wz]);
    }
  }
  return points;
}

// ----- path generation -----

/**
 * Generate the karesansui maintenance path as a sequence of ring chunks
 * with explicit flags marking inter-ring and inter-stone transits.
 *
 * Each ring is a continuous sequence of waypoints; the segment from the
 * last point of one ring to the first point of the next ring is tagged
 * either 'transit-ring' (same stone) or 'transit-stone' (next stone /
 * loop wrap). The Robot consumes these flags to decide when to pause
 * and when to lift its rake.
 */
export function generateKaresansuiPath(): KaresansuiPath {
  // One petal-spiral per stone. Each stone's entry/exit angles point
  // at its previous / next stone, so the inter-stone transit is the
  // shortest straight line between their outer-ring boundaries.
  type Chunk = { points: Waypoint[] };
  const chunks: Chunk[] = [];
  const n = VISITED_STONES.length;
  for (let s = 0; s < n; s++) {
    const stone = VISITED_STONES[s];
    const prev = VISITED_STONES[(s - 1 + n) % n];
    const next = VISITED_STONES[(s + 1) % n];
    const entryAngle = Math.atan2(
      prev.pos[1] - stone.pos[1],
      prev.pos[0] - stone.pos[0],
    );
    const exitAngle = Math.atan2(
      next.pos[1] - stone.pos[1],
      next.pos[0] - stone.pos[0],
    );
    const pts = archimedeanSpiral(stone, entryAngle, exitAngle);
    if (pts.length > 3) chunks.push({ points: pts });
  }

  const waypoints: Waypoint[] = [];
  const flags: SegmentFlag[] = [];
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    for (let i = 0; i < chunk.points.length; i++) {
      waypoints.push(chunk.points[i]);
      // Last point: outgoing edge is the (short) transit to next
      // stone's spiral. All other intra-spiral edges are 'ring'.
      flags.push(
        i === chunk.points.length - 1 ? 'transit-stone' : 'ring',
      );
    }
  }
  return { waypoints, flags };
}

// ----- runtime kinematic playback (consumed by Robot.tsx) -----

export type SampledPathPoint = {
  pos: [number, number];
  yaw: number;
  /** Flag of the segment we are currently on. */
  flag: SegmentFlag;
  /** Cumulative distance at the end of the current segment (waypoint[lo+1]). */
  segEndDist: number;
};

// ----- wabi-sabi path jitter -----
// A small perpendicular wobble layered on top of the geometric path so
// the rake lines aren't laser-straight. Driven by arc-length so the
// wobble pattern stays consistent regardless of speed.
const JITTER_AMP_RAKE = 0.013; // ~1.3cm while raking
const JITTER_AMP_TRANSIT = 0.005; // tiny during transit (rake is up anyway)

function jitterAt(distance: number): number {
  // Sum of two incommensurate sines reads as organic, not periodic.
  return (
    0.6 * Math.sin(distance * 0.85 + 1.3) +
    0.4 * Math.sin(distance * 2.17 + 0.4)
  );
}

export class PathPlayback {
  readonly waypoints: Waypoint[];
  readonly flags: SegmentFlag[];
  readonly cumDist: Float32Array;
  readonly totalLength: number;

  constructor(path: KaresansuiPath) {
    const { waypoints, flags } = path;
    if (waypoints.length === 0) {
      this.waypoints = [[0, 0]];
      this.flags = ['ring'];
      this.cumDist = new Float32Array([0]);
      this.totalLength = 0;
      return;
    }
    this.waypoints = waypoints;
    this.flags = flags;
    this.cumDist = new Float32Array(waypoints.length);
    this.cumDist[0] = 0;
    for (let i = 1; i < waypoints.length; i++) {
      const dx = waypoints[i][0] - waypoints[i - 1][0];
      const dz = waypoints[i][1] - waypoints[i - 1][1];
      this.cumDist[i] = this.cumDist[i - 1] + Math.hypot(dx, dz);
    }
    // Total length includes the loop-closing edge from last to first
    // waypoint so the sample() modulo stays consistent.
    const lastIdx = waypoints.length - 1;
    const closeDx = waypoints[0][0] - waypoints[lastIdx][0];
    const closeDz = waypoints[0][1] - waypoints[lastIdx][1];
    this.totalLength = this.cumDist[lastIdx] + Math.hypot(closeDx, closeDz);
  }

  sample(distance: number): SampledPathPoint {
    if (this.totalLength <= 0) {
      return {
        pos: [this.waypoints[0][0], this.waypoints[0][1]],
        yaw: 0,
        flag: this.flags[0],
        segEndDist: 0,
      };
    }
    let t = distance % this.totalLength;
    if (t < 0) t += this.totalLength;
    const n = this.cumDist.length;
    let lo = 0;
    let hi = n - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumDist[mid] <= t) lo = mid;
      else hi = mid;
    }
    // Special case: if t is past cumDist[lastIdx], we're on the closing
    // edge (waypoints[lastIdx] -> waypoints[0]).
    let segStart: number;
    let segEnd: number;
    let p0: Waypoint;
    let p1: Waypoint;
    if (t >= this.cumDist[n - 1]) {
      lo = n - 1;
      segStart = this.cumDist[lo];
      segEnd = this.totalLength;
      p0 = this.waypoints[lo];
      p1 = this.waypoints[0];
    } else {
      segStart = this.cumDist[lo];
      segEnd = this.cumDist[lo + 1];
      p0 = this.waypoints[lo];
      p1 = this.waypoints[lo + 1];
    }
    const segLen = segEnd - segStart;
    const u = segLen > 0 ? (t - segStart) / segLen : 0;
    const x = p0[0] + (p1[0] - p0[0]) * u;
    const z = p0[1] + (p1[1] - p0[1]) * u;
    const dx = p1[0] - p0[0];
    const dz = p1[1] - p0[1];
    const yaw = Math.atan2(dx, -dz);

    // Wabi-sabi perpendicular jitter. Offsets POSITION only, not yaw,
    // so the rake bar stays aligned with the underlying tangent and
    // we don't get a jittery rotation. We dial it down during transits.
    const flag = this.flags[lo];
    const amp = flag === 'ring' ? JITTER_AMP_RAKE : JITTER_AMP_TRANSIT;
    let xJ = x;
    let zJ = z;
    if (segLen > 0 && amp > 0) {
      const j = jitterAt(t) * amp;
      // Perpendicular to forward in world XZ.
      const perpX = dz / segLen;
      const perpZ = -dx / segLen;
      xJ += perpX * j;
      zJ += perpZ * j;
    }
    return { pos: [xJ, zJ], yaw, flag, segEndDist: segEnd };
  }
}
