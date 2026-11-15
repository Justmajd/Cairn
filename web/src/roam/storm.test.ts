import { describe, expect, it } from "vitest";
import { RadiationModel } from "../eva/radiation";
import { RoamStorm } from "./storm";
import type { ReplayData } from "../types";

// a small replay: 30 µGy/h background, the storm rising to 900 µGy/h excess within an hour
const replay = { rad: { baselineUGyH: 30 }, model: { curve: [[0, 0], [0.25, 60], [0.5, 300], [1, 900], [3, 400]], slowTauH: 6 } } as unknown as ReplayData;

describe("free-roam solar storm", () => {
  const rad = new RadiationModel(replay);
  it("raises the alarm when the dose rate passes 3× background, with 30 minutes to get inside", () => {
    const s = new RoamStorm(rad, 1000);
    expect(s.rate(s.alertS)).toBeGreaterThanOrEqual(90);
    expect(s.rate(s.alertS - 20)).toBeLessThan(90);
    expect(s.deadlineS - s.alertS).toBe(1800);
    expect(s.alarmed(s.alertS - 1)).toBe(false);
  });

  it("counts less dose inside the rover, and the dose avoided by sheltering", () => {
    const out = new RoamStorm(rad, 0);
    out.accumulate(0, 3600, false);
    const inside = new RoamStorm(rad, 0);
    inside.accumulate(0, 3600, true);
    expect(inside.doseUGy).toBeCloseTo(out.doseUGy * 0.5, 3);
    inside.board(inside.alertS + 60);
    expect(inside.avoided(inside.alertS + 3600)).toBeGreaterThan(0);
  });
});
