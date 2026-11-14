import { RELAY_MAST_M, ROVER_ANTENNA_M, SUIT_ANTENNA_M } from "../eva/radio";
import type { SiteData } from "../data/loaders";
import { ALERT_FACTOR } from "../replay/mission";
import { EvaParams, PARAM_NOTES } from "../eva/params";
import type { Poi } from "../types";
import { $, esc } from "./dom";
import { ic } from "./icons";

export function openModal(title: string, bodyHtml: string, wide = true): void {
  const host = $("#modal");
  host.innerHTML = `<div class="modal-box${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><h2>${esc(title)}</h2><button class="close icon" aria-label="Close">${ic.close}</button></header>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  host.hidden = false;
  const opener = document.activeElement as HTMLElement | null;
  const close = () => {
    host.hidden = true;
    opener?.focus?.(); // back to whatever opened the dialog
  };
  $(".close", host).addEventListener("click", close);
  $<HTMLButtonElement>(".close", host).focus();
  host.addEventListener("click", (ev) => ev.target === host && close(), { once: true });
}

/** Great-circle distance from Curiosity's storm position in Gale crater (4.73°S, 137.39°E) to the walk area. */
function galeDistanceKm(site: SiteData): number {
  const c = site.meta.centerLonLat ?? { lon: 0, lat: 0 };
  const r = Math.PI / 180;
  const [la1, lo1, la2, lo2] = [-4.73 * r, 137.39 * r, c.lat * r, c.lon * r];
  const cos = Math.sin(la1) * Math.sin(la2) + Math.cos(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
  return Math.round((Math.acos(Math.min(1, Math.max(-1, cos))) * 3389.5) / 100) * 100;
}

/** Provenance table: where every layer and reading comes from. */
export function showSources(site: SiteData, focusId?: string): void {
  const rows = site.provenance
    .map(
      (e) => `<tr id="src-${e.id}" class="${e.id === focusId ? "focus" : ""}">
        <td><b>${esc(e.layer)}</b><span class="tag">${esc(e.dataType)}</span></td>
        <td>${esc(e.mission)}<br/><span class="dim">${esc(e.instrument)}</span></td>
        <td>${esc(e.product)}<br/><span class="dim">${esc(e.provider)} · ${esc(e.credit)}</span>${e.note ? `<p class="note">${esc(e.note)}</p>` : ""}</td>
        <td>${esc(e.usedFor)}<br/><a href="${esc(e.url)}" target="_blank" rel="noopener">Open source ↗</a></td>
      </tr>`,
    )
    .join("");
  const types = [...new Set(site.provenance.map((e) => e.dataType.split(" ")[0]))].join(" · ");
  openModal(
    "Data sources",
    `<p class="lead">${site.provenance.length} datasets from NASA, USGS and JPL archives. Data types: ${esc(types)}.</p>
     <table class="sources"><thead><tr><th>Layer</th><th>Mission / instrument</th><th>Product</th><th>Used for</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
  if (focusId) document.getElementById(`src-${focusId}`)?.scrollIntoView({ block: "center" });
}

