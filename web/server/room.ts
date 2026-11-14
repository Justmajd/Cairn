/**
 * One site's live EVA on the hab server: what the crew has sent, and what Mission Control on Earth
 * may see of it yet.  Pure logic (no sockets, no files), driven by the crew's EVA clock:
 *
 *   - an item stamped t on Mars (telemetry, a log line, a field note) reaches Earth at t + light time;
 *   - a message Earth sends at t reaches the crew at t + light time;
 *   - "now" is the latest EVA clock the crew reported.  After the EVA ends, or if the crew drops off,
 *     the clock keeps running at the last simulation speed (tick) so what is still in flight arrives.
 */
import type { EarthMessage, Frame, LogEntry, McSnapshot, NoteRecord, PlanInfo, ServerMsg } from "../src/hab/protocol.ts";

const MAX_FRAMES = 6000;
const MAX_LOG = 500;

export interface Out {
  mc: ServerMsg[];
  crew: ServerMsg[];
}

const out = (): Out => ({ mc: [], crew: [] });
const key = (e: LogEntry) => `${e.t.toFixed(3)}|${e.kind}|${e.text}`;

export class Room {
  plan: PlanInfo | null = null;
  evaId: string | null = null;
  running = false;
  ended = false;
  now = 0;
  lightTimeS = 0;
  speed = 0;
  crewOnline = false;
  live: { x: number; y: number } | null = null;

  private frames: Frame[] = [];
  private framesOut = 0;
  private log: LogEntry[] = [];
  private logKeys = new Set<string>();
  private logOut = new Set<string>();
  private notes = new Map<string, NoteRecord>();
  private notesOut = new Set<string>();
  private outbox: EarthMessage[] = [];
  private msgCount = 0;

  readonly site: string;
  constructor(site: string) {
    this.site = site;
  }

  /** Earth sees what happened up to this EVA time. */
  get shownT(): number {
    return this.now - this.lightTimeS;
  }

  private evaState(): McSnapshot["eva"] {
    return this.evaId ? { id: this.evaId, running: this.running, ended: this.ended } : null;
  }

  setPlan(plan: PlanInfo): Out {
    this.plan = plan;
    if (!this.running) this.lightTimeS = plan.lightTimeS;
    const o = out();
    o.mc.push({ type: "plan", plan });
    return o;
  }

  setCrewOnline(online: boolean): Out {
    this.crewOnline = online;
    const o = out();
    o.mc.push({ type: "crew", online });
    return o;
  }

  startEva(evaId: string, lightTimeS: number): Out {
    this.evaId = evaId;
    this.running = true;
    this.ended = false;
    this.now = 0;
    this.speed = 0;
    this.lightTimeS = lightTimeS;
    this.frames = [];
    this.framesOut = 0;
    this.log = [];
    this.logKeys.clear();
    this.logOut.clear();
    this.live = null;
    // notes from earlier EVAs and from planning stay known on Earth; this EVA's arrive with the delay
    for (const n of this.notes.values()) if (n.evaT === null) this.notesOut.add(n.id);
    this.outbox = this.outbox.filter((m) => !m.delivered && m.immediate);
    const o = out();
    o.mc.push({ type: "eva", eva: this.evaState() });
    o.mc.push({ type: "clock", now: 0, lightTimeS, speed: 0, live: null });
    return o;
  }

  endEva(): Out {
    this.running = false;
    this.ended = true;
    if (this.speed <= 0) this.speed = 60; // let the last signals arrive even if the crew had paused
    const o = out();
    o.mc.push({ type: "eva", eva: this.evaState() });
    return o;
  }

  /** A telemetry frame from the crew: it moves the clock on and releases whatever has reached Earth. */
  frame(f: Frame): Out {
    if (!this.running) return out();
    const last = this.frames[this.frames.length - 1];
    if (last && f.t < last.t) return out(); // stale (reordered) frame
    this.frames.push(f);
    if (this.frames.length > MAX_FRAMES) {
      const drop = this.frames.length - MAX_FRAMES;
      this.frames.splice(0, drop);
      this.framesOut = Math.max(0, this.framesOut - drop);
    }
    this.now = f.t;
    this.speed = f.speed;
    this.lightTimeS = f.lightTimeS;
    this.live = { x: f.x, y: f.y };
    return this.release();
  }

