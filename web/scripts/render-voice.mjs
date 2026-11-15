#!/usr/bin/env node
/**
 * Render the EVA voice guidance clips with Kokoro (Kokoro-82M, Apache-2.0), a free neural voice, so
 * every visitor hears the same natural voice on any device, offline, with nothing to download but a
 * few kilobytes per line.  Run once after changing the phrases or the stops:
 *
 *   npm run render-voice              (renders only new or changed clips)
 *   npm run render-voice -- --all     (renders everything again)
 *
 * The vocabulary comes from src/ui/voiceLines.ts (imported directly: Node strips the types) plus the
 * stop names in public/data/<site>/pois.json.  Output: public/voice/<id>.mp3 and manifest.json.
 * The model (~92 MB) is downloaded to the Hugging Face cache on first run; the app never loads it.
 */
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KokoroTTS, env } from "kokoro-js";
import { Mp3Encoder } from "@breezystack/lamejs";
import { vocabulary } from "../src/ui/voiceLines.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "voice");
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = "af_heart";
const KBPS = 40;
const all = process.argv.includes("--all");

/** How the model should say what the screen writes. */
const say = (t) => t.replace(/\bEVA\b/g, "E.V.A.");

// ---- the vocabulary: phrases, numbers and every site's stop names
const sites = JSON.parse(await readFile(join(ROOT, "public/data/sites.json"), "utf8"));
const stops = [];
for (const s of sites.sites ?? sites) {
  const id = typeof s === "string" ? s : s.id;
  const pois = JSON.parse(await readFile(join(ROOT, "public/data", id, "pois.json"), "utf8")).pois;
  for (const p of pois) if (p.kind !== "shelter") {
    const clash = stops.find((q) => q.id === p.id && q.short !== p.short);
    if (clash) throw new Error(`Stop id "${p.id}" means "${clash.short}" and "${p.short}": the clips need unique ids`);
    stops.push({ id: p.id, short: p.short });
  }
}
const vocab = vocabulary(stops);

await mkdir(OUT, { recursive: true });
const manifestPath = join(OUT, "manifest.json");
const old = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : { clips: {} };
const todo = [...vocab].filter(([id, text]) => all || old.clips?.[id] !== text || !existsSync(join(OUT, `${id}.mp3`)));
console.log(`${vocab.size} clips, ${todo.length} to render (voice ${VOICE})`);

if (todo.length) {
  // the model files, fetched once into node_modules/.cache with retries (a flaky DNS lookup should not
  // end a ten-minute render), then loaded from disk
  const cache = join(ROOT, "node_modules", ".cache", "kokoro");
  for (const f of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]) await fetchOnce(f, join(cache, MODEL, f));
  env.localModelPath = cache;
  env.allowRemoteModels = false;
  const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "cpu" });
  let n = 0;
  for (const [id, text] of todo) {
    const audio = await tts.generate(say(text), { voice: VOICE });
    await writeFile(join(OUT, `${id}.mp3`), mp3(trim(audio.audio, audio.sampling_rate), audio.sampling_rate));
    if (++n % 25 === 0 || n === todo.length) console.log(`  ${n}/${todo.length}  ${id}: ${text}`);
  }
}

// clips no longer in the vocabulary go
for (const f of await readdir(OUT)) {
  if (f.endsWith(".mp3") && !vocab.has(f.slice(0, -4))) await rm(join(OUT, f));
}
await writeFile(
  manifestPath,
  JSON.stringify({ voice: VOICE, model: MODEL, licence: "Apache-2.0 (Kokoro-82M by hexgrad)", clips: Object.fromEntries([...vocab].sort()) }, null, 0) + "\n",
);
console.log(`wrote ${manifestPath}`);

async function fetchOnce(file, dest) {
  if (existsSync(dest)) return;
  await mkdir(dirname(dest), { recursive: true });
  const url = `https://huggingface.co/${MODEL}/resolve/main/${file}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await writeFile(dest, Buffer.from(await r.arrayBuffer()));
      console.log(`  fetched ${file}`);
      return;
    } catch (e) {
      if (attempt >= 12) {
        // phonemizer (loaded with kokoro-js) turns any uncaught error into a page of minified code: say it plainly and stop
        console.error(`\nCould not download ${file} (${e.cause?.code ?? e.message}).\nIf the command line cannot reach Hugging Face's download server, open this link in a browser:\n  ${url}\nand move the file to:\n  ${dest}\nthen run npm run render-voice again.`);
        process.exit(1);
      }
      await new Promise((ok) => setTimeout(ok, 1500 * attempt));
    }
  }
}

/** Cut the silence the model leaves around a phrase, keeping a short breath. */
function trim(x, rate) {
  const thr = 0.008;
  let a = 0;
  let b = x.length - 1;
  while (a < b && Math.abs(x[a]) < thr) a++;
  while (b > a && Math.abs(x[b]) < thr) b--;
  const pad = Math.round(rate * 0.025);
  return x.subarray(Math.max(0, a - pad), Math.min(x.length, b + pad * 2));
}

function mp3(x, rate) {
  const enc = new Mp3Encoder(1, rate, KBPS);
  const pcm = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) pcm[i] = Math.max(-1, Math.min(1, x[i])) * 32767;
  const chunks = [];
  for (let i = 0; i < pcm.length; i += 1152) {
    const c = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (c.length) chunks.push(Buffer.from(c));
  }
  const end = enc.flush();
  if (end.length) chunks.push(Buffer.from(end));
  return Buffer.concat(chunks);
}
