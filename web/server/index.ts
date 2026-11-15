/**
 * CAIRN hab server: the habitat's computer.  One process that
 *   - serves the built app and its map data (web/dist), gzipped where that helps;
 *   - keeps the field notebooks, voice notes and finished EVAs on disk (/api/…, see store.ts);
 *   - links the crew's devices and Mission Control live over a WebSocket (/hab), holding back whatever
 *     crosses between Mars and Earth for one light time on the EVA clock (see room.ts).
 *
 *   npm start            build the app, then serve it with the hab on http://localhost:8787
 *   npm run hab          the hab alone (with `npm run dev`, Vite forwards /api and /hab to it)
 *
 * Environment: PORT (8787), HOST (0.0.0.0: reachable from other devices on the network), HTTPS=1 (serve
 * https:// with the local certificate from scripts/cert.mjs: phones need it to use the microphone),
 * CAIRN_DATA (where notebooks are kept, web/hab-data), CAIRN_DIST (the built app, web/dist).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { SAFE_ID, type ClientMsg, type LiveEva, type Member, type NoteRecord, type Role, type ServerMsg } from "../src/hab/protocol.ts";
import { Room, type Out } from "./room.ts";
import { MAX_AUDIO_BYTES, Store } from "./store.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const DIST = resolve(process.env.CAIRN_DIST ?? join(HERE, "..", "dist"));
const store = new Store(resolve(process.env.CAIRN_DATA ?? join(HERE, "..", "hab-data")));
const started = Date.now();

// ================================================================ live link
interface Client {
  ws: WebSocket;
  role: Role | null;
  site: string | null;
  /** the crew session (room) this device is in */
  key: string | null;
  member: Member;
  alive: boolean;
  said: number[];
}

const rooms = new Map<string, Room>();
const clients = new Set<Client>();

/** One room per crew session (an EV1 and its EV2s and Mission Control screens), keyed by session id. */
async function room(site: string, key: string = site): Promise<Room> {
  let r = rooms.get(key);
  if (!r) {
    r = new Room(site, key);
    rooms.set(key, r);
    // carry on with the EVA that was under way when the hab stopped (if any)
    const live = await store.live<ReturnType<Room["liveState"]>>(site, key);
    if (live?.evaId) r.restore(live);
    r.loadNotes(await store.notes(site));
  }
  return r;
}

const hasEv1 = (key: string) => [...clients].some((c) => c.key === key && c.role === "crew" && c.member === "ev1");

/** EV1 is in it (planning or walking), or its EVA is under way: worth listing on the main menu. */
const isOpen = (r: Room) => r.listedLive() || (!r.running && hasEv1(r.key));

/** The session EV2 or Mission Control joins when the address names none: the site's newest open one. */
function newestSession(site: string): string | null {
  const open = [...rooms.values()].filter((r) => r.site === site && isOpen(r)).sort((a, b) => b.created - a.created);
  return open[0]?.key ?? null;
}

const send = (c: Client, msg: ServerMsg) => c.ws.readyState === c.ws.OPEN && c.ws.send(JSON.stringify(msg));
const inRoom = (key: string, role: Role) => [...clients].filter((c) => c.key === key && c.role === role);

function deliver(key: string, o: Out): void {
  if (o.mc.length) for (const c of inRoom(key, "mc")) for (const m of o.mc) send(c, m);
  if (o.crew.length) for (const c of inRoom(key, "crew")) for (const m of o.crew) send(c, m);
}

/** EV2's devices: they get EV1's plan, EVA state and telemetry live (both astronauts are on Mars). */
const ev2s = (key: string) => inRoom(key, "crew").filter((c) => c.member === "ev2");
function toEv2(key: string, msg: ServerMsg): void {
  for (const c of ev2s(key)) send(c, msg);
}
function countEv2(key: string): void {
  const ev2 = ev2s(key).length;
  for (const c of inRoom(key, "crew")) if (c.member === "ev1") send(c, { type: "members", ev2 });
}
/** Tell EV2 whether its EV1 is still in the session (EV1 closed CAIRN, or came back). */
function tellEv2AboutEv1(key: string, to?: Client): void {
  const online = hasEv1(key);
  for (const c of to ? [to] : ev2s(key)) send(c, { type: "ev1", online });
}

function countMc(key: string): void {
  const online = inRoom(key, "mc").length;
  for (const c of inRoom(key, "crew")) send(c, { type: "mc", online });
}