  /** The crew's whole log so far (new lines are picked out here). */
  setLog(entries: LogEntry[]): Out {
    for (const e of entries.slice(-MAX_LOG)) {
      const k = key(e);
      if (this.logKeys.has(k)) continue;
      this.logKeys.add(k);
      this.log.push(e);
    }
    this.log.sort((a, b) => a.t - b.t);
    return this.running || this.ended ? this.release() : out();
  }

  /** A note saved on the hab (by any crew device): crew devices get it now, Earth after the delay. */
  upsertNote(n: NoteRecord): Out {
    const known = this.notesOut.has(n.id);
    this.notes.set(n.id, n);
    const o = out();
    if (known || n.evaT === null || !this.evaId) {
      this.notesOut.add(n.id);
      o.mc.push({ type: "note", note: n });
    } else {
      const r = this.release();
      o.mc.push(...r.mc);
    }
    return o;
  }

  removeNote(id: string): Out {
    this.notes.delete(id);
    const o = out();
    if (this.notesOut.delete(id)) o.mc.push({ type: "note-removed", id });
    return o;
  }

  loadNotes(notes: NoteRecord[]): void {
    for (const n of notes) {
      this.notes.set(n.id, n);
      this.notesOut.add(n.id); // stored before this run of the server: already known on Earth
    }
  }

  /** Mission Control sends a message to the crew. */
  say(text: string): Out {
    const clean = text.trim().slice(0, 500);
    const o = out();
    if (!clean) return o;
    const immediate = !this.running;
    const msg: EarthMessage = {
      id: `m${++this.msgCount}`,
      text: clean,
      sentT: this.now,
      deliverT: immediate ? this.now : this.now + this.lightTimeS,
      ...(immediate ? { immediate: true } : {}),
    };
    this.outbox.push(msg);
    o.mc.push({ type: "outbox", msg });
    if (immediate) {
      msg.delivered = true;
      o.crew.push({ type: "msg", msg });
    }
    return o;
  }

  /** Wall-clock tick: after the EVA (or while the crew is away) the EVA clock runs on at the last speed. */
  tick(wallDtS: number): Out {
    if (!this.evaId || (this.running && this.crewOnline) || this.speed <= 0) return out();
    if (!this.pending()) return out();
    this.now += wallDtS * this.speed;
    return this.release(true);
  }

  /** Anything still in flight to Earth or to the crew? */
  pending(): boolean {
    return this.framesOut < this.frames.length || this.log.some((e) => !this.logOut.has(key(e))) || [...this.notes.keys()].some((id) => !this.notesOut.has(id)) || this.outbox.some((m) => !m.delivered);
  }

  private release(withClock = true): Out {
    const o = out();
    const shown = this.shownT;
    if (withClock) o.mc.push({ type: "clock", now: this.now, lightTimeS: this.lightTimeS, speed: this.speed, live: this.live });
    while (this.framesOut < this.frames.length && this.frames[this.framesOut].t <= shown) {
      o.mc.push({ type: "frame", frame: this.frames[this.framesOut++] });
    }
    for (const e of this.log) {
      const k = key(e);
      if (e.t <= shown && !this.logOut.has(k)) {
        this.logOut.add(k);
        o.mc.push({ type: "log", entry: e });
      }
    }
    for (const n of this.notes.values()) {
      if (!this.notesOut.has(n.id) && (n.evaT ?? -Infinity) <= shown) {
        this.notesOut.add(n.id);
        o.mc.push({ type: "note", note: n });
      }
    }
    for (const m of this.outbox) {
      if (!m.delivered && m.deliverT <= this.now) {
        m.delivered = true;
        o.crew.push({ type: "msg", msg: m });
        o.mc.push({ type: "outbox", msg: m });
      }
    }
    return o;
  }

  /** Everything Earth may see right now, for a Mission Control screen that just connected. */
  snapshot(): McSnapshot {
    return {
      plan: this.plan,
      crewOnline: this.crewOnline,
      eva: this.evaState(),
      now: this.now,
      lightTimeS: this.lightTimeS,
      frames: this.frames.slice(0, this.framesOut),
      log: this.log.filter((e) => this.logOut.has(key(e))),
      notes: [...this.notes.values()].filter((n) => this.notesOut.has(n.id)),
      outbox: this.outbox.slice(-50),
    };
  }

  /** The EVA's record, kept on the hab when it ends. */
  record(): { evaId: string | null; site: string; plan: PlanInfo | null; log: LogEntry[]; lastFrame: Frame | null } {
    return { evaId: this.evaId, site: this.site, plan: this.plan, log: this.log.slice(), lastFrame: this.frames[this.frames.length - 1] ?? null };
  }
}
