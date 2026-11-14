"""Mineral map of the walk area from CRISM summary parameters (MRO CRISM MTRDR, Viviano-Beck et al. 2014).

Source: FRT00005C5E_07_SU166J_MTR3 (map-projected targeted reduced data record, 18 m/px), PDS Geosciences Node.
Only the bands used are read (the cube is band-sequential, so each band is one contiguous byte range).

  R = OLINDEX3       olivine
  G = D2300          Fe/Mg phyllosilicate (clay)
  B = MIN2295_2480   Mg carbonate

Output: minerals.rgb (N x N x 3 bytes, 0..255 strength per parameter) and the "minerals" entry in site.json.
"""
import os

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject

from common import CFG, N, OUT, RAW, SIZE, X0, Y0, write_json

# observations, sharpest first: FRT = full resolution (18 m), HRL = half resolution long (36 m)
OBSERVATIONS = [
    {"product": "FRT00005C5E_07_SU166J_MTR3", "hdr": "frt00005c5e_07_su166j_mtr3.hdr", "img": "frt00005c5e_07_su166j_mtr3.img", "prefix": "band_"},
    {"product": "HRL000040FF_07_SU183J_MTR3", "hdr": "hrl000040ff_07_su183j_mtr3.hdr", "img": None, "prefix": "hrl_band_"},
]
BANDS = {  # band index in the SU cube, display name, detection floor, colour
    "olivine": (13, "Olivine", "OLINDEX3", 0.06, (184, 224, 74)),
    "clay": (39, "Fe/Mg clay", "D2300", 0.005, (77, 163, 255)),
    "carbonate": (43, "Carbonate", "MIN2295_2480", 0.002, (255, 90, 209)),
}


def header(obs):
    hdr = open(os.path.join(RAW, "crism", obs["hdr"])).read()
    get = lambda key: int(hdr.split(f"{key}")[1].split("=")[1].split()[0])
    wkt = hdr.split("coordinate system string = {")[1].split("}\n")[0]
    info = hdr.split("map info = {")[1].split("}")[0].split(",")
    return get("samples"), get("lines"), CRS.from_wkt(wkt), from_origin(float(info[3]), float(info[4]), float(info[5]), float(info[5])), float(info[5])


def read_band(obs, k, lines, samples):
    """Band k of a cube: from the separately fetched byte range, or from a (partial) full download."""
    nbytes = lines * samples * 4
    part = os.path.join(RAW, "crism", f"{obs['prefix']}{k}.bin")
    if os.path.exists(part):
        raw = open(part, "rb").read()
    else:
        with open(os.path.join(RAW, "crism", obs["img"]), "rb") as f:
            f.seek(k * nbytes)
            raw = f.read(nbytes)
    assert len(raw) == nbytes, f"band {k} incomplete"
    a = np.frombuffer(raw, dtype="<f4").reshape(lines, samples).astype(np.float32)
    a[(a >= 65534) | ~np.isfinite(a)] = np.nan
    return a


def main():
    with rasterio.open(os.path.join(RAW, CFG["region"]["dtm"])) as ds:
        dst_crs = ds.crs
    dst_transform = from_origin(X0 - SIZE / (N - 1) / 2, Y0 + SIZE + SIZE / (N - 1) / 2, SIZE / (N - 1), SIZE / (N - 1))

    rgb = np.zeros((N, N, 4), dtype=np.uint8)            # RGB strengths + A = inside CRISM coverage
    meta = []
    for ch, (key, (band, name, param, floor, color)) in enumerate(BANDS.items()):
        dst = np.full((N, N), np.nan, dtype=np.float32)
        tops = []
        for obs in OBSERVATIONS:                     # sharpest first; later observations only fill gaps
            samples, lines, src_crs, src_tf, px = header(obs)
            src = read_band(obs, band, lines, samples)
            layer = np.full((N, N), np.nan, dtype=np.float32)
            reproject(src, layer, src_transform=src_tf, src_crs=src_crs, dst_transform=dst_transform, dst_crs=dst_crs,
                      resampling=Resampling.bilinear, src_nodata=np.nan, dst_nodata=np.nan)
            fill = ~np.isfinite(dst) & np.isfinite(layer)
            dst[fill] = layer[fill]
            tops.append(float(np.nanpercentile(src, 99.5)))
        valid = np.isfinite(dst)
        rgb[..., 3] = np.maximum(rgb[..., 3], valid * 255)
        top = max(tops)
        strength = np.clip((np.nan_to_num(dst, nan=0) - floor) / max(top - floor, 1e-6), 0, 1)
        rgb[..., ch] = np.round(strength * 255)
        meta.append({"key": key, "name": name, "parameter": param, "floor": floor, "p995": round(top, 4),
                     "color": list(color), "coveragePct": round(float(valid.mean()) * 100, 1),
                     "detectedPct": round(float((strength > 0.15).mean()) * 100, 1)})
        print(f"{name:10s} {param:13s} coverage {valid.mean() * 100:5.1f}%  above floor {(strength > 0.15).mean() * 100:5.1f}%  p99.5 {top:.4f}")
    rgb.tofile(os.path.join(OUT, "minerals.rgba"))
    old = os.path.join(OUT, "minerals.rgb")
    if os.path.exists(old):
        os.remove(old)
    write_json("minerals.json", {"source": "MRO CRISM MTRDR summary parameters (PDS Geosciences Node)",
                                 "product": " + ".join(o["product"] for o in OBSERVATIONS), "mPerPx": 18, "bands": meta,
                                 "coveragePct": round(float((rgb[..., 3] > 0).mean()) * 100, 1),
                                 "scaling": "Strength = (band depth - floor) / (99.5th percentile - floor), per parameter"})


if __name__ == "__main__":
    main()
