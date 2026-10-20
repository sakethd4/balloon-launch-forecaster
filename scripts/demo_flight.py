"""Sanity check: fly the baseline simulator through real radiosonde winds.

For every Fort Worth sounding this year that reaches the balloon's ceiling, launch
from Austin and report where it would land. Winds in Fort Worth are not Austin's
winds (about 280 km apart), so this checks that the numbers are plausible, not
that they are accurate.

Run from the project root:  python -m scripts.demo_flight
"""
import numpy as np
import pandas as pd
import yaml

from src.baselines.trajectory import distance_km, simulate_flight
from src.ingest import igra

AUSTIN = (30.2672, -97.7431)

cfg = yaml.safe_load(open("configs/balloon.yaml"))
df = igra.parse(igra.download(igra.STATIONS["FWD"], "y2d"))
print(f"{len(df)} levels, {df.launch_time.nunique()} soundings, "
      f"{df.launch_time.min():%Y-%m-%d} to {df.launch_time.max():%Y-%m-%d}")

results = []
for launch_time, s in df.groupby("launch_time"):
    s = s.dropna(subset=["gph_m", "u_ms", "v_ms"]).sort_values("gph_m").drop_duplicates("gph_m")
    if len(s) < 10 or s.gph_m.max() < cfg["burst_altitude_m"]:
        continue  # sounding didn't reach our ceiling or has too little wind data
    t = simulate_flight(
        *AUSTIN, s.gph_m.to_numpy(), s.u_ms.to_numpy(), s.v_ms.to_numpy(),
        ascent_rate_ms=cfg["ascent_rate_ms"], descent_rate_ms=cfg["descent_rate_ms"],
        burst_altitude_m=cfg["burst_altitude_m"], launch_alt_m=float(s.gph_m.min()),
    )
    lat, lon = t.landing
    bearing = (np.degrees(np.arctan2((lon - AUSTIN[1]) * np.cos(np.radians(AUSTIN[0])),
                                     lat - AUSTIN[0])) + 360) % 360
    results.append((launch_time, distance_km(*AUSTIN, lat, lon), bearing, t.flight_time_s / 60))

r = pd.DataFrame(results, columns=["launch", "drift_km", "bearing_deg", "flight_min"])
print(f"\n{len(r)} usable soundings")
print(r.describe().round(1).loc[["mean", "min", "50%", "max"]])
print("\nLast 5:")
print(r.tail(5).round({"drift_km": 1, "bearing_deg": 1, "flight_min": 1}).to_string(index=False))
