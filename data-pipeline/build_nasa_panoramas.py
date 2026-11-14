"""
NASA's own 360° panoramas (JPL Photojournal), placed at the stop where the rover took them.

The mosaics are published without a pointing, so each one is aligned to the terrain here:
the skyline seen in the photo is matched against the horizon computed from the HiRISE / regional
elevation model at the rover's position (mast height ~2 m).  The fit gives the azimuth of the
image's left edge, the angular scale and the tilt of the mosaic; the result is resampled onto the
same equirectangular band as CAIRN's own panoramas (azimuth 0-360 from north, elevation -55..35),
with the no-data areas of the mosaic filled (sky above, blurred ground below) and marked as filled.

Inputs: raw/nasa_pano/PIA*.jpg (Photojournal, public domain), rover waypoints.
Output: web/public/data/<site>/panoramas/<stop>.jpg and entries merged into panoramas.json.
Run after build_panoramas.py (which writes panoramas.json for the stitched Navcam ones).
"""
import json
import math
import os
import sys

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from scipy import ndimage as ndi

from common import CFG, HERE, OUT, RAW, SITE, SIZE, X0, Y0, lonlat_to_local
import pano_common

Image.MAX_IMAGE_PIXELS = None
SRC = os.path.join(HERE, "raw", "nasa_pano")
EL_MIN, EL_MAX = -90.0, 90.0                 # full sphere, ready for VR (see pano_common.py)
PX_PER_DEG = pano_common.PX_PER_DEG
MAST_M = 2.0
DEBUG = os.environ.get("CAIRN_PANO_DEBUG")

PANOS = {
    "jezero": [{
        "stop": "brightangel", "pia": "PIA26369", "rmc": "54_0", "sols": [1178],
        "camera": "Mastcam-Z", "rover": "Perseverance",
        "title": "Perseverance Captures 'Bright Angel' in 360 Degrees",
        "link": "https://science.nasa.gov/photojournal/perseverance-captures-bright-angel-in-360-degrees/",
        "note": "346 images, colour enhanced by the Mastcam-Z team",
    }],
    "gale": [{
        "stop": "sajama", "pia": "PIA26696", "rmc": "120_82", "sols": [4714, 4741],
        "camera": "Mastcam (right, 100 mm)", "rover": "Curiosity",
        "title": "Curiosity Captures a 360-Degree View at 'Nevado Sajama'",
        "link": "https://science.nasa.gov/photojournal/curiosity-captures-a-360-degree-view-at-nevado-sajama/",
        "note": "1,031 images",
    }],
}.get(SITE, [])


# ---------------------------------------------------------------- terrain horizon
def terrain():
    """Heights as a function of local (x east, y north) metres: 1 m walk area, then the regional DTM."""
    dtm = ndi.gaussian_filter(np.load(os.path.join(RAW, "aoi_dtm_1m.npy")).astype(np.float64), 1.0)
    cell, half = 20.0, 9000.0
    n = int(2 * half / cell) + 1
    cx, cy = X0 + SIZE / 2, Y0 + SIZE / 2
    reg = np.full((n, n), np.nan, dtype=np.float32)
    with rasterio.open(os.path.join(RAW, CFG["region"]["dtm"])) as ds:
        reproject(rasterio.band(ds, 1), reg, dst_transform=from_origin(cx - half - cell / 2, cy + half + cell / 2, cell, cell),
                  dst_crs=ds.crs, resampling=Resampling.average if ds.res[0] < cell / 3 else Resampling.bilinear,
                  src_nodata=ds.nodata, dst_nodata=np.nan)
    reg[reg < -1e30] = np.nan

    def h(x, y):
        x = np.asarray(x, float)
        y = np.asarray(y, float)
        out = np.full(x.shape, np.nan)
        inside = (x >= 1) & (x <= SIZE - 2) & (y >= 1) & (y <= SIZE - 2)
        fx, fy = x[inside] - 0.5, SIZE - y[inside] - 0.5
        c, r = np.floor(fx).astype(int), np.floor(fy).astype(int)
        tx, ty = fx - c, fy - r
        out[inside] = ((dtm[r, c] * (1 - tx) + dtm[r, c + 1] * tx) * (1 - ty) + (dtm[r + 1, c] * (1 - tx) + dtm[r + 1, c + 1] * tx) * ty)
        o = ~inside
        gx = (X0 + x[o] - (cx - half)) / cell
        gy = ((cy + half) - (Y0 + y[o])) / cell
        ok = (gx >= 0) & (gx < n - 1) & (gy >= 0) & (gy < n - 1)
        vals = np.full(gx.shape, np.nan)
        vals[ok] = ndi.map_coordinates(reg, [gy[ok], gx[ok]], order=1, mode="nearest")
        out[o] = vals
        return out

    return h


