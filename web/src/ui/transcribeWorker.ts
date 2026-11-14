/// <reference lib="webworker" />
/**
 * Speech to text for voice notes, on the device: Whisper tiny (English) through transformers.js, in a
 * worker so the planner stays smooth.  The model comes from the hab when it has it (npm run
 * fetch-speech), otherwise its weights are downloaded once from Hugging Face.  The audio never leaves.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

const MODEL = "onnx-community/whisper-tiny.en";

export type TranscribeRequest = { id: number; audio: Float32Array; base: string; local: boolean };
export type TranscribeResponse =
  | { id: number; type: "progress"; loadedMB: number; totalMB: number }
  | { id: number; type: "done"; text: string; ms: number }
  | { id: number; type: "error"; message: string };

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function load(base: string, local: boolean, id: number): Promise<AutomaticSpeechRecognitionPipeline> {
  if (asr) return asr;
  if (local) {
    // everything from the hab: the model and the runtime
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = `${base}models/`;
    env.backends.onnx.wasm!.wasmPaths = `${base}ort/`;
  } else {
    env.allowLocalModels = false;
  }
  const files = new Map<string, { loaded: number; total: number }>();
  // (the library's overloads are too complex for TypeScript to resolve; this is the one used)
  const make = pipeline as unknown as (task: string, model: string, options: object) => Promise<AutomaticSpeechRecognitionPipeline>;
  asr = make("automatic-speech-recognition", MODEL, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== "progress" || !p.file) return;
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
      let loaded = 0, total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, type: "progress", loadedMB: loaded / 1e6, totalMB: total / 1e6 } satisfies TranscribeResponse);
    },
  });
  asr.catch(() => (asr = null));
  return asr;
}

self.onmessage = async (ev: MessageEvent<TranscribeRequest>) => {
  const { id, audio, base, local } = ev.data;
  const post = (m: TranscribeResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
  try {
    const t0 = performance.now();
    const run = await load(base, local, id);
    const out = await run(audio, { chunk_length_s: 30, stride_length_s: 5 });
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text).trim();
    post({ id, type: "done", text, ms: performance.now() - t0 });
  } catch (e) {
    post({ id, type: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
