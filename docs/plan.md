# CAIRN — Project Plan

> Companion to [introduction.md](introduction.md). That file explains **what** CAIRN is and **why**. This file explains **how** we build it and **when**.

---

## 0. Key Facts & Dates

| Item | Value |
|---|---|
| Event | 2026 NASA Space Apps Challenge — *Interplanetary Survival Guide: Martian Map* |
| Hackathon | **Sat Nov 14 – Sun Nov 15, 2026** |
| Submission window | Opens **Sat Nov 14, 09:00**, closes **Sun Nov 15, 23:59** (local time) |
| Challenge resources released | **Fri Nov 13** |
| Max team size | 6 |
| Repo | `github.com/Justmajd/cairn-demo` (private — make public before submitting) |
| Target site | Jezero Crater — Cheyava Falls (Neretva Vallis) + Three Forks sample depot |

> **Rule check:** confirm what Space Apps allows before the event starts. If writing code before Nov 14 isn't allowed, limit the pre-hackathon phase (Section 13.1) to research, data downloads, design and planning.

---

## 1. Scope

### 1.1 MVP — must ship (the three-act demo depends on these)

1. 3D terrain of the EVA area from a **real HiRISE elevation model**, textured with real HiRISE imagery.
2. Traversability **cost grid** built from slope + rock abundance + hazard mask.
3. **A\* route** between rover staging point and objectives; **straight-line vs safe route** comparison.
4. **EVA budget**: distance, time, O₂ use, walk-back margin, radiation dose.
5. **Walk mode**: camera at eye height walks the route; Perseverance photos appear at waypoints.
6. **Event replay**: May 20, 2024 solar particle event → DONKI alert → instant re-route to shelter → "dose avoided".
7. **Data provenance panel**: every layer names its mission, instrument and dataset.

### 1.2 Should have

- Layer toggles: slope, rock abundance (THEMIS), minerals (CRISM), geology (USGS).
- **Walk-back envelope**: a contour on the map showing how far the astronaut can go and still return safely.
- Elevation profile chart along the route.
- Regional context map (zoom from all of Mars to Jezero) using Mars Trek tiles.
- MEDA weather readouts.

### 1.3 Could have (stretch)

- Buddy mode (two astronauts, max-separation rule).
- Visor/HUD full-screen mode with heading tape.
- "Why humans" callouts at the outcrop.
- Tablet layout.

### 1.4 Won't do in the hackathon

- Live real-time data from Mars (no such feed exists — we use recorded mission data).
- Multiple sites or the site generator (post-hackathon).
- Accounts, backend, database.

---

## 2. System Architecture

### 2.1 Overview

Everything heavy is done **offline** in a Python pipeline. The web app is **fully static** — it loads preprocessed files, so the demo works with no internet at the venue.