def horizon(h, x0, y0, step_deg=0.25):
    """Elevation angle (deg) of the skyline seen from (x0, y0) at mast height, for azimuths 0..360."""
    az = np.radians(np.arange(0, 360, step_deg))
    d = np.concatenate([np.arange(3, 60, 1.0), np.geomspace(60, 9000, 900)])
    eye = h(np.array([x0]), np.array([y0]))[0] + MAST_M
    X = x0 + np.sin(az)[:, None] * d[None, :]
    Y = y0 + np.cos(az)[:, None] * d[None, :]
    z = h(X.ravel(), Y.ravel()).reshape(X.shape)
    z -= d[None, :] ** 2 / (2 * 3389500.0)                       # the planet curves away
    ang = np.degrees(np.arctan2(z - eye, d[None, :]))
    ang[~np.isfinite(ang)] = -90
    return np.degrees(az), ang.max(axis=1), eye


# ---------------------------------------------------------------- photo skyline
def load_small(path, width=3600):
    im = Image.open(path).convert("RGB")
    w, hh = im.size
    small = im.resize((width, round(hh * width / w)), Image.BOX)
    return np.asarray(small).astype(np.float32) / 255.0, (w, hh)


def skyline(img):
    """Row of the sky/ground boundary per column (nan where no sky is visible or the column is no-data)."""
    H, W, _ = img.shape
    lum = img.mean(axis=2)
    nodata = img.max(axis=2) < 0.035
    r, b = img[..., 0], img[..., 2]
    sky = ((b - r) > -0.02) & ~nodata & (lum > 0.25)             # Mars sky in these white-balanced mosaics is blue-grey
    sky = ndi.binary_opening(sky, np.ones((3, 3)))
    out = np.full(W, np.nan)
    for c in range(W):
        col_sky = sky[:, c]
        valid = ~nodata[:, c]
        if not valid.any():
            continue
        top = np.argmax(valid)
        if not col_sky[top:top + 6].any():
            continue                                             # mosaic starts below the skyline here
        # first ground row below a run of sky
        k = top
        while k < H and (col_sky[k] or nodata[k, c]):
            k += 1
        if k < H - 5 and not nodata[k:k + 4, c].any():
            out[c] = k
    # remove spikes (masts, rover hardware against the sky)
    good = np.isfinite(out)
    med = ndi.median_filter(np.where(good, out, np.nanmedian(out)), 25)
    out[good & (np.abs(out - med) > 8)] = np.nan
    return out


# ---------------------------------------------------------------- fit
def fit(sky_row, W, hz_az, hz_el, Himg):
    """Find the azimuth of column 0, the span and the level / tilt of the mosaic so that its skyline matches
    the terrain horizon.  The photo keeps its published proportions (same degrees per pixel both ways):
    only the pointing is fitted, so nothing is stretched."""
    cols = np.nonzero(np.isfinite(sky_row))[0]
    rows = sky_row[cols]

    def score(az0, span):
        s = span / W
        az = (az0 + cols * s) % 360
        y = np.interp(az, hz_az, hz_el, period=360) + s * rows          # = c0 + tilt(az)
        A = np.stack([np.ones_like(rows), np.sin(np.radians(az)), np.cos(np.radians(az))], axis=1)
        coef, *_ = np.linalg.lstsq(A, y, rcond=None)
        return float(np.median(np.abs(y - A @ coef))), coef

    best = min(((score(a, sp)[0], a, sp) for sp in np.arange(330, 381, 2.0) for a in np.arange(0, 360, 0.5)))
    _, az0, span = best
    best = min(((score(a % 360, sp)[0], a % 360, sp) for sp in np.arange(span - 2, span + 2.01, 0.25) for a in np.arange(az0 - 1, az0 + 1.01, 0.05)))
    err, az0, span = best
    _, (c0, ca, cb) = score(az0, span)
    s = span / W
    return {"err": err, "az0": float(az0), "degPerPx": float(s), "coef": [float(c0), float(s), float(ca), float(cb)], "n": int(len(cols))}


