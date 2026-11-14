#!/usr/bin/env node
/**
 * One command for development: the hab server (backend, restarts on changes) and the Vite dev server
 * (frontend, hot reload), in one terminal.  Ctrl+C stops both.
 *
 *   npm run dev:all
 *
 * If a hab is already running on its port it is reused, not started twice.  Vite listens on the
 * network too, so a second device on the same Wi-Fi can open Mission Control.
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const HAB_PORT = Number(process.env.PORT ?? 8787);
const VITE_PORT = 5173;
const colour = { hab: "\x1b[33m", web: "\x1b[36m", off: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m" };

const portInUse = (port) =>
  new Promise((ok) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), ok(true)));
    s.once("error", () => ok(false));
  });

/** Run a command, prefixing each output line with its name. */
function run(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: WEB, env: { ...process.env, ...env, FORCE_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `${colour[name]}[${name}]${colour.off} `;
  for (const stream of [child.stdout, child.stderr]) {
    let rest = "";
    stream.on("data", (d) => {
      const lines = (rest + d.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) process.stdout.write(tag + l + "\n");
    });
  }
  child.on("exit", (code, signal) => {
    if (stopping) return;
    process.stdout.write(`${tag}stopped (${signal ?? `exit ${code}`}); stopping the other one too.\n`);
    stop(code ?? 1);
  });
  return child;
}

let stopping = false;
const children = [];
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 800).unref();
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

if (await portInUse(HAB_PORT)) {
  console.log(`${colour.hab}[hab]${colour.off} already running on port ${HAB_PORT}: using it.`);
} else {
  children.push(run("hab", process.execPath, ["--watch", "server/index.ts"], { PORT: String(HAB_PORT) }));
}
if (await portInUse(VITE_PORT)) {
  console.error(`${colour.web}[web]${colour.off} port ${VITE_PORT} is busy (another dev server?). Stop it first: lsof -ti:${VITE_PORT} | xargs kill`);
  stop(1);
} else {
  children.push(run("web", npx, ["vite", "--port", String(VITE_PORT), "--strictPort", "--host"]));
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  setTimeout(() => {
    if (stopping) return;
    const b = colour.bold, o = colour.off, d = colour.dim;
    console.log(`
${b}CAIRN is running${o}
  Planner           http://localhost:${VITE_PORT}/?site=jezero
  Mission Control   http://localhost:${VITE_PORT}/?view=mission&site=jezero${lan ? `
  Other devices     http://${lan}:${VITE_PORT}  ${d}(same Wi-Fi)${o}` : ""}
  ${d}Backend (hab) on port ${HAB_PORT}. Ctrl+C stops both.${o}
`);
  }, 1500);
}