```
                 ┌──────────────────────── data-pipeline/ (Python) ───────────────────────┐
 Official        │  fetch_*.py      download raw datasets → data-pipeline/raw/ (git-ignored)│
 NASA/USGS  ───► │  build_aoi.py    crop + reproject everything to one local grid          │
 sources         │  build_cost.py   slope + rocks + hazards → cost grid                    │
                 │  build_assets.py heightmap PNG, texture, overlays, JSON indexes         │
                 └─────────────────────────────────┬───────────────────────────────────────┘
                                                   │ writes to web/public/data/jezero/
                                                   ▼
 ┌──────────────────────────────────── web/ (Vite + TypeScript) ───────────────────────────────────┐
 │                                                                                                 │
 │  app state (store) ──────────────┬───────────────────────┬────────────────────┬───────────────┐ │
 │        ▲                          ▼                       ▼                    ▼               │ │
 │        │                  Scene (Three.js)         Panels (DOM/SVG)     Context map           │ │
 │        │                  • terrain mesh           • objectives          (OpenLayers +         │ │
 │        │                  • top-down "2D" cam      • layers               Mars Trek tiles)     │ │
 │        │                  • orbit / fly-through    • EVA budget                                │ │
 │        │                  • first-person walk      • elevation profile                         │ │
 │        │                  • routes, overlays       • provenance                                │ │
 │        │                                           • alerts / replay timeline                  │ │
 │        │                                                                                       │ │
 │  Routing worker (Web Worker): A*, return-cost field, re-plan  ◄── messages ──► store           │ │
 │  EVA model (pure TS): energy, O₂, time, dose                                                   │ │
 │  Replay engine: drives the clock, fires DONKI/RAD events                                      │ │
 └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Key design decision: one renderer for 2D and 3D

The "2D planner" is the **same Three.js scene seen from directly above** with an orthographic camera. Switching to 3D is just a camera animation (top-down → tilted → fly-through → eye height).

Why:
- Route, overlays and terrain are always perfectly aligned (one coordinate system).
- The "map tilts into 3D" moment in Act 1 comes for free.
- MapLibre only supports Earth Web Mercator tiles, while Mars Trek serves equirectangular (geographic) tiles. So **OpenLayers** is used only for the small regional context map, because it supports that projection natively.

### 2.3 Repository structure

```
cairn-demo/
├── docs/
│   ├── introduction.md
│   ├── plan.md                  ← this file
│   └── data-sources.md          ← exact dataset IDs, URLs, licenses, credits
├── data-pipeline/
│   ├── requirements.txt         ← gdal, rasterio, numpy, scipy, requests, pyproj
│   ├── config/jezero.yaml       ← AOI bounds, cell size, thresholds, file names
│   ├── fetch_terrain.py
│   ├── fetch_rover.py           ← M2020 waypoints + raw images
│   ├── fetch_spaceweather.py    ← DONKI events
│   ├── build_aoi.py
│   ├── build_cost.py
│   ├── build_assets.py
│   ├── Makefile                 ← `make all` runs the whole pipeline
│   └── raw/                     ← downloads (git-ignored)
├── web/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.ts
│   ├── public/data/jezero/      ← pipeline output (committed, kept small)
│   └── src/
│       ├── main.ts
│       ├── state/store.ts
│       ├── data/loaders.ts      ← load site.json, cost.bin, images, replay
│       ├── scene/
│       │   ├── terrain.ts       ← mesh from heightmap
│       │   ├── overlays.ts      ← layer textures on terrain
│       │   ├── routes.ts        ← route lines, markers, envelope
│       │   ├── cameras.ts       ← top-down, orbit, fly-through, first-person
│       │   └── sky.ts           ← Mars sky + lighting
│       ├── routing/
│       │   ├── worker.ts
│       │   ├── astar.ts
│       │   ├── dijkstra.ts      ← return-cost field
│       │   └── heap.ts
│       ├── eva/
│       │   ├── metabolic.ts     ← Minetti cost, Tobler speed
│       │   ├── budget.ts        ← O₂, time, walk-back
│       │   └── radiation.ts
│       ├── replay/engine.ts
│       ├── ui/                  ← panels, HUD, alerts, profile chart
│       └── styles/
├── .github/workflows/deploy.yml ← build web/ and publish to GitHub Pages
└── README.md
```

---

## 3. Data Plan

### 3.1 Datasets

| # | Layer | Primary source | Format | Used for | Fallback |
|---|---|---|---|---|---|
| D1 | Terrain (~1 m/post) | **USGS Mars 2020 Terrain Relative Navigation HiRISE DTM mosaic** (Astropedia) | GeoTIFF | Heightmap, slope | Individual HiRISE DTMs (uahirise.org/dtm, PDS); CTX DTM (~20 m) |
| D2 | Orthoimage (~25 cm/px) | **USGS Mars 2020 TRN HiRISE orthomosaic** | GeoTIFF | 3D texture, top-down map | HiRISE ortho from the same DTM product |
| D3 | Rock abundance / thermal inertia | **THEMIS** thermal inertia mosaic (ASU / USGS) | GeoTIFF | Cost grid | Mars 2020 landing-site rock-hazard maps |
| D4 | Minerals | **CRISM** map-projected products (PDS Geosciences Node / ODE) | IMG/GeoTIFF | Science-target overlay | Published Jezero carbonate/olivine maps (cite paper) |
| D5 | Geology | **USGS geologic map of Jezero crater** (Sun & Stack, Planetary Geologic Mapping Program) | Shapefile | Unit overlay, terrain penalties | Hand-digitized key units, clearly labeled |
| D6 | Rover traverse & waypoints | **Perseverance MMGIS layers** (mars.nasa.gov) | GeoJSON | Waypoint positions, sols | Manual waypoint list from mission news |
| D7 | Ground photos | **Mars 2020 raw images feed** (mars.nasa.gov) | JSON + JPG | Waypoint "what you'll see" | Curated NASA press images |
| D8 | Weather | **MEDA** (PDS Atmospheres Node) | CSV | Temp/pressure/UV readouts | Published daily summaries |
| D9 | Surface radiation | **MSL RAD** (PDS PPI Node) + NASA May 2024 event release | CSV / figure | Dose baseline + SEP replay curve | Digitize the curve from NASA's published figure (labeled) |
| D10 | Space weather | **NASA DONKI API** (`/DONKI/SEP`, `/FLR`, `/CME`) | JSON | Real alert text + timing | Saved JSON snapshot (always bundled) |
| D11 | Regional context | **NASA/JPL Mars Trek** WMTS tiles | JPG tiles | Mars → Jezero zoom | Static image sequence |

Every dataset gets an entry in `docs/data-sources.md` and `provenance.json`: mission, instrument, product ID, URL, license and credit line (e.g., *NASA/JPL-Caltech/University of Arizona*).

### 3.2 Area of Interest (AOI) — decide first

1. Load D1 coverage footprint and D6 waypoints in QGIS.
2. Mark: rover staging point, **Cheyava Falls**, **Three Forks depot**.
3. **Decision gate:**
   - If both targets fit in a box of about **3 × 3 km** with DTM coverage → one AOI.
   - If not → the AOI covers Cheyava Falls (main EVA); the depot is a **rover drive** segment shown in the context map.
4. Write the bounds to `config/jezero.yaml`.

### 3.3 Coordinate system

- Everything is reprojected to the DTM's native **equirectangular projection on the Mars 2000 sphere (R = 3,396,190 m)** in meters.
- **Local frame:** origin = AOI south-west corner; `x` = east (m), `y` = north (m).
- **Three.js frame:** `X = x`, `Z = −y`, `Y = elevation` (so north is "into the screen").
- Lon/lat ↔ local meters conversion lives in one place: `data/loaders.ts` (TS) and `build_aoi.py` (Python), with a shared test point to confirm they agree.

### 3.4 Pipeline steps

```bash
# 1. Crop + resample terrain to the AOI on a 2 m grid (routing grid)
gdalwarp -te $XMIN $YMIN $XMAX $YMAX -tr 2 2 -r bilinear raw/dtm.tif out/aoi_dtm_2m.tif

