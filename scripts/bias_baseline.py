"""Cheapest baseline: subtract GFS's average error, learned on 2021-2024, tested on 2025-2026.

Part 1 (instant): wind error before/after, computed from the saved comparison results.
Part 2 (re-simulates the test-period flights, tens of minutes): landing error before/after.

Needs ~/balloon-data/processed/eval/gfs_vs_sondes_levels.csv from `scripts.compare_gfs_sondes`.

Run from the project root:  python -m scripts.bias_baseline
"""
import argparse
from datetime import date

import numpy as np
import pandas as pd

from src.evaluate import gfs_vs_sondes as ev
from src.models.bias_correction import BiasCorrection
from src.paths import PROCESSED_DIR

p = argparse.ArgumentParser()
p.add_argument("--train-end", type=date.fromisoformat, default=date(2024, 12, 31))
p.add_argument("--test-end", type=date.fromisoformat, default=date(2026, 10, 18))
p.add_argument("--skip-landing", action="store_true", help="only do the instant wind part")
args = p.parse_args()
test_start = args.train_end + pd.Timedelta(days=1).to_pytimedelta()
pd.set_option("display.width", 160)

eval_dir = PROCESSED_DIR / "eval"
levels = pd.read_csv(eval_dir / "gfs_vs_sondes_levels.csv", parse_dates=["init"])
cut = pd.Timestamp(test_start, tz="UTC")
train, test = levels[levels.init < cut], levels[levels.init >= cut]
print(f"train: {train.init.nunique()} runs up to {args.train_end} ({len(train)} comparisons) | "
      f"test: {test.init.nunique()} runs from {test_start} ({len(test)} comparisons)", flush=True)

tables = {"per_station": BiasCorrection(by_station=True).fit(train, ev.SEASONS),
          "pooled": BiasCorrection(by_station=False).fit(train, ev.SEASONS)}

# ---- Part 1: wind error before/after (a corrected forecast's error is the old error minus the bias)
def corrected_errors(bc):
    """Vectorised: look up the bias for every test comparison and subtract it."""
    out_u, out_v = np.empty(len(test)), np.empty(len(test))
    season = test.init.dt.month.map(ev.SEASONS).to_numpy()
    keys = zip(test.station.to_numpy(), season, test.lead_h.to_numpy(), test.level_hpa.to_numpy())
    cache = {}
    for i, (st, se, lead, lev) in enumerate(keys):
        entry = bc.table.get((st if bc.by_station else None, se, lead))
        if entry is None:
            out_u[i], out_v[i] = 0.0, 0.0
            continue
        k = (st if bc.by_station else None, se, lead, lev)
        if k not in cache:
            lv, bu, bv = entry
            cache[k] = (np.interp(np.log(lev), np.log(lv), bu), np.interp(np.log(lev), np.log(lv), bv))
        out_u[i], out_v[i] = cache[k]
    return test.du.to_numpy() - out_u, test.dv.to_numpy() - out_v

wind = {"raw": test.assign(sq=test.du ** 2 + test.dv ** 2)}
for name, bc in tables.items():
    du, dv = corrected_errors(bc)
    wind[name] = test.assign(sq=du ** 2 + dv ** 2)

print("\nWIND ERROR on the test period (RMSE of the vector error, m/s). Lower is better.", flush=True)
for lev in (500.0, 300.0, 200.0):
    t = pd.DataFrame({n: d[d.level_hpa == lev].groupby("lead_h").sq.mean().pow(0.5) for n, d in wind.items()}).round(2)
    t["pooled gain %"] = ((1 - t.pooled / t.raw) * 100).round(1)
    t["per-station gain %"] = ((1 - t.per_station / t.raw) * 100).round(1)
    print(f"\n{int(lev)} hPa:\n{t.to_string()}", flush=True)

if args.skip_landing:
    raise SystemExit

# ---- Part 2: landing error before/after (re-flies the test-period flights)
print("\nRe-flying test-period flights with corrected winds (this takes a while)...", flush=True)
_, flights = ev.run(test_start, args.test_end, corrections=tables, with_levels=False)
flights.to_csv(eval_dir / "bias_baseline_flights.csv", index=False)

cols = {"raw": "landing_error_km", "per_station": "landing_error_km_per_station",
        "pooled": "landing_error_km_pooled"}
print(f"\n{len(flights)} test flights. LANDING ERROR in km (median / 90th percentile). Lower is better.")
t = flights.groupby("lead_h").agg(**{f"{n} median": (c, "median") for n, c in cols.items()},
                                  **{f"{n} p90": (c, lambda x: x.quantile(0.9)) for n, c in cols.items()}).round(1)
t["pooled gain % (median)"] = ((1 - t["pooled median"] / t["raw median"]) * 100).round(1)
t["share of flights improved (pooled)"] = flights.groupby("lead_h").apply(
    lambda d: (d[cols["pooled"]] < d[cols["raw"]]).mean()).round(2)
print(t.to_string())

f = flights[flights.lead_h.isin([24, 72, 120])].assign(season=lambda d: d.init.dt.month.map(ev.SEASONS))
print("\nBy season, median landing error km, raw -> pooled correction:")
s = f.groupby(["season", "lead_h"])[[cols["raw"], cols["pooled"]]].median().round(1).unstack()
print(s.reindex(["DJF", "MAM", "JJA", "SON"]).to_string())
