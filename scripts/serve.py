"""Run the Launch Planner: serves the 3D viewer (web/) and simulates a launch whenever the page asks for one.

    python -u -W ignore -m scripts.serve            # then open http://localhost:8000

The page picks a launch point and time; /api/case flies the sampled balloons through the archived GFS forecast
(about half a second) and returns the data the viewer draws. Standard library only (no web framework).

  GET /api/region                                  where launches are allowed
  GET /api/runs                                    forecast runs available (latest first)
  GET /api/case?lat=&lon=&lead=&init=YYYY-MM-DD&n= one simulated launch
  GET /api/elevation?lat=&lon=                     ground height at a point
  anything else                                    static files from web/
"""
import argparse
import gzip
import json
import mimetypes
import sys
import time
import traceback
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from src.web import region, terrain
from src.web.cases import CaseBuilder

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
mimetypes.add_type("text/javascript", ".js")        # Windows can map .js to text/plain, which breaks ES modules
mimetypes.add_type("text/javascript", ".mjs")
BUILDER = None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):               # only API calls and errors are interesting
        if self.path.startswith("/api/") or (args and str(args[1]).startswith(("4", "5"))):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, obj, status=200):
        body = json.dumps(obj, separators=(",", ":")).encode()
        gz = len(body) > 4096 and "gzip" in self.headers.get("Accept-Encoding", "")
        if gz:
            body = gzip.compress(body, 5)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/api/region":
                return self.send_json(region.region_json())
            if url.path == "/api/runs":
                days = BUILDER.available_runs()
                return self.send_json(dict(runs=[d.isoformat() for d in days], default=days[0].isoformat() if days else None,
                                           **region.region_json()))
            if url.path == "/api/elevation":
                return self.send_json(dict(elevation_m=terrain.elevation_m(float(q["lat"]), float(q["lon"]))))
            if url.path == "/api/case":
                lat, lon, lead = float(q["lat"]), float(q["lon"]), float(q.get("lead", 25))
                n = int(q.get("n", 100))
                if not region.launch_allowed(lat, lon):
                    return self.send_json(dict(error="That point is outside the area the forecast covers (or too close to its edge "
                                                     "for a balloon to stay inside it)."), 400)
                if not region.LEAD_MIN_H <= lead <= region.LEAD_MAX_H or not 10 <= n <= 300:
                    return self.send_json(dict(error="launch time or sample count out of range"), 400)
                day = date.fromisoformat(q["init"]) if q.get("init") else BUILDER.available_runs(1)[0]
                t0 = time.time()
                case = BUILDER.build(day, lat, lon, lead, n, float(q["ground"]) if q.get("ground") else None)
                sys.stderr.write("  built case in %.2f s\n" % (time.time() - t0))
                return self.send_json(case)
            return self.send_json(dict(error="unknown endpoint"), 404)
        except (KeyError, ValueError) as e:
            return self.send_json(dict(error=f"bad request: {e}"), 400)
        except FileNotFoundError as e:
            return self.send_json(dict(error=f"no forecast data for that run ({e.filename})"), 404)
        except Exception as e:                       # report, never crash the server
            traceback.print_exc()
            return self.send_json(dict(error=f"server error: {e}"), 500)


def make_server(host="127.0.0.1", port=8000):
    global BUILDER
    BUILDER = BUILDER or CaseBuilder()
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    return srv


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args()
    server = make_server(args.host, args.port)
    print(f"Launch Planner running at http://{args.host}:{args.port}  (Ctrl+C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