async function onMessage(c: Client, raw: string): Promise<void> {
  let msg: ClientMsg;
  try {
    msg = JSON.parse(raw) as ClientMsg;
  } catch {
    return;
  }
  if (msg.type === "hello") {
    if ((msg.role !== "crew" && msg.role !== "mc") || !SAFE_ID.test(msg.site)) return c.ws.close(1008, "bad hello");
    c.role = msg.role;
    c.site = msg.site;
    c.member = msg.member === "ev2" ? "ev2" : "ev1";
    // which session: the one named (if it is this site's), else EV1 opens the site's default one and
    // EV2 or Mission Control join the site's newest open session
    const named = typeof msg.session === "string" && SAFE_ID.test(msg.session) && (rooms.get(msg.session)?.site ?? msg.site) === msg.site ? msg.session : null;
    const key = named ?? (c.role === "crew" && c.member === "ev1" ? msg.site : newestSession(msg.site) ?? msg.site);
    c.key = key;
    const r = await room(msg.site, key);
    send(c, { type: "joined", session: key });
    if (c.role === "mc") send(c, { type: "snapshot", snap: r.snapshot() });
    else {
      deliver(key, r.setCrewOnline(true));
      send(c, { type: "notebook", notes: await store.notes(msg.site) });
      if (c.member === "ev2") {
        tellEv2AboutEv1(key, c);
        // catch up with EV1: the plan, whether an EVA is under way, and where it is now
        if (r.plan) send(c, { type: "crewplan", plan: r.plan });
        send(c, { type: "crew-eva", eva: r.evaId ? { id: r.evaId, running: r.running, ended: r.ended } : null });
        const f = r.lastFrame();
        if (r.running && f) send(c, { type: "live", frame: f });
      }
      countEv2(key);
      if (c.member === "ev1") tellEv2AboutEv1(key);
    }
    countMc(key);
    return;
  }
  if (!c.site || !c.key || !c.role) return;
  const r = await room(c.site, c.key);
  if (c.role === "crew") {
    if (msg.type === "outside") {
      // going out on foot in free roam: the other astronaut's devices follow (Mars to Mars, no delay)
      const hash = typeof msg.hash === "string" && msg.hash.length <= 4000 ? msg.hash : "";
      const tau = Number.isFinite(msg.tau) ? Math.max(0, Math.min(12, +msg.tau)) : 0;
      const other = c.member === "ev1" ? "ev2" : "ev1";
      for (const e of inRoom(c.key, "crew")) if (e.member === other) send(e, { type: "outside", from: c.member, hash, tau });
      return;
    }
    if (c.member === "ev2") {
      // EV2 follows EV1's EVA (the plan, the clock and the log are EV1's); in free roam it walks on its
      // own feet, and its pose goes straight to EV1's device
      const p = msg.type === "pose" ? msg.pose : null;
      if (p && [p.x, p.y, p.z, p.headingDeg, p.vx, p.vy, p.vz].every(Number.isFinite) && typeof p.gait === "string") {
        const pose = { x: +p.x, y: +p.y, z: +p.z, headingDeg: +p.headingDeg, gait: p.gait.slice(0, 12), vx: +p.vx, vy: +p.vy, vz: +p.vz, downT: Number.isFinite(p.downT) ? +p.downT! : 0, sliding: !!p.sliding };
        for (const e of inRoom(c.key, "crew")) if (e.member === "ev1") send(e, { type: "buddy", pose });
      }
      return;
    }
    if (msg.type === "plan" && msg.plan && typeof msg.plan === "object") {
      deliver(c.key, r.setPlan(msg.plan));
      toEv2(c.key, { type: "crewplan", plan: msg.plan });
    } else if (msg.type === "frame" && msg.frame && Number.isFinite(msg.frame.t)) {
      deliver(c.key, r.frame(msg.frame));
      toEv2(c.key, { type: "live", frame: msg.frame });
    }
    else if (msg.type === "log" && Array.isArray(msg.entries)) deliver(c.key, r.setLog(msg.entries.filter((e) => e && Number.isFinite(e.t) && typeof e.text === "string")));
    else if (msg.type === "eva" && msg.state === "start" && typeof msg.evaId === "string") {
      deliver(c.key, r.startEva(msg.evaId, Number(msg.lightTimeS) || 0));
      toEv2(c.key, { type: "crew-eva", eva: { id: msg.evaId, running: true, ended: false } });
    }
    else if (msg.type === "reply" && typeof msg.id === "string") deliver(c.key, r.reply(msg.id, !!msg.accepted));
    else if (msg.type === "eva" && msg.state === "idle") {
      if (r.running) {
        deliver(c.key, r.endEva());
        toEv2(c.key, { type: "crew-eva", eva: { id: r.evaId ?? "", running: false, ended: true } });
        await store.addEva(c.site, { ...r.record(), ended: new Date().toISOString(), aborted: true, summary: "The crew's planner was closed or reloaded during the EVA." });
      }
    } else if (msg.type === "eva" && msg.state === "end") {
      deliver(c.key, r.endEva());
      toEv2(c.key, { type: "crew-eva", eva: { id: r.evaId ?? "", running: false, ended: true } });
      await store.addEva(c.site, { ...r.record(), ended: new Date().toISOString(), aborted: !!msg.aborted, summary: String(msg.summary ?? "").slice(0, 2000) });
    }
  } else if (c.role === "mc" && msg.type === "say" && typeof msg.text === "string") {
    // at most 5 messages in 10 s from one screen
    const now = Date.now();
    c.said = c.said.filter((t) => now - t < 10_000);
    if (c.said.length >= 5) return;
    c.said.push(now);
    const ch = msg.change;
    const change =
      ch && Array.isArray(ch.drop) && Array.isArray(ch.add)
        ? {
            drop: ch.drop.filter((id) => typeof id === "string" && SAFE_ID.test(id)).slice(0, 10),
            add: ch.add.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y)).slice(0, 5).map((p) => ({ x: +p.x, y: +p.y })),
          }
        : undefined;
    deliver(c.key, r.say(msg.text, change && (change.drop.length || change.add.length) ? change : undefined));
  }
}

