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

/** In contact at a point: line of sight to the rover, or to any relay that is already up (one or several). */
export function inContact(shadow: Uint8Array, grid: TerrainGrid, x: number, y: number, relay: Uint8Array | Uint8Array[] | null = null): boolean {
  if (radioDepthAt(shadow, grid, x, y) <= RADIO_LOST_M) return true;
  const relays = relay === null ? [] : Array.isArray(relay) ? relay : [relay];
  return relays.some((r) => radioDepthAt(r, grid, x, y) <= RADIO_LOST_M);
}

/** How much of a set of walks keeps line of sight to the rover (or to a relay, once it is up). */
export function radioCoverage(shadow: Uint8Array, grid: TerrainGrid, legs: MeasuredPath[], relay: RelayLink | RelayLink[] | null = null): RadioCoverage {
  const links = relay === null ? [] : Array.isArray(relay) ? relay : [relay];
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
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const lost = !inContact(shadow, grid, mx, my) && !links.some((r) => (li > r.leg || (li === r.leg && i > r.sample)) && r.reaches(mx, my));
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
  /** placed by the crew on the map (not CAIRN's search); how far it stands from the route (m) */
  manual?: boolean;
  offRouteM?: number;
  /** what this mast links to: -1 the rover, else the index of another relay in the same chain */
  via?: number;
  /** where the crew passes it (its own place on the route; `leg`/`sample` are when the link works:
   *  once it and every mast between it and the rover are up) */
  ownLeg?: number;
  ownSample?: number;
}

/** A relay the crew places by hand may stand this far from the route: they step aside to put it up. */
export const RELAY_MAX_OFF_ROUTE_M = 60;

/**
 * Relays where the crew chose to put them: one, or a chain.  Each mast stands within
 * RELAY_MAX_OFF_ROUTE_M of the route (the crew stands it up as they pass the nearest point) and must see
 * the rover or another mast of the chain, so the link can hop mast to mast around a ridge.  A mast only
 * helps once it and every mast between it and the rover are up.  Otherwise a plain reason why not.
 */
export function relayChain(
  shadow: Uint8Array,
  grid: TerrainGrid,
  legs: MeasuredPath[],
  points: XY[],
  mastM = RELAY_MAST_M,
): { relays: RelaySuggestion[] } | { reason: string; index: number } {
  // each mast's nearest point of the route, and that point's place in walking order
  const placed: { at: XY; leg: number; sample: number; d: number; alongM: number; order: number }[] = [];
  for (const [k, at] of points.entries()) {
    let best: { leg: number; sample: number; d: number; alongM: number; order: number } | null = null;
    let along = 0;
    let order = 0;
    legs.forEach((leg, li) => {
      leg.samples.forEach((q, i) => {
        if (i > 0) along += q.dist - leg.samples[i - 1].dist;
        const d = Math.hypot(q.x - at.x, q.y - at.y);
        if (!best || d < best.d) best = { leg: li, sample: i, d, alongM: along, order };
        order++;
      });
    });
    const near = best as { leg: number; sample: number; d: number; alongM: number; order: number } | null;
    if (!near) return { reason: "Plan a route first: the crew stands the relay up on the way.", index: k };
    if (near.d > RELAY_MAX_OFF_ROUTE_M) {
      return { reason: `That spot is ${Math.round(near.d)} m from the route. Put the relay within ${RELAY_MAX_OFF_ROUTE_M} m of it: the crew carries the mast and stands it up on the way.`, index: k };
    }
    placed.push({ at: { x: Math.round(at.x), y: Math.round(at.y) }, ...near });
  }
  // the chain: masts that see the rover first, then masts that see a linked mast, until nothing changes
  const via = placed.map(() => -2); // -2 not linked, -1 the rover, k another mast
  const upOrder = placed.map(() => Infinity); // when its link works (walking order)
  placed.forEach((p, k) => {
    if (radioDepthAt(shadow, grid, p.at.x, p.at.y) <= mastM - SUIT_ANTENNA_M) {
      via[k] = -1;
      upOrder[k] = p.order;
    }
  });
  for (let changed = true; changed; ) {
    changed = false;
    placed.forEach((p, k) => {
      for (const [j, q] of placed.entries()) {
        if (j === k || via[j] === -2) continue;
        const when = Math.max(p.order, upOrder[j]);
        // a better link: one that works sooner on the walk
        if (when < upOrder[k] && lineOfSight(grid, p.at, mastM, q.at, mastM)) {
          via[k] = j;
          upOrder[k] = when;
          changed = true;
        }
      }
    });
  }
  const lone = via.findIndex((v) => v === -2);
  if (lone >= 0) {
    const from = placed.length > 1 ? `From relay ${lone + 1}'s spot` : "From there";
    return { reason: `${from} even the top of the ${mastM} m mast sees neither the rover nor another relay, so it would relay nothing. Try higher ground with the rover or another mast in sight.`, index: lone };
  }
  // walking order → leg and sample (when each link works)
  const at = (order: number): { leg: number; sample: number } => {
    let o = 0;
    for (const [li, leg] of legs.entries()) {
      if (order < o + leg.samples.length) return { leg: li, sample: order - o };
      o += leg.samples.length;
    }
    return { leg: legs.length - 1, sample: legs[legs.length - 1].samples.length - 1 };
  };
  const links: RelayLink[] = placed.map((p, k) => ({ reaches: (x: number, y: number) => lineOfSight(grid, p.at, mastM, { x, y }, SUIT_ANTENNA_M), ...at(upOrder[k]) }));
  const before = radioCoverage(shadow, grid, legs);
  const after = radioCoverage(shadow, grid, legs, links);
  return {
    relays: placed.map((p, k) => ({
      at: p.at, ...at(upOrder[k]), ownLeg: p.leg, ownSample: p.sample, alongM: p.alongM, before, after,
      manual: true, offRouteM: Math.round(p.d), via: via[k],
    })),
  };
}

