import * as THREE from "three";
import "../styles/roam.css";
import type { SiteData } from "../data/loaders";
import type { RoamLook, SceneView } from "../scene/view";
import type { Poi } from "../types";
import { DEFAULT_PARAMS } from "../eva/params";
import { cadence, breathsPerMin, toppleTime, EARTH_G, Ground, heartRate, jumpOf, MARS_WALKER, newWalker, stepWalker, walkRunMs, WALKER_NOTES, WalkEvent, WalkerState } from "../eva/walker";
import { fmtLmst, lmstAt as lmstAtUtc, MARS_HOUR_S, solarGeometry, SolarGeometry, sunAt } from "../eva/sun";
import { fmtLightTime, marsSky, utcAtLmst } from "../eva/sky";
import { inContact, radioDepthAt, radioShadow, RADIO_LOST_M, RELAY_MAST_M, SUIT_ANTENNA_M } from "../eva/radio";
import { Astronaut, BlobShadow, Dust, Footprints, Trail } from "./avatar";
import { makeRelayMast, makeSurveyFlag, ROVER_HALF } from "../scene/models";
import { FieldWork, type Find } from "./field";
import { SuitAudio } from "./audio";
import { $, esc, fmtClock, fmtDist, fmtDose, fmtDur } from "../ui/dom";
import { ic } from "../ui/icons";
import { dissolveTo } from "../ui/dissolve";
import { openModal } from "../ui/modals";
import { measurePath } from "../data/grid";
import { parsePlanLink } from "../state/planLink";
import { loadRoamPlan, RoamPlan } from "./plan";
import { RoamHab } from "./hab";
import { Ev1Watch } from "../ui/ev1Left";
import { sessionParam } from "../hab/session";
import type { CrewPose, EarthMessage, Frame, Member, PlanInfo } from "../hab/protocol";
import { autonomyHtml, type Decision } from "../ui/autonomy";
import { RadiationModel } from "../eva/radiation";
import { RoamStorm } from "./storm";
import { distanceToLegs, gapToBox, scoreWalk, workO2 } from "./score";
import { ACTIONS, actionOf, DEFAULT_KEYS, keyName, loadSettings, normKey, rebind, saveSettings, type Action, type RoamSettings } from "./settings";
import { CLEAR_TAU, DUST_PRESETS, dustEffect, fmtVisibility } from "../eva/dust";
import type { XY } from "../types";

/** Close enough to a stop to work there, and to the rover's hull to climb in (m). */
/** Free roam's radio link to Earth, shortened so Mission Control's messages arrive during a walk (a demo
 *  setting, labelled as such in the HUD and in Mission Control; the true light time is 3–22 min). */
const ROAM_LINK_DELAY_S = 10;
/** The link delay for a true light time: `?delay=real` keeps it, `?delay=<s>` sets it, otherwise 10 s. */
function linkDelay(realS: number): number {
  const q = new URLSearchParams(location.search).get("delay");
  if (q === "real") return realS;
  const n = Number(q);
  return q && Number.isFinite(n) && n >= 0 ? n : ROAM_LINK_DELAY_S;
}
const AT_STOP_M = 6;
const AT_ROVER_M = 1.6;
/** Holding E (or the Sample button) this long completes the action (s). */
const HOLD_S = 2.2;
/** Further than this from the planned route counts as off route (m). */
const OFF_ROUTE_M = 15;
/** Work time of a field reading and of standing up or packing the relay mast (s, at the working rate). */
const READING_S = 60;
const MAST_S = 120;

interface MissionStop {
  id: string;
  name: string;
  short: string;
  x: number;
  y: number;
  dwellMin: number;
}

const LOOKS: [RoamLook, string, string, string][] = [
  ["plan", "map", "Map", "Top-down map that follows you"],
  ["orbit", "box", "3D", "Third person: the camera behind the astronaut"],
  ["walk", "visor", "Visor", "First person, through the helmet"],
];
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/**
 * Free roam: walk anywhere in the 2 × 2 km HiRISE area as a suited astronaut, with the walking
 * physics of eva/walker.ts, seen on the map, from behind in 3D, or through the visor.
 */
export class Roam {
  private readonly walker: WalkerState;
  private readonly ground: Ground;
  private readonly avatar: Astronaut;
  private readonly shadow = new BlobShadow();
  private readonly prints: Footprints;
  // ---- frame timing: offer the lighter version when the device struggles
  private frameSum = 0;
  private frameN = 0;
  private slowTold = false;
  private readonly dust: Dust;
  private readonly trail = new Trail();
  private readonly audio = new SuitAudio();
  private readonly rover: Poi;
  private readonly radio: Uint8Array;
  private readonly host: HTMLElement;

  private look: RoamLook = "walk";
  /** camera direction, radians clockwise from north, and tilt (negative looks down) */
  private yaw: number;
  private pitch = -0.08;
  private chaseDist = 6;
  private mapHeight = 260;
  /** actions held down (see settings.ts: keys map to actions) */
  private readonly keys = new Set<string>();
  private settings: RoamSettings = loadSettings();
  private binding: Action | null = null;
  private jumpQueued = false;
  private touch = { x: 0, y: 0, lope: false };
  private touchHold = false;
  private drag: { x: number; y: number; id: number } | null = null;
  private stick: { id: number; x0: number; y0: number } | null = null;

  private t = 0;
  private readonly startLmst: number;
  private readonly solUtc: number;
  private readonly solar: SolarGeometry;
  private readonly lat: number;
  private readonly lon: number;
  private lastSky = -1;
  private readonly sunDir = new THREE.Vector3(0, 1, 0);
  private hudT = 0;
  private landKick = 0;
  private camDip = 0;
  private readonly smoothEye = new THREE.Vector3();
  private readonly smoothCam = new THREE.Vector3();
  private readonly smoothFocus = new THREE.Vector3();
  private camInit = false;
  private visited = new Set<string>();
  private told = new Set<string>();
  private toastTimer = 0;
  private lastEdge = -10;
  private contact = true;

  // ---- the mission: a planned EVA walked on foot
  private plan: RoamPlan | null = null;
  private stops: MissionStop[] = [];
  private legs: XY[][] = [];
  private next = 0; // index of the next stop; stops.length = back to the rover
  private holdT = 0;
  private finished = false;
  private offM = 0;
  private offRouteS = 0;
  private walkS = 0;
  private falls = 0;
  private hardLandings = 0;
  private samples: { name: string; atS: number; file?: string; image?: string }[] = [];
  private routeT = 0;
  // ---- the hab link: Mission Control watches the walk and answers after the link delay
  private readonly hab: RoamHab;
  /** The radio link to Earth as free roam runs it: shortened to `ROAM_LINK_DELAY_S` so Earth's messages
   *  arrive during a walk in real time (`?delay=real` uses the true light time).  The real light time is
   *  kept in `realLightTimeS` (Earth in the sky, the debrief). */
  private lightTimeS = linkDelay(0);
  private realLightTimeS = 0;
  private decisions: Decision[] = [];
  // ---- a solar particle event during the mission (the 20 May 2024 replay)
  private stormOn = true;
  private storm: RoamStorm | null = null;
  private stormAlarm = false;
  private stormEarthT: number | null = null;
  private lastT = 0;
  // ---- dust in the air: optical depth τ, measured (the site's own record or the planner's presets)
  private readonly tau: number;
  private readonly dustName: string;
  private readonly wind = new THREE.Vector3();
  // ---- suit emergencies (practice): a leak doubles oxygen use, a twisted ankle halves the pace
  private emergency: { kind: "leak" | "ankle"; atS: number; o2LeftL: number } | null = null;
  private scheduled: { kind: "leak" | "ankle"; atS: number } | null = null;
  // ---- two astronauts on two devices
  private readonly member: Member;
  private readonly buddy: Astronaut;
  private buddyState: WalkerState | null = null;
  private buddyTarget: CrewPose | null = null;
  private buddySeen = 0;
  private apart = false;
  private heardTold = false;
  // ---- field work between the stops (field.ts): readings, finds, the relay mast
  private readonly field: FieldWork;
  private fieldT = 0;
  /** the field panel: folded to a chip on phones; on larger screens the next few tasks, or all of them */
  private fieldOpen = !matchMedia("(pointer: coarse)").matches;
  private fieldAll = false;
  private mast: { x: number; y: number; shadow: Uint8Array; obj: THREE.Object3D } | null = null;
  constructor(private readonly site: SiteData, private readonly view: SceneView, private readonly quality: "high" | "low" = "high") {
    const grid = site.grid;
    this.ground = {
      height: (x, y) => grid.heightAt(x, y),
      sand: (x, y) => grid.sand[grid.nodeAt(x, y)] / 255,
      effort: (x, y) => grid.effortAt(grid.nodeAt(x, y)),
      min: 4,
      max: grid.size - 4,
    };
    const shelter = site.pois.find((p) => p.kind === "shelter");
    if (!shelter) throw new Error("Site has no rover");
    // a plan in the address: the planner handed it over ("Walk it yourself"), or it is routed here
    const link = parsePlanLink(location.hash);
    this.stormOn = link?.storm ?? false;
    // dust: ?dust=<preset> (clear, regional, global, extreme), ?tau=<number> (the planner's choice), or
    // the site's measured value for the EVA sol
    const q = new URLSearchParams(location.search);
    const preset = DUST_PRESETS.find((d) => d.id === q.get("dust"));
    const tauQ = Number(q.get("tau"));
    const own = site.dust?.eva;
    this.tau = preset?.tau ?? (Number.isFinite(tauQ) && tauQ > 0 && tauQ <= 12 ? tauQ : own?.tau ?? CLEAR_TAU);
    this.dustName = preset ? `${preset.name} · ${preset.where}` : Number.isFinite(tauQ) && tauQ > 0 ? `τ ${tauQ} (from the planner)` : own ? `EVA sol, measured by ${site.dust!.rover}` : "Typical season";
    const em = /^(leak|ankle)(?:@(\d+))?$/.exec(new URLSearchParams(location.search).get("emergency") ?? "");
    if (em) this.scheduled = { kind: em[1] as "leak" | "ankle", atS: Number(em[2] ?? 600) };
    this.plan = link ? loadRoamPlan(site.id, location.hash) : null;
    const parked = this.plan?.rover ?? link?.rover ?? null;
    const rover = parked ? { ...shelter, x: parked.x, y: parked.y } : shelter;
    this.rover = rover;
    this.radio = radioShadow(grid, { x: rover.x, y: rover.y });
    // start at the rover: just off its rear porch, where the suitports are, facing away from it (west);
    // the 3D camera starts beside the rover, looking over the astronaut's shoulder
    this.member = new URLSearchParams(location.search).get("crew") === "ev2" ? "ev2" : "ev1";
    const sx = rover.x - ROVER_HALF.x - 1.1;
    const sy = rover.y + (this.member === "ev2" ? 1.8 : 0); // EV2 climbs out of the other suitport
    this.walker = newWalker(sx, sy, grid.heightAt(sx, sy), -Math.PI / 2);
    this.yaw = -0.15; // camera off the rover's side, looking north past the astronaut
    this.pitch = -0.3;
    this.chaseDist = 7;

    this.startLmst = this.plan?.startLmst ?? link?.startLmst ?? site.meta.eva?.startLmst ?? 10;
    this.solUtc = Date.parse(site.meta.eva?.utc ?? "2024-07-21T02:10:26Z");
    this.solar = solarGeometry(this.solUtc);
    this.lat = site.meta.centerLonLat?.lat ?? (site.meta.boundsLonLat.south + site.meta.boundsLonLat.north) / 2;
    this.lon = site.meta.centerLonLat?.lon ?? (site.meta.boundsLonLat.west + site.meta.boundsLonLat.east) / 2;

    const low = quality === "low";
    this.dust = new Dust(MARS_WALKER.g, (x, z) => view.groundAt(x, z), low ? 260 : 900);
    this.prints = new Footprints(low ? 220 : 700);
    // EV1 wears fern stripes, EV2 amber: each device draws its own suit and the other astronaut's
    const FERN = 0xc6f432;
    const AMBER = 0xffc247;
    this.avatar = new Astronaut(MARS_WALKER.g, (x, z) => view.groundAt(x, z), this.member === "ev2" ? AMBER : FERN);
    this.buddy = new Astronaut(MARS_WALKER.g, (x, z) => view.groundAt(x, z), this.member === "ev2" ? FERN : AMBER);
    this.buddy.root.visible = false;
    view.add(this.buddy.root);
    view.add(this.buddy.mapMarker, 13);
    view.add(this.avatar.root);
    view.add(this.avatar.mapMarker, 13);
    view.add(this.shadow.mesh);
    view.add(this.prints.mesh);
    view.add(this.dust.points);
    view.add(this.trail.line);
    this.markStops();
    const minerals = site.meta.minerals;
    this.field = new FieldWork(grid, {
      minerals: minerals ? site.mineralGrid : null,
      mineralBands: minerals?.bands.map((b) => ({ key: b.key, name: b.name })) ?? [],
      geology: site.geology ? site.geologyGrid : null,
      units: site.geology?.units.map((u) => ({ id: u.id, name: u.name, symbol: u.symbol })) ?? [],
      traverse: site.rover?.traverse ?? [],
      roverName: site.meta.rover?.name ?? null,
    });
    this.hab = new RoamHab(site.id, this.member);
    this.hab.onBuddy = (p) => {
      this.buddyTarget = p;
      this.buddySeen = performance.now();
    };
    this.hab.onPlan = (p) => this.planFromEv1(p);
    const ev1Watch = new Ev1Watch(site.id, () => this.toast("<b>EV1 is back</b> in the session."));
    this.hab.onEv1 = (online) => this.member === "ev2" && ev1Watch.update(online);
    this.hab.onChange = () => this.renderLink();
    this.hab.onEarth = (m) => this.fromEarth(m);

    this.host = document.createElement("div");
    this.host.id = "roam";
    document.body.append(this.host);
    document.body.classList.add("roam-on");
    this.render();
    this.bind();
    this.audio.onCue = (t) => this.caption(t);
    this.host.querySelector<HTMLElement>(".rm-captions")!.hidden = !this.settings.captions;
    const startLook = new URLSearchParams(location.search).get("look");
    this.setLook(startLook === "visor" ? "walk" : startLook === "map" ? "plan" : "orbit");
    this.updateSky(true);
    view.setDust(this.tau);
    this.audio.windiness = 1 + Math.max(0, this.tau - CLEAR_TAU) * 0.35;
    // the wind that carries it: from the west-south-west, stronger in a storm (a few m/s; an assumption)
    const ws = Math.min(9, 2 + this.tau * 0.8);
    this.wind.set(ws * 0.93, 0, -ws * 0.37);
    if (this.plan) {
      this.useMission(this.plan.stops, this.plan.legs);
      this.faceRoute();
    } else if (link) void this.routeLink(link.stops, link.add, link.dwell);
    else this.hab.plan(this.planInfo());
    this.renderMission();
  }

