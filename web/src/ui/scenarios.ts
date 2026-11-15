import { esc } from "./dom";
import { dissolveTo } from "./dissolve";

/**
 * Scenario presets: one tap sets up a story, to plan in the planner or to walk in free roam.
 * Everything a scenario sets is an ordinary option (stops, start time, storm, dust, buddy, a practice
 * emergency), carried in the address, so a scenario is just a link.  No Three.js here: the main menu
 * uses this too and must stay light.
 */
export interface Scenario {
  id: string;
  title: string;
  story: string;
  site: string;
  siteName: string;
  stops: string[];
  /** start time, local mean solar time (h) */
  t?: number;
  storm: boolean;
  /** a measured dust preset (eva/dust.ts) */
  dust?: string;
  buddy?: boolean;
  /** a practice emergency in free roam, e.g. "leak@900" (seconds into the EVA) */
  emergency?: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "morning",
    title: "Clear morning at Cheyava Falls",
    story: "Leave at 08:30 under a clear sky (τ 0.4, measured by Perseverance) for the rock with the “leopard spots”, and be back before the afternoon.",
    site: "jezero",
    siteName: "Jezero Crater",
    stops: ["cheyava"],
    t: 8.5,
    storm: false,
    dust: "clear",
  },
  {
    id: "storm",
    title: "The 20 May 2024 solar storm",
    story: "The solar particle event Curiosity's RAD measured on 20 May 2024 arrives mid-walk. The alarm gives you 30 minutes to be inside the rover.",
    site: "jezero",
    siteName: "Jezero Crater",
    stops: ["cheyava", "serpentine"],
    storm: true,
  },
  {
    id: "dust",
    title: "Gale in the 2018 global dust storm",
    story: "Dust optical depth above 8, Curiosity's highest ever (June 2018): about a tenth of the daylight. Find the boxwork ridge by compass and beacon.",
    site: "gale",
    siteName: "Gale Crater",
    stops: ["ridge"],
    storm: false,
    dust: "global",
  },
  {
    id: "pair",
    title: "Two astronauts, Earth a light time away",
    story: "EV1 and EV2 on two devices walk the same plan and see each other; Mission Control watches it all one light time late and can only advise.",
    site: "gale",
    siteName: "Gale Crater",
    stops: ["ridge", "sajama"],
    storm: false,
    buddy: true,
  },
  {
    id: "leak",
    title: "Suit leak on the way out",
    story: "Fifteen minutes into the walk the suit starts losing oxygen twice as fast. Practise CAIRN's rule: stop the science, go home now.",
    site: "jezero",
    siteName: "Jezero Crater",
    stops: ["cheyava", "serpentine"],
    storm: false,
    emergency: "leak@900",
  },
];

function hash(s: Scenario): string {
  return `#stops=${s.stops.join(",")}${s.t !== undefined ? `&t=${s.t}` : ""}${s.storm ? "" : "&storm=0"}${s.buddy ? "&buddy=1" : ""}`;
}

/** The planner, set up for the scenario. */
export function planUrl(s: Scenario): string {
  return `?site=${s.site}&skip=1${s.dust ? `&dust=${s.dust}` : ""}${hash(s)}`;
}

/** Free roam, walking the scenario as a mission. */
export function walkUrl(s: Scenario): string {
  return `?site=${s.site}&roam=1${s.dust ? `&dust=${s.dust}` : ""}${s.emergency ? `&emergency=${s.emergency}` : ""}${hash(s)}`;
}

/** The scenario cards (two actions each: plan it, walk it). */
export function scenariosHtml(): string {
  return `<div class="scenarios">${SCENARIOS.map(
    (s) => `<article class="scenario">
      <p class="eyebrow">${esc(s.siteName)}</p>
      <h3>${esc(s.title)}</h3>
      <p>${esc(s.story)}</p>
      <div class="scenario-acts"><a class="sc-plan" href="${planUrl(s)}" data-sc="${s.id}" data-go="plan">Plan it</a><a class="sc-walk" href="${walkUrl(s)}" data-sc="${s.id}" data-go="walk">Walk it</a></div>
    </article>`,
  ).join("")}</div>`;
}

/** Links in `root` go through the page transition. */
export function bindScenarios(root: HTMLElement): void {
  root.addEventListener("click", (ev) => {
    const a = (ev.target as HTMLElement).closest<HTMLAnchorElement>("a[data-sc]");
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    ev.preventDefault();
    dissolveTo(a.getAttribute("href")!);
  });
}
