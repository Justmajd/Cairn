import { describe, expect, it } from "vitest";
import { formatPlanLink, parsePlanLink, PlanLink } from "./planLink";

const base: PlanLink = { stops: ["cheyava", "serpentine"], add: [], startLmst: null, storm: true, buddy: false, relay: false, relayAt: [], rover: null, dwell: {} };

describe("plan links", () => {
  it("keep a default plan short", () => {
    expect(formatPlanLink(base)).toBe("stops=cheyava,serpentine");
  });

  it("round-trip every field", () => {
    const full: PlanLink = { stops: ["ridge"], add: [{ x: 812, y: 1460 }, { x: 5, y: 7 }], startLmst: 9.5, storm: false, buddy: true, relay: true, relayAt: [], rover: { x: 903, y: 1101 }, dwell: { ridge: 45, "custom-1": 20 } };
    const hash = formatPlanLink(full);
    expect(hash).toBe("stops=ridge&add=812_1460,5_7&t=9.5&storm=0&buddy=1&relay=1&rover=903_1101&dwell=ridge_45,custom-1_20");
    expect(parsePlanLink(`#${hash}`)).toEqual(full);
  });

  it("carry a relay the crew placed by hand as its spot", () => {
    const manual: PlanLink = { ...base, relay: true, relayAt: [{ x: 840, y: 1210 }, { x: 905, y: 1180 }] };
    expect(formatPlanLink(manual)).toBe("stops=cheyava,serpentine&relay=840_1210,905_1180");
    expect(parsePlanLink("#stops=cheyava,serpentine&relay=840_1210,905_1180")).toEqual(manual);
    expect(parsePlanLink("#stops=cheyava&relay=1")).toMatchObject({ relay: true, relayAt: [] });
  });

  it("drop what does not parse instead of failing", () => {
    const l = parsePlanLink("#stops=a,,b&add=1_2,oops,3_x&t=40&rover=nope&dwell=a_x,_5,b_999");
    expect(l).toEqual({ ...base, stops: ["a", "b"], add: [{ x: 1, y: 2 }] });
  });

  it("see no plan in an unrelated hash", () => {
    expect(parsePlanLink("#section-2")).toBeNull();
    expect(parsePlanLink("")).toBeNull();
  });
});
