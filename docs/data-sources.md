# CAIRN — Data Sources

Every map layer, photo and reading in CAIRN, with the mission, instrument, product and provider it came from.
This file is generated from [`data-pipeline/config/provenance.json`](../data-pipeline/config/provenance.json), which also feeds the *Data sources* panel in the app.

**12 datasets.** Data types covered: optical, topographic, thermal, geologic, atmospheric, radiation, space weather, rover localisation.

## Summary

| Layer | Data type | Mission · instrument | Provider |
|---|---|---|---|
| Terrain elevation (3D surface, slope, routing grid) | Topographic | Mars Reconnaissance Orbiter · HiRISE stereo | USGS Astrogeology Science Center |
| Surface image (ground texture) | Optical | Mars Reconnaissance Orbiter · HiRISE | USGS Astrogeology Science Center |
| Night-time thermal infrared | Thermal | 2001 Mars Odyssey · THEMIS | USGS Astrogeology Science Center / Arizona State University |
| Geologic units | Geologic | USGS–NASA Planetary Geologic Mapping Program · Map compiled from CTX, HiRISE, THEMIS and HRSC data | U.S. Geological Survey |
| Loose sand hazard | Derived (optical + topographic + thermal) | Mars Reconnaissance Orbiter + 2001 Mars Odyssey · HiRISE image, HiRISE DTM, THEMIS night IR | CAIRN team (derived product) |
| Surrounding terrain and regional map | Optical + topographic | Mars Reconnaissance Orbiter · Context Camera (CTX) | USGS Astrogeology Science Center |
| Global Mars map | Optical | Viking Orbiters · Viking MDIM 2.1 colour mosaic | NASA/JPL Solar System Treks (Mars Trek) |
| Perseverance traverse and stop positions | Rover localisation | Mars 2020 Perseverance · Rover localisation (waypoints) | NASA/JPL-Caltech (mars.nasa.gov) |
| Ground photographs at each stop | Optical (surface) | Mars 2020 Perseverance · Navcam, Mastcam-Z, SHERLOC WATSON | NASA/JPL-Caltech (mars.nasa.gov) |
| Surface weather | Atmospheric | Mars 2020 Perseverance · MEDA (pressure sensor, thermal infrared sensor) | NASA Planetary Data System, Atmospheres Node |
| Surface radiation dose rate | Radiation | Mars Science Laboratory Curiosity · Radiation Assessment Detector (RAD) | NASA Planetary Data System, Planetary Plasma Interactions Node |
| Space-weather alert | Space weather | NASA Community Coordinated Modeling Center · DONKI (Space Weather Database Of Notifications, Knowledge, Information) | NASA CCMC / Moon to Mars Space Weather Analysis Office |

## Details

### Terrain elevation (3D surface, slope, routing grid)

- **Data type:** Topographic
- **Mission / instrument:** Mars Reconnaissance Orbiter — HiRISE stereo
- **Product:** Mars 2020 Terrain Relative Navigation HiRISE DTM mosaic, 1 m/post (JEZ_hirise_soc_006_DTM_MOLAtopography_DeltaGeoid_1m_Eqc_latTs0_lon0_blend40)
- **Provider:** USGS Astrogeology Science Center
- **Credit:** NASA/JPL-Caltech/University of Arizona/USGS
- **Used for:** 3D terrain mesh (2 m), per-pixel relief lighting (full 1 m), slope map, metabolic cost of every step, impassable-ground mask
- **Link:** <https://astrogeology.usgs.gov/search/map/mars_2020_terrain_relative_navigation_hirise_dtm_mosaic>

### Surface image (ground texture)

