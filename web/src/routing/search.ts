import { BLOCKED, TerrainGrid } from "../data/grid";
import { MAX_GRADE, minEnergyPerMetre, minettiCost, walkSpeedMs } from "../eva/metabolic";
import type { EvaParams } from "../eva/params";
import { MinHeap } from "./heap";

const DC = [1, 1, 0, -1, -1, -1, 0, 1];
const DR = [0, 1, 1, 1, 0, -1, -1, -1];

/** Walking energy (J) and risk-weighted cost of the single grid move `from` → `to`. */
export function edge(grid: TerrainGrid, from: number, to: number, run: number, k: number): { energy: number; cost: number } {
  const grade = (grid.height[to] - grid.height[from]) / run;
  const effort = (grid.effort[from] + grid.effort[to]) / (2 * grid.effortScale);
  const risk = (grid.risk[from] + grid.risk[to]) / (2 * grid.riskScale);
  const energy = minettiCost(grade) * k * run * effort;
  return { energy, cost: energy * risk };
}

/**
 * A* over the 8-connected terrain grid, minimising risk-weighted walking energy.
 * Returns the node path from `start` to `goal`, or null if the goal cannot be reached.
 */
export function astar(grid: TerrainGrid, start: number, goal: number, p: EvaParams): Int32Array | null {
  const n = grid.n;
  const total = n * n;
  if (grid.risk[start] === BLOCKED || grid.risk[goal] === BLOCKED) return null;
  const k = p.massKg * p.gravityFactor * p.suitFactor;
  const hScale = minEnergyPerMetre(p) * grid.cell; // admissible: cheapest possible energy per cell of distance
  const g = new Float64Array(total).fill(Infinity);
  const parent = new Int32Array(total).fill(-1);
  const closed = new Uint8Array(total);
  const heap = new MinHeap(1 << 15);
  const gr = Math.floor(goal / n);
  const gc = goal - gr * n;
  const SQ2 = Math.SQRT2;
  const heuristic = (node: number) => {
    const r = Math.floor(node / n);
    const dc = Math.abs(node - r * n - gc);
    const dr = Math.abs(r - gr);
    return (Math.max(dc, dr) + (SQ2 - 1) * Math.min(dc, dr)) * hScale; // octile distance
  };

  g[start] = 0;
  heap.push(heuristic(start), start);
  while (heap.size > 0) {
    const u = heap.pop();
    if (closed[u]) continue;
    if (u === goal) break;
    closed[u] = 1;
    const ur = Math.floor(u / n);
    const uc = u - ur * n;
    for (let d = 0; d < 8; d++) {
      const c = uc + DC[d];
      const r = ur + DR[d];
      if (c < 0 || r < 0 || c >= n || r >= n) continue;
      const v = r * n + c;
      if (closed[v] || grid.risk[v] === BLOCKED) continue;
      const diagonal = (d & 1) === 1;
      // no corner cutting past impassable nodes
      if (diagonal && (grid.risk[ur * n + c] === BLOCKED || grid.risk[r * n + uc] === BLOCKED)) continue;
      const run = diagonal ? grid.cell * SQ2 : grid.cell;
      const cand = g[u] + edge(grid, u, v, run, k).cost;
      if (cand < g[v]) {
        g[v] = cand;
        parent[v] = u;
        heap.push(cand + heuristic(v), v);
      }
    }
  }
  if (parent[goal] < 0 && goal !== start) return null;
  const rev: number[] = [];
  for (let v = goal; v !== -1; v = parent[v]) rev.push(v);
  return Int32Array.from(rev.reverse());
}

export interface ReturnField {
  cost: Float32Array; // risk-weighted energy to reach the shelter (Infinity if unreachable)
  energy: Float32Array; // J of walking energy along that route
  time: Float32Array; // s of walking time along that route
  next: Int32Array; // next node toward the shelter, -1 at the shelter / unreachable
}

/**
 * Dijkstra from the shelter over the whole grid, with edges taken in the walking direction
 * (node → shelter).  Afterwards the best way home from ANY node is a table lookup, which is
 * what makes the emergency re-route instant.
 */
export function buildReturnField(grid: TerrainGrid, shelter: number, p: EvaParams): ReturnField {
  const n = grid.n;
  const total = n * n;
  const k = p.massKg * p.gravityFactor * p.suitFactor;
  const cost = new Float32Array(total).fill(Infinity);
  const energy = new Float32Array(total).fill(Infinity);
  const time = new Float32Array(total).fill(Infinity);
  const next = new Int32Array(total).fill(-1);
  const best = new Float64Array(total).fill(Infinity);
  const done = new Uint8Array(total);
  const heap = new MinHeap(1 << 18);
  const SQ2 = Math.SQRT2;

  best[shelter] = 0;
  cost[shelter] = 0;
  energy[shelter] = 0;
  time[shelter] = 0;
  heap.push(0, shelter);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    const ur = Math.floor(u / n);
    const uc = u - ur * n;
    for (let d = 0; d < 8; d++) {
      const c = uc + DC[d];
      const r = ur + DR[d];
      if (c < 0 || r < 0 || c >= n || r >= n) continue;
      const v = r * n + c;
      if (done[v] || grid.risk[v] === BLOCKED) continue;
      const diagonal = (d & 1) === 1;
      if (diagonal && (grid.risk[ur * n + c] === BLOCKED || grid.risk[r * n + uc] === BLOCKED)) continue;
      const run = diagonal ? grid.cell * SQ2 : grid.cell;
      const e = edge(grid, v, u, run, k); // walking v → u, toward the shelter
      const cand = best[u] + e.cost;
      if (cand < best[v]) {
        best[v] = cand;
        cost[v] = cand;
        energy[v] = energy[u] + e.energy;
        const grade = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, (grid.height[u] - grid.height[v]) / run));
        const effort = (grid.effort[u] + grid.effort[v]) / (2 * grid.effortScale);
        time[v] = time[u] + run / walkSpeedMs(grade, effort, p);
        next[v] = u;
        heap.push(cand, v);
      }
    }
  }
  return { cost, energy, time, next };
}

/** Follow the return field from `from` to the shelter. */
export function pathToShelter(field: ReturnField, from: number): Int32Array | null {
  if (!Number.isFinite(field.cost[from])) return null;
  const out: number[] = [];
  for (let v = from; v !== -1; v = field.next[v]) out.push(v);
  return Int32Array.from(out);
}
