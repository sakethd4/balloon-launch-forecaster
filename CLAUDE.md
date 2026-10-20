# CLAUDE.md

## Project

Launch Window Forecaster: a tool for a university club's stratospheric weather balloon project. A large-scale training pipeline (run on Google Colab Premium) learns the errors of public weather forecasts, predicts flight-relevant conditions and outcomes (winds aloft, landing zone, ascent, drift) with uncertainty, and a dashboard visualizes predicted conditions for a user-chosen future window. Full description in [PROJECT.md](PROJECT.md). Read it before making design decisions.

The project is a learning exercise for club members, so prefer clear, well-explained code over clever code.

## Status

Early build. Done so far: conda env `balloon` (Python 3.11, light packages only; see `environment.yml`), balloon config (`configs/balloon.yaml`), baseline trajectory simulator (`src/baselines/trajectory.py`, 6 passing tests), IGRA radiosonde ingestion (`src/ingest/igra.py`, verified against the real NOAA format spec), and a demo (`scripts/demo_flight.py`). Demo result: flying 594 Fort Worth soundings from Austin gives a median ~38 km drift (mostly east, max ~147 km) over ~54 min. Git repo: private, https://github.com/sakethd4/balloon-launch-forecaster (branch `main`). Data lives outside OneDrive, in `~/balloon-data` (override with `BALLOON_DATA_DIR`). Decided so far:

