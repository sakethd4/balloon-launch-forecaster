// The globe: real 3D terrain (free AWS elevation tiles), satellite imagery with shaded relief baked in, camera limits
// that keep the user inside the region we have forecasts for, and a dimmed mask outside it.
import { clamp, deg, rad, smoothstep } from "./util.js";

const C = window.Cesium;
const ESRI = "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const DEM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";   // height_m = R*256 + G + B/256 - 32768
const DEM_MAX_Z = 14;
export const MAX_CAMERA_HEIGHT = 560e3;                   // never zoom out further than this, so everything can always render
export const CITIES = [
  ["Austin", 30.267, -97.743], ["San Antonio", 29.424, -98.494], ["Houston", 29.760, -95.370], ["Dallas", 32.777, -96.797],
  ["Fort Worth", 32.755, -97.331], ["Waco", 31.549, -97.147], ["Corpus Christi", 27.801, -97.396], ["Midland", 32.000, -102.078],
  ["Del Rio", 29.363, -100.897], ["Shreveport", 32.525, -93.750], ["Lake Charles", 30.226, -93.217], ["Abilene", 32.449, -99.733],
  ["Laredo", 27.506, -99.507], ["Victoria", 28.805, -97.003], ["College Station", 30.628, -96.334], ["Killeen", 31.117, -97.728],
  ["San Angelo", 31.464, -100.437], ["Beaumont", 30.080, -94.127], ["Tyler", 32.351, -95.301], ["Round Rock", 30.508, -97.679],
  ["San Marcos", 29.883, -97.941], ["New Braunfels", 29.703, -98.124], ["Temple", 31.098, -97.343], ["Odessa", 31.845, -102.368],
  ["Bastrop", 30.110, -97.315], ["Georgetown", 30.633, -97.677], ["Lockhart", 29.885, -97.670], ["Burnet", 30.758, -98.228],
];

/* ---------- elevation tiles ---------- */
const demCache = new Map();
export function demTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (demCache.has(key)) { const p = demCache.get(key); demCache.delete(key); demCache.set(key, p); return p; }
  const p = (async () => {
    const r = await fetch(DEM.replace("{z}", z).replace("{x}", x).replace("{y}", y));
    if (!r.ok) return null;
    const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
    const cv = new OffscreenCanvas(256, 256), ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, 256, 256).data, h = new Float32Array(256 * 256);
    for (let i = 0; i < h.length; i++) h[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
    return h;
  })().catch(() => null);
  demCache.set(key, p);
  if (demCache.size > 700) demCache.delete(demCache.keys().next().value);
  return p;
}
const lonToX = (lon, z) => (lon + 180) / 360 * 2 ** z;
const latToY = (lat, z) => (1 - Math.asinh(Math.tan(rad(lat))) / Math.PI) / 2 * 2 ** z;

/** Ground height (m above sea level) at a point, from the same tiles the terrain mesh uses. */
export async function elevationAt(lat, lon, z = 12) {
  const fx = lonToX(lon, z), fy = latToY(lat, z), tx = Math.floor(fx), ty = Math.floor(fy);
  const t = await demTile(z, tx, ty);
  if (!t) return 0;
  const px = clamp((fx - tx) * 256 - 0.5, 0, 254.999), py = clamp((fy - ty) * 256 - 0.5, 0, 254.999);
  const x0 = Math.floor(px), y0 = Math.floor(py), a = px - x0, b = py - y0;
  const h = (xx, yy) => t[yy * 256 + xx];
  return Math.max(0, (h(x0, y0) * (1 - a) + h(x0 + 1, y0) * a) * (1 - b) + (h(x0, y0 + 1) * (1 - a) + h(x0 + 1, y0 + 1) * a) * b);
}

