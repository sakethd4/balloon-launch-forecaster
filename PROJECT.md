# Launch Window Forecaster for High-Altitude Balloon Flights

## Overview

Our club is building a weather balloon that will reach the stratosphere (~25–35 km) and collect atmospheric data. Choosing *when* to launch is one of our biggest risks. A bad day means a balloon that drifts hundreds of kilometers, lands in water or a city, bursts early in cloud or icing, or can't be recovered.

This project builds a large-scale training pipeline and a forecast tool on top of it. The tool predicts the conditions that matter for a flight over a window the user picks, ranks launch times by how forgiving they are, and shows everything in an interactive visualization.

We know weather is hard to predict. We are **not** trying to beat professional forecasters at general weather. Government models (NOAA GFS, HRRR, ECMWF) already do the physics. Our models learn the *errors and local biases* of those forecasts at our launch region, specifically for the variables that drive balloon flights (winds aloft above all), and turn the corrected forecast into flight outcomes. This is also a learning project covering data engineering, deep learning at scale, and honest evaluation.

## Goals

1. **Large-scale training pipeline.** Reproducible, resumable training on many years of data, run on Google Colab Premium, with experiment tracking.
2. **Corrected forecasts.** For lead times from 0 to ~7 days, predict winds (by altitude), temperature, cloud cover, and precipitation at our launch region, with uncertainty.
3. **Flight outcome prediction.** Predict landing location (as a region), ascent profile, and drift for a given launch time, plus a launch-window score with a plain-language explanation.
4. **Visualization.** An interactive dashboard where the user picks a future window and sees the predicted conditions (details below).
5. **Honest evaluation.** Every model is compared against simple baselines, and failures are reported.

### Non-goals

- Replacing NWP models or forecasting global weather.
- A safety-certified go/no-go system. Final launch decisions stay with the flight lead, and FAA/regulatory rules (14 CFR Part 101) and site rules apply regardless of what the tool says.

## Launch region and balloon

**Region.** Launch sites in the Austin, Texas area. The forecast domain is a regional map around central Texas (initial guess: roughly 27–35°N, 103–92°W, wide enough to cover where a balloon launched near Austin could land). Launch sites are not chosen yet, and finding good ones is part of what the tool is for. Instead of a fixed list, the tool evaluates a **grid of candidate launch points** across the Austin area (plus any named sites in `configs/sites.yaml`), predicts the landing region for each, and shows the result as a site-suitability map. The club can overlay its own allowed/restricted-area polygons (GeoJSON) to see which good spots are also permitted. The tool displays these layers but does not decide what is allowed. Nearest radiosonde stations for ground truth are Fort Worth (FWD), Corpus Christi (CRP), Del Rio (DRT), and Midland (MAF); to be confirmed against IGRA's station list.

**Balloon (current spec).**

| Item | Value |
|---|---|
| Balloon | 50 g latex, typically tops out around 50,000 ft (~15.2 km) |
| Target flight ceiling | ~45,000 ft (~13.7 km), controlled by fill |
| Payload | ~80 g target |
| Lift gas | Helium |
| Target ascent rate | ~350 m/min (~5.8 m/s, ~1,150 ft/min) |
| Descent rate | ~15 m/s average under parachute (no extra rigging weight beyond the 80 g payload) |
| Fill volume | **Not yet decided; placeholder** |

Design consequences:

- A ~13.7 km target ceiling (rated max ~15.2 km) is roughly the tropopause/jet-stream level. This balloon will **not** reach the stratospheric turnaround layer (~18–25 km). The vertical model domain is the surface to ~100 hPa (about 16 km), with the most weight on 200–500 hPa winds.
- At 350 m/min the climb to 45,000 ft takes about 40 minutes. The descent takes about 15 minutes (13.7 km at an average 15 m/s). So the total flight is under an hour, and most of the drift happens during the ascent, with the jet-stream layers pushing the balloon furthest. The wind profile from 200–500 hPa dominates the landing location.
- Burst altitude, ascent rate, and descent rate are inputs to the trajectory model. Treat burst altitude as uncertain (it varies with fill, temperature, and balloon quality), and model ascent rate as a distribution around 350 m/min.
- Fill volume sets the ascent rate. With helium it can be computed from total mass (balloon + payload + any rigging) and the target rate once the balloon's specs are known, so it should come from a lift calculator rather than a guess.