- **Region:** launch sites near Austin, TX. Sites are **not chosen**: the tool searches a grid of candidate launch points and shows a site-suitability map, with optional user-supplied GeoJSON overlays of allowed/restricted areas (display only; the club decides what's allowed). Named sites may go in `configs/sites.yaml`. The dashboard shows a map of the whole forecast area, initially ~27–35°N, 103–92°W.
- **Balloon:** 50 g latex (typically tops out ~50,000 ft), helium, payload ~80 g. Target ceiling ~45,000 ft (~13.7 km). Target ascent **350 m/min (~5.8 m/s)**, about 40 min to the ceiling. Parachute descent ~**15 m/s average** (~15 min from the ceiling), no rigging weight beyond the 80 g payload. Total flight under an hour. Fill volume is an unknown placeholder.
- **Vertical domain:** surface to ~100 hPa. The balloon stays below the stratospheric turnaround layer, so jet-stream and upper-tropospheric winds (200–500 hPa) matter most. Most drift happens during the ~40 min ascent.
- **Regulations/airspace:** the club handles these itself. Don't build regulatory layers or logic. Keep a one-line advisory disclaimer in the UI only. Physical hazards (water, cities) are still worth mapping.
- **Colab:** verified working through the VS Code Colab extension (Python 3.13, Tesla T4, ~208 GB local disk). Colab Pro with only **100 compute units**, so GPU time is rationed (see Compute).
- **Local machine:** Windows 11, Anaconda Python 3.13.5, NVIDIA RTX 3050 6 GB laptop GPU, ~595 GB free disk. Use it for development, data work, baselines, and small-model debugging (costs no Colab units). 6 GB VRAM limits model size, so full-size training goes to Colab's T4.
- **Shared Drive folder:** verified. `balloon-forecaster` appears in the Colab account's My Drive, so `DATA_ROOT` is `/content/drive/MyDrive/balloon-forecaster`.
- **Storage:** ~1 TB Google Drive, owned by a *different* Google account than the Colab account (see below).

Update this section as things are decided.

## Core principles

- **We post-process existing forecasts (GFS/HRRR/ECMWF); we don't forecast weather from scratch.** Models learn forecast errors and local bias.
- **Baselines first.** Climatology, raw forecast, the physics trajectory predictor, and the rule-based score must exist before any ML. ML results are only meaningful relative to them.
- **Time-based train/val/test splits only.** Never random-split weather data (leakage across adjacent days).
- **Report uncertainty.** Models output distributions/quantiles, landing predictions are regions, and uncertainty must be calibrated (check calibration curves, not just accuracy).
- **Be honest in evaluation.** Report where the model fails or ties the baseline.
- **Safety framing.** The tool is advisory only. Never word outputs as a go/no-go authorization. The club handles regulations itself, so don't build regulatory logic; a one-line advisory disclaimer in the UI is enough.

## Architecture

```
Ingest (sharded, cached) -> Raw store -> Preprocess/align -> Training store (Zarr)
   -> Train (Colab GPU, config-driven, checkpointed) -> Evaluate (time-split) -> Tracker/registry
   -> Scheduled inference on newest forecast -> Forecast products (files) -> Dashboard
```

The dashboard only **reads** precomputed forecast products. It never runs models live.

## Compute: Google Colab Premium

Training runs on Colab. Design everything around its constraints:

- Runtimes are ephemeral: they disconnect on idle or max session length and local disk is wiped. **Checkpoint regularly to Drive/bucket and support automatic resume.** Never keep the only copy of anything on the runtime disk.
- Datasets, checkpoints, and results live on Google Drive or a cloud bucket. Read Zarr in chunks; don't load full datasets into memory.
- **Code lives in Git; notebooks are thin launchers** that clone the repo, mount storage, and call `python -m src.train --config configs/<name>.yaml`. No pipeline logic in notebooks.
- Ingestion and preprocessing are sharded (e.g. one month per shard), idempotent, and restartable.
- Debug on a tiny subset locally first. Use mixed precision and gradient accumulation to use GPU time well.
- **Compute budget: 100 units (~50 T4 hours at roughly 1.5–2 units/hr; check current rates).** Do downloading, preprocessing, baselines, LightGBM, and small-model debugging locally (the laptop's RTX 3050 is free to use) or on CPU runtimes; use the Colab GPU only for full-size deep-model training. Never start a long GPU run without a short test run first and the user's go-ahead. Remind the user to disconnect idle runtimes. Log units spent per experiment.

### Storage across two Google accounts

The Colab account and the 1 TB Drive's owner account differ. A Colab runtime can only mount the Drive of the account it is signed in with. Plan:

1. The Drive owner creates a folder (e.g. `balloon-forecaster`) and shares it with the Colab account as **Editor**.
2. In the Colab account's Drive, add a shortcut to that folder under My Drive ("Shared with me" → right-click → Add shortcut to Drive).
3. Notebooks mount Drive and use `DATA_ROOT` pointing at the shortcut. Shared-folder files count against the owner's quota.

Keep `DATA_ROOT` in one config value so the location can change. Fallback if mounting doesn't work in the VS Code extension: write to Colab local disk and sync to Drive with a tool such as rclone, or use a cloud bucket. Don't hardcode Drive paths in pipeline code.

### How Claude can reach Colab

Claude can't touch Colab on its own. Two official routes exist (verify current setup steps before relying on them):

1. **Colab MCP server** (open source, `googlecolab/colab-mcp`): lets an MCP client like Claude Code create notebooks and run cells in a browser-based Colab session. Requires the user to connect and authorize it in their own browser and Google account.
2. **Colab VS Code extension:** lets the user select a Colab runtime (including Premium GPUs) as the kernel for local `.ipynb` files in VS Code. This is the lowest-effort route since the user already uses VS Code.

Claude never asks for or handles Google credentials, tokens, or auth codes. The user does all sign-in themselves. Until one of these is set up, Claude writes code and notebooks locally, and the user runs the heavy jobs on Colab.

## Planned stack (proposed, not yet confirmed)

- Python 3.11+, environment via `venv` or `uv`
- Data: `pandas`, `xarray`, `zarr`, `dask`, `cfgrib`/`netCDF4`, `requests`, `cdsapi` (ERA5), `s3fs` (AWS Open Data)
- Modeling: `scikit-learn`, `lightgbm`, PyTorch (with Lightning if the team agrees)
- Config and tracking: YAML configs (Hydra optional), Weights & Biases or TensorBoard
- Trajectory baseline: CUSF/Tawhiri or a small custom integrator
- Dashboard: Streamlit + Plotly + pydeck/folium
- Tests: `pytest`

Confirm choices with the user before installing heavy dependencies or locking in a layout.

## Proposed layout

```
configs/         # one YAML per experiment/run (seed, data range, model, hyperparameters)
data/raw/        # downloaded forecasts and soundings (gitignored; mirrored on Drive)
data/processed/  # Zarr/Parquet training store (gitignored; mirrored on Drive)
src/ingest/      # one module per data source; sharded and idempotent
src/features/    # feature engineering and dataset classes
src/baselines/   # trajectory predictor, rule-based score, climatology
src/models/      # tabular and deep models, calibration
src/train.py     # config-driven training entry point with checkpoint/resume
src/evaluate/    # time-split evaluation, metrics (RMSE, CRPS, coverage, ranking)
src/inference/   # scheduled job that writes forecast products
app/             # Streamlit dashboard (reads forecast products only)
notebooks/       # Colab launchers and exploration only
tests/
```

## Visualization requirements

The dashboard lets the user choose a future window (start/end) and shows:

1. Launch-window score timeline with uncertainty band and lead-time confidence
2. Time-by-altitude wind heatmap with direction (jet stream visible)
3. Surface wind, temperature, cloud cover, and precipitation timelines with intervals
4. **Regional forecast map of the whole Austin-area domain** (centerpiece): choose time, altitude layer, and variable; wind arrows; time slider across the window
5. Landing map: flight path and percentile landing regions on the same map, plus a **site-suitability mode** that colors a grid of candidate launch points and supports a user-loaded GeoJSON overlay of allowed/restricted areas; physical hazards marked
6. Raw forecast vs corrected forecast overlay
7. Per-factor score breakdown and historical accuracy at that lead time

Colors and chart choices should be accessible and consistent. Always label values as forecasts with uncertainty, and label the tool as advisory.

## Conventions

- Units: SI internally (m, m/s, K, Pa). Convert only for display. Name units in variables/columns where not obvious (e.g. `wind_speed_ms`, `alt_m`).
- All timestamps are UTC internally and timezone-aware. Convert to local time only in the UI.
- Altitude: state whether it is geopotential height, geometric height, or pressure level. Don't mix them silently.
- Wind direction: meteorological convention (direction wind comes *from*) in raw data. Convert to u/v components for any math.
- Forecast data must carry both the **valid time** and the **issue/init time** (lead time = valid - init). Mixing these up silently leaks future information.
- Downloads are cached and idempotent. Raw data is never edited in place.
- Every training run: fixed seed, saved config, git commit hash recorded with checkpoints, metrics logged to the tracker.
- Keep API keys and credentials out of the repo (environment variables or a gitignored `.env`; Colab secrets for Colab runs).
- Add short docstrings explaining the *why* for non-obvious meteorology or modeling choices, since teammates are learning.

## Working agreements for Claude

- Check this file and PROJECT.md first, and keep them current when decisions change (launch site, balloon specs, stack, results).
- Ask before downloading large datasets (GFS/ERA5 pulls can be many GB), starting long or costly Colab runs, or adding dependencies.
- Always report the baseline comparison alongside any model result.
- Watch for leakage: time splits, valid vs init time, and any feature that wouldn't be known at forecast time.
- Don't invent flight data or balloon specs. If a value is unknown (balloon mass, payload mass, burst diameter, ascent rate), mark it as a placeholder and ask.

## Open questions (resolve and then record here)

- Grid spacing and extent for candidate launch points around Austin (default to be proposed)
- Where the club's allowed/restricted-area data comes from (GeoJSON/KML export?)
- Confirm nearest radiosonde stations (FWD, CRP, DRT, MAF are the expected ones)
- Fill volume (compute from total mass and the 350 m/min target)
- Does the club have any past flight logs?
- Forecast horizon the club cares about (e.g. 3 vs. 7 days)
- Dashboard hosting: local only, or shared with club members?

## Commands

Run from the project root `C:\Users\saket\OneDrive\Documents\tsl larp`, using the `balloon` conda env:

- Tests: `conda run -n balloon python -m pytest -q`
- Demo: `conda run -n balloon python -m scripts.demo_flight`

Add train, evaluate, inference, and run-dashboard commands here once they exist.

## Data notes

- IGRA soundings (verified): files are `USM000722xx-data-beg2026.txt.zip` (year to date, small) and `USM000722xx-data.txt.zip` (full history, large; ask before downloading). Stations: FWD `USM00072249`, CRP `USM00072251`, DRT `USM00072261`, MAF `USM00072265`. Austin has no sounding station; the nearest are 280+ km away, so sounding winds are a proxy for Austin's winds, not exact.
- **Downloaded and verified:** full history for all four stations in `~/balloon-data/raw/igra/` (~370 MB zipped, CRC OK, sounding counts match NOAA's station list; FWD from 1937, CRP 1953, DRT 1954, MAF 1930, all through Oct 2026). Re-fetch with `python -m scripts.download_igra`. They are large once unzipped, so `igra.parse` on a full file is slow and memory-heavy: restrict to recent years and save as Parquet before modeling.
- **GFS archive (measured, not yet downloaded):** public AWS bucket `noaa-gfs-bdp-pds`, files `gfs.YYYYMMDD/HH/atmos/gfs.tHHz.pgrb2.{0p25,0p50,1p00}.fFFF` with a `.idx` file per GRIB that lists the byte range of every field, so we can download only the fields we need with HTTP Range requests. Archive starts around 2021-01-01 (nothing in 2020), about 5.8 years. GRIB messages are global, so cropping to Texas happens after download. Fields wanted: UGRD, VGRD, TMP, HGT, RH on 21 levels (1000 to 100 hPa) plus 10 m wind, 2 m temp, MSL pressure, cloud cover, precipitation. Measured size per forecast step for those fields: 0.25° 91.7 MB, 0.5° 27.7 MB, 1.0° 7.9 MB. Measured home download speed: ~17 MB/s (one stream). Raw GRIB is transient (crop, then delete); the cropped store is only a few GB.
- **GFS ingestion lessons (`src/ingest/gfs.py`, `scripts/fetch_gfs.py`):** (1) AWS throttles each connection (~0.15 MB/s at times, though one test earlier hit 17 MB/s), but connections don't share the limit, so fetch byte ranges in parallel threads. (2) **ecCodes/cfgrib is not thread-safe**: download in threads, decode serially. (3) Running the env's python directly (not via `conda run`) needs `C:\Users\saket\anaconda3\envs\balloon\Library\bin` on PATH or ecCodes isn't found. `conda run` buffers all output until exit, so for long jobs use the env python with `python -u`. (4) APCP does not exist at step 0, so `tp` is NaN there on purpose. (5) Output is one NetCDF per (date, cycle), ~3 MB per run, in `~/balloon-data/processed/gfs/`.
- **Possible future data (not started; user decides when):** (1) **ERA5 reanalysis** is the leading candidate for a gridded "truth" over Austin itself (the nearest sounding stations are 270+ km away) and gives hourly valid times, so many more training pairs. It needs a free Copernicus CDS account and API key that the *user* creates; never ask for the key in chat, read it from `~/.cdsapirc` or an env var. ERA5 is a model blend of observations, not a measurement, so keep the real soundings as an independent check. (2) More GFS cycles (00Z/06Z/18Z). (3) GEFS ensemble members for calibrated uncertainty. (4) HRRR analyses (check archive start date first). (5) AMDAR aircraft winds via MADIS (check access). (6) SondeHub flights and the club's own flights as final tests.
- IGRA missing values are -9999 and -8888 (QC-removed). Wind speed is in tenths of m/s, temperature in tenths of °C, pressure in Pa.
