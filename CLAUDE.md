# CLAUDE.md

## Project

**Launch Planner**: a probabilistic flight simulator and web app for a university club's weather balloon (Austin, TX). A 4D physics simulator flies the balloon through real NOAA GFS forecasts; an ML layer learns how forecast winds err so the app can show a calibrated distribution of plausible flights, not one line; a decision layer ranks launch sites and hours. Club-facing description: [PROJECT.md](PROJECT.md). Read it before design decisions. The user wants **ML at the core, applied uniquely** (not a wrapper around GFS) and a clean interactive app. It is a learning project, so prefer clear, well-explained code.

## Status (2026-10-21)

Done: data pipeline (GFS forecasts, IGRA soundings), 1D and 4D simulators, forecast-vs-sounding evaluation, bias-correction baseline, SondeHub real-track validation, GEFS spread test, first learned wind-error model, on-demand 3D web app (server + viewer), 45 passing tests, private repo https://github.com/sakethd4/balloon-launch-forecaster (branch `main`).

Order of work agreed with the user: (1) validate the simulator against real flight tracks (SondeHub); (2) test cheap uncertainty ideas: landing-error shape (ellipse vs ring) and GEFS ensemble spread as a predictor; (3) build the learned wind-error model and push samples through the simulator; (4) decision layer and the web app (a first app version can come earlier). Hosting/sharing for the app is undecided (local, private link, or public) and so is live vs fixed-day forecasts; default is hosting-agnostic static site, fixed days first.

## Constraints and decisions

- **Balloon:** 50 g latex (tops out ~50,000 ft), helium, 80 g payload, no extra rigging. Target ceiling ~45,000 ft (13,716 m). Ascent 350 m/min (5.833 m/s, ~40 min). Parachute descent ~15 m/s average (~15 min). Fill volume unknown (placeholder). Parameters live in `configs/balloon.yaml` (`null` = unknown, never guess).
- **Region:** Austin area, sites not chosen (a grid of candidate points will be evaluated). Forecast domain 27-35°N, 103-92°W. Vertical domain surface to 100 hPa; the balloon stays below the stratosphere so 200-500 hPa winds matter most; most drift happens during the climb.
- **Regulations/airspace:** the club handles them. Build no regulatory logic. A user-supplied GeoJSON allowed/restricted overlay may be displayed (display only). Physical hazards (water, cities) may be mapped. Keep a one-line advisory disclaimer in the UI.
- **Machines:** Windows 11 laptop, NVIDIA RTX 3050 6 GB, ~595 GB disk, Anaconda; conda env `balloon` (Python 3.11: numpy, pandas, xarray, scipy, netCDF4, zarr, requests, pyyaml, matplotlib, pytest, cfgrib, eccodes, scikit-learn; see `environment.yml`). Colab Pro via the VS Code Colab extension, **300 compute units**: a CPU runtime is nearly free (an 8 h run cost ~1 unit, measured); T4 GPU rate unmeasured (roughly 1.5 to 2 units/h from memory). Use the laptop first, Colab CPU for big downloads, Colab GPU only for full-size training and only after a short test run.
- **Storage/accounts:** project in OneDrive; data outside it in `~/balloon-data` (override `BALLOON_DATA_DIR`). **The laptop copy of all data is the master.** Google accounts: the Colab account has only 5 GB of its own Drive; a separate account has 1 TB. The Colab account's `balloon-forecaster` Drive folder was created in the Colab account (not shared from the 1 TB one), filled its quota, was emptied after the laptop copy was verified, then refilled only with the last block (2026-06-03 to 2026-10-18, ~0.3 GB) plus `balloon_code.zip`. Optional, pending: upload the full dataset to a folder owned by the 1 TB account, share it with the Colab account as Editor, add a shortcut in the Colab account's My Drive, verify, then delete the old folder and empty the Drive trash (trashed files still count).

## Key findings (baselines any ML must beat)

All from `scripts.compare_gfs_sondes` over 2021-03-22 to 2026-10-18: 2,037 GFS 12Z runs, 821,417 level comparisons, 81,815 flights, four stations FWD/CRP/DRT/MAF (270+ km from Austin).

