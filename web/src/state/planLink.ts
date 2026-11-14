import type { XY } from "../types";

/**
 * A plan as it travels in the URL hash:
 *   #stops=cheyava,serpentine&add=812_1460&t=9.5&storm=0&buddy=1&relay=1&rover=903_1101&dwell=cheyava_45
 * Custom stops and the rover position are local metres.  Defaults are left out, so a fresh plan
 * gives a short link.  Parsing never throws: anything malformed is simply dropped.
 */
export interface PlanLink {
  stops: string[]; // ids of the site's own stops, in selection order
  add: XY[]; // stops placed on the map
  startLmst: number | null; // null: the site's default start time
  storm: boolean;
  buddy: boolean;
  relay: boolean;
  rover: XY | null; // null: where the site data parks it
  dwell: Record<string, number>; // minutes on site where the crew changed them, by stop id
}

const xy = (p: XY) => `${Math.round(p.x)}_${Math.round(p.y)}`;

export function formatPlanLink(l: PlanLink): string {
  const parts = [`stops=${l.stops.map(encodeURIComponent).join(",")}`];
  if (l.add.length) parts.push(`add=${l.add.map(xy).join(",")}`);
  if (l.startLmst !== null) parts.push(`t=${+l.startLmst.toFixed(2)}`);
  if (!l.storm) parts.push("storm=0");
  if (l.buddy) parts.push("buddy=1");
  if (l.relay) parts.push("relay=1");
  if (l.rover) parts.push(`rover=${xy(l.rover)}`);
  const dwell = Object.entries(l.dwell);
  if (dwell.length) parts.push(`dwell=${dwell.map(([id, m]) => `${encodeURIComponent(id)}_${Math.round(m)}`).join(",")}`);
  return parts.join("&");
}

function parseXY(s: string): XY | null {
  const [x, y] = s.split("_").map(Number);
  return s.includes("_") && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** null when the hash holds no plan at all. */
export function parsePlanLink(hash: string): PlanLink | null {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  if (!q.has("stops") && !q.has("add")) return null;
  const t = Number(q.get("t"));
  return {
    stops: (q.get("stops") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    add: (q.get("add") ?? "").split(",").map(parseXY).filter((p): p is XY => p !== null),
    startLmst: q.has("t") && Number.isFinite(t) && t >= 5 && t <= 19 ? t : null,
    storm: q.get("storm") !== "0",
    buddy: q.get("buddy") === "1",
    relay: q.get("relay") === "1",
    rover: parseXY(q.get("rover") ?? ""),
    dwell: Object.fromEntries(
      (q.get("dwell") ?? "")
        .split(",")
        .map((item) => [item.slice(0, item.lastIndexOf("_")), Number(item.slice(item.lastIndexOf("_") + 1))] as const)
        .filter(([id, m]) => id && Number.isFinite(m) && m >= 1 && m <= 240),
    ),
  };
}
