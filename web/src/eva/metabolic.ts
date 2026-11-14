import type { EvaParams } from "./params";

/** Largest grade (rise / run) the Minetti polynomial was measured for. */
export const MAX_GRADE = 0.45;

/**
 * Metabolic cost of walking on a slope, J per kg per metre travelled.
 * Minetti, Moia, Roi, Susta & Ferretti (2002), J. Appl. Physiol. 93:1039-1046.
 * `grade` is rise / run in the direction of travel (positive = uphill), clamped to ±0.45.
 */
export function minettiCost(grade: number): number {
  const i = Math.max(-MAX_GRADE, Math.min(MAX_GRADE, grade));
  return ((((280.5 * i - 58.7) * i - 76.8) * i + 51.9) * i + 19.6) * i + 2.5;
}

/** Smallest value of the Minetti cost over the valid grade range (used for the A* heuristic). */
export const MIN_MINETTI: number = (() => {
  let best = Infinity;
  for (let i = -MAX_GRADE; i <= MAX_GRADE; i += 0.001) best = Math.min(best, minettiCost(i));
  return best;
})();

/** Joules needed to walk `distM` metres of ground distance at `grade`, on firm ground. */
export function walkEnergyJ(grade: number, distM: number, p: EvaParams): number {
  return minettiCost(grade) * p.massKg * distM * p.gravityFactor * p.suitFactor;
}

/** Lower bound of walking energy per metre anywhere on the map (admissible A* heuristic). */
export function minEnergyPerMetre(p: EvaParams): number {
  return MIN_MINETTI * p.massKg * p.gravityFactor * p.suitFactor;
}

/**
 * Walking speed in m/s.  Tobler's hiking function (1993): 6·exp(−3.5·|grade + 0.05|) km/h,
 * scaled for a suited walker and slowed on soft or rough ground (`effort` ≥ 1).
 */
export function walkSpeedMs(grade: number, effort: number, p: EvaParams): number {
  const kmh = 6 * Math.exp(-3.5 * Math.abs(grade + 0.05));
  return ((kmh * p.suitSpeedFactor) / (1 + 0.5 * (effort - 1))) / 3.6;
}
