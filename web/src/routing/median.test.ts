import { describe, expect, it } from "vitest";
import { geometricMedian } from "./median";

describe("geometricMedian", () => {
  it("is the point itself for one point and the midpoint region for two", () => {
    expect(geometricMedian([{ x: 3, y: 4 }])).toEqual({ x: 3, y: 4 });
    const m = geometricMedian([{ x: 0, y: 0 }, { x: 10, y: 0 }])!;
    expect(m.y).toBeCloseTo(0);
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.x).toBeLessThanOrEqual(10);
  });

  it("is not pulled away by a far outlier the way the mean is", () => {
    const pts = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 100, y: 0 }];
    const m = geometricMedian(pts)!;
    expect(m.x).toBeLessThan(5); // the mean would be at x = 25.75
  });

  it("returns null with no points", () => {
    expect(geometricMedian([])).toBeNull();
  });
});
