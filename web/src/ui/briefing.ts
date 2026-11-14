import type { SiteData } from "../data/loaders";
import { $, esc, LOGO_SVG } from "./dom";

/**
 * Mission briefing: the story, plus a regional CTX map of Jezero with Perseverance's real traverse,
 * the sample depot, Cheyava Falls and the EVA area — and a global locator from Mars Trek.
 */
export function showBriefing(site: SiteData, onEnter: () => void): void {
  const host = $("#briefing");
  const c = site.context;
  const W = 1000;
  const H = W / c.aspect;
  const px = (uv: [number, number] | number[]) => `${(uv[0] * W).toFixed(1)},${(uv[1] * H).toFixed(1)}`;
  const line = c.traverse.points.map((p) => px(p)).join(" ");
  const [u0, v0] = c.aoi.uv0;
  const [u1, v1] = c.aoi.uv1;
  const depot = c.places.find((p) => p.id === "threeforks")!;
  const chey = c.places.find((p) => p.id === "cheyava")!;

  const places = c.places
    .map((p) => {
      const [x, y] = [p.uv[0] * W, p.uv[1] * H];
      const left = p.uv[0] > 0.55;
      return `<g class="place ${p.id}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7"/><text x="${(x + (left ? -13 : 13)).toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="${left ? "end" : "start"}">${esc(p.name)}</text><title>${esc(p.note)} (sol ${p.sol})</title></g>`;
    })
    .join("");

  host.innerHTML = `
    <div class="brief">
      <section class="brief-text">
        <div class="brief-brand">${LOGO_SVG}<div><h1>CAIRN</h1><p>Crew Assisted Integrated Route Navigator</p></div></div>
        <h2>The rocks Perseverance found. The path humans will walk.</h2>
        <p>In 2024 Perseverance cored a rock called <b>Cheyava Falls</b> on the edge of an ancient river channel in Jezero Crater. In September 2025 NASA reported its “leopard spots” as a <b>potential biosignature</b> — the strongest candidate sign of ancient life found on Mars so far. A rover cannot settle the question.</p>
        <p><b>Your mission:</b> walk to it. CAIRN layers data from four NASA missions and the USGS into one map, finds the safest route for a person in a spacesuit, and gets you back to the rover if the Sun turns on you.</p>
        <ul class="brief-facts">
          <li><b>${c.depotToCheyavaKm} km</b><span>from the Three Forks sample depot to Cheyava Falls — a rover drive, not a walk</span></li>
          <li><b>${(site.meta.sizeM / 1000).toFixed(1)} × ${(site.meta.sizeM / 1000).toFixed(1)} km</b><span>EVA area mapped at 1 m elevation and 25 cm imagery</span></li>
          <li><b>${c.traverse.totalKm} km</b><span>driven by Perseverance up to sol ${c.traverse.lastSol} — the trail we follow</span></li>
        </ul>
        <button id="brief-enter" class="primary big">Open the EVA planner →</button>
        <p class="fine">Every map layer, photo and reading comes from NASA, USGS or JPL archives — see “Data sources” in the planner. Suit and physiology numbers are labelled demo assumptions.</p>
      </section>
      <section class="brief-map">
        <div class="region">
          <img src="${site.base}${c.image}" alt="CTX orthomosaic of Jezero Crater" />
          <svg viewBox="0 0 ${W} ${H.toFixed(1)}" preserveAspectRatio="none">
            <polyline class="trav" points="${line}"/>
            <line class="drive" x1="${(depot.uv[0] * W).toFixed(1)}" y1="${(depot.uv[1] * H).toFixed(1)}" x2="${(chey.uv[0] * W).toFixed(1)}" y2="${(chey.uv[1] * H).toFixed(1)}"/>
            <rect class="aoi" x="${(u0 * W).toFixed(1)}" y="${(v0 * H).toFixed(1)}" width="${((u1 - u0) * W).toFixed(1)}" height="${((v1 - v0) * H).toFixed(1)}"/>
            <text class="aoi-label" x="${(u0 * W).toFixed(1)}" y="${(v1 * H + 22).toFixed(1)}">EVA area</text>
            ${places}
          </svg>
          <div class="globe">
            <img src="${site.base}${c.global.image}" alt="Global map of Mars" />
            <i style="left:${(c.global.siteUv[0] * 100).toFixed(2)}%;top:${(c.global.siteUv[1] * 100).toFixed(2)}%"></i>
            <span>Jezero Crater · ${c.global.lat.toFixed(2)}°N ${c.global.lon.toFixed(2)}°E</span>
          </div>
        </div>
        <p class="fine">Regional map: ${esc(c.source)} (${c.widthKm} × ${c.heightKm} km). Green line: ${esc(c.traverse.source)}. Global map: ${esc(c.global.source)}.</p>
      </section>
    </div>`;
  host.hidden = false;
  $("#brief-enter", host).addEventListener("click", () => {
    host.hidden = true;
    onEnter();
  });
}
