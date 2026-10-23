// Launch Planner: pick a launch point and time, see where the balloon goes, ride along on it.
import * as THREE from "three";
import { $, Grid, bearingDeg, bracket, clamp, daylight, deg, kmBetween, sunPosition } from "./util.js";
import { createEarth, elevationAt, pickGround, setDaylight } from "./earth.js";
import { createOverlay } from "./overlay.js";
import { Flight } from "./flight.js";
import { Cameras } from "./cameras.js";
import * as ui from "./ui.js";
import { createBalloon } from "./balloon.js";
import { createWind } from "./wind.js";
import { createClouds } from "./clouds.js";
import { createBirds } from "./birds.js";

const C = window.Cesium;
const AUSTIN = { lat: 30.267, lon: -97.743 };
const params = new URLSearchParams(location.search);

const S = {
  cam: "orbit", t: 0, tEnd: 1, speed: 30, playing: false, lead: 25, site: { ...AUSTIN }, follow: -1, selected: null, picking: false,
  data: null, flight: null, grid: null, pos: new C.Cartesian3(), sun: { el: 30, az: 180, k: 1 }, dayK: -1, last: performance.now(), token: 0,
  bearing: 0, sphere: null, firstLoad: true, layers: {}, heading: null, quality: 1, frameMs: 16, adaptAt: 0,
};
window.__S = S;
S.reportVisualError = ui.toast;

