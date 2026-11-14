import type { RadiationModel } from "../eva/radiation";
import type { MeasuredPath, Poi, ReplayData } from "../types";
import { esc, fmtDist } from "./dom";

/** Okabe-Ito colours (safe with red-green colour blindness), matching the map layers. */
const slopeColor = (deg: number, blocked: boolean): string =>
  blocked ? "#cc79a7" : deg < 10 ? "#56b4e9" : deg < 18 ? "#f0e442" : "#e69f00";

export interface ProfileHandle {
  /** Move the "you are here" cursor to a distance along the route (metres), or hide it. */
  setCursor(distM: number | null): void;
}

/**
 * Elevation profile of the whole EVA: height against distance walked, coloured by terrain slope,
 * with a sand strip underneath and a marker at every stop.
 */
export function renderProfile(
  host: HTMLElement,
  legs: MeasuredPath[],
  stops: Poi[],
  ghost: MeasuredPath[] | null,
  noRadio: ((x: number, y: number, leg: number, sample: number) => boolean) | null = null,
): ProfileHandle {
  const W = Math.max(320, host.clientWidth);
  const H = Math.max(90, host.clientHeight);
  const pad = { l: 46, r: 12, t: 16, b: 20 };
  const total = legs.reduce((s, l) => s + l.distance, 0) || 1;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const leg of legs) for (const s of leg.samples) { zMin = Math.min(zMin, s.z); zMax = Math.max(zMax, s.z); }
  if (ghost) for (const leg of ghost) for (const s of leg.samples) { zMin = Math.min(zMin, s.z); zMax = Math.max(zMax, s.z); }
  if (!Number.isFinite(zMin)) { zMin = 0; zMax = 1; }
  const span = Math.max(8, zMax - zMin);
  zMin -= span * 0.12;
  zMax += span * 0.12;
  const X = (d: number) => pad.l + (d / total) * (W - pad.l - pad.r);
  const Y = (z: number) => pad.t + (1 - (z - zMin) / (zMax - zMin)) * (H - pad.t - pad.b);

  let svg = "";
  for (let k = 0; k <= 2; k++) {
    const z = zMin + ((zMax - zMin) * k) / 2;
    svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(z).toFixed(1)}" y2="${Y(z).toFixed(1)}"/><text class="axis" x="${pad.l - 6}" y="${(Y(z) + 3).toFixed(1)}" text-anchor="end">${Math.round(z)} m</text>`;
  }

  if (ghost) {
    const gTotal = ghost.reduce((s, l) => s + l.distance, 0) || 1;
    let off = 0;
    let path = "";
    for (const leg of ghost) {
      for (const s of leg.samples) path += `${path ? "L" : "M"}${X(((off + s.dist) / gTotal) * total).toFixed(1)},${Y(s.z).toFixed(1)}`;
      off += leg.distance;
    }
    svg += `<path class="ghost" d="${path}"/>`;
  }

  // stretches with no radio contact: shaded columns behind the trace
  if (noRadio) {
    let off = 0;
    let bands = "";
    legs.forEach((leg, li) => {
      let start: number | null = null;
      leg.samples.forEach((smp, i) => {
        const lost = noRadio(smp.x, smp.y, li, i);
        if (lost && start === null) start = off + smp.dist;
        if ((!lost || i === leg.samples.length - 1) && start !== null) {
          const x1 = X(start);
          bands += `<rect x="${x1.toFixed(1)}" y="${pad.t}" width="${Math.max(1.5, X(off + smp.dist) - x1).toFixed(1)}" height="${H - pad.t - pad.b}"/>`;
          start = null;
        }
      });
      off += leg.distance;
    });
    svg += `<g class="noradio">${bands}</g>`;
  }

  let offset = 0;
  let area = `M${X(0).toFixed(1)},${(H - pad.b).toFixed(1)}`;
  let lines = "";
  let sand = "";
  for (const leg of legs) {
    const stride = Math.max(1, Math.floor(leg.samples.length / 400));
    let prev = leg.samples[0];
    area += `L${X(offset).toFixed(1)},${Y(prev.z).toFixed(1)}`;
    for (let i = stride; i < leg.samples.length; i += stride) {
      const s = leg.samples[Math.min(i, leg.samples.length - 1)];
      const x1 = X(offset + prev.dist);
      const x2 = X(offset + s.dist);
      lines += `<line x1="${x1.toFixed(1)}" y1="${Y(prev.z).toFixed(1)}" x2="${x2.toFixed(1)}" y2="${Y(s.z).toFixed(1)}" stroke="${slopeColor(s.slopeDeg, s.blocked)}"/>`;
      if (s.sand > 0.5) sand += `<rect x="${x1.toFixed(1)}" y="${H - pad.b + 3}" width="${Math.max(1, x2 - x1).toFixed(1)}" height="4"/>`;
      area += `L${x2.toFixed(1)},${Y(s.z).toFixed(1)}`;
      prev = s;
    }
    offset += leg.distance;
  }
  area += `L${X(total).toFixed(1)},${(H - pad.b).toFixed(1)}Z`;
  svg += `<path class="area" d="${area}"/><g class="trace">${lines}</g><g class="sand">${sand}</g>`;

  let d = 0;
  stops.forEach((stop, i) => {
    const x = X(d);
    const anchor = i === 0 ? "start" : i === stops.length - 1 ? "end" : "middle";
    svg += `<line class="stop" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${pad.t - 2}" y2="${H - pad.b}"/><text class="stop-label" x="${x.toFixed(1)}" y="${pad.t - 5}" text-anchor="${anchor}">${esc(stop.short)}</text>`;
    if (i < legs.length) d += legs[i].distance;
  });
  svg += `<text class="axis" x="${W - pad.r}" y="${H - 4}" text-anchor="end">${fmtDist(total)} walked</text>`;
  svg += `<text class="axis" x="${pad.l}" y="${H - 4}">0</text>`;
  svg += `<g class="cursor" visibility="hidden"><line y1="${pad.t - 2}" y2="${H - pad.b}"/><circle r="4"/></g>`;

  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Elevation profile of the planned route">${svg}</svg>`;
  const cursor = host.querySelector<SVGGElement>(".cursor")!;
  const line = cursor.querySelector("line")!;
  const dot = cursor.querySelector("circle")!;

  // elevation lookup for the cursor dot
  const flat: { d: number; z: number }[] = [];
  let acc = 0;
  for (const leg of legs) {
    for (const s of leg.samples) flat.push({ d: acc + s.dist, z: s.z });
    acc += leg.distance;
  }
  return {
    setCursor(distM) {
      if (distM === null || flat.length === 0) {
        cursor.setAttribute("visibility", "hidden");
        return;
      }
      let lo = 0;
      let hi = flat.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (flat[mid].d <= distM) lo = mid;
        else hi = mid;
      }
      const x = X(Math.min(total, distM));
      cursor.setAttribute("visibility", "visible");
      line.setAttribute("x1", x.toFixed(1));
      line.setAttribute("x2", x.toFixed(1));
      dot.setAttribute("cx", x.toFixed(1));
      dot.setAttribute("cy", Y(flat[lo].z).toFixed(1));
    },
  };
}

