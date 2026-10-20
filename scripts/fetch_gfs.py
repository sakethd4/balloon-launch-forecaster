"""Download a range of GFS forecast runs, cropped to Texas, one file per day.

Safe to stop and restart: finished days are skipped. A single failed day is logged and
skipped, but the script stops if several days fail in a row (that means a real bug or
outage, and continuing would waste hours).

Examples (from the project root, inside the `balloon` environment):
  python -m scripts.fetch_gfs --start 2026-09-01 --end 2026-09-30        # pilot month
  python -m scripts.fetch_gfs --start 2021-01-01 --end 2026-10-01 --every 2
"""
import argparse
import time
from datetime import date, timedelta

from src.ingest import gfs

MAX_CONSECUTIVE_FAILURES = 3

p = argparse.ArgumentParser()
p.add_argument("--start", type=date.fromisoformat, required=True)
p.add_argument("--end", type=date.fromisoformat, required=True, help="inclusive")
p.add_argument("--every", type=int, default=1, help="take every Nth day")
p.add_argument("--cycle", type=int, default=12)
p.add_argument("--workers", type=int, default=4, help="forecast steps downloaded at once")
args = p.parse_args()

days = [args.start + timedelta(days=i) for i in range(0, (args.end - args.start).days + 1, args.every)]
print(f"{len(days)} days, cycle {args.cycle:02d}Z, 0.5 degrees, steps {gfs.DEFAULT_STEPS[0]}-{gfs.DEFAULT_STEPS[-1]} h",
      flush=True)

failed, streak, t_start = [], 0, time.time()
for i, day in enumerate(days, 1):
    t = time.time()
    out = gfs.PROCESSED_DIR / "gfs" / f"gfs_0p50_{day:%Y%m%d}_t{args.cycle:02d}z.nc"
    cached = out.exists()
    try:
        path = gfs.fetch_run(day, args.cycle, workers=args.workers)
        streak = 0
        status = "cached" if cached else f"ok {time.time() - t:.0f}s, {path.stat().st_size / 1e6:.1f} MB"
    except Exception as e:  # keep going on one bad day, but record it
        failed.append((day, repr(e)))
        streak += 1
        status = f"FAILED {e!r}"
    print(f"[{i}/{len(days)}] {day} {status}", flush=True)
    if streak >= MAX_CONSECUTIVE_FAILURES:
        print(f"Stopping: {streak} failures in a row.", flush=True)
        break

print(f"\nDone in {(time.time() - t_start) / 60:.1f} min. Failed days: {len(failed)}", flush=True)
for day, err in failed:
    print(f"  {day}: {err}", flush=True)
