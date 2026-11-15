import { HabLink, habApi, type LinkState } from "../hab/link";
import type { EarthMessage, Frame, LogEntry, Member, ServerMsg } from "../hab/protocol";
import type { PlanInfo } from "../hab/protocol";

/**
 * Free roam's link to the hab (see hab/protocol.ts): the same messages the planner's EVA sends, so
 * Mission Control on Earth watches a walk in free roam exactly like a planned EVA — one light time late.
 *
 * The crew device sends the plan, the EVA's start and end, telemetry frames and the log, and gets
 * Earth's messages after the delay.  Without a hab server nothing is sent and free roam works on its own.
 */
export class RoamHab {
  private link: HabLink | null = null;
  state: LinkState = "offline";
  ev2Online = 0;
  mcOnline = 0;
  private log: LogEntry[] = [];
  private evaId: string | null = null;
  private frameT = 0;

  onEarth: (m: EarthMessage) => void = () => {};
  onChange: () => void = () => {};

  constructor(readonly site: string, readonly member: Member) {
    void this.open();
  }

  get online(): boolean {
    return this.state === "online";
  }

  private async open(): Promise<void> {
    if (!(await habApi.available())) return;
    const link = new HabLink("crew", this.site, this.member);
    this.link = link;
    link.onState((s) => {
      this.state = s;
      this.onChange();
    });
    link.onMessage((m: ServerMsg) => {
      if (m.type === "msg") this.onEarth(m.msg);
      else if (m.type === "members") this.ev2Online = m.ev2;
      else if (m.type === "mc") this.mcOnline = m.online;
      this.onChange();
    });
    if (this.member === "ev1") link.send({ type: "eva", state: "idle" }); // close an EVA a reload left open
  }

  plan(p: PlanInfo): void {
    if (this.member === "ev1") this.link?.send({ type: "plan", plan: p }, true);
  }

  start(lightTimeS: number): void {
    if (this.member !== "ev1" || this.evaId) return;
    this.evaId = `roam-${Date.now().toString(36)}`;
    this.link?.send({ type: "eva", state: "start", evaId: this.evaId, lightTimeS }, true);
  }

  end(aborted: boolean, summary: string): void {
    if (this.member !== "ev1" || !this.evaId) return;
    this.sendLog();
    this.link?.send({ type: "eva", state: "end", evaId: this.evaId, aborted, summary }, true);
    this.link?.forget("frame");
  }

  /** A line in the crew log; Earth reads it one light time after `t`. */
  note(t: number, kind: string, text: string): void {
    this.log.push({ t, kind, text });
    this.sendLog();
  }

  private sendLog(): void {
    if (this.member === "ev1" && this.evaId) this.link?.send({ type: "log", entries: this.log.slice(-200) }, true);
  }

  /** The crew's answer to a revised plan from Earth: it travels back to Earth like everything else. */
  reply(id: string, accepted: boolean): void {
    if (this.member === "ev1") this.link?.send({ type: "reply", id, accepted });
  }

  /** Telemetry, at most twice a second of real time. */
  frame(dt: number, f: Frame): void {
    this.frameT -= dt;
    if (this.frameT > 0 || this.member !== "ev1" || !this.evaId) return;
    this.frameT = 0.5;
    this.link?.send({ type: "frame", frame: f });
  }
}
