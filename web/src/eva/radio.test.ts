import { describe, expect, it } from "vitest";
import { measurePath, TerrainGrid } from "../data/grid";
import { DEFAULT_PARAMS } from "./params";
import { radioCoverage, radioDepthAt, radioShadow } from "./radio";

function grid(n: number, height: (col: number, row: number) => number): TerrainGrid {
  const h = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) h[r * n + c] = height(c, r);
  const fill = (v: number) => new Uint8Array(n * n).fill(v);
  return new TerrainGrid(n, 2, h, fill(50), fill(50), fill(0), fill(0));
}

describe("radioShadow", () => {
  it("sees everything on flat ground", () => {
    const g = grid(101, () => 0);
    const s = radioShadow(g, { x: 100, y: 100 });
    expect(Math.max(...s)).toBe(0);
  });

  it("puts the ground behind a ridge in shadow, and not the ground in front", () => {
    // a 10 m wall running north-south at x = 120 m; antenna at x = 60 m
    const g = grid(101, (c) => (c === 60 ? 10 : 0));
    const s = radioShadow(g, { x: 60, y: 100 });
    expect(radioDepthAt(s, g, 100, 100)).toBe(0); // in front of the wall
    expect(radioDepthAt(s, g, 140, 100)).toBeGreaterThan(5); // right behind it
    // the sight line over the wall keeps climbing, so the shadow deepens with distance
    expect(radioDepthAt(s, g, 190, 100)).toBeGreaterThan(radioDepthAt(s, g, 140, 100));
  });

  it("measures how much of a walk stays in contact", () => {
    const g = grid(101, (c) => (c === 60 ? 10 : 0));
    const s = radioShadow(g, { x: 60, y: 100 });
    const walk = measurePath(g, [{ x: 60, y: 30 }, { x: 60, y: 170 }], DEFAULT_PARAMS); // along the near side
    expect(radioCoverage(s, g, [walk]).coveredFraction).toBe(1);
    const behind = measurePath(g, [{ x: 150, y: 30 }, { x: 150, y: 170 }], DEFAULT_PARAMS);
    const cov = radioCoverage(s, g, [behind]);
    expect(cov.coveredFraction).toBeLessThan(0.2);
    expect(cov.gaps).toBe(1);
  });
});
