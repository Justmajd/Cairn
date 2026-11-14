"""Pack a site's web data for a fast first load, and list its files for offline use.

Run after the other build steps (`CAIRN_SITE=<id> python pack_web.py`).  For every raw grid it keeps the
smaller of two encodings, both gzip-compressed:

  gzip     the bytes as they are
  delta8   each byte minus its left neighbour (mod 256), row by row: smooth fields compress far better
  delta16  the same for 16-bit heights, then high bytes and low bytes stored as two planes

The relief normal map becomes a WebP (quality 90; it only lights the terrain).  `pack.json` maps each
original name to its packed file and encoding; the web loader decodes them.  Originals are removed, so
the deployed site carries only packed files.  `files.json` lists every file for "Use offline".

The ground images (HiRISE 50 cm and 25 cm, the regional image, the briefing map) become WebP too, about
40% smaller at ~41-43 dB PSNR against the JPEGs; site.json, region.json and context.json are updated to
name the new files.
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


# ground images: (file, WebP quality, [(json file, key path to the file name), ...])
IMAGES = [
    ("texture.jpg", 85, [("site.json", ("texture", "file"))]),
    ("texture_8k.jpg", 88, [("site.json", ("texture", "hi", "file"))]),
    ("region.jpg", 85, [("region.json", ("texture", "file"))]),
    ("context.jpg", 85, [("context.json", ("image",))]),
]


def webp_images() -> None:
    for name, quality, refs in IMAGES:
        src = os.path.join(OUT, name)
        if not os.path.exists(src):
            continue
        dst = name.rsplit(".", 1)[0] + ".webp"
        im = Image.open(src)
        im = im.convert("L" if im.mode in ("L", "P", "1") else "RGB")
        im.save(os.path.join(OUT, dst), "WEBP", quality=quality, method=6 if im.width <= 4096 else 4)
        before = os.path.getsize(src)
        os.remove(src)
        for doc_name, keys in refs:
            path = os.path.join(OUT, doc_name)
            if not os.path.exists(path):
                continue
            doc = json.load(open(path))
            node = doc
            for k in keys[:-1]:
                node = node[k]
            if node.get(keys[-1]) == name:
                node[keys[-1]] = dst
                with open(path, "w") as f:
                    json.dump(doc, f, indent=1, ensure_ascii=False)
        print(f"  {name:<14} {before / 1e6:6.2f} MB -> {os.path.getsize(os.path.join(OUT, dst)) / 1e6:5.2f} MB  (webp q{quality})")


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
    webp_images()

    files = []
    for root, _, names in os.walk(OUT):
        for n in sorted(names):
            if n in ("files.json",) or n.startswith("."):
                continue
            if n.endswith("_8k.jpg"):          # 8K VR panoramas stream online; offline uses the 4K copies
                continue
            p = os.path.join(root, n)
            files.append({"path": os.path.relpath(p, OUT).replace(os.sep, "/"), "bytes": os.path.getsize(p)})
    # the close-up ground materials are shared by every site (data/materials, build_materials.py)
    shared = os.path.normpath(os.path.join(OUT, "..", "materials"))
    if os.path.isdir(shared):
        for n in sorted(os.listdir(shared)):
            if not n.startswith("."):
                files.append({"path": "../materials/" + n, "bytes": os.path.getsize(os.path.join(shared, n))})
    files.sort(key=lambda f: f["path"])
    with open(os.path.join(OUT, "files.json"), "w") as f:
        json.dump({"files": files, "totalBytes": sum(f["bytes"] for f in files)}, f, indent=0)
    print(f"  {len(files)} files, {sum(f['bytes'] for f in files) / 1e6:.1f} MB listed for offline use")


if __name__ == "__main__":
    sys.exit(main())
