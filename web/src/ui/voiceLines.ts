/**
 * The spoken guidance as pre-rendered clips: every line the EVA voice says is built from a fixed
 * vocabulary, rendered once with a neural voice (scripts/render-voice.mjs → public/voice/), and
 * joined at play time like a car navigator.  Each line also carries its plain text, which the
 * browser's own voice reads when a clip is missing (a custom stop, an old cache, no clips at all).
 *
 * Mission Control's messages are not here: they are free text, read by the browser's own voice on
 * a channel of their own (Voice.earth), which muting the EVA guidance does not silence.
 *
 * Pure and dependency-free: the render script imports this file directly (Node type stripping), so
 * the clips and the app can never disagree.  Tested in voiceLines.test.ts.
 */

export interface Line {
  text: string;
  parts: string[];
}

/** Fixed phrases: clip id → what is said. */
export const PHRASES: Record<string, string> = {
  "on": "Voice guidance on.",
  "eva-started": "EVA started.",
  "heading-to": "Heading to",
  "about": "about",
  "arrived-at": "Arrived at",
  "of-science": "of science.",
  "no-radio-here": "No radio contact here.",
  "dust": "Dust storm. Low visibility. Navigate by the route, not by landmarks.",
  "spe": "Solar particle event. Radiation alarm. Abort the EVA.",
  "return-to-rover": "Return to the rover:",
  "back-in-rover": "You are back in the rover, with",
  "inside-rover": "You are inside the rover. Radiation shelter reached.",
  "low-sun": "Low sun. Long shadows hide hazards. Head back to the rover.",
  "relay": "Relay deployed.",
  "radio-lost": "Radio contact lost.",
  "radio-back": "Radio contact back.",
  "leak": "Suit leak. Oxygen use doubled.",
  "ankle": "Ankle injury. Walking at half speed.",
  "enough-o2": "Enough oxygen,",
  "not-enough-o2": "Not enough oxygen. Rover, drive out to meet the crew.",
  "sand": "Loose sand ahead.",
  "steep": "Steep ground ahead,",
  "100m": "100 metres.",
  "the-rover": "the rover.",
  "the-rover-ahead": "The rover is ahead.",
  "bear-left": "Bear left.",
  "bear-right": "Bear right.",
  "turn-left": "Turn left.",
  "turn-right": "Turn right.",
  "around-left": "Turn around to the left.",
  "around-right": "Turn around to the right.",
};

const WAYPOINT_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
/** Custom stops from the map menu are "Stop 1" … */
export const CUSTOM_STOPS = 9;

/** Distances as spoken (rounded the way spokenDist rounds): clip id and text. */
export function distClip(m: number): { id: string; text: string } {
  if (m >= 995) {
    const km = Math.min(9.9, Math.round(m / 100) / 10);
    return { id: `d-${km.toFixed(1)}km`, text: `${km.toFixed(1)} kilometres,` };
  }
  const r = m >= 100 ? Math.round(m / 10) * 10 : Math.max(1, Math.round(m));
  return { id: `d-${r}`, text: `${r} ${r === 1 ? "metre" : "metres"},` };
}

/** Times: whole minutes (1–59) and hours (1–9): "1 hour" + "20 minutes". */
export function timeClips(s: number): { id: string; text: string }[] {
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return [{ id: `t-${min}`, text: `${min} ${min === 1 ? "minute" : "minutes"}` }];
  const h = Math.min(9, Math.floor(min / 60));
  const rest = min % 60;
  return [{ id: `h-${h}`, text: `${h} ${h === 1 ? "hour" : "hours"}` }, ...(rest ? [{ id: `t-${rest}`, text: `${rest} ${rest === 1 ? "minute" : "minutes"}` }] : [])];
}

/** Litres of oxygen, to the nearest 10 (0–700). */
export function litreClip(kind: "left" | "spare", l: number): { id: string; text: string } {
  const n = Math.max(0, Math.min(700, Math.round(l / 10) * 10));
  return kind === "left" ? { id: `o2-${n}`, text: `${n} litres of oxygen left.` } : { id: `spare-${n}`, text: `${n} litres to spare.` };
}

export function degClip(deg: number): { id: string; text: string } {
  const d = Math.max(15, Math.min(60, Math.round(deg)));
  return { id: `deg-${d}`, text: `${d} degrees.` };
}

