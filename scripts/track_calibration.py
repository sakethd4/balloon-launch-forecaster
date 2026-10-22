"""Are the landing zones calibrated against REAL flights? (end-to-end check of the whole stack)

For a random sample of 2025-2026 SondeHub legs (climbs and descents of real balloons, from
`scripts.validate_tracks`), each model draws wind-error profiles, adds each to the GFS winds, and
flies the balloon through that alternative wind field along the REAL altitude history with the 4D
simulator. The spread of the end points is the model's claim about the forecast error; the real
error (where the forecast put the balloon minus where it really was) is the target.

The models were trained only on 2021-2024 radiosonde profiles, never on these tracks. Caveat: the
SondeHub balloons are the same weather-service launches as the soundings, so this tests the
landing-zone claim on independently derived GPS positions, not on new weather situations.

Scores as in scripts/wind_error_model.py: coverage of the 50% / 90% radius, mean radii, energy score.

Run from the project root:
  python -u -W ignore -m scripts.track_calibration [--legs 1500] [--samples 30] [--workers 4]
"""
import argparse
import time
from concurrent.futures import ProcessPoolExecutor

import joblib
import numpy as np
import pandas as pd
import xarray as xr

from src.baselines.trajectory4d import WindField4D, drift_along_track
from src.evaluate import track_validation as tv
from src.ingest import gefs, gfs, sondehub
from src.paths import PROCESSED_DIR
from src.uncertainty import wind_error as we
from src.uncertainty.features import situation_features
from src.uncertainty.scoring import score

MODEL_NAMES = ("lead", "full")
_state = {}


def init_worker():
    _state["models"] = {n: joblib.load(PROCESSED_DIR / f"wind_error_{n.replace('+', '_')}.joblib") for n in MODEL_NAMES}
    _state["run"] = None


