import gzip
import json

import pandas as pd

from src.ingest import sondehub


def test_parse_summary_keys_keeps_one_row_per_flight_and_ignores_other_files():
    keys = [
        "launchsites/72249/2022/04/04/S5130641.json",
        "launchsites/72249/2022/04/05/S5130641.json",  # same flight, after midnight UTC
        "launchsites/72249/2022/04/05/S5130640.json",
        "launchsites/72249/2022/04/05/readme.txt",      # not a flight summary
        "launchsites/72249/index.html",                  # wrong depth
    ]
    df = sondehub.parse_summary_keys(keys)
    assert list(df.serial) == ["S5130641", "S5130640"]
    assert df.loc[0, "date"] == pd.Timestamp("2022-04-04")


def test_load_track_accepts_plain_json_saved_with_a_gz_name(tmp_path):
    path = tmp_path / "S2.json.gz"
    path.write_text(json.dumps([{"datetime": "2022-04-04T21:00:00.000000Z", "lat": 33.0, "lon": -96.5,
                                 "alt": 100.0}]), encoding="utf-8")
    assert list(sondehub.load_track(path).alt_m) == [100.0]


def test_load_track_sorts_dedupes_and_drops_incomplete_frames(tmp_path):
    frames = [
        {"datetime": "2022-04-04T21:10:00.000000Z", "lat": 33.0, "lon": -96.5, "alt": 20000.0, "vel_h": 10.0},
        {"datetime": "2022-04-04T21:00:00.000000Z", "lat": 32.9, "lon": -96.6, "alt": 15000.0, "vel_h": 9.0},
        {"datetime": "2022-04-04T21:00:00.000000Z", "lat": 32.9, "lon": -96.6, "alt": 15000.0, "vel_h": 9.0},  # heard twice
        {"datetime": "2022-04-04T21:05:00.000000Z", "lat": 33.0, "lon": -96.55},                                # no altitude
    ]
    path = tmp_path / "S1.json.gz"
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump(frames, f)
    df = sondehub.load_track(path)
    assert list(df.alt_m) == [15000.0, 20000.0]          # sorted by time, duplicate and incomplete removed
    assert df.time.dt.tz is not None                     # timezone-aware UTC