- Raw GFS wind RMSE (vector, m/s) at 200/300/500 hPa: 3.8/3.5/3.0 at lead 0 to 11.9/11.0/7.8 at 120 h. Median landing error 2.3 (0 h), 3.8 (24 h), 7.7 (72 h), 12.6 km (120 h); p90 5.5, 8.6, 16.9, 27.7 km. Median drift ~46 km at every lead (DJF ~80 km, JJA ~18 km). Lead-0 error is a representativeness floor, not skill. Error is larger in winter in km but smaller relative to drift (120 h: DJF ~21% of drift, JJA ~56%).
- Bias correction (mean error by station/season/lead/level, train 2021-2024, test 2025-2026, 24,134 flights; `scripts.bias_baseline`): wind RMSE improves 0.3 to 1.6%; mean 300 hPa error ~0.7 m/s vs ~7.5 m/s RMSE, so error is mostly random (in-sample gain only 1.2%, so not a bug). Landing median improves 3.8->3.5 km (24 h, -7.9%), 7.9->7.5 (72 h, -5.1%), 12.7->12.5 (120 h, -1.6%), improving 56 to 65% of flights. Per-station and pooled versions are nearly identical.
- 4D vs frozen-profile simulator from Austin at 13Z: differ ~0.5 km mean / 1.8 km max (September, drift ~20 km) and ~1.5 km mean / 4.8 km max (January, drift ~77 km), about the size of the forecast error at 1 to 2 days. ~70 ms per flight in Python.
- Predictability of error SIZE (gradient boosting on log landing error, same time split): R2 0.35 with lead time alone, 0.37 + month, 0.39 + drift distance. Predicted error tracks actual across 5 buckets (2.5 to 11.3 km predicted; actual median 2.5 to 12.6, p90 5.8 to 26.3), mostly via lead time.
- **Real tracks (SondeHub, `scripts.validate_tracks`)**: 19,473 compact tracks from 8 sites ringing Austin (FWD, CRP, DRT, MAF, LCH, SHV, CLL, BPT) gave 42,158 legs from 12,843 flights; 6% of legs leave the forecast domain and are dropped (`in_domain`). Simulator driven by the real altitude history through one 12Z GFS run. Median end-point error: climb 2.6 km (p90 7.0) at forecast age 11-23 h, 4.3 (9.9) at 35-47 h; descent 1.5 (4.8) and 2.4 (7.4) km. Consistent with the sounding-based baseline, so the simulator and its physics are sound. **Error shape is round, not an ellipse**: RMS along vs across the drift 3.2 vs 3.2 km (climb, 11-23 h), with a small systematic under-drift (-1.1 km along track). By season (climb): DJF 2.8, MAM 3.1, JJA 2.4, SON 2.3 km. **By station (climb, 11-23 h): FWD 4.2 km (n 2,367) is clearly worse than CRP 2.5, LCH 2.4, MAF 2.4, SHV 2.2, BPT 2.1**; the earlier all-FWD number (3.4) overstated the typical error. DRT yields almost no climbs (1 of 3,244 flights; tracks start above 3 km, remote receivers) but 532 descents. CLL (17 iMet-4 flights, 2026): climb 13.0 km on 11 flights, too few to read. Caveats: NWS balloons are bigger than ours; leads are bands, not exact; flights are not from Austin; per-station differences may be partly weather regime, not the simulator.
- **GEFS spread (`scripts.spread_test`, test 2025-2026, 24,134 rows)**: spread helps. R2 of log landing error: lead only 0.346; + month 0.371; + month + GFS wind speed (control) 0.397; + month + spread 0.446; + month + GFS wind + spread 0.459. Within a lead, Spearman(spread, log error) is 0.32-0.42 (GFS wind 0.20-0.45). Buckets of predicted error get slightly sharper (lowest bucket p90 5.1 vs 6.4 km, highest median 13.6 vs 12.6 km) with medians still matching. Use spread as a feature of the learned error model. Not yet tested: spread along the flight path instead of at the station, direction of error, spread on real tracks.
- **Learned wind-error model v1 (`scripts.wind_error_model`, `src/uncertainty/wind_error.py`)**: generates error profiles (u,v at 850-150 hPa) = GBM-predicted scale per output x a bank of standardized training profiles (leave-one-year-out scales, same-lead bank, zero mean). Trained 2021-2024 on 55,320 sounding profiles, tested 2025-2026 on 23,349, 100 samples per profile, scored on the landing displacement via a linear shortcut (error profile weighted by time spent aloft; vs the simulator's landing error: correlation 0.965, shortcut median 6.56 km vs 6.07 km, so ~8% high). **Calibrated**: coverage of the 50%/90% radii is 49.7%/89.7% (full), 49.9/89.4 (lead only baseline), 50.9/90.0 (lead+month); by lead 88-91%, by station 89-90%, winter slightly low (DJF 87%). **Sharper only modestly**: energy score 6.07 km (full) vs 6.19 (lead only) = -1.9%; mean 90% radius 15.0 vs 15.8 km (-5%). Predicted-size buckets match actual (bucket p90 6.0/9.6/14.0/18.9/28.2 km vs predicted r90 6.2/9.5/13.5/18.1/25.5; highest bucket slightly under-dispersed, 89% coverage). Honest read: lead-time statistics already give a calibrated zone; spread and GFS wind buy a small sharpening. Not yet done: samples through the 4D simulator, check against SondeHub end points, spatial/temporal correlation of error (the model has none: one column error for the whole flight), station-specific (FWD) effects, non-zero mean/direction.

- **Web app (2026-10-22, `python -u -W ignore -m scripts.serve`, see web/README.md)**: a standard-library server (`scripts/serve.py`, `src/web/`) plus a CesiumJS + Three.js viewer. `/api/case` simulates any launch point inside the forecast area on request: the vectorised 4D simulator (`src/baselines/ensemble4d.py`, same algorithm as `simulate_flight_4d`, tested equal to 1e-7 deg) flies 100 sampled balloons together in ~0.5 s (the scalar version took ~7 s), the response also carries a 9x9x29 grid of u, v, temperature and humidity around the launch (`src/web/cases.py`). Launch points are accepted 0.5 deg inside the 27-35N, 103-92W box (`src/web/region.py`); ground height from AWS Terrarium tiles (`src/web/terrain.py`). Viewer: real 3D terrain (Terrarium tiles as a Cesium CustomHeightmapTerrainProvider, adjustable exaggeration) with shaded relief multiplied into Esri imagery; camera limited to the region (soft wall, dimmed mask and border outside) and to 560 km height; launch time picker (date chips, hourly strip shaded by real sun, arrow keys), click-to-pick launch point, 4 camera modes (orbit, chase, balloon cam on the payload with free look, top down). Balloon: real 3D model (latex envelope that swells with height, string, payload, parachute that opens at a visible pop with latex shreds). The 100 other possible flights are clickable dots; clicking one (or a landing point) shows landing coordinates, ground height, distances, rank and ring membership, and lets you follow that balloon. Three.js layer locked to Cesium's camera (`js/overlay.js`; local ENU frame at the launch point): wind = 3,200 curved air ribbons advected by the forecast wind in the Earth frame, coloured by forecast temperature (relative to the balloon's frame so you perceive shear and the layers you climb through; small-scale swirl is added for display); volumetric ray-marched clouds placed where forecast RH is high (RH>74%), fine shape generated from 3D noise, a thin veil in map views and full density in balloon cam; birds (turkey vultures circling, geese in a V, songbird flock) at real sizes near the launch. Day/night from the real sun elevation (imagery, sky, stars). Full visual quality by default; optional quality scaling by frame time (`?adapt=1`). **Tested only in headless Edge with software WebGL (correctness, interactions: click, drag, bounds, picking); real-GPU frame rate is unmeasured.** The 'real SondeHub flight replay' of the earlier viewer was not carried over (old code is in git history, `scripts/export_web_case.py` before 2026-10-22). Imagery/elevation/CDN libraries need internet.
- **Landing zones vs REAL flights (`scripts.track_calibration`, 2025-26 SondeHub legs, 1,500 random legs, each flown through the 4D simulator along the real altitude history with 30 sampled error profiles; models trained only on 2021-2024 soundings)**: the zones are too WIDE, i.e. conservative. Coverage of the 50%/90% radius: 61.9%/94.9% (full), 60.5%/92.7% (lead only); real median error 2.7 km vs mean sampled r50 3.9 km. Sharper-and-better ordering still holds: energy score 2.67 km (full) vs 2.75 (lead only); mean r90 7.3 vs 7.7 km. Radii would need scaling by ~0.85 (50%) and ~0.87 (90%), the same for climbs (0.86/0.89) and descents (0.82/0.83), so it is one factor, not a shape problem. Predicted-size buckets still ordered (real median 1.0 / 1.9 / 2.9 / 3.9 / 6.7 km across predicted r90 2.8 / 4.6 / 6.4 / 8.5 / 13.0 km; coverage 92-96%). By station coverage90 93-98%; FWD errors biggest (real median 4.65 km). Untested hypothesis: the model applies one column error for the whole flight, while a real balloon drifts through space and time where errors partly decorrelate, and soundings add point-measurement noise. Next step if wanted: fit the scale factor on 2021-2024 tracks and test on 2025-26 (do not tune it on the same legs), or add spatial/temporal decorrelation to the generator.

