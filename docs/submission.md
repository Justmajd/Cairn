# CAIRN — Space Apps 2026 submission draft

A starting point for the project page of the **Interplanetary Survival Guide: Martian Map** challenge. Text in [brackets] still needs the team's input; numbers come from the current build (Jezero and Gale default plans).

---

## Project name

**CAIRN — Crew Assisted Integrated Route Navigator**

## High-level summary

CAIRN plans safe walks (EVAs) for the first astronauts on Mars, on real NASA terrain. Pick the science stops; CAIRN finds the safest walking route over 1 m HiRISE elevation, budgets oxygen with a walk-back margin, checks radiation, daylight and radio contact with the rover, and suggests where to stand up a radio relay or park the rover. During the walk it guides the crew in a visor view, replays the real 20 May 2024 solar storm and lets the crew practise a suit leak or a twisted ankle, finding the quickest safe way home each time. It runs in any browser, works offline, and prints a one-page cue card — at Jezero and Gale craters, where Perseverance and Curiosity show what the crew would see, and at Deuteronilus Mensae, a buried glacier proposed at NASA's 2015 workshop on landing sites for the first humans.

## Links

- Demo video: [link]
- Live app: [link — GitHub Pages after the repository is public]
- Code: [link to the public repository]

## What it does

1. **Maps the walk area from real data** — HiRISE elevation (1 m) and imagery (25 cm) in up to 16 km of surrounding terrain, CRISM minerals, THEMIS night-time thermal, the USGS geologic map, loose sand, terrain sky-shielding, minutes to shelter and radio line of sight.
2. **Finds the safest route**, minimising walking energy × fall risk, and compares it with the straight line, which crosses ground too steep to walk at both sites (Jezero: 76 m over 25°).
3. **Budgets the EVA**: distance, time, oxygen against a 25% reserve and the walk home from the farthest point, radiation dose, and the real Sun for the chosen sol — with a row of safety checks (terrain, oxygen, time, shelter, radio, daylight).
4. **Checks radio contact.** On Jezero's default walk the crew has line of sight to the rover for 85% of the walk and none at all during 30 minutes of science at Serpentine Rapids; CAIRN finds the spot on the route where a 2.5 m relay mast restores 100%.
5. **Moves the rover.** Park it anywhere (or let CAIRN pick the flat spot closest to the stops) and the way home from every point is recomputed in about 0.4 s — on Jezero this halves the walk.
6. **Guides the walk** in a first-person visor with compass, oxygen, dose, weather, spoken directions, radio and low-sun warnings, and an EVA log at the end.
7. **Rehearses emergencies**: the real May 2024 solar particle event (CAIRN re-routes to the rover and reports the dose avoided), a suit leak (double oxygen use) and a twisted ankle (half speed).
8. **Checks itself against the rovers**: 68% of Perseverance's drive at Jezero (70% of Curiosity's at Gale) is on ground CAIRN rates easy or moderate, against 45% (41%) of the area.
9. **Goes where the crew goes**: installable, works offline (a whole site is about 19–27 MB), phone and tablet layouts, a printable cue card, KML/GeoJSON export in Mars coordinates, and a shareable link that encodes the whole plan.

## How it addresses the challenge

The challenge asks for a map that helps people survive on Mars. CAIRN answers the first practical question a crew faces outside the habitat — *where can I walk, and will I get back?* — with the checks that keep a walker alive: terrain they can walk, oxygen for the way home, shelter from radiation, daylight, and contact with the rover. Every number comes from real mission data or a labelled assumption, and the tool keeps working with no connection to Earth.

## NASA data used

| Data | Mission · instrument | Used for |
|---|---|---|
| HiRISE DTMs (1 m) and orthoimages (25 cm) | Mars Reconnaissance Orbiter · HiRISE | Terrain, slopes, routing grid, surface images, radio line of sight, shade (three sites, incl. DTEEC_033653_2225_033363_2225 'Ice-rich lobate debris apron') |
| CTX mosaics | Mars Reconnaissance Orbiter · Context Camera | Surrounding terrain and regional map (Jezero) |
| CRISM spectral parameters | Mars Reconnaissance Orbiter · CRISM | Mineral layer (Jezero) |
| THEMIS night IR | 2001 Mars Odyssey · THEMIS | Thermal layer, loose-sand detection (Jezero) |
| Rover traverses and positions | Mars 2020 Perseverance, MSL Curiosity | Stop positions, the rover check |
| Raw images and Navcam camera models | Mars 2020 Perseverance, MSL Curiosity | Photos at each stop; 360° panoramas stitched at Gale |
| MEDA and REMS | Mars 2020 Perseverance, MSL Curiosity | Weather during the walk |
| RAD dose rates | MSL Curiosity · Radiation Assessment Detector | Radiation background and the 20 May 2024 storm replay |
| DONKI | NASA CCMC | The real space-weather alert for the storm |
| Viking MDIM 2.1 | Viking Orbiters (via NASA Mars Trek) | Global locator map |

Every layer is listed with its product ID and link in the app (About → Data sources) and in [data-sources.md](data-sources.md).

## Other data and partners

USGS Astrogeology Science Center (Mars 2020 TRN mosaics, geologic map SIM 3464), Arizona State University (THEMIS), University of Arizona (HiRISE), NASA Planetary Data System nodes (Geosciences, Atmospheres, PPI).

## Tools

TypeScript, Three.js (WebGL 2), Vite, Web Workers, a service worker for offline use, Vitest (tests on the real site data); Python (NumPy, rasterio, SciPy, Pillow) for the data pipeline.

## Assumptions (labelled in the app)

Suit and physiology numbers (mass, oxygen supply, metabolic rates), the rover's shielding factor, antenna and relay mast heights, the 8° low-sun limit and the 30-minute shelter aim are demo assumptions, listed with their basis under About → Suit and model assumptions. The first ~13 hours of the 20 May 2024 storm are not in the RAD archive and are filled by a model scaled to NASA's reported total, labelled as such.

## References

- Minetti et al. (2002), *J. Appl. Physiol.* 93:1039 — energy cost of walking on slopes.
- Tobler (1993) — hiking speed function.
- Lejeune et al. (1998), *J. Exp. Biol.* 201:2071 — walking on sand.
- Allison & McEwen (2000), *Planet. Space Sci.* 48:215 — Mars24 sun position.
- NASA/JPL (2024) — Curiosity RAD and the May 2024 solar storm (8,100 micrograys).

## [Use of AI tools]

[Fill in according to the 2026 Space Apps rules if they ask teams to disclose AI assistance.]
