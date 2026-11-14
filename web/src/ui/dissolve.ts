/**
 * "Dust sweep" page transition (after bracken.sh's Overpass transition): a dark curtain with a soft edge
 * sweeps across carrying Martian dust and starlight, holds while the next screen gets ready, then pulls
 * away to the right as the dust streams off and fades.
 *
 * Built from two layers animated with CSS transforms and opacity only (styles/motion.css), so the GPU
 * compositor runs it on its own thread: it stays smooth even while the page is busy loading a site.
 * Phases are sequenced with timers (not animation frames), so it always ends, even in a background tab.
 * Nothing plays with "reduce motion".
 *
 * Switching sites: the old page closes the curtain and leaves a flag in sessionStorage; an inline script
 * in index.html shows the closed curtain on the new page before anything else, and resumeDissolve()
 * keeps it closed until the site is ready, so no loading screen is seen.
 */
const IN_MS = 600;
const OUT_MS = 750;
const MAX_HOLD_MS = 12000;
const FLAG = "cairn:dissolve";

const reduce = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

function sweepElement(state: "in" | "hold"): HTMLElement {
  const el = document.createElement("div");
  el.className = `sweep sweep-${state}`;
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = '<div class="sweep-curtain"></div><div class="sweep-dust"></div>';
  document.body.appendChild(el);
  return el;
}

async function sweepOut(el: HTMLElement): Promise<void> {
  if (!el.isConnected) return;
  el.classList.remove("sweep-in", "sweep-hold");
  void el.offsetWidth; // restart from the held state
  el.classList.add("sweep-out");
  await wait(OUT_MS);
  el.remove();
}

/** Curtain in, then `between()` (e.g. hide the old screen; may return a promise to wait for), then out. */
export async function dissolve(between: () => void | Promise<unknown>): Promise<void> {
  if (reduce()) {
    await between();
    return;
  }
  const el = sweepElement("in");
  await wait(IN_MS);
  el.classList.replace("sweep-in", "sweep-hold");
  await Promise.race([Promise.resolve(between()), wait(1500)]);
  await sweepOut(el);
}

/** Curtain in, then load `url`; the next page keeps it closed until it is ready (resumeDissolve). */
export function dissolveTo(url: string): void {
  if (reduce()) {
    location.href = url;
    return;
  }
  sweepElement("in");
  window.setTimeout(() => {
    try {
      sessionStorage.setItem(FLAG, String(Date.now()));
    } catch {
      // private mode: the new page starts with its loading screen
    }
    location.href = url;
  }, IN_MS);
}

/**
 * On a page reached through dissolveTo(): keep the curtain closed (no loading screen) and return a
 * function that pulls it away once the site is ready.  Null on an ordinary page load.
 */
export function resumeDissolve(): (() => void) | null {
  const root = document.documentElement;
  let t = 0;
  try {
    t = Number(sessionStorage.getItem(FLAG) || 0);
    sessionStorage.removeItem(FLAG);
  } catch {
    // no storage
  }
  if (!t || Date.now() - t > 10000 || reduce()) {
    root.classList.remove("sweep-boot");
    return null;
  }
  const el = sweepElement("hold");
  root.classList.remove("sweep-boot"); // the real curtain has taken over from the inline one
  let opened = false;
  const open = () => {
    if (opened) return;
    opened = true;
    void sweepOut(el);
  };
  window.setTimeout(open, MAX_HOLD_MS); // never leave the page covered (e.g. if loading failed)
  return open;
}
