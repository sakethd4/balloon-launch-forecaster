import numpy as np

from src.evaluate.gfs_vs_sondes import gfs_profile


def test_low_stations_keep_all_levels_and_start_at_surface():
    # Pressure levels listed high pressure first, like GFS (1000 hPa lowest)
    gh = [110.0, 800.0, 1500.0, 3000.0]
    u = [1.0, 2.0, 3.0, 4.0]
    v = [0.0, 0.0, 0.0, 0.0]
    alt, uu, vv = gfs_profile(gh, u, v, u10=0.5, v10=0.1, elev_m=15.0)
    assert alt[0] == 15.0 and uu[0] == 0.5 and vv[0] == 0.1  # starts at the station, 10 m wind
    assert list(alt[1:]) == gh                                  # everything above ground kept


def test_levels_below_ground_are_dropped():
    # Station at 875 m (Midland): levels at 110 m and 800 m are underground
    gh = [110.0, 800.0, 1500.0, 3000.0]
    alt, uu, vv = gfs_profile(gh, [9.0, 9.0, 3.0, 4.0], [0.0] * 4, u10=0.5, v10=0.0, elev_m=875.0)
    assert list(alt) == [875.0, 1500.0, 3000.0]
    assert list(uu) == [0.5, 3.0, 4.0]  # the bogus underground values (9.0) are gone


def test_altitudes_strictly_increase():
    alt, *_ = gfs_profile([2000.0, 2000.0, 3000.0], [1, 2, 3], [0, 0, 0], 0.0, 0.0, 100.0)
    assert np.all(np.diff(alt) > 0)
