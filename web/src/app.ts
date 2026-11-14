import type { LayerId } from "./scene/terrain";
import { measurePath } from "./data/grid";
import type { SiteData, SiteEntry } from "./data/loaders";
import { buildBudget, EvaBudget, o2Litres, ReturnLookup, sampleAtTime, Segment, walkO2 } from "./eva/budget";
import { DEFAULT_PARAMS, EvaParams } from "./eva/params";
import { RadiationModel } from "./eva/radiation";
import { bestRelay, inContact, RadioCoverage, radioCoverage, radioShadow, relayFromShadow, RelaySuggestion, RELAY_MAST_M } from "./eva/radio";
import { inTerrainShadow } from "./eva/shade";
import { fmtLmst, MARS_HOUR_S, SolarGeometry, solarGeometry, sunAt, SunPosition } from "./eva/sun";
import { EmergencyKind, Mission, MissionEvent } from "./replay/mission";
import type { FieldResult, Router } from "./routing/client";
import type { SceneView } from "./scene/view";
import type { MeasuredPath, PathSample, Poi, XY } from "./types";
import { showBriefing } from "./ui/briefing";
import { DoseChartHandle, ProfileHandle, renderDoseChart, renderProfile } from "./ui/charts";
import { $, esc, fmtClock, fmtDist, fmtDose, fmtDur, fmtRate, setText } from "./ui/dom";
import { ic } from "./ui/icons";
import { openModal, showAssumptions, showSources, stopCardHtml } from "./ui/modals";
import { openPanorama } from "./ui/panorama";
import { DemoRunner, DemoStep } from "./ui/demo";
import { CueRow, showCueCard } from "./ui/cuecard";
import { ExportPlan, routeGeoJson, routeKml, saveFile } from "./ui/export";
import { promptInstall, saveForOffline } from "./ui/offline";
import { spokenDist, spokenTime, turnWords, Voice } from "./ui/voice";

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
export class App {
  private readonly P: EvaParams = DEFAULT_PARAMS;
  private readonly rad: RadiationModel;
  private readonly rover: Poi;
  private pois: Poi[];
  private customCount = 0;
  private selected: string[];
  private readonly roverName: string;

  private layer: LayerId = "none";
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
  private readonly radio: Uint8Array;
  private radioLost = false;
  /** Plan with the suggested relay (the crew stands it up on the way). */
  private useRelay = false;
  /** The relay is up during the current EVA. */
  private relayUp = false;
  /** What happened during the current EVA, for the summary (mission seconds, kind, text). */
  private log: { t: number; kind: "go" | "stop" | "radio" | "alert" | "home"; text: string }[] = [];

  private note(kind: "go" | "stop" | "radio" | "alert" | "home", text: string): void {
    this.log.push({ t: this.mission?.t ?? 0, kind, text });
  }
  private readonly voice = new Voice();
  private roverCheckCache: RoverCheck | null = null;

