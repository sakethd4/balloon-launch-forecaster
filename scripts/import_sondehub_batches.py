"""Unpack the zipped batches made by scripts.fetch_sondehub_compact into ~/balloon-data.

Compact tracks go to ~/balloon-data/processed/sondehub_tracks/ (where the validation reads them);
the manifests from Colab are merged into ~/balloon-data/processed/sondehub_manifest.csv.
Safe to rerun: tracks already present are not overwritten.

Run from the project root:  python -m scripts.import_sondehub_batches PATH_TO_DOWNLOADED_FOLDER
"""
import argparse
import zipfile
from pathlib import Path

import pandas as pd

from src.ingest import sondehub
from src.paths import PROCESSED_DIR

p = argparse.ArgumentParser()
p.add_argument("folder", help="folder containing tracks_*.zip and sondehub_manifest.csv (searched recursively)")
args = p.parse_args()

dest = sondehub.compact_path("x").parent
dest.mkdir(parents=True, exist_ok=True)
n_new = n_zip = 0
for z in sorted(Path(args.folder).rglob("tracks_*.zip")):
    with zipfile.ZipFile(z) as zf:
        bad = zf.testzip()  # CRC check: a half-synced Drive file shows up here
        if bad:
            raise SystemExit(f"{z}: corrupt member {bad}; download it again")
        for name in zf.namelist():
            if not (dest / name).exists():
                zf.extract(name, dest)
                n_new += 1
    n_zip += 1
print(f"{n_zip} zips read; {n_new} new tracks added to {dest} ({len(list(dest.glob('*.npz')))} in total)")

new = [pd.read_csv(m, dtype=str) for m in Path(args.folder).rglob("sondehub_manifest.csv")]
if new:
    merged_path = PROCESSED_DIR / "sondehub_manifest.csv"
    parts = ([pd.read_csv(merged_path, dtype=str)] if merged_path.exists() else []) + new
    merged = pd.concat(parts).drop_duplicates("serial", keep="last")
    merged.to_csv(merged_path, index=False)
    print(f"manifest: {len(merged)} flights;", merged.status.str.split(":").str[0].value_counts().to_dict())