/** The site's notebook is shared by its sessions: a note from an EVA goes to that EVA's session, others to all. */
function noteRooms(site: string, eva: string | null): Room[] {
  const all = [...rooms.values()].filter((r) => r.site === site);
  const own = eva ? all.filter((r) => r.evaId === eva) : [];
  return own.length ? own : all;
}
const siteCrew = (site: string) => [...clients].filter((c) => c.site === site && c.role === "crew");

// ================================================================ HTTP API
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (d: Buffer) => {
      size += d.length;
      if (size > limit) {
        fail(new Error("too large"));
        req.destroy();
      } else parts.push(d);
    });
    req.on("end", () => ok(Buffer.concat(parts)));
    req.on("error", fail);
  });
}

/** A note as a client sent it: only the known fields, with sane types and lengths. */
function cleanNote(v: unknown, id: string): NoteRecord | null {
  const n = v as Partial<NoteRecord>;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  if (!n || typeof n !== "object" || n.id !== id) return null;
  const x = num(n.x), y = num(n.y), lon = num(n.lon), lat = num(n.lat), elevM = num(n.elevM);
  if (x === null || y === null || lon === null || lat === null || elevM === null || typeof n.label !== "string") return null;
  return {
    id,
    label: n.label.slice(0, 12),
    sample: !!n.sample,
    x, y, lon, lat, elevM,
    text: String(n.text ?? "").slice(0, 4000),
    audio: !!n.audio,
    evaT: num(n.evaT),
    lmst: String(n.lmst ?? "").slice(0, 8),
    created: String(n.created ?? new Date().toISOString()).slice(0, 40),
    eva: typeof n.eva === "string" && SAFE_ID.test(n.eva) ? n.eva : null,
    updated: typeof n.updated === "string" ? n.updated.slice(0, 40) : new Date().toISOString(),
  };
}