  constructor(
    private readonly site: SiteData,
    private readonly view: SceneView,
    private readonly router: Router,
    private readonly field: FieldResult,
    private readonly sites: SiteEntry[] = [],
  ) {
    this.rad = new RadiationModel(site.replay);
    this.roverName = site.meta.rover?.name ?? "Perseverance";
    this.selected = site.pois.filter((p) => p.kind === "objective").map((p) => p.id);
    this.startLmst = site.meta.eva?.startLmst ?? 10;
    this.solar = solarGeometry(Date.parse(site.meta.eva?.utc ?? "2024-07-21T02:10:26Z"));
    this.lat = site.meta.centerLonLat?.lat ?? (site.meta.boundsLonLat.south + site.meta.boundsLonLat.north) / 2;
    this.pois = site.pois.slice();
    this.rover = this.pois.find((p) => p.kind === "shelter")!;
    this.lookup = (x, y) => {
      const node = site.grid.nodeAt(x, y);
      return { timeS: field.time[node], energyJ: field.energy[node] };
    };

    this.radio = field.radio; // computed by the routing worker at start-up
    view.setRadioShadow(this.radio);

    setText($("#site-name"), site.meta.name);
    this.bindChrome();
    view.onPoiClick = (id) => this.openCard(id, false);
    view.onGroundClick = (p, cx, cy) => this.groundClick(p, cx, cy);
    view.onHover = (p, cx, cy) => this.hover(p, cx, cy);
    new ResizeObserver(() => this.renderProfileChart()).observe($("#bottom"));
    new ResizeObserver(() => this.updateInsets()).observe($("#app"));

    this.applyPlanHash(location.hash);
    this.renderLeft();
    this.renderRight();
    this.renderBottom();
    this.syncViewButtons();
    void this.replan();
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
      <button id="btn-demo" class="demo-btn" title="Play the guided demo">${ic.play}<span>Demo</span></button>
      <button id="btn-about" aria-haspopup="menu" title="Briefing, data sources and assumptions">${ic.info}<span>About</span>${ic.chev}</button>`;
    $("#about-menu").innerHTML = `
      <button data-about="briefing">${ic.book}<span><b>Mission briefing</b><small>The site, the story and why it matters</small></span></button>
      <button data-about="sources">${ic.data}<span><b>Data sources</b><small>Where every layer and number comes from</small></span></button>
      <button data-about="model">${ic.sliders}<span><b>Suit and model assumptions</b><small>Oxygen, walking and radiation models</small></span></button>
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
    about.addEventListener("click", (ev) => {
      const item = (ev.target as HTMLElement).closest<HTMLElement>("[data-about]")?.dataset.about;
      if (!item) return;
      about.hidden = true;
      if (item === "briefing") showBriefing(this.site, () => {}, this.sites);
      else if (item === "sources") showSources(this.site);
      else if (item === "offline") void this.goOffline();
      else if (item === "keys") this.showShortcuts();
      else showAssumptions(this.site, this.P);
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
    $("#btn-panels").addEventListener("click", (ev) => {
      ev.stopPropagation();
      $("#app").classList.toggle("drawer");
      requestAnimationFrame(() => this.updateInsets());
    });
    $("#stage").addEventListener("pointerdown", () => $("#app").classList.remove("drawer"));
    window.addEventListener("cairn:demo", () => void this.startDemo());
    const menu = $("#site-menu");
    menu.innerHTML = this.sites
      .map((s) => `<a role="menuitem" href="?site=${s.id}" class="${s.id === this.site.id ? "on" : ""}"><b>${esc(s.name)}</b><span>${esc(s.place)} · ${esc(s.rover)}</span><em>${esc(s.tagline)}</em></a>`)
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
      const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-info],[data-src],[data-remove]");
      if (!t) return;
      if (t.dataset.info) this.openCard(t.dataset.info, false);
      else if (t.dataset.src) showSources(this.site, t.dataset.src);
      else if (t.dataset.remove) this.removeCustom(t.dataset.remove);
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
      else if (act === "fly") this.setView("fly");
      else if (act === "cue") this.openCueCard();
      else if (act === "export") {
        ev.stopPropagation();
        const menu = document.getElementById("export-menu");
        if (menu) menu.hidden = !menu.hidden;
      } else if (act === "kml" || act === "geojson") this.exportRoute(act);
      else if (act === "link") void this.copyPlanLink();
      else if (act === "resume") this.resumeRemaining();
      else if (act === "show-radio") this.selectLayer("radio");
      else if (act === "relay-on" || act === "relay-off") this.setRelay(act === "relay-on");
      else if (act === "spot") this.showSpot(t.dataset.spot === "steep" ? "steep" : "home");
      else if (act === "show-track") {
        this.showTrack = !this.showTrack;
        this.view.setTrackVisible(this.showTrack);
        this.renderRight();
      } else if (act === "emergency") void this.triggerEmergency(t.dataset.kind as EmergencyKind);
      else if (act === "replan") this.backToPlanning();
      else if (act === "sources") showSources(this.site, t.dataset.id);
      else if (act === "model") showAssumptions(this.site, this.P);
    });

