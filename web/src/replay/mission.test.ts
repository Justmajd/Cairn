import { describe, expect, it } from "vitest";
import { measurePath, TerrainGrid } from "../data/grid";
import { buildBudget, Segment } from "../eva/budget";
import { walkEnergyJ, walkSpeedMs } from "../eva/metabolic";
import { DEFAULT_PARAMS as P } from "../eva/params";
import { RadiationModel } from "../eva/radiation";
import type { Poi, ReplayData } from "../types";
import { Mission, MissionEvent } from "./mission";

const n = 201;
const grid = new TerrainGrid(n, 2, new Float32Array(n * n), new Uint8Array(n * n).fill(50), new Uint8Array(n * n).fill(50), new Uint8Array(n * n), new Uint8Array(n * n));
const poi = (id: string, x: number, kind: Poi["kind"] = "objective"): Poi => ({
  id, kind, name: id, short: id, x, y: 200, rmc: "", sols: "", description: "", science: "", whyHumans: "", dwellMin: 20, images: [],
});
const rover = poi("rover", 0, "shelter");
const a = poi("a", 300);
const b = poi("b", 380);
const lookup = (x: number) => ({ timeS: x / walkSpeedMs(0, 1, P), energyJ: walkEnergyJ(0, x, P) });
const leg = (from: Poi, to: Poi) => measurePath(grid, [from, to], P);
const plan = (): Segment[] => [
  { kind: "walk", path: leg(rover, a), to: a, label: "" },
  { kind: "dwell", poi: a, durationS: 1200, sheltered: false },
  { kind: "walk", path: leg(a, b), to: b, label: "" },
  { kind: "dwell", poi: b, durationS: 1200, sheltered: false },
  { kind: "walk", path: leg(b, rover), to: rover, label: "" },
];
const rad = new RadiationModel({
  rad: { baselineUGyH: 5, source: "", measured: [] },
  model: { slowTauH: 12, curve: [[0, 0], [0.5, 2000], [3, 400], [10, 60]] },
} as unknown as ReplayData);

function run(m: Mission, stepS: number, onEvent?: (e: MissionEvent) => void): MissionEvent[] {
  const all: MissionEvent[] = [];
  for (let i = 0; i < 100000 && m.phase !== "complete"; i++) {
    for (const e of m.advance(stepS)) {
      all.push(e);
      onEvent?.(e);
    }
  }
  return all;
}

describe("Mission without a storm", () => {
  it("visits every stop in order and matches the planned budget", () => {
    const segs = plan();
    const budget = buildBudget(segs, P, lookup);
    const m = new Mission(segs, rad, P, lookup, null);
    const events = run(m, 7);
    expect(events.filter((e) => e.type === "arrive").map((e) => (e as { poi: Poi }).poi.id)).toEqual(["a", "b", "rover"]);
    expect(events[events.length - 1]).toEqual({ type: "complete", aborted: false });
    expect(m.visited).toEqual(["a", "b"]);
    expect(m.t).toBeCloseTo(budget.totalTimeS, 3);
    expect(m.distanceM).toBeCloseTo(budget.distanceM, 3);
    expect(m.o2UsedL).toBeCloseTo(budget.o2UsedL, 3);
    expect(m.doseUGy).toBeCloseTo((5 * budget.totalTimeS) / 3600, 4); // background only
  });

  it("gives the same result for any time step", () => {
    const coarse = new Mission(plan(), rad, P, lookup, null);
    const fine = new Mission(plan(), rad, P, lookup, null);
    run(coarse, 240);
    run(fine, 0.5);
    expect(coarse.o2UsedL).toBeCloseTo(fine.o2UsedL, 4);
    expect(coarse.doseUGy).toBeCloseTo(fine.doseUGy, 4);
  });
});

describe("Mission with a storm", () => {
  const segs = plan();
  const onset = segs[0].kind === "walk" ? segs[0].path.time + 1200 + 30 : 0; // 30 s into the second walk
  const m = new Mission(segs, rad, P, lookup, onset);
  const events = run(m, 5, (e) => {
    if (e.type === "alert") {
      const p = m.pose();
      m.reroute(measurePath(grid, [{ x: p.x, y: p.y }, rover], P), rover);
    }
  });
  const types = events.map((e) => e.type);

  it("raises the alert right after onset, while walking the second leg", () => {
    expect(types.indexOf("storm-onset")).toBeGreaterThan(types.indexOf("depart"));
    expect(m.alertS! - onset).toBeLessThan(60);
    expect(m.alertS! - onset).toBeGreaterThanOrEqual(0);
  });

  it("walks to the shelter, skips the unfinished stop and ends aborted", () => {
    expect(types).toContain("sheltered");
    expect(events[events.length - 1]).toEqual({ type: "complete", aborted: true });
    expect(m.visited).toEqual(["a"]);
    expect(m.remaining().map((p) => p.id)).toEqual(["b"]);
    expect(m.pose().x).toBeCloseTo(0, 3);
  });

  it("projects the same dose it then actually receives, and sheltering avoids dose", () => {
    const pr = m.projection!;
    expect(m.t).toBeCloseTo(pr.horizonS, 3);
    expect(m.doseUGy).toBeCloseTo(pr.shelterUGy, 0);
    expect(pr.avoidedUGy).toBeGreaterThan(0);
    expect(pr.continueUGy).toBeGreaterThan(pr.shelterUGy);
    expect(pr.horizonS).toBeGreaterThanOrEqual(m.plannedEndS);
  });
});

describe("Practice emergencies", () => {
  it("a suit leak doubles oxygen use on the walk home and ends the EVA in the rover", () => {
    const m = new Mission(plan(), rad, P, lookup, null);
    m.advance(300); // part-way to the first stop
    const p = m.pose();
    const home = measurePath(grid, [{ x: p.x, y: p.y }, rover], P);
    const before = m.o2UsedL;
    const em = m.emergencyHome("leak", home, rover);
    expect(em.needL).toBeCloseTo(2 * (home.energy + P.restingW * home.time) / (P.kJPerLitreO2 * 1000), 6);
    const events = run(m, 5);
    expect(events.some((e) => e.type === "sheltered")).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "complete", aborted: true });
    expect(m.visited).toEqual([]);
    // walk home used twice the normal oxygen (plus two minutes at rest in the rover)
    const restInRover = (P.restingW * 120) / (P.kJPerLitreO2 * 1000);
    expect(m.o2UsedL - before).toBeCloseTo(em.needL + restInRover, 3);
  });

  it("a twisted ankle doubles the time home", () => {
    const m = new Mission(plan(), rad, P, lookup, null);
    m.advance(300);
    const p = m.pose();
    const home = measurePath(grid, [{ x: p.x, y: p.y }, rover], P);
    const em = m.emergencyHome("ankle", home, rover);
    expect(em.homeTimeS).toBeCloseTo(home.time * 2, 6);
    const t0 = m.t;
    run(m, 5, (e) => e.type === "sheltered" && expect(m.t - t0).toBeCloseTo(home.time * 2, 3));
  });
});
