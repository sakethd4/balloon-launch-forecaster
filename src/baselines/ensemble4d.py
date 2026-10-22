"""Fly many balloons through one forecast at once (vectorised 4D simulator).

`simulate_flight_4d` moves one balloon per call (~70 ms). The uncertainty ensemble needs ~100 balloons that
differ only in an additive wind-error profile and so share the same altitude history and time steps. Here all of
them advance together with array arithmetic, which brings 100 flights down to a fraction of a second, fast enough
to run when a user clicks a launch point.

It is the same algorithm as `simulate_flight_4d` (midpoint/RK2 steps, the 10 m wind at the ground, nearest-edge
winds outside the grid); tests/test_ensemble4d.py checks that both give the same landing points.
"""
import numpy as np

from src.baselines.trajectory import EARTH_RADIUS_M
from src.baselines.trajectory4d import WindField4D


def _weights(axis, x):
    """Lower neighbour index and fraction, clamped to the axis (vectorised `WindField4D._weights`)."""
    x = np.atleast_1d(np.asarray(x, dtype=float))
    i = np.clip(np.searchsorted(axis, x) - 1, 0, len(axis) - 2)
    return i, np.clip((x - axis[i]) / (axis[i + 1] - axis[i]), 0.0, 1.0)


def _blend(a, it, ft, iy, fy, ix, fx):
    """a[time, level, lat, lon] -> value at each point's (lat, lon) and the common time. Shape (level, N)."""
    out = 0.0
    for tt, wt in ((it, 1.0 - ft), (it + 1, ft)):
        g = a[tt]
        out = out + wt * ((1 - fy) * ((1 - fx) * g[..., iy, ix] + fx * g[..., iy, ix + 1])
                          + fy * ((1 - fx) * g[..., iy + 1, ix] + fx * g[..., iy + 1, ix + 1]))
    return out


def columns_at(field: WindField4D, lat, lon, t_h):
    """Forecast columns above each (lat, lon) at forecast hour t_h: dict with gh, u, v (level, N), u10, v10 (N).
    Temperature and humidity columns (temp_k, rh_pct) are included when the field has them."""
    lat, lon = np.atleast_1d(lat), np.atleast_1d(lon)
    it, ft = WindField4D._weights(field.lead_h, t_h)
    iy, fy = _weights(field.lat, lat)
    ix, fx = _weights(field.lon, lon)
    out = {k: _blend(getattr(field, k), it, ft, iy, fy, ix, fx) for k in ("gh", "u", "v")}
    for k in ("temp_k", "rh_pct"):
        if getattr(field, k) is not None:
            out[k] = _blend(getattr(field, k), it, ft, iy, fy, ix, fx)
    out["u10"] = _blend(field.u10[:, None], it, ft, iy, fy, ix, fx)[0]
    out["v10"] = _blend(field.v10[:, None], it, ft, iy, fy, ix, fx)[0]
    return out


def wind_from_columns(cols, alt, ground_m, eu=None, ev=None, eu10=None, ev10=None):
    """Wind (u, v) at altitude `alt` (N,) from columns, optionally shifted by per-point wind errors.

    Underground levels are replaced by the 10 m wind just above the ground, which reproduces what the scalar
    simulator does by dropping them and interpolating from the 10 m wind up to the first level above ground.
    """
    gh, u, v, u10, v10 = cols["gh"], cols["u"].copy(), cols["v"].copy(), cols["u10"].copy(), cols["v10"].copy()
    if eu is not None:                                  # eu, ev: (N, level) errors; eu10, ev10: (N,)
        u += eu.T; v += ev.T; u10 += eu10; v10 += ev10
    n_lev, n = gh.shape
    under = gh <= ground_m + 1.0
    k = np.arange(n_lev)[:, None]
    gh = np.maximum.accumulate(np.where(under, ground_m + 1e-3 * (k + 1), gh), axis=0)
    u = np.where(under, u10, u); v = np.where(under, v10, v)
    ghe = np.vstack([np.full((1, n), ground_m), gh]); ue = np.vstack([u10, u]); ve = np.vstack([v10, v])
    idx = np.clip((ghe <= alt).sum(axis=0) - 1, 0, ghe.shape[0] - 2)
    cols_n = np.arange(n)
    g0, g1 = ghe[idx, cols_n], ghe[idx + 1, cols_n]
    f = np.clip((alt - g0) / np.maximum(g1 - g0, 1e-9), 0.0, 1.0)
    return ue[idx, cols_n] * (1 - f) + ue[idx + 1, cols_n] * f, ve[idx, cols_n] * (1 - f) + ve[idx + 1, cols_n] * f


