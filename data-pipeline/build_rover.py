"""Build pois.json and rover.json: the EVA stops, Perseverance's real traverse through the AOI,
and the photographs the rover took at each stop (downloaded from the official raw-image feed)."""
import json
import os
import urllib.request

import numpy as np

from common import CFG, HERE, N, OUT, RAW, SITE, SIZE, in_aoi, local_to_node, lonlat_to_local, write_json

CAMERA_NAMES = {"NAVCAM_LEFT": "Navigation Camera (left)", "MCZ_LEFT": "Mastcam-Z (left)",
                "SHERLOC_WATSON": "SHERLOC WATSON close-up camera", "FRONT_HAZCAM_LEFT_A": "Front Hazard Camera",
                "MAHLI": "Mars Hand Lens Imager (MAHLI)"}
if CFG["rover"]["name"] == "Curiosity":
    CAMERA_NAMES["MCZ_LEFT"] = "Mastcam (left)"
WAYPOINTS = "M20_waypoints.json" if SITE == "jezero" else "MSL_waypoints.json"
STOPS = "stops.json" if SITE == "jezero" else f"stops_{SITE}.json"


def flattest_near(slope, x, y, radius_m=12):
    """Park the shelter on the flattest node within `radius_m` of the rover's real position."""
    c0, r0 = local_to_node(x, y)
    k = radius_m // CFG["cell_m"]
    best = min(((slope[r, c], c, r) for r in range(r0 - k, r0 + k + 1) for c in range(c0 - k, c0 + k + 1)
                if 0 <= r < N and 0 <= c < N), key=lambda t: t[0])
    return best[1] * CFG["cell_m"], SIZE - best[2] * CFG["cell_m"]


def download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (data-pipeline)"})
    with urllib.request.urlopen(req, timeout=90) as r, open(dest, "wb") as f:
        f.write(r.read())


def shrink(path, max_px=1200):
    """Full-resolution rover frames can be large: keep at most 1200 px, as JPEG."""
    from PIL import Image
    im = Image.open(path)
    if max(im.size) > max_px or im.format != "JPEG":
        im = im.convert("RGB")
        im.thumbnail((max_px, max_px))
        im.save(path, quality=88)


def main():
    way = json.load(open(os.path.join(RAW, WAYPOINTS)))["features"]
    by_rmc = {f["properties"]["RMC"]: f["properties"] for f in way}
    index = {r["id"]: r for rows in json.load(open(os.path.join(RAW, "images_index.json"))).values() for r in rows}
    cfg = json.load(open(os.path.join(HERE, "config", STOPS)))
    slope = np.fromfile(os.path.join(OUT, "slope.u8"), dtype=np.uint8).reshape(N, N)
    os.makedirs(os.path.join(OUT, "images"), exist_ok=True)

    pois = []
    for sid in cfg["order"]:
        s = cfg["stops"][sid]
        p = by_rmc[s["rmc"]]
        x, y = lonlat_to_local(p["lon"], p["lat"])
        p.setdefault("sol", int(s["sols"].split("–")[0]))
        if s["kind"] == "shelter":
            x, y = flattest_near(slope, x, y)
        images = []
        for iid in s["images"]:
            r = index[iid]
            fname = iid + ".jpg"
            download(r["url"], os.path.join(OUT, "images", fname))
            shrink(os.path.join(OUT, "images", fname))
            images.append({"id": iid, "file": "images/" + fname, "sol": r["sol"], "camera": r["camera"],
                           "cameraName": CAMERA_NAMES[r["camera"]], "lmst": r["lmst"], "utc": r["utc"],
                           "credit": r["credit"], "link": r["link"]})
        pois.append({"id": sid, "kind": s["kind"], "name": s["name"], "short": s["short"],
                     "x": round(x, 1), "y": round(y, 1), "rmc": s["rmc"], "sols": s["sols"],
                     "lon": round(p["lon"], 6), "lat": round(p["lat"], 6),
                     "description": s["description"], "science": s["science"], "whyHumans": s["whyHumans"],
                     "dwellMin": s["dwellMin"], "images": images})
        c, r = local_to_node(x, y)
        print(f"{sid:11s} x {x:7.1f} y {y:7.1f} slope {slope[r, c]:2d} deg  images {len(images)}")
    mission = CFG["rover"]["mission"]
    write_json("pois.json", {"source": f"Positions from the {mission} MMGIS waypoint layer; images from the {mission} raw-image feed",
                             "pois": pois})

    traverse, waypoints = [], []
    for f in way:
        p = f["properties"]
        x, y = lonlat_to_local(p["lon"], p["lat"])
        if in_aoi(x, y):
            traverse.append([round(x, 1), round(y, 1), p["sol"]])
            if (p.get("Note") or "").startswith("End-of-drive") or p.get("drive_type") == "final":
                waypoints.append({"sol": p["sol"], "rmc": p["RMC"], "x": round(x, 1), "y": round(y, 1),
                                  "note": p.get("Note") or ""})
    write_json("rover.json", {"source": f"{mission} MMGIS waypoint layer (mars.nasa.gov/mmgis-maps)", "rover": CFG["rover"]["name"],
                              "traverse": traverse, "waypoints": waypoints})
    print("traverse points in AOI:", len(traverse), "sols", traverse[0][2], "-", traverse[-1][2])


if __name__ == "__main__":
    main()
