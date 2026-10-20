import numpy as np
import pandas as pd

from src.evaluate.gfs_vs_sondes import SEASONS
from src.models.bias_correction import BiasCorrection


def make_levels(n=30, bias_u=1.5, bias_v=-0.5, station="FWD", month=1, lead=24):
    rows = []
    for i in range(n):
        for lev in (850.0, 500.0, 300.0):
            rows.append(dict(station=station, init=pd.Timestamp(2022, month, 1 + i % 28, 12, tz="UTC"),
                             lead_h=lead, level_hpa=lev, du=bias_u, dv=bias_v))
    return pd.DataFrame(rows)


def test_constant_bias_is_removed_and_other_levels_are_interpolated():
    bc = BiasCorrection(by_station=True).fit(make_levels(), SEASONS)
    levels = np.array([1000.0, 850.0, 700.0, 400.0, 100.0])
    u, v = bc("FWD", "DJF", 24, levels, np.full(5, 10.0), np.full(5, 3.0))
    assert np.allclose(u, 10.0 - 1.5) and np.allclose(v, 3.0 + 0.5)  # constant bias everywhere


def test_unseen_season_lead_or_station_is_left_unchanged():
    bc = BiasCorrection(by_station=True).fit(make_levels(), SEASONS)
    lv, u, v = np.array([500.0]), np.array([7.0]), np.array([2.0])
    for args in [("FWD", "JJA", 24), ("FWD", "DJF", 36), ("CRP", "DJF", 24)]:
        cu, cv = bc(*args, lv, u, v)
        assert cu[0] == 7.0 and cv[0] == 2.0


def test_pooled_table_ignores_station():
    bc = BiasCorrection(by_station=False).fit(make_levels(station="FWD"), SEASONS)
    cu, _ = bc("MAF", "DJF", 24, np.array([500.0]), np.array([10.0]), np.array([0.0]))
    assert np.isclose(cu[0], 8.5)  # a station never seen in training still gets the pooled bias


def test_small_samples_are_ignored():
    bc = BiasCorrection(by_station=True, min_samples=100).fit(make_levels(n=5), SEASONS)
    cu, _ = bc("FWD", "DJF", 24, np.array([500.0]), np.array([10.0]), np.array([0.0]))
    assert cu[0] == 10.0