# ---------------------------------------------------------------- resample
def resample(path, full_size, fitp, Wsmall):
    """Equirectangular band (az 0..360, el EL_MAX..EL_MIN) from the photo, with gaps filled."""
    im = Image.open(path).convert("RGB")
    W0, H0 = full_size
    k = Wsmall / W0                                              # small-image px per full-image px
    W = pano_common.W
    Hh = pano_common.H
    # work at a resolution a little above the output's
    deg_per_full_px = fitp["degPerPx"] * k
    work_scale = min(1.0, deg_per_full_px * PX_PER_DEG * 1.5)          # full px -> work px: 1.5x the output's sampling
    Ww, Hw = max(1, round(W0 * work_scale)), max(1, round(H0 * work_scale))
    work = np.asarray(im.resize((Ww, Hw), Image.LANCZOS)).astype(np.float32) / 255.0
    to_work = work_scale / k                                     # small px -> work px

    az = (np.arange(W) + 0.5) / PX_PER_DEG
    el = EL_MAX - (np.arange(Hh) + 0.5) / PX_PER_DEG
    AZ, EL = np.meshgrid(az, el)
    c0, cs, ca, cb = fitp["coef"]                                # el = c0 - cs*row + ca sin(az) + cb cos(az)
    s = fitp["degPerPx"]
    col = ((AZ - fitp["az0"]) % 360) / s                         # small-image column
    tilt = ca * np.sin(np.radians(AZ)) + cb * np.cos(np.radians(AZ))
    row = (c0 + tilt - EL) / cs                                  # small-image row (near-linear in elevation)
    cw, rw = col * to_work, row * to_work
    inside = (cw >= 0) & (cw <= Ww - 1) & (rw >= 0) & (rw <= Hw - 1)
    pano = np.zeros((Hh, W, 3), np.float32)
    for ch in range(3):
        pano[..., ch][inside] = ndi.map_coordinates(work[..., ch], [rw[inside], cw[inside]], order=1)
    covered = inside & (pano.max(axis=2) > 0.035)
    covered = ndi.binary_erosion(covered, iterations=5)              # drop the dark fringe along the mosaic's edge
    return pano, covered


def main():
    if not PANOS:
        print("no NASA panoramas for", SITE)
        return 0
    wp = json.load(open(os.path.join(HERE, "raw", "M20_waypoints.json" if SITE == "jezero" else "MSL_waypoints.json")))["features"]
    by = {f["properties"]["RMC"]: f["properties"] for f in wp}
    h = terrain()
    path_json = os.path.join(OUT, "panoramas.json")
    data = json.load(open(path_json)) if os.path.exists(path_json) else {"source": "", "pxPerDeg": PX_PER_DEG, "panoramas": {}}
    os.makedirs(os.path.join(OUT, "panoramas"), exist_ok=True)
    for p in PANOS:
        w = by[p["rmc"]]
        x0, y0 = lonlat_to_local(w["lon"], w["lat"])
        hz_az, hz_el, eye = horizon(h, x0, y0)
        src = os.path.join(SRC, p["pia"] + ".jpg")
        small, full = load_small(src)
        sky = skyline(small)
        f = fit(sky, small.shape[1], hz_az, hz_el, small.shape[0])
        print(f"{p['stop']:12s} {p['pia']}  skyline cols {f['n']}  az0 {f['az0']:.2f}°  span {f['degPerPx'] * small.shape[1]:.1f}°  "
              f"top el {f['coef'][0]:.1f}°  tilt {math.hypot(f['coef'][2], f['coef'][3]):.2f}°  median err {f['err']:.2f}°")
        pano, covered = resample(src, full, f, small.shape[1])
        if DEBUG:
            dbg = (np.clip(pano, 0, 1) * 255).astype(np.uint8).copy()
            for i, a in enumerate((np.arange(360 * PX_PER_DEG) + 0.5) / PX_PER_DEG):
                r = int((EL_MAX - np.interp(a, hz_az, hz_el, period=360)) * PX_PER_DEG)
                if 0 <= r < dbg.shape[0]:
                    dbg[max(0, r - 1):r + 2, i] = (255, 40, 200)
            Image.fromarray(dbg).save(os.path.join(DEBUG, f"{p['stop']}_fit.jpg"), quality=85)
        out = pano_common.fill_sphere(pano, covered)
        files = pano_common.save_vr(out, os.path.join(OUT, "panoramas"), p["stop"])
        data["panoramas"][p["stop"]] = {
            **files,
            "frames": 0, "coverage": round(float(covered.mean()), 3), "horizonCoverage": 1.0,
            "sols": p["sols"], "camera": p["camera"], "rmc": p["rmc"],
            "nasa": {"pia": p["pia"], "title": p["title"], "link": p["link"], "note": p["note"],
                     "credit": "NASA/JPL-Caltech" + ("/ASU/MSSS" if p["rover"] == "Perseverance" else "/MSSS"),
                     "alignErrDeg": round(f["err"], 2)},
        }
    data.setdefault("pxPerDeg", PX_PER_DEG)
    if not data.get("source"):
        data["source"] = "NASA/JPL-Caltech Photojournal 360° panoramas, aligned by CAIRN to the HiRISE terrain"
    json.dump(data, open(path_json, "w"), indent=1)
    print("wrote", path_json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
