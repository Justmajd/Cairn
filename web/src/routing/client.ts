import type { TerrainGrid } from "../data/grid";
import type { EvaParams } from "../eva/params";
import type { XY } from "../types";
import type { WorkerRequest, WorkerResponse } from "./worker";

export interface FieldResult {
  time: Float32Array; // s to walk back to the shelter from each node
  energy: Float32Array; // J to walk back to the shelter from each node
  ms: number;
  reachablePct: number;
}

/** Promise-based wrapper around the routing Web Worker. */
export class Router {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (r: WorkerResponse) => void>();
  private onReady: ((r: FieldResult) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === "ready") {
        this.onReady?.({ time: msg.time, energy: msg.energy, ms: msg.ms, reachablePct: msg.reachablePct });
        this.onReady = null;
        return;
      }
      const resolve = this.pending.get(msg.id);
      if (resolve) {
        this.pending.delete(msg.id);
        resolve(msg);
      }
    };
  }

  /** Send the terrain to the worker and build the return-to-shelter field. */
  init(grid: TerrainGrid, params: EvaParams, shelter: XY): Promise<FieldResult> {
    return new Promise((resolve) => {
      this.onReady = resolve;
      const req: WorkerRequest = {
        type: "init",
        n: grid.n,
        cell: grid.cell,
        height: grid.height.slice(),
        effort: grid.effort.slice(),
        risk: grid.risk.slice(),
        slope: grid.slope.slice(),
        sand: grid.sand.slice(),
        effortScale: grid.effortScale,
        riskScale: grid.riskScale,
        params,
        shelter,
      };
      this.worker.postMessage(req, [req.height.buffer, req.effort.buffer, req.risk.buffer, req.slope.buffer, req.sand.buffer]);
    });
  }

  private request<T extends WorkerResponse>(build: (id: number) => WorkerRequest): Promise<T> {
    return new Promise((resolve) => {
      const id = this.nextId++;
      this.pending.set(id, resolve as (r: WorkerResponse) => void);
      this.worker.postMessage(build(id));
    });
  }

  /** Safest route through the stops, one polyline per leg (null if a leg is unreachable). */
  async route(stops: XY[]): Promise<{ legs: (XY[] | null)[]; ms: number }> {
    const r = await this.request<Extract<WorkerResponse, { type: "route" }>>((id) => ({ type: "route", id, stops }));
    return { legs: r.legs, ms: r.ms };
  }

  /** Best way back to the shelter from a position. */
  async shelterPath(from: XY): Promise<{ path: XY[] | null; ms: number }> {
    const r = await this.request<Extract<WorkerResponse, { type: "shelter" }>>((id) => ({ type: "shelter", id, from }));
    return { path: r.path, ms: r.ms };
  }
}