## ML direction

ML is not for beating GFS at winds; it is for the DISTRIBUTION of where the balloon goes. Components, each with a baseline (the lead-time error table), a time-split test and calibration checks (coverage of 50/90% regions, log score or CRPS): (1) conditional generative model of wind-profile ERROR by altitude whose samples go through the physics simulator, so it works for any launch time or balloon setup; (2) validation and residual learning against real tracks: SondeHub (`s3://sondehub-history`, anonymous, CC BY-SA 2.0, GPS tracks of meteorological radiosondes, `sondehub` Python package downloads by serial; sensor values uncalibrated, GPS fine; amateur-balloon coverage unverified); (3) analog ensembles (kNN on forecast fields); (4) decision layer maximizing probability of a good landing, shown as a landing-probability heat map from sampled flights. Report honestly if a model fails to beat the baseline.

## Core principles

- **Post-process existing forecasts (GFS etc.); do not forecast weather from scratch.**
- **Baselines first.** Raw forecast, the lead-time error table and the bias correction exist; ML results only mean something relative to them.
- **Time-based splits only** (train 2021-2024, test 2025-2026 so far). Never random-split weather data.
- **Report uncertainty, calibrated.** Check calibration, not just accuracy. Be honest about ties and failures.
- **Advisory only.** Never word outputs as a go/no-go authorization.

