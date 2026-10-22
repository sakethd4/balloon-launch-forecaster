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
- Wind uses curved, soft air ribbons: 40-240 m long and 2.5-4.5 m wide in balloon cam; map views use 120-600 m by 12-20 m ribbons, transported by forecast winds.
  Dimensions never grow with camera distance. Removed the expanding coloured haze puffs and bright particle heads.
  Wind fades from 35 to 70 km camera-to-balloon range in orbit/chase/top views and fully stops beyond that;
  balloon cam keeps its nearby air field. Display turbulence and ribbon curvature are illustrative.
- Clouds intersect a curved altitude volume, clip to the forecast domain with soft edges, and use stable ray samples.
  Humidity controls billow coverage; exact cloud shapes remain illustrative. Clouds render from above and below,
  with domain-warped, differently rotated/scaled detail and slowly evolving non-periodic weather-scale variation.
  In orbit/chase/top views clouds fade from 65 to 120 km camera-to-balloon range and fully stop beyond that,
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

Checks: `node --test tests/viewer.test.mjs tests/viewer-render.test.mjs` (15 passing checks including terrain continuity/retries, imagery throttling, follow controls, camera transforms,
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
out; wind in orbit/top at 5-10 km and beyond 70 km; cloud detail from balloon cam and beyond 120 km in map modes;
balloon cam looking down near launch and aloft; follow a dot and close its drawer; drag below exaggerated terrain.

Follow/terrain maintenance (2026-10-22):

- Landing dots use terrain-clamped Entity points, not unsupported `heightReference` on raw PointPrimitives.
  Landing/launch markers and selected landing rings draw without terrain depth clipping at every zoom.
- Selecting another balloon previews that flight's complete route until the drawer closes or Follow is pressed;
  the active followed route no longer overwrites the preview every frame. Follow closes the drawer. Stop following
  is integrated beside the camera modes and returns to Orbit; clicking the followed balloon also offers Stop following.
  The separate following bubble and top-left title were removed. Left cards are anchored 26 px above the bottom.
- Clouds retain more density in humid forecast layers: weather variation modulates shape without suppressing nearly
  the entire humidity signal. Clouds remain absent where the forecast is dry. Wider map-view wind keeps its geometry
  fixed during zoom and fades spatially around the balloon, rather than vanishing when the camera leaves the air field.
  Balloon-cam wind is unchanged.
- Terrain now uses the source Web-Mercator tiling with border-aware sampling and genuine elevations at coarse levels.
  Incomplete or failed elevation tiles retain the parent surface and retry; they never become zero-filled terrain patches.
  Six heightmap loads may run concurrently, with 300 generated heightmaps and 300 globe tiles retained in memory;
  sibling/ancestor preloading helps pan/zoom. Failed decoded DEMs are evicted so they can retry. Imagery preserves Cesium's
  synchronous throttle signal. Relief shading uses a normal/light dot product instead of per-pixel trigonometry.
- Same free Esri imagery and AWS elevation sources; no account or paid service added. Tile detail will still stream and
  refine as you move, especially on first visits or slow connections. GPU terrain appearance remains unverified because
  the browser tool reports Edge unavailable. Tests cover synthetic terrain edges and refinement, retry/throttling,
  selection transitions, follow button behavior, and the wider atmosphere visibility limits.
