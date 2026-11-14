import type { TerrainGrid } from "../data/grid";
import type { MeasuredPath, XY } from "../types";

/** Mean radius of Mars (m), for the curvature of the ground between the two antennas. */
export const MARS_RADIUS_M = 3_389_500;
/** Height of the rover's mast antenna above the ground (assumption). */
export const ROVER_ANTENNA_M = 3;
/** Height of the suit's backpack antenna above the ground (assumption). */
export const SUIT_ANTENNA_M = 1.8;
/** One step of the stored shadow depth (m). */
export const RADIO_STEP_M = 0.25;
/** A suit antenna this far below the line of sight has lost the link. */
export const RADIO_LOST_M = 0.5;
/** Mast of a portable relay the crew can carry and stand up on the route (assumption). */
export const RELAY_MAST_M = 2.5;

/**
 * Radio shadow of a fixed antenna over the terrain grid.  EVA radios work on UHF, which needs a clear
 * line of sight on Mars (no ionosphere to bounce off at these frequencies, no relay assumed), so the
 * question per node is purely geometric: how far would the suit antenna have to rise to see the rover's
 * antenna?  0 means direct line of sight.
 *
 * Radial sweep: a ray from the antenna to every edge node, half a cell per step, keeping the steepest
 * terrain angle seen so far; the ground also drops away with the curvature of Mars.  A node crossed by
 * several rays keeps the smallest value.  Result: depth in RADIO_STEP_M steps, 0..255.
 */
export function radioShadow(grid: TerrainGrid, at: XY, antennaM = ROVER_ANTENNA_M, suitM = SUIT_ANTENNA_M): Uint8Array {
  const { n, cell, size } = grid;
  const out = new Uint8Array(n * n).fill(255);
  const c0 = at.x / cell;
  const r0 = (size - at.y) / cell;
  const z0 = grid.heightAt(at.x, at.y) + antennaM;
  out[grid.nodeAt(at.x, at.y)] = 0;
  const ray = (ec: number, er: number) => {
    const dc = ec - c0;
    const dr = er - r0;
    const len = Math.hypot(dc, dr);
    const steps = Math.ceil(len * 2);
    let maxTan = -Infinity;
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      const c = c0 + dc * f;
      const r = r0 + dr * f;
      const dist = len * f * cell;
      const ground = grid.heightAt(c * cell, size - r * cell) - (dist * dist) / (2 * MARS_RADIUS_M);
      const tanGround = (ground - z0) / dist;
      const depth = Math.max(0, (maxTan - (ground + suitM - z0) / dist) * dist);
      const node = Math.round(r) * n + Math.round(c);
      const v = Math.min(255, Math.ceil(depth / RADIO_STEP_M - 1e-9));
      if (v < out[node]) out[node] = v;
      if (tanGround > maxTan) maxTan = tanGround;
    }
  };
  for (let i = 0; i < n; i++) {
    ray(i, 0);
    ray(i, n - 1);
    ray(0, i);
    ray(n - 1, i);
  }
  return out;
}

/** Shadow depth (m) at a local position: 0 = in contact. */
export function radioDepthAt(shadow: Uint8Array, grid: TerrainGrid, x: number, y: number): number {
  return shadow[grid.nodeAt(x, y)] * RADIO_STEP_M;
}

export interface RadioCoverage {
  coveredFraction: number; // of the walking time
  lostS: number; // walking time out of contact
  lostM: number;
  gaps: number; // separate stretches out of contact
  longestGapS: number;
}

/** A relay stood up on the route: where it reaches, and where along the plan it goes up. */
export interface RelayLink {
  /** In contact with the relay at this point (its radio shadow, or a line-of-sight test). */
  reaches: (x: number, y: number) => boolean;
  leg: number; // leg index, and sample index within that leg, where the crew sets it up
  sample: number;
}

/** A RelayLink from the relay's full radio shadow. */
export function relayFromShadow(relayShadow: Uint8Array, grid: TerrainGrid, leg: number, sample: number): RelayLink {
  return { reaches: (x, y) => radioDepthAt(relayShadow, grid, x, y) <= RADIO_LOST_M, leg, sample };
}

/** In contact at a point: line of sight to the rover, or to a relay that is already up. */
export function inContact(shadow: Uint8Array, grid: TerrainGrid, x: number, y: number, relay: Uint8Array | null = null): boolean {
  return radioDepthAt(shadow, grid, x, y) <= RADIO_LOST_M || (relay !== null && radioDepthAt(relay, grid, x, y) <= RADIO_LOST_M);
}

