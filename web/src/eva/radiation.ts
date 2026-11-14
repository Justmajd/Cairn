import type { ReplayData } from "../types";

/**
 * Dose-rate model for the EVA.
 *   background : Curiosity RAD's measured rate before the storm (real, from the PDS archive)
 *   storm      : modeled excess during the 20 May 2024 event (see data-pipeline/build_replay.py)
 * All rates are absorbed dose in micrograys per hour (µGy/h).
 */
export class RadiationModel {
  readonly baseline: number;
  private readonly hours: Float64Array;
  private readonly excess: Float64Array;
  private readonly tailTauH: number;

  constructor(replay: ReplayData) {
    this.baseline = replay.rad.baselineUGyH;
    this.hours = Float64Array.from(replay.model.curve.map((c) => c[0]));
    this.excess = Float64Array.from(replay.model.curve.map((c) => c[1]));
    this.tailTauH = replay.model.slowTauH;
  }

  /** Storm excess (µGy/h) at `h` hours after onset. */
  excessAt(h: number): number {
    if (h <= 0) return 0;
    const n = this.hours.length;
    if (h >= this.hours[n - 1]) return this.excess[n - 1] * Math.exp(-(h - this.hours[n - 1]) / this.tailTauH);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.hours[mid] <= h) lo = mid;
      else hi = mid;
    }
    const t = (h - this.hours[lo]) / (this.hours[hi] - this.hours[lo]);
    return this.excess[lo] + (this.excess[hi] - this.excess[lo]) * t;
  }

  /** Outdoor dose rate at EVA time `tS`; `onsetS` is the EVA time the storm starts (null = no storm). */
  rateAt(tS: number, onsetS: number | null): number {
    return this.baseline + (onsetS === null ? 0 : this.excessAt((tS - onsetS) / 3600));
  }

  /**
   * Dose (µGy) received between two EVA times.  `factor(t)` scales the outdoor rate, e.g. 0.5 while
   * inside the rover.  Trapezoid rule with steps of at most `stepS`.
   */
  dose(t0S: number, t1S: number, onsetS: number | null, factor: (tS: number) => number = () => 1, stepS = 20): number {
    if (t1S <= t0S) return 0;
    const steps = Math.max(1, Math.ceil((t1S - t0S) / stepS));
    const dt = (t1S - t0S) / steps;
    let sum = 0;
    let prev = this.rateAt(t0S, onsetS) * factor(t0S);
    for (let i = 1; i <= steps; i++) {
      const t = t0S + i * dt;
      const cur = this.rateAt(t, onsetS) * factor(t);
      sum += (prev + cur) * 0.5 * dt;
      prev = cur;
    }
    return sum / 3600;
  }
}
