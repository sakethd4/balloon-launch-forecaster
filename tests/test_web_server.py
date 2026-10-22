import json
import threading
import urllib.error
import urllib.request

import pytest

from src.paths import PROCESSED_DIR
from src.web import region

HAVE_DATA = (PROCESSED_DIR / "wind_error_full.joblib").exists() and any((PROCESSED_DIR / "gfs").glob("gfs_0p50_v2_*"))


def test_launch_region_has_a_margin_inside_the_forecast_box():
    assert region.launch_allowed(30.27, -97.74)                  # Austin
    assert not region.launch_allowed(27.1, -97.7)                # too close to the southern edge
    assert not region.launch_allowed(36.0, -97.7)                # outside the box
    assert not region.launch_allowed(30.0, -92.2)


@pytest.fixture(scope="module")
def base_url():
    from scripts import serve
    srv = serve.make_server(port=0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def get(url):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


@pytest.mark.skipif(not HAVE_DATA, reason="needs the GFS/GEFS files and the trained model in ~/balloon-data")
def test_case_endpoint_returns_a_simulated_launch_and_rejects_bad_requests(base_url):
    status, runs = get(f"{base_url}/api/runs")
    assert status == 200 and runs["default"] and runs["launch"]["lat_min"] > runs["domain"]["lat_min"]
    status, c = get(f"{base_url}/api/case?lat=30.27&lon=-97.74&lead=25&n=40&init={runs['default']}")
    assert status == 200 and c["meta"]["n"] == 40 and len(c["ensemble"]["lat"]) == 40
    assert len(c["t_s"]) == len(c["alt_m"]) == len(c["nominal"]["lat"])
    assert c["meta"]["r90_km"] >= c["meta"]["r50_km"] > 0 and len(c["endpoints"]) == 40
    g = c["grid"]
    assert len(g["u"]) == len(g["alt_m"]) and len(g["u"][0]) == len(g["lat"]) and len(g["u"][0][0]) == len(g["lon"])
    assert g["t"][0][4][4] > g["t"][-1][4][4] + 40               # much colder at 14 km than at the ground
    assert get(f"{base_url}/api/case?lat=20&lon=-97.7&lead=25")[0] == 400
    assert get(f"{base_url}/api/case?lat=30.2&lon=-97.7&lead=500")[0] == 400
    assert get(f"{base_url}/api/case?lat=abc&lon=-97.7")[0] == 400
