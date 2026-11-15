import { HabLink, habApi, type LinkState } from "../hab/link";
import type { CrewPose, EarthMessage, Frame, LogEntry, Member, ServerMsg } from "../hab/protocol";
import type { PlanInfo } from "../hab/protocol";

/**
 * Free roam's link to the hab (see hab/protocol.ts): the same messages the planner's EVA sends, so
 * Mission Control on Earth watches a walk in free roam exactly like a planned EVA — one light time late.
 *
 * EV1 sends the plan, the EVA's start and end, telemetry frames (with its full pose) and the log, and
 * gets Earth's messages after the delay.  EV2 (`?crew=ev2`) gets EV1's plan and pose with no delay
 * (both are on Mars) and sends its own pose back.  Without a hab server free roam works on its own.
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
  /** The other astronaut's pose (EV1 sees EV2's; EV2 sees EV1's, from its live frames). */
  onBuddy: (p: CrewPose) => void = () => {};
  /** EV2: EV1's plan, to walk the same mission. */
  onPlan: (p: PlanInfo) => void = () => {};
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
      else if (m.type === "buddy") this.onBuddy(m.pose);
      else if (m.type === "live" && m.frame.pose) this.onBuddy(m.frame.pose);
      else if (m.type === "crewplan") this.onPlan(m.plan);
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

  /** EV2's pose to EV1, four times a second (Mars to Mars: no delay). */
  pose(dt: number, p: CrewPose): void {
    this.poseT -= dt;
    if (this.poseT > 0 || this.member !== "ev2") return;
    this.poseT = 0.25;
    this.link?.send({ type: "pose", pose: p });
  }
  private poseT = 0;

  /** Telemetry, at most twice a second of real time. */
  frame(dt: number, f: Frame): void {
    this.frameT -= dt;
    if (this.frameT > 0 || this.member !== "ev1" || !this.evaId) return;
    this.frameT = 0.5;
    this.link?.send({ type: "frame", frame: f });
  }
}
