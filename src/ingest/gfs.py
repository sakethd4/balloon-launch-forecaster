"""Ingest archived GFS forecasts from NOAA's public AWS bucket.

GFS files are global and huge (~160 MB per forecast step at 0.5 degrees), but each
file has a small `.idx` index listing the byte range of every field. So we:
  1. read the index,
  2. keep only the fields we need (winds, temperature, humidity, height on
     1000-100 hPa, plus a few surface fields),
  3. download just those byte ranges (HTTP Range requests),
  4. crop to the Texas domain and save one small NetCDF file per forecast run.

One file per (date, cycle) makes the job idempotent and restartable: re-running
skips any day that already exists.

Forecast data carries two times: the INIT time (when the run started) and the
VALID time (what moment it predicts). lead time = valid - init. We keep both, since
mixing them up would leak future information into training.
"""
import re
import tempfile
import time
import warnings
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import requests
import xarray as xr

from src.paths import PROCESSED_DIR

BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"

# Texas domain (degrees). Latitudes decrease in the GRIB files; we sort after cropping.
LAT_MIN, LAT_MAX = 27.0, 35.0
LON_MIN, LON_MAX = -103.0, -92.0

PRESSURE_VARS = {"UGRD", "VGRD", "TMP", "HGT", "RH"}
MIN_LEVEL_HPA = 100  # balloon stays below ~16 km (~100 hPa)
SURFACE_FIELDS = {
    ("UGRD", "10 m above ground"), ("VGRD", "10 m above ground"),
    ("TMP", "2 m above ground"), ("PRMSL", "mean sea level"),
    ("TCDC", "entire atmosphere"), ("APCP", "surface"),
}
DEFAULT_STEPS = tuple(range(0, 121, 6))  # 0-120 h every 6 h
# Names cfgrib gives the surface fields (every step must end up with all of them)
SURFACE_VARS = ("tcc", "u10", "v10", "t2m", "prmsl", "tp")

warnings.filterwarnings("ignore", category=FutureWarning, module="cfgrib")


def _url(day: date, cycle: int, step: int, res: str = "0p50") -> str:
    d = f"{day:%Y%m%d}"
    return f"{BUCKET}/gfs.{d}/{cycle:02d}/atmos/gfs.t{cycle:02d}z.pgrb2.{res}.f{step:03d}"


def select_ranges(idx_text: str) -> list[tuple[int, int | None]]:
    """From an .idx file, return merged byte ranges (start, end) of the fields we want.

    `end` is exclusive; None means "to end of file" (last message).
    Adjacent wanted messages are merged to cut the number of HTTP requests.
    """
    lines = idx_text.strip().splitlines()
    starts = [int(l.split(":")[1]) for l in lines]
    ranges = []
    for i, line in enumerate(lines):
        parts = line.split(":")
        var, level = parts[3], parts[4]
        m = re.fullmatch(r"(\d+(?:\.\d+)?) mb", level)
        wanted = (var in PRESSURE_VARS and m and float(m.group(1)) >= MIN_LEVEL_HPA) \
            or (var, level) in SURFACE_FIELDS
        if not wanted:
            continue
        end = starts[i + 1] if i + 1 < len(lines) else None
        if ranges and ranges[-1][1] == starts[i]:
            ranges[-1] = (ranges[-1][0], end)
        else:
            ranges.append((starts[i], end))
    return ranges


def _get_range(session: requests.Session, url: str, start: int, end: int | None,
               retries: int = 4) -> bytes:
    """Fetch one byte range, retrying on network errors (public buckets do hiccup)."""
    rng = f"bytes={start}-{end - 1}" if end is not None else f"bytes={start}-"
    for attempt in range(retries):
        try:
            r = session.get(url, headers={"Range": rng}, timeout=120)
            if r.status_code != 206:
                raise RuntimeError(f"expected partial content (206), got {r.status_code} for {url}")
            return r.content
        except (requests.RequestException, RuntimeError):
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)


