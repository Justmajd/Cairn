"""Build replay.json: the 20 May 2024 solar particle event as recorded by NASA.

Measured:  MSL/RAD dose rates (PDS PPI, MSL-M-RAD-3-RDR-V1.0, detector E = tissue-equivalent plastic).
           The archive holds ~2-4 h of dosimetry per sol, so the first ~13 h of the storm are NOT in it.
Reported:  NASA/JPL (10 Jun 2024): an astronaut next to Curiosity would have received 8,100 micrograys.
Modeled:   a two-component profile (fast spike + slow tail).  The tail is fitted to the RAD readings,
           the spike is scaled so the event total equals NASA's 8,100 uGy.  Always labeled as a model.
Alerts:    NASA CCMC DONKI — CME activity 2024-05-20T05:36:00-CME-001 and notification 20240520-AL-001.
"""
import datetime as dt
import glob
import json
import os
import re

import numpy as np

from common import RAW, write_json

NASA_TOTAL_UGY = 8100.0
CME_ID = "2024-05-20T05:36:00-CME-001"
ALERT_ID = "20240520-AL-001"
ONSET_UTC = dt.datetime(2024, 5, 20, 6, 0, 0)   # assumed particle onset at Mars (~25 min after CME start)
RISE_H, FAST_TAU_H, SLOW_RISE_H = 0.75, 2.0, 0.5


def parse_rad():
    rows = []
    for path in sorted(glob.glob(os.path.join(RAW, "rad", "*.TXT"))):
        text = open(path, errors="ignore").read()
        for blk in re.split(r"\n\[OBSERVATION: ", text)[1:]:
            t = re.search(r'START_OBS_UTC="(\d{4})-(\d{3}) (\d\d):(\d\d):(\d\d)"', blk)
            dur = re.search(r"OBS_DURATION=(\d+)", blk)
            e = re.search(r"\[DOSIMETRY_TOTAL_DOSE_E: \d+\]\s+([-\d.eE+]+)", blk)
            if not (t and dur and e):
                continue
            y, doy, hh, mm, ss = map(int, t.groups())
            when = dt.datetime(y, 1, 1) + dt.timedelta(days=doy - 1, hours=hh, minutes=mm, seconds=ss)
            if int(dur.group(1)) >= 480:   # drop truncated observations
                rows.append({"utc": when, "durS": int(dur.group(1)), "uGyH": float(e.group(1)),
                             "file": os.path.basename(path)})
    return sorted(rows, key=lambda r: r["utc"])


def fast(t, peak):
    return np.where(t < RISE_H, peak * t / RISE_H, peak * np.exp(-(t - RISE_H) / FAST_TAU_H))


def slow(t, amp, tau):
    return amp * np.exp(-t / tau) * (1 - np.exp(-t / SLOW_RISE_H))


def main():
    rad = parse_rad()
    pre = [r["uGyH"] for r in rad if r["utc"] < ONSET_UTC]
    base = float(np.median(pre))
    post = [r for r in rad if ONSET_UTC < r["utc"] < ONSET_UTC + dt.timedelta(hours=48)]
    th = np.array([(r["utc"] - ONSET_UTC).total_seconds() / 3600 for r in post])
    ex = np.array([r["uGyH"] - base for r in post])

    grid = np.linspace(0, 96, 96 * 60 + 1)       # 1-minute steps, hours since onset
    peak = 0.0
    for _ in range(30):                            # fit tail to RAD, then scale spike to NASA's total
        resid = np.clip(ex - fast(th, peak), 0.05, None)
        slope, icpt = np.polyfit(th, np.log(resid), 1)
        tau, amp = -1.0 / slope, float(np.exp(icpt))
        tail_total = float(np.trapezoid(slow(grid, amp, tau), grid))
        unit_total = float(np.trapezoid(fast(grid, 1.0), grid))
        peak = max(0.0, (NASA_TOTAL_UGY - tail_total) / unit_total)
    curve = fast(grid, peak) + slow(grid, amp, tau)
    total = float(np.trapezoid(curve, grid))
    fit_err = float(np.max(np.abs(fast(th, peak) + slow(th, amp, tau) - ex) / ex))
    print(f"baseline {base:.2f} uGy/h | tail amp {amp:.1f} tau {tau:.1f} h | spike peak {peak:.0f} uGy/h | "
          f"model total {total:.0f} uGy | max misfit vs RAD {fit_err * 100:.0f}%")

    cme = next(c for c in json.load(open(os.path.join(RAW, "donki_CME.json"))) if c["activityID"] == CME_ID)
    best = next((a for a in cme.get("cmeAnalyses") or [] if a.get("isMostAccurate")), {})
    note = next(n for n in json.load(open(os.path.join(RAW, "donki_notifications.json"))) if n["messageID"] == ALERT_ID)
    summary = note["messageBody"].split("## Summary:")[1].split("Links to the movies")[0]
    summary = re.sub(r"\s*\n\s*", " ", summary).strip()
    issued = dt.datetime.strptime(note["messageIssueTime"], "%Y-%m-%dT%H:%MZ")
    cme_start = dt.datetime.strptime(cme["startTime"], "%Y-%m-%dT%H:%MZ")

    keep = np.unique(np.concatenate([np.arange(0, 361, 2), np.arange(360, len(grid), 15)]))  # dense first 6 h
    write_json("replay.json", {
        "event": {
            "title": "20 May 2024 solar particle event",
            "summary": "A far-side X-class flare and a fast halo CME sent energetic particles to Mars. "
                       "Curiosity's RAD recorded its largest particle surge since landing.",
            "nasaReportedTotalUGy": NASA_TOTAL_UGY,
            "nasaStatement": "NASA/JPL, 10 June 2024: an astronaut standing next to Curiosity would have received "
                             "8,100 micrograys, comparable to 30 chest X-rays.",
            "assumedOnsetUtc": ONSET_UTC.isoformat() + "Z",
        },
        "donki": {
            "cme": {"activityID": cme["activityID"], "startTime": cme["startTime"], "link": cme.get("link"),
                    "speedKmS": best.get("speed"), "halfAngleDeg": best.get("halfAngle"), "type": best.get("type"),
                    "note": cme.get("note", "").strip()},
            "alert": {"messageID": note["messageID"], "issueTime": note["messageIssueTime"], "url": note["messageURL"],
                      "summary": summary,
                      "delayAfterCmeStartH": round((issued - cme_start).total_seconds() / 3600, 2)},
        },
        "rad": {
            "source": "MSL RAD RDR, PDS PPI node (MSL-M-RAD-3-RDR-V1.0), detector E dose rate",
            "baselineUGyH": round(base, 2),
            "measured": [{"utc": r["utc"].isoformat() + "Z", "durS": r["durS"], "uGyH": round(r["uGyH"], 2),
                          "hFromOnset": round((r["utc"] - ONSET_UTC).total_seconds() / 3600, 3)} for r in rad],
        },
        "model": {
            "label": "Modeled profile — not a measurement",
            "description": "Fast spike (linear rise, exponential decay) plus slow tail. The tail is fitted to the "
                           "RAD readings 13-43 h after onset; the spike is scaled so the event total above "
                           "background equals NASA's reported 8,100 micrograys.",
            "riseH": RISE_H, "fastTauH": FAST_TAU_H, "slowTauH": round(tau, 2), "slowAmpUGyH": round(amp, 1),
            "peakUGyH": round(float(curve.max()), 0), "totalUGy": round(total, 0),
            "curve": [[round(float(grid[i]), 4), round(float(curve[i]), 2)] for i in keep],  # [h, excess uGy/h]
        },
    })


if __name__ == "__main__":
    main()