def _move(lat, lon, u, v, secs):
    return (lat + np.degrees(v * secs / EARTH_RADIUS_M),
            lon + np.degrees(u * secs / (EARTH_RADIUS_M * np.cos(np.radians(lat)))))


def error_arrays(field: WindField4D, errors, levels_hpa):
    """Turn sampled error profiles (N, 2*len(levels_hpa): all du then all dv) into per-level and 10 m shifts.

    The model's error is forecast MINUS truth, so truth = forecast - error: the shifts are the negated, log-pressure
    interpolated errors (same as `WindField4D.with_column_error`).
    """
    k = len(levels_hpa)
    order = np.argsort(levels_hpa)
    x, xi = np.log(np.asarray(levels_hpa, dtype=float)[order]), np.log(field.levels_hpa)
    du, dv = -errors[:, :k][:, order], -errors[:, k:][:, order]
    eu = np.stack([np.interp(xi, x, row) for row in du])
    ev = np.stack([np.interp(xi, x, row) for row in dv])
    return eu, ev, du[:, -1], dv[:, -1]


def simulate_ensemble_4d(field: WindField4D, launch_lat, launch_lon, launch_lead_h, n=1, errors=None, levels_hpa=None,
                         ascent_rate_ms=5.833, descent_rate_ms=15.0, burst_altitude_m=13716.0, ground_m=150.0, dt_s=15.0):
    """Fly `n` balloons together. `errors` is (n, 2*len(levels_hpa)) sampled wind-error profiles, or None for one
    unperturbed flight. Returns dict: t_s (T,), alt_m (T,), lat, lon (n, T), burst_index, left_domain (n,) bool."""
    if errors is None:
        eu = ev = eu10 = ev10 = None
    else:
        n = len(errors)
        eu, ev, eu10, ev10 = error_arrays(field, errors, levels_hpa)
    lat, lon = np.full(n, float(launch_lat)), np.full(n, float(launch_lon))
    alt, t = float(ground_m), 0.0
    ts, alts, lats, lons = [t], [alt], [lat.copy()], [lon.copy()]
    burst_index, left = None, np.zeros(n, dtype=bool)

    def wind(la, lo, a, t_h):
        return wind_from_columns(columns_at(field, la, lo, t_h), np.full(len(la), a), ground_m, eu, ev, eu10, ev10)

    while True:
        ascending = burst_index is None
        rate = ascent_rate_ms if ascending else -descent_rate_ms
        new_alt = alt + rate * dt_s
        if ascending and new_alt >= burst_altitude_m:
            new_alt = burst_altitude_m
        if not ascending and new_alt <= ground_m:
            new_alt = ground_m
        step = abs(new_alt - alt) / abs(rate)
        t_h = launch_lead_h + t / 3600.0
        left |= ~((field.lat[0] <= lat) & (lat <= field.lat[-1]) & (field.lon[0] <= lon) & (lon <= field.lon[-1])
                  & (field.lead_h[0] <= t_h <= field.lead_h[-1]))
        u1, v1 = wind(lat, lon, alt, t_h)
        mlat, mlon = _move(lat, lon, u1, v1, step / 2)
        u2, v2 = wind(mlat, mlon, (alt + new_alt) / 2, t_h + step / 7200.0)
        lat, lon = _move(lat, lon, u2, v2, step)
        alt, t = new_alt, t + step
        if ascending and alt >= burst_altitude_m:
            burst_index = len(ts)
        ts.append(t); alts.append(alt); lats.append(lat.copy()); lons.append(lon.copy())
        if not ascending and alt <= ground_m:
            break
    return dict(t_s=np.array(ts), alt_m=np.array(alts), lat=np.array(lats).T, lon=np.array(lons).T,
                burst_index=burst_index, left_domain=left)
