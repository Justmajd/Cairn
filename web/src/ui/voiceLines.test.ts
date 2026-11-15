import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { distClip, L, timeClips, vocabulary, type Dest } from "./voiceLines";

const stops = ["jezero", "gale", "deuteronilus"].flatMap((s) =>
  (JSON.parse(readFileSync(`public/data/${s}/pois.json`, "utf8")).pois as { id: string; short: string; kind: string }[]).filter((p) => p.kind !== "shelter"),
);
const vocab = vocabulary(stops);
const cheyava: Dest = { rover: false, id: "cheyava", short: "Cheyava Falls", k: 1 };
const rover: Dest = { rover: true, id: "rover", short: "the rover", k: 0 };

describe("voice clips", () => {
  it("builds lines from clips, with the same words as text", () => {
    const h = L.heading(cheyava, 652, 17 * 60, true);
    expect(h.text).toBe("EVA started. Heading to waypoint one, Cheyava Falls. 650 metres, about 17 minutes");
    expect(h.parts).toEqual(["eva-started", "heading-to", "wp-1", "n-cheyava", "d-650", "about", "t-17"]);
    expect(L.arrived("cheyava", "Cheyava Falls", 30 * 60, true).text).toBe("Arrived at Cheyava Falls. 30 minutes of science. No radio contact here.");
    expect(L.heading(rover, 1260, 80 * 60).parts).toEqual(["heading-to", "the-rover", "d-1.3km", "about", "h-1", "t-20"]);
    expect(L.emergency("leak", 420, 600, -12).parts.at(-1)).toBe("not-enough-o2");
    expect(distClip(1).text).toBe("1 metre,");
    expect(timeClips(3600).map((c) => c.id)).toEqual(["h-1"]);
  });

  it("every line the app can build has its clips in the vocabulary", () => {
    const lines = [
      ...[1, 7, 99, 100, 104, 655, 999, 1000, 1049, 2500, 9949].flatMap((d) => [L.heading(cheyava, d, d * 2), L.storm(d, d), L.heading(rover, d, 90)]),
      ...[0, 4, 333, 700, 900].flatMap((l) => [L.backInRover(l), L.emergency("ankle", 300, 900, l)]),
      ...[-170, -90, -40, 40, 90, 170].map((t) => L.turn(t)),
      ...[15, 22.4, 60, 75].map((d) => L.steep(d)),
      ...stops.flatMap((s) => [L.arrived(s.id, s.short, 45 * 60, false), L.hundred({ rover: false, id: s.id, short: s.short, k: 2 }), L.ahead({ rover: false, id: s.id, short: s.short, k: 0 })]),
      L.hundred(rover), L.ahead(rover), L.heading({ rover: false, id: "custom-3", short: "Stop 3", k: 3 }, 50, 60),
    ];
    for (const l of lines) for (const p of l.parts) expect(vocab.has(p), `${p} (in “${l.text}”)`).toBe(true);
  });

  it("the rendered clips match the vocabulary", () => {
    if (!existsSync("public/voice/manifest.json")) return; // not rendered yet: the app falls back to the browser's voice
    const m = JSON.parse(readFileSync("public/voice/manifest.json", "utf8")) as { clips: Record<string, string> };
    for (const [id, text] of vocab) {
      expect(m.clips[id], id).toBe(text);
      expect(existsSync(`public/voice/${id}.mp3`), `${id}.mp3`).toBe(true);
    }
  });
});
