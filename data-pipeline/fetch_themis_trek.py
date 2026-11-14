"""
THEMIS night-time infrared for sites outside USGS SIM 3464 (e.g. Gale): the global THEMIS Night IR
controlled mosaic (100 m/px, v2 October 2018) from NASA Mars Trek's WMTS tiles, mosaicked over the walk
area plus a margin and written as a GeoTIFF in planetocentric longitude / latitude.

Output: <raw>/themis_night_trek.tif  (read by build_site.py when config layers.themis_source = "trek")
"""
import io
import math
import os
import sys
import time
import urllib.request

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_origin

from common import CFG, RAW, SIZE, X0, Y0, eqc_to_lonlat

LAYER = "THEMIS_NightIR_ControlledMosaics_100m_v2_oct2018"
URL = "https://trek.nasa.gov/tiles/Mars/EQ/" + LAYER + "/1.0.0/default/default028mm/{z}/{y}/{x}.png"
Z = 9                       # 180 / 2^9 / 256 = 0.00137 deg/px = 81 m: just finer than the 100 m mosaic
MARGIN_M = 3000
# Trek's tiles sit ~1 px east and south of the USGS SIM 3464 controlled mosaic of the same THEMIS data.
# Measured at Jezero, where both exist (correlation 0.88 as fetched, 0.996 after this shift); applied everywhere.
SHIFT_EAST_M, SHIFT_NORTH_M = -75.0, 84.0
OUT = os.path.join(RAW, "themis_night_trek.tif")


def fetch(z, y, x):
    for attempt in range(4):
        try:
            req = urllib.request.Request(URL.format(z=z, y=y, x=x), headers={"User-Agent": "Mozilla/5.0 (data-pipeline)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return np.asarray(Image.open(io.BytesIO(r.read())).convert("L"))
        except Exception as e:
            print("retry", z, y, x, e)
            time.sleep(3)
    raise RuntimeError(f"tile {z}/{y}/{x} failed")


def main(out=OUT):
    lons, lats = zip(*[eqc_to_lonlat(X0 + dx, Y0 + dy) for dx in (-MARGIN_M, SIZE + MARGIN_M) for dy in (-MARGIN_M, SIZE + MARGIN_M)])
    s = 180 / 2 ** Z
    x0, x1 = int((min(lons) + 180) // s), int((max(lons) + 180) // s)
    y0, y1 = int((90 - max(lats)) // s), int((90 - min(lats)) // s)
    rows = []
    for y in range(y0, y1 + 1):
        rows.append(np.concatenate([fetch(Z, y, x) for x in range(x0, x1 + 1)], axis=1))
    img = np.concatenate(rows, axis=0)
    px = s / 256
    m_per_deg = math.pi / 180 * CFG["mars_radius_m"]
    transform = from_origin(-180 + x0 * s + SHIFT_EAST_M / m_per_deg, 90 - y0 * s + SHIFT_NORTH_M / m_per_deg, px, px)
    crs = f"+proj=longlat +R={CFG['mars_radius_m']} +no_defs"
    with rasterio.open(out, "w", driver="GTiff", width=img.shape[1], height=img.shape[0], count=1, dtype="uint8",
                       crs=crs, transform=transform, compress="deflate") as ds:
        ds.write(img, 1)
    print(f"wrote {out}: {img.shape[1]} x {img.shape[0]} px, {(x1 - x0 + 1) * (y1 - y0 + 1)} tiles, "
          f"{px * math.pi / 180 * CFG['mars_radius_m']:.0f} m/px, values {img.min()}-{img.max()}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else OUT))
