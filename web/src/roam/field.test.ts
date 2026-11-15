import { describe, expect, it } from "vitest";
import { bearingName, FieldWork, rankOf, SOIL_APART_M, type FieldGrid, type FieldSources } from "./field";

/** A 101 × 101 grid, 2 m cells (200 m square), with a strong carbonate patch and a sheltered corner. */
function world(): { g: FieldGrid; src: FieldSources } {
  const n = 101;
  const cell = 2;
  const size = (n - 1) * cell;
  const nodeAt = (x: number, y: number) => {
    const c = Math.max(0, Math.min(n - 1, Math.round(x / cell)));
    const r = Math.max(0, Math.min(n - 1, Math.round((size - y) / cell)));
    return r * n + c;
  };
  const sand = new Uint8Array(n * n);
  const slope = new Uint8Array(n * n).fill(5);
  const shield = new Uint8Array(n * n).fill(255);
  const minerals = new Uint8Array(n * n * 4);
  const geology = new Uint8Array(n * n);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      const x = c * cell;
      const y = size - r * cell;
      sand[i] = x > 150 ? 230 : 0; // sand in the east
      geology[i] = x < 100 ? 1 : 2; // two units, west and east
      if (x <= 20 && y <= 20) shield[i] = 200; // a sheltered hollow in the south-west corner
      if (y > 100) {
        minerals[i * 4 + 3] = 255; // CRISM imaged the north half
        minerals[i * 4] = 40; // olivine everywhere there
        minerals[i * 4 + 2] = Math.hypot(x - 160, y - 180) < 6 ? 90 : (x * 7 + y * 3) % 5 === 0 ? 10 : 0; // carbonate: weak specks and one strong patch
      }
    }
  const g: FieldGrid = { n, cell, size, nodeAt, sand, slope, shield };
  const src: FieldSources = {
    minerals,
    mineralBands: [{ key: "olivine", name: "Olivine" }, { key: "clay", name: "Fe/Mg clay" }, { key: "carbonate", name: "Carbonate" }],
    geology,
    units: [{ id: 1, name: "West unit", symbol: "W" }, { id: 2, name: "East unit", symbol: "E" }],
    traverse: [[10, 50, 100], [190, 50, 101]],
    roverName: "Perseverance",
  };
  return { g, src };
}

describe("free-roam field work", () => {
  it("ranks a value against the detections", () => {
    const s = Uint8Array.from([1, 2, 3, 4]);
    expect(rankOf(s, 1)).toBe(0);
    expect(rankOf(s, 4)).toBe(0.75);
    expect(rankOf(s, 9)).toBe(1);
    expect(rankOf(s, 0)).toBe(0);
    expect(bearingName(0, 10)).toBe("N");
    expect(bearingName(10, -10)).toBe("SE");
  });

  it("reads the ground: soil, unit, shelter and minerals only where CRISM imaged", () => {
    const { g, src } = world();
    const f = new FieldWork(g, src);
    const west = f.readingAt(30, 30);
    expect(west.soil).toBe("bedrock");
    expect(west.unit?.name).toBe("West unit");
    expect(west.minerals).toBeNull();
    expect(f.readingAt(180, 30).soil).toBe("sand");
    expect(f.readingAt(10, 10).blockedPct).toBeGreaterThan(20);
    expect(f.readingAt(160, 180).minerals?.[2].rank).toBeGreaterThan(0.95);
  });

  it("finds the strong carbonate patch only on it, and the signal points the way", () => {
    const { g, src } = world();
    const f = new FieldWork(g, src);
    expect(f.scan(150, 150, 0).finds.some((x) => x.id === "mineral-carbonate")).toBe(false);
    const sig = f.signal(140, 170)!;
    expect(sig[2].rank).toBeGreaterThan(0.95);
    expect(sig[2].bearing).toBe("E");
    expect(f.nearestMineral(2, 100, 180)!.d).toBeLessThan(70);
    const hit = f.scan(160, 180, 60).finds;
    expect(hit.map((x) => x.id)).toContain("mineral-carbonate");
    // a second reading there finds nothing new
    expect(f.scan(161, 180, 70).finds.some((x) => x.id === "mineral-carbonate")).toBe(false);
  });

  it("counts soil tests only when far enough apart", () => {
    const { g, src } = world();
    const f = new FieldWork(g, src);
    f.scan(20, 100, 0);
    f.scan(20 + SOIL_APART_M / 2, 100, 0);
    expect(f.soilTests).toBe(1);
    f.scan(20 + SOIL_APART_M, 100, 0);
    f.scan(20 + SOIL_APART_M, 100 + SOIL_APART_M, 0);
    expect(f.soilTests).toBe(3);
    expect(f.tasks(0, 0, false).find((t) => t.id === "soil")!.done).toBe(true);
  });

  it("finds sheltered ground, contacts and the rover's tracks", () => {
    const { g, src } = world();
    const f = new FieldWork(g, src);
    expect(f.shelterBlockedPct).toBeGreaterThan(20);
    expect(f.scan(8, 8, 0).finds.map((x) => x.id)).toContain("shelter");
    expect(f.walk(50, 150, 0)).toEqual([]); // the first unit is where you start: not a contact
    expect(f.walk(150, 150, 10).map((x) => x.id)).toEqual(["unit-2"]);
    expect(f.tasks(150, 150, false).find((t) => t.id === "units")!.done).toBe(true);
    expect(f.walk(100, 60, 20)).toEqual([]);
    // along the route: found after 50 m on it, not at the first step
    let tr: ReturnType<typeof f.walk> = [];
    for (let x = 100; x <= 160 && !tr.length; x += 2) {
      tr = f.walk(x, 53, 30);
      if (x === 100) expect(tr).toEqual([]);
    }
    expect(tr[0]?.id).toBe("tracks");
    expect(f.trackM).toBeGreaterThanOrEqual(50);
    expect(f.tracksFound).toBe(101);
  });

  it("lists the tasks the site's data supports", () => {
    const { g, src } = world();
    const all = new FieldWork(g, src).tasks(50, 50, false).map((t) => t.id);
    expect(all).toEqual(["mineral-olivine", "mineral-carbonate", "units", "tracks", "soil", "shelter", "relay"]);
    const bare = new FieldWork({ ...g, shield: null }, { ...src, minerals: null, geology: null, traverse: [] }).tasks(50, 50, true).map((t) => t.id);
    expect(bare).toEqual(["soil", "relay"]);
  });
});