def download_step(url: str, dest: Path, session: requests.Session, range_workers: int = 8) -> None:
    """Download the wanted fields of one forecast step into `dest` (a small GRIB file).

    Ranges are fetched in parallel. A single connection to AWS can be slow while many
    connections together are fast, so parallelism is what makes this practical.
    """
    idx = session.get(url + ".idx", timeout=60)
    idx.raise_for_status()
    ranges = select_ranges(idx.text)
    with ThreadPoolExecutor(range_workers) as ex:
        chunks = list(ex.map(lambda r: _get_range(session, url, *r), ranges))  # order preserved
    with open(dest, "wb") as f:
        for c in chunks:
            f.write(c)  # concatenated GRIB messages are still a valid GRIB file


def read_step(grib_path: Path, step_h: int, init_time) -> xr.Dataset:
    """Open a trimmed GRIB file, crop to Texas, and return one merged dataset."""
    import cfgrib  # imported here so the module loads without eccodes installed

    parts = []
    for ds in cfgrib.open_datasets(str(grib_path), backend_kwargs={"indexpath": ""}):
        ds = ds.drop_vars([v for v in ("step", "time", "valid_time", "surface",
                                       "meanSea", "atmosphere", "heightAboveGround") if v in ds.coords],
                          errors="ignore")
        ds = ds.sel(latitude=slice(LAT_MAX, LAT_MIN), longitude=slice(LON_MIN % 360, LON_MAX % 360))
        # Same longitude convention for everything: -180..180
        ds = ds.assign_coords(longitude=((ds.longitude + 180) % 360) - 180)
        # 10 m / 2 m fields have different names per level type; rename for clarity
        parts.append(ds.load())
    merged = xr.merge(parts, compat="override", join="exact")
    merged = merged.sortby("latitude")
    # Precipitation is an accumulation, so it does not exist at forecast hour 0. Add it
    # as NaN so every step has the same variables and the steps can be joined.
    for name in SURFACE_VARS:
        if name not in merged:
            merged[name] = xr.full_like(merged["t2m"], float("nan"))
    merged = merged.expand_dims(lead_h=[step_h])
    return merged.astype("float32")


def fetch_run(day: date, cycle: int = 12, steps=DEFAULT_STEPS, res: str = "0p50",
              out_dir: Path | None = None, workers: int = 4) -> Path:
    """Fetch one GFS run (all `steps`), crop it, save to NetCDF. Skips if it exists."""
    out_dir = out_dir or PROCESSED_DIR / "gfs"
    out = out_dir / f"gfs_{res}_{day:%Y%m%d}_t{cycle:02d}z.nc"
    if out.exists():
        return out
    out_dir.mkdir(parents=True, exist_ok=True)

    import pandas as pd
    init_time = pd.Timestamp(day.year, day.month, day.day, cycle, tz="UTC")

    with tempfile.TemporaryDirectory() as tmp, requests.Session() as session:
        def download(step):
            g = Path(tmp) / f"f{step:03d}.grib2"
            download_step(_url(day, cycle, step, res), g, session)
            return g

        # Downloads run in parallel threads (network-bound). Decoding must NOT: the ecCodes
        # library is not thread-safe and crashes with parser errors if used from threads.
        with ThreadPoolExecutor(workers) as ex:
            files = list(ex.map(download, steps))
        datasets = [read_step(g, step, init_time) for g, step in zip(files, steps)]
    ds = xr.concat(datasets, dim="lead_h", join="outer")
    ds = ds.assign_coords(init_time=init_time.tz_convert(None))
    tmp_out = out.with_suffix(".part")
    ds.to_netcdf(tmp_out, encoding={v: {"zlib": True, "complevel": 4} for v in ds.data_vars})
    tmp_out.replace(out)  # atomic: a crash never leaves a half-written file
    return out
