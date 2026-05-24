/**
 * Single source of truth for all stone positions in the garden.
 *
 * Used by:
 *   - Stones.tsx          renders the 5 zen stones
 *   - SandPlane.tsx       feeds positions/radii to the karesansui
 *                         shader so the parallel waves bend into
 *                         concentric ripples around each stone
 *   - patterns.ts         generates the robot's concentric ring
 *                         maintenance route around each stone
 *
 * Coordinate convention: (x, z) world metres, y is always 0 (ground).
 */

export type StoneSpec = {
  /** World XZ position. */
  pos: [number, number];
  /** Visual scale of the icosahedron mesh (x, y, z). */
  scale: [number, number, number];
  /** Y-axis rotation in radians for visual variety. */
  rotY: number;
  /**
   * Approximate XZ radius for the shader's concentric-ripple field.
   * Should roughly match the stone's visible XZ footprint so ripples
   * start at the stone's edge, not from its centre.
   */
  rakeRadius: number;
};

// Stones spread across the 16m sand to corner regions, with at least
// ~4m pairwise distance for breathing room. Every stone's ripple zone
// (radius + RIPPLE_EXTENT) stays inside the safe sand area (|x|, |z|
// < 8), so concentric rings never get clipped by the wooden border.
// Two of the five stones are "standing stones" (立石): taller than wide
// rather than the squat/horizontal majority. Real karesansui composition
// rules call for vertical accents among the laying stones — a tall stone
// suggests a mountain peak, a flat one a shoreline. Stones 3 and 4 are
// the verticals here.
export const STONES: StoneSpec[] = [
  // Big squat SW anchor stone.
  { pos: [-4.0, -3.5], scale: [1.1, 0.7, 1.0], rotY: 0.3, rakeRadius: 1.1 },
  // NW medium stone — restored after deletion left the left side too sparse.
  { pos: [-4.0, 2.5], scale: [0.65, 0.45, 0.7], rotY: 1.1, rakeRadius: 0.7 },
  // Tall standing NE accent.
  { pos: [3.8, 2.5], scale: [0.5, 1.3, 0.5], rotY: 2.0, rakeRadius: 0.55 },
  // Small standing N accent.
  { pos: [0.0, 4.0], scale: [0.35, 0.95, 0.4], rotY: 1.7, rakeRadius: 0.4 },
];

/** Charging dock — tucked into the south-east corner of the garden,
 *  pressed against the walls so it stays out of the central
 *  composition. */
export const HOME_STONE_POS: [number, number] = [6.2, -6.2];
export const HOME_STONE_RAKE_RADIUS = 0.85;

/**
 * Flat list consumed by the shader uniform - 5 zen stones plus the
 * home stone. The bg shader draws concentric ripples around all 6;
 * patterns.ts treats all 6 as obstacles to avoid when generating
 * the maintenance route.
 *
 * If you add or remove a stone, also bump the loop bound in the
 * SandPlane fragment shader (currently `i < 6`).
 */
// 4 main + 1 home stone. If you add/remove a stone, update this and
// also bump the `i < N` loop bound in the SandPlane fragment shader.
export const SHADER_STONE_COUNT = 5;

export type ShaderStone = { pos: [number, number]; radius: number };

export const SHADER_STONES: ShaderStone[] = [
  ...STONES.map((s) => ({ pos: s.pos, radius: s.rakeRadius })),
  { pos: HOME_STONE_POS, radius: HOME_STONE_RAKE_RADIUS },
];