## Architecture and layout

```
GFS + IGRA ingest -> ~/balloon-data/{raw,processed} -> 4D simulator (src/baselines)
   -> uncertainty layer (src/models, planned) -> forecast products (JSON) -> web app (planned)
```

```
configs/balloon.yaml            balloon parameters
notebooks/01_colab_gfs_download.ipynb   Colab launcher for big GFS downloads
scripts/                        fetch_gfs, download_igra, compare_gfs_sondes, bias_baseline, make_colab_bundle,
                                fetch_sondehub(_compact), compact_tracks, import_sondehub_batches, validate_tracks,
                                fetch_gefs, spread_test, wind_error_model, track_calibration, demo_ensemble, serve
src/paths.py                    data locations
src/ingest/                     gfs.py (AWS GFS, byte-range, ecCodes), igra.py (soundings), sondehub.py (real tracks,
                                compact npz), gefs.py (ensemble spread)
src/evaluate/track_validation.py  simulator vs real tracks
src/baselines/                  trajectory.py (1D), trajectory4d.py (4D, WindField4D)
src/evaluate/gfs_vs_sondes.py   forecast-vs-sounding comparison and landing error
src/models/bias_correction.py   cheap baseline
src/uncertainty/                wind_error.py (learned wind-error generator: scale GBMs + bank of standardized error
                                profiles), ensemble.py (fly the samples through the 4D simulator), features.py, scoring.py
src/web/                        region, terrain (elevation), cases (builds one launch for the viewer)
src/baselines/ensemble4d.py     vectorised 4D simulator for ensembles
web/                            viewer: index.html, css/app.css, js/ (earth, flight, overlay, balloon, wind, clouds, birds, cameras, ui, main)
tests/                          45 tests (pytest)
```
Planned next: the decision layer (rank sites and hours), re-adding the real-flight replay and live SondeHub tracking to the new viewer, recalibrating the zone width on real tracks, hosting.

