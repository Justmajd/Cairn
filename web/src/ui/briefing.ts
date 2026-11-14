import type { SiteData, SiteEntry } from "../data/loaders";
import { $, esc, LOGO_SVG } from "./dom";
import { dissolve } from "./dissolve";
import { prefetchSite } from "../data/prefetch";
import { marsSky } from "../eva/sky";

/**
 * Mission briefing: the site's story, a regional orbital map with the rover's real traverse and the
 * EVA area, a global locator from Mars Trek, and a switch between sites.
 */
export function showBriefing(site: SiteData, onEnter: () => void, sites: SiteEntry[] = []): void {
  const host = $("#briefing");
  const c = site.context;
  const W = 1000;
  const H = W / c.aspect;
  const px = (uv: [number, number] | number[]) => `${(uv[0] * W).toFixed(1)},${(uv[1] * H).toFixed(1)}`;
  const line = c.traverse?.points.map((p) => px(p)).join(" ") ?? "";
  const [u0, v0] = c.aoi.uv0;
  const [u1, v1] = c.aoi.uv1;
  const place = (id: string) => c.places.find((p) => p.id === id);
  const links = (c.links ?? [])
    .map((l) => [place(l.from), place(l.to)])
    .filter((pair): pair is [NonNullable<ReturnType<typeof place>>, NonNullable<ReturnType<typeof place>>] => !!pair[0] && !!pair[1])
    .map(([a, b]) => `<line class="drive" x1="${(a.uv[0] * W).toFixed(1)}" y1="${(a.uv[1] * H).toFixed(1)}" x2="${(b.uv[0] * W).toFixed(1)}" y2="${(b.uv[1] * H).toFixed(1)}"/>`)
    .join("");
  const story = site.meta.story ?? { headline: site.meta.name, paragraphs: [] };
  const centre = site.meta.centerLonLat ?? { lon: (site.meta.boundsLonLat.west + site.meta.boundsLonLat.east) / 2, lat: (site.meta.boundsLonLat.south + site.meta.boundsLonLat.north) / 2 };
  const lightS = marsSky(Date.parse(site.meta.eva?.utc ?? "2024-07-21T02:10:26Z"), centre.lat, centre.lon).lightTimeS;
  const lightText = `${Math.round(lightS / 60)} minutes`;
  const rover = site.meta.rover?.name ?? "the rover";
  const lat = c.global.lat;
  const latText = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"} ${c.global.lon.toFixed(2)}°E`;

  const places = c.places
    .map((p) => {
      const [x, y] = [p.uv[0] * W, p.uv[1] * H];
      const left = p.uv[0] > 0.55;
      return `<g class="place ${p.id}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7"/><text x="${(x + (left ? -13 : 13)).toFixed(1)}" y="${(y + 5).toFixed(1)}" text-anchor="${left ? "end" : "start"}">${esc(p.name)}</text><title>${esc(p.note)}${p.sol !== undefined ? ` (sol ${p.sol})` : ""}</title></g>`;
    })
    .join("");
  const switcher = sites.length > 1
    ? `<div class="brief-sites" role="tablist">${sites
        .map((s) => `<a role="tab" class="${s.id === site.id ? "on" : ""}" href="?site=${s.id}"><b>${esc(s.name)}</b><span>${esc(s.place)}${s.rover ? ` · ${esc(s.rover)}` : ""}</span></a>`)
        .join("")}</div>`
    : "";

  host.innerHTML = `
    <div class="brief">
      <section class="brief-text">
        <div class="brief-brand">${LOGO_SVG}<div><h1>CAIRN</h1><p>Crew Assisted Integrated Route Navigator</p></div></div>
        ${switcher}
        <h2>${esc(story.headline)}</h2>
        ${story.paragraphs.map((p) => `<p>${p}</p>`).join("")}
        <ul class="brief-facts">${c.facts.map((f) => `<li><b>${esc(f.value)}</b><span>${esc(f.label)}</span></li>`).join("")}</ul>
        <div class="brief-cta">
          <button id="brief-enter" class="primary big">Open the EVA planner →</button>
          <button id="brief-demo" class="big">▶ Watch the 2-minute demo</button>
        </div>
        <button id="brief-mc" class="brief-mc"><b>Mission Control</b><span>Watch the EVA from Earth, ${lightText} behind Mars, and message the crew</span></button>
        <p class="fine">Every map layer, photo and reading comes from NASA, USGS or JPL archives — see About → Data sources in the planner. Suit and physiology numbers are labelled demo assumptions.</p>
      </section>
      <section class="brief-map">
        <div class="region">
          <img src="${site.base}${c.image}" alt="Regional orbital image around the EVA area" />
          <svg viewBox="0 0 ${W} ${H.toFixed(1)}" preserveAspectRatio="none">
            ${line ? `<polyline class="trav" points="${line}"/>` : ""}
            ${links}
            <rect class="aoi" x="${(u0 * W).toFixed(1)}" y="${(v0 * H).toFixed(1)}" width="${((u1 - u0) * W).toFixed(1)}" height="${((v1 - v0) * H).toFixed(1)}"/>
            <text class="aoi-label" x="${(u0 * W).toFixed(1)}" y="${(v1 * H + 22).toFixed(1)}">EVA area</text>
            ${places}
          </svg>
          <div class="globe">
            <img src="${site.base}${c.global.image}" alt="${c.global.zones ? "Regional map of Mars around the site" : "Global map of Mars"}" />
            ${c.global.zones?.length ? `<svg viewBox="0 0 1 1" preserveAspectRatio="none">${c.global.zones
              .map((z) => `<ellipse class="ez" cx="${z.uv[0]}" cy="${z.uv[1]}" rx="${z.rUv[0]}" ry="${z.rUv[1]}"><title>NASA Exploration Zone "${esc(z.name)}" (2015), ${c.global.zoneRadiusKm} km radius — centre ${z.km} km from the EVA area</title></ellipse>`)
              .join("")}</svg>` : ""}
            <i style="left:${(c.global.siteUv[0] * 100).toFixed(2)}%;top:${(c.global.siteUv[1] * 100).toFixed(2)}%"></i>
            <span>${esc(site.meta.name.split(" — ")[0])} · ${latText}</span>
          </div>
        </div>
        <p class="fine">Regional map: ${esc(c.source)} (${c.widthKm} × ${c.heightKm} km). ${c.traverse ? `Green line: ${esc(rover)}'s traverse, ${esc(c.traverse.source)}. ` : ""}${c.global.zones?.length
          ? `Locator: ${esc(c.global.source)}, ${c.global.spanDeg![0]}° × ${c.global.spanDeg![1]}°. Dashed circles: ${esc(c.global.zonesSource ?? "")} (${c.global.zoneRadiusKm} km radius); the nearest centre is ${c.global.zones[0].km} km from the EVA area.`
          : `Global map: ${esc(c.global.source)}.`}</p>
      </section>
    </div>`;
  host.hidden = false;
  // pointing at another site warms the cache with its data, so the switch is quick
  host.querySelectorAll<HTMLAnchorElement>(".brief-sites a").forEach((a) => {
    const id = new URLSearchParams(a.search).get("site");
    if (id && id !== site.id) for (const ev of ["pointerenter", "focus", "touchstart"]) a.addEventListener(ev, () => prefetchSite(id), { once: true, passive: true });
  });
  // into the planner: the headline becomes the site name in the top bar, the logo flies there too
  const close = () => void dissolve(() => {
    host.hidden = true;
  });
  $("#brief-enter", host).addEventListener("click", () => {
    close();
    onEnter();
  });
  $("#brief-mc", host).addEventListener("click", () => {
    window.open(`?view=mission&site=${encodeURIComponent(site.id)}`, `cairn-mc-${site.id}`, "noopener");
  });
  $("#brief-demo", host).addEventListener("click", () => {
    close();
    window.dispatchEvent(new CustomEvent("cairn:demo"));
  });
}
