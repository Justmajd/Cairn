import { describe, expect, it } from "vitest";
import { fmtLightTime, marsSky, utcAtLmst } from "./sky";
import { lmstAt, solarGeometry, sunAt } from "./sun";

const sep = (a: number[], b: number[]) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;

describe("Mars sky", () => {
  it("puts the Sun where Mars24 does (independent method)", () => {
    for (const [utc, lat, lon] of [["2024-07-21T02:10:26Z", 18.49, 77.31], ["2025-07-20T19:43:56Z", -4.8, 137.38], ["2035-01-01T12:00:00Z", 42.16, 18.48]] as const) {
      const t = Date.parse(utc);
      const s = marsSky(t, lat, lon);
      const m = sunAt(lat, lmstAt(t, lon), solarGeometry(t));
      expect(Math.abs(s.sun.elevation - m.elevation)).toBeLessThan(0.5);
      expect(Math.abs(s.sun.azimuth - m.azimuth)).toBeLessThan(0.5);
    }
  });

  it("sees Phobos cross the Sun at Jezero on 2 April 2022, as Perseverance filmed", () => {
    let best = 99;
    const t0 = Date.parse("2022-04-02T00:00:00Z");
    for (let t = t0; t < t0 + 86400000; t += 10000) {
      const s = marsSky(t, 18.44, 77.45);
      if (s.sun.elevation > 0) best = Math.min(best, sep(s.sun.dir, s.phobos.dir));
    }
    expect(best).toBeLessThan(0.5);
  });

  it("gives Phobos and Deimos their apparent sizes and the light time to Earth", () => {
    const s = marsSky(Date.parse("2024-07-21T02:10:26Z"), 18.49, 77.31);
    expect(s.sun.sizeDeg).toBeGreaterThan(0.3);
    expect(s.sun.sizeDeg).toBeLessThan(0.4);
    if (s.phobos.elevation > 10) expect(s.phobos.sizeDeg).toBeGreaterThan(0.15);
    // light time ranges from ~3 min (opposition) to ~22 min (conjunction)
    for (let k = 0; k < 30; k++) {
      const lt = marsSky(Date.parse("2024-01-01T00:00:00Z") + k * 30 * 86400000, 0, 0).lightTimeS;
      expect(lt).toBeGreaterThan(180);
      expect(lt).toBeLessThan(1360);
    }
  });

  it("finds the UTC moment of a local time on the same sol", () => {
    const t = Date.parse("2024-07-21T02:10:26Z");
    const u = utcAtLmst(t, lmstAt(t, 77.31), 10);
    expect(lmstAt(u, 77.31)).toBeCloseTo(10, 3);
    expect(Math.abs(u - t)).toBeLessThan(13 * 3700 * 1000);
    expect(fmtLightTime(823)).toBe("13 min 43 s");
  });
});
