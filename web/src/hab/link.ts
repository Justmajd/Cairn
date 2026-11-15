/**
 * The browser's side of the hab link (see protocol.ts): a WebSocket to the hab server that comes back
 * by itself after a drop, and the hab's storage API.  Without a hab server (the static build, or the
 * server stopped) everything here quietly reports "offline" and the planner works on its own.
 */
import type { ClientMsg, Member, NoteRecord, Role, ServerMsg } from "./protocol";
import { setSessionInUrl } from "./session";

export type LinkState = "connecting" | "online" | "offline";

/** The hab's address: the page's own origin and folder (works under a sub-path too). */
export function habUrl(path: string): string {
  return new URL(path, document.baseURI).toString();
}

export class HabLink {
  state: LinkState = "connecting";
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer = 0;
  private closed = false;
  private readonly listeners = new Set<(m: ServerMsg) => void>();
  private readonly stateListeners = new Set<(s: LinkState) => void>();
  /** Sent again after every reconnect (the latest plan, the log…), keyed by message type. */
  private readonly sticky = new Map<string, ClientMsg>();

  constructor(
    private readonly role: Role,
    private readonly site: string,
    private readonly member: Member = "ev1",
    /** the crew's session (hab/session.ts); updated when the hab says which one this device joined */
    public session: string | null = null,
  ) {
    this.connect();
    window.addEventListener("online", () => this.state !== "online" && this.reconnectNow());
  }

  onMessage(fn: (m: ServerMsg) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onState(fn: (s: LinkState) => void): void {
    this.stateListeners.add(fn);
    fn(this.state);
  }

  /** Send now if connected.  `sticky` messages are also re-sent after a reconnect. */
  send(msg: ClientMsg, sticky = false): boolean {
    if (sticky) this.sticky.set(msg.type === "eva" ? "eva" : msg.type, msg);
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  forget(type: string): void {
    this.sticky.delete(type);
  }

  close(): void {
    this.closed = true;
    window.clearTimeout(this.timer);
    this.ws?.close();
  }

  private setState(s: LinkState): void {
    if (s === this.state) return;
    this.state = s;
    for (const fn of this.stateListeners) fn(s);
  }

  private reconnectNow(): void {
    window.clearTimeout(this.timer);
    this.retry = 0;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const url = habUrl("hab").replace(/^http/, "ws");
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.later();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ type: "hello", role: this.role, site: this.site, ...(this.role === "crew" ? { member: this.member } : {}), ...(this.session ? { session: this.session } : {}) } satisfies ClientMsg));
      for (const m of this.sticky.values()) ws.send(JSON.stringify(m));
      this.setState("online");
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      // the hab says which session this device is in: keep it (reconnects rejoin it) and show it in the address
      if (msg.type === "joined" && msg.session) {
        this.session = msg.session;
        setSessionInUrl(msg.session);
      }
      for (const fn of this.listeners) fn(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this.setState("offline");
      this.later();
    };
    ws.onerror = () => ws.close();
  }

  /** Try again: 1 s, 2 s, 4 s … up to 20 s. */
  private later(): void {
    if (this.closed) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.connect(), Math.min(20_000, 1000 * 2 ** this.retry++));
  }
}

// ================================================================ storage API
async function call<T>(method: string, path: string, body?: BodyInit, type?: string): Promise<T> {
  const res = await fetch(habUrl(`api/${path}`), { method, body, headers: type ? { "content-type": type } : undefined, cache: "no-store" });
  if (!res.ok) throw new Error(`hab ${res.status}`);
  return (res.headers.get("content-type")?.includes("json") ? res.json() : res.blob()) as Promise<T>;
}

export const habApi = {
  async available(): Promise<boolean> {
    try {
      const res = await fetch(habUrl("api/health"), { cache: "no-store", signal: AbortSignal.timeout(2500) });
      return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
    } catch {
      return false;
    }
  },
  notes: (site: string) => call<{ notes: NoteRecord[] }>("GET", `notebook/${site}`).then((r) => r.notes),
  putNote: (site: string, n: NoteRecord) => call<{ note: NoteRecord }>("PUT", `notebook/${site}/${n.id}`, JSON.stringify(n), "application/json").then((r) => r.note),
  removeNote: (site: string, id: string) => call<unknown>("DELETE", `notebook/${site}/${id}`),
  putAudio: (site: string, id: string, clip: Blob) => call<unknown>("PUT", `audio/${site}/${id}`, clip, clip.type || "audio/webm"),
  audio: (site: string, id: string) => call<Blob>("GET", `audio/${site}/${id}`),
  async hasAudio(site: string, id: string): Promise<boolean> {
    try {
      return (await fetch(habUrl(`api/audio/${site}/${id}`), { method: "HEAD", cache: "no-store" })).ok;
    } catch {
      return false;
    }
  },
  audioUrl: (site: string, id: string) => habUrl(`api/audio/${site}/${id}`),
  evas: (site: string) => call<{ evas: unknown[] }>("GET", `evas/${site}`).then((r) => r.evas),
};
