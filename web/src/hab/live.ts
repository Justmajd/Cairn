import type { LiveEva } from "./protocol";

/**
 * EVAs under way right now on the hab, on every site (GET /api/live).  Small on purpose: the main
 * menu uses it without loading the hab link.  null = no hab (a static host, or the hab is down).
 */
export async function liveEvas(): Promise<LiveEva[] | null> {
  try {
    const res = await fetch(new URL("api/live", document.baseURI), { cache: "no-store", signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return ((await res.json()) as { live?: LiveEva[] }).live ?? [];
  } catch {
    return null;
  }
}

/** Is the crew's EVA clock moving (so it can be run on between answers from the hab)? */
export const liveTicking = (e: LiveEva) => e.crewOnline && !e.hidden && e.speed > 0;

/** The EVA clock `ms` after the hab answered. */
export const liveNow = (e: LiveEva, ms: number) => e.now + (liveTicking(e) ? (ms / 1000) * e.speed : 0);

/** "Running at 60×", "paused", …: what the crew's simulation is doing. */
export function liveState(e: LiveEva): string {
  if (!e.crewOnline) return "crew link lost";
  if (e.hidden) return "clock stopped: the crew's tab is in the background";
  if (e.speed <= 0) return "paused";
  return `running at ${e.speed}×`;
}

/** Site name without the subtitle ("Deuteronilus Mensae — buried glacier" → "Deuteronilus Mensae"). */
export const liveSiteName = (e: LiveEva) => e.siteName.split(" — ")[0];
