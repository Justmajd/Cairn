import { esc, fmtClock } from "./dom";
import { fmtLightTime } from "../eva/sky";

/** A decision the crew took on Mars, at EVA time `t` (s). */
export interface Decision {
  t: number;
  text: string;
}

/**
 * When Earth could have helped with each decision: it hears one light time later, and its first
 * answer can reach Mars after two.  Pure arithmetic, so it is tested on its own.
 */
export function autonomyRows(decisions: Decision[], lightTimeS: number): { t: number; text: string; earthHearsT: number; answerT: number }[] {
  return decisions
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((d) => ({ ...d, earthHearsT: d.t + lightTimeS, answerT: d.t + 2 * lightTimeS }));
}

/** The autonomy debrief card: the decisions the crew made alone, and how late Earth's help would have been. */
export function autonomyHtml(decisions: Decision[], lightTimeS: number): string {
  const rows = autonomyRows(decisions, lightTimeS);
  if (!rows.length) {
    return `<section class="autonomy"><h3>Decisions made alone</h3><p class="note">No decision on this EVA had to wait for Earth. A radio message takes ${esc(fmtLightTime(lightTimeS))} each way.</p></section>`;
  }
  return `<section class="autonomy">
      <h3>Decisions made alone</h3>
      <p class="note">A radio message takes ${esc(fmtLightTime(lightTimeS))} each way, so every one of these was the crew's call. Earth heard about it one light time later; its first answer could not arrive before two.</p>
      <table class="keys autonomy-t">
        <tr><td>On Mars</td><td>Decision</td><td>Earth hears</td><td>Earliest answer</td></tr>
        ${rows.map((r) => `<tr><td>${fmtClock(r.t)}</td><td>${esc(r.text)}</td><td>${fmtClock(r.earthHearsT)}</td><td><b>${fmtClock(r.answerT)}</b></td></tr>`).join("")}
      </table>
    </section>`;
}
