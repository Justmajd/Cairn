"""
Shared by build_panoramas.py (CAIRN's Navcam stitches) and build_nasa_panoramas.py (NASA's mosaics):
full-sphere equirectangular output ready for VR viewers.

* 8192 x 4096 px (22.76 px per degree), the native resolution of the sources (Navcam 1024 px / 45 deg,
  Sajama's Mastcam mosaic 8192 px / 341 deg; Bright Angel's Mastcam-Z mosaic is sharper and is resampled).
  A 4096 x 2048 copy for phones and GPUs that cannot hold an 8192 px texture.
* Column 0 = azimuth 0 (north), azimuth increasing to the right; row 0 = zenith, last row = nadir.
* Google Photo Sphere (GPano) XMP, so the files open as 360 photos in VR headsets and photo apps.
* What the cameras did not image is filled smoothly (sky from each column's own sky colour, ground from
  blurred neighbours, both poles blended to one colour so nothing pinches) and is never sharp.
"""
import io
import os

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

W, H = 8192, 4096
PX_PER_DEG = W / 360.0
EL = 90.0 - (np.arange(H) + 0.5) / PX_PER_DEG          # elevation of each row, degrees


def gpano_xmp(w, h):
    return (
        '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" '
        'GPano:ProjectionType="equirectangular" GPano:UsePanoramaViewer="True" '
        f'GPano:FullPanoWidthPixels="{w}" GPano:FullPanoHeightPixels="{h}" '
        f'GPano:CroppedAreaImageWidthPixels="{w}" GPano:CroppedAreaImageHeightPixels="{h}" '
        'GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0" '
        'GPano:PoseHeadingDegrees="180.0" GPano:InitialViewHeadingDegrees="180"/>'   # image centre faces south
        '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
    ).encode("utf-8")


