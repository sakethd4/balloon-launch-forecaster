"""Ingest radiosonde soundings from NOAA's IGRA v2 archive.

A radiosonde is a real weather balloon launched twice a day (00Z and 12Z) from
stations around the country. Each sounding records pressure, height,
temperature, humidity and wind on the way up. That is free ground truth for the
winds our balloon will fly through.

Format spec: https://www.ncei.noaa.gov/data/integrated-global-radiosonde-archive/doc/igra2-data-format.txt
(column positions below are 1-indexed in the spec, converted to Python slices).
"""
import io
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from src.paths import RAW_DIR

BASE_URL = "https://www.ncei.noaa.gov/data/integrated-global-radiosonde-archive/access"

# Stations near Austin (Austin itself has no radiosonde site).
STATIONS = {
    "FWD": "USM00072249",  # Fort Worth
    "CRP": "USM00072251",  # Corpus Christi
    "DRT": "USM00072261",  # Del Rio
    "MAF": "USM00072265",  # Midland
}

MISSING = (-9999, -8888)  # -9999 = missing, -8888 = removed by quality control


def file_url(station_id: str, kind: str = "y2d", year: int = 2026) -> str:
    """kind='y2d': this year so far (small). kind='por': full history (large)."""
    if kind == "y2d":
        return f"{BASE_URL}/data-y2d/{station_id}-data-beg{year}.txt.zip"
    if kind == "por":
        return f"{BASE_URL}/data-por/{station_id}-data.txt.zip"
    raise ValueError(kind)


def download(station_id: str, kind: str = "y2d", year: int = 2026) -> Path:
    """Download once and cache. Re-running never re-downloads an existing file."""
    url = file_url(station_id, kind, year)
    dest = RAW_DIR / "igra" / Path(url).name
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    resp = requests.get(url, timeout=120)
    resp.raise_for_status()
    tmp = dest.with_suffix(".part")
    tmp.write_bytes(resp.content)
    tmp.replace(dest)  # atomic, so a crash never leaves a half-written file
    return dest


def _num(s: str, scale: float = 1.0) -> float:
    v = int(s)
    return np.nan if v in MISSING else v * scale


def parse(zip_path: Path) -> pd.DataFrame:
    """Parse an IGRA zip into one row per sounding level.

    Units out: pressure_hpa, gph_m (geopotential height above sea level),
    temp_c, rh_pct, wdir_deg (direction wind comes FROM), wspd_ms, and the wind
    as u_ms (toward east) / v_ms (toward north), which is what the math needs.
    """
    rows = []
    with zipfile.ZipFile(zip_path) as zf:
        text = io.TextIOWrapper(zf.open(zf.namelist()[0]), encoding="ascii")
        station = launch = None
        for line in text:
            if line.startswith("#"):
                station = line[1:12]
                hour = int(line[24:26])
                # HOUR 99 = unknown nominal hour; fall back to release time
                if hour == 99:
                    hour = int(line[27:31]) // 100 if int(line[27:31]) < 2500 else 0
                launch = pd.Timestamp(
                    year=int(line[13:17]), month=int(line[18:20]),
                    day=int(line[21:23]), hour=min(hour, 23), tz="UTC",
                )
                continue
            rows.append((
                station, launch,
                _num(line[9:15], 0.01),   # PRESS Pa -> hPa
                _num(line[16:21]),        # GPH m
                _num(line[22:27], 0.1),   # TEMP tenths C -> C
                _num(line[28:33], 0.1),   # RH tenths % -> %
                _num(line[40:45]),        # WDIR deg
                _num(line[46:51], 0.1),   # WSPD tenths m/s -> m/s
            ))
    df = pd.DataFrame(rows, columns=[
        "station", "launch_time", "pressure_hpa", "gph_m", "temp_c", "rh_pct", "wdir_deg", "wspd_ms"])
    rad = np.radians(df["wdir_deg"])
    # Wind direction is where the wind comes FROM, so the wind vector points the opposite way.
    df["u_ms"] = -df["wspd_ms"] * np.sin(rad)
    df["v_ms"] = -df["wspd_ms"] * np.cos(rad)
    return df
