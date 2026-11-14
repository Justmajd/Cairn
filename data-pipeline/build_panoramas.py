"""Stitch a 360-degree panorama at every EVA stop from the rover's own Navcam frames.

Each raw image in NASA's feed carries its CAHVOR(E) camera model (rover frame) and the rover's attitude
quaternion (rover -> site frame: X north, Y east, Z down).  For every panorama pixel (azimuth, elevation)
we build the viewing ray in the site frame, rotate it into the rover frame, project it through each
camera model, and blend the frames that see it (feathered at their edges, exposure-matched in overlaps).

Output (web/public/data/<site>/panoramas/): <stop>.jpg (equirectangular) and panoramas.json

    .venv/bin/python build_panoramas.py            # Jezero (Perseverance)
    CAIRN_SITE=gale .venv/bin/python build_panoramas.py   # Gale (Curiosity)
"""
import io
import json
import os
import time
import urllib.parse
import urllib.request

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

from common import CFG, HERE, OUT, RAW, SITE, write_json

import pano_common

# Stitch at the Navcam's native resolution (1024 px over 45 deg ~ 22.8 px/deg) in the band the frames
# cover, aligned to whole rows of the full-sphere VR image it is then placed in (see pano_common.py).
PX_PER_DEG = pano_common.PX_PER_DEG
BAND_TOP_ROW = round(55 * PX_PER_DEG)                # sphere row where the band starts (~35 deg up)
BAND_ROWS = round(90 * PX_PER_DEG)                   # ~90 deg of elevation
EL_MAX = 90.0 - BAND_TOP_ROW / PX_PER_DEG
EL_MIN = EL_MAX - BAND_ROWS / PX_PER_DEG
UA = {"User-Agent": "cairn-data-pipeline"}
CACHE = os.path.join(RAW, "pano_frames")


# ---------------------------------------------------------------- frame metadata
def m20_frames(sols, site, drive, camera="NAVCAM_LEFT"):
    out = []
    for sol in sols:
        for page in range(12):
            q = urllib.parse.urlencode({"feed": "raw_images", "category": "mars2020", "feedtype": "json", "sol": sol,
                                        "num": 100, "page": page, "search": camera})
            d = json.load(urllib.request.urlopen(urllib.request.Request("https://mars.nasa.gov/rss/api/?" + q, headers=UA), timeout=90))
            if d.get("sol") != sol:
                break
            imgs = [i for i in d.get("images", []) if i.get("sol") == sol]
            for im in imgs:
                ext = im.get("extended", {})
                cam = im.get("camera", {})
                if im.get("site") != site or int(im.get("drive", -1)) != drive or im.get("sample_type") != "Full":
                    continue
                if not im["imageid"][:3] in ("NLF", "NLG", "ZL0"):
                    continue
                dim = [int(v) for v in ext.get("dimension", "(0,0)").strip("()").split(",")]
                if dim[0] < 1000 or dim[1] < 200 or not cam.get("camera_model_component_list"):
                    continue
                out.append({"id": im["imageid"], "url": im["image_files"]["large"], "model": cam.get("camera_model_component_list"),
                            "type": cam.get("camera_model_type"), "attitude": im.get("attitude"),
                            "subframe": ext.get("subframeRect"), "scale": float(ext.get("scaleFactor", 1)), "dim": dim,
                            "az": float(ext.get("mastAz") or 0), "el": float(ext.get("mastEl") or 0), "sol": sol, "utc": im.get("date_taken_utc"),
                            "cam": "mcz" if camera.startswith("MCZ") else "nav"})
            if len(imgs) < 100:
                break
    return out