  // ================================================================ the mission
  /** Stops on the map: the mission's in order (numbered), the others plain; the rover where the plan parks it. */
  private markStops(): void {
    const ids = this.stops.map((s) => s.id);
    const pois = this.site.pois.map((p) => (p.kind === "shelter" ? this.rover : p));
    const custom = this.stops.filter((s) => !this.site.pois.some((p) => p.id === s.id));
    for (const c of custom) pois.push({ ...this.rover, id: c.id, kind: "objective", name: c.name, short: c.short, x: c.x, y: c.y, dwellMin: c.dwellMin, images: [] });
    this.view.setPois(pois.map((p) => {
      const i = ids.indexOf(p.id);
      return { poi: p, active: this.stops.length ? i >= 0 && i >= this.next : p.kind === "objective", order: i >= 0 ? i + 1 : null };
    }));
  }

  /** What Mission Control draws: the walk area, the mission's route and stops, and the planned timeline. */
  private planInfo(): PlanInfo {
    const meta = this.site.meta;
    const route: [number, number][] = [];
    for (const leg of this.legs) for (const q of leg) {
      const last = route[route.length - 1];
      if (!last || Math.hypot(q.x - last[0], q.y - last[1]) >= 4) route.push([Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10]);
    }
    // the plan's timeline: walking at the planner's pace, then the time on site at each stop
    const timeline: [number, number, number][] = [];
    if (this.plan) {
      const walkS = this.plan.planned.walkTimeS;
      const distM = Math.max(1, this.plan.planned.distM);
      let t = 0;
      this.legs.forEach((leg, i) => {
        for (let k = 0; k < leg.length; k++) {
          if (k > 0) t += (Math.hypot(leg[k].x - leg[k - 1].x, leg[k].y - leg[k - 1].y) / distM) * walkS;
          if (k % 6 === 0 || k === leg.length - 1) timeline.push([Math.round(t), Math.round(leg[k].x), Math.round(leg[k].y)]);
        }
        const st = this.stops[i];
        if (st) {
          t += st.dwellMin * 60;
          timeline.push([Math.round(t), Math.round(st.x), Math.round(st.y)]);
        }
      });
    }
    const p = DEFAULT_PARAMS;
    return {
      site: meta.id,
      siteName: meta.name,
      sizeM: meta.sizeM,
      image: `${this.site.base}${meta.texture.file}`,
      route,
      stops: [
        { id: this.rover.id, name: this.rover.name, short: this.rover.short, x: this.rover.x, y: this.rover.y, kind: "shelter", order: 0 },
        ...this.stops.map((st, i) => ({ id: st.id, name: st.name, short: st.short, x: st.x, y: st.y, kind: "objective" as const, order: i + 1 })),
      ],
      roverName: meta.rover?.name ?? "Rover",
      startLmst: fmtLmst(this.startLmst),
      distanceM: this.plan?.planned.distM ?? 0,
      timeS: this.plan?.planned.timeS ?? 0,
      o2SupplyL: p.o2SupplyL,
      o2ReserveL: p.o2SupplyL * p.reserveFraction,
      lightTimeS: this.lightTimeS,
      ...(this.shortened() ? { realLightTimeS: this.realLightTimeS } : {}),
      storm: this.stormOn,
      buddy: this.hab.ev2Online > 0,
      dust: { tau: this.tau, name: this.dustName },
      legs: this.legs.map((leg) => leg.filter((_, k) => k % 3 === 0 || k === leg.length - 1).map((q) => [Math.round(q.x * 10) / 10, Math.round(q.y * 10) / 10] as [number, number])),
      o2PlannedL: this.plan?.planned.o2L,
      walkTimeS: this.plan?.planned.walkTimeS,
      hash: this.plan?.hash ?? location.hash,
      timeline,
      mode: "roam",
    };
  }

  /** One telemetry frame: what Mission Control will see of this moment, one light time from now. */
  private frameNow(): Frame {
    const s = this.walker;
    const tg = this.target();
    const dr = Math.max(0, this.roverGap());
    const sun = sunAt(this.lat, this.lmst(), this.solar);
    return {
      t: this.t,
      x: s.x,
      y: s.y,
      headingDeg: (s.heading * 180) / Math.PI,
      o2LeftL: DEFAULT_PARAMS.o2SupplyL - s.o2L,
      doseUGy: this.storm?.doseUGy ?? 0,
      doseRate: this.storm ? this.storm.rate(this.t) : 0,
      baseline: this.storm?.baseline ?? 0,
      status: `On foot${this.emergency ? (this.emergency.kind === "leak" ? " · suit leak" : " · twisted ankle") : ""} · ${s.gait === "down" ? "down" : s.gait === "slide" ? "sliding" : s.gait === "air" ? (s.bounding ? "loping" : "in the air") : s.gait === "lope" ? "loping" : s.gait === "walk" ? "walking" : "standing"}${this.finished ? " · back in the rover" : ""}`,
      next: tg ? tg.name : this.plan ? "the rover" : "exploring",
      nextDistM: tg ? Math.hypot(tg.x - s.x, tg.y - s.y) : 0,
      homeS: dr / 0.8,
      radio: this.contact ? "ok" : "lost",
      sheltered: this.finished,
      storm: this.stormAlarm,
      lmst: fmtLmst(this.lmst()),
      sunEl: sun.elevation,
      lightTimeS: this.lightTimeS,
      speed: document.hidden ? 0 : 1,
      hidden: document.hidden,
      pose: this.selfPose(),
      buddy: this.buddyTarget && this.buddyFresh() ? { x: this.buddyTarget.x, y: this.buddyTarget.y } : null,
    };
  }

  private selfPose(): CrewPose {
    const s = this.walker;
    return { x: s.x, y: s.y, z: s.z, headingDeg: (s.heading * 180) / Math.PI, gait: s.gait, vx: s.vx, vy: s.vy, vz: s.vz, downT: s.downT, sliding: s.sliding };
  }

  private buddyFresh(): boolean {
    return performance.now() - this.buddySeen < 5000;
  }

  /** EV2: EV1's mission arrives with its plan — walk the same stops along the same route. */
  private planFromEv1(p: PlanInfo): void {
    if (this.member !== "ev2" || p.mode !== "roam" || !p.legs?.length || this.plan?.hash === p.hash) return;
    const dwell = (id: string) => this.site.pois.find((x) => x.id === id)?.dwellMin ?? 20;
    const stops = p.stops.filter((x) => x.kind !== "shelter").sort((a, b) => a.order - b.order).map((x) => ({ id: x.id, name: x.name, short: x.short, x: x.x, y: x.y, dwellMin: dwell(x.id) }));
    const legs = p.legs.map((leg) => leg.map(([x, y]) => ({ x, y })));
    this.plan = {
      site: this.site.id, hash: p.hash ?? "", rover: { x: this.rover.x, y: this.rover.y }, startLmst: this.startLmst, stops, legs,
      planned: { o2L: p.o2PlannedL ?? 0, timeS: p.timeS, walkTimeS: p.walkTimeS ?? p.timeS, distM: p.distanceM },
    };
    this.useMission(stops, legs);
    this.toast(`<b>EV1's plan received:</b> ${stops.map((x) => esc(x.short)).join(" → ")}. Walk it together.`);
  }

  /** The other astronaut: eased toward the last pose received, animated like your own suit. */
  private updateBuddy(dt: number): void {
    const t = this.buddyTarget;
    const visible = !!t && this.buddyFresh();
    this.buddy.root.visible = visible;
    if (!visible || !t) {
      this.buddy.mapMarker.visible = false;
      return;
    }
    const b = (this.buddyState ??= newWalker(t.x, t.y, t.z, (t.headingDeg * Math.PI) / 180));
    const k = Math.min(1, dt * 8);
    b.x += (t.x - b.x) * k;
    b.y += (t.y - b.y) * k;
    b.z += (t.z - b.z) * k;
    b.vx = t.vx;
    b.vy = t.vy;
    b.vz = t.vz;
    let dh = (t.headingDeg * Math.PI) / 180 - b.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    b.heading += dh * k;
    b.gait = t.gait as WalkerState["gait"];
    b.grounded = t.gait !== "air";
    b.downT = t.downT ?? 0;
    b.sliding = !!t.sliding;
    const sp = Math.hypot(t.vx, t.vy);
    if (b.gait === "walk") b.phase += cadence(MARS_WALKER.g, MARS_WALKER.legM, sp, 1.3) * Math.PI * dt;
    this.buddy.update(b, this.view.toWorld(b.x, b.y, b.z), dt, 0, this.look === "plan");
    // the buddy rule: stay within sight and reach of each other
    const d = Math.hypot(b.x - this.walker.x, b.y - this.walker.y);
    const other = this.member === "ev2" ? "EV1" : "EV2";
    if (d > DEFAULT_PARAMS.buddyMaxSeparationM && !this.apart) {
      this.apart = true;
      this.toast(`More than ${DEFAULT_PARAMS.buddyMaxSeparationM} m from ${other}: the buddy rule keeps you within sight and reach of each other.`, true);
    } else if (d < DEFAULT_PARAMS.buddyMaxSeparationM * 0.8) this.apart = false;
  }

  /** A decision the crew had to take alone (Earth is a light time away): kept for the debrief and sent to Earth. */
  private decided(text: string): void {
    this.decisions.push({ t: this.t, text });
    this.hab.note(this.t, "alert", text);
  }

  /**
   * A message from Mission Control, shown in the helmet the moment it reaches Mars — one light time
   * after Earth sent it, answering what Earth had seen of the crew one light time before that.
   */
  private fromEarth(m: EarthMessage): void {
    const box = this.host.querySelector<HTMLElement>(".rm-earth")!;
    const lt = this.lightTimeS;
    const sentOnMarsClock = m.sentT;
    const ago = `Sent ${fmtLightTime(Math.max(0, this.t - sentOnMarsClock))} ago`;
    const late = m.immediate
      ? ""
      : sentOnMarsClock < lt
        ? `${ago}, before anything from this walk had reached Earth.`
        : `${ago}, answering what Earth had seen of you at T+${fmtClock(sentOnMarsClock - lt)}.`;
    const change = m.change;
    const dropped = change ? change.drop.map((id) => this.stops.find((x) => x.id === id)?.short ?? id) : [];
    box.innerHTML = `<p class="eyebrow">// Mission Control · Earth</p>
      <b>“${esc(m.text)}”</b>
      ${late ? `<span>${late}</span>` : ""}
      ${change ? `<p class="rm-change">Revised plan: ${dropped.length ? `skip ${esc(dropped.join(", "))}` : "no stops dropped"}${change.add.length ? `; ${change.add.length} new point${change.add.length > 1 ? "s" : ""} (add them in the planner)` : ""}.</p>
        <div class="rm-earth-acts"><button class="primary" data-earth="yes">Accept</button><button data-earth="no">Decline</button></div>` : `<button class="rm-earth-x" data-earth="ok" aria-label="Dismiss">${ic.close}</button>`}`;
    box.hidden = false;
    box.dataset.id = m.id;
    this.audio.beep();
    window.setTimeout(() => this.audio.beep(), 380);
    this.hab.note(this.t, "radio", `Mission Control: “${m.text}”`);
    window.clearTimeout(this.earthTimer);
    if (!change) this.earthTimer = window.setTimeout(() => (box.hidden = true), 14000);
    box.onclick = (ev) => {
      const what = (ev.target as HTMLElement).closest<HTMLElement>("[data-earth]")?.dataset.earth;
      if (!what) return;
      if (change && (what === "yes" || what === "no")) {
        const accepted = what === "yes";
        this.hab.reply(m.id, accepted);
        if (accepted) this.skipStops(change.drop);
        this.decided(`${accepted ? "Accepted" : "Declined"} Mission Control's revised plan`);
      }
      box.hidden = true;
    };
  }
  private earthTimer = 0;

