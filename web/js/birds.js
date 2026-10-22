// Birds near the launch site: turkey vultures soaring in slow circles (the common big soaring bird of Texas), a V of geese
// and a flock of small songbirds. Real sizes (wingspans 1.7 m, 1.6 m and 0.38 m); wings flap in the shader. They only exist
// in the first couple of kilometres above the ground near the launch, so you meet them as the balloon rises through them.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clamp, mulberry32 } from "./util.js";

function birdGeometry() {
  // unit wingspan, nose along +X, left wing +Y, up +Z. aWing = (span fraction, side) drives the flapping; the body uses (0, 0).
  const parts = [];
  const body = new THREE.SphereGeometry(0.5, 10, 8).scale(0.40, 0.11, 0.10).toNonIndexed();
  const head = new THREE.SphereGeometry(0.5, 8, 6).scale(0.11, 0.075, 0.075).translate(0.25, 0, 0.015).toNonIndexed();
  const tailPos = [-0.17, 0, 0, -0.40, 0.075, 0, -0.40, -0.075, 0], tail = new THREE.BufferGeometry();
  tail.setAttribute("position", new THREE.Float32BufferAttribute(tailPos, 3)); tail.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  for (const g of [body, head, tail]) {
    g.deleteAttribute("uv"); g.setAttribute("aWing", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); parts.push(g);
  }
  const pos = [], nor = [], wing = [], SEG = 7;
  for (const side of [1, -1]) {
    for (let i = 0; i < SEG; i++) {
      const s0 = i / SEG, s1 = (i + 1) / SEG, st = (s) => ({ le: 0.07 - 0.13 * s * s, chord: 0.26 * (1 - 0.6 * s), y: side * s * 0.5 });
      const a = st(s0), b = st(s1);
      const v = [[a.le, a.y, s0], [a.le - a.chord, a.y, s0], [b.le, b.y, s1], [b.le - b.chord, b.y, s1]];
      for (const k of [0, 1, 2, 1, 3, 2]) { pos.push(v[k][0], v[k][1], 0); wing.push(v[k][2], side); nor.push(0, 0, 1); }
    }
  }
  const w = new THREE.BufferGeometry();
  w.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); w.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3)); w.setAttribute("aWing", new THREE.Float32BufferAttribute(wing, 2));
  parts.push(w);
  return mergeGeometries(parts);
}

const species = {
  vulture: { n: 6, span: 1.75, color: [0.10, 0.085, 0.075], flap: 0.05, dihedral: 0.22, freq: 0.5 },
  goose: { n: 13, span: 1.55, color: [0.36, 0.31, 0.26], flap: 0.62, dihedral: 0.08, freq: 2.7 },
  songbird: { n: 70, span: 0.38, color: [0.07, 0.07, 0.09], flap: 0.7, dihedral: 0.10, freq: 9.0 },
};