/** How much of a set of walks keeps line of sight to the rover (or to the relay, once it is up). */
export function radioCoverage(shadow: Uint8Array, grid: TerrainGrid, legs: MeasuredPath[], relay: RelayLink | null = null): RadioCoverage {
  let total = 0;
  let lostS = 0;
  let lostM = 0;
  let gaps = 0;
  let longest = 0;
  let run = 0;
  let inGap = false;
  legs.forEach((leg, li) => {
    for (let i = 1; i < leg.samples.length; i++) {
      const a = leg.samples[i - 1];
      const b = leg.samples[i];
      const dt = b.time - a.time;
      total += dt;
      const up = relay !== null && (li > relay.leg || (li === relay.leg && i > relay.sample));
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const lost = !inContact(shadow, grid, mx, my) && !(up && relay!.reaches(mx, my));
      if (lost) {
        if (!inGap) gaps++;
        inGap = true;
        run += dt;
        lostS += dt;
        lostM += b.dist - a.dist;
        longest = Math.max(longest, run);
      } else {
        inGap = false;
        run = 0;
      }
    }
  });
  return { coveredFraction: total > 0 ? 1 - lostS / total : 1, lostS, lostM, gaps, longestGapS: longest };
}

/**
 * Line of sight between two antennas (heights above their own ground), allowing the same RADIO_LOST_M
 * slack at the far end as the radio shadow does; the ground between them bulges up with Mars' curvature.
 */
export function lineOfSight(grid: TerrainGrid, a: XY, aH: number, b: XY, bH: number): boolean {
  const za = grid.heightAt(a.x, a.y) + aH;
  const zb = grid.heightAt(b.x, b.y) + bH;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const steps = Math.ceil(len / grid.cell);
  for (let k = 1; k < steps; k++) {
    const f = k / steps;
    const d = len * f;
    const ground = grid.heightAt(a.x + dx * f, a.y + dy * f) + (d * (len - d)) / (2 * MARS_RADIUS_M);
    const above = ground - (za + (zb - za) * f);
    if (above > 0 && above / f > RADIO_LOST_M) return false; // how far the far antenna sits below the grazing line
  }
  return true;
}

export interface RelaySuggestion {
  at: XY;
  leg: number;
  sample: number;
  alongM: number; // distance along the whole route where the crew sets it up
  before: RadioCoverage;
  after: RadioCoverage; // estimated by line-of-sight tests along the route (the full relay shadow is made only when planned)
}

/**
 * Best place on the planned route to stand up a portable relay: it must see the rover from its mast,
 * and it only helps once it is up, so the search counts the blackout time it covers after that point
 * of the walk.  Candidates every ~8 m along the route; returns null when a relay would not help much.
 */
export function bestRelay(shadow: Uint8Array, grid: TerrainGrid, legs: MeasuredPath[], mastM = RELAY_MAST_M): RelaySuggestion | null {
  const before = radioCoverage(shadow, grid, legs);
  if (before.lostS < 30) return null;
  // blackout steps of the walk, in walking order; candidates at least every `spacing` metres.  Both are
  // capped (about 160 candidates, 400 blackout points) so a long plan still searches in well under a second.
  const totalM = legs.reduce((sum, l) => sum + l.distance, 0);
  const spacing = Math.max(8, totalM / 160);
  const lostAll: { x: number; y: number; dt: number; order: number }[] = [];
  const cands: { x: number; y: number; leg: number; sample: number; order: number; alongM: number }[] = [];
  let order = 0;
  let along = 0;
  let lastCand = -Infinity;
  legs.forEach((leg, li) => {
    for (let i = 1; i < leg.samples.length; i++, order++) {
      const a = leg.samples[i - 1];
      const b = leg.samples[i];
      along += b.dist - a.dist;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (!inContact(shadow, grid, mx, my)) lostAll.push({ x: mx, y: my, dt: b.time - a.time, order });
      // the relay's mast sees the rover where a suit antenna would need to rise by less than the extra height
      if (along - lastCand >= spacing && radioDepthAt(shadow, grid, b.x, b.y) <= mastM - SUIT_ANTENNA_M) {
        cands.push({ x: b.x, y: b.y, leg: li, sample: i, order, alongM: along });
        lastCand = along;
      }
    }
  });
  // thin the blackout points evenly, carrying the time of the ones skipped
  const stride = Math.max(1, Math.ceil(lostAll.length / 400));
  const lost: typeof lostAll = [];
  for (let i = 0; i < lostAll.length; i += stride) {
    let dt = 0;
    for (let j = i; j < Math.min(lostAll.length, i + stride); j++) dt += lostAll[j].dt;
    lost.push({ ...lostAll[i], dt });
  }
  let best: (typeof cands)[number] | null = null;
  let bestS = 0;
  for (const c of cands) {
    let covered = 0;
    let possible = 0;
    for (const s of lost) if (s.order >= c.order) possible += s.dt;
    if (possible <= bestS) continue;
    for (const s of lost) {
      if (s.order < c.order) continue;
      if (lineOfSight(grid, c, mastM, s, SUIT_ANTENNA_M)) covered += s.dt;
    }
    if (covered > bestS) {
      bestS = covered;
      best = c;
    }
  }
  if (!best || bestS < Math.max(30, before.lostS * 0.2)) return null;
  const at = { x: best.x, y: best.y };
  const reaches = (x: number, y: number) => lineOfSight(grid, at, mastM, { x, y }, SUIT_ANTENNA_M);
  const after = radioCoverage(shadow, grid, legs, { reaches, leg: best.leg, sample: best.sample });
  if (after.coveredFraction - before.coveredFraction < 0.03) return null;
  return { at, leg: best.leg, sample: best.sample, alongM: best.alongM, before, after };
}
