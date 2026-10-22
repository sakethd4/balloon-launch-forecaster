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

URL options for testing: `?lat=&lon=&lead=&cam=orbit|chase|balloon|top&t=0..1&speed=&play=1&select=&follow=&q=low|mid|high&clouds=0.35&adapt=0`.

Imagery: Esri World Imagery. Elevation: AWS Terrain Tiles. Attribution is shown in the page.
