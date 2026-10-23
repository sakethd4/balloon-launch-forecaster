// Forecast-driven air ribbons. Geometry is measured in metres; the field never grows with zoom.
// Curvature is illustrative sub-grid motion, while transport and colour use forecast wind/temperature.
import * as THREE from "three";
import { EARTH_R, clamp, smoothstep, windColor } from "./util.js";
import { windFade } from "./view-scale.js";

const params = new URLSearchParams(location.search);
const COUNT = Math.round(0.6 * (({ low: 1800, mid: 3200, high: 5000 })[params.get("q")] || 3200));

export function createWind(S) {
  const O = S.overlay, geo = new THREE.InstancedBufferGeometry();
  const strip = new THREE.PlaneGeometry(1, 1, 10, 1);
  geo.index = strip.index; geo.setAttribute("position", strip.attributes.position);
  const heads = new Float32Array(COUNT * 3), tails = new Float32Array(COUNT * 3);
  const colors = new Float32Array(COUNT * 4), widths = new Float32Array(COUNT), bends = new Float32Array(COUNT);
  const attributes = [new THREE.InstancedBufferAttribute(tails, 3), new THREE.InstancedBufferAttribute(heads, 3),
    new THREE.InstancedBufferAttribute(colors, 4), new THREE.InstancedBufferAttribute(widths, 1), new THREE.InstancedBufferAttribute(bends, 1)];
  ['aTail', 'aHead', 'aColor', 'aWidth', 'aBend'].forEach((key, i) => {
    attributes[i].setUsage(THREE.DynamicDrawUsage); geo.setAttribute(key, attributes[i]);
  });
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute vec3 aTail, aHead; attribute vec4 aColor; attribute float aWidth, aBend;
      uniform float uTime;
      varying vec2 vUv; varying vec4 vColor;
      void main() {
        vec4 a = modelViewMatrix * vec4(aTail, 1.0), b = modelViewMatrix * vec4(aHead, 1.0);
        float s = position.x + 0.5;
        vec2 tangent = b.xy - a.xy;
        vec2 normal = vec2(-tangent.y, tangent.x) / max(length(tangent), 0.001);
        vec4 p = mix(a, b, s);
        // Bend the centre line; width and curvature remain in world metres.
        p.xy += normal * (sin(s * 3.14159265) * aBend + position.y * aWidth);
        gl_Position = projectionMatrix * p;
        if (a.z > -0.5 || b.z > -0.5) gl_Position = vec4(3, 3, 3, 1);
        vUv = vec2(s, position.y * 2.0); vColor = aColor;
      }`,
    fragmentShader: `
      uniform float uTime; varying vec2 vUv; varying vec4 vColor;
      void main() {
        float ends = pow(max(sin(vUv.x * 3.14159265), 0.0), 1.2);
        float across = exp(-vUv.y * vUv.y * 4.5);

        gl_FragColor = vec4(vColor.rgb, vColor.a * ends * across * 0.85);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 10;
  O.world.add(mesh);
  const pos = new Float32Array(COUNT * 3), age = new Float32Array(COUNT), life = new Float32Array(COUNT);
  const sample = [0, 0, 0, 0], rgb = [0, 0, 0];
  let visible = true, reset = true, mode = null, time = 0;
  return {
    onCase() { reset = true; },
    onCamera() { reset = true; },
    onFollow() { reset = true; },
    setVisible(v) { visible = v; mesh.visible = v; if (v) reset = true; },
    update(S, dt) {
      const fade = S.data && S.enu ? windFade(S.cam, O.camEnu.distanceTo(S.enu)) : 0;
      mesh.visible = visible && !!S.grid && fade > 0;
      // Skip simulation, interpolation, buffer uploads and drawing when the field cannot be seen.
      if (!mesh.visible) { reset = true; return; }
      if (mode !== S.cam) { reset = true; mode = S.cam; }
      time += dt; mat.uniforms.uTime.value = time;
      const ride = S.cam === "balloon", radius = ride ? 1600 : 4800, vertical = ride ? 1100 : 2200;
      const ground = S.data.meta.launch.ground_m, focus = S.enu, camera = O.camEnu;
      const cosLat = Math.cos(S.site.lat * Math.PI / 180);
      const simDt = dt * clamp(S.timeScale, 1, 40);
      const count = Math.round(COUNT * (0.4 + 0.6 * S.quality)); geo.instanceCount = count;
      for (let i = 0; i < count; i++) {
        const j = i * 3, k = i * 4;
        age[i] += dt;
        let e = pos[j], n = pos[j + 1], z = pos[j + 2];
        const altitude = z + (e * e + n * n) / (2 * EARTH_R);
        if (reset || age[i] > life[i] || Math.hypot(e - focus.x, n - focus.y) > radius * 1.2 || Math.abs(altitude - S.cur.alt) > vertical * 1.3) {
          const theta = Math.random() * Math.PI * 2, r = radius * Math.sqrt(Math.random());
          e = focus.x + Math.cos(theta) * r; n = focus.y + Math.sin(theta) * r;
          z = S.cur.alt + (Math.random() * 2 - 1) * vertical - (e * e + n * n) / (2 * EARTH_R);
          life[i] = 9 + Math.random() * 9;
          // Spread ages on a reset so the air is visible immediately without a synchronized flash.
          age[i] = reset ? Math.random() * life[i] : 0;
        }
        const alt = z + (e * e + n * n) / (2 * EARTH_R);
        S.grid.at(S.site.lat + n / 111195, S.site.lon + e / (111195 * cosLat), alt, sample);
        const speed = Math.hypot(sample[0], sample[1]);
        const swirl = 0.8 + speed * 0.10;
        const u = sample[0] + Math.sin(n * 0.003 + time * 0.3) * swirl;
        const v = sample[1] + Math.cos(e * 0.0027 - time * 0.23) * swirl;
        e += u * simDt; n += v * simDt;
        pos[j] = e; pos[j + 1] = n; pos[j + 2] = z;
        const length = (ride ? clamp(40 + speed * 5, 40, 240) : clamp(120 + speed * 10, 120, 600)), norm = Math.max(Math.hypot(u, v), 0.1);
        heads[j] = e; heads[j + 1] = n; heads[j + 2] = z;
        tails[j] = e - u / norm * length; tails[j + 1] = n - v / norm * length; tails[j + 2] = z;
        widths[i] = ride ? 2.5 + 2 * smoothstep(0, 30, speed) : 12 + 8 * smoothstep(0, 30, speed);
        bends[i] = Math.sin(i * 2.399) * length * 0.15;
        windColor(sample[2], rgb);
        // Subtle tint: avoid a solid blue cloud when many trails overlap.
        for (let c = 0; c < 3; c++) colors[k + c] = rgb[c];
        const dist = Math.hypot(e - camera.x, n - camera.y, z - camera.z);
        const fieldDist = Math.hypot(e - focus.x, n - focus.y);
        const lifeFade = Math.min(age[i] / 1.5, (life[i] - age[i]) / 2, 1);
        const altitudeFade = smoothstep(ground + 25, ground + 160, alt) * (1 - smoothstep(13700, 14200, alt));
        colors[k + 3] = fade * lifeFade * altitudeFade * smoothstep(15, 100, dist)
          * (1 - smoothstep(radius * 0.7, radius * 1.6, ride ? dist : fieldDist)) * (ride ? 0.288 : 0.495);
      }
      reset = false;
      for (const attribute of attributes) {
        attribute.clearUpdateRanges(); attribute.addUpdateRange(0, count * attribute.itemSize); attribute.needsUpdate = true;
      }
    },
  };
}
