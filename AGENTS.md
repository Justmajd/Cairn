# CAIRN — technical guide for agents

**CAIRN** (Crew Assisted Integrated Route Navigator) is a web app for planning and simulating a
walking EVA (spacewalk on foot) on Mars, built from real NASA/USGS/JPL data. It is an entry for the
NASA Space Apps Challenge 2026 ("Interplanetary Survival Guide: Martian Map").

This file explains the whole project for someone (or some agent) about to change it: what each part
does, where it lives, how the pieces talk to each other, and the rules and traps learned the hard way.
User-facing docs are in `README.md` and `docs/`.

---

## 1. Quick start

```bash
cd web
npm ci                 # install
npm run dev:all        # Vite dev server (5173) + hab server (8787) in one terminal; Ctrl+C stops both
npm run dev:https      # same over https:// (phones need it for the microphone); local cert in web/.cert
npm test               # vitest (132 tests: model, routing, data, hab server end to end)
npm run typecheck      # app tsconfig + server tsconfig
npm run build          # tsc + vite build → web/dist (and dist/sw.js)
npm start              # build, then serve dist + hab on http://localhost:8787 (production-like)
npm run render-voice   # re-render the EVA voice clips (public/voice, committed) after changing phrases or stops
npm run fetch-speech   # download the Whisper model + ONNX runtime into public/models, public/ort
```

