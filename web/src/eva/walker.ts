import type { EvaParams } from "./params";
import { minettiCost, walkSpeedMs } from "./metabolic";

/**
 * Free-roam walking physics: one suited astronaut on the real terrain, in Mars gravity.
 *
 * Everything here is plain mechanics on the HiRISE elevation grid, with Mars' surface gravity
 * (3.721 m/s², NASA Mars Fact Sheet).  The suit and body numbers are DEMO ASSUMPTIONS, listed in
 * WALKER_NOTES and shown in the roam help panel; they are not NASA suit specifications.
 *
 * What it models:
 * - traction: feet can only push as hard as friction allows (μ·g·cos θ), so on Mars you speed up,
 *   stop and turn about 2.6 times more slowly than on Earth, and you cannot steer in the air;
 * - the walk–run transition at Froude number v²/(g·L) ≈ 0.5 (Kram, Domingo & Ferris 1997, measured
 *   in simulated reduced gravity): above ~1.3 m/s on Mars a walk becomes a bounding lope;
 * - jumps and lope hops are ballistic: the same push gives 2.6× the height and air time of Earth;
 *   the air is too thin (~0.02 kg/m³) for drag to matter at walking speeds, so none is applied;
 * - slopes: ground steeper than the friction angle (atan μ, close to loose regolith's angle of
 *   repose) cannot be stood on: you slide;
 * - landings: the speed into the ground is measured; a hard one can knock you down, and getting up
 *   in a pressurised suit takes a few seconds;
 * - metabolic power from the same Minetti model the planner uses → oxygen, heart rate, breathing.
 */

export const MARS_G = 3.721;
export const EARTH_G = 9.807;

export interface WalkerConfig {
  g: number; // m/s²
  legM: number; // leg length, for the Froude number and the step rhythm
  mu: number; // boot–regolith friction on firm ground
  muSand: number; // on loose sand
  pushMs2: number; // the most the legs can accelerate the suited body on level, grippy ground
  jumpMs: number; // take-off speed of a deliberate two-footed jump in the suit
  hopMs: number; // vertical speed of each lope bound
  lopeMaxMs: number; // fastest bounding lope the suit allows
  stanceS: number; // ground contact between lope bounds
  hardLandingMs: number; // impact speed felt as a hard landing
  fallMs: number; // impact speed that knocks the astronaut over
  getUpS: number; // time to get back up in the suit
}

export const MARS_WALKER: WalkerConfig = {
  g: MARS_G,
  legM: 0.9,
  mu: 0.6,
  muSand: 0.42,
  pushMs2: 3.2,
  jumpMs: 1.6,
  hopMs: 0.8,
  lopeMaxMs: 2.2,
  stanceS: 0.14,
  hardLandingMs: 2.6,
  fallMs: 4.2,
  getUpS: 3,
};

export const WALKER_NOTES: { label: string; value: string; basis: string }[] = [
  { label: "Surface gravity", value: "3.721 m/s²", basis: "NASA Mars Fact Sheet (0.38 of Earth's)" },
  { label: "Walk–run transition", value: "Froude number 0.5", basis: "Kram, Domingo & Ferris (1997), J. Exp. Biol. 200: reduced-gravity treadmill" },
  { label: "Walking speed", value: "Tobler × 0.6", basis: "Same model as the planner (Model assumptions)" },
  { label: "Metabolic cost", value: "Minetti et al. 2002", basis: "Same model as the planner; a lope costs 1.25× a walk (assumption)" },
  { label: "Leg length", value: "0.9 m", basis: "Assumption" },
  { label: "Boot friction", value: "μ 0.6 firm, 0.42 sand", basis: "Assumption (dry granular soil)" },
  { label: "Jump take-off", value: "1.6 m/s", basis: "Assumption: a suited, loaded jump" },
  { label: "Lope bound", value: "0.8 m/s up, 2.2 m/s top speed", basis: "Assumption, after the Apollo crews' bounding gait" },
  { label: "Falls", value: "impact over 4.2 m/s", basis: "Assumption; getting up takes 3 s" },
  { label: "Heart rate", value: "62 + 0.2 bpm per W over rest", basis: "Assumption, for the display only" },
  { label: "Air drag", value: "none", basis: "Mars air is ~0.02 kg/m³: under 0.05 N at a lope" },
];

/** What the walker stands on.  Local coordinates: metres, x east, y north, z up. */
export interface Ground {
  height(x: number, y: number): number;
  /** 0 firm … 1 loose sand */
  sand(x: number, y: number): number;
  /** walking effort multiplier (≥ 1: soft or rough ground) */
  effort(x: number, y: number): number;
  /** bounds of the walkable area */
  min: number;
  max: number;
}

