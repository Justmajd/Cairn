/**
 * Field notebook: geotagged notes and samples the crew records on the ground.  Text, positions and
 * sample marks are kept per site in localStorage; voice notes (audio clips) in IndexedDB.  Nothing
 * leaves the device.  They show on the map, go into the EVA log, the printable cue card and the
 * KML / GeoJSON exports.
 */
import { $, esc } from "./dom";
import { ic } from "./icons";
import { hideAnimated, showAnimated } from "./motion";

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
  private readonly key: string;

  constructor(siteId: string) {
    this.key = `cairn:notes:${siteId}`;
    try {
      const raw = localStorage.getItem(this.key);
      if (raw) this.notes = JSON.parse(raw) as FieldNote[];
    } catch {
      this.notes = [];
    }
  }

  private save(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.notes));
    } catch {
      // storage full or blocked: the notes live for this visit only
    }
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
    const i = this.notes.findIndex((n) => n.id === note.id);
    if (i >= 0) this.notes[i] = note;
    else this.notes.push(note);
    this.save();
  }

  remove(id: string): void {
    this.notes = this.notes.filter((n) => n.id !== id);
    this.save();
    void audioOp("readwrite", (s) => s.delete(id));
  }

  saveAudio(id: string, blob: Blob): Promise<unknown> {
    return audioOp("readwrite", (s) => s.put(blob, id));
  }

  loadAudio(id: string): Promise<Blob | null> {
    return audioOp<Blob>("readonly", (s) => s.get(id) as IDBRequest<Blob>);
  }
}

/** Record from the microphone until stop() is called. */
async function startRecording(): Promise<{ stop: () => Promise<Blob> }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
        };
        rec.stop();
      }),
  };
}

export const canRecord = (): boolean => typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

/**
 * The note editor: text, "this is a sample" and a voice clip.  `onSave` gets the edited note (and a new
 * clip, if one was recorded), `onDelete` removes it; closing without saving keeps nothing new.
 */
export function editNote(
  book: Notebook,
  note: FieldNote,
  isNew: boolean,
  where: string,
  onSave: (note: FieldNote, audio: Blob | null) => void,
  onDelete: () => void,
): void {
  const host = $("#modal");
  host.innerHTML = `<div class="modal-box note-box" role="dialog" aria-modal="true" aria-label="Field note">
      <header><h2><span class="note-tag${note.sample ? " sample" : ""}" id="nb-tag">${esc(note.label)}</span> Field note</h2><button class="close icon" aria-label="Close">${ic.close}</button></header>
      <div class="modal-body">
        <p class="note-where">${esc(where)}</p>
        <textarea id="nb-text" rows="4" placeholder="What do you see? Colour, texture, layering, what to come back for…">${esc(note.text)}</textarea>
        <label class="switch"><span>Sample taken here (bagged and labelled)</span><input class="sr" type="checkbox" id="nb-sample" ${note.sample ? "checked" : ""}/><i></i></label>
        <div class="note-voice">
          ${canRecord() ? `<button class="secondary" id="nb-rec">${ic.mic}<span>Record a voice note</span></button>` : `<small>Voice notes need a microphone and a browser that can record.</small>`}
          <audio id="nb-audio" controls hidden></audio>
          <button class="secondary" id="nb-mp3" hidden>${ic.download}<span>Download MP3</span></button>
        </div>
        <div class="note-actions">
          ${isNew ? "" : `<button class="secondary danger" id="nb-del">${ic.close}<span>Delete</span></button>`}
          <button class="primary" id="nb-save">${ic.check}<span>${isNew ? "Save note" : "Save"}</span></button>
        </div>
      </div>
    </div>`;
  showAnimated(host);
  let clip: Blob | null = null;
  let rec: { stop: () => Promise<Blob> } | null = null;
  let url = "";
  const audio = $<HTMLAudioElement>("#nb-audio", host);
  const showClip = (b: Blob) => {
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(b);
    audio.src = url;
    audio.hidden = false;
    mp3Btn.hidden = false;
  };
  const mp3Btn = $<HTMLButtonElement>("#nb-mp3", host);
  mp3Btn.addEventListener("click", async () => {
    const src = clip ?? (await book.loadAudio(note.id));
    if (!src) return;
    const label = mp3Btn.querySelector("span")!;
    label.textContent = "Converting…";
    try {
      const { toMp3, saveBlob } = await import("./voiceExport");
      saveBlob(`${$("#nb-tag", host).textContent ?? note.label}.mp3`, await toMp3(src));
      label.textContent = "Download MP3";
    } catch {
      label.textContent = "Could not convert this clip";
    }
  });
  if (note.audio) void book.loadAudio(note.id).then((b) => b && showClip(b));
  const close = async () => {
    if (rec) await rec.stop().catch(() => null);
    rec = null;
    if (url) URL.revokeObjectURL(url);
    hideAnimated(host, 160);
  };
  $(".close", host).addEventListener("click", () => void close());
  host.addEventListener("click", (ev) => ev.target === host && void close(), { once: true });
  const sample = $<HTMLInputElement>("#nb-sample", host);
  sample.addEventListener("change", () => {
    // a note turned into a sample takes the next sample number (and back)
    const label = sample.checked === note.sample ? note.label : book.nextLabel(sample.checked);
    const tag = $("#nb-tag", host);
    tag.textContent = label;
    tag.classList.toggle("sample", sample.checked);
  });
  const recBtn = host.querySelector<HTMLButtonElement>("#nb-rec");
  recBtn?.addEventListener("click", async () => {
    if (rec) {
      clip = await rec.stop();
      rec = null;
      recBtn.classList.remove("on");
      recBtn.querySelector("span")!.textContent = "Record again";
      showClip(clip);
      return;
    }
    try {
      rec = await startRecording();
      recBtn.classList.add("on");
      recBtn.querySelector("span")!.textContent = "Stop recording";
    } catch {
      recBtn.querySelector("span")!.textContent = "Microphone not available";
      recBtn.disabled = true;
    }
  });
  host.querySelector("#nb-del")?.addEventListener("click", () => {
    onDelete();
    void close();
  });
  $("#nb-save", host).addEventListener("click", async () => {
    if (rec) {
      clip = await rec.stop();
      rec = null;
    }
    const tag = $("#nb-tag", host).textContent ?? note.label;
    onSave({ ...note, label: tag, text: $<HTMLTextAreaElement>("#nb-text", host).value.trim(), sample: sample.checked, audio: note.audio || !!clip }, clip);
    void close();
  });
  window.setTimeout(() => $<HTMLTextAreaElement>("#nb-text", host).focus(), 50);
}
