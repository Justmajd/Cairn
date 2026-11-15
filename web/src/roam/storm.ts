import type { RadiationModel } from "../eva/radiation";

/**
 * A solar particle event during a free-roam mission, replayed from the 20 May 2024 storm (the same
 * RadiationModel the planner uses: Curiosity RAD's measured background plus the modelled storm).
 *
 * The storm starts at `onsetS` on the EVA clock.  The suit's dosimeter raises the alarm when the dose
 * rate passes `alertFactor` × background; from then the crew has `shelterMin` minutes to be inside the
 * rover (CAIRN's planning rule).  Earth's warning arrives one light time after the alarm on Mars.
 * Pure state and arithmetic: tested in storm.test.ts.
 */
export class RoamStorm {
  readonly alertS: number;
  readonly deadlineS: number;
  doseUGy = 0;
  /** dose the crew would have taken by staying out until the deadline (for the debrief) */
  shelteredS: number | null = null;

  constructor(
    private readonly rad: RadiationModel,
    readonly onsetS: number,
    readonly shelterMin = 30,
    readonly alertFactor = 3,
    readonly shelterFactor = 0.5,
  ) {
    // the first minute the rate passes the alarm level
    let t = onsetS;
    while (rad.rateAt(t, onsetS) < rad.baseline * alertFactor && t < onsetS + 6 * 3600) t += 10;
    this.alertS = t;
    this.deadlineS = t + shelterMin * 60;
  }

  get baseline(): number {
    return this.rad.baseline;
  }

  rate(tS: number): number {
    return this.rad.rateAt(tS, this.onsetS);
  }

  alarmed(tS: number): boolean {
    return tS >= this.alertS;
  }

  /** Seconds left to get inside (negative: late). */
  leftS(tS: number): number {
    return this.deadlineS - tS;
  }

  /** Add the dose from t0 to t1 (outside, or inside the rover with its shielding). */
  accumulate(t0: number, t1: number, inside: boolean): void {
    if (t1 <= t0) return;
    this.doseUGy += this.rad.dose(t0, t1, this.onsetS, () => (inside ? this.shelterFactor : 1));
  }

  board(tS: number): void {
    if (this.shelteredS === null && this.alarmed(tS)) this.shelteredS = tS;
  }

  /** Dose avoided by going inside at `shelteredS` rather than staying out for `untilS` (µGy). */
  avoided(untilS: number): number {
    if (this.shelteredS === null || untilS <= this.shelteredS) return 0;
    return this.rad.dose(this.shelteredS, untilS, this.onsetS) * (1 - this.shelterFactor);
  }
}
