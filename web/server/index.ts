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
 * Environment: PORT (8787), HOST (0.0.0.0: reachable from other devices on the network),
 * CAIRN_DATA (where notebooks are kept, web/hab-data), CAIRN_DIST (the built app, web/dist).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { SAFE_ID, type ClientMsg, type Member, type NoteRecord, type Role, type ServerMsg } from "../src/hab/protocol.ts";
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
  member: Member;
  alive: boolean;
  said: number[];
}

const rooms = new Map<string, Room>();
const clients = new Set<Client>();

async function room(site: string): Promise<Room> {
  let r = rooms.get(site);
  if (!r) {
    r = new Room(site);
    rooms.set(site, r);
    r.loadNotes(await store.notes(site));
  }
  return r;
}

const send = (c: Client, msg: ServerMsg) => c.ws.readyState === c.ws.OPEN && c.ws.send(JSON.stringify(msg));
const inRoom = (site: string, role: Role) => [...clients].filter((c) => c.site === site && c.role === role);

function deliver(site: string, o: Out): void {
  if (o.mc.length) for (const c of inRoom(site, "mc")) for (const m of o.mc) send(c, m);
  if (o.crew.length) for (const c of inRoom(site, "crew")) for (const m of o.crew) send(c, m);
}

/** EV2's devices: they get EV1's plan, EVA state and telemetry live (both astronauts are on Mars). */
const ev2s = (site: string) => inRoom(site, "crew").filter((c) => c.member === "ev2");
function toEv2(site: string, msg: ServerMsg): void {
  for (const c of ev2s(site)) send(c, msg);
}
function countEv2(site: string): void {
  const ev2 = ev2s(site).length;
  for (const c of inRoom(site, "crew")) if (c.member === "ev1") send(c, { type: "members", ev2 });
}

