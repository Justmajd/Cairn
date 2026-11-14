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

/** How much of a set of walks keeps line of sight to the rover. */
export function radioCoverage(shadow: Uint8Array, grid: TerrainGrid, legs: MeasuredPath[]): RadioCoverage {
  let total = 0;
  let lostS = 0;
  let lostM = 0;
  let gaps = 0;
  let longest = 0;
  let run = 0;
  let inGap = false;
  for (const leg of legs) {
    for (let i = 1; i < leg.samples.length; i++) {
      const a = leg.samples[i - 1];
      const b = leg.samples[i];
      const dt = b.time - a.time;
      total += dt;
      const lost = radioDepthAt(shadow, grid, (a.x + b.x) / 2, (a.y + b.y) / 2) > RADIO_LOST_M;
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
  }
  return { coveredFraction: total > 0 ? 1 - lostS / total : 1, lostS, lostM, gaps, longestGapS: longest };
}
