/**
 * Where Earth, Phobos and Deimos stand in the sky of a site on Mars, and how long a radio message
 * takes to reach Earth.
 *
 * - Earth and Mars: JPL's Keplerian elements for approximate planet positions (Standish, table 1,
 *   valid 1800-2050, J2000 ecliptic; good to about an arcminute here).
 * - Mars' spin axis and prime meridian: IAU WGCCRE 2009 (Archinal et al. 2011).
 * - Phobos and Deimos: JPL mean orbital elements (epoch 2000 Jan 1.5, on their Laplace planes),
 *   precessing node and periapsis; seen from the surface (their parallax is large: Phobos is only
 *   6000 km above the ground).
 */

const D2R = Math.PI / 180;
const AU_KM = 149_597_870.7;
const C_KM_S = 299_792.458;
const MARS_R_KM = 3389.5;

type V3 = [number, number, number];

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);

/** Days from J2000.0 (TT) for a UTC instant. */
export function daysJ2000(utcMs: number): number {
  return 2440587.5 + utcMs / 86400000 + 69.184 / 86400 - 2451545.0;
}

function kepler(M: number, e: number): number {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 6; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

/** Position on an ellipse (a, e, M in rad) rotated by periapsis argument w, inclination i, node O (rad). */
function orbit(a: number, e: number, M: number, w: number, i: number, O: number): V3 {
  const E = kepler(M, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(i), si = Math.sin(i);
  return [
    (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp,
    (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp,
    sw * si * xp + cw * si * yp,
  ];
}

// a (AU), e, I, L, long. perihelion, long. node (deg) and their rates per Julian century
const EARTH = [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0, 0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0];
const MARS = [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891, 0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343];
const OBLIQUITY = 23.43928 * D2R;

/** Heliocentric position (AU) in the ICRF equatorial frame. */
function planet(el: number[], d: number): V3 {
  const T = d / 36525;
  const [a, e, I, L, wb, O] = el.slice(0, 6).map((v, k) => v + el[k + 6] * T);
  const p = orbit(a, e, (L - wb) * D2R, (wb - O) * D2R, I * D2R, O * D2R);
  const ce = Math.cos(OBLIQUITY), se = Math.sin(OBLIQUITY);
  return [p[0], p[1] * ce - p[2] * se, p[1] * se + p[2] * ce];
}

const raDec = (ra: number, dec: number): V3 => [Math.cos(dec * D2R) * Math.cos(ra * D2R), Math.cos(dec * D2R) * Math.sin(ra * D2R), Math.sin(dec * D2R)];

/** A frame from its pole: the node on the ICRF equator, then the third axis. */
function poleFrame(pole: V3): { n: V3; q: V3; z: V3 } {
  const n0: V3 = [-pole[1], pole[0], 0];
  const n = scale(n0, 1 / norm(n0));
  return { n, q: cross(pole, n), z: pole };
}

/** Mars' body-fixed axes (prime meridian, 90° E, north pole) in ICRF. */
function marsAxes(d: number): { x: V3; y: V3; z: V3 } {
  const T = d / 36525;
  const { n, q, z } = poleFrame(raDec(317.68143 - 0.1061 * T, 52.8865 - 0.0609 * T));
  const W = (176.63 + 350.89198226 * d) * D2R;
  const x = add(scale(n, Math.cos(W)), scale(q, Math.sin(W)));
  return { x, y: cross(z, x), z };
}

interface Moon {
  a: number; e: number; w: number; M: number; i: number; node: number; n: number; pw: number; pnode: number; ra: number; dec: number; radiusKm: number;
}
// JPL SSD planetary satellite mean elements; pw, pnode: precession periods (years), node regresses
const PHOBOS: Moon = { a: 9376, e: 0.0151, w: 150.057, M: 91.059, i: 1.075, node: 207.784, n: 1128.844585, pw: 1.131, pnode: 2.262, ra: 317.724, dec: 52.924, radiusKm: 11.1 };
const DEIMOS: Moon = { a: 23458, e: 0.0002, w: 260.729, M: 325.329, i: 1.788, node: 24.525, n: 285.1618919, pw: 27.363, pnode: 54.537, ra: 316.7, dec: 53.564, radiusKm: 6.2 };

/** Mars-centred position (km, ICRF). */
function moon(m: Moon, d: number): V3 {
  const wRate = 360 / (m.pw * 365.25);
  const oRate = -360 / (m.pnode * 365.25);
  const w = m.w + wRate * d;
  const O = m.node + oRate * d;
  // n is the sidereal rate of the mean longitude (node + periapsis + mean anomaly)
  const lon = m.node + m.w + m.M + m.n * d;
  const M = lon - w - O;
  const p = orbit(m.a, m.e, M * D2R, w * D2R, m.i * D2R, O * D2R);
  const f = poleFrame(raDec(m.ra, m.dec));
  return add(add(scale(f.n, p[0]), scale(f.q, p[1])), scale(f.z, p[2]));
}

export interface SkyBody {
  elevation: number; // deg above the horizon
  azimuth: number; // deg clockwise from north
  /** World direction (X east, Y up, Z south), like sunVector(). */
  dir: [number, number, number];
  distanceKm: number;
  /** Apparent diameter, deg. */
  sizeDeg: number;
  /** Fraction of the disc lit by the Sun, 0..1. */
  phase: number;
}

export interface MarsSky {
  sun: SkyBody;
  earth: SkyBody;
  phobos: SkyBody;
  deimos: SkyBody;
  /** One-way light time Mars -> Earth, seconds. */
  lightTimeS: number;
}

/** The sky at a site (planetocentric latitude, east longitude, degrees) at a UTC instant. */
export function marsSky(utcMs: number, latDeg: number, lonEastDeg: number): MarsSky {
  const d = daysJ2000(utcMs);
  const mars = scale(planet(MARS, d), AU_KM);
  const earth = sub(scale(planet(EARTH, d), AU_KM), mars);
  const ax = marsAxes(d);
  const la = latDeg * D2R, lo = lonEastDeg * D2R;
  const up = add(scale(add(scale(ax.x, Math.cos(lo)), scale(ax.y, Math.sin(lo))), Math.cos(la)), scale(ax.z, Math.sin(la)));
  const east = add(scale(ax.x, -Math.sin(lo)), scale(ax.y, Math.cos(lo)));
  const north = cross(up, east);
  const site = scale(up, MARS_R_KM);
  const sunFromMars = scale(mars, -1);

  const body = (rel: V3, radiusKm: number, bodyPos: V3 | null): SkyBody => {
    const r = norm(rel);
    const u = scale(rel, 1 / r);
    const e = dot(u, east), nn = dot(u, north), z = dot(u, up);
    let phase = 1;
    if (bodyPos) {
      // angle Sun - body - observer
      const toSun = sub(sunFromMars, bodyPos);
      const cosA = dot(toSun, scale(rel, -1)) / (norm(toSun) * r);
      phase = (1 + cosA) / 2;
    }
    return {
      elevation: Math.asin(Math.max(-1, Math.min(1, z))) / D2R,
      azimuth: ((Math.atan2(e, nn) / D2R) + 360) % 360,
      dir: [e, z, -nn],
      distanceKm: r,
      sizeDeg: (2 * Math.atan(radiusKm / r)) / D2R,
      phase,
    };
  };
  const ph = moon(PHOBOS, d);
  const de = moon(DEIMOS, d);
  return {
    sun: body(sub(sunFromMars, site), 695_700, null),
    earth: body(sub(earth, site), 6371, earth),
    phobos: body(sub(ph, site), PHOBOS.radiusKm, ph),
    deimos: body(sub(de, site), DEIMOS.radiusKm, de),
    lightTimeS: norm(earth) / C_KM_S,
  };
}

/** UTC of the moment a site's clock reads `lmst` hours on the sol of `utcMs` (nearest such moment). */
export function utcAtLmst(utcMs: number, lmstAtUtc: number, lmst: number): number {
  let dh = (((lmst - lmstAtUtc) % 24) + 36) % 24 - 12;
  if (dh === -12) dh = 12;
  return utcMs + dh * (88775.244 / 24) * 1000;
}

/** "12 min 34 s" */
export function fmtLightTime(s: number): string {
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s - m * 60)).padStart(2, "0")} s`;
}