## What "forgiving conditions" means

These criteria are our initial hypothesis. We should refine them with the club's flight experience.

| Factor | Why it matters |
|---|---|
| Surface wind at launch | Strong wind makes inflation and release dangerous and can damage the balloon |
| Wind speed/direction by altitude (esp. jet stream, 9–15 km) | Drives total drift distance and therefore the landing zone |
| Wind shear | Stresses the payload train and causes erratic ascent |
| Wind reversals in the upper troposphere | Layers with opposing wind directions can reduce total drift. (The stratospheric turnaround layer at ~18–25 km is above this balloon's ceiling.) |
| Cloud cover / precipitation / icing | Hurts sensors, tracking, and balloon integrity, and affects camera data |
| Temperature at launch | Cold-soaked batteries and latex brittleness |
| Predicted landing zone | Avoid lakes, cities, airports, restricted airspace, dense forest |
| Forecast stability | A forecast that keeps changing is less trustworthy |

## Data

All sources are free. At this scale, data volume is the main engineering challenge, so we store data in chunked, cloud-friendly formats and never re-download.

| Source | Use | Notes |
|---|---|---|
| ERA5 reanalysis (Copernicus CDS) | Long consistent "truth" for training targets | Needs a free account and API key; downloads are queued and slow, so request in monthly shards |
| NOAA GFS archive (AWS Open Data / NCAR RDA) | Historical forecasts at many lead times (model input) | The core input. We need *past forecasts*, not just past analyses, to learn forecast errors |
| NOAA HRRR archive (AWS Open Data) | High-resolution short-range US forecasts | Lead times up to ~48 h only |
| NOAA IGRA / Univ. of Wyoming radiosondes | Real observed profiles up to ~30 km | Ground truth for winds aloft at specific stations |
| SondeHub / amateur radiosonde tracks | Real balloon flight paths and landings | Validates the trajectory and landing models |
| Open-Meteo API | Live forecasts for inference and prototyping | Handy for the dashboard's live mode |
| Our own flight logs | Most relevant data for our balloon | Little of it; used for calibration and final testing |

Target training set: roughly 10+ years of paired (forecast, observation) data over the central-Texas domain described above, from the surface to ~100 hPa. Start with 1–2 years to prove the pipeline, then scale up.

**Storage.** About 1 TB of Google Drive is available, but it belongs to a different Google account than the Colab Pro account. Plan: the Drive owner shares a dedicated project folder with the Colab account as Editor, and the pipeline reads and writes there. Files in a shared folder count against the owner's quota, so the full 1 TB is usable. See CLAUDE.md for the workflow and its fallback. Keep the training store to a few hundred GB at most so there is room for checkpoints and results.

## Models

Model progression, simplest first. Each stage must beat the previous one on the held-out test set to justify its cost.

1. **Baselines (no ML).** Climatology; raw GFS plus a physics trajectory predictor (e.g. CUSF/Tawhiri); a rule-based window score.
2. **Tabular outcome models.** Gradient-boosted trees (LightGBM) predicting landing distance, drift direction, and ascent rate from forecast features at radiosonde stations.
3. **Forecast-correction deep model.** A PyTorch network that takes the raw forecast (gridded fields on pressure levels and a lead-time embedding) and predicts the correction toward observed or reanalysis values. Candidates: U-Net/ConvLSTM on regional patches, or a small transformer over the vertical profile and time. Output is a distribution (quantiles or a mixture), not a single value.
4. **Ensemble and calibration.** Combine models and calibrate the uncertainty so that an "80% interval" really contains the truth about 80% of the time.
5. **Optional extension.** Use open pretrained weather models (e.g. GraphCast, Pangu-Weather, Aurora) as extra inputs or for fine-tuning, if licensing and compute allow. Don't plan around this until stages 1–4 work.

Finally, predicted conditions feed the trajectory simulator and scoring logic to produce landing regions and launch-window scores.

## Large-scale training pipeline

```
 Ingest (sharded, cached)
        |
 Raw store ---> Preprocess/align ---> Training store (Zarr on Drive / cloud bucket)
                                              |
                      Train (Colab GPU, config-driven, checkpointed)
                                              |
                 Evaluate (time-split) ---> Experiment tracker + model registry
                                              |
        Scheduled inference on newest forecast ---> Forecast products (files)
                                              |
                                        Dashboard
```

### Compute: Google Colab Premium

Colab gives us GPUs without owning hardware, but with constraints the pipeline has to be designed around:

- **Runtimes are temporary.** They disconnect on idle or after a maximum session length, and local disk is wiped. Training must save checkpoints regularly (to Google Drive or a bucket) and resume automatically.
- **Storage lives outside the runtime.** All datasets, checkpoints, and results go to Google Drive (or a cloud bucket). Data is read in chunks from Zarr, not loaded whole into memory.
- **Code lives in Git, not in notebooks.** Notebooks are thin launchers: they clone the repo, mount storage, and run `python -m src.train --config configs/<experiment>.yaml`. This keeps the work reviewable and lets us run the same code locally for small tests.
- **Jobs are shardable and idempotent.** Ingestion and preprocessing split work into independent shards (for example one month each), skip finished ones, and can be restarted at any point.
- **Budget: 100 compute units, so GPU time is rationed.** Colab Pro units drain much faster on a GPU than on a CPU runtime (a T4 uses roughly 1.5–2 units per hour; check the Colab resources page for current rates). That is about 50 GPU hours in total, shared by the whole club. Rules:
  - Do all data downloading, preprocessing, baselines, and LightGBM on a **CPU runtime** or on the **local laptop** (Windows 11, NVIDIA RTX 3050 6 GB, ~595 GB free disk). The local GPU is also good for debugging and small models, since it costs no units. Its 6 GB of memory limits batch and model size, so use Colab's T4 for the full-size deep-model runs.
  - Debug on a tiny subset (one month, one site) before any long GPU run. Test the code path on CPU first.
  - Set a unit budget per phase and track spending in the experiment log. Disconnect the runtime as soon as a job finishes; an idle GPU still burns units.
  - Prefer small, efficient models and mixed precision, and checkpoint often so a disconnect doesn't waste units.
  - Start with a short training run, check that the loss and validation metrics behave, and only then launch the full run.

### Experiment management

Every run is defined by a config file (YAML) with a fixed seed, logs metrics to an experiment tracker (Weights & Biases or TensorBoard), and saves its config and git commit with its checkpoints, so any result can be reproduced.

## Evaluation

- **Time-based splits only.** Train on earlier years, validate on a later block, test on the most recent block. Random splits leak weather patterns from neighboring days and give fake results.
- Compare against: (a) climatology, (b) raw GFS/HRRR, (c) raw forecast plus trajectory predictor, (d) rule-based score.
- Metrics: wind error by altitude band and lead time (RMSE/MAE), landing-distance error (km), landing-region coverage (does the 80% region contain the real landing?), probabilistic scores (CRPS, calibration curves), and ranking quality for launch windows (are good days ranked above bad days?).
- Report where the model fails or merely ties the baseline. That is still a valid learning result.

## Visualization

The dashboard is a first-class deliverable, not an afterthought. The user chooses a **future window** (start date/time and end date/time, within the forecast horizon) and optionally a launch site, and the dashboard shows what we predict for that window.

Planned views:

1. **Window selector.** Pick start and end; the rest of the page updates.
2. **Launch-window score timeline.** A score for each candidate launch hour with an uncertainty band and a confidence indicator that falls with lead time. The best windows are highlighted with a short explanation of why.
3. **Wind profile over time.** A time-by-altitude heatmap of wind speed with direction arrows/barbs, with the jet stream and the stratospheric turnaround layer visible.
4. **Surface and cloud conditions.** Timelines of surface wind, temperature, cloud cover, and precipitation probability, with intervals.
5. **Regional forecast map (centerpiece).** A map of the whole forecast area around Austin. The user chooses a time within the window, an altitude layer (surface, 850, 700, 500, 300, 200 hPa), and a variable (wind, temperature, cloud cover, precipitation), and sees the predicted field with wind arrows. A time slider animates it across the window.
6. **Landing map.** For a selected launch site and time, the predicted flight path and landing region (percentile rings) on the same map. A **site-suitability mode** colors a grid of candidate launch points by how good they are for the chosen time (for example, how far and in which direction the balloon lands, and whether the landing region is over land and reachable). Hovering a point shows its predicted landing region. The club can load its own allowed/restricted-area polygons (GeoJSON) as an overlay to compare. Physical hazards (water, cities, dense forest) are marked as map layers; the tool does not determine what is legal.
7. **Raw vs corrected forecast.** An overlay of the original GFS/HRRR forecast and our corrected forecast, so users can see what the model changed.
8. **Model transparency.** Per-factor breakdown of each score, plus the model's historical accuracy at that lead time.

Implementation: Streamlit with Plotly (charts) and a map library (pydeck or folium). The dashboard does **not** run models live. A scheduled inference job writes forecast products (Parquet/Zarr/JSON) that the dashboard only reads, which keeps the interface fast and lets it run without a GPU. The dashboard clearly labels forecasts as advisory and shows regulatory reminders.

## Milestones

| Phase | Deliverable |
|---|---|
| 1. Setup | Repo, environment, Colab workflow, launch site, and the criteria table decided |
| 2. Data | Sharded ingestion for GFS archive, ERA5, and radiosondes; Zarr training store |
| 3. Baselines | Trajectory prediction on GFS; rule-based score; evaluation harness with time splits |
| 4. Tabular models | LightGBM outcome models, compared with baselines |
| 5. Deep model | Forecast-correction network trained on Colab, with checkpoint/resume and tracking |
| 6. Calibration | Calibrated uncertainty, ensembles, final evaluation on the held-out test period |
| 7. Inference + dashboard | Scheduled inference job; Streamlit dashboard with the views above |
| 8. Field test | Compare predictions to a real club launch and write up the result |

## Risks and open questions

- **Past forecasts are hard to get at scale.** Archived GFS forecasts at many lead times are large and slow to pull. Start with a short period and one lead-time subset, and grow.
- **Colab limits.** Disconnects, GPU availability, and session caps can stall long runs. Mitigated by checkpointing and shardable jobs, but total GPU hours are limited by the subscription.
- **Little flight data.** The club has few or no past flights, so we rely on public radiosonde data as a proxy. Our balloon differs (size, payload mass, ascent rate), so the model needs those as inputs or a calibration step.
- **Forecast skill drops with lead time.** Beyond ~5 days, expect scores to be low-confidence. The tool should say so.
- **Launch sites.** Austin area, specific candidate sites not yet chosen. They define the map domain and recovery terrain. Landing predictions toward the east and southeast can end up over the Gulf or Houston area, so a wide map matters.
- **Balloon details.** Fill volume is unknown.
- **Compute budget.** Only 100 Colab compute units are available, so GPU time is a scarce resource (see the compute section).
- **Scope creep.** Get the baseline and evaluation harness working end to end before adding model complexity.

## Team and roles (to fill in)

- Data engineering: ingestion, storage, scheduling
- ML / training: models, Colab pipeline, experiment tracking
- Evaluation: baselines, metrics, calibration
- Flight domain lead: balloon specs, launch criteria, regulatory constraints
- Frontend: dashboard and visualization
