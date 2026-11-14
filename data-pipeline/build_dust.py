"""
Dust in the air, by sol, from the rovers' own measurements: the optical depth (tau) of the atmosphere,
from images of the Sun (mostly dust at 880 nm; water-ice cloud adds a little in some seasons).

  Perseverance (Jezero): Lemmon, M.T. "The Perseverance Rover's Mastcam-Z Visible Aerosol Optical Depth
      Record", Mendeley Data, DOI 10.17632/gktjp9jptb.1  -> raw/dust/m20-ztau-merged-1499.txt
  Curiosity (Gale): Lemmon, M.T. et al. (2024) "The Mars Science Laboratory Record of Optical Depth
      Measurements via Solar Imaging", NASA PDS, DOI 10.17189/fjh0-2978  -> raw/dust/msl_tau_880.csv
      (https://atmos.nmsu.edu/PDS/review/PDS4/msl_mmm_tau_bundle/data_derived/msl_tau_880.csv)

For each site: the whole record (daily means), and the dust for its EVA:
  - measured on the EVA sol when the record covers it (Jezero, sol 1215);
  - otherwise what the rover measured at the same season (Ls ± 7°) in the Mars years it covers
    (Gale: the record ends at sol 3953; Deuteronilus: no rover, Perseverance's record as a stand-in).

Writes web/public/data/<site>/dust.json and lists it in that site's files.json (offline use).
"""
import csv
import json
import math
import os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw", "dust")
DATA = os.path.normpath(os.path.join(HERE, "..", "web", "public", "data"))
SEASON_WINDOW = 7.0  # degrees of Ls either side

M20 = {
    "rover": "Perseverance", "instrument": "Mastcam-Z", "wavelengthNm": 880,
    "citation": "Lemmon, M.T. — The Perseverance Rover's Mastcam-Z Visible Aerosol Optical Depth Record (Mendeley Data, preliminary)",
    "doi": "10.17632/gktjp9jptb.1",
}
MSL = {
    "rover": "Curiosity", "instrument": "Mastcam", "wavelengthNm": 880,
    "citation": "Lemmon, M.T. et al. (2024) — The Mars Science Laboratory Record of Optical Depth Measurements via Solar Imaging (NASA PDS)",
    "doi": "10.17189/fjh0-2978",
}


