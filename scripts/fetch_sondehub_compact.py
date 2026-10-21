"""Download SondeHub tracks and keep only their compact form, in zipped batches. Built for Colab.

For every flight from the chosen launch sites: check the size on the server, skip huge tracks,
download, reduce to a ~150 KB .npz (see src/ingest/sondehub.py), delete the raw file. Each batch of
compact tracks is zipped into --out, together with a manifest (serial, station, date, status), so
the output is a few big files instead of thousands of tiny ones (Drive is slow with those).

Safe to rerun: serials already in the manifest are skipped, so a stopped run resumes.
Use scripts/import_sondehub_batches.py on the laptop to unpack the batches.

Run from the project root:
  python -u -m scripts.fetch_sondehub_compact --out OUT_DIR [--since 2021-03-22] [--workers 2]
Data is CC BY-SA 2.0 from SondeHub and its volunteers.
"""
import argparse
import csv
import tempfile
import time
import zipfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pandas as pd
import requests

from src.ingest import gfs, sondehub

_session = None


def work(args):
    """Runs in a worker process: one flight in, (serial, status) out."""
    global _session
    serial, raw_dir, scratch_dir, max_gz_mb = args
    _session = _session or requests.Session()
    try:
        return serial, sondehub.fetch_and_compact(serial, Path(raw_dir), Path(scratch_dir), max_gz_mb, _session)
    except Exception as e:  # report and keep going; failed flights are retried on the next run
        return serial, "failed: " + repr(e)[:120]


def read_manifest(path: Path) -> pd.DataFrame:
    cols = ["serial", "station", "date", "status"]
    return pd.read_csv(path, dtype=str) if path.exists() else pd.DataFrame(columns=cols)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True, help="folder for the zipped batches and the manifest (e.g. on Drive)")
    p.add_argument("--since", default=str(gfs.FIRST_SUPPORTED_DAY))
    p.add_argument("--sites", default=",".join(sondehub.ALL_STATION_WMO), help="station codes, comma separated")
    p.add_argument("--workers", type=int, default=2, help="processes (about one per CPU core)")
    p.add_argument("--max-gz-mb", type=float, default=40.0, help="skip tracks larger than this (RAM limit)")
    p.add_argument("--batch", type=int, default=400, help="flights per zip")
    p.add_argument("--skip-list", help="text file of serials to skip (one per line), e.g. ones already on the laptop")
    args = p.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "sondehub_manifest.csv"

    flights = pd.concat([sondehub.list_flights(sondehub.ALL_STATION_WMO[s]).assign(station=s)
                         for s in args.sites.split(",")], ignore_index=True)
    flights = flights[flights.date >= pd.Timestamp(args.since)]
    skip = {l.strip() for l in open(args.skip_list)} if args.skip_list else set()
    done = {r.serial for r in read_manifest(manifest_path).itertuples() if not str(r.status).startswith("failed")}
    todo = flights[~flights.serial.isin(skip | done)].reset_index(drop=True)
    print(f"{len(flights)} flights listed ({flights.groupby('station').size().to_dict()}); "
          f"{len(skip)} on the skip list, {len(done)} already done; {len(todo)} to do", flush=True)

    t0, n_ok = time.time(), 0
    with tempfile.TemporaryDirectory() as tmp, ProcessPoolExecutor(args.workers) as ex:
        raw_dir, scratch = Path(tmp) / "raw", Path(tmp) / "compact"
        for b in range(0, len(todo), args.batch):
            chunk = todo.iloc[b:b + args.batch]
            jobs = [(s, str(raw_dir), str(scratch), args.max_gz_mb) for s in chunk.serial]
            status = dict(ex.map(work, jobs, chunksize=4))
            ok = [s for s, st in status.items() if st == "ok"]
            n_ok += len(ok)
            if ok:  # stored (not recompressed): the .npz files are already compressed
                zip_tmp = out / f"tracks_{chunk.date.iloc[0]:%Y%m%d}_{len(ok)}_{ok[0]}.zip.part"
                with zipfile.ZipFile(zip_tmp, "w", zipfile.ZIP_STORED) as z:
                    for s in ok:
                        z.write(sondehub.compact_path(s, scratch), f"{s}.npz")
                zip_tmp.replace(zip_tmp.with_suffix(""))  # atomic: only complete zips carry the final name
                for s in ok:
                    sondehub.compact_path(s, scratch).unlink()
            # Manifest rows are written AFTER the zip exists, so "done" always means "in a zip".
            new = chunk.assign(status=chunk.serial.map(status))[["serial", "station", "date", "status"]]
            new.to_csv(manifest_path, mode="a", header=not manifest_path.exists(), index=False,
                       quoting=csv.QUOTE_MINIMAL)
            counts = new.status.str.split(":").str[0].value_counts().to_dict()
            print(f"  {b + len(chunk)}/{len(todo)} ({(time.time() - t0) / 60:.1f} min) this batch: {counts}",
                  flush=True)
    print(f"\nDone in {(time.time() - t0) / 60:.1f} min. {n_ok} compact tracks written to {out}.", flush=True)
