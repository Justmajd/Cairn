import type { LayerId } from "./scene/terrain";
import { measurePath } from "./data/grid";
import type { SiteData, SiteEntry } from "./data/loaders";
import { buildBudget, EvaBudget, o2Litres, ReturnLookup, Segment, walkO2 } from "./eva/budget";
import { DEFAULT_PARAMS, EvaParams } from "./eva/params";
import { RadiationModel } from "./eva/radiation";
import { fmtLmst, MARS_HOUR_S, SolarGeometry, solarGeometry, sunAt, SunPosition } from "./eva/sun";
import { Mission, MissionEvent } from "./replay/mission";
import type { FieldResult, Router } from "./routing/client";
import type { SceneView } from "./scene/view";
import type { MeasuredPath, PathSample, Poi, XY } from "./types";
import { showBriefing } from "./ui/briefing";
import { DoseChartHandle, ProfileHandle, renderDoseChart, renderProfile } from "./ui/charts";
import { $, esc, fmtClock, fmtDist, fmtDose, fmtDur, fmtRate, setText } from "./ui/dom";
import { ic } from "./ui/icons";
import { showAssumptions, showSources, stopCardHtml } from "./ui/modals";
import { openPanorama } from "./ui/panorama";
import { DemoRunner, DemoStep } from "./ui/demo";
import { CueRow, showCueCard } from "./ui/cuecard";

interface Plan {
  order: Poi[]; // rover, stops…, rover
  legs: MeasuredPath[];
  straight: MeasuredPath[];
  budget: EvaBudget;
  routeMs: number;
}

interface Layer {
  id: LayerId;
  name: string;
  source: string; // provenance id
  swatch: string; // CSS background for the layer button
  legend: [string, string] | null; // low / high labels under the colour ramp
}

const LAYERS: Layer[] = [
  { id: "none", name: "Image", source: "hirise_ortho", swatch: "linear-gradient(135deg,#5a3422,#b57650 55%,#f0c9a2)", legend: null },
  { id: "risk", name: "Traversability", source: "hirise_dtm", swatch: "linear-gradient(90deg,#1ec86e,#f0dc28,#fa8214,#e63228,#7a0029)", legend: ["easy", "impassable"] },
  { id: "slope", name: "Slope", source: "hirise_dtm", swatch: "linear-gradient(90deg,#78dc50,#ffdc00,#ff8c00,#eb2828)", legend: ["5°", "25°+"] },
  { id: "sand", name: "Loose sand", source: "sand", swatch: "linear-gradient(90deg,rgba(255,194,77,.15),#ffc24d)", legend: ["firm", "loose"] },
  { id: "thermal", name: "Night thermal", source: "themis", swatch: "linear-gradient(90deg,#140a5a,#731491,#d13d5c,#fa9926,#faf099)", legend: ["cold · sand", "warm · rock"] },
  { id: "minerals", name: "Minerals · CRISM", source: "crism", swatch: "linear-gradient(135deg,#b8e04a 0 33%,#4da3ff 33% 66%,#ff5ad1 66%)", legend: null },
  { id: "geology", name: "Geology", source: "geology", swatch: "linear-gradient(90deg,#e69f00 0 25%,#56b4e9 25% 50%,#009e73 50% 75%,#f0e442 75%)", legend: null },
  { id: "shield", name: "Sky shielding", source: "hirise_dtm", swatch: "linear-gradient(90deg,rgba(64,140,255,.2),#4d9bff,#d9f5ff)", legend: ["open sky", "−15 % dose"] },
  { id: "shelter", name: "To shelter", source: "hirise_dtm", swatch: "linear-gradient(90deg,#33f280,#bff240,#ffcc26,#ff731a,#d91f40)", legend: ["0 min", "24+ min"] },
];

