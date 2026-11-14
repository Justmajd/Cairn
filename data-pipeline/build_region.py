"""Build the regional terrain around the EVA area from the USGS Mars 2020 TRN CTX mosaics.

The HiRISE walk area (2 km) sits in the middle of a ~16 km square of CTX terrain (20 m DTM, 6 m image),
so the 3D view no longer ends at the edge of the data.

Seam handling
  * The region grid is aligned to the walk area: its cell size is SIZE / 100 = 20.48 m, so the walk-area
    border runs exactly along grid lines and the viewer can cut a clean hole for the HiRISE mesh.
  * Border vertices take the HiRISE height; the CTX-HiRISE height difference along the border is feathered
    out over FEATHER_M, so there is no step at the seam.
  * The CTX image is tone-matched to the HiRISE texture (quantile mapping over the overlap).

Outputs (web/public/data/<site>/): region.u16, region.jpg, region.json
"""
import os

import numpy as np
import rasterio
from PIL import Image
from rasterio.transform import from_origin
from rasterio.warp import Resampling, reproject
from scipy import ndimage as ndi

from common import CFG, OUT, RAW, SIZE, X0, Y0, write_json

INNER_CELLS = 100            # cells across the walk area
MARGIN_CELLS = CFG["region"]["margin_cells"]  # cells from the walk-area edge to the region edge
TEX_PX = 2688                # region image size (~6 m per pixel, CTX native)
FEATHER_M = 900.0


