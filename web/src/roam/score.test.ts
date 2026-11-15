import { describe, expect, it } from "vitest";
import { distanceToLegs, gapToBox, scoreWalk, workO2 } from "./score";
import { DEFAULT_PARAMS } from "../eva/params";

const plan = { o2L: 100, timeS: 3600 };
const good = { outOfO2: false, o2UsedL: 105, timeS: 3900, falls: 0, offRoute: 0.05, storm: null };

describe("mission scoring", () => {
  it("gives a star per check met", () => {
    expect(scoreWalk(good, plan).stars).toBe(3);
    expect(scoreWalk({ ...good, o2UsedL: 120 }, plan).stars).toBe(2); // > 10 % over
    expect(scoreWalk({ ...good, timeS: 4200 }, plan).stars).toBe(2); // > 15 % over
    expect(scoreWalk({ ...good, falls: 1 }, plan).stars).toBe(2);
    expect(scoreWalk({ ...good, offRoute: 0.2 }, plan).stars).toBe(2);
  });

  it("gives nothing when the suit ran out of oxygen", () => {
    expect(scoreWalk({ ...good, outOfO2: true }, plan).stars).toBe(0);
  });

  it("adds the shelter check when the storm alarm sounded", () => {
    const inTime = scoreWalk({ ...good, storm: { alertS: 1000, shelteredS: 2700, shelterMin: 30, doseUGy: 40 } }, plan);
    expect(inTime.checks).toHaveLength(4);
    expect(inTime.stars).toBe(4);
    const late = scoreWalk({ ...good, storm: { alertS: 1000, shelteredS: 3000, shelterMin: 30, doseUGy: 40 } }, plan);
    expect(late.stars).toBe(3);
    const never = scoreWalk({ ...good, storm: { alertS: 1000, shelteredS: null, shelterMin: 30, doseUGy: 40 } }, plan);
    expect(never.checks[3].ok).toBe(false);
  });

  it("charges a stop's work at the planner's working rate", () => {
    // 30 min at 220 W with 20.1 kJ per litre: 19.7 L
    expect(workO2(1800, DEFAULT_PARAMS.workingW, DEFAULT_PARAMS.kJPerLitreO2)).toBeCloseTo(19.7, 1);
  });

  it("measures the gap to the rover's hull and the distance off the route", () => {
    expect(gapToBox(0, 0, 0, 0, 3, 1.5)).toBe(0);
    expect(gapToBox(5, 0, 0, 0, 3, 1.5)).toBe(2);
    expect(gapToBox(6, 5.5, 0, 0, 3, 1.5)).toBe(5);
    const legs = [[{ x: 0, y: 0 }, { x: 100, y: 0 }]];
    expect(distanceToLegs(50, 12, legs)).toBe(12);
    expect(distanceToLegs(-3, 4, legs)).toBe(5);
  });
});
