"""Check the 4D simulator against real SondeHub flight tracks.

Needs the tracks (python -m scripts.fetch_sondehub) and the GFS files. Results go to
~/balloon-data/processed/eval/track_validation.csv.

Run from the project root:
  python -u -m scripts.validate_tracks [--limit N]      # --limit for a quick test on N flights
"""
import argparse

import numpy as np
import pandas as pd

from src.evaluate import track_validation as tv
from src.paths import PROCESSED_DIR

p = argparse.ArgumentParser()
p.add_argument("--limit", type=int, default=None, help="only the first N flights (by date)")
args = p.parse_args()
pd.set_option("display.width", 160)

from src.ingest import sondehub  # noqa: E402

# Flights that have a compact track on disk (scripts.fetch_sondehub, then scripts.compact_tracks)
have = {f.name[: -len(".npz")] for f in (PROCESSED_DIR / "sondehub_tracks").glob("*.npz")}
flights = pd.concat([sondehub.list_flights(w).assign(station=s) for s, w in sondehub.STATION_WMO.items()],
                    ignore_index=True)
flights = flights[flights.serial.isin(have)]
if args.limit:
    flights = flights.sort_values("date").head(args.limit)
print(f"{len(flights)} flights", flush=True)

res = tv.run(flights)
out = PROCESSED_DIR / "eval"
out.mkdir(parents=True, exist_ok=True)
res.to_csv(out / "track_validation.csv", index=False)
print(f"{len(res)} leg evaluations from {res.serial.nunique()} flights; saved to {out / 'track_validation.csv'}")

q90 = lambda x: x.quantile(0.9)
res["lead_mode"] = res.min_lead_h.map({0.0: "lead ~11-23 h", 24.0: "lead ~35-47 h"})
print("\nEND-POINT ERROR (km): predicted minus real position where each leg ends")
g = res.groupby(["leg", "lead_mode"]).agg(n=("err_km", "size"), median_drift_km=("drift_km", "median"),
                                         median_err_km=("err_km", "median"), p90_err_km=("err_km", q90)).round(1)
print(g.to_string())

print("\nERROR SHAPE: along the drift direction vs across it (km). If errors were round, these would match.")
s = res.groupby(["leg", "lead_mode"]).agg(
    along_bias=("err_along_km", "mean"), along_rms=("err_along_km", lambda x: np.sqrt((x ** 2).mean())),
    cross_bias=("err_cross_km", "mean"), cross_rms=("err_cross_km", lambda x: np.sqrt((x ** 2).mean()))).round(1)
print(s.to_string())

print("\nBy season (ascent legs, lead ~11-23 h): median error and drift (km)")
a = res[(res.leg == "ascent") & (res.min_lead_h == 0.0)]
print(a.groupby("season").agg(n=("err_km", "size"), median_err=("err_km", "median"),
                              median_drift=("drift_km", "median")).round(1).reindex(["DJF", "MAM", "JJA", "SON"]).to_string())
