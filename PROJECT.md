# Launch Planner: a probabilistic flight simulator for our weather balloon

## Overview

Our club is building a helium weather balloon that climbs to about 45,000 ft (13.7 km) from the Austin area, carrying an 80 g payload. Where it lands depends on the winds it meets during roughly 55 minutes of flight: about 40 minutes up and 15 minutes down. Choosing the launch site and hour well is the biggest thing we can control.

This project builds a **launch planner**: an interactive web app where you pick a launch site and time and see where the balloon is expected to go. Instead of one line on a map, it shows a **range of plausible flights with honest probabilities**, and it helps compare sites and hours.

Why probabilistic? The public NOAA forecast (GFS) is already good, so we are not trying to beat it at predicting weather. But no forecast is exact, and a planner needs to answer "how likely is a good landing?", not just "where is the best guess?". The machine-learning core of the project is to learn how forecast winds go wrong and what that means for a flight, so the uncertainty we show is calibrated: a "90% zone" should really contain the landing about 90% of the time.

## Goals

1. **A 4D flight simulator** that flies the balloon through a real forecast, where wind changes with place, altitude and time. *(Built and tested.)*
2. **A learned uncertainty layer** that turns one simulated flight into a calibrated distribution of flights, adapting to the day (calm days get tight zones, risky days get wide ones).
3. **A launch-planner web app** with an interactive map: launch site, flight and descent path, landing probability, and a comparison of sites and hours.
4. **Honest evaluation.** Every model is compared against simple baselines on future data it never saw, and failures are reported.

### Non-goals

- Beating weather models at forecasting weather.
- Regulatory or airspace logic. The club handles that. The app can display a user-supplied allowed/restricted-area layer, but it never decides what is allowed.
- A safety-certified go/no-go system. The app is advisory, and the flight lead makes the final call.

## Balloon and region

| Item | Value |
|---|---|
| Balloon | 50 g latex, typically bursts around 50,000 ft |
| Target ceiling | ~45,000 ft (~13.7 km), set by the fill |
| Payload | ~80 g, no extra rigging |
| Lift gas | Helium |
| Ascent rate | ~350 m/min (~5.8 m/s), about 40 min to the ceiling |
| Descent rate | ~15 m/s average under parachute, about 15 min |
| Fill volume | Not decided yet (placeholder) |

**Region.** Launch sites near Austin, Texas, not yet chosen: helping choose them is part of the goal. The forecast domain covers roughly 27–35°N, 103–92°W. At this ceiling the balloon stays in the lower atmosphere, so jet-stream and upper-level winds (200–500 hPa) decide most of the drift, and most of that happens during the climb.

## What we have measured so far

We collected 5.6 years of NOAA GFS forecasts (2,037 daily runs, cropped to Texas) and compared them with real weather-balloon soundings at four stations (Fort Worth, Corpus Christi, Del Rio, Midland), flying our simulated balloon through both. The "landing error" is the distance between the two landings.

| Forecast lead time | Wind error at 300 hPa | Median landing error | 90th-percentile landing error |
|---|---|---|---|
| 0 h | 3.5 m/s | 2.3 km | 5.5 km |
| 24 h | 4.8 m/s | 3.8 km | 8.6 km |
| 72 h | 7.6 m/s | 7.7 km | 16.9 km |
| 120 h | 11.0 m/s | 12.6 km | 27.7 km |

What it tells us:

- **The raw forecast is good.** The typical drift is about 46 km, so a one-day forecast puts the landing within roughly 8% of the drift.
- **Seasons matter a lot.** Median drift is about 80 km in winter and about 18 km in summer.
- **Simple bias correction barely helps.** Subtracting GFS's average error improves landing error by 2–8% at 1–3 days (a few hundred meters). The error is mostly random, not systematic, so a model that just "fixes the forecast" has little to gain.
- **A frozen wind profile is nearly as good as 4D.** The full 4D simulator differs by about 0.5 km on average in September and 1.5 km in January (up to 5 km), the same size as the forecast's own error.
- **The size of the error is partly predictable.** A model using lead time explains 35% of the variation in log landing error, and adding month and drift distance raises that to 39%. This is the opening for learned uncertainty.

These are the baselines our ML must beat. Caveats: the soundings are 270+ km from Austin; flights in the comparison are launched from the stations; and NOAA's later GFS model updates (after March 2021) have not been checked for their effect on error.

## Approach