function countMc(site: string): void {
  const online = inRoom(site, "mc").length;
  for (const c of inRoom(site, "crew")) send(c, { type: "mc", online });
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
    const r = await room(msg.site);
    if (c.role === "mc") send(c, { type: "snapshot", snap: r.snapshot() });
    else {
      deliver(msg.site, r.setCrewOnline(true));
      send(c, { type: "notebook", notes: await store.notes(msg.site) });
      if (c.member === "ev2") {
        // catch up with EV1: the plan, whether an EVA is under way, and where it is now
        if (r.plan) send(c, { type: "crewplan", plan: r.plan });
        send(c, { type: "crew-eva", eva: r.evaId ? { id: r.evaId, running: r.running, ended: r.ended } : null });
        const f = r.lastFrame();
        if (r.running && f) send(c, { type: "live", frame: f });
      }
      countEv2(msg.site);
    }
    countMc(msg.site);
    return;
  }
  if (!c.site || !c.role) return;
  const r = await room(c.site);
  if (c.role === "crew") {
    if (c.member === "ev2") return; // EV2 follows EV1's EVA: the plan, the clock and the log are EV1's
    if (msg.type === "plan" && msg.plan && typeof msg.plan === "object") {
      deliver(c.site, r.setPlan(msg.plan));
      toEv2(c.site, { type: "crewplan", plan: msg.plan });
    } else if (msg.type === "frame" && msg.frame && Number.isFinite(msg.frame.t)) {
      deliver(c.site, r.frame(msg.frame));
      toEv2(c.site, { type: "live", frame: msg.frame });
    }
    else if (msg.type === "log" && Array.isArray(msg.entries)) deliver(c.site, r.setLog(msg.entries.filter((e) => e && Number.isFinite(e.t) && typeof e.text === "string")));
    else if (msg.type === "eva" && msg.state === "start" && typeof msg.evaId === "string") {
      deliver(c.site, r.startEva(msg.evaId, Number(msg.lightTimeS) || 0));
      toEv2(c.site, { type: "crew-eva", eva: { id: msg.evaId, running: true, ended: false } });
    }
    else if (msg.type === "reply" && typeof msg.id === "string") deliver(c.site, r.reply(msg.id, !!msg.accepted));
    else if (msg.type === "eva" && msg.state === "idle") {
      if (r.running) {
        deliver(c.site, r.endEva());
        toEv2(c.site, { type: "crew-eva", eva: { id: r.evaId ?? "", running: false, ended: true } });
        await store.addEva(c.site, { ...r.record(), ended: new Date().toISOString(), aborted: true, summary: "The crew's planner was closed or reloaded during the EVA." });
      }
    } else if (msg.type === "eva" && msg.state === "end") {
      deliver(c.site, r.endEva());
      toEv2(c.site, { type: "crew-eva", eva: { id: r.evaId ?? "", running: false, ended: true } });
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
    deliver(c.site, r.say(msg.text, change && (change.drop.length || change.add.length) ? change : undefined));
  }
}

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
      sites: [...rooms.values()].map((r) => ({ site: r.site, crew: r.crewOnline, eva: r.evaId, running: r.running, mc: inRoom(r.site, "mc").length })),
    });
  }
  if (!site || !SAFE_ID.test(site) || (id !== undefined && !SAFE_ID.test(id))) return json(res, 400, { error: "bad site or id" });
  const method = req.method ?? "GET";

  if (what === "notebook") {
    if (method === "GET" && !id) return json(res, 200, { notes: await store.notes(site) });
    if (method === "PUT" && id) {
      const note = cleanNote(JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "null"), id);
      if (!note) return json(res, 400, { error: "not a field note" });
      const saved = await store.putNote(site, note);
      const r = await room(site);
      deliver(site, r.upsertNote(saved));
      for (const c of inRoom(site, "crew")) send(c, { type: "notebook", notes: await store.notes(site) });
      return json(res, 200, { note: saved });
    }
    if (method === "DELETE" && id) {
      await store.removeNote(site, id);
      deliver(site, (await room(site)).removeNote(id));
      for (const c of inRoom(site, "crew")) send(c, { type: "notebook", notes: await store.notes(site) });
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
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://hab");
  const parts = url.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("api"); // also under a sub-path (e.g. /cairn/api/…)
  const handle = at >= 0 ? api(req, res, parts.slice(at + 1)) : serveStatic(req, res, url.pathname);
  handle.catch((e: Error) => {
    if (!res.headersSent) json(res, e.message === "too large" ? 413 : 500, { error: e.message });
    else res.destroy();
  });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
server.on("upgrade", (req, socket, head) => {
  if (!new URL(req.url ?? "/", "http://hab").pathname.endsWith("/hab")) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
wss.on("connection", (ws: WebSocket) => {
  const c: Client = { ws, role: null, site: null, member: "ev1", alive: true, said: [] };
  clients.add(c);
  ws.on("pong", () => (c.alive = true));
  ws.on("message", (data) => void onMessage(c, data.toString()).catch((e) => console.error("hab:", e)));
  ws.on("close", () => {
    clients.delete(c);
    if (!c.site) return;
    const r = rooms.get(c.site);
    if (c.role === "crew" && r && inRoom(c.site, "crew").length === 0) deliver(c.site, r.setCrewOnline(false));
    if (c.role === "crew") countEv2(c.site);
    if (c.role === "mc") countMc(c.site);
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
let lastTick = Date.now();
const ticker = setInterval(() => {
  const now = Date.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  for (const r of rooms.values()) deliver(r.site, r.tick(dt));
}, 250);

server.listen(PORT, HOST, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => `http://${i!.address}:${PORT}`);
  console.log(`CAIRN hab on http://localhost:${PORT}${lan.length ? `  (other devices: ${lan.join(", ")})` : ""}`);
  console.log(`  app: ${DIST}`);
  console.log(`  notebooks: ${store.root}`);
});

function stop(): void {
  clearInterval(heartbeat);
  clearInterval(ticker);
  for (const c of clients) c.ws.close(1001, "hab shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
