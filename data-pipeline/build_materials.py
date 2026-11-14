"""
Close-up ground materials for the 3D view: photo-scanned CC0 textures from Poly Haven
(raw/materials/, see fetch notes in each <id>.json), packed for the web.

The colour of the ground stays the HiRISE image's: a material only adds what HiRISE cannot see.
Each material becomes one RGB WebP:
  R = fine brightness detail, as a ratio to the local mean (0.5 = unchanged, so the HiRISE brightness is kept)
  G, B = the surface normal's x and y (OpenGL convention), for lighting the relief
at 2048 px (desktop) and 1024 px (phones, ?q=low).  Output: web/public/data/materials/ + materials.json.
"""
import json
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "raw", "materials")
OUT = os.path.normpath(os.path.join(HERE, "..", "web", "public", "data", "materials"))
# role in the shader -> Poly Haven id
MATERIALS = {"sand": "red_sand", "gravel": "dry_ground_rocks", "bedrock": "cracked_red_ground", "rock": "rock_boulder_dry"}


def pack(mid):
    rgb = np.asarray(Image.open(os.path.join(SRC, f"{mid}_Diffuse_2k.jpg")).convert("RGB")).astype(np.float32) / 255
    nrm = np.asarray(Image.open(os.path.join(SRC, f"{mid}_nor_gl_2k.jpg")).convert("RGB")).astype(np.float32) / 255
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    # ratio to a wrap-around local mean: only the detail, none of the large-scale tone (tiles seamlessly)
    mean = ndi.gaussian_filter(lum, lum.shape[0] / 16, mode="wrap")
    ratio = np.clip(lum / np.maximum(mean, 1e-3), 0, 2)
    out = np.dstack([ratio * 0.5, nrm[..., 0], nrm[..., 1]])
    return Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")


def main():
    os.makedirs(OUT, exist_ok=True)
    meta = {"source": "Poly Haven (polyhaven.com), CC0 photo-scanned materials", "materials": {}}
    for role, mid in MATERIALS.items():
        img = pack(mid)
        info = json.load(open(os.path.join(SRC, f"{mid}.json")))
        files = {}
        for px in (2048, 1024):
            name = f"{mid}_{px // 1024}k.webp"
            (img if img.width == px else img.resize((px, px), Image.LANCZOS)).save(os.path.join(OUT, name), quality=90, method=6)
            files[f"{px // 1024}k"] = f"materials/{name}"
            print(f"{name:32s} {os.path.getsize(os.path.join(OUT, name)) / 1e6:.2f} MB")
        size_m = round(float(info["dimensions_mm"][0]) / 1000, 2) if info.get("dimensions_mm") else 2.0
        meta["materials"][role] = {"id": mid, "name": info["name"], "sizeM": size_m, "files": files,
                                   "authors": list((info.get("authors") or {}).keys()), "license": "CC0", "url": info["url"]}
    json.dump(meta, open(os.path.join(OUT, "materials.json"), "w"), indent=1)
    print("wrote", os.path.join(OUT, "materials.json"))


if __name__ == "__main__":
    main()
