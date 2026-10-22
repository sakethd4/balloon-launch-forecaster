// The balloon as a real 3D object: latex envelope that swells as the air thins, string, payload box and a folded parachute;
// at burst the envelope pops (flash, shreds of latex) and the parachute opens. Sizes are in metres (natural
// perspective at every camera distance). Envelope size is illustrative: the fill
// volume of the club's balloon is not known yet.
import * as THREE from "three";
import { clamp, lerp, mulberry32, rad, smoothstep } from "./util.js";

const LINE_LEN = 9;                       // metres from the envelope down to the payload
const D0 = 1.4;                           // envelope diameter at launch (m), illustrative

const stdPressureRatio = (z) => Math.pow(Math.max(1 - 2.25577e-5 * z, 0.05), 5.25588);

function skyEnvironment(renderer, k, sunEl) {
  const scene = new THREE.Scene();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, ground: { value: new THREE.Color() }, sun: { value: new THREE.Vector3(0.4, 0.3, 0.86) }, sunCol: { value: new THREE.Color() } },
    vertexShader: "varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }",
    fragmentShader: `varying vec3 vD; uniform vec3 top, horizon, ground, sun, sunCol;
      void main(){ float h = vD.y; vec3 c = h > 0. ? mix(horizon, top, pow(h, .55)) : mix(horizon, ground, pow(-h, .4));
        float s = pow(max(dot(vD, normalize(sun)), 0.), 90.); c += sunCol * s * 6.; c += sunCol * pow(max(dot(vD, normalize(sun)), 0.), 6.) * .25; gl_FragColor = vec4(c, 1.); }`,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), mat));
  const dayTop = new THREE.Color(0x5b9bf0), dayHor = new THREE.Color(0xcfe3f7), nightTop = new THREE.Color(0x070b16), nightHor = new THREE.Color(0x151d33);
  const dusk = clamp(1 - Math.abs(sunEl - 2) / 12, 0, 1);
  mat.uniforms.top.value.copy(nightTop).lerp(dayTop, k).multiplyScalar(0.35 + 0.65 * k);
  mat.uniforms.horizon.value.copy(nightHor).lerp(dayHor, k).lerp(new THREE.Color(0xff9a5a), dusk * 0.55).multiplyScalar(0.3 + 0.7 * k);
  mat.uniforms.ground.value.set(0x3b3a33).multiplyScalar(0.15 + 0.85 * k);
  mat.uniforms.sunCol.value.set(0xfff2d8).multiplyScalar(k);
  mat.uniforms.sun.value.set(0.35, Math.sin(rad(Math.max(sunEl, -5))), 0.4);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.02);
  pm.dispose(); mat.dispose();
  return rt.texture;
}

function makePayload() {
  const g = new THREE.Group();
  const styro = new THREE.MeshStandardMaterial({ color: 0xf6f3ec, roughness: 0.92 });
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.22, 0.22), styro);
  const tape = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.05, 0.23), new THREE.MeshStandardMaterial({ color: 0xff7a1c, roughness: 0.5 }));
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.02, 20), new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.15, metalness: 0.6 }));
  lens.rotation.z = Math.PI / 2; lens.position.set(-0.16, 0, 0.03);
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.55, 6), new THREE.MeshStandardMaterial({ color: 0x222222 }));
  ant.position.set(0.1, 0.06, -0.38);
  g.add(box, tape, lens, ant);
  box.rotation.set(0, 0, 0);
  return g;
}

