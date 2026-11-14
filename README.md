# CAIRN — Crew Assisted Integrated Route Navigator

> **The rocks Perseverance found. The path humans will walk.**

A Marswalk route planner for the first human explorers at Jezero Crater, built on official NASA, USGS and JPL data.

Built for the **2026 NASA Space Apps Challenge** — *Interplanetary Survival Guide: Martian Map*.

- [Introduction](docs/introduction.md) — the idea, the story and the vision
- [Project plan](docs/plan.md) — technical design and schedule
- [Data sources](docs/data-sources.md) — every dataset, with links and credits

---

## What it does

The crew parks a pressurised rover on the south bank of Neretva Vallis, an ancient river channel on the western edge of Jezero Crater. CAIRN plans the walk to **Cheyava Falls** — the rock where Perseverance found a potential biosignature — and back.

1. **Layers real mission data** on a 2 × 2 km walk area: HiRISE elevation (1 m) and imagery (25 cm), THEMIS night-time thermal, the USGS geologic map, a derived loose-sand hazard, and a "minutes to shelter" layer — set inside 16 km of surrounding CTX terrain.
2. **Finds the safest walking route** between the stops you pick (or any point you click), and shows it against the straight line. On the default plan the straight line crosses 76 m of ground steeper than 25°; CAIRN goes around it.
3. **Budgets the EVA**: distance, time, oxygen, the walk-back margin, and background radiation dose.
4. **Shows what you will see**: real Perseverance photos taken at each stop.
5. **Walks the route** in a first-person visor view with compass, oxygen, dose, weather and a minimap.
6. **Replays a real solar storm** (20 May 2024). When the dose rate rises, CAIRN finds the way back to the rover in a few milliseconds and reports the dose avoided.

Every layer, photo and reading names its mission, instrument and product in the **Data sources** panel.

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
| `npm test` | 35 unit and integration tests |
| `npm run build` | Type-check and build to `web/dist/` |
| `npm run preview` | Serve the built app |

URL options: `?skip=1` skips the briefing, `?q=low` uses a lighter mesh and the 50 cm texture for slow GPUs, `?tex=4k` forces the 50 cm texture.

## Controls

| View | Mouse / trackpad | Keys |
|---|---|---|
| **Map** | Drag to move · scroll to zoom · double-click to centre · click to add a stop | `+` `−` |
| **3D** | Drag to rotate and tilt · Shift-drag or right-drag to move · scroll to zoom · double-click to centre | Arrow keys rotate and tilt · `+` `−` · `N` faces north |
| **Visor** | Drag to look around | |

The buttons at the bottom-right of the map do the same things.

## A five-minute demo

1. **Briefing** — the story, the regional map with Perseverance's real traverse, and the EVA area.
2. **Map** — tick the objectives. Compare the white straight line (red where impassable) with the cyan CAIRN route. Try the *Traversability*, *Geologic units* and *Minutes to shelter* layers.
3. **3D** and **Fly route** — the same plan on real HiRISE terrain.
4. **Start EVA** — the visor view walks the route. At Cheyava Falls the photo card shows what Perseverance saw there.
5. **The storm** — shortly after leaving the first stop the alert fires. Watch the amber route back to the rover, the dose-rate chart, and the dose avoided.
6. **Later sol** — re-plan the remaining stop.

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
        └──► web/public/data/jezero/   (32 MB, committed)
```

- **Sharp at every distance.** The 25 cm HiRISE image is sampled with Catmull-Rom filtering, lighting uses the full 1 m elevation gradient per pixel, and map layers are coloured on the GPU from the raw data grids, so they stay smooth instead of pixelated.
- **No edge of the world.** The walk area sits in 16 km of CTX terrain (20 m elevation, 6 m image). The two datasets differ by +0.3 m on average along the seam; that difference is blended out over 900 m and the images are tone-matched.
- **One renderer for 2D and 3D.** The map is the 3D terrain seen from straight above through a narrow lens, so routes and layers always line up and switching to 3D is a camera move.
- **Routing.** A\* over a 1025 × 1025 grid (2 m cells) minimises *walking energy × fall risk*. Energy uses the Minetti (2002) cost of walking on slopes with the real elevation of every step; loose sand and rough ground cost more; slopes above 25° are impassable.
- **The way home.** One Dijkstra pass from the rover stores the best route home from every grid point. The emergency re-route is then a lookup, and the same data draws the *Minutes to shelter* layer and the walk-back margin.
- **One measuring function.** `measurePath()` produces every number shown about a route, so the router, the budget, the chart and the simulation cannot disagree.

## Rebuilding the data

Only needed to change the site or the processing. Requires Python 3.11+.

```bash
cd data-pipeline
make setup     # virtual environment + dependencies
make fetch     # downloads from USGS, NASA PDS, mars.nasa.gov, DONKI, Mars Trek (several GB of range requests; resumable)
make build     # writes web/public/data/jezero/
```

`python progress.py --watch` shows download progress. DONKI uses `DEMO_KEY` unless `NASA_API_KEY` is set.

## What is real and what is assumed

| Real mission data | Assumptions and derived products |
|---|---|
| Terrain, imagery, thermal image, geologic units | Spacesuit and physiology numbers (mass, oxygen supply, speeds) — demo values, listed in *Model assumptions* |
| Stop positions and Perseverance's traverse | Loose-sand hazard — our own analysis of HiRISE and THEMIS data |
| Photos at each stop | Mars colour in the 3D view — a display tint; HiRISE is a grey image |
| Weather (Perseverance MEDA, sol 1215) | Rover shielding factor (0.5) |
| Radiation background and storm readings (Curiosity RAD) | The first ~13 hours of the storm's dose-rate curve (see below) |
| The eruption record and alert (NASA DONKI) | |

**The storm replay.** Curiosity's archived RAD data holds 2–4 hours of dosimetry per sol, so the start of the 20 May 2024 storm is not recorded. CAIRN shows the real readings as dots (background 5.4 µGy/h before the storm, 34.7 µGy/h at 19:08 UTC on 20 May) and fills the gap with a model: the tail is fitted to those readings and the peak is scaled so the total equals the 8,100 micrograys NASA reported. The chart labels measured and modelled values separately. Curiosity is in Gale crater, about 3,700 km from Jezero.

## Differences from the plan

- **Second target.** Three Forks is 6.7 km from Cheyava Falls — a rover drive, shown on the regional map. The second walking objective is Serpentine Rapids.
- **No CRISM mineral layer.** The layers are elevation, imagery, thermal, geology, sand and time-to-shelter.
- **THEMIS is displayed and used for sand detection**, not as a routing cost on its own: at ~100 m per pixel it is too coarse for a walking route.
- **Regional map** uses the USGS CTX mosaic bundled with the app; Mars Trek tiles supply the global locator.
- **After the storm** the EVA ends at the rover and the remaining stops are re-planned for a later sol, because RAD measured elevated dose rates for about two sols.

## Credits

Data: NASA/JPL-Caltech, University of Arizona, Arizona State University, MSSS, USGS Astrogeology, NASA PDS, NASA CCMC. Full list in [docs/data-sources.md](docs/data-sources.md).

Methods: Minetti et al. (2002), *J. Appl. Physiol.* 93:1039 (energy cost of walking on slopes); Tobler (1993) hiking function; Lejeune et al. (1998), *J. Exp. Biol.* 201:2071 (walking on sand).

This project is not affiliated with or endorsed by NASA.
