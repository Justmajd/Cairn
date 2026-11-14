import { segmentCost, TerrainGrid } from "../data/grid";
import type { EvaParams } from "../eva/params";
import type { XY } from "../types";
import { edge } from "./search";

/**
 * Turn a zig-zag grid path into a natural polyline ("string pulling").
 * A shortcut between two path nodes is accepted only if walking it straight costs no more
 * (risk-weighted energy, 2 % tolerance) than the grid path it replaces and never touches
 * impassable ground — so smoothing can make the route shorter but never less safe.
 */
export function smoothPath(grid: TerrainGrid, nodes: Int32Array, p: EvaParams, lookahead = 48): XY[] {
  const count = nodes.length;
  const pts: XY[] = new Array(count);
  for (let i = 0; i < count; i++) pts[i] = grid.xyOf(nodes[i]);
  if (count <= 2) return pts;

  const k = p.massKg * p.gravityFactor * p.suitFactor;
  const prefix = new Float64Array(count); // cumulative grid cost along the path
  for (let i = 1; i < count; i++) {
    const run = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    prefix[i] = prefix[i - 1] + edge(grid, nodes[i - 1], nodes[i], run, k).cost;
  }

  const out: XY[] = [pts[0]];
  let i = 0;
  while (i < count - 1) {
    let chosen = i + 1;
    for (let j = Math.min(count - 1, i + lookahead); j > i + 1; j -= j - i > 12 ? 3 : 1) {
      if (segmentCost(grid, pts[i], pts[j], p) <= (prefix[j] - prefix[i]) * 1.02) {
        chosen = j;
        break;
      }
    }
    out.push(pts[chosen]);
    i = chosen;
  }
  return out;
}
