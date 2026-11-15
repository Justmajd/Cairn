import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./params";
import { walkSpeedMs } from "./metabolic";
import { EARTH_G, Ground, impactFrom, jumpOf, MARS_G, MARS_WALKER, newWalker, stepWalker, toppleTime, walkRunMs, WalkEvent } from "./walker";

const flat: Ground = { height: () => 0, sand: () => 0, effort: () => 1, min: -1000, max: 1000 };
const ramp = (deg: number): Ground => ({ ...flat, height: (x) => x * Math.tan((deg * Math.PI) / 180) });
const idle = { x: 0, y: 0, lope: false, jump: false };

function run(s: ReturnType<typeof newWalker>, input: typeof idle, ground: Ground, seconds: number, cfg = MARS_WALKER): WalkEvent[] {
  const ev: WalkEvent[] = [];
  for (let t = 0; t < seconds; t += 1 / 60) ev.push(...stepWalker(s, input, ground, 1 / 60, DEFAULT_PARAMS, cfg));
  return ev;
}

describe("walker", () => {
  it("jumps 2.6 times higher on Mars than on Earth, ballistically", () => {
    expect(jumpOf(1.6, MARS_G).heightM).toBeCloseTo(0.344, 2);
    expect(jumpOf(1.6, MARS_G).heightM / jumpOf(1.6, EARTH_G).heightM).toBeCloseTo(EARTH_G / MARS_G, 5);
    const s = newWalker(0, 0, 0);
    const ev = stepWalker(s, { ...idle, jump: true }, flat, 1 / 60, DEFAULT_PARAMS);
    ev.push(...run(s, idle, flat, 2));
    const land = ev.find((e) => e.kind === "land");
    expect(land && land.kind === "land" && land.heightM).toBeCloseTo(0.344, 1);
    expect(land && land.kind === "land" && land.airS).toBeCloseTo(0.86, 1);
    expect(s.grounded).toBe(true);
  });

  it("walks at the planner's speed and needs time to get going (traction)", () => {
    const s = newWalker(0, 0, 0);
    run(s, { ...idle, y: 1 }, flat, 0.15);
    expect(Math.hypot(s.vx, s.vy)).toBeLessThan(walkSpeedMs(0, 1, DEFAULT_PARAMS));
    run(s, { ...idle, y: 1 }, flat, 4);
    expect(Math.hypot(s.vx, s.vy)).toBeCloseTo(walkSpeedMs(0, 1, DEFAULT_PARAMS), 2);
    expect(s.gait).toBe("walk");
    expect(s.steps).toBeGreaterThan(2);
    expect(s.o2L).toBeGreaterThan(0);
  });

  it("turns a fast walk into a lope above the Froude limit", () => {
    expect(walkRunMs(MARS_G, 0.9)).toBeCloseTo(1.29, 2);
    const s = newWalker(0, 0, 0);
    const ev = run(s, { ...idle, y: 1, lope: true }, flat, 4);
    expect(ev.some((e) => e.kind === "takeoff" && !e.jump)).toBe(true);
    expect(Math.hypot(s.vx, s.vy)).toBeGreaterThan(1.29);
  });

  it("slides on ground steeper than the friction angle and holds below it", () => {
    const steep = newWalker(0, 0, 0);
    const ev = run(steep, idle, ramp(40), 1.5);
    expect(ev.some((e) => e.kind === "slide")).toBe(true);
    expect(steep.x).toBeLessThan(-0.5);
    const gentle = newWalker(0, 0, 0);
    run(gentle, idle, ramp(20), 1.5);
    expect(Math.hypot(gentle.x, gentle.y)).toBeLessThan(0.01);
  });

  it("measures the landing speed of a drop off a ledge", () => {
    const ledge: Ground = { ...flat, height: (x) => (x < 1 ? 2 : 0) };
    const s = newWalker(0, 0, 2);
    s.vx = 1.5;
    s.grounded = true;
    const ev = run(s, { ...idle, x: 1 }, ledge, 3);
    const land = ev.find((e) => e.kind === "land");
    expect(land).toBeDefined();
    if (land && land.kind === "land") expect(land.impactMs).toBeCloseTo(impactFrom(2, MARS_G), 0);
  });

  it("topples more slowly in Mars gravity: time scales with 1/sqrt(g)", () => {
    const mars = toppleTime(MARS_G, 1, 0.12, 1, 0);
    const earth = toppleTime(EARTH_G, 1, 0.12, 1, 0);
    expect(mars / earth).toBeCloseTo(Math.sqrt(EARTH_G / MARS_G), 1);
    expect(mars).toBeGreaterThan(1);
  });

  it("after a fall on a steep slope, slides down to steady ground before getting up", () => {
    // 40° down to x = 6, flat beyond
    const hill: Ground = { ...flat, height: (x) => (x < 6 ? -x * Math.tan((40 * Math.PI) / 180) : -6 * Math.tan((40 * Math.PI) / 180)) };
    const s = newWalker(0, 0, 0);
    s.downT = MARS_WALKER.getUpS;
    s.gait = "down";
    run(s, idle, hill, 1);
    expect(s.downT).toBeCloseTo(MARS_WALKER.getUpS, 5); // still sliding: the get-up has not started
    run(s, idle, hill, 8);
    expect(s.x).toBeGreaterThan(6); // came down onto the flat
    expect(s.downT).toBeLessThan(MARS_WALKER.getUpS);
  });
});

