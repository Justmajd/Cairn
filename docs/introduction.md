# CAIRN — Introduction

> **The rocks Perseverance found. The path humans will walk.**

**CAIRN** — *Crew Assisted Integrated Route Navigator*

A web-based EVA (Marswalk) route planner and navigation aid for the first human explorers on Mars, built entirely on official NASA, USGS and JPL data.

Built for the **2026 NASA Space Apps Challenge** — challenge: *Interplanetary Survival Guide: Martian Map*.

---

## 1. The Name

A **cairn** is a stack of stones that hikers and explorers leave to mark a safe trail for whoever comes next.

That is exactly the story of this project: NASA's robots have spent decades marking the way on Mars — mapping, measuring, photographing. CAIRN turns those markers into a safe, science-driven path that a human astronaut can actually walk.

- **Short, pronounceable, and memorable** for judges and users.
- **Visual identity:** three stacked stones that double as a map pin.
- **Backronym:** *Crew Assisted Integrated Route Navigator* — says what the tool does.
- **Closing line for the pitch:** *"Robots built the cairns. Humans will follow them."*

### Alternatives considered

| Name | Why not chosen |
|---|---|
| Waymark, Breadcrumb, SolWalk, Redline, Ares Atlas, Sherpa | Good, but less meaning-dense than CAIRN |
| Pathfinder | Already a NASA Mars mission (1997) |
| Trek / Mars Trek | Name of the JPL tool we build on — would look derivative |
| Perseverance / Curiosity / Ingenuity | Rover/helicopter names — confusing |

> Before finalizing, check the Space Apps project gallery and GitHub for name collisions this year.

---

## 2. What the Project Is About

### The challenge

