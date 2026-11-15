import { L, type Dest, type Line } from "./voiceLines";

/**
 * Spoken guidance: pre-rendered clips of a neural voice (Kokoro, see voiceLines.ts and
 * scripts/render-voice.mjs) joined like a car navigator, so every device hears the same natural
 * voice; the browser's built-in speech synthesis reads anything without a clip. astronauts in gloves need
 * directions they don't have to read.  Three levels:
 *  - "urgent" interrupts whatever is being said (storm alert, emergencies),
 *  - "event" queues behind it (arrived, heading to the next stop, radio lost),
 *  - "routine" guidance speaks only when nothing else is, and at most every `gapMs`.
 * A `key` gives a line its own cool-down, so something that flickers (radio at the edge of a shadow)
 * is not read out again and again.
 */
export class Voice {
  private on: boolean;
  private lastRoutine = -Infinity;
  private readonly lastByKey = new Map<string, number>();
  private voice: SpeechSynthesisVoice | null = null;
  private readonly clips = new ClipPlayer();

  constructor(private readonly gapMs = 14000) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("cairn.voice");
    } catch {
      /* storage blocked: default on */
    }
    this.on = stored !== "off";
    if (this.speech) {
      const pick = () => (this.voice = bestVoice(speechSynthesis.getVoices()));
      pick();
      speechSynthesis.addEventListener?.("voiceschanged", pick);
    }
  }

  get supported(): boolean {
    return typeof window !== "undefined" && ("speechSynthesis" in window || "AudioContext" in window);
  }

  private get speech(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  get enabled(): boolean {
    return this.on && this.supported;
  }

  /** The voice in use, for the tooltip. */
  get voiceName(): string | null {
    return this.clips.ready ? "Kokoro “Heart”, a free neural voice" : this.voice?.name ?? null;
  }

  /** Fetch these clips ahead (the plan's stops, the common phrases) so the first lines play at once. */
  preload(ids: string[]): void {
    if (this.enabled) void this.clips.preload(ids);
  }

  set(on: boolean): void {
    this.on = on;
    try {
      localStorage.setItem("cairn.voice", on ? "on" : "off");
    } catch {
      /* not remembered */
    }
    if (!on) this.stop();
  }

  /**
   * Silence the EVA guidance.  With clips it plays through Web Audio, apart from the browser's speech,
   * so a message from Mission Control being read keeps going; only without clips (the guidance itself
   * falling back to speech) does this cancel speech too.
   */
  stop(): void {
    this.clips.stop();
    if (this.speech && !this.clips.ready) speechSynthesis.cancel();
  }

  private get busy(): boolean {
    return this.clips.busy || (this.speech && (speechSynthesis.speaking || speechSynthesis.pending));
  }

  /**
   * Mission Control on Earth: its own channel, always the browser's voice, and on even when the EVA
   * guidance is muted — a message from Earth should never be missed.  Queues behind what is playing.
   */
  earth(text: string): void {
    if (!this.speech) return;
    this.speak(text, "event");
  }

  /** Say a line: its clips when they are all there, else its text in the browser's voice. */
  say(what: string | Line, level: "urgent" | "event" | "routine" = "event", key?: string, keyGapMs = 45000): void {
    if (!this.enabled) return;
    const now = performance.now();
    if (level === "routine" && (this.busy || now - this.lastRoutine < this.gapMs)) return;
    if (key) {
      if (now - (this.lastByKey.get(key) ?? -Infinity) < keyGapMs) return;
      this.lastByKey.set(key, now);
    }
    if (level === "routine") this.lastRoutine = now;
    if (level === "urgent") this.stop();
    const line = typeof what === "string" ? null : what;
    if (line) {
      void this.clips.play(line.parts, level === "urgent").then((ok) => {
        if (!ok) this.speak(line.text, level);
      });
      return;
    }
    this.speak(what as string, level);
  }

  private speak(text: string, level: "urgent" | "event" | "routine"): void {
    if (!this.speech) return;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang ?? "en-US";
    // a calm, even delivery: a touch slower than the default, natural pitch
    u.rate = level === "urgent" ? 1.02 : 0.96;
    u.pitch = 1;
    speechSynthesis.speak(u);
  }
}

/**
 * Plays lines made of clips one after another through Web Audio, each clip straight after the last
 * with a short breath between, like a car navigator.  Lines queue; an urgent one cuts in.
 */