def msl_frames(sols, site, drive):
    rows = json.load(open(os.path.join(RAW, "images_index.json")))
    out = []
    for stop_rows in rows.values():
        for r in stop_rows:
            if r["instrument"] not in ("NAV_LEFT_B", "NAV_LEFT_A") or r["site"] != site or r["drive"] != drive:
                continue
            if r["sol"] not in sols or not r.get("cameraModel"):
                continue
            sf = [int(float(v)) for v in (r.get("subframe") or "(1,1,1024,1024)").strip("()").split(",")]
            if sf[2] < 1000 or sf[3] < 1000:
                continue
            out.append({"id": r["id"], "url": r["url"], "model": r["cameraModel"], "type": r.get("cameraModelType"),
                        "attitude": r["attitude"], "subframe": r.get("subframe"), "scale": float(r.get("scale") or 1),
                        "dim": [sf[2], sf[3]], "az": float(r.get("mastAz") or 0), "el": float(r.get("mastEl") or 0),
                        "sol": r["sol"], "utc": r.get("utc")})
    uniq = {f["id"]: f for f in out}
    return list(uniq.values())


# ---------------------------------------------------------------- geometry
def parse_vecs(s):
    parts = [p.strip().strip("()") for p in s.split(";")]
    vecs = [np.array([float(v) for v in p.split(",")]) for p in parts[:7] if "," in p]
    return vecs  # C, A, H, V, O, R, (E)


def quat_rotate(q, v):
    """Rotate vectors v (..., 3) by unit quaternion q = (s, x, y, z)."""
    s, u = q[0], np.asarray(q[1:])
    uv = np.cross(u, v)
    return v + 2 * s * uv + 2 * np.cross(u, uv)


def project(dirs, model):
    """CAHVOR projection of direction vectors (N, 3) in the camera-model frame -> (x, y, ok)."""
    C, A, H, V, O, R = model[:6]
    p = dirs * 1000.0                              # far field: parallax negligible
    zeta = p @ O
    lam = p - zeta[:, None] * O
    tau = np.einsum("ij,ij->i", lam, lam) / np.maximum(zeta * zeta, 1e-9)
    mu = R[0] + R[1] * tau + R[2] * tau * tau
    pp = p + mu[:, None] * lam
    a = pp @ A
    ok = (a > 1e-6) & (zeta > 0)
    a = np.where(ok, a, 1.0)
    return (pp @ H) / a, (pp @ V) / a, ok


def site_dirs(az_deg, el_deg):
    az, el = np.radians(az_deg), np.radians(el_deg)
    return np.stack([np.cos(el) * np.cos(az), np.cos(el) * np.sin(az), -np.sin(el)], axis=-1)  # X north, Y east, Z down


def frame_pointing(f, conj):
    """Elevation / azimuth of the camera boresight in the site frame for a quaternion convention."""
    q = np.array([float(v) for v in f["attitude"].strip("()").split(",")])
    if conj:
        q = q * np.array([1, -1, -1, -1])
    A = parse_vecs(f["model"])[1]
    a = quat_rotate(q, A)
    return np.degrees(np.arcsin(-a[2])), (np.degrees(np.arctan2(a[1], a[0])) + 360) % 360


# ---------------------------------------------------------------- stitching
def load_image(f):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f["id"] + ".jpg")
    if not os.path.exists(path):
        data = urllib.request.urlopen(urllib.request.Request(f["url"], headers=UA), timeout=90).read()
        open(path, "wb").write(data)
    im = Image.open(path).convert("RGB")
    return np.asarray(im, dtype=np.float32) / 255.0


CONE_DEG = 58 if SITE == "jezero" else 60
MIN_HORIZON = 0.85                             # publish a panorama only if Navcam imaged this share of the horizon      # Perseverance's wide Navcam: use the low-distortion centre only


