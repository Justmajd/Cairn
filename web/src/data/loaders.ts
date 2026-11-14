import type { ContextData, GeologyUnit, Poi, ProvenanceEntry, RegionMeta, ReplayData, RoverData, SiteMeta, WeatherData } from "../types";
import type { PanoramaSet } from "../ui/panorama";
import { TerrainGrid } from "./grid";
import { undelta16, undelta8 } from "./pack";

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

/** Packed data files (see data-pipeline/pack_web.py): original name → packed file and encoding. */
interface PackEntry {
  file: string;
  enc: "gzip" | "delta8" | "delta16" | "image";
}
let pack: Record<string, PackEntry> = {};

async function loadPack(): Promise<void> {
  try {
    const res = await fetch(DATA_BASE + "pack.json");
    if (res.ok) pack = ((await res.json()) as { files: Record<string, PackEntry> }).files;
  } catch {
    pack = {};
  }
}

/** URL of a site file, following the pack table (e.g. relief.png → relief.webp). */
export function dataUrl(name: string): string {
  return DATA_BASE + (pack[name]?.file ?? name);
}

async function gunzip(buf: Uint8Array): Promise<Uint8Array> {
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf; // a server already inflated it
  const stream = new Blob([buf as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function json<T>(name: string): Promise<T> {
  const res = await fetch(DATA_BASE + name);
  if (!res.ok) throw new Error(`Could not load ${name} (${res.status})`);
  return (await res.json()) as T;
}

async function bytes(name: string): Promise<Uint8Array> {
  const entry = pack[name];
  const res = await fetch(dataUrl(name));
  if (!res.ok) throw new Error(`Could not load ${name} (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (!entry || entry.enc === "image") return buf;
  const raw = await gunzip(buf);
  return entry.enc === "delta8" ? undelta8(raw) : entry.enc === "delta16" ? undelta16(raw) : raw;
}

export async function loadSites(): Promise<SiteEntry[]> {
  try {
    const res = await fetch(DATA_ROOT + "sites.json");
    return ((await res.json()) as { sites: SiteEntry[] }).sites;
  } catch {
    return [];
  }
}

/**
 * Load every data file for the site.  `progress` gets a label and a 0..1 fraction.  Everything is
 * requested at once as soon as site.json is in; `onMeta` lets the caller start on images meanwhile.
 */
export async function loadSite(
  progress: (label: string, fraction: number) => void,
  onMeta?: (meta: SiteMeta) => void,
): Promise<SiteData> {
  progress("Reading site description", 0.02);
  const [meta] = await Promise.all([json<SiteMeta>("site.json"), loadPack()]);
  onMeta?.(meta);
  const n = meta.grid.n;
  const g = meta.grids;

  // small files and the surrounding terrain download while the grids decode
  const docs = Promise.all([
    g.geology ? json<NonNullable<SiteData["geology"]>>("geology.json") : Promise.resolve(null),
    json<{ pois: Poi[] }>("pois.json"),
    json<RoverData>("rover.json"),
    json<WeatherData>("weather.json"),
    json<ReplayData>("replay.json"),
    json<ContextData>("context.json"),
    json<{ entries: ProvenanceEntry[] }>("provenance.json"),
  ]);
  const regionJob = loadRegion();
  const panoramaJob = json<PanoramaSet>("panoramas.json").catch(() => null);
  docs.catch(() => {}); // awaited below; avoid an unhandled rejection while the grids load

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
  const [geology, poiDoc, rover, weather, replay, context, prov] = await docs;
  progress("Surrounding terrain", 0.7);
  const [region, panoramas] = await Promise.all([regionJob, panoramaJob]);
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