class ClipPlayer {
  private ctx: AudioContext | null = null;
  private manifest: Promise<Set<string> | null> | null = null;
  private readonly buffers = new Map<string, Promise<AudioBuffer | null>>();
  private known: Set<string> | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private endAt = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private gen = 0;

  get ready(): boolean {
    return !!this.known?.size;
  }

  get busy(): boolean {
    return !!this.ctx && this.ctx.currentTime < this.endAt;
  }

  private base(): string {
    return `${import.meta.env?.BASE_URL ?? "/"}voice/`;
  }

  private load(): Promise<Set<string> | null> {
    this.manifest ??= fetch(`${this.base()}manifest.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m: { clips?: Record<string, string> } | null) => (this.known = m?.clips ? new Set(Object.keys(m.clips)) : null))
      .catch(() => null);
    return this.manifest;
  }

  constructor() {
    // Safari (WebKit) and phones start audio only inside a tap or key press, and lines are often said
    // by the simulation, not by a tap: wake the audio on the first touch of the page, once
    if (typeof window === "undefined") return;
    const unlock = () => {
      const ctx = this.audio();
      if (ctx?.state === "running") ["pointerdown", "keydown", "touchend"].forEach((t) => window.removeEventListener(t, unlock, true));
    };
    ["pointerdown", "keydown", "touchend"].forEach((t) => window.addEventListener(t, unlock, true));
  }

  private audio(): AudioContext | null {
    const AC = typeof window === "undefined" ? undefined : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    this.ctx ??= new AC();
    if (this.ctx.state !== "running") void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  private buffer(id: string): Promise<AudioBuffer | null> {
    let b = this.buffers.get(id);
    if (!b) {
      const ctx = this.audio();
      b = !ctx
        ? Promise.resolve(null)
        : fetch(`${this.base()}${encodeURIComponent(id)}.mp3`)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
            .then((a) => ctx.decodeAudioData(a))
            .catch(() => null);
      this.buffers.set(id, b);
    }
    return b;
  }

  async preload(ids: string[]): Promise<void> {
    const known = await this.load();
    if (known) await Promise.all(ids.filter((id) => known.has(id)).map((id) => this.buffer(id)));
  }

  stop(): void {
    this.gen++;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
    }
    this.sources = [];
    this.endAt = 0;
    this.chain = Promise.resolve();
  }

  /** Resolves false when the line cannot be played from clips (missing clips, no Web Audio). */
  play(parts: string[], urgent: boolean): Promise<boolean> {
    const gen = this.gen;
    const run = async (): Promise<boolean> => {
      const known = await this.load();
      if (!known || !parts.every((id) => known.has(id))) return false;
      const ctx = this.audio();
      if (!ctx) return false;
      if (ctx.state !== "running") await Promise.race([ctx.resume().catch(() => {}), new Promise((ok) => setTimeout(ok, 300))]);
      if (ctx.state !== "running") return false; // audio still locked (no tap yet): the browser's voice reads it instead
      const bufs = await Promise.all(parts.map((id) => this.buffer(id)));
      if (bufs.some((b) => !b) || gen !== this.gen) return gen === this.gen ? false : true;
      let t = Math.max(ctx.currentTime + 0.03, this.endAt);
      for (const b of bufs as AudioBuffer[]) {
        const src = ctx.createBufferSource();
        src.buffer = b;
        src.connect(ctx.destination);
        src.start(t);
        src.onended = () => (this.sources = this.sources.filter((x) => x !== src));
        this.sources.push(src);
        t += b.duration + 0.06;
      }
      this.endAt = t + 0.25; // a pause before the next line
      return true;
    };
    const p = urgent ? run() : this.chain.then(run);
    this.chain = p.catch(() => false);
    return p;
  }
}

/**
 * The most natural English voice the device has.  Neural and premium voices first (macOS "Premium"
 * and "Enhanced", Edge's "Natural" voices, Google's), then the good standard ones; robotic novelty
 * voices last.  Local voices win a tie (they work offline, in the field).
 */
export function bestVoice(voices: Pick<SpeechSynthesisVoice, "name" | "lang" | "localService" | "default">[]): SpeechSynthesisVoice | null {
  const score = (v: (typeof voices)[number]) => {
    const n = v.name;
    let s = 0;
    if (!/^en(-|_|$)/i.test(v.lang)) return -Infinity;
    if (/natural|neural|premium/i.test(n)) s += 60;
    else if (/enhanced/i.test(n)) s += 45;
    if (/\b(Ava|Zoe|Evan|Nathan|Serena|Jamie|Aria|Jenny|Guy|Sonia|Libby|Ryan|Samantha|Daniel|Karen|Moira|Tessa|Allison|Susan|Tom)\b/.test(n)) s += 25;
    if (/Google (UK|US) English/.test(n)) s += 30;
    if (/^en[-_](US|GB)/i.test(v.lang)) s += 8;
    if (v.localService) s += 4;
    if (/Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Fred|Junior|Ralph|Kathy|Grandma|Grandpa|Eddy|Flo|Reed|Rocko|Sandy|Shelley/.test(n)) s -= 80;
    return s;
  };
  let best: (typeof voices)[number] | null = null;
  let bestS = -Infinity;
  for (const v of voices) {
    const s = score(v);
    if (s > bestS) {
      best = v;
      bestS = s;
    }
  }
  return (best as SpeechSynthesisVoice | null) ?? null;
}

/** What the walker sees of the route ahead, for the routine callouts. */
export interface RouteView {
  /** the stop (or the rover) this leg goes to */
  legId: string;
  dest: Dest;
  /** distance to it along the route (m) */
  distM: number;
  /** change of direction about 25 m ahead (degrees, + = right) */
  turnDeg: number;
  /** steepest slope in the next 50 m (degrees) and loose sand there */
  steepDeg: number;
  sand: boolean;
}

/**
 * Routine callouts that speak only when something changes, like a good car navigator: a real turn
 * coming up, steep ground or sand ahead (once per stretch), and 100 m / 25 m to the stop.  Walking
 * straight on along an easy route is silent.  Pure: tested in voice.test.ts.
 */
export class RouteCallouts {
  private leg = "";
  private lastTurnAtM = Infinity; // distance-to-stop when the last turn was called
  private lastTurnSide = 0;
  private lastSteepAtM = Infinity;
  private lastSandAtM = Infinity;
  private said100 = false;
  private said25 = false;

  /** A line to say now, or null to stay quiet. */
  next(v: RouteView): Line | null {
    if (v.legId !== this.leg) {
      // a new leg: "Heading to …" was just said by the departure event
      this.leg = v.legId;
      this.lastTurnAtM = this.lastSteepAtM = this.lastSandAtM = v.distM;
      this.lastTurnSide = 0;
      this.said100 = v.distM <= 140;
      this.said25 = v.distM <= 40;
      return null;
    }
    const a = Math.abs(v.turnDeg);
    const side = Math.sign(v.turnDeg);
    if (v.distM > 30 && a >= 35 && (side !== this.lastTurnSide || this.lastTurnAtM - v.distM >= 60)) {
      this.lastTurnAtM = v.distM;
      this.lastTurnSide = side;
      return L.turn(v.turnDeg);
    }
    if (v.steepDeg >= 15 && this.lastSteepAtM - v.distM >= 150) {
      this.lastSteepAtM = v.distM;
      return L.steep(v.steepDeg);
    }
    if (v.sand && this.lastSandAtM - v.distM >= 150) {
      this.lastSandAtM = v.distM;
      return L.fixed("sand");
    }
    if (!this.said100 && v.distM <= 100) {
      this.said100 = true;
      return L.hundred(v.dest);
    }
    if (!this.said25 && v.distM <= 25) {
      this.said25 = true;
      return L.ahead(v.dest);
    }
    return null;
  }
}


/** Metres for speech: "120 metres", "1.2 kilometres". */
export function spokenDist(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} kilometres`;
  const r = m >= 100 ? Math.round(m / 10) * 10 : Math.round(m);
  return `${r} ${r === 1 ? "metre" : "metres"}`;
}

/** Minutes for speech. */
export function spokenTime(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"}`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return `${h} ${h === 1 ? "hour" : "hours"}${rest ? ` ${rest} minutes` : ""}`;
}

/** Turn instruction from the change of direction (degrees, + = right). */
export function turnWords(deg: number): string {
  const a = Math.abs(deg);
  if (a < 20) return "straight on";
  const side = deg > 0 ? "right" : "left";
  return a < 60 ? `bear ${side}` : a < 135 ? `turn ${side}` : `turn around to the ${side}`;
}
