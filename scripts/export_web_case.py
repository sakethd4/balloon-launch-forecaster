"""Export a flight case as JSON for the 3D web viewer (web/).

Two kinds of case:
  forecast : fly the learned wind-error ensemble from a launch point through one archived GFS forecast
             with the 4D simulator (our balloon: 5.833 m/s up to 13.7 km, 15 m/s down). The landing
             zone is the product.
  replay   : take one REAL archived SondeHub climb, fly the ensemble along the real altitude history
             through the GFS forecast made 11-23 h before launch, and keep the real track too, so the
             viewer can show the real balloon moving through the predicted cloud (climb only: the
             forecast is only defined up to 13.7 km). The flight is chosen AT RANDOM among 2025-2026
             climbs with 40-80 km of drift, not by how well the forecast did.

Run from the project root:
  python -u -W ignore -m scripts.export_web_case forecast --day 2026-10-18 --launch-lead 25 --lat 30.27 --lon -97.74
  python -u -W ignore -m scripts.export_web_case replay --seed 3
"""
import argparse
import json
from datetime import date
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import xarray as xr

from src.baselines.trajectory4d import WindField4D, drift_along_track
from src.evaluate import track_validation as tv
from src.ingest import gefs, gfs, sondehub
from src.paths import PROCESSED_DIR
from src.uncertainty.ensemble import KM_PER_DEG, fly_ensemble, fly_ensemble_along_track
from src.uncertainty.features import situation_features

WEB_DATA = Path(__file__).resolve().parent.parent / "web" / "data"
STEP = 4  # keep every 4th point of the sampled paths (60 s): the viewer interpolates


def load_run(day):
    with xr.open_dataset(gfs.output_path(day, 12)) as g, xr.open_dataset(gefs.output_path(day)) as s:
        g, s = g.load(), s.load()
    return g, s, WindField4D.from_dataset(g)


def thin(a, step=STEP):
    """Every `step`-th row, always keeping the last."""
    idx = np.unique(np.append(np.arange(0, len(a), step), len(a) - 1))
    return idx


def round_ll(a):
    return np.round(a, 5).tolist()


def radii_km(nominal_end, ends):
    dx = (ends[:, 1] - nominal_end[1]) * KM_PER_DEG * np.cos(np.radians(nominal_end[0]))
    dy = (ends[:, 0] - nominal_end[0]) * KM_PER_DEG
    r = np.hypot(dx, dy)
    return float(np.quantile(r, 0.5)), float(np.quantile(r, 0.9))


def winds_profile(field, lat, lon, lead_h, ground_m):
    alts = np.arange(0.0, 14001.0, 1000.0)
    uv = np.array([field.wind_at(lat, lon, a, lead_h, ground_m) for a in alts])
    return dict(alt_m=alts.tolist(), u=np.round(uv[:, 0], 2).tolist(), v=np.round(uv[:, 1], 2).tolist())


