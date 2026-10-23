# Launch Planner

From the project root:

```powershell
conda activate balloon
python -u -W ignore -m scripts.serve
```

Open http://localhost:8000 and use Ctrl+F5 after viewer changes. Keep the terminal running; Ctrl+C stops the server.
The app needs the local GFS/GEFS archives and `wind_error_full.joblib` in `~/balloon-data`. Internet is needed for
Esri imagery, AWS elevation and the pinned CesiumJS/Three.js modules. No map account/key or paid service is required.

## Viewer behavior

- Click the map or a preset to choose a launch site; choose the archived launch hour. The Python server flies 100
  sampled flights on demand (`/api/case`). Blue is the forecast route, amber the selected/followed route, and pale blue
  the travelled trail. Other possible flights are opaque coral dots with a dark edge. Landing circles summarize
  landing probability: the solid ring contains 50% of simulated landings, the dashed ring 90%.
- The bottom bar's **Hide UI / Show UI** button hides or restores panels, legend, drawer and HUD while preserving
  the clock, camera controls and transport. Left panels have fully transparent backgrounds. Drag the altitude graph
  to scrub continuously, including outside its edges; playback holds during dragging and resumes on release.
  Arrow keys on the focused graph seek 10 seconds (Shift: 60); Home/End go to launch/landing. Birds are removed.
- Click a flight or landing point to inspect it. Follow closes the drawer; Stop following is beside the camera controls.
  Selecting another flight previews its route without switching the followed balloon until Follow is pressed.
- Orbit has free globe controls. Chase uses drag to orbit the balloon and the wheel to zoom, with bounded pitch/range
  and terrain clearance. Balloon cam rides the payload, with drag to look and wheel to change field of view.
  **Top down is north-up only: drag pans horizontally and the wheel zooms; no rotation, tilt or roll.**
- The balloon renders as a native Cesium glTF model, sharing terrain depth. Its existing Three.js animation supplies
  node transforms and the cloud-distance buffer, but the duplicate is not drawn on the atmosphere canvas. Geometry
  stays at fixed 60x illustrative magnification, shrinks normally with zoom, and remains anchored to the flight position.
  It is not a life-size depiction; fill volume remains unknown. Terrain defaults to real 1x height; exaggeration is optional.
- Wind is 2,560 ribbons by default (20% fewer than the earlier 3,200), with 10% lower opacity. Forecast advection and
  smooth lifetime fades remain; decorative traveling flutter, animated curvature and pulsing heads are removed.
  Fixed metre dimensions never grow with zoom. Map wind fades at 35-70 km camera-to-balloon range; payload view retains
  its nearby wind field. Width/curvature/turbulence are illustrative, not forecast-resolved eddies.
- Cloud placement uses a local GFS forecast humidity snapshot (0.5-degree horizontal spacing, resampled every 500 m
  to 14 km, roughly +/-2 degrees around the launch). Shapes and slow evolution are procedural, not satellite imagery.
  Dry gaps may come from forecast moisture or procedural shaping; outer data/zoom edges are display limits.
- Cloud rays stop at balloon geometry and exact-width route depth strokes. Clouds behind a route do not cover its
  stroke; cloud between the camera and route attenuates it. Map cloud opacity is limited to 68%, keeping covered
  sections faintly visible; payload clouds can remain opaque. **No wide cloud cutout or path halo is used.** The route
  depth pass uses the actual 3 / 3.5 / 4 CSS-pixel strokes, with no surrounding terrain strip. Cesium terrain depth is
  still not shared with the cloud pass itself. Low-resolution cloud silhouettes need final GPU inspection.
- Landing markers clamp to terrain and draw without half-clipping. Terrain uses border-aware Web-Mercator sampling,
  parent surfaces while tiles load/retry, bounded requests and caches, plus ancestor/sibling preloading. Some progressive
  detail refinement is normal on first visits or slow networks.

## Weather UI principles applied

