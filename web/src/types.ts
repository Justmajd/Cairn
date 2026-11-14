/** Shared data types.  Local coordinates: metres from the AOI south-west corner, x = east, y = north. */

export interface XY {
  x: number;
  y: number;
}

export interface SiteMeta {
  id: string;
  name: string;
  crs: string;
  originEqc: XY;
  boundsLonLat: { west: number; south: number; east: number; north: number };
  sizeM: number;
  grid: { n: number; cellM: number };
  height: { file: string; zMin: number; zMax: number };
  texture: { file: string; px: number; mPerPx: number; hi?: { file: string; px: number; mPerPx: number } };
  relief?: { file: string; range: number };
  shielding?: { file: string; exponent: number; azimuths: number; radiusM: number };
  eva?: { sol?: number; utc: string; note: string; startLmst: number; label?: string }; // label: a planning date where no rover counts sols
  rover?: { name: string; mission: string } | null; // null at a candidate landing site no rover has visited
  story?: { headline: string; paragraphs: string[] };
  minerals?: { source: string; product: string; mPerPx: number; coveragePct?: number; bands: { key: string; name: string; parameter: string; color: [number, number, number] }[] };
  centerLonLat?: { lon: number; lat: number };
  grids: { slope: string; sand: string; effort: string; risk: string; thermal?: string; geology?: string; minerals?: string };
  model: {
    slopeLimitDeg: number;
    slopeRiskStartDeg: number;
    slopeRiskMax: number;
    sandEffort: number;
    roughEffort: number;
    effortScale: number;
    riskScale: number;
    themisNativeResM: number;
  };
  stats: { slopeMedianDeg: number; blockedPct: number; sandPct: number; reliefM: number };
}

export interface GeologyUnit {
  id: number;
  unit: string;
  name: string;
  symbol: string;
  color: [number, number, number];
  areaPct: number;
}

export interface PoiImage {
  id: string;
  file: string;
  sol: number;
  camera: string;
  cameraName: string;
  lmst: string;
  utc: string;
  credit: string;
  link: string;
}

export type PoiKind = "shelter" | "objective" | "optional";

export interface Poi {
  id: string;
  kind: PoiKind;
  name: string;
  short: string;
  x: number;
  y: number;
  rmc: string;
  sols: string;
  description: string;
  science: string;
  whyHumans: string;
  dwellMin: number;
  images: PoiImage[];
}

export interface RoverData {
  source: string;
  traverse: [number, number, number][]; // x, y, sol (local metres)
  waypoints: { sol: number; rmc: string; x: number; y: number; note: string }[];
}

export interface WeatherData {
  source: string;
  instrument?: string;
  sol: number;
  site: string;
  stepH: number;
  pressurePa: (number | null)[];
  airTempK: (number | null)[];
  groundTempK: (number | null)[];
  range: Record<string, [number, number]>;
}

export interface ReplayData {
  event: {
    title: string;
    summary: string;
    nasaReportedTotalUGy: number;
    nasaStatement: string;
    assumedOnsetUtc: string;
  };
  donki: {
    cme: {
      activityID: string;
      startTime: string;
      link: string;
      speedKmS: number;
      halfAngleDeg: number;
      type: string;
      note: string;
    };
    alert: { messageID: string; issueTime: string; url: string; summary: string; delayAfterCmeStartH: number };
  };
  rad: {
    source: string;
    baselineUGyH: number;
    measured: { utc: string; durS: number; uGyH: number; hFromOnset: number }[];
  };
  model: {
    label: string;
    description: string;
    riseH: number;
    fastTauH: number;
    slowTauH: number;
    slowAmpUGyH: number;
    peakUGyH: number;
    totalUGy: number;
    curve: [number, number][]; // hours since onset, excess µGy/h
  };
}

export interface ContextData {
  image: string;
  aspect: number;
  source: string;
  widthKm: number;
  heightKm: number;
  aoi: { uv0: [number, number]; uv1: [number, number] };
  traverse: { source: string; points: [number, number, number][]; totalKm: number; lastSol: number } | null; // null: no rover here
  places: { id: string; name: string; sol?: number; uv: [number, number]; note: string; lon: number; lat: number }[];
  facts: { value: string; label: string }[];
  links: { from: string; to: string }[];
  global: {
    image: string; source: string; siteUv: [number, number]; lon: number; lat: number;
    /** A regional locator (degrees of longitude / latitude shown) instead of the whole planet. */
    spanDeg?: [number, number];
    /** NASA's 2015 Exploration Zones in view: centre, radius in image fractions, distance from the site. */
    zones?: { name: string; lon: number; lat: number; uv: [number, number]; rUv: [number, number]; km: number }[];
    zoneRadiusKm?: number;
    zonesSource?: string;
  };
}

export interface ProvenanceEntry {
  id: string;
  layer: string;
  dataType: string;
  mission: string;
  instrument: string;
  product: string;
  provider: string;
  url: string;
  credit: string;
  usedFor: string;
  note?: string;
}

/** One sample along a measured path (cumulative values from the path start). */
export interface PathSample {
  x: number;
  y: number;
  z: number;
  dist: number; // m, along the ground (3-D length)
  energy: number; // J of walking energy
  time: number; // s of walking time
  slopeDeg: number; // terrain slope at the sample
  gradeDeg: number; // slope in the walking direction (signed)
  sand: number; // 0..1
  shield: number; // fraction of the open-sky dose rate received here (terrain shielding), 0..1
  blocked: boolean;
}

export interface MeasuredPath {
  points: XY[];
  samples: PathSample[];
  distance: number;
  energy: number;
  time: number;
  climb: number;
  descent: number;
  maxSlopeDeg: number;
  blockedM: number; // metres of the path on impassable ground
  sandM: number; // metres on loose sand
  cost: number; // risk-weighted energy (what the router minimises)
}

export interface RegionMeta {
  source: string;
  n: number;
  cellM: number;
  sizeM: number;
  originLocal: XY; // south-west corner, metres from the walk-area origin
  inner: { from: number; to: number }; // node index range of the walk area
  height: { file: string; zMin: number; zMax: number };
  texture: { file: string; px: number; mPerPx: number };
}
