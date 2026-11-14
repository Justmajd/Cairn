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

type ViewTransitionDoc = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

/**
 * Change screens with a View Transition (styles/motion.css): `kind` names the transition, so the CSS can
 * give the morphing elements their names on the old screen (`<kind>-from`) and the new one (`<kind>-to`).
 * Browsers without View Transitions (or with reduce motion) just switch.
 */
export function pageTransition(kind: string, update: () => void): void {
  const doc = document as ViewTransitionDoc;
  if (!doc.startViewTransition || reduce()) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.vt = `${kind}-from`;
  const vt = doc.startViewTransition(() => {
    update();
    root.dataset.vt = `${kind}-to`;
  });
  vt.finished.finally(() => {
    if (root.dataset.vt === `${kind}-to`) delete root.dataset.vt;
  });
}

/** Links to another site: name the logo on this page so it flies into the next one (cross-document). */
export function markSiteLinks(): void {
  document.addEventListener("click", (ev) => {
    const a = (ev.target as HTMLElement).closest?.("a[href^='?site=']");
    if (!a) return;
    const briefingOpen = !(document.getElementById("briefing")?.hidden ?? true);
    document.documentElement.dataset.vt = briefingOpen ? "site-brief-from" : "site-app-from";
  }, true);
  // back from the bfcache: no stale names
  window.addEventListener("pageshow", () => delete document.documentElement.dataset.vt);
}