def stitch(frames, conj):
    W = pano_common.W
    Hh = BAND_ROWS
    az = (np.arange(W) + 0.5) / PX_PER_DEG
    el = EL_MAX - (np.arange(Hh) + 0.5) / PX_PER_DEG
    AZ, EL = np.meshgrid(az, el)
    dirs_site = site_dirs(AZ, EL).reshape(-1, 3)

    samples = []
    for f in frames:
        img = load_image(f)
        h, w = img.shape[:2]
        model = parse_vecs(f["model"])
        q = np.array([float(v) for v in f["attitude"].strip("()").split(",")])
        if not conj:                       # site -> rover is the inverse of rover -> site
            q = q * np.array([1, -1, -1, -1])
        # boresight cone test first (cheap), then full projection
        A_site = quat_rotate(q * np.array([1, -1, -1, -1]), model[1])
        cone = 30 if f.get("cam") == "mcz" else CONE_DEG
        near = dirs_site @ A_site > np.cos(np.radians(cone))
        idx = np.nonzero(near)[0]
        d_rover = quat_rotate(q, dirs_site[idx])
        x, y, ok = project(d_rover, model)
        sf = [float(v) for v in (f.get("subframe") or f"(1,1,{f['dim'][0] * f['scale']},{f['dim'][1] * f['scale']})").strip("()").split(",")]
        ix = (x - (sf[0] - 1)) / f["scale"] * (w / f["dim"][0])
        iy = (y - (sf[1] - 1)) / f["scale"] * (h / f["dim"][1])
        ok &= (ix >= 0) & (ix <= w - 1) & (iy >= 0) & (iy <= h - 1)
        if ok.sum() < 500:
            continue
        idx, ix, iy = idx[ok], ix[ok], iy[ok]
        col = np.stack([ndi.map_coordinates(img[..., k], [iy, ix], order=1) for k in range(3)], axis=-1)
        edge = np.minimum.reduce([ix, w - 1 - ix, iy, h - 1 - iy]) / (0.18 * min(w, h))
        ang = np.degrees(np.arccos(np.clip(dirs_site[idx] @ A_site, -1, 1)))
        wgt = (np.clip(edge, 0, 1) ** 2 * np.clip((cone - ang) / 8, 0, 1) + 1e-4) * (3.0 if f.get("cam") == "mcz" else 1.0)
        samples.append((idx, col, wgt, f))

    # exposure matching: per-frame gain toward the blended result, two passes
    gains = np.ones(len(samples))
    for _ in range(3):
        acc = np.zeros((W * Hh, 3))
        wsum = np.zeros(W * Hh)
        for g, (idx, col, wgt, _) in zip(gains, samples):
            acc[idx] += col * g * wgt[:, None]
            wsum[idx] += wgt
        pano = acc / np.maximum(wsum, 1e-9)[:, None]
        for k, (idx, col, wgt, _) in enumerate(samples):
            lum_p = pano[idx].mean(axis=1)
            lum_f = col.mean(axis=1) * gains[k]
            m = (lum_f > 0.03) & (lum_p > 0.03)
            if m.sum() > 200:
                gains[k] *= np.clip(np.median(lum_p[m] / lum_f[m]), 0.6, 1.6)
    covered = wsum > 1e-3
    pano = pano.reshape(Hh, W, 3)
    covered = covered.reshape(Hh, W)

    lo, hi = np.percentile(pano[covered], [0.5, 99.6])
    pano = np.clip((pano - lo) / (hi - lo), 0, 1)
    stitch.raw = (pano.astype(np.float32), covered.copy())      # imaged pixels only, for the VR sphere
    pano = fill_gaps(pano, covered)
    col_any = covered.any(axis=0)
    bins = np.arange(col_any.size) * 72 // col_any.size                # 5-degree azimuth bins
    az_cov = np.bincount(bins, weights=col_any, minlength=72) / np.bincount(bins, minlength=72)
    horizon_row = int(EL_MAX * PX_PER_DEG)
    band = covered[max(0, horizon_row - int(3 * PX_PER_DEG)):horizon_row + int(3 * PX_PER_DEG)]
    stitch.horizon = float(band.any(axis=0).mean())
    return pano, covered.mean(), len(samples), [round(float(v), 2) for v in az_cov]


