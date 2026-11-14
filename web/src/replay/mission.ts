import { o2Litres, returnO2, ReturnLookup, sampleAtTime, Segment, segmentDuration } from "../eva/budget";
import type { EvaParams } from "../eva/params";
import type { RadiationModel } from "../eva/radiation";
import type { MeasuredPath, Poi } from "../types";

export type Phase = "eva" | "holding" | "to-shelter" | "sheltered" | "complete";

/** Practice emergencies: a suit leak doubles oxygen use; a twisted ankle halves walking speed. */
export type EmergencyKind = "leak" | "ankle";

export interface Emergency {
  kind: EmergencyKind;
  atS: number; // EVA time it happened
  homeDistM: number;
  homeTimeS: number;
  needL: number; // oxygen needed to walk home
  leftL: number; // oxygen left when it happened
}

/** Oxygen-use and walking-time multipliers for each practice emergency. */
export const EMERGENCY_EFFECT: Record<EmergencyKind, { o2: number; slow: number }> = {
  leak: { o2: 2, slow: 1 },
  ankle: { o2: 1, slow: 2 },
};

/** A copy of a walk that takes `factor` times as long (same ground, same energy). */
export function slowedPath(path: MeasuredPath, factor: number): MeasuredPath {
  if (factor === 1) return path;
  return { ...path, time: path.time * factor, samples: path.samples.map((s) => ({ ...s, time: s.time * factor })) };
}

export type MissionEvent =
  | { type: "arrive"; poi: Poi }
  | { type: "depart"; poi: Poi }
  | { type: "storm-onset" }
  | { type: "alert"; rateUGyH: number }
  | { type: "sheltered" }
  | { type: "complete"; aborted: boolean };

export interface Projection {
  alertS: number; // EVA time of the alert
  arriveS: number; // EVA time the astronaut reaches the shelter
  horizonS: number; // comparison horizon: planned end of the EVA (or shelter arrival, if later)
  doseAtAlert: number;
  continueUGy: number; // dose by the horizon if the crew had finished the EVA as planned
  shelterUGy: number; // dose by the horizon when sheltering now
  avoidedUGy: number;
  shelterDistM: number;
}

export interface MissionPose {
  x: number;
  y: number;
  z: number;
  headingRad: number;
  moving: boolean;
  slopeDeg: number;
  sand: number;
}

/** Storm trigger: alert when the outdoor dose rate exceeds this multiple of the background. */
export const ALERT_FACTOR = 3;

/**
 * Simulates one EVA: walks the segments on a mission clock, spends oxygen, accumulates dose and —
 * if a storm is scheduled — raises an alert and lets the app swap in the route to shelter.
 */
export class Mission {
  phase: Phase = "eva";
  t = 0; // EVA elapsed seconds
  segIndex = 0;
  segT = 0;
  distanceM = 0;
  o2UsedL = 0;
  doseUGy = 0;
  visited: string[] = [];
  alertS: number | null = null;
  projection: Projection | null = null;
  emergency: Emergency | null = null;
  /** Oxygen-use and walking-time multipliers (1 unless an emergency is running). */
  o2Factor = 1;
  slowFactor = 1;
  readonly plannedEndS: number;
  readonly plannedSegments: Segment[];
  private segments: Segment[];
  private lastHeading = 0;
  private stormAnnounced = false;

  constructor(
    segments: Segment[],
    readonly rad: RadiationModel,
    readonly params: EvaParams,
    readonly lookup: ReturnLookup,
    readonly stormOnsetS: number | null,
    readonly shieldAt: (x: number, y: number) => number = () => 1,
  ) {
    this.segments = segments.slice();
    this.plannedSegments = segments.slice();
    this.plannedEndS = segments.reduce((s, seg) => s + segmentDuration(seg), 0);
  }

  get segment(): Segment | undefined {
    return this.segments[this.segIndex];
  }

  get sheltered(): boolean {
    const seg = this.segment;
    return this.phase === "sheltered" || (!!seg && seg.kind === "dwell" && seg.sheltered);
  }

  get stormActive(): boolean {
    return this.stormOnsetS !== null && this.t >= this.stormOnsetS;
  }

  /** Dose rate the astronaut is receiving right now (µGy/h), including shelter and terrain shielding. */
  get doseRate(): number {
    if (this.sheltered) return this.rad.rateAt(this.t, this.stormOnsetS) * this.params.shelterFactor;
    const p = this.pose();
    return this.rad.rateAt(this.t, this.stormOnsetS) * this.shieldAt(p.x, p.y);
  }

