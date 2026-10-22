"""Does GEFS ensemble spread predict how wrong a GFS-driven landing is?

For every (station, forecast run, lead) in the forecast-vs-sounding comparison we attach
  spread_ms : GEFS wind spread (vector std dev across members), mean over 500/300/200 hPa and over a
              +-1 degree box around the station, at the valid time of the flight
  gfs_wind_ms : the GFS forecast wind speed, same levels and box (a CONTROL: strong winds mean bigger
              errors, and spread could merely stand in for that)
then fit gradient boosting on log(landing error) with a time split (train before 2025, test 2025+)
and compare feature sets. The lead-time-only model is the baseline spread has to beat.

Spread is stored at leads 0,12,24,36,48,72,96,120 h; leads 60/84/108 are interpolated linearly.
Only forecast-time information is used as a feature, except in the rows marked "(+ observed drift)",
which reproduce the earlier experiment (drift is only known after the flight).

Run from the project root:  python -u -W ignore -m scripts.spread_test
"""
import numpy as np
import pandas as pd
import xarray as xr
from scipy.stats import spearmanr
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import r2_score

from src.ingest import gefs, gfs, igra
from src.paths import PROCESSED_DIR
from src.uncertainty.features import situation_features

EVAL = PROCESSED_DIR / "eval"
FEATURES = EVAL / "spread_features.csv"


def build_features(flights: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for init, grp in flights.groupby("init"):
        day = pd.Timestamp(init).date()
        try:
            with xr.open_dataset(gefs.output_path(day)) as s, xr.open_dataset(gfs.output_path(day, 12)) as g:
                s, g = s.load(), g.load()
        except FileNotFoundError:
            continue
        for st, gs in grp.groupby("station"):
            lat, lon = igra.STATION_INFO[st]["lat"], igra.STATION_INFO[st]["lon"]
            sp, wind = situation_features(s, g, lat, lon, gs.lead_h.values)
            rows.append(gs.assign(spread_ms=sp, gfs_wind_ms=wind))
    return pd.concat(rows)


def fit_score(df, cols, train, test):
    m = HistGradientBoostingRegressor(max_depth=4, learning_rate=0.05, max_iter=300, random_state=0)
    m.fit(train[cols], train.log_err)
    pred = m.predict(test[cols])
    return r2_score(test.log_err, pred), pred


if __name__ == "__main__":
    flights = pd.read_csv(EVAL / "gfs_vs_sondes_flights.csv", parse_dates=["init"])
    if FEATURES.exists():
        df = pd.read_csv(FEATURES, parse_dates=["init"])
    else:
        df = build_features(flights)
        df.to_csv(FEATURES, index=False)
    df = df[df.landing_error_km > 0].dropna(subset=["spread_ms", "gfs_wind_ms"]).copy()
    df["log_err"] = np.log(df.landing_error_km)
    df["month"] = df.init.dt.month + 0  # valid month ~ init month (leads <= 5 days)
    train, test = df[df.init < "2025-01-01"], df[df.init >= "2025-01-01"]
    print(f"{len(df)} rows; train {len(train)} (2021-2024), test {len(test)} (2025-2026)")
    print(f"spread_ms: median {df.spread_ms.median():.2f}, 10-90% {df.spread_ms.quantile(.1):.2f}-{df.spread_ms.quantile(.9):.2f}")

    sets = {
        "lead only (baseline)": ["lead_h"],
        "lead + month": ["lead_h", "month"],
        "lead + month + GFS wind (control)": ["lead_h", "month", "gfs_wind_ms"],
        "lead + month + SPREAD": ["lead_h", "month", "spread_ms"],
        "lead + month + GFS wind + SPREAD": ["lead_h", "month", "gfs_wind_ms", "spread_ms"],
        "lead + month + drift (+ observed drift)": ["lead_h", "month", "obs_drift_km"],
        "lead + month + drift + SPREAD (+ observed drift)": ["lead_h", "month", "obs_drift_km", "spread_ms"],
    }
    print("\nTEST R2 of log landing error (higher is better)")
    preds = {}
    for name, cols in sets.items():
        r2, preds[name] = fit_score(df, cols, train, test)
        print(f"  {r2:6.3f}  {name}")

    # Does spread carry information the lead time does not? Look WITHIN each lead.
    print("\nWithin each lead (test): Spearman correlation with log landing error")
    out = []
    for lead, g in test.groupby("lead_h"):
        out.append((lead, len(g), spearmanr(g.spread_ms, g.log_err)[0], spearmanr(g.gfs_wind_ms, g.log_err)[0],
                    spearmanr(g.spread_ms, g.gfs_wind_ms)[0]))
    print(pd.DataFrame(out, columns=["lead_h", "n", "rho_spread", "rho_gfs_wind", "rho_spread_vs_wind"]).round(2).to_string(index=False))

    # Sharpness and calibration of the predicted error size: 5 buckets of predicted error
    print("\nBuckets of predicted error (test): actual median / p90 landing error in km")
    for name in ["lead + month", "lead + month + GFS wind + SPREAD"]:
        t = test.assign(pred=np.exp(preds[name]))
        t["bucket"] = pd.qcut(t.pred, 5, labels=False)
        g = t.groupby("bucket").agg(n=("pred", "size"), pred_km=("pred", "median"),
                                    actual_median=("landing_error_km", "median"),
                                    actual_p90=("landing_error_km", lambda x: x.quantile(0.9))).round(1)
        print(f"  {name}\n{g.to_string()}")