NASA asks teams to create a layered, integrated map of a location or route on Mars that combines data from multiple NASA science missions and helps a human explorer plan and carry out a safe, scientifically productive Marswalk. Existing tools (JPL's Mars Trek, the USGS-NASA Planetary Geologic Mapping Program) are built for regional and global views — not the hyper-local scale of a single EVA.

### The story (our hook)

- In **September 2025**, NASA announced that a rock called **Cheyava Falls** in Jezero Crater (sampled as *"Sapphire Canyon"*) holds the most compelling **potential biosignature** found on Mars so far. Robots cannot settle the question of whether it is evidence of ancient life.
- Perseverance also left sealed sample tubes on the surface at the **Three Forks depot**, and the future of the robotic Mars Sample Return plan is uncertain.

**The mission:** the first human crew lands at Jezero with one job — walk to where we may have found life, and pick up what the robots left behind. **CAIRN is the map that gets them there and back safely.**

### What CAIRN does

1. The astronaut selects **science objectives** (e.g., the Cheyava Falls outcrop and the Three Forks depot).
2. CAIRN stacks **multiple NASA data layers** — terrain, slope, rock abundance, mineralogy, geology.
3. It builds a **traversability cost map** and computes the **safest walking route** (A\* pathfinding) instead of a naive straight line.
4. It outputs a **route plan**: distance, time, oxygen budget, walk-back margin, and expected radiation dose.
5. At each waypoint, it shows **real Perseverance ground images** taken at that spot — "this is what you'll see."
6. During the walk, it monitors **weather and space weather**, and **re-routes to shelter** if a solar particle event hits.

### Formats

- **Habitat planning screen** — full 2D/3D map for route planning before the EVA.
- **Tablet mode** — simplified view carried during the walk.
- **Visor / HUD preview** — a first-person view at astronaut eye height simulating a helmet heads-up display.

### The demo (three acts)

**Act 1 — Plan (habitat screen)**
- Pick objectives. Layers animate in one by one: HiRISE terrain → slope → THEMIS rock abundance → CRISM minerals → USGS geology.
- **Key moment:** draw the straight-line route first — it turns red crossing steep slopes and sand ripples. Then CAIRN draws the safe route around them, with distance, time, O₂ budget and dose.
- Rover-assisted EVA: the pressurized rover drops the crew at a staging point; walks are short loops (keeps distances realistic — verify actual distances in the data).

**Act 2 — Walk (tablet / visor view)**
- Step along the route. At each waypoint the real Perseverance image from that spot fades in next to the 3D view.
- Live readouts: temperature, pressure, UV (MEDA), and cumulative radiation dose.

**Act 3 — Crisis (the winning moment)**
- Replay a **real event**: on **May 20, 2024**, Curiosity's Radiation Assessment Detector (RAD) recorded the largest solar particle event measured on the Martian surface to date (~8,100 micrograys — NASA compared it to ~30 chest X-rays).
- Mid-walk, a DONKI alert fires; the dose meter climbs.
- CAIRN instantly re-plans the fastest route to shelter (the pressurized rover) within O₂ and walk-back limits and shows **"dose avoided."**
- The storm passes, the route resumes, samples are collected.

**Closing slide:** *"Every pixel on this screen is NASA data."* — followed by the mission logo wall (MRO, Mars Odyssey, Mars 2020, MSL, USGS, JPL).

### What makes CAIRN different

1. **Real event replay, not fake hazards** — the actual May 2024 solar storm, measured by RAD.
2. **Suit-aware routing** — metabolic cost rises with slope; O₂ budget and walk-back limit are part of the route (inspired by Apollo EVA operations constraints). Most teams will route by distance only.
3. **Data provenance panel** — click any layer to see the NASA mission, instrument and dataset ID it came from.
4. **Buddy mode** — two astronauts share one route; CAIRN enforces a maximum separation distance (the brief suggests working in pairs).
5. **"Why humans" moments** — at the outcrop, CAIRN shows what Perseverance couldn't do there (reach, tools, judgment) — tying back to why NASA sends humans.

### Fit to the judging criteria

Space Apps typically judges on the five criteria below (confirm against the 2026 rules).

| Criterion | How CAIRN addresses it |
|---|---|
| **Impact** | Solves a real open question — how first crews walk safely — tied to a real mission goal (life detection, sample retrieval) |
| **Creativity** | Real event replay; ground-truth POV images at each waypoint; 3D walk preview |
| **Validity** | 10+ official datasets, a real recorded event, and a provenance panel |
| **Relevance** | Hits every point in the brief: 3+ data types, safety, radiation, route map, POV imagery, rovers, working in pairs |
| **Presentation** | Three-act story with crisis and resolution that fits the short demo video / slide limit |

---

## 3. Technical Details

### 3.1 Data sources (all official)

> The challenge's Resources tab opens on **November 13, 2026**. Re-check it and swap in or add any official resources listed there.

| Layer / purpose | Source | Mission / instrument |
|---|---|---|
| Base imagery tiles (HiRISE, CTX, MOLA) | **NASA/JPL Mars Trek** tile services | MRO, MGS |
| High-resolution terrain (~1 m/post) → slope map | **HiRISE DTMs** (U. Arizona / PDS) | MRO / HiRISE |
| High-resolution orthoimage (~25 cm/px) — 3D texture | **HiRISE orthoimages** | MRO / HiRISE |
| Rock abundance / surface hardness | **THEMIS thermal inertia** (ASU) | Mars Odyssey / THEMIS |
| Mineral science targets | **CRISM** spectral products (PDS Geosciences Node) | MRO / CRISM |
| Geologic units | **USGS Jezero geologic map** (Planetary Geologic Mapping Program) | USGS / NASA |
| Rover traverse & waypoints | **Perseverance MMGIS traverse data** (mars.nasa.gov) | Mars 2020 |
| Ground-level POV images | **Mars 2020 raw images feed** (mars.nasa.gov) | Mars 2020 / Mastcam-Z, Navcam |
| Surface weather (temp, pressure, UV) | **MEDA** data (PDS Atmospheres Node) | Mars 2020 / MEDA |
| Surface radiation | **RAD** data (PDS) | MSL / RAD |
| Space weather alerts (flares, CMEs, SEPs) | **NASA DONKI API** (api.nasa.gov) | NASA CCMC |

**Notes:**
- Verify every endpoint early: availability, CORS policy, and rate limits.
- Some older community APIs (e.g., third-party rover photo wrappers) have been retired — prefer the official raw-image feeds on mars.nasa.gov.
- Large rasters (DTMs, orthoimages) are **preprocessed offline** and served as static files so the demo runs without network dependencies.

### 3.2 Architecture

```
┌──────────────────────────── Offline preprocessing (Python + GDAL) ────────────────────────────┐
│ HiRISE DTM ──► crop to EVA area ──► slope raster ──┐                                          │
│ THEMIS TI   ──► resample to DTM grid ─────────────┼──► traversability cost grid (JSON/PNG)   │
│ USGS geology / CRISM ──► rasterize / tag ─────────┘                                          │
│ HiRISE DTM ──► 16-bit heightmap PNG ;  HiRISE ortho ──► texture (JPG/WebP)                    │
│ M2020 MMGIS waypoints + raw images ──► waypoint → image index (JSON)                          │
│ RAD May-2024 SEP + DONKI event ──► replay timeline (JSON)                                     │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
                                         │ static assets
                                         ▼
┌──────────────────────────────────── Web app (browser) ────────────────────────────────────────┐
│  Scene (Three.js): top-down 2D planner ◄─ camera tween ─► 3D view · Context map (OpenLayers)  │
│  Routing engine (A* on cost grid, Web Worker)                                                │
│  EVA budget model (time, O₂, walk-back, dose)                                                │
│  Live panels: MEDA weather · RAD dose · DONKI alerts · Data provenance                       │
│  Modes: Habitat · Tablet · Visor/HUD · Event replay                                          │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Proposed tech stack

| Part | Choice | Why |
|---|---|---|
| Frontend | **Vite + TypeScript** (React optional for panels) | Fast setup, type safety |
| 2D planner | **Three.js** top-down orthographic view of the same scene | 2D and 3D stay perfectly aligned; "tilt into 3D" is a camera move |
| Regional context map | **OpenLayers** with Mars Trek tiles | Supports Mars Trek's equirectangular tiles (MapLibre only supports Web Mercator) |
| 3D terrain | **Three.js** | Full visual control, cinematic look, runs offline at the venue |
| Routing | **A\*** on a cost grid in a **Web Worker** | Fast re-planning without freezing the UI (needed for Act 3) |
| Charts | Lightweight chart library or plain SVG | Elevation profile, dose curve |
| Preprocessing | **Python + GDAL / rasterio / numpy** | Standard tools for planetary rasters |
| Hosting | GitHub Pages / any static host | No backend needed for the demo |

### 3.4 Routing model

- **Grid:** cost raster aligned with the cropped HiRISE DTM (e.g., 1–2 m cells).
- **Cell cost** = f(slope, rock abundance, terrain unit, hazard masks):
  - Slopes above a hard limit (e.g., ~25–30°) → **impassable**.
  - Walking cost increases with slope (metabolic cost model inspired by Apollo / analog EVA research).
  - High rock abundance and loose sand (ripples) → higher cost or masked.
- **Constraints:**
  - **O₂ / consumables budget** — total route time × consumption rate must stay below the suit limit with a reserve.
  - **Walk-back limit** — at every point, the astronaut must be able to return to the rover/shelter with remaining consumables.
  - **Buddy mode** — two paths, maximum separation constraint.
- **Re-planning:** on a space-weather alert, compute the shortest-time path to the nearest shelter from the current position; show dose with vs. without re-route ("dose avoided").

### 3.5 3D representation

| Moment | 3D view |
|---|---|
| Act 1 — Plan | The flat map tilts into 3D terrain; the route is draped on the real ground; the camera flies along it. The red straight line visibly climbs the slope; the safe route curves around. |
| Act 2 — Walk | Camera at astronaut eye height (~1.7 m) walks the route; matching Perseverance images fade in beside the 3D view. |
| Act 3 — Crisis | The shelter route lights up in 3D; the camera swings toward the rover. |
| Always on | Elevation profile chart along the route, steep sections highlighted. |

**Build approach:**
1. Get the **HiRISE DTM** (~1 m/post) and matching **orthoimage** (~25 cm/px) of the Jezero EVA area.
2. Crop with GDAL to a few km²; export a 16-bit heightmap + texture.
3. In Three.js: a `PlaneGeometry` displaced by the heightmap and textured with the HiRISE image; soft lighting; dusty sky; route as a glowing line slightly above the surface; hazard zones as translucent red overlays.
4. The 2D planner is the same Three.js scene seen from directly above; switching to 3D is a camera animation, so route and layers always line up. (Full details in [plan.md](plan.md).)

**Why Three.js over CesiumJS:** full control, offline-capable, more cinematic. Cesium is better for planet-scale globes, which a few-kilometer walk doesn't need.

**Honesty rule:** if vertical exaggeration is used (e.g., ×1.5–2), show a visible `vertical ×2` label.

### 3.6 Build order (hackathon)

1. **3D terrain viewer of Jezero** from real HiRISE DTM (highest technical risk — do first).
2. Cost grid + A\* route between two points; straight-line vs safe-route comparison.
3. 2D MapLibre planner with Mars Trek tiles and layer toggles.
4. Waypoint POV images from Perseverance raw images.
5. EVA budget panel (time, O₂, walk-back, dose).
6. Event replay: May 2024 SEP + DONKI alert + re-route to shelter.
7. Data provenance panel, buddy mode, polish, demo video.

### 3.7 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Endpoint down / CORS blocked during judging | Preprocess and bundle all demo data as static files |
| DTM coverage doesn't include both targets | Choose the EVA area from available DTM coverage first; use rover-assisted staging |
| Real distances too long for a walking EVA | Rover-assisted EVA: drive to staging points, walk short loops |
| 3D performance on laptops | Crop area, downsample mesh, use compressed textures |
| Scientific claims overstated | Use "potential biosignature"; cite NASA sources in the provenance panel |

---

## 4. Future Plans and Vision

### After the hackathon (near term)

- **More sites:** ~~add Gale Crater / Mount Sharp (boxwork formations studied by Curiosity in 2025) using HiRISE DTMs, REMS weather, and Curiosity traverse data~~ — **done** (with 360° panoramas stitched from Curiosity's Navcam frames).
- **Site generator:** automatically build a CAIRN map for any location with HiRISE DTM coverage, so the tool isn't hand-built per site.
- **Exploration Zone mode:** load NASA's ~47 candidate human Exploration Zones from the 2015 Human Landing Sites Workshop and compare them on ice access (SWIM, Odyssey neutron data, SHARAD), traversability, radiation (elevation-dependent shielding via MOLA), and dust-storm risk (Mars Climate Database, MARCI). **First step done:** Deuteronilus Mensae, proposed at that workshop, is CAIRN's third site — built from orbital data alone, since no rover has been there.
- **Better physiology model:** refine metabolic cost vs slope and suit mass using published NASA EVA and analog-mission research.
- **Offline-first tablet app:** ~~package as a Progressive Web App that works with no connectivity~~ — **done**: CAIRN installs as an app and saves a whole site on the device (on Mars, Earth is 4–24 light-minutes away, so the tool must decide locally).
- **Radio and relays:** ~~line-of-sight radio contact and relay placement~~ — **done** for one relay; next, several relays and the rover driving to a better spot.

### Mid term

- **True HUD:** a WebXR version for AR headsets to prototype the visor display.
- **Plugin for NASA-AMMOS MMGIS:** contribute CAIRN's routing and EVA-budget layers as a plugin to the open-source mapping tool NASA already uses for rover operations.
- **Moon / Artemis version:** the same engine using LRO data (LOLA topography, LROC imagery, Diviner thermal) for lunar south pole EVAs — directly relevant to near-term Artemis surface missions.
- **Multi-crew operations:** shared live map between EVA crew, rover, and habitat; replanning with communication-delay awareness.

### The vision

> **Every explorer who steps onto another world should carry a trail guide built from everything we already know about it.**

CAIRN aims to become an open, data-driven route-planning layer for human planetary exploration: it takes decades of robotic science — orbital imagery, spectra, thermal data, radiation and weather measurements — and turns it into one practical answer for the person in the suit: *where to step next, why it's worth going, and how to get home safely.*

Robots built the cairns. Humans will follow them.
