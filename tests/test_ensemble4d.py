import numpy as np

from src.baselines.ensemble4d import simulate_ensemble_4d
from src.baselines.trajectory4d import WindField4D, simulate_flight_4d
from src.uncertainty import wind_error as we


def _random_field(seed=0):
    """A small forecast with winds that differ by place, height and time, and a 1000 hPa level that is underground."""
    rng = np.random.default_rng(seed)
    lead, lat, lon = np.array([0.0, 6.0, 12.0, 24.0]), np.arange(28.0, 32.01, 0.5), np.arange(-100.0, -94.99, 0.5)
    lev = np.array([1000.0, 850.0, 700.0, 500.0, 400.0, 300.0, 250.0, 200.0, 150.0, 100.0])
    gh1 = np.array([100.0, 1500.0, 3000.0, 5600.0, 7200.0, 9200.0, 10400.0, 11800.0, 13600.0, 16200.0])
    shape = (len(lead), len(lev), len(lat), len(lon))
    gh = gh1[None, :, None, None] + rng.normal(0, 30, shape)
    gh = np.maximum.accumulate(gh, axis=1)
    speed = np.linspace(2, 40, len(lev))[None, :, None, None]
    u = speed * (0.5 + 0.5 * np.sin(lat[None, None, :, None] + lead[:, None, None, None] / 9)) + rng.normal(0, 2, shape)
    v = 0.4 * speed * np.cos(lon[None, None, None, :] / 2) + rng.normal(0, 2, shape)
    u10, v10 = rng.normal(2, 1, shape[:1] + shape[2:]), rng.normal(-1, 1, shape[:1] + shape[2:])
    return WindField4D(lead, lat, lon, gh, u, v, u10, v10, levels_hpa=lev)


def test_vectorised_ensemble_matches_flying_each_balloon_with_the_scalar_simulator():
    field = _random_field()
    rng = np.random.default_rng(1)
    errors = rng.normal(0, 4, (4, 2 * len(we.LEVELS_HPA)))
    ground = 800.0                                           # the 1000 hPa level (~100 m) is underground
    fast = simulate_ensemble_4d(field, 30.0, -97.5, 2.0, errors=errors, levels_hpa=we.LEVELS_HPA, ground_m=ground)
    k = len(we.LEVELS_HPA)
    for i, e in enumerate(errors):
        slow = simulate_flight_4d(field.with_column_error(we.LEVELS_HPA, -e[:k], -e[k:]), 30.0, -97.5, 2.0, ground_m=ground)
        assert len(slow.t_s) == len(fast["t_s"]) and slow.burst_index == fast["burst_index"]
        assert np.allclose(fast["lat"][i], slow.lat_deg, atol=1e-7) and np.allclose(fast["lon"][i], slow.lon_deg, atol=1e-7)
    assert np.allclose(fast["alt_m"], slow.alt_m)


def test_single_unperturbed_flight_matches_and_edge_use_is_flagged():
    field = _random_field(3)
    one = simulate_ensemble_4d(field, 30.0, -97.5, 0.0, n=1, ground_m=150.0)
    ref = simulate_flight_4d(field, 30.0, -97.5, 0.0, ground_m=150.0)
    assert np.allclose(one["lat"][0], ref.lat_deg, atol=1e-7) and np.allclose(one["lon"][0], ref.lon_deg, atol=1e-7)
    assert not one["left_domain"][0]
    edge = simulate_ensemble_4d(field, 28.05, -99.95, 0.0, n=1, ground_m=150.0)    # launched at the corner: drifts out of the grid
    assert edge["left_domain"][0] == bool(simulate_flight_4d(field, 28.05, -99.95, 0.0, ground_m=150.0).notes)
