/**
 * "Where do we put the hab?"  A suitability score for every spot of the walk area as the site of the
 * crew's base (habitat and landing pad, where the pressurised rover parks), from the same HiRISE terrain
 * the routes use:
 *
 *   flat     the mean slope of a ~24 m footprint (a hab and a pad need level ground: 1 at ≤3°, 0 at ≥10°),
 *            less for each steep (>12°) or impassable patch in it and for loose sand (footings sink,
 *            engines throw it)
 *   shelter  how much of the sky the terrain blocks (less radiation dose, see the Sky shielding layer)
 *   radio    share of the science stops the hab's mast sees directly (UHF needs line of sight)
 *   walk     mean walking time to the science stops (1 at ≤5 min, 0 at ≥40 min)
 *   ice      walking time to the nearest buried-ice stop, where the site has one (1 at 0, 0 at ≥30 min)
 *
 * Flat ground is a gate (it multiplies the score); the others are a weighted mean.  Worked out on a
 * coarse grid (every 4th node, 8 m) so it takes a fraction of a second, then shown smoothed.
 */
import { BLOCKED, TerrainGrid } from "../data/grid";
import { DEFAULT_PARAMS, EvaParams } from "./params";
import { radioShadow, RADIO_LOST_M, RADIO_STEP_M, ROVER_ANTENNA_M, SUIT_ANTENNA_M } from "./radio";
import { buildReturnField } from "../routing/search";
import type { XY } from "../types";

export const HAB_STEP = 4;

export interface HabFactors {
  flat: number;
  shelter: number;
  radio: number;
  walk: number;
  ice: number | null;
  /** Overall 0..1. */
  score: number;
  slopeDeg: number;
  shieldPct: number;
  stopsInSight: number;
  meanWalkS: number;
  iceWalkS: number | null;
}

export interface HabMap {
  /** Coarse grid size (nodes per side) and spacing (m). */
  n: number;
  cell: number;
  /** Score 0..255 per coarse node (0 = unsuitable), row 0 at the north edge like the terrain grid. */
  score: Uint8Array;
  best: XY;
  bestFactors: HabFactors;
  stops: number;
  hasIce: boolean;
  ms: number;
  at(x: number, y: number): HabFactors;
}

export const HAB_WEIGHTS = { shelter: 0.2, radio: 0.3, walk: 0.5, ice: 0.35 };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** The terrain grid at every `step`-th node: heights sampled, slopes and blocking kept at their worst. */
function coarsen(g: TerrainGrid, step: number): { grid: TerrainGrid; meanSlope: Float32Array; steep: Float32Array; meanSand: Float32Array; shield: Float32Array } {
  const n = Math.floor((g.n - 1) / step) + 1;
  const total = n * n;
  const height = new Float32Array(total);
  const effort = new Uint8Array(total);
  const risk = new Uint8Array(total);
  const slope = new Uint8Array(total);
  const sand = new Uint8Array(total);
  const meanSlope = new Float32Array(total);
  const steep = new Float32Array(total);
  const meanSand = new Float32Array(total);
  const shield = new Float32Array(total);
  const h = step >> 1;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const src = r * step * g.n + c * step;
      height[i] = g.height[src];
      let sl = 0, st = 0, blocked = false, sumE = 0, sumR = 0, sumS = 0, sumSh = 0, k = 0;
      for (let dr = -h; dr < step - h; dr++) {
        const rr = r * step + dr;
        if (rr < 0 || rr >= g.n) continue;
        for (let dc = -h; dc < step - h; dc++) {
          const cc = c * step + dc;
          if (cc < 0 || cc >= g.n) continue;
          const j = rr * g.n + cc;
          sl += g.slope[j];
          if (g.slope[j] > 12 || g.risk[j] === BLOCKED) st++;
          if (g.risk[j] === BLOCKED) blocked = true;
          else {
            sumE += g.effort[j];
            sumR += g.risk[j];
          }
          sumS += g.sand[j];
          sumSh += g.shield ? g.shield[j] / 255 : 1;
          k++;
        }
      }
      const open = Math.max(1, k - (blocked ? 1 : 0));
      effort[i] = Math.round(sumE / open) || g.effort[src];
      risk[i] = blocked && g.risk[src] === BLOCKED ? BLOCKED : Math.min(254, Math.round(sumR / open) || g.risk[src]);
      slope[i] = g.slope[src];
      sand[i] = Math.round(sumS / k);
      meanSlope[i] = sl / k;
      steep[i] = st / k;
      meanSand[i] = sumS / k / 255;
      shield[i] = sumSh / k;
    }
  }
  const grid = new TerrainGrid(n, g.cell * step, height, effort, risk, slope, sand, g.effortScale, g.riskScale);
  return { grid, meanSlope, steep, meanSand, shield };
}

