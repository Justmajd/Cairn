import type { LayerId } from "./scene/terrain";
import { measurePath } from "./data/grid";
import type { SiteData, SiteEntry } from "./data/loaders";
import { buildBudget, EvaBudget, o2Litres, ReturnLookup, sampleAtTime, Segment, walkO2 } from "./eva/budget";
import { DEFAULT_PARAMS, EvaParams } from "./eva/params";
import { RadiationModel } from "./eva/radiation";
import type { HabMap } from "./eva/hab";
import { DUST_PRESETS, dustEffect, fmtVisibility } from "./eva/dust";
import { FieldNote, Notebook } from "./ui/notebook";
import { sessionFor, sessionParam } from "./hab/session";
import { HabLink, type LinkState } from "./hab/link";
import type { EarthMessage, Frame, Member, PlanChange, PlanInfo, ServerMsg } from "./hab/protocol";
import { bestRelay, relayAtPoint, RELAY_MAX_OFF_ROUTE_M, inContact, lineOfSight, RadioCoverage, radioCoverage, radioShadow, relayFromShadow, RelaySuggestion, RELAY_MAST_M, SUIT_ANTENNA_M } from "./eva/radio";
import { inTerrainShadow } from "./eva/shade";
import { geometricMedian } from "./routing/median";
import { formatPlanLink, parsePlanLink } from "./state/planLink";
import { fmtLmst, lmstAt as lmstAtUtc, MARS_HOUR_S, SolarGeometry, solarGeometry, sunAt, SunPosition } from "./eva/sun";
import { fmtLightTime, MarsSky, marsSky, utcAtLmst } from "./eva/sky";
import { EmergencyKind, Mission, MissionEvent } from "./replay/mission";
import type { FieldResult, Router } from "./routing/client";
import type { SceneView } from "./scene/view";
import type { MeasuredPath, PathSample, Poi, XY } from "./types";
import { showBriefing } from "./ui/briefing";
import { DoseChartHandle, ProfileHandle, renderDoseChart, renderProfile } from "./ui/charts";
import { $, esc, fmtClock, fmtDist, fmtDose, fmtDur, fmtRate, setText } from "./ui/dom";
import { ic } from "./ui/icons";
import { hideAnimated, showAnimated } from "./ui/motion";
import { playOnce } from "./ui/fx";
import { dissolveTo } from "./ui/dissolve";
import { saveRoamPlan } from "./roam/plan";
import { autonomyHtml } from "./ui/autonomy";
import { bindScenarios, scenariosHtml } from "./ui/scenarios";
import { openModal, stopCardHtml } from "./ui/modals";
import type { DemoRunner, DemoStep } from "./ui/demo";
import type { CueRow } from "./ui/cuecard";
import type { ExportPlan } from "./ui/export";
import { toLonLat } from "./data/geo";
import { promptInstall, saveForOffline } from "./ui/offline";
import { RouteCallouts, Voice } from "./ui/voice";
import { Ev1Watch } from "./ui/ev1Left";
import { L, PHRASES, type Dest } from "./ui/voiceLines";

interface Plan {
  order: Poi[]; // rover, stops…, rover
  legs: MeasuredPath[];
  straight: MeasuredPath[];
  budget: EvaBudget;
  routeMs: number;
  radio: RadioCoverage; // with the relay when one is planned
  /** Best spot on the route for a portable relay (null when the walk is in contact anyway). */
  relay: RelaySuggestion | null;
  /** Mission time when the crew reaches the relay spot. */
  relayAtS: number;
}

/** Steepest ground the pressurised rover may park on (assumption). */
const ROVER_PARK_MAX_SLOPE = 10;

/** Terrain classes of the Traversability layer (same thresholds as the map colours). */
const HAZARD_CLASSES = ["easy", "moderate", "hard", "very hard", "impassable"] as const;
const HAZARD_COLORS = ["#56b4e9", "#f0e442", "#e69f00", "#d55e00", "#8c2973"];

interface RoverCheck {
  distanceM: number;
  sols: [number, number];
  track: number[]; // share of the drive per hazard class
  area: number[]; // share of the whole walk area per hazard class
  maxSlopeDeg: number;
}

interface Layer {
  id: LayerId;
  name: string;
  source: string; // provenance id
  swatch: string; // CSS background for the layer button
  legend: [string, string] | null; // low / high labels under the colour ramp
}

/** Impassable ground: purple stripes on the map, so it never relies on colour alone. */
const HATCH = "repeating-linear-gradient(135deg,#8c2973 0 3px,#f2dcec 3px 5px)";

const LAYERS: Layer[] = [
  { id: "none", name: "Image", source: "hirise_ortho", swatch: "linear-gradient(135deg,#5a3422,#b57650 55%,#f0c9a2)", legend: null },
  { id: "risk", name: "Traversability", source: "hirise_dtm", swatch: `${HATCH} right / 22% 100% no-repeat, linear-gradient(90deg,#56b4e9,#f0e442,#e69f00 55%,#d55e00 78%)`, legend: ["easy", "impassable"] },
  { id: "slope", name: "Slope", source: "hirise_dtm", swatch: `${HATCH} right / 22% 100% no-repeat, linear-gradient(90deg,#56b4e9,#f0e442,#e69f00 55%,#d55e00 78%)`, legend: ["5°", "too steep"] },
  { id: "sand", name: "Loose sand", source: "sand", swatch: "linear-gradient(90deg,rgba(255,194,77,.15),#ffc24d)", legend: ["firm", "loose"] },
  { id: "thermal", name: "Night thermal", source: "themis", swatch: "linear-gradient(90deg,#140a5a,#731491,#d13d5c,#fa9926,#faf099)", legend: ["cold · sand", "warm · rock"] },
  { id: "minerals", name: "Minerals", source: "crism", swatch: "linear-gradient(135deg,#b8e04a 0 33%,#4da3ff 33% 66%,#ff5ad1 66%)", legend: null },
  { id: "geology", name: "Geology", source: "geology", swatch: "linear-gradient(90deg,#e69f00 0 25%,#56b4e9 25% 50%,#009e73 50% 75%,#f0e442 75%)", legend: null },
  { id: "shield", name: "Sky shielding", source: "hirise_dtm", swatch: "linear-gradient(90deg,rgba(64,140,255,.2),#4d9bff,#d9f5ff)", legend: ["open sky", "−15 % dose"] },
  { id: "radio", name: "Radio contact", source: "hirise_dtm", swatch: "radial-gradient(circle at 30% 50%,rgba(158,168,230,.25) 0 30%,#141633 31%)", legend: ["line of sight to the rover", "no signal"] },
  { id: "hab", name: "Hab site", source: "hirise_dtm", swatch: "linear-gradient(90deg,#120a1c,#381f80,#1f61eb,#14bdcc,#52e661,#ffdb2e)", legend: ["unsuitable", "best"] },
  { id: "shelter", name: "To shelter", source: "hirise_dtm", swatch: "linear-gradient(90deg,#56b4e9,#f0e442,#e69f00,#d55e00,#8c2973)", legend: ["0 min", "24+ min"] },
];

const SPEEDS = [10, 60, 120, 300];

const heroDist = (m: number) => (m >= 1000 ? `<b>${(m / 1000).toFixed(2)}<small>km</small></b>` : `<b>${Math.round(m)}<small>m</small></b>`);
function heroDur(s: number): string {
  const min = Math.round(s / 60);
  const h = Math.floor(min / 60);
  return h ? `<b>${h}<small>h</small> ${String(min % 60).padStart(2, "0")}<small>min</small></b>` : `<b>${min}<small>min</small></b>`;
}

const PX_PER_DEG = 4;

/** Application controller: owns the plan, the EVA simulation and every panel. */
/** The map-click menu closes from its corner (Escape works too). */
const PIN_CLOSE = `<button class="icon close" data-x="close" aria-label="Close" title="Close (Esc)">${ic.close}</button>`;

export class App {
  private readonly P: EvaParams = DEFAULT_PARAMS;
  private readonly rad: RadiationModel;
  private rover: Poi;
  /** Where the site data parks the rover; the crew can park it elsewhere (see moveRover). */
  private readonly roverHome: XY;
  /** Way home from every point, and the rover's radio shadow, for where the rover is now. */
  private field: FieldResult;
  private pois: Poi[];
  private customCount = 0;
  private selected: string[];
  private readonly roverName: string;

  private layer: LayerId = "none";
  /** Dust in the air (eva/dust.ts preset id). */
  private dustId = "clear";
  /** With "sol": the sol picked from the rover's record. */
  private dustSol = 0;
  private dustWarned = false;
  /** The real rover's drive replayed as a ghost; its own clock while planning. */
  private ghostOn = false;
  private ghostClock = 0;
  private ghostHeading = 0;
  private readonly notebook: Notebook;
  /** Link to the hab server (the habitat's computer): Mission Control, shared notebook, EVA records. */
  private readonly habLink: HabLink;
  /** This device's astronaut: EV1 plans and runs the EVA; EV2 walks it with EV1 on another device. */
  private readonly member: Member = new URLSearchParams(location.search).get("crew") === "ev2" ? "ev2" : "ev1";
  /** EV1: EV2 devices linked through the hab.  EV2: EV1's latest EVA clock and speed, and its plan. */
  private ev2Online = 0;
  private followT = 0;
  private followSpeed = 0;
  private crewPlanHash = "";
  private evaRunningOnEv1 = false;
  private ev2Last: XY | null = null;
  private ev2Heading = 0;
  /** A revised plan accepted during the EVA: applied when the crew is back to planning. */
  private pendingChange: PlanChange | null = null;
  private habState: LinkState = "connecting";
  private mcWatching = 0;
  private evaId = "";
  private frameTimer = 0;
  private logSent = "";
  /** "Where do we put the hab?" scores, for the stops they were worked out from. */
  private hab: HabMap | null = null;
  private habKey = "";
  private habBusy = false;
  private opacity = 0.8;
  private showTrack = false;
  private showStraight = true;
  private showShadows = true;
  private startLmst: number;
  private readonly solar: SolarGeometry;
  private readonly lat: number;
  private lastSun = "";
  private exag = 1;
  private storm = true;
  private buddy = false;
  private speed = 120;
  private paused = false;

  private phase: "planning" | "eva" | "summary" = "planning";
  private viewMode: "plan" | "orbit" | "walk" = "plan";
  private plan: Plan | null = null;
  private planError: string | null = null;
  private planSeq = 0;
  private busy = false;
  private mission: Mission | null = null;
  private shelterPath: MeasuredPath | null = null;
  private shelteredAtS: number | null = null;
  private profile: ProfileHandle | null = null;
  private doseChart: DoseChartHandle | null = null;
  private liveTimer = 0;
  private widgetTimer = 0;
  private cardPoi: string | null = null;
  private toastTimer = 0;
  /** Disclosure state that survives re-rendering the panels. */
  private detailsOpen = false;
  private moreLayersOpen = false;
  /** Elevation chart open per view: open on the map, folded away in the 3D views. */
  private chartOpen: Record<string, boolean> = { plan: true, orbit: false, walk: false };
  /** Views whose gesture hint has done its job (the user has dragged or scrolled there). */
  private readonly hintSeen = new Set<string>();

  private readonly lookup: ReturnLookup;
  /** Radio shadow of the rover's mast antenna over the walk area (see eva/radio). */
  private radio: Uint8Array;
  private radioLost = false;
  /** Plan with the suggested relay (the crew stands it up on the way). */
  private useRelay = false;
  /** where the crew put the relay on the map, or null: CAIRN's suggested spot */
  private relayManual: XY | null = null;
  /** The relay is up during the current EVA. */
  private relayUp = false;
  /** What happened during the current EVA, for the summary (mission seconds, kind, text). */
  private log: { t: number; kind: "go" | "stop" | "radio" | "alert" | "home" | "note" | "earth"; text: string }[] = [];

  /** Messages on their way between the crew and Earth: the mission time each one arrives, and its log line. */
  private earthQueue: { t: number; text: string }[] = [];
  private lastSky = "";
  private readonly lon: number;
  /** A UTC instant on the EVA's sol (from the site's EVA date). */
  private readonly solUtc: number;

  private note(kind: "go" | "stop" | "radio" | "alert" | "home" | "note", text: string): void {
    this.log.push({ t: this.mission?.t ?? 0, kind, text });
  }
  private readonly voice = new Voice();
  private callouts = new RouteCallouts();
  private readonly ev1Watch = new Ev1Watch(new URLSearchParams(location.search).get("site") ?? "jezero", () => this.toast("EV1 is back in the session.", 4000));
  private roverCheckCache: RoverCheck | null = null;

  constructor(
    private readonly site: SiteData,
    private readonly view: SceneView,
    private readonly router: Router,
    field: FieldResult,
    private readonly sites: SiteEntry[] = [],
  ) {
    this.field = field;
    this.rad = new RadiationModel(site.replay);
    this.roverName = site.meta.rover?.name ?? "";
    this.selected = site.pois.filter((p) => p.kind === "objective").map((p) => p.id);
    this.startLmst = site.meta.eva?.startLmst ?? 10;
    this.solUtc = Date.parse(site.meta.eva?.utc ?? "2024-07-21T02:10:26Z");
    this.solar = solarGeometry(this.solUtc);
    this.lat = site.meta.centerLonLat?.lat ?? (site.meta.boundsLonLat.south + site.meta.boundsLonLat.north) / 2;
    this.lon = site.meta.centerLonLat?.lon ?? (site.meta.boundsLonLat.west + site.meta.boundsLonLat.east) / 2;
    this.pois = site.pois.slice();
    this.rover = this.pois.find((p) => p.kind === "shelter")!;
    this.roverHome = { x: this.rover.x, y: this.rover.y };
    this.lookup = (x, y) => {
      const node = site.grid.nodeAt(x, y);
      return { timeS: this.field.time[node], energyJ: this.field.energy[node] };
    };

    this.radio = field.radio; // computed by the routing worker at start-up
    view.setRadioShadow(this.radio);

    setText($("#site-name"), site.meta.name);
    this.bindChrome();
    view.onPoiClick = (id) => this.openCard(id, false);
    view.onGroundClick = (p, cx, cy) => this.groundClick(p, cx, cy);
    view.onNoteClick = (id) => this.openNote(id);
    if (site.dust) {
      this.dustId = "eva";
      this.dustSol = site.dust.eva.sol ?? site.dust.record[site.dust.record.length - 1][0];
      view.setDust(site.dust.eva.tau);
    }
    // ?dust=<preset> (scenario presets): a measured dust level from eva/dust.ts
    const dustQ = new URLSearchParams(location.search).get("dust");
    if (dustQ && DUST_PRESETS.some((d) => d.id === dustQ)) {
      this.dustId = dustQ;
      view.setDust(this.dustTau);
    }
    this.notebook = new Notebook(site.meta.id);
    this.pushNotes();
    this.notebook.onChange = () => {
      this.pushNotes();
      this.renderLeft();
    };
    // one crew session per EV1 (in the address as ?s=…); EV2 joins the one its link names, or the newest
    this.habLink = new HabLink("crew", site.meta.id, this.member, sessionFor(site.meta.id, this.member));
    this.habLink.onMessage((m) => this.onHab(m));
    // tell Mission Control at once when this tab goes to the background (its EVA clock stops) or comes back
    document.addEventListener("visibilitychange", () => this.sendFrame());
    this.habLink.onState((st) => {
      this.habState = st;
      if (st === "online") {
        void this.notebook.sync().then((ok) => ok && this.notebook.onChange());
        if (this.phase !== "eva") this.crewSend({ type: "eva", state: "idle" });
        this.sendPlan();
      }
      this.renderHabChip();
    });
    view.onHover = (p, cx, cy) => this.hover(p, cx, cy);
    new ResizeObserver(() => this.renderProfileChart()).observe($("#bottom"));
    new ResizeObserver(() => this.updateInsets()).observe($("#app"));

    this.historyIndex = (history.state as { cairn?: number } | null)?.cairn ?? 0; // after a reload mid-history
    this.applyPlanHash(location.hash);
    this.renderLeft();
    this.renderRight();
    this.renderBottom();
    this.syncViewButtons();
    if (this.pendingRover) void this.moveRover(this.pendingRover);
    else void this.replan();
  }

