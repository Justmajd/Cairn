import type { SiteData } from "../data/loaders";
import type { EvaBudget } from "../eva/budget";
import type { EvaParams } from "../eva/params";
import type { RadioCoverage } from "../eva/radio";
import type { MeasuredPath, Poi } from "../types";
import { renderProfile } from "./charts";
import { $, esc, fmtDist, fmtDose, fmtDur, LOGO_SVG } from "./dom";
import { ic } from "./icons";

export interface CueRow {
  poi: Poi;
  arriveS: number;
  departS: number;
  leg: MeasuredPath | null; // leg walked to reach this stop
  o2LeftAtDepartL: number;
  homeTimeS: number;
  homeO2L: number;
  bearingHome: number;
  sunEl: number;
  shade: boolean; // in the shadow of the terrain on arrival
  lmst: string;
  cover: string;
}

export interface CueCardInput {
  site: SiteData;
  params: EvaParams;
  budget: EvaBudget;
  order: Poi[];
  legs: MeasuredPath[];
  rows: CueRow[];
  start: { lmst: string; sunEl: number; sunAz: number };
  end: { lmst: string; sunEl: number };
  alertUGyH: number;
  rover: string;
  storm: boolean;
  buddy: boolean;
  doseUGy: number;
  /** Radio line of sight to the rover: coverage, and which route points are out of contact. */
  radio?: {
    coverage: RadioCoverage;
    lostAt: (x: number, y: number, leg: number, sample: number) => boolean;
    relay: { at: { x: number; y: number }; alongM: number; mastM: number; toward: string | null } | null;
    silentStops: string[]; // stops out of contact while the crew works there
  };
}

/** One line for the card: how much of the walk keeps radio contact with the rover. */
function radioLine(c: RadioCoverage): string {
  if (c.gaps === 0) return "Radio: line of sight to the rover the whole way.";
  const pct = Math.round(c.coveredFraction * 100);
  return `Radio: line of sight to the rover for ${pct}% of the walk; ${c.gaps} blackout${c.gaps > 1 ? "s" : ""} (dashed on the map), longest ${fmtDur(c.longestGapS)}. Report position before each.`;
}

