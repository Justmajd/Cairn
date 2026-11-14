/**
 * Turn a voice note into text on this device (see transcribeWorker.ts).  Loaded the first time someone
 * asks for it; the model then stays loaded in its worker for the next notes.
 */
import { habUrl } from "../hab/link";
import type { TranscribeRequest, TranscribeResponse } from "./transcribeWorker";

let worker: Worker | null = null;
let seq = 0;
let localModel: Promise<boolean> | null = null;

/** Does the hab have the model (npm run fetch-speech)?  Then nothing is downloaded from outside. */
function hasLocalModel(): Promise<boolean> {
  localModel ??= fetch(habUrl("models/onnx-community/whisper-tiny.en/config.json"), { method: "HEAD", cache: "no-store" })
    .then((r) => r.ok && !String(r.headers.get("content-type")).includes("text/html"))
    .catch(() => false);
  return localModel;
}

/** Any clip the browser recorded, as 16 kHz mono samples (what Whisper listens to). */
async function to16k(clip: Blob): Promise<Float32Array> {
  const probe = new OfflineAudioContext(1, 1, 16000);
  const decoded = await probe.decodeAudioData(await clip.arrayBuffer());
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * 16000)), 16000);
  const src = ctx.createBufferSource();
  src.buffer = decoded;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

export async function transcribe(clip: Blob, onProgress: (loadedMB: number, totalMB: number) => void): Promise<{ text: string; ms: number; local: boolean }> {
  const [audio, local] = await Promise.all([to16k(clip), hasLocalModel()]);
  worker ??= new Worker(new URL("./transcribeWorker.ts", import.meta.url), { type: "module" });
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const w = worker!;
    const onMsg = (ev: MessageEvent<TranscribeResponse>) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === "progress") return onProgress(m.loadedMB, m.totalMB);
      w.removeEventListener("message", onMsg);
      if (m.type === "done") resolve({ text: m.text, ms: m.ms, local });
      else reject(new Error(m.message));
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ id, audio, base: habUrl("./"), local } satisfies TranscribeRequest, [audio.buffer]);
  });
}