  /** Earth's revised plan drops stops: they are skipped (the route stays, the samples are not taken). */
  private skipStops(ids: string[]): void {
    const keep = this.stops.filter((st, i) => i < this.next || !ids.includes(st.id));
    if (keep.length === this.stops.length) return;
    // the walk goes on to the next stop that is left; legs to skipped stops are kept as the way there
    this.stops = keep;
    this.markStops();
    this.renderMission();
    this.toast(`Plan changed: ${ids.length} stop${ids.length > 1 ? "s" : ""} dropped. Next: ${esc(this.target()?.name ?? "the rover")}.`);
  }

  /** The same page for the second astronaut, on another device. */
  private ev2Link(): string {
    const q = new URLSearchParams(location.search);
    q.set("crew", "ev2");
    return `?${q.toString()}${location.hash}`;
  }

  /** The hab link's state, in the mission panel. */
  /** Whether the link runs on the shortened demo delay rather than the true light time. */
  private shortened(): boolean {
    return this.realLightTimeS > 0 && Math.abs(this.lightTimeS - this.realLightTimeS) > 1;
  }

  private renderLink(): void {
    const el = this.host?.querySelector<HTMLElement>(".rm-link");
    if (!el) return;
    const h = this.hab;
    const other = this.member === "ev2" ? "EV1" : "EV2";
    const b = this.buddyState;
    const pair = this.buddyTarget && this.buddyFresh() && b ? ` · ${other} ${fmtDist(Math.hypot(b.x - this.walker.x, b.y - this.walker.y))} away` : this.member === "ev1" && h.ev2Online ? ` · ${other} online` : "";
    const invite = this.member === "ev1" && h.online && !h.ev2Online ? ` · <a href="${esc(this.ev2Link())}" target="_blank" rel="noopener">EV2 link</a>` : "";
    el.innerHTML = h.online
      ? `<i class="on"></i>${this.member === "ev2" ? "You are EV2" : "Hab linked"}${pair}${h.mcOnline ? ` · Mission Control watching, ${fmtLightTime(this.lightTimeS)} behind${this.shortened() ? ` (shortened from ${fmtLightTime(this.realLightTimeS)})` : ""}` : ""}${invite}`
      : `<i></i>No hab link: walking on your own`;
  }

  /** Turn to where the first leg leaves the rover: the camera behind you, looking along the route. */
  private faceRoute(): void {
    const leg = this.legs[0];
    if (!leg?.length) return;
    const s = this.walker;
    const ahead = leg.find((q) => Math.hypot(q.x - s.x, q.y - s.y) > 25) ?? leg[leg.length - 1];
    const h = Math.atan2(ahead.x - s.x, ahead.y - s.y);
    s.heading = h;
    this.yaw = h;
    this.camInit = false;
  }

  private useMission(stops: MissionStop[], legs: XY[][]): void {
    this.stops = stops;
    this.legs = legs;
    // the storm starts a little under halfway through the planned EVA: a choice between science and shelter
    if (this.stormOn && this.plan && !this.storm) this.storm = new RoamStorm(new RadiationModel(this.site.replay), Math.max(300, Math.round(this.plan.planned.timeS * 0.42)), DEFAULT_PARAMS.maxShelterMin);
    queueMicrotask(() => this.hab.plan(this.planInfo()));
    const grid = this.site.grid;
    this.view.setRoutes({ safe: legs.map((l) => measurePath(grid, l, DEFAULT_PARAMS)), straight: [], showStraight: false, shelter: null, dimSafe: false });
    this.markStops();
    this.renderMission();
    const goal = this.host.querySelector<HTMLElement>(".rm-intro-goal");
    if (goal) goal.innerHTML = this.introGoal();
  }

  /** A shared plan link with no handed-over plan: route it here, in the plan's own stop order. */
  private async routeLink(ids: string[], add: XY[], dwell: Record<string, number>): Promise<void> {
    const byId = new Map(this.site.pois.map((p) => [p.id, p]));
    const stops: MissionStop[] = [
      ...ids.map((id) => byId.get(id)).filter((p): p is Poi => !!p && p.kind !== "shelter").map((p) => ({ id: p.id, name: p.name, short: p.short, x: p.x, y: p.y, dwellMin: dwell[p.id] ?? p.dwellMin })),
      ...add.map((a, i) => ({ id: `add-${i}`, name: `Custom stop ${i + 1}`, short: `Stop ${i + 1}`, x: a.x, y: a.y, dwellMin: dwell[`add-${i}`] ?? 20 })),
    ];
    if (!stops.length) return;
    this.toast("Working out the safe route for this plan…");
    const { Router } = await import("../routing/client");
    const router = new Router();
    const at = { x: this.rover.x, y: this.rover.y };
    await router.init(this.site.grid, DEFAULT_PARAMS, at);
    const res = await router.route([at, ...stops.map((s) => ({ x: s.x, y: s.y })), at]);
    if (res.legs.some((l) => !l)) return this.toast("No safe route links this plan's stops; walking freely instead.", true);
    const legs = res.legs as XY[][];
    const grid = this.site.grid;
    const measured = legs.map((l) => measurePath(grid, l, DEFAULT_PARAMS));
    const p = DEFAULT_PARAMS;
    const walkS = measured.reduce((a, m) => a + m.time, 0);
    const dwellS = stops.reduce((a, s) => a + s.dwellMin * 60, 0);
    const o2 = (measured.reduce((a, m) => a + m.energy, 0) + p.restingW * walkS + p.workingW * dwellS) / (p.kJPerLitreO2 * 1000);
    this.plan = { site: this.site.id, hash: location.hash, rover: at, startLmst: this.startLmst, stops, legs, planned: { o2L: o2, timeS: walkS + dwellS, walkTimeS: walkS, distM: measured.reduce((a, m) => a + m.distance, 0) } };
    this.useMission(stops, legs);
    this.faceRoute();
  }

  private renderMission(): void {
    const box = this.host.querySelector<HTMLElement>(".rm-mission")!;
    const site = encodeURIComponent(this.site.id);
    if (!this.plan) {
      const all = this.site.pois.filter((p) => p.kind !== "shelter").length;
      box.innerHTML = `<p class="eyebrow">// Explore</p><b>${this.visited.size} of ${all} stops found</b>
        <span>Walk to the cairns. To walk a planned EVA as a mission, plan it and choose <a href="?site=${site}&skip=1">Walk it yourself</a>.</span>
        <p class="rm-link"></p>`;
      this.renderLink();
      return;
    }
    const n = this.stops.length;
    const target = this.next < n ? this.stops[this.next] : null;
    box.innerHTML = `<p class="eyebrow">// Mission · ${this.finished ? "done" : this.next < n ? `stop ${this.next + 1} of ${n}` : "back to the rover"}</p>
      <b data-k="mnext">${esc(target ? target.name : "Rover — rear suitport")}</b>
      <span data-k="mdist"></span>
      <ol class="rm-mstops">${this.stops.map((st, i) => `<li class="${i < this.next ? "done" : i === this.next ? "now" : ""}">${esc(st.short)}</li>`).join("")}<li class="${this.next === n ? "now" : ""}">Rover</li></ol>
      <dl>
        <dt>EVA clock <small>/ plan</small></dt><dd data-k="mclock"></dd>
        <dt>O₂ used <small>/ plan</small></dt><dd data-k="mo2"></dd>
        <dt>Off route</dt><dd data-k="moff"></dd>
      </dl>
      <p class="rm-link"></p>`;
    this.renderLink();
  }

  private target(): XY & { name: string; dwellMin: number } | null {
    if (!this.plan || this.finished) return null;
    if (this.next < this.stops.length) return this.stops[this.next];
    return { x: this.rover.x, y: this.rover.y, name: "the rover", dwellMin: 0 };
  }

  /** Distance from the walker to the rover's hull (0 inside it). */
  private roverGap(): number {
    return gapToBox(this.walker.x, this.walker.y, this.rover.x, this.rover.y, ROVER_HALF.x, ROVER_HALF.z);
  }

  /** What E does here, if anything: sample at the next stop, climb in at the rover. */
  private action(): "sample" | "board" | "scan" | null {
    const s = this.walker;
    if (this.finished || !this.started || !s.grounded || s.gait === "down") return null;
    if (this.plan) {
      if (this.next < this.stops.length) {
        const st = this.stops[this.next];
        if (Math.hypot(st.x - s.x, st.y - s.y) < AT_STOP_M) return "sample";
      } else if (this.roverGap() < AT_ROVER_M) return "board";
    }
    return this.roverGap() < 4 ? null : "scan";
  }

  // ================================================================ field work
  /** Work on the spot: the clock runs on, oxygen at the working rate (as at a stop). */
  private work(seconds: number): void {
    const p = DEFAULT_PARAMS;
    this.walker.o2L += workO2(seconds, p.workingW, p.kJPerLitreO2);
    this.walker.energyJ += p.workingW * seconds;
    this.t += seconds;
    this.updateSky(true);
  }

  /** A field reading at your boots: what the maps say, and any find it makes. */
  private reading(): void {
    const s = this.walker;
    this.work(READING_S);
    const { reading: r, finds } = this.field.scan(s.x, s.y, this.t);
    const parts = [
      `${r.soil === "sand" ? "loose sand" : r.soil} (${r.sandPct} % sand)`,
      `${r.slopeDeg}° slope`,
      r.unit ? `${r.unit.name} (${r.unit.symbol})` : "",
      this.site.grid.shield ? `terrain blocks ${r.blockedPct} % of the sky` : "",
    ].filter(Boolean);
    const min = r.minerals?.filter((m) => m.detected).map((m) => `${m.name.toLowerCase()} stronger than ${Math.floor(m.rank * 100)} % of detections`) ?? [];
    this.hab.note(this.t, "science", `Field reading: ${parts.join(", ")}${min.length ? `; CRISM: ${min.join(", ")}` : ""}`);
    if (finds.length) this.found(finds);
    else this.toast(`<b>Field reading</b> ${esc(parts.join(" · "))}${r.minerals ? `<br><small>CRISM, 18 m pixels: ${min.length ? esc(min.join(" · ")) : "no mineral above the detection floor"}</small>` : ""}`);
    this.renderField();
  }

  /** Finds: a toast, a survey flag on the ground, a line in the crew log (Earth reads it a light time later). */
  private found(finds: Find[]): void {
    for (const f of finds) {
      const flag = makeSurveyFlag(f.id.startsWith("mineral") ? 0xc6f432 : 0x9fb4c6);
      flag.position.copy(this.view.toWorld(f.x + 0.7, f.y, this.site.grid.heightAt(f.x + 0.7, f.y)));
      this.view.add(flag);
      this.hab.note(f.t, "science", `${f.title}. ${f.text}`);
    }
    const f = finds[finds.length - 1];
    this.toast(`<b>${esc(f.title)}</b> ${esc(f.text)}${finds.length > 1 ? ` <small>(+${finds.length - 1} more in the field log)</small>` : ""}`);
    this.renderField();
  }

  /** R: stand the relay mast up here (it must see the rover from its top), or pack it up again. */
  private toggleMast(): void {
    const s = this.walker;
    if (this.finished || !this.started) return;
    if (!s.grounded || s.gait === "down" || Math.hypot(s.vx, s.vy) > 0.25) return this.toast("Stand still to work with the mast.");
    const grid = this.site.grid;
    if (this.mast) {
      if (Math.hypot(this.mast.x - s.x, this.mast.y - s.y) > 3) return this.toast(`The mast is ${fmtDist(Math.hypot(this.mast.x - s.x, this.mast.y - s.y))} away. Walk back to it to pack it up.`);
      this.mast.obj.removeFromParent();
      this.view.invalidate();
      this.mast = null;
      this.field.relayUp = false;
      this.work(MAST_S);
      this.toast(`<b>Mast packed</b> (${MAST_S / 60} min of work). Carry it on to the next blind spot.`);
      this.renderField();
      return;
    }
    // the mast's antenna is RELAY_MAST_M up, the suit's SUIT_ANTENNA_M: it sees over that much more ground
    const depth = radioDepthAt(this.radio, grid, s.x, s.y);
    if (depth > RADIO_LOST_M + (RELAY_MAST_M - SUIT_ANTENNA_M)) {
      return this.toast(`<b>No line of sight to the rover from here</b>, even from the top of the ${RELAY_MAST_M} m mast. Stand it up on ground that can still see the rover.`, true);
    }
    const x = s.x + Math.sin(s.heading) * 1.2;
    const y = s.y + Math.cos(s.heading) * 1.2;
    const obj = makeRelayMast();
    obj.position.copy(this.view.toWorld(x, y, grid.heightAt(x, y)));
    this.view.add(obj);
    this.mast = { x, y, shadow: radioShadow(grid, { x, y }, RELAY_MAST_M), obj };
    this.field.relayUp = true;
    this.work(MAST_S);
    this.hab.note(this.t, "radio", "Relay mast up");
    this.decided("Stood up the relay mast");
    this.toast(`<b>Relay mast up</b> (${MAST_S / 60} min of work). Its top sees the rover; behind ridges that hide the rover you now talk through it.`);
    this.renderField();
  }

