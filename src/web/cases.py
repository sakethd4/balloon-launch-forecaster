"""Build the data package the 3D viewer needs for one launch: "balloon launched HERE at THIS time".

Everything the page draws comes from this dict (sent as JSON by scripts/serve.py or written by
scripts/export_web_case.py):
  - the nominal flight and ~100 sampled flights (the learned wind-error model's draws), flown together through the
    4D GFS forecast with the vectorised simulator,
  - their landing points and the 50% / 90% landing-zone radii,
  - a gridded snapshot of the forecast around the launch (wind, temperature, humidity at every 500 m), which the page
    uses to move wind particles, colour them by temperature and build clouds where the air is humid.
"""
import threading
from collections import OrderedDict
from datetime import date

import joblib
import numpy as np
import pandas as pd
import xarray as xr

from src.baselines.ensemble4d import columns_at, simulate_ensemble_4d, wind_from_columns
from src.baselines.trajectory4d import WindField4D
from src.ingest import gefs, gfs
from src.paths import PROCESSED_DIR
from src.uncertainty import wind_error as we
from src.uncertainty.features import situation_features
from src.web import region, terrain

KM_PER_DEG = 111.195
GRID_ALTS_M = np.arange(0.0, 14001.0, 500.0)
THIN = 4                                            # keep every 4th time step of the paths (60 s)


def _round(a, nd=5):
    return np.round(a, nd).tolist()


class Run:
    """One archived forecast run: GFS winds/temperature/humidity and GEFS spread, loaded once."""

    def __init__(self, day: date):
        with xr.open_dataset(gfs.output_path(day, 12)) as g, xr.open_dataset(gefs.output_path(day)) as s:
            self.gfs, self.gefs = g.load(), s.load()
        self.field = WindField4D.from_dataset(self.gfs)
        self.day = day


def grid_snapshot(field: WindField4D, lat, lon, lead_h, ground_m, half_deg=2.0, step=0.5):
    """Forecast around the launch at one time: u, v (m/s), temperature (deg C), relative humidity (%) on
    [altitude][lat][lon] at every 500 m. Below-ground levels are filled from the lowest level above ground."""
    lats = np.round(lat + np.arange(-half_deg, half_deg + 1e-9, step), 4)
    lons = np.round(lon + np.arange(-half_deg, half_deg + 1e-9, step), 4)
    la, lo = np.meshgrid(lats, lons, indexing="ij")
    la, lo = la.ravel(), lo.ravel()
    cols = columns_at(field, la, lo, lead_h)
    gh = cols["gh"]
    under = gh <= ground_m + 1.0
    first = np.argmax(~under, axis=0)
    idx = np.arange(gh.shape[1])
    out = {k: [] for k in ("u", "v", "t", "rh")}
    ghc = np.maximum.accumulate(np.where(under, ground_m + 1e-3, gh), axis=0)     # (level, N), rising
    for a in GRID_ALTS_M:
        alt = np.full(len(la), max(a, ground_m))
        u, v = wind_from_columns(cols, alt, ground_m)
        j = np.clip((ghc <= alt).sum(axis=0) - 1, 0, ghc.shape[0] - 2)
        w = np.clip((alt - ghc[j, idx]) / np.maximum(ghc[j + 1, idx] - ghc[j, idx], 1e-9), 0, 1)
        for name, key in (("t", "temp_k"), ("rh", "rh_pct")):
            val = cols[key].copy()
            val[under] = np.take_along_axis(val, first[None], 0).repeat(val.shape[0], axis=0)[under]
            x = val[j, idx] * (1 - w) + val[j + 1, idx] * w
            out[name].append(x - 273.15 if name == "t" else x)
        out["u"].append(u); out["v"].append(v)
    shape = (len(GRID_ALTS_M), len(lats), len(lons))
    return dict(lat=lats.tolist(), lon=lons.tolist(), alt_m=GRID_ALTS_M.tolist(),
                u=np.round(np.array(out["u"]).reshape(shape), 1).tolist(),
                v=np.round(np.array(out["v"]).reshape(shape), 1).tolist(),
                t=np.round(np.array(out["t"]).reshape(shape), 1).tolist(),
                rh=np.round(np.clip(np.array(out["rh"]).reshape(shape), 0, 100), 0).astype(int).tolist())


