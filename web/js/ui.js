// The interface: cards, the launch-time picker, the transport bar and the details drawer. Pure DOM; the app state and
// the actions live in main.js and are passed in as `h` (handlers).
import { $, bearingDeg, clamp, clockText, compass, daylight, kmBetween, local, localDayKey, localHour, sunElevation, tempGradientCss, utcText } from "./util.js";
import { bindTimeline } from "./timeline.js";
import { CITIES } from "./earth.js";

const PRESETS = [["Austin", 30.267, -97.743], ["Round Rock", 30.508, -97.679], ["Georgetown", 30.633, -97.677], ["Bastrop", 30.110, -97.315],
  ["San Marcos", 29.883, -97.941], ["Burnet", 30.758, -98.228]];

export function nearestPlace(lat, lon) {
  let best = null;
  for (const [name, la, lo] of CITIES) { const d = kmBetween(lat, lon, la, lo); if (!best || d < best.d) best = { name, d, b: bearingDeg(la, lo, lat, lon) }; }
  return best;
}
export const fmtLat = (v) => `${Math.abs(v).toFixed(3)}°${v >= 0 ? "N" : "S"}`;
export const fmtLon = (v) => `${Math.abs(v).toFixed(3)}°${v >= 0 ? "E" : "W"}`;

let toastTimer;
export function toast(msg, ms = 6000) {
  const el = $("toast"); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
export function setLoading(on, text) { $("loading").hidden = !on; if (text) $("loadingText").textContent = text; }
export function setPlaying(on) {
  $("playIcon").innerHTML = on ? '<path d="M5 3.5h3.6v13H5zM11.4 3.5H15v13h-3.6z" fill="currentColor"/>' : '<path d="M6 3.5l11 6.5-11 6.5z" fill="currentColor"/>';
}

export function initUI(S, h) {
  $("legendBar").style.background = tempGradientCss();
  // presets
  $("presets").innerHTML = PRESETS.map(([n, la, lo]) => `<button data-la="${la}" data-lo="${lo}">${n}</button>`).join("");
  $("presets").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) h.setSite(Number(b.dataset.la), Number(b.dataset.lo)); });
  $("pickBtn").addEventListener("click", () => h.togglePick());
  // time
  $("prevHour").addEventListener("click", () => h.setLead(S.lead - 1));
  $("nextHour").addEventListener("click", () => h.setLead(S.lead + 1));
  $("runSelect").addEventListener("change", (e) => h.setRun(e.target.value));
  const strip = $("strip");
  strip.addEventListener("pointerdown", (e) => { strip.setPointerCapture(e.pointerId); strip.dataset.drag = "1"; stripPick(S, h, e); });
  strip.addEventListener("pointermove", (e) => { if (strip.dataset.drag) stripPick(S, h, e); });
  strip.addEventListener("pointerup", () => { delete strip.dataset.drag; });
  // transport
  $("playBtn").addEventListener("click", () => h.togglePlay());
  $("restartBtn").addEventListener("click", () => h.seek(0));
  $("speeds").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { h.setSpeed(Number(b.dataset.speed)); setSpeedChip(Number(b.dataset.speed)); } });
  bindTimeline($("chart"), S, h);
  $("toggleUI").addEventListener("click", () => {
    const hidden = document.body.classList.toggle("ui-hidden");
    const label = hidden ? "Show UI" : "Hide UI";
    $("toggleUI").setAttribute("aria-label", label);
    $("toggleUI").title = label;
    $("toggleUI").setAttribute("aria-pressed", String(hidden));
    for (const id of ["left", "legend", "details", "hud"]) $(id).inert = hidden;
  });
  // cameras, drawer, layers
  $("camModes").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b?.dataset.cam) h.setCam(b.dataset.cam); });
  $("stopFollow").addEventListener("click", () => h.follow(-1));
  $("detailsClose").addEventListener("click", () => h.select(null));
  $("dFollow").addEventListener("click", () => { if (S.selected != null) h.follow(S.follow === S.selected ? -1 : S.selected); });
  document.querySelectorAll("#cardLayers h2.toggle").forEach((t) => t.addEventListener("click", () => t.parentElement.classList.toggle("collapsed")));
  for (const id of ["lyWind", "lyClouds", "lyDots", "lyRings"]) $(id).addEventListener("change", () => h.layers());
  $("exag").addEventListener("input", (e) => { $("exagOut").textContent = `${Number(e.target.value).toFixed(1)}x`; h.exaggeration(Number(e.target.value)); });
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); h.togglePlay(); }
    else if (e.code === "ArrowLeft" && S.cam !== "balloon") { e.preventDefault(); h.setLead(S.lead - 1); }
    else if (e.code === "ArrowRight" && S.cam !== "balloon") { e.preventDefault(); h.setLead(S.lead + 1); }
  });
}
export function setSpeedChip(v) { document.querySelectorAll("#speeds button").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === v)); }
export function setCamChip(mode) { document.querySelectorAll("#camModes button").forEach((b) => b.classList.toggle("on", b.dataset.cam === mode)); document.body.classList.toggle("balloon-cam", mode === "balloon"); $("hud").hidden = mode !== "balloon"; }
export function setPicking(on) { $("pickBtn").classList.toggle("picking", on); $("pickBtn").querySelector("span").textContent = on ? "Click the map..." : "Pick on the map"; $("pickHint").hidden = !on; document.body.classList.toggle("picking", on); }
export function setFollowing(k) {
  $("stopFollow").hidden = k < 0;
  $("stopFollow").title = k < 0 ? "Stop following" : `Stop following possible flight ${k + 1}`;
}

