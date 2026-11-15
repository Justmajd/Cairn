import { describe, expect, it } from "vitest";
import { autonomyHtml, autonomyRows } from "./autonomy";

describe("autonomy debrief", () => {
  it("puts Earth's earliest answer two light times after each decision, in time order", () => {
    const rows = autonomyRows([{ t: 900, text: "Turned back" }, { t: 120, text: "Re-routed" }], 1000);
    expect(rows.map((r) => r.text)).toEqual(["Re-routed", "Turned back"]);
    expect(rows[0].earthHearsT).toBe(1120);
    expect(rows[0].answerT).toBe(2120);
  });

  it("says so when nothing had to wait for Earth", () => {
    expect(autonomyHtml([], 600)).toContain("No decision");
  });
});
