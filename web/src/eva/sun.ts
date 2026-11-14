/**
 * Position of the Sun in the Martian sky.
 * Mars24 algorithm: Allison & McEwen (2000), Planet. Space Sci. 48:215, as published by NASA GISS
 * (https://www.giss.nasa.gov/tools/mars24/help/algorithm.html).
 */

const D2R = Math.PI / 180;
const MARS_SOL_S = 88775.244;

export interface SolarGeometry {
  ls: number; // areocentric solar longitude, deg (season)
  eotDeg: number; // equation of time, deg (LTST - LMST, x 15)
  declination: number; // subsolar latitude, deg
}

export interface SunPosition {
  elevation: number; // deg above the horizon
  azimuth: number; // deg clockwise from north
  ltst: number; // local true solar time, hours
}

/** Season-dependent quantities for a UTC instant (Mars24 steps A-B-C). */
export function solarGeometry(utcMs: number): SolarGeometry {
  const jdUt = 2440587.5 + utcMs / 86400000;
  const jdTt = jdUt + 69.184 / 86400; // TT - UTC (37 leap seconds + 32.184 s)
  const dt = jdTt - 2451545.0;
  const m = (19.3871 + 0.52402073 * dt) * D2R;
  const alphaFms = 270.3871 + 0.524038496 * dt;
  const A = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.002, 0.0018];
  const tau = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493];
  const phi = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095];
  let pbs = 0;
  for (let i = 0; i < 7; i++) pbs += A[i] * Math.cos(((0.985626 * dt) / tau[i] + phi[i]) * D2R);
  const nuM =
    (10.691 + 3.0e-7 * dt) * Math.sin(m) + 0.623 * Math.sin(2 * m) + 0.05 * Math.sin(3 * m) + 0.005 * Math.sin(4 * m) + 0.0005 * Math.sin(5 * m) + pbs;
  const ls = (((alphaFms + nuM) % 360) + 360) % 360;
  const lsr = ls * D2R;
  const eotDeg = 2.861 * Math.sin(2 * lsr) - 0.071 * Math.sin(4 * lsr) + 0.002 * Math.sin(6 * lsr) - nuM;
  const declination = Math.asin(0.42565 * Math.sin(lsr)) / D2R + 0.25 * Math.sin(lsr);
  return { ls, eotDeg, declination };
}

/** Sun position at a site for a local mean solar time (hours) on the day described by `geo`. */
export function sunAt(latDeg: number, lmstHours: number, geo: SolarGeometry): SunPosition {
  const ltst = lmstHours + geo.eotDeg / 15;
  const h = (ltst - 12) * 15 * D2R;
  const lat = latDeg * D2R;
  const dec = geo.declination * D2R;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(h);
  const elevation = Math.asin(Math.max(-1, Math.min(1, sinEl))) / D2R;
  const az = Math.atan2(-Math.sin(h), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(h)) / D2R;
  return { elevation, azimuth: (az + 360) % 360, ltst };
}

/** Local mean solar time (hours) at an east longitude for a UTC instant (Mars24 step C-2/C-3). */
export function lmstAt(utcMs: number, lonEastDeg: number): number {
  const jdTt = 2440587.5 + utcMs / 86400000 + 69.184 / 86400;
  const mst = 24 * (((jdTt - 2451549.5) / 1.0274912517 + 44796.0 - 0.0009626) % 1);
  return (((mst + lonEastDeg / 15) % 24) + 24) % 24;
}

/** Seconds of EVA time per hour of local solar time. */
export const MARS_HOUR_S = MARS_SOL_S / 24;

/** World-space direction toward the Sun (X east, Y up, Z south). */
export function sunVector(sun: SunPosition): [number, number, number] {
  const el = sun.elevation * D2R;
  const az = sun.azimuth * D2R;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
}

export function fmtLmst(hours: number): string {
  const t = ((hours % 24) + 24) % 24;
  const hh = Math.floor(t);
  const mm = Math.floor((t - hh) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