- **Data type:** Optical
- **Mission / instrument:** Mars Reconnaissance Orbiter — HiRISE
- **Product:** Mars 2020 Terrain Relative Navigation HiRISE orthorectified image mosaic, 25 cm/px (JEZ_hirise_soc_006_orthoMosaic_25cm_Eqc_latTs0_lon0_first)
- **Provider:** USGS Astrogeology Science Center
- **Credit:** NASA/JPL-Caltech/University of Arizona/USGS
- **Used for:** Ground texture at the full 25 cm resolution (50 cm on GPUs limited to 4096 px textures), sand-ripple detection
- **Link:** <https://astrogeology.usgs.gov/search/map/mars_2020_terrain_relative_navigation_hirise_orthorectified_image_mosaic>
- **Note:** HiRISE is a single-band (grey) image here; the Mars colour in the 3D view is a display tint, not measured colour.

### Night-time thermal infrared

- **Data type:** Thermal
- **Mission / instrument:** 2001 Mars Odyssey — THEMIS
- **Product:** THEMIS Night IR controlled mosaic of the Nili Planum / Jezero region, ~100 m/px (distributed with USGS SIM 3464)
- **Provider:** USGS Astrogeology Science Center / Arizona State University
- **Credit:** NASA/JPL-Caltech/Arizona State University/USGS
- **Used for:** Thermal layer; fused with HiRISE to flag loose sand (sand is cold at night, bedrock stays warm)
- **Link:** <https://pubs.usgs.gov/sim/3464/>
- **Note:** Native resolution is ~100 m, so this layer is smooth at walking scale.

### Geologic units

- **Data type:** Geologic
- **Mission / instrument:** USGS–NASA Planetary Geologic Mapping Program — Map compiled from CTX, HiRISE, THEMIS and HRSC data
- **Product:** USGS Scientific Investigations Map 3464 — Geologic map of Jezero crater and the Nili Planum region, Mars (Sun & Stack, 2020), 1:75,000
- **Provider:** U.S. Geological Survey
- **Credit:** Sun, V.Z., and Stack, K.M., 2020, USGS SIM 3464
- **Used for:** Geology layer and the rock unit shown under the cursor and at each stop
- **Link:** <https://pubs.usgs.gov/publication/sim3464>
- **Note:** Mapped at 1:75,000, so unit boundaries are approximate at walking scale.

### Loose sand hazard

- **Data type:** Derived (optical + topographic + thermal)
- **Mission / instrument:** Mars Reconnaissance Orbiter + 2001 Mars Odyssey — HiRISE image, HiRISE DTM, THEMIS night IR
- **Product:** Computed by CAIRN (data-pipeline/build_site.py): ripple texture in the HiRISE image and DTM, weighted by THEMIS night-time temperature
- **Provider:** CAIRN team (derived product)
- **Credit:** Derived from NASA/JPL-Caltech/University of Arizona/ASU/USGS data
- **Used for:** Extra walking energy on sand (×2.1 at full strength) and slower walking speed
- **Link:** <https://github.com/Justmajd/cairn-demo/blob/main/data-pipeline/build_site.py>
- **Note:** This is our own analysis, not an official NASA product.

### Surrounding terrain and regional map

- **Data type:** Optical + topographic
- **Mission / instrument:** Mars Reconnaissance Orbiter — Context Camera (CTX)
- **Product:** Mars 2020 Terrain Relative Navigation CTX DTM mosaic, 20 m/post (JEZ_ctx_B_soc_008_DTM_MOLAtopography_DeltaGeoid_20m_Eqc_latTs0_lon0) and orthorectified image mosaic, 6 m/px (JEZ_ctx_B_soc_008_orthoMosaic_6m_Eqc_latTs0_lon0)
- **Provider:** USGS Astrogeology Science Center
- **Credit:** NASA/JPL-Caltech/MSSS/USGS
- **Used for:** The 16 km of terrain around the walk area in the 3D view (tone-matched and height-blended to the HiRISE data at the seam), and the regional map in the mission briefing
- **Link:** <https://astrogeology.usgs.gov/search/map/mars_2020_terrain_relative_navigation_context_camera_orthorectified_image_mosaic>

### Global Mars map

- **Data type:** Optical
- **Mission / instrument:** Viking Orbiters — Viking MDIM 2.1 colour mosaic
- **Product:** Mars_Viking_MDIM21_ClrMosaic_global_232m, WMTS tiles
- **Provider:** NASA/JPL Solar System Treks (Mars Trek)
- **Credit:** NASA/JPL-Caltech/USGS
- **Used for:** Global locator in the mission briefing
- **Link:** <https://trek.nasa.gov/mars/>