/** One relay where the crew chose to put it (see relayChain). */
export function relayAtPoint(shadow: Uint8Array, grid: TerrainGrid, legs: MeasuredPath[], at: XY, mastM = RELAY_MAST_M): { relay: RelaySuggestion } | { reason: string } {
  const r = relayChain(shadow, grid, legs, [at], mastM);
  return "relays" in r ? { relay: r.relays[0] } : { reason: r.reason };
}

/**
 * Best place on the planned route to stand up a portable relay: it must see the rover from its mast,
 * and it only helps once it is up, so the search counts the blackout time it covers after that point
 * of the walk.  Candidates every ~8 m along the route; returns null when a relay would not help much.
 */
export function bestRelay(
  shadow: Uint8Array,
  grid: TerrainGrid,
  legs: MeasuredPath[],
  mastM = RELAY_MAST_M,
  stops: { x: number; y: number; seconds: number; afterLeg: number }[] = [],
): RelaySuggestion | null {
  const before = radioCoverage(shadow, grid, legs);
  // time spent working at stops with no contact counts too (stop k is reached at the end of leg afterLeg)
  const silent = stops.filter((st) => !inContact(shadow, grid, st.x, st.y));
  if (before.lostS < 30 && !silent.some((st) => st.seconds >= 60)) return null;
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
  // stops out of contact: one point each, carrying the whole dwell time, in walking order
  const legEnd: number[] = [];
  let acc = 0;
  for (const leg of legs) {
    acc += Math.max(0, leg.samples.length - 1);
    legEnd.push(acc);
  }
  for (const st of silent) lostAll.push({ x: st.x, y: st.y, dt: st.seconds, order: legEnd[st.afterLeg] ?? acc });
  lostAll.sort((a, b) => a.order - b.order);
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
  const silentS = silent.reduce((sum, st) => sum + st.seconds, 0);
  if (!best || bestS < Math.max(30, (before.lostS + silentS) * 0.2)) return null;
  const at = { x: best.x, y: best.y };
  const reaches = (x: number, y: number) => lineOfSight(grid, at, mastM, { x, y }, SUIT_ANTENNA_M);
  const after = radioCoverage(shadow, grid, legs, { reaches, leg: best.leg, sample: best.sample });
  const freed = silent.filter((st) => (legEnd[st.afterLeg] ?? acc) >= best!.order && reaches(st.x, st.y));
  if (after.coveredFraction - before.coveredFraction < 0.03 && !freed.length) return null;
  return { at, leg: best.leg, sample: best.sample, alongM: best.alongM, before, after };
}
