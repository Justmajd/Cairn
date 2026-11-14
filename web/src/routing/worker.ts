/// <reference lib="webworker" />
import { TerrainGrid } from "../data/grid";
import type { EvaParams } from "../eva/params";
import type { XY } from "../types";
import { astar, buildReturnField, pathToShelter, ReturnField } from "./search";
import { smoothPath } from "./smooth";

export type WorkerRequest =
  | {
      type: "init";
      n: number;
      cell: number;
      height: Float32Array;
      effort: Uint8Array;
      risk: Uint8Array;
      slope: Uint8Array;
      sand: Uint8Array;
      effortScale: number;
      riskScale: number;
      params: EvaParams;
      shelter: XY;
    }
  | { type: "route"; id: number; stops: XY[] }
  | { type: "shelter"; id: number; from: XY };

export type WorkerResponse =
  | { type: "ready"; time: Float32Array; energy: Float32Array; ms: number; reachablePct: number }
  | { type: "route"; id: number; legs: (XY[] | null)[]; ms: number }
  | { type: "shelter"; id: number; path: XY[] | null; ms: number };

let grid: TerrainGrid | null = null;
let params: EvaParams | null = null;
let field: ReturnField | null = null;

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  const t0 = performance.now();
  if (msg.type === "init") {
    grid = new TerrainGrid(msg.n, msg.cell, msg.height, msg.effort, msg.risk, msg.slope, msg.sand, msg.effortScale, msg.riskScale);
    params = msg.params;
    const shelter = grid.nearestPassable(msg.shelter.x, msg.shelter.y);
    field = buildReturnField(grid, shelter, params);
    let reachable = 0;
    for (let i = 0; i < field.cost.length; i++) if (Number.isFinite(field.cost[i])) reachable++;
    // send copies; the worker keeps its own field for path extraction
    const time = field.time.slice();
    const energy = field.energy.slice();
    post({ type: "ready", time, energy, ms: performance.now() - t0, reachablePct: (100 * reachable) / field.cost.length }, [
      time.buffer,
      energy.buffer,
    ]);
    return;
  }
  if (!grid || !params || !field) return;
  if (msg.type === "route") {
    const legs: (XY[] | null)[] = [];
    for (let i = 1; i < msg.stops.length; i++) {
      const a = grid.nearestPassable(msg.stops[i - 1].x, msg.stops[i - 1].y);
      const b = grid.nearestPassable(msg.stops[i].x, msg.stops[i].y);
      const nodes = a >= 0 && b >= 0 ? astar(grid, a, b, params) : null;
      legs.push(nodes ? smoothPath(grid, nodes, params) : null);
    }
    post({ type: "route", id: msg.id, legs, ms: performance.now() - t0 });
  } else if (msg.type === "shelter") {
    const from = grid.nearestPassable(msg.from.x, msg.from.y);
    const nodes = from >= 0 ? pathToShelter(field, from) : null;
    const path = nodes ? smoothPath(grid, nodes, params) : null;
    if (path && path.length) path[0] = { x: msg.from.x, y: msg.from.y }; // start exactly where the astronaut stands
    post({ type: "shelter", id: msg.id, path, ms: performance.now() - t0 });
  }
};
