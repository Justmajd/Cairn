import type { SiteMeta, MeasuredPath, Poi } from "../types";
import { toLonLat } from "../data/geo";

export { toLonLat };

/** A stop on the exported plan, with the EVA clock at arrival. */
export interface ExportStop {
  poi: Poi;
  arriveS: number;
  lmst: string;
}

export interface ExportPlan {
  site: SiteMeta;
  legs: MeasuredPath[];
  stops: ExportStop[];
  distanceM: number;
  timeS: number;
  o2UsedL: number;
  startLmst: string;
  /** Portable radio relay the crew stands up on the way (local metres), if planned. */
  relay?: { x: number; y: number; mastM: number } | null;
  /** Field notebook entries (ui/notebook.ts). */
  notes?: { label: string; sample: boolean; x: number; y: number; elevM: number; text: string; audio: boolean; lmst: string; evaT: number | null; voiceFile?: string }[];
}

/** Route vertices with elevation, thinned to about one per 2 m of route. */
function routeCoords(plan: ExportPlan): [number, number, number][] {
  const out: [number, number, number][] = [];
  let last: { x: number; y: number } | null = null;
  for (const leg of plan.legs) {
    for (const s of leg.samples) {
      if (last && Math.hypot(s.x - last.x, s.y - last.y) < 2) continue;
      const [lon, lat] = toLonLat(plan.site, s.x, s.y);
      out.push([+lon.toFixed(7), +lat.toFixed(7), +s.z.toFixed(1)]);
      last = s;
    }
  }
  return out;
}

const minutes = (s: number) => Math.round(s / 60);

export function routeGeoJson(plan: ExportPlan): string {
  const features: object[] = [
    {
      type: "Feature",
      properties: {
        name: `CAIRN EVA route — ${plan.site.name}`,
        distance_m: Math.round(plan.distanceM),
        time_outside_min: minutes(plan.timeS),
        oxygen_used_l: Math.round(plan.o2UsedL),
        leave_rover_lmst: plan.startLmst,
      },
      geometry: { type: "LineString", coordinates: routeCoords(plan) },
    },
    ...plan.stops.map((s, i) => ({
      type: "Feature",
      properties: {
        name: s.poi.name,
        order: i,
        kind: s.poi.kind,
        arrive_eva_min: minutes(s.arriveS),
        arrive_lmst: s.lmst,
        dwell_min: s.poi.kind === "shelter" ? 0 : s.poi.dwellMin,
      },
      geometry: { type: "Point", coordinates: toLonLat(plan.site, s.poi.x, s.poi.y).map((v) => +v.toFixed(7)) },
    })),
    ...(plan.notes ?? []).map((n) => ({
      type: "Feature",
      properties: {
        name: n.label,
        kind: n.sample ? "sample" : "note",
        text: n.text,
        voice_note: n.audio,
        ...(n.voiceFile ? { voice_file: n.voiceFile } : {}),
        ...(n.evaT !== null ? { eva_min: minutes(n.evaT), lmst: n.lmst } : {}),
        elevation_m: +n.elevM.toFixed(1),
      },
      geometry: { type: "Point", coordinates: toLonLat(plan.site, n.x, n.y).map((v) => +v.toFixed(7)) },
    })),
    ...(plan.relay
      ? [{
          type: "Feature",
          properties: { name: "Radio relay", kind: "relay", mast_m: plan.relay.mastM },
          geometry: { type: "Point", coordinates: toLonLat(plan.site, plan.relay.x, plan.relay.y).map((v) => +v.toFixed(7)) },
        }]
      : []),
  ];
  return JSON.stringify(
    {
      type: "FeatureCollection",
      name: `cairn-${plan.site.id}`,
      // GeoJSON assumes Earth; these are Mars coordinates — say so for GIS tools that read it
      crs: { type: "name", properties: { name: "IAU_2015:49900" } },
      metadata: {
        body: "Mars",
        coordinates: "Mars 2000 planetocentric longitude / latitude, degrees east (IAU 49900)",
        elevation: "metres above the Mars areoid, from the HiRISE elevation model",
        generator: "CAIRN — Crew Assisted Integrated Route Navigator",
      },
      features,
    },
    null,
    1,
  );
}

