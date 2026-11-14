import { describe, expect, it } from "vitest";
import { fmtLmst, lmstAt, solarGeometry, sunAt, sunVector } from "./sun";

describe("Mars24 sun model", () => {
  it("reproduces Perseverance's clock: sol 1215 image at 11:48:00 LMST", () => {
    // raw image NLG_1215_0774798880: 2024-07-21T02:10:26.133Z, LMST 11:48:00 at Jezero (77.45° E)
    expect(lmstAt(Date.parse("2024-07-21T02:10:26.133Z"), 77.45)).toBeCloseTo(11.8, 1);
  });

  it("reproduces Curiosity's clock: RAD observation at sol 4191 00:06:36 LMST", () => {
    expect(lmstAt(Date.parse("2024-05-20T19:08:25Z"), 137.4) * 60).toBeCloseTo(6.6, -1);
  });

  it("matches MEDA's LTST - LMST offset on sol 1215 (-38.5 min)", () => {
    const g = solarGeometry(Date.parse("2024-07-21T02:10:26.133Z"));
    expect(g.eotDeg * 4).toBeGreaterThan(-40);
    expect(g.eotDeg * 4).toBeLessThan(-37);
  });

  it("puts the noon Sun to the south for a northern site in southern summer", () => {
    const g = solarGeometry(Date.parse("2024-07-21T02:10:26.133Z"));
    expect(g.declination).toBeLessThan(-20);
    const noon = sunAt(18.49, 12 - g.eotDeg / 15, g);
    expect(noon.azimuth).toBeCloseTo(180, 0);
    expect(noon.elevation).toBeCloseTo(90 - 18.49 + g.declination, 1);
  });

  it("rises in the east and sets in the west", () => {
    const g = solarGeometry(Date.parse("2024-07-21T02:10:26.133Z"));
    const morning = sunAt(18.49, 8, g);
    const evening = sunAt(18.49, 16, g);
    expect(morning.azimuth).toBeGreaterThan(90);
    expect(morning.azimuth).toBeLessThan(180);
    expect(evening.azimuth).toBeGreaterThan(180);
    expect(sunAt(18.49, 3, g).elevation).toBeLessThan(0);
  });

  it("gives a unit world vector pointing up at noon", () => {
    const g = solarGeometry(Date.parse("2024-07-21T02:10:26.133Z"));
    const v = sunVector(sunAt(18.49, 12, g));
    expect(Math.hypot(...v)).toBeCloseTo(1, 9);
    expect(v[1]).toBeGreaterThan(0.6);
    expect(v[2]).toBeGreaterThan(0); // south = +Z
  });

  it("formats local time", () => expect(fmtLmst(10.25)).toBe("10:15"));
});
