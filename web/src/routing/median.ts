import type { XY } from "../types";

/**
 * Geometric median of a set of points: the spot with the smallest sum of straight-line distances to
 * them (Weiszfeld's iteration).  CAIRN parks the rover near it to keep every stop close.
 */
export function geometricMedian(points: XY[], iterations = 60): XY | null {
  if (!points.length) return null;
  let x = points.reduce((a, p) => a + p.x, 0) / points.length;
  let y = points.reduce((a, p) => a + p.y, 0) / points.length;
  for (let k = 0; k < iterations; k++) {
    let wx = 0;
    let wy = 0;
    let w = 0;
    for (const p of points) {
      const d = Math.max(1e-6, Math.hypot(p.x - x, p.y - y));
      wx += p.x / d;
      wy += p.y / d;
      w += 1 / d;
    }
    x = wx / w;
    y = wy / w;
  }
  return { x, y };
}