const compass = (az: number) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(az / 45) % 8];
const tplus = (s: number) => {
  const m = Math.round(s / 60);
  return `T+${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
};

/** Route map for the card: HiRISE image cropped to the route, with stops, north arrow and scale bar. */
function mapSvg(input: CueCardInput, W: number, H: number): string {
  const size = input.site.meta.sizeM;
  const pts = input.legs.flatMap((l) => l.samples);
  let x0 = Math.min(...pts.map((p) => p.x));
  let x1 = Math.max(...pts.map((p) => p.x));
  let y0 = Math.min(...pts.map((p) => p.y));
  let y1 = Math.max(...pts.map((p) => p.y));
  const pad = Math.max(60, Math.max(x1 - x0, y1 - y0) * 0.12);
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
  // match the box aspect
  const want = W / H;
  if ((x1 - x0) / (y1 - y0) < want) {
    const c = (x0 + x1) / 2, half = ((y1 - y0) * want) / 2;
    x0 = c - half; x1 = c + half;
  } else {
    const c = (y0 + y1) / 2, half = (x1 - x0) / want / 2;
    y0 = c - half; y1 = c + half;
  }
  const sx = W / (x1 - x0);
  const X = (x: number) => (x - x0) * sx;
  const Y = (y: number) => (y1 - y) * sx;
  const line = (path: MeasuredPath) => path.samples.filter((_, i) => i % 2 === 0).map((s) => `${X(s.x).toFixed(1)},${Y(s.y).toFixed(1)}`).join(" ");
  const nice = [20, 50, 100, 200, 500].find((v) => v * sx > W * 0.12) ?? 500;
  const stops = input.order.slice(0, -1).map((p, i) => {
    const home = p.kind === "shelter";
    return `<g transform="translate(${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)})">
      <circle r="9" class="${home ? "home" : "stop"}"/><text class="n" text-anchor="middle" dy="3.5">${home ? "R" : i}</text>
      <text class="lbl" x="13" dy="4">${esc(p.short)}</text></g>`;
  });
  return `<svg class="cc-map" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    <image href="${input.site.base}${input.site.meta.texture.file}" x="${X(0)}" y="${Y(size)}" width="${size * sx}" height="${size * sx}" preserveAspectRatio="none" class="ground"/>
    ${input.legs.map((l) => `<polyline class="route-halo" points="${line(l)}"/><polyline class="route" points="${line(l)}"/>`).join("")}
    ${input.radio ? blackoutLines(input.legs, input.radio.lostAt, X, Y) : ""}
    ${input.radio?.relay ? `<g transform="translate(${X(input.radio.relay.at.x).toFixed(1)},${Y(input.radio.relay.at.y).toFixed(1)})"><path d="M0,-9 L8,0 L0,9 L-8,0Z" class="relay"/><text class="lbl" x="12" dy="4">Relay</text></g>` : ""}
    ${stops.join("")}
    <g transform="translate(${W - 26},28)"><path d="M0,-16 L7,6 L0,1 L-7,6Z" class="north"/><text y="18" text-anchor="middle" class="nl">N</text></g>
    <g transform="translate(14,${H - 16})"><rect width="${nice * sx}" height="5" class="bar"/><text y="-5" class="nl">${nice} m</text></g>
  </svg>`;
}

/** Stretches of the route with no line of sight to the rover, drawn over the route as dashes. */
function blackoutLines(legs: MeasuredPath[], lostAt: (x: number, y: number, leg: number, sample: number) => boolean, X: (x: number) => number, Y: (y: number) => number): string {
  const out: string[] = [];
  legs.forEach((leg, li) => {
    let run: string[] = [];
    const flush = () => {
      if (run.length > 1) out.push(`<polyline class="no-radio" points="${run.join(" ")}"/>`);
      run = [];
    };
    leg.samples.forEach((s, i) => {
      if (lostAt(s.x, s.y, li, i)) run.push(`${X(s.x).toFixed(1)},${Y(s.y).toFixed(1)}`);
      else flush();
    });
    flush();
  });
  return out.join("");
}

/** Build the one-page cue card and show it in a preview with a Print / Save as PDF button. */
export function showCueCard(input: CueCardInput): void {
  const { site, params: P, budget: b } = input;
  const reserve = P.o2SupplyL * P.reserveFraction;
  const title = site.meta.name.split(" — ");
  const rows = input.rows
    .map((r, i) => {
      const leg = r.leg;
      const hazards = leg
        ? [
            `max ${leg.maxSlopeDeg}°`,
            leg.climb >= 3 ? `climb ${Math.round(leg.climb)} m` : "",
            leg.sandM >= 10 ? `sand ${Math.round(leg.sandM)} m` : "",
          ].filter(Boolean).join(" · ")
        : "—";
      const turnBack = Math.ceil(r.homeO2L + reserve);
      return `<tr class="${r.poi.kind === "shelter" ? "home" : ""}">
        <td class="c">${r.poi.kind === "shelter" ? (i === 0 ? "R" : "R") : i}</td>
        <td><b>${esc(r.poi.name)}</b>${r.poi.dwellMin && r.poi.kind !== "shelter" ? `<small>${r.poi.dwellMin} min science</small>` : ""}</td>
        <td class="m">${leg ? fmtDist(leg.distance) : "—"}<small>${leg ? fmtDur(leg.time) : ""}</small></td>
        <td class="m">${tplus(r.arriveS)}<small>${r.lmst} LMST</small></td>
        <td class="m">${r.poi.kind === "shelter" && i > 0 ? "—" : tplus(r.departS)}</td>
        <td>${hazards}</td>
        <td class="m">${Math.round(r.o2LeftAtDepartL)} L</td>
        <td class="m">${r.poi.kind === "shelter" ? "—" : `${fmtDur(r.homeTimeS)}<small>${compass(r.bearingHome)} ${Math.round(r.bearingHome)}°</small>`}</td>
        <td class="m warn">${r.poi.kind === "shelter" ? "—" : `${turnBack} L`}</td>
        <td class="m">${Math.round(r.sunEl)}°${r.shade ? `<br><small>in shade</small>` : ""}</td>
      </tr>`;
    })
    .join("");

  const html = `
  <article class="cuecard">
    <header class="cc-head">
      <div class="cc-brand">${LOGO_SVG}<div><b>CAIRN · EVA cue card</b><span>${esc(title[0])} — ${esc(title[1] ?? "")}</span></div></div>
      <dl class="cc-meta">
        <div><dt>Sol (EVA date)</dt><dd>${site.meta.eva?.sol ?? "—"}</dd></div>
        <div><dt>Leave rover</dt><dd>${input.start.lmst} LMST</dd></div>
        <div><dt>Back by</dt><dd>${input.end.lmst} LMST</dd></div>
        <div><dt>Distance</dt><dd>${fmtDist(b.distanceM)}</dd></div>
        <div><dt>Time outside</dt><dd>${fmtDur(b.totalTimeS)}</dd></div>
        <div><dt>O₂ used / supply</dt><dd>${Math.round(b.o2UsedL)} / ${P.o2SupplyL} L</dd></div>
        <div><dt>Crew</dt><dd>${input.buddy ? "EV1 + EV2" : "EV1"}</dd></div>
      </dl>
    </header>
    <section class="cc-body">
      <div class="cc-left">
        ${mapSvg(input, 520, 420)}
        <div class="cc-profile" id="cc-profile"></div>
      </div>
      <div class="cc-right">
        <table class="cc-table">
          <thead><tr><th>#</th><th>Stop</th><th>Leg</th><th>Arrive</th><th>Leave</th><th>Leg hazards</th><th>O₂ left</th><th>To rover</th><th>Turn back if O₂ &lt;</th><th>Sun</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="cc-boxes">
          <div class="cc-box">
            <h4>${ic.warn} Limits</h4>
            <ul>
              <li>Slopes over ${site.meta.model.slopeLimitDeg}° are off-limits; the planned route stays under ${b.maxSlopeDeg}°.</li>
              <li>Keep ${Math.round(P.reserveFraction * 100)}% oxygen (${Math.round(reserve)} L) in reserve. Turn back at the value in the table.</li>
              <li>Maximum EVA ${P.maxEvaH} h. ${input.buddy ? `EV1 and EV2 stay within ${P.buddyMaxSeparationM} m.` : "Report position at every stop."}</li>
              ${input.radio ? `<li>${radioLine(input.radio.coverage)}${input.radio.silentStops.length ? ` <b>No contact at ${input.radio.silentStops.map(esc).join(" or ")}:</b> agree a check-in time before going there.` : ""}</li>` : ""}
              ${input.radio?.relay ? `<li>Relay: stand the ${input.radio.relay.mastM} m mast up after ${fmtDist(input.radio.relay.alongM)}${input.radio.relay.toward ? ` (on the way to ${esc(input.radio.relay.toward)})` : ""}, at ◆ on the map. Check the link to the rover before walking on.</li>` : ""}
              <li>Sun ${Math.round(input.start.sunEl)}° at departure, ${Math.round(input.end.sunEl)}° at return${input.start.sunEl < 15 || input.end.sunEl < 15 ? " — low sun: shadows hide holes and rocks." : "."}</li>
            </ul>
          </div>
          <div class="cc-box storm">
            <h4>${ic.rad} Solar particle event</h4>
            <ul>
              <li>Abort when the dose rate passes <b>${Math.round(input.alertUGyH)} µGy/h</b> (3× background) or on a space-weather alert.</li>
              <li>Walk straight to the rover: bearing and time from each stop are in the table. Inside, the dose rate halves (assumption).</li>
              <li>Natural cover nearby: ${esc(input.rows.map((r) => r.cover).filter(Boolean)[0] ?? "terrain here blocks under 3% of the dose — use the rover")}.</li>
              <li>Planned background dose for this EVA: ${fmtDose(input.doseUGy)}.</li>
            </ul>
          </div>
        </div>
      </div>
    </section>
    <footer class="cc-foot">
      <span>Terrain: HiRISE (NASA/JPL/UArizona) · Positions and photos: ${esc(site.meta.rover?.mission ?? "")} (NASA/JPL-Caltech) · Radiation: Curiosity RAD (PDS) · Space weather: NASA DONKI.</span>
      <span>Suit and physiology values are demo assumptions, not flight data. Generated by CAIRN.</span>
    </footer>
  </article>`;

  const host = $("#modal");
  host.innerHTML = `<div class="modal-box wide cc-modal" role="dialog" aria-modal="true" aria-label="EVA cue card">
      <header><h2>EVA cue card</h2><div class="cc-actions"><button class="primary" id="cc-print">${ic.book}<span>Print / save as PDF</span></button><button class="close icon" aria-label="Close">${ic.close}</button></div></header>
      <div class="modal-body cc-scroll">${html}</div>
    </div>`;
  host.hidden = false;
  renderProfile($("#cc-profile"), input.legs, input.order, null);
  const close = () => (host.hidden = true);
  $(".close", host).addEventListener("click", close);
  $("#cc-print", host).addEventListener("click", () => {
    const print = $("#print");
    print.innerHTML = html;
    renderProfile($("#cc-profile", print), input.legs, input.order, null);
    window.print();
  });
}
