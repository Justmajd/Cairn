#!/usr/bin/env node
/**
 * Put the speech-to-text model on the hab, once (about 45 MB), so voice notes become text with nothing
 * leaving the habitat:
 *
 *   npm run fetch-speech
 *
 *   public/models/onnx-community/whisper-tiny.en/   Whisper tiny (English), 8-bit, from Hugging Face
 *   public/ort/                                      the ONNX runtime the browser runs it with (from npm)
 *
 * Both folders are ignored by git.  Without them, the app downloads the model weights from Hugging Face
 * and the runtime from jsDelivr the first time; the recording itself never leaves the device either way.
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const MODEL = "onnx-community/whisper-tiny.en";
const FILES = [
  "config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx",
];
const out = join(WEB, "public", "models", MODEL);

for (const f of FILES) {
  const to = join(out, f);
  if (existsSync(to) && statSync(to).size > 0) {
    console.log(`have  ${f}`);
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  const res = await fetch(`https://huggingface.co/${MODEL}/resolve/main/${f}`);
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  writeFileSync(to, data);
  console.log(`got   ${f}  ${(data.length / 1e6).toFixed(1)} MB`);
}

const ort = join(WEB, "public", "ort");
mkdirSync(ort, { recursive: true });
const dist = join(WEB, "node_modules", "@huggingface", "transformers", "dist");
for (const f of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
  copyFileSync(join(dist, f), join(ort, f));
  console.log(`copy  ort/${f}`);
}
console.log("Speech model ready: voice notes are transcribed on this hab, offline.");
