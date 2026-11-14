"""Build the terrain, hazard grids, overlays and texture for the AOI.

Inputs  (raw/, fetched by fetch_terrain.py and fetch_geology.py)
  aoi_dtm_1m.npy      HiRISE DTM window, 1 m/post          (USGS Mars 2020 TRN mosaic)
  aoi_ortho_25cm.npy  HiRISE orthoimage window, 0.25 m/px  (USGS Mars 2020 TRN mosaic)
  sim3464/            USGS SIM 3464 geologic map database + THEMIS IR mosaics

Outputs (web/public/data/<site>/)
  height.u16  slope.u8  effort.u8  risk.u8  sand.u8      N x N node grids, row 0 = north
  texture.jpg                                            HiRISE orthoimage
  overlays/{slope,sand,risk,thermal,geology}.png         RGBA layers
  site.json  geology.json
"""
import glob
import json
import os

import numpy as np
import pyogrio
import rasterio
import shapely
from PIL import Image, ImageFilter
from pyproj import CRS, Transformer
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from scipy import ndimage as ndi

from common import CELL, CFG, LAT_TS, LON0, N, OUT, R_MARS, RAW, SIZE, X0, Y0, eqc_to_lonlat, write_json

# ---- model thresholds (demo parameters; see docs/plan.md §4-5) ----------------------------------
SLOPE_LIMIT_DEG = 25.0      # steeper than this is impassable for a suited walker
SLOPE_RISK_START_DEG = 8.0  # fall-risk penalty starts here ...
SLOPE_RISK_MAX = 3.0        # ... and adds up to this much at the limit
SAND_EFFORT = 1.1           # loose sand: energy x2.1 (Lejeune et al. 1998, walking on sand)
ROUGH_EFFORT = 0.4          # very rough ground: energy x1.4
ROUGH_FULL_M = 0.35         # roughness (m RMS) that counts as "very rough"

EQC = None  # CRS of the USGS mosaics, read from the CTX file


def eqc_crs():
    global EQC
    if EQC is None:
        with rasterio.open(os.path.join(RAW, CFG["region"]["dtm"])) as ds:
            EQC = ds.crs
    return EQC


def aoi_transform(n):
    """Affine transform of an n x n raster covering the AOI (pixel-as-area)."""
    return from_origin(X0, Y0 + SIZE, SIZE / n, SIZE / n)


def save_u8(name, arr):
    arr.astype(np.uint8).tofile(os.path.join(OUT, name))


# ---- terrain -----------------------------------------------------------------------------------
def build_heights(dtm):
    """Node heights on the 2 m grid: mean of the four 1 m posts around each node."""
    p = np.pad(dtm, 1, mode="edge")
    idx = np.arange(N) * CELL
    return (p[idx][:, idx] + p[idx + 1][:, idx] + p[idx][:, idx + 1] + p[idx + 1][:, idx + 1]) / 4.0


def horn_slope_deg(h, cell):
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float64) / (8.0 * cell)
    dzdx = ndi.correlate(h, kx, mode="nearest")
    dzdy = ndi.correlate(h, kx.T, mode="nearest")
    return np.degrees(np.arctan(np.hypot(dzdx, dzdy)))


def build_roughness(dtm):
    """RMS of metre-scale relief (DTM minus a 3 m Gaussian), sampled at the nodes.  Metres."""
    resid = dtm - ndi.gaussian_filter(dtm, 3.0)
    rms = np.sqrt(ndi.gaussian_filter(resid * resid, 3.0))
    idx = np.minimum(np.arange(N) * CELL, dtm.shape[0] - 1)
    return rms[idx][:, idx]


def build_sand_index(ortho_05m, dtm):
    """Likelihood (0..1) of loose aeolian bedforms (ripples / TARs).

    Bedforms are bright, regularly spaced ridges: strong image contrast AND real relief at
    5-40 m wavelengths, on gentle regional slopes.  We combine band-pass energy of the HiRISE
    image with band-pass energy of the HiRISE DTM.
    """
    img = ortho_05m.astype(np.float64)
    bp_img = ndi.gaussian_filter(img, 3.0) - ndi.gaussian_filter(img, 24.0)       # 1.5 m .. 12 m sigma
    e_img = np.sqrt(ndi.gaussian_filter(bp_img * bp_img, 30.0))
    bp_dtm = ndi.gaussian_filter(dtm, 2.0) - ndi.gaussian_filter(dtm, 12.0)
    e_dtm = np.sqrt(ndi.gaussian_filter(bp_dtm * bp_dtm, 15.0))
    bright = ndi.gaussian_filter(img, 30.0)

    step = img.shape[0] // (N - 1)
    idx_i = np.minimum(np.arange(N) * step, img.shape[0] - 1)
    idx_d = np.minimum(np.arange(N) * CELL, dtm.shape[0] - 1)
    e_img, bright, e_dtm = e_img[idx_i][:, idx_i], bright[idx_i][:, idx_i], e_dtm[idx_d][:, idx_d]

    a = np.clip((e_img - 9.0) / 9.0, 0, 1)       # image ripple contrast
    b = np.clip((e_dtm - 0.10) / 0.25, 0, 1)     # ridge relief of 0.1 .. 0.35 m RMS
    c = np.clip((bright - 95.0) / 25.0, 0, 1)    # bedforms are brighter than bedrock here
    return ndi.gaussian_filter(np.sqrt(a * b) * (0.5 + 0.5 * c), 2.0).clip(0, 1)