export interface WalkInput {
  /** wanted direction of travel in local x/y (length 0…1 = how hard the stick is pushed) */
  x: number;
  y: number;
  lope: boolean;
  jump: boolean;
}

export type Gait = "stand" | "walk" | "lope" | "air" | "slide" | "down";

export interface WalkerState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
  gait: Gait;
  /** direction the body faces, radians clockwise from north */
  heading: number;
  /** stride phase, radians (one full turn = two steps) */
  phase: number;
  foot: 0 | 1;
  stanceT: number;
  downT: number;
  air: { t: number; z0: number; peak: number; x0: number; y0: number; jump: boolean } | null;
  /** last lope or jump: lets the gait show "lope" while bounding */
  bounding: boolean;
  steps: number;
  distM: number;
  climbM: number;
  energyJ: number;
  o2L: number;
  powerW: number;
  /** power smoothed over ~20 s: what the heart and lungs follow */
  effortW: number;
  slopeDeg: number;
  sand: number;
  maxJumpM: number;
  maxAirS: number;
  t: number;
}

export type WalkEvent =
  | { kind: "step"; x: number; y: number; heading: number; foot: 0 | 1; sand: number; speed: number; lope: boolean }
  | { kind: "takeoff"; jump: boolean; vz: number }
  | { kind: "land"; impactMs: number; airS: number; heightM: number; distM: number; hard: boolean; fell: boolean; jump: boolean; x: number; y: number; sand: number }
  | { kind: "slide"; slopeDeg: number }
  | { kind: "up" }
  | { kind: "edge" };

export function newWalker(x: number, y: number, z: number, heading = 0): WalkerState {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0, grounded: true, gait: "stand", heading, phase: 0, foot: 0, stanceT: 0, downT: 0, air: null, bounding: false,
    steps: 0, distM: 0, climbM: 0, energyJ: 0, o2L: 0, powerW: 100, effortW: 100, slopeDeg: 0, sand: 0, maxJumpM: 0, maxAirS: 0, t: 0,
  };
}

/** Fastest walk before the gait turns into a lope (Froude number 0.5). */
export function walkRunMs(g: number, legM: number): number {
  return Math.sqrt(0.5 * g * legM);
}

/** Height and air time of a jump with take-off speed `v` under gravity `g`. */
export function jumpOf(v: number, g: number): { heightM: number; airS: number } {
  return { heightM: (v * v) / (2 * g), airS: (2 * v) / g };
}

/** Speed of a fall from `h` metres. */
export function impactFrom(h: number, g: number): number {
  return Math.sqrt(2 * g * Math.max(0, h));
}

/** Natural step rate of a leg swinging as a pendulum, scaled to human cadence (steps/s). */
export function cadence(g: number, legM: number, speed: number, maxSpeed: number): number {
  const pendulum = Math.sqrt(g / legM) / (2 * Math.PI); // ~0.52 Hz on Earth, ~0.32 Hz on Mars
  return pendulum * 3.6 * (0.55 + 0.45 * Math.min(1, speed / Math.max(0.1, maxSpeed)));
}

export function heartRate(effortW: number, restingW: number): number {
  return Math.min(185, 62 + 0.2 * Math.max(0, effortW - restingW));
}

export function breathsPerMin(effortW: number, restingW: number): number {
  return Math.min(48, 12 + 0.045 * Math.max(0, effortW - restingW));
}

const H = 0.5; // finite-difference step for the ground gradient (m)

function gradient(g: Ground, x: number, y: number): [number, number] {
  return [(g.height(x + H, y) - g.height(x - H, y)) / (2 * H), (g.height(x, y + H) - g.height(x, y - H)) / (2 * H)];
}

/**
 * Advance the walker by `dt` seconds (internally in steps of at most 1/120 s).
 * Returns what happened (footsteps, take-offs, landings…) for sound, footprints and the HUD.
 */
export function stepWalker(s: WalkerState, input: WalkInput, ground: Ground, dt: number, p: EvaParams, cfg: WalkerConfig = MARS_WALKER): WalkEvent[] {
  const events: WalkEvent[] = [];
  let left = Math.min(dt, 0.25);
  let jump = input.jump;
  while (left > 1e-6) {
    const h = Math.min(left, 1 / 120);
    left -= h;
    tick(s, input, jump, ground, h, p, cfg, events);
    jump = false; // one press, one jump
  }
  return events;
}

