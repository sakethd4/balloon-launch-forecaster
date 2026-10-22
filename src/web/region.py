"""The area the forecasts cover, and where a launch may be placed.

Our GFS files are cropped to 27-35 N, 103-92 W. A balloon drifts tens of kilometres (up to ~100 km in a winter jet),
so launches are only accepted a margin inside that box; flights that still leave it are flagged, because outside the
box the simulator can only repeat the winds at the edge.
"""
DOMAIN = dict(lat_min=27.0, lat_max=35.0, lon_min=-103.0, lon_max=-92.0)
LAUNCH_MARGIN_DEG = 0.5
LEAD_MIN_H, LEAD_MAX_H = 3, 96            # launch times offered, hours after the forecast run starts


def launch_allowed(lat: float, lon: float) -> bool:
    d, m = DOMAIN, LAUNCH_MARGIN_DEG
    return d["lat_min"] + m <= lat <= d["lat_max"] - m and d["lon_min"] + m <= lon <= d["lon_max"] - m


def region_json() -> dict:
    d, m = DOMAIN, LAUNCH_MARGIN_DEG
    return dict(domain=d, launch=dict(lat_min=d["lat_min"] + m, lat_max=d["lat_max"] - m,
                                      lon_min=d["lon_min"] + m, lon_max=d["lon_max"] - m),
                lead_min_h=LEAD_MIN_H, lead_max_h=LEAD_MAX_H)