# ---- texture -----------------------------------------------------------------------------------
def build_texture(ortho):
    """Write the ground textures and return the 0.5 m/px image (reused for sand detection).

    texture.jpg     4096 px, 0.5 m/px  — fallback for GPUs limited to 4096 px textures, and the minimap
    texture_8k.jpg  8192 px, 0.25 m/px — the full HiRISE resolution, lightly sharpened
    Both use the same contrast stretch, so switching between them does not change the look.
    """
    px = CFG["texture_px"]
    f = ortho.shape[0] // px
    small = ortho.reshape(px, f, px, f).mean(axis=(1, 3))
    lo, hi = np.percentile(small, [0.3, 99.7])
    out = ((small - lo) / (hi - lo)).clip(0, 1) * 255
    Image.fromarray(out.astype(np.uint8), "L").save(os.path.join(OUT, "texture.jpg"), quality=90)

    full = ((ortho.astype(np.float32) - lo) / (hi - lo)).clip(0, 1) * 255
    hires = Image.fromarray(full.astype(np.uint8), "L").filter(ImageFilter.UnsharpMask(radius=1.6, percent=55, threshold=2))
    hires.save(os.path.join(OUT, "texture_8k.jpg"), quality=93, optimize=True, subsampling=0)
    return small


# ---- relief ------------------------------------------------------------------------------------
RELIEF_RANGE = 1.5  # |dz/dx| range stored in the relief map (1.5 = 56 degrees)


def build_relief(dtm):
    """Terrain gradient at the full 1 m DTM resolution, for per-pixel lighting in the 3D view.

    relief.png: R = dz/dx (east), G = dz/dy (north), mapped from [-RELIEF_RANGE, RELIEF_RANGE] to 0..255.
    Storing the gradient (not a fixed normal) lets the viewer apply vertical exaggeration exactly.
    """
    kx = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float64) / 8.0
    dzdx = ndi.correlate(dtm, kx, mode="nearest")
    dzdy = -ndi.correlate(dtm, kx.T, mode="nearest")      # rows run north -> south
    enc = lambda g: np.clip(np.round(127.5 + 127.5 * g / RELIEF_RANGE), 0, 255).astype(np.uint8)
    rgb = np.stack([enc(dzdx), enc(dzdy), np.full(dtm.shape, 128, np.uint8)], axis=-1)
    Image.fromarray(rgb, "RGB").save(os.path.join(OUT, "relief.png"), optimize=True)


# ---- terrain shielding --------------------------------------------------------------------------
SHIELD_EXPONENT = 2.0   # dose from zenith angle t falls as cos(t)^n (assumption; Wimmer-Schweingruber et al. 2015 measured a zenith dependence)
SHIELD_AZIMUTHS = 24


def build_shielding(h, cell):
    """Fraction of the surface radiation dose still received at each node once nearby terrain blocks
    part of the sky.  Per azimuth, terrain up to elevation angle b blocks sin(b)^(n+1) of a cos^n-weighted
    hemisphere.  1.0 = open ground; cliffs and channel walls give a few to ~15 percent less."""
    n = h.shape[0]
    pad = 260                                                # metres of terrain considered around each node
    k = int(pad / cell)
    hp = np.pad(h, k, mode="edge")
    dists = np.unique(np.round(np.geomspace(cell, pad, 34) / cell).astype(int))
    blocked = np.zeros_like(h)
    for a in range(SHIELD_AZIMUTHS):
        th = 2 * np.pi * a / SHIELD_AZIMUTHS
        best = np.zeros_like(h)
        for d in dists:
            dc = int(round(np.sin(th) * d))
            dr = int(round(-np.cos(th) * d))
            if dc == 0 and dr == 0:
                continue
            other = hp[k + dr:k + dr + n, k + dc:k + dc + n]
            ang = (other - h) / (cell * np.hypot(dc, dr))
            np.maximum(best, ang, out=best)
        sinb = np.sin(np.arctan(best))
        blocked += sinb ** (SHIELD_EXPONENT + 1)
    return np.clip(1.0 - blocked / SHIELD_AZIMUTHS, 0, 1)


