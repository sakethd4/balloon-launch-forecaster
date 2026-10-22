import numpy as np
import pandas as pd

from src.uncertainty import wind_error as we


def test_uniform_wind_error_moves_landing_by_wind_times_time_aloft():
    # a 1 m/s eastward error at every level acts for the whole flight: 13716 m of climb at 5.833 m/s
    # plus 13716 m of descent at 15 m/s, about 3,266 s, so ~3.27 km
    err = np.zeros(16)
    err[:8] = 1.0
    east, north = we.landing_displacement_km(err)
    assert abs(east - 13716 * (1 / 5.833 + 1 / 15) / 1000) < 0.02
    assert north == 0.0


def _toy_table(n=3000, seed=0):
    rng = np.random.default_rng(seed)
    lead = rng.choice([0, 12, 24, 48], n)
    spread = rng.uniform(1, 6, n)
    scale = 0.5 * spread                              # error size really depends on spread
    d = {c: rng.normal(0, 1, n) * scale for c in we.OUTPUTS}
    return pd.DataFrame({**d, "lead_h": lead, "month": 6, "gfs_wind_ms": 20.0, "spread_ms": spread,
                         "year": rng.choice([2021, 2022, 2023, 2024], n)})


def test_model_learns_that_spread_sets_the_error_size_and_samples_have_the_right_shape():
    t = _toy_table()
    m = we.WindErrorModel(["lead_h", "spread_ms"], max_iter=60).fit(t)
    probe = pd.DataFrame({"lead_h": [12, 12], "spread_ms": [1.5, 5.5]})
    s = m.sample(probe, 400, np.random.default_rng(0))
    assert s.shape == (2, 400, 16)
    assert s[1].std() > 2.0 * s[0].std()               # more spread -> wider error samples
    assert abs(s.mean()) < 0.3                         # centred on zero


def _calm_field():
    from src.baselines.trajectory4d import WindField4D
    lev = [1000.0, 500.0, 200.0]
    shape = (2, 3, 2, 2)
    gh = np.broadcast_to(np.array([100.0, 5500.0, 12000.0])[None, :, None, None], shape)
    z, z2 = np.zeros(shape), np.zeros((2, 2, 2))
    return WindField4D([0.0, 24.0], [30.0, 31.0], [-98.0, -97.0], gh, z, z, z2, z2, levels_hpa=lev)


def test_column_error_shifts_the_whole_wind_profile_and_moves_the_landing():
    from src.baselines.trajectory4d import simulate_flight_4d
    f = _calm_field()
    shifted = f.with_column_error([850.0, 150.0], [5.0, 5.0], [0.0, 0.0])      # 5 m/s from the west, all heights
    assert np.allclose(shifted.u, 5.0) and np.allclose(shifted.u10, 5.0) and np.allclose(shifted.v, 0.0)
    assert np.allclose(f.u, 0.0)                                                # the original is untouched
    calm = simulate_flight_4d(f, 30.5, -97.5, 0.0, ground_m=150.0)
    moved = simulate_flight_4d(shifted, 30.5, -97.5, 0.0, ground_m=150.0)
    east_km = (moved.landing[1] - calm.landing[1]) * 111.195 * np.cos(np.radians(30.5))
    assert abs(east_km - 5.0 * (13566 / 5.833 + 13566 / 15) / 1000) < 0.8       # ~16.2 km
    assert abs(moved.landing[0] - calm.landing[0]) < 1e-3                       # no northward drift


def test_ensemble_landings_scatter_around_the_nominal_landing_in_proportion_to_the_error_size():
    from src.uncertainty.ensemble import fly_ensemble
    t = _toy_table()
    m = we.WindErrorModel(["lead_h", "spread_ms"], max_iter=40).fit(t)
    f = _calm_field()
    small = fly_ensemble(f, m, dict(lead_h=12, spread_ms=1.5), 30.5, -97.5, 0.0, n=30, rng=np.random.default_rng(0))
    large = fly_ensemble(f, m, dict(lead_h=12, spread_ms=5.5), 30.5, -97.5, 0.0, n=30, rng=np.random.default_rng(0))
    assert small.landings.shape == (30, 2)
    assert large.radius_km(0.9) > 2.0 * small.radius_km(0.9)
    assert 0.0 <= large.prob_within(*large.nominal.landing, 1000.0) <= 1.0


def test_ensemble_along_a_prescribed_altitude_history_scatters_only_through_the_winds():
    from src.uncertainty.ensemble import fly_ensemble_along_track
    t = _toy_table()
    m = we.WindErrorModel(["lead_h", "spread_ms"], max_iter=40).fit(t)
    elapsed = np.arange(0.0, 2401.0, 60.0)
    alt = 150.0 + 5.833 * elapsed
    nominal, paths = fly_ensemble_along_track(_calm_field(), m, dict(lead_h=12, spread_ms=4.0), 30.5, -97.5, 0.0,
                                              elapsed, alt, ground_m=150.0, n=20, rng=np.random.default_rng(0))
    assert nominal.shape == (len(elapsed), 2) and paths.shape == (20, len(elapsed), 2)
    assert np.allclose(paths[:, 0], nominal[0])                  # all start at the launch point
    assert np.ptp(paths[:, -1, 1]) > 1e-3                        # but end in different places
