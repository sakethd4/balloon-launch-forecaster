"use strict";
/* Launch Planner 3D: plays back a forecast flight (and the learned landing-zone ensemble) on a 3D globe,
   compares it with a real balloon, and tracks a live SondeHub balloon. Static page: data comes from
   data/*.json written by scripts/export_web_case.py. Needs to be served over http (python -m http.server). */
const C = Cesium;
const KM_PER_DEG = 111.195;
const TZ = "America/Chicago";                       // Austin: the launch time is shown in local time and UTC
const $ = (id) => document.getElementById(id);

const COLORS = {
  forecast: C.Color.WHITE,
  landing: C.Color.fromCssColorString("#eb6834"),
  real: C.Color.fromCssColorString("#1baf7a"),
  trail: C.Color.fromCssColorString("#86b6ef"),
};
// Altitude ramp for the path and the wind map: one blue hue, lighter = higher / faster (dark imagery)
const RAMP = ["#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"].map((h) => C.Color.fromCssColorString(h));

/* ---------- viewer, atmosphere and lighting ---------- */
const viewer = new C.Viewer("globe", {
  baseLayer: new C.ImageryLayer(new C.UrlTemplateImageryProvider({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maximumLevel: 18,
    credit: "Imagery: Esri, Maxar, Earthstar Geographics",
  })),
  baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
  animation: false, timeline: false, infoBox: false, selectionIndicator: false, fullscreenButton: false,
  shouldAnimate: false,
});
const scene = viewer.scene;
// Day and night are set by us from the real sun elevation at the launch site (see applyDaylight): Cesium's own
// lighting switches itself off when the camera is closer than ~10,000 km, which is always the case here.
scene.globe.enableLighting = false;
scene.globe.showGroundAtmosphere = true;
scene.skyAtmosphere.show = true;
scene.skyAtmosphere.brightnessShift = 0.05;
scene.sun.show = true;
scene.moon.show = true;
scene.fog.enabled = true;
scene.fog.density = 0.00018;
scene.fog.minimumBrightness = 0.06;
scene.light = new C.SunLight();
viewer.clock.clockRange = C.ClockRange.CLAMPED;

const S = {
  data: null, epoch: null, tEnd: 0, times: [], alt: [], nomPos: [], ensPos: [], objs: [], entities: [],
  balloonPos: C.Cartesian3.ZERO, balloonAlt: 0, labelText: "", real: null, view: "overview",
  bearing: 0, radius: 20000, center: null, lastText: {}, cur: { lat: 0, lon: 0, alt: 0 },
  mode: "forecast", cases: [], forecast: [], replays: [], idx: 0, cache: new Map(), loadToken: 0, firstLoad: true,
  spriteUp: true, camDist: 1e9, loadedMode: null,
};

/* ---------- small helpers ---------- */
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const cart = (lat, lon, alt) => C.Cartesian3.fromDegrees(lon, lat, alt);
const fmtTime = (s) => { s = Math.round(s); const m = Math.floor(s / 60); return `T+${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const kmBetween = (lat0, lon0, lat1, lon1) =>
  Math.hypot((lon1 - lon0) * KM_PER_DEG * Math.cos(lat0 * Math.PI / 180), (lat1 - lat0) * KM_PER_DEG);
const bearingRad = (lat0, lon0, lat1, lon1) =>
  Math.atan2((lon1 - lon0) * Math.cos(lat0 * Math.PI / 180), lat1 - lat0);
function toast(msg, ms = 6000) {
  const el = $("toast"); el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms);
}
function setText(id, text) { if (S.lastText[id] !== text) { S.lastText[id] = text; $(id).textContent = text; } }
function bracket(arr, x) {            // index i and fraction f with arr[i] <= x <= arr[i+1]
  let lo = 0, hi = arr.length - 1;
  if (x <= arr[0]) return [0, 0];
  if (x >= arr[hi]) return [hi - 1, 1];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid; else hi = mid; }
  return [lo, (x - arr[lo]) / (arr[hi] - arr[lo])];
}
const scratch = new C.Cartesian3();
function lerpPos(list, i, f, out) { return C.Cartesian3.lerp(list[i], list[i + 1], f, out || new C.Cartesian3()); }
function rampColor(frac, alpha = 1) {
  const x = clamp(frac, 0, 1) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x));
  return C.Color.lerp(RAMP[i], RAMP[i + 1], x - i, new C.Color()).withAlpha(alpha);
}
function circle(lat0, lon0, rKm, alt = 15, n = 120) {
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const a = (k / n) * 2 * Math.PI;
    pts.push(cart(lat0 + rKm * Math.cos(a) / KM_PER_DEG, lon0 + rKm * Math.sin(a) / (KM_PER_DEG * Math.cos(lat0 * Math.PI / 180)), alt));
  }
  return pts;
}
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash2 = (a, b) => Math.imul(Math.round(a * 1000) ^ 0x9E3779B1, 0x85EBCA6B) ^ Math.imul(Math.round(b * 1000) ^ 0xC2B2AE35, 0x27D4EB2F);

/* ---------- local time and the sun ---------- */
const fmtParts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric",
  minute: "2-digit", second: "2-digit", timeZoneName: "short", hourCycle: "h12" });
const fmtHour = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
const fmtDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
function local(date) { const o = {}; fmtParts.formatToParts(date).forEach((p) => { o[p.type] = p.value; }); return o; }
const localHour = (date) => Number(fmtHour.format(date)) % 24;
const localDayKey = (date) => fmtDay.format(date);
const utcText = (date) => `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
function sunElevation(date, lat, lon) {              // degrees above the horizon (NOAA-style approximation, good to ~0.5 degree)
  const r = Math.PI / 180, d = date.getTime() / 86400000 - 10957.5;      // days since J2000
  const q = (280.460 + 0.9856474 * d) % 360, g = ((357.528 + 0.9856003 * d) % 360) * r;
  const lam = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * r, eps = 23.439 * r;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam)), ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const ha = (((18.697374558 + 24.06570982441908 * d) % 24) * 15 + lon) * r - ra;
  return Math.asin(Math.sin(lat * r) * Math.sin(dec) + Math.cos(lat * r) * Math.cos(dec) * Math.cos(ha)) / r;
}

/* ---------- day and night ---------- */
function applyDaylight(date) {
  const meta = S.data.meta, el = sunElevation(date, meta.launch.lat, meta.launch.lon);
  const x = clamp((el + 6) / 18, 0, 1), k = x * x * (3 - 2 * x);               // 0 below -6 degrees (night), 1 above 12 degrees (day)
  S.sunEl = el;
  if (S.dayK !== undefined && Math.abs(k - S.dayK) < 0.02) return;
  S.dayK = k;
  const layer = viewer.imageryLayers.get(0);
  layer.brightness = 0.30 + 0.70 * k; layer.saturation = 0.55 + 0.45 * k;
  scene.skyAtmosphere.brightnessShift = -0.75 * (1 - k);
  scene.globe.atmosphereBrightnessShift = -0.75 * (1 - k);
  scene.fog.minimumBrightness = 0.02 + 0.04 * k;
  if (S.clouds) for (let i = 0; i < S.clouds.length; i++) S.clouds.get(i).brightness = 0.35 + 0.65 * k;
}

