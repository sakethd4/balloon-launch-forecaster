// Volumetric clouds. Cloud is placed where the forecast says the air is humid (relative humidity at every 500 m of height over
// the launch region), shaped by 3D noise, and lit by scattering from the real sun position. A shader marches a ray through the
// atmosphere for every pixel (at reduced resolution, then scaled up). The forecast gives humidity on a coarse grid; the
// fine structure of the clouds is generated, so their exact shapes are illustrative, but where and how thick they are follows the data.
import * as THREE from "three";
import { clamp, mulberry32, rad } from "./util.js";

import { cloudFade } from "./view-scale.js";
import { CLOUD_DEPTH_FAR } from "./depth-pass.js";

const params = new URLSearchParams(location.search);
const SCALE = Number(params.get("clouds")) || 0.5;          // render resolution of the cloud pass relative to the screen

function noiseTexture(size = 64) {
  // R: smooth value-noise fbm (the big shapes), G: inverted Worley fbm (billowy cauliflower detail). Tileable, so it can repeat.
  const rnd = mulberry32(1234), data = new Uint8Array(size * size * size * 4);
  const lattice = (f) => { const a = new Float32Array(f * f * f); for (let i = 0; i < a.length; i++) a[i] = rnd(); return a; };
  const value = (a, f, x, y, z) => {
    x *= f; y *= f; z *= f;
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), fx = x - xi, fy = y - yi, fz = z - zi;
    const s = (t) => t * t * (3 - 2 * t), sx = s(fx), sy = s(fy), sz = s(fz), w = (v) => ((v % f) + f) % f;
    const at = (i, j, k) => a[(w(k) * f + w(j)) * f + w(i)];
    const l = (a0, b0, t) => a0 + (b0 - a0) * t;
    return l(l(l(at(xi, yi, zi), at(xi + 1, yi, zi), sx), l(at(xi, yi + 1, zi), at(xi + 1, yi + 1, zi), sx), sy),
      l(l(at(xi, yi, zi + 1), at(xi + 1, yi, zi + 1), sx), l(at(xi, yi + 1, zi + 1), at(xi + 1, yi + 1, zi + 1), sx), sy), sz);
  };
  const points = (f) => { const p = new Float32Array(f * f * f * 3); for (let i = 0; i < p.length; i++) p[i] = rnd(); return p; };
  const worley = (p, f, x, y, z) => {
    x *= f; y *= f; z *= f;
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z); let best = 9;
    for (let k = -1; k <= 1; k++) for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = xi + i, cy = yi + j, cz = zi + k, wx = ((cx % f) + f) % f, wy = ((cy % f) + f) % f, wz = ((cz % f) + f) % f, o = ((wz * f + wy) * f + wx) * 3;
      const dx = cx + p[o] - x, dy = cy + p[o + 1] - y, dz = cz + p[o + 2] - z, d = dx * dx + dy * dy + dz * dz;
      if (d < best) best = d;
    }
    return 1 - Math.min(Math.sqrt(best), 1);
  };
  const v = [4, 8, 16].map((f) => [lattice(f), f]), wp = [3, 6, 12].map((f) => [points(f), f]);
  let idx = 0;
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, w = y / size, t = z / size;
    const fv = 0.55 * value(v[0][0], 4, u, w, t) + 0.3 * value(v[1][0], 8, u, w, t) + 0.15 * value(v[2][0], 16, u, w, t);
    const fw = 0.55 * worley(wp[0][0], 3, u, w, t) + 0.3 * worley(wp[1][0], 6, u, w, t) + 0.15 * worley(wp[2][0], 12, u, w, t);
    data[idx++] = Math.round(clamp(fv, 0, 1) * 255); data[idx++] = Math.round(clamp(fw, 0, 1) * 255); data[idx++] = 0; data[idx++] = 255;
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType; tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping; tex.unpackAlignment = 1; tex.needsUpdate = true;
  return tex;
}

