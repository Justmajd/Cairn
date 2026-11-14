import { describe, expect, it } from "vitest";
import { dustEffect, DUST_PRESETS } from "./dust";

describe("dust storm model", () => {
  it("leaves a clear day as it is", () => {
    const e = dustEffect(0.4, 40);
    expect(e.direct).toBe(1);
    expect(e.sunlight).toBeCloseTo(1, 5);
    expect(e.visibilityM).toBeGreaterThan(50_000);
  });

  it("dims the light and shortens the view as the dust thickens", () => {
    let last = dustEffect(0.4, 40);
    for (const p of DUST_PRESETS.slice(1)) {
      const e = dustEffect(p.tau, 40);
      expect(e.sunlight).toBeLessThan(last.sunlight);
      expect(e.visibilityM).toBeLessThan(last.visibilityM);
      last = e;
    }
    // Curiosity's global storm (τ 8): almost no direct sun, a few km of visibility
    const g = dustEffect(8, 40);
    expect(g.direct).toBeLessThan(1e-4);
    expect(g.visibilityM).toBeGreaterThan(4000);
    expect(g.visibilityM).toBeLessThan(7000);
  });

  it("hits a low Sun hardest (a longer path through the dust)", () => {
    expect(dustEffect(1.4, 10).direct).toBeLessThan(dustEffect(1.4, 60).direct);
  });
});
