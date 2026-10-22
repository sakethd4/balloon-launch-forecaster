"""The forecast-situation features the wind-error model conditions on (see wind_error.py).

Defined once so training (scripts/spread_test.py) and use (flying an ensemble for a real launch)
compute them identically: GEFS wind spread and GFS wind speed, each averaged over 500/300/200 hPa
and over a +-1 degree box around the launch point, at the requested lead time.
"""
import numpy as np

LEVELS = [500.0, 300.0, 200.0]
BOX_DEG = 1.0


def _box(ds, lat, lon):
    return ds.sel(latitude=slice(lat - BOX_DEG, lat + BOX_DEG), longitude=slice(lon - BOX_DEG, lon + BOX_DEG))


def situation_features(spread_ds, gfs_ds, lat, lon, leads_h):
    """(spread_ms, gfs_wind_ms) arrays for each lead in `leads_h` (hours after the run started).

    The spread file has leads 0,12,24,36,48,72,96,120 h; other leads are interpolated linearly.
    The GFS file has every 6 h; other leads are interpolated linearly too.
    """
    leads_h = np.atleast_1d(np.asarray(leads_h, dtype=float))
    spread = (_box(spread_ds.spread_ms.sel(isobaricInhPa=LEVELS), lat, lon)
              .mean(["isobaricInhPa", "latitude", "longitude"]).interp(lead_h=leads_h))
    g = _box(gfs_ds.sel(isobaricInhPa=LEVELS), lat, lon)
    wind = np.hypot(g.u, g.v).mean(["isobaricInhPa", "latitude", "longitude"]).interp(lead_h=leads_h)
    return spread.values, wind.values
