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
  /** Buddy (EV2) position, in buddy mode. */
  buddy?: { x: number; y: number } | null;
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
  | { type: "hello"; role: Role; site: string; member?: Member }
  | { type: "plan"; plan: PlanInfo }
  | { type: "eva"; state: "start"; evaId: string; lightTimeS: number }
  | { type: "eva"; state: "end"; evaId: string; aborted: boolean; summary: string }
  /** The crew device is not in an EVA (sent on connecting): closes an EVA left open by a closed page. */
  | { type: "eva"; state: "idle" }
  | { type: "frame"; frame: Frame }
  | { type: "log"; entries: LogEntry[] }
  | { type: "say"; text: string; change?: PlanChange }
  /** The crew's answer to a revised plan: travels back to Earth like everything else. */
  | { type: "reply"; id: string; accepted: boolean };

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
  | { type: "clock"; now: number; lightTimeS: number; speed: number; live: { x: number; y: number } | null }
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
  | { type: "live"; frame: Frame };

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
