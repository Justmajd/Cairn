/**
 * The hab's disk: field notebooks, voice notes and finished EVA records, one folder per site.
 *
 *   <root>/<site>/notes.json        field notebook entries
 *   <root>/<site>/audio/<id>.bin    a voice note as the browser recorded it, <id>.type its MIME type
 *   <root>/<site>/evas.json         the last 50 EVAs (log, plan, final telemetry)
 *   <root>/<site>/live.json         the EVA under way (so a restarted hab carries on with it)
 *
 * Writes go to a temporary file first and are renamed into place, so a crash never leaves half a file.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SAFE_ID, type NoteRecord } from "../src/hab/protocol.ts";

export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const MAX_NOTES = 500;
const AUDIO_TYPES = /^audio\/[a-z0-9.+-]+(;\s*codecs=[a-z0-9.,"' -]+)?$/i;

export class Store {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  private dir(site: string, ...rest: string[]): string {
    if (!SAFE_ID.test(site) || rest.some((r) => r.includes("/") || r.includes("\\") || r.includes(".."))) throw new Error("bad id");
    return join(this.root, site, ...rest);
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 1));
    await rename(tmp, path);
  }

  // ---------------------------------------------------------------- notebook
  notes(site: string): Promise<NoteRecord[]> {
    return this.readJson<NoteRecord[]>(this.dir(site, "notes.json"), []);
  }

  /** Insert or replace a note; the newer `updated` wins if two devices edited the same note. */
  async putNote(site: string, note: NoteRecord): Promise<NoteRecord> {
    const list = await this.notes(site);
    const i = list.findIndex((n) => n.id === note.id);
    const stamped = { ...note, updated: note.updated ?? new Date().toISOString() };
    if (i >= 0) {
      if ((list[i].updated ?? "") > (stamped.updated ?? "")) return list[i];
      list[i] = stamped;
    } else {
      if (list.length >= MAX_NOTES) throw new Error("notebook full");
      list.push(stamped);
    }
    await this.writeJson(this.dir(site, "notes.json"), list);
    return stamped;
  }

  async removeNote(site: string, id: string): Promise<boolean> {
    if (!SAFE_ID.test(id)) throw new Error("bad id");
    const list = await this.notes(site);
    const left = list.filter((n) => n.id !== id);
    if (left.length === list.length) return false;
    await this.writeJson(this.dir(site, "notes.json"), left);
    await this.removeAudio(site, id);
    return true;
  }

  // ---------------------------------------------------------------- voice notes
  async putAudio(site: string, id: string, type: string, data: Buffer): Promise<void> {
    if (!SAFE_ID.test(id)) throw new Error("bad id");
    if (!AUDIO_TYPES.test(type)) throw new Error("not audio");
    if (data.length > MAX_AUDIO_BYTES) throw new Error("too large");
    const dir = this.dir(site, "audio");
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${id}.${process.pid}.tmp`);
    await writeFile(tmp, data);
    await rename(tmp, join(dir, `${id}.bin`));
    await writeFile(join(dir, `${id}.type`), type);
  }

  async audio(site: string, id: string): Promise<{ type: string; data: Buffer } | null> {
    if (!SAFE_ID.test(id)) return null;
    try {
      const dir = this.dir(site, "audio");
      const [data, type] = await Promise.all([readFile(join(dir, `${id}.bin`)), readFile(join(dir, `${id}.type`), "utf8")]);
      return { type, data };
    } catch {
      return null;
    }
  }

  async hasAudio(site: string, id: string): Promise<boolean> {
    if (!SAFE_ID.test(id)) return false;
    try {
      await stat(this.dir(site, "audio", `${id}.bin`));
      return true;
    } catch {
      return false;
    }
  }

  async removeAudio(site: string, id: string): Promise<void> {
    if (!SAFE_ID.test(id)) return;
    const dir = this.dir(site, "audio");
    await Promise.all([rm(join(dir, `${id}.bin`), { force: true }), rm(join(dir, `${id}.type`), { force: true })]);
  }

  // ---------------------------------------------------------------- the EVA under way, per session
  /** The site's default session keeps live.json; other sessions live-<session>.json. */
  private liveFile(site: string, session: string): string {
    if (!SAFE_ID.test(session)) throw new Error("bad id");
    return this.dir(site, session === site ? "live.json" : `live-${session}.json`);
  }

  live<T>(site: string, session: string = site): Promise<T | null> {
    return this.readJson<T | null>(this.liveFile(site, session), null);
  }

  putLive(site: string, state: unknown, session: string = site): Promise<void> {
    return this.writeJson(this.liveFile(site, session), state);
  }

  /** A session closed: its live state goes (so a restarted hab does not bring it back). */
  async dropLive(site: string, session: string): Promise<void> {
    await rm(this.liveFile(site, session), { force: true });
  }

  /** The sessions with live state on disk for a site. */
  async liveSessions(site: string): Promise<string[]> {
    try {
      const files = await readdir(this.dir(site));
      return files.flatMap((f) => (f === "live.json" ? [site] : /^live-([A-Za-z0-9_-]{1,64})\.json$/.exec(f)?.slice(1, 2) ?? []));
    } catch {
      return [];
    }
  }

  // ---------------------------------------------------------------- EVA records
  evas(site: string): Promise<unknown[]> {
    return this.readJson<unknown[]>(this.dir(site, "evas.json"), []);
  }

  async addEva(site: string, record: unknown): Promise<void> {
    const list = await this.evas(site);
    list.push(record);
    await this.writeJson(this.dir(site, "evas.json"), list.slice(-50));
  }
}
