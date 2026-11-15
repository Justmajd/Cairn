/**
 * The hab link: messages between the planner (the crew), the hab server and Mission Control.
 *
 * The hab server (web/server) is the habitat's computer.  The crew's devices send it their telemetry
 * and log as the EVA runs; Mission Control on Earth sees each item only one light time after it
 * happened on Mars, and what Earth sends reaches the crew one light time after it was sent.  The delay
 * is applied by the server on the EVA clock (which runs faster than real time when the simulation is
 * sped up), so every screen shares one timeline.
 */

export type Role = "crew" | "mc";
/** Which astronaut a crew device is: EV1 runs the EVA (and the plan); EV2 walks with EV1, on its own device. */
export type Member = "ev1" | "ev2";

/** What Mission Control needs to draw the plan. */
export interface PlanInfo {
  site: string;
  siteName: string;
  sizeM: number;
  /** Image of the walk area, relative to the app (e.g. "data/jezero/texture.webp"). */
  image: string;
  route: [number, number][];
  stops: { id: string; name: string; short: string; x: number; y: number; kind: "shelter" | "objective" | "optional"; order: number }[];
  roverName: string;
  startLmst: string;
  distanceM: number;
  timeS: number;
  o2SupplyL: number;
  o2ReserveL: number;
  lightTimeS: number;
  storm: boolean;
  buddy: boolean;
  dust: { tau: number; name: string };
  /** The plan as a link (state/planLink.ts): EV2's device rebuilds exactly the same plan from it. */
  hash?: string;
  /** Where the plan puts the crew over time: [EVA seconds, x, y].  Mission Control's "Earth's best guess". */
  timeline?: [number, number, number][];
  /** Free roam: the real one-way light time, when the link runs on a shortened demo delay (lightTimeS). */
  realLightTimeS?: number;
  /** "roam": the crew is walking it on foot in free roam (physics, not the planner's simulation). */
  mode?: "plan" | "roam";
  /** Free roam: the routed legs, so EV2's device walks exactly the same mission. */
  legs?: [number, number][][];
  /** Free roam: the planner's oxygen estimate for the mission (L), what EV2's debrief scores against. */
  o2PlannedL?: number;
  walkTimeS?: number;
}

/** One astronaut's pose in free roam, sent Mars to Mars with no delay (EV2 → EV1, and EV1 → EV2 in frames). */
export interface CrewPose {
  x: number;
  y: number;
  z: number;
  headingDeg: number;
  gait: string;
  vx: number;
  vy: number;
  vz: number;
  downT?: number;
  sliding?: boolean;
}

/** A change to the plan proposed by Mission Control: stops to drop (ids) and points to add. */
export interface PlanChange {
  drop: string[];
  add: { x: number; y: number }[];
}

/** One telemetry frame from the crew, stamped with the EVA clock `t` (seconds). */
export interface Frame {
  t: number;
  x: number;
  y: number;
  headingDeg: number;
  o2LeftL: number;
  doseUGy: number;
  doseRate: number;
  baseline: number;
  status: string;
  next: string;
  nextDistM: number;
  homeS: number;
  radio: "ok" | "relay" | "lost";
  sheltered: boolean;
  storm: boolean;
  lmst: string;
  sunEl: number;
  lightTimeS: number;
  /** Simulation speed (EVA seconds per real second), 0 when paused. */
  speed: number;
  /** The crew's planner is in a background tab: the browser has stopped its EVA clock. */
  hidden?: boolean;
  /** Buddy (EV2) position, in buddy mode. */
  buddy?: { x: number; y: number } | null;
  /** Free roam: EV1's full pose, for EV2's device to draw EV1 walking. */
  pose?: CrewPose;
}

export interface LogEntry {
  t: number;
  kind: string;
  text: string;
  /** The Earth message this answers (the crew accepting or declining a revised plan). */
  ref?: string;
  accepted?: boolean;
}

/** A field notebook entry as the server stores it (see ui/notebook.ts). */
export interface NoteRecord {
  id: string;
  label: string;
  sample: boolean;
  x: number;
  y: number;
  lon: number;
  lat: number;
  elevM: number;
  text: string;
  audio: boolean;
  evaT: number | null;
  lmst: string;
  created: string;
  updated?: string;
  /** The EVA it was taken on (null: while planning).  Earth gets it one light time after evaT on that EVA. */
  eva?: string | null;
}

/** A message from Earth to the crew. */
export interface EarthMessage {
  id: string;
  text: string;
  /** EVA clock when Mission Control sent it, and when it reaches the crew. */
  sentT: number;
  deliverT: number;
  /** Sent while no EVA was running: delivered at once (there is no EVA clock to delay it on). */
  immediate?: boolean;
  delivered?: boolean;
  /** A revised plan, for the crew to accept or decline. */
  change?: PlanChange;
}

