import numpy as np
import pandas as pd

from src.uncertainty import wind_error as we


def test_uniform_wind_error_moves_landing_by_wind_times_time_aloft():
    # a 1 m/s eastward error at every level acts for the whole flight: 13716 m of climb at 5.833 m/s
    # plus 13716 m of descent at 15 m/s, about 3,266 s, so ~3.27 km
    err = np.zeros(16)
    err[:8] = 1.0
    east, north = we.landing_displacement_km(err)
    assert abs(east - 13716 * (1 / 5.833 + 1 / 15) / 1000) < 0.02
    assert north == 0.0


def _toy_table(n=3000, seed=0):
    rng = np.random.default_rng(seed)
    lead = rng.choice([0, 12, 24, 48], n)
    spread = rng.uniform(1, 6, n)
    scale = 0.5 * spread                              # error size really depends on spread
    d = {c: rng.normal(0, 1, n) * scale for c in we.OUTPUTS}
    return pd.DataFrame({**d, "lead_h": lead, "month": 6, "gfs_wind_ms": 20.0, "spread_ms": spread,
                         "year": rng.choice([2021, 2022, 2023, 2024], n)})


def test_model_learns_that_spread_sets_the_error_size_and_samples_have_the_right_shape():
    t = _toy_table()
    m = we.WindErrorModel(["lead_h", "spread_ms"], max_iter=60).fit(t)
    probe = pd.DataFrame({"lead_h": [12, 12], "spread_ms": [1.5, 5.5]})
    s = m.sample(probe, 400, np.random.default_rng(0))
    assert s.shape == (2, 400, 16)
    assert s[1].std() > 2.0 * s[0].std()               # more spread -> wider error samples
    assert abs(s.mean()) < 0.3                         # centred on zero
