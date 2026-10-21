"""A generative model of how GFS winds are wrong, by altitude.

What it learns: given a forecast situation (lead time, month, how strong the forecast wind is, how
much the GEFS ensemble members disagree), the distribution of the wind ERROR profile (forecast
minus measured u and v on 850 ... 150 hPa). Drawing samples from it and adding them to the
forecast winds gives many plausible "true" wind fields; flying the balloon through each one gives a
distribution of landing points instead of one dot. The physics stays in the simulator; the model
only supplies the winds' uncertainty, so it works for any launch time or balloon setup.

How (kept simple on purpose, every step is checked against a baseline in scripts/wind_error_model.py):
  1. SCALE: for each of the 16 outputs (8 levels x u,v), gradient boosting predicts the typical
     size of the error, E|error|, from the forecast situation.
  2. SHAPE: error / scale gives "standardized" error profiles. Keeping whole profiles (not
     independent numbers) preserves how errors at different heights move together (a jet-stream
     displacement shifts many levels at once) and the heavy tails. Training profiles are
     standardized with scale predictions made WITHOUT their own year (leave-one-year-out); scales
     fitted in-sample would be too small on the training rows and give a too-narrow bank.
  3. SAMPLE: draw a standardized profile from the bank (same lead time) and multiply by the scale
     predicted for the new situation.
The mean error is taken as zero: the measured mean 300 hPa error is ~0.7 m/s against ~7.5 m/s RMSE
(see CLAUDE.md), so bias is a small part of the story.
"""
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

LEVELS_HPA = (850.0, 700.0, 500.0, 400.0, 300.0, 250.0, 200.0, 150.0)
# Heights (m) of those levels in the standard atmosphere, used only to turn level errors into a
# landing displacement. Real heights vary by a few hundred metres with the weather.
LEVEL_HEIGHTS_M = np.array([1457.0, 3012.0, 5574.0, 7185.0, 9164.0, 10363.0, 11784.0, 13608.0])
OUTPUTS = [f"{c}{int(l)}" for c in ("du", "dv") for l in LEVELS_HPA]  # du850 ... du150, dv850 ... dv150
FEATURE_SETS = {
    "lead": ["lead_h"],
    "lead+month": ["lead_h", "month"],
    "full": ["lead_h", "month", "gfs_wind_ms", "spread_ms"],
}


def profile_table(levels: pd.DataFrame, features: pd.DataFrame) -> pd.DataFrame:
    """One row per (station, init, lead): the 16 error values plus the forecast-situation features.

    `levels` is the per-level wind error table (gfs_vs_sondes_levels.csv), `features` the table made
    by scripts/spread_test.py (spread_features.csv). Profiles missing any of the 8 levels are dropped.
    """
    sel = levels[levels.level_hpa.isin(LEVELS_HPA)]
    wide = sel.pivot_table(index=["station", "init", "lead_h"], columns="level_hpa", values=["du", "dv"])
    wide.columns = [f"{c}{int(l)}" for c, l in wide.columns]
    wide = wide[OUTPUTS].dropna().reset_index()
    out = wide.merge(features[["station", "init", "lead_h", "spread_ms", "gfs_wind_ms"]],
                     on=["station", "init", "lead_h"], how="inner").dropna()
    out["month"] = out.init.dt.month
    out["year"] = out.init.dt.year
    return out.reset_index(drop=True)


def landing_weights(heights_m=LEVEL_HEIGHTS_M, burst_m=13716.0, ascent_ms=5.833, descent_ms=15.0):
    """How much one metre/second of error at each level moves the landing point (seconds).

    A balloon that climbs at a constant rate spends 1/ascent seconds per metre of height in each layer
    and 1/descent on the way down, so the landing displacement caused by a wind error profile e(z)
    is the integral of e(z) * (1/ascent + 1/descent) dz. With e(z) interpolated linearly between
    levels (held constant below the lowest and above the highest), that is a weighted sum of the
    level errors. It ignores that the wind error also changes with position and time during the
    flight; scripts/wind_error_model.py checks this against the full simulator's landing errors.
    """
    z = np.arange(0.0, burst_m, 10.0) + 5.0
    w = np.array([np.interp(z, heights_m, np.eye(len(heights_m))[j]).sum() * 10.0 for j in range(len(heights_m))])
    return w * (1.0 / ascent_ms + 1.0 / descent_ms)


def landing_displacement_km(errors: np.ndarray) -> np.ndarray:
    """(east, north) landing displacement in km for error profiles of shape (..., 16)."""
    w = landing_weights()
    n = len(LEVELS_HPA)
    return np.stack([errors[..., :n] @ w, errors[..., n:] @ w], axis=-1) / 1000.0


class WindErrorModel:
    """Conditional generator of wind-error profiles. `features` picks which situation features it sees."""

    def __init__(self, features, max_iter=200, seed=0):
        self.features = list(features)
        self.max_iter = max_iter
        self.seed = seed

    def _gbm(self):
        return HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=self.max_iter,
                                             min_samples_leaf=100, random_state=self.seed)

    def _fit_scales(self, X, E):
        return [self._gbm().fit(X, np.abs(E[:, j])) for j in range(E.shape[1])]

    @staticmethod
    def _predict_scales(models, X):
        return np.maximum(np.column_stack([m.predict(X) for m in models]), 0.1)  # m/s floor keeps ratios sane

    def fit(self, table: pd.DataFrame):
        X, E = table[self.features].to_numpy(), table[OUTPUTS].to_numpy()
        self.scale_models_ = self._fit_scales(X, E)
        # Standardize each training profile with scales from models that never saw its year.
        scale_oof = np.zeros_like(E)
        years = table.year.to_numpy()
        for y in np.unique(years):
            hold = years == y
            scale_oof[hold] = self._predict_scales(self._fit_scales(X[~hold], E[~hold]), X[hold])
        self.bank_ = E / scale_oof
        self.bank_lead_ = table.lead_h.to_numpy()
        self.leads_ = np.unique(self.bank_lead_)
        return self

    def scales(self, table: pd.DataFrame) -> np.ndarray:
        return self._predict_scales(self.scale_models_, table[self.features].to_numpy())

    def sample(self, table: pd.DataFrame, n: int, rng=None) -> np.ndarray:
        """Error profiles for each row of `table`: array (rows, n, 16)."""
        rng = rng or np.random.default_rng(self.seed)
        scale = self.scales(table)
        nearest = self.leads_[np.abs(table.lead_h.to_numpy()[:, None] - self.leads_[None]).argmin(axis=1)]
        out = np.empty((len(table), n, len(OUTPUTS)))
        for lead in np.unique(nearest):
            rows = np.where(nearest == lead)[0]
            pool = self.bank_[self.bank_lead_ == lead]
            out[rows] = pool[rng.integers(0, len(pool), size=(len(rows), n))] * scale[rows][:, None, :]
        return out
