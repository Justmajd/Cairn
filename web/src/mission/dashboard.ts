/**
 * Mission Control: the EVA as Earth sees it.  Everything on this page left Mars one light time ago
 * (13–22 minutes): the crew's position, oxygen, dose, their log, their field notes.  The hab server
 * holds each item back until it would have arrived (server/room.ts), so this page simply shows what it
 * receives.  Messages typed here reach the crew one light time later.
 */
import { HabLink, habApi, type LinkState } from "../hab/link";
import type { EarthMessage, Frame, LogEntry, McSnapshot, NoteRecord, PlanInfo, ServerMsg } from "../hab/protocol";
import { $, esc, fmtClock, LOGO_SVG } from "../ui/dom";
import "../styles/mission.css";

const fmtLight = (s: number) => `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, "0")} s`;
const fmtDistM = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const fmtMin = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")} min` : `${Math.max(0, Math.round(s / 60))} min`);

interface State {
  link: LinkState;
  crewOnline: boolean;
  plan: PlanInfo | null;
  eva: McSnapshot["eva"];
  now: number;
  lightTimeS: number;
  speed: number;
  live: { x: number; y: number } | null;
  frames: Frame[];
  log: { entry: LogEntry; arrivedT: number }[];
  notes: Map<string, { note: NoteRecord; arrivedT: number }>;
  outbox: Map<string, EarthMessage>;
  alert: LogEntry | null;
}