/** Every assumption behind the numbers, so nobody mistakes demo values for flight data. */
export function showAssumptions(site: SiteData, p: EvaParams): void {
  const m = site.meta.model;
  const r = site.replay;
  const params = PARAM_NOTES.map((n) => `<tr><td>${esc(n.label)}</td><td class="num">${p[n.key]} ${esc(n.unit)}</td><td>${esc(n.basis)}</td></tr>`).join("");
  openModal(
    "Model assumptions",
    `<p class="lead">CAIRN's terrain, images, weather and radiation readings are real mission data. The spacesuit and physiology numbers below are <b>demo assumptions</b>, not NASA specifications.</p>
     <h3>Spacesuit and physiology</h3>
     <table class="sources"><thead><tr><th>Parameter</th><th>Value</th><th>Basis</th></tr></thead><tbody>${params}</tbody></table>
     <h3>Walking model</h3>
     <ul>
       <li><b>Energy:</b> Minetti et al. (2002) metabolic cost of walking on slopes, per step of the route, using the real 1 m HiRISE elevation. Uphill costs more than downhill.</li>
       <li><b>Speed:</b> Tobler's hiking function, scaled for a suited walker and slowed on soft or rough ground.</li>
       <li><b>Loose sand:</b> up to ×${(1 + m.sandEffort).toFixed(1)} energy (Lejeune et al., 1998, walking on sand). <b>Rough ground:</b> up to ×${(1 + m.roughEffort).toFixed(1)}.</li>
       <li><b>Slope risk:</b> a fall-risk penalty starts at ${m.slopeRiskStartDeg}° and grows to ×${1 + m.slopeRiskMax} at ${m.slopeLimitDeg}°. Steeper ground is impassable. The router minimises energy × risk; oxygen is computed from energy alone.</li>
       <li><b>Way home:</b> the cost of walking back to the rover is pre-computed for all ${(site.grid.n * site.grid.n).toLocaleString()} grid points, so the emergency route is a lookup.</li>
     </ul>
     <h3>Radiation and the storm replay</h3>
     <ul>
       <li><b>Measured:</b> Curiosity RAD dose rates from the PDS archive. Background before the storm: ${r.rad.baselineUGyH} µGy/h. ${site.id === "gale" ? "Curiosity measured them about 2.3 km from this walk area." : `Curiosity is in Gale crater, about ${galeDistanceKm(site).toLocaleString()} km from this walk area.`}</li>
       <li><b>Gap:</b> the archive holds 2–4 hours of dosimetry per sol, so the first ~13 hours of the 20 May 2024 storm are not recorded there.</li>
       <li><b>Model:</b> ${esc(r.model.description)} Modelled peak: ${Math.round(r.model.peakUGyH).toLocaleString()} µGy/h. Assumed onset at Mars: ${esc(r.event.assumedOnsetUtc.replace("T", " ").replace(":00Z", " UTC"))}.</li>
       <li><b>Alert:</b> CAIRN raises the alarm when the outdoor dose rate exceeds ${ALERT_FACTOR}× background. The real DONKI notification (${esc(r.donki.alert.messageID)}) was issued ${r.donki.alert.delayAfterCmeStartH.toFixed(1)} hours after the eruption and did not list Mars — a crew needs on-site detection.</li>
       <li><b>Shelter:</b> dose rate inside the rover is ${p.shelterFactor}× outdoors (assumption).</li>
     </ul>
     <h3>Radio contact and practice emergencies</h3>
     <ul>
       <li><b>Radio:</b> suit radios work on UHF, which needs a clear line of sight on Mars. CAIRN sweeps rays from an antenna ${ROVER_ANTENNA_M} m up the rover's mast across the 1 m HiRISE terrain (and the curvature of Mars) and marks where a suit antenna ${SUIT_ANTENNA_M} m above the ground loses sight of it. No reflections are assumed: a worst case.</li>
       <li><b>Stops without contact:</b> a stop counts as silent when the rover (or the relay, once it is up) is out of sight from it; the relay search counts the time spent working there.</li>
       <li><b>Relay:</b> where the walk loses contact, CAIRN looks along the route for the spot where a portable relay on a ${RELAY_MAST_M} m mast (assumption) sees the rover and covers the most blackout time after the crew sets it up there. With the relay planned, contact during the EVA counts the relay from the moment the crew reaches it.</li>
       <li><b>Suit leak:</b> oxygen use doubles from that moment. <b>Twisted ankle:</b> walking takes twice as long. In both, CAIRN routes the quickest safe way home from the current position and compares the oxygen needed with what is left (both assumptions for practice, not suit data).</li>
     </ul>
     <h3>Sun, shadows and terrain shielding</h3>
     <ul>
       <li><b>Sun:</b> Mars24 algorithm (Allison & McEwen 2000, NASA GISS) for ${site.meta.eva?.sol !== undefined ? `sol ${site.meta.eva.sol}` : esc(site.meta.eva?.label ?? "the planning date")}. Checked against rover clocks: local solar time within a minute.</li>
       <li><b>Shadows:</b> cast from the real elevation grids (walk area and surroundings) by marching each pixel toward the Sun. A stop or the walker counts as <i>in shade</i> when the terrain hides the Sun from a point 1.2 m above the ground (chest height, assumption).</li>
       <li><b>Low sun:</b> below 8° of elevation long shadows hide rocks and holes, so the plan warns and the EVA alerts (threshold is an assumption). The dust-storm season is taken as solar longitude 180–360°.</li>
       <li><b>Rover parking:</b> the rover may be parked on ground of up to 10° slope (assumption); its drive there is not modelled. Moving it recomputes the way home from every point and its radio shadow.</li>
       <li><b>Terrain shielding:</b> share of the sky blocked by terrain within ${site.meta.shielding?.radiusM ?? 260} m, weighting each direction by cos${"\u00b2"} of its zenith angle (the dose falls toward the horizon; the exponent is an assumption). ${(() => {
         const sh = site.grid.shield;
         if (!sh) return "";
         let min = 255;
         for (let i = 0; i < sh.length; i++) if (sh[i] < min) min = sh[i];
         return `At this site terrain cuts the dose by at most ${Math.round((1 - min / 255) * 100)}%, and only right against cliff walls — the rover remains the real shelter.`;
       })()}</li>
     </ul>
     ${site.meta.minerals ? `<h3>Minerals (CRISM)</h3>
     <ul>
       <li>Summary parameters from ${esc(site.meta.minerals.product)} at ${site.meta.minerals.mPerPx} m/px: OLINDEX3 (olivine), D2300 (Fe/Mg clay), MIN2295_2480 (carbonate).</li>
       <li>Strength is scaled to these observations; CRISM imaged ${Math.round(site.meta.minerals.coveragePct ?? 0)}% of the walk area. Band depths indicate likely minerals, not certainties.</li>
     </ul>` : ""}
     ${site.panoramas ? `<h3>360° panoramas</h3>
     <ul><li>${esc(site.panoramas.source)}. Each pixel's viewing ray is projected through every frame's published camera model; frames are feathered and exposure-matched. Unimaged sky and the ground under the rover are filled smoothly.</li></ul>` : ""}
     <h3>Display</h3>
     <ul>
       <li>HiRISE is a grey image; the Mars colour is a display tint. Fine grain near the camera in the Visor view is a rendering effect.</li>
       <li>THEMIS is ~${m.themisNativeResM} m per pixel and the USGS geologic map is 1:75,000 — both are coarse at walking scale.</li>
     </ul>`,
  );
}

