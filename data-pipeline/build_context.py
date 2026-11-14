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

from rasterio.windows import from_bounds

from common import CFG, OUT, RAW, SHARED, SITE, SIZE, X0, Y0, eqc_to_lonlat, lonlat_to_eqc, write_json

CONTEXT_PX = 2048


def ndi_open(mask):
    """Remove compression speckle from a footprint mask."""
    from scipy import ndimage as ndi
    return ndi.binary_opening(mask, iterations=3)
TREK_LAYER = "Mars_Viking_MDIM21_ClrMosaic_global_232m"


def main():
    os.makedirs(OUT, exist_ok=True)
    ctx = CFG.get("context", {"ortho": "ctx_ortho.tif"})
    with rasterio.open(os.path.join(RAW, ctx["ortho"])) as ds:
        if "halfKm" in ctx:                     # square crop around the walk area
            cx, cy, hk = X0 + SIZE / 2, Y0 + SIZE / 2, ctx["halfKm"] * 1000
            win = from_bounds(cx - hk, cy - hk, cx + hk, cy + hk, ds.transform)
            b = rasterio.coords.BoundingBox(cx - hk, cy - hk, cx + hk, cy + hk)
        else:
            win = None
            b = ds.bounds
        w = CONTEXT_PX
        h = round(w * (b.top - b.bottom) / (b.right - b.left))
        img = ds.read(1, window=win, out_shape=(h, w), resampling=Resampling.average).astype(np.float64)
        valid = ndi_open(img > 6)  # JPEG2000 leaves faint non-zero values outside the footprint
        lo, hi = np.percentile(img[valid], [0.5, 99.5])
        out = np.where(valid, ((img - lo) / (hi - lo)).clip(0, 1) * 255, 0)
        if (~valid).any():   # outside the image footprint: a dim, blurred continuation instead of black
            from scipy import ndimage as ndi
            idx = ndi.distance_transform_edt(~valid, return_distances=False, return_indices=True)
            dist = ndi.distance_transform_edt(~valid)
            soft = ndi.gaussian_filter(out[tuple(idx)], 12)
            fade = np.clip(1 - dist / (0.15 * out.shape[1]), 0.25, 1) * 0.45
            out = np.where(valid, out, soft * fade)
        Image.fromarray(out.astype(np.uint8), "L").save(os.path.join(OUT, "context.jpg"), quality=86)

    def norm(x, y):   # eqc metres -> [0..1] image coords (u right, v down)
        return [round((x - b.left) / (b.right - b.left), 5), round((b.top - y) / (b.top - b.bottom), 5)]

    if not CFG.get("rover"):
        return finish_no_rover(norm, b, w, h, ctx)
    way = json.load(open(os.path.join(RAW, "M20_waypoints.json" if SITE == "jezero" else "MSL_waypoints.json")))["features"]
    pts = [(f["properties"], lonlat_to_eqc(f["properties"]["lon"], f["properties"]["lat"])) for f in way]
    line, last = [], None
    for p, (x, y) in pts:                       # decimate to >= 25 m spacing
        if last is None or math.hypot(x - last[0], y - last[1]) >= 25:
            line.append(norm(x, y) + [p["sol"]]); last = (x, y)

    def at_sol(sol):
        p, xy = min(pts, key=lambda t: abs(t[0]["sol"] - sol))
        return p, xy

    places = []
    for pl in CFG["context"]["places"] if "context" in CFG else [
        {"id": "landing", "name": "Octavia E. Butler Landing", "sol": 13, "note": "Perseverance touched down here on 18 Feb 2021."},
        {"id": "threeforks", "name": "Three Forks sample depot", "sol": 670, "note": "Ten sealed sample tubes left on the surface, sols 653-690."},
        {"id": "cheyava", "name": "Cheyava Falls · Bright Angel", "sol": 1215, "note": "Potential biosignature rock, sampled as 'Sapphire Canyon' on sol 1215."},
        {"id": "latest", "name": "Rover position in this dataset", "sol": -1, "note": "Last waypoint in the MMGIS layer used here."},
    ]:
        p, (x, y) = at_sol(pl["sol"] if pl["sol"] >= 0 else pts[-1][0]["sol"])
        u, v = norm(x, y)
        if not (0 <= u <= 1 and 0 <= v <= 1):
            continue
        places.append({**pl, "sol": p["sol"], "uv": [u, v], "lon": round(p["lon"], 5), "lat": round(p["lat"], 5)})

    def km_between(sol_a, sol_b):
        (ax, ay), (bx, by) = at_sol(sol_a)[1], at_sol(sol_b)[1]
        return round(math.hypot(ax - bx, ay - by) / 1000, 2)

    if SITE == "jezero":
        facts = [{"value": f"{km_between(670, 1215)} km", "label": "from the Three Forks sample depot to Cheyava Falls — a rover drive, not a walk"}]
        lines = [{"from": "threeforks", "to": "cheyava"}]
    else:
        facts = [{"value": f"{km_between(4190, 4605)} km", "label": "from where Curiosity measured the 20 May 2024 storm to the boxwork"}]
        lines = [{"from": "storm", "to": "ridge"}]
    facts += [{"value": f"{SIZE / 1000:.1f} × {SIZE / 1000:.1f} km", "label": "EVA area mapped at 1 m elevation and 25 cm imagery"},
              {"value": f"{pts[-1][0]['dist_total_m'] / 1000:.2f} km", "label": f"driven by {CFG['rover']['name']} up to sol {pts[-1][0]['sol']} — the trail we follow"}]

    save_global()
    lon_c, lat_c = eqc_to_lonlat(X0 + SIZE / 2, Y0 + SIZE / 2)
    write_json("context.json", {
        "image": "context.jpg", "aspect": round(w / h, 5),
        "source": ctx.get("source", "USGS Mars 2020 TRN CTX orthomosaic, 6 m/px (MRO Context Camera)"),
        "widthKm": round((b.right - b.left) / 1000, 2), "heightKm": round((b.top - b.bottom) / 1000, 2),
        "aoi": {"uv0": norm(X0, Y0 + SIZE), "uv1": norm(X0 + SIZE, Y0)},
        "traverse": {"source": f"{CFG['rover']['mission']} MMGIS waypoint layer (mars.nasa.gov)", "points": line,
                     "totalKm": round(pts[-1][0]["dist_total_m"] / 1000, 2), "lastSol": pts[-1][0]["sol"]},
        "places": places,
        "facts": facts, "links": lines,
        "global": {"image": "global.jpg", "source": f"NASA/JPL Mars Trek WMTS — {TREK_LAYER}",
                   "siteUv": [round((lon_c + 180) / 360, 5), round((90 - lat_c) / 180, 5)],
                   "lon": round(lon_c, 4), "lat": round(lat_c, 4)},
    })
    print("context", w, h, "traverse pts", len(line), "places", [p["id"] for p in places])


