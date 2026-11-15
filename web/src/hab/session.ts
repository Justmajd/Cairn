/**
 * Crew sessions: every EV1 opens one, on any site, and the main menu lists them all so anyone can join
 * one as EV2 or watch it from Mission Control.  The session id lives in the address (`?s=<id>`), so a
 * reload keeps it and links carry it (planner ↔ free roam, EV2, Mission Control).
 */

/** The session in the address, if any. */
export function sessionInUrl(): string | null {
  const s = new URLSearchParams(location.search).get("s");
  return s && /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

/**
 * This device's session.  EV1 opens one if the address has none (and writes it there, so a reload keeps
 * it); EV2 and Mission Control use the address's, or none (the hab then picks the site's newest).
 */
export function sessionFor(site: string, member: "ev1" | "ev2", role: "crew" | "mc" = "crew"): string | null {
  const s = sessionInUrl();
  if (s || role !== "crew" || member !== "ev1") return s;
  const id = `${site}-${Math.random().toString(36).slice(2, 8)}`;
  setSessionInUrl(id);
  return id;
}

/** Keep the session in the address (when the hab says which one EV2 or Mission Control joined). */
export function setSessionInUrl(id: string): void {
  const q = new URLSearchParams(location.search);
  if (q.get("s") === id) return;
  q.set("s", id);
  history.replaceState(history.state, "", `${location.pathname}?${q}${location.hash}`);
}

/** `&s=<id>` for a link, or "". */
export const sessionParam = (id: string | null | undefined): string => (id ? `&s=${encodeURIComponent(id)}` : "");
