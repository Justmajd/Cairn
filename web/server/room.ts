/**
 * One site's live EVA on the hab server: what the crew has sent, and what Mission Control on Earth
 * may see of it yet.  Pure logic (no sockets, no files), driven by the crew's EVA clock:
 *
 *   - an item stamped t on Mars (telemetry, a log line, a field note) reaches Earth at t + light time;
 *   - a message Earth sends at t reaches the crew at t + light time;
 *   - "now" is the latest EVA clock the crew reported.  After the EVA ends, or if the crew drops off,
 *     the clock keeps running at the last simulation speed (tick) so what is still in flight arrives.
 */
import type { EarthMessage, EvaRecord, Frame, LogEntry, McSnapshot, NoteRecord, PlanChange, PlanInfo, ServerMsg } from "../src/hab/protocol.ts";

const MAX_FRAMES = 6000;
const MAX_LOG = 500;

export interface Out {
  mc: ServerMsg[];
  crew: ServerMsg[];
}

const out = (): Out => ({ mc: [], crew: [] });
const key = (e: LogEntry) => `${e.t.toFixed(3)}|${e.kind}|${e.text}`;

/** A running EVA whose crew has been gone this long stops being listed as live (ms). */
export const STALE_CREW_MS = 10 * 60 * 1000;

let openedCount = 0;

export class Room {
  plan: PlanInfo | null = null;
  evaId: string | null = null;
  running = false;
  ended = false;
  now = 0;
  lightTimeS = 0;
  speed = 0;
  crewOnline = false;
  /** when the crew's link dropped (ms since 1970), or null while it is up / before anyone connected */
  crewLostMs: number | null = null;
  live: { x: number; y: number } | null = null;
  crewHidden = false;

  private frames: Frame[] = [];
  private framesOut = 0;
  private log: LogEntry[] = [];
  private logKeys = new Set<string>();
  private logOut = new Set<string>();
  private notes = new Map<string, NoteRecord>();
  private notesOut = new Set<string>();
  private outbox: EarthMessage[] = [];
  /** Notes taken during the current EVA (for its record). */
  private evaNotes = new Set<string>();
  private msgCount = 0;