  /** The field panel: tasks with live hints, the spectral signal where CRISM imaged. */
  private renderField(): void {
    const box = this.host.querySelector<HTMLElement>(".rm-field")!;
    const s = this.walker;
    const tasks = this.field.tasks(s.x, s.y, !this.contact);
    const done = tasks.filter((t) => t.done).length;
    const sig = this.fieldOpen ? this.field.signal(s.x, s.y) : null;
    const bar = (rank: number) => `<i class="rm-sig"><i style="width:${Math.round(rank * 100)}%"></i></i>`;
    const open = tasks.filter((t) => !t.done);
    const shown = this.fieldAll ? tasks : open.slice(0, 3);
    const more = this.fieldAll ? "Show fewer" : tasks.length > shown.length ? `All ${tasks.length} tasks` : "";
    const html = `<button class="rm-field-head" data-act="field" aria-expanded="${this.fieldOpen}"><span class="eyebrow">// Field work</span><b>${done} of ${tasks.length}</b></button>
      ${this.fieldOpen ? `<ul>${shown.map((t) => `<li class="${t.done ? "done" : ""}"><b>${t.done ? "✓" : "○"} ${esc(t.title)}</b><span>${esc(t.detail)}</span></li>`).join("")}</ul>
      ${more ? `<button class="rm-field-more" data-act="field-all">${more}</button>` : ""}
      ${sig ? `<div class="rm-spectra"><small>CRISM signal within 40 m</small>${sig.map((b) => `<label>${esc(b.name)}${bar(b.rank)}<em>${b.rank > 0 ? `${Math.floor(b.rank * 100)} %${b.bearing ? ` ${b.bearing}` : ""}` : "—"}</em></label>`).join("")}</div>` : this.field.hasMinerals ? `<p class="rm-spectra-off">Outside CRISM's footprint: no mineral signal here.</p>` : ""}
      <button class="rm-mast" data-act="mast">${this.mast ? "Pack up the mast" : "Stand up the relay mast"} <kbd>${esc(keyName(this.settings.keys.mast))}</kbd></button>` : ""}`;
    if (box.innerHTML !== html) box.innerHTML = html;
  }

  private fieldTick(dt: number): void {
    this.fieldT -= dt;
    if (this.fieldT > 0) return;
    this.fieldT = 0.25;
    const s = this.walker;
    if (this.started && !this.finished) {
      const finds = this.field.walk(s.x, s.y, this.t);
      if (finds.length) this.found(finds);
    }
    this.renderField();
  }

  /** Hold E (or the Hold button): sample at the stop, climb in at the rover, or take a field reading. */
  private useHold(dt: number): void {
    const act = this.action();
    const prompt = this.host.querySelector<HTMLElement>(".rm-act")!;
    const holding = this.keys.has("use") || this.touchHold;
    const s = this.walker;
    const still = Math.hypot(s.vx, s.vy) < 0.25;
    if (act && holding && still) this.holdT += dt;
    else this.holdT = Math.max(0, this.holdT - dt * 3);
    // a field reading is always possible, so its prompt stays quiet until you stop walking
    prompt.hidden = !act || (act === "scan" && !still && this.holdT === 0);
    prompt.classList.toggle("quiet", act === "scan");
    if (act) {
      const key = matchMedia("(pointer: coarse)").matches ? "Hold" : `Hold ${keyName(this.settings.keys.use)}`;
      const st = this.stops[this.next];
      const what =
        act === "sample" ? `collect a sample at ${esc(st.short)} <small>(${st.dwellMin} min of work)</small>`
        : act === "board" ? "climb into the suitport and end the EVA"
        : `for a field reading <small>(${READING_S / 60} min)</small>`;
      const html = `<b>${key}</b> ${act === "scan" ? "" : "to "}${what}`;
      const label = prompt.querySelector<HTMLElement>("span")!;
      if (label.innerHTML !== html) label.innerHTML = html;
      prompt.style.setProperty("--p", String(Math.min(1, this.holdT / HOLD_S)));
      prompt.classList.toggle("moving", !still);
    }
    this.avatar.setAction(act && holding ? (act === "board" ? "board" : "sample") : null, this.holdT / HOLD_S);
    if (act && this.holdT >= HOLD_S) {
      this.holdT = 0;
      if (act === "sample") this.chooseSample();
      else if (act === "board") this.finish(false);
      else this.reading();
    }
  }

  private mission(dt: number): void {
    const s = this.walker;
    // off route: distance to the planned legs, a few times a second
    this.routeT -= dt;
    if (this.routeT <= 0) {
      this.routeT = 0.25;
      this.offM = this.distanceToRoute(s.x, s.y);
    }
    if (Math.hypot(s.vx, s.vy) > 0.2) {
      this.walkS += dt;
      if (this.offM > OFF_ROUTE_M) this.offRouteS += dt;
    }
    if (DEFAULT_PARAMS.o2SupplyL - s.o2L <= 0) this.finish(true);
    this.weather();
  }

  /** A practice emergency: what it does, and CAIRN's rule — stop the science and go home now. */
  startEmergency(kind: "leak" | "ankle"): void {
    if (this.emergency || this.finished) return;
    const p = DEFAULT_PARAMS;
    this.emergency = { kind, atS: this.t, o2LeftL: p.o2SupplyL - this.walker.o2L };
    this.avatar.setLimp(kind === "ankle");
    this.audio.setLeak(kind === "leak");
    if (this.plan) {
      this.next = this.stops.length;
      this.markStops();
      this.renderMission();
    }
    const d = this.roverGap();
    this.toast(
      kind === "leak"
        ? `<b>Suit leak (practice).</b> Pressure is holding but oxygen is going twice as fast. Stop the science and walk back to the rover now: ${fmtDist(d)}.`
        : `<b>Twisted ankle (practice).</b> Keep the weight off it: half your pace, no bounding or jumping. Head back to the rover: ${fmtDist(d)}.`,
      true,
    );
    this.audio.beep(true);
    this.decided(kind === "leak" ? "Suit leak: stopped the science and turned back" : "Twisted ankle: turned back at half pace");
    this.renderEmergency();
  }

  private renderEmergency(): void {
    const el = this.host.querySelector<HTMLElement>(".rm-emergency")!;
    const e = this.emergency;
    el.hidden = !e;
    if (!e) return;
    const p = DEFAULT_PARAMS;
    const left = p.o2SupplyL - this.walker.o2L;
    el.innerHTML = `<b>${e.kind === "leak" ? "Suit leak" : "Twisted ankle"}</b><span>${e.kind === "leak" ? `O₂ ×2 · ${Math.round(left)} L left` : "half pace · no jumps"} · rover ${fmtDist(this.roverGap())}</span>`;
  }

  /** The storm: dose as it builds, the alarm on Mars, Earth's answer two light times later. */
  private weather(): void {
    const st = this.storm;
    if (!st) return;
    st.accumulate(this.lastT, this.t, this.finished);
    this.lastT = this.t;
    if (!this.stormAlarm && st.alarmed(this.t)) {
      this.stormAlarm = true;
      const rate = st.rate(this.t);
      const skipped = this.stops.length - this.next;
      this.next = this.stops.length; // turn back: the rover is the only target now
      this.markStops();
      this.renderMission();
      this.toast(`<b>Solar particle event.</b> Your dosimeter reads ${Math.round(rate)} µGy/h, ${Math.round(rate / st.baseline)}× background. Get inside the rover within ${st.shelterMin} min.${skipped ? ` ${skipped} stop${skipped > 1 ? "s" : ""} left for another sol.` : ""}`, true);
      this.audio.beep(true);
      this.decided(`Radiation alarm at ${Math.round(rate)} µGy/h: turned back for the rover`);
      // Earth hears the alarm one light time later; its first answer is back one light time after that
      this.stormEarthT = st.alertS + 2 * this.lightTimeS;
    }
    if (this.stormEarthT !== null && this.t >= this.stormEarthT) {
      this.stormEarthT = null;
      this.fromEarth({ id: "storm-earth", text: "We have your radiation alarm. Confirm you are heading for the rover and take the shortest safe way.", sentT: st.alertS + this.lightTimeS, deliverT: this.t });
    }
    const panel = this.host.querySelector<HTMLElement>(".rm-storm")!;
    panel.hidden = !this.stormAlarm;
    if (this.stormAlarm) {
      const left = st.leftS(this.t);
      const inside = this.finished;
      const html = `<p class="eyebrow">// Solar particle event</p>
        <b>${Math.round(st.rate(this.t))} µGy/h <small>${Math.round(st.rate(this.t) / st.baseline)}× background</small></b>
        <span>${inside ? `Inside the rover after ${fmtDur((st.shelteredS ?? this.t) - st.alertS)}` : left >= 0 ? `Inside within <em>${fmtClock(left).slice(3)}</em>` : `<em class="bad">${fmtClock(-left).slice(3)} past the shelter time</em>`} · dose ${fmtDose(st.doseUGy)}</span>`;
      if (panel.innerHTML !== html) panel.innerHTML = html;
      panel.classList.toggle("late", !inside && left < 0);
    }
  }

  private distanceToRoute(x: number, y: number): number {
    return distanceToLegs(x, y, this.legs);
  }


  /**
   * Choose what to sample: the stop's own rover photos (real Navcam frames from the site data).  The
   * clock waits while the crew decides.  Stops with no photos go straight to the work.
   */
  private chooseSample(): void {
    const st = this.stops[this.next];
    const poi = this.site.pois.find((x) => x.id === st.id);
    const imgs = poi?.images ?? [];
    if (!imgs.length || !poi) return this.sample(null);
    this.choosing = true;
    if (document.pointerLockElement) document.exitPointerLock();
    openModal(
      `Sample at ${st.name}`,
      `<p class="rm-pick-note">These are ${esc(this.site.meta.rover?.name ?? "the rover")}'s own photos of this stop. Pick the one that shows what you will sample; the work takes ${st.dwellMin} min.</p>
      <div class="rm-pick">${imgs
        .map((im, i) => `<button data-pick="${i}"><img src="${this.site.base}${im.file}" alt="${esc(im.cameraName)}, sol ${im.sol}" loading="lazy"/><span>${esc(im.cameraName)} · sol ${im.sol}</span></button>`)
        .join("")}</div>
      <p class="fine">${esc(imgs[0].credit)}. Raw images from the mission archive; the science notes below come from the stop's record.</p>`,
      true,
    );
    const box = $("#modal");
    box.querySelectorAll<HTMLButtonElement>("[data-pick]").forEach((b) =>
      b.addEventListener("click", () => {
        const im = imgs[Number(b.dataset.pick)];
        box.hidden = true;
        this.choosing = false;
        this.sample(im);
      }),
    );
    // closing the dialog without a pick: no sample yet, the crew can try again
    const done = new MutationObserver(() => {
      if (box.hidden) {
        this.choosing = false;
        done.disconnect();
      }
    });
    done.observe(box, { attributes: true, attributeFilter: ["hidden"] });
  }
  private choosing = false;

  /** What the sample is about: the stop's science notes, with the chosen photo. */
  private science(id: string, pick: { file: string; cameraName: string; sol: number } | null): void {
    const poi = this.site.pois.find((x) => x.id === id);
    const box = this.host.querySelector<HTMLElement>(".rm-science")!;
    if (!poi || (!poi.science && !poi.whyHumans)) return;
    box.innerHTML = `${pick ? `<img src="${this.site.base}${pick.file}" alt="${esc(pick.cameraName)}, sol ${pick.sol}"/>` : ""}
      <div><p class="eyebrow">// Sample bagged · ${esc(poi.short)}</p>
      ${poi.science ? `<p>${esc(poi.science)}</p>` : ""}
      ${poi.whyHumans ? `<p class="why"><b>Why a person:</b> ${esc(poi.whyHumans)}</p>` : ""}</div>
      <button class="rm-science-x" aria-label="Close">${ic.close}</button>`;
    box.hidden = false;
    box.querySelector("button")!.onclick = () => (box.hidden = true);
    window.setTimeout(() => (box.hidden = true), 22000);
  }

  /** Work at the stop: the clock moves on by the planned time there, at working metabolic rate. */
  private sample(pick: { id: string; file: string; sol: number; cameraName: string } | null): void {
    const st = this.stops[this.next];
    const p = DEFAULT_PARAMS;
    let dwellS = st.dwellMin * 60;
    // the alarm cuts the work short: the clock only runs on to the moment it sounds
    const alarmAt = this.storm && !this.stormAlarm ? this.storm.alertS : Infinity;
    const cut = this.t + dwellS > alarmAt;
    if (cut) dwellS = Math.max(0, alarmAt - this.t);
    const o2 = workO2(dwellS, p.workingW, p.kJPerLitreO2);
    this.walker.o2L += o2;
    this.walker.energyJ += p.workingW * dwellS;
    this.t += dwellS;
    this.samples.push({ name: cut ? `${st.name} (cut short)` : st.name, atS: this.t, file: pick?.file, image: pick?.id });
    const target = pick ? `, target in ${pick.cameraName} image ${pick.id} (sol ${pick.sol})` : "";
    this.hab.note(this.t, "stop", cut ? `Sample at ${st.name} cut short by the radiation alarm after ${Math.round(dwellS / 60)} min${target}` : `Sample collected at ${st.name} (${st.dwellMin} min on site)${target}`);
    this.next++;
    this.markStops();
    this.renderMission();
    this.updateSky(true);
    const nextName = this.next < this.stops.length ? this.stops[this.next].short : "the rover";
    if (cut) return; // the alarm takes over (see weather)
    this.science(st.id, pick);
    this.toast(`<b>Sample collected</b> at ${esc(st.name)}. ${st.dwellMin} min of work used ${o2.toFixed(1)} L of oxygen; the Sun has moved on. Next: ${esc(nextName)}.`);
  }

