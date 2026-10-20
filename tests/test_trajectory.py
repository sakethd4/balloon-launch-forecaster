import numpy as np
import pytest

from src.baselines.trajectory import distance_km, simulate_flight

ALT = np.array([0.0, 20000.0])


def flight(u, v, **kw):
    return simulate_flight(30.0, -97.0, ALT, np.full(2, u), np.full(2, v), **kw)


def test_no_wind_lands_at_launch_point():
    t = flight(0.0, 0.0)
    assert t.landing == pytest.approx((30.0, -97.0), abs=1e-9)


def test_flight_time_matches_rates():
    # 13716 m up at 5.833 m/s + 13716 m down at 15 m/s
    t = flight(0.0, 0.0)
    expected = 13716 / 5.833 + 13716 / 15.0
    assert t.flight_time_s == pytest.approx(expected, rel=1e-6)
    assert t.alt_m.max() == pytest.approx(13716.0)
    assert t.alt_m[t.burst_index] == pytest.approx(13716.0)


def test_constant_westerly_wind_moves_balloon_east():
    t = flight(10.0, 0.0)
    lat, lon = t.landing
    assert lat == pytest.approx(30.0, abs=1e-9)
    # drift = wind speed * flight time
    assert distance_km(30.0, -97.0, lat, lon) == pytest.approx(10.0 * t.flight_time_s / 1000, rel=1e-3)
    assert lon > -97.0


def test_southerly_wind_moves_balloon_north():
    t = flight(0.0, 10.0)
    assert t.landing[0] > 30.0
    assert t.landing[1] == pytest.approx(-97.0, abs=1e-9)


def test_wind_layers_matter():
    # Wind only above 9 km: balloon should drift less than with the same wind everywhere
    alt = np.array([0.0, 9000.0, 9001.0, 20000.0])
    u = np.array([0.0, 0.0, 40.0, 40.0])
    layered = simulate_flight(30.0, -97.0, alt, u, np.zeros(4))
    uniform = flight(40.0, 0.0)
    assert 0 < distance_km(30, -97, *layered.landing) < distance_km(30, -97, *uniform.landing)


def test_rejects_unsorted_altitudes():
    with pytest.raises(ValueError):
        simulate_flight(30, -97, np.array([5.0, 1.0]), np.zeros(2), np.zeros(2))
