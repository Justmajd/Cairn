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
  const close = () => (host.hidden = true);
  $(".close", host).addEventListener("click", close);
  host.addEventListener("click", (ev) => ev.target === host && close(), { once: true });
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
       <li><b>Measured:</b> Curiosity RAD dose rates from the PDS archive. Background before the storm: ${r.rad.baselineUGyH} µGy/h. Curiosity is in Gale crater, about 3,700 km from Jezero.</li>
       <li><b>Gap:</b> the archive holds 2–4 hours of dosimetry per sol, so the first ~13 hours of the 20 May 2024 storm are not recorded there.</li>
       <li><b>Model:</b> ${esc(r.model.description)} Modelled peak: ${Math.round(r.model.peakUGyH).toLocaleString()} µGy/h. Assumed onset at Mars: ${esc(r.event.assumedOnsetUtc.replace("T", " ").replace(":00Z", " UTC"))}.</li>
       <li><b>Alert:</b> CAIRN raises the alarm when the outdoor dose rate exceeds ${ALERT_FACTOR}× background. The real DONKI notification (${esc(r.donki.alert.messageID)}) was issued ${r.donki.alert.delayAfterCmeStartH.toFixed(1)} hours after the eruption and did not list Mars — a crew needs on-site detection.</li>
       <li><b>Shelter:</b> dose rate inside the rover is ${p.shelterFactor}× outdoors (assumption).</li>
     </ul>
     <h3>Display</h3>
     <ul>
       <li>HiRISE is a grey image; the Mars colour is a display tint. Fine grain near the camera in the Visor view is a rendering effect.</li>
       <li>THEMIS is ~${m.themisNativeResM} m per pixel and the USGS geologic map is 1:75,000 — both are coarse at walking scale.</li>
     </ul>`,
  );
}

/** Stop card: what Perseverance saw there, why it matters, and what a human adds. */
export function stopCardHtml(poi: Poi, base: string, unitName: string | null, arrived: boolean): string {
  const imgs = poi.images
    .map(
      (im, i) => `<figure class="${i === 0 ? "on" : ""}" data-i="${i}">
        <img src="${base}${im.file}" alt="${esc(poi.name)} — ${esc(im.cameraName)}, sol ${im.sol}"/>
        <figcaption>Perseverance · ${esc(im.cameraName)} · sol ${im.sol} · ${esc(im.credit)} · <a href="${esc(im.link)}" target="_blank" rel="noopener">source ↗</a></figcaption>
      </figure>`,
    )
    .join("");
  const dots = poi.images.length > 1 ? `<div class="dots">${poi.images.map((_, i) => `<button data-i="${i}" class="${i === 0 ? "on" : ""}" aria-label="Photo ${i + 1}"></button>`).join("")}</div>` : "";
  return `
    <header><span class="kicker">${arrived ? "Arrived — this is what you see" : poi.kind === "shelter" ? "Rover and shelter" : "What you will see"}</span>
      <h3>${esc(poi.name)}</h3><button class="close icon" aria-label="Close">${ic.close}</button></header>
    ${poi.images.length ? `<div class="gallery">${imgs}${dots}</div>` : ""}
    <p>${esc(poi.description)}</p>
    ${poi.science ? `<p class="sci"><b>Science</b>${esc(poi.science)}</p>` : ""}
    ${poi.whyHumans ? `<p class="why"><b>Why send a human</b>${esc(poi.whyHumans)}</p>` : ""}
    <p class="meta">${poi.rmc ? `Perseverance stood here on sols ${esc(poi.sols)} (rover position ${esc(poi.rmc)}).` : "Custom stop added on the map."}${unitName ? ` USGS map unit: ${esc(unitName)}.` : ""}</p>`;
}