  private finish(outOfO2: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.renderMission();
    this.host.querySelector<HTMLElement>(".rm-act")!.hidden = true;
    if (document.pointerLockElement) document.exitPointerLock();
    const plan = this.plan!;
    const s = this.walker;
    const pl = plan.planned;
    const o2 = s.o2L;
    const off = this.walkS > 0 ? this.offRouteS / this.walkS : 0;
    this.storm?.board(this.t);
    this.weather();
    const st = this.storm;
    const { checks, stars } = scoreWalk(
      {
        outOfO2, o2UsedL: o2, timeS: this.t, falls: this.falls, offRoute: off,
        storm: st && this.stormAlarm ? { alertS: st.alertS, shelteredS: st.shelteredS, shelterMin: st.shelterMin, doseUGy: st.doseUGy } : null,
      },
      pl,
    );
    if (outOfO2) this.decided("Out of oxygen before reaching the rover");
    this.hab.note(this.t, outOfO2 ? "alert" : "home", outOfO2 ? "Suit out of oxygen" : "Back in the rover through the suitport");
    this.hab.end(outOfO2, outOfO2 ? "Free roam: out of oxygen before the rover." : `Free roam: ${this.samples.length} of ${this.stops.length} samples, ${stars} of ${checks.length} stars.`);
    const row = (k: string, plan: string, you: string) => `<tr><td>${k}</td><td>${plan}</td><td><b>${you}</b></td></tr>`;
    openModal(
      outOfO2 ? "EVA failed: out of oxygen" : "EVA complete",
      `<div class="rm-debrief">
        <p class="rm-stars" aria-label="${stars} of ${checks.length}">${"★".repeat(stars)}<i>${"★".repeat(checks.length - stars)}</i></p>
        <p>${outOfO2 ? "The suit ran out of oxygen before you reached the rover. In a real EVA the 25 % reserve is there so this never happens: turn back when you reach it." : `Back in the rover with ${this.samples.length} of ${this.stops.length} samples.`}</p>
        <ul class="rm-checks">${checks.map((c) => `<li class="${c.ok ? "ok" : ""}">${c.ok ? "✓" : "✗"} ${c.text}</li>`).join("")}</ul>
        <table class="keys"><tr><td></td><td>Planned</td><td>You</td></tr>
          ${row("EVA time", fmtDur(pl.timeS), fmtDur(this.t))}
          ${row("Oxygen", `${Math.round(pl.o2L)} L`, `${Math.round(o2)} L`)}
          ${row("Distance walked", fmtDist(pl.distM), fmtDist(s.distM))}
          ${row("Samples", String(this.stops.length), `${this.samples.length}${this.samples.length ? ` — ${this.samples.map((x) => esc(x.name)).join(", ")}` : ""}`)}
          ${row("Falls · hard landings", "0", `${this.falls} · ${this.hardLandings}`)}
          ${row("Highest jump", "—", s.maxJumpM > 0 ? `${Math.round(s.maxJumpM * 100)} cm` : "—")}
          ${this.emergency ? row(this.emergency.kind === "leak" ? "Suit leak" : "Twisted ankle", "—", `at ${fmtClock(this.emergency.atS)}, ${Math.round(this.emergency.o2LeftL)} L of O₂ left then; home with ${Math.round(DEFAULT_PARAMS.o2SupplyL - s.o2L)} L (reserve ${Math.round(DEFAULT_PARAMS.o2SupplyL * DEFAULT_PARAMS.reserveFraction)} L)`) : ""}
          ${st && this.stormAlarm ? row("Radiation dose", "—", `${fmtDose(st.doseUGy)} (sheltering avoided ${fmtDose(st.avoided(st.deadlineS + 3600))} in the next hour)`) : ""}
        </table>
        <p class="fine">Planned figures come from the planner's model for this exact route; yours come from the walking physics as you walked it. Suit numbers are demo assumptions.</p>
        ${this.fieldDebrief()}
        ${autonomyHtml(this.decisions, this.realLightTimeS)}
        <div class="rm-debrief-acts"><button class="primary big" data-again>Walk it again</button><button class="big" data-planner>Back to the planner</button></div>
      </div>`,
      false,
    );
    const m = document.querySelector("#modal")!;
    m.querySelector("[data-again]")?.addEventListener("click", () => location.reload());
    m.querySelector("[data-planner]")?.addEventListener("click", () => dissolveTo(`?site=${encodeURIComponent(this.site.id)}&skip=1${this.backLink()}${location.hash}`));
  }

  private fieldDebrief(): string {
    const s = this.walker;
    const tasks = this.field.tasks(s.x, s.y, !this.contact);
    const finds = this.field.finds;
    return `<div class="rm-fieldlog"><h3>Field work · ${tasks.filter((t) => t.done).length} of ${tasks.length} tasks</h3>
      <ul class="rm-checks">${tasks.map((t) => `<li class="${t.done ? "ok" : ""}">${t.done ? "✓" : "✗"} ${esc(t.title)}</li>`).join("")}</ul>
      ${finds.length ? `<table class="keys">${finds.map((f) => `<tr><td>T+${fmtClock(f.t)}</td><td><b>${esc(f.title)}</b> — ${esc(f.text)}</td></tr>`).join("")}</table>` : `<p class="fine">No finds this time. Hold E away from the stops for field readings.</p>`}
      <p class="fine">${this.field.readings.length} field reading${this.field.readings.length === 1 ? "" : "s"}, ${fmtDur(this.field.readings.length * READING_S)} of work.</p></div>`;
  }

  // ================================================================ interface
  private render(): void {
    const name = this.site.meta.name.split(" — ")[0];
    const vRun = walkRunMs(MARS_WALKER.g, MARS_WALKER.legM);
    this.host.innerHTML = `
      <div class="rm-helmet" aria-hidden="true"><i class="rm-fog"></i><i class="rm-glare"></i></div>
      <header class="rm-top">
        <div class="pill rm-brand"><button class="rm-exit" data-act="menu" title="Main menu">${ic.home}<span>Menu</span></button><span class="sep"></span><b>Free roam</b><span class="rm-site">${esc(name)}</span></div>
        <nav class="pill seg rm-views" aria-label="View">${LOOKS.map(([v, i, label, title]) => `<button data-look="${v}" title="${title} (${LOOKS.findIndex((l) => l[0] === v) + 1})">${ic[i as keyof typeof ic]}<span>${label}</span></button>`).join("")}</nav>
        <div class="pill rm-actions">
          <button data-act="planner" title="Plan an EVA here">${ic.route}<span>Planner</span></button>
          <button data-act="sound" title="Suit sound on or off (M)">${ic.voiceOn}</button>
          <button data-act="settings" title="Keys, camera shake, captions (,)">${ic.sliders}</button>
          <button data-act="help" title="Controls and what is modelled (H)">${ic.info}</button>
        </div>
      </header>
      <div class="rm-compass" aria-hidden="true"><div class="rm-strip"></div><i></i></div>
      <section class="rm-hud" aria-label="Suit readouts">
        <div class="rm-tile o2"><small>Oxygen</small><b data-k="o2">—</b><span data-k="o2t"></span><i class="rm-bar"><i data-k="o2bar"></i></i></div>
        <div class="rm-tile hr"><small>Heart</small><b data-k="hr">—</b><span data-k="br"></span></div>
        <div class="rm-tile pw"><small>Metabolic</small><b data-k="pw">—</b><span data-k="kcal"></span></div>
        <div class="rm-tile sp"><small>Speed</small><b data-k="sp">—</b><span data-k="gait"></span></div>
        <div class="rm-tile gr"><small>Underfoot</small><b data-k="slope">—</b><span data-k="ground"></span></div>
        <div class="rm-tile rv"><small>Rover</small><b data-k="rover">—</b><span data-k="radio"></span></div>
        <div class="rm-tile sun"><small>Local time</small><b data-k="time">—</b><span data-k="sun"></span></div>
        <div class="rm-tile tr"><small>Walked</small><b data-k="dist">—</b><span data-k="steps"></span></div>
      </section>
      <section class="rm-mission panel" aria-label="Mission"></section>
      <section class="rm-field panel" aria-label="Field work"></section>
      <section class="rm-storm" role="status" hidden></section>
      <div class="rm-emergency" role="status" hidden></div>
      <section class="rm-science panel" role="status" hidden></section>
      <div class="rm-act" role="status" hidden><i class="rm-ring" aria-hidden="true"></i><span></span></div>
      <div class="rm-gait" aria-hidden="true"><b data-k="gaitbig"></b><span data-k="gaitsub"></span></div>
      <div class="rm-toast" role="status" aria-live="polite" hidden></div>
      <section class="rm-earth" role="alert" hidden></section>
      <div class="rm-hint" data-k="hint"></div>
      <div class="rm-captions" role="log" aria-label="Sound captions" hidden></div>
      <div class="rm-touch" aria-hidden="true">
        <div class="rm-stick"><i></i></div>
        <button class="rm-btn rm-lope" data-touch="lope">Lope</button>
        <button class="rm-btn rm-jump" data-touch="jump">Jump</button>
        <button class="rm-btn rm-use" data-touch="use">Hold</button>
      </div>
      <div class="rm-intro panel" role="dialog" aria-label="Free roam">
        <p class="eyebrow">// Free roam · ${esc(name)}</p>
        <div class="rm-intro-goal">${this.introGoal()}</div>
        <p>You have just climbed out of the rover through its rear suitport, onto the real 1 m HiRISE terrain. Gravity is 0.38 of Earth's: you weigh ${Math.round(DEFAULT_PARAMS.massKg * MARS_WALKER.g)} N with suit and tools instead of ${Math.round(DEFAULT_PARAMS.massKg * EARTH_G).toLocaleString("en")} N, but you still have all ${DEFAULT_PARAMS.massKg} kg of mass to start, stop and turn — and only 38 % of the grip.</p>
        <ul class="rm-keys">
          <li class="touch">Left thumb stick: walk · drag the view: look · <b>Lope</b> and <b>Jump</b> buttons on the right</li>
          <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk <span>(arrows too)</span></li>
          <li><kbd>Shift</kbd> lope — bound like the Apollo crews; above ${vRun.toFixed(1)} m/s a walk turns into one anyway</li>
          <li><kbd>Space</kbd> jump</li>
          <li><kbd>Mouse</kbd> look (click the view to lock the pointer, Esc to free it) · <kbd>Scroll</kbd> zoom</li>
          <li><kbd>E</kbd> (hold) sample at a stop, climb in, or take a field reading anywhere · <kbd>R</kbd> relay mast · <kbd>G</kbd> gold sun visor</li>
          <li><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> map, 3D, visor (inside the helmet) · <kbd>M</kbd> sound · <kbd>H</kbd> help</li>
        </ul>
        <p class="fine">Terrain, Sun, Earth and moons are real for this site and date. The suit and body numbers are demo assumptions (Help lists them).</p>
        <button class="primary big" data-act="go">Step outside →</button>
      </div>`;
  }

  /** Back to the planner as the same astronaut, in the same crew session. */
  private backLink(): string {
    return `${this.member === "ev2" ? "&crew=ev2" : ""}${sessionParam(this.hab.session)}`;
  }

  /** The intro's heading and goal: EV2, a mission (handed over, or routed once the route is ready), or a free walk. */
  private introGoal(): string {
    const p = this.plan;
    return `<h2>${this.member === "ev2" ? "You are EV2" : p ? "Walk your plan" : "Walk on Mars"}</h2>
      ${this.member === "ev2" ? `<p class="rm-goal">EV1 runs this EVA on another device. You climb out of the other suitport, see EV1's suit, and walk EV1's mission with them; EV1 sees you. Stay within ${DEFAULT_PARAMS.buddyMaxSeparationM} m of each other.</p>` : ""}
      ${p ? `<p class="rm-goal">Mission: reach ${p.stops.length} ${p.stops.length === 1 ? "stop" : "stops"} in order (${p.stops.map((s) => esc(s.short)).join(" → ")}), hold <kbd>E</kbd> at each to collect a sample, then climb back into the rover. The planner says ${fmtDur(p.planned.timeS)} and ${Math.round(p.planned.o2L)} L of oxygen — can you match it?</p>`
        : `<p class="rm-goal">No plan: walk where you like. The <b>Field work</b> list gives you jobs on the way — readings, minerals, the rover's route, the relay mast.</p>`}`;
  }

