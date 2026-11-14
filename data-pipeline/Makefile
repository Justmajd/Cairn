# CAIRN data pipeline.  `make all` rebuilds every file in web/public/data/jezero from official sources.
PY = .venv/bin/python

.PHONY: all setup fetch build gale deuteronilus clean
all: fetch build

setup:
	python3 -m venv .venv
	$(PY) -m pip install -q -r requirements.txt

fetch:
	$(PY) fetch_terrain.py
	$(PY) fetch_geology.py
	$(PY) fetch_misc.py
	$(PY) fetch_rover_images.py

build:
	$(PY) build_minerals.py
	$(PY) build_site.py
	$(PY) build_region.py
	$(PY) build_rover.py
	$(PY) build_replay.py
	$(PY) build_weather.py
	$(PY) build_context.py
	$(PY) build_provenance.py
	$(PY) build_panoramas.py
	$(PY) pack_web.py

# Gale Crater (Curiosity): download the HiRISE DTM + orthoimages listed in config/gale.json into raw/gale first
gale:
	CAIRN_SITE=gale $(PY) prepare_hirise.py
	CAIRN_SITE=gale $(PY) fetch_rover_images_msl.py
	CAIRN_SITE=gale $(PY) build_site.py
	CAIRN_SITE=gale $(PY) build_region.py
	CAIRN_SITE=gale $(PY) build_rover.py
	CAIRN_SITE=gale $(PY) build_replay.py
	CAIRN_SITE=gale $(PY) build_weather.py
	CAIRN_SITE=gale $(PY) build_context.py
	CAIRN_SITE=gale $(PY) build_provenance.py
	CAIRN_SITE=gale $(PY) build_panoramas.py
	CAIRN_SITE=gale $(PY) pack_web.py

# Deuteronilus Mensae (no rover): download the HiRISE DTM + orthoimages listed in config/deuteronilus.json
# into raw/deuteronilus first.  No rover photos, traverse, weather or panoramas.
deuteronilus:
	CAIRN_SITE=deuteronilus $(PY) prepare_hirise.py
	CAIRN_SITE=deuteronilus $(PY) build_site.py
	CAIRN_SITE=deuteronilus $(PY) build_region.py
	CAIRN_SITE=deuteronilus $(PY) build_rover.py
	CAIRN_SITE=deuteronilus $(PY) build_replay.py
	CAIRN_SITE=deuteronilus $(PY) build_context.py
	CAIRN_SITE=deuteronilus $(PY) build_provenance.py
	CAIRN_SITE=deuteronilus $(PY) pack_web.py

clean:
	rm -rf ../web/public/data/jezero