def ls_at(utc_iso):
    """Areocentric solar longitude for a UTC time (Mars24, Allison & McEwen 2000), as eva/sun.ts."""
    from datetime import datetime, timezone
    t = datetime.fromisoformat(utc_iso.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp() * 1000
    jd_tt = 2440587.5 + t / 86400000 + 69.184 / 86400
    dt = jd_tt - 2451545.0
    m = math.radians(19.3871 + 0.52402073 * dt)
    alpha = 270.3871 + 0.524038496 * dt
    A = [0.0071, 0.0057, 0.0039, 0.0037, 0.0021, 0.002, 0.0018]
    tau = [2.2353, 2.7543, 1.1177, 15.7866, 2.1354, 2.4694, 32.8493]
    phi = [49.409, 168.173, 191.837, 21.736, 15.704, 95.528, 49.095]
    pbs = sum(A[i] * math.cos(math.radians((0.985626 * dt) / tau[i] + phi[i])) for i in range(7))
    nu = (10.691 + 3.0e-7 * dt) * math.sin(m) + 0.623 * math.sin(2 * m) + 0.05 * math.sin(3 * m) + 0.005 * math.sin(4 * m) + 0.0005 * math.sin(5 * m) + pbs
    return (alpha + nu) % 360


def read_m20():
    rows = []
    for line in open(os.path.join(RAW, "m20-ztau-merged-1499.txt")):
        p = [x.strip() for x in line.split(",")]
        # columns: eye, type, sol, (local time), SCLK, sequence, focal length, decimal sol, Ls, tau B G R I, ...
        # (one more column than the readme lists: the local time after the sol)
        if len(p) < 19 or p[0] not in ("L", "R", "B", "S"):
            continue
        try:
            sol, ls = float(p[7]), float(p[8])
            tau_r, tau_i = float(p[11]), float(p[12])
        except ValueError:
            continue
        tau = tau_i if tau_i >= 0 else tau_r  # 880 nm, or 630 nm where 880 was not validated
        if tau >= 0:
            rows.append((sol, ls, tau))
    return rows


def read_msl():
    rows = []
    for p in csv.reader(open(os.path.join(RAW, "msl_tau_880.csv"))):
        try:
            rows.append((float(p[1]), float(p[2]), float(p[3])))
        except (ValueError, IndexError):
            continue
    return rows


def daily(rows):
    by = defaultdict(list)
    for sol, ls, tau in rows:
        by[int(sol)].append((ls, tau))
    out = []
    for sol in sorted(by):
        v = by[sol]
        out.append([sol, round(sum(t for _, t in v) / len(v), 3), round(v[0][0], 1)])
    return out  # [sol, tau, Ls]


def mars_years(record):
    """Number each day's Mars year in the record (a new year where Ls wraps from ~360 to ~0)."""
    year, prev, out = 0, None, []
    for sol, tau, ls in record:
        if prev is not None and ls < prev - 180:
            year += 1
        prev = ls
        out.append(year)
    return out


def season(record, ls):
    years = mars_years(record)
    hits = [(r, y) for r, y in zip(record, years) if abs(((r[2] - ls + 180) % 360) - 180) <= SEASON_WINDOW]
    if not hits:
        return None
    taus = sorted(r[1] for r, _ in hits)
    return {"median": taus[len(taus) // 2], "min": taus[0], "max": taus[-1], "n": len(hits), "years": len({y for _, y in hits})}


def write(site_id, src, record, eva):
    path = os.path.join(DATA, site_id, "dust.json")
    doc = {**src, "record": record, "eva": eva,
           "note": "Optical depth tau: how much the dust (and some ice) dims the Sun. Daily means of the rover's measurements."}
    with open(path, "w") as f:
        json.dump(doc, f, separators=(",", ":"))
    files_path = os.path.join(DATA, site_id, "files.json")
    files = json.load(open(files_path))
    files["files"] = [e for e in files["files"] if e["path"] != "dust.json"] + [{"path": "dust.json", "bytes": os.path.getsize(path)}]
    files["files"].sort(key=lambda e: e["path"])
    files["totalBytes"] = sum(e["bytes"] for e in files["files"])
    with open(files_path, "w") as f:
        json.dump(files, f, indent=0)
    print(f"{site_id:13s} {os.path.getsize(path) / 1000:6.1f} kB  {len(record)} sols  EVA: {eva['how']} tau {eva['tau']}  ({eva['text']})")


def main():
    m20 = daily(read_m20())
    msl = daily(read_msl())
    for site_id in ("jezero", "gale", "deuteronilus"):
        meta = json.load(open(os.path.join(DATA, site_id, "site.json")))
        ev = meta.get("eva") or {}
        ls = ls_at(ev.get("utc", "2024-07-21T02:10:26Z"))
        sol = ev.get("sol")
        if site_id == "jezero":
            src, rec = M20, m20
        elif site_id == "gale":
            src, rec = MSL, msl
        else:
            src, rec = {**M20, "standIn": "No rover has been to Deuteronilus Mensae: Perseverance's record at Jezero (2,600 km away), same season."}, m20
        on_sol = [r for r in rec if sol is not None and abs(r[0] - sol) <= 1] if site_id != "deuteronilus" else []
        if on_sol:
            best = min(on_sol, key=lambda r: abs(r[0] - sol))
            eva = {"how": "measured", "sol": best[0], "ls": best[2], "tau": best[1],
                   "text": f"Measured by {src['rover']} on sol {best[0]}" + ("" if best[0] == sol else f", the nearest to the EVA's sol {sol}")}
        else:
            s = season(rec, ls)
            eva = {"how": "season", "ls": round(ls, 1), "tau": s["median"], "range": [s["min"], s["max"]], "n": s["n"], "years": s["years"],
                   "text": (f"{src['rover']}'s record ends at sol {rec[-1][0]}: " if site_id == "gale" else "") +
                           f"median of {s['n']} days at this season (Ls {ls:.0f}° ± {SEASON_WINDOW:.0f}°) over {s['years']} Mars years, range {s['min']}–{s['max']}"}
        write(site_id, src, rec, eva)


if __name__ == "__main__":
    main()
