/**
 * Free roam's settings, kept in this browser only (localStorage, failing quietly): which key does what,
 * a calmer camera, and captions for sound cues.
 */
export type Action = "forward" | "back" | "left" | "right" | "lope" | "jump" | "use" | "visor";

export const ACTIONS: { id: Action; label: string }[] = [
  { id: "forward", label: "Walk forward" },
  { id: "back", label: "Walk back" },
  { id: "left", label: "Step left" },
  { id: "right", label: "Step right" },
  { id: "lope", label: "Lope (hold)" },
  { id: "jump", label: "Jump" },
  { id: "use", label: "Sample / climb in (hold)" },
  { id: "visor", label: "Gold sun visor" },
];

export const DEFAULT_KEYS: Record<Action, string> = { forward: "w", back: "s", left: "a", right: "d", lope: "Shift", jump: " ", use: "e", visor: "g" };
/** Keys that already do something else (views, sound, help, settings), so they cannot be bound. */
export const RESERVED = new Set(["1", "2", "3", "v", "m", "h", "?", ",", "Escape", "Enter", "Tab"]);
/** The arrows always walk, whatever else is bound. */
export const ARROWS: Record<string, Action> = { ArrowUp: "forward", ArrowDown: "back", ArrowLeft: "left", ArrowRight: "right" };

export interface RoamSettings {
  keys: Record<Action, string>;
  reduceShake: boolean;
  captions: boolean;
}

const KEY = "cairn:roam-settings";

export function loadSettings(): RoamSettings {
  const base: RoamSettings = { keys: { ...DEFAULT_KEYS }, reduceShake: matchMedia("(prefers-reduced-motion: reduce)").matches, captions: false };
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<RoamSettings> | null;
    if (!s) return base;
    return { keys: { ...base.keys, ...(s.keys ?? {}) }, reduceShake: s.reduceShake ?? base.reduceShake, captions: !!s.captions };
  } catch {
    return base;
  }
}

export function saveSettings(s: RoamSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private mode: the settings last until the page closes
  }
}

/** A key as the settings store it: letters lower-case, others by name. */
export const normKey = (key: string): string => (key.length === 1 ? key.toLowerCase() : key);

export function keyName(k: string): string {
  return k === " " ? "Space" : k.length === 1 ? k.toUpperCase() : k;
}

/** Which action a key does (the arrows always walk). */
export function actionOf(keys: Record<Action, string>, key: string): Action | null {
  const k = normKey(key);
  if (ARROWS[k]) return ARROWS[k];
  return (Object.keys(keys) as Action[]).find((a) => keys[a] === k) ?? null;
}

/** Bind `key` to `action`; a key bound elsewhere moves here (its old action gets this action's old key). */
export function rebind(keys: Record<Action, string>, action: Action, key: string): Record<Action, string> | null {
  const k = normKey(key);
  if (RESERVED.has(k) || ARROWS[k] || k === "Meta" || k === "Control" || k === "Alt") return null;
  const next = { ...keys };
  const other = (Object.keys(next) as Action[]).find((a) => next[a] === k && a !== action);
  if (other) next[other] = keys[action];
  next[action] = k;
  return next;
}
