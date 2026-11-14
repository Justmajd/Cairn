import type { Poi } from "../types";
import { $, esc } from "./dom";
import { ic } from "./icons";
import { hideAnimated, showAnimated } from "./motion";

export function openModal(title: string, bodyHtml: string, wide = true): void {
  const host = $("#modal");
  host.innerHTML = `<div class="modal-box${wide ? " wide" : ""}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header><h2>${esc(title)}</h2><button class="close icon" aria-label="Close">${ic.close}</button></header>
      <div class="modal-body">${bodyHtml}</div>
    </div>`;
  showAnimated(host);
  const opener = document.activeElement as HTMLElement | null;
  const close = () => {
    hideAnimated(host, 160);
    opener?.focus?.(); // back to whatever opened the dialog
  };
  $(".close", host).addEventListener("click", close);
  $<HTMLButtonElement>(".close", host).focus();
  host.addEventListener("click", (ev) => ev.target === host && close(), { once: true });
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

export function stopCardHtml(poi: Poi, base: string, unitName: string | null, arrived: boolean, rover = "Perseverance", panorama: string | null = null, orbital: OrbitalImage | null = null): string {
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
    ? `<button class="look" data-pano="${esc(poi.id)}">${ic.visor}<span>Look around 360°</span><small>${esc(panorama)}</small></button>`
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