def export_forecast(args):
    g, s, field = load_run(args.day)
    spread, wind = situation_features(s, g, args.lat, args.lon, args.launch_lead)
    valid = pd.Timestamp(args.day, tz="UTC") + pd.Timedelta(hours=12 + args.launch_lead)
    situation = dict(lead_h=args.launch_lead, month=valid.month, gfs_wind_ms=float(wind[0]), spread_ms=float(spread[0]))
    model = joblib.load(PROCESSED_DIR / "wind_error_full.joblib")
    ens = fly_ensemble(field, model, situation, args.lat, args.lon, args.launch_lead, n=args.n, keep_paths=args.n,
                       rng=np.random.default_rng(0))
    nom = ens.nominal
    assert len({len(f.t_s) for f in ens.paths}) == 1 and len(ens.paths[0].t_s) == len(nom.t_s)
    r50, r90 = ens.radius_km(0.5), ens.radius_km(0.9)
    idx = thin(nom.t_s)
    return dict(
        id=args.id or f"forecast_{args.day}_lead{args.launch_lead:.0f}", kind="forecast",
        title="Forecast flight from Austin",
        subtitle=f"GFS run {args.day} 12Z, launch {valid:%Y-%m-%d %H:%MZ} ({args.launch_lead:.0f} h in)",
        meta=dict(launch=dict(lat=args.lat, lon=args.lon, alt_m=150.0), launch_time_utc=f"{valid:%Y-%m-%dT%H:%M:%SZ}",
                  init_utc=f"{args.day}T12:00:00Z", lead_h=args.launch_lead, spread_ms=round(float(spread[0]), 2),
                  gfs_wind_ms=round(float(wind[0]), 1), r50_km=round(r50, 2), r90_km=round(r90, 2), n=args.n,
                  endpoint_label="landing", burst_time_s=float(nom.t_s[nom.burst_index]),
                  notes=["Our balloon: 5.8 m/s climb to 13.7 km, 15 m/s parachute descent.",
                         "Orange dots and faint paths: sampled wind-error flights from the learned model."]),
        t_s=nom.t_s[idx].round(1).tolist(), alt_m=np.round(nom.alt_m[idx]).tolist(),
        nominal=dict(lat=round_ll(nom.lat_deg[idx]), lon=round_ll(nom.lon_deg[idx])),
        ensemble=dict(lat=[round_ll(f.lat_deg[idx]) for f in ens.paths], lon=[round_ll(f.lon_deg[idx]) for f in ens.paths]),
        endpoints=np.round(ens.landings, 5).tolist(),
        winds=winds_profile(field, args.lat, args.lon, args.launch_lead, 150.0))


