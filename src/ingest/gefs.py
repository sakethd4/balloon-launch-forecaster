"""Ingest the GEFS ensemble SPREAD (standard deviation across 30 members) from NOAA's AWS bucket.

GEFS runs 30 perturbed copies of the forecast. Where the members disagree the atmosphere is
hard to predict, so their spread is a candidate predictor of how wrong GFS winds will be. NOAA
already publishes the per-gridpoint standard deviation as its own file (`gespr`), so we never
download the 30 members: one small field per (level, wind component, lead step).

Same trick as src/ingest/gfs.py: read the .idx, fetch only the wanted byte ranges, crop to
Texas, save one small NetCDF per forecast run (idempotent, restartable).

The spread is a std dev of u and of v separately (m/s). `spread_ms` = sqrt(su^2 + sv^2) is the
combined vector spread, the natural analogue of the vector RMSE we score GFS with.
"""
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import xarray as xr

from src.ingest import gfs
from src.paths import PROCESSED_DIR

BUCKET = "https://noaa-gefs-pds.s3.amazonaws.com"
LEVELS_HPA = (500, 300, 200)             # the winds that carry the balloon (descending, like GFS files)
DEFAULT_STEPS = (0, 12, 24, 36, 48, 72, 96, 120)
SCHEMA_VERSION = 1


def output_path(day: date, cycle: int = 12, out_dir: Path | None = None) -> Path:
    out_dir = out_dir or PROCESSED_DIR / "gefs"
    return out_dir / f"gefs_spread_v{SCHEMA_VERSION}_{day:%Y%m%d}_t{cycle:02d}z.nc"


def _url(day: date, cycle: int, step: int) -> str:
    if day < gfs.FIRST_SUPPORTED_DAY:
        raise ValueError(f"{day}: before {gfs.FIRST_SUPPORTED_DAY}; kept aligned with the GFS files")
    return (f"{BUCKET}/gefs.{day:%Y%m%d}/{cycle:02d}/atmos/pgrb2ap5/"
            f"gespr.t{cycle:02d}z.pgrb2a.0p50.f{step:03d}")


def select_ranges(idx_text: str, levels=LEVELS_HPA) -> list[tuple[int, int | None]]:
    """Merged byte ranges (start, end exclusive; None = to end of file) of UGRD/VGRD on `levels`."""
    lines = idx_text.strip().splitlines()
    starts = [int(l.split(":")[1]) for l in lines]
    wanted_levels = {f"{lev} mb" for lev in levels}
    ranges = []
    for i, line in enumerate(lines):
        parts = line.split(":")
        if parts[3] not in ("UGRD", "VGRD") or parts[4] not in wanted_levels:
            continue
        end = starts[i + 1] if i + 1 < len(lines) else None
        if ranges and ranges[-1][1] == starts[i]:
            ranges[-1] = (ranges[-1][0], end)
        else:
            ranges.append((starts[i], end))
    return ranges


def _download_step(url: str, dest: Path, session: requests.Session) -> None:
    ranges = select_ranges(gfs._retry(lambda: gfs._get_text(session, url + ".idx")))
    with open(dest, "wb") as f:
        for r in ranges:  # a handful of small ranges; the parallelism is across steps instead
            f.write(gfs._get_range(session, url, *r))


def read_step(grib_path: Path, step_h: int) -> xr.Dataset:
    """Decode the trimmed GRIB (ecCodes, not thread-safe) to Texas; variables su, sv (lead, level, lat, lon)."""
    import eccodes

    fields, lat_idx = {}, None
    with open(grib_path, "rb") as f:
        while (h := eccodes.codes_grib_new_from_file(f)) is not None:
            try:
                if lat_idx is None:
                    ni, nj = eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")
                    sign = 1 if eccodes.codes_get(h, "jScansPositively") else -1
                    all_lats = (eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees")
                                + sign * eccodes.codes_get(h, "jDirectionIncrementInDegrees") * np.arange(nj))
                    all_lons = (eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees")
                                + eccodes.codes_get(h, "iDirectionIncrementInDegrees") * np.arange(ni) + 180) % 360 - 180
                    eps = 1e-6
                    lat_idx = np.where((all_lats >= gfs.LAT_MIN - eps) & (all_lats <= gfs.LAT_MAX + eps))[0]
                    lon_idx = np.where((all_lons >= gfs.LON_MIN - eps) & (all_lons <= gfs.LON_MAX + eps))[0]
                    lats, lons = all_lats[lat_idx], all_lons[lon_idx]
                grid = eccodes.codes_get_values(h).reshape(nj, ni)[np.ix_(lat_idx, lon_idx)]
                fields[(eccodes.codes_get(h, "shortName"), eccodes.codes_get(h, "level"))] = grid
            finally:
                eccodes.codes_release(h)
    order = np.argsort(lats)
    levels = sorted({lev for _, lev in fields}, reverse=True)
    coords = {"lead_h": [step_h], "isobaricInhPa": np.array(levels, dtype=float),
              "latitude": lats[order], "longitude": lons}
    data = {name: (("lead_h", "isobaricInhPa", "latitude", "longitude"),
                   np.stack([fields[(short, lev)] for lev in levels])[:, order, :][None])
            for name, short in (("su", "u"), ("sv", "v"))}
    return xr.Dataset(data, coords).astype("float32")


def fetch_run(day: date, cycle: int = 12, steps=DEFAULT_STEPS, out_dir: Path | None = None,
              workers: int = 4) -> Path:
    """Fetch the spread of one GEFS run for all `steps`, crop, save. Skips if the file exists."""
    out = output_path(day, cycle, out_dir)
    if out.exists():
        return out
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp, requests.Session() as session:
        def download(step):
            g = Path(tmp) / f"f{step:03d}.grib2"
            _download_step(_url(day, cycle, step), g, session)
            return g

        with ThreadPoolExecutor(workers) as ex:
            files = list(ex.map(download, steps))
        ds = xr.concat([read_step(g, s) for g, s in zip(files, steps)], dim="lead_h")  # decode serially
    ds["spread_ms"] = np.hypot(ds.su, ds.sv)
    ds = ds.assign_coords(init_time=pd.Timestamp(day.year, day.month, day.day, cycle))
    tmp_out = out.with_suffix(".part")
    ds.to_netcdf(tmp_out, encoding={v: {"zlib": True, "complevel": 4} for v in ds.data_vars})
    tmp_out.replace(out)
    return out