# 2. Slope in degrees (Horn's method)
gdaldem slope out/aoi_dtm_2m.tif out/aoi_slope.tif

# 3. Heightmap for 3D (16-bit PNG, 1025×1025 vertices)
gdal_translate -ot UInt16 -scale $ZMIN $ZMAX 0 65535 -outsize 1025 1025 -of PNG \
  out/aoi_dtm_2m.tif web/public/data/jezero/height.png

# 4. Texture (4096² JPG; WebP if size allows)
gdalwarp -te $XMIN $YMIN $XMAX $YMAX raw/ortho.tif out/aoi_ortho.tif
gdal_translate -outsize 4096 4096 -of JPEG -co QUALITY=85 \
  out/aoi_ortho.tif web/public/data/jezero/texture.jpg

# 5. THEMIS → same 2 m grid (bilinear); geology → rasterized unit codes
gdalwarp -t_srs out/aoi_dtm_2m.tif -te $XMIN $YMIN $XMAX $YMAX -tr 2 2 -r bilinear raw/themis_ti.tif out/aoi_ti.tif
gdal_rasterize -a UNIT_CODE -te $XMIN $YMIN $XMAX $YMAX -tr 2 2 raw/geology.shp out/aoi_geo.tif
```

Then `build_cost.py` combines the rasters (Section 4.2) and writes `cost.bin`, and `build_assets.py` writes the overlay PNGs and JSON indexes.

### 3.5 Output file contracts (`web/public/data/jezero/`)

| File | Content |
|---|---|
| `site.json` | Site metadata (below) |
| `height.png` | 16-bit grayscale heightmap, scaled `zMin..zMax` |
| `texture.jpg` | HiRISE orthoimage, AOI-aligned |
| `cost.bin` | `Float32Array`, row-major, `rows × cols`; value = cost multiplier ≥ 1; `-1` = impassable |
| `slope.bin` | `Uint8Array`, slope in whole degrees (for profile + hazard display) |
| `overlays/*.png` | Slope, rocks, minerals, geology — RGBA, AOI-aligned |
| `pois.json` | Staging point, objectives, shelter, with local coords + descriptions |
| `waypoints.geojson` | Perseverance waypoints (local coords added as properties) |
| `images.json` | `[{ id, sol, camera, file, credit, x, y, headingDeg, caption }]` |
| `weather.json` | MEDA time series for the chosen sol |
| `replay.json` | Event timeline + dose-rate curve (below) |
| `provenance.json` | `{ layerId: { mission, instrument, product, url, credit, license } }` |

```jsonc
// site.json
{
  "id": "jezero",
  "name": "Jezero Crater — Neretva Vallis",
  "crs": "Mars 2000 sphere, equirectangular",
  "origin": { "lon": 77.40, "lat": 18.40 },          // AOI SW corner (placeholder values)
  "extentM": { "width": 3000, "height": 3000 },
  "grid": { "cols": 1500, "rows": 1500, "cellM": 2 },
  "height": { "file": "height.png", "zMin": -2600, "zMax": -2450 }, // placeholder values
  "texture": "texture.jpg",
  "verticalExaggeration": 1.0
}
```

```jsonc
// replay.json
{
  "event": "2024-05-20 solar particle event",
  "timeScale": 120,                                   // 1 s of demo = 2 min of mission time
  "events": [
    { "t": 0,    "type": "eva_start" },
    { "t": 2400, "type": "donki_alert", "source": "DONKI SEP", "text": "..." },
    { "t": 2700, "type": "dose_rise" },
    { "t": 9000, "type": "all_clear" }
  ],
  "doseRate": [ { "t": 0, "uGyPerH": 9 }, { "t": 2700, "uGyPerH": 400 } ]  // from RAD (placeholders)
}
```

---

## 4. Routing Engine

### 4.1 Grid

- 2 m cells, ~1500 × 1500 = 2.25 M cells for a 3 × 3 km AOI.
- Stored in typed arrays (`Float32Array` costs, `Float32Array` heights) inside a **Web Worker** so the UI never freezes.
- 8-connected moves (straight = 1 cell, diagonal = √2 cells).

### 4.2 Cell cost (built offline in `build_cost.py`)

```
if slope > 25°                → impassable
if hazard mask (sand/ripples) → impassable (or ×5 if marked "soft")
rock = normalize(thermal inertia)            → 0..1
geo  = unit penalty from table (e.g., 0 for flat bedrock, 0.5 for talus)
cellCost = 1 + 2·rock + geo + slopePenalty(slope)
slopePenalty: 0 below 10°, rising linearly to 3 at 25°
```

All thresholds live in `config/jezero.yaml` so they can be tuned live during the demo build.

### 4.3 Edge cost (computed at runtime, direction-aware)

Walking uphill costs more than walking downhill, so the cost of a move depends on direction:

```
grade i   = (z_to − z_from) / horizontal distance            (clamped to ±0.45)
C(i)      = 280.5i⁵ − 58.7i⁴ − 76.8i³ + 51.9i² + 19.6i + 2.5    [J/(kg·m)]  — Minetti et al. 2002
energy    = C(i) · mass · distance · gravityFactor · suitFactor
edgeCost  = energy · avg(cellCost_from, cellCost_to)
```

### 4.4 Algorithms

| Need | Algorithm | Notes |
|---|---|---|
| Route between two points | **A\*** with binary heap | Heuristic = straight-line distance × minimum possible cost per meter (admissible) |
| Multi-stop EVA | A\* per leg; stop order fixed by the user (2–3 stops, no optimizer needed) | |
| Walk-back check + shelter re-route | **Dijkstra from the shelter** over the whole grid → "return-cost field" | Computed once on load. Any point's cost to get home is a lookup. Re-routing in Act 3 = following the field downhill → **instant** |
| Walk-back envelope | Contour of the return-cost field at the remaining O₂ budget | Drawn as a glowing boundary on the terrain |
| Straight-line comparison | Bresenham line across the grid | Sample slope/cost along it; color segments red where impassable |
| Smoothing | String-pulling on the A\* path (line-of-sight check on cost grid) | Removes zig-zags from grid paths |

**Performance targets:** A\* on 2.25 M cells < 300 ms; Dijkstra field < 2 s on load (run behind the loading screen).

### 4.5 Worker messages

```ts
// main → worker
{ type: "init", cost: ArrayBuffer, height: ArrayBuffer, grid, params }
{ type: "route", stops: [{x,y}, ...] }
{ type: "replanToShelter", from: {x,y}, oxygenLeftL: number }

// worker → main
{ type: "ready", returnFieldStats }
{ type: "route", legs: [{ path: Float32Array, distanceM, energyJ, timeS }], straightLine: {...} }
{ type: "envelope", contour: Float32Array }
```

---

## 5. EVA Budget Model

All values are **demo parameters, not real spacesuit specifications.** They live in `eva/params.ts` and are shown in a "model assumptions" popover so judges see we're being honest.

| Parameter | Demo value | Basis |
|---|---|---|
| Astronaut + suit + kit mass | 180 kg | Assumption |
| Gravity factor (Mars 0.38 g) | 0.6 | Partial scaling — walking cost doesn't fall linearly with gravity |
| Suit factor | 1.8 | Suited walking costs more than unsuited |
| Resting metabolic rate | 100 W | Typical human value |
| Energy per liter of O₂ | 20.1 kJ/L | Standard physiology |
| Suit O₂ supply | 700 L | Assumption (~1 kg O₂) |
| Reserve | 25% | Safety margin |
| Max EVA duration | 6 h | Assumption |
| Walking speed | Tobler: `v = 6·e^(−3.5·|tanθ + 0.05|)` km/h × 0.6 suit factor | Tobler's hiking function |
| Time at each science stop | 30 min | Assumption |

**Outputs per route:**
- Distance, walking time, stop time, total EVA time.
- O₂ used = (Σ walking energy + resting rate × total time) / 20.1 kJ/L.
- **Walk-back margin** at every point = O₂ left − O₂ needed to return − reserve. If it ever goes below 0 → the route is flagged and the leg turns orange.
- Radiation dose (Section 6).

---

## 6. Radiation Model & Event Replay

### 6.1 Baseline

- Galactic cosmic ray dose on the surface measured by Curiosity RAD: about **0.21 mGy/day absorbed** (Hassler et al., 2014).
- Shown as a slowly rising dose counter during the walk.

### 6.2 May 20, 2024 solar particle event

- Total recorded by RAD: about **8.1 mGy (8,100 µGy)** over the event (NASA release).
- `replay.json` holds a dose-rate curve with that total and the real timing shape (from RAD data if archived; otherwise digitized from NASA's published figure — labeled as such).
- DONKI SEP/flare/CME records for May 2024 provide the **alert text and timestamps** shown on screen.

### 6.3 Replay engine

1. The clock runs at `timeScale` (e.g., 1 s = 2 min).
2. At `donki_alert`: banner + sound; the walk pauses; the worker returns the shelter route from the **current position** (instant via the return-cost field).
3. The astronaut walks to the rover; dose accumulates at the outdoor rate until arrival, then at `outdoor × shieldingFactor` (demo value **0.5**, adjustable).
4. **Dose avoided** = ∫(outdoor rate − actual rate) dt over the event, shown as a big number with a small chart comparing the two curves.
5. At `all_clear`: the original route resumes from the rover.

---

## 7. 3D Scene

### 7.1 Terrain

- `PlaneGeometry` with **1024 × 1024 segments**; heights written from `height.png` on load (decode 16-bit with a small PNG decoder, e.g. `fast-png`, since browsers clip canvas reads to 8 bits).
- Material: `MeshStandardMaterial` with the HiRISE texture; normals computed from the heightmap.
- Overlays: a second texture mixed into the terrain shader by layer opacity (one draw call, perfect alignment).
- Vertical exaggeration uniform (default 1.0); when ≠ 1, a `vertical ×N` label is shown.

### 7.2 Atmosphere & lighting

- Sky: gradient dome, butterscotch at the horizon to darker tan overhead; light dust fog (`scene.fog`) to hide the AOI edges.
- Sun: one `DirectionalLight` at a low angle so the HiRISE relief reads well; soft ambient light.

### 7.3 Routes & markers

- Routes: thick lines (`Line2` / `MeshLine`) draped 0.5 m above the terrain. Safe route = cyan glow; straight line = white with **red segments** where impassable; shelter route = amber.
- POIs: stacked-stone cairn markers (three simple stones) with labels.
- Walk-back envelope: glowing contour line on the terrain.

### 7.4 Camera modes

| Mode | Camera | Use |
|---|---|---|
| Plan (2D) | Orthographic, straight down | Planning, layers |
| Orbit (3D) | Perspective, OrbitControls | Exploring terrain |
| Fly-through | Perspective, follows a spline along the route, 150 m up | Act 1 reveal |
| Walk / HUD | Perspective, 1.7 m above ground, looks along the path | Act 2 + 3 |

Transitions are 1.5 s eased tweens between modes.

### 7.5 Performance budget

| Metric | Target |
|---|---|
| Frame rate (mid laptop) | 60 fps orbit, ≥ 30 fps walk |
| Initial load | < 5 s on venue Wi-Fi; instant from local build |
| Total data in `public/data` | < 60 MB |
| Draw calls | < 50 |

---

## 8. UI & UX

### 8.1 Habitat screen layout

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ CAIRN ▲  Jezero · Neretva Vallis        [ Plan | 3D | Walk | Replay ]   ⚠ alert │
├───────────────┬───────────────────────────────────────────────┬───────────────┤
│ OBJECTIVES    │                                               │ EVA BUDGET    │
│ ☑ Cheyava F.  │                                               │ Dist  2.4 km  │
│ ☑ Three Forks │             3D / top-down scene               │ Time  3h 10m  │
│ + add stop    │                                               │ O₂ ████░ 62%  │
│               │                                               │ Back  ✓ +18%  │
│ LAYERS        │                                               │ Dose  0.03 mGy│
│ ◉ Terrain     │                                               │               │
│ ○ Slope       │                                               │ COMPARE       │
│ ○ Rocks       │                                               │ Straight ✗    │
│ ○ Minerals    │                                               │ CAIRN    ✓    │
│ ○ Geology     │                                               │               │
│ ⓘ sources     │                                               │ [ Start EVA ] │
├───────────────┴───────────────────────────────────────────────┴───────────────┤
│ Elevation profile ▁▂▃▅▆▅▃▂▁   ·   Replay timeline ──●────────────  ▶ 120×     │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Walk / HUD mode

- Full-screen first-person view.
- Top: heading tape (compass).
- Center bottom: next waypoint — name, distance, bearing arrow.
- Left: O₂ bar, suit time left, walk-back margin.
- Right: dose rate + total, temperature, pressure, UV (MEDA).
- Waypoint arrival: the Perseverance photo slides in with caption + credit ("Sol 1212 · Mastcam-Z · NASA/JPL-Caltech/ASU").
- Alerts take over the top band in amber/red.

### 8.3 Visual style

- Dark UI (night-friendly inside a habitat), Mars-orange accents, cyan for safe route, amber/red for warnings.
- Monospace numerals for telemetry.
- Logo: three stacked stones forming a map pin.

### 8.4 Provenance panel

Clicking ⓘ on any layer or reading shows: mission → instrument → product ID → link → credit. This is the "every pixel is NASA data" proof.

---

## 9. Demo Script

### 9.1 Live demo (~3 minutes)

| Time | Act | On screen | Narration (key line) |
|---|---|---|---|
| 0:00 | Hook | Context map zooms from Mars to Jezero | "In 2025 NASA found the most compelling potential sign of ancient life on Mars — here." |
| 0:20 | Act 1 | Objectives selected; layers stack in | "CAIRN layers data from five NASA missions." |
| 0:45 | Act 1 | Straight line → red segments → safe route appears | "The straight line kills. CAIRN finds the path." |
| 1:05 | Act 1 | Tilt to 3D, fly-through | "Real HiRISE terrain, one-meter resolution." |
| 1:25 | Act 2 | Walk mode; Perseverance photo at a waypoint | "This is exactly what you'll see — Perseverance stood here." |
| 1:50 | Act 3 | DONKI alert; dose climbs; amber shelter route | "May 20, 2024 — a real storm, measured by Curiosity." |
| 2:20 | Act 3 | Arrive at rover; "dose avoided" | "CAIRN got the crew to shelter in minutes." |
| 2:40 | Close | Provenance panel → logo wall | "Robots built the cairns. Humans will follow them." |

### 9.2 Submission video / slides

- Cut the live script to the submission limit, keeping the three beats: **straight line vs safe route**, **Perseverance photo**, **storm re-route**.
- Record screen at 1080p, 60 fps; add captions (judges often watch muted).
- Backup slides: one slide per act + a data-sources slide + a team slide.

---

## 10. Team Roles (up to 6)

| Role | Owns | If the team is smaller |
|---|---|---|
| **R1 — Data lead** | Pipeline, AOI, all datasets, provenance | Merge with R6 |
| **R2 — Routing & EVA** | Worker, A\*, Dijkstra field, EVA model, tests | Merge with R1 |
| **R3 — 3D lead** | Terrain, overlays, cameras, routes, sky | Keep separate — highest risk |
| **R4 — Frontend/UI** | Layout, panels, HUD, alerts, profile chart, deploy | Merge with R5 |
| **R5 — Story & design** | Logo, style, demo script, video, slides, project page | Merge with R4 |
| **R6 — Science & QA** | Fact-checks claims, science captions, testing, rules | Merge with R1 |

**Solo / pair plan:** person A = R1 + R2 + R6; person B = R3 + R4 + R5.

---

## 11. Milestones & Gates

| # | When | Gate | If missed |
|---|---|---|---|
| M0 | Fri Nov 13, 20:00 | AOI chosen; D1, D2, D6, D7, D10 downloaded and checked | Switch D1 to an individual HiRISE DTM |
| M1 | Sat 14:00 | Real terrain renders in Three.js with texture | Fall back to CTX DTM, keep going |
| M2 | Sat 20:00 | A\* route + straight-line comparison on real cost grid | Drop rock/geology from cost; slope only |
| M3 | Sun 12:00 | Acts 1–3 run end to end | Cut stretch features (Section 1.3) |
| M4 | Sun 18:00 | **Feature freeze**; deployed to GitHub Pages | Demo from local build |
| M5 | Sun 21:00 | Video + project page **submitted** | 2 h buffer to 23:59 |

---

## 12. Testing & Verification

| Area | Test |
|---|---|
| Routing | Vitest: A\* on small hand-made grids (wall, corridor, slope); path never crosses impassable cells; heuristic is admissible |
| Return field | Every cell's field value ≥ straight-line lower bound; shelter cell = 0 |
| EVA math | Minetti C(0) = 2.5; uphill > downhill; O₂ totals match a hand calculation |
| Coordinates | Known waypoint (lon/lat) lands on the right spot in the HiRISE texture (visual check + shared test point) |
| Data alignment | Overlay edges line up with terrain features at 3 checkpoints |
| Replay | Dose integral equals the source total (±2%) |
| Performance | fps counter (stats.js) in dev; check on the weakest team laptop |
| Demo rehearsal | Full run-through 3× on Sunday, once with Wi-Fi off |

---

## 13. Timeline

### 13.1 Pre-hackathon (Wed Nov 11 – Fri Nov 13)

> Follow the rule check in Section 0.

**Wed Nov 11**
- Form team, assign roles (Section 10).
- R1: find D1/D2 products; download; open in QGIS; check coverage of Cheyava Falls and Three Forks.
- R5: logo sketch, color palette, UI wireframe from Section 8.
- R6: collect source links for every claim (biosignature announcement, May 2024 storm, RAD baseline).

**Thu Nov 12**
- R1: AOI decision (Section 3.2); run the GDAL steps (Section 3.4) by hand once.
- R1/R6: download D6, D7 (pick 6–10 photos near the route), D10 (DONKI May 15–25, 2024), D9 (RAD), D8 (MEDA).
- R3: Three.js spike — load any 16-bit heightmap + texture (proves the 16-bit decoding path).
- R2: A\* + heap spike on a synthetic grid.

**Fri Nov 13**
- **Resources tab opens** → compare against Section 3.1; add or swap datasets; update `data-sources.md`.
- Finalize story wording and demo script.
- Everyone: dev environment ready (Node LTS, Python 3.11 + GDAL, QGIS).
- **M0 gate** at 20:00.

### 13.2 Hackathon Day 1 — Saturday Nov 14

| Time | R1 Data | R2 Routing/EVA | R3 3D | R4 UI | R5 Story |
|---|---|---|---|---|---|
| 09:00–10:00 | Kickoff, repo scaffold (Vite + TS, pipeline folder), create project page | ← | ← | ← | ← |
| 10:00–14:00 | Pipeline scripts → `height.png`, `texture.jpg`, `cost.bin`, `site.json` | Worker + A\* + heap, unit tests | Terrain mesh from real data, lighting, sky | App shell, layout, store, mode switch | Logo, style tokens, slide template |
| **14:00** | **M1: real terrain on screen** | | | | |
| 14:00–20:00 | Overlays (slope, rocks, geology, minerals), `pois.json`, provenance | Edge cost (Minetti), straight-line compare, string-pulling | Route lines, POI cairns, top-down ↔ 3D camera tween | Objectives + layers panel, EVA budget panel | Narration draft, record b-roll of progress |
| **20:00** | **M2: real route + comparison** | | | | |
| 20:00–24:00 | `images.json`, `weather.json` | EVA budget model + Dijkstra return field | Fly-through + walk camera | Elevation profile, provenance panel | Project page text |
| Night | Rest in shifts — at least 5 h sleep per person | | | | |

### 13.3 Hackathon Day 2 — Sunday Nov 15

| Time | R1 Data | R2 Routing/EVA | R3 3D | R4 UI | R5 Story |
|---|---|---|---|---|---|
| 08:00–12:00 | `replay.json` (RAD curve + DONKI) | Shelter re-route + walk-back envelope | Envelope contour, shelter route styling | HUD layout, waypoint photo cards, alerts | Storyboard final |
| **12:00** | **M3: Acts 1–3 end to end** | | | | |
| 12:00–16:00 | Data QA, credits | Replay engine + dose-avoided chart | Polish, performance pass | Replay timeline, assumptions popover | Rehearsal #1 |
| 16:00–18:00 | Stretch: CRISM polish | Stretch: buddy mode | Stretch: visual polish | Deploy to GitHub Pages | Rehearsal #2 |
| **18:00** | **M4: feature freeze + deployed** | | | | |
| 18:00–21:00 | README + data-sources.md | Bug fixes only | Bug fixes only | Bug fixes only | Record video, edit, captions |
| **21:00** | **M5: submit** (make repo public first) | | | | |
| 21:00–23:59 | Buffer — fix the project page, re-upload if needed | | | | |

---

## 14. Deployment

- `web/` builds with `vite build` → `web/dist/`.
- GitHub Actions workflow (`deploy.yml`) on push to `main` → GitHub Pages.
- `vite.config.ts`: `base: "/cairn-demo/"`.
- **Offline fallback:** `npm run preview` on the demo laptop, with all data local; tested with Wi-Fi off.

---

## 15. Risks & Fallbacks

| Risk | Likelihood | Impact | Fallback |
|---|---|---|---|
| TRN DTM mosaic doesn't cover both targets | Medium | High | Individual HiRISE DTM; or one target + rover drive to the other |
| 16-bit PNG heights decode wrong | Medium | High | Use `fast-png`; or ship heights as raw `Float32` `.bin` |
| A\* too slow on 2.25 M cells | Low | Medium | 4 m grid (560 k cells); worker keeps UI responsive anyway |
| May 2024 RAD data not archived on PDS yet | Medium | Medium | Digitize NASA's published curve; label it clearly |
| Raw image API changed or blocked | Medium | Low | Images are downloaded in advance and bundled |
| Mars Trek tiles blocked by CORS | Medium | Low | Pre-rendered context zoom image sequence |
| Running out of time | High | High | Milestone gates (Section 11) + cut list (Section 1.3) |
| Overstated science claims | Low | High | R6 reviews all on-screen text; "potential biosignature", "demo parameters" labels |

---

## 16. Submission Checklist

- [ ] Repo **public**, README with screenshots, how to run, and data credits.
- [ ] Live demo URL (GitHub Pages) works in a fresh browser.
- [ ] Demo video / slides within the official limits.
- [ ] Project page: title, one-line summary, how it addresses the challenge, NASA data used (with links), partner-agency data used, tools used.
- [ ] Disclose AI tool use if the rules ask for it.
- [ ] Image credits on every photo and in `data-sources.md`.
- [ ] All team members listed on the team page.
- [ ] Submitted before **23:59 local, Sun Nov 15** — target 21:00.

---

## 17. After the Hackathon

The roadmap and vision are in [introduction.md § 4](introduction.md#4-future-plans-and-vision). Engineering steps to get there:

1. **Generalize the pipeline:** `config/<site>.yaml` → any site with DTM coverage (Gale Crater / Mount Sharp first).
2. **Site picker** in the app; data loaded per site.
3. **Exploration Zone mode:** import NASA's candidate human landing zones; compute per-zone summaries (ice, traversability, radiation, dust).
4. **PWA + offline cache** for the tablet version.
5. **WebXR** prototype for the visor.
6. **MMGIS plugin:** package routing + EVA budget as a NASA-AMMOS MMGIS tool.
7. **Lunar version:** swap Mars datasets for LRO (LOLA, LROC, Diviner) with Moon gravity and lighting.

---

## 18. Open Questions

| Question | Owner | Decide by |
|---|---|---|
| Final AOI bounds — one AOI or two? | R1 | Thu Nov 12 |
| Exact Cheyava Falls and Three Forks coordinates | R1/R6 | Thu Nov 12 |
| Which resources from the official Resources tab to add | All | Fri Nov 13 |
| Submission video length / slide limits | R5 | Fri Nov 13 |
| Rules on pre-event work and AI disclosure | R6 | Wed Nov 11 |
| Team size and final role mapping | All | Wed Nov 11 |
