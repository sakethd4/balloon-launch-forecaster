"use strict";
/* Launch Planner 3D: plays back a forecast flight (and the learned landing-zone ensemble) on a 3D globe,
   compares it with a real balloon, and tracks a live SondeHub balloon. Static page: data comes from
   data/*.json written by scripts/export_web_case.py. Needs to be served over http (python -m http.server). */
const C = Cesium;
const KM_PER_DEG = 111.195;
const $ = (id) => document.getElementById(id);

const COLORS = {
  forecast: C.Color.fromCssColorString("#86b6ef"),
  landing: C.Color.fromCssColorString("#eb6834"),
  real: C.Color.fromCssColorString("#1baf7a"),
  ink: C.Color.fromCssColorString("#f0efec"),
};
// Altitude ramp for the path: one blue hue, lighter = higher (the surface is dark imagery)
const RAMP = ["#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"].map((h) => C.Color.fromCssColorString(h));

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
viewer.scene.globe.enableLighting = false;
viewer.scene.skyAtmosphere.show = true;
viewer.clock.clockRange = C.ClockRange.CLAMPED;

const S = {
  data: null, epoch: null, tEnd: 0, times: [], alt: [], nomPos: [], ensPos: [], objs: [], entities: [],
  balloonPos: C.Cartesian3.ZERO, balloonAlt: 0, balloonR: 100, labelText: "", real: null, view: "overview",
  bearing: 0, radius: 20000, center: null, lastText: {},
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

/* ---------- scene objects (everything added per case is tracked so it can be cleared) ---------- */
function track(obj) { S.objs.push(obj); return obj; }
function addPrimitive(p) { viewer.scene.primitives.add(p); return track(p); }
function addEntity(e) { S.entities.push(viewer.entities.add(e)); return S.entities[S.entities.length - 1]; }
function clearCase() {
  viewer.trackedEntity = undefined;
  for (const p of S.objs) viewer.scene.primitives.remove(p);
  for (const e of S.entities) viewer.entities.remove(e);
  S.objs = []; S.entities = []; S.real = null; S.swarm = null; S.lastText = {};
}

async function loadCase(file) {
  let d;
  try {
    const r = await fetch("data/" + file);
    if (!r.ok) throw new Error(r.status);
    d = await r.json();
  } catch (e) {
    toast("Could not load the case data. Serve this folder over http (python -m http.server) instead of opening the file directly.", 12000);
    return;
  }
  clearCase();
  stopLive();
  const m = d.meta;
  S.data = d; S.times = d.t_s; S.alt = d.alt_m; S.tEnd = d.t_s[d.t_s.length - 1];
  S.epoch = C.JulianDate.fromIso8601(m.launch_time_utc);
  const clock = viewer.clock;
  clock.startTime = S.epoch.clone(); clock.currentTime = S.epoch.clone();
  clock.stopTime = C.JulianDate.addSeconds(S.epoch, S.tEnd, new C.JulianDate());
  clock.multiplier = Number($("speedSelect").value); clock.shouldAnimate = false;
  setPlayLabel();

  S.nomPos = d.t_s.map((_, i) => cart(d.nominal.lat[i], d.nominal.lon[i], d.alt_m[i]));
  S.ensPos = d.ensemble.lat.map((la, k) => la.map((lat, i) => cart(lat, d.ensemble.lon[k][i], d.alt_m[i])));
  const endNom = [d.nominal.lat.at(-1), d.nominal.lon.at(-1)];
  S.bearing = bearingRad(m.launch.lat, m.launch.lon, endNom[0], endNom[1]);

  buildStatic(d);
  buildMovers(d);
  fillPanel(d);
  drawChart();
  const all = [...S.nomPos, ...d.endpoints.map((p) => cart(p[0], p[1], 0)), cart(m.launch.lat, m.launch.lon, 0)];
  const sphere = C.BoundingSphere.fromPoints(all);
  S.center = sphere.center; S.radius = Math.max(sphere.radius, 8000);
  setView("overview", 0);
  update(0);
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
  S.pathPrim = addPrimitive(new C.Primitive({
    geometryInstances: new C.GeometryInstance({ geometry: new C.PolylineGeometry({
      positions: S.nomPos, width: 4, vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT, colors, colorsPerVertex: true }) }),
    appearance: new C.PolylineColorAppearance({ translucent: true }), asynchronous: false }));

  // Sampled paths of the ensemble: one faint line each
  S.ensPrim = addPrimitive(new C.Primitive({
    geometryInstances: S.ensPos.map((pos) => new C.GeometryInstance({
      geometry: new C.PolylineGeometry({ positions: pos, width: 1.2, vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT }),
      attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.WHITE.withAlpha(0.16)) } })),
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
        outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45), pixelOffset: new C.Cartesian2(0, -22), verticalOrigin: C.VerticalOrigin.BOTTOM } }),
  ];
  addEntity({ position: cart(m.launch.lat, m.launch.lon, 0), point: { pixelSize: 10, color: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 2 },
    label: { text: "Launch", font: "600 13px system-ui, sans-serif", fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3,
      style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45), pixelOffset: new C.Cartesian2(14, 6), horizontalOrigin: C.HorizontalOrigin.LEFT } });

  // Forecast winds at the launch point, one arrow per kilometre of height (length = speed)
  S.windEnts = [];
  const w = d.winds, cosLat = Math.cos(m.launch.lat * Math.PI / 180), SCALE = 450;       // metres of arrow per m/s
  w.alt_m.forEach((a, i) => {
    const sp = Math.hypot(w.u[i], w.v[i]);
    const tip = cart(m.launch.lat + (w.v[i] * SCALE) / 111195, m.launch.lon + (w.u[i] * SCALE) / (111195 * cosLat), a);
    const ent = addEntity({ polyline: { positions: [cart(m.launch.lat, m.launch.lon, a), tip], width: 9, arcType: C.ArcType.NONE,
      material: new C.PolylineArrowMaterialProperty(C.Color.WHITE.withAlpha(0.8)) } });
    S.windEnts.push(ent);
    if (a % 4000 === 0 && a > 0) S.windEnts.push(addEntity({ position: tip, label: { text: `${a / 1000} km: ${sp.toFixed(0)} m/s`,
      font: "12px system-ui, sans-serif", fillColor: C.Color.WHITE, outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45),
      pixelOffset: new C.Cartesian2(8, 0), horizontalOrigin: C.HorizontalOrigin.LEFT } }));
  });
  applyLayers();
}

