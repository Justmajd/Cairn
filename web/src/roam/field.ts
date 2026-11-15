/**
 * Field work in free roam: the jobs a crew does on the way between stops, built only from the site's
 * own data, so the walk is real exploration and not just getting from A to B.
 *
 *  - Field reading (hold E away from a stop): what the orbital maps say about the ground under your
 *    boots — CRISM mineral strength (Jezero), the USGS geologic unit, CAIRN's sand map, and how much of
 *    the sky the terrain blocks (CAIRN's shielding map, the same one the storm uses).
 *  - Mineral hunt (CRISM sites): find readings in the top 5 % of each mineral's detections.  A spectral
 *    signal nearby (within 40 m) and the nearest strong patch guide the search.
 *  - Geologic contacts: walk onto three different mapped units.
 *  - The rover's tracks: reach the route the real rover drove between its logged stops.
 *  - Soil tests: three readings at least 100 m apart.
 *  - Sheltered ground: find the 1 % of the area where the terrain blocks the most sky (storm refuge).
 *  - Relay mast: stand it up where it sees the rover, and use it to talk from radio shadow.
 *
 * Everything here is pure arithmetic over the grids (tested in field.test.ts); roam.ts draws it.
 */

export interface FieldGrid {
  n: number;
  cell: number;
  size: number;
  nodeAt(x: number, y: number): number;
  sand: Uint8Array;
  slope: Uint8Array;
  shield: Uint8Array | null;
}

export interface FieldSources {
  /** RGBA per node: olivine, Fe/Mg clay, carbonate strength (0..255), imaged by CRISM (alpha > 0) */
  minerals: Uint8Array | null;
  mineralBands: { key: string; name: string }[];
  geology: Uint8Array | null;
  units: { id: number; name: string; symbol: string }[];
  /** the real rover's traverse: [x, y, sol] in local metres */
  traverse: [number, number, number][];
  roverName: string | null;
}

export interface Reading {
  x: number;
  y: number;
  sandPct: number;
  slopeDeg: number;
  soil: "bedrock" | "mixed" | "sand";
  /** % of the open-sky dose the terrain blocks here */
  blockedPct: number;
  unit: { id: number; name: string; symbol: string } | null;
  /** per band: share of that mineral's detections this reading is stronger than (0..1), or null outside CRISM's footprint */
  minerals: { key: string; name: string; rank: number; detected: boolean }[] | null;
}

export interface Find {
  id: string;
  title: string;
  text: string;
  t: number;
  x: number;
  y: number;
}

export interface Task {
  id: string;
  title: string;
  /** live progress or hint */
  detail: string;
  done: boolean;
}

/** Points worth walking to (x, y pairs), thinned to keep the nearest-point search cheap. */
class Targets {
  readonly xy: Float32Array;
  constructor(points: number[]) {
    this.xy = new Float32Array(points);
  }
  get count(): number {
    return this.xy.length / 2;
  }
  nearest(x: number, y: number): { d: number; x: number; y: number } | null {
    let best = Infinity;
    let bi = -1;
    for (let i = 0; i < this.xy.length; i += 2) {
      const d = (this.xy[i] - x) ** 2 + (this.xy[i + 1] - y) ** 2;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    return bi < 0 ? null : { d: Math.sqrt(best), x: this.xy[bi], y: this.xy[bi + 1] };
  }
}

/** A mineral reading counts as a find in the top 5 % of that mineral's detections. */
export const MINERAL_TOP = 0.95;
/** Sheltered ground: the 1 % of the area where the terrain blocks the most sky. */
export const SHELTER_TOP = 0.99;
/** Within this distance of the rover's route counts as walking on it (m), and how far to follow it. */
export const TRACK_M = 5;
export const TRACK_FOLLOW_M = 50;
/** Soil readings must be this far apart to count as separate tests (m). */
export const SOIL_APART_M = 100;
export const SOIL_TESTS = 3;
/** The spectral signal looks this far around the walker (m). */
export const SIGNAL_M = 40;

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export function bearingName(dx: number, dy: number): string {
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
/** "Olivine" → "olivine", "Fe/Mg clay" stays. */
export const lc = (name: string): string => (/^[A-Z][a-z]+(\s|$)/.test(name) ? name[0].toLowerCase() + name.slice(1) : name);
const roundM = (d: number) => (d < 50 ? `${Math.round(d)} m` : `${Math.round(d / 50) * 50} m`);
const where = (from: { x: number; y: number }, to: { x: number; y: number }, d: number) => `${roundM(d)} ${bearingName(to.x - from.x, to.y - from.y)}`;

/** Distance from a point to a segment, and the parameter along it (0..1). */
function toSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): { d: number; f: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const f = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return { d: Math.hypot(x - (ax + dx * f), y - (ay + dy * f)), f };
}

export class FieldWork {
  readonly finds: Find[] = [];
  readonly readings: Reading[] = [];
  readonly unitsVisited = new Set<number>();
  relayUsed = false;
  relayUp = false;
  tracksFound: number | null = null; // sol of the drive followed
  /** metres walked along the rover's route so far, and where the last step on it was */
  trackM = 0;
  private lastOnTrack: { x: number; y: number } | null = null;

