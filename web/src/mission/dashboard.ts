/**
 * Mission Control: the EVA as Earth sees it.  Everything on this page left Mars one light time ago
 * (13–22 minutes): the crew's position, oxygen, dose, their log, their field notes.  The hab server
 * holds each item back until it would have arrived (server/room.ts), so this page simply shows what it
 * receives.  Messages typed here reach the crew one light time later.
 */
import { HabLink, habApi, type LinkState } from "../hab/link";
import type { EarthMessage, EvaRecord, Frame, LogEntry, McSnapshot, NoteRecord, PlanChange, PlanInfo, ServerMsg } from "../hab/protocol";
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
      <h1 class="vh">CAIRN Mission Control</h1>
      <p class="vh" id="mc-say" role="status" aria-live="polite"></p>
      <p class="vh" id="mc-shout" role="alert"></p>
      <header class="mc-top">
        <div class="mc-brand">${LOGO_SVG}<div><b>CAIRN</b><span>Mission Control · Earth</span></div></div>
        <div class="mc-site" id="mc-site">—</div>
        <div class="mc-links"><span id="mc-hab" class="dot">Hab</span><span id="mc-crew" class="dot">Crew</span></div>
        <div class="mc-clocks">
          <div><span>Earth clock</span><b id="mc-now">—</b></div>
          <div class="delay" title="One-way radio delay between Mars and Earth"><span>Signal delay</span><b id="mc-delay">—</b></div>
          <div><span>Mars as of</span><b id="mc-shown">—</b><small id="mc-shown-lmst"></small></div>
        </div>
      </header>
      <div class="mc-replay" id="mc-replay" hidden>
        <div class="mc-replay-head"><b id="mc-replay-title">Replay</b><span id="mc-replay-clock"></span>
          <button id="mc-replay-play" aria-label="Play">▶</button>
          <label><span class="vh">Replay speed</span><select id="mc-replay-speed"><option value="30">30×</option><option value="60" selected>60×</option><option value="180">180×</option></select></label>
          <button id="mc-replay-exit">Back to live</button></div>
        <div class="mc-replay-track"><div id="mc-replay-marks" aria-hidden="true"></div>
          <label class="vh" for="mc-replay-t">Earth clock during the replay</label><input type="range" id="mc-replay-t" min="0" max="1" step="1" value="0"/></div>
        <p class="mc-replay-key"><i class="k-alert"></i>Event on Mars <i class="k-earth"></i>Earth finds out <i class="k-msg"></i>Message from Earth</p>
      </div>
      <div class="mc-banner" id="mc-banner" hidden></div>
      <main class="mc-grid">
        <section class="mc-card mc-map">
          <header><h2>Crew position</h2><label class="mc-toggle"><input type="checkbox" id="mc-truth"/><span>Show where the crew really is now <em>(Earth can't know this yet)</em></span></label></header>
          <div class="mc-canvas"><canvas id="mc-canvas" role="img" aria-label="Map of the walk area"></canvas><div class="mc-wait" id="mc-wait"></div></div>
          <footer class="mc-legend"><span><i class="l-route"></i>Planned route</span><span><i class="l-trail"></i>Received track</span><span><i class="l-crew"></i>Last received position</span><span><i class="l-now"></i>Now (not yet known)</span></footer>
        </section>
        <section class="mc-card mc-telemetry">
          <header><h2>Telemetry</h2><small id="mc-age"></small></header>
          <div class="mc-status" id="mc-status">—</div>
          <div class="mc-tiles" id="mc-tiles"></div>
          <canvas id="mc-chart" class="mc-chart" role="img" aria-label="Chart of oxygen left and dose rate as received"></canvas>
        </section>
        <section class="mc-card mc-log">
          <header><h2>Crew log</h2><small>as it reaches Earth</small></header>
          <ol id="mc-log" aria-label="Crew log, newest first"></ol>
        </section>
        <section class="mc-card mc-notes">
          <header><h2>Field notebook</h2><small id="mc-notes-n"></small></header>
          <ul id="mc-notes"></ul>
        </section>
        <section class="mc-card mc-comms">
          <header><h2>Message the crew</h2><small id="mc-comms-hint"></small></header>
          <form id="mc-form"><label class="vh" for="mc-text">Message to the crew</label><textarea id="mc-text" rows="2" maxlength="500" placeholder="e.g. Copy the storm alert. Shelter in the rover, report when inside."></textarea><button class="primary" id="mc-send" type="submit">Send</button></form>
          <div class="mc-propose">
            <button id="mc-propose" type="button" aria-pressed="false">Propose a plan change</button>
            <div id="mc-propose-box" hidden>
              <p>On the map: click a stop to drop it, or click elsewhere to add a stop (up to 3).</p>
              <ul id="mc-changes"></ul>
              <div class="row"><button type="button" id="mc-propose-cancel">Cancel</button><button type="button" class="primary" id="mc-propose-send" disabled>Send revised plan</button></div>
            </div>
          </div>
          <ul id="mc-outbox"></ul>
        </section>
        <section class="mc-card mc-history">
          <header><h2>Past EVAs on the hab</h2><small>replay any of them</small></header>
          <ul id="mc-history"><li class="empty">—</li></ul>
        </section>
      </main>
    </div>`;

  // L: the live EVA, as messages arrive.  S: what the screen shows (L, or a replay of a past EVA).
  const L: State = {
    link: "connecting", crewOnline: false, plan: null, eva: null, now: 0, lightTimeS: 0, speed: 0, live: null,
    frames: [], log: [], notes: new Map(), outbox: new Map(), alert: null,
  };
  let S: State = L;
  let history: EvaRecord[] = [];
  let replay: { rec: EvaRecord; t: number; end: number; playing: boolean; timer: number } | null = null;
  let editing: PlanChange | null = null;
  /** Names of every stop seen in any plan: a revised plan may drop a stop the current plan no longer has. */
  const stopNames = new Map<string, string>();
  let image: HTMLImageElement | null = null;
  let imageSrc = "";

  // the link is opened last (below), once everything it renders into exists
  let link: HabLink;

  /** Tell screen-reader users what just reached Earth (polite), or an alert (at once). */
  const announce = (text: string, urgent = false) => {
    const el = $(urgent ? "#mc-shout" : "#mc-say");
    el.textContent = "";
    window.setTimeout(() => (el.textContent = text), 50); // a change, even when the same words repeat
  };

  function apply(m: ServerMsg): void {
    switch (m.type) {
      case "snapshot": {
        const s = m.snap;
        L.plan = s.plan;
        L.crewOnline = s.crewOnline;
        L.eva = s.eva;
        L.now = s.now;
        L.lightTimeS = s.lightTimeS;
        L.frames = s.frames;
        L.log = s.log.map((entry) => ({ entry, arrivedT: entry.t + s.lightTimeS }));
        L.notes = new Map(s.notes.map((note) => [note.id, { note, arrivedT: (note.evaT ?? 0) + s.lightTimeS }]));
        L.outbox = new Map(s.outbox.map((o) => [o.id, o]));
        L.alert = [...s.log].reverse().find((e) => e.kind === "alert") ?? null;
        break;
      }
      case "plan":
        L.plan = m.plan;
        if (!L.eva?.running) L.lightTimeS = m.plan.lightTimeS;
        break;
      case "crew":
        if (L.crewOnline !== m.online) announce(m.online ? "Crew device connected to the hab." : "Crew device disconnected from the hab.");
        L.crewOnline = m.online;
        break;
      case "eva":
        if (m.eva && m.eva.id !== L.eva?.id) {
          L.frames = [];
          L.log = [];
          L.alert = null;
          for (const [id, msg] of L.outbox) if (msg.delivered || !msg.immediate) L.outbox.delete(id);
          for (const [id, n] of L.notes) if (n.note.evaT !== null) L.notes.delete(id);
          void loadHistory();
        }
        L.eva = m.eva;
        if (m.eva?.ended) void loadHistory();
        break;
      case "clock":
        L.now = m.now;
        L.lightTimeS = m.lightTimeS;
        L.speed = m.speed;
        L.live = m.live;
        break;
      case "frame":
        L.frames.push(m.frame);
        break;
      case "log":
        L.log.push({ entry: m.entry, arrivedT: L.now });
        if (m.entry.kind === "alert") {
          L.alert = m.entry;
          announce(`Received from Mars: ${m.entry.text}. It happened ${fmtLight(L.now - m.entry.t)} ago.`, true);
        }
        break;
      case "note":
        if (!L.notes.has(m.note.id)) announce(`${m.note.sample ? "Sample" : "Field note"} ${m.note.label} received${m.note.text ? `: ${m.note.text.replace(/[.\s]+$/, "")}` : ""}.`);
        L.notes.set(m.note.id, { note: m.note, arrivedT: L.now });
        break;
      case "note-removed":
        L.notes.delete(m.id);
        break;
      case "outbox":
        if (m.msg.delivered && !L.outbox.get(m.msg.id)?.delivered && !m.msg.immediate) announce(`Your message reached the crew: ${m.msg.text}`);
        L.outbox.set(m.msg.id, m.msg);
        break;
    }
  }

  async function loadHistory(): Promise<void> {
    try {
      history = ((await habApi.evas(site)) as EvaRecord[]).slice().reverse().slice(0, 8);
      $("#mc-history").innerHTML = history.length
        ? history
            .map((e, i) => {
              const last = e.log[e.log.length - 1];
              const alert = e.log.some((l) => l.kind === "alert");
              const canReplay = (e.frames?.length ?? 0) > 1;
              return `<li><b>${new Date(e.ended ?? "").toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</b><span>${e.aborted ? "Ended early" : "Completed"}${alert ? " · storm alert" : ""} · ${e.log.length} log entries${last ? ` · last at EVA ${fmtClock(last.t)}` : ""}${e.plan ? ` · ${fmtDistM(e.plan.distanceM)} planned` : ""}</span>${
                canReplay ? `<button data-replay="${i}">▶ Replay</button>` : `<small>No telemetry kept (recorded before replays existed).</small>`
              }</li>`;
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
    for (const st of S.plan?.stops ?? []) stopNames.set(st.id, st.short);
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
    $("#mc-shown").textContent = f ? `T+${fmtClock(f.t)}` : S.eva ? "no signal yet" : "—";
    $("#mc-shown-lmst").textContent = f ? `${f.lmst} LMST on Mars` : "";

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
      tile("Oxygen", `${Math.round(f.o2LeftL)} L`, reserveHit ? "bad" : "", `<i class="bar" aria-hidden="true"><u style="width:${Math.max(0, Math.min(100, (f.o2LeftL / P.o2SupplyL) * 100)).toFixed(1)}%"></u><em style="left:${((P.o2ReserveL / P.o2SupplyL) * 100).toFixed(1)}%"></em></i>`),
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
        const answer = S.log.find((l) => l.entry.ref === m.id)?.entry;
        const change = m.change ? `<p class="change">Revised plan: ${[...m.change.drop.map((id) => `drop ${esc(stopNames.get(id) ?? id)}`), ...(m.change.add.length ? [`add ${m.change.add.length} stop${m.change.add.length === 1 ? "" : "s"}`] : [])].join(", ")}</p>` : "";
        const reply = m.change ? (answer ? `<b class="${answer.accepted ? "yes" : "no"}">Crew ${answer.accepted ? "accepted" : "declined"} · ${m.immediate ? "heard at once (no EVA running)" : `Earth heard it at T+${fmtClock(answer.t + S.lightTimeS)}`}</b>` : m.delivered ? `<b>Waiting for the crew's answer</b>` : "") : "";
        return `<li class="${m.delivered ? "done" : "flight"}">${m.text ? `<p>${esc(m.text)}</p>` : ""}${change}<small>Sent T+${fmtClock(m.sentT)} · ${state}</small>${reply}</li>`;
      })
      .join("");
    ($("#mc-send") as HTMLButtonElement).disabled = S.link !== "online" || !!replay;
    ($("#mc-propose") as HTMLButtonElement).disabled = S.link !== "online" || !!replay || !S.plan;
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
        g.arc(X(f.buddy.x), Y(f.buddy.y), 4.5, 0, Math.PI * 2);
        g.fillStyle = "#ffe3a8";
        g.strokeStyle = "#0b0d10";
        g.lineWidth = 1.5;
        g.fill();
        g.stroke();
        // with two astronauts, say which is which
        g.font = "600 10px 'IBM Plex Mono', monospace";
        g.fillStyle = "#ffe3a8";
        g.shadowColor = "rgba(0,0,0,0.8)";
        g.shadowBlur = 3;
        g.fillText("EV2", X(f.buddy.x) + 7, Y(f.buddy.y) + 12);
        g.fillStyle = "#ffc45c";
        g.fillText("EV1", X(f.x) + 9, Y(f.y) - 8);
        g.shadowBlur = 0;
      }
    }
    if (editing) {
      for (const id of editing.drop) {
        const st = P.stops.find((x) => x.id === id);
        if (!st) continue;
        g.strokeStyle = "#ff6257";
        g.lineWidth = 3;
        g.beginPath();
        g.moveTo(X(st.x) - 8, Y(st.y) - 8);
        g.lineTo(X(st.x) + 8, Y(st.y) + 8);
        g.moveTo(X(st.x) + 8, Y(st.y) - 8);
        g.lineTo(X(st.x) - 8, Y(st.y) + 8);
        g.stroke();
      }
      editing.add.forEach((p, i) => {
        g.beginPath();
        g.arc(X(p.x), Y(p.y), 8, 0, Math.PI * 2);
        g.fillStyle = "rgba(70, 224, 207, 0.25)";
        g.strokeStyle = "#46e0cf";
        g.lineWidth = 2;
        g.fill();
        g.stroke();
        g.font = "600 11px 'IBM Plex Mono', monospace";
        g.fillStyle = "#fff";
        g.fillText(`+${i + 1}`, X(p.x) + 11, Y(p.y) + 4);
      });
    }
    const lf = lastFrame();
    canvas.setAttribute(
      "aria-label",
      lf
        ? `Map of the walk area. Planned route with ${P.stops.length} stops. Crew last received at EVA ${fmtClock(lf.t)}: ${lf.status} ${lf.next}${lf.nextDistM > 0 ? `, ${fmtDistM(lf.nextDistM)} to go` : ""}.`
        : `Map of the walk area. Planned route with ${P.stops.length} stops; no crew position received yet.`,
    );
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

  // ---------------------------------------------------------------- replay of a past EVA
  /** What Earth knew at Earth time `t` of a recorded EVA (and, for the truth toggle, where the crew was). */
  function replayState(rec: EvaRecord, t: number): State {
    const lt = rec.lightTimeS;
    const seen = (at: number) => at + lt <= t;
    const frames = rec.frames.filter((f) => seen(f.t));
    const log = rec.log.filter((e) => seen(e.t)).map((entry) => ({ entry, arrivedT: entry.t + lt }));
    const mars = [...rec.frames].reverse().find((f) => f.t <= t) ?? rec.frames[0];
    return {
      link: L.link,
      crewOnline: false,
      plan: rec.plan,
      eva: { id: rec.evaId ?? "replay", running: t < (rec.lastFrame?.t ?? 0), ended: t >= (rec.lastFrame?.t ?? 0) },
      now: t,
      lightTimeS: lt,
      speed: 0,
      live: mars ? { x: mars.x, y: mars.y } : null,
      frames,
      log,
      notes: new Map(rec.notes.filter((n) => n.evaT !== null && seen(n.evaT)).map((note) => [note.id, { note, arrivedT: (note.evaT ?? 0) + lt }])),
      outbox: new Map(rec.outbox.filter((m) => m.sentT <= t).map((m) => [m.id, { ...m, delivered: m.deliverT <= t }])),
      alert: [...log].reverse().find((l) => l.entry.kind === "alert")?.entry ?? null,
    };
  }

  function showReplay(): void {
    if (!replay) return;
    S = replayState(replay.rec, replay.t);
    $<HTMLInputElement>("#mc-replay-t").value = String(Math.round(replay.t));
    $("#mc-replay-clock").textContent = `Earth clock T+${fmtClock(replay.t)} · seeing Mars at T+${fmtClock(Math.max(0, replay.t - replay.rec.lightTimeS))}`;
    $("#mc-replay-play").textContent = replay.playing ? "❚❚" : "▶";
    $("#mc-replay-play").setAttribute("aria-label", replay.playing ? "Pause" : "Play");
    render();
  }

  function startReplay(rec: EvaRecord): void {
    stopReplay(false);
    const end = (rec.lastFrame?.t ?? rec.frames[rec.frames.length - 1]?.t ?? 0) + rec.lightTimeS + 30;
    replay = { rec, t: 0, end, playing: true, timer: 0 };
    const bar = $("#mc-replay");
    bar.hidden = false;
    $("#mc-replay-title").textContent = `Replay · ${new Date(rec.ended ?? "").toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
    const range = $<HTMLInputElement>("#mc-replay-t");
    range.max = String(Math.ceil(end));
    // marks on the timeline: what happened on Mars, and when Earth found out
    const pos = (t: number) => `${Math.max(0, Math.min(100, (t / end) * 100)).toFixed(2)}%`;
    const marks: string[] = [];
    for (const e of rec.log) {
      if (e.kind !== "alert" && !e.ref) continue;
      marks.push(`<i class="k-alert" style="left:${pos(e.t)}" title="On Mars at T+${fmtClock(e.t)}: ${esc(e.text)}"></i>`);
      marks.push(`<i class="k-earth" style="left:${pos(e.t + rec.lightTimeS)}" title="Earth finds out at T+${fmtClock(e.t + rec.lightTimeS)}"></i>`);
    }
    for (const m of rec.outbox) marks.push(`<i class="k-msg" style="left:${pos(m.sentT)}" title="Earth sends at T+${fmtClock(m.sentT)}"></i>`);
    $("#mc-replay-marks").innerHTML = marks.join("");
    tickReplay();
    bar.scrollIntoView({ block: "nearest" });
  }

  function tickReplay(): void {
    if (!replay) return;
    window.clearInterval(replay.timer);
    if (replay.playing) {
      replay.timer = window.setInterval(() => {
        if (!replay) return;
        replay.t = Math.min(replay.end, replay.t + 0.1 * Number($<HTMLSelectElement>("#mc-replay-speed").value));
        if (replay.t >= replay.end) {
          replay.playing = false;
          window.clearInterval(replay.timer);
        }
        showReplay();
      }, 100);
    }
    showReplay();
  }

  function stopReplay(show = true): void {
    if (replay) window.clearInterval(replay.timer);
    replay = null;
    S = L;
    $("#mc-replay").hidden = true;
    if (show) render();
  }

  $("#mc-history").addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-replay]");
    const rec = b ? history[Number(b.dataset.replay)] : null;
    if (rec) startReplay(rec);
  });
  $("#mc-replay-play").addEventListener("click", () => {
    if (!replay) return;
    if (replay.t >= replay.end) replay.t = 0;
    replay.playing = !replay.playing;
    tickReplay();
  });
  $("#mc-replay-t").addEventListener("input", (ev) => {
    if (!replay) return;
    replay.t = Number((ev.target as HTMLInputElement).value);
    replay.playing = false;
    tickReplay();
  });
  $("#mc-replay-exit").addEventListener("click", () => stopReplay());

  // ---------------------------------------------------------------- proposing a revised plan
  function renderChanges(): void {
    const box = $("#mc-propose-box");
    const btn = $("#mc-propose");
    box.hidden = !editing;
    btn.setAttribute("aria-pressed", String(!!editing));
    btn.textContent = editing ? "Editing the plan on the map…" : "Propose a plan change";
    if (!editing) return;
    const items = [
      ...editing.drop.map((id) => `<li>Drop ${esc(S.plan?.stops.find((st) => st.id === id)?.name ?? id)}</li>`),
      ...editing.add.map((p, i) => `<li>Add stop +${i + 1} (${Math.round(p.x)}, ${Math.round(p.y)})</li>`),
    ];
    $("#mc-changes").innerHTML = items.join("") || `<li class="empty">No changes yet.</li>`;
    ($("#mc-propose-send") as HTMLButtonElement).disabled = !items.length;
  }
  $("#mc-propose").addEventListener("click", () => {
    editing = editing ? null : { drop: [], add: [] };
    renderChanges();
    draw();
  });
  $("#mc-propose-cancel").addEventListener("click", () => {
    editing = null;
    renderChanges();
    draw();
  });
  $("#mc-propose-send").addEventListener("click", () => {
    if (!editing) return;
    const note = $<HTMLTextAreaElement>("#mc-text").value.trim();
    if (link.send({ type: "say", text: note, change: editing })) {
      $<HTMLTextAreaElement>("#mc-text").value = "";
      editing = null;
      renderChanges();
      draw();
    }
  });
  canvas.addEventListener("click", (ev) => {
    if (!editing || !S.plan || replay) return;
    const r = canvas.getBoundingClientRect();
    const size = r.width;
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    const x = (px / size) * S.plan.sizeM, y = (1 - py / size) * S.plan.sizeM;
    const hit = S.plan.stops.find((st) => st.kind !== "shelter" && Math.hypot(((st.x - x) / S.plan!.sizeM) * size, ((st.y - y) / S.plan!.sizeM) * size) < 14);
    if (hit) editing.drop = editing.drop.includes(hit.id) ? editing.drop.filter((id) => id !== hit.id) : [...editing.drop, hit.id];
    else if (editing.add.length < 3) editing.add.push({ x: Math.round(x), y: Math.round(y) });
    renderChanges();
    draw();
  });

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
    if (!replay) render();
  });
  link.onState((st) => {
    L.link = st;
    if (st === "online") void loadHistory();
    render();
  });
}
