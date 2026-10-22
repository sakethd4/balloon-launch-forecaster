// Wind you can see. Thousands of particles are carried by the forecast wind (the 3D grid exported with each launch), coloured
// by the forecast air temperature, and drawn as soft streaks with fading tails. Particles live in the Earth frame, so when you
// ride the balloon (which drifts with the wind at its own height) you perceive wind as the air above and below sliding past you
// (shear) and as the layers you climb through. The small-scale swirl is added for display; it is not in the forecast.
import * as THREE from "three";
import { EARTH_R, clamp, smoothstep, tempColor } from "./util.js";

const params = new URLSearchParams(location.search);
const COUNT = ({ low: 3500, mid: 8000, high: 14000 })[params.get("q")] || 9000;
const STREAK_SECONDS = 0.11;                    // length of a streak, in real seconds of motion on screen

export function createWind(S) {
  const O = S.overlay;
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index; geo.setAttribute("position", quad.attributes.position);
  const tail = new Float32Array(COUNT * 3), head = new Float32Array(COUNT * 3), col = new Float32Array(COUNT * 4), size = new Float32Array(COUNT);
  const aTail = new THREE.InstancedBufferAttribute(tail, 3), aHead = new THREE.InstancedBufferAttribute(head, 3);
  const aCol = new THREE.InstancedBufferAttribute(col, 4), aSize = new THREE.InstancedBufferAttribute(size, 1);
  for (const a of [aTail, aHead, aCol, aSize]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aTail", aTail); geo.setAttribute("aHead", aHead); geo.setAttribute("aColor", aCol); geo.setAttribute("aSize", aSize);
  geo.instanceCount = COUNT;
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    uniforms: { uRes: { value: new THREE.Vector2(1, 1) } },
    vertexShader: `
      attribute vec3 aTail; attribute vec3 aHead; attribute vec4 aColor; attribute float aSize;
      uniform vec2 uRes; varying vec2 vUv; varying vec4 vColor;
      void main() {
        vec4 ca = projectionMatrix * modelViewMatrix * vec4(aTail, 1.0), cb = projectionMatrix * modelViewMatrix * vec4(aHead, 1.0);
        if (ca.w < 0.5 || cb.w < 0.5) { gl_Position = vec4(3.0, 3.0, 3.0, 1.0); return; }
        vec2 sa = ca.xy / ca.w * uRes * 0.5, sb = cb.xy / cb.w * uRes * 0.5;
        vec2 d = sb - sa; float len = length(d); d = len > 0.001 ? d / len : vec2(1.0, 0.0);
        vec2 nrm = vec2(-d.y, d.x);
        float s = position.x + 0.5;
        vec2 sa2 = sb - d * max(len, 3.2 * aSize);                       // never shorter than a few widths: very slow air still shows as a soft mote
        vec2 ps = mix(sa2, sb, s) + nrm * position.y * 2.0 * aSize;
        float w = mix(ca.w, cb.w, s);
        gl_Position = vec4(ps / (uRes * 0.5) * w, mix(ca.z, cb.z, s), w);
        vUv = vec2(s, position.y * 2.0); vColor = aColor;
      }`,
    fragmentShader: `
      varying vec2 vUv; varying vec4 vColor;
      void main() {
        float along = pow(vUv.x, 2.6), across = exp(-vUv.y * vUv.y * 3.2);
        float core = smoothstep(0.86, 1.0, vUv.x) * exp(-vUv.y * vUv.y * 4.0);
        vec3 c = vColor.rgb * (0.75 + 0.7 * core);
        gl_FragColor = vec4(c, vColor.a * (0.7 * along * across + 0.6 * core));
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 10;
  O.world.add(mesh);

  // Soft volumetric wisps: big faint puffs of temperature-coloured haze carried by the same wind, so the air has depth, not just streaks.
  const PUFFS = Math.round(COUNT / 40), pgeo = new THREE.InstancedBufferGeometry(), pquad = new THREE.PlaneGeometry(2, 2);
  pgeo.index = pquad.index; pgeo.setAttribute("position", pquad.attributes.position); pgeo.setAttribute("uv", pquad.attributes.uv);
  const pPos = new Float32Array(PUFFS * 3), pCol = new Float32Array(PUFFS * 4), pSize = new Float32Array(PUFFS);
  const paPos = new THREE.InstancedBufferAttribute(pPos, 3), paCol = new THREE.InstancedBufferAttribute(pCol, 4), paSize = new THREE.InstancedBufferAttribute(pSize, 1);
  for (const a of [paPos, paCol, paSize]) a.setUsage(THREE.DynamicDrawUsage);
  pgeo.setAttribute("iPos", paPos); pgeo.setAttribute("iColor", paCol); pgeo.setAttribute("iSize", paSize); pgeo.instanceCount = PUFFS;
  const pmat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec3 iPos; attribute vec4 iColor; attribute float iSize; varying vec2 vUv; varying vec4 vC;
      void main(){ vec4 mv = modelViewMatrix * vec4(iPos, 1.0); mv.xy += position.xy * iSize; vUv = position.xy; vC = iColor; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying vec2 vUv; varying vec4 vC; void main(){ float r2 = dot(vUv, vUv); gl_FragColor = vec4(vC.rgb, vC.a * exp(-r2 * 3.2) * (1.0 - smoothstep(0.7, 1.0, r2))); }`,
  });
  const puffs = new THREE.Mesh(pgeo, pmat); puffs.frustumCulled = false; puffs.renderOrder = 9; O.world.add(puffs);
  const qPos = new Float32Array(PUFFS * 3), qAge = new Float32Array(PUFFS), qLife = new Float32Array(PUFFS), qSz = new Float32Array(PUFFS);
  for (let i = 0; i < PUFFS; i++) { qLife[i] = 14 + Math.random() * 14; qAge[i] = Math.random() * qLife[i]; qSz[i] = 0.6 + 0.8 * Math.random(); }

  const pos = new Float32Array(COUNT * 3), age = new Float32Array(COUNT), life = new Float32Array(COUNT), tint = new Float32Array(COUNT).fill(0.8);
  for (let i = 0; i < COUNT; i++) { life[i] = 7 + Math.random() * 9; age[i] = Math.random() * life[i]; }
  const smp = [0, 0, 0, 0], rgb = [0, 0, 0], st = { vis: true, prevEnu: new THREE.Vector3(), prevT: 0, vBal: new THREE.Vector3(), time: 0, needSpawn: true };
  const turbulence = (x, y, z, t, out) => {                         // smooth, cheap swirl, two octaves
    out[0] = Math.sin(y * 0.0016 + z * 0.0009 + t * 0.31) * 0.6 + Math.sin(y * 0.0071 - x * 0.0043 + t * 0.83) * 0.4;
    out[1] = Math.cos(x * 0.0017 - z * 0.0011 - t * 0.27) * 0.6 + Math.cos(x * 0.0066 + y * 0.0052 - t * 0.77) * 0.4;
  };
  const tb = [0, 0];

  const self = {
    onCase() { st.needSpawn = true; },
    setVisible(v) { st.vis = v; mesh.visible = puffs.visible = v; },
    update(S, dt) {
      mesh.visible = puffs.visible = st.vis && !!S.data && S.grid != null;
      if (!mesh.visible) return;
      const g = S.grid, focus = S.enu, cosLat = Math.cos(S.site.lat * Math.PI / 180), ground = S.data.meta.launch.ground_m;
      const balloonCam = S.cam === "balloon", camD = O.camEnu.distanceTo(focus);
      const H = balloonCam ? 2600 : clamp(camD * 0.85, 1800, 80000), V = balloonCam ? 1500 : clamp(H * 0.30, 900, 5200);
      st.time += dt;
      const simDt = dt * clamp(S.timeScale, 1, 80);
      // the balloon's own velocity (to show motion relative to it when the camera rides along)
      if (S.t !== st.prevT && Math.abs(S.t - st.prevT) < 20 && S.t > st.prevT) st.vBal.copy(S.enu).sub(st.prevEnu).divideScalar(S.t - st.prevT);
      else if (!S.playing) st.vBal.multiplyScalar(0.9);
      st.prevEnu.copy(S.enu); st.prevT = S.t;
      const frameV = (S.cam === "chase" || balloonCam) ? st.vBal : null;
      const visScale = clamp(S.timeScale, 1, 80);
      const pxr = O.renderer.getPixelRatio(); mat.uniforms.uRes.value.set(O.renderer.domElement.width, O.renderer.domElement.height);
      const camEnu = O.camEnu, pxPerM = O.renderer.domElement.height / (2 * Math.tan(O.camera.fov * Math.PI / 360));
      const active = Math.max(2500, Math.round(COUNT * Math.min(1, 0.35 + 0.65 * S.quality)));
      geo.instanceCount = active;
      for (let i = 0; i < active; i++) {
        const i3 = i * 3, i4 = i * 4;
        age[i] += dt;
        let E = pos[i3], N = pos[i3 + 1], U = pos[i3 + 2];
        let respawn = st.needSpawn || age[i] > life[i];
        if (!respawn) {
          const dx = E - focus.x, dy = N - focus.y, alt0 = U + (E * E + N * N) / (2 * EARTH_R);
          const lim = balloonCam ? 1900 : H * 1.25, limV = balloonCam ? 1900 : V * 1.4;
          if (Math.abs(dx) > lim || Math.abs(dy) > lim || Math.abs(alt0 - S.cur.alt) > limV) respawn = true;
        }
        if (respawn) {
          const ang = Math.random() * 6.2832;
          let r, dz;
          if (balloonCam) {                                   // ride-along: most of the air you can feel is within a few hundred metres
            const rr = 1800 * Math.pow(Math.random(), 1.9), el = Math.asin(2 * Math.random() - 1);
            r = rr * Math.cos(el); dz = rr * Math.sin(el);
          } else { r = H * Math.sqrt(Math.random()); dz = V * (2 * Math.random() - 1); }
          E = focus.x + Math.cos(ang) * r; N = focus.y + Math.sin(ang) * r;
          const alt = clamp(S.cur.alt + dz, ground + 60, 13900);
          U = alt - (E * E + N * N) / (2 * EARTH_R);
          age[i] = 0; life[i] = 7 + Math.random() * 9; tint[i] = 0.45 + 0.55 * Math.random();
        }
        const alt = U + (E * E + N * N) / (2 * EARTH_R);
        g.at(S.site.lat + N / 111195, S.site.lon + E / (111195 * cosLat), alt, smp);
        let u = smp[0], v = smp[1];
        const sp = Math.hypot(u, v);
        turbulence(E, N, U, st.time, tb);
        const gust = 0.14 * sp + 0.5;
        u += tb[0] * gust; v += tb[1] * gust;
        E += u * simDt; N += v * simDt;
        pos[i3] = E; pos[i3 + 1] = N; pos[i3 + 2] = U;
        // streak: motion relative to the camera's frame, scaled to what you would see on screen
        let rx = u, ry = v, rz = 0;
        if (frameV) { rx -= frameV.x; ry -= frameV.y; rz -= frameV.z; }
        const L = STREAK_SECONDS * visScale, dist = Math.hypot(E - camEnu.x, N - camEnu.y, U - camEnu.z);
        // never shorter than a screen-space minimum, so from far away the flow still reads as direction and speed (not as dots)
        const pxMin = balloonCam ? 3 : 6 + 40 * smoothstep(2, 32, sp), minLen = pxMin * dist / pxPerM, relLen = Math.hypot(rx, ry, rz);
        const k = relLen * L < minLen ? (relLen > 0.05 ? minLen / relLen : 0) : L;
        head[i3] = E; head[i3 + 1] = N; head[i3 + 2] = U;
        if (relLen > 0.05) { tail[i3] = E - rx * k; tail[i3 + 1] = N - ry * k; tail[i3 + 2] = U - rz * k; }
        else { tail[i3] = E - u * minLen / Math.max(sp, 0.1); tail[i3 + 1] = N - v * minLen / Math.max(sp, 0.1); tail[i3 + 2] = U; }
        // colour = temperature, brightness = speed, faded in and out over the particle's life and with distance
        tempColor(smp[2], rgb);
        const fade = Math.min(age[i] / 0.9, (life[i] - age[i]) / 1.3, 1) * (balloonCam ? Math.pow(Math.max(1 - dist / 1500, 0), 2.4) : Math.exp(-dist / (H * 3.2 + 400)));
        const speedGlow = 0.5 + 0.55 * smoothstep(2, 35, sp);
        col[i4] = rgb[0] * speedGlow; col[i4 + 1] = rgb[1] * speedGlow; col[i4 + 2] = rgb[2] * speedGlow;
        col[i4 + 3] = clamp(fade, 0, 1) * tint[i] * (balloonCam ? 0.95 : 0.55);
        size[i] = pxr * clamp(1.0 + (balloonCam ? 2200 : 900) / (dist + 200), 1.1, balloonCam ? 3.4 : 2.6);
      }
      // wisps
      const pActive = Math.max(150, Math.round(PUFFS * Math.min(1, 0.4 + 0.6 * S.quality)));
      pgeo.instanceCount = pActive;
      for (let i = 0; i < pActive; i++) {
        const i3 = i * 3, i4 = i * 4;
        qAge[i] += dt;
        let E = qPos[i3], N = qPos[i3 + 1], U = qPos[i3 + 2], respawn = st.needSpawn || qAge[i] > qLife[i];
        if (!respawn) { const lim = balloonCam ? 2500 : H * 1.3; if (Math.abs(E - focus.x) > lim || Math.abs(N - focus.y) > lim || Math.abs(U + (E * E + N * N) / (2 * EARTH_R) - S.cur.alt) > (balloonCam ? 2500 : V * 1.5)) respawn = true; }
        if (respawn) {
          const ang = Math.random() * 6.2832; let r, dz;
          if (balloonCam) { const rr = 2400 * Math.pow(Math.random(), 1.5), el = Math.asin(2 * Math.random() - 1); r = rr * Math.cos(el); dz = rr * Math.sin(el); }
          else { r = H * Math.sqrt(Math.random()); dz = V * (2 * Math.random() - 1); }
          E = focus.x + Math.cos(ang) * r; N = focus.y + Math.sin(ang) * r;
          U = clamp(S.cur.alt + dz, ground + 80, 13900) - (E * E + N * N) / (2 * EARTH_R);
          qAge[i] = 0; qLife[i] = 14 + Math.random() * 14;
        }
        const alt = U + (E * E + N * N) / (2 * EARTH_R);
        g.at(S.site.lat + N / 111195, S.site.lon + E / (111195 * cosLat), alt, smp);
        E += smp[0] * simDt; N += smp[1] * simDt;
        qPos[i3] = E; qPos[i3 + 1] = N; qPos[i3 + 2] = U;
        pPos[i3] = E; pPos[i3 + 1] = N; pPos[i3 + 2] = U;
        tempColor(smp[2], rgb);
        const dist = Math.hypot(E - camEnu.x, N - camEnu.y, U - camEnu.z);
        const fade = Math.min(qAge[i] / 2.5, (qLife[i] - qAge[i]) / 3.0, 1);
        pSize[i] = (balloonCam ? 45 + 90 * qSz[i] : clamp(camD * 0.02, 80, 2800) * qSz[i]);
        const near = smoothstep(pSize[i] * 0.6, pSize[i] * 3.0, dist);                       // a puff you are inside of fades so it never blanks the view
        pCol[i4] = rgb[0]; pCol[i4 + 1] = rgb[1]; pCol[i4 + 2] = rgb[2];
        pCol[i4 + 3] = clamp(fade, 0, 1) * near * (balloonCam ? 0.013 : 0.035) * Math.exp(-dist / (balloonCam ? 900 : H * 3 + 600));
      }
      paPos.needsUpdate = paCol.needsUpdate = paSize.needsUpdate = true;
      st.needSpawn = false;
      aTail.needsUpdate = aHead.needsUpdate = aCol.needsUpdate = aSize.needsUpdate = true;
    },
  };
  return self;
}
