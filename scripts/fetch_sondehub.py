"""Download the full flight tracks of NWS radiosondes launched from our four stations.

Tracks go to ~/balloon-data/raw/sondehub/<serial>.json.gz (about 65 KB each) and a flight
index (station, serial, launch date) to ~/balloon-data/processed/sondehub_flights.csv.
Safe to rerun: tracks already downloaded are skipped.

Run from the project root:  python -u -m scripts.fetch_sondehub
Data is CC BY-SA 2.0 from SondeHub and its volunteers.
"""
import argparse
import time

import pandas as pd

from src.ingest import gfs, sondehub
from src.paths import PROCESSED_DIR

p = argparse.ArgumentParser()
p.add_argument("--since", default=str(gfs.FIRST_SUPPORTED_DAY), help="first launch date to keep")
p.add_argument("--workers", type=int, default=16)
args = p.parse_args()

t0 = time.time()
flights = pd.concat([sondehub.list_flights(w).assign(station=s) for s, w in sondehub.STATION_WMO.items()],
                    ignore_index=True)
flights = flights[flights.date >= pd.Timestamp(args.since)].reset_index(drop=True)
print(f"{len(flights)} flights since {args.since}: {flights.groupby('station').size().to_dict()}", flush=True)

ok, missing = [], []
for i in range(0, len(flights), 500):  # in chunks, so progress is visible and a crash loses little
    chunk = flights.serial.iloc[i:i + 500].tolist()
    done, miss = sondehub.download_tracks(chunk, workers=args.workers)
    ok += done
    missing += miss
    print(f"  {min(i + 500, len(flights))}/{len(flights)} ({(time.time() - t0) / 60:.1f} min), "
          f"not in archive so far: {len(missing)}", flush=True)

flights["downloaded"] = ~flights.serial.isin(missing)
PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
flights.to_csv(PROCESSED_DIR / "sondehub_flights.csv", index=False)
print(f"\nDone in {(time.time() - t0) / 60:.1f} min: {len(ok)} tracks on disk, {len(missing)} not in the archive.",
      flush=True)
