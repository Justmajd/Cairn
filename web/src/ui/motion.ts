/**
 * Enter / leave animations for overlays (CSS classes in styles/motion.css).  Only transform, opacity and
 * clip-path are animated, and only for a fraction of a second; with "reduce motion" nothing animates.
 */
const reduce = (): boolean => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const leaving = new WeakMap<HTMLElement, number>();

/** Show an element with its enter animation (`motion-in`). */
export function showAnimated(el: HTMLElement): void {
  const t = leaving.get(el);
  if (t !== undefined) {
    window.clearTimeout(t); // reopened while it was leaving
    leaving.delete(el);
  }
  el.classList.remove("motion-out");
  el.hidden = false;
  if (reduce()) return;
  el.classList.remove("motion-in");
  void el.offsetWidth; // restart the animation
  el.classList.add("motion-in");
  const end = () => el.classList.remove("motion-in");
  el.addEventListener("animationend", end, { once: true });
  window.setTimeout(end, 1200); // a background tab may never run the animation: never leave it half-faded
}

/** Hide an element after its leave animation (`motion-out`, `ms` long). */
export function hideAnimated(el: HTMLElement, ms = 220, done?: () => void): void {
  if (el.hidden || reduce()) {
    el.hidden = true;
    el.classList.remove("motion-in", "motion-out");
    done?.();
    return;
  }
  el.classList.remove("motion-in");
  el.classList.add("motion-out");
  const t = window.setTimeout(() => {
    leaving.delete(el);
    el.hidden = true;
    el.classList.remove("motion-out");
    done?.();
  }, ms);
  leaving.set(el, t);
}