## Conventions

- SI units internally (m, m/s, K, Pa); name units in columns (`wind_speed_ms`). UTC, timezone-aware timestamps everywhere; convert only in the UI.
- Altitude: say which (geopotential height, geometric, pressure level); the simulators use geopotential height as altitude. Wind direction in raw data is where it comes FROM; use u/v for math.
- Forecast data carries init time and valid time (lead = valid - init); mixing them leaks the future.
- Downloads are cached, idempotent and restartable; raw data is never edited. Credentials never go in the repo or the chat (env vars, `~/.cdsapirc`, Colab secrets).
- Docstrings explain the *why* of non-obvious meteorology or modeling.

## Working agreements for Claude

- Tell the user what you do as you go, in plain words; they want to follow along. The user gave standing permission to do what is needed (install into the `balloon` env, run jobs, commit and push) as long as it is reported. Still ask before large downloads, long or costly Colab GPU runs, or heavy new dependencies.
- **Do not wait on long jobs.** Run them in the background (`run_in_background`), do not poll or sleep, and report when the completion notice arrives.
- Keep this file, PROJECT.md and the memory files current when decisions or results change. Commit and push after changes (commit messages end with the Co-Authored-By line from the session instructions).
- Always report the baseline comparison next to any model result. Watch for leakage (time splits, valid vs init time, features unknown at forecast time).
- Never invent flight data or balloon specs; mark unknowns as placeholders. Never ask for or handle Google or GitHub credentials; the user signs in themselves.

## Commands

From the project root `C:\Users\saket\OneDrive\Documents\tsl larp`, env `balloon`:

- Tests: `conda run -n balloon python -m pytest -q`
- For jobs that read GRIB (ecCodes), call the env's python directly with `C:\Users\saket\anaconda3\envs\balloon\Library\bin` on PATH and `-u`; `conda run` buffers all output until exit.
- Fetch GFS (slow on the laptop, ~105 s/day; use Colab for bulk): `python -u -m scripts.fetch_gfs --start D --end D`
- Comparison over a range (~45 min for all 5 years): `python -u -m scripts.compare_gfs_sondes --start 2021-03-22 --end 2026-10-18`
- Bias baseline: `python -u -m scripts.bias_baseline` (needs the comparison CSVs; `--skip-landing` for the instant wind part)
- Rebuild the Colab code zip: `python -m scripts.make_colab_bundle` (writes `dist/`, gitignored)
- Run the app: `python -u -W ignore -m scripts.serve` then open http://localhost:8000

## Data notes (lessons that still matter)