async function api(req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> {
  const [what, site, id] = parts;
  if (what === "health") {
    return json(res, 200, {
      ok: true,
      name: "CAIRN hab",
      uptimeS: Math.round((Date.now() - started) / 1000),
      app: await stat(join(DIST, "index.html")).then(() => true, () => false),
      sessions: [...rooms.values()].map((r) => ({ session: r.key, site: r.site, crew: r.crewOnline, eva: r.evaId, running: r.running, mc: inRoom(r.key, "mc").length })),
    });
  }
  if (what === "live") {
    // the open crew sessions on every site (EV1 planning, or an EVA under way), newest first: the main
    // menu offers each one's own Join as EV2 and Mission Control
    const live: LiveEva[] = [...rooms.values()]
      .filter(isOpen)
      .sort((a, b) => b.created - a.created)
      .map((r) => ({
        session: r.key,
        running: r.running,
        site: r.site,
        siteName: typeof r.plan?.siteName === "string" ? r.plan.siteName : r.site,
        evaId: r.evaId ?? "",
        now: r.now,
        speed: r.speed,
        lightTimeS: r.lightTimeS,
        crewOnline: r.crewOnline,
        hidden: r.crewHidden,
        ev2: ev2s(r.key).length,
        mc: inRoom(r.key, "mc").length,
        stops: Array.isArray(r.plan?.stops) ? r.plan.stops.filter((s) => s.kind !== "shelter").length : 0,
        route: Array.isArray(r.plan?.stops) ? r.plan.stops.filter((s) => s.kind !== "shelter").map((s) => String(s.short ?? s.name ?? "")).join(" → ").slice(0, 160) : "",
        roam: r.plan?.mode === "roam",
      }));
    return json(res, 200, { live });
  }
  if (!site || !SAFE_ID.test(site) || (id !== undefined && !SAFE_ID.test(id))) return json(res, 400, { error: "bad site or id" });
  const method = req.method ?? "GET";

  if (what === "notebook") {
    if (method === "GET" && !id) return json(res, 200, { notes: await store.notes(site) });
    if (method === "PUT" && id) {
      const note = cleanNote(JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "null"), id);
      if (!note) return json(res, 400, { error: "not a field note" });
      const saved = await store.putNote(site, note);
      for (const r of noteRooms(site, saved.eva ?? null)) deliver(r.key, r.upsertNote(saved));
      const notes = await store.notes(site);
      for (const c of siteCrew(site)) send(c, { type: "notebook", notes });
      return json(res, 200, { note: saved });
    }
    if (method === "DELETE" && id) {
      await store.removeNote(site, id);
      for (const r of noteRooms(site, null)) deliver(r.key, r.removeNote(id));
      const notes = await store.notes(site);
      for (const c of siteCrew(site)) send(c, { type: "notebook", notes });
      return json(res, 200, { ok: true });
    }
  }
  if (what === "audio" && id) {
    if (method === "GET" || method === "HEAD") {
      const a = await store.audio(site, id);
      if (!a) return json(res, 404, { error: "no voice note" });
      res.writeHead(200, { "content-type": a.type, "content-length": a.data.length, "cache-control": "no-store" });
      return void res.end(method === "HEAD" ? undefined : a.data);
    }
    if (method === "PUT") {
      const type = String(req.headers["content-type"] ?? "");
      try {
        await store.putAudio(site, id, type, await readBody(req, MAX_AUDIO_BYTES));
      } catch (e) {
        return json(res, (e as Error).message === "too large" ? 413 : 400, { error: (e as Error).message });
      }
      return json(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      await store.removeAudio(site, id);
      return json(res, 200, { ok: true });
    }
  }
  if (what === "evas" && method === "GET") return json(res, 200, { evas: await store.evas(site) });
  return json(res, 404, { error: "no such endpoint" });
}

// ================================================================ static app
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff",
  ".pk": "application/octet-stream", ".bin": "application/octet-stream", ".txt": "text/plain; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".onnx": "application/octet-stream", ".wav": "audio/wav",
};
const GZIP = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".webmanifest", ".txt"]);
const gzCache = new Map<string, { mtime: number; data: Buffer }>();

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  } catch {
    return json(res, 400, { error: "bad path" });
  }
  let file = resolve(DIST, rel || "index.html");
  if (file !== DIST && !file.startsWith(DIST + sep)) return json(res, 403, { error: "outside the app" });
  let info = await stat(file).catch(() => null);
  if (info?.isDirectory()) {
    file = join(file, "index.html");
    info = await stat(file).catch(() => null);
  }
  if (!info) {
    if (!(await stat(join(DIST, "index.html")).catch(() => null))) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
      return void res.end("CAIRN hab: the app is not built yet. Run `npm start` (build + serve) or `npm run build` first.\n");
    }
    return json(res, 404, { error: "not found" });
  }
  const ext = extname(file).toLowerCase();
  const etag = `"${info.size.toString(36)}-${info.mtimeMs.toString(36)}"`;
  const headers: Record<string, string> = {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    etag,
    // hashed build files never change; everything else is checked each time (cheap, with the ETag)
    "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return void res.end();
  }
  if (GZIP.has(ext) && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) && info.size > 1024) {
    let hit = gzCache.get(file);
    if (!hit || hit.mtime !== info.mtimeMs) {
      hit = { mtime: info.mtimeMs, data: gzipSync(await readFile(file), { level: 6 }) };
      gzCache.set(file, hit);
    }
    res.writeHead(200, { ...headers, "content-encoding": "gzip", vary: "accept-encoding", "content-length": String(hit.data.length) });
    return void res.end(req.method === "HEAD" ? undefined : hit.data);
  }
  res.writeHead(200, { ...headers, "content-length": String(info.size) });
  if (req.method === "HEAD") return void res.end();
  createReadStream(file).pipe(res);
}

