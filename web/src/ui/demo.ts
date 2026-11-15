import { $, esc } from "./dom";
import { ic } from "./icons";

export interface DemoStep {
  title: string;
  body: string | (() => string);
  run: (ctx: DemoContext) => Promise<void>;
}

export interface DemoContext {
  /** Wait `ms` of demo time (stops while paused, resolves early on Next). */
  sleep(ms: number): Promise<void>;
  /** Wait until `cond()` is true (checked every 100 ms) or `timeoutMs` passes. */
  until(cond: () => boolean, timeoutMs: number): Promise<void>;
  /** Replace the caption body while a step is running. */
  say(body: string): void;
  readonly aborted: boolean;
}

class Abort extends Error {}

/**
 * Guided demo: a scripted walk through the whole story, with a caption card, progress dots and
 * Pause / Next / Exit controls.  Steps drive the app through its public methods.
 */
export class DemoRunner {
  private host = $("#demo");
  private paused = false;
  private skip = false;
  private stopped = false;
  private index = 0;
  onPause: (paused: boolean) => void = () => {};
  onEnd: () => void = () => {};

  constructor(private readonly steps: DemoStep[], private readonly finale: { title: string; body: () => string; extra?: { label: string; act: () => void } }) {}

  get running(): boolean {
    return !this.stopped;
  }

  async start(): Promise<void> {
    this.render();
    this.host.hidden = false;
    document.body.classList.add("demo-on");
    try {
      for (this.index = 0; this.index < this.steps.length; this.index++) {
        this.skip = false;
        this.render();
        await this.steps[this.index].run(this.ctx());
      }
      this.showFinale();
    } catch (err) {
      if (!(err instanceof Abort)) throw err;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.host.hidden = true;
    document.body.classList.remove("demo-on");
    this.onEnd();
  }

  private ctx(): DemoContext {
    const self = this;
    const check = () => {
      if (self.stopped) throw new Abort();
    };
    return {
      get aborted() {
        return self.stopped;
      },
      sleep: async (ms) => {
        let left = ms;
        while (left > 0 && !self.skip) {
          check();
          await new Promise((r) => setTimeout(r, 100));
          if (!self.paused) left -= 100;
        }
        check();
      },
      until: async (cond, timeoutMs) => {
        let left = timeoutMs;
        while (!cond() && left > 0 && !self.skip) {
          check();
          await new Promise((r) => setTimeout(r, 100));
          if (!self.paused) left -= 100;
        }
        check();
      },
      say: (body) => {
        const el = self.host.querySelector(".demo-body");
        if (el) el.innerHTML = body;
      },
    };
  }

  private render(): void {
    const step = this.steps[this.index];
    const body = typeof step.body === "function" ? step.body() : step.body;
    const dots = this.steps.map((_, i) => `<i class="${i < this.index ? "done" : i === this.index ? "on" : ""}"></i>`).join("");
    this.host.innerHTML = `
      <div class="demo-card">
        <header><span class="demo-step">${this.index + 1} / ${this.steps.length}</span><div class="demo-dots">${dots}</div></header>
        <h3>${esc(step.title)}</h3>
        <p class="demo-body">${body}</p>
        <footer>
          <button class="ghost" data-d="pause">${this.paused ? ic.play : ic.pause}<span>${this.paused ? "Resume" : "Pause"}</span></button>
          <button class="ghost" data-d="next">${ic.skip}<span>Next</span></button>
          <button class="ghost" data-d="exit">${ic.close}<span>Exit demo</span></button>
        </footer>
      </div>`;
    this.bind();
  }

  private showFinale(): void {
    this.host.innerHTML = `
      <div class="demo-card finale">
        <header><span class="demo-step">Demo complete</span></header>
        <h3>${esc(this.finale.title)}</h3>
        <p class="demo-body">${this.finale.body()}</p>
        <footer>
          ${this.finale.extra ? `<button class="primary" data-d="extra">${ic.walk}<span>${esc(this.finale.extra.label)}</span></button>` : ""}
          <button class="${this.finale.extra ? "ghost" : "primary"}" data-d="exit">${ic.route}<span>Explore it yourself</span></button>
          <button class="ghost" data-d="replay">${ic.rotL}<span>Replay</span></button>
        </footer>
      </div>`;
    this.bind();
  }

  private bind(): void {
    this.host.onclick = (ev) => {
      const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-d]")?.dataset.d;
      if (act === "pause") {
        this.paused = !this.paused;
        this.onPause(this.paused);
        this.render();
      } else if (act === "next") {
        this.skip = true;
      } else if (act === "exit") {
        this.stop();
      } else if (act === "extra") {
        this.stop();
        this.finale.extra?.act();
      } else if (act === "replay") {
        this.stop();
        window.dispatchEvent(new CustomEvent("cairn:demo"));
      }
    };
  }
}
