/**
 * Single source of truth for geometric constants shared by the sand
 * plane mesh, sand border, sandField texture mapping, robot path
 * generator, and any other consumer.
 *
 * Anything that needs to know "how big is the sand?" or "where do
 * the walls sit?" imports from here so a change in one place can't
 * desync the others.
 */

/** Edge length of the square sand area in world metres. */
export const SAND_SIZE = 16;
export const SAND_HALF = SAND_SIZE / 2;

/** Vertical thickness of the visible sand body (cosmetic). */
export const SAND_THICKNESS = 0.15;

/** Vertical thickness of the brown earth block beneath the sand. */
export const EARTH_DEPTH = 1.4;

/** Half-length-ish margin used to keep waypoints away from stone surfaces. */
export const CHASSIS_SAFETY = 0.6;

/** Robot waypoints must stay inside [-WALL_LIMIT, +WALL_LIMIT] on X and Z. */
export const WALL_LIMIT = SAND_HALF - 1.0;
