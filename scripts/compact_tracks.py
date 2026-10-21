"""Convert downloaded raw SondeHub tracks into small deduplicated files.

Raw recent tracks are hundreds of MB of JSON each (every receiver uploads its own copy of every
frame). Each is reduced to about 150 KB in ~/balloon-data/processed/sondehub_tracks/.
Tracks over 60 MB compressed are skipped (too much RAM to unpack) and listed at the end.
Safe to rerun: converted tracks are skipped.

Run from the project root:  python -u -m scripts.compact_tracks [--workers 3]
"""
import argparse
import time
from concurrent.futures import ProcessPoolExecutor

from src.ingest import sondehub
from src.paths import RAW_DIR


def convert(serial):
    try:
        return serial, sondehub.compact_track(serial), None
    except Exception as e:  # report and keep going: one bad file should not stop the batch
        return serial, None, repr(e)[:200]


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--workers", type=int, default=3, help="each worker can need a few GB of RAM")
    args = p.parse_args()

    serials = sorted(f.name[: -len(".json.gz")] for f in (RAW_DIR / "sondehub").glob("*.json.gz"))
    print(f"{len(serials)} raw tracks to check", flush=True)
    t0, done, skipped, failed = time.time(), 0, [], []
    with ProcessPoolExecutor(args.workers) as ex:
        for serial, path, err in ex.map(convert, serials, chunksize=4):
            done += 1
            if err:
                failed.append((serial, err))
            elif path is None:
                skipped.append(serial)
            if done % 100 == 0:
                print(f"  {done}/{len(serials)} ({(time.time() - t0) / 60:.1f} min), "
                      f"skipped too big: {len(skipped)}, failed: {len(failed)}", flush=True)
    print(f"\nDone in {(time.time() - t0) / 60:.1f} min. Skipped (over 60 MB compressed): {len(skipped)}. "
          f"Failed: {len(failed)}.", flush=True)
    for s, e in failed[:10]:
        print(f"  failed {s}: {e}", flush=True)