export function startMissionControl(site: string): void {
  document.title = "CAIRN — Mission Control";
  document.body.className = "mc-body";
  document.body.innerHTML = `
    <div class="mc">
      <header class="mc-top">
        <div class="mc-brand">${LOGO_SVG}<div><b>CAIRN</b><span>Mission Control · Earth</span></div></div>
        <div class="mc-site" id="mc-site">—</div>
        <div class="mc-links"><span id="mc-hab" class="dot">Hab</span><span id="mc-crew" class="dot">Crew</span></div>
        <div class="mc-clocks">
          <div><span>Earth · EVA clock</span><b id="mc-now">—</b></div>
          <div class="delay"><span>Signal delay, one way</span><b id="mc-delay">—</b></div>
          <div><span>Showing Mars at</span><b id="mc-shown">—</b></div>
        </div>
      </header>
      <div class="mc-banner" id="mc-banner" hidden></div>
      <main class="mc-grid">
        <section class="mc-card mc-map">
          <header><h2>Crew position</h2><label class="mc-toggle"><input type="checkbox" id="mc-truth"/><span>Show where the crew really is now <em>(Earth can't know this yet)</em></span></label></header>
          <div class="mc-canvas"><canvas id="mc-canvas"></canvas><div class="mc-wait" id="mc-wait"></div></div>
          <footer class="mc-legend"><span><i class="l-route"></i>Planned route</span><span><i class="l-trail"></i>Received track</span><span><i class="l-crew"></i>Last received position</span><span><i class="l-now"></i>Now (not yet known)</span></footer>
        </section>
        <section class="mc-card mc-telemetry">
          <header><h2>Telemetry</h2><small id="mc-age"></small></header>
          <div class="mc-status" id="mc-status">—</div>
          <div class="mc-tiles" id="mc-tiles"></div>
          <canvas id="mc-chart" class="mc-chart"></canvas>
        </section>
        <section class="mc-card mc-log">
          <header><h2>Crew log</h2><small>as it reaches Earth</small></header>
          <ol id="mc-log"></ol>
        </section>
        <section class="mc-card mc-notes">
          <header><h2>Field notebook</h2><small id="mc-notes-n"></small></header>
          <ul id="mc-notes"></ul>
        </section>
        <section class="mc-card mc-comms">
          <header><h2>Message the crew</h2><small id="mc-comms-hint"></small></header>
          <form id="mc-form"><textarea id="mc-text" rows="2" maxlength="500" placeholder="e.g. Copy the storm alert. Shelter in the rover, report when inside."></textarea><button class="primary" id="mc-send" type="submit">Send</button></form>
          <ul id="mc-outbox"></ul>
        </section>
        <section class="mc-card mc-history">
          <header><h2>Past EVAs on the hab</h2></header>
          <ul id="mc-history"><li class="empty">—</li></ul>
        </section>
      </main>
    </div>`;

  const S: State = {
    link: "connecting", crewOnline: false, plan: null, eva: null, now: 0, lightTimeS: 0, speed: 0, live: null,
    frames: [], log: [], notes: new Map(), outbox: new Map(), alert: null,
  };
  let image: HTMLImageElement | null = null;
  let imageSrc = "";

  // the link is opened last (below), once everything it renders into exists
  let link: HabLink;

  function apply(m: ServerMsg): void {
    switch (m.type) {
      case "snapshot": {
        const s = m.snap;
        S.plan = s.plan;
        S.crewOnline = s.crewOnline;
        S.eva = s.eva;
        S.now = s.now;
        S.lightTimeS = s.lightTimeS;
        S.frames = s.frames;
        S.log = s.log.map((entry) => ({ entry, arrivedT: entry.t + s.lightTimeS }));
        S.notes = new Map(s.notes.map((note) => [note.id, { note, arrivedT: (note.evaT ?? 0) + s.lightTimeS }]));
        S.outbox = new Map(s.outbox.map((o) => [o.id, o]));
        S.alert = [...s.log].reverse().find((e) => e.kind === "alert") ?? null;
        break;
      }
      case "plan":
        S.plan = m.plan;
        if (!S.eva?.running) S.lightTimeS = m.plan.lightTimeS;
        break;
      case "crew":
        S.crewOnline = m.online;
        break;
      case "eva":
        if (m.eva && m.eva.id !== S.eva?.id) {
          S.frames = [];
          S.log = [];
          S.alert = null;
          for (const [id, msg] of S.outbox) if (msg.delivered || !msg.immediate) S.outbox.delete(id);
          for (const [id, n] of S.notes) if (n.note.evaT !== null) S.notes.delete(id);
          void loadHistory();
        }
        S.eva = m.eva;
        if (m.eva?.ended) void loadHistory();
        break;
      case "clock":
        S.now = m.now;
        S.lightTimeS = m.lightTimeS;
        S.speed = m.speed;
        S.live = m.live;
        break;
      case "frame":
        S.frames.push(m.frame);
        break;
      case "log":
        S.log.push({ entry: m.entry, arrivedT: S.now });
        if (m.entry.kind === "alert") S.alert = m.entry;
        break;
      case "note":
        S.notes.set(m.note.id, { note: m.note, arrivedT: S.now });
        break;
      case "note-removed":
        S.notes.delete(m.id);
        break;
      case "outbox":
        S.outbox.set(m.msg.id, m.msg);
        break;
    }
  }

  async function loadHistory(): Promise<void> {
    try {
      const evas = (await habApi.evas(site)) as { evaId: string; ended: string; aborted: boolean; log: LogEntry[]; plan: PlanInfo | null }[];
      $("#mc-history").innerHTML = evas.length
        ? evas
            .slice()
            .reverse()
            .slice(0, 8)
            .map((e) => {
              const last = e.log[e.log.length - 1];
              return `<li><b>${new Date(e.ended).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</b><span>${e.aborted ? "Ended early" : "Completed"} · ${e.log.length} log entries${last ? ` · last at EVA ${fmtClock(last.t)}` : ""}${e.plan ? ` · ${fmtDistM(e.plan.distanceM)} planned` : ""}</span></li>`;
            })
            .join("")
        : `<li class="empty">No EVA has been completed at this site yet.</li>`;
    } catch {
      $("#mc-history").innerHTML = `<li class="empty">Not available.</li>`;
    }
  }

  // ---------------------------------------------------------------- rendering
  const lastFrame = () => S.frames[S.frames.length - 1] ?? null;

  function render(): void {
    const dot = (el: HTMLElement, on: boolean, text: string, title: string) => {
      el.className = `dot ${on ? "on" : "off"}`;
      el.textContent = text;
      el.title = title;
    };
    dot($("#mc-hab"), S.link === "online", S.link === "online" ? "Hab linked" : S.link === "connecting" ? "Hab…" : "Hab offline", S.link === "online" ? "Connected to the hab server" : "No hab server: start it with npm start");
    dot($("#mc-crew"), S.crewOnline, S.crewOnline ? "Crew online" : "Crew offline", S.crewOnline ? "A crew device is connected to the hab" : "No crew device connected");
    $("#mc-site").textContent = S.plan ? S.plan.siteName.split(" — ")[0] : site;

    const running = !!S.eva?.running;
    const ended = !!S.eva?.ended;
    $("#mc-now").textContent = S.eva ? `T+${fmtClock(S.now)}` : "no EVA";
    $("#mc-delay").textContent = S.lightTimeS ? fmtLight(S.lightTimeS) : "—";
    const f = lastFrame();
    $("#mc-shown").textContent = f ? `T+${fmtClock(f.t)} · ${f.lmst} LMST` : S.eva ? "no signal yet" : "—";

    // waiting messages over the map
    const wait = $("#mc-wait");
    let w = "";
    if (S.link !== "online") w = `<b>No link to the hab</b><span>Mission Control needs the hab server. Start it with <code>npm start</code> in <code>web/</code> and open this page from it (http://localhost:8787).</span>`;
    else if (!S.plan) w = `<b>Waiting for the crew's plan</b><span>Open the planner for this site — <a href="?site=${esc(site)}" target="_blank" rel="noopener">CAIRN planner</a> — on any device linked to this hab.</span>`;
    else if (!S.eva) w = `<b>The crew is planning</b><span>${fmtDistM(S.plan.distanceM)}, ${fmtMin(S.plan.timeS)} outside, leaving the ${esc(S.plan.roverName ? "rover" : "hab")} at ${esc(S.plan.startLmst)} LMST. Earth will see the EVA ${fmtLight(S.plan.lightTimeS)} after it starts.</span>`;
    else if (running && !f) w = `<b>EVA under way on Mars</b><span>The first signal left Mars at T+00:00:00 and arrives at T+${fmtClock(S.lightTimeS)}: in ${fmtMin(Math.max(0, S.lightTimeS - S.now))} of EVA time.</span>`;
    wait.innerHTML = w;
    wait.hidden = !w;

    // banner: an alert that has reached Earth
    const banner = $("#mc-banner");
    if (S.alert && (running || ended)) {
      const ago = S.now - S.alert.t;
      banner.innerHTML = `<b>${esc(S.alert.text)}</b><span>Happened on Mars at T+${fmtClock(S.alert.t)}, received now: the crew has been dealing with it for ${fmtMin(ago)}. Any answer reaches them at T+${fmtClock(S.now + S.lightTimeS)} at the earliest.</span>`;
      banner.hidden = false;
    } else banner.hidden = true;

    renderTelemetry(f);
    renderLog();
    renderNotes();
    renderOutbox(running);
    draw();
  }

  function renderTelemetry(f: Frame | null): void {
    const P = S.plan;
    $("#mc-age").textContent = f ? `data ${fmtLight(Math.max(0, S.now - f.t))} old on arrival` : "";
    if (!f || !P) {
      $("#mc-status").innerHTML = S.eva?.ended && !f ? "EVA ended" : "No telemetry yet";
      $("#mc-tiles").innerHTML = "";
      drawChart();
      return;
    }
    const reserveHit = f.o2LeftL <= P.o2ReserveL;
    const rateX = f.doseRate / Math.max(1e-6, f.baseline);
    $("#mc-status").innerHTML = `<b>${esc(f.status)}</b> ${esc(f.next)}${f.nextDistM > 0 ? ` · ${fmtDistM(f.nextDistM)}` : ""}${S.eva?.ended && S.frames.length && f === lastFrame() ? "" : ""}`;
    const tile = (label: string, value: string, cls = "", sub = "") => `<div class="mc-tile ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    $("#mc-tiles").innerHTML = [
      tile("Oxygen", `${Math.round(f.o2LeftL)} L`, reserveHit ? "bad" : "", `<i class="bar"><u style="width:${Math.max(0, Math.min(100, (f.o2LeftL / P.o2SupplyL) * 100)).toFixed(1)}%"></u><em style="left:${((P.o2ReserveL / P.o2SupplyL) * 100).toFixed(1)}%"></em></i>`),
      tile("Way home", fmtMin(f.homeS), "", f.sheltered ? "inside the rover" : "walking time to the rover"),
      tile("Dose rate", `${f.doseRate.toFixed(f.doseRate < 10 ? 1 : 0)} µGy/h`, rateX >= 3 ? "bad" : rateX >= 1.5 ? "warn" : "", `${rateX.toFixed(rateX >= 10 ? 0 : 1)}× background${f.storm ? " · storm" : ""}`),
      tile("EVA dose", `${f.doseUGy >= 1000 ? `${(f.doseUGy / 1000).toFixed(2)} mGy` : `${f.doseUGy.toFixed(1)} µGy`}`),
      tile("Radio", f.radio === "lost" ? "No contact" : f.radio === "relay" ? "Via relay" : "Rover link", f.radio === "lost" ? "warn" : ""),
      tile("Local time", `${f.lmst}`, "", `Sun ${Math.round(f.sunEl)}° up`),
    ].join("");
    drawChart();
  }

  function renderLog(): void {
    const items = S.log.slice().sort((a, b) => b.entry.t - a.entry.t);
    $("#mc-log").innerHTML = items.length
      ? items
          .map(({ entry: e }) => `<li class="${esc(e.kind)}"><time>T+${fmtClock(e.t)}</time><span>${esc(e.text)}</span><small>arrived T+${fmtClock(e.t + S.lightTimeS)}</small></li>`)
          .join("")
      : `<li class="empty">${S.eva ? "Nothing has reached Earth yet." : "No EVA running."}</li>`;
  }

  function renderNotes(): void {
    const notes = [...S.notes.values()].sort((a, b) => (b.note.evaT ?? -1) - (a.note.evaT ?? -1));
    $("#mc-notes-n").textContent = notes.length ? `${notes.length} received` : "";
    const list = $("#mc-notes");
    const ids = notes.map((n) => n.note.id).join(",");
    if (list.dataset.ids === ids) return; // keep audio players playing between updates
    list.dataset.ids = ids;
    list.innerHTML = notes.length
      ? notes
          .map(({ note: n }) => `<li><span class="tag${n.sample ? " sample" : ""}">${esc(n.label)}</span><div><p>${esc(n.text || (n.audio ? "Voice note" : n.sample ? "Sample" : "Note"))}</p><small>${n.evaT !== null ? `Taken at T+${fmtClock(n.evaT)}, ${esc(n.lmst)} LMST · ` : "Planning note · "}${n.lat.toFixed(5)}°, ${n.lon.toFixed(5)}°E</small>${n.audio ? `<audio controls preload="none" src="${esc(habApi.audioUrl(site, n.id))}"></audio>` : ""}</div></li>`)
          .join("")
      : `<li class="empty">No notes from the crew.</li>`;
  }

  function renderOutbox(running: boolean): void {
    $("#mc-comms-hint").textContent = running ? `reaches the crew ${fmtLight(S.lightTimeS)} after you send it` : "no EVA running: delivered at once";
    const msgs = [...S.outbox.values()].sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)));
    $("#mc-outbox").innerHTML = msgs
      .map((m) => {
        const state = m.delivered ? `Delivered at T+${fmtClock(m.deliverT)}` : `In flight · reaches the crew at T+${fmtClock(m.deliverT)} (in ${fmtMin(m.deliverT - S.now)})`;
        return `<li class="${m.delivered ? "done" : "flight"}"><p>${esc(m.text)}</p><small>Sent T+${fmtClock(m.sentT)} · ${state}</small></li>`;
      })
      .join("");
    ($("#mc-send") as HTMLButtonElement).disabled = S.link !== "online";
  }

  // ---------------------------------------------------------------- map
  const canvas = $<HTMLCanvasElement>("#mc-canvas");
  function draw(): void {
    const box = canvas.parentElement!.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = Math.max(200, Math.floor(Math.min(box.width, box.height || box.width)));
    if (canvas.width !== size * dpr) {
      canvas.width = canvas.height = size * dpr;
      canvas.style.width = canvas.style.height = `${size}px`;
    }
    const g = canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#14110f";
    g.fillRect(0, 0, size, size);
    const P = S.plan;
    if (!P) return;
    if (imageSrc !== P.image) {
      imageSrc = P.image;
      image = new Image();
      image.onload = () => draw();
      image.src = P.image;
    }
    if (image?.complete && image.naturalWidth) {
      g.globalAlpha = 0.85;
      g.drawImage(image, 0, 0, size, size);
      g.globalAlpha = 1;
    }
    const X = (x: number) => (x / P.sizeM) * size;
    const Y = (y: number) => (1 - y / P.sizeM) * size;
    const line = (pts: [number, number][], color: string, width: number, dash: number[] = []) => {
      if (pts.length < 2) return;
      g.beginPath();
      g.moveTo(X(pts[0][0]), Y(pts[0][1]));
      for (const [x, y] of pts.slice(1)) g.lineTo(X(x), Y(y));
      g.strokeStyle = color;
      g.lineWidth = width;
      g.setLineDash(dash);
      g.stroke();
      g.setLineDash([]);
    };
    line(P.route, "rgba(70, 224, 207, 0.85)", 2.5);
    for (const s of P.stops) {
      g.beginPath();
      g.arc(X(s.x), Y(s.y), s.kind === "shelter" ? 7 : 6, 0, Math.PI * 2);
      g.fillStyle = s.kind === "shelter" ? "#f5b544" : "#46e0cf";
      g.fill();
      g.strokeStyle = "#0b0d10";
      g.lineWidth = 2;
      g.stroke();
      g.font = "600 11px 'IBM Plex Sans', sans-serif";
      g.fillStyle = "#fff";
      g.shadowColor = "rgba(0,0,0,0.8)";
      g.shadowBlur = 4;
      g.fillText(s.kind === "shelter" ? "Rover" : s.short, X(s.x) + 10, Y(s.y) + 4);
      g.shadowBlur = 0;
    }
    for (const n of S.notes.values()) {
      g.fillStyle = n.note.sample ? "#8af0c8" : "#ffe08a";
      g.fillRect(X(n.note.x) - 3, Y(n.note.y) - 3, 6, 6);
    }
    line(S.frames.map((f) => [f.x, f.y]), "rgba(255, 196, 92, 0.95)", 2);
    const f = lastFrame();
    if (f) {
      const a = (f.headingDeg * Math.PI) / 180;
      g.save();
      g.translate(X(f.x), Y(f.y));
      g.rotate(a); // heading: clockwise from north, as the canvas turns
      g.beginPath();
      g.moveTo(0, -11);
      g.lineTo(7, 8);
      g.lineTo(0, 4);
      g.lineTo(-7, 8);
      g.closePath();
      g.fillStyle = "#ffc45c";
      g.strokeStyle = "#0b0d10";
      g.lineWidth = 2;
      g.fill();
      g.stroke();
      g.restore();
      if (f.buddy) {
        g.beginPath();
        g.arc(X(f.buddy.x), Y(f.buddy.y), 4, 0, Math.PI * 2);
        g.fillStyle = "#ffe3a8";
        g.fill();
      }
    }
    if ($<HTMLInputElement>("#mc-truth").checked && S.live && S.eva) {
      g.beginPath();
      g.arc(X(S.live.x), Y(S.live.y), 9, 0, Math.PI * 2);
      g.setLineDash([3, 3]);
      g.strokeStyle = "#ff8a8a";
      g.lineWidth = 2;
      g.stroke();
      g.setLineDash([]);
      if (f) line([[f.x, f.y], [S.live.x, S.live.y]], "rgba(255, 138, 138, 0.6)", 1, [2, 4]);
    }
  }

  // ---------------------------------------------------------------- chart: oxygen and dose rate as received
  const chart = $<HTMLCanvasElement>("#mc-chart");
  function drawChart(): void {
    const w = chart.clientWidth || 300;
    const h = 90;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    chart.width = w * dpr;
    chart.height = h * dpr;
    const g = chart.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const P = S.plan;
    const fr = S.frames;
    if (!P || fr.length < 2) return;
    const t1 = Math.max(P.timeS, fr[fr.length - 1].t);
    const X = (t: number) => (t / t1) * (w - 2) + 1;
    const top = 18; // label row
    const Yv = (v: number, max: number) => h - 4 - (v / max) * (h - 4 - top);
    const maxRate = Math.max(...fr.map((f) => f.doseRate), fr[0].baseline * 3);
    const plot = (val: (f: Frame) => number, max: number, color: string) => {
      g.beginPath();
      fr.forEach((f, i) => (i ? g.lineTo(X(f.t), Yv(val(f), max)) : g.moveTo(X(f.t), Yv(val(f), max))));
      g.strokeStyle = color;
      g.lineWidth = 1.6;
      g.stroke();
    };
    g.strokeStyle = "rgba(255,255,255,0.08)";
    g.beginPath();
    g.moveTo(0, Yv(P.o2ReserveL, P.o2SupplyL));
    g.lineTo(w, Yv(P.o2ReserveL, P.o2SupplyL));
    g.stroke();
    plot((f) => f.o2LeftL, P.o2SupplyL, "#46e0cf");
    plot((f) => f.doseRate, maxRate, "#ff8a5c");
    g.font = "10px 'IBM Plex Mono', monospace";
    g.fillStyle = "#46e0cf";
    g.fillText("O₂ left", 4, 11);
    g.fillStyle = "#ff8a5c";
    g.fillText("dose rate", 56, 11);
    g.fillStyle = "rgba(255,255,255,0.35)";
    g.fillText("— O₂ reserve", 120, 11);
  }

  // ---------------------------------------------------------------- inputs
  $("#mc-truth").addEventListener("change", () => draw());
  $<HTMLFormElement>("#mc-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const box = $<HTMLTextAreaElement>("#mc-text");
    const text = box.value.trim();
    if (!text) return;
    if (link.send({ type: "say", text })) box.value = "";
  });
  $<HTMLTextAreaElement>("#mc-text").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      $<HTMLFormElement>("#mc-form").requestSubmit();
    }
  });
  new ResizeObserver(() => draw()).observe(canvas.parentElement!);
  link = new HabLink("mc", site);
  link.onMessage((m) => {
    apply(m);
    render();
  });
  link.onState((st) => {
    S.link = st;
    if (st === "online") void loadHistory();
    render();
  });
}
