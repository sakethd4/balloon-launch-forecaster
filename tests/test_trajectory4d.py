import numpy as np
import pytest

from src.baselines.trajectory import distance_km, simulate_flight
from src.baselines.trajectory4d import WindField4D, simulate_flight_4d

LEAD = np.array([0.0, 24.0, 48.0])
LAT = np.linspace(28.0, 32.0, 9)
LON = np.linspace(-100.0, -95.0, 11)
GH = np.array([100.0, 1500.0, 3000.0, 5500.0, 9000.0, 12000.0, 16000.0])  # 7 "pressure levels"
GROUND = 150.0


def make_field(u_fn, v_fn=lambda *a: 0.0):
    """u_fn(lead_h, gh_m, lat, lon) -> wind. Built on a grid so interpolation is exercised."""
    T, L, Y, X = len(LEAD), len(GH), len(LAT), len(LON)
    t, g, y, x = np.meshgrid(LEAD, GH, LAT, LON, indexing="ij")
    u, v = u_fn(t, g, y, x) + 0 * t, v_fn(t, g, y, x) + 0 * t
    t2, y2, x2 = np.meshgrid(LEAD, LAT, LON, indexing="ij")
    u10 = u_fn(t2, np.full_like(t2, GROUND), y2, x2) + 0 * t2
    v10 = v_fn(t2, np.full_like(t2, GROUND), y2, x2) + 0 * t2
    return WindField4D(LEAD, LAT, LON, np.broadcast_to(g, (T, L, Y, X)).copy(), u, v, u10, v10)


def test_uniform_wind_matches_the_1d_simulator():
    field = make_field(lambda t, g, y, x: 10.0 + 0 * g)
    f4 = simulate_flight_4d(field, 30.0, -97.5, 6.0, ground_m=GROUND, dt_s=10.0)
    f1 = simulate_flight(30.0, -97.5, np.array([0.0, 20000.0]), np.full(2, 10.0), np.zeros(2),
                         launch_alt_m=GROUND, dt_s=10.0)
    assert distance_km(*f4.landing, *f1.landing) < 0.05
    assert f4.flight_time_s == pytest.approx(f1.flight_time_s, rel=1e-6)
    assert f4.notes == ()


def test_height_dependent_wind_matches_the_1d_simulator():
    wind = lambda g: 0.002 * g  # 0 to 32 m/s from ground to 16 km
    field = make_field(lambda t, g, y, x: wind(g))
    alts = np.concatenate([[GROUND], GH[GH > GROUND + 1]])
    f4 = simulate_flight_4d(field, 30.0, -97.5, 6.0, ground_m=GROUND, dt_s=10.0)
    f1 = simulate_flight(30.0, -97.5, alts, wind(alts), np.zeros(len(alts)), launch_alt_m=GROUND, dt_s=10.0)
    assert distance_km(*f4.landing, *f1.landing) < 0.2


def test_wind_that_grows_with_forecast_time():
    a = 0.1  # m/s of wind per forecast hour
    field = make_field(lambda t, g, y, x: a * t)
    h0 = 6.0
    f = simulate_flight_4d(field, 30.0, -97.5, h0, ground_m=GROUND, dt_s=10.0)
    T = f.flight_time_s
    east_m = a * (h0 * T + T * T / 7200.0)  # integral of a * (h0 + t/3600) dt
    expected_dlon = np.degrees(east_m / (6_371_000.0 * np.cos(np.radians(30.0))))
    assert f.landing[1] - (-97.5) == pytest.approx(expected_dlon, rel=0.01)


def test_wind_that_depends_on_latitude():
    field = make_field(lambda t, g, y, x: 5.0 * (y - 30.0))  # no wind at 30N, eastward north of it
    calm = simulate_flight_4d(field, 30.0, -97.5, 6.0, ground_m=GROUND)
    windy = simulate_flight_4d(field, 31.0, -97.5, 6.0, ground_m=GROUND)
    assert calm.landing[1] == pytest.approx(-97.5, abs=1e-9)
    east_m = 5.0 * 1.0 * windy.flight_time_s
    expected = np.degrees(east_m / (6_371_000.0 * np.cos(np.radians(31.0))))
    assert windy.landing[1] - (-97.5) == pytest.approx(expected, rel=0.01)


def test_flight_outside_the_grid_is_flagged():
    field = make_field(lambda t, g, y, x: 10.0 + 0 * g)
    f = simulate_flight_4d(field, 33.5, -97.5, 6.0, ground_m=GROUND)
    assert any("left the forecast" in n for n in f.notes)


def test_flight_running_past_the_last_forecast_hour_is_flagged():
    field = make_field(lambda t, g, y, x: 10.0 + 0 * g)
    f = simulate_flight_4d(field, 30.0, -97.5, 47.9, ground_m=GROUND)  # 55 min flight starts 6 min before the end
    assert any("left the forecast" in n for n in f.notes)
