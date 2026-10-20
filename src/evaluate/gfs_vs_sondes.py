"""Compare GFS forecasts with real radiosonde soundings.

For a GFS run started at 12Z on day D, the forecast for lead time L describes the
atmosphere at 12Z + L hours. Radiosondes are released at 00Z and 12Z, so leads that are
multiples of 12 h line up with a real sounding at the same moment. For each such pair we:

  1. Compare forecast and measured winds on the standard pressure levels.
  2. Fly the baseline balloon simulator through BOTH wind profiles from the station and
     measure how far apart the two landing points are. This "landing error" is the
     number the project cares about, since it says how much a forecast error moves the
     predicted landing zone.

Caveats: the soundings are at four stations 270+ km from Austin, and a sounding is a
snapshot at launch (the real balloon drifts during its ascent), so this checks the
pipeline and gives a first accuracy estimate. It is not the final Austin answer.
"""
from datetime import date, timedelta

import numpy as np
import pandas as pd
import xarray as xr

from src.baselines.trajectory import distance_km, simulate_flight
from src.ingest import gfs, igra

BURST_ALT_M = 13716.0
ASCENT_MS, DESCENT_MS = 5.833, 15.0


def gfs_profile(gh_m, u, v, u10, v10, elev_m):
    """Wind profile above ground from forecast values on pressure levels.

    High-elevation stations have pressure levels below ground (1000 hPa at Midland), where
    the model just extrapolates. We drop those and start the profile at the station's
    elevation using the 10 m wind. Returns strictly increasing altitude with its winds.
    """
    gh_m, u, v = (np.asarray(a, dtype=float) for a in (gh_m, u, v))
    order = np.argsort(gh_m)
    gh_m, u, v = gh_m[order], u[order], v[order]
    keep = gh_m > elev_m + 1.0
    alt = np.concatenate([[elev_m], gh_m[keep]])
    uu = np.concatenate([[u10], u[keep]])
    vv = np.concatenate([[v10], v[keep]])
    strictly_up = np.concatenate([[True], np.diff(alt) > 0])
    return alt[strictly_up], uu[strictly_up], vv[strictly_up]


def sounding_profile(snd: pd.DataFrame):
    """Measured wind profile (altitude, u, v), or None if it does not reach the ceiling."""
    s = snd.dropna(subset=["gph_m", "u_ms", "v_ms"]).sort_values("gph_m").drop_duplicates("gph_m")
    if len(s) < 10 or s.gph_m.max() < BURST_ALT_M:
        return None
    return s.gph_m.to_numpy(), s.u_ms.to_numpy(), s.v_ms.to_numpy()


def _fly(lat, lon, profile, elev_m):
    alt, u, v = profile
    return simulate_flight(lat, lon, alt, u, v, ascent_rate_ms=ASCENT_MS, descent_rate_ms=DESCENT_MS,
                           burst_altitude_m=BURST_ALT_M, launch_alt_m=elev_m)