function terrainProvider() {
  const tiling = new C.GeographicTilingScheme();
  return new C.CustomHeightmapTerrainProvider({
    width: 65, height: 65, tilingScheme: tiling,
    callback: async (x, y, level) => {
      const out = new Float32Array(65 * 65);
      if (level < 4) return out;
      const r = tiling.tileXYToRectangle(x, y, level);
      const W = deg(r.west), E = deg(r.east), S = deg(r.south), N = deg(r.north), z = Math.min(DEM_MAX_Z, level + 1);
      const x0 = Math.floor(lonToX(W, z)), x1 = Math.floor(lonToX(E, z) - 1e-9), y0 = Math.floor(latToY(N, z)), y1 = Math.floor(latToY(S, z) - 1e-9);
      const need = [];
      for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) need.push([tx, ty]);
      const tiles = new Map();
      await Promise.all(need.map(async ([tx, ty]) => tiles.set(tx + "," + ty, await demTile(z, tx, ty))));
      for (let j = 0; j < 65; j++) {
        const lat = N - (N - S) * j / 64, fy = latToY(lat, z);
        for (let i = 0; i < 65; i++) {
          const fx = lonToX(W + (E - W) * i / 64, z), tx = Math.min(Math.floor(fx), x1), ty = Math.min(Math.floor(fy), y1), t = tiles.get(tx + "," + ty);
          if (!t) continue;
          const px = clamp((fx - tx) * 256 - 0.5, 0, 254.999), py = clamp((fy - ty) * 256 - 0.5, 0, 254.999);
          const xi = Math.floor(px), yi = Math.floor(py), a = px - xi, b = py - yi;
          const h = (u, v) => t[v * 256 + u];
          out[j * 65 + i] = Math.max(0, (h(xi, yi) * (1 - a) + h(xi + 1, yi) * a) * (1 - b) + (h(xi, yi + 1) * (1 - a) + h(xi + 1, yi + 1) * a) * b);
        }
      }
      return out;
    },
  });
}

/* ---------- satellite imagery with shaded relief (multiplied in, so hills read in 3D) ---------- */
async function reliefTile(x, y, level) {
  if (level < 8) return null;
  const z = Math.min(level, DEM_MAX_Z), d = level - z;
  const dem = await demTile(z, x >> d, y >> d);
  if (!dem) return null;
  let h = dem;
  if (d > 0) {                                                  // deeper than the DEM: stretch the matching sub-block
    const size = 256 >> d, ox = (x & ((1 << d) - 1)) * size, oy = (y & ((1 << d) - 1)) * size;
    h = new Float32Array(256 * 256);
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const sx = ox + (i + 0.5) / 256 * size - 0.5, sy = oy + (j + 0.5) / 256 * size - 0.5;
      const x0 = clamp(Math.floor(sx), 0, 254), y0 = clamp(Math.floor(sy), 0, 254), a = clamp(sx - x0, 0, 1), b = clamp(sy - y0, 0, 1);
      h[j * 256 + i] = (dem[y0 * 256 + x0] * (1 - a) + dem[y0 * 256 + x0 + 1] * a) * (1 - b) + (dem[(y0 + 1) * 256 + x0] * (1 - a) + dem[(y0 + 1) * 256 + x0 + 1] * a) * b;
    }
  }
  const lat = deg(Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / 2 ** level)))), mpp = 156543.03392 * Math.cos(rad(lat)) / 2 ** level;
  const E = 2.2, zen = rad(90 - 38), az = rad(315), out = new Float32Array(256 * 256), flat = Math.cos(zen);
  for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
    const l = h[j * 256 + Math.max(i - 1, 0)], r = h[j * 256 + Math.min(i + 1, 255)], u = h[Math.max(j - 1, 0) * 256 + i], dn = h[Math.min(j + 1, 255) * 256 + i];
    const dzdx = E * (r - l) / (2 * mpp), dzdy = E * (u - dn) / (2 * mpp);
    const slope = Math.atan(Math.hypot(dzdx, dzdy)), asp = Math.atan2(dzdy, -dzdx);
    const hs = flat * Math.cos(slope) + Math.sin(zen) * Math.sin(slope) * Math.cos(az - asp);
    out[j * 256 + i] = clamp(1 + 1.25 * (hs - flat), 0.55, 1.4);
  }
  return out;
}
function reliefImagery() {
  const base = new C.UrlTemplateImageryProvider({ url: ESRI, maximumLevel: 18, credit: "Imagery: Esri, Maxar, Earthstar Geographics. Elevation: Mapzen/AWS Terrain Tiles" });
  const orig = base.requestImage.bind(base);
  base.requestImage = async function (x, y, level, request) {
    const img = await orig(x, y, level, request);
    if (!img) return img;
    const shade = await reliefTile(x, y, level).catch(() => null);
    if (!shade) return img;
    const cv = document.createElement("canvas"); cv.width = cv.height = 256;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 256, 256);
    const id = ctx.getImageData(0, 0, 256, 256), d = id.data;
    for (let i = 0, k = 0; i < shade.length; i++, k += 4) {
      const m = shade[i];
      d[k] = Math.min(255, d[k] * m); d[k + 1] = Math.min(255, d[k + 1] * m); d[k + 2] = Math.min(255, d[k + 2] * m);
    }
    ctx.putImageData(id, 0, 0);
    return cv;
  };
  return base;
}

