/**
 * The hab server end to end: start the real process on a free port, connect a crew client and a
 * Mission Control client over WebSockets, and check what crosses, when, and what is kept on disk.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ClientMsg, Frame, ServerMsg } from "../src/hab/protocol.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
let proc: ChildProcess;
let base = "";
let dataDir = "";

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

class Client {
  ws: WebSocket;
  got: ServerMsg[] = [];
  constructor(role: "crew" | "mc", site = "jezero", member?: "ev1" | "ev2", session?: string) {
    this.ws = new WebSocket(base.replace("http", "ws") + "/hab");
    this.ws.on("message", (d) => this.got.push(JSON.parse(d.toString()) as ServerMsg));
    this.ws.on("open", () => this.send({ type: "hello", role, site, ...(member ? { member } : {}), ...(session ? { session } : {}) }));
  }
  ready(): Promise<void> {
    return new Promise((ok) => (this.ws.readyState === WebSocket.OPEN ? ok() : this.ws.once("open", () => ok())));
  }
  send(m: ClientMsg): void {
    this.ws.send(JSON.stringify(m));
  }
  async waitFor(pred: (m: ServerMsg) => boolean, ms = 3000): Promise<ServerMsg> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = this.got.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("timed out");
  }
}

const frame = (t: number): Frame => ({
  t, x: 100 + t, y: 200, headingDeg: 0, o2LeftL: 650, doseUGy: 1, doseRate: 5, baseline: 5, status: "Walking to", next: "A", nextDistM: 50,
  homeS: 60, radio: "ok", sheltered: false, storm: false, lmst: "10:00", sunEl: 40, lightTimeS: 600, speed: 60,
});

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "cairn-hab-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [join(HERE, "index.ts")], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", CAIRN_DATA: dataDir }, stdio: "pipe" });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("hab did not start");
}, 10_000);

afterAll(() => {
  proc?.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("hab server", () => {
  it("relays telemetry to Mission Control one light time late, and Earth's messages back", async () => {
    const crew = new Client("crew");
    await crew.ready();
    const mc = new Client("mc");
    await mc.ready();
    await mc.waitFor((m) => m.type === "snapshot");
    await crew.waitFor((m) => m.type === "mc" && m.online === 1);

    crew.send({ type: "eva", state: "start", evaId: "e1", lightTimeS: 600 });
    crew.send({ type: "frame", frame: frame(0) });
    crew.send({ type: "frame", frame: frame(300) });
    crew.send({ type: "log", entries: [{ t: 0, kind: "go", text: "Left the rover" }] });
    await new Promise((r) => setTimeout(r, 150));
    expect(mc.got.some((m) => m.type === "frame")).toBe(false); // nothing has reached Earth yet

    crew.send({ type: "frame", frame: frame(620) });
    const f = (await mc.waitFor((m) => m.type === "frame")) as { frame: Frame };
    expect(f.frame.t).toBe(0);
    await mc.waitFor((m) => m.type === "log" && m.entry.text === "Left the rover");

    mc.send({ type: "say", text: "Copy, looking good" });
    await mc.waitFor((m) => m.type === "outbox" && !m.msg.delivered);
    crew.send({ type: "frame", frame: frame(1000) });
    await new Promise((r) => setTimeout(r, 120));
    expect(crew.got.some((m) => m.type === "msg")).toBe(false);
    crew.send({ type: "frame", frame: frame(1230) }); // sent at 620, arrives at 1220
    const msg = (await crew.waitFor((m) => m.type === "msg")) as { msg: { text: string; sentT: number } };
    expect(msg.msg).toMatchObject({ text: "Copy, looking good", sentT: 620 });

    crew.send({ type: "eva", state: "end", evaId: "e1", aborted: false, summary: "done" });
    await new Promise((r) => setTimeout(r, 200));
    const evas = (await (await fetch(`${base}/api/evas/jezero`)).json()) as { evas: { evaId: string }[] };
    expect(evas.evas.at(-1)?.evaId).toBe("e1");
    crew.ws.close();
    mc.ws.close();
  });

  it("keeps the field notebook and voice notes, shared with every crew device", async () => {
    const tablet = new Client("crew", "gale");
    await tablet.ready();
    await tablet.waitFor((m) => m.type === "notebook");
    const note = { id: "n1", label: "S1", sample: true, x: 1, y: 2, lon: 137.4, lat: -4.8, elevM: -4400, text: "Boxwork vein", audio: true, evaT: null, lmst: "", created: "2026-11-13T10:00:00Z" };
    const put = await fetch(`${base}/api/notebook/gale/n1`, { method: "PUT", body: JSON.stringify(note), headers: { "content-type": "application/json" } });
    expect(put.ok).toBe(true);
    const pushed = (await tablet.waitFor((m) => m.type === "notebook" && m.notes.length === 1)) as { notes: { text: string }[] };
    expect(pushed.notes[0].text).toBe("Boxwork vein");

    const clip = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
    expect((await fetch(`${base}/api/audio/gale/n1`, { method: "PUT", body: clip, headers: { "content-type": "audio/webm;codecs=opus" } })).ok).toBe(true);
    const back = await fetch(`${base}/api/audio/gale/n1`);
    expect(back.headers.get("content-type")).toBe("audio/webm;codecs=opus");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(clip);

    expect((await fetch(`${base}/api/audio/gale/n1`, { method: "PUT", body: "x", headers: { "content-type": "text/html" } })).status).toBe(400);
    expect((await fetch(`${base}/api/notebook/..%2Fetc/n1`)).status).toBe(400);
    expect((await fetch(`${base}/api/notebook/gale/n1`, { method: "DELETE" })).ok).toBe(true);
    expect(((await (await fetch(`${base}/api/notebook/gale`)).json()) as { notes: unknown[] }).notes).toHaveLength(0);
    expect((await fetch(`${base}/api/audio/gale/n1`)).status).toBe(404);
    tablet.ws.close();
  });

  it("links EV2's device to EV1's EVA live, with no delay (both are on Mars)", async () => {
    const ev1 = new Client("crew", "deuteronilus", "ev1");
    await ev1.ready();
    const ev2 = new Client("crew", "deuteronilus", "ev2");
    await ev2.ready();
    await ev1.waitFor((m) => m.type === "members" && m.ev2 === 1);
    ev1.send({ type: "plan", plan: { site: "deuteronilus", hash: "stops=toe&buddy=1", lightTimeS: 600 } as never });
    const plan = (await ev2.waitFor((m) => m.type === "crewplan")) as { plan: { hash: string } };
    expect(plan.plan.hash).toBe("stops=toe&buddy=1");
    ev1.send({ type: "eva", state: "start", evaId: "e2", lightTimeS: 600 });
    await ev2.waitFor((m) => m.type === "crew-eva" && !!m.eva?.running);
    ev1.send({ type: "frame", frame: frame(42) });
    const live = (await ev2.waitFor((m) => m.type === "live")) as { frame: Frame };
    expect(live.frame.t).toBe(42); // straight away, not one light time later
    // EV2 cannot drive the shared EVA
    ev2.send({ type: "eva", state: "end", evaId: "e2", aborted: true, summary: "" });
    await new Promise((r) => setTimeout(r, 150));
    expect(ev2.got.some((m) => m.type === "crew-eva" && !!m.eva?.ended)).toBe(false);
    ev1.send({ type: "eva", state: "end", evaId: "e2", aborted: false, summary: "" });
    await ev2.waitFor((m) => m.type === "crew-eva" && !!m.eva?.ended);
    const evas = (await (await fetch(`${base}/api/evas/deuteronilus`)).json()) as { evas: { frames: Frame[] }[] };
    expect(evas.evas.at(-1)?.frames.map((f) => f.t)).toEqual([42]);
    ev1.ws.close();
    ev2.ws.close();
  });

  it("relays EV2's free-roam pose to EV1 at once, and ignores a malformed one", async () => {
    const ev1 = new Client("crew", "jezero");
    await ev1.ready();
    const ev2 = new Client("crew", "jezero", "ev2");
    await ev2.ready();
    await ev1.waitFor((m) => m.type === "members" && m.ev2 === 1);
    ev2.send({ type: "pose", pose: { x: Number.NaN, y: 1, z: 1, headingDeg: 0, gait: "walk", vx: 0, vy: 0, vz: 0 } } as never);
    ev2.send({ type: "pose", pose: { x: 812.5, y: 1460, z: -2400, headingDeg: 90, gait: "walk", vx: 0.8, vy: 0, vz: 0 } });
    const got = (await ev1.waitFor((m) => m.type === "buddy")) as { pose: { x: number; gait: string } };
    expect(got.pose.x).toBe(812.5);
    expect(got.pose.gait).toBe("walk");
    expect(ev1.got.filter((m) => m.type === "buddy")).toHaveLength(1); // the NaN pose never arrived
    ev1.ws.close();
    ev2.ws.close();
  });

  it("tells the other astronaut when one goes out on foot, both ways, and never echoes it back", async () => {
    const ev1 = new Client("crew", "gale");
    await ev1.ready();
    const ev2 = new Client("crew", "gale", "ev2");
    await ev2.ready();
    await ev1.waitFor((m) => m.type === "members" && m.ev2 === 1);
    ev1.send({ type: "outside", hash: "#stops=ridge,sajama", tau: 0.6 });
    const a = (await ev2.waitFor((m) => m.type === "outside")) as { from: string; hash: string; tau: number };
    expect(a).toMatchObject({ from: "ev1", hash: "#stops=ridge,sajama", tau: 0.6 });
    ev2.send({ type: "outside", hash: "", tau: 99 });
    const b = (await ev1.waitFor((m) => m.type === "outside")) as { from: string; tau: number };
    expect(b).toMatchObject({ from: "ev2", tau: 12 }); // τ clamped
    expect(ev1.got.filter((m) => m.type === "outside")).toHaveLength(1);
    expect(ev2.got.filter((m) => m.type === "outside")).toHaveLength(1);
    ev1.ws.close();
    ev2.ws.close();
  });

  it("lists the open sessions on every site, for the main menu", async () => {
    type Live = { live: { session: string; running: boolean; site: string; siteName: string; evaId: string; crewOnline: boolean; ev2: number; stops: number }[] };
    const live = async () => ((await (await fetch(`${base}/api/live`)).json()) as Live).live.filter((e) => e.site === "gale");
    expect(await live()).toEqual([]);

    const ev1 = new Client("crew", "gale", "ev1");
    await ev1.ready();
    const ev2 = new Client("crew", "gale", "ev2");
    await ev2.ready();
    await ev1.waitFor((m) => m.type === "members" && m.ev2 === 1);
    const stops = [
      { id: "rover", name: "Rover", short: "Rover", x: 0, y: 0, kind: "shelter", order: 0 },
      { id: "box", name: "Boxwork", short: "Box", x: 10, y: 10, kind: "objective", order: 1 },
    ];
    ev1.send({ type: "plan", plan: { site: "gale", siteName: "Gale Crater — Mount Sharp boxwork", stops, lightTimeS: 600 } as never });
    expect(await live()).toMatchObject([{ session: "gale", running: false, ev2: 1 }]); // EV1 planning: a session to join
    ev1.send({ type: "eva", state: "start", evaId: "e3", lightTimeS: 600 });
    await ev2.waitFor((m) => m.type === "crew-eva" && !!m.eva?.running);
    expect(await live()).toMatchObject([{ session: "gale", running: true, site: "gale", siteName: "Gale Crater — Mount Sharp boxwork", evaId: "e3", crewOnline: true, ev2: 1, stops: 1 }]);

    ev1.send({ type: "eva", state: "end", evaId: "e3", aborted: false, summary: "" });
    await ev2.waitFor((m) => m.type === "crew-eva" && !!m.eva?.ended);
    expect(await live()).toMatchObject([{ session: "gale", running: false }]); // EV1 is still there
    ev1.ws.close();
    ev2.ws.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(await live()).toEqual([]); // EV1 left: nothing to join
  });

  it("keeps several crews apart: one session per EV1, on one site or many", async () => {
    type Live = { live: { session: string; site: string; ev2: number }[] };
    const live = async () => ((await (await fetch(`${base}/api/live`)).json()) as Live).live;
    const a1 = new Client("crew", "deuteronilus", "ev1", "deut-aaaa");
    const b1 = new Client("crew", "deuteronilus", "ev1", "deut-bbbb");
    await a1.ready();
    await b1.ready();
    await a1.waitFor((m) => m.type === "joined");
    await b1.waitFor((m) => m.type === "joined");
    const sessions = (await live()).filter((e) => e.site === "deuteronilus").map((e) => e.session);
    expect(sessions).toEqual(["deut-bbbb", "deut-aaaa"]); // newest first
    // EV2 joins B by name, and only B's EV1 hears about it
    const b2 = new Client("crew", "deuteronilus", "ev2", "deut-bbbb");
    await b2.ready();
    await b1.waitFor((m) => m.type === "members" && m.ev2 === 1);
    expect(a1.got.some((m) => m.type === "members" && m.ev2 === 1)).toBe(false);
    // A's plan goes to nobody in B
    a1.send({ type: "plan", plan: { site: "deuteronilus", siteName: "Deuteronilus Mensae", stops: [], lightTimeS: 600, hash: "stops=toe" } as never });
    b1.send({ type: "plan", plan: { site: "deuteronilus", siteName: "Deuteronilus Mensae", stops: [], lightTimeS: 600, hash: "stops=brain" } as never });
    const plan = (await b2.waitFor((m) => m.type === "crewplan")) as { plan: { hash: string } };
    expect(plan.plan.hash).toBe("stops=brain");
    await new Promise((r) => setTimeout(r, 100));
    expect(b2.got.filter((m) => m.type === "crewplan").map((m) => (m as { plan: { hash: string } }).plan.hash)).toEqual(["stops=brain"]);
    // Mission Control without a session joins the site's newest; with one, that one
    const mcNew = new Client("mc", "deuteronilus");
    const mcA = new Client("mc", "deuteronilus", undefined, "deut-aaaa");
    expect(((await mcNew.waitFor((m) => m.type === "joined")) as { session: string }).session).toBe("deut-bbbb");
    expect(((await mcA.waitFor((m) => m.type === "joined")) as { session: string }).session).toBe("deut-aaaa");
    const snap = (await mcA.waitFor((m) => m.type === "snapshot")) as { snap: { plan: { hash: string } | null } };
    expect(snap.snap.plan?.hash).toBe("stops=toe");
    // a session id from another site is not joined: EV1 gets this site's own default session instead
    const odd = new Client("crew", "jezero", "ev1", "deut-aaaa");
    expect(((await odd.waitFor((m) => m.type === "joined")) as { session: string }).session).toBe("jezero");
    for (const c of [a1, b1, b2, mcNew, mcA, odd]) c.ws.close();
  });

  it("serves only files inside the app", async () => {
    expect((await fetch(`${base}/..%2F..%2Fpackage.json`)).status).toBeGreaterThanOrEqual(400);
  });
});