- **GFS** (`src/ingest/gfs.py`): public AWS bucket `noaa-gfs-bdp-pds`, 0.5° files `gfs.DATE/HH/atmos/gfs.tHHz.pgrb2.0p50.fFFF` with an `.idx` giving each field's byte range, so only needed fields are fetched (u, v, t, gh, r on 21 levels 1000-100 hPa; 10 m wind, 2 m temp, MSL pressure, cloud cover, precipitation) and cropped to Texas. Stored one NetCDF per (date, cycle): `~/balloon-data/processed/gfs/gfs_0p50_v2_YYYYMMDD_t12z.nc` (~2.2 MB). **Complete: 2,037 files, 12Z run, 21 steps (0-120 h every 6 h), 2021-03-22 to 2026-10-18, 4.5 GB, verified.**
- Archive begins 2021-01-01, but the folder layout and model change on **2021-03-22 (GFS v16)**, so `gfs.FIRST_SUPPORTED_DAY` refuses earlier dates. Smaller GFS updates after v16 are unchecked and could shift error statistics; check before trusting errors across the whole period.
- Ingestion lessons: AWS gives each connection little bandwidth from this laptop (~0.15 MB/s) but connections do not share the limit, so ranges are fetched in parallel; **ecCodes is not thread-safe** (download in threads, decode serially or in separate processes); direct ecCodes decoding is ~7x faster than cfgrib; GFS stores cloud cover and precipitation twice per step, so the code keeps instantaneous `tcc` and 6 h `tp`; `tp` is NaN at step 0 on purpose; a 404 is reported as a missing day, not an outage. File names carry `SCHEMA_VERSION`; bump it whenever file contents change (v1 files, which had an arbitrary tcc/tp pick, are ignored).
- Colab bulk runs: ~20 to 29 s per day per process; two processes ran ~1.4x faster than one. Colab writes to Drive through a cache, so **the notebook check cell can see files that never reached Drive**; always `drive.flush_and_unmount()` then remount before trusting a count. Drive web folder downloads were unreliable (zips of ~1.9 GB plus tiny leftovers); verify counts after extracting and flatten the nested `gfs` folder.
- **IGRA soundings** (`src/ingest/igra.py`): full history for FWD `USM00072249`, CRP `USM00072251`, DRT `USM00072261`, MAF `USM00072265` in `~/balloon-data/raw/igra/` (CRC-checked). Fixed-width format parsed from NOAA's spec; missing = -9999/-8888; wind speed tenths of m/s, temperature tenths of °C, pressure Pa. `parse(..., start, end)` skips other years quickly. Austin has no sounding station.
- Eval outputs in `~/balloon-data/processed/eval/`: `gfs_vs_sondes_levels.csv` (per level, 70 MB), `gfs_vs_sondes_flights.csv`, `bias_baseline_flights.csv`.
- **GEFS spread:** `~/balloon-data/processed/gefs/` one NetCDF per day (2,037 days, 178 MB): u/v/vector spread at 500/300/200 hPa for leads 0,12,24,36,48,72,96,120 h, from NOAA's `gespr` files on `noaa-gefs-pds` (about 3 s per day). **Possible data:** ERA5 for winds over Austin itself and climatology (CDS API with a user-created token in `~/.cdsapirc` and the dataset licence accepted, with area subsetting; the ARCO-ERA5 Google Cloud copy has global hourly chunks, ~154 MB per variable, so regional pulls are heavy; ERA5 assimilates the same soundings, so it is a cross-check, not independent truth, and cannot be a forecast input); HRRR analyses and AMDAR aircraft winds (access and archive dates unchecked); the club's own flights.

## Open questions

- App hosting/sharing and live vs fixed-day forecasts.
- Grid spacing and extent of candidate launch points; the format of the club's allowed-area data (GeoJSON/KML?).
- Fill volume (compute from total mass and the ascent-rate target); any past club flight logs.
- SondeHub has no launch site in Austin. In-domain sites: FWD, CRP, DRT, MAF plus LCH 72240, SHV 72248, CLL (folder -115, College Station, iMet-4, 17 flights 2026) and BPT (folder -12, Beaumont area, 2021-22); the names of the last two are guesses from coordinates. Out-of-domain sites (BRO, OUN, AMA, LZK, Monterrey) cannot be evaluated with the Texas GFS crop. Amateur flights without a launch-site label were not searched (would need scanning the date/ view). `notebooks/02_colab_sondehub_download.ipynb` fetched 17,261 more flights as compact zips (done 2026-10-21, imported with `scripts.import_sondehub_batches`; 1 download failed, rerun the notebook to retry; the Drive copy can be deleted). Also open: dates of GFS updates after v16, Austin-area ground truth (club flights with a GPS tracker; AMDAR aircraft winds unchecked).
- Whether to move the dataset to the 1 TB account.

## Viewer fixes (2026-10-22)

Balloon geometry keeps a fixed illustrative 60x magnification and the simulated payload anchor at every zoom (follow-up below). Ensemble markers are smaller,
subdued and terrain-depth-tested. Wind no longer piles up on a clamped ground plane or uses additive blending.
Cloud rays intersect the curved height field, clip to the forecast grid, use stable samples and retain coverage from
near/top views; wide map views fade clouds out (follow-up below); procedural billows remain illustrative. Following preserves the complete projected route after closing
selection. Camera clearance applies to free, tracked and payload cameras using loaded, exaggerated terrain.
Performance changes preserve default visual quality: reuse grid interpolation buffers, cache paused flight geometry,
update telemetry DOM at 10 Hz, and skip empty cloud space. Quality reductions require `?adapt=1`.
Verification: all 45 Python tests pass, four Node regression tests pass (followed-route/visibility transitions and analytic interpolation), and all viewer JavaScript files pass syntax checks. See web/README.md
for the visual check list and limitations: no connected browser was available in this session, GPU performance unmeasured.