def export_replay(args):
    res = pd.read_csv(PROCESSED_DIR / "eval" / "track_validation.csv")
    res["start_time"] = pd.to_datetime(res.start_time, utc=True, format="mixed")
    c = res[(res.leg == "ascent") & (res.min_lead_h == 0.0) & res.in_domain & (res.start_time >= pd.Timestamp("2025-01-01", tz="UTC"))
            & res.drift_km.between(40, 80) & (res.start_alt_m < 600)]
    row = c.sample(1, random_state=args.seed).iloc[0]
    print(f"{len(c)} candidate climbs; random pick (seed {args.seed}): {row.serial} {row.station} {row.start_time:%Y-%m-%d %H:%M}Z, "
          f"drift {row.drift_km:.0f} km", flush=True)
    t = tv.clean_flight(sondehub.load_track(sondehub.compact_path(row.serial)))
    leg = tv.ascent_leg(t)
    peak = t.loc[t.alt_m.idxmax()]
    init = tv.pick_init(peak.time - pd.Timedelta(seconds=peak.alt_m / 5.5), row.min_lead_h)
    g, s, field = load_run(init.date())
    sub, elapsed = tv.subsample(leg)
    lat0, lon0 = leg.lat.iloc[0], leg.lon.iloc[0]
    start_lead = (leg.time.iloc[0] - init).total_seconds() / 3600.0
    ground = min(sondehub.station_elev_m(row.station), float(leg.alt_m.min()))
    spread, wind = situation_features(s, g, lat0, lon0, start_lead)
    situation = dict(lead_h=start_lead, month=leg.time.iloc[0].month, gfs_wind_ms=float(wind[0]), spread_ms=float(spread[0]))
    model = joblib.load(PROCESSED_DIR / "wind_error_full.joblib")
    nominal, paths = fly_ensemble_along_track(field, model, situation, lat0, lon0, start_lead, elapsed, sub.alt_m.to_numpy(),
                                              ground_m=ground, n=args.n, rng=np.random.default_rng(0))
    r50, r90 = radii_km(nominal[-1], paths[:, -1])
    real_e, real_n = tv.local_km(leg.lat.iloc[-1], leg.lon.iloc[-1], nominal[-1, 0], nominal[-1, 1])
    idx = thin(elapsed)
    return dict(
        id=args.id or f"replay_{row.serial}", kind="replay", title=f"Real climb vs forecast ({row.station})",
        subtitle=f"Weather-service balloon {row.serial} (SondeHub), launched {leg.time.iloc[0]:%Y-%m-%d %H:%MZ}; GFS run {init:%Y-%m-%d} 12Z",
        meta=dict(launch=dict(lat=float(lat0), lon=float(lon0), alt_m=float(leg.alt_m.iloc[0])),
                  launch_time_utc=f"{leg.time.iloc[0]:%Y-%m-%dT%H:%M:%SZ}", init_utc=f"{init:%Y-%m-%dT%H:%M:%SZ}",
                  lead_h=round(start_lead, 1), spread_ms=round(float(spread[0]), 2), gfs_wind_ms=round(float(wind[0]), 1),
                  r50_km=round(r50, 2), r90_km=round(r90, 2), n=args.n, endpoint_label="end of climb (13.7 km)",
                  burst_time_s=float(elapsed[-1]),
                  real_error_km=round(float(np.hypot(real_e, real_n)), 2),
                  notes=["Climb only: the forecast covers up to 13.7 km, so the real balloon is clipped there.",
                         "The forecast paths follow this balloon's real altitude history, so only the winds differ.",
                         f"Chosen at random (seed {args.seed}) among 2025-2026 climbs with 40-80 km drift, not for how well the forecast did.",
                         "Real balloon data: SondeHub and its volunteers, CC BY-SA 2.0."]),
        t_s=np.round(elapsed[idx], 1).tolist(), alt_m=np.round(sub.alt_m.to_numpy()[idx]).tolist(),
        nominal=dict(lat=round_ll(nominal[idx, 0]), lon=round_ll(nominal[idx, 1])),
        ensemble=dict(lat=[round_ll(p[idx, 0]) for p in paths], lon=[round_ll(p[idx, 1]) for p in paths]),
        endpoints=np.round(paths[:, -1], 5).tolist(),
        winds=winds_profile(field, lat0, lon0, start_lead, ground),
        observed=dict(source=f"SondeHub {row.serial}", t_s=np.round(elapsed[idx], 1).tolist(),
                      lat=round_ll(sub.lat.to_numpy()[idx]), lon=round_ll(sub.lon.to_numpy()[idx]),
                      alt_m=np.round(sub.alt_m.to_numpy()[idx]).tolist()))


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="mode", required=True)
    f = sub.add_parser("forecast")
    f.add_argument("--day", type=date.fromisoformat, default=date(2026, 10, 18))
    f.add_argument("--launch-lead", type=float, default=25.0)
    f.add_argument("--lat", type=float, default=30.27)
    f.add_argument("--lon", type=float, default=-97.74)
    r = sub.add_parser("replay")
    r.add_argument("--seed", type=int, default=3)
    for q in (f, r):
        q.add_argument("--n", type=int, default=100)
        q.add_argument("--id")
    args = p.parse_args()
    case = export_forecast(args) if args.mode == "forecast" else export_replay(args)
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    out = WEB_DATA / f"{case['id']}.json"
    out.write_text(json.dumps(case, separators=(",", ":")))
    # the viewer's case list
    cases = []
    for fpath in sorted(WEB_DATA.glob("*.json")):
        if fpath.name != "index.json":
            d = json.loads(fpath.read_text())
            cases.append(dict(id=d["id"], file=fpath.name, title=d["title"], subtitle=d["subtitle"], kind=d["kind"]))
    (WEB_DATA / "index.json").write_text(json.dumps(cases, indent=1))
    print(f"wrote {out} ({out.stat().st_size / 1e3:.0f} KB); nominal end-point zones: 50% {case['meta']['r50_km']} km, "
          f"90% {case['meta']['r90_km']} km")