export function createBirds(S) {
  const O = S.overlay, rnd = mulberry32(99), N = species.vulture.n + species.goose.n + species.songbird.n;
  const geo = new THREE.InstancedBufferGeometry().copy(birdGeometry());
  const iPos = new Float32Array(N * 3), iAng = new Float32Array(N * 4), iFlap = new Float32Array(N * 4), iFlap2 = new Float32Array(N * 2), iCol = new Float32Array(N * 3);
  const attrs = { iPos: new THREE.InstancedBufferAttribute(iPos, 3), iAng: new THREE.InstancedBufferAttribute(iAng, 4), iFlap: new THREE.InstancedBufferAttribute(iFlap, 4),
    iFlap2: new THREE.InstancedBufferAttribute(iFlap2, 2), iColor: new THREE.InstancedBufferAttribute(iCol, 3) };
  for (const [k, a] of Object.entries(attrs)) { a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(k, a); }
  geo.instanceCount = N;
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true,
    uniforms: { uTime: { value: 0 }, uSun: { value: new THREE.Vector3(0, 0, 1) }, uSunCol: { value: new THREE.Color(1, 1, 1) }, uAmb: { value: new THREE.Color(0.5, 0.55, 0.65) }, uFade: { value: 1 } },
    vertexShader: `
      attribute vec2 aWing; attribute vec3 iPos; attribute vec4 iAng; attribute vec4 iFlap; attribute vec2 iFlap2; attribute vec3 iColor;
      uniform float uTime; varying vec3 vN; varying vec3 vCol; varying float vUp;
      mat3 rotZ(float a){ float c=cos(a), s=sin(a); return mat3(c,s,0., -s,c,0., 0.,0.,1.); }
      mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
      mat3 rotX(float a){ float c=cos(a), s=sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
      void main() {
        vec3 p = position, n = normal; float s = aWing.x, side = aWing.y;
        if (s > 0.0) {
          float ang = iFlap.z + iFlap.y * sin(uTime * 6.2832 * iFlap2.x + iFlap.x - iFlap.w * s) * (0.35 + 0.65 * s) + 0.12 * s * s * iFlap.z;
          float ay = abs(p.y); p.y = side * ay * cos(ang); p.z = ay * sin(ang);
          n = normalize(vec3(0.0, -side * sin(ang), cos(ang)));
        }
        p *= iAng.w;
        mat3 R = rotZ(iAng.x) * rotY(-iAng.y) * rotX(iAng.z);
        vec3 wp = R * p + iPos; vN = R * n; vCol = iColor; vUp = n.z;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uSun, uSunCol, uAmb; uniform float uFade; varying vec3 vN; varying vec3 vCol; varying float vUp;
      void main() {
        vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
        float ndl = max(dot(n, uSun), 0.0);
        vec3 c = vCol * (uAmb + uSunCol * ndl * 1.1);
        c = mix(c, c + vec3(0.16, 0.16, 0.17) * (uAmb.r + 0.3), clamp(-vUp, 0.0, 1.0) * 0.5);       // paler underside
        gl_FragColor = vec4(c, uFade);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 5; mesh.visible = false;
  O.world.add(mesh);

  // flock set-up (fixed random numbers, so the birds are the same every time)
  const birds = [];
  const add = (kind, extra) => { const sp = species[kind]; birds.push({ kind, ...sp, phase: rnd() * 6.28, ...extra }); };
  for (let i = 0; i < species.vulture.n; i++) add("vulture", { cx: (rnd() - 0.5) * 1800, cy: (rnd() - 0.5) * 1800, agl: 380 + rnd() * 760, r: 130 + rnd() * 140, dir: rnd() < 0.5 ? 1 : -1, a0: rnd() * 6.28 });
  const gooseDir = rnd() * 6.28;
  for (let i = 0; i < species.goose.n; i++) { const row = i === 0 ? 0 : Math.ceil(i / 2), side = i % 2 ? 1 : -1; add("goose", { row, side, dir0: gooseDir, agl: 300 + rnd() * 20 }); }
  for (let i = 0; i < species.songbird.n; i++) add("songbird", { ox: (rnd() - 0.5) * 70, oy: (rnd() - 0.5) * 50, oz: (rnd() - 0.5) * 28, wob: rnd() * 6.28, agl: 120 + rnd() * 20 });
  let time = 0;
  const self = {
    visible: true, iPos, N,                                    // iPos is exposed for tests
    setVisible(v) { self.visible = v; },
    onCase() { time = 0; },
    update(S, dt) {
      if (!S.data || !O.anchor) return;
      time += dt * clamp(S.timeScale, 1, 4);
      const ground = S.data.meta.launch.ground_m, cam = O.camEnu;
      const near = Math.hypot(cam.x, cam.y) < 5200 && cam.z < ground + 3200;
      mesh.visible = self.visible && near;
      if (!mesh.visible) return;
      const u = mat.uniforms; u.uTime.value = time; u.uSun.value.copy(O.sunDirection(S.sun.el, S.sun.az));
      u.uSunCol.value.setRGB(1, 0.95, 0.85).multiplyScalar(S.sun.k * (0.3 + 0.7 * clamp(S.sun.el / 20, 0, 1)));
      u.uAmb.value.setRGB(0.55, 0.62, 0.78).multiplyScalar(0.06 + 0.94 * S.sun.k);
      const wind = [0, 0, 0, 0];
      birds.forEach((b, i) => {
        let x, y, z, yaw, pitch = 0, roll = 0, flapPhase = b.phase;
        if (b.kind === "vulture") {
          S.grid.at(S.site.lat, S.site.lon, ground + b.agl, wind);                         // thermals drift with the wind at their height
          const a = b.a0 + b.dir * (time * 11 / b.r), cx = b.cx + wind[0] * time * 0.35, cy = b.cy + wind[1] * time * 0.35;
          x = cx + Math.cos(a) * b.r; y = cy + Math.sin(a) * b.r; z = ground + b.agl + 18 * Math.sin(time * 0.2 + b.phase);
          yaw = a + b.dir * Math.PI / 2; roll = -b.dir * 0.36;                              // banked into the turn
        } else if (b.kind === "goose") {
          const sp = 16, along = (time * sp) % 7000 - 3500, back = b.row * 11, lat = b.side * b.row * 9, c = Math.cos(b.dir0), s = Math.sin(b.dir0);
          x = (along - back) * c - lat * s - 400 * s; y = (along - back) * s + lat * c + 400 * c; z = ground + b.agl + 6 * Math.sin(time * 0.6 + b.row);
          yaw = b.dir0; flapPhase = b.phase * 0.2 + b.row * 0.18;
        } else {
          const cx = 900 * Math.cos(time * 0.012 + 1), cy = 700 * Math.sin(time * 0.017), cz = ground + 150 + 40 * Math.sin(time * 0.05);
          const w = time * 0.5 + b.wob;
          x = cx + b.ox + 14 * Math.sin(w) + 30 * Math.sin(time * 0.1); y = cy + b.oy + 11 * Math.cos(w * 1.3); z = cz + b.oz + 5 * Math.sin(w * 0.8);
          yaw = Math.atan2(700 * Math.cos(time * 0.017) * 0.017, -900 * Math.sin(time * 0.012 + 1) * 0.012) + 0.25 * Math.sin(w); roll = 0.3 * Math.sin(w * 1.1);
        }
        iPos[i * 3] = x; iPos[i * 3 + 1] = y; iPos[i * 3 + 2] = z - (x * x + y * y) / (2 * 6371000);
        iAng[i * 4] = yaw; iAng[i * 4 + 1] = pitch; iAng[i * 4 + 2] = roll; iAng[i * 4 + 3] = b.span;
        iFlap[i * 4] = flapPhase; iFlap[i * 4 + 1] = b.flap; iFlap[i * 4 + 2] = b.dihedral; iFlap[i * 4 + 3] = b.kind === "songbird" ? 0.6 : 0.9;
        iFlap2[i * 2] = b.freq; iFlap2[i * 2 + 1] = 0;
        const c = b.color, v = 0.85 + 0.3 * ((i * 37) % 10) / 10; iCol[i * 3] = c[0] * v; iCol[i * 3 + 1] = c[1] * v; iCol[i * 3 + 2] = c[2] * v;
      });
      for (const a of Object.values(attrs)) a.needsUpdate = true;
    },
  };
  return self;
}
