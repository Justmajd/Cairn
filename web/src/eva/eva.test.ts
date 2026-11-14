import { describe, expect, it } from "vitest";
import { measurePath, TerrainGrid } from "../data/grid";
import type { Poi, ReplayData } from "../types";
import { buildBudget, o2Litres, sampleAtTime, Segment } from "./budget";
import { MIN_MINETTI, minettiCost, walkEnergyJ, walkSpeedMs } from "./metabolic";
import { DEFAULT_PARAMS as P } from "./params";
import { RadiationModel } from "./radiation";

function flatGrid(n = 51, tilt = 0) {
  const h = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) h[r * n + c] = c * 2 * tilt; // rises to the east
  return new TerrainGrid(n, 2, h, new Uint8Array(n * n).fill(50), new Uint8Array(n * n).fill(50), new Uint8Array(n * n), new Uint8Array(n * n));
}

describe("Minetti metabolic cost", () => {
  it("is 2.5 J/kg/m on level ground", () => expect(minettiCost(0)).toBeCloseTo(2.5, 10));
  it("costs more uphill than downhill", () => {
    expect(minettiCost(0.2)).toBeGreaterThan(minettiCost(0));
    expect(minettiCost(0.2)).toBeGreaterThan(minettiCost(-0.2));
  });
  it("has its minimum on a gentle downhill", () => {
    expect(MIN_MINETTI).toBeLessThan(minettiCost(0));
    expect(MIN_MINETTI).toBeGreaterThan(0.8);
    expect(minettiCost(-0.15)).toBeCloseTo(MIN_MINETTI, 1);
  });
  it("clamps beyond ±0.45", () => expect(minettiCost(2)).toBe(minettiCost(0.45)));
});

describe("walking energy, speed and oxygen", () => {
  it("matches a hand calculation for 1 km of level ground", () => {
    const j = walkEnergyJ(0, 1000, P); // 2.5 × 180 kg × 1000 m × 0.6 × 1.8
    expect(j).toBeCloseTo(486_000, 0);
    const timeS = 1000 / walkSpeedMs(0, 1, P);
    expect(timeS).toBeCloseTo(1000 / ((6 * Math.exp(-0.175) * 0.6) / 3.6), 6);
    expect(o2Litres(j, timeS, P.restingW, P)).toBeCloseTo((486_000 + 100 * timeS) / 20_100, 6);
  });
  it("is slower on sand", () => expect(walkSpeedMs(0, 2.1, P)).toBeLessThan(walkSpeedMs(0, 1, P)));
});

describe("measurePath", () => {
  it("measures a level path", () => {
    const g = flatGrid();
    const m = measurePath(g, [{ x: 0, y: 50 }, { x: 100, y: 50 }], P);
    expect(m.distance).toBeCloseTo(100, 6);
    expect(m.energy).toBeCloseTo(walkEnergyJ(0, 100, P), 3);
    expect(m.climb).toBe(0);
    expect(m.samples[m.samples.length - 1].time).toBeCloseTo(m.time, 9);
  });
  it("charges more to climb than to descend the same slope", () => {
    const g = flatGrid(51, 0.15);
    const up = measurePath(g, [{ x: 0, y: 50 }, { x: 100, y: 50 }], P);
    const down = measurePath(g, [{ x: 100, y: 50 }, { x: 0, y: 50 }], P);
    expect(up.climb).toBeCloseTo(15, 3);
    expect(down.descent).toBeCloseTo(15, 3);
    expect(up.energy).toBeGreaterThan(down.energy * 2);
    expect(up.distance).toBeCloseTo(Math.hypot(100, 15), 3);
  });
});

const poi = (id: string, x: number, y: number): Poi => ({
  id, kind: "objective", name: id, short: id, x, y, rmc: "", sols: "", description: "", science: "", whyHumans: "", dwellMin: 30, images: [],
});

describe("EVA budget", () => {
  const g = flatGrid();
  const out = measurePath(g, [{ x: 0, y: 50 }, { x: 100, y: 50 }], P);
  const back = measurePath(g, [{ x: 100, y: 50 }, { x: 0, y: 50 }], P);
  const lookup = (x: number) => ({ timeS: x / walkSpeedMs(0, 1, P), energyJ: walkEnergyJ(0, x, P) });
  const segments: Segment[] = [
    { kind: "walk", path: out, to: poi("a", 100, 50), label: "out" },
    { kind: "dwell", poi: poi("a", 100, 50), durationS: 1800, sheltered: false },
    { kind: "walk", path: back, to: null, label: "back" },
  ];
  const b = buildBudget(segments, P, lookup);

  it("adds up distance, time and oxygen", () => {
    expect(b.distanceM).toBeCloseTo(200, 6);
    expect(b.totalTimeS).toBeCloseTo(out.time + back.time + 1800, 6);
    const expected = (out.energy + back.energy + P.restingW * (out.time + back.time) + P.workingW * 1800) / 20_100;
    expect(b.o2UsedL).toBeCloseTo(expected, 6);
    expect(b.feasible).toBe(true);
  });
  it("finds the tightest walk-back margin at the far end of the stop", () => {
    const usedAtStopEnd = (out.energy + P.restingW * out.time + P.workingW * 1800) / 20_100;
    const home = (walkEnergyJ(0, 100, P) + P.restingW * (100 / walkSpeedMs(0, 1, P))) / 20_100;
    expect(b.walkBack.minMarginL).toBeCloseTo(b.o2UsableL - usedAtStopEnd - home, 6);
    expect(b.walkBack.atTimeS).toBeCloseTo(out.time + 1800, 6);
  });
  it("flags a plan that exhausts the oxygen", () => {
    const tiny = { ...P, o2SupplyL: 5 };
    expect(buildBudget(segments, tiny, lookup).feasible).toBe(false);
  });
  it("interpolates position along a path by time", () => {
    const mid = sampleAtTime(out, out.time / 2);
    expect(mid.x).toBeCloseTo(50, 1);
    expect(mid.headingRad).toBeCloseTo(Math.PI / 2, 6); // walking east
  });
});

describe("radiation model", () => {
  const replay = {
    rad: { baselineUGyH: 6, source: "", measured: [] },
    model: { slowTauH: 10, curve: [[0, 0], [1, 600], [2, 300], [4, 100]] },
  } as unknown as ReplayData;
  const rad = new RadiationModel(replay);

  it("gives only background without a storm", () => {
    expect(rad.rateAt(1000, null)).toBe(6);
    expect(rad.dose(0, 3600, null)).toBeCloseTo(6, 9);
  });
  it("interpolates the storm curve and decays past its end", () => {
    expect(rad.excessAt(-1)).toBe(0);
    expect(rad.excessAt(0.5)).toBeCloseTo(300, 9);
    expect(rad.excessAt(1.5)).toBeCloseTo(450, 9);
    expect(rad.excessAt(14)).toBeCloseTo(100 * Math.exp(-1), 9);
  });
  it("integrates dose and applies shelter shielding", () => {
    const open = rad.dose(0, 3600, 0); // background 6 + triangle 0→600 over 1 h = 306
    expect(open).toBeCloseTo(306, 0);
    const sheltered = rad.dose(0, 3600, 0, () => 0.5);
    expect(sheltered).toBeCloseTo(open / 2, 6);
  });
});