const FRAG = `
precision highp float; precision highp sampler3D;
uniform sampler3D uRH, uNoise, uWeather;
uniform sampler2D uSceneDepth;
uniform float uDepthFar;
#include <packing>
uniform vec3 uCam, uRight, uUp, uDir, uSun, uSunCol, uAmbTop, uAmbBot;
uniform vec2 uGridMin, uGridSpan, uRes;
uniform float uTanY, uAspect, uTime, uZMax, uGround, uHMin, uHMax, uCover, uDensity, uOpacity;
varying vec2 vUv;
const float R_EARTH = 6371000.0;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float heightOf(vec3 p) { return p.z + (p.x * p.x + p.y * p.y) / (2.0 * R_EARTH); }
float coverage(vec3 p, float h) {
  float z = h / uZMax; if (z < 0.0 || z > 1.0) return 0.0;
  vec2 g = (p.xy - uGridMin) / uGridSpan;
  vec2 edge = smoothstep(vec2(0.0), vec2(0.12), g) * (1.0 - smoothstep(vec2(0.88), vec2(1.0), g));
  float rh = texture(uRH, vec3(g, z)).r;
  return smoothstep(0.74 - uCover, 0.985 - uCover * 0.5, rh) * edge.x * edge.y;
}
float density(vec3 p, float h, bool detail) {
  float base = coverage(p, h);
  if (base <= 0.0) return 0.0;
  vec3 q = (p + vec3(uTime * 7.0, uTime * 3.0, 0.0)) * vec3(1.0, 1.0, 2.0);
  // A separate non-repeating volume spans the entire forecast domain. Two fields morph slowly.
  vec3 weatherUV = vec3((p.xy - uGridMin + vec2(uTime * 7.0, uTime * 3.0)) / uGridSpan, h / uZMax * 0.4);
  vec2 fields = texture(uWeather, weatherUV).rg;
  float weather = mix(fields.r, fields.g, 0.5 + 0.5 * sin(uTime * 0.008));
  q += vec3(weather * 7200.0, weather * -5300.0, weather * 1800.0);
  vec2 n1 = texture(uNoise, q / 11000.0).rg;
  vec3 rotated = vec3(q.x * 0.8 + q.y * 0.6, q.y * 0.8 - q.x * 0.6, q.z);
  n1 = mix(n1, texture(uNoise, rotated / 17321.0 + vec3(0.31, 0.67, uTime * 0.0009)).rg, 0.45);
  base *= mix(0.85, 1.15, weather);
  // Humidity controls the fraction occupied by billows instead of making a uniform sheet.
  float shape = n1.r * 0.7 + n1.g * 0.3;
  float d = (shape - (0.52 - base * 0.28)) / 0.35;
  if (detail) { vec2 n2 = texture(uNoise, q / 2300.0).rg; d += (n2.g - 0.45) * 0.38 * (1.0 - base * 0.4); d -= (n2.r - 0.5) * 0.15; }
  float fadeTop = (1.0 - smoothstep(uHMax - 1500.0, uHMax, h)), fadeBot = smoothstep(uHMin, uHMin + 500.0, h);
  return clamp(d * 1.7, 0.0, 1.0) * fadeTop * fadeBot;
}
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
// Intersect the same curved height field used by density to avoid grazing-angle popping.
vec2 heightRoots(vec3 ro, vec3 rd, float height) {
  float a = dot(rd.xy, rd.xy) / (2.0 * R_EARTH);
  float b = rd.z + dot(ro.xy, rd.xy) / R_EARTH;
  float c = heightOf(ro) - height;
  if (a < 1e-12) {
    if (abs(b) < 1e-7) return c < 0.0 ? vec2(-2e7, 2e7) : vec2(2e7, -2e7);
    float t = -c / b;
    return b > 0.0 ? vec2(-2e7, t) : vec2(t, 2e7);
  }
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0) return vec2(2e7, -2e7);
  float q = -0.5 * (b + (b >= 0.0 ? 1.0 : -1.0) * sqrt(disc));
  float x = q / a, y = abs(q) > 1e-12 ? c / q : x;
  return vec2(min(x, y), max(x, y));
}
void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  vec3 rd = normalize(uDir + uRight * (uv.x * uTanY * uAspect) + uUp * (uv.y * uTanY));
  vec3 ro = uCam;
  vec2 outer = heightRoots(ro, rd, uHMax), inner = heightRoots(ro, rd, uHMin);
  float t0 = max(outer.x, 0.0), t1 = min(outer.y, 1500000.0);
  if (inner.x <= t0 && inner.y > t0) t0 = inner.y;
  else if (inner.x > t0) t1 = min(t1, inner.x);
  // Skip empty space outside the forecast grid before the expensive march.
  for (int axis = 0; axis < 2; axis++) {
    if (abs(rd[axis]) < 1e-7) {
      if (ro[axis] < uGridMin[axis] || ro[axis] > uGridMin[axis] + uGridSpan[axis]) { gl_FragColor = vec4(0.0); return; }
    } else {
      float a = (uGridMin[axis] - ro[axis]) / rd[axis];
      float b = (uGridMin[axis] + uGridSpan[axis] - ro[axis]) / rd[axis];
      t0 = max(t0, min(a, b)); t1 = min(t1, max(a, b));
    }
  }
  // Clip each ray to the balloon surface. Cloud behind it cannot wash over its silhouette.
  float objectDistance = unpackRGBAToDepth(texture2D(uSceneDepth, vUv)) * uDepthFar;
  t1 = min(t1, objectDistance);
  if (t1 <= t0) { gl_FragColor = vec4(0.0); return; }
  const int N = 96;
  float dt = (t1 - t0) / float(N);
  // Stable samples remove animated noise; animation comes from the cloud field itself.
  float t = t0 + dt * (0.35 + 0.3 * hash(gl_FragCoord.xy));
  vec3 col = vec3(0.0); float T = 1.0;
  float cosS = dot(rd, uSun), phase = mix(hg(cosS, 0.62), hg(cosS, -0.25), 0.3);
  for (int i = 0; i < N; i++) {
    if (t > t1 || T < 0.02) break;
    vec3 p = ro + rd * t; float h = heightOf(p);
    if (h < uGround + 150.0) break;                           // the ground ends the ray
    float d = density(p, h, true);
    if (d > 0.004) {
      float sigma = d * 0.0062 * uDensity, att = 0.0;
      for (int j = 1; j <= 3; j++) { vec3 pl = p + uSun * (140.0 * float(j) * float(j)); att += density(pl, heightOf(pl), false) * (140.0 * float(j) * float(j)); }
      float tau = att * 0.0062 * 0.33 * uDensity;
      vec3 sunL = uSunCol * exp(-tau) * (phase * 11.0 + 0.35) * (0.45 + 0.55 * (1.0 - exp(-2.0 * sigma * dt * 4.0)));
      float hn = clamp((h - uHMin) / (uHMax - uHMin), 0.0, 1.0);
      vec3 amb = mix(uAmbBot, uAmbTop, hn);
      float dT = exp(-sigma * dt), haze = exp(-t / 120000.0);
      col += T * (sunL + amb) * (1.0 - dT) * haze;
      T *= dT;
    }
    t += dt;
  }
  col = (1.0 - exp(-col / max(1.0 - T, 0.001) * 1.15)) * (1.0 - T);                                // soft tone map
  gl_FragColor = vec4(col, 1.0 - T) * uOpacity;                           // premultiplied
}`;

