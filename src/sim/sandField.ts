import * as THREE from 'three';
import { SAND_SIZE } from './constants';

/**
 * The sand height field.
 *
 * Each cell stores ONE float: the depression depth at that point of
 * the sand surface. 0 = pristine flat, 1 = maximum dig.
 *
 * Resolution is 256x256 over the 14x14m sand area = 0.055m per cell.
 * This is fine enough that the 5 rake teeth (~12cm apart) carve
 * visibly DISTINCT parallel lines: each tooth covers ~1-2 cells and
 * the gap between teeth is ~2-3 cells of pristine sand.
 *
 * No procedural background pattern. The sand starts as a blank canvas;
 * only the robot's actual etching leaves marks. Trail visuals come
 * entirely from the shader's height-gradient relief lighting in
 * SandPlane.tsx - no sin-wave overlay, no concentric ripples, no
 * parallel waves. The visible "karesansui rake line" look emerges
 * from the physical geometry of the etched groove + directional light.
 *
 * Coordinate convention:
 *   world  ( -7, _, +7 ) -> UV (0, 0) -> cell (i=0, j=0)
 *   world  ( +7, _, -7 ) -> UV (1, 1) -> cell (size-1, size-1)
 */

// Bumped from 256 -> 1024 (~1.56cm per cell over 16m). At 256 each
// rake tooth covered ~1 cell, leaving a blurry blob; at 1024 a 2cm
// tooth spans ~2.5 cells which finally reads as a crisp groove.
// Memory is 4 MB (1024^2 * 4B), still negligible.
const GRID_SIZE = 1024;
const WORLD_SIZE = SAND_SIZE;

class SandField {
  readonly size = GRID_SIZE;
  readonly worldSize = WORLD_SIZE;
  readonly grid = new Float32Array(GRID_SIZE * GRID_SIZE);
  readonly texture: THREE.DataTexture;
  private readonly _scratch = new Float32Array(GRID_SIZE * GRID_SIZE);

  constructor() {
    // pristine flat sand
    this.grid.fill(0);

    this.texture = new THREE.DataTexture(
      this.grid,
      GRID_SIZE,
      GRID_SIZE,
      THREE.RedFormat,
      THREE.FloatType,
    );
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.needsUpdate = true;
  }

  private worldToCell(x: number, z: number): [number, number] {
    const half = this.worldSize / 2;
    const cellsPerMeter = this.size / this.worldSize;
    return [(x + half) * cellsPerMeter, (half - z) * cellsPerMeter];
  }

  /**
   * Dig a small circular depression around world (x, z). With grid
   * 256 and a radius of ~0.05m, each tooth carves about 2 cells wide
   * - thin enough that adjacent teeth at 0.12m spacing leave a clear
   * gap of pristine sand between them.
   */
  etch(
    x: number,
    z: number,
    radiusMeters: number,
    depthPerSec: number,
    dt: number,
  ) {
    const [cx, cz] = this.worldToCell(x, z);
    const cellsPerMeter = this.size / this.worldSize;
    const r = radiusMeters * cellsPerMeter;
    const r2 = r * r;
    const dtDepth = depthPerSec * dt;

    const iMin = Math.max(0, Math.floor(cx - r));
    const iMax = Math.min(this.size - 1, Math.ceil(cx + r));
    const jMin = Math.max(0, Math.floor(cz - r));
    const jMax = Math.min(this.size - 1, Math.ceil(cz + r));

    for (let j = jMin; j <= jMax; j++) {
      const dj = j + 0.5 - cz;
      for (let i = iMin; i <= iMax; i++) {
        const di = i + 0.5 - cx;
        const d2 = di * di + dj * dj;
        if (d2 < r2) {
          const falloff = 1 - Math.sqrt(d2) / r;
          const idx = j * this.size + i;
          this.grid[idx] = Math.min(1, this.grid[idx] + dtDepth * falloff);
        }
      }
    }
  }