def save_global():
    """Global mosaic from Mars Trek WMTS tiles (level 2 = 8 x 4 tiles of 256 px, equirectangular)."""
    sheet = Image.new("RGB", (8 * 256, 4 * 256))
    for r in range(4):
        for c in range(8):
            sheet.paste(Image.open(os.path.join(SHARED, "trek", f"2_{r}_{c}.jpg")).convert("RGB"), (c * 256, r * 256))
    sheet.resize((1536, 768), Image.LANCZOS).save(os.path.join(OUT, "global.jpg"), quality=85)


def finish_no_rover(norm, b, w, h, ctx):
    """A site no rover has visited: places and facts come from the config, there is no traverse."""
    places = []
    for pl in ctx.get("places", []):
        x, y = lonlat_to_eqc(pl["lon"], pl["lat"])
        u, v = norm(x, y)
        if 0 <= u <= 1 and 0 <= v <= 1:
            places.append({**pl, "uv": [u, v]})
    facts = ctx.get("facts", []) + [{"value": f"{SIZE / 1000:.1f} × {SIZE / 1000:.1f} km", "label": "EVA area mapped at 1 m elevation and 25 cm imagery"}]
    save_global()
    lon_c, lat_c = eqc_to_lonlat(X0 + SIZE / 2, Y0 + SIZE / 2)
    write_json("context.json", {
        "image": "context.jpg", "aspect": round(w / h, 5), "source": ctx.get("source", ""),
        "widthKm": round((b.right - b.left) / 1000, 2), "heightKm": round((b.top - b.bottom) / 1000, 2),
        "aoi": {"uv0": norm(X0, Y0 + SIZE), "uv1": norm(X0 + SIZE, Y0)},
        "traverse": None, "places": places, "facts": facts, "links": ctx.get("links", []),
        "global": {"image": "global.jpg", "source": f"NASA/JPL Mars Trek WMTS — {TREK_LAYER}",
                   "siteUv": [round((((lon_c + 180) % 360) - 0) / 360, 5), round((90 - lat_c) / 180, 5)],
                   "lon": round(lon_c, 4), "lat": round(lat_c, 4)},
    })
    print("context", w, h, "places", [p["id"] for p in places])


if __name__ == "__main__":
    main()
