// A Three.js layer drawn on top of the Cesium globe. Its camera is copied from Cesium's every frame, so the balloon,
// wind and clouds line up with the terrain. All objects live in `world`, a local east-north-up frame centred
// on the launch point (so coordinates stay small and float32 precision is plenty); `world` is re-placed each frame
// relative to the camera, which sits at the origin.
import * as THREE from "three";
import { deg, rad } from "./util.js";
import { createOccluderDepth } from "./depth-pass.js";

const C = window.Cesium;

export function createOverlay(earth) {
  const { viewer, scene, camera } = earth;
  const canvas = document.createElement("canvas");
  canvas.id = "overlay";
  (document.getElementById("stage") || document.body).appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance", logarithmicDepthBuffer: true });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  const scene3 = new THREE.Scene();
  const cam3 = new THREE.PerspectiveCamera(60, 1, 0.3, 4e6);
  cam3.matrixAutoUpdate = false;
  const world = new THREE.Group();
  world.matrixAutoUpdate = false;
  scene3.add(world);

  const sun = new THREE.DirectionalLight(0xffffff, 2.5), hemi = new THREE.HemisphereLight(0xbcd8ff, 0x4a4338, 0.8);
  world.add(sun, sun.target, hemi);
  const occluders = new THREE.Group(); world.add(occluders);

  const O = { renderer, scene: scene3, world, occluders, camera: cam3, sun, hemi, canvas, frameHooks: [], anchor: null, R: new THREE.Matrix4(), cam: new C.Cartesian3(), camEnu: new THREE.Vector3(),
    camBasis: { right: new THREE.Vector3(), up: new THREE.Vector3(), dir: new THREE.Vector3() }, enuA: null };
  O.depth = createOccluderDepth(O);

  /** Set the local frame's origin (the launch point on the ground) and the matrix that turns ENU into Earth-fixed axes. */
  O.setAnchor = (lat, lon) => {
    O.anchor = C.Cartesian3.fromDegrees(lon, lat, 0);
    const m = C.Transforms.eastNorthUpToFixedFrame(O.anchor);
    O.enuMatrix = m;
    O.R.fromArray(m);                                  // column-major, like THREE
    O.R.setPosition(0, 0, 0);
    O.Rinv = O.R.clone().transpose();                  // rotation only: inverse = transpose
  };
  /** Earth-fixed point -> local east-north-up metres. */
  O.ecefToEnu = (p, out = new THREE.Vector3()) => {
    out.set(p.x - O.anchor.x, p.y - O.anchor.y, p.z - O.anchor.z).applyMatrix4(O.Rinv);
    return out;
  };
  O.geoToEnu = (lat, lon, alt, out) => O.ecefToEnu(C.Cartesian3.fromDegrees(lon, lat, alt), out);
  /** Local east-north-up metres -> Earth-fixed Cartesian3 (for handing positions back to Cesium). */
  O.enuToEcef = (v, out = new C.Cartesian3()) => {
    const t = new THREE.Vector3(v.x, v.y, v.z).applyMatrix4(O.R);
    out.x = t.x + O.anchor.x; out.y = t.y + O.anchor.y; out.z = t.z + O.anchor.z;
    return out;
  };
  /** Direction in the local frame for a sun at elevation/azimuth (degrees, azimuth clockwise from north). */
  O.sunDirection = (el, az) => new THREE.Vector3(Math.sin(rad(az)) * Math.cos(rad(el)), Math.cos(rad(az)) * Math.cos(rad(el)), Math.sin(rad(el)));

  function resize() {
    const w = viewer.canvas.clientWidth, h = viewer.canvas.clientHeight, pr = Math.min(window.devicePixelRatio || 1, 2);
    if (renderer.domElement.width !== Math.round(w * pr) || renderer.domElement.height !== Math.round(h * pr)) {
      renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
    }
    return [w, h];
  }

  /** Copy Cesium's camera into the Three camera and place the local frame. Call once per frame, after Cesium has updated. */
  O.sync = () => {
    if (!O.anchor) return;
    const [w, h] = resize();
    const cp = camera.positionWC, d = camera.directionWC, u = camera.upWC, r = camera.rightWC;
    O.cam.x = cp.x; O.cam.y = cp.y; O.cam.z = cp.z;
    cam3.matrixWorld.set(r.x, u.x, -d.x, 0, r.y, u.y, -d.y, 0, r.z, u.z, -d.z, 0, 0, 0, 0, 1);
    // The renderer calls camera.updateMatrixWorld(): preserve the copied pose in the local matrix too.
    cam3.matrix.copy(cam3.matrixWorld);
    cam3.matrixWorldInverse.copy(cam3.matrixWorld).invert();
    const fov = deg(camera.frustum.fovy), aspect = w / h;
    if (cam3.fov !== fov || cam3.aspect !== aspect) {
      cam3.fov = fov; cam3.aspect = aspect; cam3.updateProjectionMatrix();
    }
    world.matrix.copy(O.R);
    const e = world.matrix.elements;
    e[12] = O.anchor.x - cp.x; e[13] = O.anchor.y - cp.y; e[14] = O.anchor.z - cp.z;
    world.matrixWorldNeedsUpdate = true;
    // camera pose in the local frame (for shaders that march rays in ENU)
    O.camEnu.set(cp.x - O.anchor.x, cp.y - O.anchor.y, cp.z - O.anchor.z).applyMatrix4(O.Rinv);
    O.camBasis.right.set(r.x, r.y, r.z).applyMatrix4(O.Rinv); O.camBasis.up.set(u.x, u.y, u.z).applyMatrix4(O.Rinv); O.camBasis.dir.set(d.x, d.y, d.z).applyMatrix4(O.Rinv);
  };
  O.render = () => {
    if (!O.anchor) return;
    O.sync();
    scene3.updateMatrixWorld(true);
    for (const hook of O.frameHooks) hook(O);
    renderer.render(scene3, cam3);
  };
  scene.postRender.addEventListener(O.render);
  return O;
}