  // ================================================================ chrome
  private bindChrome(): void {
    $("#views").innerHTML = [
      ["plan", ic.map, "Map", "Top-down planning map"],
      ["orbit", ic.box, "3D", "Tilted 3D terrain"],
      ["walk", ic.visor, "Visor", "First-person helmet display"],
    ].map(([v, i, label, title]) => `<button data-view="${v}" title="${title}">${i}<span>${label}</span></button>`).join("");
    $(".top-actions").innerHTML = `
      <button id="btn-panels" class="compact-only" title="Route and map layers">${ic.layers}<span>Route & layers</span></button>
      <button id="btn-hab" class="hab-chip" title="Mission Control">${ic.radio}<span>Mission Control</span><i></i></button>
      <button id="btn-roam" title="Free roam: walk anywhere on foot, in Mars gravity">${ic.walk}<span>Free roam</span></button>
      <button id="btn-demo" class="demo-btn" title="Play the guided demo">${ic.play}<span>Demo</span></button>
      <button id="btn-about" aria-haspopup="menu" title="Briefing, data sources and assumptions">${ic.info}<span>About</span>${ic.chev}</button>`;
    $("#about-menu").innerHTML = `
      <button data-about="briefing">${ic.book}<span><b>Mission briefing</b><small>The site, the story and why it matters</small></span></button>
      <button data-about="sources">${ic.data}<span><b>Data sources</b><small>Where every layer and number comes from</small></span></button>
      <button data-about="model">${ic.sliders}<span><b>Suit and model assumptions</b><small>Oxygen, walking and radiation models</small></span></button>
      <button data-about="scenarios">${ic.play}<span><b>Scenarios</b><small>One tap sets up a story: a clear morning, the 2024 solar storm, a global dust storm, two astronauts, a suit leak</small></span></button>
      <button data-about="offline">${ic.offline}<span><b>Use offline</b><small>Save this site to the device and install CAIRN as an app. No network needed after that.</small></span></button>
      <button data-about="keys" class="fine-pointer">${ic.keyboard}<span><b>Keyboard shortcuts</b><small>Views, zoom, pause — press ? any time</small></span></button>`;
    $("#nav").innerHTML = `
      <button data-menu="view" title="Display settings">${ic.sliders}</button>
      <i></i>
      <button data-nav="in" title="Zoom in (+)">${ic.plus}</button>
      <button data-nav="out" title="Zoom out (−)">${ic.minus}</button>
      <i class="only3d"></i>
      <button class="only3d" data-nav="left" title="Rotate left (←)">${ic.rotL}</button>
      <button class="only3d" data-nav="right" title="Rotate right (→)">${ic.rotR}</button>
      <button class="only3d" data-nav="up" title="Tilt toward top-down (↑)">${ic.up}</button>
      <button class="only3d" data-nav="down" title="Tilt toward the horizon (↓)">${ic.down}</button>
      <button class="only3d" data-nav="north" title="Face north (N)">${ic.compass}</button>`;
    $("#views").addEventListener("click", (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-view]");
      if (btn) this.setView(btn.dataset.view as "plan" | "orbit" | "fly" | "walk");
    });
    $("#nav").addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest("[data-menu]")) {
        ev.stopPropagation();
        const menu = $("#view-menu");
        if (menu.hidden) this.renderViewMenu();
        menu.hidden = !menu.hidden;
        return;
      }
      const btn = t.closest<HTMLButtonElement>("button[data-nav]");
      if (btn) this.view.nudge(btn.dataset.nav as "in" | "out" | "left" | "right" | "up" | "down" | "north");
    });
    const viewMenu = $("#view-menu");
    viewMenu.addEventListener("click", (ev) => ev.stopPropagation());
    viewMenu.addEventListener("change", (ev) => this.displayChange(ev.target as HTMLInputElement));
    viewMenu.addEventListener("input", (ev) => this.displayChange(ev.target as HTMLInputElement));
    const about = $("#about-menu");
    $("#btn-about").addEventListener("click", (ev) => {
      ev.stopPropagation();
      about.hidden = !about.hidden;
    });
    // the logo and name go back to the main menu, a page of its own (the plan stays in the address)
    $("#brand-home").addEventListener("click", () => dissolveTo(`?site=${encodeURIComponent(this.site.id)}&menu=1${location.hash}`));
    about.addEventListener("click", (ev) => {
      const item = (ev.target as HTMLElement).closest<HTMLElement>("[data-about]")?.dataset.about;
      if (!item) return;
      about.hidden = true;
      if (item === "briefing") showBriefing(this.site, this.sites, "overlay");
      else if (item === "sources") void this.about("sources");
      else if (item === "offline") void this.goOffline();
      else if (item === "scenarios") {
        openModal("Scenarios", `<p class="note">Each one is an ordinary plan with its options set. Plan it here, or walk it on foot in free roam.</p>${scenariosHtml()}`, true);
        bindScenarios($("#modal").querySelector(".scenarios")!);
      }
      else if (item === "keys") this.showShortcuts();
      else void this.about("model");
    });
    // the gesture hint goes away once it has been used
    const used = () => {
      if (this.viewMode === "walk" || this.hintSeen.has(this.viewMode)) return;
      this.hintSeen.add(this.viewMode);
      $("#nav-hint").hidden = true;
    };
    $("#scene").addEventListener("pointerdown", used);
    $("#scene").addEventListener("wheel", used, { passive: true });
    $("#btn-demo").addEventListener("click", () => void this.startDemo());
    $("#btn-roam").addEventListener("click", () => this.walkItYourself());
    $("#sheet").addEventListener("click", () => {
      this.sheetOpen = $("#app").dataset.sheet !== "open";
      this.applySheet();
    });
    $("#btn-hab").addEventListener("click", () => this.openMissionControl());
    this.renderHabChip();
    $("#btn-panels").addEventListener("click", (ev) => {
      ev.stopPropagation();
      $("#app").classList.toggle("drawer");
      requestAnimationFrame(() => this.updateInsets());
    });
    $("#stage").addEventListener("pointerdown", () => $("#app").classList.remove("drawer"));
    window.addEventListener("cairn:demo", () => void this.startDemo());
    const menu = $("#site-menu");
    menu.innerHTML = this.sites
      .map((s) => `<a role="menuitem" href="?site=${s.id}&skip=1" class="${s.id === this.site.id ? "on" : ""}"><b>${esc(s.name)}</b><span>${esc(s.place)}${s.rover ? ` · ${esc(s.rover)}` : ""}</span><em>${esc(s.tagline)}</em></a>`)
      .join("");
    $("#site-switch").addEventListener("click", (ev) => {
      ev.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    document.addEventListener("click", () => {
      menu.hidden = true;
      about.hidden = true;
      viewMenu.hidden = true;
      const exportMenu = document.getElementById("export-menu");
      if (exportMenu) exportMenu.hidden = true;
    });

    const left = $("#left");
    left.addEventListener("change", (ev) => this.leftChange(ev.target as HTMLInputElement));
    left.addEventListener("input", (ev) => this.leftInput(ev.target as HTMLInputElement));
    left.addEventListener("toggle", (ev) => {
      const t = ev.target as HTMLDetailsElement;
      if (t.id === "more-layers") this.moreLayersOpen = t.open;
    }, true); // toggle does not bubble
    left.addEventListener("click", (ev) => {
      const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-info],[data-src],[data-remove],[data-rover-reset],[data-rover-closer],[data-dwell],[data-hab],[data-note]");
      if (!t) return;
      if (t.dataset.note) this.openNote(t.dataset.note);
      else if (t.dataset.hab && this.hab) {
        if (t.dataset.hab === "park") void this.moveRover(this.hab.best);
        else this.showHabBest();
      } else if (t.dataset.info) this.openCard(t.dataset.info, false);
      else if (t.dataset.src) void this.about("sources", t.dataset.src);
      else if (t.dataset.remove) this.removeCustom(t.dataset.remove);
      else if (t.dataset.roverReset) void this.moveRover(this.roverHome);
      else if (t.dataset.roverCloser) this.parkCloser();
      else if (t.dataset.dwell) {
        const p = this.poi(t.dataset.dwell);
        if (p) this.setDwell(p.id, p.dwellMin + Number(t.dataset.d ?? 0));
      }
    });

    const right = $("#right");
    right.addEventListener("change", (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.id === "opt-storm") this.storm = t.checked;
      if (t.id === "opt-buddy") this.buddy = t.checked;
      if (t.id === "opt-storm" || t.id === "opt-buddy") this.writePlanHash();
      if (t.id === "opt-straight") {
        this.showStraight = t.checked;
        this.pushRoutes();
        this.renderBottom();
      }
    });
    right.addEventListener("toggle", (ev) => {
      const t = ev.target as HTMLDetailsElement;
      if (t.id === "plan-details") this.detailsOpen = t.open;
    }, true);
    right.addEventListener("input", (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.id !== "start" || !this.plan) return;
      this.startLmst = Number(t.value);
      const b = this.plan.budget;
      setText($("#start-val"), `${fmtLmst(this.startLmst)} LMST`);
      setText($("#sun-val"), `Sun ${this.sunText(this.sunAtEva(0))} → ${this.sunText(this.sunAtEva(b.totalTimeS))} at ${fmtLmst(this.lmstAt(b.totalTimeS))}`);
      setText(document.getElementById("earth-val"), this.earthText());
    });
    right.addEventListener("change", (ev) => {
      if ((ev.target as HTMLElement).id !== "start") return;
      this.renderRight(); // refresh warnings and dose
      this.writePlanHash();
    });
    right.addEventListener("click", (ev) => {
      const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!t) return;
      const act = t.dataset.act;
      if (act === "start") this.startEva();
      else if (act === "walk-it") this.walkItYourself();
      else if (act === "fly") this.setView("fly");
      else if (act === "cue") this.openCueCard();
      else if (act === "export") {
        ev.stopPropagation();
        const menu = document.getElementById("export-menu");
        if (menu) menu.hidden = !menu.hidden;
      } else if (act === "kml" || act === "geojson") void this.exportRoute(act);
      else if (act === "notes-zip") void this.exportNotebook();
      else if (act === "link") void this.copyPlanLink();
      else if (act === "resume") this.resumeRemaining();
      else if (act === "show-radio") this.selectLayer("radio");
      else if (act === "relay-on" || act === "relay-off") this.setRelay(act === "relay-on");
      else if (act === "relay-auto") {
        this.relayManual = null;
        void this.replan();
      }
      else if (act === "spot") this.showSpot(t.dataset.spot === "steep" ? "steep" : "home");
      else if (act === "check") this.openCheck(t.dataset.check ?? "");
      else if (act === "show-track") {
        this.showTrack = !this.showTrack;
        this.view.setTrackVisible(this.showTrack);
        this.renderRight();
      } else if (act === "emergency") void this.triggerEmergency(t.dataset.kind as EmergencyKind);
      else if (act === "replan") this.backToPlanning();
      else if (act === "save-log") this.saveLog();
      else if (act === "sources") void this.about("sources", t.dataset.id);
      else if (act === "model") void this.about("model");
    });

    window.addEventListener("keydown", (ev) => this.onKey(ev));
    window.addEventListener("popstate", (ev) => {
      this.historyIndex = (ev.state as { cairn?: number } | null)?.cairn ?? 0;
      this.restoreFromHash();
    });

    $("#bottom").addEventListener("click", (ev) => {
      const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!t) return;
      const act = t.dataset.act;
      if (act === "pause") {
        this.paused = !this.paused;
        this.renderBottom();
      } else if (act === "speed") {
        this.speed = Number(t.dataset.v);
        this.renderBottom();
      } else if (act === "voice") {
        this.voice.set(!this.voice.enabled);
        this.renderBottom();
        if (this.voice.enabled) this.voice.say(L.fixed("on"), "urgent");
      } else if (act === "skip") this.skipAhead();
      else if (act === "note-here" && this.mission) {
        const pose = this.member === "ev2" ? this.mission.buddyPose() : this.mission.pose();
        this.addNote({ x: pose.x, y: pose.y });
      }
      else if (act === "end") this.backToPlanning();
      else if (act === "chart") {
        this.chartOpen[this.viewMode] = !this.chartIsOpen();
        this.renderBottom();
      }
    });
  }

  /** Keyboard shortcuts (the 3D camera keys live in the scene view). */
  private onKey(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement | null;
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "z" && this.phase === "planning" && $("#modal").hidden) {
      ev.preventDefault();
      if (ev.shiftKey) history.forward();
      else if (this.historyIndex > 0) history.back(); // never back out of CAIRN itself
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    if (!$("#pano").hidden) return; // the panorama has its own keys
    if (ev.key === "Escape") {
      if (!$("#modal").hidden) $("#modal").hidden = true;
      else if (!$("#card").hidden) this.closeCard();
      else if (!$("#pin-menu").hidden) $("#pin-menu").hidden = true;
      return;
    }
    if (!$("#briefing").hidden || !$("#modal").hidden) return;
    const views: Record<string, "plan" | "orbit" | "walk"> = { "1": "plan", "2": "orbit", "3": "walk" };
    if (views[ev.key]) {
      ev.preventDefault();
      this.setView(views[ev.key]);
    } else if (ev.key === " " && this.phase === "eva" && (!t || t === document.body || t.tagName === "CANVAS")) {
      ev.preventDefault();
      this.paused = !this.paused;
      this.renderBottom();
    } else if (ev.key === "?") {
      ev.preventDefault();
      this.showShortcuts();
    }
  }

  private showShortcuts(): void {
    const row = (keys: string[], what: string) => `<tr><td>${keys.map((k) => `<kbd>${esc(k)}</kbd>`).join(" ")}</td><td>${what}</td></tr>`;
    openModal(
      "Keyboard shortcuts",
      `<table class="keys">
        ${row(["1"], "Map")}
        ${row(["2"], "3D")}
        ${row(["3"], "Visor (first person)")}
        ${row(["+", "−"], "Zoom in and out")}
        ${row(["←", "→", "↑", "↓"], "3D: rotate and tilt")}
        ${row(["N"], "3D: face north")}
        ${row(["Space"], "Pause or resume the EVA")}
        ${row(["Ctrl/⌘", "Z"], "Undo a change to the plan (Shift for redo)")}
        ${row(["Esc"], "Close the open card or dialog")}
        ${row(["?"], "This list")}
      </table>
      <p class="hint">Mouse: drag to move (map) or rotate (3D), scroll to zoom, click to add a stop, double-click to fly there.</p>`,
      false,
    );
  }

  private setView(mode: "plan" | "orbit" | "fly" | "walk"): void {
    if (mode === "fly") {
      if (!this.plan) return this.toast("Plan a route first.");
      const samples: PathSample[] = this.plan.legs.flatMap((l) => l.samples);
      this.viewMode = "orbit";
      this.syncViewButtons("fly");
      void this.view.flyAlong(samples, 16).then(() => this.syncViewButtons());
      $("#hud").hidden = true;
      return;
    }
    if (mode === "walk") {
      const pose = this.mission ? this.mission.pose() : null;
      const first = this.plan?.legs[0]?.samples;
      const heading = pose ? pose.headingRad : first && first.length > 1 ? Math.atan2(first[1].x - first[0].x, first[1].y - first[0].y) : 0;
      const at = pose ?? this.rover;
      this.view.enterWalk(at.x, at.y, heading);
      this.viewMode = "walk";
      this.renderHud();
    } else {
      // the 3D view opens on the astronaut during an EVA, otherwise on the middle of the planned stops
      const pose = this.mission?.pose();
      const stops = this.plan?.order ?? [this.rover];
      const centre = { x: stops.reduce((s, p) => s + p.x, 0) / stops.length, y: stops.reduce((s, p) => s + p.y, 0) / stops.length };
      this.view.setMode(mode, mode === "orbit" ? (pose ? { x: pose.x, y: pose.y } : centre) : undefined);
      this.viewMode = mode;
      $("#hud").hidden = true;
    }
    this.syncViewButtons();
    this.hover(null, 0, 0);
  }

  private syncViewButtons(override?: string): void {
    const active = override ?? this.viewMode;
    const lit = active === "fly" ? "orbit" : active; // the fly-through is part of the 3D view
    for (const b of $("#views").querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("on", b.dataset.view === lit);
    const walk = this.viewMode === "walk";
    if (walk || active === "fly") $("#view-menu").hidden = true;
    if ($("#app").classList.contains("chart-closed") === this.chartIsOpen()) this.renderBottom();
    $("#app").dataset.view = active;
    $("#app").dataset.phase = this.phase;
    this.applySheet();
    requestAnimationFrame(() => this.updateInsets());
    $("#mapwidgets").hidden = walk;
    $("#nav").hidden = walk || active === "fly";
    $("#nav").classList.toggle("flat", this.viewMode === "plan");
    const hint = $("#nav-hint");
    hint.hidden = walk || active === "fly" || this.hintSeen.has(this.viewMode);
    hint.innerHTML =
      this.viewMode === "plan"
        ? "<b>Drag</b> pan <i></i> <b>Scroll</b> zoom <i></i> <b>Click</b> add a stop <i></i> <b>3D</b> to rotate"
        : "<b>Drag</b> rotate <i></i> <b>Shift-drag</b> pan <i></i> <b>Scroll</b> zoom <i></i> <b>Double-click</b> fly there";
  }

  /** Local mean solar time at EVA time `tS`. */
  private lmstAt(tS: number): number {
    return this.startLmst + tS / MARS_HOUR_S;
  }

  private sunAtEva(tS: number): SunPosition {
    return sunAt(this.lat, this.lmstAt(tS), this.solar);
  }

  /** Earth, Phobos and Deimos over the site at EVA time `tS` (the EVA's sol, leaving at the chosen time). */
  private skyAt(tS: number): MarsSky {
    const utc = utcAtLmst(this.solUtc, lmstAtUtc(this.solUtc, this.lon), this.startLmst) + tS * 1000;
    return marsSky(utc, this.lat, this.lon);
  }

  /** Where Earth is at the start of the EVA, and how far away by radio. */
  private earthText(): string {
    const s = this.skyAt(0);
    const where = s.earth.elevation > 0 ? `${Math.round(s.earth.elevation)}° up, ${App.compass(s.earth.azimuth)}` : "below the horizon";
    return `Earth ${fmtLightTime(s.lightTimeS)} away by radio, one way · ${where} at the start`;
  }

  /** Report something to Mission Control: it arrives one light time later, a reply can come back after two. */
  private tellEarth(what: string, reply: boolean): number {
    const t = this.mission?.t ?? 0;
    const lt = this.skyAt(t).lightTimeS;
    this.earthQueue.push({ t: t + lt, text: `Mission Control receives: ${what}` });
    if (reply) this.earthQueue.push({ t: t + 2 * lt, text: `Earliest possible answer from Earth on: ${what}` });
    this.earthQueue.sort((a, b) => a.t - b.t);
    return lt;
  }

  /**
   * Start times (06:00–17:00 on the slider) that keep the Sun above 8° for the whole walk:
   * a gradient for the slider track and one line of text.
   */
  private daylightTrack(totalS: number): { gradient: string; text: string } {
    const ok: boolean[] = [];
    for (let t = 6; t <= 17.0001; t += 0.25) {
      ok.push(sunAt(this.lat, t, this.solar).elevation >= 8 && sunAt(this.lat, t + totalS / MARS_HOUR_S, this.solar).elevation >= 8);
    }
    const good = "rgba(198, 244, 50, 0.6)";
    const bad = "rgba(255, 255, 255, 0.12)";
    const stops: string[] = [];
    ok.forEach((v, i) => {
      const a = (i / ok.length) * 100;
      const b = ((i + 1) / ok.length) * 100;
      stops.push(`${v ? good : bad} ${a.toFixed(1)}% ${b.toFixed(1)}%`);
    });
    const first = ok.indexOf(true);
    const last = ok.lastIndexOf(true);
    // sunrise and sunset: where the Sun's elevation crosses the horizon, to the minute
    const cross = (from: number, to: number) => {
      let a = from;
      let b = to;
      const up = sunAt(this.lat, b, this.solar).elevation > 0;
      for (let i = 0; i < 20; i++) {
        const m = (a + b) / 2;
        if ((sunAt(this.lat, m, this.solar).elevation > 0) === up) b = m;
        else a = m;
      }
      return b;
    };
    const rise = cross(0, 12);
    const set = cross(24, 12);
    const text = `${first < 0
      ? "No start time keeps the Sun above 8° for the whole walk: shorten it."
      : `Daylight the whole way when leaving ${fmtLmst(6 + first * 0.25)}–${fmtLmst(6 + last * 0.25)} (green).`} Sunrise ${fmtLmst(rise)}, sunset ${fmtLmst(set)}.`;
    return { gradient: `linear-gradient(90deg, ${stops.join(", ")})`, text };
  }

  /**
   * The EVA over time: walking (blue) and science (teal) bars with stop letters, radio blackouts
   * (lavender), the Sun's elevation (yellow line) and the oxygen left (white line, reserve dashed).
   */
  private timelineSvg(): string {
    const plan = this.plan;
    if (!plan) return "";
    const P = this.P;
    const b = plan.budget;
    const total = Math.max(60, b.totalTimeS);
    const W = 300;
    const H = 96;
    const X = (t: number) => (t / total) * W;
    const barY = 54;
    const bars: string[] = [];
    const lost: string[] = [];
    const o2: string[] = [`0,${(10).toFixed(1)}`];
    const o2Y = (left: number) => 10 + (1 - left / P.o2SupplyL) * 36;
    let t = 0;
    let used = 0;
    let leg = 0;
    let stopNo = 0;
    for (const seg of b.segments) {
      if (seg.kind === "walk") {
        bars.push(`<rect class="walk" x="${X(t).toFixed(1)}" y="${barY}" width="${Math.max(0.5, X(seg.path.time)).toFixed(1)}" height="10"/>`);
        // radio blackouts along this leg
        let start: number | null = null;
        const smp = seg.path.samples;
        for (let i = 0; i < smp.length; i++) {
          const off = this.lostOnPlan(smp[i].x, smp[i].y, leg, i);
          if (off && start === null) start = t + smp[i].time;
          if ((!off || i === smp.length - 1) && start !== null) {
            lost.push(`<rect class="lost" x="${X(start).toFixed(1)}" y="${barY - 3}" width="${Math.max(1, X(t + smp[i].time - start)).toFixed(1)}" height="16"/>`);
            start = null;
          }
        }
        used += walkO2(seg.path, P);
        t += seg.path.time;
        o2.push(`${X(t).toFixed(1)},${o2Y(P.o2SupplyL - used).toFixed(1)}`);
        leg++;
      } else {
        stopNo++;
        const silent = !inContact(this.radio, this.site.grid, seg.poi.x, seg.poi.y, this.useRelay && plan.relay && leg >= plan.relay.leg + 1 ? this.relayShadowAt(plan.relay.at) : null);
        if (silent) lost.push(`<rect class="lost" x="${X(t).toFixed(1)}" y="${barY - 3}" width="${X(seg.durationS).toFixed(1)}" height="16"/>`);
        bars.push(`<rect class="dwell" x="${X(t).toFixed(1)}" y="${barY}" width="${X(seg.durationS).toFixed(1)}" height="10"/><text class="lbl" x="${X(t + seg.durationS / 2).toFixed(1)}" y="${barY + 22}" text-anchor="middle">${stopNo}</text>`);
        used += o2Litres(0, seg.durationS, P.workingW, P);
        t += seg.durationS;
        o2.push(`${X(t).toFixed(1)},${o2Y(P.o2SupplyL - used).toFixed(1)}`);
      }
    }
    // Sun elevation, 0–90° over the same height band as the oxygen line
    const sun: string[] = [];
    for (let k = 0; k <= 40; k++) {
      const tt = (k / 40) * total;
      const el = Math.max(0, this.sunAtEva(tt).elevation);
      sun.push(`${X(tt).toFixed(1)},${(46 - (el / 90) * 36).toFixed(1)}`);
    }
    const reserveY = o2Y(P.o2SupplyL * P.reserveFraction);
    const hours = Math.floor(total / 3600);
    const ticks = Array.from({ length: hours + 1 }, (_, h) => h).map((h) => `<line class="tick" x1="${X(h * 3600).toFixed(1)}" x2="${X(h * 3600).toFixed(1)}" y1="${barY + 12}" y2="${barY + 15}"/><text class="axis" x="${X(h * 3600).toFixed(1)}" y="${H - 2}" text-anchor="${h === 0 ? "start" : "middle"}">${fmtLmst(this.lmstAt(h * 3600))}</text>`);
    return `<svg class="timeline" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="EVA timeline: walking, science, radio blackouts, Sun and oxygen">
        <line class="reserve" x1="0" x2="${W}" y1="${reserveY.toFixed(1)}" y2="${reserveY.toFixed(1)}"/>
        <polyline class="sun" points="${sun.join(" ")}"/>
        <polyline class="o2" points="${o2.join(" ")}"/>
        <text class="end o2t" x="${W}" y="${(o2Y(P.o2SupplyL - used) - 3).toFixed(1)}" text-anchor="end">O₂ ${Math.round(P.o2SupplyL - used)} L</text>
        <text class="end sunt" x="${W}" y="${(46 - (Math.max(0, this.sunAtEva(total).elevation) / 90) * 36 + 10).toFixed(1)}" text-anchor="end">Sun ${Math.round(this.sunAtEva(total).elevation)}°</text>
        ${lost.join("")}${bars.join("")}${ticks.join("")}
        <text class="axis end" x="${W}" y="${H - 2}" text-anchor="end">${fmtLmst(this.lmstAt(total))}</text>
      </svg>
      <p class="tl-key"><i class="walk"></i>walking <i class="dwell"></i>science <i class="lost"></i>no radio <i class="sun"></i>Sun height <i class="o2"></i>oxygen left (dashed: reserve)</p>`;
  }

  /** A safety check chip shows where it comes from: a map layer, or the part of the panel behind it. */
  private openCheck(name: string): void {
    const layers: Record<string, LayerId> = { terrain: "risk", shelter: "shelter", radio: "radio" };
    if (layers[name]) {
      this.selectLayer(layers[name]);
      this.toast(`${name[0].toUpperCase()}${name.slice(1)}: showing the ${LAYERS.find((l) => l.id === layers[name])?.name ?? name} layer.`, 2500);
      return;
    }
    const target = name === "daylight" ? "#start" : name === "oxygen" ? ".o2" : name === "time" ? "#plan-details" : null;
    const el = target ? document.querySelector<HTMLElement>(`#right ${target}`) : null;
    if (name === "time") (el as HTMLDetailsElement | null)?.setAttribute("open", "");
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (el instanceof HTMLInputElement) el.focus();
  }

  /** One row of safety checks for the plan: terrain, oxygen, time, shelter, radio, daylight. */
  private checksHtml(lowSun: boolean, margin: number): string {
    const checks = this.planChecks(lowSun, margin);
    return checks.length
      ? `<ul class="checks" aria-label="Safety checks">${checks
          .map(([name, ok, why]) => `<li><button class="${ok ? "ok" : "warn"}" data-act="check" data-check="${name.toLowerCase()}" title="${esc(why)}">${ok ? ic.check : ic.warn}<span>${name}</span></button></li>`)
          .join("")}</ul>`
      : "";
  }

  private planChecks(lowSun: boolean, margin: number): [string, boolean, string][] {
    const plan = this.plan;
    if (!plan) return [];
    const b = plan.budget;
    const P = this.P;
    const limit = this.site.meta.model.slopeLimitDeg;
    const silent = this.silentStops();
    const rc = plan.radio;
    const checks: [string, boolean, string][] = [
      ["Terrain", b.blockedM === 0 && b.maxSlopeDeg <= limit, `Steepest ground ${b.maxSlopeDeg}° (limit ${limit}°)`],
      ["Oxygen", margin >= 0, margin >= 0 ? `${Math.round(margin)} L spare after the walk home and the reserve` : `${Math.round(-margin)} L short`],
      ["Time", b.withinTime, `${fmtDur(b.totalTimeS)} outside (limit ${P.maxEvaH} h)`],
      ["Shelter", b.walkBack.maxReturnMin <= P.maxShelterMin, `The rover is at most ${Math.round(b.walkBack.maxReturnMin)} min away (aim: ${P.maxShelterMin} min, for solar storms)`],
      ["Radio", rc.coveredFraction >= 0.95 && !silent.length, silent.length ? `No contact at ${silent.map((p) => p.short).join(", ")}` : `Contact for ${Math.floor(rc.coveredFraction * 100)}% of the walk`],
      ["Daylight", !lowSun, lowSun ? "The Sun is under 8° at the start or end" : "The Sun stays above 8°"],
    ];
    return checks;
  }

  /** Season at the site from the solar longitude, and whether it is the dust-storm season (Ls 180–360). */
  private seasonText(): string {
    const ls = this.solar.ls;
    const north = ["spring", "summer", "autumn", "winter"][Math.floor(ls / 90) % 4];
    const south = ["autumn", "winter", "spring", "summer"][Math.floor(ls / 90) % 4];
    const season = `${this.lat >= 0 ? "northern" : "southern"} ${this.lat >= 0 ? north : south}`;
    return ls >= 180
      ? `Season: Ls ${Math.round(ls)}°, ${season} — dust-storm season (Ls 180–360): regional storms can cut visibility.`
      : `Season: Ls ${Math.round(ls)}°, ${season} — outside the dust-storm season.`;
  }

  private static compass(az: number): string {
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(az / 45) % 8];
  }

  private sunText(sun: { elevation: number; azimuth: number }): string {
    return sun.elevation <= 0 ? "below the horizon" : `${Math.round(sun.elevation)}° up, ${App.compass(sun.azimuth)}`;
  }

  /** Tell the 3D view which parts of the screen the floating panels cover. */
  private updateInsets(): void {
    const app = $("#app").getBoundingClientRect();
    const box = (sel: string) => {
      const el = $(sel);
      return el.offsetParent === null || getComputedStyle(el).display === "none" ? null : el.getBoundingClientRect();
    };
    const top = box("#topbar");
    const left = $("#app").classList.contains("drawer") || window.innerWidth > 1180 ? box("#left") : null; // a closed drawer covers nothing
    const right = box("#right");
    const bottom = box("#bottom");
    const sheet = !!right && right.width > app.width * 0.6; // portrait: the plan is a bottom sheet
    this.view.setInsets({
      top: top ? top.bottom - app.top : 0,
      left: left ? Math.max(0, left.right - app.left) : 0,
      right: right && !sheet ? app.right - right.left : 0,
      bottom: Math.max(bottom ? app.bottom - bottom.top : 0, sheet && right ? app.bottom - right.top : 0),
    });
  }

  private toast(text: string, ms = 3200): void {
    const el = $("#toast");
    el.textContent = text;
    el.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (el.hidden = true), ms);
  }

  // ================================================================ planning
  private poi(id: string): Poi | undefined {
    return this.pois.find((p) => p.id === id);
  }

  /** Visit order that minimises the straight-line round trip from the rover (all permutations; ≤ 6 stops). */
  private orderStops(): Poi[] {
    const stops = this.selected.map((id) => this.poi(id)!).filter(Boolean);
    if (stops.length <= 1 || stops.length > 6) return stops;
    const dist = (a: XY, b: XY) => Math.hypot(a.x - b.x, a.y - b.y);
    let best: Poi[] = stops;
    let bestLen = Infinity;
    const permute = (rest: Poi[], acc: Poi[], len: number) => {
      if (len >= bestLen) return;
      if (rest.length === 0) {
        const total = len + dist(acc[acc.length - 1], this.rover);
        if (total < bestLen) {
          bestLen = total;
          best = acc.slice();
        }
        return;
      }
      for (let i = 0; i < rest.length; i++) {
        const next = rest[i];
        permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, next], len + dist(acc.length ? acc[acc.length - 1] : this.rover, next));
      }
    };
    permute(stops, [], 0);
    // A round trip is equally long in both directions: start with the stop listed first (primary objectives lead).
    const rank = (p: Poi) => this.pois.indexOf(p);
    return rank(best[0]) <= rank(best[best.length - 1]) ? best : best.slice().reverse();
  }

  /** Free roam with this plan as a mission: the planned route, its stops in order, the totals to beat. */
  /**
   * Go out on foot in free roam: with the plan as a mission (planning), or freely.  The other astronaut,
   * linked through the hab, is told and follows (`follow`: this is that following, so do not echo it).
   */
  private walkItYourself(follow = false): void {
    const site = encodeURIComponent(this.site.id);
    const crew = `${this.member === "ev2" ? "&crew=ev2" : ""}${sessionParam(this.habLink.session)}`; // the same session on foot
    const p = this.plan;
    const tau = +this.dustTau.toFixed(2);
    if (!follow) this.habLink?.send({ type: "outside", hash: p && this.phase === "planning" ? location.hash : "", tau });
    if (!p || this.phase !== "planning") return dissolveTo(`?site=${site}&roam=1${crew}`);
    const b = p.budget;
    saveRoamPlan({
      site: this.site.id,
      hash: location.hash,
      rover: { x: this.rover.x, y: this.rover.y },
      startLmst: this.startLmst,
      stops: p.order.slice(1, -1).map((s) => ({ id: s.id, name: s.name, short: s.short, x: s.x, y: s.y, dwellMin: s.dwellMin })),
      legs: p.legs.map((l) => l.points.map((q) => ({ x: q.x, y: q.y }))),
      planned: { o2L: b.o2UsedL, timeS: b.totalTimeS, walkTimeS: b.walkTimeS, distM: b.distanceM },
    });
    dissolveTo(`?site=${site}&roam=1${crew}&tau=${tau}${location.hash}`); // the planner's dust goes too
  }

  /** The other astronaut went out on foot: follow them in a few seconds, unless this one stays. */
  private offerFollow(from: "ev1" | "ev2", hash: string, tau: number): void {
    if (this.phase === "eva") return; // mid-EVA in the planner: not now
    document.querySelector(".roam-join")?.remove();
    const card = document.createElement("div");
    card.className = "roam-join";
    card.setAttribute("role", "alertdialog");
    const who = from.toUpperCase();
    let left = 4;
    card.innerHTML = `<p class="eyebrow">// ${who} is going out on foot</p>
      <b>${who} stepped out in free roam. You follow in <span data-left>${left}</span> s.</b>
      <span>Same ${hash ? "plan" : "site"}; you see each other's suits.</span>
      <div class="roam-join-acts"><button class="primary" data-join>Join now</button><button data-stay>Stay here</button></div>`;
    document.body.append(card);
    const go = () => {
      window.clearInterval(timer);
      card.remove();
      const site = encodeURIComponent(this.site.id);
      const crew = `${this.member === "ev2" ? "&crew=ev2" : ""}${sessionParam(this.habLink.session)}`;
      // the same plan as this planner: hand it over as a mission (EV1 keeps the routed legs); otherwise go with theirs
      if (hash && hash === location.hash && this.plan) this.walkItYourself(true);
      else dissolveTo(`?site=${site}&roam=1${crew}${tau ? `&tau=${tau}` : ""}${hash}`);
    };
    const timer = window.setInterval(() => {
      left -= 1;
      const el = card.querySelector("[data-left]");
      if (el) el.textContent = String(left);
      if (left <= 0) go();
    }, 1000);
    card.querySelector("[data-join]")!.addEventListener("click", go);
    card.querySelector("[data-stay]")!.addEventListener("click", () => {
      window.clearInterval(timer);
      card.remove();
      this.toast(`${who} is walking in free roam. Free roam (top bar) joins them later.`, 5000);
    });
  }

  private async replan(): Promise<void> {
    const seq = ++this.planSeq;
    const stops = this.orderStops();
    if (stops.length === 0) {
      this.plan = null;
      this.planError = "Select at least one objective.";
      this.afterPlan();
      return;
    }
    const order = [this.rover, ...stops, this.rover];
    this.busy = true;
    this.renderRight();
    const grid = this.site.grid;
    const result = await this.router.route(order.map((p) => ({ x: p.x, y: p.y })));
    if (seq !== this.planSeq) return;
    this.busy = false;

    const missing = result.legs.findIndex((l) => l === null);
    if (missing >= 0) {
      this.plan = null;
      this.planError = `No safe route between ${order[missing].short} and ${order[missing + 1].short}: the ground in between is too steep to walk.`;
      this.afterPlan();
      return;
    }
    const legs = result.legs.map((pts) => measurePath(grid, pts!, this.P));
    const straight = order.slice(1).map((p, i) => measurePath(grid, [order[i], p], this.P));
    const segments: Segment[] = [];
    legs.forEach((path, i) => {
      const to = order[i + 1];
      segments.push({ kind: "walk", path, to, label: to.short });
      if (to.kind !== "shelter") segments.push({ kind: "dwell", poi: to, durationS: to.dwellMin * 60, sheltered: false });
    });
    let relay = bestRelay(this.radio, grid, legs, RELAY_MAST_M,
      order.slice(1, -1).map((p, k) => ({ x: p.x, y: p.y, seconds: p.dwellMin * 60, afterLeg: k })));
    if (this.relayManual) {
      // the crew's own spot instead of CAIRN's (still checked: near the route, rover in sight)
      const mine = relayAtPoint(this.radio, grid, legs, this.relayManual, RELAY_MAST_M);
      if ("relay" in mine) relay = mine.relay;
      else {
        this.relayManual = null;
        this.toast(`${mine.reason} The relay is back where CAIRN suggests.`, 7000);
      }
    }
    let relayAtS = 0;
    if (relay) {
      // walk and dwell times up to the relay spot
      for (let i = 0; i < relay.leg; i++) relayAtS += legs[i].time + (order[i + 1].kind === "shelter" ? 0 : order[i + 1].dwellMin * 60);
      relayAtS += legs[relay.leg].samples[relay.sample].time;
    }
    this.plan = {
      order, legs, straight, budget: buildBudget(segments, this.P, this.lookup, (poi) => grid.shieldAt(poi.x, poi.y)), routeMs: result.ms,
      radio: relay && this.useRelay
        ? radioCoverage(this.radio, grid, legs, relayFromShadow(this.relayShadowAt(relay.at), grid, relay.leg, relay.sample))
        : radioCoverage(this.radio, grid, legs),
      relay, relayAtS,
    };
    this.pushRelay();
    this.planError = null;
    this.afterPlan();
  }

  private afterPlan(): void {
    if (this.phase === "planning") this.writePlanHash();
    this.sendPlan();
    this.view.setSpot(null);
    this.pushRoutes();
    this.pushPois();
    this.renderLeft();
    this.renderRight();
    this.renderBottom();
  }

  private pushRoutes(): void {
    this.view.setRoutes({
      safe: this.plan?.legs ?? [],
      straight: this.plan?.straight ?? [],
      showStraight: this.showStraight && this.phase === "planning",
      shelter: this.shelterPath,
      dimSafe: this.shelterPath !== null,
    });
    this.renderMinimapRoutes();
  }

  private pushPois(): void {
    const order = this.plan?.order ?? [];
    const silent = new Set(this.silentStops().map((p) => p.id));
    this.view.setPois(
      this.pois.map((poi) => {
        const idx = order.findIndex((p, i) => p.id === poi.id && i > 0 && i < order.length - 1);
        return { poi, active: poi.kind === "shelter" || this.selected.includes(poi.id), order: idx > 0 ? idx : null, noRadio: silent.has(poi.id) };
      }),
    );
  }

  private groundClick(p: XY, clientX: number, clientY: number): void {
    const menu = $("#pin-menu");
    if (this.phase !== "planning" || this.member === "ev2") {
      if (this.phase !== "eva" && this.member !== "ev2") return;
      // during the EVA (and on EV2's device) a click on the ground can only take a note or a sample
      menu.innerHTML = `${PIN_CLOSE}<p class="t">${ic.note}Field notebook</p><p>Elevation ${Math.round(this.site.grid.heightAt(p.x, p.y))} m · slope ${this.site.grid.slope[this.site.grid.nodeAt(p.x, p.y)]}°</p><div class="row"><button data-x="sample">${ic.sample}<span>Sample</span></button><button class="primary" data-x="note">${ic.note}<span>Note</span></button></div>`;
      this.placePinMenu(menu, clientX, clientY);
      menu.onclick = (ev) => {
        const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-x]")?.dataset.x;
        if (!act) return;
        menu.hidden = true;
        if (act === "note" || act === "sample") this.addNote(p, act === "sample");
      };
      return;
    }
    const grid = this.site.grid;
    const node = grid.nodeAt(p.x, p.y);
    const blocked = grid.isBlocked(node) || !Number.isFinite(this.field.time[node]);
    menu.innerHTML = blocked
      ? `<p class="t bad">${ic.warn}Too steep to walk</p><p>Slope ${grid.slope[node]}°, beyond the ${this.site.meta.model.slopeLimitDeg}° limit or cut off from the rover.</p><div class="row"><button data-x="close">OK</button></div>`
      : `${PIN_CLOSE}<p class="t">${ic.walk}${fmtDur(this.field.time[node])} from the rover</p><p>Slope ${grid.slope[node]}°${this.site.geologyGrid ? ` · ${esc(this.unitAt(p.x, p.y) ?? "unmapped unit")}` : ""}</p><div class="row">${
          grid.slope[node] <= ROVER_PARK_MAX_SLOPE ? `<button data-x="rover" title="Move the rover (start, end and shelter) here">${ic.home}<span>Park rover</span></button>` : ""
        }${this.plan ? `<button data-x="relay" title="Put the radio relay mast here (within ${RELAY_MAX_OFF_ROUTE_M} m of the route, with the rover in sight from its ${RELAY_MAST_M} m top)">${ic.radio}<span>Relay here</span></button>` : ""}<button data-x="note" title="Geotagged field note or sample here">${ic.note}<span>Note</span></button><button class="primary" data-x="add">${ic.plus}<span>Add stop</span></button></div>`;
    this.placePinMenu(menu, clientX, clientY);
    menu.onclick = (ev) => {
      const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-x]")?.dataset.x;
      if (!act) return;
      menu.hidden = true;
      if (act === "add") this.addCustom(p);
      else if (act === "rover") void this.moveRover(p);
      else if (act === "relay") this.placeRelay(p);
      else if (act === "note") this.addNote(p);
    };
  }

  /**
   * Show the map-click menu next to the click, on the map: beside the pointer, flipped to its left or
   * above it when it would run under a side panel, the chart, or off the screen.
   */
  private placePinMenu(menu: HTMLElement, clientX: number, clientY: number): void {
    menu.style.left = "0px";
    menu.style.top = "0px";
    menu.hidden = false;
    const stage = $("#stage").getBoundingClientRect();
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    let maxX = stage.right - 8;
    let maxY = stage.bottom - 8;
    for (const id of ["#right", "#bottom"]) {
      const el = document.querySelector<HTMLElement>(id);
      if (!el || el.hidden || getComputedStyle(el).display === "none") continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const beside = r.left > stage.left + stage.width / 2 && clientY >= r.top - h && clientY <= r.bottom; // a panel on the right
      const below = r.top > stage.top + stage.height / 2 && clientX >= r.left - w && clientX <= r.right; // a panel along the bottom
      if (beside) maxX = Math.min(maxX, r.left - 8);
      if (below) maxY = Math.min(maxY, r.top - 8);
    }
    let x = clientX + 12;
    if (x + w > maxX) x = clientX - 12 - w;
    let y = clientY + 12;
    if (y + h > maxY) y = clientY - 12 - h;
    x = Math.max(stage.left + 8, Math.min(x, maxX - w));
    y = Math.max(stage.top + 8, Math.min(y, maxY - h));
    menu.style.left = `${Math.round(x - stage.left)}px`;
    menu.style.top = `${Math.round(y - stage.top)}px`;
  }

  /**
   * Park the rover on flat ground as close as possible to the chosen stops: the point with the smallest
   * sum of distances to them (Weiszfeld's geometric median), moved to the nearest spot where the rover
   * can park.  The crew can undo it like any other change.
   */
  private parkCloser(): void {
    const stops = this.selected.map((id) => this.poi(id)).filter((p): p is Poi => !!p);
    const median = geometricMedian(stops);
    if (!median) return;
    const { x, y } = median;
    // nearest node that is flat, passable and can still reach every stop
    const grid = this.site.grid;
    let best: XY | null = null;
    let bestD = Infinity;
    for (let r = 0; r <= 300 && !best; r += 8) {
      for (let a = 0; a < 360; a += r ? Math.max(4, 360 / (r / 4)) : 360) {
        const px = x + r * Math.cos((a * Math.PI) / 180);
        const py = y + r * Math.sin((a * Math.PI) / 180);
        if (!grid.inside(px, py)) continue;
        const node = grid.nodeAt(px, py);
        if (grid.isBlocked(node) || grid.slope[node] > ROVER_PARK_MAX_SLOPE || !Number.isFinite(this.field.time[node])) continue;
        const d = Math.hypot(px - x, py - y);
        if (d < bestD) {
          bestD = d;
          best = { x: px, y: py };
        }
      }
    }
    if (!best) return this.toast("No flat ground near the stops to park the rover on.");
    if (Math.hypot(best.x - this.rover.x, best.y - this.rover.y) < 40) return this.toast("The rover is already about as close as it can park.");
    void this.moveRover(best);
  }

  /** Minutes on site the crew changed, by stop id (kept in the plan link). */
  private dwellOverrides: Record<string, number> = {};

  /** Change the science time at a stop (5–180 min); the plan, oxygen and link follow. */
  private setDwell(id: string, minutes: number, replan = true): void {
    const m = Math.max(5, Math.min(180, Math.round(minutes / 5) * 5));
    const original = this.site.pois.find((p) => p.id === id)?.dwellMin ?? 10;
    this.pois = this.pois.map((p) => (p.id === id ? { ...p, dwellMin: m } : p));
    if (m === original && !id.startsWith("custom-")) delete this.dwellOverrides[id];
    else this.dwellOverrides[id] = m;
    if (replan) void this.replan();
  }

  private roverMoved(): boolean {
    return Math.hypot(this.rover.x - this.roverHome.x, this.rover.y - this.roverHome.y) > 1;
  }

  /**
   * Park the pressurised rover somewhere else: the way home from every point and the radio shadow are
   * worked out again from there (in the routing worker), then the plan follows.
   */
  private async moveRover(p: XY): Promise<void> {
    if (this.phase !== "planning") return;
    const at = { x: Math.round(p.x), y: Math.round(p.y) };
    const was = this.plan ? { km: this.plan.budget.distanceM / 1000, home: this.plan.budget.walkBack.maxReturnMin, radio: this.plan.radio.coveredFraction } : null;
    this.busy = true;
    this.renderRight();
    this.toast("Moving the rover: working out the way home from every point…", 2500);
    const field = await this.router.init(this.site.grid, this.P, at);
    this.field = field;
    this.radio = field.radio;
    this.relayCache = null;
    this.view.setShelterTimes(field.time);
    const moved: Poi = { ...this.rover, x: at.x, y: at.y };
    this.pois = this.pois.map((q) => (q === this.rover ? moved : q));
    this.rover = moved;
    this.busy = false;
    this.renderLeft();
    await this.replan();
    const now = this.plan ? { km: this.plan.budget.distanceM / 1000, home: this.plan.budget.walkBack.maxReturnMin, radio: this.plan.radio.coveredFraction } : null;
    const change = was && now
      ? ` Walk ${was.km.toFixed(2)} → ${now.km.toFixed(2)} km, longest way home ${Math.round(was.home)} → ${Math.round(now.home)} min, radio ${Math.floor(was.radio * 100)}% → ${Math.floor(now.radio * 100)}%.`
      : "";
    this.toast(`${this.roverMoved() ? "Rover parked here." : "Rover back at its planned spot."}${change}`, 5000);
  }

  private addCustom(p: XY): void {
    this.selected.push(this.customPoi(p).id);
    void this.replan();
  }

  /** A stop placed on the map (added to the list, not yet selected). */
  private customPoi(p: XY): Poi {
    const n = ++this.customCount;
    const unit = this.unitAt(p.x, p.y);
    const poi: Poi = {
      id: `custom-${n}`, kind: "optional", name: `Custom stop ${n}`, short: `Stop ${n}`, x: Math.round(p.x), y: Math.round(p.y),
      rmc: "", sols: "", dwellMin: 10, images: [],
      description: `A stop you placed on the map${unit ? `, on the ${unit}` : ""}. CAIRN routes to any walkable point in the EVA area.`,
      science: "", whyHumans: "",
    };
    this.pois.push(poi);
    return poi;
  }

  private removeCustom(id: string): void {
    this.pois = this.pois.filter((p) => p.id !== id);
    this.selected = this.selected.filter((s) => s !== id);
    void this.replan();
  }

  /** Strongest CRISM mineral signal at a node, in words (null where nothing stands out). */
  private mineralsAt(node: number): string | null {
    const m = this.site.mineralGrid;
    const bands = this.site.meta.minerals?.bands;
    if (!m || !bands) return null;
    let best = -1;
    let bestV = 0;
    if (m[node * 4 + 3] < 128) return "not imaged by CRISM";
    for (let k = 0; k < 3; k++) {
      const v = m[node * 4 + k] / 255;
      if (v > bestV) {
        bestV = v;
        best = k;
      }
    }
    if (best < 0 || bestV < 0.15) return "no strong signal";
    return `${bands[best].name} ${bestV > 0.6 ? "(strong)" : bestV > 0.3 ? "(moderate)" : "(weak)"}`;
  }

  private unitAt(x: number, y: number): string | null {
    if (!this.site.geologyGrid || !this.site.geology) return null;
    const id = this.site.geologyGrid[this.site.grid.nodeAt(x, y)];
    const u = this.site.geology.units.find((g) => g.id === id);
    return u ? `${u.name} (${u.symbol})` : null;
  }

  /** Layers this site has data for. */
  private layers(): Layer[] {
    const g = this.site.meta.grids;
    const sand = (this.site.meta.stats?.sandPct ?? 1) > 0;
    return LAYERS.filter((l) => (l.id !== "thermal" || g.thermal) && (l.id !== "geology" || g.geology) && (l.id !== "minerals" || g.minerals) && (l.id !== "shield" || this.site.grid.shield) && (l.id !== "sand" || sand));
  }

  // ================================================================ left panel
  private renderLeft(): void {
    const locked = this.phase !== "planning";
    const order = this.plan?.order ?? [];
    const stops = this.pois
      .filter((p) => p.kind !== "shelter")
      .map((p) => {
        const idx = order.findIndex((o, i) => o.id === p.id && i > 0 && i < order.length - 1);
        const on = this.selected.includes(p.id);
        const custom = p.id.startsWith("custom-");
        const kind = p.kind === "objective" ? "Primary objective" : custom ? "Your stop" : "Optional";
        return `<li class="stop${on ? " on" : ""}">
          <label>
            <input class="sr" type="checkbox" data-stop="${p.id}" ${on ? "checked" : ""} ${locked ? "disabled" : ""}/>
            <span class="pin">${idx > 0 ? idx : ic.plus}</span>
            <span class="txt"><b>${esc(p.name)}</b><small>${kind} · ${p.dwellMin} min on site</small></span>
          </label>
          ${
            on && !locked
              ? `<span class="dwell" role="group" aria-label="Minutes on site at ${esc(p.short)}"><button data-dwell="${p.id}" data-d="-5" title="5 min less on site">−</button><button data-dwell="${p.id}" data-d="5" title="5 min more on site">+</button></span>`
              : ""
          }
          ${
            custom
              ? `<button class="icon" data-remove="${p.id}" title="Remove this stop" ${locked ? "disabled" : ""}>${ic.close}</button>`
              : `<button class="icon" data-info="${p.id}" title="Photos and science">${ic.image}</button>`
          }
        </li>`;
      })
      .join("");

    // four everyday layers up front; the rest one click away, grouped by what they are for
    const avail = this.layers();
    const primaryIds = (["none", "risk", "shelter", "minerals", "slope"] as LayerId[]).filter((id) => avail.some((l) => l.id === id)).slice(0, 4);
    const rest = avail.filter((l) => !primaryIds.includes(l.id));
    const chip = (l: Layer) => `<label class="layer${l.id === this.layer ? " on" : ""}">
          <input class="sr" type="radio" name="layer" value="${l.id}" ${l.id === this.layer ? "checked" : ""}/>
          <i class="swatch" style="background:${l.swatch}"></i><span>${esc(l.name)}</span>
        </label>`;
    const primary = primaryIds.map((id) => chip(avail.find((l) => l.id === id)!)).join("");
    const groups: [string, LayerId[]][] = [["Safety", ["risk", "shelter", "radio", "slope", "sand"]], ["Science", ["minerals", "geology", "thermal"]], ["Radiation", ["shield"]], ["Base", ["hab"]]];
    const more = groups
      .map(([name, ids]) => {
        const ls = rest.filter((l) => ids.includes(l.id));
        return ls.length ? `<div class="layer-group"><h4>${name}</h4><div class="layer-grid">${ls.map(chip).join("")}</div></div>` : "";
      })
      .join("");
    const inMore = rest.some((l) => l.id === this.layer);
    const active = avail.find((l) => l.id === this.layer) ?? LAYERS[0];
    let legend = "";
    if (this.layer === "minerals" && this.site.meta.minerals) {
      const mm = this.site.meta.minerals;
      legend = `<div class="legend units">${mm.bands
        .map((b) => `<span><i style="background:rgb(${b.color.join(",")})"></i>${esc(b.name)}<em>${esc(b.parameter)}</em></span>`)
        .join("")}<span><i class="hatch"></i>Not imaged by CRISM<em>${100 - Math.round(mm.coveragePct ?? 0)}%</em></span></div>
        <p class="note">CRISM band depths at ${mm.mPerPx} m/px, scaled to these observations. Colour shows where each signal is strongest, not a mineral survey.</p>`;
    } else if (this.layer === "geology" && this.site.geology) {
      legend = `<div class="legend units">${this.site.geology.units
        .map((u) => `<span><i style="background:rgb(${u.color.join(",")})"></i>${esc(u.name)}<em>${esc(u.symbol)}</em></span>`)
        .join("")}</div>`;
    } else if (active.legend) {
      legend = `<div class="legend"><i class="ramp" style="background:${active.swatch}"></i><span>${active.legend[0]}</span><span>${active.legend[1]}</span></div>`;
    }
    if (this.layer === "hab") legend += this.habHtml(locked);

    $("#left").innerHTML = `
      <section>
        <header class="sec-head"><h2>Route</h2><span class="sub">${locked ? "Locked during the EVA" : "Tick stops · CAIRN orders them"}</span></header>
        <ul class="stops">
          <li class="stop shelter">
            <span class="pin home">${ic.home}</span>
            <span class="txt"><b>${esc(this.rover.name)}</b><small>${
              this.roverMoved()
                ? `Parked ${fmtDist(Math.hypot(this.rover.x - this.roverHome.x, this.rover.y - this.roverHome.y))} from the planned spot · <button class="link" data-rover-reset="1">put back</button>`
                : `Start, end and radiation shelter${locked ? "" : ` · <button class="link" data-rover-closer="1" title="Park the rover on flat ground closest to the chosen stops">park closer</button>`}`
            }</small></span>
            <button class="icon" data-info="${this.rover.id}" title="Photos">${ic.image}</button>
          </li>
          ${stops}
        </ul>
        ${locked ? "" : `<p class="hint">${ic.plus}<span>Click anywhere on the map to add your own stop.</span></p>`}
      </section>
      <section>
        <header class="sec-head"><h2>Map layer</h2><button class="link" data-src="${active.source}">${ic.info}<span>Source</span></button></header>
        <div class="layer-grid">${primary}</div>
        ${this.layer !== "none" ? `${legend}<label class="slider"><span>Opacity</span><input type="range" id="opacity" min="0.2" max="1" step="0.05" value="${this.opacity}"/></label>` : ""}
        ${
          rest.length
            ? `<details class="more-layers" id="more-layers" ${this.moreLayersOpen || inMore ? "open" : ""}>
                 <summary>${ic.layers}<span>More layers</span><em>${rest.length}</em>${ic.chev}</summary>${more}</details>`
            : ""
        }
      </section>
      ${this.notesHtml()}`;
  }

  /** Display settings, in a small menu on the map. */
  private renderViewMenu(): void {
    $("#view-menu").innerHTML = `
      <h3>Display</h3>
      ${this.site.rover.traverse.length ? `<label class="switch"><span>${esc(this.roverName)}'s real track</span><input class="sr" type="checkbox" id="track" ${this.showTrack ? "checked" : ""}/><i></i></label>` : ""}
      ${this.site.rover.traverse.length ? `<label class="switch"><span>Ghost of ${esc(this.roverName)}'s drive</span><input class="sr" type="checkbox" id="ghost" ${this.ghostOn ? "checked" : ""}/><i></i></label>` : ""}
      <label class="switch"><span>Sun shadows</span><input class="sr" type="checkbox" id="shadows" ${this.showShadows ? "checked" : ""}/><i></i></label>
      <label class="view-menu-dust"><span>Dust in the air</span><select id="dust">${this.dustOptions().map((o) => `<option value="${o.id}" ${o.id === this.dustId ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select><small id="dust-info">${esc(this.dustText())}</small></label>
      <div id="dust-chart">${this.dustChart()}</div>
      <label class="slider"><span>Vertical exaggeration <b id="exag-val">×${this.exag.toFixed(2)}</b></span><input type="range" id="exag" min="1" max="2.5" step="0.25" value="${this.exag}"/></label>`;
  }

  private displayChange(t: HTMLInputElement): void {
    if (t.id === "ghost") this.setGhost(t.checked);
    else if (t.id === "dust") this.setDust(t.value);
    else if (t.id === "dust-sol") {
      this.dustSol = Number(t.value);
      this.setDust("sol");
    }
    else if (t.id === "track") {
      this.showTrack = t.checked;
      this.view.setTrackVisible(this.showTrack);
    } else if (t.id === "shadows") {
      this.showShadows = t.checked;
      this.view.setShadows(this.showShadows);
    } else if (t.id === "exag") {
      this.exag = Number(t.value);
      this.view.setExaggeration(this.exag);
      setText($("#exag-val"), `×${this.exag.toFixed(2)}`);
      const tag = $("#exag-tag");
      tag.hidden = this.exag === 1;
      tag.textContent = `Heights ×${this.exag.toFixed(2)} for display`;
    }
  }

  private leftChange(t: HTMLInputElement): void {
    if (t.dataset.stop) {
      const id = t.dataset.stop;
      this.selected = t.checked ? [...this.selected, id] : this.selected.filter((s) => s !== id);
      void this.replan();
    } else if (t.name === "layer") {
      this.layer = t.value as LayerId;
      this.view.setLayer(this.layer, this.opacity);
      this.renderLeft();
    }
  }

  private leftInput(t: HTMLInputElement): void {
    if (t.id === "opacity") {
      this.opacity = Number(t.value);
      this.view.setLayerOpacity(this.opacity);
    }
  }

  // ================================================================ right panel
  private shownPhase: string | null = null;
  // ================================================================ phone sheet
  /** The phone's bottom sheet: the user's choice for this view and phase, or null (automatic). */
  private sheetOpen: boolean | null = null;
  private sheetKey = "";

  /**
   * On phones the right panel is a bottom sheet.  It starts open on the planning map (that is where you
   * plan) and as a slim bar with a summary in 3D, the visor and during an EVA, so the terrain is visible;
   * the handle opens and closes it.  On larger screens nothing changes.
   */
  private applySheet(): void {
    const key = `${this.viewMode}|${this.phase}`;
    if (key !== this.sheetKey) {
      this.sheetKey = key;
      this.sheetOpen = null; // a new view or phase: back to the sensible default
    }
    const auto = this.phase === "summary" || (this.viewMode === "plan" && this.phase === "planning");
    const open = this.sheetOpen ?? auto;
    const app = $("#app");
    if (app.dataset.sheet !== (open ? "open" : "peek")) {
      app.dataset.sheet = open ? "open" : "peek";
      $("#sheet").setAttribute("aria-expanded", String(open));
      requestAnimationFrame(() => this.updateInsets());
      window.setTimeout(() => this.updateInsets(), 320); // after the sheet has slid
    }
    this.sheetSummary();
  }

  /** The one line on the handle: the plan, or the EVA clock, where you are headed and the oxygen left. */
  private sheetSummary(): void {
    let text = "";
    const m = this.mission;
    if (this.phase === "eva" && m) {
      const ph = this.phaseLabel(m);
      text = `${fmtClock(m.t)} · ${ph.name ? `→ ${ph.name}` : ph.label} · O₂ ${Math.round(this.P.o2SupplyL - m.o2UsedL)} L`;
    } else if (this.phase === "summary") text = "EVA debrief";
    else if (this.plan) text = `EVA plan · ${fmtDist(this.plan.budget.distanceM)} · ${fmtDur(this.plan.budget.totalTimeS)}`;
    else text = this.planError ?? "EVA plan";
    setText($("#sheet-sum"), text);
  }

  private renderRight(): void {
    const host = $("#right");
    $("#app").dataset.phase = this.phase;
    this.applySheet();
    if (this.phase !== this.shownPhase) {
      // a new phase (plan → live EVA → debrief): its sections rise in one after another
      this.shownPhase = this.phase;
      requestAnimationFrame(() => playOnce(host, "phase-in", 1200));
    }
    if (this.phase === "eva") return this.renderLive(host);
    if (this.phase === "summary") return this.renderSummary(host);
    if (!this.plan) {
      host.innerHTML = `<div class="scroll"><section><header class="sec-head"><h2>EVA plan</h2></header>
        <p class="${this.busy ? "hint" : "callout warn"}">${this.busy ? "Finding the safest route…" : `${ic.warn}<span>${esc(this.planError ?? "")}</span>`}</p></section></div>`;
      return;
    }
    const b = this.plan.budget;
    const P = this.P;
    const sum = (f: (m: MeasuredPath) => number, set: MeasuredPath[]) => set.reduce((s, m) => s + f(m), 0);
    const st = this.plan.straight;
    const sf = this.plan.legs;
    const stBlocked = sum((m) => m.blockedM, st);
    const stSteep = Math.max(...st.map((m) => m.maxSlopeDeg));
    const limit = this.site.meta.model.slopeLimitDeg;
    const row = (label: string, a: string, c: string, bad = false) => `<tr><th>${label}</th><td class="${bad ? "bad" : ""}">${a}</td><td>${c}</td></tr>`;
    const usedPct = (b.o2UsedL / P.o2SupplyL) * 100;
    const reservePct = P.reserveFraction * 100;
    const issues: string[] = [];
    if (!b.withinTime) issues.push(`longer than the ${P.maxEvaH} h suit limit`);
    if (!b.withinO2) issues.push("short of oxygen to keep the reserve and walk home");
    const dose = this.rad.baseline * b.exposureH;
    const sunStart = this.sunAtEva(0);
    const sunEnd = this.sunAtEva(b.totalTimeS);
    const lowSun = sunStart.elevation < 8 || sunEnd.elevation < 8;
    const margin = b.walkBack.minMarginL;

    const stCost = sum((m) => m.cost, st) / sum((m) => m.cost, sf);
    const vs =
      stBlocked > 0
        ? `The straight line crosses <b>${fmtDist(stBlocked)}</b> steeper than ${limit}°. CAIRN goes around it.`
        : stCost >= 1.05
          ? `Walking the straight line would cost <b>${stCost.toFixed(1)}×</b> the effort and risk of this route.`
          : "The straight line is walkable here, and about as easy as this route.";

    host.innerHTML = `
      <div class="scroll">
        <section>
          <header class="sec-head"><h2>EVA plan</h2>${
            b.feasible ? `<span class="status ok">${ic.check}Within suit limits</span>` : `<span class="status bad">${ic.warn}Not safe</span>`
          }</header>
          ${issues.length ? `<p class="callout bad">${ic.warn}<span>This plan is ${issues.join(" and ")}. Remove a stop.</span></p>` : ""}
          ${lowSun ? `<p class="callout warn">${ic.warn}<span>The Sun is under 8° at the ${sunStart.elevation < 8 ? "start" : "end"} of this EVA. Long shadows hide rocks and holes, and it gets cold fast — leave later or plan a shorter walk.</span></p>` : ""}
          <div class="hero quad">
            <div><span>Distance</span>${heroDist(b.distanceM)}</div>
            <div><span>Time outside</span>${heroDur(b.totalTimeS)}</div>
            <button class="spot" data-act="spot" data-spot="home" title="Show the point of the route farthest from the rover"><span>Longest way home ${ic.locate}</span>${heroDur(b.walkBack.maxReturnMin * 60)}</button>
            <button class="spot" data-act="spot" data-spot="steep" title="Show the steepest ground on the route"><span>Steepest ground ${ic.locate}</span><b>${b.maxSlopeDeg}<small>°</small></b></button>
          </div>
          ${this.checksHtml(lowSun, margin)}
          <div class="o2">
            <div class="o2-head"><span>Oxygen</span><b>${Math.round(b.o2UsedL)} L <small>of ${P.o2SupplyL} L</small></b></div>
            <div class="meter"><i style="width:${Math.min(100, usedPct).toFixed(1)}%"></i><u style="left:${(100 - reservePct).toFixed(1)}%"></u></div>
            <p class="o2-sub"><b class="${margin >= 0 ? "good" : "bad"}">${margin >= 0 ? `${Math.round(margin)} L spare` : `${Math.round(-margin)} L short`}</b> after walking home from the farthest point and keeping the ${reservePct}% reserve</p>
          </div>
          ${this.radioLine()}
          <label class="slider start"><span>Leave the rover at <b id="start-val">${fmtLmst(this.startLmst)} LMST</b></span>
            <input type="range" id="start" min="6" max="17" step="0.25" value="${this.startLmst}" style="--track:${this.daylightTrack(b.totalTimeS).gradient}"/>
            <small id="sun-val">Sun ${this.sunText(sunStart)} → ${this.sunText(sunEnd)} at ${fmtLmst(this.lmstAt(b.totalTimeS))}</small>
            <small class="daylight">${this.daylightTrack(b.totalTimeS).text}</small>
            <small class="daylight">${this.seasonText()}</small>
            <small class="daylight" id="earth-val">${this.earthText()}</small></label>
          <div class="vs">
            <p>${vs}</p>
            <label class="switch"><span>Show the straight line on the map</span><input class="sr" type="checkbox" id="opt-straight" ${this.showStraight ? "checked" : ""}/><i></i></label>
          </div>
        </section>
        <details class="more" id="plan-details" ${this.detailsOpen ? "open" : ""}>
          <summary><span>Details</span><em>time, dose, comparison, simulation</em>${ic.chev}</summary>
          <section>
            <h3>Timeline</h3>
            ${this.timelineSvg()}
          </section>
          <section>
            <h3>Time and terrain</h3>
            <dl class="kv">
              <dt>Walking</dt><dd>${fmtDur(b.walkTimeS)}</dd>
              <dt>Science at stops</dt><dd>${fmtDur(b.stopTimeS)}</dd>
              <dt>Total climb</dt><dd>${Math.round(b.climbM)} m</dd>
              <dt>On loose sand</dt><dd>${fmtDist(b.sandM)}</dd>
              <dt>Background dose</dt><dd>${fmtDose(dose)}</dd>
            </dl>
            <p class="note">Oxygen margin: what is left at the tightest point of the plan after walking home and keeping the reserve. Dose: Curiosity RAD background, ${this.rad.baseline} µGy/h. <a data-act="model">Model assumptions</a></p>
          </section>
          <section>
            <h3>Straight line vs CAIRN <span class="sub">route found in ${Math.round(this.plan.routeMs)} ms</span></h3>
            <table class="compare">
              <thead><tr><th></th><th>Straight</th><th>CAIRN</th></tr></thead>
              <tbody>
                ${row("Distance", fmtDist(sum((m) => m.distance, st)), fmtDist(sum((m) => m.distance, sf)))}
                ${row("Impassable", fmtDist(stBlocked), "0 m", stBlocked > 0)}
                ${row("Steepest", `${stSteep}°`, `${Math.max(...sf.map((m) => m.maxSlopeDeg))}°`, stSteep > limit)}
                ${row("Loose sand", fmtDist(sum((m) => m.sandM, st)), fmtDist(sum((m) => m.sandM, sf)))}
                ${row("Effort × risk", `${stCost.toFixed(2)}×`, "1.00×", stBlocked > 0)}
              </tbody>
            </table>
          </section>
          ${this.roverCheckHtml()}
          <section>
            <h3>Simulation</h3>
            <label class="switch"><span>Replay the 20 May 2024 solar storm</span><input class="sr" type="checkbox" id="opt-storm" ${this.storm ? "checked" : ""}/><i></i></label>
            <label class="switch"><span>Buddy mode · two astronauts</span><input class="sr" type="checkbox" id="opt-buddy" ${this.buddy ? "checked" : ""}/><i></i></label>
          </section>
        </details>
      </div>
      <footer class="panel-foot">
        <div class="foot-row three">
          <button class="secondary" data-act="fly" title="Fly along the planned route">${ic.flight}<span>Fly route</span></button>
          <button class="secondary" data-act="cue" title="One-page printable plan">${ic.book}<span>Cue card</span></button>
          <button class="secondary" data-act="export" aria-haspopup="menu" title="Save the route for Google Earth or GIS tools, or copy a link to the plan">${ic.download}<span>Export</span></button>
        </div>
        <div class="menu list" id="export-menu" role="menu" hidden>
          <button data-act="kml">${ic.download}<span><b>KML</b><small>Google Earth in Mars mode</small></span></button>
          <button data-act="geojson">${ic.download}<span><b>GeoJSON</b><small>QGIS and other map tools · Mars 2000 coordinates</small></span></button>
          ${this.notebook.notes.length ? `<button data-act="notes-zip">${ic.note}<span><b>Field notebook (ZIP)</b><small>Route, notes and samples as KML + GeoJSON, voice notes as MP3</small></span></button>` : ""}
          <button data-act="link">${ic.link}<span><b>Copy link to this plan</b><small>Stops, start time and options, for a teammate or a judge</small></span></button>
        </div>
        ${
          this.member === "ev2"
            ? `<button class="primary big" disabled>${ic.play}<span>${this.habState === "online" ? "EV1 starts the EVA" : "No link to the hab"}</span></button>
               <p class="crew-note">You are <b>EV2</b>. EV1 plans this EVA on their device; when they start it, you walk it with them here.</p>`
            : `<button class="primary big" data-act="start" ${b.feasible ? "" : "disabled"}>${ic.play}<span>Start EVA</span></button>
               <button class="big walk-it" data-act="walk-it" title="Walk this plan on foot in free roam: reach each stop, take the samples, get back to the rover">${ic.walk}<span>Walk it yourself</span></button>`
        }
      </footer>`;
  }

  private renderLive(host: HTMLElement): void {
    const r = this.site.replay;
    host.innerHTML = `
      <div class="scroll">
        <section class="live">
          <header class="sec-head"><h2>EVA in progress</h2><span class="status live"><i class="dot"></i>Live</span></header>
          <div class="clock" id="lv-clock">00:00:00</div>
          <p class="phase"><span id="lv-label"></span> <b id="lv-next"></b></p>
          <dl class="kv">
            <dt id="lv-dist-k">Distance left</dt><dd id="lv-dist"></dd>
            <dt>Walked so far</dt><dd id="lv-walked"></dd>
            <dt>Radio</dt><dd id="lv-radio"></dd>
          </dl>
        </section>
        <section>
          <header class="sec-head"><h2>Oxygen</h2><span class="num"><span id="lv-o2"></span> <small>left of ${this.P.o2SupplyL} L</small></span></header>
          <div class="meter"><i id="lv-o2bar"></i><u style="left:${((1 - this.P.reserveFraction) * 100).toFixed(1)}%"></u></div>
          <dl class="kv">
            <dt>Walk-back margin</dt><dd id="lv-margin"></dd>
            <dt>Way home from here</dt><dd id="lv-home"></dd>
            ${this.buddy ? `<dt>Buddy separation</dt><dd id="lv-buddy"></dd>` : ""}
          </dl>
        </section>
        <section class="drill">
          <header class="sec-head"><h2>Practice an emergency</h2></header>
          <p class="note">Something goes wrong out here. CAIRN finds the quickest safe way home and checks the oxygen.</p>
          <div class="foot-row two">
            <button class="secondary" data-act="emergency" data-kind="leak" title="Oxygen use doubles">${ic.leak}<span>Suit leak</span></button>
            <button class="secondary" data-act="emergency" data-kind="ankle" title="Walking speed halves">${ic.ankle}<span>Twisted ankle</span></button>
          </div>
        </section>
        <section>
          <header class="sec-head"><h2>Radiation</h2><button class="link" data-act="sources" data-id="rad">${ic.info}<span>Source</span></button></header>
          <dl class="kv">
            <dt>Dose rate</dt><dd><span id="lv-rate"></span> µGy/h</dd>
            <dt></dt><dd id="lv-mult" class="dim"></dd>
            <dt>Dose this EVA</dt><dd id="lv-dose"></dd>
          </dl>
        </section>
        <section class="stormbox" id="stormbox" hidden>
          <header class="sec-head"><h2>Solar particle event</h2><button class="link" data-act="sources" data-id="donki">${ic.info}<span>DONKI</span></button></header>
          <p class="utc" id="st-utc"></p>
          <div id="st-proj"></div>
          <div id="st-chart" class="chart"></div>
          <p class="note">Replay of the ${esc(r.event.title)}. ${esc(r.event.nasaStatement)}</p>
          <p class="note">DONKI ${esc(r.donki.cme.activityID)}: ${esc(r.donki.cme.type)}-type CME, ${Math.round(r.donki.cme.speedKmS)} km/s. The public notification came ${r.donki.alert.delayAfterCmeStartH.toFixed(1)} h after the eruption — CAIRN alerts on the first dose-rate rise instead.</p>
        </section>
        <section>
          ${
            this.site.weather
              ? `<header class="sec-head"><h2>Weather</h2><button class="link" data-act="sources" data-id="meda">${ic.info}<span>${esc((this.site.weather.instrument ?? "MEDA").split(" ").pop()!)}</span></button></header>`
              : `<header class="sec-head"><h2>Time and Sun</h2></header>`
          }
          <dl class="kv">
            <dt>Local time</dt><dd id="lv-lmst"></dd>
            <dt>Sun</dt><dd id="lv-sun"></dd>
            <dt>Earth</dt><dd id="lv-earth"></dd>
            ${this.site.weather ? `<dt>Air · ground</dt><dd id="lv-temp"></dd><dt>Pressure</dt><dd id="lv-pres"></dd>` : ""}
          </dl>
          <p class="note">${
            this.site.weather
              ? `${esc(this.site.weather.instrument ?? "Perseverance MEDA")} readings for the same time of day on sol ${this.site.weather.sol}.`
              : "No lander or rover has measured the weather here."
          }</p>
        </section>
      </div>`;
    this.doseChart = null;
    this.updateLive();
  }

  private renderSummary(host: HTMLElement): void {
    const m = this.mission!;
    const aborted = m.alertS !== null || m.emergency !== null;
    const pr = m.projection;
    const em = m.emergency;
    const remaining = m.remaining();
    const visited = [
      ...m.visited.map((id) => this.poi(id)?.short ?? id),
      ...m.reached.filter((id) => !m.visited.includes(id)).map((id) => `${this.poi(id)?.short ?? id} (science cut short)`),
    ];
    host.innerHTML = `
      <div class="scroll">
        <section class="summary">
          <header class="sec-head"><h2>${aborted ? "EVA aborted" : "EVA complete"}</h2>${
            aborted ? `<span class="status warn">${ic.home}Crew in the rover</span>` : `<span class="status ok">${ic.check}Back at the rover</span>`
          }</header>
          <div class="hero">
            <div><span>Walked</span>${heroDist(m.distanceM)}</div>
            <div><span>${m.alertS !== null ? "To all-clear" : "Time outside"}</span>${heroDur(m.t)}</div>
          </div>
          <dl class="kv">
            <dt>Stops reached</dt><dd>${visited.length ? esc(visited.join(", ")) : "none"}</dd>
            <dt>Oxygen used</dt><dd>${Math.round(m.o2UsedL)} L of ${this.P.o2SupplyL} L</dd>
            <dt>Dose received</dt><dd>${fmtDose(m.doseUGy)}</dd>
          </dl>
          ${
            em
              ? `<div class="avoided"><span>${em.kind === "leak" ? "Suit leak" : "Twisted ankle"} at ${fmtClock(em.atS)} into the EVA</span><b>${Math.round(this.P.o2SupplyL - m.o2UsedL)} L left</b>
                  <small>CAIRN sent the crew home at once: ${fmtDist(em.homeDistM)} in ${fmtDur(em.homeTimeS)}${em.kind === "ankle" ? " at half speed" : ", using oxygen twice as fast"}. The walk home needed ${Math.round(em.needL)} L of the ${Math.round(em.leftL)} L left.</small></div>
                 <p class="note">${em.leftL - em.needL >= this.P.o2SupplyL * this.P.reserveFraction ? "The oxygen reserve was never touched." : em.leftL >= em.needL ? "The crew made it home on the reserve." : "Not enough oxygen to walk home: the rover would have to drive out to meet the crew."}</p>`
              : pr
              ? `<div class="avoided"><span>Dose avoided by sheltering</span><b>${fmtDose(pr.avoidedUGy)}</b>
                  <small>${fmtDose(pr.shelterUGy)} received vs ${fmtDose(pr.continueUGy)} had the crew finished the walk, compared at the planned end of the EVA. Rover shielding ×${this.P.shelterFactor} is an assumption.</small></div>
                 <p class="note">Alert to shelter: ${fmtDur(pr.arriveS - pr.alertS)} over ${fmtDist(pr.shelterDistM)}. RAD measured elevated dose rates for about two sols after this storm, so the remaining objectives move to a later sol.</p>`
              : `<p class="note">All objectives reached; the crew is back at the rover with ${Math.round(this.P.o2SupplyL - m.o2UsedL)} L of oxygen.</p>`
          }
        </section>
        ${autonomyHtml(this.log.filter((e) => e.kind === "alert").map((e) => ({ t: e.t, text: e.text })), this.skyAt(0).lightTimeS)}
        ${this.logHtml()}
      </div>
      <footer class="panel-foot">
        ${remaining.length ? `<button class="primary big" data-act="resume">${ic.later}<span>Plan the remaining stop${remaining.length > 1 ? "s" : ""} for a later sol</span></button>` : ""}
        <div class="foot-row log">
          <button class="big" data-act="replan">Back to planning</button>
          <button class="secondary" data-act="save-log" title="Download the EVA log as a Markdown file">${ic.download}<span>Save log</span></button>
        </div>
      </footer>`;
  }

  /** Debrief file: the totals and the EVA log, as Markdown (readable as plain text too). */
  private saveLog(): void {
    const m = this.mission;
    if (!m) return;
    const site = this.site.meta;
    const lines = [
      `# EVA log — ${site.name}`,
      "",
      `- Date: ${site.eva?.sol !== undefined ? `sol ${site.eva.sol}` : ((site.eva as { label?: string } | undefined)?.label ?? "")}, left the rover at ${fmtLmst(this.startLmst)} LMST`,
      `- Walked ${fmtDist(m.distanceM)} in ${fmtDur(m.t)}; oxygen used ${Math.round(m.o2UsedL)} L of ${this.P.o2SupplyL} L; dose ${fmtDose(m.doseUGy)}`,
      m.emergency ? `- Practice emergency: ${m.emergency.kind === "leak" ? "suit leak" : "twisted ankle"}` : m.alertS !== null ? "- Aborted for a solar particle event" : "- Completed as planned",
      "",
      "| Mission time | LMST | Event |",
      "|---|---|---|",
      ...this.log.map((e) => `| ${fmtClock(e.t)} | ${fmtLmst(this.lmstAt(e.t))} | ${e.text} |`),
      "",
      "Made with CAIRN from NASA HiRISE terrain. Suit and physiology values are demo assumptions.",
      "",
    ];
    void import("./ui/export").then(({ saveFile }) => saveFile(`cairn-${this.site.id}-eva-log.md`, "text/markdown", lines.join("\n")));
    this.toast("Saved the EVA log.");
  }

  /** The EVA log for the summary: mission clock, local time and what happened. */
  private logHtml(): string {
    if (this.log.length < 2) return "";
    // radio flickers on a ridge crest: keep the log readable by merging lost/back pairs shorter than 30 s
    const rows: typeof this.log = [];
    for (const e of this.log) {
      const prev = rows[rows.length - 1];
      if (prev && prev.kind === "radio" && e.kind === "radio" && prev.text === "Radio contact lost" && e.text === "Radio contact back" && e.t - prev.t < 30) {
        rows.pop();
        continue;
      }
      rows.push(e);
    }
    return `<section class="evalog">
        <header class="sec-head"><h2>EVA log</h2></header>
        <ol>${rows
          .map((e) => `<li class="${e.kind}"><time>${fmtClock(e.t)}</time><span>${esc(e.text)}</span><small>${fmtLmst(this.lmstAt(e.t))}</small></li>`)
          .join("")}</ol>
      </section>`;
  }

  // ================================================================ bottom bar
  private chartIsOpen(): boolean {
    return this.chartOpen[this.viewMode] ?? true;
  }

  private renderBottom(): void {
    const eva = this.phase === "eva";
    const straight = this.showStraight && this.phase === "planning";
    const open = this.chartIsOpen();
    $("#app").classList.toggle("chart-closed", !open);
    requestAnimationFrame(() => this.updateInsets());
    const b = this.plan?.budget;
    const summary = b ? `<span class="chart-sum">${ic.route}${Math.round(b.climbM)} m climb · steepest ${b.maxSlopeDeg}°</span>` : "";
    const toggle = `<button class="icon chart-toggle" data-act="chart" title="${open ? "Hide" : "Show"} the elevation chart" aria-expanded="${open}">${ic.chev}</button>`;
    $("#bottom").innerHTML = `
      <header class="bar">
        ${
          eva
            ? `<div class="transport">
                 <button class="icon solid" data-act="pause" title="${this.paused ? "Resume" : "Pause"}">${this.paused ? ic.play : ic.pause}</button>
                 <div class="seg small">${SPEEDS.map((v) => `<button data-act="speed" data-v="${v}" class="${v === this.speed ? "on" : ""}">${v}×</button>`).join("")}</div>
                 <button class="ghost" data-act="skip" title="Jump to the end of the current step">${ic.skip}<span>Skip</span></button>
                 <button class="ghost" data-act="note-here" title="Geotagged note or sample where you stand">${ic.note}<span>Note</span></button>
                 ${this.voice.supported ? `<button class="ghost voice${this.voice.enabled ? " on" : ""}" data-act="voice" title="Spoken directions in the visor: turns, steep ground, sand and arrivals, only when something changes. Messages from Mission Control are always read out, even with this off${this.voice.voiceName ? ` (voice: ${esc(this.voice.voiceName)})` : ""}" aria-pressed="${this.voice.enabled}">${this.voice.enabled ? ic.voiceOn : ic.voiceOff}<span>Voice</span></button>` : ""}
                 <button class="ghost" data-act="end" aria-label="End EVA">${ic.stop}<span>End<span class="wide-only"> EVA</span></span></button>
               </div>`
            : `<h2>Elevation along the route</h2>`
        }
        ${
          open
            ? `<div class="key">
                 <span><i style="background:#56b4e9"></i>&lt; 10°</span><span><i style="background:#f0e442"></i>10–18°</span>
                 <span><i style="background:#e69f00"></i>18–25°</span><span><i style="background:${HATCH}"></i>too steep</span>
                 ${(this.site.meta.stats?.sandPct ?? 1) > 0 ? `<span><i class="sand"></i>sand</span>` : ""}${this.plan && this.plan.radio.lostS > 0 ? `<span><i class="noradio"></i>no radio</span>` : ""}${straight ? `<span><i class="dash"></i>straight line</span>` : ""}
               </div>`
            : summary
        }
        ${toggle}
      </header>
      <div id="profile" ${open ? "" : "hidden"}></div>`;
    this.renderProfileChart();
  }

  private renderProfileChart(): void {
    const host = document.getElementById("profile");
    if (!host || host.hidden) {
      this.profile = null;
      return;
    }
    if (!this.plan) {
      host.innerHTML = `<p class="hint pad">No route to show.</p>`;
      this.profile = null;
      return;
    }
    if (this.phase === "planning") this.view.setHoverMarker(null); // a chart redrawn under the pointer leaves no stale marker
    this.profile = renderProfile(
      host, this.plan.legs, this.plan.order, this.showStraight && this.phase === "planning" ? this.plan.straight : null,
      this.plan.radio.lostS > 0 ? (x, y, leg, i) => this.lostOnPlan(x, y, leg, i) : null,
      (at) => {
        if (this.phase === "planning") this.view.setHoverMarker(at);
      },
      this.useRelay && this.plan.relay ? this.plan.relay.alongM : null,
    );
  }

  // ================================================================ stop card
  private openCard(id: string, arrived: boolean): void {
    const poi = this.poi(id);
    if (!poi) return;
    const card = $("#card");
    const tex = this.site.meta.texture;
    const orbital = tex.hi ? { url: this.site.base + tex.hi.file, sizeM: this.site.meta.sizeM, mPerPx: tex.hi.mPerPx } : { url: this.site.base + tex.file, sizeM: this.site.meta.sizeM, mPerPx: tex.mPerPx };
    card.innerHTML = stopCardHtml(poi, this.site.base, this.unitAt(poi.x, poi.y), arrived, this.roverName, this.panoLabel(poi.id), orbital);
    if (card.hidden || card.classList.contains("motion-out")) showAnimated(card);
    else card.hidden = false;
    card.classList.toggle("arrived", arrived);
    this.cardPoi = id;
    card.onclick = (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest(".close")) return this.closeCard();
      const look = t.closest<HTMLElement>("[data-pano]");
      if (look) return void this.openPano(look.dataset.pano!);
      const i = t.dataset.i;
      if (i !== undefined && t.tagName === "BUTTON") {
        for (const f of card.querySelectorAll("figure")) f.classList.toggle("on", f.dataset.i === i);
        for (const d of card.querySelectorAll(".dots button")) d.classList.toggle("on", (d as HTMLElement).dataset.i === i);
      }
    };
  }

  // ================================================================ guided demo
  private demo: DemoRunner | null = null;
  private demoArrived: string | null = null; // first stop reached during the demo (the walk pauses there)

  async startDemo(): Promise<void> {
    this.demo?.stop();
    if (this.phase === "planning" && this.roverMoved()) await this.moveRover(this.roverHome); // the demo tells the site's own plan
    $("#briefing").hidden = true;
    $("#modal").hidden = true;
    const objective = this.site.pois.find((p) => p.kind === "objective");
    const sum = (f: (m: MeasuredPath) => number) => (this.plan ? this.plan.straight.reduce((s, m) => s + f(m), 0) : 0);
    const meta = this.site.meta;
    const story = meta.story?.paragraphs[0]?.replace(/<[^>]+>/g, "") ?? meta.name;
    const firstSentence = story.split(/(?<=\.)\s/)[0];
    let closePano: (() => void) | null = null;
    let lastAvoided = 0;

    const steps: DemoStep[] = [
      {
        title: meta.name.split(" — ")[0],
        body: `${esc(firstSentence)}`,
        run: async (d) => {
          this.resetForDemo();
          await this.view.overview();
          await d.sleep(2500);
        },
      },
      {
        title: "Real terrain, not a model",
        body: `The walk area is HiRISE data: <b>1 m elevation</b> and a <b>25 cm image</b> — the sharpest view of Mars from orbit. Around it: ${esc(this.site.region ? `${(this.site.region.meta.sizeM / 1000).toFixed(0)} km of surrounding terrain` : "the wider region")}.`,
        run: async (d) => {
          this.setView("orbit");
          await d.until(() => !this.view.isAnimating(), 4000);
          this.view.setAutoRotate(true, 0.9);
          await d.sleep(6500);
          this.view.setAutoRotate(false);
        },
      },
      {
        title: "Where it is safe to walk",
        body: () => {
          const b = this.plan?.budget;
          const blocked = sum((m) => m.blockedM);
          return b
            ? `Colour shows walking effort × fall risk. ${blocked > 0 ? `The straight line crosses <b>${fmtDist(blocked)}</b> steeper than ${meta.model.slopeLimitDeg}°.` : "The straight line is walkable but costs more."} CAIRN's route: <b>${fmtDist(b.distanceM)}</b>, <b>${fmtDur(b.totalTimeS)}</b> outside, ${Math.round(b.o2UsedL)} L of oxygen.`
            : "Colour shows walking effort × fall risk.";
        },
        run: async (d) => {
          this.selectLayer("risk");
          await d.sleep(7000);
          this.selectLayer("shelter");
          d.say(`And the way home from every point of the map, worked out in ${Math.max(0.1, this.field.ms / 1000).toFixed(1)} s when CAIRN opened — so an emergency re-route is instant.`);
          await d.sleep(4500);
          this.selectLayer("none");
        },
      },
      {
        title: "The real Sun",
        body: `CAIRN places the Sun for ${meta.eva?.sol !== undefined ? `the actual sol (${meta.eva.sol})` : `the planning date (${esc(meta.eva?.label ?? "—")})`} and casts shadows from the real terrain. At dawn, long shadows hide rocks and holes — so the plan leaves later.`,
        run: async (d) => {
          const keep = this.startLmst;
          this.startLmst = 7.6;
          this.renderRight();
          await d.sleep(3500);
          this.startLmst = 8.6;
          this.renderRight();
          await d.sleep(1500);
          this.startLmst = keep;
          this.renderRight();
          await d.sleep(1500);
        },
      },
      {
        title: "Radio contact",
        body: () => {
          const rc = this.plan?.radio;
          if (!rc) return "Hills block radio. CAIRN draws the line of sight to the rover's antenna.";
          return rc.lostS < 20
            ? "Hills block radio. CAIRN draws the line of sight to the rover's antenna: this whole walk stays in contact."
            : `Hills block radio. CAIRN draws the line of sight to the rover's antenna: this walk keeps contact for <b>${Math.floor(rc.coveredFraction * 100)}%</b> of the time.`;
        },
        run: async (d) => {
          this.selectLayer("radio");
          await d.sleep(4500);
          const relay = this.plan?.relay;
          if (relay) {
            const toward = this.relayLeg(relay);
            this.setRelay(true);
            await d.until(() => !this.busy, 6000);
            d.say(`CAIRN finds where the crew should stand up a relay mast: after ${fmtDist(relay.alongM)}${toward ? `, on the way to ${esc(toward)}` : ""}. Contact goes to <b>${Math.floor(relay.after.coveredFraction * 100)}%</b>.`);
            await d.sleep(5000);
          } else {
            await d.sleep(1000);
          }
          this.selectLayer("none");
        },
      },
      {
        title: "Fly the route",
        body: "The safe route, draped over the real ground.",
        run: async (d) => {
          this.setView("fly");
          await d.sleep(800);
          await d.until(() => !this.view.isAnimating(), 22000);
        },
      },
      {
        title: objective ? `Walk to ${objective.short}` : "Walk the route",
        body: `The visor shows heading, oxygen, dose and the next stop.${this.roverName ? ` At each stop: what ${esc(this.roverName)} actually saw there.` : ""}`,
        run: async (d) => {
          this.storm = true;
          this.demoArrived = null;
          this.startEva();
          this.speed = 300;
          await d.until(() => this.demoArrived !== null, 30000);
          if (objective && this.site.panoramas?.panoramas[objective.id]) {
            await d.sleep(2500);
            d.say(`A real 360° view stitched from ${esc(this.roverName)}'s Navcam frames at this exact spot.`);
            closePano = await this.openPano(objective.id, true);
            await d.sleep(8000);
            closePano?.();
            closePano = null;
          } else {
            await d.sleep(5500);
          }
          this.paused = false;
          this.demoArrived = "done";
        },
      },
      {
        title: "20 May 2024: a real solar storm",
        body: "Replaying the largest particle surge Curiosity's RAD has recorded. When the dose rate passes 3× background, CAIRN aborts the walk and routes to the rover.",
        run: async (d) => {
          this.speed = 300;
          await d.until(() => !!this.mission && this.mission.alertS !== null, 60000);
          this.speed = 120;
          // the light-time story: Earth's last word was written before the storm, and only arrives now
          const lt = this.skyAt(this.mission?.t ?? 0).lightTimeS;
          const sentAgo = fmtLightTime(lt);
          this.log.push({ t: this.mission?.t ?? 0, kind: "earth", text: `(Demo) Mission Control, sent ${sentAgo} ago: “Space weather looks quiet. Carry on.” It arrives after the alarm.` });
          d.say(`The alarm sounds on Mars now. Earth's last message, <b>“Space weather looks quiet, carry on”</b>, was sent ${esc(sentAgo)} ago and arrives only now. Earth will not even hear about the storm for another ${esc(sentAgo)}: the crew decides alone.`);
          await d.sleep(6500);
          this.speed = 300;
          await d.until(() => this.phase === "summary", 60000);
          lastAvoided = this.mission?.projection?.avoidedUGy ?? 0;
          await d.sleep(2500);
        },
      },
      {
        title: "Decisions made alone",
        body: () => {
          const lt = fmtLightTime(this.skyAt(0).lightTimeS);
          return `Every call on this EVA was the crew's: Earth heard about the turn-back ${esc(lt)} later, and its first answer could not arrive for twice that. The debrief lists each decision with those times.`;
        },
        run: async (d) => {
          document.querySelector(".autonomy")?.scrollIntoView({ behavior: "smooth", block: "center" });
          await d.sleep(6000);
        },
      },
      {
        title: "Now walk it yourself",
        body: "The same plan can be walked on foot in free roam: real Mars gravity and a stiff suit, the same storm, Earth one light time behind. Choose <b>Walk it yourself</b> under Start EVA, or a scenario under About.",
        run: async (d) => {
          if (this.phase !== "planning") this.backToPlanning();
          await d.sleep(300);
          document.querySelector<HTMLElement>("[data-act=walk-it]")?.classList.add("demo-glow");
          await d.sleep(6000);
          document.querySelector<HTMLElement>("[data-act=walk-it]")?.classList.remove("demo-glow");
        },
      },
    ];
    const { DemoRunner } = await import("./ui/demo");
    this.demo = new DemoRunner(steps, {
      title: "Robots built the cairns. Humans will follow them.",
      body: () =>
        `${lastAvoided > 0 ? `Sheltering avoided <b>${fmtDose(lastAvoided)}</b> of radiation. ` : ""}Every layer here comes from NASA, USGS and JPL archives — open <b>About → Data sources</b> to check any of them.`,
      extra: { label: "Walk it yourself", act: () => this.walkItYourself() },
    });
    this.demo.onPause = (p) => {
      this.paused = p;
      this.view.setAutoRotate(false);
    };
    this.demo.onEnd = () => {
      closePano?.();
      this.view.setAutoRotate(false);
      this.demo = null;
    };
    await this.demo.start();
  }

  /** Arrival time (EVA seconds) at each stop of the plan, rover first and last. */
  private stopTimes(): { poi: Poi; arriveS: number }[] {
    if (!this.plan) return [];
    const out = [{ poi: this.rover, arriveS: 0 }];
    let t = 0;
    for (const seg of this.plan.budget.segments) {
      if (seg.kind === "walk") {
        t += seg.path.time;
        if (seg.to) out.push({ poi: seg.to, arriveS: t });
      } else t += seg.durationS;
    }
    return out;
  }

  // ================================================================ plan links
  /**
   * The plan in the URL hash — `#stops=cheyava,serpentine&add=812_1460&t=9.5&storm=0&buddy=1` — so a
   * reload keeps it and a link shares it.  Custom stops travel as local x_y metres.
   */
  private planHash(): string {
    return formatPlanLink({
      stops: this.selected.filter((id) => !id.startsWith("custom-")),
      add: this.selected.map((id) => this.poi(id)).filter((p): p is Poi => !!p && p.id.startsWith("custom-")),
      startLmst: this.startLmst !== (this.site.meta.eva?.startLmst ?? 10) ? this.startLmst : null,
      storm: this.storm,
      buddy: this.buddy,
      relay: this.useRelay,
      relayAt: this.useRelay ? this.relayManual : null,
      rover: this.roverMoved() ? this.rover : null,
      dwell: Object.fromEntries(Object.entries(this.dwellOverrides).filter(([id]) => this.selected.includes(id))),
    });
  }

  /**
   * Each edit of the plan becomes a browser history entry, so Back (or Ctrl/Cmd+Z) undoes it and
   * Forward (Ctrl/Cmd+Shift+Z) redoes it.  The first plan of a visit and the demo replace instead.
   */
  private historyReady = false;
  /** Position in this visit's plan history (0 = the plan the visit started with): undo stops there. */
  private historyIndex = 0;
  private writePlanHash(): void {
    const url = `${location.pathname}${location.search}#${this.planHash()}`;
    const ready = this.historyReady;
    this.historyReady = true; // from the first plan on, every change is an undo step (even if that plan came from the link)
    if (url === `${location.pathname}${location.search}${location.hash}`) return;
    if (ready && !this.demo?.running) history.pushState({ cairn: ++this.historyIndex }, "", url);
    else history.replaceState({ cairn: this.historyIndex }, "", url);
  }

  /** Back / Forward through plan edits: rebuild the plan from the link. */
  private restoreFromHash(): void {
    if (this.phase !== "planning") return;
    this.pois = this.pois
      .filter((p) => !p.id.startsWith("custom-"))
      .map((p) => (p.kind === "shelter" ? p : this.site.pois.find((o) => o.id === p.id) ?? p)); // science times back to the site's
    this.dwellOverrides = {};
    this.customCount = 0;
    this.selected = this.site.pois.filter((p) => p.kind === "objective").map((p) => p.id);
    this.startLmst = this.site.meta.eva?.startLmst ?? 10;
    this.storm = true;
    this.buddy = false;
    this.useRelay = false;
    this.pendingRover = null;
    this.applyPlanHash(location.hash);
    const to = this.pendingRover ?? this.roverHome;
    this.pendingRover = null;
    if (Math.hypot(to.x - this.rover.x, to.y - this.rover.y) > 1) void this.moveRover(to);
    else void this.replan();
  }

  /** Restore a plan from a link; anything that does not fit this site is ignored. */
  private applyPlanHash(hash: string): void {
    const link = parsePlanLink(hash);
    if (!link) return;
    const grid = this.site.grid;
    const ids = link.stops.filter((id) => this.site.pois.some((p) => p.id === id && p.kind !== "shelter"));
    for (const { x, y } of link.add) {
      if (!grid.inside(x, y)) continue;
      const node = grid.nodeAt(x, y);
      if (grid.isBlocked(node) || !Number.isFinite(this.field.time[node])) continue;
      ids.push(this.customPoi({ x, y }).id);
    }
    if (ids.length) this.selected = [...new Set(ids)]; // a link made for another site keeps the default stops
    if (link.startLmst !== null) this.startLmst = link.startLmst;
    this.storm = link.storm;
    this.buddy = link.buddy;
    this.useRelay = link.relay;
    this.relayManual = link.relayAt;
    for (const [id, m] of Object.entries(link.dwell)) if (this.poi(id)) this.setDwell(id, m, false);
    const r = link.rover;
    if (r && grid.inside(r.x, r.y) && !grid.isBlocked(grid.nodeAt(r.x, r.y))) {
      this.pendingRover = r; // moved once the panels are up (it needs the routing worker)
    }
  }
  private pendingRover: XY | null = null;

  private async copyPlanLink(): Promise<void> {
    this.writePlanHash();
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      this.toast("Link copied. It opens this plan: the same stops, start time and options.");
    } catch {
      this.toast(`Copy this link: ${url}`);
    }
  }

  /** The route, notes and samples (KML + GeoJSON) with every voice note as an MP3, in one ZIP. */
  private async exportNotebook(): Promise<void> {
    const plan = this.exportPlan();
    if (!plan) return;
    const withVoice = this.notebook.notes.filter((n) => n.audio);
    this.toast(withVoice.length ? `Converting ${withVoice.length} voice note${withVoice.length === 1 ? "" : "s"} to MP3…` : "Packing the notebook…", 2500);
    const [{ toMp3, zipFiles, saveBlob }, { routeKml, routeGeoJson }] = await Promise.all([import("./ui/voiceExport"), import("./ui/export")]);
    const files: Record<string, string | Blob> = {};
    const voiceFile = new Map<string, string>();
    let failed = 0;
    for (const n of withVoice) {
      const clip = await this.notebook.loadAudio(n.id);
      if (!clip) {
        failed++;
        continue;
      }
      try {
        const path = `voice/${n.label}.mp3`;
        files[path] = await toMp3(clip);
        voiceFile.set(n.id, path);
      } catch {
        failed++;
      }
    }
    plan.notes = this.notebook.notes.map((n) => ({ ...n, voiceFile: voiceFile.get(n.id) }));
    const name = `cairn-${this.site.id}-notebook`;
    files[`${name}.kml`] = routeKml(plan);
    files[`${name}.geojson`] = routeGeoJson(plan);
    saveBlob(`${name}.zip`, await zipFiles(files));
    this.toast(`Saved ${name}.zip: route, ${this.notebook.notes.length} notebook entr${this.notebook.notes.length === 1 ? "y" : "ies"}${voiceFile.size ? `, ${voiceFile.size} MP3 voice note${voiceFile.size === 1 ? "" : "s"}` : ""}${failed ? ` (${failed} clip${failed === 1 ? "" : "s"} could not be read)` : ""}.`, 5000);
  }

  private exportPlan(): ExportPlan | null {
    if (!this.plan) return null;
    const b = this.plan.budget;
    return {
      site: this.site.meta, legs: this.plan.legs, distanceM: b.distanceM, timeS: b.totalTimeS, o2UsedL: b.o2UsedL,
      startLmst: fmtLmst(this.startLmst),
      stops: this.stopTimes().map((s) => ({ ...s, lmst: fmtLmst(this.lmstAt(s.arriveS)) })),
      relay: this.useRelay && this.plan.relay ? { ...this.plan.relay.at, mastM: RELAY_MAST_M } : null,
      notes: this.notebook.notes,
    };
  }

  /** Save the planned route as KML (Google Earth, Mars mode) or GeoJSON (GIS tools). */
  private async exportRoute(kind: "kml" | "geojson"): Promise<void> {
    if (!this.plan) return;
    const { routeKml, routeGeoJson, saveFile } = await import("./ui/export");
    const b = this.plan.budget;
    const plan: ExportPlan = {
      site: this.site.meta, legs: this.plan.legs, distanceM: b.distanceM, timeS: b.totalTimeS, o2UsedL: b.o2UsedL,
      startLmst: fmtLmst(this.startLmst),
      stops: this.stopTimes().map((s) => ({ ...s, lmst: fmtLmst(this.lmstAt(s.arriveS)) })),
      relay: this.useRelay && this.plan.relay ? { ...this.plan.relay.at, mastM: RELAY_MAST_M } : null,
      notes: this.notebook.notes,
    };
    const name = `cairn-${this.site.id}-eva`;
    if (kind === "kml") saveFile(`${name}.kml`, "application/vnd.google-earth.kml+xml", routeKml(plan));
    else saveFile(`${name}.geojson`, "application/geo+json", routeGeoJson(plan));
    this.toast(kind === "kml" ? "Saved the route as KML — open it in Google Earth, switched to Mars." : "Saved the route as GeoJSON (Mars 2000 longitude / latitude).");
  }

  /** One-page printable plan: map, timeline, oxygen turn-back values, storm protocol. */
  private async openCueCard(): Promise<void> {
    const { showCueCard } = await import("./ui/cuecard");
    if (!this.plan) return;
    const P = this.P;
    const b = this.plan.budget;
    const rows: CueRow[] = [];
    let t = 0;
    let o2 = 0;
    const add = (poi: Poi, arriveS: number, departS: number, leg: MeasuredPath | null) => {
      const home = this.lookup(poi.x, poi.y);
      const sun = this.sunAtEva(arriveS);
      const cover = poi.kind === "shelter" ? null : this.naturalCover(poi.x, poi.y);
      rows.push({
        poi, arriveS, departS, leg,
        o2LeftAtDepartL: P.o2SupplyL - o2,
        homeTimeS: home.timeS,
        homeO2L: o2Litres(home.energyJ, home.timeS, P.restingW, P),
        bearingHome: (((Math.atan2(this.rover.x - poi.x, this.rover.y - poi.y) * 180) / Math.PI) + 360) % 360,
        sunEl: sun.elevation,
        shade: inTerrainShadow(this.site.grid, poi.x, poi.y, sun.elevation, sun.azimuth),
        lmst: fmtLmst(this.lmstAt(arriveS)),
        cover: cover ? `${cover.pct}% less dose ${cover.dist} m ${cover.dir} of ${poi.short}` : "",
      });
    };
    add(this.rover, 0, 0, null);
    let pendingLeg: MeasuredPath | null = null;
    for (const seg of b.segments) {
      if (seg.kind === "walk") {
        t += seg.path.time;
        o2 += walkO2(seg.path, P);
        pendingLeg = seg.path;
        if (seg.to && seg.to.kind === "shelter") add(seg.to, t, t, pendingLeg);
      } else {
        const arrive = t;
        t += seg.durationS;
        o2 += o2Litres(0, seg.durationS, P.workingW, P);
        add(seg.poi, arrive, t, pendingLeg);
      }
    }
    const s0 = this.sunAtEva(0);
    const s1 = this.sunAtEva(b.totalTimeS);
    showCueCard({
      site: this.site, params: P, budget: b, order: this.plan.order, legs: this.plan.legs, rows,
      start: { lmst: fmtLmst(this.lmstAt(0)), sunEl: s0.elevation, sunAz: s0.azimuth },
      end: { lmst: fmtLmst(this.lmstAt(b.totalTimeS)), sunEl: s1.elevation },
      alertUGyH: this.rad.baseline * 3, rover: this.roverName, storm: this.storm, buddy: this.buddy,
      notes: this.notebook.notes,
      doseUGy: this.rad.baseline * b.exposureH,
      checks: this.planChecks(s0.elevation < 8 || s1.elevation < 8, b.walkBack.minMarginL),
      radio: {
        coverage: this.plan.radio,
        lostAt: (x, y, leg, i) => this.lostOnPlan(x, y, leg, i),
        relay: this.useRelay && this.plan.relay ? { at: this.plan.relay.at, alongM: this.plan.relay.alongM, mastM: RELAY_MAST_M, toward: this.relayLeg(this.plan.relay) } : null,
        silentStops: this.silentStops().map((p) => p.short),
      },
    });
  }

  private resetForDemo(): void {
    if (this.phase !== "planning") this.backToPlanning();
    this.closeCard();
    this.useRelay = false;
    this.selected = this.site.pois.filter((p) => p.kind === "objective").map((p) => p.id);
    this.pois = this.pois
      .filter((p) => !p.id.startsWith("custom-"))
      .map((p) => (p.kind === "shelter" ? p : this.site.pois.find((o) => o.id === p.id) ?? p));
    this.dwellOverrides = {};
    this.startLmst = this.site.meta.eva?.startLmst ?? 10;
    this.selectLayer("none");
    void this.replan();
  }

  // ================================================================ loaded on demand
  /** About → Data sources / Model assumptions (a separate file, fetched the first time). */
  private async about(kind: "sources" | "model", focus?: string): Promise<void> {
    const m = await import("./ui/about");
    if (kind === "sources") m.showSources(this.site, focus);
    else m.showAssumptions(this.site, this.P);
  }

  // ================================================================ hab link (Mission Control)
  private renderHabChip(): void {
    const b = document.getElementById("btn-hab");
    if (!b) return;
    b.className = `hab-chip ${this.habState}`;
    b.title =
      this.habState === "online"
        ? `Connected to the hab server. ${this.mcWatching ? `Mission Control is watching on ${this.mcWatching} screen${this.mcWatching === 1 ? "" : "s"}.` : "Open Mission Control to watch this EVA from Earth."}`
        : this.habState === "connecting"
          ? "Looking for the hab server…"
          : "No hab server: the planner works on its own. Start it with `npm start` to link Mission Control and share notes.";
    const label = b.querySelector("span");
    if (label) label.textContent = this.habState === "online" && this.mcWatching ? `Mission Control · ${this.mcWatching}` : "Mission Control";
    const badge = document.getElementById("crew-badge");
    if (badge) {
      badge.hidden = this.member === "ev1" && this.ev2Online === 0;
      badge.innerHTML = this.member === "ev2" ? "EV2" : `EV1<span class="wide-only"> · EV2 linked</span><span class="narrow-only">+2</span>`;
      badge.title = this.member === "ev2" ? "This device is EV2: you walk EV1's EVA with them" : "EV2 is linked on another device";
    }
    // the label is hidden on small screens: say the state in words too
    b.setAttribute("aria-label", `Open Mission Control. ${this.habState === "online" ? `Hab connected${this.mcWatching ? `, ${this.mcWatching} screen${this.mcWatching === 1 ? "" : "s"} watching` : ""}` : this.habState === "connecting" ? "Connecting to the hab" : "No hab server"}.`);
  }

  /** Open Mission Control for this site, in its own window. */
  openMissionControl(): void {
    const s = this.habLink.session;
    window.open(`?view=mission&site=${encodeURIComponent(this.site.meta.id)}${sessionParam(s)}`, `cairn-mc-${s ?? this.site.meta.id}`, "noopener");
  }

  private planInfo(): PlanInfo | null {
    if (!this.plan) return null;
    const b = this.plan.budget;
    const pts: [number, number][] = [];
    let last: XY | null = null;
    for (const leg of this.plan.legs) {
      for (const smp of leg.samples) {
        if (last && Math.hypot(smp.x - last.x, smp.y - last.y) < 4) continue;
        pts.push([Math.round(smp.x * 10) / 10, Math.round(smp.y * 10) / 10]);
        last = smp;
      }
    }
    const order = this.plan.order;
    const stops = this.pois
      .filter((p) => p.kind === "shelter" || this.selected.includes(p.id))
      .map((p) => ({ id: p.id, name: p.name, short: p.short, x: p.x, y: p.y, kind: p.kind, order: Math.max(0, order.findIndex((o, i) => o.id === p.id && i > 0 && i < order.length - 1)) }));
    const dust = { tau: this.dustTau, name: this.dustOptions().find((o) => o.id === this.dustId)?.label ?? "" };
    return {
      site: this.site.meta.id,
      siteName: this.site.meta.name,
      sizeM: this.site.meta.sizeM,
      image: `${this.site.base}${this.site.meta.texture.file}`,
      route: pts,
      stops,
      roverName: this.roverName,
      startLmst: fmtLmst(this.startLmst),
      distanceM: b.distanceM,
      timeS: b.totalTimeS,
      o2SupplyL: this.P.o2SupplyL,
      o2ReserveL: this.P.o2SupplyL * this.P.reserveFraction,
      lightTimeS: this.skyAt(0).lightTimeS,
      storm: this.storm,
      buddy: this.buddy,
      dust: { tau: dust.tau, name: dust.name },
      hash: this.planHash(),
      timeline: this.planTimeline(),
      mode: "plan",
    };
  }

  /** Where the plan puts the crew over the EVA, every ~20 s: Mission Control's "Earth's best guess". */
  private planTimeline(): [number, number, number][] {
    const out: [number, number, number][] = [];
    if (!this.plan) return out;
    let t = 0;
    let at: XY = this.rover;
    for (const seg of this.plan.budget.segments) {
      if (seg.kind === "walk") {
        let next = 0;
        for (const smp of seg.path.samples) {
          if (smp.time < next) continue;
          out.push([Math.round(t + smp.time), Math.round(smp.x), Math.round(smp.y)]);
          next = smp.time + 20;
        }
        t += seg.path.time;
        const end = seg.path.samples[seg.path.samples.length - 1];
        if (end) at = end;
        out.push([Math.round(t), Math.round(at.x), Math.round(at.y)]);
      } else {
        t += seg.durationS;
        out.push([Math.round(t), Math.round(at.x), Math.round(at.y)]);
      }
    }
    return out;
  }

  private sendPlan(): void {
    const plan = this.planInfo();
    if (plan) this.crewSend({ type: "plan", plan }, true);
  }

  /** Telemetry to the hab, four times a second of real time during an EVA. */
  private sendFrame(): void {
    const m = this.mission;
    if (!m || this.phase !== "eva" || this.habState !== "online") return;
    const pose = m.pose();
    const n = m.next();
    const sun = this.sunAtEva(m.t);
    const viaRelay = !this.radioLost && this.relayUp && !inContact(this.radio, this.site.grid, pose.x, pose.y);
    const frame: Frame = {
      t: m.t,
      x: pose.x,
      y: pose.y,
      headingDeg: (pose.headingRad * 180) / Math.PI,
      o2LeftL: this.P.o2SupplyL - m.o2UsedL,
      doseUGy: m.doseUGy,
      doseRate: m.doseRate,
      baseline: this.rad.baseline,
      status: this.phaseLabel(m).label,
      next: this.phaseLabel(m).name,
      nextDistM: n.distM,
      homeS: m.returnTimeS(),
      radio: this.radioLost ? "lost" : viaRelay ? "relay" : "ok",
      sheltered: m.sheltered,
      storm: m.stormActive,
      lmst: fmtLmst(this.lmstAt(m.t)),
      sunEl: sun.elevation,
      lightTimeS: this.skyAt(m.t).lightTimeS,
      // a background tab gets no animation frames: its EVA clock is stopped, whatever the speed setting
      speed: this.paused || document.hidden ? 0 : this.speed,
      hidden: document.hidden,
      buddy: this.buddy ? m.buddyPose() : null,
    };
    this.crewSend({ type: "frame", frame });
    this.sendLog();
  }

  private sendLog(): void {
    const sig = `${this.log.length}|${this.log[this.log.length - 1]?.t ?? 0}`;
    if (sig === this.logSent) return;
    const entries = this.log.filter((e) => e.kind !== "earth").map((e) => ({ t: e.t, kind: e.kind, text: e.text })); // Earth knows when it heard
    if (this.crewSend({ type: "log", entries })) this.logSent = sig;
  }

  /** Send to the hab as the crew.  EV2's device follows EV1's EVA, so it never sends plan, clock or log. */
  private crewSend(msg: Parameters<HabLink["send"]>[0], sticky = false): boolean {
    if (this.member === "ev2") return false;
    return this.habLink.send(msg, sticky);
  }

  private onHab(m: ServerMsg): void {
    if (m.type === "members") {
      const joined = m.ev2 > this.ev2Online;
      this.ev2Online = m.ev2;
      this.renderHabChip();
      if (joined) {
        if (this.phase === "planning" && !this.buddy) {
          this.buddy = true;
          void this.replan();
          this.toast("EV2 joined on another device. Buddy mode is on: you plan, and you walk the EVA together.", 6000);
        } else this.toast("EV2 joined on another device.", 4000);
      }
      return;
    }
    if (m.type === "ev1") {
      // EV2: EV1 closed CAIRN or lost their connection (or came back)
      if (this.member === "ev2") this.ev1Watch.update(m.online);
      return;
    }
    if (m.type === "outside") {
      this.offerFollow(m.from, m.hash, m.tau);
      return;
    }
    if (m.type === "crewplan") {
      // EV2: rebuild EV1's plan exactly (same stops, rover, start time) from its link
      if (this.member !== "ev2" || this.phase !== "planning" || !m.plan.hash || m.plan.hash === this.crewPlanHash) return;
      this.crewPlanHash = m.plan.hash;
      history.replaceState(history.state, "", `${location.pathname}${location.search}#${m.plan.hash}`);
      this.restoreFromHash();
      return;
    }
    if (m.type === "crew-eva") {
      if (this.member !== "ev2") return;
      this.evaRunningOnEv1 = !!m.eva?.running;
      if (m.eva?.id) this.evaId = m.eva.id; // EV2's notes belong to EV1's EVA
      if (m.eva?.running && this.phase === "planning") {
        // EV1 started: walk it with them (the plan is already EV1's; the clock follows EV1's frames)
        window.setTimeout(() => {
          if (!this.evaRunningOnEv1 || this.phase !== "planning") return;
          this.followT = 0;
          this.followSpeed = 0;
          this.ev2Last = null;
          this.startEva();
          this.toast("EV1 started the EVA. You are EV2: walking with EV1. Drag to look around; Note marks what you see.", 6000);
        }, 400);
      } else if (!m.eva?.running && this.phase === "eva") {
        this.onComplete(false);
        this.toast("EV1 ended the EVA.", 4000);
      }
      return;
    }
    if (m.type === "live") {
      if (this.member !== "ev2") return;
      this.followT = Math.max(this.followT, m.frame.t);
      this.followSpeed = m.frame.speed;
      return;
    }
    if (m.type === "mc") {
      this.mcWatching = m.online;
      this.renderHabChip();
    } else if (m.type === "notebook") {
      this.notebook.applyRemote(m.notes as FieldNote[]);
    } else if (m.type === "msg") {
      const at = this.mission?.t ?? 0;
      const lag = m.msg.immediate ? "" : ` (sent ${fmtLightTime(m.msg.deliverT - m.msg.sentT)} ago)`;
      if (this.phase === "eva") {
        this.log.push({ t: at, kind: "radio", text: `Mission Control: “${m.msg.text}”${lag}` });
        this.log.sort((a, b) => a.t - b.t);
      }
      if (m.msg.change) {
        this.voice.earth("Mission Control sent a revised plan.");
        this.buzz([80, 60, 80]);
        if (this.member === "ev1") this.openProposal(m.msg);
        else this.toast(`Mission Control sent EV1 a revised plan${lag}.`, 6000);
        return;
      }
      this.toast(`Message from Mission Control${lag}: “${m.msg.text}”`, 9000);
      this.voice.earth(`Message from Mission Control. ${m.msg.text}`);
      this.buzz([80, 60, 80]);
    }
  }

  // ================================================================ revised plans from Earth
  /** What a plan change means, in words, for this site. */
  private describeChange(c: PlanChange): string[] {
    const lines: string[] = [];
    for (const id of c.drop) lines.push(`Drop ${esc(this.poi(id)?.name ?? id)}`);
    for (const p of c.add) {
      const node = this.site.grid.nodeAt(p.x, p.y);
      const t = this.field.time[node];
      lines.push(`Add a stop ${Number.isFinite(t) ? `${fmtDur(t)} from the rover` : "where the ground is not walkable"} (${Math.round(p.x)}, ${Math.round(p.y)})`);
    }
    return lines;
  }

  /** A revised plan from Mission Control: the crew decides, and the answer travels back to Earth. */
  private openProposal(msg: EarthMessage): void {
    const c = msg.change!;
    const lag = msg.immediate ? "" : `Sent ${fmtLightTime(msg.deliverT - msg.sentT)} ago from Earth. `;
    const inEva = this.phase === "eva";
    openModal(
      "Revised plan from Mission Control",
      `<div class="proposal">
        <p>${lag}${msg.text ? `“${esc(msg.text)}”` : ""}</p>
        <ul>${this.describeChange(c).map((l) => `<li>${l}</li>`).join("")}</ul>
        <p class="note">${inEva ? "You are on the EVA: accepting applies it when you are back at the rover. Earth hears your answer one light time from now." : "Accepting changes the plan now. Earth hears your answer at once (no EVA clock is running)."}</p>
        <div class="row"><button class="secondary" data-proposal="no">Decline</button><button class="primary" data-proposal="yes">${ic.check}<span>Accept</span></button></div>
      </div>`,
      false,
    );
    const box = $("#modal");
    box.querySelector<HTMLButtonElement>("[data-proposal=yes]")?.focus();
    box.querySelectorAll<HTMLButtonElement>("[data-proposal]").forEach((b) =>
      b.addEventListener("click", () => {
        const accepted = b.dataset.proposal === "yes";
        box.querySelector<HTMLButtonElement>(".close")?.click();
        this.habLink.send({ type: "reply", id: msg.id, accepted });
        if (this.phase === "eva") this.log.push({ t: this.mission?.t ?? 0, kind: "earth", text: `${accepted ? "Accepted" : "Declined"} Mission Control's revised plan` });
        if (!accepted) return this.toast("Declined. Mission Control will hear it one light time from now.", 4000);
        if (this.phase === "planning") this.applyChange(c);
        else {
          this.pendingChange = c;
          this.toast("Accepted: the revised plan applies when you are back at the rover.", 5000);
        }
      }),
    );
  }

  private applyChange(c: PlanChange): void {
    this.selected = this.selected.filter((id) => !c.drop.includes(id));
    const grid = this.site.grid;
    for (const p of c.add) {
      if (!grid.inside(p.x, p.y)) continue;
      const node = grid.nodeAt(p.x, p.y);
      if (grid.isBlocked(node) || !Number.isFinite(this.field.time[node])) continue;
      this.selected.push(this.customPoi(p).id);
    }
    void this.replan();
    this.toast("Revised plan from Mission Control applied.", 4000);
  }

  // ================================================================ dust storm
  /** The measured day nearest a sol in this site's record. */
  private dustDay(sol: number): [number, number, number] | null {
    const r = this.site.dust?.record;
    if (!r?.length) return null;
    let best = r[0];
    for (const d of r) if (Math.abs(d[0] - sol) < Math.abs(best[0] - sol)) best = d;
    return best;
  }

  private get dustTau(): number {
    const d = this.site.dust;
    if (this.dustId === "eva" && d) return d.eva.tau;
    if (this.dustId === "sol" && d) return this.dustDay(this.dustSol)?.[1] ?? d.eva.tau;
    return (DUST_PRESETS.find((p) => p.id === this.dustId) ?? DUST_PRESETS[0]).tau;
  }

  /** The dust choices: this EVA's measured value, the historic storms, or any sol of the rover's record. */
  private dustOptions(): { id: string; label: string }[] {
    const d = this.site.dust;
    const own = d
      ? [
          { id: "eva", label: `${d.eva.how === "measured" ? `EVA sol ${d.eva.sol}` : "This season"} · τ ${d.eva.tau.toFixed(2)} (${d.rover})` },
          { id: "sol", label: `Any sol of ${d.rover}'s record…` },
        ]
      : [];
    return [...own, ...DUST_PRESETS.map((p) => ({ id: p.id, label: `${p.name} · τ ${p.tau}` }))];
  }

  private dustText(): string {
    const d = this.site.dust;
    const e = dustEffect(this.dustTau, Math.max(20, this.sunAtEva(this.mission?.t ?? 0).elevation));
    const effect = `Sunlight ${Math.round(e.sunlight * 100)}% of a clear day, visibility ${fmtVisibility(e.visibilityM)}.`;
    if (d && this.dustId === "eva") return `${d.eva.text}${d.standIn ? `. ${d.standIn}` : ""} (${d.instrument}, ${d.wavelengthNm} nm). ${effect}`;
    if (d && this.dustId === "sol") {
      const day = this.dustDay(this.dustSol);
      return day ? `Sol ${day[0]} (Ls ${Math.round(day[2])}°): τ ${day[1].toFixed(2)}, measured by ${d.rover}'s ${d.instrument}. ${effect}` : effect;
    }
    const p = DUST_PRESETS.find((x) => x.id === this.dustId) ?? DUST_PRESETS[0];
    return `Measured: ${p.where}. ${effect}`;
  }

  /** The whole record as a small chart, with the picked sol marked (only with "Any sol…"). */
  private dustChart(): string {
    const d = this.site.dust;
    if (!d || this.dustId !== "sol") return "";
    const r = d.record;
    const s0 = r[0][0], s1 = r[r.length - 1][0];
    const max = Math.max(1, ...r.map((x) => x[1]));
    const W = 236, H = 46;
    const X = (sol: number) => ((sol - s0) / Math.max(1, s1 - s0)) * W;
    const Y = (tau: number) => H - 2 - (Math.min(tau, max) / max) * (H - 6);
    const path = r.map((x, i) => `${i ? "L" : "M"}${X(x[0]).toFixed(1)},${Y(x[1]).toFixed(1)}`).join("");
    const day = this.dustDay(this.dustSol);
    return `<div class="dust-pick">
        <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(d.rover)}'s dust record, sols ${s0} to ${s1}; the highest is τ ${max.toFixed(1)}">
          <path d="${path}" fill="none" stroke="#f5b544" stroke-width="1.2"/>
          ${day ? `<line x1="${X(day[0]).toFixed(1)}" x2="${X(day[0]).toFixed(1)}" y1="0" y2="${H}" stroke="#c6f432" stroke-width="1.5"/>` : ""}
        </svg>
        <label><span class="vh">Sol</span><input type="range" id="dust-sol" min="${s0}" max="${s1}" step="1" value="${this.dustSol}"/></label>
        <small class="dust-axis"><span>sol ${s0}</span><span>τ up to ${max.toFixed(1)}</span><span>sol ${s1}</span></small>
      </div>`;
  }

  private setDust(id: string): void {
    const changed = id !== this.dustId;
    this.dustId = id;
    this.view.setDust(this.dustTau);
    setText(document.getElementById("dust-info"), this.dustText());
    const chart = document.getElementById("dust-chart");
    if (chart && changed) chart.innerHTML = this.dustChart();
    else if (chart) {
      // dragging the sol slider: move the marker only (rebuilding would drop the slider mid-drag)
      const r = this.site.dust!.record;
      const day = this.dustDay(this.dustSol);
      const x = day ? (((day[0] - r[0][0]) / Math.max(1, r[r.length - 1][0] - r[0][0])) * 236).toFixed(1) : "0";
      chart.querySelector("line")?.setAttribute("x1", x);
      chart.querySelector("line")?.setAttribute("x2", x);
    }
    this.dustWarned = false;
    if (this.phase === "eva") this.warnDust();
    if (this.viewMode === "walk") this.renderHud();
  }

  /** Tell the crew what the dust does to them (once per change). */
  private warnDust(): void {
    if (this.dustWarned || this.dustTau < 1) return;
    this.dustWarned = true;
    const e = dustEffect(this.dustTau, this.sunAtEva(this.mission?.t ?? 0).elevation);
    const vis = fmtVisibility(e.visibilityM);
    this.note("alert", `Dust storm, τ ${this.dustTau}: visibility ${vis}, sunlight ${Math.round(e.sunlight * 100)}%`);
    this.toast(`Dust storm (τ ${this.dustTau}): visibility about ${vis}, sunlight ${Math.round(e.sunlight * 100)}% of a clear day. Distant landmarks are gone — navigate by the route arrow, not by sight.`, 6500);
    this.voice.say(L.fixed("dust"));
  }

  // ================================================================ ghost of the real rover
  private setGhost(on: boolean): void {
    this.ghostOn = on;
    this.ghostClock = 0;
    this.view.setTrackVisible(this.showTrack || on);
    if (!on) {
      this.view.setGhost(null);
      return;
    }
    const tr = this.site.rover.traverse;
    let km = 0;
    for (let i = 1; i < tr.length; i++) km += Math.hypot(tr[i][0] - tr[i - 1][0], tr[i][1] - tr[i - 1][1]) / 1000;
    this.toast(
      `Ghost of ${this.roverName}: its real drive here, sols ${tr[0][2]}–${tr[tr.length - 1][2]} (${km.toFixed(1)} km in ${tr[tr.length - 1][2] - tr[0][2]} sols), replayed in 45 s. During an EVA it keeps pace with your walk.`,
      7000,
    );
  }

  /** Where the real rover was at `frac` (0..1) of its drive here, by sol: it stops between drives, as it did. */
  private ghostPose(frac: number): { x: number; y: number; heading: number; label: string } | null {
    const tr = this.site.rover.traverse;
    if (tr.length < 2) return null;
    const sol = tr[0][2] + frac * (tr[tr.length - 1][2] - tr[0][2]);
    let i = 1;
    while (i < tr.length - 1 && tr[i][2] < sol) i++;
    const a = tr[i - 1], b = tr[i];
    const k = b[2] > a[2] ? Math.min(1, Math.max(0, (sol - a[2]) / (b[2] - a[2]))) : 1;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.5) this.ghostHeading = Math.atan2(b[1] - a[1], b[0] - a[0]);
    return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, heading: this.ghostHeading, label: `${this.roverName} · sol ${Math.floor(sol)}` };
  }

  private tickGhost(dt: number): void {
    if (!this.ghostOn) return;
    const m = this.mission;
    let frac: number;
    if (m && this.phase === "eva" && this.plan) frac = Math.min(1, m.t / Math.max(1, this.plan.budget.totalTimeS));
    else {
      this.ghostClock = (this.ghostClock + dt) % 48; // 45 s of driving, then a pause at the end
      frac = Math.min(1, this.ghostClock / 45);
    }
    this.view.setGhost(this.ghostPose(frac));
  }

  // ================================================================ field notebook
  private pushNotes(): void {
    this.view.setNotes(this.notebook.notes.map((n) => ({ id: n.id, label: n.label, x: n.x, y: n.y, sample: n.sample, text: n.text })));
  }

  /** A new note or sample at a spot on the ground; opens the editor. */
  private addNote(p: XY, sample = false): void {
    const [lon, lat] = toLonLat(this.site.meta, p.x, p.y);
    const evaT = this.phase === "eva" && this.mission ? this.mission.t : null;
    const note: FieldNote = {
      id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      label: this.notebook.nextLabel(sample),
      sample,
      x: p.x,
      y: p.y,
      lon,
      lat,
      elevM: this.site.grid.heightAt(p.x, p.y),
      text: "",
      audio: false,
      evaT,
      eva: evaT !== null ? this.evaId || null : null,
      lmst: evaT !== null ? fmtLmst(this.lmstAt(evaT)) : "",
      created: new Date().toISOString(),
    };
    this.editNoteDialog(note, true);
  }

  private openNote(id: string): void {
    const n = this.notebook.get(id);
    if (n) this.editNoteDialog(n, false);
  }

  private editNoteDialog(note: FieldNote, isNew: boolean): void {
    const where = `${note.lat.toFixed(5)}° N, ${note.lon.toFixed(5)}° E · ${Math.round(note.elevM)} m${note.evaT !== null ? ` · EVA ${fmtClock(note.evaT)}, ${note.lmst} LMST` : ""}`;
    void import("./ui/noteEditor").then(({ editNote }) => editNote(
      this.notebook,
      note,
      isNew,
      where,
      (saved, clip) => {
        this.notebook.upsert(saved);
        if (clip) void this.notebook.saveAudio(saved.id, clip);
        this.pushNotes();
        this.renderLeft();
        if (isNew && saved.evaT !== null) {
          this.log.push({ t: saved.evaT, kind: "note", text: `${saved.label} ${saved.sample ? "sample" : "note"}${saved.text ? `: ${saved.text}` : ""}${clip ? " (voice)" : ""}` });
          this.log.sort((a, b) => a.t - b.t);
        }
        this.toast(`${saved.label} saved${saved.sample ? " as a sample" : ""}. It goes into the EVA log, the cue card and the exports.`, 3500);
      },
      () => {
        this.notebook.remove(note.id);
        this.pushNotes();
        this.renderLeft();
      },
    ));
  }

  private notesHtml(): string {
    const notes = this.notebook.notes;
    const list = notes
      .map((n) => `<li><button data-note="${n.id}"><span class="note-tag${n.sample ? " sample" : ""}">${esc(n.label)}</span><span>${esc(n.text || (n.audio ? "Voice note" : n.sample ? "Sample" : "Note"))}</span><small>${n.lmst || "plan"}</small></button></li>`)
      .join("");
    return `<section>
        <header class="sec-head"><h2>Field notebook</h2><span class="sub">${notes.length ? `${notes.length} entr${notes.length === 1 ? "y" : "ies"}` : ""}</span></header>
        ${notes.length ? `<ul class="notes-list">${list}</ul>` : ""}
        <p class="hint">${ic.note}<span>${this.phase === "eva" ? "Press <b>Note</b> in the bar below to note or sample where you stand, or click the map." : "Click the map and choose <b>Note</b> to add a geotagged note or sample."}</span></p>
      </section>`;
  }

  private selectLayer(id: LayerId): void {
    this.layer = id;
    this.view.setLayer(id, this.opacity);
    this.renderLeft();
    if (id === "hab") this.showHabBest();
  }

  /** The stops the hab is scored against: the ones in the plan (all science stops if none is ticked). */
  private habStops(): Poi[] {
    const chosen = this.pois.filter((p) => p.kind !== "shelter" && this.selected.includes(p.id));
    return chosen.length ? chosen : this.pois.filter((p) => p.kind !== "shelter");
  }

  /** Work the hab map out again when the stops have changed (a few hundred ms, after the panel paints). */
  private refreshHab(): void {
    const stops = this.habStops();
    const key = stops.map((p) => `${p.id}@${Math.round(p.x)},${Math.round(p.y)}`).join("|");
    if (key === this.habKey || this.habBusy) return;
    this.habBusy = true;
    window.setTimeout(async () => {
      const { habSuitability } = await import("./eva/hab");
      this.hab = habSuitability(this.site.grid, stops, this.pois.filter((p) => p.ice), this.P);
      this.habKey = key;
      this.habBusy = false;
      this.view.setHabMap(this.hab.score, this.hab.n);
      if (this.layer === "hab") {
        this.renderLeft();
        this.showHabBest(false);
      }
    }, 30);
  }

  /** Mark the best hab site on the map (and fly to it). */
  private showHabBest(fly = true): void {
    if (!this.hab) return;
    this.view.setSpot(this.hab.best, `Best hab site · ${Math.round(this.hab.bestFactors.score * 100)}/100`);
    if (fly) this.view.focusOn(this.hab.best);
    window.clearTimeout(this.spotTimer);
    this.spotTimer = window.setTimeout(() => this.view.setSpot(null), 12000);
  }

  /** The hab layer's panel: what makes the best spot best, and what to do with it. */
  private habHtml(locked: boolean): string {
    this.refreshHab();
    const h = this.hab;
    if (!h || this.habBusy) return `<p class="note">Scoring every spot of the area…</p>`;
    const f = h.bestFactors;
    const pct = (v: number) => `${Math.round(v * 100)}`;
    const bar = (label: string, v: number, detail: string, w: number) =>
      `<li><span>${label}<em aria-hidden="true">${w}%</em><span class="vh">: scores ${pct(v)} out of 100, weight ${w} percent.</span></span><i aria-hidden="true"><b style="width:${pct(v)}%"></b></i><small>${detail}</small></li>`;
    const W = h.weights;
    const wsum = W.shelter + W.radio + W.walk + (f.ice === null ? 0 : W.ice);
    const share = (w: number) => Math.round((w / wsum) * 100);
    const here = h.at(this.rover.x, this.rover.y);
    return `<div class="hab">
        <p class="hab-best"><b>${pct(f.score)}<small>/100</small></b><span>Best spot for the base, marked on the map. The rover is parked where the score is ${pct(here.score)}.</span></p>
        <ul class="hab-bars">
          ${bar("Flat ground", f.flat, `${f.slopeDeg.toFixed(1)}° mean slope · must-have`, 100)}
          ${bar("Walk to stops", f.walk, `${fmtDur(f.meanWalkS)} on average to ${h.stops} stop${h.stops === 1 ? "" : "s"}`, share(W.walk))}
          ${bar("Radio", f.radio, `${f.stopsInSight} of ${h.stops} stops in line of sight`, share(W.radio))}
          ${f.ice !== null ? bar("Buried ice", f.ice, `${fmtDur(f.iceWalkS ?? 0)} walk to the ice`, share(W.ice)) : ""}
          ${bar("Radiation cover", f.shelter, `terrain blocks ${f.shieldPct.toFixed(1)}% of the dose`, share(W.shelter))}
        </ul>
        <div class="hab-act">
          <button class="secondary" data-hab="show">${ic.locate}<span>Show</span></button>
          <button class="secondary" data-hab="park" ${locked ? "disabled" : ""} title="Park the rover (the crew's base) at the best spot and re-plan">${ic.home}<span>Park the rover here</span></button>
        </div>
        <p class="note">Scored for the stops in your plan: tick other stops and the map changes. Flat ground multiplies the score; the rest is a weighted mean. Worked out at ${h.cell} m in ${Math.max(1, Math.round(h.ms))} ms from the HiRISE terrain.</p>
      </div>`;
  }

  /** Who made a stop's 360° view, for its button (null: none). */
  private panoLabel(id: string): string | null {
    const info = this.site.panoramas?.panoramas[id];
    if (!info) return null;
    return info.nasa ? `NASA · ${this.roverName} ${info.camera.replace(/ \(.*\)/, "")}` : `${this.roverName} Navcam`;
  }

  /** Open the stitched 360° panorama for a stop; other stops appear as bearings on the compass. */
  async openPano(id: string, autoRotate = false): Promise<(() => void) | null> {
    const poi = this.poi(id);
    const info = this.site.panoramas?.panoramas[id];
    if (!poi || !info) return null;
    const wasPaused = this.paused;
    this.paused = true;
    const targets = this.pois
      .filter((p) => p.id !== id && (p.kind === "shelter" || this.selected.includes(p.id)))
      .map((p) => ({ name: p.short, bearing: (((Math.atan2(p.x - poi.x, p.y - poi.y) * 180) / Math.PI) + 360) % 360, distM: Math.hypot(p.x - poi.x, p.y - poi.y) }))
      .sort((a, b) => a.distM - b.distM);
    const { openPanorama } = await import("./ui/panorama");
    return openPanorama(this.site.base, poi, info, this.roverName, targets, { autoRotate, onClose: () => (this.paused = wasPaused) });
  }

  private closeCard(): void {
    hideAnimated($("#card"), 160);
    this.cardPoi = null;
  }

  // ================================================================ EVA
  private startEva(): void {
    this.callouts = new RouteCallouts();
    // the clips this EVA will need first: the common phrases and this plan's stops
    this.voice.preload([
      ...Object.keys(PHRASES),
      ...(this.plan?.order ?? []).flatMap((p, i) => (p.kind === "shelter" ? [] : [`n-${p.id}`, `na-${p.id}`, `wp-${i}`])),
    ]);
    if (!this.plan || !this.plan.budget.feasible) return;
    const segs = this.plan.budget.segments;
    let onset: number | null = null;
    if (this.storm) {
      // the storm starts shortly after the crew leaves the first science stop
      let t = 0;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const dur = s.kind === "walk" ? s.path.time : s.durationS;
        if (s.kind === "dwell") {
          const nextWalk = segs[i + 1];
          onset = t + dur + Math.min(120, nextWalk && nextWalk.kind === "walk" ? nextWalk.path.time * 0.25 : 60);
          break;
        }
        t += dur;
      }
    }
    const grid = this.site.grid;
    this.mission = new Mission(segs, this.rad, this.P, this.lookup, onset, (x, y) => grid.shieldAt(x, y));
    this.phase = "eva";
    this.paused = false;
    void this.keepAwake(true);
    this.shelterPath = null;
    this.shelteredAtS = null;
    this.radioLost = false;
    this.relayUp = false;
    this.lowSunWarned = this.sunAtEva(0).elevation < 8; // a plan that starts in low sun was warned about already
    this.log = [{ t: 0, kind: "go", text: "Left the rover" }];
    this.earthQueue = [];
    this.tellEarth("EVA started", false);
    this.dustWarned = false;
    window.setTimeout(() => this.warnDust(), 2500);
    if (this.member === "ev1") this.evaId = `eva-${Date.now().toString(36)}`; // EV2 keeps EV1's (from the hab)
    this.logSent = "";
    this.crewSend({ type: "eva", state: "start", evaId: this.evaId, lightTimeS: this.skyAt(0).lightTimeS }, true);
    this.sendFrame();
    this.view.setRelay(this.useRelay ? this.plan?.relay?.at ?? null : null);
    $("#pin-menu").hidden = true;
    this.closeCard();
    this.pushRoutes();
    this.renderLeft();
    this.renderRight();
    this.renderBottom();
    this.setView("walk");
    this.toast("EVA started. Visor view — drag to look around, or switch to Map / 3D.", 5000);
    const first = this.mission.next();
    if (first.poi) this.voice.say(L.heading(this.destOf(first.poi), first.distM, first.etaS, true));
  }

  private backToPlanning(): void {
    window.setTimeout(() => {
      if (this.pendingChange && this.phase === "planning") {
        const c = this.pendingChange;
        this.pendingChange = null;
        this.applyChange(c);
      }
    }, 0);
    if (this.phase === "eva" && this.evaId) this.crewSend({ type: "eva", state: "end", evaId: this.evaId, aborted: true, summary: "EVA ended early from the planner." }, true);
    void this.keepAwake(false);
    this.mission = null;
    this.voice.stop();
    this.phase = "planning";
    this.shelterPath = null;
    this.shelteredAtS = null;
    this.clearAlert();
    this.closeCard();
    this.view.setAstronaut(null);
    this.view.setBuddy(null);
    if (this.viewMode === "walk") this.setView("plan");
    this.profile?.setCursor(null);
    this.relayUp = false;
    this.pushRelay();
    this.afterPlan();
  }

  private resumeRemaining(): void {
    const remaining = this.mission?.remaining().map((p) => p.id) ?? [];
    this.selected = remaining;
    this.storm = false;
    this.backToPlanning();
    void this.replan();
    this.toast("New sol, storm passed. Remaining objectives re-planned from the rover.", 4500);
  }

  private skipAhead(): void {
    const m = this.mission;
    if (!m || m.phase === "holding") return;
    const seg = m.segment;
    if (!seg) return;
    const dur = seg.kind === "walk" ? seg.path.time : seg.durationS;
    this.handleEvents(m.advance(Math.max(0, dur - m.segT) + 0.01));
  }

  /** Called every frame by the scene. */
  tick(dt: number): void {
    const m = this.mission;
    if (m && this.phase === "eva") {
      if (this.member === "ev2") {
        // run at EV1's speed, held to EV1's EVA clock (frames arrive four times a second)
        let step = dt * this.followSpeed;
        const err = this.followT - m.t;
        if (err > Math.max(2, this.followSpeed * 0.6)) step = err; // fell behind (tab hidden, joined late): catch up
        step = Math.max(0, Math.min(step, this.followT + this.followSpeed * 0.5 - m.t));
        if (step > 0) this.handleEvents(m.advance(step));
      } else if (!this.paused) this.handleEvents(m.advance(dt * this.speed));
      const pose = m.pose();
      if (this.member === "ev2") {
        // this device is EV2: the camera is at EV2, and EV1 is the other suit, walking ahead
        const me = m.buddyPose();
        if (this.ev2Last && Math.hypot(me.x - this.ev2Last.x, me.y - this.ev2Last.y) > 0.05) this.ev2Heading = Math.atan2(me.x - this.ev2Last.x, me.y - this.ev2Last.y);
        const moving = !!this.ev2Last && Math.hypot(me.x - this.ev2Last.x, me.y - this.ev2Last.y) > 0.01;
        this.ev2Last = me;
        this.view.setAstronaut({ x: me.x, y: me.y, headingRad: this.ev2Heading, moving }, dt);
        this.view.setBuddy({ x: pose.x, y: pose.y }, true);
      } else {
        this.view.setAstronaut({ x: pose.x, y: pose.y, headingRad: pose.headingRad, moving: pose.moving && !this.paused }, dt);
        this.view.setBuddy(this.buddy ? m.buddyPose() : null, this.ev2Online > 0);
      }
      if (this.viewMode === "orbit" && pose.moving && !this.paused) this.view.follow(pose.x, pose.y, dt);
      this.watchRadio(m);
      this.watchSun(m);
      if (this.viewMode === "walk" && !this.paused) this.guide(m);
    }
    const sun = this.sunAtEva(m && this.phase !== "planning" ? m.t : 0);
    const key = `${sun.elevation.toFixed(2)}/${sun.azimuth.toFixed(2)}`;
    if (key !== this.lastSun) {
      this.lastSun = key;
      this.view.setSun(sun.elevation, sun.azimuth);
    }
    const skyT = m && this.phase !== "planning" ? m.t : 0;
    const skyKey = `${this.startLmst}/${Math.floor(skyT)}`;
    if (skyKey !== this.lastSky) {
      this.lastSky = skyKey;
      const s = this.skyAt(skyT);
      const km = (b: { distanceKm: number }) => `${Math.round(b.distanceKm).toLocaleString("en")} km`;
      this.view.setSkyBodies({
        earth: { dir: s.earth.dir, sizeDeg: s.earth.sizeDeg, caption: `${fmtLightTime(s.lightTimeS)} by radio` },
        phobos: { dir: s.phobos.dir, sizeDeg: s.phobos.sizeDeg, caption: km(s.phobos) },
        deimos: { dir: s.deimos.dir, sizeDeg: s.deimos.sizeDeg, caption: km(s.deimos) },
      });
    }
    while (m && this.phase === "eva" && this.earthQueue.length && this.earthQueue[0].t <= m.t) {
      const msg = this.earthQueue.shift()!;
      this.log.push({ t: msg.t, kind: "earth", text: msg.text });
      this.log.sort((x, y) => x.t - y.t); // a skip ahead can deliver it after later events
      this.toast(msg.text, 3500);
    }
    this.tickGhost(dt);
    this.frameTimer += dt;
    if (this.frameTimer > 0.25) {
      this.frameTimer = 0;
      this.sendFrame();
    }
    this.liveTimer += dt;
    if (this.liveTimer > 0.1) {
      this.liveTimer = 0;
      if (m && this.phase === "eva") this.updateLive();
      if (this.viewMode === "walk") this.updateHud();
    }
    this.widgetTimer += dt;
    if (this.widgetTimer > 0.2) {
      this.widgetTimer = 0;
      this.updateWidgets();
    }
  }

  private handleEvents(events: MissionEvent[]): void {
    for (const ev of events) {
      if (ev.type === "arrive" && ev.poi.kind !== "shelter" && this.demo && this.demoArrived === null) {
        this.demoArrived = ev.poi.id;
        this.paused = true; // hold the walk until the demo has shown the stop
      }
      if (ev.type === "arrive" && ev.poi.kind !== "shelter") {
        this.note("stop", `Arrived at ${ev.poi.short}`);
        this.openCard(ev.poi.id, true);
        const quiet = this.radioLost;
        this.toast(`Arrived at ${ev.poi.short}. ${ev.poi.dwellMin} min of science.${quiet ? " No radio contact here: check in before and after." : ""}`);
        this.voice.say(L.arrived(ev.poi.id, ev.poi.short, ev.poi.dwellMin * 60, quiet));
      } else if (ev.type === "depart") {
        this.note("go", `Left ${ev.poi.short}`);
        if (this.cardPoi === ev.poi.id) this.closeCard();
        const n = this.mission?.next();
        if (n?.poi) this.voice.say(L.heading(this.destOf(n.poi), n.distM, n.etaS));
      } else if (ev.type === "alert") void this.onAlert(ev.rateUGyH);
      else if (ev.type === "sheltered") {
        this.note("home", "Inside the rover");
        this.onSheltered();
      } else if (ev.type === "complete") {
        if (!this.log.some((l) => l.kind === "home")) this.note("home", "Back at the rover");
        this.onComplete(ev.aborted);
      }
    }
  }

  private async onAlert(rate: number): Promise<void> {
    this.buzz([300, 120, 300, 120, 300]);
    this.note("alert", `Storm alert: ${Math.round(rate)} µGy/h, turned back`);
    const m = this.mission!;
    const lt = this.tellEarth("the storm alert", true);
    this.closeCard();
    const pose = m.pose();
    const res = await this.router.shelterPath({ x: pose.x, y: pose.y });
    if (this.mission !== m) return;
    const pts = res.path ?? [{ x: pose.x, y: pose.y }, { x: this.rover.x, y: this.rover.y }];
    const path = measurePath(this.site.grid, pts, this.P);
    const proj = m.reroute(path, this.rover);
    this.shelterPath = path;
    this.speed = Math.min(this.speed, 60);
    this.pushRoutes();
    this.renderBottom();
    $("#stage").classList.add("storm");
    const alert = $("#alert");
    alert.className = "danger";
    const cover = this.naturalCover(pose.x, pose.y);
    alert.innerHTML = `<div class="ico">${ic.rad}</div><div><b>Solar particle event — abort the EVA</b>
      <span>Dose rate ${(rate / this.rad.baseline).toFixed(0)}× background and rising.</span>
      <span class="go">Shelter in the rover · ${fmtDist(path.distance)} · ${fmtDur(path.time)} · route found in ${Math.max(1, Math.round(res.ms))} ms</span>
      <span class="sub2">${
        cover
          ? `Nearest natural cover: ${cover.dir} ${fmtDist(cover.dist)} away, ${cover.pct}% less dose. The rover cuts ${Math.round((1 - this.P.shelterFactor) * 100)}%.`
          : `No useful natural cover nearby: terrain here blocks under 3% of the dose.`
      }</span>
      <span class="sub2 earth">Earth is ${fmtLightTime(lt)} away by radio: Mission Control hears this at ${fmtClock(m.t + lt)} and can answer at ${fmtClock(m.t + 2 * lt)} at the earliest. The crew decides now.</span></div>`;
    alert.hidden = false;
    this.voice.say(L.storm(path.distance, path.time), "urgent");
    const box = document.getElementById("stormbox");
    if (box) {
      box.hidden = false;
      $("#st-proj").innerHTML = `<div class="avoided"><span>Projected dose avoided by sheltering now</span><b>${fmtDose(proj.avoidedUGy)}</b>
        <small>${fmtDose(proj.shelterUGy)} sheltering vs ${fmtDose(proj.continueUGy)} finishing the walk as planned.</small></div>`;
      this.doseChart = renderDoseChart($("#st-chart"), this.site.replay, this.rad, this.P.shelterFactor);
    }
  }

  private onSheltered(): void {
    const m = this.mission!;
    this.shelteredAtS = m.t;
    const alert = $("#alert");
    alert.className = "safe";
    const em = m.emergency;
    alert.innerHTML = em
      ? `<div class="ico">${ic.home}</div><div><b>Crew back in the rover</b><span>Home ${fmtDur(m.t - em.atS)} after the ${em.kind === "leak" ? "suit leak" : "injury"}, with ${Math.round(this.P.o2SupplyL - m.o2UsedL)} L of oxygen left.</span></div>`
      : `<div class="ico">${ic.home}</div><div><b>Crew in shelter</b><span>Inside the rover ${fmtDur(m.t - (m.alertS ?? m.t))} after the alert. Dose rate cut to ${this.P.shelterFactor}× outdoors.</span></div>`;
    this.voice.say(em ? L.backInRover(this.P.o2SupplyL - m.o2UsedL) : L.fixed("inside-rover"), "urgent");
    $("#stage").classList.remove("storm");
    this.speed = 300;
    this.renderBottom();
    if (this.viewMode === "walk") this.setView("orbit");
  }

  private onComplete(aborted: boolean): void {
    this.sendFrame();
    this.sendLog();
    this.crewSend({ type: "eva", state: "end", evaId: this.evaId, aborted, summary: this.log.map((e) => `${fmtClock(e.t)} ${e.text}`).join("\n") }, true);
    this.phase = "summary";
    void this.keepAwake(false);
    this.clearAlert();
    this.closeCard();
    if (this.viewMode === "walk") this.setView("orbit");
    this.renderRight();
    this.renderBottom();
    this.toast(aborted ? "Storm window over. Crew safe." : "EVA complete. Crew back at the rover.", 4500);
  }

  private clearAlert(): void {
    $("#alert").hidden = true;
    $("#stage").classList.remove("storm");
  }

  /** Best terrain shielding within ~150 m (cliffs and channel walls block part of the sky). */
  private naturalCover(x: number, y: number): { dist: number; pct: number; dir: string } | null {
    const grid = this.site.grid;
    if (!grid.shield) return null;
    let best: { dist: number; pct: number; dir: string } | null = null;
    let bestScore = 0;
    for (let r = 4; r <= 150; r += 4) {
      for (let a = 0; a < 360; a += 10) {
        const px = x + r * Math.sin((a * Math.PI) / 180);
        const py = y + r * Math.cos((a * Math.PI) / 180);
        if (!grid.inside(px, py)) continue;
        const node = grid.nodeAt(px, py);
        if (grid.isBlocked(node)) continue;
        const cut = 1 - grid.shield[node] / 255;
        const score = cut - r * 0.0002; // prefer close cover
        if (cut >= 0.03 && score > bestScore) {
          bestScore = score;
          best = { dist: r, pct: Math.round(cut * 100), dir: App.compass(a) };
        }
      }
    }
    return best;
  }

  // ================================================================ radio, voice, emergencies
  /** One line in the plan: how much of the walk keeps line of sight to the rover's antenna. */
  private radioLine(): string {
    const plan = this.plan;
    const rc = plan?.radio;
    if (!plan || !rc) return "";
    const relay = plan.relay;
    const toward = relay ? this.relayLeg(relay) : null;
    const where = relay ? `after ${fmtDist(relay.alongM)}${toward ? ` (on the way to ${esc(toward)})` : ""}` : "";
    const silent = this.silentStops();
    const silentText = silent.length
      ? ` <b class="warnc">No contact at ${silent.map((p) => esc(p.short)).join(" or ")}</b> (${silent.map((p) => `${p.dwellMin} min`).join(", ")} of science).`
      : "";
    if (relay && this.useRelay) {
      const whose = relay.manual ? ` at the spot you chose${relay.offRouteM ? `, ${relay.offRouteM} m off the route` : ""}` : " where CAIRN suggests";
      const auto = relay.manual ? `<button class="link" data-act="relay-auto" title="Put the relay back where CAIRN suggests">Let CAIRN choose</button>` : "";
      return `<div class="radio-line${silent.length ? " warn" : ""}">${ic.radio}<span>In radio contact for <b>${Math.floor(rc.coveredFraction * 100)}%</b> of the walk, with a relay stood up ${where}${whose}.${silentText} <small class="relay-how">To move it, click the map → <b>Relay here</b>.</small></span>${auto}<button class="link" data-act="relay-off">Remove</button></div>`;
    }
    const whole = rc.lostS < 20 && !silent.length;
    const text = whole
      ? "In radio contact with the rover the whole way."
      : `In radio contact for <b>${Math.floor(rc.coveredFraction * 100)}%</b> of the walk${rc.gaps ? ` · ${rc.gaps} blackout${rc.gaps > 1 ? "s" : ""}, longest ${fmtDur(Math.max(60, rc.longestGapS))}` : ""}.${silentText}`;
    const freed = relay ? silent.filter((p) => plan.order.indexOf(p) >= relay.leg + 1 && lineOfSight(this.site.grid, relay.at, RELAY_MAST_M, p, SUIT_ANTENNA_M)) : [];
    const tip = relay
      ? `<div class="relay-tip"><span>A ${RELAY_MAST_M} m relay mast stood up ${where} gives contact for <b>${Math.floor(relay.after.coveredFraction * 100)}%</b> of the walk${freed.length ? ` and at ${freed.map((p) => esc(p.short)).join(" and ")}` : ""}. Or put it where you want: click the map → <b>Relay here</b>.</span><button class="secondary" data-act="relay-on">${ic.radio}<span>Plan with relay</span></button></div>`
      : whole ? "" : `<div class="relay-tip"><span>CAIRN found no spot where a relay helps much. You can still put one where you want: click the map → <b>Relay here</b>.</span></div>`;
    return `<div class="radio-line${whole ? "" : " warn"}${tip ? " has-tip" : ""}">${ic.radio}<span>${text}</span><button class="link" data-act="show-radio">Show</button></div>${tip}`;
  }

  /** Radio line of the hover probe: the rover in sight, the relay (when planned), or no signal. */
  private probeRadio(x: number, y: number): string {
    const grid = this.site.grid;
    const r = this.useRelay ? this.plan?.relay : null;
    const rover = inContact(this.radio, grid, x, y);
    const relay = !rover && !!r && inContact(this.relayShadowAt(r.at), grid, x, y);
    return `<dt>Radio</dt><dd class="${rover || relay ? "" : "warnc"}">${rover ? "rover in sight" : relay ? "relay in sight" : "no signal"}</dd>`;
  }

  private spotTimer = 0;
  /** Fly to the route's farthest point from the rover, or its steepest ground, and mark it for a while. */
  private showSpot(kind: "home" | "steep"): void {
    if (!this.plan) return;
    let best: PathSample | null = null;
    let bestV = -Infinity;
    for (const leg of this.plan.legs) {
      for (const smp of leg.samples) {
        const v = kind === "steep" ? smp.slopeDeg : this.lookup(smp.x, smp.y).timeS;
        if (Number.isFinite(v) && v > bestV) {
          bestV = v;
          best = smp;
        }
      }
    }
    if (!best) return;
    const text = kind === "steep" ? `Steepest on the route · ${Math.round(bestV)}°` : `Farthest from the rover · ${fmtDur(bestV)} home`;
    this.view.setSpot(best, text);
    this.view.focusOn(best);
    window.clearTimeout(this.spotTimer);
    this.spotTimer = window.setTimeout(() => this.view.setSpot(null), 9000);
  }

  // ================================================================ field use: screen and haptics
  private wakeLock: WakeLockSentinel | null = null;
  private wakeWatch = false;

  /** Keep a phone or tablet screen on during the EVA (the visor is useless if it goes dark). */
  private async keepAwake(on: boolean): Promise<void> {
    if (!("wakeLock" in navigator)) return;
    if (!this.wakeWatch) {
      this.wakeWatch = true;
      // the lock drops when the page is hidden; take it again on return if the EVA is still on
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && this.phase === "eva" && !this.wakeLock) void this.keepAwake(true);
      });
    }
    try {
      if (on && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener("release", () => (this.wakeLock = null));
      } else if (!on && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {
      /* not allowed here (e.g. battery saver): the EVA runs anyway */
    }
  }

  /** Vibrate a phone for alerts: a glove-friendly cue that does not need eyes on the screen. */
  private buzz(pattern: number[] = [180, 90, 180]): void {
    try {
      navigator.vibrate?.(pattern);
    } catch {
      /* no vibration motor */
    }
  }

  /** Out of radio contact at a sample of the planned route (counting the relay once it is up). */
  private lostOnPlan(x: number, y: number, leg: number, i: number): boolean {
    const r = this.useRelay ? this.plan?.relay : null;
    const up = !!r && (leg > r.leg || (leg === r.leg && i > r.sample));
    return !inContact(this.radio, this.site.grid, x, y, up ? this.relayShadowAt(r!.at) : null);
  }

  /** Stops of the plan where the crew does its science out of radio contact (counting the relay once it is up). */
  private silentStops(): Poi[] {
    const plan = this.plan;
    if (!plan) return [];
    const r = this.useRelay ? plan.relay : null;
    return plan.order.filter((p, k) => {
      if (p.kind === "shelter") return false;
      const relayUp = !!r && k >= r.leg + 1;
      return !inContact(this.radio, this.site.grid, p.x, p.y, relayUp ? this.relayShadowAt(r!.at) : null);
    });
  }

  /** Name of the stop the crew is walking to when it reaches the relay spot. */
  private relayLeg(r: RelaySuggestion): string | null {
    const to = this.plan?.order[r.leg + 1];
    return to && to.kind !== "shelter" ? to.short : to ? "the rover" : null;
  }

  /** Relay marker on the map and the radio layer with the relay's coverage added. */
  private pushRelay(): void {
    const r = this.useRelay ? this.plan?.relay ?? null : null;
    this.view.setRelay(r ? r.at : null);
    if (!r) return this.view.setRadioShadow(this.radio);
    const both = new Uint8Array(this.radio.length);
    const rs = this.relayShadowAt(r.at);
    for (let i = 0; i < both.length; i++) both[i] = Math.min(this.radio[i], rs[i]);
    this.view.setRadioShadow(both);
  }

  private setRelay(on: boolean): void {
    this.useRelay = on;
    if (!on) this.relayManual = null;
    void this.replan();
  }

  /** The crew puts the relay mast where they want it (map menu); checked on the next plan. */
  private placeRelay(p: XY): void {
    if (!this.plan) return this.toast("Plan a route first: the crew stands the relay up on the way.");
    const check = relayAtPoint(this.radio, this.site.grid, this.plan.legs, p, RELAY_MAST_M);
    if ("reason" in check) return this.toast(check.reason, 7000);
    this.relayManual = { x: Math.round(p.x), y: Math.round(p.y) };
    this.useRelay = true;
    void this.replan();
    this.toast(`Relay mast placed${check.relay.offRouteM ? `, ${check.relay.offRouteM} m off the route` : " on the route"}. The crew stands it up as they pass.`, 5000);
  }

  /** Radio shadow of a relay mast at a point, made once per position (~0.1 s) and only when the relay is used. */
  private relayCache: { x: number; y: number; shadow: Uint8Array } | null = null;
  private relayShadowAt(at: XY): Uint8Array {
    const c = this.relayCache;
    if (c && c.x === at.x && c.y === at.y) return c.shadow;
    const shadow = radioShadow(this.site.grid, at, RELAY_MAST_M);
    this.relayCache = { x: at.x, y: at.y, shadow };
    return shadow;
  }

  /** Relay shadow once the relay is up in this EVA, else null. */
  private liveRelay(): Uint8Array | null {
    return this.relayUp && this.plan?.relay ? this.relayShadowAt(this.plan.relay.at) : null;
  }

  /** Warn once if the walk runs late enough for the Sun to drop below 8° (a delay, an emergency at half speed). */
  private lowSunWarned = false;
  private watchSun(m: Mission): void {
    if (this.lowSunWarned || m.sheltered || m.phase === "complete") return;
    const sun = this.sunAtEva(m.t);
    if (sun.elevation >= 8 || sun.elevation < -1) return;
    this.lowSunWarned = true;
    this.note("alert", "Sun below 8°");
    this.buzz([200, 100, 200]);
    this.toast("The Sun is below 8°: long shadows hide rocks and holes, and it is getting cold. Head back to the rover.", 6000);
    this.voice.say(L.fixed("low-sun"), "event");
  }

  /** Tell the crew when the terrain cuts the line of sight to the rover, and when it comes back. */
  private watchRadio(m: Mission): void {
    const relay = this.useRelay ? this.plan?.relay : null;
    if (relay && !this.relayUp && m.t >= this.plan!.relayAtS && m.alertS === null && !m.emergency) {
      this.relayUp = true;
      this.note("radio", "Relay up");
      this.view.setRelay(relay.at, true);
      this.toast("Relay up: radio contact now reaches the ground behind the hills.", 3500);
      this.voice.say(L.fixed("relay"));
    }
    const p = m.pose();
    const lost = !m.sheltered && m.phase !== "complete" && !inContact(this.radio, this.site.grid, p.x, p.y, this.liveRelay());
    if (lost === this.radioLost) return;
    this.radioLost = lost;
    this.note("radio", lost ? "Radio contact lost" : "Radio contact back");
    if (lost) {
      this.buzz([120]);
      this.toast("Radio contact with the rover lost: the terrain blocks the line of sight.", 4000);
      this.voice.say(L.fixed("radio-lost"), "event", "radio-lost");
    } else {
      this.toast("Radio contact with the rover restored.", 2500);
      this.voice.say(L.fixed("radio-back"), "event", "radio-back");
    }
  }

  /** Where a leg goes, for the voice: the rover, or the stop and its number in the plan. */
  private destOf(poi: Poi): Dest {
    if (poi.kind === "shelter") return { rover: true, id: "rover", short: "the rover", k: 0 };
    const k = this.plan?.order.findIndex((p, i) => p.id === poi.id && i > 0) ?? -1;
    return { rover: false, id: poi.id, short: poi.short, k: Math.max(0, k) };
  }


  /** Routine spoken directions in the visor, only when something changes: a turn, steep ground or sand ahead, 100 m and 25 m to go. */
  private guide(m: Mission): void {
    if (!this.voice.enabled) return;
    const seg = m.segment;
    const n = m.next();
    if (!seg || seg.kind !== "walk" || !n.poi || n.distM < 8 || m.phase === "holding") return;
    const s = sampleAtTime(seg.path, m.segT);
    const samples = seg.path.samples;
    const ahead = samples.find((q) => q.dist >= s.dist + 25) ?? samples[samples.length - 1];
    const bearing = (Math.atan2(ahead.x - s.x, ahead.y - s.y) * 180) / Math.PI;
    const turn = ((bearing - (s.headingRad * 180) / Math.PI + 540) % 360) - 180;
    let steep = 0;
    let sand = false;
    for (const q of samples) {
      if (q.dist < s.dist || q.dist > s.dist + 50) continue;
      steep = Math.max(steep, q.slopeDeg);
      sand ||= q.sand > 0.5;
    }
    const line = this.callouts.next({ legId: n.poi.id, dest: this.destOf(n.poi), distM: n.distM, turnDeg: turn, steepDeg: steep, sand });
    if (line) this.voice.say(line, "routine");
  }

  /**
   * Practice emergency during the EVA: stop, find the quickest safe way home from here, check the
   * oxygen with the new consumption, and walk home.
   */
  private async triggerEmergency(kind: EmergencyKind): Promise<void> {
    const m = this.mission;
    if (!m || m.phase !== "eva" || m.emergency || m.alertS !== null || !m.segment) return;
    this.buzz([300, 120, 300]);
    this.note("alert", kind === "leak" ? "Practice emergency: suit leak, turned back" : "Practice emergency: twisted ankle, turned back");
    m.hold();
    this.closeCard();
    const pose = m.pose();
    const res = await this.router.shelterPath({ x: pose.x, y: pose.y });
    if (this.mission !== m) return;
    const pts = res.path ?? [{ x: pose.x, y: pose.y }, { x: this.rover.x, y: this.rover.y }];
    const path = measurePath(this.site.grid, pts, this.P);
    const em = m.emergencyHome(kind, path, this.rover);
    this.shelterPath = path;
    this.paused = false;
    this.pushRoutes();
    this.renderBottom();
    this.updateLive();
    const spare = em.leftL - em.needL;
    const reserve = this.P.o2SupplyL * this.P.reserveFraction;
    const verdict = spare >= reserve ? "Makes it home with the reserve untouched" : spare >= 0 ? "Makes it home, using the reserve" : "Not enough oxygen to walk home";
    const title = kind === "leak" ? "Suit leak — oxygen use doubled" : "Twisted ankle — walking at half speed";
    const alert = $("#alert");
    alert.className = spare >= 0 ? "danger drill" : "danger";
    alert.innerHTML = `<div class="ico">${kind === "leak" ? ic.leak : ic.ankle}</div><div><b>${title}</b>
      <span>${
        path.distance < 15
          ? "The crew is still beside the rover: straight back inside."
          : `Quickest safe way home: ${fmtDist(path.distance)} · ${fmtDur(em.homeTimeS)}. Needs ${Math.round(em.needL)} L of the ${Math.round(em.leftL)} L left.`
      }</span>
      <span class="go">${verdict}: ${spare >= 0 ? `${Math.round(spare)} L to spare` : `${Math.round(-spare)} L short`} · route found in ${Math.max(1, Math.round(res.ms))} ms</span>
      <span class="sub2">${spare >= 0 ? `Turn back now.${this.buddy ? " The buddy stays alongside." : ""}` : "Call the rover to drive out and meet the crew."}</span></div>`;
    alert.hidden = false;
    this.voice.say(L.emergency(kind, path.distance, em.homeTimeS, spare), "urgent");
  }

  // ================================================================ offline
  private async goOffline(): Promise<void> {
    const name = this.site.meta.name.split(" — ")[0];
    this.toast(`Saving ${name} for offline use…`, 60000);
    try {
      const mb = (b: number) => Math.round(b / 1e6);
      const r = await saveForOffline(this.site.id, (done, total, bytes, totalBytes) =>
        this.toast(`Saving for offline use… ${done} of ${total} files · ${mb(bytes)} of ${mb(totalBytes)} MB`, 60000),
      );
      this.toast(`${name} now works offline (${mb(r.bytes)} MB saved on this device).`, 5000);
      await promptInstall();
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), 6000);
    }
  }

  // ================================================================ rover check
  private hazardClass(node: number): number {
    const g = this.site.grid;
    const r = g.risk[node];
    if (r >= 250) return 4;
    const total = (g.effort[node] / g.effortScale) * (Math.min(r, 254) / g.riskScale);
    return total <= 1.25 ? 0 : total <= 1.9 ? 1 : total <= 2.8 ? 2 : 3;
  }

  /** How the rover's real drive through the walk area scores on CAIRN's terrain model. */
  private roverCheck(): RoverCheck | null {
    if (this.roverCheckCache) return this.roverCheckCache;
    const g = this.site.grid;
    const pts = this.site.rover.traverse.filter(([x, y]) => g.inside(x, y));
    if (pts.length < 3) return null;
    const drive = measurePath(g, pts.map(([x, y]) => ({ x, y })), this.P);
    const track = [0, 0, 0, 0, 0];
    for (let i = 1; i < drive.samples.length; i++) {
      const a = drive.samples[i - 1];
      const b = drive.samples[i];
      track[this.hazardClass(g.nodeAt((a.x + b.x) / 2, (a.y + b.y) / 2))] += b.dist - a.dist;
    }
    const area = [0, 0, 0, 0, 0];
    for (let i = 0; i < g.n * g.n; i++) area[this.hazardClass(i)]++;
    const norm = (v: number[]) => {
      const sum = v.reduce((s, x) => s + x, 0) || 1;
      return v.map((x) => x / sum);
    };
    this.roverCheckCache = {
      distanceM: drive.distance, sols: [pts[0][2], pts[pts.length - 1][2]], track: norm(track), area: norm(area), maxSlopeDeg: drive.maxSlopeDeg,
    };
    return this.roverCheckCache;
  }

  private roverCheckHtml(): string {
    const rc = this.roverCheck();
    if (!rc) return "";
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const bar = (shares: number[]) =>
      `<div class="hz-bar">${shares.map((v, i) => (v > 0.002 ? `<i style="width:${(v * 100).toFixed(1)}%;background:${i === 4 ? "repeating-linear-gradient(135deg,#8c2973 0 3px,#f2dcec 3px 5px)" : HAZARD_COLORS[i]}" title="${HAZARD_CLASSES[i]} ${pct(v)}"></i>` : "")).join("")}</div>`;
    const easyTrack = rc.track[0] + rc.track[1];
    const easyArea = rc.area[0] + rc.area[1];
    return `<section class="rover-check">
      <h3>Check against ${esc(this.roverName)}'s real drive</h3>
      <p>${pct(easyTrack)} of ${esc(this.roverName)}'s ${fmtDist(rc.distanceM)} drive here is on ground CAIRN rates easy or moderate, against ${pct(easyArea)} of the area. The rover drivers kept to the ground CAIRN prefers.</p>
      <div class="hz"><span>Rover drive</span>${bar(rc.track)}<span>Whole area</span>${bar(rc.area)}</div>
      <div class="legend units hz-key">${HAZARD_CLASSES.map((c, i) => `<span><i style="background:${i === 4 ? "repeating-linear-gradient(135deg,#8c2973 0 3px,#f2dcec 3px 5px)" : HAZARD_COLORS[i]}"></i>${c}</span>`).join("")}</div>
      <p class="note">Sols ${rc.sols[0]}–${rc.sols[1]}, rover positions joined by straight lines; steepest ground on the drive ${rc.maxSlopeDeg}°. A rover is not an astronaut, so this checks the terrain model, not the walking model.</p>
      <button class="link" data-act="show-track">${ic.compare}<span>${this.showTrack ? "Hide" : "Show"} the real track on the map</span></button>
    </section>`;
  }

  // ================================================================ live readouts
  private weatherAt(tS: number): { lmst: string; air: number | null; ground: number | null; pressure: number | null } {
    const w = this.site.weather;
    const hours = ((this.lmstAt(tS) % 24) + 24) % 24;
    const pick = (arr: (number | null)[] | undefined) => {
      if (!w || !arr) return null;
      const i = Math.floor(hours / w.stepH);
      for (let d = 0; d < arr.length; d++) {
        const v = arr[(i + d) % arr.length] ?? arr[(i - d + arr.length) % arr.length];
        if (v !== null && v !== undefined) return v;
      }
      return null;
    };
    const hh = Math.floor(hours);
    const mm = Math.floor((hours - hh) * 60);
    return { lmst: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, air: pick(w?.airTempK), ground: pick(w?.groundTempK), pressure: pick(w?.pressurePa) };
  }

  private stormUtc(m: Mission): string {
    if (m.stormOnsetS === null || m.t < m.stormOnsetS) return "";
    const onset = Date.parse(this.site.replay.event.assumedOnsetUtc);
    const d = new Date(onset + (m.t - m.stormOnsetS) * 1000);
    return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }

  private phaseLabel(m: Mission): { label: string; name: string } {
    if (m.phase === "complete") return { label: m.alertS !== null || m.emergency !== null ? "EVA ended early ·" : "EVA complete ·", name: "crew back in the rover" };
    if (m.phase === "holding") return { label: "Alert —", name: "finding the way to shelter" };
    if (m.phase === "to-shelter") return { label: "Returning to", name: "the rover (shelter)" };
    if (m.sheltered) return { label: "Sheltering in", name: "the rover" };
    const n = m.next();
    return { label: n.label, name: n.poi?.short ?? "" };
  }

  private updateLive(): void {
    const m = this.mission;
    if (!m || !document.getElementById("lv-clock")) return;
    const P = this.P;
    const n = m.next();
    const ph = this.phaseLabel(m);
    const left = P.o2SupplyL - m.o2UsedL;
    const margin = m.walkBackMarginL();
    const w = this.weatherAt(m.t);
    setText($("#lv-clock"), fmtClock(m.t));
    this.sheetSummary();
    setText($("#lv-label"), ph.label);
    setText($("#lv-next"), ph.name);
    setText($("#lv-dist-k"), n.distM > 0 || m.sheltered ? "Distance left" : "Science time left");
    setText($("#lv-dist"), n.distM > 0 ? `${fmtDist(n.distM)} · ${fmtDur(n.etaS)}` : m.sheltered ? "—" : fmtDur(n.etaS));
    setText($("#lv-walked"), fmtDist(m.distanceM));
    const lr = document.getElementById("lv-radio");
    const relayOnly = !this.radioLost && this.relayUp && !inContact(this.radio, this.site.grid, m.pose().x, m.pose().y);
    setText(lr, m.sheltered ? "in the rover" : this.radioLost ? "no line of sight to the rover" : relayOnly ? "in contact through the relay" : "in contact with the rover");
    if (lr) lr.className = this.radioLost && !m.sheltered ? "warnc" : "";
    const drillOff = m.phase !== "eva" || m.emergency !== null || m.alertS !== null || !m.segment;
    for (const b of document.querySelectorAll<HTMLButtonElement>(".drill button")) b.disabled = drillOff;
    $("#lv-o2bar").style.width = `${Math.max(0, (m.o2UsedL / P.o2SupplyL) * 100).toFixed(1)}%`;
    setText($("#lv-o2"), `${Math.round(left)} L`);
    const mg = $("#lv-margin");
    setText(mg, `${margin >= 0 ? "+" : ""}${Math.round(margin)} L`);
    mg.className = margin >= 0 ? "good" : "bad";
    setText($("#lv-home"), fmtDur(m.returnTimeS()));
    const rate = m.doseRate;
    setText($("#lv-rate"), fmtRate(rate));
    setText($("#lv-mult"), `${(rate / this.rad.baseline).toFixed(rate > this.rad.baseline * 1.5 ? 0 : 1)}× background${m.sheltered ? " (in rover)" : ""}`);
    $("#lv-rate").parentElement!.className = m.outdoorRate > this.rad.baseline * 3 ? (m.sheltered ? "warnc" : "bad") : "";
    setText($("#lv-dose"), fmtDose(m.doseUGy));
    setText($("#lv-lmst"), `${w.lmst} LMST`);
    setText(document.getElementById("lv-temp"), `${w.air !== null ? Math.round(w.air - 273.15) : "—"} °C / ${w.ground !== null ? Math.round(w.ground - 273.15) : "—"} °C`);
    setText(document.getElementById("lv-pres"), w.pressure !== null ? `${Math.round(w.pressure)} Pa` : "—");
    const sunNow = this.sunAtEva(m.t);
    const pose = m.pose();
    const shaded = sunNow.elevation > 0 && inTerrainShadow(this.site.grid, pose.x, pose.y, sunNow.elevation, sunNow.azimuth);
    setText(document.getElementById("lv-sun"), `${this.sunText(sunNow)}${shaded ? " · in shade" : ""}`);
    const skyNow = this.skyAt(m.t);
    setText(document.getElementById("lv-earth"), `${fmtLightTime(skyNow.lightTimeS)} by radio · ${this.sunText(skyNow.earth)}`);
    if (this.buddy) {
      const b = m.buddyPose();
      const p = m.pose();
      const sep = Math.hypot(b.x - p.x, b.y - p.y);
      const el = document.getElementById("lv-buddy");
      if (el) {
        setText(el, `${sep.toFixed(0)} m ${sep <= P.buddyMaxSeparationM ? "✓" : "— too far"}`);
        el.className = sep <= P.buddyMaxSeparationM ? "good" : "bad";
      }
    }
    if (m.stormActive) {
      setText(document.getElementById("st-utc"), `Storm clock: ${this.stormUtc(m)}`);
      const h = (m.t - m.stormOnsetS!) / 3600;
      this.doseChart?.update(h, this.shelteredAtS !== null ? (this.shelteredAtS - m.stormOnsetS!) / 3600 : null);
    }
    // cursor on the elevation profile (only while still on the planned route)
    if (this.plan && m.alertS === null) {
      let d = 0;
      for (let i = 0; i < m.plannedSegments.length && i < m.segIndex; i++) {
        const s = m.plannedSegments[i];
        if (s.kind === "walk") d += s.path.distance;
      }
      const seg = m.segment;
      if (seg && seg.kind === "walk") d += seg.path.distance - m.next().distM;
      this.profile?.setCursor(d);
    } else this.profile?.setCursor(null);
  }

  // ================================================================ visor HUD
  private renderHud(): void {
    const hud = $("#hud");
    const marks: string[] = [];
    const names: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
    for (let deg = -180; deg <= 540; deg += 15) {
      const norm = ((deg % 360) + 360) % 360;
      const label = names[norm] ?? String(norm);
      marks.push(`<span class="${names[norm] ? "card" : ""}" style="left:${(deg + 180) * PX_PER_DEG}px">${label}</span>`);
    }
    const size = this.site.meta.sizeM;
    hud.innerHTML = `
      <div class="hud-top"><div class="tape"><div class="strip" id="hud-tape">${marks.join("")}</div><i></i></div><b id="hud-head">000°</b></div>
      <div class="hud-side left">
        <div class="hud-item"><span>O₂</span><div class="meter"><i id="hud-o2bar"></i><u style="left:${((1 - this.P.reserveFraction) * 100).toFixed(1)}%"></u></div><b id="hud-o2">—</b></div>
        <div class="hud-item minor"><span>Walk-back</span><b id="hud-margin">—</b></div>
        <div class="hud-item"><span>Way home</span><b id="hud-home">—</b></div>
        <div class="hud-item" id="hud-radiobox"><span>Radio</span><b id="hud-radio">—</b></div>
        <div class="hud-item minor"><span>EVA clock</span><b id="hud-clock">00:00:00</b></div>
        <div class="hud-item minor" title="One-way radio delay to Mission Control"><span>Earth delay</span><b id="hud-earth">—</b></div>
      </div>
      <div class="hud-side right">
        <div class="hud-item" id="hud-ratebox"><span>Dose rate</span><b><i id="hud-rate">—</i> µGy/h</b></div>
        <div class="hud-item minor"><span>Dose</span><b id="hud-dose">—</b></div>
        ${this.dustTau >= 1 ? (() => {
          const e = dustEffect(this.dustTau, this.sunAtEva(this.mission?.t ?? 0).elevation);
          return `<div class="hud-item warn" title="Dust optical depth τ ${this.dustTau}"><span>Dust · visibility</span><b>${fmtVisibility(e.visibilityM)}</b></div>
        <div class="hud-item minor warn"><span>Sunlight</span><b>${Math.round(e.sunlight * 100)}%</b></div>`;
        })() : ""}
        ${this.site.weather ? `<div class="hud-item minor"><span>Air · ground</span><b id="hud-temp">—</b></div>
        <div class="hud-item minor"><span>Pressure</span><b id="hud-pres">—</b></div>` : ""}
      </div>
      <div class="hud-bottom">
        <div class="arrow" id="hud-arrow">▲</div>
        <div><span id="hud-label">Standing at</span><b id="hud-next">${esc(this.rover.short)}</b><span id="hud-dist">${this.mission ? "" : "Start the EVA to walk the route"}</span></div>
      </div>
      <div class="minimap"><svg id="hud-map" viewBox="0 0 500 500">
        <image href="${this.site.base}${this.site.meta.texture.file}" x="0" y="0" width="${size}" height="${size}" preserveAspectRatio="none"/>
        <g id="mm-routes"></g><g id="mm-pois"></g>
        <g id="mm-me"><circle r="26" class="halo"/><path d="M0,-17 L11,13 L0,6 L-11,13Z"/></g>
      </svg><span>North up · 500 m across</span></div>
      <div class="hud-hint">Drag to look around</div>`;
    hud.hidden = false;
    this.renderMinimapRoutes();
    this.updateHud();
  }

  private renderMinimapRoutes(): void {
    const g = document.getElementById("mm-routes");
    const gp = document.getElementById("mm-pois");
    if (!g || !gp) return;
    const size = this.site.meta.sizeM;
    const pts = (path: MeasuredPath) => {
      const stride = Math.max(1, Math.floor(path.samples.length / 150));
      return path.samples.filter((_, i) => i % stride === 0 || i === path.samples.length - 1).map((s) => `${s.x.toFixed(0)},${(size - s.y).toFixed(0)}`).join(" ");
    };
    let html = "";
    for (const leg of this.plan?.legs ?? []) html += `<polyline class="${this.shelterPath ? "old" : "safe"}" points="${pts(leg)}"/>`;
    if (this.shelterPath) html += `<polyline class="shelter" points="${pts(this.shelterPath)}"/>`;
    g.innerHTML = html;
    gp.innerHTML = this.pois
      .filter((p) => p.kind === "shelter" || this.selected.includes(p.id))
      .map((p) => `<circle class="${p.kind}" cx="${p.x}" cy="${size - p.y}" r="${p.kind === "shelter" ? 13 : 10}"/>`)
      .join("");
  }

  private updateHud(): void {
    if ($("#hud").hidden) return;
    const head = this.view.cameraHeadingDeg();
    const tape = $("#hud-tape");
    const half = tape.parentElement!.clientWidth / 2;
    tape.style.transform = `translateX(${(half - (head + 180) * PX_PER_DEG).toFixed(1)}px)`;
    setText($("#hud-head"), Number.isFinite(head) ? `${String(Math.round(head) % 360).padStart(3, "0")}°` : "—"); // the first frame of the visor, before the camera is placed

    const m = this.mission;
    const pose = m ? m.pose() : { x: this.rover.x, y: this.rover.y, headingRad: 0 };
    const size = this.site.meta.sizeM;
    $("#hud-map").setAttribute("viewBox", `${(pose.x - 250).toFixed(0)} ${(size - pose.y - 250).toFixed(0)} 500 500`);
    document.getElementById("mm-me")!.setAttribute("transform", `translate(${pose.x.toFixed(1)},${(size - pose.y).toFixed(1)}) rotate(${head.toFixed(0)})`);
    if (!m) return;

    const P = this.P;
    const n = m.next();
    const ph = this.phaseLabel(m);
    const margin = m.walkBackMarginL();
    const w = this.weatherAt(m.t);
    $("#hud-o2bar").style.width = `${Math.max(0, (m.o2UsedL / P.o2SupplyL) * 100).toFixed(1)}%`;
    setText($("#hud-o2"), `${Math.round(P.o2SupplyL - m.o2UsedL)} L`);
    const mg = $("#hud-margin");
    setText(mg, `${margin >= 0 ? "+" : ""}${Math.round(margin)} L`);
    mg.className = margin >= 0 ? "" : "bad";
    setText($("#hud-home"), fmtDur(m.returnTimeS()));
    const viaRelay = !this.radioLost && this.relayUp && this.mission && !inContact(this.radio, this.site.grid, this.mission.pose().x, this.mission.pose().y);
    setText($("#hud-radio"), this.radioLost ? "No signal" : viaRelay ? "Relay ✓" : "Rover ✓");
    $("#hud-radiobox").className = `hud-item${this.radioLost ? " warn" : ""}`;
    setText($("#hud-clock"), fmtClock(m.t));
    setText(document.getElementById("hud-earth"), fmtLightTime(this.skyAt(m.t).lightTimeS));
    setText($("#hud-rate"), fmtRate(m.doseRate));
    $("#hud-ratebox").className = `hud-item${m.outdoorRate > this.rad.baseline * 3 ? " bad" : ""}`;
    setText($("#hud-dose"), fmtDose(m.doseUGy));
    setText(document.getElementById("hud-temp"), `${w.air !== null ? Math.round(w.air - 273.15) : "—"} · ${w.ground !== null ? Math.round(w.ground - 273.15) : "—"} °C`);
    setText(document.getElementById("hud-pres"), w.pressure !== null ? `${Math.round(w.pressure)} Pa` : "—");
    setText($("#hud-label"), ph.label);
    setText($("#hud-next"), ph.name);
    setText($("#hud-dist"), n.distM > 0 ? `${fmtDist(n.distM)} · ${fmtDur(n.etaS)}` : n.poi && !m.sheltered ? `${fmtDur(n.etaS)} of science left` : "");
    const target = n.poi ?? this.rover;
    const bearing = (Math.atan2(target.x - pose.x, target.y - pose.y) * 180) / Math.PI;
    const arrow = $("#hud-arrow");
    arrow.style.transform = `rotate(${(bearing - head).toFixed(0)}deg)`;
    arrow.style.visibility = n.distM > 3 ? "visible" : "hidden";
    $("#hud").classList.toggle("storm", m.phase === "to-shelter" || m.phase === "holding");
  }

  // ================================================================ map widgets and probe
  private updateWidgets(): void {
    if (this.viewMode === "walk") return;
    $("#compass").querySelector<HTMLElement>("i")!.style.transform = `rotate(${(-this.view.cameraHeadingDeg()).toFixed(1)}deg)`;
    const mpp = this.view.metresPerPixel();
    const nice = [10, 20, 50, 100, 200, 500, 1000].find((v) => v / mpp >= 70) ?? 1000;
    const bar = $("#scalebar");
    bar.querySelector<HTMLElement>("i")!.style.width = `${(nice / mpp).toFixed(0)}px`;
    setText(bar.querySelector("span"), nice >= 1000 ? `${nice / 1000} km` : `${nice} m`);
  }

  private hover(p: XY | null, clientX: number, clientY: number): void {
    const probe = $("#probe");
    this.view.setHoverMarker(p);
    if (!p || this.viewMode === "walk") {
      probe.hidden = true;
      return;
    }
    const grid = this.site.grid;
    const node = grid.nodeAt(p.x, p.y);
    const home = this.field.time[node];
    const blocked = grid.isBlocked(node);
    const thermal = this.site.thermalGrid;
    const cold = thermal ? 1 - thermal[node] / 255 : null;
    const minerals = this.mineralsAt(node);
    const shieldCut = grid.shield ? Math.round((1 - grid.shield[node] / 255) * 100) : 0;
    const rect = $("#stage").getBoundingClientRect();
    probe.innerHTML = `
      <b>${grid.heightAt(p.x, p.y).toFixed(1)} m</b> elevation
      <dl>
        <dt>Slope</dt><dd class="${blocked ? "bad" : ""}">${grid.slope[node]}°${blocked ? " — impassable" : ""}</dd>
        <dt>Loose sand</dt><dd>${Math.round((grid.sand[node] / 255) * 100)}%</dd>
        ${cold !== null ? `<dt>Night IR</dt><dd>${cold > 0.6 ? "cold" : cold < 0.35 ? "warm" : "mid"}</dd>` : ""}
        ${this.site.geology ? `<dt>Rock unit</dt><dd>${esc(this.unitAt(p.x, p.y) ?? "unmapped")}</dd>` : ""}
        ${minerals ? `<dt>CRISM</dt><dd>${esc(minerals)}</dd>` : ""}
        ${shieldCut >= 2 ? `<dt>Sky shielding</dt><dd>−${shieldCut}% dose</dd>` : ""}
        <dt>To shelter</dt><dd>${Number.isFinite(home) ? fmtDur(home) : "cut off"}</dd>
        ${this.probeRadio(p.x, p.y)}
      </dl>`;
    probe.hidden = false;
    probe.style.left = `${Math.min(rect.width - 250, clientX - rect.left + 16)}px`;
    probe.style.top = `${Math.min(rect.height - 150, clientY - rect.top + 16)}px`;
  }
}
