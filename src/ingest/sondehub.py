"""Ingest real weather-balloon flight tracks from SondeHub's open archive.

SondeHub (https://sondehub.org) collects GPS telemetry from radiosondes, received by
volunteers' ground stations. The public bucket `sondehub-history` (anonymous, CC BY-SA 2.0)
has three views:
  - launchsites/<WMO id>/YYYY/MM/DD/<serial>.json : 3-frame summaries (first heard, highest,
    last heard). Listable, so this is how we find which flights came from our stations.
  - date/YYYY/MM/DD/... : the same summaries by date.
  - serial/<serial>.json.gz : the FULL track of one flight. The folder cannot be listed,
    but a file can be downloaded directly if you know the serial.

Caveat: a frame only exists if some receiver heard it, so a track often starts well above
the ground (the first receiver needs line of sight) and may stop before landing. Sensor
readings (temperature etc.) are uncalibrated; the GPS positions are what we use.

License: CC BY-SA 2.0. Credit SondeHub and its volunteers when results are shown.
"""
import gzip
import json
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd
import requests

from src.paths import RAW_DIR

BASE = "https://sondehub-history.s3.amazonaws.com"
_NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"

# National Weather Service stations near Austin (WMO ids, same stations as our soundings)
STATION_WMO = {"FWD": "72249", "CRP": "72251", "DRT": "72261", "MAF": "72265"}


def parse_summary_keys(keys: list[str]) -> pd.DataFrame:
    """From launchsites/<wmo>/YYYY/MM/DD/<serial>.json keys to one row per serial.

    A flight that crosses midnight UTC appears under two dates; keep the first.
    """
    rows = []
    for k in keys:
        parts = k.split("/")
        if len(parts) != 6 or not parts[5].endswith(".json"):
            continue
        rows.append(dict(wmo=parts[1], date=pd.Timestamp(f"{parts[2]}-{parts[3]}-{parts[4]}"),
                         serial=parts[5].removesuffix(".json")))
    df = pd.DataFrame(rows, columns=["wmo", "date", "serial"])
    return df.sort_values("date").drop_duplicates("serial").reset_index(drop=True)


def list_flights(wmo: str) -> pd.DataFrame:
    """All archived flights launched from one site (one listing call per 1,000 files)."""
    keys, token = [], None
    while True:
        params = {"list-type": "2", "prefix": f"launchsites/{wmo}/", "max-keys": "1000"}
        if token:
            params["continuation-token"] = token
        r = requests.get(BASE, params=params, timeout=60)
        r.raise_for_status()
        root = ET.fromstring(r.content)
        keys += [c.find(_NS + "Key").text for c in root.findall(_NS + "Contents")]
        token = root.findtext(_NS + "NextContinuationToken")
        if not token:
            return parse_summary_keys(keys)


def track_path(serial: str, out_dir: Path | None = None) -> Path:
    return (out_dir or RAW_DIR / "sondehub") / f"{serial}.json.gz"


def download_track(serial: str, out_dir: Path | None = None, session: requests.Session | None = None) -> Path:
    """Download one flight's full track once and cache it. Re-running skips existing files."""
    dest = track_path(serial, out_dir)
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    s = session or requests
    for attempt in range(4):
        try:
            r = s.get(f"{BASE}/serial/{serial}.json.gz", timeout=60)
            if r.status_code == 404 or r.status_code == 403:
                raise FileNotFoundError(serial)  # not in the archive; do not retry
            r.raise_for_status()
            break
        except requests.RequestException:
            if attempt == 3:
                raise
    data = r.content
    if not data.startswith(b"\x1f\x8b"):
        # The server marks these files as compressed, so the HTTP library may already have
        # unpacked them. Store every track the same way: gzip-compressed.
        data = gzip.compress(data)
    tmp = dest.with_suffix(".part")
    tmp.write_bytes(data)
    tmp.replace(dest)  # atomic: a crash never leaves a half-written file
    return dest


def download_tracks(serials, workers: int = 16, out_dir: Path | None = None):
    """Download many tracks in parallel. Returns (downloaded_or_cached, missing_serials)."""
    ok, missing = [], []
    with requests.Session() as s, ThreadPoolExecutor(workers) as ex:
        def one(serial):
            try:
                return download_track(serial, out_dir, s)
            except FileNotFoundError:
                return None
        for serial, path in zip(serials, ex.map(one, serials)):
            (ok if path else missing).append(path or serial)
    return ok, missing


def load_track(path: Path) -> pd.DataFrame:
    """One flight as a table sorted by time: time (UTC), lat, lon, alt_m, vel_h_ms, vel_v_ms.

    Several receivers can hear the same frame, so duplicate timestamps are dropped.
    Frames without a position or altitude are dropped.
    """
    raw = Path(path).read_bytes()
    if raw.startswith(b"\x1f\x8b"):  # gzip magic bytes (older downloads may be plain JSON)
        raw = gzip.decompress(raw)
    frames = json.loads(raw.decode("utf-8"))
    df = pd.DataFrame(frames)
    keep = {"datetime": "time", "lat": "lat", "lon": "lon", "alt": "alt_m",
            "vel_h": "vel_h_ms", "vel_v": "vel_v_ms"}
    df = df[[c for c in keep if c in df.columns]].rename(columns=keep)
    df["time"] = pd.to_datetime(df["time"], utc=True)
    df = df.dropna(subset=["time", "lat", "lon", "alt_m"]).sort_values("time")
    return df.drop_duplicates("time").reset_index(drop=True)