  private bind(): void {
    const canvas = this.view.renderer.domElement;
    this.host.addEventListener("click", (ev) => {
      const el = ev.target as HTMLElement;
      const look = el.closest<HTMLElement>("button[data-look]")?.dataset.look as RoamLook | undefined;
      if (look) return this.setLook(look);
      const act = el.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "go") {
        this.stepOutside();
      } else if (act === "menu") dissolveTo(`?site=${encodeURIComponent(this.site.id)}&menu=1`);
      else if (act === "planner") dissolveTo(`?site=${encodeURIComponent(this.site.id)}&skip=1${this.backLink()}`);
      else if (act === "sound") this.toggleSound();
      else if (act === "help") this.help();
      else if (act === "settings") this.openSettings();
      else if (act === "mast") this.toggleMast();
      else if (act === "field-all") {
        this.fieldAll = !this.fieldAll;
        this.renderField();
      } else if (act === "field") {
        this.fieldOpen = !this.fieldOpen;
        this.renderField();
      }
    });
    window.addEventListener("keydown", (ev) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (!$("#modal").hidden) return;
      const k = normKey(ev.key);
      const a = actionOf(this.settings.keys, ev.key);
      this.audio.start();
      if (a === "jump") {
        ev.preventDefault();
        if (!ev.repeat) this.jumpQueued = true;
        this.stepOutside();
      } else if (a === "visor") {
        if (!ev.repeat) this.goldVisor();
      } else if (a === "mast") {
        if (!ev.repeat) this.toggleMast();
      } else if (a) {
        ev.preventDefault();
        this.keys.add(a);
        if (a !== "lope" && a !== "use") this.stepOutside();
      } else if (k === "1" || k === "2" || k === "3") this.setLook(LOOKS[Number(k) - 1][0]);
      else if (k === "v") this.setLook(LOOKS[(LOOKS.findIndex((l) => l[0] === this.look) + 1) % 3][0]);
      else if (k === "m") this.toggleSound();
      else if (k === "h" || k === "?") this.help();
      else if (k === ",") this.openSettings();
      else if (k === "Enter") this.stepOutside();
    });
    window.addEventListener("keyup", (ev) => {
      const a = actionOf(this.settings.keys, ev.key);
      if (a) this.keys.delete(a);
    });
    window.addEventListener("blur", () => this.keys.clear());
    // a different plan in the address (edited, or a link opened in this tab): start again with it
    window.addEventListener("hashchange", () => location.reload());

    // looking around: pointer lock on a mouse, drag as a fallback and on touch screens
    canvas.addEventListener("click", () => {
      if (this.look !== "plan" && matchMedia("(pointer: fine)").matches && document.pointerLockElement !== canvas) {
        try {
          (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); // refused: dragging still works
        } catch {
          // no pointer lock here: dragging still works
        }
      }
    });
    document.addEventListener("mousemove", (ev) => {
      if (document.pointerLockElement !== canvas) return;
      this.turn(ev.movementX, ev.movementY);
    });
    document.addEventListener("pointerlockchange", () => this.hint());
    canvas.addEventListener("pointerdown", (ev) => {
      if (document.pointerLockElement === canvas) return;
      this.drag = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
      canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener("pointermove", (ev) => {
      if (!this.drag || this.drag.id !== ev.pointerId) return;
      this.turn((ev.clientX - this.drag.x) * 1.4, (ev.clientY - this.drag.y) * 1.4);
      this.drag = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
    });
    const end = (ev: PointerEvent) => {
      if (this.drag?.id === ev.pointerId) this.drag = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (ev) => {
      ev.preventDefault();
      const k = Math.exp(ev.deltaY * 0.0012);
      if (this.look === "orbit") this.chaseDist = THREE.MathUtils.clamp(this.chaseDist * k, 2.2, 60);
      else if (this.look === "plan") this.mapHeight = THREE.MathUtils.clamp(this.mapHeight * k, 25, 2600);
    }, { passive: false });

    // touch: a thumb stick on the left, jump and lope buttons on the right
    const stick = this.host.querySelector<HTMLElement>(".rm-stick")!;
    const knob = stick.querySelector<HTMLElement>("i")!;
    stick.addEventListener("pointerdown", (ev) => {
      stick.setPointerCapture(ev.pointerId);
      const r = stick.getBoundingClientRect();
      this.stick = { id: ev.pointerId, x0: r.left + r.width / 2, y0: r.top + r.height / 2 };
      this.audio.start();
      this.stepOutside();
    });
    stick.addEventListener("pointermove", (ev) => {
      if (!this.stick || ev.pointerId !== this.stick.id) return;
      const r = stick.clientWidth / 2;
      let dx = (ev.clientX - this.stick.x0) / r;
      let dy = (ev.clientY - this.stick.y0) / r;
      const l = Math.hypot(dx, dy);
      if (l > 1) {
        dx /= l;
        dy /= l;
      }
      this.touch.x = dx;
      this.touch.y = -dy;
      knob.style.transform = `translate(${dx * r * 0.6}px, ${dy * r * 0.6}px)`;
    });
    const release = () => {
      this.stick = null;
      this.touch.x = 0;
      this.touch.y = 0;
      knob.style.transform = "";
    };
    stick.addEventListener("pointerup", release);
    stick.addEventListener("pointercancel", release);
    for (const b of this.host.querySelectorAll<HTMLButtonElement>("[data-touch]")) {
      if (b.dataset.touch === "use") {
        const up = () => (this.touchHold = false);
        b.addEventListener("pointerup", up);
        b.addEventListener("pointercancel", up);
        b.addEventListener("pointerleave", up);
      }
      b.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        this.audio.start();
        if (b.dataset.touch === "use") this.touchHold = true;
        else if (b.dataset.touch === "jump") this.jumpQueued = true;
        else {
          this.touch.lope = !this.touch.lope;
          b.classList.toggle("on", this.touch.lope);
        }
      });
    }
  }

  private turn(dx: number, dy: number): void {
    if (this.look === "plan") return;
    this.yaw += dx * 0.0026;
    // in a suit the helmet is fixed to the torso: the eyes can tilt only so far inside it (≈ 45° down, 40° up)
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * 0.0022, this.look === "walk" ? -0.78 : -1.2, this.look === "walk" ? 0.7 : 0.35);
  }

  private setLook(look: RoamLook): void {
    this.look = look;
    this.host.dataset.look = look;
    for (const b of this.host.querySelectorAll<HTMLElement>("[data-look]")) b.classList.toggle("on", b.dataset.look === look);
    if (look === "orbit" && this.pitch > -0.1) this.pitch = -0.32;
    if (look === "walk") this.pitch = Math.max(-0.5, Math.min(0.3, this.pitch));
    this.view.setRoamNear(look === "walk" ? 0.05 : 0);
    if (look === "plan" && document.pointerLockElement) document.exitPointerLock();
    this.view.setRoamLook(look);
    this.avatar.firstPerson(look === "walk");
    this.audio.setPerspective(look === "walk" ? "inside" : look === "plan" ? "far" : "outside");
    this.host.classList.toggle("gold", look === "walk" && this.gold);
    if (this.started && !this.heardTold) {
      this.heardTold = true;
      this.toast(look === "walk" ? "Inside the helmet: your fan, your breathing, your footsteps through the boots." : "Outside: Mars is quiet. Thin CO₂ air carries little sound — wind, and dull footsteps.");
    }
    this.camInit = false;
    this.hint();
  }

  private hint(): void {
    const locked = !!document.pointerLockElement;
    const touch = matchMedia("(pointer: coarse)").matches;
    const text =
      this.look === "plan"
        ? touch ? "Stick to walk · map is north-up" : "<b>WASD</b> walk (north is up) · <b>Scroll</b> zoom · <b>3</b> visor"
        : touch ? "Stick to walk · drag to look" : locked ? "<b>WASD</b> walk · <b>Shift</b> lope · <b>Space</b> jump · <b>Esc</b> free the mouse" : "<b>Click</b> the view to look with the mouse · <b>WASD</b> walk · <b>Space</b> jump";
    this.host.querySelector<HTMLElement>("[data-k=hint]")!.innerHTML = text;
  }

  private gold = false;
  private started = false;

  /** The gold-coated sun visor: cuts glare and heat; tints the world gold. */
  private goldVisor(): void {
    this.gold = !this.gold;
    this.host.classList.toggle("gold", this.look === "walk" && this.gold);
    if (this.look === "walk") this.toast(this.gold ? "Gold sun visor down: it blocks most visible light and infrared." : "Sun visor up.");
  }

  /** Out of the suitport: the walk starts (sound, the hab's EVA, the first message), whatever started it. */
  private stepOutside(): void {
    if (this.started) return;
    this.host.querySelector(".rm-intro")?.remove();
    this.audio.start();
    this.started = true;
    this.hab.start(this.lightTimeS);
    this.hab.note(this.t, "go", this.plan ? `Left the rover on foot to walk the plan: ${this.stops.map((x) => x.short).join(", ")}` : "Left the rover on foot (free roam)");
    if (this.tau > 1) {
      const de = dustEffect(this.tau, 30);
      this.toast(`<b>Dust storm:</b> τ ${this.tau.toFixed(1)} (${esc(this.dustName)}). Sunlight about ${Math.round(de.sunlight * 100)} % of a clear day, dark landmarks fade at ${fmtVisibility(de.visibilityM)}. Navigate by the compass and the beacons over the stops (visor).`, true);
    } else this.toast("Outside. The rover is behind you; its suitports are on the rear wall. <b>WASD</b> to walk, <b>Shift</b> to lope, <b>Space</b> to jump.");
  }

  /** Settings: rebind keys, calm the camera, captions for sound cues. */
  private openSettings(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    const st = this.settings;
    const body = () => `<table class="keys rm-binds">${ACTIONS.map((a) => `<tr><td>${a.label}</td><td><button data-bind="${a.id}">${this.binding === a.id ? "Press a key…" : esc(keyName(st.keys[a.id]))}</button></td></tr>`).join("")}
        <tr><td>Arrows</td><td>always walk</td></tr></table>
      <p class="rm-set-row"><button data-reset>Reset keys</button></p>
      <label class="rm-check"><input type="checkbox" data-opt="reduceShake" ${st.reduceShake ? "checked" : ""}/> Reduce camera shake <small>(no head bob or dip on footsteps in the visor; on by default when your system asks for reduced motion)</small></label>
      <label class="rm-check"><input type="checkbox" data-opt="captions" ${st.captions ? "checked" : ""}/> Captions for sound cues <small>(radio tones, breathing, heartbeat, footsteps, hiss, wind)</small></label>
      <p class="fine">Kept in this browser only.</p>`;
    openModal("Free roam settings", `<div class="rm-settings">${body()}</div>`, false);
    const box = $("#modal").querySelector<HTMLElement>(".rm-settings")!;
    const redraw = () => (box.innerHTML = body());
    box.addEventListener("click", (ev) => {
      const el = ev.target as HTMLElement;
      const b = el.closest<HTMLElement>("[data-bind]");
      if (b) {
        this.binding = b.dataset.bind as Action;
        redraw();
        const take = (kev: KeyboardEvent) => {
          kev.preventDefault();
          kev.stopImmediatePropagation();
          window.removeEventListener("keydown", take, true);
          const action = this.binding!;
          this.binding = null;
          if (kev.key !== "Escape") {
            const next = rebind(st.keys, action, kev.key);
            if (next) st.keys = next;
            else this.toast(`${esc(keyName(normKey(kev.key)))} is used for something else.`, true);
          }
          saveSettings(st);
          redraw();
        };
        window.addEventListener("keydown", take, true);
      } else if (el.closest("[data-reset]")) {
        st.keys = { ...DEFAULT_KEYS };
        saveSettings(st);
        redraw();
      }
    });
    box.addEventListener("change", (ev) => {
      const el = ev.target as HTMLInputElement;
      const opt = el.dataset.opt as "reduceShake" | "captions" | undefined;
      if (!opt) return;
      st[opt] = el.checked;
      saveSettings(st);
      if (opt === "captions") this.host.querySelector<HTMLElement>(".rm-captions")!.hidden = !el.checked;
    });
  }

  /** One sound cue as a caption line (shown for a few seconds). */
  private caption(text: string): void {
    if (!this.settings.captions) return;
    const box = this.host.querySelector<HTMLElement>(".rm-captions")!;
    box.hidden = false;
    const line = document.createElement("span");
    line.textContent = text;
    box.append(line);
    while (box.children.length > 3) box.firstElementChild!.remove();
    window.setTimeout(() => line.remove(), 4000);
  }

  private toggleSound(): void {
    this.audio.start();
    this.audio.setMuted(!this.audio.muted);
    this.host.querySelector<HTMLElement>("[data-act=sound]")!.innerHTML = this.audio.muted ? ic.voiceOff : ic.voiceOn;
  }

  private help(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    const g = MARS_WALKER.g;
    const j = jumpOf(MARS_WALKER.jumpMs, g);
    const je = jumpOf(MARS_WALKER.jumpMs, EARTH_G);
    openModal(
      "Free roam: controls and physics",
      `<table class="keys">
        <tr><td><kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></td><td>Walk (in the map view, W is north)</td></tr>
        <tr><td><kbd>Shift</kbd></td><td>Lope: a bounding run</td></tr>
        <tr><td><kbd>Space</kbd></td><td>Jump</td></tr>
        <tr><td><kbd>E</kbd> (hold)</td><td>Collect a sample at the next stop; climb back into the rover; anywhere else, a field reading (1 min of work)</td></tr>
        <tr><td><kbd>R</kbd></td><td>Stand up the relay mast (it must see the rover from its ${RELAY_MAST_M} m top), or pack it up (2 min of work)</td></tr>
        <tr><td><kbd>G</kbd></td><td>Lower or raise the gold sun visor (visor view)</td></tr>
        <tr><td><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>V</kbd></td><td>Map, 3D (behind you), visor (inside the helmet); V cycles</td></tr>
        <tr><td>Mouse / drag</td><td>Look around; scroll zooms the map and 3D views</td></tr>
        <tr><td><kbd>M</kbd> <kbd>H</kbd> <kbd>,</kbd></td><td>Sound, this help, settings (rebind keys, calmer camera, captions)</td></tr>
      </table>
      <h3>What you feel, and why</h3>
      <ul class="rm-why">
        <li><b>Slow to start and stop.</b> Feet push only as hard as friction allows: μ·g = ${(MARS_WALKER.mu * g).toFixed(1)} m/s² on Mars against ${(MARS_WALKER.mu * EARTH_G).toFixed(1)} m/s² on Earth. Your mass is the same, your grip is 38 %.</li>
        <li><b>No steering in the air.</b> Once your boots leave the ground you follow a ballistic arc. The air (about 0.02 kg/m³) is too thin to matter.</li>
        <li><b>Walking turns into bounding</b> at ${walkRunMs(g, MARS_WALKER.legM).toFixed(2)} m/s (Froude number 0.5), against ${walkRunMs(EARTH_G, MARS_WALKER.legM).toFixed(2)} m/s on Earth.</li>
        <li><b>Jumps:</b> the same push gives ${Math.round(j.heightM * 100)} cm and ${j.airS.toFixed(2)} s in the air, against ${Math.round(je.heightM * 100)} cm and ${je.airS.toFixed(2)} s on Earth.</li>
        <li><b>Slopes:</b> past about ${Math.round((Math.atan(MARS_WALKER.mu) * 180) / Math.PI)}° (${Math.round((Math.atan(MARS_WALKER.muSand) * 180) / Math.PI)}° in loose sand) your boots cannot hold and you slide. Uphill is slower and costs more oxygen.</li>
        <li><b>Oxygen, heart and breathing</b> follow the planner's walking model (Minetti), so the numbers match a planned EVA. Work at a stop runs the clock forward by the planned time on site, at the working rate.</li>
        <li><b>Sound:</b> in the visor you hear your suit — fan, breathing in the bubble, footsteps through the boots, your heart. Outside (3D, map) you hear what a microphone on the ground would: wind and faint, dull footsteps. Mars' thin CO₂ air carries sound poorly and high pitches least (Perseverance's microphones).</li>
        <li><b>In a suit the helmet turns with the body:</b> in the visor view your body turns to face where you look, and you see your own arms and boots.</li>
      </ul>
      <h3>Field work</h3>
      <ul class="rm-why">
        <li><b>Field readings</b> show what the orbital maps say about the ground at your boots: CAIRN's sand and slope maps from HiRISE, the USGS geologic unit, how much sky the terrain blocks (the storm's shielding map) and, where CRISM imaged, mineral strength (18 m pixels). A real crew would carry a handheld spectrometer; here the reading comes from the orbital data.</li>
        <li><b>Finds</b> plant a survey flag and go into the crew log, so Mission Control reads them one light time later.</li>
        <li><b>The rover's route</b> joins the rover's logged stops in straight lines; its real wheel tracks wander around that line.</li>
      </ul>
      <h3>Practise an emergency</h3>
      <p class="rm-practice">${this.emergency ? `Under way: ${this.emergency.kind === "leak" ? "suit leak" : "twisted ankle"}.` : `<button data-practice="leak">Suit leak</button><button data-practice="ankle">Twisted ankle</button>`} The rule is the same as in the planner: stop the science and go home now.</p>
      <h3>Numbers used</h3>
      <table class="keys">${WALKER_NOTES.map((n) => `<tr><td>${esc(n.label)}</td><td><b>${esc(n.value)}</b> — ${esc(n.basis)}</td></tr>`).join("")}</table>`,
      false,
    );
    $("#modal").querySelectorAll<HTMLButtonElement>("[data-practice]").forEach((b) =>
      b.addEventListener("click", () => {
        $("#modal").hidden = true;
        this.startEmergency(b.dataset.practice as "leak" | "ankle");
      }),
    );
  }

  private toast(text: string, warn = false): void {
    const el = this.host.querySelector<HTMLElement>(".rm-toast")!;
    el.innerHTML = text;
    el.classList.toggle("warn", warn);
    el.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (el.hidden = true), warn ? 5200 : 6500);
    this.audio.beep(warn);
  }

  /** A lesson once per session: the first jump, the first lope, the first slide… */
  private once(key: string, text: string, warn = false): void {
    if (this.told.has(key)) return;
    this.told.add(key);
    this.toast(text, warn);
  }

  // ================================================================ frame
  tick(dt: number): void {
    const s = this.walker;
    if (this.choosing) {
      // the clock waits while the crew picks a target; only the view moves
      const feet = this.view.toWorld(s.x, s.y, s.z);
      this.camera(dt, feet);
      this.view.invalidate();
      return;
    }
    const input = this.input();
    if (this.emergency?.kind === "ankle") {
      // weight off the bad foot: half the pace, no bounding, no jumping
      input.x *= 0.5;
      input.y *= 0.5;
      input.lope = false;
      input.jump = false;
    }
    const o2Before = s.o2L;
    const events = stepWalker(s, input, this.ground, dt, DEFAULT_PARAMS, MARS_WALKER);
    if (this.emergency?.kind === "leak") s.o2L += s.o2L - o2Before; // oxygen leaves twice as fast
    if (this.scheduled && this.started && this.t >= this.scheduled.atS) {
      const k = this.scheduled.kind;
      this.scheduled = null;
      this.startEmergency(k);
    }
    this.jumpQueued = false;
    this.collideRover();
    if (this.look === "walk" && s.gait !== "down") {
      // in a suit the helmet is fixed to the torso: to look somewhere, the body turns
      let d = this.yaw - s.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      s.heading += d * Math.min(1, dt * 8);
    }
    if (!this.finished) this.t += dt;
    for (const e of events) this.onEvent(e);
    this.useHold(dt);
    if (this.plan) this.mission(dt);
    this.fieldTick(dt);
    if (this.started && !this.finished) this.hab.frame(dt, this.frameNow());
    if (this.started) this.hab.pose(dt, this.selfPose());
    this.updateBuddy(dt);

    const feet = this.view.toWorld(s.x, s.y, s.z);
    const groundY = this.view.groundAt(feet.x, feet.z);
    this.avatar.update(s, feet, dt, this.landKick, this.look === "plan");
    this.landKick = 0;
    this.shadow.mesh.visible = true;
    this.shadow.place(feet, groundY, this.sunDir);
    if (this.tau > 1) this.dust.drift(feet, this.wind, Math.min(this.quality === "low" ? 60 : 260, (this.tau - 0.8) * 30), dt);
    this.watchFrames(dt);
    this.dust.update(dt);
    if (this.look === "plan" || s.grounded) this.trail.push(feet);
    this.trail.line.visible = this.look === "plan";
    this.camera(dt, feet);
    this.updateSky(false);
    this.view.invalidate();

    const effort01 = THREE.MathUtils.clamp((s.effortW - DEFAULT_PARAMS.restingW) / 700, 0, 1);
    this.audio.update(dt, breathsPerMin(s.effortW, DEFAULT_PARAMS.restingW), heartRate(s.effortW, DEFAULT_PARAMS.restingW), effort01);
    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = 0.1;
      this.hud(effort01);
    }
  }

  private input(): { x: number; y: number; lope: boolean; jump: boolean } {
    const k = this.keys;
    let f = (k.has("forward") ? 1 : 0) - (k.has("back") ? 1 : 0);
    let r = (k.has("right") ? 1 : 0) - (k.has("left") ? 1 : 0);
    if (this.stick) {
      f = this.touch.y;
      r = this.touch.x;
    }
    const l = Math.hypot(f, r);
    if (l > 1) {
      f /= l;
      r /= l;
    }
    const yaw = this.look === "plan" ? 0 : this.yaw;
    // forward along the camera's heading (clockwise from north), right 90° clockwise of it
    const x = Math.sin(yaw) * f + Math.cos(yaw) * r;
    const y = Math.cos(yaw) * f - Math.sin(yaw) * r;
    return { x, y, lope: k.has("lope") || this.touch.lope, jump: this.jumpQueued };
  }

  /** The rover is solid: a box around its hull (front toward east); push the walker out the nearest side. */
  private collideRover(): void {
    const s = this.walker;
    const pad = 0.3; // the suit's own half-width
    const hx = ROVER_HALF.x + pad;
    const hy = ROVER_HALF.z + pad;
    const dx = s.x - this.rover.x;
    const dy = s.y - this.rover.y;
    if (Math.abs(dx) >= hx || Math.abs(dy) >= hy) return;
    const px = hx - Math.abs(dx);
    const py = hy - Math.abs(dy);
    let nx = 0;
    let ny = 0;
    if (px < py) {
      nx = Math.sign(dx) || 1;
      s.x = this.rover.x + nx * hx;
    } else {
      ny = Math.sign(dy) || 1;
      s.y = this.rover.y + ny * hy;
    }
    const vn = s.vx * nx + s.vy * ny;
    if (vn < 0) {
      s.vx -= vn * nx;
      s.vy -= vn * ny;
    }
    if (s.grounded) s.z = this.ground.height(s.x, s.y);
  }

  private normalAt(x: number, y: number): THREE.Vector3 {
    const g = this.ground;
    const dx = (g.height(x + 0.5, y) - g.height(x - 0.5, y)) / 1;
    const dy = (g.height(x, y + 0.5) - g.height(x, y - 0.5)) / 1;
    // local (x east, y north, z up) → world (X east, Y up, Z south)
    return new THREE.Vector3(-dx, 1, dy).normalize();
  }

  private print(x: number, y: number, heading: number, side: number, sand: number): void {
    const ox = Math.cos(heading) * 0.13 * side;
    const oy = -Math.sin(heading) * 0.13 * side;
    const px = x + ox;
    const py = y + oy;
    this.prints.add(this.view.toWorld(px, py, this.ground.height(px, py)), heading, this.normalAt(px, py), sand);
  }

  private onEvent(e: WalkEvent): void {
    const s = this.walker;
    const vel = new THREE.Vector3(s.vx, 0, -s.vy);
    if (e.kind === "step") {
      this.print(e.x, e.y, e.heading, e.foot === 0 ? -1 : 1, e.sand);
      this.dust.kick(this.view.toWorld(e.x, e.y, this.ground.height(e.x, e.y)), vel, 0.8 + e.speed * 0.4, e.sand);
      this.audio.step(0.8 + e.speed * 0.5, e.sand);
      this.avatar.addDust(0.0004 * (1 + e.sand) * (1 + Math.max(0, this.tau - CLEAR_TAU) / 3));
      this.camDip = Math.max(this.camDip, 0.012);
    } else if (e.kind === "land") {
      this.print(e.x, e.y, s.heading, -1, e.sand);
      this.print(e.x, e.y, s.heading, 1, e.sand);
      const power = 1 + e.impactMs * 0.9;
      this.dust.kick(this.view.toWorld(e.x, e.y, this.ground.height(e.x, e.y)), vel, power, e.sand);
      this.audio.step(power, e.sand);
      this.landKick = e.impactMs;
      this.camDip = Math.max(this.camDip, Math.min(0.25, 0.02 + e.impactMs * 0.04));
      this.avatar.addDust(e.fell ? 0.25 : 0.002 * (1 + e.impactMs));
      if (e.fell) {
        this.falls++;
        this.decided(`Fell at ${e.impactMs.toFixed(1)} m/s; checked the suit and got up`);
      }
      else if (e.hard) this.hardLandings++;
      if (e.fell) {
        this.toast(`<b>Down.</b> You hit the ground at ${e.impactMs.toFixed(1)} m/s and topple onto your hands — slowly: a fall takes ${toppleTime(MARS_WALKER.g).toFixed(1)} s on Mars, ${toppleTime(EARTH_G).toFixed(1)} s on Earth. Getting up in a pressurised suit takes about ${MARS_WALKER.getUpS} s: sit back, one knee up, push.`, true);
      } else if (e.hard) {
        this.toast(`<b>Hard landing:</b> ${e.impactMs.toFixed(1)} m/s into the ground. On Earth the same drop would hit at ${(e.impactMs * Math.sqrt(EARTH_G / MARS_WALKER.g)).toFixed(1)} m/s.`, true);
      } else if (e.jump) {
        const j = e.heightM;
        const earthH = j * (MARS_WALKER.g / EARTH_G);
        const earthT = e.airS * (MARS_WALKER.g / EARTH_G);
        const first = !this.told.has("jump");
        this.told.add("jump");
        if (first || j > 0.05) this.toast(`<b>Jump:</b> ${Math.round(j * 100)} cm up, ${e.airS.toFixed(2)} s in the air${e.distM > 0.3 ? `, ${e.distM.toFixed(1)} m forward` : ""}. The same push on Earth: ${Math.round(earthH * 100)} cm, ${earthT.toFixed(2)} s.`);
      }
    } else if (e.kind === "takeoff" && !e.jump) {
      this.once("lope", `<b>Loping.</b> Above ${walkRunMs(MARS_WALKER.g, MARS_WALKER.legM).toFixed(1)} m/s a walk becomes a series of bounds on Mars (on Earth people switch at ${walkRunMs(EARTH_G, MARS_WALKER.legM).toFixed(1)} m/s). You cannot steer while in the air.`);
    } else if (e.kind === "slide") {
      this.avatar.addDust(0.08);
      if (e.slopeDeg > 8) this.decided(`Slid on a ${Math.round(e.slopeDeg)}° slope`);
      if (e.slopeDeg > 8) this.toast(`<b>Sliding:</b> ${Math.round(e.slopeDeg)}° is steeper than the boots can hold on this ground: sit down, slide feet first and brake with your hands. Lean (WASD) to steer.`, true);
    } else if (e.kind === "up") {
      this.toast("Back on your feet.");
    } else if (e.kind === "edge" && this.t - this.lastEdge > 6) {
      this.lastEdge = this.t;
      this.toast("Edge of the 1 m HiRISE elevation map: the terrain beyond is only known at 20 m, too coarse to walk on.", true);
    }
  }

  // ================================================================ camera
  private camera(dt: number, feet: THREE.Vector3): void {
    const s = this.walker;
    this.camDip = Math.max(0, this.camDip - dt * 0.5);
    if (this.look === "walk") {
      // the eye rides on the body: real ballistic height in a jump, a dip on each footfall
      const eye = this.avatar.eyeWorld();
      if (!this.settings.reduceShake) eye.y -= this.camDip;
      const sway = s.gait === "walk" && !this.settings.reduceShake ? Math.sin(s.phase) * 0.02 : 0;
      eye.x += Math.cos(this.yaw) * sway;
      eye.z += Math.sin(this.yaw) * sway;
      if (!this.camInit) this.smoothEye.copy(eye);
      // a helmet is not a gimbal: the view lags the body by a few hundredths of a second
      this.smoothEye.lerp(eye, Math.min(1, dt * 22));
      const cp = Math.cos(this.pitch);
      const look = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
      // tumbling: the view goes where the helmet faces
      const w = this.avatar.poseWeight;
      if (w > 0) look.lerp(this.avatar.faceWorld(), w).normalize();
      if (Math.abs(look.y) > 0.995) look.x += 0.02;
      const target = this.smoothEye.clone().add(look);
      this.view.setRoamCamera(this.smoothEye, target, 70);
    } else if (this.look === "orbit") {
      // follow the body itself, so a fall or a slide stays in the middle of the view
      const centre = this.avatar.centreWorld();
      if (!this.camInit) this.smoothFocus.copy(centre);
      this.smoothFocus.lerp(centre, Math.min(1, dt * 6));
      const focus = this.smoothFocus.clone();
      focus.y += 0.15;
      const cp = Math.cos(this.pitch);
      const want = focus.clone().add(new THREE.Vector3(-Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp).multiplyScalar(this.chaseDist));
      const floor = this.view.groundAt(want.x, want.z) + 0.6;
      if (want.y < floor) want.y = floor;
      // never inside the rover: over its hull, lift the camera above the roof
      const rv = this.view.toWorld(this.rover.x, this.rover.y, this.ground.height(this.rover.x, this.rover.y));
      const nearX = ROVER_HALF.x + 2.2 - Math.abs(want.x - rv.x);
      const nearZ = ROVER_HALF.z + 2.2 - Math.abs(want.z - rv.z);
      if (nearX > 0 && nearZ > 0) want.y = Math.max(want.y, rv.y + 3.6 + Math.min(1.5, Math.min(nearX, nearZ)) * 1.2); // rise over the roof as it comes close
      if (!this.camInit) this.smoothCam.copy(want);
      this.smoothCam.lerp(want, Math.min(1, dt * 8));
      this.view.setRoamCamera(this.smoothCam, focus, 55);
    } else {
      const want = feet.clone();
      want.y += this.mapHeight;
      want.z += this.mapHeight * 0.002; // north-up
      if (!this.camInit) this.smoothCam.copy(want);
      this.smoothCam.lerp(want, Math.min(1, dt * 6));
      const target = this.smoothCam.clone();
      target.y -= this.mapHeight;
      target.z -= this.mapHeight * 0.002;
      this.view.setRoamCamera(this.smoothCam, target, 30);
    }
    this.camInit = true;
  }

  // ================================================================ sky and clock
  private lmst(): number {
    return this.startLmst + this.t / MARS_HOUR_S;
  }

  private updateSky(force: boolean): void {
    const sec = Math.floor(this.t);
    if (!force && sec === this.lastSky) return;
    this.lastSky = sec;
    const sun = sunAt(this.lat, this.lmst(), this.solar);
    this.view.setSun(sun.elevation, sun.azimuth);
    const el = THREE.MathUtils.degToRad(sun.elevation);
    const az = THREE.MathUtils.degToRad(sun.azimuth);
    this.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
    const utc = utcAtLmst(this.solUtc, lmstAtUtc(this.solUtc, this.lon), this.startLmst) + this.t * 1000;
    const sky = marsSky(utc, this.lat, this.lon);
    this.realLightTimeS = sky.lightTimeS;
    this.lightTimeS = linkDelay(sky.lightTimeS);
    const km = (b: { distanceKm: number }) => `${Math.round(b.distanceKm).toLocaleString("en")} km`;
    this.view.setSkyBodies({
      earth: { dir: sky.earth.dir, sizeDeg: sky.earth.sizeDeg, caption: `${fmtLightTime(sky.lightTimeS)} by radio` },
      phobos: { dir: sky.phobos.dir, sizeDeg: sky.phobos.sizeDeg, caption: km(sky.phobos) },
      deimos: { dir: sky.deimos.dir, sizeDeg: sky.deimos.sizeDeg, caption: km(sky.deimos) },
    });
    const s = this.walker;
    const direct = inContact(this.radio, this.site.grid, s.x, s.y);
    this.contact = direct || (this.mast !== null && inContact(this.mast.shadow, this.site.grid, s.x, s.y));
    if (!direct && this.contact && !this.field.relayUsed && this.started) {
      this.field.relayUsed = true;
      this.found([{ id: "relay", title: "Talking through the relay", text: "The rover is out of sight, but the mast relays your radio. Mission Control keeps hearing you.", t: this.t, x: s.x, y: s.y }]);
    }
    this.renderLink(); // once a second: the other astronaut's distance
    this.checkStops();
  }

  private checkStops(): void {
    const s = this.walker;
    for (const p of this.site.pois) {
      if (p.kind === "shelter" || this.visited.has(p.id)) continue;
      if (Math.hypot(p.x - s.x, p.y - s.y) < 14) {
        this.visited.add(p.id);
        if (!this.plan) this.renderMission();
        const first = p.description.split(/(?<=\.)\s/)[0];
        if (!this.plan) this.toast(`<b>${esc(p.name)}</b> — ${esc(first)}`);
      }
    }
  }

  // ================================================================ readouts
  private hud(effort01: number): void {
    const s = this.walker;
    const p = DEFAULT_PARAMS;
    const set = (k: string, v: string) => {
      const el = this.host.querySelector<HTMLElement>(`[data-k=${k}]`);
      if (el && el.innerHTML !== v) el.innerHTML = v;
    };
    const left = Math.max(0, p.o2SupplyL - s.o2L);
    const usable = Math.max(0, left - p.o2SupplyL * p.reserveFraction);
    const lps = s.effortW / (p.kJPerLitreO2 * 1000);
    set("o2", `${Math.round((left / p.o2SupplyL) * 100)} %`);
    set("o2t", `${Math.round(left)} L · ${fmtDur(usable / lps)} to reserve`);
    (this.host.querySelector<HTMLElement>("[data-k=o2bar]")!).style.width = `${(left / p.o2SupplyL) * 100}%`;
    const bpm = heartRate(s.effortW, p.restingW);
    set("hr", `${Math.round(bpm)} <small>bpm</small>`);
    set("br", `${Math.round(breathsPerMin(s.effortW, p.restingW))} breaths/min`);
    set("pw", `${Math.round(s.powerW)} <small>W</small>`);
    set("kcal", `${Math.round(s.energyJ / 4184)} kcal · ${(s.o2L).toFixed(1)} L O₂ used`);
    const speed = Math.hypot(s.vx, s.vy);
    set("sp", `${speed.toFixed(2)} <small>m/s</small>`);
    set("gait", `${(speed * 3.6).toFixed(1)} km/h`);
    set("slope", `${Math.round(s.slopeDeg)}°`);
    set("ground", s.sand > 0.5 ? "loose sand" : s.sand > 0.2 ? "sandy" : "firm ground");
    const dr = Math.hypot(this.rover.x - s.x, this.rover.y - s.y);
    const brg = (Math.atan2(this.rover.x - s.x, this.rover.y - s.y) * 180) / Math.PI;
    set("rover", fmtDist(dr));
    set("radio", `${compass(brg)} · ${this.contact ? "radio contact" : '<em class="bad">no radio</em>'}`);
    const sun = sunAt(this.lat, this.lmst(), this.solar);
    set("time", fmtLmst(this.lmst()));
    const de = dustEffect(this.tau, Math.max(5, sun.elevation));
    set("sun", this.tau > 1 ? `τ ${this.tau.toFixed(1)} · light ${Math.round(de.sunlight * 100)} % · ${fmtVisibility(de.visibilityM)}` : `Sun ${Math.round(sun.elevation)}° ${compass(sun.azimuth)}`);
    set("dist", fmtDist(s.distM));
    set("steps", `${s.steps.toLocaleString("en")} steps · ${Math.round(s.climbM)} m up`);
    const air = s.air;
    const [big, sub] =
      // a lope is a series of short bounds: no flashing "In the air" / "Loping" while bounding, only for a real jump
      s.gait === "air" && !s.bounding ? ["In the air", air ? `${air.t.toFixed(2)} s · ${Math.round(Math.max(0, s.z - air.z0) * 100)} cm up` : ""]
      : s.gait === "air" || s.gait === "lope" ? ["", ""]
      : s.gait === "walk" ? ["", ""]
      : s.gait === "slide" ? ["Sliding", `${Math.round(s.slopeDeg)}° — too steep to hold`]
      : s.gait === "down" ? (s.sliding ? ["Down", "sliding to steadier ground"] : ["Down", `getting up · ${s.downT.toFixed(1)} s`])
      : ["", ""];
    set("gaitbig", big);
    set("gaitsub", sub);
    this.host.querySelector(".rm-gait")!.classList.toggle("on", !!big);
    this.host.querySelector(".rm-gait")!.classList.toggle("warn", s.gait === "slide" || s.gait === "down");
    // the visor fogs a little at the edges when breathing hard
    this.host.style.setProperty("--fog", (effort01 * 0.9).toFixed(2));
    this.host.style.setProperty("--o2", String(left / p.o2SupplyL));
    // compass strip: the camera heading in the 3D views, the body's in the map
    const heading = this.look === "plan" ? (s.heading * 180) / Math.PI : (this.yaw * 180) / Math.PI;
    const goal = this.target();
    this.compassStrip(heading, brg, goal && this.next < this.stops.length ? (Math.atan2(goal.x - s.x, goal.y - s.y) * 180) / Math.PI : null);
    if (this.emergency) this.renderEmergency();
    const tg = this.target();
    if (tg && this.plan) {
      const d = Math.hypot(tg.x - s.x, tg.y - s.y);
      const b = (Math.atan2(tg.x - s.x, tg.y - s.y) * 180) / Math.PI;
      set("mdist", `${fmtDist(d)} · ${compass(b)}`);
      set("mclock", `${fmtDur(this.t)} <small>/ ${fmtDur(this.plan.planned.timeS)}</small>`);
      set("mo2", `${Math.round(s.o2L)} L <small>/ ${Math.round(this.plan.planned.o2L)} L</small>`);
      set("moff", this.offM > OFF_ROUTE_M ? `<em class="bad">${Math.round(this.offM)} m</em>` : `${Math.round(this.offM)} m`);
    }
    if (left <= p.o2SupplyL * p.reserveFraction && !this.told.has("reserve")) {
      this.once("reserve", "<b>Oxygen at reserve.</b> Head back to the rover.", true);
      this.decided("Oxygen at the 25 % reserve: turned back for the rover");
    }
  }

  private compassStrip(heading: number, roverBrg: number, goalBrg: number | null = null): void {
    const strip = this.host.querySelector<HTMLElement>(".rm-strip")!;
    const h = ((heading % 360) + 360) % 360;
    const marks: string[] = [];
    for (let d = -90; d <= 90; d += 15) {
      const a = Math.round((h + d) / 15) * 15;
      const off = a - h;
      if (Math.abs(off) > 90) continue;
      const norm = ((a % 360) + 360) % 360;
      const label = norm % 45 === 0 ? COMPASS[norm / 45] : "";
      marks.push(`<i style="left:${50 + (off / 180) * 100}%" class="${label ? "major" : ""}">${label}</i>`);
    }
    let rel = roverBrg - h;
    rel = ((rel + 540) % 360) - 180;
    if (Math.abs(rel) <= 90) marks.push(`<b class="rover" style="left:${50 + (rel / 180) * 100}%" title="Rover">${ic.home}</b>`);
    if (goalBrg !== null) {
      let g = goalBrg - h;
      g = ((g + 540) % 360) - 180;
      const at = Math.max(-90, Math.min(90, g)); // pinned to the edge when it is behind you
      marks.push(`<b class="goal${Math.abs(g) > 90 ? " edge" : ""}" style="left:${50 + (at / 180) * 100}%" title="Next stop">▼</b>`);
    }
    const html = marks.join("");
    if (strip.dataset.h !== html.length + ":" + Math.round(h)) {
      strip.dataset.h = html.length + ":" + Math.round(h);
      strip.innerHTML = html;
    }
  }

  /**
   * Average frame time over a few seconds of walking: if the device cannot keep ~25 frames a second at
   * full quality, offer the lighter version (coarser mesh, 50 cm image, fewer particles), keeping the plan.
   */
  private watchFrames(dt: number): void {
    if (this.quality === "low" || this.slowTold || document.hidden || dt >= 0.1) return;
    this.frameSum += dt;
    if (++this.frameN < 150) return;
    const avg = this.frameSum / this.frameN;
    this.frameSum = 0;
    this.frameN = 0;
    if (avg > 0.04) {
      this.slowTold = true;
      const q = new URLSearchParams(location.search);
      q.set("q", "low");
      this.toast(`Running at ${Math.round(1 / avg)} frames a second. <a href="?${esc(q.toString())}${esc(location.hash)}">Open the lighter version</a> (coarser mesh, fewer particles; your plan stays).`, true);
    }
  }

  /** For the console and tests: `window.cairn.roam.state`. */
  get state(): Readonly<WalkerState> {
    return this.walker;
  }
}