    window.addEventListener("keydown", (ev) => this.onKey(ev));

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
        if (this.voice.enabled) this.voice.say("Voice guidance on.", "urgent");
      } else if (act === "skip") this.skipAhead();
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

  /**
   * Start times (06:00–17:00 on the slider) that keep the Sun above 8° for the whole walk:
   * a gradient for the slider track and one line of text.
   */
  private daylightTrack(totalS: number): { gradient: string; text: string } {
    const ok: boolean[] = [];
    for (let t = 6; t <= 17.0001; t += 0.25) {
      ok.push(sunAt(this.lat, t, this.solar).elevation >= 8 && sunAt(this.lat, t + totalS / MARS_HOUR_S, this.solar).elevation >= 8);
    }
    const good = "rgba(90, 212, 138, 0.6)";
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

  private static compass(az: number): string {
    return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(az / 45) % 8];
  }

  private sunText(sun: SunPosition): string {
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
    const relay = bestRelay(this.radio, grid, legs);
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
    this.view.setPois(
      this.pois.map((poi) => {
        const idx = order.findIndex((p, i) => p.id === poi.id && i > 0 && i < order.length - 1);
        return { poi, active: poi.kind === "shelter" || this.selected.includes(poi.id), order: idx > 0 ? idx : null };
      }),
    );
  }

  private groundClick(p: XY, clientX: number, clientY: number): void {
    const menu = $("#pin-menu");
    if (this.phase !== "planning") return;
    const grid = this.site.grid;
    const node = grid.nodeAt(p.x, p.y);
    const rect = $("#stage").getBoundingClientRect();
    const blocked = grid.isBlocked(node) || !Number.isFinite(this.field.time[node]);
    menu.innerHTML = blocked
      ? `<p class="t bad">${ic.warn}Too steep to walk</p><p>Slope ${grid.slope[node]}°, beyond the ${this.site.meta.model.slopeLimitDeg}° limit or cut off from the rover.</p><div class="row"><button data-x="close">OK</button></div>`
      : `<p class="t">${ic.walk}${fmtDur(this.field.time[node])} from the rover</p><p>Slope ${grid.slope[node]}°${this.site.geologyGrid ? ` · ${esc(this.unitAt(p.x, p.y) ?? "unmapped unit")}` : ""}</p><div class="row"><button data-x="close">Cancel</button><button class="primary" data-x="add">${ic.plus}<span>Add stop</span></button></div>`;
    menu.hidden = false;
    menu.style.left = `${Math.min(rect.width - 260, Math.max(8, clientX - rect.left + 12))}px`;
    menu.style.top = `${Math.min(rect.height - 150, Math.max(8, clientY - rect.top + 12))}px`;
    menu.onclick = (ev) => {
      const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-x]")?.dataset.x;
      if (!act) return;
      menu.hidden = true;
      if (act === "add") this.addCustom(p);
    };
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
    return LAYERS.filter((l) => (l.id !== "thermal" || g.thermal) && (l.id !== "geology" || g.geology) && (l.id !== "minerals" || g.minerals) && (l.id !== "shield" || this.site.grid.shield));
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
    const groups: [string, LayerId[]][] = [["Safety", ["risk", "shelter", "radio", "slope", "sand"]], ["Science", ["minerals", "geology", "thermal"]], ["Radiation", ["shield"]]];
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

    $("#left").innerHTML = `
      <section>
        <header class="sec-head"><h2>Route</h2><span class="sub">${locked ? "Locked during the EVA" : "Tick stops · CAIRN orders them"}</span></header>
        <ul class="stops">
          <li class="stop shelter">
            <span class="pin home">${ic.home}</span>
            <span class="txt"><b>${esc(this.rover.name)}</b><small>Start, end and radiation shelter</small></span>
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
      </section>`;
  }

  /** Display settings, in a small menu on the map. */
  private renderViewMenu(): void {
    $("#view-menu").innerHTML = `
      <h3>Display</h3>
      <label class="switch"><span>${esc(this.roverName)}'s real track</span><input class="sr" type="checkbox" id="track" ${this.showTrack ? "checked" : ""}/><i></i></label>
      <label class="switch"><span>Sun shadows</span><input class="sr" type="checkbox" id="shadows" ${this.showShadows ? "checked" : ""}/><i></i></label>
      <label class="slider"><span>Vertical exaggeration <b id="exag-val">×${this.exag.toFixed(2)}</b></span><input type="range" id="exag" min="1" max="2.5" step="0.25" value="${this.exag}"/></label>`;
  }

  private displayChange(t: HTMLInputElement): void {
    if (t.id === "track") {
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
  private renderRight(): void {
    const host = $("#right");
    $("#app").dataset.phase = this.phase;
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
          <div class="o2">
            <div class="o2-head"><span>Oxygen</span><b>${Math.round(b.o2UsedL)} L <small>of ${P.o2SupplyL} L</small></b></div>
            <div class="meter"><i style="width:${Math.min(100, usedPct).toFixed(1)}%"></i><u style="left:${(100 - reservePct).toFixed(1)}%"></u></div>
            <p class="o2-sub"><b class="${margin >= 0 ? "good" : "bad"}">${margin >= 0 ? `${Math.round(margin)} L spare` : `${Math.round(-margin)} L short`}</b> after walking home from the farthest point and keeping the ${reservePct}% reserve</p>
          </div>
          ${this.radioLine()}
          <label class="slider start"><span>Leave the rover at <b id="start-val">${fmtLmst(this.startLmst)} LMST</b></span>
            <input type="range" id="start" min="6" max="17" step="0.25" value="${this.startLmst}" style="--track:${this.daylightTrack(b.totalTimeS).gradient}"/>
            <small id="sun-val">Sun ${this.sunText(sunStart)} → ${this.sunText(sunEnd)} at ${fmtLmst(this.lmstAt(b.totalTimeS))}</small>
            <small class="daylight">${this.daylightTrack(b.totalTimeS).text}</small></label>
          <div class="vs">
            <p>${vs}</p>
            <label class="switch"><span>Show the straight line on the map</span><input class="sr" type="checkbox" id="opt-straight" ${this.showStraight ? "checked" : ""}/><i></i></label>
          </div>
        </section>
        <details class="more" id="plan-details" ${this.detailsOpen ? "open" : ""}>
          <summary><span>Details</span><em>time, dose, comparison, simulation</em>${ic.chev}</summary>
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
          <button data-act="link">${ic.link}<span><b>Copy link to this plan</b><small>Stops, start time and options, for a teammate or a judge</small></span></button>
        </div>
        <button class="primary big" data-act="start" ${b.feasible ? "" : "disabled"}>${ic.play}<span>Start EVA</span></button>
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
            <dt>Distance left</dt><dd id="lv-dist"></dd>
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
          <header class="sec-head"><h2>Weather</h2><button class="link" data-act="sources" data-id="meda">${ic.info}<span>${esc((this.site.weather.instrument ?? "MEDA").split(" ").pop()!)}</span></button></header>
          <dl class="kv">
            <dt>Local time</dt><dd id="lv-lmst"></dd>
          <dt>Sun</dt><dd id="lv-sun"></dd>
            <dt>Air · ground</dt><dd id="lv-temp"></dd>
            <dt>Pressure</dt><dd id="lv-pres"></dd>
          </dl>
          <p class="note">${esc(this.site.weather.instrument ?? "Perseverance MEDA")} readings for the same time of day on sol ${this.site.weather.sol}.</p>
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
        ${this.logHtml()}
      </div>
      <footer class="panel-foot">
        ${remaining.length ? `<button class="primary big" data-act="resume">${ic.later}<span>Plan the remaining stop${remaining.length > 1 ? "s" : ""} for a later sol</span></button>` : ""}
        <button class="big" data-act="replan">Back to planning</button>
      </footer>`;
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
                 ${this.voice.supported ? `<button class="ghost voice${this.voice.enabled ? " on" : ""}" data-act="voice" title="Spoken directions" aria-pressed="${this.voice.enabled}">${this.voice.enabled ? ic.voiceOn : ic.voiceOff}<span>Voice</span></button>` : ""}
                 <button class="ghost" data-act="end">${ic.stop}<span>End EVA</span></button>
               </div>`
            : `<h2>Elevation along the route</h2>`
        }
        ${
          open
            ? `<div class="key">
                 <span><i style="background:#56b4e9"></i>&lt; 10°</span><span><i style="background:#f0e442"></i>10–18°</span>
                 <span><i style="background:#e69f00"></i>18–25°</span><span><i style="background:${HATCH}"></i>too steep</span>
                 <span><i class="sand"></i>sand</span>${this.plan && this.plan.radio.lostS > 0 ? `<span><i class="noradio"></i>no radio</span>` : ""}${straight ? `<span><i class="dash"></i>straight line</span>` : ""}
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
    );
  }

  // ================================================================ stop card
  private openCard(id: string, arrived: boolean): void {
    const poi = this.poi(id);
    if (!poi) return;
    const card = $("#card");
    const tex = this.site.meta.texture;
    const orbital = tex.hi ? { url: this.site.base + tex.hi.file, sizeM: this.site.meta.sizeM, mPerPx: tex.hi.mPerPx } : { url: this.site.base + tex.file, sizeM: this.site.meta.sizeM, mPerPx: tex.mPerPx };
    card.innerHTML = stopCardHtml(poi, this.site.base, this.unitAt(poi.x, poi.y), arrived, this.roverName, !!this.site.panoramas?.panoramas[poi.id], orbital);
    card.hidden = false;
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
        body: `CAIRN places the Sun for the actual sol (${meta.eva?.sol ?? "—"}) and casts shadows from the real terrain. At dawn, long shadows hide rocks and holes — so the plan leaves later.`,
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
        body: `The visor shows heading, oxygen, dose and the next stop. At each stop: what ${esc(this.roverName)} actually saw there.`,
        run: async (d) => {
          this.storm = true;
          this.demoArrived = null;
          this.startEva();
          this.speed = 300;
          await d.until(() => this.demoArrived !== null, 30000);
          if (objective && this.site.panoramas?.panoramas[objective.id]) {
            await d.sleep(2500);
            d.say(`A real 360° view stitched from ${esc(this.roverName)}'s Navcam frames at this exact spot.`);
            closePano = this.openPano(objective.id, true);
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
          await d.sleep(4500);
          this.speed = 300;
          await d.until(() => this.phase === "summary", 60000);
          lastAvoided = this.mission?.projection?.avoidedUGy ?? 0;
          await d.sleep(3500);
        },
      },
    ];
    this.demo = new DemoRunner(steps, {
      title: "Robots built the cairns. Humans will follow them.",
      body: () =>
        `${lastAvoided > 0 ? `Sheltering avoided <b>${fmtDose(lastAvoided)}</b> of radiation. ` : ""}Every layer here comes from NASA, USGS and JPL archives — open <b>About → Data sources</b> to check any of them.`,
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
    const custom = this.selected.map((id) => this.poi(id)).filter((p): p is Poi => !!p && p.id.startsWith("custom-"));
    const parts = [`stops=${this.selected.filter((id) => !id.startsWith("custom-")).map(encodeURIComponent).join(",")}`];
    if (custom.length) parts.push(`add=${custom.map((p) => `${Math.round(p.x)}_${Math.round(p.y)}`).join(",")}`);
    if (this.startLmst !== (this.site.meta.eva?.startLmst ?? 10)) parts.push(`t=${+this.startLmst.toFixed(2)}`);
    if (!this.storm) parts.push("storm=0");
    if (this.buddy) parts.push("buddy=1");
    if (this.useRelay) parts.push("relay=1");
    return parts.join("&");
  }

  private writePlanHash(): void {
    const url = `${location.pathname}${location.search}#${this.planHash()}`;
    if (url !== `${location.pathname}${location.search}${location.hash}`) history.replaceState(history.state, "", url);
  }

  /** Restore a plan from a link; anything that does not fit this site is ignored. */
  private applyPlanHash(hash: string): void {
    const q = new URLSearchParams(hash.replace(/^#/, ""));
    if (!q.has("stops") && !q.has("add")) return;
    const ids = (q.get("stops") ?? "").split(",").filter((id) => this.site.pois.some((p) => p.id === id && p.kind !== "shelter"));
    const grid = this.site.grid;
    for (const xy of (q.get("add") ?? "").split(",").filter(Boolean)) {
      const [x, y] = xy.split("_").map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !grid.inside(x, y)) continue;
      const node = grid.nodeAt(x, y);
      if (grid.isBlocked(node) || !Number.isFinite(this.field.time[node])) continue;
      ids.push(this.customPoi({ x, y }).id);
    }
    if (ids.length) this.selected = [...new Set(ids)]; // a link made for another site keeps the default stops
    const t = Number(q.get("t"));
    if (q.has("t") && Number.isFinite(t) && t >= 5 && t <= 19) this.startLmst = t;
    if (q.get("storm") === "0") this.storm = false;
    if (q.get("buddy") === "1") this.buddy = true;
    if (q.get("relay") === "1") this.useRelay = true;
  }

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

  /** Save the planned route as KML (Google Earth, Mars mode) or GeoJSON (GIS tools). */
  private exportRoute(kind: "kml" | "geojson"): void {
    if (!this.plan) return;
    const b = this.plan.budget;
    const plan: ExportPlan = {
      site: this.site.meta, legs: this.plan.legs, distanceM: b.distanceM, timeS: b.totalTimeS, o2UsedL: b.o2UsedL,
      startLmst: fmtLmst(this.startLmst),
      stops: this.stopTimes().map((s) => ({ ...s, lmst: fmtLmst(this.lmstAt(s.arriveS)) })),
      relay: this.useRelay && this.plan.relay ? { ...this.plan.relay.at, mastM: RELAY_MAST_M } : null,
    };
    const name = `cairn-${this.site.id}-eva`;
    if (kind === "kml") saveFile(`${name}.kml`, "application/vnd.google-earth.kml+xml", routeKml(plan));
    else saveFile(`${name}.geojson`, "application/geo+json", routeGeoJson(plan));
    this.toast(kind === "kml" ? "Saved the route as KML — open it in Google Earth, switched to Mars." : "Saved the route as GeoJSON (Mars 2000 longitude / latitude).");
  }

  /** One-page printable plan: map, timeline, oxygen turn-back values, storm protocol. */
  private openCueCard(): void {
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
      doseUGy: this.rad.baseline * b.exposureH,
      radio: {
        coverage: this.plan.radio,
        lostAt: (x, y, leg, i) => this.lostOnPlan(x, y, leg, i),
        relay: this.useRelay && this.plan.relay ? { at: this.plan.relay.at, alongM: this.plan.relay.alongM, mastM: RELAY_MAST_M, toward: this.relayLeg(this.plan.relay) } : null,
      },
    });
  }

  private resetForDemo(): void {
    if (this.phase !== "planning") this.backToPlanning();
    this.closeCard();
    this.useRelay = false;
    this.selected = this.site.pois.filter((p) => p.kind === "objective").map((p) => p.id);
    this.pois = this.pois.filter((p) => !p.id.startsWith("custom-"));
    this.startLmst = this.site.meta.eva?.startLmst ?? 10;
    this.selectLayer("none");
    void this.replan();
  }

  private selectLayer(id: LayerId): void {
    this.layer = id;
    this.view.setLayer(id, this.opacity);
    this.renderLeft();
  }

  /** Open the stitched 360° panorama for a stop; other stops appear as bearings on the compass. */
  openPano(id: string, autoRotate = false): (() => void) | null {
    const poi = this.poi(id);
    const info = this.site.panoramas?.panoramas[id];
    if (!poi || !info) return null;
    const wasPaused = this.paused;
    this.paused = true;
    const targets = this.pois
      .filter((p) => p.id !== id && (p.kind === "shelter" || this.selected.includes(p.id)))
      .map((p) => ({ name: p.short, bearing: (((Math.atan2(p.x - poi.x, p.y - poi.y) * 180) / Math.PI) + 360) % 360, distM: Math.hypot(p.x - poi.x, p.y - poi.y) }))
      .sort((a, b) => a.distM - b.distM);
    return openPanorama(this.site.base, poi, info, this.roverName, targets, { autoRotate, onClose: () => (this.paused = wasPaused) });
  }

  private closeCard(): void {
    $("#card").hidden = true;
    this.cardPoi = null;
  }

  // ================================================================ EVA
  private startEva(): void {
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
    this.log = [{ t: 0, kind: "go", text: "Left the rover" }];
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
    if (first.poi) this.voice.say(`EVA started. Heading to ${this.waypointName(first.poi)}. ${spokenDist(first.distM)}, about ${spokenTime(first.etaS)}.`);
  }

  private backToPlanning(): void {
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
      if (!this.paused) this.handleEvents(m.advance(dt * this.speed));
      const pose = m.pose();
      this.view.setAstronaut({ x: pose.x, y: pose.y, headingRad: pose.headingRad, moving: pose.moving && !this.paused }, dt);
      this.view.setBuddy(this.buddy ? m.buddyPose() : null);
      if (this.viewMode === "orbit" && pose.moving && !this.paused) this.view.follow(pose.x, pose.y, dt);
      this.watchRadio(m);
      if (this.viewMode === "walk" && !this.paused) this.guide(m);
    }
    const sun = this.sunAtEva(m && this.phase !== "planning" ? m.t : 0);
    const key = `${sun.elevation.toFixed(2)}/${sun.azimuth.toFixed(2)}`;
    if (key !== this.lastSun) {
      this.lastSun = key;
      this.view.setSun(sun.elevation, sun.azimuth);
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
        this.toast(`Arrived at ${ev.poi.short}. ${ev.poi.dwellMin} min of science.`);
        this.voice.say(`Arrived at ${ev.poi.short}. ${spokenTime(ev.poi.dwellMin * 60)} of science.`);
      } else if (ev.type === "depart") {
        this.note("go", `Left ${ev.poi.short}`);
        if (this.cardPoi === ev.poi.id) this.closeCard();
        const n = this.mission?.next();
        if (n?.poi) this.voice.say(`Heading to ${this.waypointName(n.poi)}. ${spokenDist(n.distM)}, about ${spokenTime(n.etaS)}.`);
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
      }</span></div>`;
    alert.hidden = false;
    this.voice.say(`Solar particle event. Dose rate ${Math.round(rate / this.rad.baseline)} times background. Abort the EVA. Return to the rover: ${spokenDist(path.distance)}, ${spokenTime(path.time)}.`, "urgent");
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
    this.voice.say(em ? `You are back in the rover, with ${Math.round(this.P.o2SupplyL - m.o2UsedL)} litres of oxygen left.` : "You are inside the rover. Radiation shelter reached.", "urgent");
    $("#stage").classList.remove("storm");
    this.speed = 300;
    this.renderBottom();
    if (this.viewMode === "walk") this.setView("orbit");
  }

  private onComplete(aborted: boolean): void {
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
    if (relay && this.useRelay) {
      return `<div class="radio-line">${ic.radio}<span>In radio contact for <b>${Math.floor(rc.coveredFraction * 100)}%</b> of the walk, with a relay stood up ${where}.</span><button class="link" data-act="relay-off">Remove</button></div>`;
    }
    const whole = rc.lostS < 20;
    const text = whole
      ? "In radio contact with the rover the whole way."
      : `In radio contact for <b>${Math.floor(rc.coveredFraction * 100)}%</b> of the walk · ${rc.gaps} blackout${rc.gaps > 1 ? "s" : ""}, longest ${fmtDur(Math.max(60, rc.longestGapS))}`;
    const tip = relay
      ? `<div class="relay-tip"><span>A ${RELAY_MAST_M} m relay mast stood up ${where} gives contact for <b>${Math.floor(relay.after.coveredFraction * 100)}%</b> of the walk.</span><button class="secondary" data-act="relay-on">${ic.radio}<span>Plan with relay</span></button></div>`
      : "";
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
    void this.replan();
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

  /** Tell the crew when the terrain cuts the line of sight to the rover, and when it comes back. */
  private watchRadio(m: Mission): void {
    const relay = this.useRelay ? this.plan?.relay : null;
    if (relay && !this.relayUp && m.t >= this.plan!.relayAtS && m.alertS === null && !m.emergency) {
      this.relayUp = true;
      this.note("radio", "Relay up");
      this.view.setRelay(relay.at, true);
      this.toast("Relay up: radio contact now reaches the ground behind the hills.", 3500);
      this.voice.say("Relay deployed.");
    }
    const p = m.pose();
    const lost = !m.sheltered && m.phase !== "complete" && !inContact(this.radio, this.site.grid, p.x, p.y, this.liveRelay());
    if (lost === this.radioLost) return;
    this.radioLost = lost;
    this.note("radio", lost ? "Radio contact lost" : "Radio contact back");
    if (lost) {
      this.buzz([120]);
      this.toast("Radio contact with the rover lost: the terrain blocks the line of sight.", 4000);
      this.voice.say("Radio contact with the rover lost. Terrain is blocking the line of sight.");
    } else {
      this.toast("Radio contact with the rover restored.", 2500);
      this.voice.say("Radio contact restored.");
    }
  }

  /** "Waypoint 2, Boxwork ridge" — or the rover. */
  private waypointName(poi: Poi): string {
    if (poi.kind === "shelter") return "the rover";
    const k = this.plan?.order.findIndex((p, i) => p.id === poi.id && i > 0) ?? -1;
    return k > 0 ? `waypoint ${k}, ${poi.short}` : poi.short;
  }

  /** Routine spoken directions in the visor: distance, turn, steep ground or sand ahead. */
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
    const name = n.poi.kind === "shelter" ? "Rover" : this.waypointName(n.poi).replace(/^w/, "W");
    this.voice.say(
      `${name}, ${spokenDist(n.distM)}, ${turnWords(turn)}.${steep >= 15 ? ` Slope ahead ${Math.round(steep)} degrees.` : ""}${sand ? " Loose sand ahead." : ""}`,
      "routine",
    );
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
    this.voice.say(
      `${kind === "leak" ? "Suit leak. Oxygen use doubled." : "Ankle injury. Walking at half speed."} Return to the rover: ${spokenDist(path.distance)}, ${spokenTime(em.homeTimeS)}. ${
        spare >= 0 ? `Enough oxygen, ${Math.round(spare)} litres to spare.` : "Not enough oxygen. Rover, drive out to meet the crew."
      }`,
      "urgent",
    );
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
    const pick = (arr: (number | null)[]) => {
      const i = Math.floor(hours / w.stepH);
      for (let d = 0; d < arr.length; d++) {
        const v = arr[(i + d) % arr.length] ?? arr[(i - d + arr.length) % arr.length];
        if (v !== null && v !== undefined) return v;
      }
      return null;
    };
    const hh = Math.floor(hours);
    const mm = Math.floor((hours - hh) * 60);
    return { lmst: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, air: pick(w.airTempK), ground: pick(w.groundTempK), pressure: pick(w.pressurePa) };
  }

  private stormUtc(m: Mission): string {
    if (m.stormOnsetS === null || m.t < m.stormOnsetS) return "";
    const onset = Date.parse(this.site.replay.event.assumedOnsetUtc);
    const d = new Date(onset + (m.t - m.stormOnsetS) * 1000);
    return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }

  private phaseLabel(m: Mission): { label: string; name: string } {
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
    setText($("#lv-label"), ph.label);
    setText($("#lv-next"), ph.name);
    setText($("#lv-dist"), n.distM > 0 ? `${fmtDist(n.distM)} · ${fmtDur(n.etaS)}` : m.sheltered ? "—" : `${fmtDur(n.etaS)} on site`);
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
    setText($("#lv-temp"), `${w.air !== null ? Math.round(w.air - 273.15) : "—"} °C / ${w.ground !== null ? Math.round(w.ground - 273.15) : "—"} °C`);
    setText($("#lv-pres"), w.pressure !== null ? `${Math.round(w.pressure)} Pa` : "—");
    const sunNow = this.sunAtEva(m.t);
    const pose = m.pose();
    const shaded = sunNow.elevation > 0 && inTerrainShadow(this.site.grid, pose.x, pose.y, sunNow.elevation, sunNow.azimuth);
    setText(document.getElementById("lv-sun"), `${this.sunText(sunNow)}${shaded ? " · in shade" : ""}`);
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
      </div>
      <div class="hud-side right">
        <div class="hud-item" id="hud-ratebox"><span>Dose rate</span><b><i id="hud-rate">—</i> µGy/h</b></div>
        <div class="hud-item minor"><span>Dose</span><b id="hud-dose">—</b></div>
        <div class="hud-item minor"><span>Air · ground</span><b id="hud-temp">—</b></div>
        <div class="hud-item minor"><span>Pressure</span><b id="hud-pres">—</b></div>
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
    setText($("#hud-head"), `${String(Math.round(head) % 360).padStart(3, "0")}°`);

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
    setText($("#hud-rate"), fmtRate(m.doseRate));
    $("#hud-ratebox").className = `hud-item${m.outdoorRate > this.rad.baseline * 3 ? " bad" : ""}`;
    setText($("#hud-dose"), fmtDose(m.doseUGy));
    setText($("#hud-temp"), `${w.air !== null ? Math.round(w.air - 273.15) : "—"} · ${w.ground !== null ? Math.round(w.ground - 273.15) : "—"} °C`);
    setText($("#hud-pres"), w.pressure !== null ? `${Math.round(w.pressure)} Pa` : "—");
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