def fill_gaps(pano, covered):
    """Uncovered sky -> smooth gradient from the sky colour seen just above the horizon;
    uncovered ground (under the rover) -> blurred, darkened ground.  Marked as filled in panoramas.json."""
    Hh, W, _ = pano.shape
    rows = np.arange(Hh)[:, None]
    any_cov = covered.any(axis=0)
    horizon = int(EL_MAX * PX_PER_DEG)              # row of elevation 0
    top = np.where(any_cov, covered.argmax(axis=0), horizon)
    bot = np.where(any_cov, Hh - 1 - covered[::-1].argmax(axis=0), horizon)
    # one smooth fill line per edge (removes the staircase of individual frame edges)
    top = ndi.gaussian_filter1d(ndi.maximum_filter1d(top, int(20 * PX_PER_DEG), mode="wrap").astype(float), 3.3 * PX_PER_DEG, mode="wrap").astype(int) + 4
    bot = ndi.gaussian_filter1d(ndi.minimum_filter1d(bot, int(20 * PX_PER_DEG), mode="wrap").astype(float), 3.3 * PX_PER_DEG, mode="wrap").astype(int) - 4
    # sky colour: mean of the 8 covered rows below each column's top edge, smoothed around the horizon
    raw_top = np.where(any_cov, covered.argmax(axis=0), 0)
    raw_bot = np.where(any_cov, Hh - 1 - covered[::-1].argmax(axis=0), Hh - 1)
    sky = np.stack([pano[np.clip(raw_top + k, 0, Hh - 1), np.arange(W)] for k in range(2, 10)]).mean(axis=0)
    ground = np.stack([pano[np.clip(raw_bot - k, 0, Hh - 1), np.arange(W)] for k in range(2, 14)]).mean(axis=0)
    cols = np.arange(W)
    if any_cov.any() and not any_cov.all():          # columns never imaged: interpolate around the circle
        known = cols[any_cov]
        for arr in (sky, ground):
            for k in range(3):
                arr[:, k] = np.interp(cols, known, arr[known, k], period=W)
    sky = np.stack([ndi.gaussian_filter1d(sky[:, k], 5 * PX_PER_DEG, mode="wrap") for k in range(3)], axis=-1)
    ground = np.stack([ndi.gaussian_filter1d(ground[:, k], 3.3 * PX_PER_DEG, mode="wrap") for k in range(3)], axis=-1)
    up = np.clip((top[None, :] - rows) / max(1, Hh * 0.45), 0, 1)[..., None]       # 0 at the edge -> 1 high up
    sky_fill = sky[None, :, :] * (1 - 0.35 * up)                                    # darker toward the zenith
    down = np.clip((rows - bot[None, :]) / max(1, Hh * 0.2), 0, 1)[..., None]
    ground_fill = ground[None, :, :] * (0.85 - 0.35 * down)
    out = pano.copy()
    above = rows < top[None, :]
    below = rows > bot[None, :]
    empty = ~any_cov
    if empty.any():
        t = np.clip((rows - horizon) / (Hh * 0.08), -1, 1)[..., None] * 0.5 + 0.5
        mid = sky[None, :, :] * (1 - t) + ground[None, :, :] * t
        out[:, empty] = mid[:, empty]
    out[above] = sky_fill[above]
    out[below] = ground_fill[below]
    # feather the fill line over ~10 px
    mask = ndi.gaussian_filter((above | below).astype(np.float32), 5)[..., None]
    return np.clip(pano * (1 - mask) + out * mask, 0, 1)


def waypoint_yaw(rmc):
    name = "M20_waypoints.json" if SITE == "jezero" else "MSL_waypoints.json"
    for f in json.load(open(os.path.join(RAW, name)))["features"]:
        if f["properties"]["RMC"] == rmc:
            return float(f["properties"]["yaw"])
    return 0.0