/** Stop card: what the rover saw there, why it matters, and what a human adds. */
/** Where to cut an orbital close-up for stops with no rover photos: the HiRISE image and its ground size. */
export interface OrbitalImage {
  url: string;
  sizeM: number;
  mPerPx: number;
}

/** A HiRISE close-up centred on a stop: a window of the walk-area image, drawn with CSS (no extra download). */
function orbitalTile(poi: Poi, img: OrbitalImage, widthM = 150): string {
  // window of widthM x 3/4 widthM metres centred on the stop, in percentages so it scales with the card
  const hM = (widthM * 3) / 4;
  const x0 = Math.min(Math.max(poi.x - widthM / 2, 0), img.sizeM - widthM);
  const y0 = Math.min(Math.max(img.sizeM - poi.y - hM / 2, 0), img.sizeM - hM);
  const px = (x0 / (img.sizeM - widthM)) * 100;
  const py = (y0 / (img.sizeM - hM)) * 100;
  const mx = ((poi.x - x0) / widthM) * 100; // where the stop falls in the window (near the edge of the map)
  const my = ((img.sizeM - poi.y - y0) / hM) * 100;
  return `<figure class="orbital on">
      <div class="orbital-img" style="background-image:url('${img.url}');background-size:${((img.sizeM / widthM) * 100).toFixed(1)}% auto;background-position:${px.toFixed(3)}% ${py.toFixed(3)}%"><i style="left:${mx.toFixed(1)}%;top:${my.toFixed(1)}%"></i></div>
      <figcaption>From orbit: HiRISE, ${widthM} m across at ${Math.round(img.mPerPx * 100)} cm per pixel · NASA/JPL/University of Arizona</figcaption>
    </figure>`;
}

export function stopCardHtml(poi: Poi, base: string, unitName: string | null, arrived: boolean, rover = "Perseverance", panorama = false, orbital: OrbitalImage | null = null): string {
  const imgs = poi.images
    .map(
      (im, i) => `<figure class="${i === 0 ? "on" : ""}" data-i="${i}">
        <img src="${base}${im.file}" alt="${esc(poi.name)} — ${esc(im.cameraName)}, sol ${im.sol}"/>
        <figcaption>${esc(rover)} · ${esc(im.cameraName)} · sol ${im.sol} · ${esc(im.credit)} · <a href="${esc(im.link)}" target="_blank" rel="noopener">source ↗</a></figcaption>
      </figure>`,
    )
    .join("");
  const dots = poi.images.length > 1 ? `<div class="dots">${poi.images.map((_, i) => `<button data-i="${i}" class="${i === 0 ? "on" : ""}" aria-label="Photo ${i + 1}"></button>`).join("")}</div>` : "";
  const look = panorama
    ? `<button class="look" data-pano="${esc(poi.id)}">${ic.visor}<span>Look around 360°</span><small>${esc(rover)} Navcam</small></button>`
    : "";
  return `
    <header><span class="kicker">${arrived ? "Arrived — this is what you see" : poi.kind === "shelter" ? "Rover and shelter" : "What you will see"}</span>
      <h3>${esc(poi.name)}</h3><button class="close icon" aria-label="Close">${ic.close}</button></header>
    ${poi.images.length ? `<div class="gallery">${imgs}${dots}</div>` : orbital ? `<div class="gallery">${orbitalTile(poi, orbital)}</div>` : ""}
    ${look}
    <p>${esc(poi.description)}</p>
    ${poi.science ? `<p class="sci"><b>Science</b>${esc(poi.science)}</p>` : ""}
    ${poi.whyHumans ? `<p class="why"><b>Why send a human</b>${esc(poi.whyHumans)}</p>` : ""}
    <p class="meta">${poi.rmc ? `${esc(rover)} stood here on sols ${esc(poi.sols)} (rover position ${esc(poi.rmc)}).` : poi.id.startsWith("custom-") ? "Custom stop added on the map." : "No rover has been here: the stop is chosen on the HiRISE terrain and imagery."}${unitName ? ` USGS map unit: ${esc(unitName)}.` : ""}</p>`;
}
