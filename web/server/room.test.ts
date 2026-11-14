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

  it("ignores frames that arrive out of order", () => {
    const r = new Room("x");
    r.setCrewOnline(true);
    r.startEva("e1", LT);
    r.frame(frame(700));
    expect(r.frame(frame(650)).mc).toHaveLength(0);
    expect(r.now).toBe(700);
  });
});
