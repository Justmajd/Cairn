/**
 * Voice notes out of the app: the browser records WebM/Opus (Chrome, Firefox) or MP4/AAC (Safari),
 * which not every player opens, so clips are decoded and re-encoded as MP3 (LAME, mono, 96 kbit/s).
 * Loaded only when a voice note is exported (the encoder is ~100 kB).
 */
import { Mp3Encoder } from "@breezystack/lamejs";
import { strToU8, zipSync } from "fflate";

/** Decode any clip the browser recorded and encode it as MP3. */
export async function toMp3(clip: Blob): Promise<Blob> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  const audio = await ctx.decodeAudioData(await clip.arrayBuffer());
  // mix down to mono, as 16-bit samples
  const n = audio.length;
  const pcm = new Int16Array(n);
  const chans = Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const ch of chans) v += ch[i];
    v /= chans.length;
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  const enc = new Mp3Encoder(1, audio.sampleRate, 96);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < n; i += 1152 * 8) {
    const out = enc.encodeBuffer(pcm.subarray(i, i + 1152 * 8));
    if (out.length) parts.push(out);
  }
  const tail = enc.flush();
  if (tail.length) parts.push(tail);
  return new Blob(parts as BlobPart[], { type: "audio/mpeg" });
}

/** A ZIP of text files and MP3 clips (path → content). */
export async function zipFiles(files: Record<string, string | Blob>): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, v] of Object.entries(files)) {
    entries[path] = typeof v === "string" ? strToU8(v) : new Uint8Array(await v.arrayBuffer());
  }
  // MP3 is already compressed: store it as is, deflate only the text
  const zipped = zipSync(
    Object.fromEntries(Object.entries(entries).map(([p, d]) => [p, [d, { level: p.endsWith(".mp3") ? 0 : 6 }]])),
  );
  return new Blob([zipped as BlobPart], { type: "application/zip" });
}

export function saveBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