### Perseverance traverse and stop positions

- **Data type:** Rover localisation
- **Mission / instrument:** Mars 2020 Perseverance — Rover localisation (waypoints)
- **Product:** Mars 2020 MMGIS waypoint layer (M20_waypoints.json)
- **Provider:** NASA/JPL-Caltech (mars.nasa.gov)
- **Credit:** NASA/JPL-Caltech
- **Used for:** Position of every EVA stop, the rover track on the map, and the regional traverse
- **Link:** <https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json>

### Ground photographs at each stop

- **Data type:** Optical (surface)
- **Mission / instrument:** Mars 2020 Perseverance — Navcam, Mastcam-Z, SHERLOC WATSON
- **Product:** Mars 2020 raw images feed — images taken at the same rover positions as the EVA stops
- **Provider:** NASA/JPL-Caltech (mars.nasa.gov)
- **Credit:** NASA/JPL-Caltech (Mastcam-Z: NASA/JPL-Caltech/ASU)
- **Used for:** "What you will see" photos when planning and on arrival
- **Link:** <https://mars.nasa.gov/mars2020/multimedia/raw-images/>

### Surface weather

- **Data type:** Atmospheric
- **Mission / instrument:** Mars 2020 Perseverance — MEDA (pressure sensor, thermal infrared sensor)
- **Product:** MEDA derived pressure and calibrated TIRS air / ground temperature, sol 1215
- **Provider:** NASA Planetary Data System, Atmospheres Node
- **Credit:** NASA/JPL-Caltech/CAB (CSIC-INTA)
- **Used for:** Pressure, air temperature and ground temperature readouts during the EVA
- **Link:** <https://atmos.nmsu.edu/PDS/data/PDS4/Mars2020/mars2020_meda/>

### Surface radiation dose rate

- **Data type:** Radiation
- **Mission / instrument:** Mars Science Laboratory Curiosity — Radiation Assessment Detector (RAD)
- **Product:** MSL-M-RAD-3-RDR-V1.0, sols 4189–4194 (18–24 May 2024), detector E dose rate
- **Provider:** NASA Planetary Data System, Planetary Plasma Interactions Node
- **Credit:** NASA/JPL-Caltech/SwRI
- **Used for:** Background dose rate and the measured points of the storm replay
- **Link:** <https://pds-ppi.igpp.ucla.edu/data/MSL-M-RAD-3-RDR-V1.0/>
- **Note:** Curiosity is in Gale crater, about 3,700 km from Jezero. The archive holds 2–4 hours of dosimetry per sol, so the first ~13 hours of the 20 May 2024 storm are not in it. That gap is filled by a clearly labelled model scaled to NASA's reported total of 8,100 micrograys.

### Space-weather alert

- **Data type:** Space weather
- **Mission / instrument:** NASA Community Coordinated Modeling Center — DONKI (Space Weather Database Of Notifications, Knowledge, Information)
- **Product:** CME activity 2024-05-20T05:36:00-CME-001 and notification 20240520-AL-001
- **Provider:** NASA CCMC / Moon to Mars Space Weather Analysis Office
- **Credit:** NASA CCMC DONKI
- **Used for:** The real eruption record and alert text shown in the storm replay
- **Link:** <https://ccmc.gsfc.nasa.gov/tools/DONKI/>

## The EVA area

- **Site:** Jezero Crater — Neretva Vallis / Bright Angel
- **Bounds:** 18.475438°N to 18.509989°N, 77.288897°E to 77.323448°E (2.048 km square)
- **Projection:** Equirectangular, Mars 2000 sphere (R = 3,396,190 m), lat_ts = 0, lon0 = 0
- **Routing grid:** 1025 × 1025 nodes, 2 m apart
- **Terrain relief in the area:** 423 m; median slope 9.5°; 3.2% steeper than the 25° walking limit