/* ---------- the globe ---------- */
export function createEarth(region) {
  const viewer = new C.Viewer("globe", {
    terrainProvider: terrainProvider(),
    baseLayer: new C.ImageryLayer(reliefImagery()),
    baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false,
    animation: false, timeline: false, infoBox: false, selectionIndicator: false, fullscreenButton: false,
    shouldAnimate: false, msaaSamples: 4,
  });
  const scene = viewer.scene, camera = viewer.camera, ctrl = scene.screenSpaceCameraController;
  viewer.clock.clockRange = C.ClockRange.CLAMPED;
  scene.verticalExaggeration = 1.8;
  scene.globe.depthTestAgainstTerrain = true;
  scene.globe.maximumScreenSpaceError = 1.6;
  scene.globe.enableLighting = false;                    // day and night are set by us (see setDaylight)
  scene.globe.showGroundAtmosphere = true;
  scene.skyAtmosphere.show = true;
  scene.sun.show = true; scene.moon.show = true;
  scene.fog.enabled = true; scene.fog.density = 0.00014; scene.fog.minimumBrightness = 0.05;
  scene.postProcessStages.fxaa.enabled = true;
  ctrl.maximumZoomDistance = MAX_CAMERA_HEIGHT; ctrl.minimumZoomDistance = 40; ctrl.enableCollisionDetection = true;
  ctrl.inertiaZoom = 0.7; ctrl.inertiaSpin = 0.85; ctrl.inertiaTranslate = 0.85;
  viewer.cesiumWidget.creditContainer.style.cssText = "position:fixed;right:10px;bottom:3px;z-index:3;max-width:46vw;text-align:right";

  // dim everything outside the forecast region, with a thin edge line, so the user can see where the data ends
  const d = region.domain, big = 30, dim = C.Color.fromCssColorString("#06080c").withAlpha(0.62);
  const band = (w, s, e, n) => viewer.entities.add({ rectangle: { coordinates: C.Rectangle.fromDegrees(w, s, e, n), material: dim,
    classificationType: C.ClassificationType.TERRAIN } });
  band(d.lon_min - big, d.lat_min - big, d.lon_min, d.lat_max + big); band(d.lon_max, d.lat_min - big, d.lon_max + big, d.lat_max + big);
  band(d.lon_min, d.lat_max, d.lon_max, d.lat_max + big); band(d.lon_min, d.lat_min - big, d.lon_max, d.lat_min);
  viewer.entities.add({ polyline: { positions: C.Cartesian3.fromDegreesArray([d.lon_min, d.lat_min, d.lon_max, d.lat_min, d.lon_max, d.lat_max,
    d.lon_min, d.lat_max, d.lon_min, d.lat_min]), width: 2.5, clampToGround: true, material: C.Color.fromCssColorString("#9ad1ff").withAlpha(0.65) } });

  for (const [name, lat, lon] of CITIES) {
    if (lat < d.lat_min || lat > d.lat_max || lon < d.lon_min || lon > d.lon_max) continue;
    viewer.entities.add({ position: C.Cartesian3.fromDegrees(lon, lat), point: { pixelSize: 5, color: C.Color.WHITE.withAlpha(0.9),
      outlineColor: C.Color.BLACK.withAlpha(0.6), outlineWidth: 1, heightReference: C.HeightReference.CLAMP_TO_GROUND,
      distanceDisplayCondition: new C.DistanceDisplayCondition(18e3, 700e3), disableDepthTestDistance: 5e4 },
    label: { text: name, font: "600 12px Inter, system-ui, sans-serif", fillColor: C.Color.WHITE.withAlpha(0.95), outlineColor: C.Color.BLACK.withAlpha(0.75),
      outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(8, -4), horizontalOrigin: C.HorizontalOrigin.LEFT,
      heightReference: C.HeightReference.CLAMP_TO_GROUND, distanceDisplayCondition: new C.DistanceDisplayCondition(18e3, 700e3), disableDepthTestDistance: 5e4 } });
  }

  // keep the camera inside the region (a soft wall) and below the maximum height
  const slack = 0.35;
  scene.preRender.addEventListener(() => {
    if (viewer.trackedEntity || viewer.__boundsOff) return;
    const c = C.Cartographic.fromCartesian(camera.positionWC);
    const lat = clamp(deg(c.latitude), d.lat_min - slack, d.lat_max + slack), lon = clamp(deg(c.longitude), d.lon_min - slack, d.lon_max + slack);
    const h = Math.min(c.height, MAX_CAMERA_HEIGHT);
    if (lat !== deg(c.latitude) || lon !== deg(c.longitude) || h !== c.height)
      camera.setView({ destination: C.Cartesian3.fromDegrees(lon, lat, h), orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll } });
  });

  // Controller collision checks do not cover tracked entities or programmatic setView calls.
  function enforceClearance() {
    const c = C.Cartographic.fromCartesian(camera.positionWC);
    const terrain = scene.globe.getHeight(c) ?? 0;
    const reference = scene.verticalExaggerationRelativeHeight ?? 0;
    const floor = reference + (terrain - reference) * scene.verticalExaggeration + 2;
    if (c.height >= floor) return;
    c.height = floor;
    const corrected = C.Cartesian3.fromRadians(c.longitude, c.latitude, c.height);
    // Move in world coordinates while preserving the tracked camera's local transform and orientation.
    const delta = C.Cartesian3.subtract(corrected, camera.positionWC, new C.Cartesian3());
    const local = C.Matrix4.multiplyByPointAsVector(camera.inverseTransform, delta, new C.Cartesian3());
    C.Cartesian3.add(camera.position, local, camera.position);
  }
  return { viewer, scene, camera, enforceClearance, Cesium: C };
}

/** Night dims the imagery, sky and haze; day restores them. k in [0, 1]. */
export function setDaylight(earth, k, sunEl = 30) {
  const { viewer, scene } = earth, layer = viewer.imageryLayers.get(0);
  scene.skyBox.show = sunEl < 3;                          // no stars in the daytime sky
  layer.brightness = 0.26 + 0.74 * k; layer.saturation = 0.5 + 0.5 * k; layer.contrast = 1.0 + 0.06 * k;
  scene.skyAtmosphere.brightnessShift = -0.8 * (1 - k);
  scene.globe.atmosphereBrightnessShift = -0.8 * (1 - k);
  scene.fog.minimumBrightness = 0.015 + 0.05 * k;
}

/** Terrain-aware pick: geographic point under a window position, or null. */
export function pickGround(earth, pos) {
  const { scene, camera } = earth, ray = camera.getPickRay(pos);
  const p = ray && scene.globe.pick(ray, scene);
  if (!p) return null;
  const c = C.Cartographic.fromCartesian(p);
  return { lat: deg(c.latitude), lon: deg(c.longitude), height: c.height };
}