  get outdoorRate(): number {
    return this.rad.rateAt(this.t, this.stormOnsetS);
  }

  get o2UsableL(): number {
    return this.params.o2SupplyL * (1 - this.params.reserveFraction);
  }

  pose(): MissionPose {
    const seg = this.segment;
    if (!seg) {
      const last = this.segments[this.segments.length - 1];
      const p = last.kind === "walk" ? last.path.samples[last.path.samples.length - 1] : { x: last.poi.x, y: last.poi.y, z: 0 };
      return { x: p.x, y: p.y, z: p.z, headingRad: this.lastHeading, moving: false, slopeDeg: 0, sand: 0 };
    }
    if (seg.kind === "walk") {
      const s = sampleAtTime(seg.path, this.segT);
      this.lastHeading = s.headingRad;
      return { x: s.x, y: s.y, z: s.z, headingRad: s.headingRad, moving: this.phase !== "holding", slopeDeg: s.slopeDeg, sand: s.sand };
    }
    return { x: seg.poi.x, y: seg.poi.y, z: 0, headingRad: this.lastHeading, moving: false, slopeDeg: 0, sand: 0 };
  }

  /** Position `lagS` seconds behind on the current walk — where the buddy is. */
  buddyPose(lagS = 9): { x: number; y: number } {
    const seg = this.segment;
    if (seg && seg.kind === "walk") {
      const s = sampleAtTime(seg.path, Math.max(0, this.segT - lagS));
      return { x: s.x, y: s.y };
    }
    const p = this.pose();
    return { x: p.x + 2.5, y: p.y - 1.5 };
  }

  /** The stop being walked to (or worked at) and the distance / time left to reach it. */
  next(): { poi: Poi | null; distM: number; etaS: number; label: string } {
    const seg = this.segment;
    if (!seg) return { poi: null, distM: 0, etaS: 0, label: "EVA complete" };
    if (seg.kind === "dwell") return { poi: seg.poi, distM: 0, etaS: seg.durationS - this.segT, label: seg.sheltered ? "Sheltering" : "Science at" };
    const s = sampleAtTime(seg.path, this.segT);
    return { poi: seg.to, distM: seg.path.distance - s.dist, etaS: seg.path.time - this.segT, label: "Walking to" };
  }

  /** Oxygen needed to walk home from a position, with any emergency multipliers. */
  homeO2L(x: number, y: number): number {
    if (this.o2Factor === 1 && this.slowFactor === 1) return returnO2(x, y, this.lookup, this.params);
    const r = this.lookup(x, y);
    return o2Litres(r.energyJ, r.timeS * this.slowFactor, this.params.restingW, this.params) * this.o2Factor;
  }

  /** Oxygen left after walking home from the current position and keeping the reserve (litres). */
  walkBackMarginL(): number {
    const p = this.pose();
    return this.o2UsableL - this.o2UsedL - this.homeO2L(p.x, p.y);
  }

  returnTimeS(): number {
    const p = this.pose();
    return this.lookup(p.x, p.y).timeS * this.slowFactor;
  }

  /** Stop the clock (while the app finds the way home). */
  hold(): void {
    if (this.phase === "eva") this.phase = "holding";
  }

  /**
   * Practice emergency: from now on oxygen use and walking time change, and the rest of the plan is
   * replaced by the walk home on `path` (measured at normal pace; it is slowed here if need be).
   */
  emergencyHome(kind: EmergencyKind, path: MeasuredPath, shelter: Poi): Emergency {
    const fx = EMERGENCY_EFFECT[kind];
    this.o2Factor = fx.o2;
    this.slowFactor = fx.slow;
    const home = slowedPath(path, fx.slow);
    this.emergency = {
      kind, atS: this.t, homeDistM: path.distance, homeTimeS: home.time,
      needL: o2Litres(home.energy, home.time, this.params.restingW, this.params) * fx.o2,
      leftL: this.params.o2SupplyL - this.o2UsedL,
    };
    this.segments = [
      ...this.segments.slice(0, this.segIndex),
      { kind: "walk", path: home, to: shelter, label: "Rover" },
      { kind: "dwell", poi: shelter, durationS: 120, sheltered: true },
    ];
    this.segT = 0;
    this.phase = "to-shelter";
    return this.emergency;
  }

