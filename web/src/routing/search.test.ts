import { describe, expect, it } from "vitest";
import { BLOCKED, measurePath, segmentCost, TerrainGrid } from "../data/grid";
import { DEFAULT_PARAMS } from "../eva/params";
import { MinHeap } from "./heap";
import { astar, buildReturnField, pathToShelter } from "./search";
import { smoothPath } from "./smooth";

/** Small synthetic grid: flat ground, optional wall / hill / sand. */
function makeGrid(n: number, edit?: (g: { h: Float32Array; effort: Uint8Array; risk: Uint8Array; sand: Uint8Array; n: number }) => void) {
  const h = new Float32Array(n * n);
  const effort = new Uint8Array(n * n).fill(50);
  const risk = new Uint8Array(n * n).fill(50);
  const slope = new Uint8Array(n * n);
  const sand = new Uint8Array(n * n);
  edit?.({ h, effort, risk, sand, n });
  return new TerrainGrid(n, 2, h, effort, risk, slope, sand);
}

describe("MinHeap", () => {
  it("pops keys in ascending order", () => {
    const heap = new MinHeap(4);
    const keys = Array.from({ length: 500 }, (_, i) => (i * 7919) % 1009);
    keys.forEach((k, i) => heap.push(k, i));
    const out: number[] = [];
    while (heap.size) out.push(keys[heap.pop()]);
    expect(out).toEqual([...keys].sort((a, b) => a - b));
  });
});

describe("astar", () => {
  it("walks straight across flat ground", () => {
    const g = makeGrid(21);
    const path = astar(g, g.index(0, 10), g.index(20, 10), DEFAULT_PARAMS)!;
    expect(path.length).toBe(21);
    expect(path[0]).toBe(g.index(0, 10));
    expect(path[path.length - 1]).toBe(g.index(20, 10));
  });

  it("goes around a wall and never steps on impassable nodes", () => {
    const g = makeGrid(31, ({ risk, n }) => {
      for (let r = 0; r < 25; r++) risk[r * n + 15] = BLOCKED; // wall with a gap at the bottom
    });
    const path = astar(g, g.index(2, 5), g.index(28, 5), DEFAULT_PARAMS)!;
    expect(path).not.toBeNull();
    for (const node of path) expect(g.isBlocked(node)).toBe(false);
    expect(Math.max(...Array.from(path, (p) => Math.floor(p / 31)))).toBeGreaterThanOrEqual(25);
  });

  it("returns null when the goal is walled off", () => {
    const g = makeGrid(21, ({ risk, n }) => {
      for (let r = 0; r < n; r++) risk[r * n + 10] = BLOCKED;
    });
    expect(astar(g, g.index(2, 10), g.index(18, 10), DEFAULT_PARAMS)).toBeNull();
  });

  it("prefers firm ground over a sand patch", () => {
    const g = makeGrid(41, ({ effort, n }) => {
      for (let r = 10; r <= 30; r++) for (let c = 15; c <= 25; c++) effort[r * n + c] = 105; // ×2.1 energy
    });
    const path = astar(g, g.index(0, 20), g.index(40, 20), DEFAULT_PARAMS)!;
    const onSand = Array.from(path).filter((p) => g.effort[p] > 50).length;
    expect(onSand).toBe(0);
  });

  it("finds the optimal cost (matches Dijkstra from the goal)", () => {
    const g = makeGrid(41, ({ h, effort, n }) => {
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++) {
          h[r * n + c] = 6 * Math.sin(c / 5) * Math.cos(r / 7);
          effort[r * n + c] = 50 + ((r * 13 + c * 7) % 40);
        }
    });
    const start = g.index(3, 4);
    const goal = g.index(36, 33);
    const field = buildReturnField(g, goal, DEFAULT_PARAMS);
    const path = astar(g, start, goal, DEFAULT_PARAMS)!;
    const k = DEFAULT_PARAMS.massKg * DEFAULT_PARAMS.gravityFactor * DEFAULT_PARAMS.suitFactor;
    let cost = 0;
    for (let i = 1; i < path.length; i++) {
      const a = g.xyOf(path[i - 1]);
      const b = g.xyOf(path[i]);
      const run = Math.hypot(a.x - b.x, a.y - b.y);
      const grade = (g.height[path[i]] - g.height[path[i - 1]]) / run;
      const i5 = ((((280.5 * grade - 58.7) * grade - 76.8) * grade + 51.9) * grade + 19.6) * grade + 2.5;
      cost += i5 * k * run * ((g.effort[path[i - 1]] + g.effort[path[i]]) / 100);
    }
    expect(cost).toBeCloseTo(field.cost[start], -1);
    expect(Math.abs(cost - field.cost[start]) / cost).toBeLessThan(1e-4);
  });
});

describe("return field", () => {
  it("is zero at the shelter and leads every node home", () => {
    const g = makeGrid(25, ({ risk, n }) => {
      for (let r = 5; r < 20; r++) risk[r * n + 12] = BLOCKED;
    });
    const shelter = g.index(20, 12);
    const field = buildReturnField(g, shelter, DEFAULT_PARAMS);
    expect(field.cost[shelter]).toBe(0);
    const path = pathToShelter(field, g.index(2, 12))!;
    expect(path[path.length - 1]).toBe(shelter);
    for (const node of path) expect(g.isBlocked(node)).toBe(false);
    expect(field.time[g.index(2, 12)]).toBeGreaterThan(field.time[g.index(15, 12)]);
  });

  it("marks enclosed nodes unreachable", () => {
    const g = makeGrid(21, ({ risk, n }) => {
      for (let r = 0; r < n; r++) risk[r * n + 10] = BLOCKED;
    });
    const field = buildReturnField(g, g.index(2, 2), DEFAULT_PARAMS);
    expect(Number.isFinite(field.cost[g.index(18, 2)])).toBe(false);
    expect(pathToShelter(field, g.index(18, 2))).toBeNull();
  });
});

describe("smoothPath", () => {
  it("straightens a diagonal staircase without raising the cost", () => {
    const g = makeGrid(41);
    const nodes = astar(g, g.index(0, 0), g.index(40, 17), DEFAULT_PARAMS)!;
    const smooth = smoothPath(g, nodes, DEFAULT_PARAMS);
    const raw = measurePath(g, Array.from(nodes, (n) => g.xyOf(n)), DEFAULT_PARAMS);
    const cooked = measurePath(g, smooth, DEFAULT_PARAMS);
    expect(smooth.length).toBeLessThan(nodes.length / 3);
    expect(cooked.distance).toBeLessThanOrEqual(raw.distance + 1e-6);
    expect(cooked.distance).toBeCloseTo(Math.hypot(80, 34), 0);
  });

  it("never shortcuts across impassable ground", () => {
    const g = makeGrid(31, ({ risk, n }) => {
      for (let r = 0; r < 25; r++) risk[r * n + 15] = BLOCKED;
    });
    const nodes = astar(g, g.index(2, 5), g.index(28, 5), DEFAULT_PARAMS)!;
    const smooth = smoothPath(g, nodes, DEFAULT_PARAMS);
    for (let i = 1; i < smooth.length; i++) expect(Number.isFinite(segmentCost(g, smooth[i - 1], smooth[i], DEFAULT_PARAMS))).toBe(true);
    expect(measurePath(g, smooth, DEFAULT_PARAMS).blockedM).toBe(0);
  });
});
