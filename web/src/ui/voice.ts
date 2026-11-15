/**
 * Spoken guidance through the browser's built-in speech synthesis: astronauts in gloves need
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

  constructor(private readonly gapMs = 14000) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("cairn.voice");
    } catch {
      /* storage blocked: default on */
    }
    this.on = stored !== "off";
    if (this.supported) {
      const pick = () => (this.voice = bestVoice(speechSynthesis.getVoices()));
      pick();
      speechSynthesis.addEventListener?.("voiceschanged", pick);
    }
  }

  get supported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  get enabled(): boolean {
    return this.on && this.supported;
  }

  /** The voice in use, for the tooltip ("Voice: Ava (Premium)"). */
  get voiceName(): string | null {
    return this.voice?.name ?? null;
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

  stop(): void {
    if (this.supported) speechSynthesis.cancel();
  }

  say(text: string, level: "urgent" | "event" | "routine" = "event", key?: string, keyGapMs = 45000): void {
    if (!this.enabled) return;
    const now = performance.now();
    if (level === "routine" && (speechSynthesis.speaking || speechSynthesis.pending || now - this.lastRoutine < this.gapMs)) return;
    if (key) {
      if (now - (this.lastByKey.get(key) ?? -Infinity) < keyGapMs) return;
      this.lastByKey.set(key, now);
    }
    if (level === "urgent") speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang ?? "en-US";
    // a calm, even delivery: a touch slower than the default, natural pitch
    u.rate = level === "urgent" ? 1.02 : 0.96;
    u.pitch = 1;
    speechSynthesis.speak(u);
    if (level === "routine") this.lastRoutine = now;
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
  name: string;
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
  next(v: RouteView): string | null {
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
      return `${cap(turnWords(v.turnDeg))}.`;
    }
    if (v.steepDeg >= 15 && this.lastSteepAtM - v.distM >= 150) {
      this.lastSteepAtM = v.distM;
      return `Steep ground ahead, ${Math.round(v.steepDeg)} degrees.`;
    }
    if (v.sand && this.lastSandAtM - v.distM >= 150) {
      this.lastSandAtM = v.distM;
      return "Loose sand ahead.";
    }
    if (!this.said100 && v.distM <= 100) {
      this.said100 = true;
      return `${v.name}, 100 metres.`;
    }
    if (!this.said25 && v.distM <= 25) {
      this.said25 = true;
      return `${v.name} ahead.`;
    }
    return null;
  }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

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
