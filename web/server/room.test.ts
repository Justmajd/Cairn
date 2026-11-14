import { describe, expect, it } from "vitest";
import type { Frame, PlanInfo, ServerMsg } from "../src/hab/protocol.ts";
import { Room } from "./room.ts";

const LT = 600; // 10 minutes of light time

const frame = (t: number, extra: Partial<Frame> = {}): Frame => ({
  t, x: t, y: 0, headingDeg: 90, o2LeftL: 700 - t / 10, doseUGy: t / 100, doseRate: 5, baseline: 5, status: "Walking to", next: "A",
  nextDistM: 100, homeS: t, radio: "ok", sheltered: false, storm: false, lmst: "10:00", sunEl: 40, lightTimeS: LT, speed: 60, ...extra,
});
const plan = { site: "x", lightTimeS: LT } as PlanInfo;
const of = (msgs: ServerMsg[], type: ServerMsg["type"]) => msgs.filter((m) => m.type === type);

describe("hab room: Earth sees Mars one light time late", () => {
  it("holds telemetry until it would have reached Earth", () => {
    const r = new Room("x");
    r.setPlan(plan);
    r.setCrewOnline(true);
    r.startEva("e1", LT);
    expect(of(r.frame(frame(0)).mc, "frame")).toHaveLength(0);
    expect(of(r.frame(frame(300)).mc, "frame")).toHaveLength(0);
    const at600 = of(r.frame(frame(600)).mc, "frame");
    expect(at600).toHaveLength(1); // the frame from T+0 arrives at T+600
    expect((at600[0] as { frame: Frame }).frame.t).toBe(0);
    expect(of(r.frame(frame(900)).mc, "frame").map((m) => (m as { frame: Frame }).frame.t)).toEqual([300]);
  });

  it("delays log lines and field notes the same way, and sends each only once", () => {
    const r = new Room("x");
    r.setCrewOnline(true);
    r.startEva("e1", LT);
    r.frame(frame(100));
    expect(of(r.setLog([{ t: 100, kind: "alert", text: "Storm alert" }]).mc, "log")).toHaveLength(0);
    expect(of(r.upsertNote({ id: "n1", label: "S1", sample: true, x: 1, y: 2, lon: 0, lat: 0, elevM: 0, text: "rock", audio: false, evaT: 150, lmst: "", created: "" }).mc, "note")).toHaveLength(0);
    const later = r.frame(frame(760)).mc;
    expect(of(later, "log")).toHaveLength(1);
    expect(of(later, "note")).toHaveLength(1);
    const again = r.setLog([{ t: 100, kind: "alert", text: "Storm alert" }]);
    expect(of(again.mc, "log")).toHaveLength(0);
  });

  it("delivers Earth's messages to the crew one light time after they were sent", () => {
    const r = new Room("x");
    r.setCrewOnline(true);
    r.startEva("e1", LT);
    r.frame(frame(1000));
    const sent = r.say("Copy, shelter now");
    expect(sent.crew).toHaveLength(0);
    expect(of(r.frame(frame(1500)).crew, "msg")).toHaveLength(0);
    const got = of(r.frame(frame(1600)).crew, "msg") as { msg: { text: string; sentT: number; deliverT: number } }[];
    expect(got).toHaveLength(1);
    expect(got[0].msg).toMatchObject({ text: "Copy, shelter now", sentT: 1000, deliverT: 1600 });
    expect(of(r.frame(frame(2000)).crew, "msg")).toHaveLength(0); // once
  });

  it("delivers at once when no EVA is running (no EVA clock to delay on)", () => {
    const r = new Room("x");
    r.setCrewOnline(true);
    expect(of(r.say("Good morning, crew").crew, "msg")).toHaveLength(1);
  });

  it("lets the last signals arrive after the EVA ends, on the wall clock", () => {
    const r = new Room("x");
    r.setCrewOnline(true);
    r.startEva("e1", LT);
    r.frame(frame(0));
    r.frame(frame(1200, { speed: 60 }));
    r.endEva();
    let released = 0;
    for (let i = 0; i < 40; i++) released += of(r.tick(0.5).mc, "frame").length; // 20 s × 60 = 1200 s of EVA time
    expect(released).toBe(1);
    expect(r.pending()).toBe(false);
  });

  it("gives a late Mission Control screen exactly what Earth may know", () => {
    const r = new Room("x");
    r.setPlan(plan);
    r.setCrewOnline(true);
    r.startEva("e1", LT);
    for (let t = 0; t <= 1200; t += 100) r.frame(frame(t));
    r.setLog([{ t: 500, kind: "go", text: "early" }, { t: 900, kind: "go", text: "too recent" }]);
    const snap = r.snapshot();
    expect(snap.frames.every((f) => f.t <= 600)).toBe(true);
    expect(snap.frames).toHaveLength(7);
    expect(snap.log.map((e) => e.text)).toEqual(["early"]);
  });

  it("sends a revised plan with the delay, and the crew's answer back with the delay", () => {
    const r = new Room("x");
    r.setCrewOnline(true);
    r.startEva("e1", LT);
    r.frame(frame(1000));
    r.say("Add the dark rocks", { drop: ["serpentine"], add: [{ x: 10, y: 20 }] });
    const got = of(r.frame(frame(1600)).crew, "msg") as { msg: { id: string; change?: { drop: string[] } } }[];
    expect(got[0].msg.change?.drop).toEqual(["serpentine"]);
    expect(of(r.reply(got[0].msg.id, true).mc, "log")).toHaveLength(0); // answered at 1600: Earth hears it at 2200
    const heard = of(r.frame(frame(2200)).mc, "log") as { entry: { ref?: string; accepted?: boolean } }[];
    expect(heard[0].entry).toMatchObject({ ref: got[0].msg.id, accepted: true });
  });

  it("keeps a record of the EVA that is enough to replay it", () => {
    const r = new Room("x");
    r.setCrewOnline(true);
    r.startEva("e1", LT);
    for (let t = 0; t <= 4000; t += 2) r.frame(frame(t));
    r.upsertNote({ id: "n9", label: "S1", sample: true, x: 1, y: 2, lon: 0, lat: 0, elevM: 0, text: "vein", audio: false, evaT: 900, lmst: "", created: "" });
    r.endEva();
    const rec = r.record();
    expect(rec.frames.length).toBeLessThanOrEqual(1501);
    expect(rec.frames[rec.frames.length - 1].t).toBe(4000);
    expect(rec.notes.map((n) => n.id)).toEqual(["n9"]);
    expect(rec.lightTimeS).toBe(LT);
  });

  it("holds this EVA's notes for one light time even after the hab restarts", () => {
    const note = { id: "n1", label: "N1", sample: false, x: 1, y: 2, lon: 0, lat: 0, elevM: 0, text: "vein", audio: true, evaT: 300, lmst: "", created: "", eva: "e1" };
    const a = new Room("x");
    a.setCrewOnline(true);
    a.startEva("e1", LT);
    a.frame(frame(310));
    expect(of(a.upsertNote(note).mc, "note")).toHaveLength(0);
    // the hab restarts: a new room, restored from disk, with the notebook reloaded
    const b = new Room("x");
    b.restore(a.liveState());
    b.loadNotes([note]);
    expect(b.snapshot().notes).toHaveLength(0); // a Mission Control screen that connects now: still not
    b.setCrewOnline(true);
    expect(of(b.startEva("e1", LT).mc, "clock")).toHaveLength(0); // the crew reconnects: same EVA, no reset
    expect(b.now).toBe(310);
    expect(of(b.frame(frame(899)).mc, "note")).toHaveLength(0);
    expect(of(b.frame(frame(900)).mc, "note")).toHaveLength(1); // taken at 300, on Earth at 900
  });

  it("knows notes from planning and from earlier EVAs at once", () => {
    const r = new Room("x");
    r.loadNotes([
      { id: "p", label: "N1", sample: false, x: 0, y: 0, lon: 0, lat: 0, elevM: 0, text: "", audio: false, evaT: null, lmst: "", created: "", eva: null },
      { id: "old", label: "S1", sample: true, x: 0, y: 0, lon: 0, lat: 0, elevM: 0, text: "", audio: false, evaT: 5000, lmst: "", created: "", eva: "e0" },
    ]);
    r.setCrewOnline(true);
    r.startEva("e1", LT);
    expect(r.snapshot().notes.map((n) => n.id).sort()).toEqual(["old", "p"]);
  });

  it("ignores frames that arrive out of order", () => {
    const r = new Room("x");
    r.setCrewOnline(true);
    r.startEva("e1", LT);
    r.frame(frame(700));
    expect(r.frame(frame(650)).mc).toHaveLength(0);
    expect(r.now).toBe(700);
  });
});
