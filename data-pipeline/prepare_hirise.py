"""Cut the walk area out of a downloaded HiRISE DTM + orthoimage pair (PDS products from uahirise.org).

Used for sites outside the USGS Mars 2020 TRN mosaics (Gale).  Writes, in the site's raw folder:
  aoi_dtm_1m.npy      SIZE x SIZE, exactly 1 m/post, float32
  aoi_ortho_25cm.npy  4*SIZE x 4*SIZE, exactly 0.25 m/px, uint8

    CAIRN_SITE=gale .venv/bin/python prepare_hirise.py
"""
import os
import time

import numpy as np
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from rasterio.windows import from_bounds

from common import CFG, RAW, SIZE, X0, Y0


def cut(src_path, px, dtype, resampling, out_path, nodata_fill=None):
    if os.path.exists(out_path):
        print("exists", out_path)
        return
    t0 = time.time()
    n = int(round(SIZE / px))
    dst = np.zeros((n, n), dtype=np.float32)
    with rasterio.open(src_path) as ds:
        pad = 8 * ds.res[0]
        win = from_bounds(X0 - pad, Y0 - pad, X0 + SIZE + pad, Y0 + SIZE + pad, ds.transform).round_offsets().round_lengths()
        src = ds.read(1, window=win).astype(np.float32)
        if ds.nodata is not None:
            src[src == np.float32(ds.nodata)] = np.nan
        src[src < -1e30] = np.nan
        reproject(src, dst, src_transform=ds.window_transform(win), src_crs=ds.crs,
                  dst_transform=from_origin(X0, Y0 + SIZE, px, px), dst_crs=ds.crs,
                  resampling=resampling, src_nodata=np.nan, dst_nodata=np.nan)
    bad = ~np.isfinite(dst)
    if bad.any():
        print(f"  filling {bad.mean() * 100:.3f}% gaps")
        fill = nodata_fill if nodata_fill is not None else float(np.nanmedian(dst))
        dst[bad] = fill
    np.save(out_path, dst.astype(dtype))
    print(f"saved {os.path.basename(out_path)} {dst.shape} {dtype.__name__} in {time.time() - t0:.0f}s "
          f"range {np.nanmin(dst):.1f}..{np.nanmax(dst):.1f}")


if __name__ == "__main__":
    s = CFG["sources"]
    cut(os.path.join(RAW, s["hirise_dtm"]), 1.0, np.float32, Resampling.bilinear, os.path.join(RAW, "aoi_dtm_1m.npy"))
    cut(os.path.join(RAW, s["hirise_ortho"]), 0.25, np.uint8, Resampling.bilinear, os.path.join(RAW, "aoi_ortho_25cm.npy"))
