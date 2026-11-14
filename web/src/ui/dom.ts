/** Small DOM and formatting helpers. */
export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const node = root.querySelector(sel);
  if (!node) throw new Error(`Missing element ${sel}`);
  return node as T;
};

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const fmtDist = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

export function fmtDur(s: number): string {
  if (!Number.isFinite(s)) return "—";
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

export function fmtClock(s: number): string {
  const t = Math.max(0, Math.floor(s));
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

/** Dose in micrograys, switching to milligrays for large values. */
export const fmtDose = (uGy: number): string => (uGy >= 1000 ? `${(uGy / 1000).toFixed(2)} mGy` : `${uGy < 10 ? uGy.toFixed(1) : Math.round(uGy)} µGy`);

export const fmtRate = (uGyH: number): string => (uGyH >= 100 ? `${Math.round(uGyH)}` : uGyH.toFixed(1));

export const setText = (node: Element | null, text: string): void => {
  if (node && node.textContent !== text) node.textContent = text;
};

export const LOGO_SVG = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><ellipse cx="16" cy="24" rx="10" ry="4.4" fill="#e8a15c"/><ellipse cx="16" cy="16.5" rx="7.2" ry="3.8" fill="#f0b878"/><ellipse cx="16" cy="9.8" rx="4.6" ry="3.2" fill="#f7d2a0"/></svg>`;
