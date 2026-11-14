import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { TerrainGrid } from "../data/grid";
import { undelta16, undelta8 } from "../data/pack";
import type { Poi, SiteMeta } from "../types";
import { habSuitability } from "./hab";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../public/data");

function load(siteId: string): { grid: TerrainGrid; pois: Poi[] } {
  const DIR = resolve(ROOT, siteId);
  const json = <T,>(name: string) => JSON.parse(readFileSync(resolve(DIR, name), "utf8")) as T;
  const bin = (name: string): Uint8Array => {
    const entry = json<{ files: Record<string, { file: string; enc: string }> }>("pack.json").files[name];
    if (!entry) return new Uint8Array(readFileSync(resolve(DIR, name)));
    const raw = new Uint8Array(gunzipSync(readFileSync(resolve(DIR, entry.file))));
    return entry.enc === "delta8" ? undelta8(raw) : entry.enc === "delta16" ? undelta16(raw) : raw;
  };
  const meta = json<SiteMeta>("site.json");
  const n = meta.grid.n;
  const raw = bin("height.u16");
  const u16 = new Uint16Array(raw.buffer, raw.byteOffset, n * n);
  const height = new Float32Array(n * n);
  for (let i = 0; i < height.length; i++) height[i] = meta.height.zMin + (u16[i] / 65535) * (meta.height.zMax - meta.height.zMin);
  const grid = new TerrainGrid(n, meta.grid.cellM, height, bin("effort.u8"), bin("risk.u8"), bin("slope.u8"), bin("sand.u8"), 50, 50, bin("shield.u8"));
  return { grid, pois: json<{ pois: Poi[] }>("pois.json").pois };
}

describe.each(["jezero", "gale", "deuteronilus"])("hab map at %s", (siteId) => {
  it("scores the area quickly and picks flat ground in reach of the stops", () => {
    const { grid, pois } = load(siteId);
    const stops = pois.filter((p) => p.kind !== "shelter");
    const ice = pois.filter((p) => p.ice);
    const hab = habSuitability(grid, stops, ice);
    const f = hab.bestFactors;
    const rover = pois.find((p) => p.kind === "shelter")!;
    const atRover = hab.at(rover.x, rover.y);
    let good = 0;
    for (const v of hab.score) if (v > 200) good++;
    console.log(siteId, `${hab.ms.toFixed(0)} ms`, `best (${hab.best.x.toFixed(0)}, ${hab.best.y.toFixed(0)}) score ${f.score.toFixed(2)} slope ${f.slopeDeg}° shield ${f.shieldPct.toFixed(1)}% sight ${f.stopsInSight}/${stops.length} walk ${(f.meanWalkS / 60).toFixed(1)} min ice ${f.iceWalkS === null ? "-" : (f.iceWalkS / 60).toFixed(1)} | rover spot score ${atRover.score.toFixed(2)} | >0.78: ${((100 * good) / hab.score.length).toFixed(1)}%`);
    expect(hab.ms).toBeLessThan(1500);
    expect(f.score).toBeGreaterThan(0.5);
    expect(f.slopeDeg).toBeLessThanOrEqual(6);
    expect(f.score).toBeGreaterThanOrEqual(atRover.score);
    expect(hab.hasIce).toBe(siteId === "deuteronilus");
  });
});