  /** Advance the mission clock by `dtSim` seconds.  Returns what happened. */
  advance(dtSim: number): MissionEvent[] {
    const events: MissionEvent[] = [];
    let left = dtSim;
    while (left > 1e-6 && this.phase !== "complete" && this.phase !== "holding") {
      const seg = this.segment;
      if (!seg) {
        this.phase = "complete";
        events.push({ type: "complete", aborted: this.alertS !== null || this.emergency !== null });
        break;
      }
      const dur = segmentDuration(seg);
      const step = Math.min(left, 10, dur - this.segT);
      const t0 = this.t;
      const t1 = t0 + step;

      if (seg.kind === "walk") {
        const a = sampleAtTime(seg.path, this.segT);
        const b = sampleAtTime(seg.path, this.segT + step);
        this.o2UsedL += o2Litres(b.energy - a.energy, step, this.params.restingW, this.params) * this.o2Factor;
        this.distanceM += b.dist - a.dist;
      } else {
        // inside the rover the suit is off its own supply
        this.o2UsedL += o2Litres(0, step, seg.sheltered ? this.params.restingW : this.params.workingW, this.params) * (seg.sheltered ? 1 : this.o2Factor);
      }
      let factor = this.params.shelterFactor;
      if (!this.sheltered) {
        const p = this.pose();
        factor = this.shieldAt(p.x, p.y);
      }
      this.doseUGy += this.rad.dose(t0, t1, this.stormOnsetS, () => factor, 5);

      this.t = t1;
      this.segT += step;
      left -= step;

      if (this.stormOnsetS !== null && !this.stormAnnounced && this.t >= this.stormOnsetS) {
        this.stormAnnounced = true;
        events.push({ type: "storm-onset" });
      }
      if (this.alertS === null && this.emergency === null && this.stormAnnounced && this.outdoorRate >= ALERT_FACTOR * this.rad.baseline) {
        this.alertS = this.t;
        this.phase = "holding"; // freeze until the app has the shelter route
        events.push({ type: "alert", rateUGyH: this.outdoorRate });
        break;
      }

      if (this.segT >= dur - 1e-6) {
        if (seg.kind === "walk") {
          if (seg.to) events.push({ type: "arrive", poi: seg.to });
          if (this.phase === "to-shelter") {
            this.phase = "sheltered";
            events.push({ type: "sheltered" });
          }
        } else {
          if (!seg.sheltered) {
            this.visited.push(seg.poi.id);
            events.push({ type: "depart", poi: seg.poi });
          }
        }
        this.segIndex++;
        this.segT = 0;
        if (this.segIndex >= this.segments.length) {
          this.phase = "complete";
          events.push({ type: "complete", aborted: this.alertS !== null || this.emergency !== null });
        }
      }
    }
    return events;
  }

  /** Replace the rest of the plan with the walk to shelter, then wait out the planned EVA window inside. */
  reroute(path: MeasuredPath, shelter: Poi): Projection {
    const alertS = this.t;
    const arriveS = alertS + path.time;
    const horizonS = Math.max(this.plannedEndS, arriveS + 600);
    const f = this.params.shelterFactor;
    const continueUGy =
      this.doseUGy + this.rad.dose(alertS, this.plannedEndS, this.stormOnsetS) + this.rad.dose(this.plannedEndS, horizonS, this.stormOnsetS, () => f);
    const along = (t: number) => {
      const s = sampleAtTime(path, t - alertS);
      return this.shieldAt(s.x, s.y);
    };
    const shelterUGy = this.doseUGy + this.rad.dose(alertS, arriveS, this.stormOnsetS, along) + this.rad.dose(arriveS, horizonS, this.stormOnsetS, () => f);
    this.projection = {
      alertS, arriveS, horizonS, doseAtAlert: this.doseUGy, continueUGy, shelterUGy,
      avoidedUGy: continueUGy - shelterUGy, shelterDistM: path.distance,
    };
    this.segments = [
      ...this.segments.slice(0, this.segIndex),
      { kind: "walk", path, to: shelter, label: "Shelter" },
      { kind: "dwell", poi: shelter, durationS: horizonS - arriveS, sheltered: true },
    ];
    this.segT = 0;
    this.phase = "to-shelter";
    return this.projection;
  }

  /** Objectives of the original plan that were not completed. */
  remaining(): Poi[] {
    const out: Poi[] = [];
    for (const seg of this.plannedSegments) {
      if (seg.kind === "dwell" && !seg.sheltered && !this.visited.includes(seg.poi.id)) out.push(seg.poi);
    }
    return out;
  }
}
