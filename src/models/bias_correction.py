"""Cheapest baseline: subtract the forecast's average error.

If GFS winds are, say, 1.5 m/s too strong at 300 hPa in winter at 48 h lead, subtract
1.5 m/s from the forecast. No learning beyond an average. The error table is estimated on a
TRAINING period only and then applied to a later TEST period, so the score reflects how it
would do on future launches (time-based split, never random).

The table is keyed by (station, season, lead time) and holds the mean wind error (forecast
minus measured, u and v) at the standard pressure levels soundings report. To correct the
other forecast levels, the bias is interpolated between those levels in log-pressure.

`by_station=False` pools all stations into one table. That version does not know where it
is, so it is the honest test of how a correction would transfer to a place with no sounding
(Austin).
"""
import numpy as np
import pandas as pd

MIN_SAMPLES = 20  # ignore a table entry built from fewer comparisons than this


class BiasCorrection:
    def __init__(self, by_station: bool, min_samples: int = MIN_SAMPLES):
        self.by_station = by_station
        self.min_samples = min_samples
        self.table = {}  # (station or None, season, lead_h) -> (levels_hpa, bias_u, bias_v)

    def fit(self, levels: pd.DataFrame, seasons: dict):
        """`levels`: one row per forecast/sounding comparison (columns station, init,
        lead_h, level_hpa, du, dv), where du/dv = forecast minus measured wind."""
        df = levels.assign(season=levels.init.dt.month.map(seasons))
        df["station"] = df.station if self.by_station else None
        keys = ["station", "season", "lead_h", "level_hpa"]
        g = df.groupby(keys, dropna=False).agg(u=("du", "mean"), v=("dv", "mean"), n=("du", "size")).reset_index()
        g = g[g.n >= self.min_samples]
        for (st, season, lead), part in g.groupby(["station", "season", "lead_h"], dropna=False):
            part = part.sort_values("level_hpa")
            st = None if pd.isna(st) else st
            self.table[(st, season, lead)] = (part.level_hpa.to_numpy(), part.u.to_numpy(), part.v.to_numpy())
        return self

    def __call__(self, station, season, lead_h, levels_hpa, u, v):
        """Return corrected (u, v) on `levels_hpa`. Unchanged if the table has no entry."""
        entry = self.table.get((station if self.by_station else None, season, lead_h))
        if entry is None:
            return np.asarray(u, dtype=float), np.asarray(v, dtype=float)
        lv, bu, bv = entry
        x, xp = np.log(np.asarray(levels_hpa, dtype=float)), np.log(lv)
        # np.interp needs ascending xp (log of ascending pressure) and holds the end values
        return (np.asarray(u, dtype=float) - np.interp(x, xp, bu),
                np.asarray(v, dtype=float) - np.interp(x, xp, bv))