function makeEnvelope() {
  // a pear-shaped lathe profile of unit height; scaled each frame to the current diameter
  const pts = [];
  for (let i = 0; i <= 56; i++) {
    const t = i / 56, phi = t * Math.PI, pear = 0.20;
    const r = 0.5 * Math.sin(phi) * (1 - pear * (1 - t) * (1 - t)) * (1 + 0.04 * Math.sin(phi * 2));
    pts.push(new THREE.Vector2(Math.max(r, 0.0001), 0.5 * (1 - Math.cos(phi))));
  }
  const geo = new THREE.LatheGeometry(pts, 48);
  geo.rotateX(Math.PI / 2);                                  // lathe axis Y -> Z (up)
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xf3eee4, roughness: 0.30, metalness: 0, clearcoat: 0.75, clearcoatRoughness: 0.22, sheen: 0.6,
    sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.5, transparent: true, opacity: 0.97, envMapIntensity: 1.1 });
  const mesh = new THREE.Mesh(geo, mat);
  const knot = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 12), new THREE.MeshStandardMaterial({ color: 0xe9e2d4, roughness: 0.6 }));
  knot.rotation.x = -Math.PI / 2; knot.position.z = -0.04;
  const g = new THREE.Group(); g.add(mesh, knot);
  return { group: g, mesh, mat };
}

function makeChute() {
  const R = 0.78, g = new THREE.Group();
  const geo = new THREE.SphereGeometry(R, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2.1);
  geo.rotateX(Math.PI / 2);                                  // dome up (+Z)
  const col = [], pos = geo.attributes.position, orange = new THREE.Color(0xff6a14), white = new THREE.Color(0xf5f1e8);
  for (let i = 0; i < pos.count; i++) { const a = Math.atan2(pos.getY(i), pos.getX(i)); col.push(...(Math.floor((a + Math.PI) / (Math.PI / 4)) % 2 ? orange : white).toArray()); }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const canopy = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide }));
  const lines = [], rim = R * Math.sin(Math.PI / 2.1), rimZ = R * Math.cos(Math.PI / 2.1);
  for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; lines.push(rim * Math.cos(a), rim * Math.sin(a), rimZ, 0, 0, -3.0); }
  const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
  const shroud = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x4a4a4a }));
  g.add(canopy, shroud);
  return g;
}