/* ---- launch site and outcome ---- */
export function renderSite(S) {
  const m = S.data.meta, p = nearestPlace(m.launch.lat, m.launch.lon);
  $("siteName").textContent = p.d < 4 ? p.name : `${p.d.toFixed(0)} km ${compass(p.b)} of ${p.name}`;
  $("siteCoords").textContent = `${fmtLat(m.launch.lat)}  ${fmtLon(m.launch.lon)}  ·  ${Math.round(m.launch.ground_m)} m above sea level`;
}
export function renderOutcome(S) {
  const m = S.data.meta, d = S.data;
  $("r50").textContent = m.r50_km.toFixed(1); $("r90").textContent = m.r90_km.toFixed(1);
  const la = d.nominal.lat.at(-1), lo = d.nominal.lon.at(-1), dist = kmBetween(m.launch.lat, m.launch.lon, la, lo);
  $("drift").textContent = dist.toFixed(0); $("driftDir").textContent = `toward ${compass(bearingDeg(m.launch.lat, m.launch.lon, la, lo))}`;
  $("situation").textContent = `Forecast ${m.lead_h.toFixed(0)} h ahead. Ensemble wind spread ${m.spread_ms.toFixed(1)} m/s; ${Math.round(m.flight_time_s / 60)} minute flight. ` +
    `${m.n} possible flights simulated.`;
  const w = $("warn");
  if (m.left_domain_nominal || m.left_domain_count > 0) {
    w.hidden = false;
    w.textContent = m.left_domain_nominal ? "This flight leaves the forecast area. Beyond the edge the simulator can only repeat the edge winds, so treat the landing as unreliable."
      : `${m.left_domain_count} of ${m.n} possible flights leave the forecast area; their landings are less reliable.`;
  } else w.hidden = true;
}