  /** sorted per band: values of the cells where CRISM detected the mineral (for ranks) */
  private readonly detections: Uint8Array[] = [];
  private readonly mineralThreshold: number[] = [];
  private readonly mineralTargets: Targets[] = [];
  readonly shelterBlockedPct: number;
  private readonly shelterTargets: Targets | null;
  private readonly unitTargets = new Map<number, Targets>();
  readonly unitGoal: number;

  constructor(private readonly g: FieldGrid, private readonly src: FieldSources) {
    const { n, cell, size } = g;
    const xy = (i: number): [number, number] => [(i % n) * cell, size - Math.floor(i / n) * cell];
    // ---- minerals: ranks against the detections, and where the strong ones are
    if (src.minerals) {
      src.mineralBands.forEach((_, b) => {
        const vals: number[] = [];
        for (let i = 0; i < n * n; i++) if (src.minerals![i * 4 + 3] > 0 && src.minerals![i * 4 + b] > 0) vals.push(src.minerals![i * 4 + b]);
        const sorted = Uint8Array.from(vals).sort();
        this.detections.push(sorted);
        const thr = sorted.length ? Math.max(1, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * MINERAL_TOP))]) : 256;
        this.mineralThreshold.push(thr);
        const pts: number[] = [];
        for (let i = 0; i < n * n; i += 1) if (src.minerals![i * 4 + 3] > 0 && src.minerals![i * 4 + b] >= thr) pts.push(...xy(i));
        this.mineralTargets.push(new Targets(thin(pts, 3000)));
      });
    }
    // ---- sheltered ground
    if (g.shield) {
      const hist = new Uint32Array(256);
      for (let i = 0; i < n * n; i++) hist[g.shield[i]]++;
      // lowest dose factors first: the cut-off below which 1 % of the area lies
      let acc = 0;
      let cut = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= n * n * (1 - SHELTER_TOP)) {
          cut = v;
          break;
        }
      }
      this.shelterBlockedPct = Math.round((1 - cut / 255) * 1000) / 10;
      const pts: number[] = [];
      for (let i = 0; i < n * n; i++) if (g.shield[i] <= cut) pts.push(...xy(i));
      this.shelterTargets = new Targets(thin(pts, 3000));
    } else {
      this.shelterBlockedPct = 0;
      this.shelterTargets = null;
    }
    // ---- geologic units
    if (src.geology) {
      const byUnit = new Map<number, number[]>();
      for (let r = 0; r < n; r += 4)
        for (let c = 0; c < n; c += 4) {
          const id = src.geology[r * n + c];
          if (!src.units.some((u) => u.id === id)) continue;
          if (!byUnit.has(id)) byUnit.set(id, []);
          byUnit.get(id)!.push(c * cell, size - r * cell);
        }
      for (const [id, pts] of byUnit) this.unitTargets.set(id, new Targets(thin(pts, 2000)));
    }
    this.unitGoal = Math.min(3, this.unitTargets.size);
  }

  get hasMinerals(): boolean {
    return this.detections.some((d) => d.length > 0);
  }

  /** What the maps say about the ground at (x, y). */
  readingAt(x: number, y: number): Reading {
    const { g, src } = this;
    const i = g.nodeAt(x, y);
    const sandPct = Math.round((g.sand[i] / 255) * 100);
    const blockedPct = g.shield ? Math.round((1 - g.shield[i] / 255) * 1000) / 10 : 0;
    const unitId = src.geology ? src.geology[i] : -1;
    const unit = src.units.find((u) => u.id === unitId) ?? null;
    let minerals: Reading["minerals"] = null;
    if (src.minerals && src.minerals[i * 4 + 3] > 0) {
      minerals = src.mineralBands.map((b, k) => {
        const v = src.minerals![i * 4 + k];
        return { key: b.key, name: b.name, rank: rankOf(this.detections[k], v), detected: v > 0 };
      });
    }
    return { x, y, sandPct, slopeDeg: g.slope[i], soil: sandPct < 15 ? "bedrock" : sandPct > 60 ? "sand" : "mixed", blockedPct, unit, minerals };
  }

  /** The strongest spectral signal within SIGNAL_M, per mineral (rank 0..1), or null outside CRISM's footprint. */
  signal(x: number, y: number): { key: string; name: string; rank: number; bearing: string | null }[] | null {
    const { g, src } = this;
    if (!src.minerals) return null;
    const step = Math.max(g.cell, 6);
    let seen = false;
    const best = src.mineralBands.map((b) => ({ key: b.key, name: b.name, rank: 0, bearing: null as string | null }));
    for (let dy = -SIGNAL_M; dy <= SIGNAL_M; dy += step)
      for (let dx = -SIGNAL_M; dx <= SIGNAL_M; dx += step) {
        if (dx * dx + dy * dy > SIGNAL_M * SIGNAL_M) continue;
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px > g.size || py > g.size) continue;
        const i = g.nodeAt(px, py);
        if (src.minerals[i * 4 + 3] === 0) continue;
        seen = true;
        best.forEach((b, k) => {
          const r = rankOf(this.detections[k], src.minerals![i * 4 + k]);
          if (r > b.rank) {
            b.rank = r;
            b.bearing = Math.hypot(dx, dy) < 4 ? "here" : bearingName(dx, dy);
          }
        });
      }
    return seen ? best : null;
  }

  /** Nearest strong patch of a mineral (for the hint). */
  nearestMineral(k: number, x: number, y: number): { d: number; x: number; y: number } | null {
    return this.mineralTargets[k]?.nearest(x, y) ?? null;
  }

  /** Distance to the rover's route, and the sol of that drive. */
  tracksNear(x: number, y: number): { d: number; sol: number; x: number; y: number } | null {
    const tr = this.src.traverse;
    let best: { d: number; sol: number; x: number; y: number } | null = null;
    for (let i = 1; i < tr.length; i++) {
      const [ax, ay] = tr[i - 1];
      const [bx, by, sol] = tr[i];
      // a gap longer than a few hundred metres between logged stops is not one drive we can draw
      if (Math.hypot(bx - ax, by - ay) > 400) continue;
      const s = toSegment(x, y, ax, ay, bx, by);
      if (!best || s.d < best.d) best = { d: s.d, sol, x: ax + (bx - ax) * s.f, y: ay + (by - ay) * s.f };
    }
    return best;
  }

  get hasTracks(): boolean {
    return this.src.traverse.some(([x, y]) => x >= 0 && y >= 0 && x <= this.g.size && y <= this.g.size);
  }

  /** Walking over the ground: geologic contacts and the rover's tracks are found just by getting there. */
  walk(x: number, y: number, t: number): Find[] {
    const out: Find[] = [];
    const i = this.g.nodeAt(x, y);
    if (this.src.geology) {
      const id = this.src.geology[i];
      const u = this.src.units.find((v) => v.id === id);
      if (u && !this.unitsVisited.has(id)) {
        const first = this.unitsVisited.size === 0;
        this.unitsVisited.add(id);
        if (!first) out.push(this.add({ id: `unit-${id}`, title: `Geologic contact: ${u.name} (${u.symbol})`, text: `You crossed onto a new mapped unit. ${this.unitsVisited.size} of ${this.unitGoal} units walked.`, t, x, y }));
      }
    }
    if (this.tracksFound === null && this.hasTracks) {
      const tr = this.tracksNear(x, y);
      if (tr && tr.d <= TRACK_M) {
        if (this.lastOnTrack) this.trackM += Math.min(5, Math.hypot(x - this.lastOnTrack.x, y - this.lastOnTrack.y));
        this.lastOnTrack = { x, y };
        if (this.trackM >= TRACK_FOLLOW_M) {
          this.tracksFound = tr.sol;
          out.push(this.add({ id: "tracks", title: `Followed ${this.src.roverName ?? "the rover"}'s route, sol ${tr.sol}`, text: `${TRACK_FOLLOW_M} m along the line ${this.src.roverName ?? "the rover"} drove on sol ${tr.sol}, from its logged stops.`, t, x, y }));
        }
      } else this.lastOnTrack = null;
    }
    return out;
  }

  /** A field reading: logged, and checked for finds (minerals, sheltered ground, soil tests). */
  scan(x: number, y: number, t: number): { reading: Reading; finds: Find[] } {
    const r = this.readingAt(x, y);
    const fresh = this.readings.every((o) => Math.hypot(o.x - x, o.y - y) >= SOIL_APART_M);
    this.readings.push(r);
    const out: Find[] = [];
    if (fresh) {
      const k = this.soilTests;
      if (k <= SOIL_TESTS) out.push(this.add({ id: `soil-${k}`, title: `Soil test ${k} of ${SOIL_TESTS}: ${r.soil === "sand" ? "loose sand" : r.soil}`, text: `${r.sandPct} % sand on CAIRN's map, ${r.slopeDeg}° slope.`, t, x, y }));
    }
    r.minerals?.forEach((m, k) => {
      const id = `mineral-${m.key}`;
      if (m.detected && m.rank >= MINERAL_TOP && !this.has(id)) {
        const v = this.src.minerals![this.g.nodeAt(x, y) * 4 + k];
        if (v >= this.mineralThreshold[k]) out.push(this.add({ id, title: `Strong ${lc(m.name)} signal`, text: `Stronger than ${Math.floor(m.rank * 100)} % of CRISM's ${lc(m.name)} detections in this area. Worth a sample on a later EVA.`, t, x, y }));
      }
    });
    if (this.g.shield && !this.has("shelter") && r.blockedPct >= this.shelterBlockedPct && r.blockedPct > 0) {
      out.push(this.add({ id: "shelter", title: "Sheltered ground", text: `The terrain blocks ${r.blockedPct} % of the sky's radiation here, among the best 1 % of the area. A place to wait out a storm if the rover is far.`, t, x, y }));
    }
    return { reading: r, finds: out };
  }

  /** Readings at least SOIL_APART_M apart. */
  get soilTests(): number {
    const kept: Reading[] = [];
    for (const r of this.readings) if (kept.every((o) => Math.hypot(o.x - r.x, o.y - r.y) >= SOIL_APART_M)) kept.push(r);
    return kept.length;
  }

  has(id: string): boolean {
    return this.finds.some((f) => f.id === id);
  }

  private add(f: Find): Find {
    this.finds.push(f);
    return f;
  }

  /** The task list, with live hints from where the walker stands. */
  tasks(x: number, y: number, inRadioShadow: boolean): Task[] {
    const here = { x, y };
    const out: Task[] = [];
    if (this.hasMinerals) {
      this.src.mineralBands.forEach((b, k) => {
        if (!this.detections[k].length) return;
        const done = this.has(`mineral-${b.key}`);
        const near = done ? null : this.nearestMineral(k, x, y);
        out.push({ id: `mineral-${b.key}`, title: `Find strong ${lc(b.name)}`, detail: done ? "found" : near ? (near.d < 6 ? "here — hold E for a reading" : `nearest strong patch ${where(here, near, near.d)}`) : "none in reach", done });
      });
    }
    if (this.unitGoal >= 2) {
      const done = this.unitsVisited.size >= this.unitGoal;
      let hint = "";
      if (!done) {
        let best: { d: number; x: number; y: number; name: string } | null = null;
        for (const [id, tg] of this.unitTargets) {
          if (this.unitsVisited.has(id)) continue;
          const p = tg.nearest(x, y);
          const name = this.src.units.find((u) => u.id === id)!.name;
          if (p && (!best || p.d < best.d)) best = { ...p, name };
        }
        if (best) hint = ` · next: ${best.name}, ${where(here, best, best.d)}`;
      }
      out.push({ id: "units", title: `Walk on ${this.unitGoal} geologic units`, detail: `${Math.min(this.unitsVisited.size, this.unitGoal)} of ${this.unitGoal}${hint}`, done });
    }
    if (this.hasTracks) {
      const done = this.tracksFound !== null;
      const tr = done ? null : this.tracksNear(x, y);
      const on = tr !== null && tr.d <= TRACK_M;
      out.push({
        id: "tracks",
        title: `Follow ${this.src.roverName ?? "the rover"}'s route for ${TRACK_FOLLOW_M} m`,
        detail: done ? `sol ${this.tracksFound}` : on ? `on it (sol ${tr!.sol}): ${Math.round(this.trackM)} of ${TRACK_FOLLOW_M} m` : tr ? `${where(here, tr, tr.d)} (sol ${tr.sol})${this.trackM > 0 ? ` · ${Math.round(this.trackM)} m so far` : ""}` : "",
        done,
      });
    }
    const soil = this.soilTests;
    out.push({ id: "soil", title: `${SOIL_TESTS} soil tests, ${SOIL_APART_M} m apart`, detail: soil >= SOIL_TESTS ? "done" : `${soil} of ${SOIL_TESTS} · hold E away from a stop`, done: soil >= SOIL_TESTS });
    if (this.shelterTargets) {
      const done = this.has("shelter");
      const p = done ? null : this.shelterTargets.nearest(x, y);
      out.push({ id: "shelter", title: `Find ground that blocks ≥ ${this.shelterBlockedPct} % of the sky`, detail: done ? "found" : `here ${this.readingAt(x, y).blockedPct} %${p ? ` · nearest ${where(here, p, p.d)}` : ""}`, done });
    }
    out.push({
      id: "relay",
      title: "Talk to the rover through the relay mast",
      detail: this.relayUsed ? "done" : this.relayUp ? "mast up · walk into radio shadow behind it" : inRadioShadow ? "no radio here: go back to where the rover is in sight and press R" : "press R where the rover is in sight, then walk out of its view",
      done: this.relayUsed,
    });
    return out;
  }
}

/** Share of sorted values strictly below v (0..1). */
export function rankOf(sorted: Uint8Array, v: number): number {
  if (!sorted.length || v <= 0) return 0;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo / sorted.length;
}

/** Keep at most `max` points (pairs), evenly spread through the list. */
function thin(pts: number[], max: number): number[] {
  const count = pts.length / 2;
  if (count <= max) return pts;
  const out: number[] = [];
  const step = count / max;
  for (let k = 0; k < max; k++) {
    const i = Math.floor(k * step) * 2;
    out.push(pts[i], pts[i + 1]);
  }
  return out;
}