def run_leg(job):
    serial, station, leg_name, min_lead, n = job
    t = tv.clean_flight(sondehub.load_track(sondehub.compact_path(serial)))
    leg = (tv.ascent_leg if leg_name == "ascent" else tv.descent_leg)(t)
    peak = t.loc[t.alt_m.idxmax()]
    init = tv.pick_init(peak.time - pd.Timedelta(seconds=peak.alt_m / 5.5), min_lead)
    day = init.date()
    if _state["run"] != day:  # fields for this forecast run (jobs come in date order, so mostly cached)
        with xr.open_dataset(gfs.output_path(day, 12)) as g, xr.open_dataset(gefs.output_path(day)) as s:
            g, s = g.load(), s.load()
        _state.update(run=day, gfs=g, gefs=s, field=WindField4D.from_dataset(g))
    field = _state["field"]

    sub, elapsed = tv.subsample(leg)
    start_lead = (leg.time.iloc[0] - init).total_seconds() / 3600.0
    lat0, lon0 = leg.lat.iloc[0], leg.lon.iloc[0]
    ground = min(sondehub.station_elev_m(station), float(leg.alt_m.min()))

    def end_point(f):
        lat, lon = drift_along_track(f, lat0, lon0, start_lead, elapsed, sub.alt_m.to_numpy(), ground_m=ground)
        return lat[-1], lon[-1]

    fc_lat, fc_lon = end_point(field)
    real_east, real_north = tv.local_km(leg.lat.iloc[-1], leg.lon.iloc[-1], fc_lat, fc_lon)  # forecast minus real

    spread, wind = situation_features(_state["gefs"], _state["gfs"], lat0, lon0, start_lead)
    situation = pd.DataFrame([dict(lead_h=start_lead, month=leg.time.iloc[0].month,
                                   gfs_wind_ms=float(wind[0]), spread_ms=float(spread[0]))])
    rng = np.random.default_rng(abs(hash(serial)) % 2**32)
    k = len(we.LEVELS_HPA)
    out = dict(serial=serial, station=station, leg=leg_name, min_lead_h=min_lead, start_lead_h=start_lead,
               real_east=real_east, real_north=real_north, spread_ms=float(spread[0]), gfs_wind_ms=float(wind[0]),
               start_time=leg.time.iloc[0], season=tv.SEASONS[leg.time.iloc[0].month])
    for name, model in _state["models"].items():
        errors = model.sample(situation, n, rng)[0]
        d = np.empty((n, 2))
        for i, e in enumerate(errors):  # truth = forecast - error
            lat, lon = end_point(field.with_column_error(we.LEVELS_HPA, -e[:k], -e[k:]))
            d[i] = tv.local_km(lat, lon, fc_lat, fc_lon)  # forecast minus sampled truth
        out[name] = d
    return out


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--legs", type=int, default=1500)
    p.add_argument("--samples", type=int, default=30)
    p.add_argument("--workers", type=int, default=4)
    args = p.parse_args()
    pd.set_option("display.width", 160)

    res = pd.read_csv(PROCESSED_DIR / "eval" / "track_validation.csv")
    res["start_time"] = pd.to_datetime(res.start_time, utc=True, format="mixed")
    res = res[res.in_domain & (res.start_time >= pd.Timestamp("2025-01-01", tz="UTC"))]
    pick = res.sample(min(args.legs, len(res)), random_state=0).sort_values("start_time")
    print(f"{len(res)} test-period legs available; calibrating on {len(pick)} (x {len(MODEL_NAMES)} models x "
          f"{args.samples} samples)", flush=True)
    jobs = [(r.serial, r.station, r.leg, r.min_lead_h, args.samples) for r in pick.itertuples()]

    t0, rows = time.time(), []
    with ProcessPoolExecutor(args.workers, initializer=init_worker) as ex:
        for i, r in enumerate(ex.map(run_leg, jobs, chunksize=4), 1):
            rows.append(r)
            if i % 100 == 0:
                print(f"  {i}/{len(jobs)} ({(time.time() - t0) / 60:.1f} min)", flush=True)
    meta = pd.DataFrame([{k: v for k, v in r.items() if k not in MODEL_NAMES} for r in rows])
    y = meta[["real_east", "real_north"]].to_numpy()
    scored = {n: score(np.stack([r[n] for r in rows]), y) for n in MODEL_NAMES}
    for n, s in scored.items():
        for key in ("cover50", "cover90", "r50", "r90", "energy"):
            meta[f"{key}_{n}"] = s[key]
    meta.to_csv(PROCESSED_DIR / "eval" / "track_calibration.csv", index=False)

    print(f"\nREAL-TRACK CALIBRATION ({len(meta)} legs, {(time.time() - t0) / 60:.1f} min). Coverage should be 50% / 90%.")
    print(pd.DataFrame([dict(model=n, energy_score_km=meta[f"energy_{n}"].mean(), coverage50=meta[f"cover50_{n}"].mean(),
                             coverage90=meta[f"cover90_{n}"].mean(), mean_r50_km=meta[f"r50_{n}"].mean(),
                             mean_r90_km=meta[f"r90_{n}"].mean()) for n in MODEL_NAMES]).round(3).to_string(index=False))
    meta["real_km"] = np.hypot(meta.real_east, meta.real_north)
    print(f"\nreal error: median {meta.real_km.median():.2f} km, p90 {meta.real_km.quantile(0.9):.2f} km")
    for by in ("leg", "min_lead_h", "season", "station"):
        g = meta.groupby(by).agg(n=("real_km", "size"), real_median=("real_km", "median"), c50_full=("cover50_full", "mean"),
                                 c90_full=("cover90_full", "mean"), c90_lead=("cover90_lead", "mean"),
                                 r90_full=("r90_full", "mean"), r90_lead=("r90_lead", "mean"),
                                 ES_full=("energy_full", "mean"), ES_lead=("energy_lead", "mean")).round(2)
        print(f"\nby {by}\n{g.to_string()}")
    print("\nIs the predicted size informative? 5 buckets of the full model's r90")
    meta["bucket"] = pd.qcut(meta.r90_full, 5, labels=False)
    print(meta.groupby("bucket").agg(n=("real_km", "size"), pred_r90=("r90_full", "median"), real_median=("real_km", "median"),
                                     real_p90=("real_km", lambda x: x.quantile(0.9)), c90=("cover90_full", "mean")).round(2).to_string())
    mean_samples = np.mean([r["full"].mean(axis=0) for r in rows], axis=0)
    print(f"\nMean real error vector (east, north) = ({y[:, 0].mean():.2f}, {y[:, 1].mean():.2f}) km; "
          f"mean of the model's samples = ({mean_samples[0]:.2f}, {mean_samples[1]:.2f}) km (model assumes zero bias)")
