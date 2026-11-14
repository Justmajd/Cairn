"""Fetch the USGS SIM 3464 (Sun & Stack 2020) Jezero geologic map database and the THEMIS / HRSC
rasters bundled with it — only the needed members, via range requests.  Output: raw/sim3464/"""
import os
from remotezip import open_remote_zip

URL = "https://pubs.usgs.gov/sim/3464/sim3464_database.zip"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw", "sim3464")
WANT = (".gdb/", "CoordinateSystems/", "THEMIS_IR_controlled_mosaic", "Metadata/")

if __name__ == "__main__":
    z = open_remote_zip(URL)
    for info in z.infolist():
        fn = info.filename
        if fn.endswith("/") or "__MACOSX" in fn or not any(w in fn for w in WANT):
            continue
        dest = os.path.join(OUT, fn.split("sim3464_JezeroNili_FINAL/", 1)[1])
        if os.path.exists(dest) and os.path.getsize(dest) == info.file_size:
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with z.open(info) as src, open(dest, "wb") as dst:
            dst.write(src.read())
        print("got", dest[len(OUT) + 1:], info.file_size, flush=True)
