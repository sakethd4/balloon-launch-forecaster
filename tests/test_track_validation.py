import numpy as np
import pandas as pd

from src.evaluate import track_validation as tv


def make_track(n_up=3000, n_down=900, start=100.0, peak=30000.0, t0="2024-01-10 11:20:00", gap_at=None, gap_s=0):
    """A fake flight, one frame per second: climbs linearly to `peak`, then falls."""
    alt = np.concatenate([np.linspace(start, peak, n_up), np.linspace(peak, 200.0, n_down)])
    secs = np.arange(len(alt), dtype=float)
    if gap_at is not None:
        secs[gap_at:] += gap_s
    time = pd.Timestamp(t0, tz="UTC") + pd.to_timedelta(secs, unit="s")
    return pd.DataFrame({"time": time, "lat": 33.0, "lon": -96.5, "alt_m": alt})


def test_ascent_leg_ends_at_the_first_frame_at_or_above_the_top():
    leg = tv.ascent_leg(make_track())
    assert leg.alt_m.iloc[0] == 100.0
    assert leg.alt_m.iloc[-1] >= tv.TOP_M > leg.alt_m.iloc[-2]


def test_ascent_leg_rejected_when_the_track_starts_high_or_has_a_gap():
    assert tv.ascent_leg(make_track(start=8000.0)) is None                     # first frame heard at 8 km
    assert tv.ascent_leg(make_track(gap_at=1000, gap_s=900)) is None            # 15 min with no frames


def test_descent_leg_starts_below_the_top_and_ends_at_the_last_frame():
    leg = tv.descent_leg(make_track())
    assert leg.alt_m.iloc[0] <= tv.TOP_M and leg.alt_m.iloc[-1] == 200.0
    assert tv.descent_leg(make_track(n_down=900).iloc[:-400]) is None          # track stops at ~9 km


def test_clean_flight_keeps_only_the_segment_with_the_peak():
    a = make_track(t0="2024-01-10 11:20:00")
    stray = make_track(n_up=50, n_down=50, peak=2000.0, t0="2024-01-12 11:20:00")  # unrelated frames 2 days later
    both = pd.concat([a, stray], ignore_index=True)
    assert len(tv.clean_flight(both)) == len(a)


def test_subsample_keeps_first_and_last_and_thins_to_about_every_30_seconds():
    leg = tv.ascent_leg(make_track())
    sub, elapsed = tv.subsample(leg, 30.0)
    assert sub.index[0] == leg.index[0] and sub.index[-1] == leg.index[-1]
    assert elapsed[0] == 0.0 and np.all(np.diff(elapsed) <= 30.0 + 1e-9)
    assert len(sub) < len(leg) / 20


def test_pick_init_chooses_the_latest_12z_run_issued_early_enough():
    start = pd.Timestamp("2024-01-10 11:20", tz="UTC")                          # a 12Z-sounding launch
    assert tv.pick_init(start, 0) == pd.Timestamp("2024-01-09 12:00", tz="UTC")  # lead ~23 h
    assert tv.pick_init(start, 24) == pd.Timestamp("2024-01-08 12:00", tz="UTC") # lead ~47 h
    late = pd.Timestamp("2024-01-10 23:20", tz="UTC")                           # a 00Z-sounding launch
    assert tv.pick_init(late, 0) == pd.Timestamp("2024-01-10 12:00", tz="UTC")   # lead ~11 h
