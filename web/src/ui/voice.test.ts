import { describe, expect, it } from "vitest";
import { bestVoice, RouteCallouts, type RouteView } from "./voice";

const v = (name: string, lang = "en-US", localService = true) => ({ name, lang, localService, default: false });

describe("spoken guidance", () => {
  it("picks the most natural English voice", () => {
    expect(bestVoice([v("Fred"), v("Samantha"), v("Ava (Premium)")])!.name).toBe("Ava (Premium)");
    expect(bestVoice([v("Zarvox"), v("Daniel", "en-GB")])!.name).toBe("Daniel");
    expect(bestVoice([v("Microsoft Aria Online (Natural) - English (United States)", "en-US", false), v("Microsoft David - English (United States)")])!.name).toContain("Aria");
    expect(bestVoice([v("Thomas", "fr-FR"), v("Karen", "en-AU")])!.name).toBe("Karen");
    expect(bestVoice([])).toBeNull();
  });

  it("stays quiet walking straight on, and speaks only when something changes", () => {
    const c = new RouteCallouts();
    const dest = { rover: false, id: "cheyava", short: "Cheyava Falls", k: 1 };
    const at = (distM: number, o: Partial<RouteView> = {}): string | null => c.next({ legId: "a", dest, distM, turnDeg: 0, steepDeg: 5, sand: false, ...o })?.text ?? null;
    expect(at(600)).toBeNull(); // the new leg was announced on departure
    const lines: string[] = [];
    for (let d = 590; d >= 0; d -= 5) {
      const l = at(d, d === 400 ? { turnDeg: 70 } : d === 395 ? { turnDeg: 70 } : d === 300 ? { steepDeg: 18 } : d === 290 ? { steepDeg: 19 } : {});
      if (l) lines.push(l);
    }
    expect(lines).toEqual(["Turn right.", "Steep ground ahead, 18 degrees.", "Cheyava Falls. 100 metres.", "Cheyava Falls is ahead."]);
  });

  it("does not repeat a turn or a hazard every few metres", () => {
    const c = new RouteCallouts();
    const rover = { rover: true, id: "rover", short: "Rover", k: 0 };
    c.next({ legId: "b", dest: rover, distM: 800, turnDeg: 0, steepDeg: 0, sand: false });
    const said: string[] = [];
    for (let d = 795; d > 450; d -= 5) {
      const l = c.next({ legId: "b", dest: rover, distM: d, turnDeg: 40, steepDeg: 0, sand: true });
      if (l) said.push(l.text);
    }
    // a long gentle bend: called again only every 60 m; sand only every 150 m
    expect(said.filter((s) => s === "Bear right.").length).toBeLessThanOrEqual(6);
    expect(said.filter((s) => s === "Loose sand ahead.").length).toBe(2);
  });
});
