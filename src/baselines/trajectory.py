"""Baseline balloon trajectory simulator (no ML).

A latex weather balloon is carried by the wind. It climbs at a roughly constant
rate until it bursts, then falls under a parachute. So the flight is:

    position change = wind at current altitude * time step

We step through time, look up the wind at the balloon's altitude, and move the
balloon. This is the baseline every ML model has to beat.

Simplifications (documented so nobody is surprised):
- One wind profile is used for the whole flight (no change in time or location).
  Later versions will use forecast fields that vary in space and time.
- Constant ascent and descent rates (the club's average numbers).
- Wind is in m/s: u = toward the east, v = toward the north (so pass u/v, not
  the "direction wind comes from" convention used in raw data).
"""
from dataclasses import dataclass

import numpy as np

EARTH_RADIUS_M = 6_371_000.0


@dataclass
class Trajectory:
    """Flight path sampled every time step."""
    t_s: np.ndarray      # seconds since launch
    lat_deg: np.ndarray
    lon_deg: np.ndarray
    alt_m: np.ndarray
    burst_index: int     # index of the burst point in the arrays

    @property
    def landing(self) -> tuple[float, float]:
        return float(self.lat_deg[-1]), float(self.lon_deg[-1])

    @property
    def flight_time_s(self) -> float:
        return float(self.t_s[-1])


def distance_km(lat1, lon1, lat2, lon2) -> float:
    """Great-circle (haversine) distance between two points in km."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(lon2 - lon1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return float(2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(a)) / 1000)


def simulate_flight(
    launch_lat_deg: float,
    launch_lon_deg: float,
    wind_alt_m: np.ndarray,
    wind_u_ms: np.ndarray,
    wind_v_ms: np.ndarray,
    ascent_rate_ms: float = 5.833,
    descent_rate_ms: float = 15.0,
    burst_altitude_m: float = 13716.0,
    launch_alt_m: float = 0.0,
    dt_s: float = 10.0,
) -> Trajectory:
    """Simulate one flight through a single wind profile.

    `wind_alt_m` must be increasing. Outside its range the nearest value is used.
    Altitudes are meters above mean sea level (same reference for the profile).
    """
    wind_alt_m = np.asarray(wind_alt_m, dtype=float)
    if np.any(np.diff(wind_alt_m) <= 0):
        raise ValueError("wind_alt_m must be strictly increasing")

    def wind_at(alt):
        # np.interp holds the end values flat outside the range
        return (np.interp(alt, wind_alt_m, wind_u_ms),
                np.interp(alt, wind_alt_m, wind_v_ms))

    t, lat, lon, alt = 0.0, launch_lat_deg, launch_lon_deg, launch_alt_m
    ts, lats, lons, alts = [t], [lat], [lon], [alt]
    burst_index = None

    while True:
        ascending = burst_index is None
        rate = ascent_rate_ms if ascending else -descent_rate_ms
        # Use the wind at the middle of the step (midpoint rule) for better accuracy
        # than using the wind at the start of the step.
        new_alt = alt + rate * dt_s
        if ascending and new_alt >= burst_altitude_m:
            new_alt = burst_altitude_m
        if not ascending and new_alt <= launch_alt_m:
            new_alt = launch_alt_m  # don't overshoot the ground on the last step
        step = abs(new_alt - alt) / abs(rate)  # seconds actually used this step
        u, v = wind_at((alt + new_alt) / 2)

        # Meters moved -> degrees. East-west degrees shrink with latitude (cos(lat)).
        dlat = np.degrees(v * step / EARTH_RADIUS_M)
        dlon = np.degrees(u * step / (EARTH_RADIUS_M * np.cos(np.radians(lat))))
        lat, lon, alt, t = lat + dlat, lon + dlon, new_alt, t + step

        if ascending and alt >= burst_altitude_m:
            burst_index = len(ts)
        if not ascending and alt <= launch_alt_m:
            alt = launch_alt_m
            ts.append(t); lats.append(lat); lons.append(lon); alts.append(alt)
            break
        ts.append(t); lats.append(lat); lons.append(lon); alts.append(alt)

    return Trajectory(np.array(ts), np.array(lats), np.array(lons), np.array(alts), burst_index)