/* ---- launch time: big readout, date chips, a strip shaded by the real sun, hour stepping ---- */
const STRIP = { x0: 8, x1: 312 };
export function launchDate(S, lead) { return new Date(Date.parse(S.run + "T12:00:00Z") + lead * 3600000); }
export function renderTimeCard(S) {
  const when = launchDate(S, S.lead), l = local(when);
  $("launchBig").textContent = `${l.weekday}, ${l.month} ${l.day} · ${l.hour}:${l.minute} ${l.dayPeriod} ${l.timeZoneName}`;
  $("launchSmall").textContent = `Launch ${utcText(when)} \u00b7 GFS ${S.run} 12Z \u00b7 +${S.lead}h`;
  const days = new Map();
  for (let ld = S.region.lead_min_h; ld <= S.region.lead_max_h; ld++) { const k = localDayKey(launchDate(S, ld)); if (!days.has(k)) days.set(k, []); days.get(k).push(ld); }
  const cur = localDayKey(when), box = $("dateChips");
  box.innerHTML = "";
  for (const [k, leads] of days) {
    const l0 = local(launchDate(S, leads[0])), b = document.createElement("button");
    b.innerHTML = `${l0.weekday}<b>${l0.day}</b>`; b.classList.toggle("on", k === cur);
    b.addEventListener("click", () => S.handlers.setLead(leads.reduce((a, ld) => Math.abs(localHour(launchDate(S, ld)) - 9) < Math.abs(localHour(launchDate(S, a)) - 9) ? ld : a, leads[0])));
    box.appendChild(b);
  }
  $("hourCount").textContent = `${S.lead - S.region.lead_min_h + 1} / ${S.region.lead_max_h - S.region.lead_min_h + 1}`;
  drawStrip(S);
}
function drawStrip(S) {
  const svg = $("strip"), t0 = launchDate(S, S.region.lead_min_h).getTime(), t1 = launchDate(S, S.region.lead_max_h).getTime();
  STRIP.t0 = t0; STRIP.t1 = t1;
  const x = (ms) => STRIP.x0 + ((ms - t0) / (t1 - t0)) * (STRIP.x1 - STRIP.x0), lat = S.site.lat, lon = S.site.lon;
  let html = "";
  for (let ms = t0; ms < t1; ms += 15 * 60000) {
    const el = sunElevation(new Date(ms + 7.5 * 60000), lat, lon), cls = el > 0 ? "day" : el > -6 ? "twilight" : "night";
    html += `<rect class="${cls}" x="${x(ms).toFixed(1)}" y="4" width="${(x(ms + 15 * 60000) - x(ms) + 0.4).toFixed(1)}" height="30" rx="0"/>`;
  }
  for (let ms = Math.ceil(t0 / 3600000) * 3600000; ms <= t1; ms += 3600000) {
    const h = localHour(new Date(ms));
    if (h === 0) {
      html += `<line class="grid" x1="${x(ms).toFixed(1)}" y1="4" x2="${x(ms).toFixed(1)}" y2="34"/>`;
      html += `<text class="lbl" x="${x(ms + 12 * 3600000).toFixed(1)}" y="46" text-anchor="middle">${local(new Date(ms + 12 * 3600000)).weekday}</text>`;
    } else if (h % 6 === 0) html += `<line class="grid" x1="${x(ms).toFixed(1)}" y1="28" x2="${x(ms).toFixed(1)}" y2="34"/>`;
  }
  const mx = x(launchDate(S, S.lead).getTime());
  html += `<line class="mark" x1="${mx}" y1="0" x2="${mx}" y2="38"/><circle class="dot" cx="${mx}" cy="35" r="5.5"/>`;
  svg.innerHTML = html;
}
function stripPick(S, h, ev) {
  const r = $("strip").getBoundingClientRect(), vx = (ev.clientX - r.left) / r.width * 320;
  const ms = STRIP.t0 + clamp((vx - STRIP.x0) / (STRIP.x1 - STRIP.x0), 0, 1) * (STRIP.t1 - STRIP.t0);
  const lead = Math.round((ms - Date.parse(S.run + "T12:00:00Z")) / 3600000);
  if (lead !== S.lead) h.setLead(lead);
}
export function renderRuns(S) {
  $("runSelect").innerHTML = S.runs.map((d) => `<option value="${d}">${d.slice(5)}</option>`).join("");
  $("runSelect").value = S.run;
}

