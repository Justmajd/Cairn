"""Build weather.json from Perseverance MEDA data for sol 1215 (the sol Cheyava Falls was sampled).
Source: PDS Atmospheres node, Mars 2020 MEDA — derived pressure (PS) and calibrated TIRS air/ground temperature."""
import csv
import os

import numpy as np

from common import RAW, write_json

SOL = 1215


def lmst_hours(s):                      # "01215M11:48:00.293" -> 11.80
    hh, mm, ss = s.split("M")[1].split(":")
    return int(hh) + int(mm) / 60 + float(ss) / 3600


def column(path, name, ok=lambda v: True):
    out = []
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            try:
                v = float(row[name])
            except (ValueError, KeyError):
                continue
            if ok(v):
                out.append((lmst_hours(row["LMST"]), v))
    return np.array(out)


def binned(series, step=0.25):
    rows = []
    for h in np.arange(0, 24, step):
        m = (series[:, 0] >= h) & (series[:, 0] < h + step)
        rows.append(round(float(np.median(series[m, 1])), 2) if m.sum() >= 5 else None)
    return rows


def rems(path):
    """Curiosity REMS MODRDR table: LMST (col 2), BRIGHTNESS_TEMP = ground (8), AMBIENT_TEMP = air (16), PRESSURE (38)."""
    cols = {"air": 15, "ground": 7, "pressure": 37}
    out = {k: [] for k in cols}
    with open(path, newline="") as f:
        for row in csv.reader(f, skipinitialspace=True):
            if len(row) < 38:
                continue
            h = lmst_hours(row[1].strip().strip('"'))
            for k, i in cols.items():
                v = float(row[i])
                lo, hi = {"air": (150, 320), "ground": (150, 330), "pressure": (400, 1200)}[k]
                if lo < v < hi:
                    out[k].append((h, v))
    return {k: np.array(v) for k, v in out.items()}


if __name__ == "__main__":
    from common import CFG, SITE
    if SITE == "jezero":
        ps = column(os.path.join(RAW, "meda_PS.csv"), "PRESSURE", lambda v: 400 < v < 1200)
        air = column(os.path.join(RAW, "meda_TIRScal.csv"), "AIR_TEMP", lambda v: 120 < v < 320)
        gnd = column(os.path.join(RAW, "meda_TIRScal.csv"), "GROUND_TEMP", lambda v: 120 < v < 340)
        source = "Mars 2020 MEDA, PDS Atmospheres node (derived PS, calibrated TIRS)"
        where = "Bright Angel, Neretva Vallis (rover parked at Cheyava Falls)"
        instrument = "Perseverance MEDA"
    else:
        import glob
        r = rems(glob.glob(os.path.join(RAW, "rems", "*RMD*.TAB"))[0])
        ps, air, gnd = r["pressure"], r["air"], r["ground"]
        SOL = CFG["eva"]["sol"]
        source = "MSL REMS calibrated environmental data (MODRDR), PDS Atmospheres node"
        where = "Boxwork, Mount Sharp (Curiosity at the main exposure)"
        instrument = "Curiosity REMS"
    write_json("weather.json", {
        "source": source, "instrument": instrument, "sol": SOL,
        "site": where,
        "stepH": 0.25,
        "pressurePa": binned(ps), "airTempK": binned(air), "groundTempK": binned(gnd),
        "range": {"pressurePa": [round(float(ps[:, 1].min()), 1), round(float(ps[:, 1].max()), 1)],
                  "airTempK": [round(float(air[:, 1].min()), 1), round(float(air[:, 1].max()), 1)],
                  "groundTempK": [round(float(gnd[:, 1].min()), 1), round(float(gnd[:, 1].max()), 1)]},
    })
    print("pressure", ps[:, 1].min(), ps[:, 1].max(), "air", air[:, 1].min(), air[:, 1].max(),
          "ground", gnd[:, 1].min(), gnd[:, 1].max())
