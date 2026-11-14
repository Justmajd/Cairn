"""Shared helpers for the CAIRN data pipeline: config, paths and coordinate conversion.

Coordinate systems
  eqc    : Equirectangular on the Mars 2000 sphere (R = 3,396,190 m), lat_ts = 0, metres; x = R*(lon - lon0), y = R*lat.
           lon0 = 0 for Jezero (USGS Mars 2020 TRN mosaics), 137.38 for Gale (HiRISE DTM DTEEC_019698_1750_019988_1750).
  local  : meters from the AOI south-west corner.  x = east, y = north.
  grid   : node (col, row) on the (N x N) routing/mesh grid.  row 0 is the NORTH edge.
"""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.environ.get("CAIRN_SITE", "jezero")          # which site to build: config/<site>.json
CFG = json.load(open(os.path.join(HERE, "config", f"{SITE}.json")))
RAW = os.path.join(HERE, CFG.get("raw", "raw"))        # site-specific downloads
SHARED = os.path.join(HERE, "raw")                     # downloads shared by all sites (RAD, DONKI, Mars Trek)
LON0 = CFG.get("proj", {}).get("lon0", 0.0)            # central meridian of the site's equirectangular projection
OUT = os.path.normpath(os.path.join(HERE, "..", "web", "public", "data", CFG["id"]))

R_MARS = CFG["mars_radius_m"]
X0 = CFG["aoi"]["x0"]
Y0 = CFG["aoi"]["y0"]
SIZE = CFG["aoi"]["size_m"]
CELL = CFG["cell_m"]
N = SIZE // CELL + 1  # nodes per side


def lonlat_to_eqc(lon_deg, lat_deg):
    return R_MARS * math.radians(lon_deg - LON0), R_MARS * math.radians(lat_deg)


def eqc_to_lonlat(x, y):
    return math.degrees(x / R_MARS) + LON0, math.degrees(y / R_MARS)


def eqc_to_local(x, y):
    return x - X0, y - Y0


def lonlat_to_local(lon_deg, lat_deg):
    return eqc_to_local(*lonlat_to_eqc(lon_deg, lat_deg))


def local_to_node(x, y):
    return int(round(x / CELL)), int(round((SIZE - y) / CELL))


def in_aoi(x, y, margin=0.0):
    return margin <= x <= SIZE - margin and margin <= y <= SIZE - margin


def write_json(name, obj):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    with open(path, "w") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
    print("wrote", os.path.relpath(path, HERE), os.path.getsize(path), "bytes")
