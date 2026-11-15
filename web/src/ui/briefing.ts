import type { BriefSite, SiteEntry } from "../data/loaders";
import { $, esc, fmtClock, LOGO_SVG } from "./dom";
import { liveEvas, liveNow, liveSiteName, liveState } from "../hab/live";
import type { LiveEva } from "../hab/protocol";
import { dissolve, dissolveTo } from "./dissolve";
import { marsSky } from "../eva/sky";
import { countUp, playOnce, pointerGlow, scramble } from "./fx";

/**
 * Mission briefing: the site's story, a regional orbital map with the rover's real traverse and the
 * EVA area, a global locator from Mars Trek, and a switch between sites.
 *
 * "page": it is the main menu, a page of its own; its buttons load the planner (or the demo) for the
 * site.  "overlay": opened over a running planner (About → Mission briefing); its buttons close it.
 */
export function showBriefing(site: BriefSite, sites: SiteEntry[] = [], mode: "page" | "overlay" = "overlay"): void {
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
  const index = Math.max(0, sites.findIndex((s) => s.id === site.id));
  const eyebrow = `<p class="eyebrow"><span>Site ${String(index + 1).padStart(2, "0")} / ${String(Math.max(1, sites.length)).padStart(2, "0")}</span><span class="rule" aria-hidden="true">${(sites.length ? sites : [site])
    .map((_, i) => `<i class="${i === index ? "on" : ""}"></i>`)
    .join("")}</span><span class="code" id="brief-code">// ${esc(latText)}</span></p>`;
  // the headline in display capitals, one sentence per line; the second in steel
  const sentences = story.headline.split(/(?<=[.!?])\s+/).filter(Boolean);
  const headline = sentences.map((t, i) => `<span class="line"><span class="${i > 0 ? "s" : ""}">${esc(t)}</span></span>`).join("");
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
        <div id="brief-live" class="brief-live" aria-live="polite" hidden></div>
        ${eyebrow}
        <h2>${headline}</h2>
        ${story.paragraphs.map((p) => `<p>${p}</p>`).join("")}
        <ul class="brief-facts">${c.facts.map((f) => `<li><b>${esc(f.value)}</b><span>${esc(f.label)}</span></li>`).join("")}</ul>
        <div class="brief-cta">
          <button id="brief-enter" class="primary big">Open the EVA planner →</button>
          <button id="brief-demo" class="big">▶ Watch the 2-minute demo</button>
          <button id="brief-roam" class="big roam" title="Walk anywhere in the suit, in Mars gravity: lope, jump, slide, and watch your oxygen">Free roam on foot</button>
        </div>
        <div class="brief-links">
          <button id="brief-mc" class="brief-mc"><b>Mission Control</b><span>Watch the EVA from Earth, ${lightText} behind Mars, and message the crew</span></button>
          <button id="brief-ev2" class="brief-mc ev2"><b>Join as EV2</b><span>The second astronaut, on another device: walk the EVA with EV1</span></button>
        </div>
        <p class="fine">Every map layer, photo and reading comes from NASA, USGS or JPL archives — see About → Data sources in the planner. Suit and physiology numbers are labelled demo assumptions.</p>
      </section>
      <section class="brief-map">
        <div class="region">
          <img src="${site.base}${c.image}" alt="Regional orbital image around the EVA area" />
          <svg viewBox="0 0 ${W} ${H.toFixed(1)}" preserveAspectRatio="none">
            ${line ? `<polyline class="trav" pathLength="1" points="${line}"/>` : ""}
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
  scramble($("#brief-code", host), 1100);
  host.querySelectorAll<HTMLElement>(".brief-facts b").forEach((b, i) => countUp(b, 1500, 450 + i * 70));
  // listeners on the host go on once: the briefing is drawn again into the same element
  if (!host.dataset.glow) {
    host.dataset.glow = "1";
    pointerGlow(host, ".brief-mc");
  }
  // into the planner: the headline becomes the site name in the top bar, the logo flies there too
  const close = () => void dissolve(() => {
    host.hidden = true;
    playOnce(document.getElementById("app"), "boot", 1700); // the console assembles as the curtain opens
  });
  const id = encodeURIComponent(site.id);
  // the plan in the address (#stops=…) goes along to the planner
  $("#brief-enter", host).addEventListener("click", () => (mode === "page" ? dissolveTo(`?site=${id}&skip=1${location.hash}`) : close()));
  $("#brief-ev2", host).addEventListener("click", () => {
    location.href = `?site=${id}&skip=1&crew=ev2`;
  });
  $("#brief-roam", host).addEventListener("click", () => dissolveTo(`?site=${id}&roam=1`));
  $("#brief-mc", host).addEventListener("click", () => {
    window.open(`?view=mission&site=${id}`, `cairn-mc-${site.id}`, "noopener");
  });
  $("#brief-demo", host).addEventListener("click", () => {
    if (mode === "page") return dissolveTo(`?site=${id}&demo=1`);
    close();
    window.dispatchEvent(new CustomEvent("cairn:demo"));
  });
  if (mode === "page") watchLive($("#brief-live", host), site.id);
}

