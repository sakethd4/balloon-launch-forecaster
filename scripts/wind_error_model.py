"""Train and test the wind-error generator (src/uncertainty/wind_error.py).

Time split: train on forecast runs before 2025, test on 2025-2026 (24k sounding profiles). Three models
share all the machinery and differ only in what they know about the forecast situation:
  lead         : lead time only. This is the old baseline (error statistics by lead), as a generator.
  lead+month   : adds the season.
  full         : adds GFS wind speed and GEFS ensemble spread.
For every test profile each model draws 100 error profiles; each is turned into a landing displacement
(km east/north of the forecast landing), and the REAL measured error's displacement is the target.

Scores (landing displacement, 2-D):
  energy score (km, lower is better): proper score for a sampled 2-D distribution; rewards being both
      calibrated and sharp.
  coverage: share of real errors inside the sampled 50% / 90% radius around the forecast landing
      (a calibrated model gives 50% / 90%).
  r50 / r90: mean sampled radius (km). Smaller at the same coverage means sharper.

Run from the project root:  python -u -W ignore -m scripts.wind_error_model
"""
import time

import joblib
import numpy as np
import pandas as pd

from src.paths import PROCESSED_DIR
from src.uncertainty import wind_error as we

EVAL = PROCESSED_DIR / "eval"
N_SAMPLES = 100
SEASONS = {12: "DJF", 1: "DJF", 2: "DJF", 3: "MAM", 4: "MAM", 5: "MAM",
           6: "JJA", 7: "JJA", 8: "JJA", 9: "SON", 10: "SON", 11: "SON"}


def energy_score(samples, y, batch=1000):
    """samples (R, S, 2), y (R, 2) -> energy score per row."""
    out = np.empty(len(y))
    for i in range(0, len(y), batch):
        x, t = samples[i:i + batch], y[i:i + batch]
        a = np.linalg.norm(x - t[:, None, :], axis=-1).mean(axis=1)
        b = np.linalg.norm(x[:, :, None, :] - x[:, None, :, :], axis=-1).mean(axis=(1, 2))
        out[i:i + batch] = a - 0.5 * b
    return out


def score(samples, y):
    r = np.linalg.norm(samples, axis=-1)                      # sampled landing displacement sizes
    r50, r90 = np.quantile(r, [0.5, 0.9], axis=1)
    ry = np.linalg.norm(y, axis=-1)
    return dict(energy=energy_score(samples, y), cover50=ry <= r50, cover90=ry <= r90, r50=r50, r90=r90)


if __name__ == "__main__":
    pd.set_option("display.width", 160)
    t0 = time.time()
    levels = pd.read_csv(EVAL / "gfs_vs_sondes_levels.csv", usecols=["station", "init", "lead_h", "level_hpa", "du", "dv"],
                         parse_dates=["init"])
    feats = pd.read_csv(EVAL / "spread_features.csv", parse_dates=["init"])
    table = we.profile_table(levels, feats)
    train, test = table[table.init < "2025-01-01"].reset_index(drop=True), table[table.init >= "2025-01-01"].reset_index(drop=True)
    print(f"{len(table)} profiles; train {len(train)} (2021-2024), test {len(test)} (2025-2026)", flush=True)

    # 1. Is the linear landing shortcut faithful to the full simulator? Compare with the simulator's landing error.
    flights = feats[["station", "init", "lead_h", "landing_error_km"]]
    chk = table.merge(flights, on=["station", "init", "lead_h"])
    approx = np.linalg.norm(we.landing_displacement_km(chk[we.OUTPUTS].to_numpy()), axis=-1)
    print(f"\nLINEAR SHORTCUT vs simulator landing error ({len(chk)} profiles): "
          f"correlation {np.corrcoef(approx, chk.landing_error_km)[0, 1]:.3f}; "
          f"median shortcut {np.median(approx):.2f} km vs simulator {chk.landing_error_km.median():.2f} km; "
          f"median |difference| {np.median(np.abs(approx - chk.landing_error_km)):.2f} km", flush=True)

    # 2. Fit the models and score the landing distributions on the test years.
    y = we.landing_displacement_km(test[we.OUTPUTS].to_numpy())
    results, per_row, models = {}, {}, {}
    for name, cols in we.FEATURE_SETS.items():
        m = we.WindErrorModel(cols).fit(train)
        samples = we.landing_displacement_km(m.sample(test, N_SAMPLES, np.random.default_rng(1)))
        results[name] = score(samples, y)
        models[name] = m
        print(f"  fitted and scored '{name}' ({(time.time() - t0) / 60:.1f} min)", flush=True)
        joblib.dump(m, PROCESSED_DIR / f"wind_error_{name.replace('+', '_')}.joblib")

    print("\nLANDING DISTRIBUTION on the test years (km; coverage should be 50% / 90%)")
    rows = [dict(model=n, energy_score=r["energy"].mean(), coverage50=r["cover50"].mean(), coverage90=r["cover90"].mean(),
                 mean_r50=r["r50"].mean(), mean_r90=r["r90"].mean()) for n, r in results.items()]
    print(pd.DataFrame(rows).round(3).to_string(index=False))

    print("\nBy lead time: coverage90 / energy score (km)")
    out = {}
    for n, r in results.items():
        d = pd.DataFrame({"lead_h": test.lead_h, "c90": r["cover90"], "es": r["energy"]}).groupby("lead_h").mean()
        out[f"{n} cov90"], out[f"{n} ES"] = d.c90, d.es
    print(pd.DataFrame(out).round(2).to_string())

    print("\nBy season (full model): coverage50 / coverage90 / energy score; baseline 'lead' energy score")
    ss = test.init.dt.month.map(SEASONS)
    d = pd.DataFrame({"season": ss, "c50": results["full"]["cover50"], "c90": results["full"]["cover90"],
                      "ES_full": results["full"]["energy"], "ES_lead": results["lead"]["energy"]}).groupby("season").mean()
    print(d.reindex(["DJF", "MAM", "JJA", "SON"]).round(2).to_string())

    print("\nBy station (full model)")
    d = pd.DataFrame({"station": test.station, "c50": results["full"]["cover50"], "c90": results["full"]["cover90"],
                      "ES_full": results["full"]["energy"], "ES_lead": results["lead"]["energy"]}).groupby("station").mean()
    print(d.round(2).to_string())

    print("\nIs the predicted size informative? Test rows in 5 buckets of the full model's mean r90")
    r90 = results["full"]["r90"]
    b = pd.qcut(r90, 5, labels=False)
    ry = np.linalg.norm(y, axis=-1)
    d = pd.DataFrame({"bucket": b, "pred_r90": r90, "actual_median": ry, "c90": results["full"]["cover90"]})
    print(d.groupby("bucket").agg(n=("pred_r90", "size"), pred_r90_km=("pred_r90", "median"),
                                  actual_median_km=("actual_median", "median"),
                                  actual_p90_km=("actual_median", lambda x: x.quantile(0.9)), coverage90=("c90", "mean")).round(2).to_string())
    pd.DataFrame(rows).to_csv(EVAL / "wind_error_model_results.csv", index=False)
    print(f"\nDone in {(time.time() - t0) / 60:.1f} min")
