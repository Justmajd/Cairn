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


if __name__ == "__main__":
    ps = column(os.path.join(RAW, "meda_PS.csv"), "PRESSURE", lambda v: 400 < v < 1200)
    air = column(os.path.join(RAW, "meda_TIRScal.csv"), "AIR_TEMP", lambda v: 120 < v < 320)
    gnd = column(os.path.join(RAW, "meda_TIRScal.csv"), "GROUND_TEMP", lambda v: 120 < v < 340)
    write_json("weather.json", {
        "source": "Mars 2020 MEDA, PDS Atmospheres node (derived PS, calibrated TIRS)", "sol": SOL,
        "site": "Bright Angel, Neretva Vallis (rover parked at Cheyava Falls)",
        "stepH": 0.25,
        "pressurePa": binned(ps), "airTempK": binned(air), "groundTempK": binned(gnd),
        "range": {"pressurePa": [round(float(ps[:, 1].min()), 1), round(float(ps[:, 1].max()), 1)],
                  "airTempK": [round(float(air[:, 1].min()), 1), round(float(air[:, 1].max()), 1)],
                  "groundTempK": [round(float(gnd[:, 1].min()), 1), round(float(gnd[:, 1].max()), 1)]},
    })
    print("pressure", ps[:, 1].min(), ps[:, 1].max(), "air", air[:, 1].min(), air[:, 1].max(),
          "ground", gnd[:, 1].min(), gnd[:, 1].max())