async function getJSON(url, opts) {
  const r = await fetch(url, opts), j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function fatal(msg) {
  document.body.insertAdjacentHTML("beforeend", `<div style="position:fixed;inset:0;z-index:99;display:grid;place-items:center;background:#05070a;text-align:center;padding:24px">
    <div><h2 style="margin:0 0 8px">Launch Planner can't reach its server</h2><p style="color:#9aa5b4;margin:0 0 14px">${msg}</p>
    <code style="background:#10151d;padding:8px 12px;border-radius:8px">python -u -W ignore -m scripts.serve</code></div></div>`);
}

/* ------------------------------------------------------------------ actions */
const handlers = {
  async setSite(lat, lon) {
    const r = S.region.launch;
    if (lat < r.lat_min || lat > r.lat_max || lon < r.lon_min || lon > r.lon_max) { ui.toast("That spot is outside the area the forecast covers (or too near its edge for a balloon to stay inside)."); return; }
    S.site = { lat, lon }; S.siteChanged = true;
    await loadCase();
  },
  togglePick(force) {
    S.picking = force == null ? !S.picking : force;
    ui.setPicking(S.picking);
  },
  setLead(lead) {
    lead = clamp(Math.round(lead), S.region.lead_min_h, S.region.lead_max_h);
    if (lead === S.lead && S.data) return;
    S.lead = lead; ui.renderTimeCard(S);
    clearTimeout(handlers._leadTimer); handlers._leadTimer = setTimeout(() => loadCase(), 110);
  },
  setRun(run) { S.run = run; ui.renderTimeCard(S); loadCase(); },
  togglePlay() {
    if (!S.data) return;
    if (!S.playing && S.t >= S.tEnd - 1e-6) S.t = 0;
    S.playing = !S.playing; ui.setPlaying(S.playing);
  },
  seek(frac) { if (S.data) S.t = clamp(frac, 0, 1) * S.tEnd; },
  setSpeed(v) { S.speed = v; },
  setCam(mode) {
    S.cam = mode; ui.setCamChip(mode);
    if (S.flight) S.flight.setVisible({ hidden: mode === "balloon" });
    S.cameras.setMode(mode, { travelHeading: S.travelHeading(), sphere: S.sphere, bearing: S.bearing });
    S.modules.forEach((m) => m.onCamera && m.onCamera(S));
  },
  select(k) {
    S.selected = k; S.flight.select(k);
    if (k == null) { ui.hideDetails(); return; }
    const d = S.data, e = d.endpoints[k], m = d.meta, nl = d.nominal.lat.at(-1), no = d.nominal.lon.at(-1);
    const dist = (a) => kmBetween(nl, no, a[0], a[1]);
    const fromNominal = dist(e), rank = d.endpoints.filter((o) => dist(o) < fromNominal).length;
    ui.showDetails(S, k, { lat: e[0], lon: e[1], elev: null, fromLaunch: kmBetween(m.launch.lat, m.launch.lon, e[0], e[1]), bearing: bearingDeg(m.launch.lat, m.launch.lon, e[0], e[1]),
      fromNominal, rank, leftDomain: d.left_domain[k] });
    elevationAt(e[0], e[1]).then((h) => { if (S.selected === k) ui.updateDetailsElevation(h); });
  },
  follow(k) {
    if (!Number.isInteger(k) || k >= S.data.meta.n) k = -1;                 // anything that is not a flight number means the forecast balloon
    S.follow = k;
    ui.setFollowing(k);
    handlers.select(null); // Following closes the inspection drawer; the route remains on the globe.
    if (k >= 0 && S.cam === "orbit") handlers.setCam("chase");
    else if (k < 0 && (S.cam === "chase" || S.cam === "balloon")) handlers.setCam("orbit");
    S.modules.forEach((m) => m.onFollow && m.onFollow(S));
  },
  layers() {
    const on = (id) => $(id).checked;
    S.layers = { wind: on("lyWind"), clouds: on("lyClouds"), birds: on("lyBirds"), dots: on("lyDots"), rings: on("lyRings") };
    if (S.flight) S.flight.setVisible({ dots: S.layers.dots, rings: S.layers.rings, hidden: S.cam === "balloon" });
    const [, wind, clouds, birds] = S.modules;
    wind.setVisible(S.layers.wind); clouds.setVisible(S.layers.clouds); birds.setVisible(S.layers.birds);
    $("windLegend").hidden = !S.layers.wind;
  },
  exaggeration(v) { S.earth.scene.verticalExaggeration = v; },
};
S.handlers = handlers;
S.travelHeading = () => (S.data ? bearingDeg(S.site.lat, S.site.lon, S.data.nominal.lat.at(-1), S.data.nominal.lon.at(-1)) : 0);

/* ------------------------------------------------------------------ loading a launch */
async function loadCase() {
  const my = ++S.token;
  if (S.abort) S.abort.abort();
  S.abort = new AbortController();
  const slow = setTimeout(() => ui.setLoading(true, "Simulating 100 balloons..."), 220);
  try {
    const q = new URLSearchParams({ lat: S.site.lat.toFixed(5), lon: S.site.lon.toFixed(5), lead: S.lead, init: S.run, n: 100 });
    const data = await getJSON(`/api/case?${q}`, { signal: S.abort.signal });
    if (my === S.token) apply(data);
  } catch (e) {
    if (e.name !== "AbortError") ui.toast(e.message);
  } finally {
    clearTimeout(slow);
    if (my === S.token) ui.setLoading(false);
  }
}

function apply(data) {
  const wasPlaying = S.playing, first = S.firstLoad, siteChanged = S.siteChanged || first;
  if (S.flight) S.flight.destroy();
  S.data = data; S.flight = new Flight(S.earth, data);
  const m = data.meta;
  S.site = { lat: m.launch.lat, lon: m.launch.lon }; S.launchMs = Date.parse(m.launch_time_utc);
  S.tEnd = data.t_s.at(-1); S.t = 0; S.playing = wasPlaying; S.siteChanged = false; S.firstLoad = false;
  S.grid = new Grid(data.grid, m.launch.lat, m.launch.lon);
  S.overlay.setAnchor(m.launch.lat, m.launch.lon);
  S.follow = -1; ui.setFollowing(-1); S.selected = null; ui.hideDetails();
  S.bearing = Math.atan2((data.nominal.lon.at(-1) - m.launch.lon) * Math.cos(m.launch.lat * Math.PI / 180), data.nominal.lat.at(-1) - m.launch.lat);
  const pts = [...S.flight.nom, ...data.endpoints.map((e) => C.Cartesian3.fromDegrees(e[1], e[0], 0))];
  S.sphere = C.BoundingSphere.fromPoints(pts); S.sphere.radius = Math.max(S.sphere.radius, 6000);
  handlers.layers();
  ui.resetReadouts(); ui.renderSite(S); ui.renderOutcome(S); ui.renderTimeCard(S); ui.renderChart(S);
  S.modules.forEach((mod) => mod.onCase(S));
  if (siteChanged && (S.cam === "chase" || S.cam === "balloon")) {
    S.cameras.setMode(S.cam, { travelHeading: S.travelHeading(), sphere: S.sphere, bearing: S.bearing });
    S.flight.position(S.follow, S.t, S.pos);
    S.cameras.update(S.pos, performance.now() / 1000, m.launch.ground_m);
  }
  if (siteChanged && (S.cam === "orbit" || S.cam === "top")) S.cameras.frame(S.sphere, S.bearing, S.cam, first ? 0 : 1.8);
}

/* ------------------------------------------------------------------ per-frame */
// Optional adaptive quality (?adapt=1). Default rendering preserves full resolution and particle counts.
function adaptQuality(dt) {
  if (params.get("adapt") !== "1") return;
  S.frameMs += (dt * 1000 - S.frameMs) * 0.06;
  const now = performance.now();
  if (now < S.adaptAt) return;
  S.adaptAt = now + 1800;
  if (S.frameMs > 38 && S.quality > 0.4) S.quality = Math.max(0.4, S.quality * 0.78);
  else if (S.frameMs < 19 && S.quality < 1) S.quality = Math.min(1, S.quality * 1.12);
  S.earth.viewer.resolutionScale = S.quality < 0.55 ? 0.8 : 1;
}
function frame() {
  const now = performance.now(), dt = Math.min(0.1, (now - S.last) / 1000);
  S.last = now;
  if (!S.data) return;
  if (S.playing) {
    S.t += dt * S.speed;
    if (S.t >= S.tEnd) { S.t = S.tEnd; S.playing = false; ui.setPlaying(false); }
  }
  adaptQuality(dt);
  const f = S.flight;
  f.update(S.t, S.follow);
  f.position(S.follow, S.t, S.pos);
  const [i, fr] = bracket(f.times, S.t), dtS = f.times[i + 1] - f.times[i], alt = f.altitude(S.t);
  const la0 = S.data.nominal, a = S.follow < 0 ? la0 : { lat: S.data.ensemble.lat[S.follow], lon: S.data.ensemble.lon[S.follow] };
  const [lat, lon] = f.latLon(S.follow, S.t), sideKmh = kmBetween(a.lat[i], a.lon[i], a.lat[i + 1], a.lon[i + 1]) / dtS * 3600;
  S.cur = { lat, lon, alt, vert: (f.alt[i + 1] - f.alt[i]) / dtS, side: sideKmh, up: S.t < S.data.meta.burst_time_s };
  S.heading = bearingDeg(a.lat[i], a.lon[i], a.lat[i + 1], a.lon[i + 1]);
  // the sun, from the real clock time of this moment of the flight
  const date = new Date(S.launchMs + S.t * 1000), sp = sunPosition(date, S.site.lat, S.site.lon), k = daylight(sp.el);
  S.sun = { el: sp.el, az: sp.az, k };
  if (Math.abs(k - S.dayK) > 0.01) { S.dayK = k; setDaylight(S.earth, k, sp.el); }
  S.earth.viewer.clock.currentTime = C.JulianDate.fromDate(date);
  S.cameras.update(S.pos, performance.now() / 1000, S.data.meta.launch.ground_m);
  S.overlay.ecefToEnu(S.pos, S.enu || (S.enu = new THREE.Vector3()));
  S.timeScale = S.playing ? S.speed : 6;                         // wind and birds keep drifting a little when paused
  S.dt = dt;
  S.earth.enforceClearance();
  S.overlay.sync();
  for (const mod of S.modules) mod.update(S, dt);
  if (now - (S.lastReadout || 0) < 100) return;
  S.lastReadout = now;
  ui.updateReadouts(S, { alt, vert: S.cur.vert, side: sideKmh, dist: kmBetween(S.site.lat, S.site.lon, lat, lon), sunEl: sp.el, heading: S.cam === "balloon" ? S.cameras.headingDeg : S.heading });
}

/* ------------------------------------------------------------------ picking */
function setupPicking() {
  const { viewer, scene } = S.earth, canvas = viewer.canvas, h = new C.ScreenSpaceEventHandler(canvas);
  h.setInputAction((e) => {
    if (S.picking) {
      const g = pickGround(S.earth, e.position);
      if (!g) return;
      const r = S.region.launch;
      if (g.lat < r.lat_min || g.lat > r.lat_max || g.lon < r.lon_min || g.lon > r.lon_max) { ui.toast("That spot is outside the forecast area. Pick inside the bright region."); return; }
      handlers.togglePick(false); handlers.setSite(g.lat, g.lon);
      return;
    }
    if (S.cam === "balloon") return;
    const p = scene.pick(e.position), id = p && p.id;
    if (id && (id.kind === "dot" || id.kind === "end")) handlers.select(id.i);
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  let lastMove = 0;
  h.setInputAction((e) => {
    const now = performance.now();
    if (now - lastMove < 70 || S.picking || S.cam === "balloon") return;
    lastMove = now;
    const p = scene.pick(e.endPosition), id = p && p.id;
    canvas.style.cursor = id && (id.kind === "dot" || id.kind === "end") ? "pointer" : "";
  }, C.ScreenSpaceEventType.MOUSE_MOVE);
}

/* ------------------------------------------------------------------ boot */
(async function boot() {
  let meta;
  try { meta = await getJSON("/api/runs"); } catch (e) { fatal(e.message); return; }
  if (!meta.default) { fatal("No forecast data was found in ~/balloon-data."); return; }
  S.region = meta; S.runs = meta.runs; S.run = meta.default;
  S.earth = createEarth(meta);
  const clock = S.earth.viewer.clock;
  clock.clockRange = C.ClockRange.UNBOUNDED; clock.shouldAnimate = false;
  S.overlay = createOverlay(S.earth);
  S.cameras = new Cameras(S.earth);
  S.modules = [createBalloon(S), createWind(S), createClouds(S), createBirds(S)];
  ui.initUI(S, handlers); ui.renderRuns(S); ui.setSpeedChip(S.speed);
  S.earth.scene.preRender.addEventListener(frame);
  setupPicking();
  if (params.get("lead")) S.lead = clamp(Number(params.get("lead")), meta.lead_min_h, meta.lead_max_h);
  if (params.get("lat") && params.get("lon")) S.site = { lat: Number(params.get("lat")), lon: Number(params.get("lon")) };
  S.speed = Number(params.get("speed")) || S.speed; ui.setSpeedChip(S.speed);
  await loadCase();
  if (params.get("cam")) handlers.setCam(params.get("cam"));
  if (params.get("t")) S.t = clamp(Number(params.get("t")), 0, 1) * S.tEnd;
  if (params.get("play")) { S.playing = true; ui.setPlaying(true); }
  if (params.get("select")) handlers.select(Number(params.get("select")));
  if (params.get("follow")) handlers.follow(Number(params.get("follow")));
})();
