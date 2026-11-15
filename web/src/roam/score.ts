import { fmtDose, fmtDur } from "../ui/dom";

/** Everything the debrief scores a walk on. */
export interface WalkResult {
  outOfO2: boolean;
  o2UsedL: number;
  timeS: number;
  falls: number;
  /** fraction of the walking time spent more than 15 m off the planned route */
  offRoute: number;
  /** the radiation alarm, if it sounded: when, when the crew got inside (null: never), the limit, the dose */
  storm: { alertS: number; shelteredS: number | null; shelterMin: number; doseUGy: number } | null;
}

export interface Planned {
  o2L: number;
  timeS: number;
}

/**
 * The debrief's checks: oxygen within 10 % of the plan, EVA time within 15 %, safe walking (no falls,
 * at most 10 % off route) and, when the storm hit, inside within the shelter time.  One star each;
 * none if the suit ran out of oxygen.
 */
export function scoreWalk(r: WalkResult, plan: Planned): { checks: { ok: boolean; text: string }[]; stars: number } {
  const checks = [
    { ok: !r.outOfO2 && r.o2UsedL <= plan.o2L * 1.1, text: `Oxygen within 10 % of the plan (${Math.round(r.o2UsedL)} L used, ${Math.round(plan.o2L)} L planned)` },
    { ok: !r.outOfO2 && r.timeS <= plan.timeS * 1.15, text: `EVA time within 15 % of the plan (${fmtDur(r.timeS)}, ${fmtDur(plan.timeS)} planned)` },
    { ok: r.falls === 0 && r.offRoute <= 0.1, text: `Safe walking: no falls, under 10 % of the walk off the planned route (${r.falls} ${r.falls === 1 ? "fall" : "falls"}, ${Math.round(r.offRoute * 100)} % off route)` },
  ];
  if (r.storm) {
    const took = (r.storm.shelteredS ?? r.timeS) - r.storm.alertS;
    checks.push({ ok: !r.outOfO2 && r.storm.shelteredS !== null && took <= r.storm.shelterMin * 60, text: `Inside within ${r.storm.shelterMin} min of the radiation alarm (${fmtDur(took)}; dose ${fmtDose(r.storm.doseUGy)})` });
  }
  return { checks, stars: r.outOfO2 ? 0 : checks.filter((c) => c.ok).length };
}

/** Oxygen (L) for `seconds` of work at a stop at `watts` (the planner's working rate). */
export function workO2(seconds: number, watts: number, kJPerLitre: number): number {
  return (watts * seconds) / (kJPerLitre * 1000);
}

/** Distance (m) from a point to a box `hx` × `hy` half-sizes centred at (cx, cy); 0 inside. */
export function gapToBox(x: number, y: number, cx: number, cy: number, hx: number, hy: number): number {
  return Math.hypot(Math.max(0, Math.abs(x - cx) - hx), Math.max(0, Math.abs(y - cy) - hy));
}

/** Shortest distance from a point to any of the polylines. */
export function distanceToLegs(x: number, y: number, legs: { x: number; y: number }[][]): number {
  let best = Infinity;
  for (const leg of legs) {
    for (let i = 1; i < leg.length; i++) {
      const a = leg[i - 1];
      const b = leg[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
      best = Math.min(best, Math.hypot(x - a.x - dx * t, y - a.y - dy * t));
    }
  }
  return best;
}