### Viewer follow-up (2026-10-22)

The life-size model was unreadable from normal overview distances. Use a fixed 60x illustrative balloon scale in ALL
camera modes (never a pixel-size floor or zoom-dependent scale); Chase shows the model and perspective still shrinks it
when zooming out. Keep both the Three camera's local and world matrices synchronized with Cesium, including renderer
matrix updates. Cloud detail uses non-periodic low-frequency weather noise to warp and modulate differently rotated,
incommensurate detail volumes; shapes evolve slowly. Clouds fade between 28-50 km camera-to-balloon range in all map
modes and then skip their render pass. Wind now uses 3,200 segmented, curved, soft ribbons with fixed metre dimensions
(40-240 m long, 2.5-4.5 m wide); removed zoom-growing haze puffs, bright particle heads, screen-space size floors and
vertical relative-velocity tails that looked like rain. Map wind fades at 10-22 km and then skips simulation, sampling,
buffer uploads and drawing. Payload view retains nearby wind/clouds. Stationary cloud views reuse their target for at
most 33 ms, moving views render immediately. Weather variation is generated once in a cached 3D texture rather than recomputed per sample. Projection matrices update only for FOV/aspect changes.
Nine Node checks pass (five logic checks and four integration checks using the pinned Three.js library with a stubbed
renderer); JavaScript syntax checks pass. GPU shader compilation, appearance and real frame rate remain unverified.
See web/README.md for verification setup. The preceding full Python suite passed 45 tests; no Python changes here.

### Follow UI / terrain maintenance (2026-10-22)

Use terrain-clamped Entity points for landing markers: raw PointPrimitive ignores heightReference. Ground markers and
selected landing rings disable terrain depth clipping at every range. Selected flight preview takes precedence over the
followed flight route while the drawer is open; closing it restores the followed route. Follow closes the drawer and
exposes one Stop following button beside camera modes; stopping returns Chase/payload to Orbit. Removed following bubble
and top-left title, anchored left cards near bottom. Map wind now uses fixed 120-600 m by 12-20 m ribbons with spatial
fade around the followed balloon (not the distant camera), fading at 35-70 km. Payload ribbons are unchanged. Clouds
preserve humidity-driven density and fade at 65-120 km; procedural weather modulation no longer erases most density.
Terrain uses Web-Mercator tiles aligned with Terrarium, bilinear cross-tile borders, and source heights even at coarse
levels. Bounded request/cache helpers retain parent terrain while loading or retrying failed source tiles instead of
returning zero patches. Evict failed DEM cache entries; 12 s download timeout. Preserve the imagery provider's synchronous
undefined retry signal. Relief shading now uses equivalent vector lighting without per-pixel trig. Globe cache 300 tiles,
heightmap cache 300, max 6 heightmap jobs, sibling/ancestor preloading. No paid data/account required. Progressive LOD is
still expected; GPU visual quality unverified (browser tool reports Edge unavailable).
Verification: 15 Node checks pass, including terrain seams/refinement, missing-tile retries, imagery throttle semantics,
follow controls and selection during following; all JS syntax checks pass. No backend/model changes.

### Wind/chase/cloud occlusion maintenance (2026-10-22)

Wind presets reduced 20% (default 2,560 ribbons), opacity reduced 10%, and a traveling vertex wave/width flutter added.
Chase no longer uses a tracked entity: explicit ENU heading/pitch/range, drag/wheel controls, pitch -85..75 degrees,
range 120 m..200 km. Clamp pitch against exaggerated terrain clearance; no Cesium collision/inertia fighting tracking.
Mode changes cancel camera flights/reset to identity; site changes reinitialize chase/payload context and position.
Cloud rays now stop at a balloon-only packed-distance prepass, then composite after geometry. Exclude invisible flashes;
restore visibility/material/target state even on errors. Depth prepass uses both faces and logarithmic depth; no Cesium
terrain-depth sharing. Cloud cache also invalidates when balloon position changes. Field remains forecast RH on a local
9x9x29 grid (+/-2 deg, 0.5 deg, every 500 m to 14 km) with procedural fine shape, not live/observed cloud cover.
Outer data/zoom fades are artificial boundaries; interior gaps may be humidity-driven or procedural. Layer tooltip and
web/README.md explain this. 18 Node checks pass using pinned Three.js and Cesium (renderer stubbed; camera math real),
including chase terrain limits/relocation and occluder state restoration. GPU appearance/shader compilation unverified.