## EVA stops

Positions are Perseverance's own, from the MMGIS waypoint layer (RMC = site_drive). The rover/shelter is moved to the flattest point within 12 m of the waypoint.

| Stop | Rover position (RMC) | Sols | Longitude °E | Latitude °N | Photos |
|---|---|---|---|---|---|
| Pressurised rover | 52_2638 | 1150–1154 | 77.31359 | 18.490711 | 3 |
| Cheyava Falls · Bright Angel | 56_0 | 1210–1219 | 77.305191 | 18.497484 | 4 |
| Serpentine Rapids | 56_3368 | 1230–1244 | 77.30104 | 18.491903 | 3 |
| Mount Washburn boulder field | 52_5032 | 1168–1169 | 77.313807 | 18.496073 | 2 |
| Neretva Vallis floor | 52_6980 | 1171–1173 | 77.308325 | 18.495201 | 3 |

### Photos used

All from the Mars 2020 raw-image feed. Credit: NASA/JPL-Caltech (Mastcam-Z: NASA/JPL-Caltech/ASU).

| Stop | Camera | Sol | Image ID |
|---|---|---|---|
| Rover | Navigation Camera (left) | 1151 | [NLF_1151_0769112624_722ECM_N0522638NCAM14150_01_195J](https://mars.nasa.gov/mars2020/multimedia/raw-images/NLF_1151_0769112624_722ECM_N0522638NCAM14150_01_195J) |
| Rover | Mastcam-Z (left) | 1155 | [ZL0_1155_0769468584_831EBY_N0522644ZCAM09193_0480LMJ](https://mars.nasa.gov/mars2020/multimedia/raw-images/ZL0_1155_0769468584_831EBY_N0522644ZCAM09193_0480LMJ) |
| Rover | Navigation Camera (left) | 1154 | [NLF_1154_0769389547_755ECM_N0522644NCAM03154_09_095J](https://mars.nasa.gov/mars2020/multimedia/raw-images/NLF_1154_0769389547_755ECM_N0522644NCAM03154_09_095J) |
| Cheyava Falls | Navigation Camera (left) | 1211 | [NLF_1211_0774440401_066ECM_N0560000NCAM15210_04_195J](https://mars.nasa.gov/mars2020/multimedia/raw-images/NLF_1211_0774440401_066ECM_N0560000NCAM15210_04_195J) |
| Cheyava Falls | Navigation Camera (left) | 1210 | [NLF_1210_0774361908_130ECM_N0560000NCAM03210_10_195J](https://mars.nasa.gov/mars2020/multimedia/raw-images/NLF_1210_0774361908_130ECM_N0560000NCAM03210_10_195J) |
| Cheyava Falls | Mastcam-Z (left) | 1217 | [ZL0_1217_0774980058_772EBY_N0560000ZCAM09264_1100LMJ](https://mars.nasa.gov/mars2020/multimedia/raw-images/ZL0_1217_0774980058_772EBY_N0560000ZCAM09264_1100LMJ) |
| Cheyava Falls | SHERLOC WATSON close-up camera | 1212 | [SIF_1212_0774536757_953EBY_N0560000SRLC01024_0000LMJ](https://mars.nasa.gov/mars2020/multimedia/raw-images/SIF_1212_0774536757_953EBY_N0560000SRLC01024_0000LMJ) |
| Serpentine Rapids | Navigation Camera (left) | 1231 | [NLF_1231_0776216101_776ECM_N0563368NCAM15230_01_195J](https://mars.nasa.gov/mars2020/multimedia/raw-images/NLF_1231_0776216101_776ECM_N0563368NCAM15230_01_195J) |
| Serpentine Rapids | Mastcam-Z (left) | 1234 | [ZL0_1234_0776478674_473EBY_N0563438ZCAM09288_1100LMJ](https://mars.nasa.gov/mars2020/multimedia/raw-images/ZL0_1234_0776478674_473EBY_N0563438ZCAM09288_1100LMJ) |
| Serpentine Rapids | SHERLOC WATSON close-up camera | 1239 | [SIF_1239_0776967346_765EBY_N0563438SRLC08050_0000LMJ](https://mars.nasa.gov/mars2020/multimedia/raw-images/SIF_1239_0776967346_765EBY_N0563438SRLC08050_0000LMJ) |
| Mount Washburn | Navigation Camera (left) | 1169 | [NLF_1169_0770713652_145ECM_N0525032NCAM14168_04_195J](https://mars.nasa.gov/mars2020/multimedia/raw-images/NLF_1169_0770713652_145ECM_N0525032NCAM14168_04_195J) |
| Mount Washburn | Mastcam-Z (left) | 1168 | [ZL0_1168_0770638741_646EBY_N0525032ZCAM07125_1100LMJ](https://mars.nasa.gov/mars2020/multimedia/raw-images/ZL0_1168_0770638741_646EBY_N0525032ZCAM07125_1100LMJ) |
| Channel floor | Navigation Camera (left) | 1172 | [NLF_1172_0770979129_113ECM_N0526980NCAM14171_01_195J](https://mars.nasa.gov/mars2020/multimedia/raw-images/NLF_1172_0770979129_113ECM_N0526980NCAM14171_01_195J) |
| Channel floor | Mastcam-Z (left) | 1171 | [ZL0_1171_0770903225_928EBY_N0526980ZCAM09210_0630LMJ](https://mars.nasa.gov/mars2020/multimedia/raw-images/ZL0_1171_0770903225_928EBY_N0526980ZCAM09210_0630LMJ) |
| Channel floor | Mastcam-Z (left) | 1171 | [ZL0_1171_0770903573_928EBY_N0526980ZCAM09210_0630LMJ](https://mars.nasa.gov/mars2020/multimedia/raw-images/ZL0_1171_0770903573_928EBY_N0526980ZCAM09210_0630LMJ) |

## Geologic units in the EVA area

From USGS SIM 3464 (Sun & Stack, 2020), GeoUnits_v1, mapped at 1:75,000.

| Symbol | Unit | Share of the area |
|---|---|---|
| Nue | Upper etched unit | 34.7% |
| Aeb | Eolian bedform unit | 28.9% |
| cr | Crater riim unit | 20.1% |
| su | Smooth unit, undivided | 8.5% |
| NHjf2 | Jezero fan 2 unit | 4.8% |
| Nnp1 | Nili Planum 1 unit | 3.0% |

## The 20 May 2024 storm replay

- **Eruption record:** DONKI activity `2024-05-20T05:36:00-CME-001` — R-type CME, 2678 km/s, start 2024-05-20T05:36Z. <https://ccmc.gsfc.nasa.gov/DONKI/view/CME/31034/-1>
- **Notification:** `20240520-AL-001`, issued 2024-05-20T15:52Z — 10.3 hours after the eruption began. <https://ccmc.gsfc.nasa.gov/DONKI/view/Alert/31039/1>
- **Measured:** 85 Curiosity RAD dose-rate observations, 18–24 May 2024 (MSL RAD RDR, PDS PPI node (MSL-M-RAD-3-RDR-V1.0), detector E dose rate). Background before the storm: 5.39 µGy/h.
- **Reported by NASA:** NASA/JPL, 10 June 2024: an astronaut standing next to Curiosity would have received 8,100 micrograys, comparable to 30 chest X-rays.
- **Model (not a measurement):** Fast spike (linear rise, exponential decay) plus slow tail. The tail is fitted to the RAD readings 13-43 h after onset; the spike is scaled so the event total above background equals NASA's reported 8,100 micrograys. Peak 3100 µGy/h, total 8100 µGy above background. Assumed particle onset at Mars: 2024-05-20T06:00:00Z.
- **Why a model is needed:** the RAD archive holds 2–4 hours of dosimetry per sol. The first reading after the eruption is at 19:08 UTC on 20 May, about 13 hours later.

## Reproducing the data

```bash
cd data-pipeline
make setup && make fetch && make build
```

See the [README](../README.md#rebuilding-the-data).