export type ClientMsg =
  /**
   * `session`: which crew's session (one per EV1, see hab/session.ts).  EV1 without one gets the site's
   * default session; EV2 and Mission Control without one join the site's newest session.
   */
  | { type: "hello"; role: Role; site: string; member?: Member; session?: string }
  | { type: "plan"; plan: PlanInfo }
  | { type: "eva"; state: "start"; evaId: string; lightTimeS: number }
  | { type: "eva"; state: "end"; evaId: string; aborted: boolean; summary: string }
  /** The crew device is not in an EVA (sent on connecting): closes an EVA left open by a closed page. */
  | { type: "eva"; state: "idle" }
  | { type: "frame"; frame: Frame }
  | { type: "log"; entries: LogEntry[] }
  | { type: "say"; text: string; change?: PlanChange }
  /** The crew's answer to a revised plan: travels back to Earth like everything else. */
  | { type: "reply"; id: string; accepted: boolean }
  /** Free roam, EV2: where this astronaut is (relayed to EV1 at once — both are on Mars). */
  | { type: "pose"; pose: CrewPose }
  /** This astronaut is going out on foot in free roam with this plan (#hash) and dust (τ): the other follows. */
  | { type: "outside"; hash: string; tau: number };

export interface McSnapshot {
  plan: PlanInfo | null;
  crewOnline: boolean;
  eva: { id: string; running: boolean; ended: boolean } | null;
  now: number;
  lightTimeS: number;
  frames: Frame[];
  log: LogEntry[];
  notes: NoteRecord[];
  outbox: EarthMessage[];
}

export type ServerMsg =
  // to Mission Control
  | { type: "snapshot"; snap: McSnapshot }
  | { type: "plan"; plan: PlanInfo }
  | { type: "crew"; online: boolean }
  | { type: "eva"; eva: McSnapshot["eva"] }
  | { type: "clock"; now: number; lightTimeS: number; speed: number; live: { x: number; y: number } | null; hidden?: boolean }
  | { type: "frame"; frame: Frame }
  | { type: "log"; entry: LogEntry }
  | { type: "note"; note: NoteRecord }
  | { type: "note-removed"; id: string }
  | { type: "outbox"; msg: EarthMessage }
  // to the crew
  | { type: "mc"; online: number }
  | { type: "msg"; msg: EarthMessage }
  | { type: "notebook"; notes: NoteRecord[] }
  // between the two astronauts (Mars to Mars: no delay)
  | { type: "members"; ev2: number }
  | { type: "crewplan"; plan: PlanInfo }
  | { type: "crew-eva"; eva: McSnapshot["eva"] }
  | { type: "live"; frame: Frame }
  | { type: "buddy"; pose: CrewPose }
  /** To EV2: whether EV1 is in the session (sent on joining, and when EV1 leaves or comes back). */
  | { type: "ev1"; online: boolean }
  /** The hab's answer to hello: the session this device is in (EV2 and Mission Control may not have known it). */
  | { type: "joined"; session: string }
  /** The other astronaut went out on foot in free roam (relayed from EV1 to EV2, or EV2 to EV1). */
  | { type: "outside"; from: Member; hash: string; tau: number };

/** A finished EVA as the hab keeps it (for Mission Control's replay). */
export interface EvaRecord {
  evaId: string | null;
  site: string;
  plan: PlanInfo | null;
  log: LogEntry[];
  frames: Frame[];
  notes: NoteRecord[];
  outbox: EarthMessage[];
  lightTimeS: number;
  lastFrame: Frame | null;
  ended?: string;
  aborted?: boolean;
  summary?: string;
}

/** Site ids and note ids: letters, digits, dash and underscore only (they become file names). */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An EVA under way on one site, as the hab lists it for the main menu (GET /api/live). */
export interface LiveEva {
  /** the session (one per EV1): EV2 and Mission Control join it with ?s=<session> */
  session: string;
  /** EV1 is connected and planning (no EVA yet), or an EVA is under way */
  running: boolean;
  site: string;
  siteName: string;
  evaId: string;
  /** EVA clock (s) when the hab answered; it moves at `speed`× while the crew is online and not paused. */
  now: number;
  speed: number;
  lightTimeS: number;
  /** EV1's planner is connected (its clock only runs then). */
  crewOnline: boolean;
  /** EV1's planner tab is in the background: its EVA clock is stopped. */
  hidden: boolean;
  ev2: number;
  mc: number;
  stops: number;
  /** the stops in order ("Cheyava Falls → Serpentine Rapids"), to tell sessions apart */
  route: string;
  /** EV1 is walking it in free roam (so EV2 joins there, not in the planner). */
  roam: boolean;
}
