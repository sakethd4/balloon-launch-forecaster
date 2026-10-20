"""Download the full radiosonde history for the stations near Austin.

Files are cached, so re-running skips anything already downloaded.
Run from the project root:  python -m scripts.download_igra
"""
from src.ingest import igra

for name, station_id in igra.STATIONS.items():
    path = igra.download(station_id, "por")
    print(f"{name}: {path.name}  {path.stat().st_size / 1e6:.1f} MB", flush=True)