function buildMovers(d) {
  S.swarm = addPrimitive(new C.PointPrimitiveCollection());
  for (let k = 0; k < S.ensPos.length; k++) S.swarm.add({ position: S.ensPos[k][0], pixelSize: 4, color: C.Color.WHITE.withAlpha(0.85),
    outlineColor: C.Color.BLACK.withAlpha(0.5), outlineWidth: 1 });

  S.trailPositions = [];
  S.balloon = addEntity({
    position: new C.CallbackProperty(() => S.balloonPos, false),
    ellipsoid: { radii: new C.CallbackProperty(() => new C.Cartesian3(S.balloonR, S.balloonR, S.balloonR * 1.25), false),
      material: COLORS.forecast },
    label: { text: new C.CallbackProperty(() => S.labelText, false), font: "600 13px system-ui, sans-serif", fillColor: C.Color.WHITE,
      outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45), pixelOffset: new C.Cartesian2(16, -16),
      horizontalOrigin: C.HorizontalOrigin.LEFT, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    polyline: { positions: new C.CallbackProperty(() => S.trailPositions, false), width: 6, arcType: C.ArcType.NONE,
      material: new C.PolylineGlowMaterialProperty({ glowPower: 0.3, color: COLORS.forecast }) },
  });
  S.dropLine = addEntity({ polyline: { positions: new C.CallbackProperty(() => S.dropPositions || [], false), width: 1.5, arcType: C.ArcType.NONE,
    material: new C.PolylineDashMaterialProperty({ color: C.Color.WHITE.withAlpha(0.6), dashLength: 12 }) } });
  S.dropPositions = [];

  if (d.observed) {                                           // a real balloon through the same sky
    const o = d.observed;
    S.real = { t: o.t_s, pos: o.t_s.map((_, i) => cart(o.lat[i], o.lon[i], o.alt_m[i])), alt: o.alt_m, lat: o.lat, lon: o.lon, trail: [], p: C.Cartesian3.ZERO, r: 100 };
    S.real.ent = addEntity({
      position: new C.CallbackProperty(() => S.real.p, false),
      ellipsoid: { radii: new C.CallbackProperty(() => new C.Cartesian3(S.real.r, S.real.r, S.real.r * 1.25), false), material: COLORS.real },
      label: { text: "Real balloon", font: "600 13px system-ui, sans-serif", fillColor: COLORS.real, outlineColor: C.Color.BLACK, outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45), pixelOffset: new C.Cartesian2(16, 16), horizontalOrigin: C.HorizontalOrigin.LEFT,
        disableDepthTestDistance: Number.POSITIVE_INFINITY },
      polyline: { positions: new C.CallbackProperty(() => S.real.trail, false), width: 6, arcType: C.ArcType.NONE,
        material: new C.PolylineGlowMaterialProperty({ glowPower: 0.3, color: COLORS.real }) } });
  }
}

