# CAIRN — Crew Assisted Integrated Route Navigator

> **The rocks Perseverance found. The path humans will walk.**

A Marswalk route planner for the first human explorers on Mars, built on official NASA, USGS and JPL data — at two real rover sites: **Jezero Crater** (Perseverance, Cheyava Falls) and **Gale Crater** (Curiosity, the Mount Sharp boxwork).

Built for the **2026 NASA Space Apps Challenge** — *Interplanetary Survival Guide: Martian Map*.

- [Introduction](docs/introduction.md) — the idea, the story and the vision
- [Project plan](docs/plan.md) — technical design and schedule
- [Data sources](docs/data-sources.md) — every dataset, with links and credits

---

## What it does

Pick a site, pick the stops, and CAIRN plans the walk from the pressurised rover and back.

1. **Layers real mission data** on a 2 × 2 km walk area set in up to 16 km of surrounding terrain: HiRISE elevation (1 m) and imagery (25 cm), CRISM minerals, THEMIS night-time thermal, the USGS geologic map, loose sand, terrain sky-shielding and minutes to shelter.
2. **Finds the safest walking route** (walking energy × fall risk) between the stops you pick or any point you click, and shows it against the straight line — which crosses ground too steep to walk at both sites. You can also **park the pressurised rover** somewhere else (click the map → *Park rover*): the way home from every point and the radio coverage are recomputed in under a second (on Jezero, parking between the two stops halves the walk and gives radio contact the whole way).
3. **Budgets the EVA**: distance, time, oxygen, walk-back margin and radiation dose — with the **real Sun** for the chosen sol and start time, casting shadows from the real terrain. The start-time slider shows which departures keep daylight for the whole walk (and sunrise and sunset), the cue card marks stops that are in shade on arrival, and a click on *Longest way home* or *Steepest ground* flies to that point of the route.
4. **Shows what you will see**: rover photos taken at each stop, and at Gale a **360° panorama** CAIRN stitched from Curiosity's Navcam frames. Stops without photos (your own, placed on the map) get a HiRISE close-up from orbit.
5. **Walks the route** in a first-person visor view with compass, oxygen, dose, weather and a minimap.
6. **Replays a real solar storm** (20 May 2024, measured by Curiosity's RAD). CAIRN finds the way back to the rover in milliseconds, names the nearest natural cover, and reports the dose avoided.
7. **Checks radio contact.** A line-of-sight model of the rover's antenna over the real terrain shows where hills cut the link, how much of the walk stays in contact, which stops have no contact at all (on Jezero's default walk: 30 min of science at Serpentine Rapids), and the best spot on the route for the crew to stand up a portable relay (85% → 100%, Serpentine Rapids included).
8. **Practises emergencies.** During a walk, *Suit leak* doubles oxygen use and *Twisted ankle* halves the walking speed; CAIRN finds the quickest safe way home from where the astronaut stands and checks the oxygen.
9. **Talks the crew through it.** Spoken directions in the visor: distance, turns, steep ground and sand ahead, arrivals, alerts, radio loss.
10. **Checks itself against the real rovers.** 68% of Perseverance's drive at Jezero (70% of Curiosity's at Gale) is on ground CAIRN rates easy or moderate, against 45% (41%) of the area: the rover drivers avoided what CAIRN avoids.
11. **Prints a one-page EVA cue card**: map with radio blackouts, timeline, turn-back oxygen per stop, storm protocol.
12. **Shares and exports the plan.** The plan lives in the link (stops, start time, options, relay), so it survives a reload and can be sent to a teammate; the route exports to KML (Google Earth in Mars mode) and GeoJSON (Mars 2000 coordinates).
13. **Works offline and installs as an app.** About → Use offline saves a whole site on the device — astronauts on Mars will not have the internet.
14. **Plays a two-minute guided demo** of the core story (Demo button or the briefing).

Colour-blind safe throughout: map layers and charts use the Okabe-Ito palette, and impassable ground is also hatched. Keyboard shortcuts (press `?`), screen-reader announcements for alerts, and reduced motion are supported; on phones the screen stays on during a walk and alerts vibrate.

Every layer, photo and reading names its mission, instrument and product in the **Data sources** panel and in [docs/data-sources.md](docs/data-sources.md).

## Run it

Requires Node.js 20 or newer. All data is already in the repository, so no downloads are needed.

```bash
cd web
npm install
npm run dev
```