These are implementation choices informed by professional guidance, rather than a claim that a source endorses the
app's exact display settings:

| Guidance | Application |
| --- | --- |
| [Met Office forecast colour scales](https://weather.metoffice.gov.uk/learn-about/how-forecasts-are-made/forecast-colour-scales): consistent scales, lightness differences and accessible cool/warm hues. | Fixed blue-neutral-orange temperature scale, a fixed freezing reference, numerical Celsius ticks, and the same colour function for wind and legend, including both scale endpoints. |
| [NOAA probabilistic decision support](https://www.weather.gov/tbw/probabilistic): show the range of possible solutions and uncertainty. | Preserve ensemble flights and 50%/90% landing rings; label their solid/dashed styles and forecast/selected routes explicitly. Decorative atmosphere stays secondary to the analytical display. |
| [ECMWF forecast charts](https://www.ecmwf.int/): distinguish forecast base time, lead and valid time. | Launch controls retain initialization/lead information. Per the UI cleanup request, the extra snapshot timestamp and illustrative-effect notes are kept out of the legend; cloud provenance remains in the layer tooltip and this README. |
| [Cesium native models](https://cesium.com/learn/cesiumjs/ref-doc/Model.html): local-frame models participate in the 3D scene. | Balloon/terrain occlusion uses the globe renderer, instead of a separate canvas pretending to share terrain depth. Top view has predictable map-only navigation. |

The native model is built once with the pinned Three.js GLTFExporter. If that renderer fails, the app reports it and
falls back to the older overlay balloon; that fallback cannot share terrain depth. No credentials are involved.

## Performance and verification

Full quality is the default. `?adapt=1` opts into automatic resolution/particle reductions. Hidden weather fields skip
simulation/drawing; stationary cloud frames cache for at most 33 ms. Route depth geometry caches until flight/selection
changes. Grid interpolation reuses buffers; telemetry DOM updates at 10 Hz. Native balloon rendering avoids the unused
Three.js sky-environment regeneration. Cloud and route/balloon distance targets are reused.

URL options: `?lat=&lon=&lead=&cam=orbit|chase|balloon|top&t=0..1&speed=&play=1&select=&follow=&q=low|mid|high&clouds=0.5&adapt=1`.

Run checks:

```powershell
node --test tests/viewer.test.mjs tests/viewer-render.test.mjs tests/viewer-camera.test.mjs
conda run -n balloon python -m pytest -q
```

The optional integration checks require these pinned modules in ignored `dist/`:

```powershell
New-Item -ItemType Directory -Force dist/viewer-check | Out-Null
Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js' -OutFile 'dist/viewer-check/three.mjs'
Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/exporters/GLTFExporter.js' -OutFile 'dist/viewer-check/GLTFExporter.mjs'
Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/utils/TextureUtils.js' -OutFile 'dist/viewer-check/TextureUtils.mjs'
Invoke-WebRequest -Uri 'https://cdn.jsdelivr.net/npm/cesium@1.120.0/Build/Cesium/Cesium.js' -OutFile 'dist/viewer-check/cesium.cjs'
```

**22 viewer checks pass**, including the actual Cesium camera math, real GLB export/node synchronization, route depth
widths/pass ordering, terrain seams/retries, legend consistency and pointer-captured timeline scrubbing. JavaScript syntax checks pass. The Three.js renderer
and Cesium model drawing are stubbed, so these checks do not validate GPU shader compilation or final appearance.
The browser tool reports no available in-app browser; manual GPU inspection remains necessary. The preceding backend
suite passed 45 tests; this change does not modify the backend or forecasts.

Suggested GPU checks: near-ground Chase with hills crossing the balloon silhouette; above/below-cloud route angles
without terrain halos; payload wind without flutter; repeated Top-view drags preserving north-up/nadir; launch changes,
burst/parachute animation, and all weather layer toggles. Imagery/elevation attribution remains on the map.
