/** Decoders for the packed grids written by data-pipeline/pack_web.py (after gzip). */

/** Undo the row-by-row delta coding: each value was stored as the difference from its left neighbour. */
export function undelta8(d: Uint8Array): Uint8Array {
  const n = Math.round(Math.sqrt(d.length));
  const out = new Uint8Array(d.length);
  for (let r = 0; r < n; r++) {
    let acc = 0;
    for (let c = 0, i = r * n; c < n; c++, i++) out[i] = acc = (acc + d[i]) & 255;
  }
  return out;
}

/** 16-bit version: high bytes then low bytes as two planes; returns little-endian u16 bytes. */
export function undelta16(d: Uint8Array): Uint8Array {
  const count = d.length / 2;
  const n = Math.round(Math.sqrt(count));
  const out = new Uint16Array(count);
  for (let r = 0; r < n; r++) {
    let acc = 0;
    for (let c = 0, i = r * n; c < n; c++, i++) out[i] = acc = (acc + ((d[i] << 8) | d[count + i])) & 0xffff;
  }
  return new Uint8Array(out.buffer);
}