/** A stop's name: "Cheyava Falls." and "Cheyava Falls is ahead." */
export function stopClip(id: string, short: string): { id: string; text: string } {
  return { id: `n-${id}`, text: `${short}.` };
}
export function stopAheadClip(id: string, short: string): { id: string; text: string } {
  return { id: `na-${id}`, text: `${short} is ahead.` };
}
export function waypointClip(k: number): { id: string; text: string } | null {
  return k >= 1 && k <= WAYPOINT_WORDS.length ? { id: `wp-${k}`, text: `waypoint ${WAYPOINT_WORDS[k - 1]},` } : null;
}

// ---------------------------------------------------------------- lines
type Clip = { id: string; text: string };
const P = (id: string): Clip => ({ id, text: PHRASES[id] });
const line = (...clips: (Clip | null)[]): Line => {
  const c = clips.filter((x): x is Clip => !!x);
  return { text: c.map((x) => x.text).join(" ").replace(/,(\s*)$/, ".$1").replace(/\s+/g, " ").trim(), parts: c.map((x) => x.id) };
};

/** Where a leg goes: the rover, or "waypoint one, Cheyava Falls." */
export interface Dest {
  rover: boolean;
  id: string;
  short: string;
  /** its number in the plan (1, 2, …), or 0 */
  k: number;
}
const dest = (d: Dest): Clip[] => (d.rover ? [P("the-rover")] : [waypointClip(d.k), stopClip(d.id, d.short)].filter((x): x is Clip => !!x));

export const L = {
  fixed: (id: keyof typeof PHRASES): Line => line(P(id)),
  heading: (d: Dest, distM: number, etaS: number, started = false): Line =>
    line(started ? P("eva-started") : null, P("heading-to"), ...dest(d), distClip(distM), P("about"), ...timeClips(etaS)),
  arrived: (id: string, short: string, dwellS: number, noRadio: boolean): Line =>
    line(P("arrived-at"), stopClip(id, short), ...timeClips(dwellS), P("of-science"), noRadio ? P("no-radio-here") : null),
  storm: (distM: number, timeS: number): Line => line(P("spe"), P("return-to-rover"), distClip(distM), ...timeClips(timeS)),
  backInRover: (o2LeftL: number): Line => line(P("back-in-rover"), litreClip("left", o2LeftL)),
  emergency: (kind: "leak" | "ankle", distM: number, timeS: number, spareL: number): Line =>
    line(P(kind), P("return-to-rover"), distClip(distM), ...timeClips(timeS), ...(spareL >= 0 ? [P("enough-o2"), litreClip("spare", spareL)] : [P("not-enough-o2")])),
  turn: (deg: number): Line => {
    const a = Math.abs(deg);
    const side = deg > 0 ? "right" : "left";
    return line(P(a < 60 ? `bear-${side}` : a < 135 ? `turn-${side}` : `around-${side}`));
  },
  steep: (deg: number): Line => line(P("steep"), degClip(deg)),
  hundred: (d: Dest): Line => line(d.rover ? { id: "the-rover", text: "The rover." } : stopClip(d.id, d.short), P("100m")),
  ahead: (d: Dest): Line => line(d.rover ? P("the-rover-ahead") : stopAheadClip(d.id, d.short)),
};

/** Every clip the app can ask for, given the sites' stops: what the render script renders. */
export function vocabulary(stops: { id: string; short: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (c: Clip | null) => c && out.set(c.id, c.text);
  for (const id of Object.keys(PHRASES)) add(P(id));
  for (let m = 1; m < 100; m++) add(distClip(m));
  for (let m = 100; m < 1000; m += 10) add(distClip(m));
  for (let dm = 10; dm <= 99; dm++) add(distClip(dm * 100));
  for (let t = 1; t < 60; t++) add(timeClips(t * 60)[0]);
  for (let h = 1; h <= 9; h++) add(timeClips(h * 3600)[0]);
  for (let l = 0; l <= 700; l += 10) {
    add(litreClip("left", l));
    add(litreClip("spare", l));
  }
  for (let d = 15; d <= 60; d++) add(degClip(d));
  for (let k = 1; k <= WAYPOINT_WORDS.length; k++) add(waypointClip(k));
  const named = [...stops, ...Array.from({ length: CUSTOM_STOPS }, (_, i) => ({ id: `custom-${i + 1}`, short: `Stop ${i + 1}` }))];
  for (const s of named) {
    add(stopClip(s.id, s.short));
    add(stopAheadClip(s.id, s.short));
  }
  return out;
}