def run(start: date, end: date, stations=("FWD", "CRP", "DRT", "MAF"), lead_step_h: int = 12,
        gfs_dir=None, cycle: int = 12):
    """Compare every available GFS run in [start, end] with the matching soundings.

    Returns (levels, flights): wind errors per pressure level, and landing errors per flight.
    """
    last_valid = pd.Timestamp(end) + pd.Timedelta(days=6)
    soundings = {}
    for st in stations:
        df = igra.parse(igra.download(igra.STATION_INFO[st]["id"], "por"),
                        start=pd.Timestamp(start), end=last_valid)
        soundings[st] = {t: g for t, g in df.groupby("launch_time")}

    level_rows, flight_rows = [], []
    day = start
    while day <= end:
        path = gfs.output_path(day, cycle, out_dir=gfs_dir)
        if path.exists():
            with xr.open_dataset(path) as ds:
                ds = ds.load()
            init = pd.Timestamp(year=day.year, month=day.month, day=day.day, hour=cycle, tz="UTC")
            for st in stations:
                info = igra.STATION_INFO[st]
                col = ds.interp(latitude=info["lat"], longitude=info["lon"])  # bilinear
                for lead in range(0, int(ds.lead_h.max()) + 1, lead_step_h):
                    snd = soundings[st].get(init + pd.Timedelta(hours=lead))
                    if snd is None:
                        continue
                    c = col.sel(lead_h=lead)
                    # 1. wind error on the pressure levels the sounding also reports
                    for lev in c.isobaricInhPa.values:
                        m = snd[(snd.pressure_hpa - lev).abs() < 0.05].dropna(subset=["u_ms", "v_ms"])
                        if m.empty:
                            continue
                        p = c.sel(isobaricInhPa=lev)
                        level_rows.append(dict(
                            station=st, init=init, lead_h=lead, level_hpa=float(lev),
                            du=float(p.u) - float(m.u_ms.iloc[0]), dv=float(p.v) - float(m.v_ms.iloc[0]),
                            obs_speed=float(np.hypot(m.u_ms.iloc[0], m.v_ms.iloc[0]))))
                    # 2. landing error: same simulated flight through forecast vs measured winds
                    obs = sounding_profile(snd)
                    if obs is None:
                        continue
                    fc = gfs_profile(c.gh.values, c.u.values, c.v.values, float(c.u10), float(c.v10),
                                     info["elev_m"])
                    t_obs, t_fc = (_fly(info["lat"], info["lon"], p, info["elev_m"]) for p in (obs, fc))
                    flight_rows.append(dict(
                        station=st, init=init, lead_h=lead,
                        landing_error_km=distance_km(*t_obs.landing, *t_fc.landing),
                        obs_drift_km=distance_km(info["lat"], info["lon"], *t_obs.landing)))
        day += timedelta(days=1)
        if (day - start).days % 100 == 0:
            print(f"  ...{day} done ({len(flight_rows)} flights so far)", flush=True)
    return pd.DataFrame(level_rows), pd.DataFrame(flight_rows)


SEASONS = {12: "DJF", 1: "DJF", 2: "DJF", 3: "MAM", 4: "MAM", 5: "MAM",
           6: "JJA", 7: "JJA", 8: "JJA", 9: "SON", 10: "SON", 11: "SON"}


def summarize_by_season(levels: pd.DataFrame, flights: pd.DataFrame, leads=(24, 72, 120)):
    """Landing error and 300 hPa wind error by season (DJF = winter) at a few lead times."""
    f = flights[flights.lead_h.isin(leads)].assign(season=lambda d: d.init.dt.month.map(SEASONS))
    land = f.pivot_table(index="season", columns="lead_h", values="landing_error_km",
                         aggfunc="median").round(1)
    land.columns = [f"median landing error km @{c}h" for c in land.columns]
    drift = f.groupby("season").obs_drift_km.median().round(1).rename("median drift km (all leads)")
    lv = levels[(levels.level_hpa == 300.0) & levels.lead_h.isin(leads)].copy()
    lv["season"] = lv.init.dt.month.map(SEASONS)
    lv["sq"] = lv.du ** 2 + lv.dv ** 2
    wind = lv.pivot_table(index="season", columns="lead_h", values="sq", aggfunc="mean").pow(0.5).round(1)
    wind.columns = [f"wind RMSE 300 hPa m/s @{c}h" for c in wind.columns]
    return pd.concat([land, drift, wind], axis=1).reindex(["DJF", "MAM", "JJA", "SON"])


def summarize(levels: pd.DataFrame, flights: pd.DataFrame):
    """Tables of wind error (RMSE of the vector error, m/s) and landing error (km) by lead."""
    levels = levels.assign(sq=levels.du ** 2 + levels.dv ** 2)
    wind = (levels[levels.level_hpa.isin([500.0, 300.0, 200.0])]
            .groupby(["lead_h", "level_hpa"]).sq.mean().pow(0.5).unstack().round(2))
    wind.columns = [f"wind RMSE {int(c)} hPa" for c in wind.columns]
    wind.insert(0, "n pairs", levels[levels.level_hpa == 500.0].groupby("lead_h").size())
    land = flights.groupby("lead_h").agg(
        n_flights=("landing_error_km", "size"),
        median_landing_error_km=("landing_error_km", "median"),
        p90_landing_error_km=("landing_error_km", lambda x: x.quantile(0.9)),
        median_obs_drift_km=("obs_drift_km", "median")).round(1)
    return wind, land