/* ---------- sprites: a mini weather balloon (latex balloon, string, payload) and the parachute it falls on ---------- */
function roundRectPath(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function drawPayload(g) {
  g.fillStyle = "#f4f2ea"; g.strokeStyle = "rgba(15,20,30,.8)"; g.lineWidth = 2.5;
  roundRectPath(g, 32, 166, 32, 26, 4); g.fill(); g.stroke();
  g.fillStyle = "#c9c6bb"; g.fillRect(34, 176, 28, 5);                 // tape
}
function spriteBalloon() {
  const cv = document.createElement("canvas"); cv.width = 96; cv.height = 200; const g = cv.getContext("2d");
  g.strokeStyle = "rgba(15,20,30,.8)"; g.lineWidth = 2; g.beginPath(); g.moveTo(48, 140); g.lineTo(48, 166); g.stroke();
  drawPayload(g);
  g.beginPath(); g.moveTo(48, 139);
  g.bezierCurveTo(40, 132, 16, 118, 16, 92); g.bezierCurveTo(16, 66, 32, 60, 48, 60);
  g.bezierCurveTo(64, 60, 80, 66, 80, 92); g.bezierCurveTo(80, 118, 56, 132, 48, 139); g.closePath();
  const grad = g.createRadialGradient(38, 82, 4, 48, 98, 48);
  grad.addColorStop(0, "#ffffff"); grad.addColorStop(0.55, "#e7edf4"); grad.addColorStop(1, "#aebdcf");
  g.fillStyle = grad; g.fill(); g.strokeStyle = "rgba(15,25,45,.65)"; g.lineWidth = 2.5; g.stroke();
  g.fillStyle = "rgba(255,255,255,.7)"; g.beginPath(); g.ellipse(37, 80, 6, 13, -0.45, 0, Math.PI * 2); g.fill();
  g.fillStyle = "rgba(15,25,45,.8)"; g.beginPath(); g.moveTo(44, 142); g.lineTo(52, 142); g.lineTo(48, 134); g.closePath(); g.fill();   // neck
  return cv.toDataURL();
}
function spriteChute() {
  const cv = document.createElement("canvas"); cv.width = 96; cv.height = 200; const g = cv.getContext("2d");
  g.strokeStyle = "rgba(15,20,30,.7)"; g.lineWidth = 1.6;
  for (const x of [14, 31, 48, 65, 82]) { g.beginPath(); g.moveTo(x, 104); g.lineTo(48, 166); g.stroke(); }   // shroud lines
  drawPayload(g);
  g.beginPath(); g.moveTo(12, 104); g.bezierCurveTo(12, 70, 30, 54, 48, 54); g.bezierCurveTo(66, 54, 84, 70, 84, 104);
  for (let k = 4; k >= 0; k--) { const x0 = 12 + (72 / 5) * (k + 1), x1 = 12 + (72 / 5) * k; g.quadraticCurveTo((x0 + x1) / 2, 114, x1, 104); }
  g.closePath();
  const grad = g.createLinearGradient(12, 54, 84, 104);
  grad.addColorStop(0, "#ffffff"); grad.addColorStop(1, "#b8c4d2");
  g.fillStyle = grad; g.fill(); g.strokeStyle = "rgba(15,25,45,.65)"; g.lineWidth = 2.5; g.stroke();
  g.strokeStyle = "rgba(15,25,45,.35)"; g.lineWidth = 1.4;
  for (const x of [30, 48, 66]) { g.beginPath(); g.moveTo(48, 54); g.quadraticCurveTo((48 + x) / 2, 78, x, 106); g.stroke(); }
  return cv.toDataURL();
}
const SPRITE = { balloon: spriteBalloon(), chute: spriteChute() };
const SPRITE_SCALE = 0.56;                                    // 96x200 px canvas drawn at 56%: the balloon body is ~36 px wide
const SPRITE_NEAR_FAR = new C.NearFarScalar(3000, 1.35, 160000, 0.72);   // a little bigger up close
const GHOST_ALPHA = 0.16;

/* ---------- scene objects (everything added per case is tracked so it can be cleared) ---------- */
function track(obj) { S.objs.push(obj); return obj; }
function addPrimitive(p) { viewer.scene.primitives.add(p); return track(p); }
function addEntity(e) { S.entities.push(viewer.entities.add(e)); return S.entities[S.entities.length - 1]; }
function clearCase() {
  for (const p of S.objs) viewer.scene.primitives.remove(p);
  for (const e of S.entities) viewer.entities.remove(e);
  S.objs = []; S.entities = []; S.real = null; S.swarm = null; S.lastText = {}; S.clouds = null; S.gust = null; S.slice = null;
}

/* ---------- case list and loading ---------- */
async function fetchCase(file) {
  if (S.cache.has(file)) return S.cache.get(file);
  const r = await fetch("data/" + file);
  if (!r.ok) throw new Error(r.status);
  const d = await r.json();
  S.cache.set(file, d);
  return d;
}

async function loadCase(file) {
  const token = ++S.loadToken;
  let d;
  try { d = await fetchCase(file); }
  catch (e) {
    toast("Could not load the case data. Serve this folder over http (python -m http.server) instead of opening the file directly.", 12000);
    return;
  }
  if (token !== S.loadToken) return;                 // a newer choice arrived while this one was loading
  const wasPlaying = viewer.clock.shouldAnimate, hadView = S.view, first = S.firstLoad;
  viewer.trackedEntity = undefined;
  clearCase();
  stopLive();
  const m = d.meta;
  S.data = d; S.times = d.t_s; S.alt = d.alt_m; S.tEnd = d.t_s[d.t_s.length - 1]; S.spriteUp = true;
  S.epoch = C.JulianDate.fromIso8601(m.launch_time_utc);
  const clock = viewer.clock;
  clock.startTime = S.epoch.clone(); clock.currentTime = S.epoch.clone();
  clock.stopTime = C.JulianDate.addSeconds(S.epoch, S.tEnd, new C.JulianDate());
  clock.multiplier = Number($("speedSelect").value); clock.shouldAnimate = wasPlaying && !first;
  setPlayLabel();

  S.nomPos = d.t_s.map((_, i) => cart(d.nominal.lat[i], d.nominal.lon[i], d.alt_m[i]));
  S.ensPos = d.ensemble.lat.map((la, k) => la.map((lat, i) => cart(lat, d.ensemble.lon[k][i], d.alt_m[i])));
  const endNom = [d.nominal.lat.at(-1), d.nominal.lon.at(-1)];
  S.bearing = bearingRad(m.launch.lat, m.launch.lon, endNom[0], endNom[1]);

  buildStatic(d);
  buildMovers(d);
  buildClouds(d);
  buildWind(d);
  S.dayK = undefined;
  applyLayers();
  fillPanel(d);
  drawChart();
  renderTimeCard();
  const all = [...S.nomPos, ...d.endpoints.map((p) => cart(p[0], p[1], 0)), cart(m.launch.lat, m.launch.lon, 0)];
  const sphere = C.BoundingSphere.fromPoints(all);
  S.center = sphere.center; S.radius = Math.max(sphere.radius, 8000);
  update(0);
  if (first || S.mode !== S.loadedMode) setView("overview", 0);          // moving between hours keeps the camera where it is
  else if (hadView === "chase") setView("chase", 0);
  S.firstLoad = false; S.loadedMode = S.mode;
}

function buildStatic(d) {
  const m = d.meta, n = S.nomPos.length;
  // The forecast path coloured by altitude, over a dark underlay so it reads on any imagery
  const colors = d.alt_m.map((a) => rampColor(a / 13716));
  addPrimitive(new C.Primitive({
    geometryInstances: new C.GeometryInstance({ geometry: new C.PolylineGeometry({
      positions: S.nomPos, width: 8, vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT,
      colors: new Array(n).fill(C.Color.BLACK.withAlpha(0.45)), colorsPerVertex: true }) }),
    appearance: new C.PolylineColorAppearance({ translucent: true }), asynchronous: false }));
  addPrimitive(new C.Primitive({
    geometryInstances: new C.GeometryInstance({ geometry: new C.PolylineGeometry({
      positions: S.nomPos, width: 4, vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT, colors, colorsPerVertex: true }) }),
    appearance: new C.PolylineColorAppearance({ translucent: true }), asynchronous: false }));

  // Sampled paths of the ensemble: one faint line each
  S.ensPrim = addPrimitive(new C.Primitive({
    geometryInstances: S.ensPos.map((pos) => new C.GeometryInstance({
      geometry: new C.PolylineGeometry({ positions: pos, width: 1.2, vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT }),
      attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.WHITE.withAlpha(0.14)) } })),
    appearance: new C.PolylineColorAppearance({ translucent: true }), asynchronous: false }));

  // Where the sampled flights end, the nominal end point, and the 50% / 90% rings
  S.endPts = addPrimitive(new C.PointPrimitiveCollection());
  for (const p of d.endpoints) S.endPts.add({ position: cart(p[0], p[1], 3), pixelSize: 6, color: COLORS.landing.withAlpha(0.9),
    outlineColor: C.Color.BLACK.withAlpha(0.5), outlineWidth: 1 });
  const [elat, elon] = [d.nominal.lat.at(-1), d.nominal.lon.at(-1)];
  S.ringEnts = [
    addEntity({ polyline: { positions: circle(elat, elon, m.r50_km), width: 2.5, material: C.Color.WHITE.withAlpha(0.95), arcType: C.ArcType.NONE } }),
    addEntity({ polyline: { positions: circle(elat, elon, m.r90_km), width: 2.5, arcType: C.ArcType.NONE,
      material: new C.PolylineDashMaterialProperty({ color: C.Color.WHITE.withAlpha(0.95), dashLength: 18 }) } }),
    addEntity({ position: cart(elat, elon, 0), ellipse: { semiMajorAxis: m.r90_km * 1000, semiMinorAxis: m.r90_km * 1000,
      material: COLORS.landing.withAlpha(0.12), height: 0 } }),
    addEntity({ position: cart(elat, elon, 0), point: { pixelSize: 10, color: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 2 },
      label: { text: `Forecast ${m.endpoint_label}`, font: "600 13px system-ui, sans-serif", fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK,
        outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45),
        pixelOffset: new C.Cartesian2(0, -22), verticalOrigin: C.VerticalOrigin.BOTTOM } }),
  ];
  addEntity({ position: cart(m.launch.lat, m.launch.lon, 0), point: { pixelSize: 10, color: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 2 },
    label: { text: "Launch", font: "600 13px system-ui, sans-serif", fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3,
      style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45),
      pixelOffset: new C.Cartesian2(14, 6), horizontalOrigin: C.HorizontalOrigin.LEFT } });

  // Forecast winds at the launch point, one arrow per kilometre of height (length = speed)
  S.windEnts = [];
  const w = d.winds, cosLat = Math.cos(m.launch.lat * Math.PI / 180), SCALE = 450;       // metres of arrow per m/s
  w.alt_m.forEach((a, i) => {
    const sp = Math.hypot(w.u[i], w.v[i]);
    const tip = cart(m.launch.lat + (w.v[i] * SCALE) / 111195, m.launch.lon + (w.u[i] * SCALE) / (111195 * cosLat), a);
    S.windEnts.push(addEntity({ polyline: { positions: [cart(m.launch.lat, m.launch.lon, a), tip], width: 9, arcType: C.ArcType.NONE,
      material: new C.PolylineArrowMaterialProperty(C.Color.WHITE.withAlpha(0.8)) } }));
    if (a % 4000 === 0 && a > 0) S.windEnts.push(addEntity({ position: tip, label: { text: `${a / 1000} km: ${sp.toFixed(0)} m/s`,
      font: "12px system-ui, sans-serif", fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
      showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45), pixelOffset: new C.Cartesian2(8, 0), horizontalOrigin: C.HorizontalOrigin.LEFT } }));
  });
}

