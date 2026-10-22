# Launch Planner (3D web app)

Run it (needs the GFS/GEFS files in `~/balloon-data` and `wind_error_full.joblib` from `scripts.wind_error_model`):

    python -u -W ignore -m scripts.serve        # then open http://localhost:8000

The server (standard library only) serves this folder and simulates a launch on request: `/api/case?lat=&lon=&lead=&init=&n=`
flies 100 sampled balloons through the archived GFS forecast with the vectorised 4D simulator (about 0.6 s) and returns the
flights plus a gridded snapshot of wind, temperature and humidity around the launch. The page needs internet for the map
imagery, the elevation tiles and the CesiumJS/Three.js libraries (all loaded from public CDNs, no keys).

What you can do: pick any launch point inside the bright area of the map, pick the launch hour, watch the flight, click a dot
(a possible flight) to see its landing and follow it, and ride the balloon (Balloon cam: drag to look around, scroll to zoom).

Modules (`js/`): `earth` (terrain, imagery, bounds), `flight` (path, dots, rings), `overlay` (Three.js layer locked to Cesium's camera),
`balloon`, `wind`, `clouds`, `birds` (the 3D scene), `cameras`, `ui`, `main`.

URL options for testing: `?lat=&lon=&lead=&cam=orbit|chase|balloon|top&t=0..1&speed=&play=1&select=&follow=&q=low|mid|high&clouds=0.35&adapt=1`.

Imagery: Esri World Imagery. Elevation: AWS Terrain Tiles. Attribution is shown in the page.

Rendering fixes (2026-10-22):

- The illustrated balloon uses metre units and stays anchored to the simulated payload position at every zoom.
  At map scale it becomes too small to see; the flight dots and routes provide map context.
- Possible-flight dots have smaller, subdued markers with terrain depth testing, avoiding the bright launch-site pileup.
- Wind uses alpha compositing, volume-distributed particles and altitude fades instead of clamping particles onto a ground sheet.
- Clouds intersect a curved altitude volume, clip to the forecast domain with soft edges, and use stable ray samples.
  Humidity controls billow coverage; exact cloud shapes remain illustrative. Clouds render from above and below,
  including at the maximum camera height. They remain an overlay without access to Cesium's terrain depth texture.
- Following a possible flight preserves its complete projected route even when the selection drawer closes.
- All camera modes enforce 2 m clearance above the currently loaded terrain, including terrain exaggeration.
  Terrain accuracy depends on the elevation tiles that have loaded.
- Full visual quality is the default. `?adapt=1` opts into the previous automatic resolution/particle reductions.
  Optimizations reuse interpolation scratch buffers, avoid rebuilding paused flight geometry, throttle telemetry DOM
  updates to 10 Hz, and skip cloud ray marching outside the forecast volume.

Checks: `node --test tests/viewer.test.mjs` (flight route/visibility transitions and analytic grid interpolation),
`conda run -n balloon python -m pytest -q`, and JavaScript syntax checks.
No connected browser was available for visual QA in this session; cloud appearance and real-GPU frame rate need
verification on the laptop. Suggested checks: zoom near/far around a paused balloon; orbit/top views at 560 km;
balloon cam looking straight down near launch and aloft; follow a dot and close its drawer; drag below exaggerated terrain.
