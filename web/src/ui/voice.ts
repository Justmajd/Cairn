/**
 * Spoken guidance through the browser's built-in speech synthesis: astronauts in gloves need
 * directions they don't have to read.  Three levels:
 *  - "urgent" interrupts whatever is being said (storm alert, emergencies),
 *  - "event" queues behind it (arrived, heading to the next stop, radio lost),
 *  - "routine" guidance speaks only when nothing else is, and at most every `gapMs`.
 */
export class Voice {
  private on: boolean;
  private lastRoutine = 0;
  private voice: SpeechSynthesisVoice | null = null;

  constructor(private readonly gapMs = 9000) {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem("cairn.voice");
    } catch {
      /* storage blocked: default on */
    }
    this.on = stored !== "off";
    if (this.supported) {
      const pick = () => {
        const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
        this.voice = voices.find((v) => /Samantha|Daniel|Google UK English|Google US English|Karen|Moira/.test(v.name)) ?? voices[0] ?? null;
      };
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

  say(text: string, level: "urgent" | "event" | "routine" = "event"): void {
    if (!this.enabled) return;
    const now = performance.now();
    if (level === "routine" && (speechSynthesis.speaking || speechSynthesis.pending || now - this.lastRoutine < this.gapMs)) return;
    if (level === "urgent") speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang ?? "en-US";
    u.rate = 1.04;
    speechSynthesis.speak(u);
    this.lastRoutine = now;
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