export function createBalloon(S) {
  const O = S.overlay, root = new THREE.Group(), train = new THREE.Group(), sway = new THREE.Group();
  root.visible = false; O.world.add(root); root.add(train); train.add(sway);
  const payload = makePayload(), env = makeEnvelope(), chute = makeChute();
  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.0013, 0.0013, 1, 6), new THREE.MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.6 }));
  line.rotation.x = Math.PI / 2;                                           // cylinder axis Y -> Z
  const folded = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), new THREE.MeshStandardMaterial({ color: 0xf5f1e8, roughness: 0.9 }));
  folded.scale.set(1, 1, 1.6);
  const remnant = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshStandardMaterial({ color: 0xd8d0bf, roughness: 0.8 }));
  remnant.scale.set(1, 0.7, 0.25);
  const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
  sway.add(payload, line, folded, env.group, chute, remnant, flash);
  // shreds of latex that fall after the pop
  const shreds = new THREE.Group(); const rnd = mulberry32(7); const shredData = [];
  for (let i = 0; i < 22; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.18), new THREE.MeshStandardMaterial({ color: 0xf0e9db, roughness: 0.6, side: THREE.DoubleSide, transparent: true }));
    shreds.add(m); shredData.push({ m, v: new THREE.Vector3((rnd() - 0.5) * 3.2, (rnd() - 0.5) * 3.2, (rnd() - 0.2) * 2.4), w: new THREE.Vector3(rnd() * 6, rnd() * 6, rnd() * 6) });
  }
  sway.add(shreds); shreds.visible = false;

  const st = { phase: null, since: 0, lastT: 0, envTexture: null, envK: -1, envEl: 99, popAt: -1 };
  const self = {
    onCase() { st.phase = null; st.popAt = -1; },
    setVisible(v) { self.visible = v; },
    visible: true,
    update(S, dt) {
      if (!S.data || !O.anchor) return;
      const now = performance.now() / 1000, T = S.t, burstT = S.data.meta.burst_time_s, up = T < burstT, alt = S.cur.alt;
      root.visible = self.visible;
      root.position.copy(S.enu);
      // light and sky for this time of day
      const k = S.sun.k, el = S.sun.el;
      O.sun.position.copy(O.sunDirection(el, S.sun.az)).multiplyScalar(1000); O.sun.target.position.set(0, 0, 0);
      O.sun.intensity = 0.1 + 3.4 * k * (0.35 + 0.65 * clamp(el / 25, 0, 1)); O.sun.color.setHSL(0.1, 0.5 * (1 - clamp(el / 20, 0, 1)) + 0.05, 0.92 - 0.12 * (1 - clamp(el / 20, 0, 1)));
      O.hemi.intensity = 0.15 + 0.85 * k;
      if (Math.abs(k - st.envK) > 0.06 || Math.abs(el - st.envEl) > 4) {
        if (st.envTexture) st.envTexture.dispose();
        st.envTexture = skyEnvironment(O.renderer, k, el); O.scene.environment = st.envTexture; st.envK = k; st.envEl = el;
      }
      // The simulated position is the payload. Camera distance never changes the model's scale or anchor.
      const camMode = S.cam === "balloon";
      const d = D0 * Math.pow(1 / stdPressureRatio(alt), 1 / 3), L = LINE_LEN;
      train.scale.setScalar(1);
      train.position.set(0, 0, 0);
      payload.visible = !camMode;                                          // you are looking out of the payload
      // swing under the balloon
      const sw = S.playing || true ? Math.sin(now * 0.9) * 0.025 : 0;
      sway.rotation.set(sw, Math.sin(now * 0.7 + 1) * 0.02, 0);
      // phase changes: pop and parachute (animated when it happens during playback, instant if the user jumped)
      const jumped = Math.abs(T - st.lastT) > 8; st.lastT = T;
      if (up !== st.phase) {
        st.phase = up; st.since = now;
        if (!up && !jumped && S.playing) { st.popAt = now; shreds.visible = true; shredData.forEach((s) => { s.m.position.set(0, 0, L + d * 0.5); s.m.material.opacity = 1; }); }
        else { st.popAt = -1; shreds.visible = false; }
      }
      const popAge = st.popAt > 0 ? now - st.popAt : 99;
      // parts
      line.visible = true;
      if (up) {
        const stretch = lerp(1.12, 1.0, smoothstep(0, 9000, alt));
        env.group.visible = true; env.group.position.set(0, 0, L);
        env.mesh.scale.set(d, d, d * stretch);
        chute.visible = false; remnant.visible = false; folded.visible = true; folded.position.set(0, 0, L * 0.55);
        line.scale.set(1, L, 1); line.position.set(0, 0, L / 2 + 0.11);
        flash.material.opacity = 0;
      } else {
        const open = smoothstep(0, 1.2, now - st.since + (jumped || !S.playing ? 5 : 0));
        env.group.visible = popAge < 0.12;                                   // the envelope swells for an instant, then is gone
        env.mesh.scale.setScalar(d * (1 + 0.45 * Math.min(popAge / 0.12, 1)));
        chute.visible = true; chute.position.set(0, 0, 3.2 + 0.2 * open); chute.scale.set(0.3 + 0.7 * open, 0.3 + 0.7 * open, 0.6 + 0.4 * open);
        folded.visible = false;
        remnant.visible = true; remnant.position.set(0, 0, 4.1 + L * 0.8);
        line.scale.set(1, L * 0.8, 1); line.position.set(0, 0, 4.0 + L * 0.4);
        const fl = popAge < 0.35 ? 1 - popAge / 0.35 : 0;
        flash.position.set(0, 0, L + d * 0.5); flash.scale.setScalar(d * (0.6 + 2.2 * (1 - fl))); flash.material.opacity = 0.8 * fl;
        if (shreds.visible) {
          if (popAge > 7) shreds.visible = false;
          else shredData.forEach((s) => { const a = Math.max(popAge, 0); s.m.position.set(s.v.x * a * 0.7, s.v.y * a * 0.7, L + d * 0.5 + s.v.z * a * 0.7 - 1.2 * a * a); s.m.rotation.set(s.w.x * a, s.w.y * a, s.w.z * a); s.m.material.opacity = clamp(1.5 - a / 5, 0, 1); });
        }
      }
    },
  };
  return self;
}