# ---- THEMIS thermal ----------------------------------------------------------------------------
def build_thermal():
    """THEMIS night IR on the node grid: the USGS SIM 3464 mosaic at Jezero, else the global controlled
    mosaic from Mars Trek (fetch_themis_trek.py), which is the same 100 m THEMIS product."""
    if CFG.get("layers", {}).get("themis_source") == "trek":
        path, native_m = os.path.join(RAW, "themis_night_trek.tif"), 100.0
    else:
        path, native_m = glob.glob(os.path.join(RAW, "sim3464", "**", "*NightIR*.tif"), recursive=True)[0], None
    with rasterio.open(path) as ds:
        dst = np.zeros((N, N), dtype=np.float32)
        reproject(rasterio.band(ds, 1), dst, dst_transform=aoi_transform(N), dst_crs=eqc_crs(),
                  resampling=Resampling.cubic)
        native_m = native_m or abs(ds.res[0])
    return dst, native_m


# ---- geology -----------------------------------------------------------------------------------
PALETTE = [(230, 159, 0), (86, 180, 233), (0, 158, 115), (240, 228, 66), (0, 114, 178),
           (213, 94, 0), (204, 121, 167), (150, 150, 150), (120, 94, 240), (255, 176, 0),
           (100, 143, 255), (220, 38, 127), (254, 97, 0), (120, 200, 120)]


def build_geology():
    gdb = glob.glob(os.path.join(RAW, "sim3464", "**", "*.gdb"), recursive=True)[0]
    info = pyogrio.read_info(gdb, layer="GeoUnits_v1")
    tf = Transformer.from_crs(CRS.from_wkt(info["crs"]), CRS.from_wkt(eqc_crs().to_wkt()), always_xy=True)
    _, _, geoms, fields = pyogrio.raw.read(gdb, layer="GeoUnits_v1", columns=["unit", "name", "symbol"])
    aoi_box = shapely.box(X0, Y0, X0 + SIZE, Y0 + SIZE)

    units, shapes = {}, []
    for wkb, unit, name, symbol in zip(geoms, *fields):
        geom = shapely.transform(shapely.from_wkb(wkb), lambda xy: np.column_stack(tf.transform(xy[:, 0], xy[:, 1])))
        if not geom.intersects(aoi_box):
            continue
        key = str(unit)
        if key not in units:
            units[key] = {"id": len(units) + 1, "unit": key, "name": str(name), "symbol": str(symbol),
                          "color": list(PALETTE[len(units) % len(PALETTE)])}
        shapes.append((geom, units[key]["id"]))
    grid = rasterize(shapes, out_shape=(N, N), transform=aoi_transform(N), fill=0, dtype="uint8")
    for u in units.values():
        u["areaPct"] = round(float((grid == u["id"]).mean()) * 100, 1)
    print("geology units in AOI:", [(u["symbol"], u["name"], u["areaPct"]) for u in units.values()], "of", len(geoms), "polygons")
    return grid, sorted(units.values(), key=lambda u: -u["areaPct"])


# ---- main --------------------------------------------------------------------------------------
def main():
    os.makedirs(OUT, exist_ok=True)
    dtm = np.load(os.path.join(RAW, "aoi_dtm_1m.npy")).astype(np.float64)
    ortho = np.load(os.path.join(RAW, "aoi_ortho_25cm.npy"))
    assert dtm.shape == (SIZE, SIZE) and (dtm > -1e30).all(), "DTM window has gaps"

    h = build_heights(dtm)
    z_min, z_max = float(np.floor(h.min())), float(np.ceil(h.max()))
    ((h - z_min) / (z_max - z_min) * 65535).round().astype("<u2").tofile(os.path.join(OUT, "height.u16"))

    build_relief(dtm)
    slope = horn_slope_deg(h, CELL)
    rough = build_roughness(dtm)
    tex05 = build_texture(ortho)                      # 0.5 m/px float image, reused for sand
    layers = CFG.get("layers", {})
    if layers.get("themis", True):
        thermal, themis_res = build_thermal()
        lo, hi = np.percentile(thermal, [2, 98])
        tn = ((thermal - lo) / (hi - lo)).clip(0, 1)  # THEMIS night IR, 0 = coldest, 1 = warmest
        # Sand hazard = HiRISE bedform texture, weighted by THEMIS night-time temperature:
        # loose sand has low thermal inertia and is cold at night, bedrock stays warm.
        sand = build_sand_index(tex05, dtm) * (0.3 + 0.7 * np.clip((0.75 - tn) / 0.45, 0, 1))
    else:
        tn, themis_res = None, None
        sand = build_sand_index(tex05, dtm)
    sand = np.where(slope > 18, 0, sand).clip(0, 1)   # bedforms sit on gentle ground; cliffs are not sand
    if layers.get("sand", True) is False:
        # e.g. Deuteronilus: brain terrain has ridges at ripple wavelengths but is not loose sand
        sand = np.zeros_like(sand)

    effort = 1.0 + SAND_EFFORT * sand + ROUGH_EFFORT * np.clip(rough / ROUGH_FULL_M, 0, 1)
    risk = 1.0 + SLOPE_RISK_MAX * np.clip((slope - SLOPE_RISK_START_DEG) / (SLOPE_LIMIT_DEG - SLOPE_RISK_START_DEG), 0, 1)
    blocked = slope > SLOPE_LIMIT_DEG

    shield = build_shielding(h, CELL)
    save_u8("shield.u8", np.round(shield * 255))
    print("terrain shielding: dose factor min %.3f, p1 %.3f, median %.3f" % (shield.min(), np.percentile(shield, 1), np.median(shield)))
    save_u8("slope.u8", np.clip(slope.round(), 0, 90))
    save_u8("sand.u8", (sand * 255).round())
    save_u8("effort.u8", np.clip((effort * 50).round(), 0, 254))             # value / 50 = multiplier
    save_u8("risk.u8", np.where(blocked, 255, np.clip((risk * 50).round(), 0, 254)))  # 255 = impassable


    grids = {"slope": "slope.u8", "sand": "sand.u8", "effort": "effort.u8", "risk": "risk.u8"}
    if tn is not None:
        save_u8("thermal.u8", (tn * 255).round())
        grids["thermal"] = "thermal.u8"
    if layers.get("geology", True):
        build_and_save_geology()
        grids["geology"] = "geology.u8"
    if os.path.exists(os.path.join(OUT, "minerals.rgba")):
        grids["minerals"] = "minerals.rgba"

    write_site_json(grids, z_min, z_max, slope, blocked, sand, themis_res, ortho.shape[0])


