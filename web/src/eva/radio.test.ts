import { describe, expect, it } from "vitest";
import { measurePath, TerrainGrid } from "../data/grid";
import { DEFAULT_PARAMS } from "./params";
import { bestRelay, lineOfSight, radioCoverage, radioDepthAt, radioShadow } from "./radio";

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

describe("relay", () => {
  // a 10 m wall at x = 120 m between the rover (x = 60 m) and the far side
  const g = grid(101, (c) => (c === 60 ? 10 : 0));
  const rover = { x: 60, y: 100 };

  it("checks line of sight between two antennas", () => {
    expect(lineOfSight(g, { x: 20, y: 100 }, 3, { x: 100, y: 100 }, 1.8)).toBe(true);
    expect(lineOfSight(g, { x: 60, y: 100 }, 3, { x: 180, y: 100 }, 1.8)).toBe(false);
    expect(lineOfSight(g, { x: 120, y: 100 }, 2.5, { x: 180, y: 100 }, 1.8)).toBe(true); // from the top of the wall
  });

  it("puts the relay where it covers the blackout, and only counts it once it is up", () => {
    const s = radioShadow(g, rover);
    // out over the wall and back along the far side
    const out = measurePath(g, [rover, { x: 190, y: 100 }], DEFAULT_PARAMS);
    const along = measurePath(g, [{ x: 190, y: 100 }, { x: 190, y: 30 }], DEFAULT_PARAMS);
    const r = bestRelay(s, g, [out, along]);
    expect(r).not.toBeNull();
    expect(r!.before.coveredFraction).toBeLessThan(0.7);
    expect(r!.after.coveredFraction).toBeGreaterThan(0.95);
    expect(r!.at.x).toBeGreaterThan(100);
    expect(r!.at.x).toBeLessThan(140); // on or near the wall top, the only spot that sees both sides
  });

  it("counts the time spent at a stop with no contact", () => {
    const s = radioShadow(g, rover);
    // a short hop over the wall to a stop right behind it, 30 min of work there, and back
    const out = measurePath(g, [rover, { x: 150, y: 100 }], DEFAULT_PARAMS);
    const back = measurePath(g, [{ x: 150, y: 100 }, rover], DEFAULT_PARAMS);
    const r = bestRelay(s, g, [out, back], undefined, [{ x: 150, y: 100, seconds: 1800, afterLeg: 0 }]);
    expect(r).not.toBeNull();
    expect(lineOfSight(g, r!.at, 2.5, { x: 150, y: 100 }, 1.8)).toBe(true);
  });

  it("suggests nothing when the whole walk is in contact", () => {
    const s = radioShadow(g, rover);
    const near = measurePath(g, [{ x: 60, y: 30 }, { x: 60, y: 170 }], DEFAULT_PARAMS);
    expect(bestRelay(s, g, [near])).toBeNull();
  });
});
