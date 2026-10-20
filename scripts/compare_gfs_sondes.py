"""Compare saved GFS forecasts with real radiosonde soundings.

Needs GFS files for the date range in ~/balloon-data/processed/gfs (or BALLOON_DATA_DIR).
Days with no GFS file are skipped.

Run from the project root:
  python -m scripts.compare_gfs_sondes --start 2026-09-01 --end 2026-09-30
"""
import argparse
from datetime import date

import pandas as pd

from src.evaluate import gfs_vs_sondes
from src.paths import PROCESSED_DIR

p = argparse.ArgumentParser()
p.add_argument("--start", type=date.fromisoformat, required=True)
p.add_argument("--end", type=date.fromisoformat, required=True)
args = p.parse_args()

levels, flights = gfs_vs_sondes.run(args.start, args.end)
if levels.empty:
    raise SystemExit("No forecast/sounding pairs found. Are there GFS files for these dates?")

wind, land = gfs_vs_sondes.summarize(levels, flights)
pd.set_option("display.width", 140)
print(f"\n{levels.init.nunique()} GFS runs, {len(levels)} level comparisons, {len(flights)} flight comparisons")
print("\nWind error vs measured soundings (RMSE of the vector error, m/s):")
print(wind.to_string())
print("\nLanding error: same simulated flight through forecast vs measured winds:")
print(land.to_string())

print("\nBy season (DJF = Dec-Feb, MAM = Mar-May, JJA = Jun-Aug, SON = Sep-Nov):")
print(gfs_vs_sondes.summarize_by_season(levels, flights).to_string())

out = PROCESSED_DIR / "eval"
out.mkdir(parents=True, exist_ok=True)
levels.to_csv(out / "gfs_vs_sondes_levels.csv", index=False)
flights.to_csv(out / "gfs_vs_sondes_flights.csv", index=False)
print(f"\nSaved details to {out}")
