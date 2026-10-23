// Small shared helpers: math, time zones and the sun, and the temperature colour ramp.
export const KM_PER_DEG = 111.195;
export const EARTH_R = 6371000;
export const TZ = "America/Chicago";            // Austin: times are shown in local time and UTC
export const $ = (id) => document.getElementById(id);

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const rad = (d) => d * Math.PI / 180;
export const deg = (r) => r * 180 / Math.PI;

export function kmBetween(lat0, lon0, lat1, lon1) {
  return Math.hypot((lon1 - lon0) * KM_PER_DEG * Math.cos(rad(lat0)), (lat1 - lat0) * KM_PER_DEG);
}
export function bearingDeg(lat0, lon0, lat1, lon1) {      // compass bearing from point 0 to point 1, degrees clockwise from north
  return (deg(Math.atan2((lon1 - lon0) * Math.cos(rad(lat0)), lat1 - lat0)) + 360) % 360;
}
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const compass = (b) => COMPASS[Math.round(b / 22.5) % 16];

export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- bracketing in a sorted array: index i and fraction f with arr[i] <= x <= arr[i+1]
export function bracket(arr, x) {
  let lo = 0, hi = arr.length - 1;
  if (x <= arr[0]) return [0, 0];
  if (x >= arr[hi]) return [hi - 1, 1];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (arr[mid] <= x) lo = mid; else hi = mid; }
  return [lo, (x - arr[lo]) / (arr[hi] - arr[lo])];
}

// ---- local time (Austin) and the sun
const fmtParts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric",
  minute: "2-digit", second: "2-digit", timeZoneName: "short", hourCycle: "h12" });
