"""Fetch the small official datasets: rover waypoints, DONKI space-weather records, Curiosity RAD
dosimetry, Perseverance MEDA weather and the Mars Trek global tiles.  Everything lands in raw/.

DONKI needs an api.nasa.gov key.  The public DEMO_KEY works but is rate-limited; set NASA_API_KEY
in the environment to use your own.
"""
import os
import re
import urllib.request

from common import CFG, RAW

UA = {"User-Agent": "Mozilla/5.0 (data-pipeline)"}
API_KEY = os.environ.get("NASA_API_KEY", "DEMO_KEY")

RAD_DIR = "https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/DATA/SOL_04134_04257/"
RAD_DAYS = ("139", "140", "141", "142", "143", "144")           # day-of-year 2024: 18-23 May
MEDA = "https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/"
MEDA_FILES = {
    "meda_PS.csv": "data_derived_env/sol_1140_1259/sol_1215/WE__1215___________DER_PS__________________P01.CSV",
    "meda_TIRScal.csv": "data_calibrated_env/sol_1140_1259/sol_1215/WE__1215___________CAL_TIRS________________P02.CSV",
    "meda_ATS.csv": "data_calibrated_env/sol_1140_1259/sol_1215/WE__1215___________CAL_ATS_________________P01.CSV",
}
TREK = "https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/"
DONKI = "https://api.nasa.gov/DONKI/{kind}?startDate=2024-05-19&endDate=2024-05-23&api_key=" + API_KEY


def get(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r, open(dest, "wb") as f:
        f.write(r.read())
    print("got", os.path.relpath(dest, RAW), os.path.getsize(dest))


if __name__ == "__main__":
    get(CFG["sources"]["m20_waypoints"], os.path.join(RAW, "M20_waypoints.json"))
    get(CFG["sources"]["m20_traverse"], os.path.join(RAW, "M20_traverse.json"))

    for kind in ("CME", "notifications"):
        get(DONKI.format(kind=kind), os.path.join(RAW, f"donki_{kind}.json"))

    listing = urllib.request.urlopen(urllib.request.Request(RAD_DIR, headers=UA), timeout=120).read().decode()
    for name in sorted(set(re.findall(r'href="(RAD_RDR_2024_(?:%s)_[^"]+\.(?:TXT|LBL))"' % "|".join(RAD_DAYS), listing))):
        get(RAD_DIR + name, os.path.join(RAW, "rad", name))

    for dest, path in MEDA_FILES.items():
        get(MEDA + path, os.path.join(RAW, dest))

    for row in range(4):                                           # WMTS level 2: 8 x 4 tiles
        for col in range(8):
            get(f"{TREK}2/{row}/{col}.jpg", os.path.join(RAW, "trek", f"2_{row}_{col}.jpg"))