// ================================================================ server
const HTTPS = process.env.HTTPS === "1";
const tls = HTTPS ? { key: readFileSync(join(HERE, "..", ".cert", "key.pem")), cert: readFileSync(join(HERE, "..", ".cert", "cert.pem")) } : null;
const handler = (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://hab");
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("api"); // also under a sub-path (e.g. /cairn/api/…)
  const handle = at >= 0 ? api(req, res, parts.slice(at + 1)) : serveStatic(req, res, url.pathname);
  handle.catch((e: Error) => {
    if (!res.headersSent) json(res, e.message === "too large" ? 413 : 500, { error: e.message });
    else res.destroy();
  });
};
const server = tls ? createHttpsServer(tls, handler) : createServer(handler);

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
server.on("upgrade", (req, socket, head) => {
  if (!new URL(req.url ?? "/", "http://hab").pathname.endsWith("/hab")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws: WebSocket) => {
  const c: Client = { ws, role: null, site: null, key: null, member: "ev1", alive: true, said: [] };
  clients.add(c);
  ws.on("pong", () => (c.alive = true));
  ws.on("message", (data) => void onMessage(c, data.toString()).catch((e) => console.error("hab:", e)));
  ws.on("close", () => {
    clients.delete(c);
    if (!c.key) return;
    const r = rooms.get(c.key);
    if (c.role === "crew" && r && inRoom(c.key, "crew").length === 0) deliver(c.key, r.setCrewOnline(false));
    if (c.role === "crew") countEv2(c.key);
    if (c.role === "crew" && c.member === "ev1") tellEv2AboutEv1(c.key);
    if (c.role === "mc") countMc(c.key);
  });
});

// heartbeats (drop dead connections) and the EVA clock after an EVA ends
const heartbeat = setInterval(() => {
  for (const c of clients) {
    if (!c.alive) {
      c.ws.terminate();
      continue;
    }
    c.alive = false;
    c.ws.ping();
  }
}, 20_000);
// the EVA under way, on disk every 2 s when it changes (a restarted hab carries on with it)
const saved = new Map<string, string>();
const saver = setInterval(() => {
  for (const r of rooms.values()) {
    const state = JSON.stringify(r.liveState());
    if (saved.get(r.key) === state) continue;
    saved.set(r.key, state);
    store.putLive(r.site, r.liveState(), r.key).catch((e) => console.error("hab: saving live state", e));
  }
}, 2000);
let lastTick = Date.now();
const ticker = setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  for (const r of rooms.values()) deliver(r.key, r.tick(dt));
  closeEmptySessions(now);
}, 250);

// A session nobody is in closes: after 2 min when no EVA is running (a reload or a quick walk to free
// roam keeps it), after an hour when an abandoned EVA is still marked as running.
const emptySince = new Map<string, number>();
function closeEmptySessions(now: number): void {
  for (const r of [...rooms.values()]) {
    if ([...clients].some((c) => c.key === r.key)) {
      emptySince.delete(r.key);
      continue;
    }
    const since = emptySince.get(r.key) ?? now;
    emptySince.set(r.key, since);
    if (now - since < (r.running ? 3_600_000 : 120_000)) continue;
    rooms.delete(r.key);
    emptySince.delete(r.key);
    saved.delete(r.key);
    if (r.key !== r.site) store.dropLive(r.site, r.key).catch(() => {});
  }
}

// Bring back the rooms of EVAs that were under way when the hab stopped, so /api/live lists them
// before anyone reconnects.
void readdir(store.root, { withFileTypes: true })
  .then(async (dirs) => {
    for (const d of dirs) {
      if (!d.isDirectory() || !SAFE_ID.test(d.name)) continue;
      for (const key of await store.liveSessions(d.name)) {
        const live = await store.live<{ evaId?: string; running?: boolean }>(d.name, key);
        if (live?.evaId && live.running) await room(d.name, key);
        else if (key !== d.name) await store.dropLive(d.name, key); // a session that had closed
      }
    }
  })
  .catch(() => {}); // no hab-data yet: nothing to resume

server.listen(PORT, HOST, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => `${HTTPS ? "https" : "http"}://${i!.address}:${PORT}`);
  console.log(`CAIRN hab on ${HTTPS ? "https" : "http"}://localhost:${PORT}${lan.length ? `  (other devices: ${lan.join(", ")})` : ""}`);
  if (HTTPS) console.log("  self-signed certificate: each device asks once to trust it (Advanced → Proceed)");
  console.log(`  app: ${DIST}`);
  console.log(`  notebooks: ${store.root}`);
});

function stop(): void {
  clearInterval(heartbeat);
  clearInterval(ticker);
  clearInterval(saver);
  for (const c of clients) c.ws.close(1001, "hab shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
