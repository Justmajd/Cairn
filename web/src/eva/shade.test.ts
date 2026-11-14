import { describe, expect, it } from "vitest";
import { TerrainGrid } from "../data/grid";
import { inTerrainShadow } from "./shade";

function grid(n: number, height: (col: number, row: number) => number): TerrainGrid {
  const h = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) h[r * n + c] = height(c, r);
  const fill = (v: number) => new Uint8Array(n * n).fill(v);
  return new TerrainGrid(n, 2, h, fill(50), fill(50), fill(0), fill(0));
}

describe("inTerrainShadow", () => {
  // a 20 m wall running north-south at x = 120 m
  const g = grid(101, (c) => (c === 60 ? 20 : 0));
  it("is in shade just west of the wall with a low Sun in the east", () => {
    expect(inTerrainShadow(g, 100, 100, 20, 90)).toBe(true);
  });
  it("is lit when the Sun is high or behind the walker", () => {
    expect(inTerrainShadow(g, 100, 100, 70, 90)).toBe(false);
    expect(inTerrainShadow(g, 100, 100, 20, 270)).toBe(false);
  });
  it("is always in shade at night", () => {
    expect(inTerrainShadow(g, 40, 40, -3, 90)).toBe(true);
  });
});
