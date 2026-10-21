"""Validate the 4D simulator against REAL balloon tracks (SondeHub).

Each real flight is cut into the two phases our balloon flies: the climb to 13.7 km and the
descent from 13.7 km to the ground. For each phase we start a simulated balloon at the real
starting point and carry it through a GFS forecast along the REAL altitude history, then compare
where it ends up with where the real balloon was. Because the altitude history is the real one,
the difference measures the winds (forecast error) and the simulator's physics, not a guess about
how fast the balloon climbs.

Limits worth remembering:
- A track only has frames some receiver heard, so many start above the ground; we require the
  climb to start below 3 km and the descent to end below 3 km.
- The forecast only reaches 100 hPa (~16 km), which is above these legs (<= 13.7 km).
- NWS balloons are bigger than ours and climb at different rates; we use their altitude history
  but the wind physics is the same for any balloon that follows the wind.
- One 12Z GFS run is used per flight: the latest issued at least `min_lead_h` hours before the
  estimated launch, so the launch is `min_lead_h` to `min_lead_h + 24` h into that run.
"""
import numpy as np
import pandas as pd
import xarray as xr

from src.baselines.trajectory4d import WindField4D, drift_along_track
from src.ingest import gfs, igra, sondehub

TOP_M = 13716.0
SEASONS = {12: "DJF", 1: "DJF", 2: "DJF", 3: "MAM", 4: "MAM", 5: "MAM",
           6: "JJA", 7: "JJA", 8: "JJA", 9: "SON", 10: "SON", 11: "SON"}


def clean_flight(track: pd.DataFrame, split_gap_s: float = 1800.0) -> pd.DataFrame:
    """Keep the one flight in a file: the run of frames around the highest point.

    Some serial numbers hold several days of data (a reused or merged serial); a gap of more
    than `split_gap_s` starts a new segment, and we keep the segment containing the peak.
    """
    t = track.reset_index(drop=True)
    segment = (t.time.diff().dt.total_seconds().fillna(0) > split_gap_s).cumsum()
    return t[segment == segment[t.alt_m.idxmax()]].reset_index(drop=True)


def _contiguous(leg: pd.DataFrame, max_gap_s: float) -> bool:
    return len(leg) >= 5 and leg.time.diff().dt.total_seconds().iloc[1:].max() <= max_gap_s


def ascent_leg(t: pd.DataFrame, top_m: float = TOP_M, max_start_m: float = 3000.0,
               max_gap_s: float = 600.0):
    """Frames from the first frame up to the first frame at or above `top_m`, or None."""
    up = t.iloc[: t.alt_m.idxmax() + 1]
    if up.alt_m.iloc[0] > max_start_m or up.alt_m.max() < top_m:
        return None
    leg = up.iloc[: int(np.argmax(up.alt_m.to_numpy() >= top_m)) + 1]
    return leg if _contiguous(leg, max_gap_s) and (leg.time.iloc[-1] - leg.time.iloc[0]).total_seconds() > 600 else None


def descent_leg(t: pd.DataFrame, top_m: float = TOP_M, max_end_m: float = 3000.0,
                max_gap_s: float = 600.0):
    """Frames from the first descending frame at or below `top_m` to the last frame, or None."""
    down = t.iloc[t.alt_m.idxmax():]
    if down.alt_m.iloc[-1] > max_end_m or down.alt_m.max() < top_m:
        return None
    leg = down.iloc[int(np.argmax(down.alt_m.to_numpy() <= top_m)):]
    return leg if _contiguous(leg, max_gap_s) and (leg.time.iloc[-1] - leg.time.iloc[0]).total_seconds() > 180 else None


def subsample(leg: pd.DataFrame, every_s: float = 30.0):
    """Thin a 1-second track to about every `every_s` seconds, always keeping the first and last frame."""
    elapsed = (leg.time - leg.time.iloc[0]).dt.total_seconds().to_numpy()
    idx = np.unique(np.append(np.searchsorted(elapsed, np.arange(0.0, elapsed[-1], every_s)), len(leg) - 1))
    return leg.iloc[idx], elapsed[idx]