def main():
    stops_file = "stops.json" if SITE == "jezero" else f"stops_{SITE}.json"
    stops = json.load(open(os.path.join(HERE, "config", stops_file)))["stops"]
    pois = {p["id"]: p for p in json.load(open(os.path.join(OUT, "pois.json")))["pois"]}
    os.makedirs(os.path.join(OUT, "panoramas"), exist_ok=True)
    result = {}
    conj = None
    for sid, s in stops.items():
        site, drive = (int(v) for v in s["rmc"].split("_"))
        if SITE == "jezero":
            lo, hi = (int(v) for v in s["sols"].replace("–", "-").split("-")) if "-" in s["sols"].replace("–", "-") else (int(s["sols"]),) * 2
            frames = m20_frames(range(lo, hi + 1), site, drive)
        else:
            lo, hi = s["solRange"]
            frames = msl_frames(range(lo, hi + 1), site, drive)
        # keep one frame per pointing (repeat pans exist)
        seen, uniq = set(), []
        for f in sorted(frames, key=lambda f: (-f["dim"][1], f["sol"])):     # full frames before strips
            b = 2.5 if f.get("cam") == "mcz" else 6
            key = (f.get("cam"), round(f["az"] / b), round(f["el"] / b))
            if key not in seen:
                seen.add(key)
                uniq.append(f)
        frames = uniq
        if len(frames) < 4:
            print(sid, "too few frames:", len(frames))
            continue
        if conj is None:                   # pick the quaternion convention that reproduces rover heading + mast azimuth
            yaw = waypoint_yaw(s["rmc"])
            def az_err(c):
                d = [((frame_pointing(f, c)[1] - (f["az"] + yaw)) + 180) % 360 - 180 for f in frames]
                return float(np.mean(np.abs(d)))
            err = {c: az_err(c) for c in (False, True)}
            conj = min(err, key=err.get)
            print("quaternion convention", "conjugate" if conj else "as given", {k: round(v, 2) for k, v in err.items()})
        t0 = time.time()
        pano, cover, used, az_cov = stitch(frames, conj)
        if stitch.horizon < MIN_HORIZON:
            print(f"{sid:10s} skipped: Navcam frames cover only {stitch.horizon * 100:.0f}% of the horizon")
            for stale in (f"{sid}.jpg", f"{sid}_8k.jpg"):
                if os.path.exists(os.path.join(OUT, "panoramas", stale)):
                    os.remove(os.path.join(OUT, "panoramas", stale))
            continue
        # place the band in the full sphere and fill above / below it (VR-ready, see pano_common.py)
        raw, cov = stitch.raw
        sphere = np.zeros((pano_common.H, pano_common.W, 3), np.float32)
        sphere[BAND_TOP_ROW:BAND_TOP_ROW + BAND_ROWS] = raw
        band = np.zeros((pano_common.H, pano_common.W), bool)
        band[BAND_TOP_ROW:BAND_TOP_ROW + BAND_ROWS] = ndi.binary_erosion(cov, iterations=2)
        filled = pano_common.fill_sphere(sphere, band, uniform_sky=True)
        files = pano_common.save_vr(filled, os.path.join(OUT, "panoramas"), sid)
        sols = sorted({f["sol"] for f in frames})
        cams = sorted({"Mastcam-Z (left)" if f.get("cam") == "mcz" else "Navcam (left)" for f in frames})
        result[sid] = {**files,
                       "frames": used, "coverage": round(float(cover), 3), "sols": sols, "camera": " + ".join(cams),
                       "rmc": s["rmc"], "horizonCoverage": round(stitch.horizon, 3), "azCoverage5deg": az_cov, "frameIds": [f["id"] for f in frames]}
        print(f"{sid:10s} {used:2d} frames, {cover * 100:.0f}% covered, sols {sols[0]}-{sols[-1]}, {time.time() - t0:.0f}s")
    write_json("panoramas.json", {"source": f"Stitched by CAIRN from {CFG['rover']['name']} Navcam raw images using their CAHVOR(E) camera models",
                                  "pxPerDeg": PX_PER_DEG, "panoramas": result})


if __name__ == "__main__":
    main()
