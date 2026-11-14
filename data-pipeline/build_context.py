"""Build the regional context: a CTX orthomosaic of Jezero with Perseverance's real traverse,
plus a global Mars image from NASA/JPL Mars Trek tiles.

Outputs: context.jpg, global.jpg, context.json
"""
import json
import math
import os

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling

from common import OUT, RAW, SIZE, X0, Y0, lonlat_to_eqc, write_json

CONTEXT_PX = 2048
TREK_LAYER = "Mars_Viking_MDIM21_ClrMosaic_global_232m"


def main():
    os.makedirs(OUT, exist_ok=True)
    with rasterio.open(os.path.join(RAW, "ctx_ortho.tif")) as ds:
        b = ds.bounds
        w = CONTEXT_PX
        h = round(w * ds.height / ds.width)
        img = ds.read(1, out_shape=(h, w), resampling=Resampling.average).astype(np.float64)
        valid = img > 0
        lo, hi = np.percentile(img[valid], [0.5, 99.5])
        out = np.where(valid, ((img - lo) / (hi - lo)).clip(0, 1) * 255, 0)
        Image.fromarray(out.astype(np.uint8), "L").save(os.path.join(OUT, "context.jpg"), quality=86)

    def norm(x, y):   # eqc metres -> [0..1] image coords (u right, v down)
        return [round((x - b.left) / (b.right - b.left), 5), round((b.top - y) / (b.top - b.bottom), 5)]

    way = json.load(open(os.path.join(RAW, "M20_waypoints.json")))["features"]
    pts = [(f["properties"], lonlat_to_eqc(f["properties"]["lon"], f["properties"]["lat"])) for f in way]
    line, last = [], None
    for p, (x, y) in pts:                       # decimate to >= 25 m spacing
        if last is None or math.hypot(x - last[0], y - last[1]) >= 25:
            line.append(norm(x, y) + [p["sol"]]); last = (x, y)

    def at_sol(sol):
        p, xy = min(pts, key=lambda t: abs(t[0]["sol"] - sol))
        return p, xy

    places = []
    for pid, name, sol, note in [
        ("landing", "Octavia E. Butler Landing", 13, "Perseverance touched down here on 18 Feb 2021."),
        ("threeforks", "Three Forks sample depot", 670, "Ten sealed sample tubes left on the surface, sols 653-690."),
        ("cheyava", "Cheyava Falls · Bright Angel", 1215, "Potential biosignature rock, sampled as 'Sapphire Canyon' on sol 1215."),
        ("latest", "Rover position in this dataset", pts[-1][0]["sol"], "Last waypoint in the MMGIS layer used here."),
    ]:
        p, (x, y) = at_sol(sol)
        places.append({"id": pid, "name": name, "sol": p["sol"], "uv": norm(x, y), "note": note,
                       "lon": round(p["lon"], 5), "lat": round(p["lat"], 5)})
    depot, chey = places[1], places[2]
    (dx, dy), (cx, cy) = at_sol(670)[1], at_sol(1215)[1]

    # global mosaic from Mars Trek WMTS tiles (level 2 = 8 x 4 tiles of 256 px, equirectangular)
    sheet = Image.new("RGB", (8 * 256, 4 * 256))
    for r in range(4):
        for c in range(8):
            sheet.paste(Image.open(os.path.join(RAW, "trek", f"2_{r}_{c}.jpg")).convert("RGB"), (c * 256, r * 256))
    sheet.resize((1536, 768), Image.LANCZOS).save(os.path.join(OUT, "global.jpg"), quality=85)

    lon_c, lat_c = math.degrees((X0 + SIZE / 2) / 3396190.0), math.degrees((Y0 + SIZE / 2) / 3396190.0)
    write_json("context.json", {
        "image": "context.jpg", "aspect": round(w / h, 5),
        "source": "USGS Mars 2020 TRN CTX orthomosaic, 6 m/px (MRO Context Camera)",
        "widthKm": round((b.right - b.left) / 1000, 2), "heightKm": round((b.top - b.bottom) / 1000, 2),
        "aoi": {"uv0": norm(X0, Y0 + SIZE), "uv1": norm(X0 + SIZE, Y0)},
        "traverse": {"source": "Mars 2020 MMGIS waypoint layer (mars.nasa.gov)", "points": line,
                     "totalKm": round(pts[-1][0]["dist_total_m"] / 1000, 2), "lastSol": pts[-1][0]["sol"]},
        "places": places,
        "depotToCheyavaKm": round(math.hypot(dx - cx, dy - cy) / 1000, 2),
        "global": {"image": "global.jpg", "source": f"NASA/JPL Mars Trek WMTS — {TREK_LAYER}",
                   "siteUv": [round((lon_c + 180) / 360, 5), round((90 - lat_c) / 180, 5)],
                   "lon": round(lon_c, 4), "lat": round(lat_c, 4)},
    })
    print("context", w, h, "traverse pts", len(line), "depot->cheyava km", round(math.hypot(dx - cx, dy - cy) / 1000, 2))


if __name__ == "__main__":
    main()