def pick_init(start_time: pd.Timestamp, min_lead_h: float) -> pd.Timestamp:
    """Latest 12Z run issued at least `min_lead_h` hours before `start_time` (the launch)."""
    cand = start_time - pd.Timedelta(hours=min_lead_h)
    init = cand.floor("D") + pd.Timedelta(hours=12)
    return init if init <= cand else init - pd.Timedelta(days=1)


def local_km(lat0, lon0, lat1, lon1):
    """(east, north) displacement in km from point 0 to point 1 (flat-earth, fine for < 500 km)."""
    return ((lon1 - lon0) * 111.195 * np.cos(np.radians(lat0)), (lat1 - lat0) * 111.195)


def evaluate_leg(field: WindField4D, leg: pd.DataFrame, init: pd.Timestamp, ground_m: float):
    """Predict where the leg ends from its start and altitude history; return the error summary."""
    sub, elapsed = subsample(leg)
    start_lead = (leg.time.iloc[0] - init).total_seconds() / 3600.0
    lat, lon = drift_along_track(field, leg.lat.iloc[0], leg.lon.iloc[0], start_lead, elapsed,
                                 sub.alt_m.to_numpy(), ground_m=ground_m)
    act_e, act_n = local_km(leg.lat.iloc[0], leg.lon.iloc[0], leg.lat.iloc[-1], leg.lon.iloc[-1])
    err_e, err_n = local_km(leg.lat.iloc[-1], leg.lon.iloc[-1], lat[-1], lon[-1])  # predicted minus actual
    drift = float(np.hypot(act_e, act_n))
    ux, uy = (act_e / drift, act_n / drift) if drift > 0.05 else (1.0, 0.0)
    return dict(lead_h=start_lead, duration_min=elapsed[-1] / 60, drift_km=drift,
                err_east_km=err_e, err_north_km=err_n, err_km=float(np.hypot(err_e, err_n)),
                err_along_km=err_e * ux + err_n * uy, err_cross_km=-err_e * uy + err_n * ux,
                start_alt_m=float(leg.alt_m.iloc[0]), end_alt_m=float(leg.alt_m.iloc[-1]))


def run(flights: pd.DataFrame, min_leads=(0.0, 24.0), gfs_dir=None):
    """Evaluate every flight in `flights` (columns station, serial, date), both legs, both lead modes.

    Returns one row per (flight, leg, lead mode). Flights are processed in date order so each GFS
    file is loaded once.
    """
    rows, cache_key, field = [], None, None
    for fl in flights.sort_values("date").itertuples():
        path = sondehub.track_path(fl.serial)
        if not path.exists():
            continue
        track = sondehub.load_track(path)
        if len(track) < 50:
            continue
        t = clean_flight(track)
        legs = {"ascent": ascent_leg(t), "descent": descent_leg(t)}
        elev = igra.STATION_INFO[fl.station]["elev_m"]
        # One forecast run per flight (both legs use it), chosen from the estimated launch time:
        # the moment of the highest frame minus the time a ~5.5 m/s climb needs to get there.
        peak = t.loc[t.alt_m.idxmax()]
        launch_est = peak.time - pd.Timedelta(seconds=peak.alt_m / 5.5)
        for leg_name, leg in legs.items():
            if leg is None:
                continue
            for min_lead in min_leads:
                init = pick_init(launch_est, min_lead)
                file = gfs.output_path(init.date(), 12, out_dir=gfs_dir)
                if not file.exists():
                    continue
                if cache_key != file:
                    with xr.open_dataset(file) as ds:
                        field = WindField4D.from_dataset(ds.load())
                    cache_key = file
                row = evaluate_leg(field, leg, init, min(elev, float(leg.alt_m.min())))
                rows.append(dict(station=fl.station, serial=fl.serial, leg=leg_name, min_lead_h=min_lead,
                                 start_time=leg.time.iloc[0], season=SEASONS[leg.time.iloc[0].month], **row))
    return pd.DataFrame(rows)