### Flight-path cloud readability (2026-10-22)

A cached projected-route mask clears only a narrow antialiased strip of the cloud composite over nominal/selected
paths and the travelled trail. Original Cesium route styling/terrain tests remain, as does balloon-specific cloud depth
clipping. Update the mask before the cloud-cache early return so selection/playback changes appear immediately. Clip
segments in homogeneous coordinates before dividing by w; skip unchanged/blank masks and all work when clouds hide.
20 viewer checks pass, including route visibility/cache/selection and near/side/behind-camera clipping. GPU appearance
remains unverified. No backend or forecast changes.

### Native balloon / map-view corrections and weather-UI research (2026-10-22)

Supersedes the preceding route-mask approach: removed the screen-space cloud cutout (it created visible terrain halos).
Balloon now exports once as a Cesium glTF model via the pinned Three GLTFExporter; mirror node matrices/visibility and
use the launch ENU model frame, Z up/X forward, no minimum pixel floor and fixed 60x illustration scale. The Three source
is layer 1 only, reserved for cloud depth; if native loading fails, report and explicitly fall back to overlay rendering.
Default terrain exaggeration is now 1x. Cloud prepass adds exact-width route depth geometry after balloon depth, retaining
the depth buffer. Routes above cloud retain their strokes; those behind cloud attenuate naturally. Cap map cloud opacity
at 0.68, keep full payload density, and remove glow styling/fat underlay. No route halo mask. Terrain depth still is not
shared with the cloud pass itself. Native animation transforms are copied from a stable export snapshot; avoid obsolete
static-bound culling and skip unused Three PMREM generation unless the fallback is active.
Removed decorative wind flutter, animated bend and brightness pulse; forecast transport/lifetime fade remain. Top is
manual north-up nadir pan/zoom only, with bounded map coordinates/height, no tilt/rotation/roll. Restore controls on exit.
Research: Met Office colour guidance -> fixed blue/neutral/orange ramp and exact shared wind/legend colour function;
NOAA probabilistic visualization -> explicit forecast/selected and solid50/dashed90 keys; ECMWF base/valid presentation ->
weather snapshot UTC stamp alongside init/lead controls. Legend persists when wind hides; labels distinguish procedural
clouds and illustrative model size. Sources and mappings are in web/README.md. No forecast/ML changes.
21 Node checks pass (actual Cesium camera math incl. top pan/zoom, real glTF export and mirrored model node transforms,
cloud route depth widths/pass ordering, terrain retry/seams and palette/legend consistency). JS syntax checks pass.
GPU rendering/model drawing remain unverified: browser tool reports IAB unavailable. See web/README.md for setup/QA.


### Viewer interface cleanup (2026-10-22)

Flight details use a geometrically centred SVG close icon. Other possible flights are opaque coral markers with a
subtle dark outline, retaining their existing sizes and terrain depth. Birds and their layer toggle are removed.
The legend drops the extra weather valid-time and illustrative-effect notes; rings are labelled landing probability
(50% solid / 90% dashed), meaning fractions of simulated landings rather than a calibrated guarantee for real flights.
The transport's Hide UI / Show UI control preserves clock, perspective and transport while hiding the other app
panels; left card backgrounds are fully transparent. UI visibility is controlled consistently in all camera modes.
Altitude-chart scrubbing captures pointer drags, clamps endpoints and holds playback until release, with cancellation
cleanup and keyboard seeking. Twenty-two viewer checks pass; browser/GPU visual inspection remains pending.


Viewer layout correction: restored glass backgrounds/borders/blur on individual left cards; only the scrolling
container and scrollbar track are transparent. The altitude graph now keeps its 360:64 proportions at a bounded
width instead of stretching across spare transport space. Hide/Show UI is an accessible circular panel icon at the
right end of the transport, matching its other icon controls. Removed the wind-ribbon length caption and centred
legend text. Existing continuous scrubbing remains intact.
