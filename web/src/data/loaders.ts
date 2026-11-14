import type { ContextData, GeologyUnit, Poi, ProvenanceEntry, RegionMeta, ReplayData, RoverData, SiteMeta, WeatherData } from "../types";
import type { PanoramaSet } from "../ui/panorama";
import { TerrainGrid } from "./grid";

export interface SiteData {
  id: string;
  base: string;
  meta: SiteMeta;
  grid: TerrainGrid;
  geologyGrid: Uint8Array | null;
  thermalGrid: Uint8Array | null;
  mineralGrid: Uint8Array | null; // RGBA per node: olivine, Fe/Mg clay, carbonate strength, imaged-by-CRISM (CRISM)
  geology: { source: string; mapScale: string; units: GeologyUnit[] } | null;
  pois: Poi[];
  rover: RoverData;
  weather: WeatherData;
  replay: ReplayData;
  context: ContextData;
  provenance: ProvenanceEntry[];
  region: { meta: RegionMeta; heights: Float32Array } | null;
  panoramas: PanoramaSet | null;
}

export interface SiteEntry {
  id: string;
  name: string;
  place: string;
  rover: string;
  tagline: string;
}

/** Site chosen with `?site=<id>` (default: the first site in sites.json). */
export const SITE_ID = new URLSearchParams(location.search).get("site") ?? "jezero";
export const DATA_ROOT = `${import.meta.env.BASE_URL}data/`;
export const DATA_BASE = `${DATA_ROOT}${SITE_ID}/`;

async function json<T>(name: string): Promise<T> {
  const res = await fetch(DATA_BASE + name);
  if (!res.ok) throw new Error(`Could not load ${name} (${res.status})`);
  return (await res.json()) as T;
}

async function bytes(name: string): Promise<Uint8Array> {
  const res = await fetch(DATA_BASE + name);
  if (!res.ok) throw new Error(`Could not load ${name} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function loadSites(): Promise<SiteEntry[]> {
  try {
    const res = await fetch(DATA_ROOT + "sites.json");
    return ((await res.json()) as { sites: SiteEntry[] }).sites;
  } catch {
    return [];
  }
}

/** Load every data file for the site.  `progress` gets a label and a 0..1 fraction. */
export async function loadSite(progress: (label: string, fraction: number) => void): Promise<SiteData> {
  progress("Reading site description", 0.02);
  const meta = await json<SiteMeta>("site.json");
  const n = meta.grid.n;
  const g = meta.grids;

  const jobs: [string, string][] = [
    ["height.u16", "HiRISE elevation model"],
    [g.slope, "Slope map"],
    [g.sand, "Sand hazard"],
    [g.effort, "Walking effort grid"],
    [g.risk, "Risk grid"],
  ];
  if (g.geology) jobs.push([g.geology, "USGS geologic units"]);
  if (g.thermal) jobs.push([g.thermal, "THEMIS thermal image"]);
  if (g.minerals) jobs.push([g.minerals, "CRISM mineral indices"]);
  if (meta.shielding) jobs.push([meta.shielding.file, "Terrain shielding"]);
  let done = 0;
  const loaded = await Promise.all(
    jobs.map(async ([file, label]) => {
      const data = await bytes(file);
      progress(label, 0.05 + 0.55 * (++done / jobs.length));
      return [file, data] as const;
    }),
  );
  const file = new Map(loaded);
  const need = (name: string) => file.get(name)!;
  const [rawH, slope, sand, effort, risk] = [need("height.u16"), need(g.slope), need(g.sand), need(g.effort), need(g.risk)];
  for (const [name, arr] of [["slope", slope], ["sand", sand], ["effort", effort], ["risk", risk]] as const) {
    if (arr.length !== n * n) throw new Error(`${name} grid has ${arr.length} cells, expected ${n * n}`);
  }

  const u16 = new Uint16Array(rawH.buffer, rawH.byteOffset, n * n);
  const height = new Float32Array(n * n);
  const span = meta.height.zMax - meta.height.zMin;
  for (let i = 0; i < height.length; i++) height[i] = meta.height.zMin + (u16[i] / 65535) * span;
  const shield = meta.shielding ? file.get(meta.shielding.file) ?? null : null;
  const grid = new TerrainGrid(n, meta.grid.cellM, height, effort, risk, slope, sand, meta.model.effortScale, meta.model.riskScale, shield);

  progress("Mission data", 0.65);
  const [geology, poiDoc, rover, weather, replay, context, prov] = await Promise.all([
    g.geology ? json<NonNullable<SiteData["geology"]>>("geology.json") : Promise.resolve(null),
    json<{ pois: Poi[] }>("pois.json"),
    json<RoverData>("rover.json"),
    json<WeatherData>("weather.json"),
    json<ReplayData>("replay.json"),
    json<ContextData>("context.json"),
    json<{ entries: ProvenanceEntry[] }>("provenance.json"),
  ]);
  progress("Surrounding terrain", 0.7);
  const region = await loadRegion();
  const panoramas = await json<PanoramaSet>("panoramas.json").catch(() => null);
  return {
    panoramas,
    id: SITE_ID, base: DATA_BASE, meta, grid,
    geologyGrid: g.geology ? need(g.geology) : null,
    thermalGrid: g.thermal ? need(g.thermal) : null,
    mineralGrid: g.minerals ? need(g.minerals) : null,
    geology, pois: poiDoc.pois, rover, weather, replay, context, provenance: prov.entries, region,
  };
}

/** Regional CTX terrain around the walk area (optional: the app still works without it). */
async function loadRegion(): Promise<SiteData["region"]> {
  try {
    const meta = await json<RegionMeta>("region.json");
    const raw = await bytes(meta.height.file);
    const count = meta.n * meta.n;
    const u16 = new Uint16Array(raw.buffer, raw.byteOffset, count);
    const heights = new Float32Array(count);
    const span = meta.height.zMax - meta.height.zMin;
    for (let i = 0; i < count; i++) heights[i] = meta.height.zMin + (u16[i] / 65535) * span;
    return { meta, heights };
  } catch (err) {
    console.warn("Regional terrain not available", err);
    return null;
  }
}
