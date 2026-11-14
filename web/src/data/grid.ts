import type { MeasuredPath, PathSample, XY } from "../types";
import type { EvaParams } from "../eva/params";
import { MAX_GRADE, walkEnergyJ, walkSpeedMs } from "../eva/metabolic";

export const BLOCKED = 255;
/** Risk multiplier charged for (straight-line) travel across impassable ground, for comparison only. */
export const BLOCKED_RISK = 8;

/**
 * The terrain grid shared by the main thread and the routing worker.
 * Nodes sit every `cell` metres; row 0 is the north edge.  Arrays are row-major, n × n.
 */
export class TerrainGrid {
  readonly size: number;
  constructor(
    readonly n: number,
    readonly cell: number,
    readonly height: Float32Array, // metres
    readonly effort: Uint8Array, // energy multiplier × effortScale
    readonly risk: Uint8Array, // risk multiplier × riskScale, 255 = impassable
    readonly slope: Uint8Array, // degrees
    readonly sand: Uint8Array, // 0..255
    readonly effortScale = 50,
    readonly riskScale = 50,
    readonly shield: Uint8Array | null = null, // dose factor x 255 (terrain blocking part of the sky)
  ) {
    this.size = (n - 1) * cell;
  }

  index(col: number, row: number): number {
    return row * this.n + col;
  }

  /** Nearest node to a local position. */
  nodeAt(x: number, y: number): number {
    const c = Math.max(0, Math.min(this.n - 1, Math.round(x / this.cell)));
    const r = Math.max(0, Math.min(this.n - 1, Math.round((this.size - y) / this.cell)));
    return r * this.n + c;
  }

  xyOf(node: number): XY {
    const r = Math.floor(node / this.n);
    const c = node - r * this.n;
    return { x: c * this.cell, y: this.size - r * this.cell };
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x <= this.size && y <= this.size;
  }

  /** Bilinear terrain height at a local position. */
  heightAt(x: number, y: number): number {
    const fx = Math.max(0, Math.min(this.n - 1.0001, x / this.cell));
    const fy = Math.max(0, Math.min(this.n - 1.0001, (this.size - y) / this.cell));
    const c = Math.floor(fx);
    const r = Math.floor(fy);
    const tx = fx - c;
    const ty = fy - r;
    const i = r * this.n + c;
    const h = this.height;
    return (h[i] * (1 - tx) + h[i + 1] * tx) * (1 - ty) + (h[i + this.n] * (1 - tx) + h[i + this.n + 1] * tx) * ty;
  }

  effortAt(node: number): number {
    return this.effort[node] / this.effortScale;
  }

  riskAt(node: number): number {
    return this.risk[node] / this.riskScale;
  }

  /** Fraction of the open-sky dose rate received at a position (1 = open ground). */
  shieldAt(x: number, y: number): number {
    return this.shield ? this.shield[this.nodeAt(x, y)] / 255 : 1;
  }

  isBlocked(node: number): boolean {
    return this.risk[node] === BLOCKED;
  }

  /** Nearest passable node to a position (spiral search), or -1. */
  nearestPassable(x: number, y: number, maxRadiusCells = 40): number {
    const start = this.nodeAt(x, y);
    if (!this.isBlocked(start)) return start;
    const r0 = Math.floor(start / this.n);
    const c0 = start - r0 * this.n;
    let best = -1;
    let bestD = Infinity;
    for (let rad = 1; rad <= maxRadiusCells && best < 0; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || c < 0 || r >= this.n || c >= this.n) continue;
          const i = r * this.n + c;
          if (this.isBlocked(i)) continue;
          const d = dr * dr + dc * dc;
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best;
  }
}

/**
 * Walk a polyline and accumulate distance, energy and time, sampling every `step` metres.
 * This one function produces every number the app shows about a route, so the router,
 * the budget panel, the profile chart and the simulation can never disagree.
 */
export function measurePath(grid: TerrainGrid, points: XY[], p: EvaParams, step = grid.cell): MeasuredPath {
  const samples: PathSample[] = [];
  let dist = 0;
  let energy = 0;
  let time = 0;
  let cost = 0;
  let climb = 0;
  let descent = 0;
  let maxSlope = 0;
  let blockedM = 0;
  let sandM = 0;

  const push = (x: number, y: number, z: number, gradeDeg: number) => {
    const node = grid.nodeAt(x, y);
    const slopeDeg = grid.slope[node];
    samples.push({
      x, y, z, dist, energy, time, slopeDeg, gradeDeg,
      sand: grid.sand[node] / 255,
      shield: grid.shield ? grid.shield[node] / 255 : 1,
      blocked: grid.isBlocked(node),
    });
    if (slopeDeg > maxSlope) maxSlope = slopeDeg;
  };

  if (points.length === 0) {
    return { points, samples, distance: 0, energy: 0, time: 0, climb: 0, descent: 0, maxSlopeDeg: 0, blockedM: 0, sandM: 0, cost: 0 };
  }

  let px = points[0].x;
  let py = points[0].y;
  let pz = grid.heightAt(px, py);
  push(px, py, pz, 0);

  for (let k = 1; k < points.length; k++) {
    const ax = points[k - 1].x;
    const ay = points[k - 1].y;
    const bx = points[k].x;
    const by = points[k].y;
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen < 1e-6) continue;
    const steps = Math.max(1, Math.ceil(segLen / step));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const z = grid.heightAt(x, y);
      const run = Math.hypot(x - px, y - py);
      const rise = z - pz;
      const grade = run > 1e-9 ? rise / run : 0;
      const na = grid.nodeAt(px, py);
      const nb = grid.nodeAt(x, y);
      const effort = (grid.effortAt(na) + grid.effortAt(nb)) / 2;
      const blocked = grid.isBlocked(na) || grid.isBlocked(nb);
      const risk = blocked ? BLOCKED_RISK : (grid.riskAt(na) + grid.riskAt(nb)) / 2;
      const e = walkEnergyJ(grade, run, p) * effort;
      const clamped = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, grade));
      energy += e;
      cost += e * risk;
      time += run / walkSpeedMs(clamped, effort, p);
      dist += Math.hypot(run, rise);
      if (rise > 0) climb += rise;
      else descent -= rise;
      if (blocked) blockedM += run;
      if ((grid.sand[na] + grid.sand[nb]) / 510 > 0.5) sandM += run;
      px = x;
      py = y;
      pz = z;
      push(x, y, z, (Math.atan(grade) * 180) / Math.PI);
    }
  }

  return { points, samples, distance: dist, energy, time, climb, descent, maxSlopeDeg: maxSlope, blockedM, sandM, cost };
}

/** Risk-weighted energy of walking a straight segment; Infinity if it touches impassable ground. */
export function segmentCost(grid: TerrainGrid, a: XY, b: XY, p: EvaParams): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 1e-6) return 0;
  const steps = Math.max(1, Math.ceil(len / (grid.cell * 0.5)));
  let px = a.x;
  let py = a.y;
  let pz = grid.heightAt(px, py);
  let pn = grid.nodeAt(px, py);
  if (grid.isBlocked(pn)) return Infinity;
  let cost = 0;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const n = grid.nodeAt(x, y);
    if (grid.isBlocked(n)) return Infinity;
    const z = grid.heightAt(x, y);
    const run = Math.hypot(x - px, y - py);
    const e = walkEnergyJ((z - pz) / run, run, p) * ((grid.effortAt(pn) + grid.effortAt(n)) / 2);
    cost += e * ((grid.riskAt(pn) + grid.riskAt(n)) / 2);
    px = x;
    py = y;
    pz = z;
    pn = n;
  }
  return cost;
}