export interface DoseChartHandle {
  /** `hSinceOnset` is the storm clock; `shelteredFromH` shades the time spent inside the rover. */
  update(hSinceOnset: number, shelteredFromH: number | null): void;
}

/**
 * Dose-rate chart of the 20 May 2024 storm.  Dots are Curiosity RAD measurements (real);
 * the dashed line is the model that fills the hours RAD did not record.
 * The time axis is stretched for the first 3 hours — the part an EVA cares about.
 */
export function renderDoseChart(host: HTMLElement, replay: ReplayData, rad: RadiationModel, shelterFactor: number): DoseChartHandle {
  const W = Math.max(260, host.clientWidth);
  const H = 150;
  const pad = { l: 40, r: 8, t: 10, b: 26 };
  const split = 0.5;
  const X = (h: number) => {
    const w = W - pad.l - pad.r;
    const f = h <= 3 ? (Math.max(-0.5, h) + 0.5) / 3.5 * split : split + ((Math.min(48, h) - 3) / 45) * (1 - split);
    return pad.l + f * w;
  };
  const yMin = Math.log10(3);
  const yMax = Math.log10(6000);
  const Y = (rate: number) => pad.t + (1 - (Math.log10(Math.max(3, rate)) - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

  let svg = "";
  for (const v of [10, 100, 1000]) {
    svg += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/><text class="axis" x="${pad.l - 5}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end">${v >= 1000 ? "1k" : v}</text>`;
  }
  for (const h of [0, 1, 2, 3, 12, 24, 36, 48]) {
    svg += `<line class="tick" x1="${X(h).toFixed(1)}" x2="${X(h).toFixed(1)}" y1="${H - pad.b}" y2="${H - pad.b + 4}"/><text class="axis" x="${X(h).toFixed(1)}" y="${H - pad.b + 14}" text-anchor="middle">${h}</text>`;
  }
  svg += `<line class="split" x1="${X(3).toFixed(1)}" x2="${X(3).toFixed(1)}" y1="${pad.t}" y2="${H - pad.b}"/>`;
  svg += `<text class="axis" x="${(W - pad.r).toFixed(1)}" y="${H - 2}" text-anchor="end">hours after onset (axis compressed after 3 h)</text>`;
  svg += `<text class="axis" x="4" y="${pad.t + 2}">µGy/h</text>`;
  svg += `<rect class="shelter-band" x="0" y="${pad.t}" width="0" height="${H - pad.t - pad.b}"/>`;

  let path = "";
  for (let h = -0.5; h <= 48; h += h < 3 ? 0.02 : 0.25) path += `${path ? "L" : "M"}${X(h).toFixed(1)},${Y(rad.baseline + rad.excessAt(h)).toFixed(1)}`;
  svg += `<path class="model" d="${path}"/>`;
  let inside = "";
  for (let h = 0; h <= 48; h += h < 3 ? 0.02 : 0.25) inside += `${inside ? "L" : "M"}${X(h).toFixed(1)},${Y((rad.baseline + rad.excessAt(h)) * shelterFactor).toFixed(1)}`;
  svg += `<path class="inside" d="${inside}"/>`;
  for (const m of replay.rad.measured) {
    if (m.hFromOnset < -0.5 || m.hFromOnset > 48) continue;
    svg += `<circle class="rad" cx="${X(m.hFromOnset).toFixed(1)}" cy="${Y(m.uGyH).toFixed(1)}" r="2.2"/>`;
  }
  svg += `<g class="cursor" visibility="hidden"><line y1="${pad.t}" y2="${H - pad.b}"/><circle r="4"/></g>`;
  host.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Dose rate during the 20 May 2024 storm">${svg}</svg>
    <div class="chart-key"><span><i class="k-rad"></i>RAD measured (Curiosity, PDS)</span><span><i class="k-model"></i>Model, outdoors</span><span><i class="k-inside"></i>Model, in rover</span></div>`;

  const cursor = host.querySelector<SVGGElement>(".cursor")!;
  const line = cursor.querySelector("line")!;
  const dot = cursor.querySelector("circle")!;
  const band = host.querySelector<SVGRectElement>(".shelter-band")!;
  return {
    update(h, shelteredFromH) {
      const x = X(h);
      cursor.setAttribute("visibility", "visible");
      line.setAttribute("x1", x.toFixed(1));
      line.setAttribute("x2", x.toFixed(1));
      dot.setAttribute("cx", x.toFixed(1));
      const outdoors = rad.baseline + rad.excessAt(h);
      dot.setAttribute("cy", Y(shelteredFromH !== null && h >= shelteredFromH ? outdoors * shelterFactor : outdoors).toFixed(1));
      if (shelteredFromH !== null && h > shelteredFromH) {
        band.setAttribute("x", X(shelteredFromH).toFixed(1));
        band.setAttribute("width", Math.max(0, x - X(shelteredFromH)).toFixed(1));
      } else band.setAttribute("width", "0");
    },
  };
}