const SPEEDS = [60, 120, 300];

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

  private readonly lookup: ReturnLookup;

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

    setText($("#site-name"), site.meta.name);
    this.bindChrome();
    view.onPoiClick = (id) => this.openCard(id, false);
    view.onGroundClick = (p, cx, cy) => this.groundClick(p, cx, cy);
    view.onHover = (p, cx, cy) => this.hover(p, cx, cy);
    new ResizeObserver(() => this.renderProfileChart()).observe($("#bottom"));
    new ResizeObserver(() => this.updateInsets()).observe($("#app"));

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
      ["fly", ic.flight, "Flyover", "Fly along the planned route"],
      ["walk", ic.visor, "Visor", "First-person helmet display"],
    ].map(([v, i, label, title]) => `<button data-view="${v}" title="${title}">${i}<span>${label}</span></button>`).join("");
    $(".top-actions").innerHTML = `
      <button id="btn-panels" class="compact-only" title="Route and map layers">${ic.layers}<span>Route & layers</span></button>
      <button id="btn-demo" class="demo-btn" title="Play the guided demo">${ic.play}<span>Demo</span></button>
      <button id="btn-briefing" title="Mission briefing">${ic.book}<span>Briefing</span></button>
      <button id="btn-sources" title="Where every layer comes from">${ic.data}<span>Data sources</span></button>
      <button id="btn-model" title="Spacesuit and model assumptions">${ic.sliders}<span>Assumptions</span></button>`;
    $("#nav").innerHTML = `
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
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button[data-nav]");
      if (btn) this.view.nudge(btn.dataset.nav as "in" | "out" | "left" | "right" | "up" | "down" | "north");
    });
    $("#btn-briefing").addEventListener("click", () => showBriefing(this.site, () => {}, this.sites));
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
    document.addEventListener("click", () => (menu.hidden = true));
    $("#btn-sources").addEventListener("click", () => showSources(this.site));
    $("#btn-model").addEventListener("click", () => showAssumptions(this.site, this.P));

    const left = $("#left");
    left.addEventListener("change", (ev) => this.leftChange(ev.target as HTMLInputElement));
    left.addEventListener("input", (ev) => this.leftInput(ev.target as HTMLInputElement));
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
    });
    right.addEventListener("input", (ev) => {
      const t = ev.target as HTMLInputElement;
      if (t.id !== "start" || !this.plan) return;
      this.startLmst = Number(t.value);
      const b = this.plan.budget;
      setText($("#start-val"), `${fmtLmst(this.startLmst)} LMST`);
      setText($("#sun-val"), `Sun ${this.sunText(this.sunAtEva(0))} → ${this.sunText(this.sunAtEva(b.totalTimeS))} at ${fmtLmst(this.lmstAt(b.totalTimeS))}`);
    });
    right.addEventListener("change", (ev) => {
      if ((ev.target as HTMLElement).id === "start") this.renderRight(); // refresh warnings and dose
    });
    right.addEventListener("click", (ev) => {
      const t = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]");
      if (!t) return;
      const act = t.dataset.act;
      if (act === "start") this.startEva();
      else if (act === "cue") this.openCueCard();
      else if (act === "resume") this.resumeRemaining();
      else if (act === "replan") this.backToPlanning();
      else if (act === "sources") showSources(this.site, t.dataset.id);
      else if (act === "model") showAssumptions(this.site, this.P);
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
      } else if (act === "skip") this.skipAhead();
      else if (act === "end") this.backToPlanning();
    });
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
    for (const b of $("#views").querySelectorAll<HTMLButtonElement>("button")) b.classList.toggle("on", b.dataset.view === active);
    const walk = this.viewMode === "walk";
    $("#app").dataset.view = active;
    $("#app").dataset.phase = this.phase;
    requestAnimationFrame(() => this.updateInsets());
    $("#mapwidgets").hidden = walk;
    $("#nav").hidden = walk || active === "fly";
    $("#nav").classList.toggle("flat", this.viewMode === "plan");
    const hint = $("#nav-hint");
    hint.hidden = walk || active === "fly";
    hint.innerHTML =
      this.viewMode === "plan"
        ? "<b>Drag</b> pan <i></i> <b>Scroll</b> zoom <i></i> <b>Click</b> add a stop <i></i> <b>3D</b> to rotate"
        : "<b>Drag</b> rotate <i></i> <b>Shift-drag</b> pan <i></i> <b>Scroll</b> zoom <i></i> <b>Double-click</b> centre";
  }

  /** Local mean solar time at EVA time `tS`. */
  private lmstAt(tS: number): number {
    return this.startLmst + tS / MARS_HOUR_S;
  }

  private sunAtEva(tS: number): SunPosition {
    return sunAt(this.lat, this.lmstAt(tS), this.solar);
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
    this.plan = { order, legs, straight, budget: buildBudget(segments, this.P, this.lookup, (poi) => grid.shieldAt(poi.x, poi.y)), routeMs: result.ms };
    this.planError = null;
    this.afterPlan();
  }

  private afterPlan(): void {
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
      : `<p class="t">${ic.walk}${fmtDur(this.field.time[node])} from the rover</p><p>Slope ${grid.slope[node]}° · ${esc(this.unitAt(p.x, p.y) ?? "unmapped unit")}</p><div class="row"><button data-x="close">Cancel</button><button class="primary" data-x="add">${ic.plus}<span>Add stop</span></button></div>`;
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
    const n = ++this.customCount;
    const unit = this.unitAt(p.x, p.y);
    const poi: Poi = {
      id: `custom-${n}`, kind: "optional", name: `Custom stop ${n}`, short: `Stop ${n}`, x: Math.round(p.x), y: Math.round(p.y),
      rmc: "", sols: "", dwellMin: 10, images: [],
      description: `A stop you placed on the map${unit ? `, on the ${unit}` : ""}. CAIRN routes to any walkable point in the EVA area.`,
      science: "", whyHumans: "",
    };
    this.pois.push(poi);
    this.selected.push(poi.id);
    void this.replan();
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

    const layers = this.layers().map(
      (l) => `<label class="layer${l.id === this.layer ? " on" : ""}">
          <input class="sr" type="radio" name="layer" value="${l.id}" ${l.id === this.layer ? "checked" : ""}/>
          <i class="swatch" style="background:${l.swatch}"></i><span>${esc(l.name)}</span>
        </label>`,
    ).join("");
    const active = this.layers().find((l) => l.id === this.layer) ?? LAYERS[0];
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
        <div class="layer-grid">${layers}</div>
        ${legend}
        <label class="slider${this.layer === "none" ? " off" : ""}"><span>Opacity</span><input type="range" id="opacity" min="0.2" max="1" step="0.05" value="${this.opacity}"/></label>
      </section>
      <section>
        <header class="sec-head"><h2>Display</h2></header>
        <label class="switch"><span>${esc(this.roverName)}'s real track</span><input class="sr" type="checkbox" id="track" ${this.showTrack ? "checked" : ""}/><i></i></label>
        <label class="switch"><span>Straight-line comparison</span><input class="sr" type="checkbox" id="straight" ${this.showStraight ? "checked" : ""}/><i></i></label>
        <label class="switch"><span>Sun shadows</span><input class="sr" type="checkbox" id="shadows" ${this.showShadows ? "checked" : ""}/><i></i></label>
        <label class="slider"><span>Vertical exaggeration <b id="exag-val">×${this.exag.toFixed(2)}</b></span><input type="range" id="exag" min="1" max="2.5" step="0.25" value="${this.exag}"/></label>
      </section>`;
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
    } else if (t.id === "track") {
      this.showTrack = t.checked;
      this.view.setTrackVisible(this.showTrack);
    } else if (t.id === "shadows") {
      this.showShadows = t.checked;
      this.view.setShadows(this.showShadows);
    } else if (t.id === "straight") {
      this.showStraight = t.checked;
      this.pushRoutes();
      this.renderProfileChart();
    }
  }

  private leftInput(t: HTMLInputElement): void {
    if (t.id === "opacity") {
      this.opacity = Number(t.value);
      this.view.setLayerOpacity(this.opacity);
    } else if (t.id === "exag") {
      this.exag = Number(t.value);
      this.view.setExaggeration(this.exag);
      setText($("#exag-val"), `×${this.exag.toFixed(2)}`);
      const tag = $("#exag-tag");
      tag.hidden = this.exag === 1;
      tag.textContent = `Heights ×${this.exag.toFixed(2)} for display`;
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

    host.innerHTML = `
      <div class="scroll">
        <section>
          <header class="sec-head"><h2>EVA plan</h2>${
            b.feasible ? `<span class="status ok">${ic.check}Within suit limits</span>` : `<span class="status bad">${ic.warn}Not safe</span>`
          }</header>
          ${issues.length ? `<p class="callout bad">${ic.warn}<span>This plan is ${issues.join(" and ")}. Remove a stop.</span></p>` : ""}
          ${lowSun ? `<p class="callout warn">${ic.warn}<span>The Sun is under 8° at the ${sunStart.elevation < 8 ? "start" : "end"} of this EVA. Long shadows hide rocks and holes, and it gets cold fast — leave later or plan a shorter walk.</span></p>` : ""}
          <div class="hero">
            <div><span>Distance</span>${heroDist(b.distanceM)}</div>
            <div><span>Time outside</span>${heroDur(b.totalTimeS)}</div>
          </div>
          <label class="slider start"><span>Leave the rover at <b id="start-val">${fmtLmst(this.startLmst)} LMST</b></span>
            <input type="range" id="start" min="6" max="17" step="0.25" value="${this.startLmst}"/>
            <small id="sun-val">Sun ${this.sunText(sunStart)} → ${this.sunText(sunEnd)} at ${fmtLmst(this.lmstAt(b.totalTimeS))}</small></label>
          <dl class="kv">
            <dt>Walking</dt><dd>${fmtDur(b.walkTimeS)}</dd>
            <dt>Science at stops</dt><dd>${fmtDur(b.stopTimeS)}</dd>
            <dt>Total climb</dt><dd>${Math.round(b.climbM)} m</dd>
            <dt>Steepest ground</dt><dd>${b.maxSlopeDeg}°</dd>
            <dt>On loose sand</dt><dd>${fmtDist(b.sandM)}</dd>
          </dl>
        </section>
        <section>
          <header class="sec-head"><h2>Oxygen</h2><span class="num">${Math.round(b.o2UsedL)} L <small>of ${P.o2SupplyL} L</small></span></header>
          <div class="meter"><i style="width:${Math.min(100, usedPct).toFixed(1)}%"></i><u style="left:${(100 - reservePct).toFixed(1)}%"></u></div>
          <div class="meter-legend"><span>Used by this plan</span><span>${reservePct}% reserve</span></div>
          <dl class="kv">
            <dt>Walk-back margin</dt><dd class="${margin >= 0 ? "good" : "bad"}">${margin >= 0 ? "+" : ""}${Math.round(margin)} L</dd>
            <dt>Longest way home</dt><dd>${fmtDur(b.walkBack.maxReturnMin * 60)}</dd>
            <dt>Background dose</dt><dd>${fmtDose(dose)}</dd>
          </dl>
          <p class="note">Margin: oxygen left at the tightest point of the plan after walking home and keeping the reserve. Dose: Curiosity RAD background, ${this.rad.baseline} µGy/h. <a data-act="model">Model assumptions</a></p>
        </section>
        <section>
          <header class="sec-head"><h2>Straight line vs CAIRN</h2><span class="sub">${Math.round(this.plan.routeMs)} ms</span></header>
          <table class="compare">
            <thead><tr><th></th><th>Straight</th><th>CAIRN</th></tr></thead>
            <tbody>
              ${row("Distance", fmtDist(sum((m) => m.distance, st)), fmtDist(sum((m) => m.distance, sf)))}
              ${row("Impassable", fmtDist(stBlocked), "0 m", stBlocked > 0)}
              ${row("Steepest", `${stSteep}°`, `${Math.max(...sf.map((m) => m.maxSlopeDeg))}°`, stSteep > limit)}
              ${row("Loose sand", fmtDist(sum((m) => m.sandM, st)), fmtDist(sum((m) => m.sandM, sf)))}
              ${row("Effort × risk", `${(sum((m) => m.cost, st) / sum((m) => m.cost, sf)).toFixed(2)}×`, "1.00×", stBlocked > 0)}
            </tbody>
          </table>
          ${
            stBlocked > 0
              ? `<p class="callout warn">${ic.warn}<span>The straight line crosses ${fmtDist(stBlocked)} steeper than ${limit}°, marked red on the map. CAIRN goes around it.</span></p>`
              : `<p class="note">No impassable ground on the straight line here, but CAIRN's route costs less effort and risk.</p>`
          }
        </section>
      </div>
      <footer class="panel-foot">
        <label class="switch"><span>Replay the 20 May 2024 solar storm</span><input class="sr" type="checkbox" id="opt-storm" ${this.storm ? "checked" : ""}/><i></i></label>
        <label class="switch"><span>Buddy mode · two astronauts</span><input class="sr" type="checkbox" id="opt-buddy" ${this.buddy ? "checked" : ""}/><i></i></label>
        <div class="foot-row">
          <button class="big secondary" data-act="cue" title="One-page printable plan">${ic.book}<span>Cue card</span></button>
          <button class="primary big" data-act="start" ${b.feasible ? "" : "disabled"}>${ic.play}<span>Start EVA</span></button>
        </div>
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
    const aborted = m.alertS !== null;
    const pr = m.projection;
    const remaining = m.remaining();
    const visited = m.visited.map((id) => this.poi(id)?.short ?? id);
    host.innerHTML = `
      <div class="scroll">
        <section class="summary">
          <header class="sec-head"><h2>${aborted ? "EVA aborted" : "EVA complete"}</h2>${
            aborted ? `<span class="status warn">${ic.home}Crew in the rover</span>` : `<span class="status ok">${ic.check}Back at the rover</span>`
          }</header>
          <div class="hero">
            <div><span>Walked</span>${heroDist(m.distanceM)}</div>
            <div><span>${aborted ? "To all-clear" : "Time outside"}</span>${heroDur(m.t)}</div>
          </div>
          <dl class="kv">
            <dt>Stops completed</dt><dd>${visited.length ? esc(visited.join(", ")) : "none"}</dd>
            <dt>Oxygen used</dt><dd>${Math.round(m.o2UsedL)} L of ${this.P.o2SupplyL} L</dd>
            <dt>Dose received</dt><dd>${fmtDose(m.doseUGy)}</dd>
          </dl>
          ${
            pr
              ? `<div class="avoided"><span>Dose avoided by sheltering</span><b>${fmtDose(pr.avoidedUGy)}</b>
                  <small>${fmtDose(pr.shelterUGy)} received vs ${fmtDose(pr.continueUGy)} had the crew finished the walk, compared at the planned end of the EVA. Rover shielding ×${this.P.shelterFactor} is an assumption.</small></div>
                 <p class="note">Alert to shelter: ${fmtDur(pr.arriveS - pr.alertS)} over ${fmtDist(pr.shelterDistM)}. RAD measured elevated dose rates for about two sols after this storm, so the remaining objectives move to a later sol.</p>`
              : `<p class="note">All objectives reached; the crew is back at the rover with ${Math.round(this.P.o2SupplyL - m.o2UsedL)} L of oxygen.</p>`
          }
        </section>
      </div>
      <footer class="panel-foot">
        ${remaining.length ? `<button class="primary big" data-act="resume">${ic.later}<span>Plan the remaining stop${remaining.length > 1 ? "s" : ""} for a later sol</span></button>` : ""}
        <button class="big" data-act="replan">Back to planning</button>
      </footer>`;
  }

  // ================================================================ bottom bar
  private renderBottom(): void {
    const eva = this.phase === "eva";
    const straight = this.showStraight && this.phase === "planning";
    $("#bottom").innerHTML = `
      <header class="bar">
        ${
          eva
            ? `<div class="transport">
                 <button class="icon solid" data-act="pause" title="${this.paused ? "Resume" : "Pause"}">${this.paused ? ic.play : ic.pause}</button>
                 <div class="seg small">${SPEEDS.map((v) => `<button data-act="speed" data-v="${v}" class="${v === this.speed ? "on" : ""}">${v}×</button>`).join("")}</div>
                 <button class="ghost" data-act="skip" title="Jump to the end of the current step">${ic.skip}<span>Skip</span></button>
                 <button class="ghost" data-act="end">${ic.stop}<span>End EVA</span></button>
               </div>`
            : `<h2>Elevation along the route</h2>`
        }
        <div class="key">
          <span><i style="background:#3ddc84"></i>&lt; 10°</span><span><i style="background:#f5d02e"></i>10–18°</span>
          <span><i style="background:#ff8a1f"></i>18–25°</span><span><i style="background:#ff4d4d"></i>too steep</span>
          <span><i class="sand"></i>sand</span>${straight ? `<span><i class="dash"></i>straight line</span>` : ""}
        </div>
      </header>
      <div id="profile"></div>`;
    this.renderProfileChart();
  }

  private renderProfileChart(): void {
    const host = document.getElementById("profile");
    if (!host) return;
    if (!this.plan) {
      host.innerHTML = `<p class="hint pad">No route to show.</p>`;
      this.profile = null;
      return;
    }
    this.profile = renderProfile(host, this.plan.legs, this.plan.order, this.showStraight && this.phase === "planning" ? this.plan.straight : null);
  }

  // ================================================================ stop card
  private openCard(id: string, arrived: boolean): void {
    const poi = this.poi(id);
    if (!poi) return;
    const card = $("#card");
    card.innerHTML = stopCardHtml(poi, this.site.base, this.unitAt(poi.x, poi.y), arrived, this.roverName, !!this.site.panoramas?.panoramas[poi.id]);
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
          await d.sleep(7500);
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
        `${lastAvoided > 0 ? `Sheltering avoided <b>${fmtDose(lastAvoided)}</b> of radiation. ` : ""}Every layer here comes from NASA, USGS and JPL archives — open <b>Data sources</b> to check any of them.`,
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
    });
  }

  private resetForDemo(): void {
    if (this.phase !== "planning") this.backToPlanning();
    this.closeCard();
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
    this.shelterPath = null;
    this.shelteredAtS = null;
    $("#pin-menu").hidden = true;
    this.closeCard();
    this.pushRoutes();
    this.renderLeft();
    this.renderRight();
    this.renderBottom();
    this.setView("walk");
    this.toast("EVA started. Visor view — drag to look around, or switch to Map / 3D.", 5000);
  }

  private backToPlanning(): void {
    this.mission = null;
    this.phase = "planning";
    this.shelterPath = null;
    this.shelteredAtS = null;
    this.clearAlert();
    this.closeCard();
    this.view.setAstronaut(null);
    this.view.setBuddy(null);
    if (this.viewMode === "walk") this.setView("plan");
    this.profile?.setCursor(null);
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
        this.openCard(ev.poi.id, true);
        this.toast(`Arrived at ${ev.poi.short}. ${ev.poi.dwellMin} min of science.`);
      } else if (ev.type === "depart") {
        if (this.cardPoi === ev.poi.id) this.closeCard();
      } else if (ev.type === "alert") void this.onAlert(ev.rateUGyH);
      else if (ev.type === "sheltered") this.onSheltered();
      else if (ev.type === "complete") this.onComplete(ev.aborted);
    }
  }

  private async onAlert(rate: number): Promise<void> {
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
    alert.innerHTML = `<div class="ico">${ic.home}</div><div><b>Crew in shelter</b><span>Inside the rover ${fmtDur(m.t - (m.alertS ?? m.t))} after the alert. Dose rate cut to ${this.P.shelterFactor}× outdoors.</span></div>`;
    $("#stage").classList.remove("storm");
    this.speed = 300;
    this.renderBottom();
    if (this.viewMode === "walk") this.setView("orbit");
  }

  private onComplete(aborted: boolean): void {
    this.phase = "summary";
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
    setText(document.getElementById("lv-sun"), this.sunText(this.sunAtEva(m.t)));
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
        <div class="hud-item"><span>Walk-back</span><b id="hud-margin">—</b></div>
        <div class="hud-item"><span>Way home</span><b id="hud-home">—</b></div>
        <div class="hud-item"><span>EVA clock</span><b id="hud-clock">00:00:00</b></div>
      </div>
      <div class="hud-side right">
        <div class="hud-item" id="hud-ratebox"><span>Dose rate</span><b><i id="hud-rate">—</i> µGy/h</b></div>
        <div class="hud-item"><span>Dose</span><b id="hud-dose">—</b></div>
        <div class="hud-item"><span>Air · ground</span><b id="hud-temp">—</b></div>
        <div class="hud-item"><span>Pressure</span><b id="hud-pres">—</b></div>
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
      </dl>`;
    probe.hidden = false;
    probe.style.left = `${Math.min(rect.width - 250, clientX - rect.left + 16)}px`;
    probe.style.top = `${Math.min(rect.height - 150, clientY - rect.top + 16)}px`;
  }
}
