"""Query the official Mars 2020 raw-image feed for images Perseverance took at the EVA stops.
Writes raw/images_index.json (metadata only).  build_rover.py picks from it and downloads the files."""
import json, os, time, urllib.parse, urllib.request
from common import RAW

API = "https://mars.nasa.gov/rss/api/"
# stop id -> (site, drives, sols)   — rover positions (RMC = site_drive) from the MMGIS waypoint layer
STOPS = {
    "rover":      (52, {2638, 2644}, range(1150, 1156)),
    "washburn":   (52, {5032}, range(1168, 1170)),
    "channel":    (52, {6980}, range(1171, 1174)),
    "cheyava":    (56, {0}, range(1210, 1219)),
    "serpentine": (56, {3368, 3438}, range(1230, 1244)),
}
CAMERAS = ["NAVCAM_LEFT", "MCZ_LEFT", "SHERLOC_WATSON", "FRONT_HAZCAM_LEFT_A"]


def query(sol, camera):
    """All images of one camera on one sol.  The feed returns the newest images of the whole
    mission when a sol has none, and repeats the last page — both are filtered out here."""
    out, seen = [], set()
    for page in range(8):
        q = urllib.parse.urlencode({"feed": "raw_images", "category": "mars2020", "feedtype": "json",
                                    "sol": sol, "num": 100, "page": page, "search": camera})
        req = urllib.request.Request(API + "?" + q, headers={"User-Agent": "Mozilla/5.0 (data-pipeline)"})
        d = None
        for attempt in range(4):
            try:
                d = json.load(urllib.request.urlopen(req, timeout=60)); break
            except Exception as e:
                print("retry", sol, camera, e); time.sleep(3)
        if not d or d.get("sol") != sol:
            break
        fresh = [im for im in d.get("images", []) if im.get("sol") == sol and im["imageid"] not in seen]
        if not fresh:
            break
        seen.update(im["imageid"] for im in fresh)
        out += fresh
        if len(d.get("images", [])) < 100:
            break
    return out


if __name__ == "__main__":
    index = {}
    for stop, (site, drives, sols) in STOPS.items():
        rows = []
        for sol in sols:
            for cam in CAMERAS:
                for im in query(sol, cam):
                    if im.get("site") != site or int(im.get("drive", -1)) not in drives:
                        continue
                    if im.get("sample_type") != "Full" or im["camera"]["instrument"] != cam:
                        continue
                    ext = im.get("extended", {})
                    dim = [int(v) for v in ext.get("dimension", "(0,0)").strip("()").split(",")]
                    rows.append({"id": im["imageid"], "sol": im["sol"], "camera": cam, "site": site,
                                 "drive": int(im["drive"]), "dim": dim,
                                 "mastAz": ext.get("mastAz"), "mastEl": ext.get("mastEl"),
                                 "url": im["image_files"]["large"], "link": im["link"],
                                 "utc": im["date_taken_utc"], "lmst": im["date_taken_mars"],
                                 "credit": im["credit"], "title": im["title"]})
        index[stop] = rows
        cams = {}
        for r in rows: cams[r["camera"]] = cams.get(r["camera"], 0) + 1
        print(stop, len(rows), cams, flush=True)
    json.dump(index, open(os.path.join(RAW, "images_index.json"), "w"), indent=1)