const fmtHour = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
const fmtDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export function local(date) { const o = {}; fmtParts.formatToParts(date).forEach((p) => { o[p.type] = p.value; }); return o; }
export const localHour = (date) => Number(fmtHour.format(date)) % 24;
export const localDayKey = (date) => fmtDay.format(date);
export const utcText = (date) => `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
export function clockText(date) { const l = local(date); return `${l.hour}:${l.minute} ${l.dayPeriod} ${l.timeZoneName}`; }

// Sun position (NOAA-style approximation, good to about half a degree): elevation and azimuth in degrees.
export function sunPosition(date, lat, lon) {
  const r = Math.PI / 180, d = date.getTime() / 86400000 - 10957.5;      // days since J2000
  const q = (280.460 + 0.9856474 * d) % 360, g = ((357.528 + 0.9856003 * d) % 360) * r;
  const lam = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * r, eps = 23.439 * r;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam)), ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const ha = (((18.697374558 + 24.06570982441908 * d) % 24) * 15 + lon) * r - ra;
  const sinEl = Math.sin(lat * r) * Math.sin(dec) + Math.cos(lat * r) * Math.cos(dec) * Math.cos(ha);
  const el = Math.asin(sinEl);
  const az = Math.atan2(-Math.cos(dec) * Math.sin(ha), Math.sin(dec) * Math.cos(lat * r) - Math.cos(dec) * Math.sin(lat * r) * Math.cos(ha));
  return { el: el / r, az: (az / r + 360) % 360 };
}
export const sunElevation = (date, lat, lon) => sunPosition(date, lat, lon).el;
/** 0 at night (sun below -6 degrees) to 1 in full day (above 12 degrees). */
export const daylight = (elDeg) => smoothstep(-6, 12, elDeg);

// Fixed cool-to-warm scale: blue/neutral/orange with lightness variation and a fixed freezing reference.
const TEMP_STOPS = [[-70, [0.08, 0.22, 0.42]], [-50, [0.14, 0.38, 0.64]], [-30, [0.32, 0.57, 0.77]],
  [-10, [0.65, 0.8, 0.9]], [0, [0.96, 0.96, 0.94]], [10, [0.99, 0.84, 0.62]],
  [20, [0.93, 0.60, 0.30]], [30, [0.80, 0.35, 0.12]], [40, [0.55, 0.20, 0.06]]];
export function tempColor(tC, out = [0, 0, 0]) {
  const s = TEMP_STOPS;
  if (tC <= s[0][0]) { out[0] = s[0][1][0]; out[1] = s[0][1][1]; out[2] = s[0][1][2]; return out; }
  for (let i = 1; i < s.length; i++) {
    if (tC <= s[i][0]) {
      const f = (tC - s[i - 1][0]) / (s[i][0] - s[i - 1][0]), a = s[i - 1][1], b = s[i][1];
      out[0] = a[0] + (b[0] - a[0]) * f; out[1] = a[1] + (b[1] - a[1]) * f; out[2] = a[2] + (b[2] - a[2]) * f; return out;
    }
  }
  const e = s[s.length - 1][1]; out[0] = e[0]; out[1] = e[1]; out[2] = e[2]; return out;
}
// Shared by the rendered wind and its legend: avoid showing an untinted key for tinted particles.
export function windColor(tC, out = [0, 0, 0]) {
  tempColor(tC, out); for (let i = 0; i < 3; i++) out[i] = out[i] * 0.55 + 0.45;
  return out;
}
export function tempGradientCss() {
  const lo = -60, hi = 40, stops = [];
  for (let t = lo; t <= hi; t += 10) {
    const c = windColor(t).map(v => Math.round(v * 255));
    stops.push(`rgb(${c.join(",")}) ${((t - lo) / (hi - lo) * 100).toFixed(0)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

// ---- the forecast grid exported with each case: sample u, v, temperature, humidity anywhere inside it
export class Grid {
  constructor(g, lat0, lon0) {
    this.g = g; this.lat0 = lat0; this.lon0 = lon0;
    this.nz = g.alt_m.length; this.ny = g.lat.length; this.nx = g.lon.length;
    this.dz = g.alt_m[1] - g.alt_m[0]; this.dlat = g.lat[1] - g.lat[0]; this.dlon = g.lon[1] - g.lon[0];
    const flat = (a) => Float32Array.from(a.flat(2));
    this.u = flat(g.u); this.v = flat(g.v); this.t = flat(g.t); this.rh = flat(g.rh);
    // Reused by the synchronous particle sampler: avoid two allocations per particle per frame.
    this.weights = new Float64Array(8); this.offsets = new Int32Array(8);
    this.cosLat = Math.cos(rad(lat0));
    this.eMin = (g.lon[0] - lon0) * 111195 * this.cosLat; this.eMax = (g.lon.at(-1) - lon0) * 111195 * this.cosLat;
    this.nMin = (g.lat[0] - lat0) * 111195; this.nMax = (g.lat.at(-1) - lat0) * 111195;
    this.zMax = g.alt_m.at(-1);
  }
  /** Trilinear sample of one field at geographic position; out gets (u, v, t, rh). */
  at(lat, lon, alt, out) {
    const fy = clamp((lat - this.g.lat[0]) / this.dlat, 0, this.ny - 1.001), fx = clamp((lon - this.g.lon[0]) / this.dlon, 0, this.nx - 1.001);
    const fz = clamp(alt / this.dz, 0, this.nz - 1.001);
    const z = fz | 0, y = fy | 0, x = fx | 0, tz = fz - z, ty = fy - y, tx = fx - x, nx = this.nx, ny = this.ny, s = nx * ny;
    const i0 = z * s + y * nx + x;
    const w = this.weights, o = this.offsets;
    w[0] = (1 - tz) * (1 - ty) * (1 - tx); w[1] = (1 - tz) * (1 - ty) * tx;
    w[2] = (1 - tz) * ty * (1 - tx); w[3] = (1 - tz) * ty * tx;
    w[4] = tz * (1 - ty) * (1 - tx); w[5] = tz * (1 - ty) * tx;
    w[6] = tz * ty * (1 - tx); w[7] = tz * ty * tx;
    o[0] = i0; o[1] = i0 + 1; o[2] = i0 + nx; o[3] = i0 + nx + 1;
    o[4] = i0 + s; o[5] = i0 + s + 1; o[6] = i0 + s + nx; o[7] = i0 + s + nx + 1;
    let u = 0, v = 0, t = 0, rh = 0;
    for (let k = 0; k < 8; k++) { u += this.u[o[k]] * w[k]; v += this.v[o[k]] * w[k]; t += this.t[o[k]] * w[k]; rh += this.rh[o[k]] * w[k]; }
    out[0] = u; out[1] = v; out[2] = t; out[3] = rh; return out;
  }
}