def main():
    cell = SIZE / INNER_CELLS
    n = INNER_CELLS + 2 * MARGIN_CELLS + 1
    rx0 = X0 - MARGIN_CELLS * cell
    ry0 = Y0 - MARGIN_CELLS * cell
    rsize = (n - 1) * cell

    # --- heights: CTX DTM sampled at the region nodes (node-registered grid, row 0 = north)
    with rasterio.open(os.path.join(RAW, CFG["region"]["dtm"])) as ds:
        crs = ds.crs
        heights = np.full((n, n), np.nan, dtype=np.float32)
        fine = ds.res[0] < cell / 3
        reproject(rasterio.band(ds, 1), heights,
                  dst_transform=from_origin(rx0 - cell / 2, ry0 + rsize + cell / 2, cell, cell),
                  dst_crs=crs, resampling=Resampling.average if fine else Resampling.bilinear,
                  src_nodata=ds.nodata, dst_nodata=np.nan)
    heights[heights < -1e30] = np.nan
    gaps = ~np.isfinite(heights)
    if gaps.any():                                         # e.g. the ragged edge of a HiRISE strip
        print(f"filling {gaps.mean() * 100:.1f}% of the region outside the source DTM")
        idx = ndi.distance_transform_edt(gaps, return_distances=False, return_indices=True)
        heights = heights[tuple(idx)]

    # --- HiRISE heights along the walk-area border, at the region's border nodes
    dtm = np.load(os.path.join(RAW, "aoi_dtm_1m.npy")).astype(np.float64)
    dtm_s = ndi.gaussian_filter(dtm, 2.0)

    def hirise(x, y):  # local metres -> bilinear height from the 1 m DTM (pixel-as-area)
        fx = np.clip(x - 0.5, 0, SIZE - 1.001)
        fy = np.clip(SIZE - y - 0.5, 0, SIZE - 1.001)
        c, r = np.floor(fx).astype(int), np.floor(fy).astype(int)
        tx, ty = fx - c, fy - r
        return ((dtm_s[r, c] * (1 - tx) + dtm_s[r, c + 1] * tx) * (1 - ty)
                + (dtm_s[r + 1, c] * (1 - tx) + dtm_s[r + 1, c + 1] * tx) * ty)

    i0, i1 = MARGIN_CELLS, MARGIN_CELLS + INNER_CELLS     # node indices of the walk-area border
    idx = np.arange(n)
    gx = rx0 + idx * cell - X0                            # local x of each column
    gy = (ry0 + rsize - idx * cell) - Y0                  # local y of each row
    border = []                                           # (local x, local y, hirise - ctx)
    for k in range(i0, i1 + 1):
        for (r, c) in ((i0, k), (i1, k), (k, i0), (k, i1)):
            hz = float(hirise(np.array(gx[c]), np.array(gy[r])))
            border.append((gx[c], gy[r], hz - heights[r, c]))
    border = np.array(border)
    print(f"HiRISE - CTX along the border: mean {border[:, 2].mean():+.2f} m, "
          f"p5 {np.percentile(border[:, 2], 5):+.2f}, p95 {np.percentile(border[:, 2], 95):+.2f}")

    # --- feather the difference outward: nearest border sample, fading over FEATHER_M
    X, Y = np.meshgrid(gx, gy)
    cx = np.clip(X, 0, SIZE)
    cy = np.clip(Y, 0, SIZE)
    dist = np.hypot(X - cx, Y - cy)
    # nearest border sample for every node (border is dense: one sample per region cell)
    from scipy.spatial import cKDTree
    tree = cKDTree(border[:, :2])
    _, nearest = tree.query(np.column_stack([cx.ravel(), cy.ravel()]))
    diff = ndi.gaussian_filter1d(border[:, 2], 2.0, mode="wrap")[nearest].reshape(n, n)
    w = np.clip(1 - dist / FEATHER_M, 0, 1)
    w = w * w * (3 - 2 * w)
    heights = heights + diff * w
    inside = (X >= -1e-6) & (X <= SIZE + 1e-6) & (Y >= -1e-6) & (Y <= SIZE + 1e-6)
    heights[inside] = hirise(X[inside], Y[inside])        # border (and hidden interior) = HiRISE

    z_min, z_max = float(np.floor(heights.min())), float(np.ceil(heights.max()))
    ((heights - z_min) / (z_max - z_min) * 65535).round().astype("<u2").tofile(os.path.join(OUT, "region.u16"))

    # --- image: CTX orthomosaic over the region, tone-matched to the HiRISE texture
    with rasterio.open(os.path.join(RAW, CFG["region"]["ortho"])) as ds:
        img = np.zeros((TEX_PX, TEX_PX), dtype=np.float32)
        reproject(rasterio.band(ds, 1), img, dst_transform=from_origin(rx0, ry0 + rsize, rsize / TEX_PX, rsize / TEX_PX),
                  dst_crs=crs, resampling=Resampling.average if ds.res[0] < rsize / TEX_PX / 2 else Resampling.cubic,
                  src_nodata=0, dst_nodata=0)
    if (img <= 0).any():                                   # outside the image footprint: nearest valid tone
        idx = ndi.distance_transform_edt(img <= 0, return_distances=False, return_indices=True)
        img = img[tuple(idx)]
    hi = np.asarray(Image.open(os.path.join(OUT, "texture.jpg")), dtype=np.float32)   # 4096 px over the walk area
    px = rsize / TEX_PX
    a0 = int(round(MARGIN_CELLS * cell / px))
    a1 = int(round((MARGIN_CELLS * cell + SIZE) / px))
    ctx_in = img[a0:a1, a0:a1]
    hi_in = np.asarray(Image.fromarray(hi).resize(ctx_in.shape[::-1], Image.BILINEAR), dtype=np.float32)
    q = np.linspace(0.5, 99.5, 100)
    mapped = np.interp(img, np.percentile(ctx_in, q), np.percentile(hi_in, q))
    Image.fromarray(np.clip(mapped, 0, 255).astype(np.uint8), "L").save(os.path.join(OUT, "region.jpg"), quality=88, optimize=True)

    write_json("region.json", {
        "source": CFG["region"].get("source", "USGS Mars 2020 TRN CTX DTM (20 m) and orthomosaic (6 m)"),
        "n": n, "cellM": cell, "sizeM": rsize,
        "originLocal": {"x": rx0 - X0, "y": ry0 - Y0},     # south-west corner, metres from the walk-area origin
        "inner": {"from": i0, "to": i1},                     # node index range of the walk area (both axes)
        "height": {"file": "region.u16", "zMin": z_min, "zMax": z_max},
        "texture": {"file": "region.jpg", "px": TEX_PX, "mPerPx": round(px, 3)},
    })
    print(f"region {rsize / 1000:.1f} km, {n}x{n} nodes at {cell} m, relief {z_max - z_min:.0f} m")


if __name__ == "__main__":
    main()