class CaseBuilder:
    """Builds launch cases on demand. Thread-safe; keeps recent runs and recent cases in memory."""

    def __init__(self, max_runs=6, max_cases=64):
        self.model = joblib.load(PROCESSED_DIR / "wind_error_full.joblib")
        self._runs, self._cases = OrderedDict(), OrderedDict()
        self._max_runs, self._max_cases = max_runs, max_cases
        self._lock = threading.Lock()

    def run(self, day: date) -> Run:
        with self._lock:
            if day in self._runs:
                self._runs.move_to_end(day)
                return self._runs[day]
        r = Run(day)
        with self._lock:
            self._runs[day] = r
            while len(self._runs) > self._max_runs:
                self._runs.popitem(last=False)
        return r

    def available_runs(self, count=30):
        days = []
        for f in sorted((PROCESSED_DIR / "gfs").glob("gfs_0p50_v2_*_t12z.nc"), reverse=True):
            d = f.name.split("_")[3]
            day = date(int(d[:4]), int(d[4:6]), int(d[6:]))
            if gefs.output_path(day).exists():
                days.append(day)
            if len(days) >= count:
                break
        return days

    def build(self, day: date, lat: float, lon: float, lead_h: float, n: int = 100, ground_m=None) -> dict:
        key = (day, round(lat, 4), round(lon, 4), round(lead_h, 2), n, ground_m)
        with self._lock:
            if key in self._cases:
                self._cases.move_to_end(key)
                return self._cases[key]
        case = self._build(day, lat, lon, lead_h, n, ground_m)
        with self._lock:
            self._cases[key] = case
            while len(self._cases) > self._max_cases:
                self._cases.popitem(last=False)
        return case

    def _build(self, day, lat, lon, lead_h, n, ground_m):
        run = self.run(day)
        ground = float(terrain.elevation_m(lat, lon)) if ground_m is None else float(ground_m)
        valid = pd.Timestamp(day, tz="UTC") + pd.Timedelta(hours=12 + lead_h)
        spread, wind = situation_features(run.gefs, run.gfs, lat, lon, lead_h)
        situation = pd.DataFrame([dict(lead_h=lead_h, month=valid.month, gfs_wind_ms=float(wind[0]), spread_ms=float(spread[0]))])
        errors = self.model.sample(situation, n, np.random.default_rng(0))[0]
        k = len(we.LEVELS_HPA)
        sim = simulate_ensemble_4d(run.field, lat, lon, lead_h, errors=np.vstack([np.zeros((1, 2 * k)), errors]),
                                   levels_hpa=we.LEVELS_HPA, ground_m=ground)
        t_s, alt = sim["t_s"], sim["alt_m"]
        idx = np.unique(np.append(np.arange(0, len(t_s), THIN), len(t_s) - 1))
        la, lo = sim["lat"], sim["lon"]
        dx = (lo[1:, -1] - lo[0, -1]) * KM_PER_DEG * np.cos(np.radians(la[0, -1]))
        dy = (la[1:, -1] - la[0, -1]) * KM_PER_DEG
        r = np.hypot(dx, dy)
        mid_lead = lead_h + t_s[-1] / 7200.0
        return dict(
            id=f"forecast_{day}_{lat:.4f}_{lon:.4f}_lead{lead_h:03.0f}", kind="forecast", title="Forecast flight",
            subtitle=f"GFS run {day} 12Z",
            meta=dict(launch=dict(lat=float(lat), lon=float(lon), ground_m=round(ground, 1)),
                      launch_time_utc=f"{valid:%Y-%m-%dT%H:%M:%SZ}", init_utc=f"{day}T12:00:00Z", lead_h=float(lead_h),
                      spread_ms=round(float(spread[0]), 2), gfs_wind_ms=round(float(wind[0]), 1),
                      r50_km=round(float(np.quantile(r, 0.5)), 2), r90_km=round(float(np.quantile(r, 0.9)), 2), n=int(n),
                      endpoint_label="landing", burst_time_s=float(t_s[sim["burst_index"]]),
                      flight_time_s=float(t_s[-1]), left_domain_nominal=bool(sim["left_domain"][0]),
                      left_domain_count=int(sim["left_domain"][1:].sum()),
                      notes=["Our balloon: 5.8 m/s climb to 13.7 km, 15 m/s parachute descent.",
                             "Dots: sampled wind-error flights from the learned model (click one to follow it).",
                             "Wind motion is the forecast at launch time; the small-scale swirl is added for display."]),
            t_s=_round(t_s[idx], 1), alt_m=np.round(alt[idx]).tolist(),
            nominal=dict(lat=_round(la[0, idx]), lon=_round(lo[0, idx])),
            ensemble=dict(lat=[_round(row[idx]) for row in la[1:]], lon=[_round(row[idx]) for row in lo[1:]]),
            endpoints=np.round(np.column_stack([la[1:, -1], lo[1:, -1]]), 5).tolist(),
            left_domain=sim["left_domain"][1:].tolist(),
            grid=grid_snapshot(run.field, lat, lon, mid_lead, ground))