def build_and_save_geology():
    geo, units = build_geology()
    save_u8("geology.u8", geo)
    write_json("geology.json", {"source": "USGS SIM 3464 (Sun & Stack, 2020), GeoUnits_v1", "mapScale": "1:75,000",
                                "units": units})


def write_site_json(grids, z_min, z_max, slope, blocked, sand, themis_res, ortho_px):
    lon0, lat0 = eqc_to_lonlat(X0, Y0)
    lon1, lat1 = eqc_to_lonlat(X0 + SIZE, Y0 + SIZE)
    story = CFG.get("story")
    mp = os.path.join(OUT, "minerals.json")
    minerals = json.load(open(mp)) if os.path.exists(mp) and "minerals" in grids else None
    write_json("site.json", {
        "id": CFG["id"], "name": CFG["name"],
        "crs": f"Equirectangular, Mars sphere (R = {R_MARS:,.0f} m), lat_ts = {LAT_TS:g}, lon0 = {LON0}",
        "originEqc": {"x": X0, "y": Y0},
        "boundsLonLat": {"west": round(lon0, 6), "south": round(lat0, 6), "east": round(lon1, 6), "north": round(lat1, 6)},
        "sizeM": SIZE, "grid": {"n": N, "cellM": CELL},
        "height": {"file": "height.u16", "zMin": z_min, "zMax": z_max},
        "texture": {"file": "texture.jpg", "px": CFG["texture_px"], "mPerPx": SIZE / CFG["texture_px"],
                    "hi": {"file": "texture_8k.jpg", "px": ortho_px, "mPerPx": SIZE / ortho_px}},
        "relief": {"file": "relief.png", "range": RELIEF_RANGE},
        "eva": CFG.get("eva"), "rover": CFG.get("rover"), "story": story, "minerals": minerals,
        "centerLonLat": {"lon": round((lon0 + lon1) / 2, 6), "lat": round((lat0 + lat1) / 2, 6)},
        "shielding": {"file": "shield.u8", "exponent": SHIELD_EXPONENT, "azimuths": SHIELD_AZIMUTHS, "radiusM": 260},
        "grids": grids,
        "model": {"slopeLimitDeg": SLOPE_LIMIT_DEG, "slopeRiskStartDeg": SLOPE_RISK_START_DEG,
                  "slopeRiskMax": SLOPE_RISK_MAX, "sandEffort": SAND_EFFORT, "roughEffort": ROUGH_EFFORT,
                  "effortScale": 50, "riskScale": 50, "themisNativeResM": round(themis_res, 1) if themis_res else None},
        "stats": {"slopeMedianDeg": round(float(np.median(slope)), 1),
                  "blockedPct": round(float(blocked.mean()) * 100, 1),
                  "sandPct": round(float((sand > 0.5).mean()) * 100, 1),
                  "reliefM": round(z_max - z_min, 1)},
    })
    print("slope median %.1f deg, blocked %.1f%%, sand>0.5 %.1f%%" % (np.median(slope), blocked.mean() * 100, (sand > 0.5).mean() * 100))


if __name__ == "__main__":
    main()
