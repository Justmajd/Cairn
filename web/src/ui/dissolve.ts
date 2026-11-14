/**
 * "Dust sweep" page transition: a dark curtain with a soft edge sweeps across the screen carrying Martian
 * dust and starlight with it, holds while the next screen gets ready, then pulls away to the right as the
 * dust streams off and fades.  One 2D canvas, ~1.4 s, a few thousand small rectangles per frame drawn in one
 * pass per colour; skipped entirely with "reduce motion".
 *
 * Across a page load (switching sites) the curtain is closed on the old page, a flag goes into
 * sessionStorage, and the new page opens it again as soon as it starts (resumeDissolve()).
 */
const BG = "#0f0d0c";
const EDGE = 90; // px of soft edge on the curtain
const IN_S = 0.6;
const OUT_S = 0.75;
const FLAG = "cairn:dissolve";
// Mars dust, dust highlights, starlight, a little blue-grey, a trace of CAIRN's accent
const PALETTE: [string, number][] = [["#e8a15c", 0.32], ["#f0b878", 0.22], ["#dddddd", 0.3], ["#9fb4c6", 0.13], ["#46e0cf", 0.03]];

interface Mote { x: number; y: number; size: number; speed: number }

/** Next animation frame; in a background tab (no frames) a timer keeps the sweep going so it always ends. */
function tick(cb: (now: number) => void): void {
  let fired = false;
  const id = requestAnimationFrame((t) => {
    fired = true;
    cb(t);
  });
  window.setTimeout(() => {
    if (fired) return;
    cancelAnimationFrame(id);
    cb(performance.now());
  }, 120);
}

const reduce = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const easeOut = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeIn = (t: number) => (t <= 0 ? 0 : Math.pow(2, 10 * (t - 1)));

function makeCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; w: number; h: number; motes: Mote[][] } | null {
  const canvas = document.createElement("canvas");
  canvas.className = "dust-sweep";
  canvas.setAttribute("aria-hidden", "true");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);
  // grouped by colour: one fillStyle change per colour per frame
  const n = w < 760 ? 700 : 1600;
  const motes: Mote[][] = PALETTE.map(() => []);
  for (let i = 0; i < n; i++) {
    let r = Math.random();
    let k = 0;
    while (k < PALETTE.length - 1 && r >= PALETTE[k][1]) r -= PALETTE[k++][1];
    motes[k].push({ x: Math.random() * w, y: Math.random() * h, size: 1 + Math.random() * 2.2, speed: Math.random() });
  }
  return { canvas, ctx, w, h, motes };
}

function drawMotes(ctx: CanvasRenderingContext2D, motes: Mote[][], xOf: (m: Mote) => number, alpha: number): void {
  ctx.globalAlpha = alpha;
  motes.forEach((group, k) => {
    ctx.fillStyle = PALETTE[k][0];
    for (const m of group) ctx.fillRect(xOf(m), m.y, m.size, m.size);
  });
  ctx.globalAlpha = 1;
}

/** Curtain in, then `between()` (e.g. hide the old screen; may return a promise to wait for), then out. */
export function dissolve(between: () => void | Promise<unknown>): Promise<void> {
  if (reduce()) return Promise.resolve(between()).then(() => undefined);
  const s = makeCanvas();
  if (!s) return Promise.resolve(between()).then(() => undefined);
  return new Promise((resolve) => {
    sweepIn(s, () => {
      const ready = Promise.race([Promise.resolve(between()), new Promise((r) => window.setTimeout(r, 1500))]);
      holdThenOut(s, ready, resolve);
    });
  });
}

/** Curtain in, then load `url` (the next page finishes the transition: see resumeDissolve). */
export function dissolveTo(url: string): void {
  const s = reduce() ? null : makeCanvas();
  if (!s) {
    location.href = url;
    return;
  }
  sweepIn(s, () => {
    try {
      sessionStorage.setItem(FLAG, String(Date.now()));
    } catch {
      // private mode: the new page just appears
    }
    location.href = url;
  });
}

/** On a page that was reached through dissolveTo(): start closed, then pull the curtain away. */
export function resumeDissolve(): void {
  let t = 0;
  try {
    t = Number(sessionStorage.getItem(FLAG) || 0);
    sessionStorage.removeItem(FLAG);
  } catch {
    return;
  }
  if (!t || Date.now() - t > 8000 || reduce()) return;
  const s = makeCanvas();
  if (!s) return;
  holdThenOut(s, new Promise((r) => tick(() => r(undefined))), () => {});
}

type Sweep = NonNullable<ReturnType<typeof makeCanvas>>;

function sweepIn({ ctx, w, h, motes }: Sweep, done: () => void): void {
  const t0 = performance.now();
  const frame = (now: number) => {
    const t = (now - t0) / 1000;
    const edge = easeOut(Math.min(1, t / IN_S)) * (w + EDGE);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, Math.max(0, edge - EDGE), h);
    const g = ctx.createLinearGradient(edge - EDGE, 0, edge, 0);
    g.addColorStop(0, BG);
    g.addColorStop(1, "rgba(15, 13, 12, 0)");
    ctx.fillStyle = g;
    ctx.fillRect(edge - EDGE, 0, EDGE, h);
    drawMotes(ctx, motes, (m) => (m.x / w) * edge, 1); // the dust rides in with the curtain
    if (t >= IN_S) return done();
    tick(frame);
  };
  tick(frame);
}

function holdThenOut(s: Sweep, ready: Promise<unknown>, done: () => void): void {
  const { canvas, ctx, w, h, motes } = s;
  let phase: "hold" | "out" = "hold";
  let t0 = performance.now();
  void ready.then(() => {
    phase = "out";
    t0 = performance.now();
  });
  const frame = (now: number) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = BG;
    if (phase === "hold") {
      ctx.fillRect(0, 0, w, h);
      drawMotes(ctx, motes, (m) => m.x, 1);
    } else {
      const t = (now - t0) / 1000;
      const e = easeIn(Math.min(1, t / OUT_S));
      ctx.fillRect(e * (w + EDGE), 0, w, h); // the curtain pulls away to the right
      drawMotes(ctx, motes, (m) => m.x + e * w * (0.5 + m.speed), 1 - e); // the dust streams off
      if (t >= OUT_S) {
        canvas.remove();
        return done();
      }
    }
    tick(frame);
  };
  tick(frame);
}
