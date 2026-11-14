import type { ContextData, GeologyUnit, Poi, ProvenanceEntry, RegionMeta, ReplayData, RoverData, SiteMeta, WeatherData } from "../types";
import { TerrainGrid } from "./grid";

export interface SiteData {
  base: string;
  meta: SiteMeta;
  grid: TerrainGrid;
  geologyGrid: Uint8Array;
  thermalGrid: Uint8Array;
  geology: { source: string; mapScale: string; units: GeologyUnit[] };
  pois: Poi[];
  rover: RoverData;
  weather: WeatherData;
  replay: ReplayData;
  context: ContextData;
  provenance: ProvenanceEntry[];
  region: { meta: RegionMeta; heights: Float32Array } | null;
}

export const DATA_BASE = `${import.meta.env.BASE_URL}data/jezero/`;

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

/** Load every data file for the site.  `progress` gets a label and a 0..1 fraction. */
export async function loadSite(progress: (label: string, fraction: number) => void): Promise<SiteData> {
  progress("Reading site description", 0.02);
  const meta = await json<SiteMeta>("site.json");
  const n = meta.grid.n;

  let done = 0;
  const names = ["height.u16", "slope.u8", "sand.u8", "effort.u8", "risk.u8", "geology.u8", "thermal.u8"];
  const track = async (name: string, label: string) => {
    const data = await bytes(name);
    done++;
    progress(label, 0.05 + 0.55 * (done / names.length));
    return data;
  };
  const [rawH, slope, sand, effort, risk, geologyGrid, thermalGrid] = await Promise.all([
    track("height.u16", "HiRISE elevation model"),
    track("slope.u8", "Slope map"),
    track("sand.u8", "Sand hazard"),
    track("effort.u8", "Walking effort grid"),
    track("risk.u8", "Risk grid"),
    track("geology.u8", "USGS geologic units"),
    track("thermal.u8", "THEMIS thermal image"),
  ]);
  for (const [name, arr] of [["slope", slope], ["sand", sand], ["effort", effort], ["risk", risk]] as const) {
    if (arr.length !== n * n) throw new Error(`${name} grid has ${arr.length} cells, expected ${n * n}`);
  }

  const u16 = new Uint16Array(rawH.buffer, rawH.byteOffset, n * n);
  const height = new Float32Array(n * n);
  const span = meta.height.zMax - meta.height.zMin;
  for (let i = 0; i < height.length; i++) height[i] = meta.height.zMin + (u16[i] / 65535) * span;
  const grid = new TerrainGrid(n, meta.grid.cellM, height, effort, risk, slope, sand, meta.model.effortScale, meta.model.riskScale);

  progress("Mission data", 0.65);
  const [geology, poiDoc, rover, weather, replay, context, prov] = await Promise.all([
    json<SiteData["geology"]>("geology.json"),
    json<{ pois: Poi[] }>("pois.json"),
    json<RoverData>("rover.json"),
    json<WeatherData>("weather.json"),
    json<ReplayData>("replay.json"),
    json<ContextData>("context.json"),
    json<{ entries: ProvenanceEntry[] }>("provenance.json"),
  ]);
  progress("Regional terrain (CTX)", 0.7);
  const region = await loadRegion();
  return { base: DATA_BASE, meta, grid, geologyGrid, thermalGrid, geology, pois: poiDoc.pois, rover, weather, replay, context, provenance: prov.entries, region };
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
