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

- The balloon stays anchored to the simulated payload position with a fixed 60x illustrative magnification in every
  camera mode. It shrinks naturally on zoom out; it is not a life-size depiction. Chase view shows the model clearly.
  The overlay preserves the globe camera pose through Three.js matrix updates.
- Possible-flight dots have smaller, subdued markers with terrain depth testing, avoiding the bright launch-site pileup.
- Wind uses curved, soft air ribbons: 40-240 m long and 2.5-4.5 m wide, transported by forecast winds.
  Dimensions never grow with camera distance. Removed the expanding coloured haze puffs and bright particle heads.
  Wind fades from 10 to 22 km camera-to-balloon range in orbit/chase/top views and fully stops beyond that;
  balloon cam keeps its nearby air field. Display turbulence and ribbon curvature are illustrative.
- Clouds intersect a curved altitude volume, clip to the forecast domain with soft edges, and use stable ray samples.
  Humidity controls billow coverage; exact cloud shapes remain illustrative. Clouds render from above and below,
  with domain-warped, differently rotated/scaled detail and slowly evolving non-periodic weather-scale variation.
  In orbit/chase/top views clouds fade from 28 to 50 km camera-to-balloon range and fully stop beyond that,
  hiding the forecast square in wide views. They remain an overlay without access to Cesium's terrain depth texture.
- Following a possible flight preserves its complete projected route even when the selection drawer closes.
- All camera modes enforce 2 m clearance above the currently loaded terrain, including terrain exaggeration.
  Terrain accuracy depends on the elevation tiles that have loaded.
- Full visual quality is the default. `?adapt=1` opts into the previous automatic resolution/particle reductions.
  Optimizations reuse interpolation scratch buffers, avoid rebuilding paused flight geometry, throttle telemetry DOM
  updates to 10 Hz, and skip cloud ray marching outside the forecast volume. Wind now samples 3,200 ribbons rather
  than 9,000 streaks plus puffs; hidden fields skip CPU sampling and buffer uploads. Cloud textures are reused for up to
  33 ms only when the viewpoint is stationary; moving the camera renders immediately. Projection matrices update only
  when the field of view or aspect ratio changes.

Checks: `node --test tests/viewer.test.mjs tests/viewer-render.test.mjs` (9 passing checks including camera transforms,
balloon anchoring/scale, ribbon dimensions and hidden-field render/sampling skips). The four Three.js integration tests
use the app's pinned library in ignored `dist/viewer-check/three.mjs`; without it they report a skip. To obtain it:

```powershell
New-Item -ItemType Directory -Force dist/viewer-check | Out-Null
Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js' -OutFile 'dist/viewer-check/three.mjs'
```

The renderer is stubbed in these tests: they exercise real Three.js geometry/matrices, not GPU shader compilation or
visual quality. The Python suite passed all 45 tests during the preceding viewer fix; this follow-up changes only the viewer.
All viewer JavaScript files pass syntax checks. No connected browser was available for visual QA; cloud appearance and
real-GPU frame rate still need verification on the laptop. Suggested checks: Chase to inspect the balloon, then zoom
out; wind in orbit/top at 5-10 km and beyond 22 km; cloud detail from balloon cam and beyond 50 km in map modes;
balloon cam looking down near launch and aloft; follow a dot and close its drawer; drag below exaggerated terrain.