Open the address Vite prints (normally http://localhost:5173).

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm test` | 59 unit and integration tests |
| `npm run build` | Type-check and build to `web/dist/` |
| `npm run preview` | Serve the built app |

URL options: `?site=gale` opens Gale Crater (default `jezero`), `?skip=1` skips the briefing, `?q=low` uses a lighter mesh and the 50 cm texture for slow GPUs, `?tex=4k` stays on the 50 cm texture. The part after `#` is the plan, e.g. `#stops=cheyava,serpentine&t=9.5&relay=1`; links with a plan open straight on it.

Works on desktop, tablets and phones: below 1180 px the route and layers panel becomes a drawer (layers button, top right); in portrait the plan becomes a bottom sheet, and during a walk the controls sit in a strip above it.

Offline mode needs the built app (`npm run build`, then `npm run preview` or any static host): the service worker is not registered by the development server.

## Controls

| View | Mouse / trackpad | Keys |
|---|---|---|
| **Map** | Drag to move · scroll to zoom · double-click to fly there · click to add a stop | `+` `−` |
| **3D** | Drag to rotate and tilt · Shift-drag or right-drag to move · scroll to zoom · double-click to fly there (also outside the walk area) | Arrow keys rotate and tilt · `+` `−` · `N` faces north |
| **Visor** | Drag to look around | |
| **Any** | Hover the elevation chart to see that point on the map | `1` `2` `3` switch views · `Space` pauses the EVA · `Ctrl/⌘ Z` undoes a plan change (browser Back works too) · `Esc` closes · `?` lists shortcuts |

The buttons at the bottom-right of the map do the same things.

## The demo

Press **Demo** (top right) or **Watch the 2-minute demo** in the briefing. It walks through: the site → real terrain in 3D → traversability and the deadly straight line → the real Sun and shadows → radio contact and where to stand up a relay → a flyover → the walk, arriving at the first objective (with the 360° view at Gale) → the 20 May 2024 storm, the re-route and the dose avoided. Pause, skip or exit at any time.

## How it works

```
data-pipeline/  (Python)                     web/  (TypeScript + Three.js, fully static)
  fetch_*.py     download official data        data/      loaders, terrain grid, path measurement
  build_site.py  terrain, slope, sand,         routing/   A*, return-to-shelter field, smoothing (Web Worker)
                 thermal, geology, textures    eva/       walking energy, oxygen budget, radiation
  build_region.py 16 km CTX surroundings
  build_rover.py stops, traverse, photos       replay/    EVA simulation and storm re-route
  build_replay.py RAD + DONKI storm replay     scene/     terrain mesh, layers, routes, cameras
  build_weather.py MEDA weather                ui/        briefing, panels, charts, dialogs
  build_context.py regional + global maps      app.ts     controller
        │
  pack_web.py    compress grids for the web
        │
        └──► web/public/data/<site>/   (Jezero 18 MB, Gale 27 MB with photos and panoramas; committed)
```

- **Sharp at every distance.** The 25 cm HiRISE image is sampled with Catmull-Rom filtering, lighting uses the full 1 m elevation gradient per pixel, and map layers are coloured on the GPU from the raw data grids, so they stay smooth instead of pixelated.
- **No edge of the world.** The walk area sits in 16 km of CTX terrain (20 m elevation, 6 m image). The two datasets differ by +0.3 m on average along the seam; that difference is blended out over 900 m and the images are tone-matched.
- **Real Sun, real shadows.** Mars24 (Allison & McEwen 2000) places the Sun for the chosen sol and local time — checked against rover clocks to within a minute. Each pixel marches toward the Sun across the elevation grids for cast shadows.
- **Terrain shielding.** For every grid point, CAIRN measures how much of the sky the surrounding terrain blocks, weighted toward the zenith where most of the dose comes from. Cliffs cut the dose by at most ~15–40% — the rover stays the real shelter, and the storm alert says so.
- **Stitched panoramas.** For every panorama pixel, the viewing ray is rotated into the rover frame (attitude quaternion) and projected through each Navcam frame's published CAHVOR camera model; frames are feathered and exposure-matched. Published only where the frames cover at least 85% of the horizon — all five Gale stops.
- **One renderer for 2D and 3D.** The map is the 3D terrain seen from straight above through a narrow lens, so routes and layers always line up and switching to 3D is a camera move.
- **Routing.** A\* over a 1025 × 1025 grid (2 m cells) minimises *walking energy × fall risk*. Energy uses the Minetti (2002) cost of walking on slopes with the real elevation of every step; loose sand and rough ground cost more; slopes above 25° are impassable.
- **The way home.** One Dijkstra pass from the rover stores the best route home from every grid point. The emergency re-route is then a lookup, and the same data draws the *Minutes to shelter* layer and the walk-back margin.
- **One measuring function.** `measurePath()` produces every number shown about a route, so the router, the budget, the chart and the simulation cannot disagree.
- **Radio line of sight.** Rays from the rover's mast antenna (3 m) to every edge of the grid keep the steepest terrain angle seen so far, with the curvature of Mars; each point stores how far a suit antenna (1.8 m) would have to rise to see the rover. The relay search tries every ~8 m of the route where a 2.5 m mast still sees the rover and counts the blackout time it covers *after* the crew gets there.
- **Fast first load.** Grids are row-delta coded and gzipped (Gale: 6.3 → 3.2 MB), the HiRISE images and relief map are WebP (the 25 cm image: 14.5 → 8 MB), and all files load in parallel with the return-to-shelter calculation. The planner opens on the 50 cm image; the 25 cm one streams in afterwards.
- **Offline.** A service worker keeps the app and every file of a site; its data cache is versioned by the data, so app updates do not throw away a saved site.

## Rebuilding the data

Only needed to change the site or the processing. Requires Python 3.11+.

```bash
cd data-pipeline
make setup     # virtual environment + dependencies
make fetch     # downloads from USGS, NASA PDS, mars.nasa.gov, DONKI, Mars Trek (several GB of range requests; resumable)
make build     # writes web/public/data/jezero/  (make gale for Gale; both end with pack_web.py)
```

`python progress.py --watch` shows download progress. DONKI uses `DEMO_KEY` unless `NASA_API_KEY` is set.

## What is real and what is assumed

| Real mission data | Assumptions and derived products |
|---|---|
| CRISM mineral band depths (Jezero; 25% of the walk area imaged) | Mineral strengths scaled to the observations; terrain-shielding zenith exponent |
| Rover Navcam frames and camera models | The stitched panoramas (filled sky and ground under the rover are marked as filled) |
| Terrain, imagery, thermal image, geologic units | Spacesuit and physiology numbers (mass, oxygen supply, speeds) — demo values, listed in *Model assumptions* |
| Stop positions and Perseverance's traverse | Loose-sand hazard — our own analysis of HiRISE and THEMIS data |
| Photos at each stop | Mars colour in the 3D view — a display tint; HiRISE is a grey image |
| Weather (Perseverance MEDA, sol 1215) | Rover shielding factor (0.5) |
| Radiation background and storm readings (Curiosity RAD) | The first ~13 hours of the storm's dose-rate curve (see below) |
| The eruption record and alert (NASA DONKI) | Antenna heights (rover mast 3 m, suit 1.8 m, relay mast 2.5 m) and line-of-sight radio with no reflections |
| Perseverance and Curiosity drive paths (rover check) | Practice emergencies: suit leak doubles oxygen use, twisted ankle halves the speed |

**The storm replay.** Curiosity's archived RAD data holds 2–4 hours of dosimetry per sol, so the start of the 20 May 2024 storm is not recorded. CAIRN shows the real readings as dots (background 5.4 µGy/h before the storm, 34.7 µGy/h at 19:08 UTC on 20 May) and fills the gap with a model: the tail is fitted to those readings and the peak is scaled so the total equals the 8,100 micrograys NASA reported. The chart labels measured and modelled values separately. Curiosity is in Gale crater, about 3,700 km from Jezero.

## Sites

| | Jezero Crater | Gale Crater |
|---|---|---|
| Rover | Perseverance | Curiosity |
| Objectives | Cheyava Falls (potential biosignature), Serpentine Rapids | Boxwork ridge (main exposure), Nevado Sajama drill site |
| Terrain | USGS Mars 2020 TRN HiRISE mosaics + 16 km CTX surroundings | HiRISE DTM DTEEC_019698_1750_019988_1750 + 6.8 km of the same strip |
| Weather | MEDA, sol 1215 | REMS, sol 4605 |
| Extra layers | THEMIS, USGS geology, CRISM minerals | — |
| 360° panoramas | — (the public Navcam frames cover under 85% of the horizon) | All five stops |
| Storm | Curiosity RAD, 3,700 km away | Curiosity RAD, 2.3 km away |

## Differences from the plan

- **Second target.** Three Forks is 6.7 km from Cheyava Falls — a rover drive, shown on the regional map. The second walking objective is Serpentine Rapids.
- **THEMIS is displayed and used for sand detection**, not as a routing cost on its own: at ~100 m per pixel it is too coarse for a walking route.
- **Regional map** uses the USGS CTX mosaic bundled with the app; Mars Trek tiles supply the global locator.
- **After the storm** the EVA ends at the rover and the remaining stops are re-planned for a later sol, because RAD measured elevated dose rates for about two sols.

## Credits

Data: NASA/JPL-Caltech, University of Arizona, Arizona State University, MSSS, USGS Astrogeology, NASA PDS, NASA CCMC. Full list in [docs/data-sources.md](docs/data-sources.md).

Methods: Minetti et al. (2002), *J. Appl. Physiol.* 93:1039 (energy cost of walking on slopes); Tobler (1993) hiking function; Lejeune et al. (1998), *J. Exp. Biol.* 201:2071 (walking on sand).

This project is not affiliated with or endorsed by NASA.
