"""Fly a whole ensemble of balloons: the physics simulator with the learned wind uncertainty.

One launch gives one nominal flight through the forecast. Here the wind-error model draws `n`
plausible error profiles; each is subtracted from the forecast winds (the model's error is
forecast MINUS truth, so truth = forecast - error) and the balloon is flown through that alternative
wind field with the 4D simulator. The landing points form a sampled probability distribution:
"where could this balloon come down?", from which landing-zone radii and the probability of
landing within some distance of a target follow.

Limits (also in CLAUDE.md): each sample is one wind-error PROFILE applied everywhere and for the
whole flight (the model has no spatial or temporal structure yet), and the mean error is zero.
"""
from dataclasses import dataclass

import numpy as np
import pandas as pd

from src.baselines.trajectory4d import Flight, WindField4D, drift_along_track, simulate_flight_4d
from src.uncertainty import wind_error as we

KM_PER_DEG = 111.195


@dataclass
class Ensemble:
    nominal: Flight                  # the flight through the unperturbed forecast
    landings: np.ndarray             # (n, 2) landing (lat, lon) of each sampled flight
    paths: list                      # first `keep_paths` sampled Flights (for drawing)

    def displacement_km(self) -> np.ndarray:
        """(n, 2) east/north offset of each landing from the nominal landing, km."""
        lat0, lon0 = self.nominal.landing
        return np.column_stack([(self.landings[:, 1] - lon0) * KM_PER_DEG * np.cos(np.radians(lat0)),
                                (self.landings[:, 0] - lat0) * KM_PER_DEG])

    def radius_km(self, prob: float) -> float:
        """Radius around the nominal landing that contains `prob` of the sampled landings."""
        return float(np.quantile(np.linalg.norm(self.displacement_km(), axis=1), prob))

    def prob_within(self, lat: float, lon: float, radius_km: float) -> float:
        """Share of sampled landings within `radius_km` of a point (e.g. a landing area you want)."""
        dx = (self.landings[:, 1] - lon) * KM_PER_DEG * np.cos(np.radians(lat))
        dy = (self.landings[:, 0] - lat) * KM_PER_DEG
        return float(np.mean(np.hypot(dx, dy) <= radius_km))


def fly_ensemble(field: WindField4D, model: we.WindErrorModel, situation: dict, launch_lat: float,
                 launch_lon: float, launch_lead_h: float, n: int = 100, rng=None, keep_paths: int = 0,
                 **flight_kwargs) -> Ensemble:
    """`situation` holds the model's features for this launch (lead_h, month, gfs_wind_ms, spread_ms).

    `flight_kwargs` go to simulate_flight_4d (ascent_rate_ms, descent_rate_ms, burst_altitude_m, ground_m ...).
    """
    rng = rng or np.random.default_rng(0)
    errors = model.sample(pd.DataFrame([situation]), n, rng)[0]       # (n, 16)
    k = len(we.LEVELS_HPA)
    fly = lambda f: simulate_flight_4d(f, launch_lat, launch_lon, launch_lead_h, **flight_kwargs)
    nominal = fly(field)
    flights = [fly(field.with_column_error(we.LEVELS_HPA, -e[:k], -e[k:])) for e in errors]
    return Ensemble(nominal, np.array([f.landing for f in flights]), flights[:keep_paths])


def fly_ensemble_along_track(field: WindField4D, model: we.WindErrorModel, situation: dict, start_lat: float,
                             start_lon: float, start_lead_h: float, elapsed_s, alt_m, ground_m: float = 0.0,
                             n: int = 100, rng=None):
    """Like `fly_ensemble`, but the balloon follows a PRESCRIBED altitude history (e.g. a real flight's),
    so the spread of the paths comes from the winds alone. Returns (nominal, paths): nominal is (T, 2)
    lat/lon, paths is (n, T, 2), all on the `elapsed_s` time grid."""
    rng = rng or np.random.default_rng(0)
    errors = model.sample(pd.DataFrame([situation]), n, rng)[0]
    k = len(we.LEVELS_HPA)

    def fly(f):
        lat, lon = drift_along_track(f, start_lat, start_lon, start_lead_h, elapsed_s, alt_m, ground_m=ground_m)
        return np.column_stack([lat, lon])

    return fly(field), np.stack([fly(field.with_column_error(we.LEVELS_HPA, -e[:k], -e[k:])) for e in errors])
