# CLAUDE.md

## Project

**Launch Planner**: a probabilistic flight simulator and web app for a university club's weather balloon (Austin, TX). A 4D physics simulator flies the balloon through real NOAA GFS forecasts; an ML layer learns how forecast winds err so the app can show a calibrated distribution of plausible flights, not one line; a decision layer ranks launch sites and hours. Club-facing description: [PROJECT.md](PROJECT.md). Read it before design decisions. The user wants **ML at the core, applied uniquely** (not a wrapper around GFS) and a clean interactive app. It is a learning project, so prefer clear, well-explained code.

## Status (2026-10-21)

Done: data pipeline (GFS forecasts, IGRA soundings), 1D and 4D simulators, forecast-vs-sounding evaluation, bias-correction baseline, SondeHub real-track validation, GEFS spread test, first learned wind-error model, 38 passing tests, private repo https://github.com/sakethd4/balloon-launch-forecaster (branch `main`).

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
                                fetch_gefs, spread_test, wind_error_model
src/paths.py                    data locations
src/ingest/                     gfs.py (AWS GFS, byte-range, ecCodes), igra.py (soundings), sondehub.py (real tracks,
                                compact npz), gefs.py (ensemble spread)
src/evaluate/track_validation.py  simulator vs real tracks
src/baselines/                  trajectory.py (1D), trajectory4d.py (4D, WindField4D)
src/evaluate/gfs_vs_sondes.py   forecast-vs-sounding comparison and landing error
src/models/bias_correction.py   cheap baseline
src/uncertainty/wind_error.py   learned wind-error generator (scale GBMs + bank of standardized error profiles)
tests/                          38 tests (pytest)
```
Planned: sampling through the 4D simulator, real-track calibration of the generator, `web/` (app).

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