  /**
   * Dig a thin GROOVE between two world-space endpoints. Used when the
   * robot moves slightly each frame so the trail is a continuous line
   * rather than a sequence of discrete stamps. We rasterise the
   * cell-AABB once and, for each cell, compute distance to the closest
   * point on the segment. This is cheap because the per-frame segment
   * is only ~1cm long.
   */
  etchLine(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    radiusMeters: number,
    depthPerSec: number,
    dt: number,
  ) {
    const [cx0, cz0] = this.worldToCell(x0, z0);
    const [cx1, cz1] = this.worldToCell(x1, z1);
    const cellsPerMeter = this.size / this.worldSize;
    const r = radiusMeters * cellsPerMeter;
    const r2 = r * r;
    const dtDepth = depthPerSec * dt;

    const iMin = Math.max(0, Math.floor(Math.min(cx0, cx1) - r));
    const iMax = Math.min(this.size - 1, Math.ceil(Math.max(cx0, cx1) + r));
    const jMin = Math.max(0, Math.floor(Math.min(cz0, cz1) - r));
    const jMax = Math.min(this.size - 1, Math.ceil(Math.max(cz0, cz1) + r));

    const sdx = cx1 - cx0;
    const sdz = cz1 - cz0;
    const segLen2 = sdx * sdx + sdz * sdz;

    for (let j = jMin; j <= jMax; j++) {
      const rowOff = j * this.size;
      for (let i = iMin; i <= iMax; i++) {
        const px = i + 0.5;
        const pz = j + 0.5;
        // Closest point on segment to (px, pz). t clamped to [0, 1].
        let t = 0;
        if (segLen2 > 0) {
          t = ((px - cx0) * sdx + (pz - cz0) * sdz) / segLen2;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
        }
        const qx = cx0 + sdx * t;
        const qz = cz0 + sdz * t;
        const dx = px - qx;
        const dz = pz - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 < r2) {
          const falloff = 1 - Math.sqrt(d2) / r;
          const idx = rowOff + i;
          this.grid[idx] = Math.min(1, this.grid[idx] + dtDepth * falloff);
        }
      }
    }
  }

  /**
   * Pull a world-space point toward the depth-weighted centroid of
   * nearby existing grooves. Used by the rake to lock onto an existing
   * trail when it passes near one, so re-treads land on the same cells
   * instead of carving a parallel ghost line a few cm over.
   *
   * Returns the suggested snapped (x, z). If no cell within
   * searchRadiusMeters has depth >= minDepth, returns the input
   * unchanged so the caller can blend safely.
   */
  snapToGroove(
    x: number,
    z: number,
    searchRadiusMeters: number,
    minDepth: number,
  ): [number, number] {
    const [cx, cz] = this.worldToCell(x, z);
    const cellsPerMeter = this.size / this.worldSize;
    const r = searchRadiusMeters * cellsPerMeter;
    const r2 = r * r;
    const iMin = Math.max(0, Math.floor(cx - r));
    const iMax = Math.min(this.size - 1, Math.ceil(cx + r));
    const jMin = Math.max(0, Math.floor(cz - r));
    const jMax = Math.min(this.size - 1, Math.ceil(cz + r));

    let totalWeight = 0;
    let sumI = 0;
    let sumJ = 0;
    for (let j = jMin; j <= jMax; j++) {
      const rowOff = j * this.size;
      const dj = j + 0.5 - cz;
      for (let i = iMin; i <= iMax; i++) {
        const depth = this.grid[rowOff + i];
        if (depth < minDepth) continue;
        const di = i + 0.5 - cx;
        const d2 = di * di + dj * dj;
        if (d2 > r2) continue;
        const dist = Math.sqrt(d2);
        const w = depth * (1 - dist / r);
        sumI += (i + 0.5) * w;
        sumJ += (j + 0.5) * w;
        totalWeight += w;
      }
    }
    if (totalWeight <= 0) return [x, z];
    const targetCx = sumI / totalWeight;
    const targetCz = sumJ / totalWeight;
    const half = this.worldSize / 2;
    const metersPerCell = this.worldSize / this.size;
    const worldX = targetCx * metersPerCell - half;
    const worldZ = half - targetCz * metersPerCell;
    return [worldX, worldZ];
  }

  /**
   * Optional 5-point Laplacian smoothing. Set rate to 0 (the default
   * we use) to keep rake lines crisp. A tiny positive value can be
   * used to round off sharp pixel-aliased edges.
   */
  diffuse(factor: number) {
    if (factor <= 0) return;
    const G = this.grid;
    const S = this._scratch;
    const N = this.size;
    for (let j = 0; j < N; j++) {
      const rowOff = j * N;
      for (let i = 0; i < N; i++) {
        const idx = rowOff + i;
        const c = G[idx];
        const l = i > 0 ? G[idx - 1] : c;
        const r = i < N - 1 ? G[idx + 1] : c;
        const u = j > 0 ? G[idx - N] : c;
        const d = j < N - 1 ? G[idx + N] : c;
        const avg = (l + r + u + d) * 0.25;
        S[idx] = c + (avg - c) * factor;
      }
    }
    G.set(S);
  }

  /**
   * Exponential drift back toward 0 (pristine). Slow - we want rake
   * patterns to LINGER like a real karesansui that only gets re-raked
   * once a day.
   */
  drift(rate: number) {
    if (rate <= 0) return;
    const G = this.grid;
    for (let i = 0; i < G.length; i++) {
      G[i] -= G[i] * rate;
    }
  }

  upload() {
    this.texture.needsUpdate = true;
  }
}

export const sandField = new SandField();
