import type { XY } from "../types";

/**
 * A plan handed from the planner to free roam ("Walk it yourself"): the stops in CAIRN's order, the
 * routed legs, and the planned totals the walk is scored against.  Passed through sessionStorage
 * (same tab, survives a reload); the plan link in the address says which plan it is.
 */
export interface RoamPlan {
  site: string;
  hash: string;
  rover: XY;
  startLmst: number;
  stops: { id: string; name: string; short: string; x: number; y: number; dwellMin: number }[];
  /** one polyline per leg: rover → stop 1 → … → rover */
  legs: XY[][];
  planned: { o2L: number; timeS: number; walkTimeS: number; distM: number };
}

const KEY = "cairn:roam-plan";

export function saveRoamPlan(plan: RoamPlan): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(plan));
  } catch {
    // private mode: free roam then routes the plan link itself
  }
}

/** The handed-over plan for this site and this plan link, or null. */
export function loadRoamPlan(site: string, hash: string): RoamPlan | null {
  try {
    const p = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as RoamPlan | null;
    return p && p.site === site && p.hash === hash && Array.isArray(p.legs) ? p : null;
  } catch {
    return null;
  }
}
