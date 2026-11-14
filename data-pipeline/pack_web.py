"""Pack a site's web data for a fast first load, and list its files for offline use.

Run after the other build steps (`CAIRN_SITE=<id> python pack_web.py`).  For every raw grid it keeps the
smaller of two encodings, both gzip-compressed:

  gzip     the bytes as they are
  delta8   each byte minus its left neighbour (mod 256), row by row: smooth fields compress far better
  delta16  the same for 16-bit heights, then high bytes and low bytes stored as two planes

The relief normal map becomes a WebP (quality 90; it only lights the terrain).  `pack.json` maps each
original name to its packed file and encoding; the web loader decodes them.  Originals are removed, so
the deployed site carries only packed files.  `files.json` lists every file for "Use offline".
"""
import gzip
import json
import os
import sys

import numpy as np
from PIL import Image

from common import OUT


def gz(data: bytes) -> bytes:
    return gzip.compress(data, compresslevel=9, mtime=0)


def delta8(raw: bytes) -> bytes:
    a = np.frombuffer(raw, dtype=np.uint8)
    n = int(round(len(a) ** 0.5))
    if n * n != len(a):
        return b""
    a = a.reshape(n, n).astype(np.int16)
    return np.diff(a, axis=1, prepend=0).astype(np.uint8).tobytes()


def delta16(raw: bytes) -> bytes:
    a = np.frombuffer(raw, dtype="<u2")
    n = int(round(len(a) ** 0.5))
    if n * n != len(a):
        return b""
    d = np.diff(a.reshape(n, n).astype(np.int32), axis=1, prepend=0).astype(np.uint16)
    return (d >> 8).astype(np.uint8).tobytes() + (d & 255).astype(np.uint8).tobytes()


def read_grid(name: str) -> bytes:
    """Raw bytes of a web grid, whether it is still raw or already packed (for later build steps)."""
    path = os.path.join(OUT, name)
    if os.path.exists(path):
        return open(path, "rb").read()
    entry = json.load(open(os.path.join(OUT, "pack.json")))["files"][name]
    data = gzip.decompress(open(os.path.join(OUT, entry["file"]), "rb").read())
    if entry["enc"] == "delta8":
        n = int(round(len(data) ** 0.5))
        return np.cumsum(np.frombuffer(data, np.uint8).reshape(n, n), axis=1, dtype=np.uint8).tobytes()
    if entry["enc"] == "delta16":
        half = len(data) // 2
        n = int(round(half ** 0.5))
        d = (np.frombuffer(data[:half], np.uint8).astype(np.uint16) << 8) | np.frombuffer(data[half:], np.uint8)
        return np.cumsum(d.reshape(n, n), axis=1, dtype=np.uint16).astype("<u2").tobytes()
    return data


def pack_grid(name: str, entries: dict) -> None:
    path = os.path.join(OUT, name)
    if not os.path.exists(path):
        return
    raw = open(path, "rb").read()
    options = {"gzip": gz(raw)}
    if name.endswith(".u16"):
        d = delta16(raw)
        if d:
            options["delta16"] = gz(d)
    elif name.endswith(".u8"):
        d = delta8(raw)
        if d:
            options["delta8"] = gz(d)
    enc, data = min(options.items(), key=lambda kv: len(kv[1]))
    packed = f"{name}.pk"
    with open(os.path.join(OUT, packed), "wb") as f:
        f.write(data)
    os.remove(path)
    entries[name] = {"file": packed, "enc": enc, "bytes": len(raw)}
    print(f"  {name:<14} {len(raw) / 1e6:6.2f} MB -> {len(data) / 1e6:5.2f} MB  ({enc})")


def main() -> None:
    pack_path = os.path.join(OUT, "pack.json")
    entries = json.load(open(pack_path))["files"] if os.path.exists(pack_path) else {}
    site = json.load(open(os.path.join(OUT, "site.json")))
    names = ["height.u16", *site["grids"].values()]
    if site.get("shielding"):
        names.append(site["shielding"]["file"])
    region_path = os.path.join(OUT, "region.json")
    if os.path.exists(region_path):
        names.append(json.load(open(region_path))["height"]["file"])
    print(f"Packing {OUT}")
    for name in dict.fromkeys(names):
        pack_grid(name, entries)

    relief = site.get("relief", {}).get("file", "relief.png")
    src = os.path.join(OUT, relief)
    if os.path.exists(src) and relief.endswith(".png"):
        webp = relief[:-4] + ".webp"
        Image.open(src).convert("RGB").save(os.path.join(OUT, webp), "WEBP", quality=90, method=6)
        before = os.path.getsize(src)
        os.remove(src)
        entries[relief] = {"file": webp, "enc": "image", "bytes": before}
        print(f"  {relief:<14} {before / 1e6:6.2f} MB -> {os.path.getsize(os.path.join(OUT, webp)) / 1e6:5.2f} MB  (webp)")

    with open(pack_path, "w") as f:
        json.dump({"version": 1, "files": entries}, f, indent=1)

    files = []
    for root, _, names in os.walk(OUT):
        for n in sorted(names):
            if n in ("files.json",) or n.startswith("."):
                continue
            p = os.path.join(root, n)
            files.append({"path": os.path.relpath(p, OUT).replace(os.sep, "/"), "bytes": os.path.getsize(p)})
    files.sort(key=lambda f: f["path"])
    with open(os.path.join(OUT, "files.json"), "w") as f:
        json.dump({"files": files, "totalBytes": sum(f["bytes"] for f in files)}, f, indent=0)
    print(f"  {len(files)} files, {sum(f['bytes'] for f in files) / 1e6:.1f} MB listed for offline use")


if __name__ == "__main__":
    sys.exit(main())
