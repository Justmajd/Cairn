"""Copy config/provenance.json to the web data folder after checking it is complete."""
import json
import os

from common import HERE, write_json

REQUIRED = ("id", "layer", "dataType", "mission", "instrument", "product", "provider", "url", "credit", "usedFor")

if __name__ == "__main__":
    doc = json.load(open(os.path.join(HERE, "config", "provenance.json")))
    for e in doc["entries"]:
        missing = [k for k in REQUIRED if not e.get(k)]
        assert not missing, f"{e.get('id')}: missing {missing}"
    write_json("provenance.json", doc)
