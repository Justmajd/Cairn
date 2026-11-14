"""Fetch only the AOI window of the USGS Mars 2020 TRN HiRISE DTM + orthomosaic
(HTTP range requests through GDAL /vsicurl), plus the full CTX regional mosaics.

Outputs (git-ignored): raw/aoi_dtm_1m.npy, raw/aoi_ortho_25cm.npy, raw/ctx_dtm.tif, raw/ctx_ortho.tif
"""
import json, os, sys, time, urllib.request
import numpy as np
import rasterio
from rasterio.windows import Window

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = json.load(open(os.path.join(HERE, "config", "jezero.json")))
RAW = os.path.join(HERE, "raw")
os.makedirs(RAW, exist_ok=True)
ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GTIFF_DIRECT_IO="YES",
           GDAL_HTTP_MAX_RETRY="5", GDAL_HTTP_RETRY_DELAY="2")


def read_window(url, x0, y0, size_m, out_path, chunk_rows):
    """Read one AOI window. Resumable: rows already fetched are kept in <out>.part.npy
    and the next run continues from <out>.rows (number of rows done)."""
    if os.path.exists(out_path):
        print("exists", out_path); return
    part, marker = out_path + ".part.npy", out_path + ".rows"
    src = "/vsicurl/" + url
    with rasterio.Env(**ENV):
        with rasterio.open(src) as ds:
            res = ds.res[0]
            col0 = round((x0 - ds.bounds.left) / res)
            row0 = round((ds.bounds.top - (y0 + size_m)) / res)
            n = round(size_m / res)
            dtype = ds.dtypes[0]
            assert 0 <= col0 and col0 + n <= ds.width and 0 <= row0 and row0 + n <= ds.height, "AOI outside raster"
        done = int(open(marker).read()) if os.path.exists(marker) and os.path.exists(part) else 0
        mode = "r+" if done else "w+"
        out = np.lib.format.open_memmap(part, mode=mode, dtype=dtype, shape=(n, n))
        t0 = time.time()
        r = done
        while r < n:
            h = min(chunk_rows, n - r)
            for attempt in range(30):
                try:
                    with rasterio.open(src) as ds:  # reopen so a dropped connection is not reused
                        out[r:r + h] = ds.read(1, window=Window(col0, row0 + r, n, h))
                    break
                except Exception as e:  # network hiccup: wait and retry
                    print("retry", r, attempt, str(e)[:120], flush=True); time.sleep(min(60, 5 * (attempt + 1)))
            else:
                raise RuntimeError("failed rows %d" % r)
            r += h
            out.flush()
            with open(marker, "w") as f:
                f.write(str(r))
            print(f"  {os.path.basename(out_path)} rows {r}/{n} ({time.time() - t0:.0f}s)", flush=True)
        del out
        os.replace(part, out_path)
        os.remove(marker)
        print("saved", out_path)


def download(url, out_path):
    if os.path.exists(out_path):
        print("exists", out_path); return
    print("downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (data-pipeline)"})
    with urllib.request.urlopen(req) as r, open(out_path + ".part", "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(out_path + ".part", out_path)


if __name__ == "__main__":
    a, s = CFG["aoi"], CFG["sources"]
    download(s["ctx_dtm"], os.path.join(RAW, "ctx_dtm.tif"))
    download(s["ctx_ortho"], os.path.join(RAW, "ctx_ortho.tif"))
    read_window(s["hirise_dtm"], a["x0"], a["y0"], a["size_m"], os.path.join(RAW, "aoi_dtm_1m.npy"), 128)
    read_window(s["hirise_ortho"], a["x0"], a["y0"], a["size_m"], os.path.join(RAW, "aoi_ortho_25cm.npy"), 256)
