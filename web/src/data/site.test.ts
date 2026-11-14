import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { buildBudget, Segment } from "../eva/budget";
import { DEFAULT_PARAMS as P } from "../eva/params";
import { astar, buildReturnField, pathToShelter, ReturnField } from "../routing/search";
import { smoothPath } from "../routing/smooth";
import type { MeasuredPath, Poi, SiteMeta } from "../types";
import { measurePath, TerrainGrid } from "./grid";
import { undelta16, undelta8 } from "./pack";

/** Integration test against the real site data produced by the pipeline (every site). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../public/data");

describe.each(["jezero", "gale", "deuteronilus"])("%s site data", (siteId) => {
const DIR = resolve(ROOT, siteId);
const json = <T,>(name: string) => JSON.parse(readFileSync(resolve(DIR, name), "utf8")) as T;
/** A grid as the app sees it: raw, or packed by the pipeline (see data/pack.ts). */
const bin = (name: string): Uint8Array => {
  const entry = json<{ files: Record<string, { file: string; enc: string }> }>("pack.json").files[name];
  if (!entry) return new Uint8Array(readFileSync(resolve(DIR, name)));
  const raw = new Uint8Array(gunzipSync(readFileSync(resolve(DIR, entry.file))));
  return entry.enc === "delta8" ? undelta8(raw) : entry.enc === "delta16" ? undelta16(raw) : raw;
};

let grid: TerrainGrid;
let pois: Record<string, Poi>;
let field: ReturnField;
const legs: MeasuredPath[] = [];
const straight: MeasuredPath[] = [];

beforeAll(() => {
  const meta = json<SiteMeta>("site.json");
  const n = meta.grid.n;
  const raw = bin("height.u16");
  const u16 = new Uint16Array(raw.buffer, raw.byteOffset, n * n);
  const height = new Float32Array(n * n);
  for (let i = 0; i < height.length; i++) height[i] = meta.height.zMin + (u16[i] / 65535) * (meta.height.zMax - meta.height.zMin);
  grid = new TerrainGrid(n, meta.grid.cellM, height, bin("effort.u8"), bin("risk.u8"), bin("slope.u8"), bin("sand.u8"));
  pois = Object.fromEntries(json<{ pois: Poi[] }>("pois.json").pois.map((p) => [p.id, p]));

  const t0 = performance.now();
  field = buildReturnField(grid, grid.nearestPassable(pois.rover.x, pois.rover.y), P);
  console.log(`return field: ${(performance.now() - t0).toFixed(0)} ms`);

  const objectives = Object.values(pois).filter((p) => p.kind === "objective").map((p) => p.id);
  const order = ["rover", ...objectives, "rover"];
  for (let i = 1; i < order.length; i++) {
    const a = pois[order[i - 1]];
    const b = pois[order[i]];
    const t1 = performance.now();
    const nodes = astar(grid, grid.nearestPassable(a.x, a.y), grid.nearestPassable(b.x, b.y), P)!;
    const pts = smoothPath(grid, nodes, P);
    const ms = performance.now() - t1;
    const leg = measurePath(grid, pts, P);
    const line = measurePath(grid, [a, b], P);
    legs.push(leg);
    straight.push(line);
    console.log(
      `${a.id} → ${b.id}: safe ${leg.distance.toFixed(0)} m, ${(leg.time / 60).toFixed(1)} min, max slope ${leg.maxSlopeDeg}°, sand ${leg.sandM.toFixed(0)} m, ` +
        `${pts.length} pts, ${ms.toFixed(0)} ms | straight ${line.distance.toFixed(0)} m, blocked ${line.blockedM.toFixed(0)} m, sand ${line.sandM.toFixed(0)} m, ` +
        `cost ratio ${(line.cost / leg.cost).toFixed(2)}`,
    );
  }
});

describe("checks", () => {
  it("loads a consistent grid", () => {
    expect(grid.n).toBe(1025);
    expect(grid.size).toBe(2048);
    expect(grid.height.every((h) => h > -4500 && h < -1500)).toBe(true);
  });

  it("places every stop on passable ground inside the AOI", () => {
    for (const p of Object.values(pois)) {
      expect(grid.inside(p.x, p.y)).toBe(true);
      expect(grid.isBlocked(grid.nodeAt(p.x, p.y))).toBe(false);
      if (json<SiteMeta>("site.json").rover) expect(p.images.length).toBeGreaterThan(0); // rover sites have photos
    }
  });

  it("finds a safe route for every leg of the default EVA", () => {
    expect(legs.length).toBe(Object.values(pois).filter((p) => p.kind === "objective").length + 1);
    for (const leg of legs) {
      expect(leg.blockedM).toBe(0);
      expect(leg.maxSlopeDeg).toBeLessThanOrEqual(25);
      expect(leg.distance).toBeGreaterThan(100);
    }
  });

  it("the safe route is never worse than the straight line", () => {
    legs.forEach((leg, i) => expect(leg.cost).toBeLessThanOrEqual(straight[i].cost * 1.001));
    if (siteId === "jezero") expect(straight.some((s) => s.blockedM > 0)).toBe(true); // the demo's deadly straight line
  });

  it("can get home from every stop, and the default EVA fits the suit budget", () => {
    const lookup = (x: number, y: number) => {
      const node = grid.nodeAt(x, y);
      return { timeS: field.time[node], energyJ: field.energy[node] };
    };
    for (const p of Object.values(pois)) expect(pathToShelter(field, grid.nearestPassable(p.x, p.y))).not.toBeNull();
    const objectives = Object.values(pois).filter((p) => p.kind === "objective");
    const segments: Segment[] = [];
    objectives.forEach((p, i) => {
      segments.push({ kind: "walk", path: legs[i], to: p, label: "" }, { kind: "dwell", poi: p, durationS: 1800, sheltered: false });
    });
    segments.push({ kind: "walk", path: legs[legs.length - 1], to: pois.rover, label: "" });
    const b = buildBudget(segments, P, lookup);
    console.log(
      `EVA: ${(b.distanceM / 1000).toFixed(2)} km, ${(b.totalTimeS / 3600).toFixed(2)} h, O2 ${b.o2UsedL.toFixed(0)} L of ${b.o2UsableL.toFixed(0)} usable, ` +
        `min walk-back margin ${b.walkBack.minMarginL.toFixed(0)} L, max return ${b.walkBack.maxReturnMin.toFixed(1)} min, climb ${b.climbM.toFixed(0)} m`,
    );
    expect(b.feasible).toBe(true);
    expect(b.walkBack.minMarginL).toBeGreaterThan(0);
  });
});
});