export function createClouds(S) {
  const O = S.overlay, renderer = O.renderer;
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.ShaderMaterial({
    glslVersion: null, depthTest: false, depthWrite: false,
    uniforms: { uSceneDepth: { value: O.depth.texture }, uDepthFar: { value: CLOUD_DEPTH_FAR }, uRH: { value: null }, uNoise: { value: null }, uWeather: { value: null }, uCam: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() },
      uDir: { value: new THREE.Vector3() }, uSun: { value: new THREE.Vector3(0, 0, 1) }, uSunCol: { value: new THREE.Color(1, 1, 1) }, uAmbTop: { value: new THREE.Color() }, uAmbBot: { value: new THREE.Color() },
      uGridMin: { value: new THREE.Vector2() }, uGridSpan: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() }, uTanY: { value: 0.6 }, uAspect: { value: 1.6 }, uTime: { value: 0 },
      uOpacity: { value: 1 }, uDensity: { value: 1 }, uZMax: { value: 14000 }, uGround: { value: 150 }, uHMin: { value: 600 }, uHMax: { value: 13200 }, uCover: { value: 0 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: FRAG,
  });
  const rtScene = new THREE.Scene(), rtCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  rtScene.add(new THREE.Mesh(quadGeo, mat));
  const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  const comp = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    uniforms: { tex: { value: rt.texture } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: "uniform sampler2D tex; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tex, vUv); }" }));
  comp.frustumCulled = false; comp.renderOrder = 1000; comp.visible = false;
  O.scene.add(comp);
  mat.uniforms.uNoise.value = noiseTexture(64);
  // Cache non-repeating weather randomness once for inexpensive ray/light sampling.
  const weatherSize = 24, weatherData = new Uint8Array(weatherSize ** 3 * 4), random = mulberry32(98421);
  for (let i = 0; i < weatherData.length; i++) weatherData[i] = Math.round(random() * 255);
  const weatherTex = new THREE.Data3DTexture(weatherData, weatherSize, weatherSize, weatherSize);
  weatherTex.format = THREE.RGBAFormat; weatherTex.type = THREE.UnsignedByteType;
  weatherTex.minFilter = weatherTex.magFilter = THREE.LinearFilter;
  weatherTex.wrapS = weatherTex.wrapT = weatherTex.wrapR = THREE.ClampToEdgeWrapping;
  weatherTex.unpackAlignment = 1; weatherTex.needsUpdate = true;
  mat.uniforms.uWeather.value = weatherTex;
  const st = { rhTex: null, vis: true, ready: false, lastRender: -Infinity,
    balloon: new THREE.Vector3(Infinity, 0, 0), camera: new THREE.Vector3(Infinity, 0, 0), dir: new THREE.Vector3(), up: new THREE.Vector3(), fov: 0, mode: null };

  O.frameHooks.push(() => {
    const fade = S.data && S.enu ? cloudFade(S.cam, O.camEnu.distanceTo(S.enu)) : 0;
    comp.visible = st.vis && st.ready && !!S.data && fade > 0;
    mat.uniforms.uOpacity.value = fade;
    if (!comp.visible) return;
    const dom = renderer.domElement, sc = SCALE * (0.55 + 0.45 * S.quality), w = Math.max(2, Math.round(dom.width * sc)), h = Math.max(2, Math.round(dom.height * sc));
    const resized = rt.width !== w || rt.height !== h;
    if (resized) rt.setSize(w, h);
    const now = performance.now();
    const stable = st.camera.distanceToSquared(O.camEnu) < 0.0001 && st.balloon.distanceToSquared(S.enu) < 0.0001
      && st.dir.distanceToSquared(O.camBasis.dir) < 1e-12 && st.up.distanceToSquared(O.camBasis.up) < 1e-12
      && st.fov === O.camera.fov && st.mode === S.cam;
    // Reuse a stationary view for at most 33 ms; camera movement always renders immediately.
    if (!resized && stable && now - st.lastRender < 33) return;
    st.lastRender = now; st.balloon.copy(S.enu); st.camera.copy(O.camEnu); st.dir.copy(O.camBasis.dir); st.up.copy(O.camBasis.up);
    st.fov = O.camera.fov; st.mode = S.cam;
    const u = mat.uniforms, b = O.camBasis;
    u.uCam.value.copy(O.camEnu); u.uRight.value.copy(b.right); u.uUp.value.copy(b.up); u.uDir.value.copy(b.dir);
    u.uTanY.value = Math.tan(rad(O.camera.fov) / 2); u.uAspect.value = O.camera.aspect; u.uTime.value = performance.now() / 1000; u.uRes.value.set(w, h);
    const sd = O.sunDirection(S.sun.el, S.sun.az), k = S.sun.k, dusk = clamp(1 - Math.abs(S.sun.el - 3) / 14, 0, 1);
    u.uSun.value.copy(sd);
    u.uSunCol.value.setRGB(1.0, 0.93 - 0.3 * dusk, 0.8 - 0.5 * dusk).multiplyScalar(k * (0.25 + 0.75 * clamp(S.sun.el / 20, 0, 1)));
    u.uAmbTop.value.setRGB(0.52, 0.64, 0.86).multiplyScalar(0.05 + 0.95 * k).lerp(new THREE.Color(1.0, 0.62, 0.45), dusk * 0.3 * k);
    u.uAmbBot.value.setRGB(0.30, 0.33, 0.38).multiplyScalar(0.03 + 0.7 * k);
    u.uGround.value = S.data.meta.launch.ground_m;
    u.uDensity.value = S.cam === "balloon" ? 1.0 : 0.3;          // a thin veil on the map views, so the path and landing zone stay readable
    O.depth.render(w, h);
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(rtScene, rtCam); renderer.setRenderTarget(null);
  });

  return {
    onCase(S) {
      st.lastRender = -Infinity;
      const g = S.data.grid, nx = g.lon.length, ny = g.lat.length, nz = g.alt_m.length, buf = new Uint8Array(nx * ny * nz);
      let i = 0;
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) buf[i++] = Math.round(clamp(g.rh[z][y][x], 0, 100) * 2.55);
      if (st.rhTex) st.rhTex.dispose();
      const tex = new THREE.Data3DTexture(buf, nx, ny, nz);
      tex.format = THREE.RedFormat; tex.type = THREE.UnsignedByteType; tex.minFilter = tex.magFilter = THREE.LinearFilter;
      tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping; tex.unpackAlignment = 1; tex.needsUpdate = true;
      st.rhTex = tex; mat.uniforms.uRH.value = tex;
      const G = S.grid;
      mat.uniforms.uGridMin.value.set(G.eMin, G.nMin); mat.uniforms.uGridSpan.value.set(G.eMax - G.eMin, G.nMax - G.nMin);
      mat.uniforms.uZMax.value = G.zMax; st.ready = true;
    },
    setVisible(v) { st.vis = v; },
    update() {},
  };
}