function applyLayers() {
  const on = (id) => $(id).checked;
  if (S.ensPrim) S.ensPrim.show = on("lyEnsemble");
  if (S.swarm) S.swarm.show = on("lyEnsemble");
  if (S.endPts) S.endPts.show = on("lyEnd");
  (S.ringEnts || []).forEach((e) => { e.show = on("lyEnd"); });
  (S.windEnts || []).forEach((e) => { e.show = on("lyWinds"); });
  if (S.dropLine) S.dropLine.show = on("lyDrop");
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
  S.balloonAlt = alt;
  S.balloonR = t < d.meta.burst_time_s ? 220 + 650 * clamp(alt / 13716, 0, 1) : 180;   // drawn bigger than life; it grows on the way up
  S.labelText = `${(alt / 1000).toFixed(1)} km`;
  S.trailPositions = S.nomPos.slice(0, i + 1).concat([S.balloonPos]);
  S.dropPositions = [S.balloonPos, cart(lat, lon, 0)];
  if (S.swarm) for (let k = 0; k < S.ensPos.length; k++) S.swarm.get(k).position = lerpPos(S.ensPos[k], i, f, scratch);

  const done = t >= S.tEnd - 1e-6, up = t < d.meta.burst_time_s;
  setText("rTime", fmtTime(t));
  setText("rAlt", `${(alt / 1000).toFixed(1)} km`);
  setText("rAltFt", `${Math.round(alt * 3.28084).toLocaleString()} ft`);
  setText("rVert", `${vert >= 0 ? "+" : ""}${vert.toFixed(1)} m/s`);
  setText("rPhase", done ? (d.kind === "replay" ? "end of climb" : "landed") : (up ? "climbing" : "parachute descent"));
  setText("rDist", `${kmBetween(d.meta.launch.lat, d.meta.launch.lon, lat, lon).toFixed(1)} km`);
  setText("rSpeed", `${speed.toFixed(0)} km/h sideways`);
  const cur = $("chartCursor"); if (cur) { const x = 24 + (t / S.tEnd) * 288; cur.setAttribute("x1", x); cur.setAttribute("x2", x); }

  if (S.real) {
    const r = S.real, [j, g] = bracket(r.t, t);
    r.p = lerpPos(r.pos, j, g);
    r.r = 200 + 560 * clamp((r.alt[j] + (r.alt[j + 1] - r.alt[j]) * g) / 13716, 0, 1);
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

viewer.clock.onTick.addEventListener((clock) => {
  if (!S.data) return;
  const t = clamp(C.JulianDate.secondsDifference(clock.currentTime, S.epoch), 0, S.tEnd);
  update(t);
  if (t >= S.tEnd && clock.shouldAnimate) { clock.shouldAnimate = false; setPlayLabel(); }
});

/* ---------- panel ---------- */
function fillPanel(d) {
  const m = d.meta;
  $("caseSubtitle").textContent = d.subtitle;
  $("r50").textContent = m.r50_km.toFixed(1); $("r90").textContent = m.r90_km.toFixed(1);
  $("endLabel").textContent = m.endpoint_label;
  $("situation").textContent = `Forecast situation: ${m.lead_h.toFixed(0)} h lead, ensemble wind spread ${m.spread_ms.toFixed(1)} m/s, ` +
    `forecast wind ${m.gfs_wind_ms.toFixed(0)} m/s at 200-500 hPa. ${m.n} sampled flights.`;
  $("notes").textContent = m.notes.join("\n");
  $("compare").hidden = !d.observed;
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
let live = { active: false, timer: null, frames: [], first: true, ent: null, trail: [], pos: C.Cartesian3.ZERO, demoT: 0 };
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
    ellipsoid: { radii: new C.Cartesian3(450, 450, 560), material: COLORS.real },
    label: { text: new C.CallbackProperty(() => live.label || "", false), font: "600 13px system-ui, sans-serif", fillColor: COLORS.real,
      outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, showBackground: true, backgroundColor: C.Color.BLACK.withAlpha(0.45), pixelOffset: new C.Cartesian2(16, 16),
      horizontalOrigin: C.HorizontalOrigin.LEFT, disableDepthTestDistance: Number.POSITIVE_INFINITY },
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
  $("liveStats").hidden = false;
  $("lAlt").textContent = `${(last.alt / 1000).toFixed(2)} km`;
  $("lVert").textContent = Number.isFinite(vv) ? `${vv >= 0 ? "+" : ""}${vv.toFixed(1)} m/s` : "-";
  $("lSpeed").textContent = Number.isFinite(vh) ? `${(vh * 3.6).toFixed(0)} km/h` : "-";
  let offText = "-";
  if (S.data && kmBetween(S.data.meta.launch.lat, S.data.meta.launch.lon, frames[0].lat, frames[0].lon) < 25) {
    const nom = nominalAtAltitude(last.alt, !(Number.isFinite(vv) && vv < -1));
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
  if (!o) { toast("Load the real-flight case first: the demo feed replays its recorded climb."); return; }
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
["lyEnsemble", "lyEnd", "lyWinds", "lyDrop"].forEach((id) => $(id).addEventListener("change", applyLayers));
$("liveBtn").addEventListener("click", () => { if (live.active || live.timer) { stopLive(); } else startLive(); });
$("demoBtn").addEventListener("click", startDemo);
$("liveId").addEventListener("keydown", (e) => { if (e.key === "Enter") startLive(); });
window.addEventListener("keydown", (e) => { if (e.code === "Space" && !/INPUT|SELECT|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); togglePlay(); } });
$("caseSelect").addEventListener("change", (e) => loadCase(e.target.value));

(async function init() {
  try {
    const cases = await (await fetch("data/index.json")).json();
    $("caseSelect").innerHTML = cases.map((c) => `<option value="${c.file}">${c.title}</option>`).join("");
    // Optional deep link: ?case=<id or title text>&view=overview|chase|top|side&t=<0..1 of the flight>
    const q = new URLSearchParams(location.search);
    const pick = cases.find((c) => c.id === q.get("case")) || cases[0];
    if (pick) {
      $("caseSelect").value = pick.file;
      await loadCase(pick.file);
      if (q.get("view")) setView(q.get("view"), 0);
      if (q.get("t")) seek(Number(q.get("t")));
    }
  } catch (e) {
    toast("Could not load data/index.json. Serve this folder over http: python -m http.server 8000 (from the web folder).", 15000);
  }
})();
if (new URLSearchParams(location.search).get("debug")) {          // ?debug=1 : on-screen diagnostics (used for headless testing)
  const box = document.createElement("pre");
  box.style.cssText = "position:fixed;right:8px;top:8px;z-index:9;background:#000c;color:#9f9;padding:6px;font:11px monospace;max-width:520px;white-space:pre-wrap";
  document.body.appendChild(box);
  const errs = [];
  viewer.imageryLayers.get(0).imageryProvider.errorEvent.addEventListener((e) => errs.push(String(e.message).slice(0, 120)));
  setInterval(() => {
    const g = viewer.scene.globe, c = viewer.camera, h = C.Ellipsoid.WGS84.cartesianToCartographic(c.position);
    box.textContent = `globe.show=${g.show} tilesLoaded=${g.tilesLoaded} layers=${viewer.imageryLayers.length} ready=${viewer.imageryLayers.get(0).ready}
` +
      `cam h=${Math.round(h.height)} m  pitch=${C.Math.toDegrees(c.pitch).toFixed(0)} frustum far=${c.frustum.far.toExponential(1)}
` +
      `imagery errors: ${errs.length} ${errs.slice(-2).join(" | ")}
rings=${(S.ringEnts || []).length} t=${(window.__S.lastText.rTime)}`;
  }, 500);
}
window.__S = S;   // for debugging in the browser console