function tick(s: WalkerState, input: WalkInput, jump: boolean, ground: Ground, dt: number, p: EvaParams, cfg: WalkerConfig, events: WalkEvent[]): void {
  s.t += dt;
  const g = cfg.g;
  const [gx, gy] = gradient(ground, s.x, s.y);
  const gradLen = Math.hypot(gx, gy);
  const slope = Math.atan(gradLen);
  const cos = Math.cos(slope);
  s.slopeDeg = (slope * 180) / Math.PI;
  s.sand = ground.sand(s.x, s.y);
  const mu = cfg.mu + (cfg.muSand - cfg.mu) * s.sand;
  let extraJ = 0;
  let locomotionW = 0;

  const ix = input.x;
  const iy = input.y;
  const want = Math.min(1, Math.hypot(ix, iy));

  if (s.grounded) {
    const speed = Math.hypot(s.vx, s.vy);
    if (s.downT > 0) {
      // knocked down: friction stops the body, then the slow climb back up
      s.gait = "down";
      s.downT -= dt;
      const k = Math.max(0, 1 - dt * 4);
      s.vx *= k;
      s.vy *= k;
      locomotionW = 260;
      if (s.downT <= 0) {
        s.downT = 0;
        s.gait = "stand";
        events.push({ kind: "up" });
      }
    } else if (gradLen > mu) {
      // steeper than the friction angle: the boots cannot hold, the body slides downhill
      if (s.gait !== "slide") events.push({ kind: "slide", slopeDeg: s.slopeDeg });
      s.gait = "slide";
      const sin = Math.sin(slope);
      const a = g * (sin - mu * cos) * cos; // along the slope, projected on the map
      s.vx += (-gx / gradLen) * a * dt;
      s.vy += (-gy / gradLen) * a * dt;
      // a little steering by leaning, and kinetic friction against sideways motion
      s.vx += ix * 0.4 * dt;
      s.vy += iy * 0.4 * dt;
      locomotionW = 180;
    } else {
      // target speed from the same walking model as the planner, along the wanted direction
      const dirX = want > 1e-3 ? ix / want : 0;
      const dirY = want > 1e-3 ? iy / want : 0;
      const grade = dirX * gx + dirY * gy;
      const effort = ground.effort(s.x, s.y);
      const walk = walkSpeedMs(grade, effort, p);
      const vRun = walkRunMs(g, cfg.legM);
      const lopeTop = Math.min(cfg.lopeMaxMs, walk * 2.4);
      const target = want * (input.lope ? Math.max(walk, lopeTop) : Math.min(walk, vRun));
      const tx = dirX * target;
      const ty = dirY * target;
      // the push is limited by the legs and by friction: μ·g·cos θ (2.2 m/s² on Mars, 5.9 on Earth)
      const aMax = Math.min(cfg.pushMs2, mu * g * cos);
      let dx = tx - s.vx;
      let dy = ty - s.vy;
      const dl = Math.hypot(dx, dy);
      const step = aMax * dt;
      if (dl > step) {
        dx *= step / dl;
        dy *= step / dl;
      }
      s.vx += dx;
      s.vy += dy;
      const sp = Math.hypot(s.vx, s.vy);
      if (sp < 0.03 && want < 0.05) {
        s.vx = 0;
        s.vy = 0;
      }
      // gait from the speed: above the Froude limit, walking turns into bounding
      const bounding = sp > vRun * 0.98 || (input.lope && sp > 0.5);
      if (bounding) {
        s.gait = "lope";
        s.stanceT += dt;
        if (s.stanceT >= cfg.stanceS) {
          s.stanceT = 0;
          s.vz = cfg.hopMs;
          takeOff(s, false);
          s.bounding = true;
          extraJ += (0.5 * p.massKg * cfg.hopMs * cfg.hopMs) / 0.25; // muscles ~25 % efficient
          events.push({ kind: "takeoff", jump: false, vz: s.vz });
        }
      } else {
        s.gait = sp > 0.05 ? "walk" : "stand";
        s.bounding = false;
        if (sp > 0.05) {
          const rate = cadence(g, cfg.legM, sp, vRun);
          const before = Math.floor(s.phase / Math.PI);
          s.phase += rate * Math.PI * dt;
          if (Math.floor(s.phase / Math.PI) !== before) {
            s.foot = s.foot === 0 ? 1 : 0;
            s.steps++;
            events.push({ kind: "step", x: s.x, y: s.y, heading: s.heading, foot: s.foot, sand: s.sand, speed: sp, lope: false });
          }
        }
      }
      locomotionW = speed > 0.05 ? minettiCost(Math.max(-0.45, Math.min(0.45, (s.vx * gx + s.vy * gy) / Math.max(0.05, speed)))) * p.massKg * p.gravityFactor * p.suitFactor * speed * (bounding ? 1.25 : 1) * effort : 0;
    }
    if (jump && s.downT <= 0 && s.gait !== "slide" && s.grounded) {
      s.vz = cfg.jumpMs;
      takeOff(s, true);
      extraJ += (0.5 * p.massKg * cfg.jumpMs * cfg.jumpMs) / 0.25;
      events.push({ kind: "takeoff", jump: true, vz: s.vz });
    }
  }

  // the body faces its motion; standing still it turns toward the stick
  const sp = Math.hypot(s.vx, s.vy);
  const face = sp > 0.15 ? Math.atan2(s.vx, s.vy) : want > 0.2 ? Math.atan2(ix, iy) : s.heading;
  let dh = face - s.heading;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh));
  s.heading += dh * Math.min(1, dt * (s.grounded ? 6 : 1.5));

  // move
  const ox = s.x;
  const oy = s.y;
  let nx = s.x + s.vx * dt;
  let ny = s.y + s.vy * dt;
  const lo = ground.min;
  const hi = ground.max;
  if (nx < lo || nx > hi || ny < lo || ny > hi) {
    if (nx < lo || nx > hi) s.vx = 0;
    if (ny < lo || ny > hi) s.vy = 0;
    nx = Math.min(hi, Math.max(lo, nx));
    ny = Math.min(hi, Math.max(lo, ny));
    events.push({ kind: "edge" });
  }
  s.x = nx;
  s.y = ny;
  const zg = ground.height(nx, ny);

  if (s.grounded && !s.air) {
    // follow the ground, unless it falls away faster than gravity can pull the body down
    const ball = s.z + s.vz * dt - 0.5 * g * dt * dt;
    if (zg < ball - 0.05 && sp > 0.2) {
      takeOff(s, false);
      s.vz -= g * dt;
      s.z = ball;
    } else {
      const vz = (zg - s.z) / dt;
      if (zg > s.z) s.climbM += zg - s.z;
      s.vz = vz;
      s.z = zg;
    }
  } else {
    s.vz -= g * dt;
    s.z += s.vz * dt;
    const a = s.air!;
    a.t += dt;
    if (s.z > a.peak) a.peak = s.z;
    if (s.z <= zg) {
      // landing: the speed into the ground (along its normal) is what the legs have to absorb
      const [lx, ly] = gradient(ground, nx, ny);
      const nl = Math.hypot(lx, ly, 1);
      const n = [-lx / nl, -ly / nl, 1 / nl];
      const vn = s.vx * n[0] + s.vy * n[1] + s.vz * n[2];
      const impact = Math.max(0, -vn);
      s.vx -= vn * n[0];
      s.vy -= vn * n[1];
      s.vz -= vn * n[2];
      s.z = zg;
      s.grounded = true;
      s.air = null;
      const lslope = (Math.atan(Math.hypot(lx, ly)) * 180) / Math.PI;
      const tangential = Math.hypot(s.vx, s.vy);
      const fell = impact > cfg.fallMs || (lslope > 24 && tangential > 1.7 && impact > 1.2);
      const hard = !fell && impact > cfg.hardLandingMs;
      const keep = fell ? 0.3 : a.jump ? 0.75 : 0.92; // the legs soak up some of the speed
      s.vx *= keep;
      s.vy *= keep;
      if (fell) s.downT = cfg.getUpS;
      const heightM = Math.max(0, a.peak - a.z0);
      if (a.jump) {
        s.maxJumpM = Math.max(s.maxJumpM, heightM);
        s.maxAirS = Math.max(s.maxAirS, a.t);
      }
      s.steps++;
      s.foot = s.foot === 0 ? 1 : 0;
      events.push({ kind: "land", impactMs: impact, airS: a.t, heightM, distM: Math.hypot(nx - a.x0, ny - a.y0), hard, fell, jump: a.jump, x: nx, y: ny, sand: s.sand });
      s.stanceT = 0;
    }
  }
  if (!s.grounded) s.gait = "air";
  s.distM += Math.hypot(s.x - ox, s.y - oy);

  // metabolic power → oxygen; heart and lungs follow a ~20 s average
  const power = p.restingW + locomotionW;
  s.powerW = power; // jump and bound pulses are counted in energy, not shown as a spike
  s.energyJ += power * dt + extraJ;
  s.o2L += (power * dt + extraJ) / (p.kJPerLitreO2 * 1000);
  const felt = power + extraJ / 0.6; // a jump's work spread over ~0.6 s for the heart
  s.effortW += (felt - s.effortW) * Math.min(1, dt / 20);
}

function takeOff(s: WalkerState, jump: boolean): void {
  s.grounded = false;
  s.air = { t: 0, z0: s.z, peak: s.z, x0: s.x, y0: s.y, jump };
}
