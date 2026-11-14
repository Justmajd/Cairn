/**
 * About → Data sources and Suit and model assumptions: long reference dialogs, loaded the first time
 * one is opened (they are not needed to start the planner).
 */
import { RELAY_MAST_M, ROVER_ANTENNA_M, SUIT_ANTENNA_M } from "../eva/radio";
import type { SiteData } from "../data/loaders";
import { ALERT_FACTOR } from "../replay/mission";
import { EvaParams, PARAM_NOTES } from "../eva/params";
import { esc } from "./dom";
import { openModal } from "./modals";

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
     <h3>Dust storms, the rover ghost and the field notebook</h3>
     <ul>
       <li>Dust by sol is the rovers' own record of dust optical depth (τ, 880 nm, from images of the Sun): Perseverance Mastcam-Z (Lemmon, Mendeley Data, DOI 10.17632/gktjp9jptb.1, preliminary) and Curiosity Mastcam (Lemmon et al. 2024, NASA PDS, DOI 10.17189/fjh0-2978). Jezero uses the value measured on the EVA's sol; Gale's record ends at sol 3953, so its EVA uses the median of the same season (Ls ± 7°) over six Mars years; Deuteronilus has no rover, so Perseverance's record at the same season stands in. Any sol of the record can be picked from the Display menu.</li>
       <li>Voice notes become text on the device with Whisper tiny (English, 8-bit) run in the browser (transformers.js). The model is served by the hab after <code>npm run fetch-speech</code>; without it the model weights are downloaded once from Hugging Face. The recording itself is never sent anywhere.</li>
       <li>Dust presets are measured optical depths (τ): Jezero clear 0.4 and the January 2022 regional storm 1.4 (Perseverance Mastcam-Z, sols 312 and 316), Gale's 2018 global storm above 8 (Curiosity Mastcam, June 2018) and 10.8 at Meridiani (Opportunity, June 2018). What τ does to the scene is a model: direct sunlight e^(−Δτ/sin elevation), sky light e^(−0.18 Δτ), visibility 3.9·H/τ with the dust mixed through an 11 km scale height. The view adapts its exposure like an eye (it shows about √ of the drop in light); the HUD gives the real numbers.</li>
       <li>The rover ghost replays the rover's end-of-drive positions from NASA's MMGIS waypoint layer, joined by straight lines and timed by sol (it waits between drives, as the rover did). During an EVA the whole drive is stretched over your walk.</li>
       <li>Field notes, samples and voice clips stay in this browser (local storage); nothing is uploaded. Voice notes are kept as audio, not transcribed.</li>
     </ul>
     <h3>Hab site map</h3>
     <ul>
       <li>Every 8 m spot is scored as the site of the crew's base (habitat, landing pad, parked rover). Flat ground is required: the mean slope of a ~24 m footprint (full marks at 3° or less, none at 10°), less for steep or impassable patches and loose sand. It multiplies a weighted mean of: walking time to the stops in the plan (weight 50), stops in direct radio line of sight from a 3 m mast (30), terrain radiation shielding (20) and, at Deuteronilus, walking time to the stops on buried ice (35).</li>
       <li>The weights are CAIRN's choice for a short surface stay, not NASA criteria. Landing safety at the scale of a real lander (rocks under 1 m, plume debris, approach paths) is not modelled.</li>
     </ul>
     ${site.meta.minerals ? `<h3>Minerals (CRISM)</h3>
     <ul>
       <li>Summary parameters from ${esc(site.meta.minerals.product)} at ${site.meta.minerals.mPerPx} m/px: OLINDEX3 (olivine), D2300 (Fe/Mg clay), MIN2295_2480 (carbonate).</li>
       <li>Strength is scaled to these observations; CRISM imaged ${Math.round(site.meta.minerals.coveragePct ?? 0)}% of the walk area. Band depths indicate likely minerals, not certainties.</li>
     </ul>` : ""}
     ${site.panoramas ? `<h3>360° panoramas</h3>
     <ul>${
       Object.values(site.panoramas.panoramas).some((p) => !p.nasa)
         ? `<li>${esc(site.panoramas.source)}. Each pixel's viewing ray is projected through every frame's published camera model; frames are feathered and exposure-matched. Unimaged sky and the ground under the rover are filled smoothly.</li>`
         : ""
     }${Object.entries(site.panoramas.panoramas)
       .filter(([, p]) => p.nasa)
       .map(([id, p]) => `<li>${esc(id)}: NASA/JPL-Caltech panorama <a href="${esc(p.nasa!.link)}" target="_blank" rel="noopener">${esc(p.nasa!.pia)}</a>, "${esc(p.nasa!.title)}" (${esc(p.nasa!.credit)}). CAIRN aligned it to north by matching its skyline with the horizon computed from the HiRISE terrain at the rover's position (median difference ${p.nasa!.alignErrDeg.toFixed(1)}°) and filled the sky and ground beyond the mosaic's edges.</li>`)
       .join("")}</ul>` : ""}
     <h3>Display</h3>
     <ul>
       <li>HiRISE is a grey image; the Mars colour is a display tint. Fine grain near the camera in the Visor view is a rendering effect.</li>
       <li>Close up, the ground and the small rocks use photo-scanned Earth materials (CC0, Poly Haven: Red Sand, Dry Ground Rocks, Cracked Red Ground, Rock Boulder Dry) chosen per spot from the sand map and HiRISE brightness. The 3D rocks under 70 cm are scattered from the terrain data, not mapped. Colour and brightness stay HiRISE's; this is rendering detail, not Mars data.</li>
       <li>Earth, Phobos and Deimos in the sky and the radio delay to Earth are computed for the EVA's date and time: planet positions from JPL's approximate Keplerian elements (Standish), Mars' rotation from the IAU (WGCCRE 2009), the moons from JPL's mean orbital elements. Good to about a degree in the sky, enough to look up and find them, not to time an eclipse. The delay is the one-way light time; real traffic through relay orbiters waits longer.</li>
       <li>THEMIS is ~${m.themisNativeResM} m per pixel and the USGS geologic map is 1:75,000 — both are coarse at walking scale.</li>
     </ul>`,
  );
}

