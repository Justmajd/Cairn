/**
 * Entry point: the fonts and styles, then one of three pages, chosen by the address:
 * - the main menu (the default): a site's briefing, with only its text and two images loaded;
 * - the EVA planner (?skip=1, ?demo=1, or a shared plan link): planner.ts, with Three.js and the
 *   site's terrain, loaded only now;
 * - Mission Control (?view=mission): mission/dashboard.ts.
 * - Free roam (?roam=1): the planner's chunk, booting the walking astronaut instead of the planner.
 */
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/tektur/700.css";
import "./styles/main.css";
import "./styles/motion.css";
import "./styles/theme.css";
import { loadBriefing, loadSites } from "./data/loaders";
import { resumeDissolve } from "./ui/dissolve";
import { hideAnimated, markSiteLinks } from "./ui/motion";
import { showBriefing } from "./ui/briefing";
import { initOffline } from "./ui/offline";
import { $ } from "./ui/dom";

const query = new URLSearchParams(location.search);
const sharedPlan = /(^#|&)(stops|add)=/.test(location.hash);
const page: "mission" | "menu" | "planner" =
  query.get("view") === "mission"
    ? "mission"
    : query.get("menu") === "1" || (query.get("skip") !== "1" && query.get("demo") !== "1" && query.get("roam") !== "1" && !sharedPlan)
      ? "menu"
      : "planner";

function failed(err: unknown): void {
  document.documentElement.classList.remove("sweep-boot");
  console.error(err);
  const box = $("#loading");
  box.hidden = false;
  box.classList.add("failed");
  $("#load-label").textContent = `Could not start: ${err instanceof Error ? err.message : String(err)}`;
}

/** The main menu: the briefing for ?site=, and nothing of the planner. */
async function startMenu(): Promise<void> {
  const arrival = resumeDissolve(); // from another site's menu: the curtain opens once this one is drawn
  $("#load-label").textContent = "Opening the briefing";
  const [site, sites] = await Promise.all([loadBriefing(), loadSites()]);
  document.title = `CAIRN — ${site.meta.name.split(" — ")[0]} · Marswalk Route Planner`;
  showBriefing(site, sites, "page");
  if (arrival) {
    $("#loading").hidden = true;
    arrival();
  } else hideAnimated($("#loading"), 350);
}

if (page === "mission") {
  // Mission Control: its own page, no 3D terrain to load
  document.documentElement.classList.remove("sweep-boot");
  const site = query.get("site") ?? "jezero";
  void import("./mission/dashboard").then(({ startMissionControl }) => startMissionControl(/^[A-Za-z0-9_-]{1,64}$/.test(site) ? site : "jezero"));
} else {
  initOffline();
  markSiteLinks();
  if (page === "menu") startMenu().catch(failed);
  else import("./planner").then(({ startPlanner }) => startPlanner()).catch(failed);
}
