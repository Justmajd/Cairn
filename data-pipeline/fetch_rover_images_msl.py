"""Query Curiosity's official raw-image feed for photos taken at the EVA stops of a site.
Writes <site raw>/images_index.json in the same schema as fetch_rover_images.py (Perseverance).

    CAIRN_SITE=gale .venv/bin/python fetch_rover_images_msl.py
"""
import json, os, time, urllib.parse, urllib.request
from common import HERE, RAW, SITE

API = "https://mars.nasa.gov/api/v1/raw_image_items/"
CAMERAS = {"NAV_LEFT_B": "NAVCAM_LEFT", "NAV_LEFT_A": "NAVCAM_LEFT", "MAST_LEFT": "MCZ_LEFT", "MAHLI": "MAHLI", "FHAZ_LEFT_B": "FRONT_HAZCAM_LEFT_A"}


def query(sol, instrument):
    out = []
    for page in range(10):
        q = urllib.parse.urlencode({"order": "sol desc", "per_page": 100, "page": page,
                                    "condition_1": "msl:mission", "condition_2": f"{sol}:sol:gte",
                                    "condition_3": f"{sol}:sol:lte", "condition_4": f"{instrument}:instrument:in"})
        for attempt in range(4):
            try:
                d = json.load(urllib.request.urlopen(urllib.request.Request(API + "?" + q, headers={"User-Agent": "cairn-data-pipeline"}), timeout=60))
                break
            except Exception as e:
                print("retry", sol, instrument, e); time.sleep(3)
        else:
            return out
        out += d.get("items", [])
        if not d.get("more"):
            break
    return out


if __name__ == "__main__":
    stops = json.load(open(os.path.join(HERE, "config", f"stops_{SITE}.json")))["stops"]
    index = {}
    for sid, s in stops.items():
        site, drive = (int(v) for v in s["rmc"].split("_"))
        rows = []
        for sol in range(s["solRange"][0], s["solRange"][1] + 1):
            for inst, cam in CAMERAS.items():
                for im in query(sol, inst):
                    # Mastcam / MAHLI products carry no site/drive: accept them on the sols the rover sat at this stop
                    if im.get("site") not in (None, "") and (int(im["site"]) != site or int(im.get("drive") or -1) != drive):
                        continue
                    if im.get("is_thumbnail") or "thumbnail" in (im.get("sample_type") or "").lower():
                        continue
                    ext = im.get("extended") or {}
                    if isinstance(ext, str):
                        ext = {}
                    rows.append({"id": im["imageid"], "sol": int(im["sol"]), "camera": cam, "instrument": inst,
                                 "site": site, "drive": drive, "subframe": im.get("subframe_rect"),
                                 "scale": im.get("scale_factor"), "mastAz": ext.get("mast_az"), "mastEl": ext.get("mast_el"),
                                 "url": im.get("https_url") or im.get("url"), "link": "https://mars.nasa.gov" + (im.get("link") or ""),
                                 "utc": im.get("date_taken"), "lmst": ext.get("lmst"), "credit": im.get("image_credit") or "NASA/JPL-Caltech",
                                 "title": im.get("title"), "cameraModel": im.get("camera_model_component_list"),
                                 "cameraModelType": im.get("camera_model_type"), "attitude": im.get("attitude")})
        index[sid] = rows
        cams = {}
        for r in rows: cams[r["instrument"]] = cams.get(r["instrument"], 0) + 1
        print(sid, len(rows), cams, flush=True)
    json.dump(index, open(os.path.join(RAW, "images_index.json"), "w"), indent=1)