Requirements: Node 24 (the server runs `.ts` directly via Node's type stripping, see §8), a browser
with WebGL 2 and `DecompressionStream`.

Data pipeline (only needed to rebuild site data):

```bash
cd data-pipeline
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # or: make setup
make all            # Jezero: fetch + build + pack into web/public/data/jezero
make gale           # Gale Crater
make deuteronilus   # Deuteronilus Mensae
```

---

## 2. Repository layout

```
AGENTS.md            this file
README.md            user-facing overview, features, URL options, data notes
docs/                introduction.md, submission.md, data-sources.md (generated), plan.md (original plan), img/
data-pipeline/       Python: download official data, build per-site web data (see §4)
  config/            <site>.json (bounds, sources), stops*.json (POIs), provenance*.json (credits)
  raw/               ~2.4 GB of original downloads (gitignored; re-fetched by fetch_*.py)
web/                 the app (Vite + TypeScript + Three.js) and the hab server (Node)
  index.html         single HTML page for all three "pages" (menu, planner, Mission Control)
  vite.config.ts     build config, dev proxy to the hab, service-worker generation
  sw.template.js     offline service worker template
  public/data/       per-site data the app loads (~87 MB, in git) — see §4
  public/models, public/ort   speech model + runtime (gitignored; npm run fetch-speech)
  hab-data/          hab server's stored notebooks/voice notes/EVA records (gitignored)
  scripts/           dev-all.mjs (one-shot dev), cert.mjs (local HTTPS cert), fetch-speech.mjs, render-voice.mjs (Kokoro → public/voice/*.mp3)
  server/            hab server: index.ts (HTTP + WebSocket), room.ts (light-time relay), store.ts (disk)
  src/               the app (see §5)
```

---

## 3. The pages (`web/src/main.ts`)

One `index.html`, three modes chosen from the address:

| URL | Page | Loads |
|---|---|---|
| `?site=jezero` (default), `?menu=1` | **Main menu** (briefing) | only `site.json`, `context.json`, `sites.json` and two images; **no Three.js, no terrain** |
| `?site=…&skip=1`, `?demo=1`, or a hash with `stops=`/`add=` | **EVA planner** | `planner.ts` (lazy chunk) → Three.js, terrain, everything |
| `?view=mission&site=…` | **Mission Control** | `mission/dashboard.ts` (lazy chunk) |
| `?site=…&roam=1` (`&look=3d\|visor\|map`, `&crew=ev2`, `&dust=`/`&tau=`, `&emergency=leak@900`, `&q=`) | **Free roam** | `planner.ts` boots `roam/roam.ts` (its own lazy chunk) instead of `App`; no routing worker |

- The menu must stay light: never import planner code (Three.js, `app.ts`, `scene/*`) statically from
  `main.ts`. Nothing is prefetched (the user explicitly does not want preloading).
- Navigation between pages is a real page load through the "dust sweep" transition
  (`ui/dissolve.ts`: `dissolveTo(url)` closes a curtain, sets a sessionStorage flag, navigates; the next
  page's inline script in `index.html` shows the curtain immediately; `resumeDissolve()` opens it).
- The plan lives in the URL hash (`#stops=cheyava,serpentine&t=9.5&relay=1`, see `state/planLink.ts`)
  and is carried menu ↔ planner.
- Other URL options: `?q=low` (coarser mesh, 50 cm texture), `?tex=4k`, `?crew=ev2` (second astronaut).
- `index.html` has inline critical CSS (dark background, `color-scheme: dark`, loading text hidden until
  styles arrive). In dev, Vite injects CSS from JS after first paint — without this every page load
  flashed white. Keep it.

---

## 4. Data

### 4.1 Sites
`web/public/data/sites.json` lists the sites; each has a folder:

- **jezero** — Jezero Crater, Neretva Vallis / Bright Angel (Perseverance; Cheyava Falls "leopard spots").
- **gale** — Gale Crater, Mount Sharp boxwork (Curiosity).
- **deuteronilus** — Deuteronilus Mensae, buried glacier (no rover; near NASA's 2015 human landing
  Exploration Zones — never claim the site itself was proposed; it is ~174 km from the nearest zone centre).

Each walk area is a 2 × 2 km (Jezero: 2048 m) square: 1 m HiRISE elevation, 25 cm HiRISE image.

### 4.2 Files in a site folder

| File | What |
|---|---|
| `site.json` | `SiteMeta`: name, bounds, grid size, EVA date/UTC, rover name, model limits, texture list, story text |
| `pack.json` | maps original names → packed files and encodings (`gzip`, `delta8`, `delta16`, `image`) |
| `files.json` | every file with byte size (offline download list; also versions the data cache) |
| `height.u16.pk` | elevation grid (delta16 + gzip) |
| `slope/sand/effort/risk/geology/thermal/shield.u8.pk` | per-node grids (delta8 + gzip) |
| `minerals.rgba.pk` | CRISM olivine / Fe-Mg clay / carbonate strength + "imaged" mask |
| `region.u16.pk`, `region.json`, `region.webp` | the larger surrounding terrain shown around the walk area |
| `texture.webp`, `texture_8k.webp`, `relief.webp` | HiRISE orthoimage (50 cm start, 25 cm streamed later), shaded relief |
| `pois.json` | stops (`Poi`: id, name, kind shelter/objective/optional, x/y, dwell, photos, science text) |
| `geology.json`, `minerals.json` | geologic units legend, mineral legend |
| `rover.json` | the rover's real traverse (ghost rover replay) |
| `weather.json` | MEDA/REMS readings by time of day |
| `dust.json` | measured dust optical depth (τ) by sol (Mastcam-Z / Curiosity records) |
| `replay.json` | the 20 May 2024 solar particle event (RAD dose rates + DONKI CME/alert) |
| `context.json`, `context.webp`, `global.jpg` | main-menu regional map, places, facts, global locator |
| `panoramas.json`, `panoramas/*.jpg` | 360° views (real NASA/rover photos only), `_8k` versions |
| `images/*.jpg` | rover Navcam photos for stop cards (original NASA file names) |
| `provenance.json` | source and licence of every dataset (shown in About → Data sources) |

`web/public/data/materials/` holds CC0 close-up ground textures (Poly Haven) shared by all sites.

Loading: `data/loaders.ts` (`loadSite()` everything; `loadBriefing()` menu-only; `loadSites()`),
`data/pack.ts` (undelta), `data/grid.ts` (`TerrainGrid`: heights, slope, flags, sampling helpers).

### 4.3 Pipeline (`data-pipeline/`)
- `fetch_*.py` download (HiRISE DTM/ortho, CTX, CRISM, THEMIS, geology map, rover images/traverses).
  hirise-pds.lpl.arizona.edu resets parallel downloads: fetch one file at a time.
- `build_*.py` produce the web files: `build_site.py` (grids, sand, effort, risk, shield),
  `build_region.py`, `build_rover.py`, `build_replay.py`, `build_weather.py`, `build_dust.py`,
  `build_context.py`, `build_minerals.py`, `build_panoramas.py` / `build_nasa_panoramas.py`,
  `build_materials.py`, `build_provenance.py`, `build_docs.py` (writes docs/data-sources.md).
- `pack_web.py` packs grids (`.pk`), converts images to WebP and **rewrites the site JSONs to name the
  .webp files** — always re-run after rebuilding a site, and run the full make target (build_region
  needs texture.jpg).
- `CAIRN_SITE=<id>` selects `config/<id>.json`. `common.py` handles projections (Deuteronilus DTM CRS
  is eqc lat_ts=40, lon_0=18.51, R=3387887.658 — not the index's values).

---

## 5. The app (`web/src/`)

### 5.1 Entry and orchestration
- `main.ts` — fonts/styles, page choice (§3), menu boot.
- `planner.ts` — planner boot: checks WebGL 2, loads site data (`loadSite`), starts texture downloads
  early, builds `SceneView`, starts the routing worker (`Router.init` → return field), creates `App`,
  streams the 25 cm texture and close-up materials afterwards. Shows progress on `#loading`.
- `app.ts` (~3.5k lines) — `App`, the planner's brain: UI panels (left: route/stops, layers, notebook;
  right: plan / live EVA / debrief; bottom: elevation chart or EVA transport strip), plan computation,
  EVA simulation loop (`tick(dt)`), alerts, visor HUD, map-click menu, demo, hab link, exports.
  Phases: `planning` → `eva` → `summary`. View modes: map (`plan`), 3D (`orbit`), visor (`walk`), `fly`.

### 5.2 Route planning
- `routing/search.ts` — A* on the 8-connected grid minimising **risk-weighted walking energy**
  (Minetti metabolic cost × effort × risk); `buildReturnField()` is a Dijkstra from the rover giving
  the fastest way home from every node (used for "way home" times, the shelter layer and storm
  re-routes); `pathToShelter()`.
- `routing/worker.ts` + `routing/client.ts` (`Router`) — the same in a Web Worker.
- `routing/smooth.ts` (line-of-sight smoothing), `routing/median.ts` (geometric median for
  "park the rover closer"), `routing/heap.ts`.
- Stop order is chosen by CAIRN (shortest feasible tour); custom stops come from the map-click menu.

### 5.3 EVA model (`eva/`)
All suit/physiology numbers are **labelled demo assumptions** (`eva/params.ts`, shown in About → Model
assumptions). Never present them as NASA specs.
- `metabolic.ts` — Minetti cost of walking by grade, Mars gravity factor, suit penalty,
  Tobler-based suited walking speed; `MAX_GRADE`.
- `budget.ts` — segments (walk / dwell), O₂ litres, time, **walk-back margin** (O₂ left after walking
  home from the farthest point and keeping a 25 % reserve), safety checks (terrain, oxygen, time,
  shelter ≤ 30 min, radio, daylight).
- `radio.ts` — line-of-sight radio shadow from the rover antenna; coverage along the route; best
  relay mast position.
- `radiation.ts` — `RadiationModel`: background dose and the storm replay (RAD archive lacks the first
  ~13 h of the 20 May 2024 event → a labelled model scaled to NASA's 8,100 µGy).
- `sun.ts` — solar geometry, LMST, sun position; `shade.ts` — terrain shadow test.
- `sky.ts` — Mars sky ephemeris: Sun, **Earth**, Phobos, Deimos positions (JPL Keplerian elements, IAU
  rotation), **one-way light time Earth↔Mars** for the EVA date (validated against Mars24).
- `dust.ts` — dust optical depth τ → direct/diffuse light, visibility (3.912·H/τ, H = 11 km).
- `hab.ts` — "Where do we put the hab?" suitability map (flatness, walk time to stops, radio, shielding,
  ice at Deuteronilus).

### 5.3b Free roam (`roam/`, `eva/walker.ts`)
- `eva/walker.ts` — pure walking physics (tested in `walker.test.ts`): Mars g, traction limit μ·g·cos θ,
  Froude 0.5 walk→lope, ballistic jumps/bounds (no control in the air, no drag), sliding past the friction
  angle, landing impact → hard landing / fall / getting up, Minetti power → O₂, heart rate, breathing.
  Suit/body numbers are demo assumptions in `WALKER_NOTES` (shown in the roam Help dialog).
- `roam/roam.ts` — `Roam`: input (keys, pointer lock, drag, touch stick), the three looks (map north-up,
  3D chase, visor), HUD, lessons as toasts, rover collision, real Sun/Earth/moons clock, stop arrivals.
  Uses `SceneView.enterRoam/setRoamLook/setRoamCamera/add/groundAt`; in roam the view's `look` getter
  stands in for `mode` when deciding how to draw.
- `scene/models.ts` — the pressurised rover (shelter), stone cairns with survey flags (stops), `roundedBox`,
  `marsEnvironment` (reflections for the models; `scene.environment`). The view's sun light follows the real Sun.
- Missions: the planner's *Walk it yourself* (`app.ts` `walkItYourself`) saves a `RoamPlan` (`roam/plan.ts`, sessionStorage, keyed by site + plan hash) and opens `?roam=1#<plan>`; without a saved plan, roam routes the plan link itself with `Router`. `Roam` then draws the legs, numbers the stops, handles hold-E sampling (clock + O₂ at `workingW` for the dwell), off-route time, boarding at the rover, and the debrief (`finish`).
- Visor = inside the helmet (`Astronaut.firstPerson`: helmet hidden, arms forward, body follows the view); `SuitAudio.setPerspective` crossfades the inside bus (fan, breathing in a bubble comb, conducted steps, heart) and the outside bus (wind, faint low-passed steps).
- Falls and slides (`roam/avatar.ts`): no ragdoll — a pressurised suit is stiff. A fall topples as an inverted pendulum in Mars gravity (`toppleTime` in `eva/walker.ts`, tested) onto hands and knees; the last 4.2 s of `downT` (7 s, `getUpS`) are the suited get-up (sit back → one knee up → stand). The topple runs until the hands touch the terrain (`settle` rests the lowest contact point on the ground, `alignToGround` tilts to the slope); while down on ground steeper than the suit's grip the walker keeps sliding (`sliding`) and the get-up timer waits. A slide is a seated, feet-first pose fitted to the slope. All joints are eased each frame (`smoothJoints`, ~70 ms), so no state change snaps; `setAction` poses sampling and boarding.
- More roam modules: `roam/hab.ts` (`RoamHab`: plan, EVA start/end, frames with the full `pose`, log, Earth messages, EV2 `pose` relay), `roam/storm.ts` (`RoamStorm`: the 20 May 2024 replay via `RadiationModel`, alarm at 3× background, 30 min to shelter; tested), `roam/score.ts` (debrief checks, work O₂, hull gap, off-route distance; tested), `roam/settings.ts` (key bindings by action, reduce shake, captions; localStorage; tested), `roam/plan.ts` (the planner → roam handoff), `roam/field.ts` (`FieldWork`: field readings, finds and tasks from the site's own grids — CRISM ranks against the detections, geologic contacts, following the rover's traverse, soil tests, the most sheltered 1 % of ground, the relay mast; tested). In `roam.ts`, hold E away from a stop is a field reading (`useHold` → `reading`, 1 min of work), R stands up / packs the relay mast (`toggleMast`, 2 min; contact = rover shadow or the mast's own `radioShadow`), finds plant `makeSurveyFlag`s.
- Two players: EV2 opens roam with `&crew=ev2`, gets EV1's `PlanInfo` (`mode: "roam"`, `legs`, `o2PlannedL`) via `crewplan`, sees EV1 from the live frames' `pose`, sends its own `pose` (server relays it to EV1 as `buddy`). Suits: EV1 fern, EV2 amber (`Astronaut` accent).
- Mission Control: plans carry a `timeline` ([t, x, y]); `dashboard.ts` draws Earth's best guess there (the old "show the truth" toggle is gone). `ui/autonomy.ts` lists decisions made alone (planner summary and roam debrief). `ui/scenarios.ts`: scenario presets as links (main menu, About → Scenarios); the planner reads `?dust=`.
- `roam/avatar.ts` — articulated astronaut posed from the physics, blob shadow, instanced boot prints,
  dust (coarse ballistic + fine settling), map trail.  `roam/audio.ts` — synthesised suit sound (WebAudio).
- Debug: `window.cairn.roam` (`.state`, `.tick(dt)`); with the pane hidden, call `roam.tick` and
  `view.update` + `view.renderIfNeeded()` yourself.

### 5.4 Live EVA simulation (`replay/mission.ts`)
`Mission` advances along the planned segments on an EVA clock (speeds 10×/60×/120×/300×; pause;
background tabs stop the clock). Phases `eva → holding → to-shelter → sheltered → complete`. Handles the
storm alert (re-route to the rover via the return field), emergencies (suit leak doubles O₂ use,
twisted ankle halves speed), buddy (EV2) pose, dose accumulation.

### 5.5 3D scene (`scene/`)
- `view.ts` — `SceneView`: renderer, cameras and modes (map/3D/visor/fly), route lines (`Line2`),
  stop markers + beacons, CSS2D labels (`.label-layer`, its own z-index layer — Three.js sets a
  z-index per label by depth), astronaut/buddy suits, ghost rover, rover model, sky bodies, note pins,
  shelter-time layer, tile LOD. Renders on demand (`dirty`), not every frame.
- `terrain.ts` — terrain mesh + shader: regolith lighting, layers (image, traversability, to shelter,
  minerals, geology, thermal, slope, hab site…), dust (`uDust`), sky shader. The shader is at WebGL's
  16-sampler limit: slope/sand/effort/risk are packed in one RGBA texture.
- `rocks.ts` (instanced rocks), `post.ts` (post effects; custom shaders write linear via `uLinearOut`).
- Do **not** create/destroy WebGL contexts repeatedly (Chrome blocks the page); the panorama reuses one
  renderer.

### 5.6 UI modules (`ui/`)
`briefing.ts` (main menu, also an overlay in the planner via About → Mission briefing),
`charts.ts` (elevation profile, dose chart), `cuecard.ts` (printable one-page plan), `export.ts`
(KML / GeoJSON for Google Earth and GIS, copy plan link), `demo.ts` (2-minute guided demo), `panorama.ts` (360° viewer), `notebook.ts`
(field notebook: localStorage + IndexedDB audio, synced to the hab), `noteEditor.ts` (note dialog,
voice recording, "Turn into text", MP3), `voiceExport.ts` (MP3 via lamejs, ZIP via fflate),
`transcribe.ts` + `transcribeWorker.ts` (Whisper tiny.en via transformers.js, on device; model from the
hab if `npm run fetch-speech` was run, else Hugging Face), `voice.ts` (spoken directions: `Voice` plays pre-rendered Kokoro clips through Web Audio, falling back to the browser's speechSynthesis; `RouteCallouts` speaks only on change — turns, hazards, 100 m / 25 m; tested), `voiceLines.ts` (every spoken line as clip ids + text, and the full `vocabulary`; imported by `scripts/render-voice.mjs`, so add new phrases there and re-render; tested), `about.ts`
(data sources / assumptions), `offline.ts` (service worker + "Use offline" download), `motion.ts`
(show/hide animations), `dissolve.ts` (page transition), `fx.ts` (text scramble, count-up, pointer
glow, `playOnce`), `dom.ts` (helpers, formatters), `icons.ts` (Lucide).

### 5.7 State
`state/planLink.ts` (plan ↔ URL hash), `state/store.ts`. Undo/redo uses browser history of the hash.

---

## 6. Features (what exists, where)

| Feature | Main code |
|---|---|
| Safe route to chosen stops, straight-line comparison, steep/sand/radio warnings | `routing/*`, `eva/budget.ts`, `app.ts` |
| Oxygen / time / walk-back margin / safety chips | `eva/budget.ts`, `app.ts` (right panel) |
| Map layers (traversability, to shelter, minerals, geology, thermal, slope, hab site…) | `scene/terrain.ts`, `app.ts` LAYERS |
| 3D terrain, visor (first person) with HUD, fly-through | `scene/view.ts`, `app.ts` renderHud |
| Real Sun/shadows by date & time, daylight window, season | `eva/sun.ts`, `eva/shade.ts` |
| Earth in the sky + real radio delay | `eva/sky.ts` |
| Radio contact + relay mast | `eva/radio.ts` |
| Solar storm replay (20 May 2024), auto re-route to shelter, dose avoided | `replay/mission.ts`, `eva/radiation.ts` |
| Emergencies (suit leak, twisted ankle) | `replay/mission.ts` |
| Dust storm mode with real τ by sol | `eva/dust.ts`, `scene/terrain.ts` |
| Ghost of the real rover | `scene/view.ts`, `rover.json` |
| Hab-site suitability map | `eva/hab.ts` |
| Field notebook (geotagged notes, samples, voice notes, MP3, speech-to-text) | `ui/notebook.ts`, `ui/noteEditor.ts`, `ui/transcribe*.ts` |
| 360° panoramas at stops | `ui/panorama.ts` |
| Exports (cue card, KML/GeoJSON, plan link, EVA log as Markdown) | `ui/cuecard.ts`, `ui/export.ts` |
| Guided demo | `ui/demo.ts` |
| Offline mode (PWA) | `ui/offline.ts`, `sw.template.js` |
| Mission Control (Earth, one light time late) | `mission/dashboard.ts`, `server/room.ts` |
| Free roam: walk anywhere with real Mars-gravity physics (map / 3D / visor) | `roam/*`, `eva/walker.ts` |
| Free-roam missions: samples from rover photos, storm, emergencies, dust, two players, Earth messages, debrief | `roam/*` |
| Free-roam field work: readings, mineral hunt, geologic contacts, rover's route, soil tests, sheltered ground, relay mast | `roam/field.ts`, `roam/roam.ts` |
| Earth's best guess in Mission Control; autonomy debrief; scenario presets | `mission/dashboard.ts`, `ui/autonomy.ts`, `ui/scenarios.ts` |
| Two astronauts on two devices (EV1 + EV2) | `app.ts` (`member`), `server/index.ts` |
| Earth sends a revised plan; crew accepts/declines | `server/room.ts` (`say` with change, `reply`) |
| Replay of past EVAs in Mission Control | `server/store.ts` (EVA records), `dashboard.ts` |
| Live EVA card on the main menu (any site → that EVA's Mission Control / Join as EV2); Mission Control points to a live EVA elsewhere | `hab/live.ts` (`/api/live`, no `HabLink`, keeps the menu light), `ui/briefing.ts` `watchLive`, `dashboard.ts` |

---

## 7. Design system

Visual language after bracken.sh (`styles/theme.css`, tokens in `styles/main.css :root`):
- Colours: background `#121110`, text `#e4e2df`, steel `#9fb4c6` (lines, labels), **one accent: fern
  `#c6f432`** (actions, the route line, beacons, "good"). Amber/red only for warnings.
- Type: Geist Sans (text), Geist Mono (numbers, `// SECTION` labels in spaced capitals), Tektur
  (headlines, capitals). Fonts are self-hosted via `@fontsource`.
- Components: glass panels with a lit top edge, pill buttons, HUD corner brackets on readout tiles
  (`::after` gradients), mono HUD chips.
- Motion: `--ease-glide` for arrivals, `--ease-spring` for touch; only transform/opacity/filter; all off
  with `prefers-reduced-motion`.
- Rules learned: no animations on the loading screen (main thread is busy, they never start); briefing
  entrance animations use fill `backwards` (held animations kept GPU layers and made scrolling flicker);
  no fixed/blended layers over the scrolling menu; `body:has(> #briefing:not([hidden])) #app` is hidden.
- Styles: `main.css` (layout, components), `motion.css` (transitions, starfield), `theme.css` (the
  bracken layer), `mission.css` (Mission Control).

---

## 8. Hab server (`web/server/`) and Mission Control

Node 24 runs the `.ts` files directly (type stripping). Constraints: no TypeScript-only runtime syntax
(no constructor parameter properties, no enums); imports use `.ts` extensions; checked by
`tsconfig.server.json`.

- `index.ts` — static serving of `web/dist` (gzip, ETag, immutable assets, path safety); REST
  `/api/health`, `/api/notebook/<site>[/<id>]` (GET/PUT/DELETE), `/api/audio/<site>/<id>` (voice notes),
  `/api/evas/<site>` (finished EVA records), `/api/live` (EVAs under way on every site, `LiveEva`;
  rooms of running EVAs are restored at startup so it lists them before anyone reconnects); WebSocket `/hab` with one room per site; persists live
  state to `live.json`; optional HTTPS (`HTTPS=1`, cert from `scripts/cert.mjs`).
  Env: `PORT` (8787), `HOST`, `CAIRN_DATA` (hab-data dir), `CAIRN_DIST`.
- **Crew sessions**: one `Room` per session, not per site. EV1 opens a session (`hab/session.ts` `sessionFor`: `?s=<site>-<random>` written into the address); EV2 and Mission Control join the one their `?s=` names, or the site's newest open one (`newestSession`). Hello carries `session`; the hab answers `joined`. `/api/live` lists every open session (EV1 connected, or an EVA under way) newest first with `session`, `running`, `route`; the main menu (`briefing.ts` `watchLive`) shows them under the planner buttons (where the old Mission Control / Join as EV2 buttons were) with Join as EV2 / Mission Control per session. Live state is saved per session (`live-<session>.json`; the site's default session keeps `live.json`); empty sessions close after 2 min (1 h with an EVA marked running). The notebook stays per site.
- `room.ts` — `Room`: the **light-time relay**. Telemetry frames, log lines and notes from the crew
  reach Mission Control one light time later *on the EVA clock*; Earth's messages reach the crew one
  light time after sending. Resumes an EVA with the same id after a restart; notes from the current
  EVA are held until due (`noteDue`); keeps thinned frames for replay.
- `store.ts` — notebooks, audio, EVA records on disk.
- Protocol: `src/hab/protocol.ts` (shared types: `ClientMsg`, `ServerMsg`, `Frame`, `PlanInfo`,
  `NoteRecord`, `EarthMessage`, `EvaRecord`). Client: `src/hab/link.ts` (`HabLink`, reconnecting
  WebSocket; `habApi`).
- EV2 (`?crew=ev2`): rebuilds EV1's plan from its hash, follows EV1's EVA clock live (no delay — both on
  Mars), sees EV1's suit; only EV1 can start/end the EVA.
- Mission Control (`mission/dashboard.ts`): live vs replay state, clock interpolated 0.3 s behind for
  smooth motion, "sim paused / tab hidden" notices, crew log, notebook (with voice notes), messages,
  revised-plan editor on the map, history + replay timeline. New list items animate with a
  negative-delay trick so redraws (4×/s) don't restart them.
- Dev: Vite proxies `/api` and `/hab` to `CAIRN_HAB` (default `localhost:8787`). A scratch hab for
  testing: `PORT=8799 CAIRN_DATA=/tmp/x node server/index.ts` and `CAIRN_HAB=localhost:8799 npx vite`.
- Deploy: Railway, one service from the repository root (root `railway.json` + a root `package.json`
  whose `build`/`start` run `web/`'s `npm ci --include=dev && npm run build:deploy` and
  `node server/index.ts`; health `/api/health`). Root Directory must stay empty — Railpack needs a
  `package.json` where it starts. Needs a volume with `CAIRN_DATA` pointing at it, and
  must stay at **one replica** (rooms are in memory). Steps in README → "Deploy on Railway".

---

## 9. Offline / service worker

`vite.config.ts` generates `dist/sw.js` from `sw.template.js`. It **precaches only the main menu's
files** (entry chunk + its static imports + CSS + Latin WOFF2 fonts + icons). Everything else (planner,
Three.js, Mission Control, speech engine, site data) is cached when first used. Site data goes into a
cache versioned by all sites' `files.json`. `/api/`, `/models/`, `/ort/` are never cached. The SW only
runs in production builds.

---

## 10. Testing

- `npm test` — vitest: `eva/*.test.ts` (model), `routing/*.test.ts`, `data/site.test.ts` (real site
  data sanity), `replay/mission.test.ts`, `state/planLink.test.ts`, `server/room.test.ts` (light-time
  logic), `server/hab.test.ts` (spawns the real server, WebSocket clients end to end).
- Manual/browser checks: the in-app browser pane is often hidden or throttled, so rAF/timers and load
  timings are unreliable there; drive the planner from the console via `window.cairn` (`{ app, view,
  site, field }`) — e.g. `app.tick()` / `view.update()`.
- Editing `app.ts` while an EVA runs in a dev tab hot-reloads the page and ends that EVA (expected).

---

## 11. Rules and conventions (from the project owner)

- **Commits and pushes are made as the user only — never add Claude/AI co-author lines or attribution.**
- **Do not push unless the user asks.** The project lives in `~/Documents/cairn`; its GitHub repo
  `Justmajd/Cairn` is private and, as of 2026-11-14, empty on purpose.
- Pushing from this Mac: git's default HTTP/2 uploads to GitHub drop large packs. Use
  `git -c http.version=HTTP/1.1 -c http.postBuffer=524288000 push …` and push in steps of ≤ 40 MB
  (`git push origin <sha>:refs/heads/main`, oldest first).
- Long-running commands go to the background; don't poll them.
- Data honesty: every number and image comes from an official source listed in `provenance.json`, or is
  labelled as a CAIRN derivation or a demo assumption. Panoramas are real photos only (terrain-rendered
  or composite panoramas were rejected). MMGIS mosaics return 403 to scripts — don't bypass.
- Keep the main menu light (§3) and avoid white first frames (§3).
- Writing style in the UI: plain, concrete English; units always shown; no hype.

---

## 12. Ideas held for later (build only when asked)

Done in November 2026 (PRs #6–#20): scenario presets, the light-time demo, Earth's best guess and the
autonomy debrief below, plus free-roam missions with Mission Control, two players, storms, emergencies,
dust, sample choices, tests, performance, accessibility. Kept for reference:

When the user says **"add the new features we talked about"**, build:
1. **Scenario presets** — one tap sets up a story (clear morning at Cheyava Falls; 20 May 2024 storm;
   Gale in the 2018 global dust storm; two-person EVA with Earth 22 min away).
2. **Updated 2-minute demo** telling the light-time story (storm hits, crew turns back, Earth's
   "weather looks good" arrives too late), including Mission Control, EV2, dust, notebook.
3. **Earth's best guess** — a faint Mission Control marker where Earth predicts the crew is from the
   plan, replacing the "show the truth" checkbox.
4. **Autonomy debrief** — after each EVA, one card: decisions the crew made alone, when Earth heard,
   when its first answer could arrive.

Also still open: a VR/AR (WebXR) walk at true scale (panoramas are already 8K, VR-ready).