/**
 * Score the whole walk area for the hab.  `stops`: the science stops the crew will walk to; `ice`:
 * stops on buried ice (Deuteronilus), or none.
 */
export function habSuitability(fine: TerrainGrid, stops: XY[], ice: XY[] = [], p: EvaParams = DEFAULT_PARAMS, step = HAB_STEP): HabMap {
  const t0 = performance.now();
  const { grid, meanSlope, steep, meanSand, shield } = coarsen(fine, step);
  const n = grid.n;
  const total = n * n;

  // the footprint: one coarse node in every direction (~24 m square at 8 m spacing)
  const footSlope = new Float32Array(total);
  const footSteep = new Float32Array(total);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let a = 0, b = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = Math.min(n - 1, Math.max(0, r + dr));
        for (let dc = -1; dc <= 1; dc++) {
          const j = rr * n + Math.min(n - 1, Math.max(0, c + dc));
          a += meanSlope[j];
          b += steep[j];
        }
      }
      footSlope[r * n + c] = a / 9;
      footSteep[r * n + c] = b / 9;
    }
  }

  // walking time from every node to each stop, and whether the hab's mast sees the stop
  const walkSum = new Float32Array(total);
  const reach = new Uint8Array(total);
  const seen = new Uint8Array(total);
  for (const s of stops) {
    const f = buildReturnField(grid, grid.nearestPassable(s.x, s.y), p);
    // reciprocity: a suit at the stop sees the hab mast exactly when the mast sees the suit
    const shadow = radioShadow(grid, s, SUIT_ANTENNA_M, ROVER_ANTENNA_M);
    for (let i = 0; i < total; i++) {
      if (Number.isFinite(f.time[i])) {
        walkSum[i] += f.time[i];
        reach[i]++;
      }
      if (shadow[i] * RADIO_STEP_M < RADIO_LOST_M) seen[i]++;
    }
  }
  let iceTime: Float32Array | null = null;
  if (ice.length) {
    iceTime = new Float32Array(total).fill(Infinity);
    for (const s of ice) {
      const f = buildReturnField(grid, grid.nearestPassable(s.x, s.y), p);
      for (let i = 0; i < total; i++) if (f.time[i] < iceTime[i]) iceTime[i] = f.time[i];
    }
  }

  const factorsAt = (i: number): HabFactors => {
    const slopeDeg = footSlope[i];
    const blocked = grid.risk[i] === BLOCKED;
    const flat = blocked ? 0 : clamp01((10 - slopeDeg) / 7) * clamp01(1 - 4 * footSteep[i]) * (1 - 0.35 * meanSand[i]);
    const shieldPct = (1 - shield[i]) * 100;
    const shelter = clamp01(shieldPct / 10);
    const radio = stops.length ? seen[i] / stops.length : 1;
    const allReached = reach[i] === stops.length;
    const meanWalkS = stops.length && reach[i] ? walkSum[i] / reach[i] : 0;
    const walk = !allReached ? 0 : stops.length ? clamp01(1 - (meanWalkS - 300) / 2100) : 1;
    const iceWalkS = iceTime ? iceTime[i] : null;
    const iceScore = iceWalkS === null ? null : Number.isFinite(iceWalkS) ? clamp01(1 - iceWalkS / 1800) : 0;
    const W = HAB_WEIGHTS;
    const wsum = W.shelter + W.radio + W.walk + (iceScore === null ? 0 : W.ice);
    const mean = (W.shelter * shelter + W.radio * radio + W.walk * walk + (iceScore === null ? 0 : W.ice * iceScore)) / wsum;
    const score = allReached ? flat * mean : 0;
    return { flat, shelter, radio, walk, ice: iceScore, score, slopeDeg: Math.round(slopeDeg * 10) / 10, shieldPct, stopsInSight: seen[i], meanWalkS, iceWalkS };
  };

  const score = new Uint8Array(total);
  let bestI = 0, bestS = -1;
  for (let i = 0; i < total; i++) {
    const s = factorsAt(i).score;
    score[i] = Math.round(s * 255);
    // keep away from the edge of the mapped area: the ground beyond it is unknown
    const r = Math.floor(i / n), c = i - r * n;
    const inner = r > 2 && c > 2 && r < n - 3 && c < n - 3;
    if (inner && s > bestS) {
      bestS = s;
      bestI = i;
    }
  }
  return {
    n,
    cell: grid.cell,
    score,
    best: grid.xyOf(bestI),
    bestFactors: factorsAt(bestI),
    stops: stops.length,
    hasIce: ice.length > 0,
    ms: performance.now() - t0,
    at: (x, y) => factorsAt(grid.nodeAt(x, y)),
  };
}