const LIVE_POLL_MS = 10_000;

/**
 * The main menu's "live EVA" card: an EVA under way on the hab, on any site, with a way straight into
 * that EVA's own Mission Control (or to join it as EV2).  Hidden when nothing is running or there is
 * no hab (a static host).
 */
function watchLive(box: HTMLElement, here: string): void {
  let live: LiveEva[] = [];
  let at = 0; // when the hab answered (performance.now)
  let shownKey = "";

  const statusText = (e: LiveEva) =>
    `T+${fmtClock(liveNow(e, performance.now() - at))} · ${liveState(e)} · Earth sees it ${Math.round(e.lightTimeS / 60)} min late`;

  const draw = () => {
    // the rows are rebuilt only when the set of EVAs changes; the clocks update in place
    const key = live.map((e) => `${e.site}|${e.evaId}`).join(",");
    if (key !== shownKey) {
      shownKey = key;
      box.innerHTML = live
        .map((e) => {
          const name = esc(liveSiteName(e));
          const where = e.site === here ? "at this site" : `at ${name}`;
          const who = [e.ev2 ? `EV1 + ${e.ev2 > 1 ? `${e.ev2} × ` : ""}EV2` : "EV1", `${e.stops} stop${e.stops === 1 ? "" : "s"}`, e.mc ? `${e.mc} watching from Earth` : ""].filter(Boolean).join(" · ");
          return `<div class="brief-live-row" data-site="${esc(e.site)}">
            <span class="pulse" aria-hidden="true"></span>
            <div class="t"><small>// Live EVA ${where}</small><b>${name}</b><span class="clock"></span><span class="who">${esc(who)}</span></div>
            <div class="acts">
              <button class="primary" data-mc="${esc(e.site)}">Mission Control →</button>
              <button data-ev2="${esc(e.site)}">Join as EV2</button>
            </div>
          </div>`;
        })
        .join("");
      box.hidden = live.length === 0;
    }
    for (const e of live) {
      const clock = box.querySelector(`[data-site="${CSS.escape(e.site)}"] .clock`);
      if (clock) clock.textContent = statusText(e);
    }
  };

  const poll = async () => {
    if (document.hidden || !box.isConnected) return;
    const got = await liveEvas();
    live = got ?? [];
    at = performance.now();
    // the EVA at this site first, then the rest by name
    live.sort((a, b) => Number(b.site === here) - Number(a.site === here) || a.siteName.localeCompare(b.siteName));
    draw();
  };

  box.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!btn) return;
    const mc = btn.dataset.mc;
    const ev2 = btn.dataset.ev2;
    if (mc) window.open(`?view=mission&site=${encodeURIComponent(mc)}`, `cairn-mc-${mc}`, "noopener");
    if (ev2) location.href = `?site=${encodeURIComponent(ev2)}&skip=1&crew=ev2`;
  });

  void poll();
  const pollTimer = window.setInterval(poll, LIVE_POLL_MS);
  const clockTimer = window.setInterval(() => live.length && !document.hidden && draw(), 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void poll();
  });
  // the briefing is drawn again into the same element (site switch): stop this one's timers then
  const stopOnRedraw = new MutationObserver(() => {
    if (box.isConnected) return;
    clearInterval(pollTimer);
    clearInterval(clockTimer);
    stopOnRedraw.disconnect();
  });
  stopOnRedraw.observe(box.parentElement?.parentElement?.parentElement ?? document.body, { childList: true });
}