def push_pull(img, w):
    """Smooth membrane fill of the pixels with weight 0 from those with weight 1 (no streaks)."""
    levels = []
    cur, cw = img * w[..., None], w.astype(np.float32)
    while min(cur.shape[:2]) > 4:
        levels.append((cur, cw))
        hh, ww = cur.shape[0] // 2 * 2, cur.shape[1] // 2 * 2
        cur = cur[:hh, :ww].reshape(hh // 2, 2, ww // 2, 2, 3).sum(axis=(1, 3))
        cw = cw[:hh, :ww].reshape(hh // 2, 2, ww // 2, 2).sum(axis=(1, 3))
    est = cur / np.maximum(cw, 1e-6)[..., None]
    for cur, cw in reversed(levels):
        up = np.asarray(Image.fromarray(np.clip(est * 255, 0, 255).astype(np.uint8)).resize((cur.shape[1], cur.shape[0]), Image.BILINEAR)).astype(np.float32) / 255
        mine = cur / np.maximum(cw, 1e-6)[..., None]
        a = np.clip(cw, 0, 1)[..., None]
        est = mine * a + up * (1 - a)
    return est


def fill_sphere(pano, covered, uniform_sky=False):
    """Fill a full-sphere panorama (H x W x 3, float 0..1) where `covered` is False.
    `uniform_sky`: one sky tone (median of the bright, smooth pixels where the frames saw sky) instead of
    each column's top colour — for mosaics whose frames often stop below the skyline (Navcam stitches)."""
    pano = pano.astype(np.float32, copy=True)
    covered = covered.copy()
    Hh, Ww, _ = pano.shape
    el = 90.0 - (np.arange(Hh) + 0.5) * 180.0 / Hh
    # 1. azimuth gap (columns that are almost empty): mirrored texture from both edges, cross-faded
    empty = covered.mean(axis=0) < 0.02
    if empty.any() and not empty.all():
        start = int(np.argmax(~empty))
        order = np.roll(np.arange(Ww), -start)
        e = empty[order]
        i = 0
        while i < Ww:
            if not e[i]:
                i += 1
                continue
            j = i
            while j < Ww and e[j]:
                j += 1
            g = j - i
            for k in range(g):
                t = (k + 1) / (g + 1)
                a = order[(i - 1 - k) % Ww]
                b = order[(j + (g - 1 - k)) % Ww]
                col = order[i + k]
                ca, cb = covered[:, a], covered[:, b]
                mix = pano[:, a] * (1 - t) + pano[:, b] * t
                pano[:, col] = np.where((ca & cb)[:, None], mix, np.where(ca[:, None], pano[:, a], pano[:, b]))
                covered[:, col] = ca | cb
            i = j
    # 2. sky: each column's top imaged colour, a little darker toward the zenith
    any_cov = covered.any(axis=0)
    top = np.where(any_cov, np.argmax(covered, axis=0), Hh // 2)
    tops = np.clip(top + 3, 0, Hh - 1)
    sky = np.stack([pano[np.clip(tops + d, 0, Hh - 1), np.arange(Ww)] for d in range(8)]).mean(axis=0)
    sky = ndi.uniform_filter1d(sky, 81, axis=0, mode="wrap")
    if uniform_sky:
        lum = pano.mean(axis=2)
        smooth = np.abs(ndi.uniform_filter(lum, 9) - lum) < 0.02          # sky is featureless
        upper = (el > 2)[:, None] & covered & smooth
        cand = pano[upper]
        if len(cand) > 500:
            l = cand.mean(axis=1)
            tone = np.median(cand[l >= np.percentile(l, 60)], axis=0)       # the bright part: sky, not cliffs
        else:
            tone = np.median(sky, axis=0)
        sky = np.repeat(tone[None, :], Ww, axis=0).astype(np.float32)
    rows = np.arange(Hh)[:, None]
    above = rows < top[None, :]
    k = np.clip((top[None, :] - rows) / np.maximum(top[None, :], 1), 0, 1)
    pano = np.where(above[..., None], sky[None, :, :] * (1 - 0.2 * k[..., None]), pano)
    covered = covered | above
    # 3. ground under the mosaic: smooth membrane from the imaged edge
    est = push_pull(np.where(covered[..., None], pano, 0), covered)
    est = ndi.gaussian_filter(est, (6, 6, 0))
    soft = np.clip(ndi.gaussian_filter(ndi.binary_erosion(covered, iterations=8).astype(np.float32), 6.0), 0, 1)[..., None]
    out = pano * soft + est * (1 - soft)          # ~8 px blend: no hard line where the imaged ground ends
    # 4. poles: blend to a single colour so the equirectangular columns do not pinch in a headset
    for lo, hi, ref in ((60.0, 88.0, 62.0), (-60.0, -88.0, -62.0)):
        rref = int(np.argmin(np.abs(el - ref)))
        mean = out[rref].mean(axis=0)
        t = np.clip((el - lo) / (hi - lo), 0, 1)[:, None, None]
        t = t * t * (3 - 2 * t)
        out = out * (1 - t) + mean[None, None, :] * t
    return np.clip(out, 0, 1)


def save_vr(pano, out_dir, sid):
    """Write <sid>_8k.jpg (8192 x 4096) and <sid>.jpg (4096 x 2048), both with Photo Sphere metadata."""
    img = Image.fromarray((np.clip(pano, 0, 1) * 255 + 0.5).astype(np.uint8))
    if img.size != (W, H):
        img = img.resize((W, H), Image.LANCZOS)
    hi = os.path.join(out_dir, f"{sid}_8k.jpg")
    img.save(hi, quality=88, optimize=True, progressive=True, xmp=gpano_xmp(W, H))
    lo = os.path.join(out_dir, f"{sid}.jpg")
    img.resize((W // 2, H // 2), Image.LANCZOS).save(lo, quality=88, optimize=True, progressive=True, xmp=gpano_xmp(W // 2, H // 2))
    return {"file": f"panoramas/{sid}.jpg", "fileHi": f"panoramas/{sid}_8k.jpg", "azMin": 0, "azMax": 360, "elMin": -90.0, "elMax": 90.0,
            "width": W, "height": H}
