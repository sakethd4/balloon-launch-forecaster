"""4D balloon trajectory simulator: winds that change with place AND time.

The 1D simulator (trajectory.py) freezes one wind profile for the whole flight. A real flight
lasts about 55 minutes and drifts tens of kilometres, so the wind it feels changes as it
moves and as the forecast evolves. Here the wind comes from a gridded forecast
(latitude x longitude x pressure level x forecast time), interpolated linearly in
latitude, longitude and time. Vertically, each interpolated column maps altitude to wind
using the forecast's geopotential height of every pressure level.

Simplifications (also true of the 1D version unless noted):
- Constant ascent and descent rates; burst at a fixed altitude.
- Geopotential height is used as altitude (differs from geometric height by ~0.2% at 13 km).
- Flat ground at `ground_m` everywhere. Real terrain varies; there is no terrain data yet.
- The forecast has no wind below the lowest pressure level above ground, so the 10 m wind
  is used at ground level and interpolated up to the first level above ground.
- Outside the forecast grid or time range the nearest edge value is used, and the flight
  records a note so the result can be flagged as unreliable.
"""
from dataclasses import dataclass

import numpy as np

from src.baselines.trajectory import EARTH_RADIUS_M, Trajectory


@dataclass
class Flight(Trajectory):
    """A trajectory plus notes about anything that makes it less trustworthy."""
    notes: tuple = ()


class WindField4D:
    """Gridded wind forecast. Arrays are indexed [time, level, lat, lon] (u, v, gh) and
    [time, lat, lon] (u10, v10). Latitude and longitude must be ascending."""

    def __init__(self, lead_h, lat, lon, gh_m, u, v, u10, v10):
        self.lead_h = np.asarray(lead_h, dtype=float)
        self.lat = np.asarray(lat, dtype=float)
        self.lon = np.asarray(lon, dtype=float)
        self.gh, self.u, self.v = (np.asarray(a, dtype=float) for a in (gh_m, u, v))
        self.u10, self.v10 = np.asarray(u10, dtype=float), np.asarray(v10, dtype=float)
        for axis, name in ((self.lead_h, "lead_h"), (self.lat, "lat"), (self.lon, "lon")):
            if np.any(np.diff(axis) <= 0):
                raise ValueError(f"{name} must be strictly increasing")

    @classmethod
    def from_dataset(cls, ds):
        """Build from a saved GFS file (see src/ingest/gfs.py)."""
        ds = ds.sortby("latitude").sortby("longitude")
        return cls(ds.lead_h.values, ds.latitude.values, ds.longitude.values,
                   ds.gh.transpose("lead_h", "isobaricInhPa", "latitude", "longitude").values,
                   ds.u.transpose("lead_h", "isobaricInhPa", "latitude", "longitude").values,
                   ds.v.transpose("lead_h", "isobaricInhPa", "latitude", "longitude").values,
                   ds.u10.transpose("lead_h", "latitude", "longitude").values,
                   ds.v10.transpose("lead_h", "latitude", "longitude").values)

    @staticmethod
    def _weights(axis, x):
        """Index of the lower neighbour and fractional position, clamped to the axis."""
        i = int(np.clip(np.searchsorted(axis, x) - 1, 0, len(axis) - 2))
        f = float(np.clip((x - axis[i]) / (axis[i + 1] - axis[i]), 0.0, 1.0))
        return i, f

    def inside(self, lat, lon, t_h):
        return (self.lat[0] <= lat <= self.lat[-1] and self.lon[0] <= lon <= self.lon[-1]
                and self.lead_h[0] <= t_h <= self.lead_h[-1])

    def wind_at(self, lat, lon, alt_m, t_h, ground_m):
        """Wind (u east, v north, m/s) at a point in space and time."""
        it, ft = self._weights(self.lead_h, t_h)
        iy, fy = self._weights(self.lat, lat)
        ix, fx = self._weights(self.lon, lon)

        def blend(a):  # a[..., t, ..., lat, lon] -> value at (t, lat, lon); level axis kept if present
            lo, hi = a[it], a[it + 1]
            out = 0.0
            for tt, wt in ((lo, 1 - ft), (hi, ft)):
                out = out + wt * ((1 - fy) * ((1 - fx) * tt[..., iy, ix] + fx * tt[..., iy, ix + 1])
                                  + fy * ((1 - fx) * tt[..., iy + 1, ix] + fx * tt[..., iy + 1, ix + 1]))
            return out

        gh, u, v = blend(self.gh), blend(self.u), blend(self.v)
        u10, v10 = blend(self.u10), blend(self.v10)
        order = np.argsort(gh)
        gh, u, v = gh[order], u[order], v[order]
        keep = gh > ground_m + 1.0  # drop pressure levels that are underground
        alts = np.concatenate([[ground_m], gh[keep]])
        us = np.concatenate([[u10], u[keep]])
        vs = np.concatenate([[v10], v[keep]])
        return float(np.interp(alt_m, alts, us)), float(np.interp(alt_m, alts, vs))


def simulate_flight_4d(field: WindField4D, launch_lat_deg: float, launch_lon_deg: float,
                       launch_lead_h: float, ascent_rate_ms: float = 5.833,
                       descent_rate_ms: float = 15.0, burst_altitude_m: float = 13716.0,
                       ground_m: float = 150.0, dt_s: float = 15.0) -> Flight:
    """Fly a balloon through a gridded forecast.

    `launch_lead_h` is the launch time in forecast hours (hours after the model run started).
    Position is advanced with a midpoint (RK2) step: wind at the start gives a half step, wind
    at that midpoint gives the full step. This is noticeably more accurate than using only the
    wind at the start of each step when the wind changes along the path.
    """
    lat, lon, alt, t = launch_lat_deg, launch_lon_deg, ground_m, 0.0
    ts, lats, lons, alts = [t], [lat], [lon], [alt]
    burst_index = None
    notes = set()

    def move(lat, lon, u, v, secs):
        return (lat + np.degrees(v * secs / EARTH_RADIUS_M),
                lon + np.degrees(u * secs / (EARTH_RADIUS_M * np.cos(np.radians(lat)))))

    while True:
        ascending = burst_index is None
        rate = ascent_rate_ms if ascending else -descent_rate_ms
        new_alt = alt + rate * dt_s
        if ascending and new_alt >= burst_altitude_m:
            new_alt = burst_altitude_m
        if not ascending and new_alt <= ground_m:
            new_alt = ground_m
        step = abs(new_alt - alt) / abs(rate)  # seconds actually used (shorter at burst / landing)
        t_h = launch_lead_h + t / 3600.0
        if not field.inside(lat, lon, t_h):
            notes.add("left the forecast grid or time range: edge winds used")
        u1, v1 = field.wind_at(lat, lon, alt, t_h, ground_m)
        mlat, mlon = move(lat, lon, u1, v1, step / 2)
        u2, v2 = field.wind_at(mlat, mlon, (alt + new_alt) / 2, t_h + step / 7200.0, ground_m)
        lat, lon = move(lat, lon, u2, v2, step)
        alt, t = new_alt, t + step
        if ascending and alt >= burst_altitude_m:
            burst_index = len(ts)
        ts.append(t); lats.append(lat); lons.append(lon); alts.append(alt)
        if not ascending and alt <= ground_m:
            break

    return Flight(np.array(ts), np.array(lats), np.array(lons), np.array(alts), burst_index,
                  tuple(sorted(notes)))
