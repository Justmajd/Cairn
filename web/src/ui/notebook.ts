/**
 * Field notebook: geotagged notes and samples the crew records on the ground.  Kept on the device
 * (localStorage, voice clips in IndexedDB) and, when the hab server is reachable, on the hab too, where
 * every crew device and Mission Control share them.  Without a hab nothing leaves the device.  They show on the map, go into the EVA log, the printable cue card and the
 * KML / GeoJSON exports.
 */
import { habApi } from "../hab/link";

export interface FieldNote {
  id: string;
  /** N1, N2… for notes; S1, S2… for samples. */
  label: string;
  sample: boolean;
  x: number;
  y: number;
  lon: number;
  lat: number;
  elevM: number;
  text: string;
  /** A voice clip is stored for this note. */
  audio: boolean;
  /** EVA clock (s) when it was taken during an EVA, else null (a planning note). */
  evaT: number | null;
  /** Local mean solar time on Mars when taken during an EVA ("10:42"), else "". */
  lmst: string;
  created: string;
  /** Last edit (ISO time): the newer copy wins when devices sync. */
  updated?: string;
}

const DB = "cairn-notebook";
const STORE = "audio";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function audioOp<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  try {
    const db = await idb();
    return await new Promise<T>((resolve, reject) => {
      const req = op(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // private mode / storage blocked: voice notes are not kept
  }
}

export class Notebook {
  notes: FieldNote[] = [];
  /** Connected to the hab server: notes and voice notes are kept there too, shared by every device. */
  hab = false;
  /** Called when notes arrive from another device. */
  onChange: () => void = () => {};
  private readonly key: string;
  private readonly delKey: string;
  private readonly site: string;
  /** Notes deleted while away from the hab, to delete there on the next sync. */
  private deleted: string[] = [];

  constructor(siteId: string) {
    this.site = siteId;
    this.key = `cairn:notes:${siteId}`;
    this.delKey = `cairn:notes-deleted:${siteId}`;
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) this.notes = JSON.parse(raw) as FieldNote[];
      this.deleted = JSON.parse(localStorage.getItem(this.delKey) ?? "[]") as string[];
    } catch {
      this.notes = [];
    }
  }

  private save(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.notes));
      localStorage.setItem(this.delKey, JSON.stringify(this.deleted));
    } catch {
      // storage full or blocked: the notes live for this visit only (and on the hab, if connected)
    }
  }

  /**
   * Bring this device and the hab in line: deletions made offline go up, then for each note the newer
   * copy wins (by `updated`), and voice notes the hab is missing are uploaded.  False without a hab.
   */
  async sync(): Promise<boolean> {
    if (!(await habApi.available())) {
      this.hab = false;
      return false;
    }
    try {
      for (const id of this.deleted) await habApi.removeNote(this.site, id).catch(() => null);
      this.deleted = [];
      const remote = new Map((await habApi.notes(this.site)).map((n) => [n.id, n as FieldNote]));
      const merged = new Map(remote);
      for (const local of this.notes) {
        const r = remote.get(local.id);
        if (!r || (local.updated ?? local.created) > (r.updated ?? r.created)) {
          merged.set(local.id, await habApi.putNote(this.site, local).catch(() => local) as FieldNote);
        }
        if (local.audio && !(await habApi.hasAudio(this.site, local.id))) {
          const clip = await this.localAudio(local.id);
          if (clip) await habApi.putAudio(this.site, local.id, clip).catch(() => null);
        }
      }
      this.notes = [...merged.values()].sort((a, b) => a.created.localeCompare(b.created));
      this.hab = true;
      this.save();
      return true;
    } catch {
      this.hab = false;
      return false;
    }
  }

  /** The hab's list, pushed after another device changed it. */
  applyRemote(notes: FieldNote[]): void {
    this.notes = notes.slice().sort((a, b) => a.created.localeCompare(b.created));
    this.save();
    this.onChange();
  }

  /** Next label of a kind: N3, S2… */
  nextLabel(sample: boolean): string {
    const p = sample ? "S" : "N";
    const used = this.notes.filter((n) => n.label.startsWith(p)).map((n) => Number(n.label.slice(1)) || 0);
    return `${p}${used.length ? Math.max(...used) + 1 : 1}`;
  }

  get(id: string): FieldNote | undefined {
    return this.notes.find((n) => n.id === id);
  }

  upsert(note: FieldNote): void {
    const stamped = { ...note, updated: new Date().toISOString() };
    const i = this.notes.findIndex((n) => n.id === note.id);
    if (i >= 0) this.notes[i] = stamped;
    else this.notes.push(stamped);
    this.save();
    if (this.hab) void habApi.putNote(this.site, stamped).catch(() => (this.hab = false));
  }

  remove(id: string): void {
    this.notes = this.notes.filter((n) => n.id !== id);
    void audioOp("readwrite", (s) => s.delete(id));
    if (this.hab) void habApi.removeNote(this.site, id).catch(() => this.deleted.push(id));
    else this.deleted.push(id);
    this.save();
  }

  async saveAudio(id: string, blob: Blob): Promise<void> {
    await audioOp("readwrite", (s) => s.put(blob, id));
    if (this.hab) await habApi.putAudio(this.site, id, blob).catch(() => null);
  }

  private localAudio(id: string): Promise<Blob | null> {
    return audioOp<Blob>("readonly", (s) => s.get(id) as IDBRequest<Blob>);
  }

  /** A voice note from this device, or from the hab (recorded on another device). */
  async loadAudio(id: string): Promise<Blob | null> {
    const local = await this.localAudio(id);
    if (local || !this.hab) return local ?? null;
    try {
      const blob = await habApi.audio(this.site, id);
      void audioOp("readwrite", (s) => s.put(blob, id));
      return blob;
    } catch {
      return null;
    }
  }
}
