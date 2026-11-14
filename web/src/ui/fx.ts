/**
 * Small interface effects (see styles/theme.css): text that decodes itself, numbers that count up to
 * their value, and a glow that follows the pointer across a card.  Each does nothing with "reduce motion".
 */
const reduce = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const GLYPHS = "#+/<>?{}[]=*~01";

/** Decode `el`'s text: random glyphs settle into the real characters from left to right. */
export function scramble(el: HTMLElement, ms = 900): void {
  const text = el.dataset.text ?? el.textContent ?? "";
  el.dataset.text = text;
  if (reduce() || !text) {
    el.textContent = text;
    return;
  }
  el.setAttribute("aria-label", text);
  const t0 = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - t0) / ms);
    const fixed = Math.floor(k * text.length);
    let out = text.slice(0, fixed);
    for (let i = fixed; i < text.length; i++) out += text[i] === " " ? " " : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    el.textContent = out;
    if (k < 1) requestAnimationFrame(step);
    else el.removeAttribute("aria-label");
  };
  requestAnimationFrame(step);
}

/** Count the first number in `el`'s text up from zero, keeping its decimals and everything around it. */
export function countUp(el: HTMLElement, ms = 1400, delayMs = 0): void {
  const text = el.textContent ?? "";
  const m = /(\d+(?:[.,]\d+)?)/.exec(text);
  if (!m || reduce()) return;
  const target = Number(m[1].replace(",", "."));
  const decimals = m[1].split(/[.,]/)[1]?.length ?? 0;
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + m[1].length);
  el.setAttribute("aria-label", text);
  const ease = (k: number) => 1 - Math.pow(1 - k, 4);
  let t0 = 0;
  const step = (now: number) => {
    t0 ||= now + delayMs;
    const k = Math.max(0, Math.min(1, (now - t0) / ms));
    el.textContent = `${before}${(target * ease(k)).toFixed(decimals)}${after}`;
    if (k < 1) requestAnimationFrame(step);
    else {
      el.textContent = text;
      el.removeAttribute("aria-label");
    }
  };
  el.textContent = `${before}${(0).toFixed(decimals)}${after}`;
  requestAnimationFrame(step);
}

/** A soft light under the pointer on cards that ask for it (CSS reads --gx / --gy). */
export function pointerGlow(root: HTMLElement, selector: string): void {
  root.addEventListener("pointermove", (ev) => {
    const card = (ev.target as HTMLElement).closest?.(selector) as HTMLElement | null;
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty("--gx", `${ev.clientX - r.left}px`);
    card.style.setProperty("--gy", `${ev.clientY - r.top}px`);
  }, { passive: true });
}

/** Run a one-shot CSS entrance (a class) on `el`, and take the class off again afterwards. */
export function playOnce(el: HTMLElement | null, cls: string, ms: number): void {
  if (!el || reduce()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), ms);
}