1. **Physics backbone (done).** The 4D simulator, validated against hand-calculated cases and a simpler 1D version.
2. **Real flight tracks (next).** SondeHub keeps an open archive of GPS tracks from weather balloons. Comparing our simulated path with real tracks tells us how accurate the simulator is and reveals what it misses (climb-rate variation, sub-grid winds). It is the only true flight data we can get at scale.
3. **Learned uncertainty.** First test cheap ideas: whether landing error is stretched along the wind direction (an ellipse instead of a ring) and whether the spread of the 30-member GEFS ensemble predicts how uncertain a day is. Then build a model of forecast **wind error by altitude** that can generate realistic error profiles. Pushing each sampled profile through the physics simulator gives a cloud of flights that works for any launch time or balloon setup. We judge it by calibration (does the 90% zone hold 90%?) and a proper scoring rule against the simple error-table baseline.
4. **Decision layer.** Rank launch sites and hours by the probability of a good landing (for example, close to the launch site, away from water), shown as a landing-probability heat map.

Also under consideration: analog forecasts (finding past days that looked like the coming one and showing how flights went), and an ERA5 climatology of flights from each candidate site across decades.

## The launch-planner app (first version built)

The first version runs simulations on a local Python server and displays the results in a CesiumJS/Three.js browser viewer. It supports launch location/hour selection, terrain, probability rings, clickable possible flights, and orbit, chase, payload and top cameras. Site ranking and the additional controls below remain planned:

- Click the map to set the launch site. The flight path is colored by altitude, with the burst point and landing marked, plus the landing probability zone.
- Controls for launch date and hour, ascent rate, burst altitude and descent rate.
- Side view of altitude against distance, and wind speed and direction by altitude.
- A timeline of drift distance and direction across launch hours.
- A grid of candidate launch sites colored by how forgiving they are, with an optional allowed-area overlay from a file the club provides.

Open decisions: who uses it and how it is shared (local only, a private link, or public), and whether the forecast is live (needs a scheduled data job) or fixed archived days.

## Data

| Source | Use | Status |
|---|---|---|
| NOAA GFS forecasts (AWS open data), 0.5°, 12Z run, 21 steps, 1000–100 hPa | Forecast winds; the simulator's input | Done: 2021-03-22 to 2026-10-18, 4.5 GB |
| NOAA IGRA radiosonde soundings, four stations | Ground truth for winds aloft | Done: full history |
| SondeHub open telemetry | Real flight tracks | Collected and evaluated |
| GEFS ensemble forecasts | Predicting how uncertain a day is | Collected; spread used in learned error model |
| ERA5 reanalysis (optional) | Winds over Austin itself; climatology | Possible later |
| The club's own flights | The final test | When available |

Data lives outside the project folder (`~/balloon-data`). Large downloads run on Google Colab, because the laptop's connection to the data servers is much slower than Colab's.

## Evaluation rules

- Always train on earlier years and test on later ones. Random splits leak weather patterns between neighboring days.
- Compare every model with: raw forecast, the simple error table, and the simple bias correction.
- Judge uncertainty by calibration, not only accuracy.
- Report where a model fails or ties the baseline.

## Status

| Piece | State |
|---|---|
| Data pipeline (GFS, soundings) | Done and verified |
| 1D and 4D flight simulators | Done, 21 tests passing |
| Forecast-vs-sounding baseline and bias baseline | Done |
| Real-track validation (SondeHub) | Built; simulator and landing-zone checks completed |
| Learned uncertainty | First calibrated model built; gains over lead-time baseline are modest (see CLAUDE.md) |
| Web app | First local version built; viewer fixes implemented 2026-10-22, visual/GPU verification pending |

## Risks and open questions

- **ML gains may be modest.** The forecast is already good. The value we expect is calibrated uncertainty, and we will report it honestly either way.
- **Terrain remains approximate.** The app uses real elevation tiles for launch ground height and displayed terrain; it does not simulate terrain-following winds or detailed landing obstacles.
- **Fill volume and real balloon behavior are unknown.** Real ascent rate, burst altitude and descent rate vary with the fill, temperature and balloon quality.
- **Soundings are not at Austin.** ERA5 or real tracks could close this gap.
- **GFS model updates** after March 2021 may change the error behavior. We still need to check their dates.
- **Hosting decision** for the web app.

## Team and roles (to fill in)

- Data and infrastructure
- Modeling and evaluation
- Web app and visualization
- Flight lead: balloon specs, launch criteria, regulatory constraints

### Viewer maintenance (2026-10-22)

Implemented fixes for zoom-dependent balloon scale/position, bright overlapping launch markers and wind particles,
cloud visibility/stability, followed projected routes and underground cameras. Default visual quality is preserved;
performance work removes repeated allocations, paused geometry updates and excess telemetry DOM work. Adaptive quality
reductions are opt-in. Cloud shapes are illustrative within forecast humidity, and camera clearance depends on loaded
terrain. Browser visual checks and laptop GPU measurements are pending; implementation and verification details are in
web/README.md and CLAUDE.md.