  readonly site: string;
  /** the crew session this room is (one per EV1; the site's id for the default session) */
  readonly key: string;
  /** when the session was opened (ms, plus a counter so two in the same millisecond still have an order):
   *  the newest is the one EV2 and Mission Control join by default */
  readonly created = Date.now() + (openedCount++ % 1000) / 1000;
  constructor(site: string, key: string = site) {
    this.site = site;
    this.key = key;
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

  setCrewOnline(online: boolean, nowMs = Date.now()): Out {
    this.crewOnline = online;
    this.crewLostMs = online ? null : nowMs;
    const o = out();
    o.mc.push({ type: "crew", online });
    return o;
  }

  /** What a restarted hab needs to carry on with the same EVA (store.ts keeps it on disk). */
  liveState(): { evaId: string | null; running: boolean; now: number; lightTimeS: number; speed: number; plan: PlanInfo | null } {
    return { evaId: this.evaId, running: this.running, now: this.now, lightTimeS: this.lightTimeS, speed: this.speed, plan: this.plan };
  }

  /** After a restart of the hab: the EVA that was under way, as it was last saved. */
  restore(s: ReturnType<Room["liveState"]>): void {
    this.evaId = s.evaId;
    this.running = s.running;
    this.ended = !s.running && !!s.evaId;
    this.now = s.now;
    this.lightTimeS = s.lightTimeS;
    this.speed = s.speed;
    this.plan = s.plan;
    this.crewLostMs = Date.now(); // nobody is connected after a restart: the crew has a while to come back
  }

  /**
   * Is this EVA worth listing as live (main menu, Mission Control elsewhere)?  Running, and the crew
   * either connected or lost for less than STALE_CREW_MS: a walk abandoned in a closed tab drops off the
   * list, while a crew that comes back resumes it.
   */
  listedLive(nowMs = Date.now()): boolean {
    if (!this.running || !this.evaId) return false;
    return this.crewOnline || this.crewLostMs === null || nowMs - this.crewLostMs < STALE_CREW_MS;
  }

  startEva(evaId: string, lightTimeS: number): Out {
    if (evaId === this.evaId && this.running) {
      // the same EVA again: the crew's device reconnected (or the hab restarted). Carry on, do not reset
      // Earth's timeline (the clock catches up with the crew's next frame).
      const o = out();
      o.mc.push({ type: "eva", eva: this.evaState() });
      return o;
    }
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
    this.evaNotes.clear();
    // notes from earlier EVAs and from planning stay known on Earth; this EVA's arrive with the delay
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
    this.crewHidden = !!f.hidden;
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
  /**
   * Has a note reached Earth?  A note taken on the EVA under way arrives one light time after it was
   * taken; anything else (taken while planning, or on an earlier EVA) is already known.  Decided from the
   * note itself, so it holds after a restart of the hab or of Mission Control.
   */
  private noteDue(n: NoteRecord): boolean {
    const thisEva = this.evaId !== null && (n.eva === this.evaId || (n.eva === undefined && this.evaNotes.has(n.id)));
    return !thisEva || n.evaT === null || n.evaT <= this.shownT;
  }

  upsertNote(n: NoteRecord): Out {
    if (this.running && n.evaT !== null) this.evaNotes.add(n.id);
    const known = this.notesOut.has(n.id);
    this.notes.set(n.id, n);
    const o = out();
    if (known || this.noteDue(n)) {
      this.notesOut.add(n.id);
      o.mc.push({ type: "note", note: n });
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
    for (const n of notes) this.notes.set(n.id, n); // released (or not) by noteDue, like any other
  }

  /** Mission Control sends a message to the crew. */
  say(text: string, change?: PlanChange): Out {
    const clean = text.trim().slice(0, 500);
    const o = out();
    if (!clean && !change) return o;
    const immediate = !this.running;
    const msg: EarthMessage = {
      id: `m${++this.msgCount}`,
      text: clean,
      sentT: this.now,
      deliverT: immediate ? this.now : this.now + this.lightTimeS,
      ...(immediate ? { immediate: true } : {}),
      ...(change ? { change } : {}),
    };
    this.outbox.push(msg);
    o.mc.push({ type: "outbox", msg });
    if (immediate) {
      msg.delivered = true;
      o.crew.push({ type: "msg", msg });
    }
    return o;
  }

  /** The crew answers a revised plan: during an EVA it reaches Earth one light time later. */
  reply(id: string, accepted: boolean): Out {
    const msg = this.outbox.find((m) => m.id === id);
    if (!msg?.change) return out();
    const entry: LogEntry = { t: this.now, kind: "radio", text: `Crew ${accepted ? "accepted" : "declined"} Mission Control's revised plan`, ref: id, accepted };
    const k = key(entry);
    if (this.logKeys.has(k)) return out();
    this.logKeys.add(k);
    this.log.push(entry);
    if (this.running) return this.release();
    this.logOut.add(k); // no EVA running: no EVA clock to delay it on
    const o = out();
    o.mc.push({ type: "log", entry });
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
    if (withClock) o.mc.push({ type: "clock", now: this.now, lightTimeS: this.lightTimeS, speed: this.speed, live: this.live, hidden: this.crewHidden });
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
      if (!this.notesOut.has(n.id) && this.noteDue(n)) {
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
      notes: [...this.notes.values()].filter((n) => {
        if (this.noteDue(n)) this.notesOut.add(n.id);
        return this.notesOut.has(n.id);
      }),
      outbox: this.outbox.slice(-50),
    };
  }

  /** The EVA's record, kept on the hab when it ends: enough for Mission Control to replay it. */
  record(): EvaRecord {
    // at most ~1500 frames (an EVA at 4 frames a second of real time), always keeping the last one
    const step = Math.max(1, Math.ceil(this.frames.length / 1500));
    const frames = this.frames.filter((_, i) => i % step === 0 || i === this.frames.length - 1);
    return {
      evaId: this.evaId,
      site: this.site,
      plan: this.plan,
      log: this.log.slice(),
      frames,
      notes: [...this.notes.values()].filter((n) => this.evaNotes.has(n.id) || (n.eva != null && n.eva === this.evaId)),
      outbox: this.outbox.slice(-50),
      lightTimeS: this.lightTimeS,
      lastFrame: this.frames[this.frames.length - 1] ?? null,
    };
  }

  /** The latest frame (for EV2's device joining mid-EVA). */
  lastFrame(): Frame | null {
    return this.frames[this.frames.length - 1] ?? null;
  }
}
