/**
 * The field note editor (text, "sample taken", voice recording), loaded when a note is first opened.
 */
import { $, esc } from "./dom";
import { ic } from "./icons";
import { hideAnimated, showAnimated } from "./motion";
import type { FieldNote, Notebook } from "./notebook";

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
        <label class="vh" for="nb-text">What you see at this spot</label>
        <textarea id="nb-text" rows="4" placeholder="What do you see? Colour, texture, layering, what to come back for…">${esc(note.text)}</textarea>
        <label class="switch"><span>Sample taken here (bagged and labelled)</span><input class="sr" type="checkbox" id="nb-sample" ${note.sample ? "checked" : ""}/><i></i></label>
        <div class="note-voice">
          ${canRecord() ? `<button class="secondary" id="nb-rec" aria-pressed="false">${ic.mic}<span>Record a voice note</span></button>` : `<small>Voice notes need a microphone and a browser that can record.</small>`}
          <audio id="nb-audio" controls hidden aria-label="Voice note"></audio>
          <p class="note-status" id="nb-status" role="status" aria-live="polite"></p>
          <div class="note-voice-row">
            <button class="secondary" id="nb-text-btn" hidden title="Speech to text on this device: the recording is not sent anywhere">${ic.note}<span>Turn into text</span></button>
            <button class="secondary" id="nb-mp3" hidden>${ic.download}<span>Download MP3</span></button>
          </div>
        </div>
        <div class="note-actions">
          ${isNew ? "" : `<button class="secondary danger" id="nb-del">${ic.close}<span>Delete</span></button>`}
          <button class="primary" id="nb-save">${ic.check}<span>${isNew ? "Save note" : "Save"}</span></button>
        </div>
      </div>
    </div>`;
  showAnimated(host);
  const opener = document.activeElement as HTMLElement | null;
  const status = (text: string) => ($("#nb-status", host).textContent = text);
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
    textBtn.hidden = false;
  };
  // speech to text, on this device (the model loads once, ~45 MB, from the hab when it has it)
  const textBtn = $<HTMLButtonElement>("#nb-text-btn", host);
  textBtn.addEventListener("click", async () => {
    const src = clip ?? (await book.loadAudio(note.id));
    if (!src) return;
    const label = textBtn.querySelector("span")!;
    textBtn.disabled = true;
    label.textContent = "Starting…";
    status("Turning the voice note into text on this device.");
    try {
      const { transcribe } = await import("./transcribe");
      const r = await transcribe(src, (loaded, total) => {
        label.textContent = total > 1 ? `Loading speech model ${Math.round((loaded / total) * 100)}%` : "Loading speech model…";
      });
      label.textContent = "Turn into text";
      const ta = $<HTMLTextAreaElement>("#nb-text", host);
      if (r.text) ta.value = ta.value.trim() ? `${ta.value.trim()}\n${r.text}` : r.text;
      status(r.text ? `Transcribed in ${(r.ms / 1000).toFixed(1)} s on this device${r.local ? ", with the hab's speech model" : ""}. Check it, then save.` : "No speech heard in the recording.");
      ta.focus();
    } catch (e) {
      label.textContent = "Could not transcribe";
      status(`Speech to text failed: ${e instanceof Error ? e.message : e}`);
      console.warn("transcribe", e);
    } finally {
      textBtn.disabled = false;
    }
  });
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
    host.removeEventListener("keydown", keys);
    hideAnimated(host, 160);
    // back to what opened the note; if the notebook was redrawn meanwhile (another device saved), to
    // this note's pin or list entry now; never left on the hidden dialog
    const target =
      (opener?.isConnected && opener !== document.body ? opener : null) ??
      document.querySelector<HTMLElement>(`[data-note="${note.id}"], .note-pin[data-note-id="${note.id}"]`);
    if (target) target.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  };
  // Escape closes (even while typing); Tab stays inside the dialog
  const keys = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      void close();
    } else if (ev.key === "Tab") {
      const items = [...host.querySelectorAll<HTMLElement>("button:not([disabled]):not([hidden]), textarea, input, audio:not([hidden])")].filter((e) => e.offsetParent !== null || e === document.activeElement);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  };
  host.addEventListener("keydown", keys);
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
      recBtn.setAttribute("aria-pressed", "false");
      recBtn.querySelector("span")!.textContent = "Record again";
      showClip(clip);
      status("Voice note recorded. It is saved with the note.");
      return;
    }
    try {
      rec = await startRecording();
      recBtn.classList.add("on");
      recBtn.setAttribute("aria-pressed", "true");
      recBtn.querySelector("span")!.textContent = "Stop recording";
      status("Recording. Press the button again to stop.");
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