const x = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export function routeKml(plan: ExportPlan): string {
  const line = routeCoords(plan).map(([lon, lat]) => `${lon},${lat},0`).join(" ");
  const marks = plan.stops
    .map((s, i) => {
      const [lon, lat] = toLonLat(plan.site, s.poi.x, s.poi.y);
      const what = s.poi.kind === "shelter" ? (i === 0 ? "Start: leave the rover" : "End: back in the rover") : `Stop ${i} · ${s.poi.dwellMin} min of science`;
      return `    <Placemark>
      <name>${x(s.poi.short)}</name>
      <description>${x(what)}. Arrive ${x(s.lmst)} LMST (EVA +${minutes(s.arriveS)} min).</description>
      <styleUrl>#${s.poi.kind === "shelter" ? "rover" : "stop"}</styleUrl>
      <Point><coordinates>${lon.toFixed(7)},${lat.toFixed(7)},0</coordinates></Point>
    </Placemark>`;
    })
    .join("\n");
  const relay = plan.relay
    ? (() => {
        const [lon, lat] = toLonLat(plan.site, plan.relay.x, plan.relay.y);
        return `\n    <Placemark>
      <name>Relay</name>
      <description>Portable radio relay, ${plan.relay.mastM} m mast: the crew stands it up here on the way.</description>
      <styleUrl>#relay</styleUrl>
      <Point><coordinates>${lon.toFixed(7)},${lat.toFixed(7)},0</coordinates></Point>
    </Placemark>`;
      })()
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" hint="target=mars">
  <Document>
    <name>CAIRN EVA — ${x(plan.site.name)}</name>
    <description>${(plan.distanceM / 1000).toFixed(2)} km, ${minutes(plan.timeS)} min outside, ${Math.round(plan.o2UsedL)} L of oxygen. Leave the rover at ${x(plan.startLmst)} LMST. Mars 2000 planetocentric coordinates. Made with CAIRN from NASA HiRISE data.</description>
    <Style id="route"><LineStyle><color>ffe9b456</color><width>4</width></LineStyle></Style>
    <Style id="rover"><IconStyle><color>ff27b6f5</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/homegardenbusiness.png</href></Icon></IconStyle></Style>
    <Style id="stop"><IconStyle><color>ffcfe145</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-circle.png</href></Icon></IconStyle></Style>
    <Style id="note"><IconStyle><color>ff8ae0ff</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/ylw-blank.png</href></Icon></IconStyle></Style>
    <Style id="sample"><IconStyle><color>ffc8f08a</color><Icon><href>http://maps.google.com/mapfiles/kml/paddle/grn-diamond.png</href></Icon></IconStyle></Style>
    <Style id="relay"><IconStyle><color>ffffa6b9</color><Icon><href>http://maps.google.com/mapfiles/kml/shapes/target.png</href></Icon></IconStyle></Style>
    <Placemark>
      <name>Safe route</name>
      <styleUrl>#route</styleUrl>
      <LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode><coordinates>${line}</coordinates></LineString>
    </Placemark>
${marks}${relay}${(plan.notes ?? [])
    .map((n) => {
      const [lon, lat] = toLonLat(plan.site, n.x, n.y);
      const when = n.evaT !== null ? ` Taken at ${n.lmst} LMST (EVA +${minutes(n.evaT)} min).` : "";
      return `\n    <Placemark>
      <name>${x(n.label)}</name>
      <description>${x(`${n.sample ? "Sample" : "Field note"}: ${(n.text || "(no text)").replace(/[.\s]+$/, "")}${n.voiceFile ? ` · voice note: ${n.voiceFile}` : n.audio ? " · voice note in the notebook ZIP export" : ""}.${when}`)}${n.voiceFile ? `&lt;br/&gt;&lt;a href="${x(n.voiceFile)}"&gt;Play the voice note&lt;/a&gt;` : ""}</description>
      <styleUrl>#${n.sample ? "sample" : "note"}</styleUrl>
      <Point><coordinates>${lon.toFixed(7)},${lat.toFixed(7)},0</coordinates></Point>
    </Placemark>`;
    })
    .join("")}
  </Document>
</kml>
`;
}

/** Save text as a file through the browser's own download. */
export function saveFile(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