/* ---- transport: altitude chart and readouts ---- */
export function renderChart(S) {
  const svg = $("chart"), d = S.data, X0 = 30, W = 320, Y0 = 6, H = 40, x = (t) => X0 + (t / S.tEnd) * W, y = (a) => Y0 + H - (a / 14000) * H;
  const pts = d.t_s.map((t, i) => `${x(t).toFixed(1)},${y(d.alt_m[i]).toFixed(1)}`);
  let html = `<line class="axis" x1="${X0}" y1="${Y0 + H}" x2="${X0 + W}" y2="${Y0 + H}"/>`;
  for (const a of [0, 7, 14]) html += `<text class="tick" x="${X0 - 5}" y="${y(a * 1000) + 3}" text-anchor="end">${a} km</text>`;
  for (const f of [0, 0.5, 1]) html += `<text class="tick" x="${X0 + f * W}" y="${Y0 + H + 13}" text-anchor="${f === 0 ? "start" : f === 1 ? "end" : "middle"}">${Math.round(f * S.tEnd / 60)} min</text>`;
  html += `<path class="area" d="M${x(0)},${y(0)} L${pts.join(" L")} L${x(S.tEnd)},${y(0)} Z"/><path class="line" d="M${pts.join(" L")}"/>`;
  html += `<line id="chartCursor" class="cursor" x1="${X0}" y1="${Y0}" x2="${X0}" y2="${Y0 + H}"/>`;
  svg.innerHTML = html;
}
let lastText = {};
function setText(id, t) { if (lastText[id] !== t) { lastText[id] = t; $(id).textContent = t; } }
export function resetReadouts() { lastText = {}; }
export function updateReadouts(S, st) {
  setText("rTime", `T+${String(Math.floor(S.t / 60)).padStart(2, "0")}:${String(Math.floor(S.t % 60)).padStart(2, "0")}`);
  setText("rAlt", `${(st.alt / 1000).toFixed(1)} km`);
  setText("rVert", `${st.vert >= 0 ? "+" : ""}${st.vert.toFixed(1)} m/s`);
  setText("rSpeed", `${st.side.toFixed(0)} km/h`);
  setText("rDist", `${st.dist.toFixed(1)} km`);
  $("chart").setAttribute("aria-valuenow", (S.t / S.tEnd * 100).toFixed(1));
  $("chart").setAttribute("aria-valuetext", `${Math.round(S.t / 60)} of ${Math.round(S.tEnd / 60)} minutes`);
  const cur = $("chartCursor"); if (cur) { const x = 30 + (S.t / S.tEnd) * 320; cur.setAttribute("x1", x); cur.setAttribute("x2", x); }
  const date = new Date(Date.parse(S.data.meta.launch_time_utc) + S.t * 1000), l = local(date);
  const el = st.sunEl, phase = el > 0 ? "day" : el > -6 ? "twilight" : "night";
  setText("timeText", `${l.weekday} ${l.month} ${l.day} · ${l.hour}:${l.minute}:${l.second} ${l.dayPeriod} ${l.timeZoneName}`);
  $("sunGlyph").className = phase === "day" ? "" : phase;
  setText("hudAlt", `ALT ${st.alt < 1000 ? Math.round(st.alt) + " m" : (st.alt / 1000).toFixed(2) + " km"}`);
  setText("hudVert", `${st.vert >= 0 ? "↑" : "↓"} ${Math.abs(st.vert).toFixed(1)} m/s`);
  if (st.heading != null) setText("hudHdg", `${compass(st.heading)} ${Math.round(st.heading)}°`);
}

/* ---- details drawer for a selected possible flight ---- */
export function showDetails(S, k, info) {
  $("details").hidden = false;
  $("dTitle").textContent = `Possible flight ${k + 1}`;
  $("dSub").textContent = `One of ${S.data.meta.n} flights simulated with different wind errors.`;
  const rows = [
    ["Lands at", `${fmtLat(info.lat)} ${fmtLon(info.lon)}`],
    ["Ground height there", info.elev == null ? "..." : `${Math.round(info.elev)} m`],
    ["From launch", `${info.fromLaunch.toFixed(1)} km ${compass(info.bearing)}`],
    ["From forecast landing", `${info.fromNominal.toFixed(1)} km`],
    ["Closer to forecast than", `${info.rank} of ${S.data.meta.n - 1}`],
    ["Inside the rings", info.fromNominal <= S.data.meta.r50_km ? "50% ring" : info.fromNominal <= S.data.meta.r90_km ? "90% ring" : "outside both"],
  ];
  if (info.leftDomain) rows.push(["Forecast area", "flight leaves it"]);
  $("dList").innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("");
  $("dFollow").textContent = S.follow === k ? "Stop following" : "Follow this balloon";
}
export function hideDetails() { $("details").hidden = true; }
export function updateDetailsElevation(elev) { const dd = $("dList").children[3]; if (dd) dd.textContent = `${Math.round(elev)} m`; }
