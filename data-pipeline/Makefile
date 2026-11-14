# CAIRN data pipeline.  `make all` rebuilds every file in web/public/data/jezero from official sources.
PY = .venv/bin/python

.PHONY: all setup fetch build clean
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
	$(PY) build_site.py
	$(PY) build_region.py
	$(PY) build_rover.py
	$(PY) build_replay.py
	$(PY) build_weather.py
	$(PY) build_context.py
	$(PY) build_provenance.py

clean:
	rm -rf ../web/public/data/jezero
