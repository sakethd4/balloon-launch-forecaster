"""Download the GEFS ensemble spread (see src/ingest/gefs.py) for a range of days.

About 3 s and 90 KB per day; safe to rerun (finished days are skipped; missing days are listed).

Run from the project root:
  python -u -m scripts.fetch_gefs --start 2021-03-22 --end 2026-10-18
"""
import argparse
import time
from datetime import date, timedelta

from src.ingest import gefs

p = argparse.ArgumentParser()
p.add_argument("--start", type=date.fromisoformat, default=date(2021, 3, 22))
p.add_argument("--end", type=date.fromisoformat, default=date(2026, 10, 18))
args = p.parse_args()

days = [args.start + timedelta(d) for d in range((args.end - args.start).days + 1)]
t0, missing, failed = time.time(), [], []
for i, day in enumerate(days, 1):
    try:
        gefs.fetch_run(day)
    except FileNotFoundError:
        missing.append(day)
    except Exception as e:  # a network hiccup on one day should not stop a 2-hour run; rerun retries it
        failed.append(day)
        print(f"  {day} failed: {repr(e)[:100]}", flush=True)
    if i % 50 == 0:
        print(f"  {i}/{len(days)} days ({(time.time() - t0) / 60:.1f} min), missing: {len(missing)}", flush=True)
print(f"Done in {(time.time() - t0) / 60:.1f} min. Missing on the server: {len(missing)} {missing[:10]}; "
      f"failed (rerun to retry): {len(failed)}", flush=True)