function spriteProps(url, color) {
  return { image: url, scale: SPRITE_SCALE, color, scaleByDistance: SPRITE_NEAR_FAR, verticalOrigin: C.VerticalOrigin.CENTER,
    disableDepthTestDistance: Number.POSITIVE_INFINITY };
}

function buildMovers(d) {
  // The potential flights: the same sprite, much fainter
  S.swarm = addPrimitive(new C.BillboardCollection({ scene: viewer.scene }));
  for (let k = 0; k < S.ensPos.length; k++) S.swarm.add({ position: S.ensPos[k][0], ...spriteProps(SPRITE.balloon, C.Color.WHITE.withAlpha(GHOST_ALPHA)) });

  S.trailPositions = [];
  S.balloon = addEntity({
    position: new C.CallbackProperty(() => S.balloonPos, false),
    billboard: { ...spriteProps(new C.CallbackProperty(() => (S.spriteUp ? SPRITE.balloon : SPRITE.chute), false), COLORS.forecast) },
    label: { text: new C.CallbackProperty(() => S.labelText, false), font: "600 13px system-ui, sans-serif", fillColor: C.Color.WHITE,
      outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true,
      backgroundColor: C.Color.BLACK.withAlpha(0.45), pixelOffset: new C.Cartesian2(24, -10),
      horizontalOrigin: C.HorizontalOrigin.LEFT, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    polyline: { positions: new C.CallbackProperty(() => S.trailPositions, false), width: 6, arcType: C.ArcType.NONE,
      material: new C.PolylineGlowMaterialProperty({ glowPower: 0.3, color: COLORS.trail }) },
  });
  S.dropLine = addEntity({ polyline: { positions: new C.CallbackProperty(() => S.dropPositions || [], false), width: 1.5, arcType: C.ArcType.NONE,
    material: new C.PolylineDashMaterialProperty({ color: C.Color.WHITE.withAlpha(0.6), dashLength: 12 }) } });
  S.dropPositions = [];

  if (d.observed) {                                           // a real balloon through the same sky
    const o = d.observed;
    S.real = { t: o.t_s, pos: o.t_s.map((_, i) => cart(o.lat[i], o.lon[i], o.alt_m[i])), alt: o.alt_m, lat: o.lat, lon: o.lon, trail: [], p: C.Cartesian3.ZERO };
    S.real.ent = addEntity({
      position: new C.CallbackProperty(() => S.real.p, false),
      billboard: { ...spriteProps(SPRITE.balloon, COLORS.real) },
      label: { text: "Real balloon", font: "600 13px system-ui, sans-serif", fillColor: COLORS.real, outlineColor: C.Color.BLACK, outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45),
        pixelOffset: new C.Cartesian2(24, 14), horizontalOrigin: C.HorizontalOrigin.LEFT, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      polyline: { positions: new C.CallbackProperty(() => S.real.trail, false), width: 6, arcType: C.ArcType.NONE,
        material: new C.PolylineGlowMaterialProperty({ glowPower: 0.3, color: COLORS.real }) } });
  }
}

/* ---------- clouds: GFS total cloud cover at the launch time, puffs placed where the forecast says it is cloudy ---------- */
function buildClouds(d) {
  const cl = d.clouds;
  if (!cl || !C.CloudCollection) return;
  const lat0 = d.meta.launch.lat, lon0 = d.meta.launch.lon;
  const coll = addPrimitive(new C.CloudCollection({ noiseDetail: 16.0, noiseOffset: C.Cartesian3.ZERO }));
  const THRESH = [14, 38, 62, 84];                               // a cell shows more puffs as its cover rises
  for (let i = 0; i < cl.lat.length; i++) for (let j = 0; j < cl.lon.length; j++) {
    if (Math.abs(cl.lat[i] - lat0) > 2.0 || Math.abs(cl.lon[j] - lon0) > 2.0) continue;
    const cover = cl.tcc[i][j], rnd = mulberry32(hash2(cl.lat[i], cl.lon[j]));   // fixed per place, so clouds grow in place between hours
    for (let k = 0; k < THRESH.length; k++) {
      const dlat = (rnd() - 0.5) * 0.5, dlon = (rnd() - 0.5) * 0.5, base = 2200 + rnd() * 3600, w = 14000 + rnd() * 12000, hgt = 3000 + rnd() * 2500;
      if (cover < THRESH[k]) continue;
      coll.add({ position: cart(cl.lat[i] + dlat, cl.lon[j] + dlon, base), scale: new C.Cartesian2(w, hgt),
        maximumSize: new C.Cartesian3(46, 11, 14), slice: 0.36 + rnd() * 0.2, brightness: 1.0 });
    }
  }
  S.clouds = coll;
}

/* ---------- wind: gust streaks up close, a speed-and-direction map from afar ---------- */
function windAt(lat, lon, alt) {                                 // forecast wind (u east, v north, m/s) from the exported grid
  const g = S.data && S.data.windgrid;
  if (!g) return [0, 0];
  const fy = clamp((lat - g.lat[0]) / (g.lat[1] - g.lat[0]), 0, g.lat.length - 1.001);
  const fx = clamp((lon - g.lon[0]) / (g.lon[1] - g.lon[0]), 0, g.lon.length - 1.001);
  const fz = clamp(alt / (g.alt_m[1] - g.alt_m[0]), 0, g.alt_m.length - 1.001);
  const [z, y, x] = [Math.floor(fz), Math.floor(fy), Math.floor(fx)], [tz, ty, tx] = [fz - z, fy - y, fx - x];
  const tri = (a) => {
    const at = (zz) => (a[zz][y][x] * (1 - tx) + a[zz][y][x + 1] * tx) * (1 - ty) + (a[zz][y + 1][x] * (1 - tx) + a[zz][y + 1][x + 1] * tx) * ty;
    return at(z) * (1 - tz) + at(z + 1) * tz;
  };
  return [tri(g.u), tri(g.v)];
}

const GUST_N = 110, GUST_BOX_H = 5500, GUST_BOX_V = 2400, GUST_STREAK_S = 70;
function buildWind(d) {
  if (!d.windgrid) return;
  // Gust streaks: short white lines drifting with the forecast wind around the balloon. Their length shows the speed.
  const lines = addPrimitive(new C.PolylineCollection());
  S.gust = { lines, parts: [], alpha: -1 };
  for (let i = 0; i < GUST_N; i++) {
    const line = lines.add({ positions: [C.Cartesian3.ZERO, C.Cartesian3.ZERO], width: 1.5,
      material: C.Material.fromType("Color", { color: C.Color.WHITE.withAlpha(0.0) }), show: false });
    S.gust.parts.push({ line, lat: 0, lon: 0, alt: 0, age: 0, dx: 0, dy: 0 });
  }
  respawnGusts(true);

  // Wind map: a see-through sheet at the balloon's height, coloured by wind speed with direction arrows
  const g = d.windgrid;
  S.slice = { bucket: -1, alpha: 0 };
  S.slice.ent = addEntity({ rectangle: {
    coordinates: C.Rectangle.fromDegrees(g.lon[0], g.lat[0], g.lon.at(-1), g.lat.at(-1)),
    height: new C.CallbackProperty(() => S.balloonAlt, false),
    material: new C.ImageMaterialProperty({ image: windTexture(0), transparent: true,
      color: new C.CallbackProperty(() => C.Color.WHITE.withAlpha(S.slice.alpha), false) }) } });
}
function respawnGusts(all) {
  if (!S.gust) return;
  for (const p of S.gust.parts) {
    if (!all && Math.abs(p.dx) <= GUST_BOX_H && Math.abs(p.dy) <= GUST_BOX_H && Math.abs(p.alt - S.cur.alt) <= GUST_BOX_V) continue;
    const cosLat = Math.cos(S.cur.lat * Math.PI / 180);
    p.dx = (Math.random() * 2 - 1) * GUST_BOX_H; p.dy = (Math.random() * 2 - 1) * GUST_BOX_H;
    p.lat = S.cur.lat + p.dy / 111195; p.lon = S.cur.lon + p.dx / (111195 * cosLat);
    p.alt = Math.max(300, S.cur.alt + (Math.random() * 2 - 1) * GUST_BOX_V); p.age = 0;
  }
}
function stepGusts(simDt) {
  const G = S.gust, cosLat = Math.cos(S.cur.lat * Math.PI / 180);
  for (const p of G.parts) {
    const [u, v] = windAt(p.lat, p.lon, p.alt);
    p.lat += (v * simDt) / 111195; p.lon += (u * simDt) / (111195 * cosLat); p.age += simDt;
    p.dx = (p.lon - S.cur.lon) * 111195 * cosLat; p.dy = (p.lat - S.cur.lat) * 111195;
    const tail = cart(p.lat - (v * GUST_STREAK_S) / 111195, p.lon - (u * GUST_STREAK_S) / (111195 * cosLat), p.alt);
    p.line.positions = [tail, cart(p.lat, p.lon, p.alt)];
  }
  respawnGusts(false);
}
function setGustAlpha(a) {
  const G = S.gust; a = Math.round(a * 10) / 10;
  if (G.alpha === a) return;
  G.alpha = a;
  for (const p of G.parts) { p.line.show = a > 0; p.line.material.uniforms.color = C.Color.WHITE.withAlpha(0.5 * a); }
}
function windTexture(altM) {                                    // canvas: speed as colour, direction as arrows
  const g = S.data.windgrid, W = 256, latSpan = g.lat.at(-1) - g.lat[0], lonSpan = g.lon.at(-1) - g.lon[0];
  const H = Math.round(W * latSpan / (lonSpan * Math.cos(g.lat[Math.floor(g.lat.length / 2)] * Math.PI / 180)));
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H; const ctx = cv.getContext("2d");
  const img = ctx.createImageData(W, H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const lat = g.lat.at(-1) - (j / (H - 1)) * latSpan, lon = g.lon[0] + (i / (W - 1)) * lonSpan;
    const [u, v] = windAt(lat, lon, altM), sp = Math.hypot(u, v), c = rampColor(sp / 40);
    const edge = Math.min(i, W - 1 - i, j, H - 1 - j) / (0.14 * W), vign = clamp(edge, 0, 1);
    const k = (j * W + i) * 4;
    img.data[k] = c.red * 255; img.data[k + 1] = c.green * 255; img.data[k + 2] = c.blue * 255;
    img.data[k + 3] = 255 * (0.40 + 0.60 * clamp(sp / 24, 0, 1)) * vign;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.fillStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 1.2;
  for (let a = 1; a < g.lat.length - 1; a++) for (let b = 1; b < g.lon.length - 1; b++) {      // one arrow per grid node, direction only
    const [u, v] = windAt(g.lat[a], g.lon[b], altM);
    if (Math.hypot(u, v) < 1.5) continue;
    const cx = ((g.lon[b] - g.lon[0]) / lonSpan) * W, cy = ((g.lat.at(-1) - g.lat[a]) / latSpan) * H, ang = Math.atan2(u, v), L = 6;
    const dx = Math.sin(ang) * L, dy = -Math.cos(ang) * L;
    ctx.beginPath(); ctx.moveTo(cx - dx, cy - dy); ctx.lineTo(cx + dx, cy + dy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + dx, cy + dy);
    ctx.lineTo(cx + dx - Math.sin(ang - 0.5) * 5, cy + dy + Math.cos(ang - 0.5) * 5);
    ctx.lineTo(cx + dx - Math.sin(ang + 0.5) * 5, cy + dy + Math.cos(ang + 0.5) * 5); ctx.closePath(); ctx.fill();
  }
  return cv;
}
function updateWindFx(simDt) {
  const on = $("lyWindFx").checked, d = S.camDist;
  if (S.gust) {
    const ga = on ? clamp((30000 - d) / 14000, 0, 1) : 0;
    setGustAlpha(ga);
    if (ga > 0) stepGusts(simDt);
  }
  if (S.slice) {
    S.slice.alpha = on ? 0.75 * clamp((d - 60000) / 50000, 0, 1) : 0;
    S.slice.ent.show = S.slice.alpha > 0.01;
    const bucket = Math.round(S.balloonAlt / 500);
    if (S.slice.ent.show && bucket !== S.slice.bucket) {            // redraw only when the balloon has climbed another 500 m
      S.slice.bucket = bucket;
      S.slice.ent.rectangle.material.image = windTexture(bucket * 500);
    }
  }
  const lg = $("windLegend"); if (lg) lg.style.opacity = on ? 1 : 0.4;
}

function applyLayers() {
  const on = (id) => $(id).checked;
  if (S.ensPrim) S.ensPrim.show = on("lyEnsemble");
  if (S.swarm) S.swarm.show = on("lyEnsemble");
  if (S.endPts) S.endPts.show = on("lyEnd");
  (S.ringEnts || []).forEach((e) => { e.show = on("lyEnd"); });
  (S.windEnts || []).forEach((e) => { e.show = on("lyWinds"); });
  if (S.dropLine) S.dropLine.show = on("lyDrop");
  if (S.clouds) S.clouds.show = on("lyClouds");
}

/* ---------- per-frame update ---------- */
function update(t) {
  const d = S.data; if (!d) return;
  const [i, f] = bracket(S.times, t);
  S.balloonPos = lerpPos(S.nomPos, i, f);
  const alt = S.alt[i] + (S.alt[i + 1] - S.alt[i]) * f, dt = S.times[i + 1] - S.times[i];
  const vert = (S.alt[i + 1] - S.alt[i]) / dt;
  const lat = d.nominal.lat[i] + (d.nominal.lat[i + 1] - d.nominal.lat[i]) * f, lon = d.nominal.lon[i] + (d.nominal.lon[i + 1] - d.nominal.lon[i]) * f;
  const speed = kmBetween(d.nominal.lat[i], d.nominal.lon[i], d.nominal.lat[i + 1], d.nominal.lon[i + 1]) / dt * 3600;
  S.balloonAlt = alt; S.cur = { lat, lon, alt };
  S.labelText = `${(alt / 1000).toFixed(1)} km`;
  S.trailPositions = S.nomPos.slice(0, i + 1).concat([S.balloonPos]);
  S.dropPositions = [S.balloonPos, cart(lat, lon, 0)];
  const up = t < d.meta.burst_time_s;
  if (up !== S.spriteUp) {                                           // burst: every sprite swaps to the parachute
    S.spriteUp = up;
    if (S.swarm) for (let k = 0; k < S.swarm.length; k++) S.swarm.get(k).image = up ? SPRITE.balloon : SPRITE.chute;
  }
  if (S.swarm) for (let k = 0; k < S.ensPos.length; k++) S.swarm.get(k).position = lerpPos(S.ensPos[k], i, f, scratch);

  const done = t >= S.tEnd - 1e-6;
  setText("rTime", fmtTime(t));
  setText("rAlt", `${(alt / 1000).toFixed(1)} km`);
  setText("rAltFt", `${Math.round(alt * 3.28084).toLocaleString()} ft`);
  setText("rVert", `${vert >= 0 ? "+" : ""}${vert.toFixed(1)} m/s`);
  setText("rPhase", done ? (d.kind === "replay" ? "end of climb" : "landed") : (up ? "climbing" : "parachute descent"));
  setText("rDist", `${kmBetween(d.meta.launch.lat, d.meta.launch.lon, lat, lon).toFixed(1)} km`);
  setText("rSpeed", `${speed.toFixed(0)} km/h sideways`);
  const cur = $("chartCursor"); if (cur) { const x = 24 + (t / S.tEnd) * 288; cur.setAttribute("x1", x); cur.setAttribute("x2", x); }
  const now = new Date(Date.parse(d.meta.launch_time_utc) + t * 1000), lp = local(now);
  applyDaylight(now);
  const phase = S.sunEl > 0 ? "day" : S.sunEl > -6 ? "twilight" : "night";
  setText("timePill", `${lp.weekday} ${lp.month} ${lp.day}  ${lp.hour}:${lp.minute}:${lp.second} ${lp.dayPeriod} ${lp.timeZoneName}  ·  ${phase}`);

  if (S.real) {
    const r = S.real, [j, g] = bracket(r.t, t);
    r.p = lerpPos(r.pos, j, g);
    r.trail = r.pos.slice(0, j + 1).concat([r.p]);
    r.ent.show = !(live && live.active);
    const rl = r.lat[j] + (r.lat[j + 1] - r.lat[j]) * g, ro = r.lon[j] + (r.lon[j + 1] - r.lon[j]) * g;
    const off = kmBetween(lat, lon, rl, ro);
    const cmp = $("compare"); cmp.hidden = false;
    if (done) {
      const ends = d.endpoints, el = d.nominal.lat.at(-1), eo = d.nominal.lon.at(-1);
      const realOff = kmBetween(el, eo, r.lat.at(-1), r.lon.at(-1));
      const closer = ends.filter((p) => kmBetween(el, eo, p[0], p[1]) < realOff).length;
      cmp.textContent = `End of climb: the real balloon finished ${realOff.toFixed(1)} km from the forecast nominal end point, ` +
        `${realOff <= d.meta.r50_km ? "inside" : "outside"} the 50% ring and ${realOff <= d.meta.r90_km ? "inside" : "outside"} the 90% ring. ` +
        `${closer} of ${ends.length} sampled flights ended closer to the nominal than the real one.`;
    } else cmp.textContent = `Real balloon is ${off.toFixed(1)} km from the forecast balloon right now (same flight time).`;
  }
}

let lastFrame = performance.now();
viewer.clock.onTick.addEventListener((clock) => {
  if (!S.data) return;
  const t = clamp(C.JulianDate.secondsDifference(clock.currentTime, S.epoch), 0, S.tEnd);
  update(t);
  if (t >= S.tEnd && clock.shouldAnimate) { clock.shouldAnimate = false; setPlayLabel(); }
  // wind effects advance with simulated time (so they stay in step with the balloon); a slow drift when paused
  const now = performance.now(), frameDt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  S.camDist = C.Cartesian3.distance(viewer.camera.positionWC, S.balloonPos);
  updateWindFx(frameDt * (clock.shouldAnimate ? clock.multiplier : 25));
});

/* ---------- panel: case modes, launch-time card, readout ---------- */
function fillPanel(d) {
  const m = d.meta;
  $("caseSubtitle").textContent = d.kind === "replay" ? d.subtitle : "Austin launch, GFS forecast (12Z run), learned wind-error ensemble.";
  $("r50").textContent = m.r50_km.toFixed(1); $("r90").textContent = m.r90_km.toFixed(1);
  $("endLabel").textContent = m.endpoint_label;
  $("situation").textContent = `Forecast situation: ${m.lead_h.toFixed(0)} h lead, ensemble wind spread ${m.spread_ms.toFixed(1)} m/s, ` +
    `forecast wind ${m.gfs_wind_ms.toFixed(0)} m/s at 200-500 hPa. ${m.n} sampled flights.`;
  $("notes").textContent = m.notes.join("\n");
  $("compare").hidden = !d.observed;
  $("modeForecast").classList.toggle("active", S.mode === "forecast");
  $("modeReal").classList.toggle("active", S.mode === "real");
}

function selectIdx(idx) {
  idx = clamp(idx, 0, S.forecast.length - 1);
  if (S.mode === "forecast" && idx === S.idx && S.data && S.data.id === S.forecast[idx].id) return;
  S.idx = idx;
  loadCase(S.forecast[idx].file);
  renderTimeCard();                                                   // update the card at once; the scene follows when the file arrives
}
function renderTimeCard() {
  const real = S.mode === "real", entry = real ? S.replays[0] : S.forecast[S.idx];
  if (!entry) return;
  const when = new Date(entry.launch_utc), lp = local(when);
  $("launchBig").textContent = `${lp.weekday}, ${lp.month} ${lp.day} · ${lp.hour}:${lp.minute} ${lp.dayPeriod} ${lp.timeZoneName}`;
  const init = new Date(entry.init_utc);
  $("launchSmall").textContent = real ? `${utcText(when)} · a real weather-service launch, compared with the GFS run ${local(init).month} ${local(init).day} 12Z`
    : `${utcText(when)} · forecast hour +${entry.lead_h.toFixed(0)} after the 12Z run on ${local(init).month} ${local(init).day}`;
  $("tzNote").textContent = "local time, Austin";
  $("dateChips").style.display = real ? "none" : "";
  $("strip").style.display = real ? "none" : "";
  document.querySelector(".stepRow").style.display = real ? "none" : "";
  if (real) return;
  $("hourCount").textContent = `${S.idx + 1} of ${S.forecast.length} launch hours`;
  // date chips: one per local day that has launch hours
  const days = new Map();
  S.forecast.forEach((c, i) => { const k = localDayKey(new Date(c.launch_utc)); if (!days.has(k)) days.set(k, []); days.get(k).push(i); });
  const cur = localDayKey(when), box = $("dateChips");
  box.innerHTML = "";
  for (const [k, idxs] of days) {
    const lpd = local(new Date(S.forecast[idxs[0]].launch_utc)), b = document.createElement("button");
    b.innerHTML = `${lpd.weekday}<b>${lpd.day}</b>`; b.classList.toggle("active", k === cur); b.title = `${lpd.month} ${lpd.day}`;
    b.addEventListener("click", () => {                                // jump to the morning (9 AM local) of that day, or the nearest hour
      const best = idxs.reduce((a, i) => Math.abs(localHour(new Date(S.forecast[i].launch_utc)) - 9) < Math.abs(localHour(new Date(S.forecast[a].launch_utc)) - 9) ? i : a, idxs[0]);
      selectIdx(best);
    });
    box.appendChild(b);
  }
  if (!STRIP.built) { drawStrip(); STRIP.built = true; }
  moveStripMark();
}

const STRIP = { x0: 8, x1: 312, built: false };
function drawStrip() {
  const svg = $("strip"), t0 = Date.parse(S.forecast[0].launch_utc), t1 = Date.parse(S.forecast.at(-1).launch_utc);
  const x = (ms) => STRIP.x0 + ((ms - t0) / (t1 - t0)) * (STRIP.x1 - STRIP.x0);
  const lat = S.forecast[0].lat, lon = S.forecast[0].lon;
  let html = "";
  for (let ms = t0; ms < t1; ms += 15 * 60000) {                    // night / twilight / day bands from the sun's real elevation
    const el = sunElevation(new Date(ms + 7.5 * 60000), lat, lon), cls = el > 0 ? "day" : el > -6 ? "twilight" : "night";
    html += `<rect class="${cls}" x="${x(ms).toFixed(1)}" y="6" width="${(x(ms + 15 * 60000) - x(ms) + 0.4).toFixed(1)}" height="30"/>`;
  }
  for (let ms = Math.ceil(t0 / 3600000) * 3600000; ms <= t1; ms += 3600000) {
    const h = localHour(new Date(ms));
    if (h === 0) {
      html += `<line class="grid" x1="${x(ms).toFixed(1)}" y1="6" x2="${x(ms).toFixed(1)}" y2="36"/>`;
      html += `<text class="lbl" x="${x(ms + 12 * 3600000).toFixed(1)}" y="50" text-anchor="middle">${local(new Date(ms + 12 * 3600000)).weekday}</text>`;
    } else if (h % 6 === 0) html += `<line class="grid" x1="${x(ms).toFixed(1)}" y1="31" x2="${x(ms).toFixed(1)}" y2="36"/>`;
  }
  html += `<g><line class="mark" id="stripLine" x1="0" y1="2" x2="0" y2="40"/><circle class="dot" id="stripDot" cx="0" cy="38" r="5"/></g>`;
  svg.innerHTML = html;
  STRIP.t0 = t0; STRIP.t1 = t1;
}
function moveStripMark() {
  if (STRIP.t0 === undefined) return;
  const ms = Date.parse(S.forecast[S.idx].launch_utc), x = STRIP.x0 + ((ms - STRIP.t0) / (STRIP.t1 - STRIP.t0)) * (STRIP.x1 - STRIP.x0);
  for (const [id, attr] of [["stripLine", "x1"], ["stripLine", "x2"], ["stripDot", "cx"]]) { const el = $(id); if (el) el.setAttribute(attr, x.toFixed(1)); }
}
function stripPick(ev) {
  const r = $("strip").getBoundingClientRect(), vx = ((ev.clientX - r.left) / r.width) * 320;
  const ms = STRIP.t0 + clamp((vx - STRIP.x0) / (STRIP.x1 - STRIP.x0), 0, 1) * (STRIP.t1 - STRIP.t0);
  let best = 0, bd = Infinity;
  S.forecast.forEach((c, i) => { const dd = Math.abs(Date.parse(c.launch_utc) - ms); if (dd < bd) { bd = dd; best = i; } });
  if (best !== S.idx) { S.idx = best; moveStripMark(); renderLabelsOnly(); clearTimeout(stripPick.t); stripPick.t = setTimeout(() => { S.idx = -1; selectIdx(best); }, 120); }
}
function renderLabelsOnly() {                                         // cheap update while dragging: only the big readout
  const e = S.forecast[S.idx], when = new Date(e.launch_utc), lp = local(when);
  $("launchBig").textContent = `${lp.weekday}, ${lp.month} ${lp.day} · ${lp.hour}:${lp.minute} ${lp.dayPeriod} ${lp.timeZoneName}`;
  $("launchSmall").textContent = `${utcText(when)} · forecast hour +${e.lead_h.toFixed(0)}`;
}

function setMode(mode) {
  if (mode === S.mode) return;
  S.mode = mode;
  if (mode === "forecast") { const i = S.idx; S.idx = -1; selectIdx(i < 0 ? 0 : i); } else if (S.replays[0]) { loadCase(S.replays[0].file); renderTimeCard(); }
}

function setPlayLabel() { $("playBtn").textContent = viewer.clock.shouldAnimate ? "Pause" : "Play"; }
function togglePlay() {
  const c = viewer.clock;
  if (!c.shouldAnimate && C.JulianDate.secondsDifference(c.currentTime, S.epoch) >= S.tEnd - 1e-6) c.currentTime = S.epoch.clone();
  c.shouldAnimate = !c.shouldAnimate; setPlayLabel();
}
function seek(frac) {
  viewer.clock.currentTime = C.JulianDate.addSeconds(S.epoch, clamp(frac, 0, 1) * S.tEnd, new C.JulianDate());
  update(clamp(frac, 0, 1) * S.tEnd);
}

function drawChart() {
  const svg = $("chart"), d = S.data, W = 288, H = 64, X0 = 24, Y0 = 8;
  const x = (t) => X0 + (t / S.tEnd) * W, y = (a) => Y0 + H - (a / 14000) * H;
  const path = (ts, as) => ts.map((t, i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(as[i]).toFixed(1)}`).join("");
  let html = `<line class="axis" x1="${X0}" y1="${Y0 + H}" x2="${X0 + W}" y2="${Y0 + H}"/><line class="axis" x1="${X0}" y1="${Y0}" x2="${X0}" y2="${Y0 + H}"/>`;
  for (const a of [0, 7000, 14000]) html += `<text class="tick" x="${X0 - 3}" y="${y(a) + 3}" text-anchor="end">${a / 1000}</text>`;
  for (const f of [0, 0.5, 1]) html += `<text class="tick" x="${X0 + f * W}" y="${Y0 + H + 11}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}">${Math.round(f * S.tEnd / 60)} min</text>`;
  html += `<text class="tick" x="2" y="6">km</text><path class="profile" d="${path(S.times, S.alt)}"/>`;
  if (d.observed) html += `<path class="real" d="${path(d.observed.t_s, d.observed.alt_m)}"/>`;
  html += `<line id="chartCursor" class="cursor" x1="${X0}" y1="${Y0}" x2="${X0}" y2="${Y0 + H}"/>`;
  svg.innerHTML = html;
}
$("chart").addEventListener("click", (ev) => {
  const r = $("chart").getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * 320;
  seek((px - 24) / 288);
});

/* ---------- camera ---------- */
function setView(name, duration = 1.4) {
  S.view = name;
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  viewer.trackedEntity = undefined;
  if (!S.center) return;
  const sphere = new C.BoundingSphere(S.center, S.radius);
  const side = S.bearing + Math.PI / 2;
  if (name === "chase") {
    const back = 14000;
    S.balloon.viewFrom = new C.Cartesian3(-Math.sin(S.bearing) * back, -Math.cos(S.bearing) * back, 6000);
    viewer.trackedEntity = S.balloon;
    return;
  }
  const offsets = {
    overview: new C.HeadingPitchRange(side, C.Math.toRadians(-28), S.radius * 3.0),
    top: new C.HeadingPitchRange(0, C.Math.toRadians(-90), S.radius * 3.4),
    side: new C.HeadingPitchRange(side, C.Math.toRadians(-2), S.radius * 4.2),
  };
  viewer.camera.flyToBoundingSphere(sphere, { offset: offsets[name], duration });
}

/* ---------- live tracking (SondeHub) ---------- */
let live = { active: false, timer: null, frames: [], first: true, ent: null, trail: [], pos: C.Cartesian3.ZERO, demoT: 0, up: true };
const API = "https://api.v2.sondehub.org";

function collectFrames(node, out = []) {            // find every frame-like object, whatever the nesting
  if (Array.isArray(node)) node.forEach((n) => collectFrames(n, out));
  else if (node && typeof node === "object") {
    if (typeof node.lat === "number" && typeof node.lon === "number" && typeof node.alt === "number" && node.datetime) out.push(node);
    else Object.values(node).forEach((n) => collectFrames(n, out));
  }
  return out;
}
function ensureLiveEntity() {
  if (live.ent) return;
  live.ent = addEntity({
    position: new C.CallbackProperty(() => live.pos, false),
    billboard: { ...spriteProps(new C.CallbackProperty(() => (live.up ? SPRITE.balloon : SPRITE.chute), false), COLORS.real) },
    label: { text: new C.CallbackProperty(() => live.label || "", false), font: "600 13px system-ui, sans-serif", fillColor: COLORS.real,
      outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45),
      pixelOffset: new C.Cartesian2(24, 14), horizontalOrigin: C.HorizontalOrigin.LEFT, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    polyline: { positions: new C.CallbackProperty(() => live.trail, false), width: 6, arcType: C.ArcType.NONE,
      material: new C.PolylineGlowMaterialProperty({ glowPower: 0.3, color: COLORS.real }) } });
}
function nominalAtAltitude(alt, ascending) {        // lat/lon of the forecast path at this altitude on the same leg
  const d = S.data, b = Math.round(d.meta.burst_time_s), burstIdx = S.times.findIndex((t) => t >= b - 1e-6);
  const lo = ascending ? 0 : Math.max(0, burstIdx), hi = ascending ? Math.max(1, burstIdx) : S.alt.length - 1;
  for (let i = lo; i < hi; i++) {
    const a0 = S.alt[i], a1 = S.alt[i + 1];
    if ((alt - a0) * (alt - a1) <= 0 && a0 !== a1) {
      const f = (alt - a0) / (a1 - a0);
      return [d.nominal.lat[i] + (d.nominal.lat[i + 1] - d.nominal.lat[i]) * f, d.nominal.lon[i] + (d.nominal.lon[i + 1] - d.nominal.lon[i]) * f];
    }
  }
  return null;
}
function ingestFrames(frames, source) {
  frames = frames.filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon) && Number.isFinite(f.alt))
    .sort((a, b) => a.datetime < b.datetime ? -1 : 1);
  if (!frames.length) { $("liveStatus").textContent = `${source}: no frames yet. Is the balloon transmitting and heard by a receiver?`; return; }
  ensureLiveEntity();
  live.active = true; live.frames = frames;
  const last = frames.at(-1);
  live.trail = frames.map((f) => cart(f.lat, f.lon, f.alt));
  live.pos = live.trail.at(-1);
  live.label = `${source}: ${(last.alt / 1000).toFixed(1)} km`;
  const prev = frames.at(-2), dtS = prev ? (Date.parse(last.datetime) - Date.parse(prev.datetime)) / 1000 : 0;
  const vv = Number.isFinite(last.vel_v) ? last.vel_v : (dtS > 0 ? (last.alt - prev.alt) / dtS : NaN);
  const vh = Number.isFinite(last.vel_h) ? last.vel_h : (dtS > 0 ? kmBetween(prev.lat, prev.lon, last.lat, last.lon) * 1000 / dtS : NaN);
  live.up = !(Number.isFinite(vv) && vv < -1);
  $("liveStats").hidden = false;
  $("lAlt").textContent = `${(last.alt / 1000).toFixed(2)} km`;
  $("lVert").textContent = Number.isFinite(vv) ? `${vv >= 0 ? "+" : ""}${vv.toFixed(1)} m/s` : "-";
  $("lSpeed").textContent = Number.isFinite(vh) ? `${(vh * 3.6).toFixed(0)} km/h` : "-";
  let offText = "-";
  if (S.data && kmBetween(S.data.meta.launch.lat, S.data.meta.launch.lon, frames[0].lat, frames[0].lon) < 25) {
    const nom = nominalAtAltitude(last.alt, live.up);
    if (nom) offText = `${kmBetween(nom[0], nom[1], last.lat, last.lon).toFixed(1)} km`;
  } else if (S.data) offText = "n/a (other launch)";
  $("lOff").textContent = offText;
  const age = Math.max(0, (Date.now() - Date.parse(last.datetime)) / 1000);
  $("liveStatus").textContent = source === "Demo feed" ? `Demo feed: ${frames.length} frames played.`
    : `${frames.length} frames; newest is ${age < 120 ? Math.round(age) + " s" : Math.round(age / 60) + " min"} old.`;
  if (live.first || $("liveFollow").checked) {
    viewer.trackedEntity = undefined;
    viewer.camera.flyToBoundingSphere(new C.BoundingSphere(live.pos, 12000), { duration: live.first ? 2 : 0.8,
      offset: new C.HeadingPitchRange(0, C.Math.toRadians(-35), 30000) });
    live.first = false;
  }
}
async function pollOnce(kind, id) {
  const param = kind === "sondes" ? "serial" : "payload_callsign";
  const url = `${API}/${kind}/telemetry?${param}=${encodeURIComponent(id)}&duration=12h`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    ingestFrames(collectFrames(await r.json()), id);
  } catch (e) { $("liveStatus").textContent = `Could not reach SondeHub (${e.message}). Will retry.`; }
}
function startLive() {
  const id = $("liveId").value.trim();
  if (!id) { toast("Enter a sonde serial or a payload callsign first."); return; }
  stopLive(true);
  live.first = true; live.active = true;
  $("liveStatus").textContent = `Looking for ${id}...`;
  const kind = $("liveKind").value;
  pollOnce(kind, id);
  live.timer = setInterval(() => pollOnce(kind, id), 10000);
  $("liveBtn").textContent = "Stop";
}
function stopLive(keepButton) {
  clearInterval(live.timer); live.timer = null; live.active = false;
  if (live.ent) { viewer.entities.remove(live.ent); S.entities = S.entities.filter((e) => e !== live.ent); live.ent = null; }
  live.trail = []; live.frames = [];
  if (!keepButton) { $("liveBtn").textContent = "Track"; $("liveStats").hidden = true; $("liveStatus").textContent = "Not tracking. Needs the balloon's transmissions to reach SondeHub."; }
}
function startDemo() {
  const o = S.data && S.data.observed;
  if (!o) { toast("Switch to 'Real flight' first: the demo feed replays its recorded climb."); return; }
  stopLive(true);
  live.first = true; live.active = true; live.demoT = 0;
  $("liveBtn").textContent = "Stop";
  const t0 = Date.parse(S.data.meta.launch_time_utc);
  const frames = o.t_s.map((t, i) => {
    const j = Math.min(i + 1, o.t_s.length - 1), k = Math.max(i - 1, 0), dt = o.t_s[j] - o.t_s[k] || 1;
    return { datetime: new Date(t0 + t * 1000).toISOString(), lat: o.lat[i], lon: o.lon[i], alt: o.alt_m[i],
      vel_v: (o.alt_m[j] - o.alt_m[k]) / dt, vel_h: kmBetween(o.lat[k], o.lon[k], o.lat[j], o.lon[j]) * 1000 / dt };
  });
  viewer.trackedEntity = undefined;
  live.timer = setInterval(() => {
    live.demoT += Number($("speedSelect").value);     // one real second = `speed` flight seconds
    ingestFrames(frames.filter((f) => (Date.parse(f.datetime) - t0) / 1000 <= live.demoT), "Demo feed");
    if (live.demoT >= o.t_s.at(-1)) { clearInterval(live.timer); live.timer = null; $("liveBtn").textContent = "Track"; }
  }, 1000);
}

/* ---------- wiring ---------- */
$("playBtn").addEventListener("click", togglePlay);
$("restartBtn").addEventListener("click", () => { seek(0); });
$("speedSelect").addEventListener("change", (e) => { viewer.clock.multiplier = Number(e.target.value); });
document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
["lyEnsemble", "lyEnd", "lyWinds", "lyDrop", "lyClouds", "lyWindFx"].forEach((id) => $(id).addEventListener("change", applyLayers));
$("liveBtn").addEventListener("click", () => { if (live.active || live.timer) { stopLive(); } else startLive(); });
$("demoBtn").addEventListener("click", startDemo);
$("liveId").addEventListener("keydown", (e) => { if (e.key === "Enter") startLive(); });
$("modeForecast").addEventListener("click", () => setMode("forecast"));
$("modeReal").addEventListener("click", () => setMode("real"));
$("prevHour").addEventListener("click", () => selectIdx(S.idx - 1));
$("nextHour").addEventListener("click", () => selectIdx(S.idx + 1));
const strip = $("strip");
strip.addEventListener("pointerdown", (e) => { strip.setPointerCapture(e.pointerId); strip.dataset.drag = "1"; stripPick(e); });
strip.addEventListener("pointermove", (e) => { if (strip.dataset.drag) stripPick(e); });
strip.addEventListener("pointerup", () => { delete strip.dataset.drag; });
window.addEventListener("keydown", (e) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (e.code === "Space" && document.activeElement.tagName !== "BUTTON") { e.preventDefault(); togglePlay(); }
  else if (e.code === "ArrowLeft" && S.mode === "forecast") { e.preventDefault(); selectIdx(S.idx - 1); }
  else if (e.code === "ArrowRight" && S.mode === "forecast") { e.preventDefault(); selectIdx(S.idx + 1); }
});

(async function init() {
  try {
    S.cases = await (await fetch("data/index.json")).json();
    S.forecast = S.cases.filter((c) => c.kind === "forecast").sort((a, b) => a.launch_utc < b.launch_utc ? -1 : 1);
    S.replays = S.cases.filter((c) => c.kind === "replay");
    // Optional deep link: ?launch=<ISO UTC time>&mode=real&view=overview|chase|top|side&t=<0..1 of the flight>
    const q = new URLSearchParams(location.search);
    if (!S.forecast.length && !S.replays.length) throw new Error("no cases");
    if (q.get("mode") === "real" && S.replays.length) S.mode = "real";
    else if (!S.forecast.length) S.mode = "real";
    if (S.mode === "forecast") {
      let idx = S.forecast.findIndex((c) => c.lead_h === 25);                // default: 8 AM local the next morning
      if (q.get("launch")) { const want = Date.parse(q.get("launch")); idx = S.forecast.reduce((b, c, i) => Math.abs(Date.parse(c.launch_utc) - want) < Math.abs(Date.parse(S.forecast[b].launch_utc) - want) ? i : b, 0); }
      S.idx = Math.max(0, idx);
    }
    S.loadedMode = S.mode;
    await loadCase((S.mode === "forecast" ? S.forecast[S.idx] : S.replays[0]).file);
    if (q.get("view")) setView(q.get("view"), 0);
    if (q.get("t")) seek(Number(q.get("t")));
  } catch (e) {
    console.error(e);
    toast("Could not load data/index.json. Serve this folder over http: python -m http.server 8000 (from the web folder).", 15000);
  }
})();

if (new URLSearchParams(location.search).get("debug")) {          // ?debug=1 : on-screen diagnostics (used for headless testing)
  const box = document.createElement("pre");
  box.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:9;background:#000c;color:#9f9;padding:6px;font:11px monospace;max-width:520px;white-space:pre-wrap";
  document.body.appendChild(box);
  setInterval(() => {
    const g = viewer.scene.globe;
    box.textContent = `tilesLoaded=${g.tilesLoaded} camDist=${Math.round(S.camDist)} m  gust=${S.gust ? S.gust.alpha : "-"} slice=${S.slice ? S.slice.alpha.toFixed(2) : "-"} ` +
      `clouds=${S.clouds ? S.clouds.length : 0} case=${S.data ? S.data.id : "-"}`;
  }, 500);
}
window.__S = S; window.__viewer = viewer; window.__C = C;   // for debugging in the browser console
