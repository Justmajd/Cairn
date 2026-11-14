import type { MeasuredPath, PathSample, Poi } from "../types";
import type { EvaParams } from "./params";

/** One step of the EVA: walking a leg, or working at a stop. */
export type Segment =
  | { kind: "walk"; path: MeasuredPath; to: Poi | null; label: string }
  | { kind: "dwell"; poi: Poi; durationS: number; sheltered: boolean };

export function segmentDuration(seg: Segment): number {
  return seg.kind === "walk" ? seg.path.time : seg.durationS;
}

/** Litres of O2 for `walkJ` of walking energy plus `restS` seconds at `watts`. */
export function o2Litres(walkJ: number, restS: number, watts: number, p: EvaParams): number {
  return (walkJ + watts * restS) / (p.kJPerLitreO2 * 1000);
}

/** O2 used by a whole walking segment: locomotion energy + resting metabolism for its duration. */
export function walkO2(path: MeasuredPath, p: EvaParams): number {
  return o2Litres(path.energy, path.time, p.restingW, p);
}

export interface WalkBack {
  minMarginL: number; // smallest O2 margin anywhere on the plan (negative = unsafe)
  atTimeS: number; // EVA time of that minimum
  maxReturnMin: number; // longest walk back to the shelter from anywhere on the plan
}

export interface EvaBudget {
  segments: Segment[];
  distanceM: number;
  walkTimeS: number;
  stopTimeS: number;
  totalTimeS: number;
  walkEnergyJ: number;
  o2UsedL: number;
  o2UsableL: number; // supply minus reserve
  o2Fraction: number; // used / supply
  climbM: number;
  maxSlopeDeg: number;
  sandM: number;
  blockedM: number;
  walkBack: WalkBack;
  withinO2: boolean;
  withinTime: boolean;
  feasible: boolean;
}

export interface ReturnLookup {
  /** Seconds and joules needed to walk from (x, y) back to the shelter; Infinity if unreachable. */
  (x: number, y: number): { timeS: number; energyJ: number };
}

/** O2 needed to walk back to the shelter from a position. */
export function returnO2(x: number, y: number, lookup: ReturnLookup, p: EvaParams): number {
  const r = lookup(x, y);
  return o2Litres(r.energyJ, r.timeS, p.restingW, p);
}

export function buildBudget(segments: Segment[], p: EvaParams, lookup: ReturnLookup): EvaBudget {
  let distanceM = 0;
  let walkTimeS = 0;
  let stopTimeS = 0;
  let walkEnergyJ = 0;
  let o2 = 0;
  let climbM = 0;
  let maxSlopeDeg = 0;
  let sandM = 0;
  let blockedM = 0;
  let t = 0;
  const walkBack: WalkBack = { minMarginL: Infinity, atTimeS: 0, maxReturnMin: 0 };
  const usable = p.o2SupplyL * (1 - p.reserveFraction);

  const check = (x: number, y: number, usedL: number, timeS: number) => {
    const r = lookup(x, y);
    const margin = usable - usedL - o2Litres(r.energyJ, r.timeS, p.restingW, p);
    if (margin < walkBack.minMarginL) {
      walkBack.minMarginL = margin;
      walkBack.atTimeS = timeS;
    }
    if (Number.isFinite(r.timeS)) walkBack.maxReturnMin = Math.max(walkBack.maxReturnMin, r.timeS / 60);
  };

  for (const seg of segments) {
    if (seg.kind === "walk") {
      const path = seg.path;
      const stride = Math.max(1, Math.floor(path.samples.length / 200));
      for (let i = 0; i < path.samples.length; i += stride) {
        const s = path.samples[i];
        check(s.x, s.y, o2 + o2Litres(s.energy, s.time, p.restingW, p), t + s.time);
      }
      distanceM += path.distance;
      walkTimeS += path.time;
      walkEnergyJ += path.energy;
      climbM += path.climb;
      maxSlopeDeg = Math.max(maxSlopeDeg, path.maxSlopeDeg);
      sandM += path.sandM;
      blockedM += path.blockedM;
      o2 += walkO2(path, p);
      t += path.time;
    } else {
      o2 += o2Litres(0, seg.durationS, p.workingW, p);
      stopTimeS += seg.durationS;
      t += seg.durationS;
      check(seg.poi.x, seg.poi.y, o2, t);
    }
  }
  if (!Number.isFinite(walkBack.minMarginL)) walkBack.minMarginL = usable;

  const withinO2 = o2 <= usable && walkBack.minMarginL >= 0;
  const withinTime = t <= p.maxEvaH * 3600;
  return {
    segments, distanceM, walkTimeS, stopTimeS, totalTimeS: t, walkEnergyJ,
    o2UsedL: o2, o2UsableL: usable, o2Fraction: o2 / p.o2SupplyL,
    climbM, maxSlopeDeg, sandM, blockedM, walkBack, withinO2, withinTime,
    feasible: withinO2 && withinTime && blockedM === 0,
  };
}

/** Sample of a measured path at walking time `tS` (linear interpolation between samples). */
export function sampleAtTime(path: MeasuredPath, tS: number): PathSample & { headingRad: number } {
  const s = path.samples;
  if (s.length === 1 || tS <= 0) return { ...s[0], headingRad: heading(s, 0) };
  if (tS >= path.time) return { ...s[s.length - 1], headingRad: heading(s, s.length - 2) };
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].time <= tS) lo = mid;
    else hi = mid;
  }
  const a = s[lo];
  const b = s[hi];
  const f = b.time > a.time ? (tS - a.time) / (b.time - a.time) : 0;
  const mix = (u: number, v: number) => u + (v - u) * f;
  return {
    x: mix(a.x, b.x), y: mix(a.y, b.y), z: mix(a.z, b.z),
    dist: mix(a.dist, b.dist), energy: mix(a.energy, b.energy), time: tS,
    slopeDeg: b.slopeDeg, gradeDeg: b.gradeDeg, sand: b.sand, blocked: b.blocked,
    headingRad: heading(s, lo),
  };
}

/** Compass-style heading (radians, 0 = north, clockwise) of the path at sample `i`. */
function heading(s: PathSample[], i: number): number {
  const a = s[Math.max(0, Math.min(s.length - 2, i))];
  const b = s[Math.max(1, Math.min(s.length - 1, i + 1))];
  return Math.atan2(b.x - a.x, b.y - a.y);
}
