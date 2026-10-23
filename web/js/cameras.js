// Camera modes: orbit (free), chase (follows the balloon), top down, and the balloon cam - the camera rides on the
// payload, moves with it, and the user looks around by dragging (up at the balloon and parachute, down at the ground).
import { clamp, deg, rad } from "./util.js";

const C = window.Cesium;

export class Cameras {
  constructor(earth) {
    this.earth = earth;
    this.mode = "orbit";
    this.look = { heading: 0, pitch: rad(-12), fov: 100 };      // balloon cam: look direction (rad) and horizontal field of view (deg)
    this.followPos = new C.Cartesian3();
    this.top = null;
    this.chase = { heading: 0, pitch: rad(-17), range: 1780 };
    this.defaultFov = earth.camera.frustum.fov;
    this.drag = null;
    this.sway = { on: true };
    const canvas = earth.viewer.canvas;
    canvas.addEventListener("pointerdown", (e) => { if (this.mode !== "balloon" && this.mode !== "chase" && this.mode !== "top") return; this.drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.drag || !["balloon", "chase", "top"].includes(this.mode)) return;
      if (this.mode === "top" && this.top) {
        const metresPerPixel = 2 * this.top.height * Math.tan(this.earth.camera.frustum.fovy / 2) / canvas.clientHeight;
        this.top.longitude -= (e.clientX - this.drag.x) * metresPerPixel / (6378137 * Math.cos(this.top.latitude));
        this.top.latitude += (e.clientY - this.drag.y) * metresPerPixel / 6378137;
        this.drag = { x: e.clientX, y: e.clientY }; return;
      }
      if (this.mode === "chase") {
        this.chase.heading -= (e.clientX - this.drag.x) * 0.004;
        this.chase.pitch = clamp(this.chase.pitch + (e.clientY - this.drag.y) * 0.004, rad(-85), rad(75));
        this.drag = { x: e.clientX, y: e.clientY }; return;
      }
      const k = rad(this.look.fov) / canvas.clientWidth;                                       // radians of view per pixel dragged
      this.look.heading = (this.look.heading - (e.clientX - this.drag.x) * k + 2 * Math.PI) % (2 * Math.PI);
      this.look.pitch = clamp(this.look.pitch + (e.clientY - this.drag.y) * k, rad(-89), rad(89));
      this.drag = { x: e.clientX, y: e.clientY };
    });
    const end = () => { this.drag = null; };
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (e) => {
      if (this.mode !== "balloon" && this.mode !== "chase" && this.mode !== "top") return;
      e.preventDefault();
      if (this.mode === "top" && this.top) this.top.height = clamp(this.top.height * Math.exp(Math.sign(e.deltaY) * 0.12), 1000, 560000);
      else if (this.mode === "chase") this.chase.range = clamp(this.chase.range * Math.exp(Math.sign(e.deltaY) * 0.12), 120, 200000);
      else this.look.fov = clamp(this.look.fov * (1 + Math.sign(e.deltaY) * 0.08), 40, 120);
    }, { passive: false });
    window.addEventListener("keydown", (e) => {
      if (this.mode !== "balloon" || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      const s = rad(3);
      if (e.code === "KeyA") this.look.heading -= s; else if (e.code === "KeyD") this.look.heading += s;
      else if (e.code === "KeyW") this.look.pitch = clamp(this.look.pitch + s, rad(-89), rad(89)); else if (e.code === "KeyS") this.look.pitch = clamp(this.look.pitch - s, rad(-89), rad(89));
    });
  }

  /** Where the camera frames the whole flight from (orbit and top down). */
  frame(sphere, bearingRad, mode, duration = 1.6) {
    const { camera, viewer } = this.earth;
    viewer.trackedEntity = undefined;
    camera.cancelFlight(); camera.lookAtTransform(C.Matrix4.IDENTITY);
    if (mode === "top") {
      const centre = C.Cartographic.fromCartesian(sphere.center);
      this.top = { longitude: centre.longitude, latitude: centre.latitude, height: clamp(sphere.radius * 3.4, 3000, 560000) };
      return;
    }
    const side = bearingRad + Math.PI / 2;
    const pose = new C.HeadingPitchRange(side, rad(-27), sphere.radius * 3.1);
    camera.flyToBoundingSphere(sphere, { offset: pose, duration });
  }

  setMode(mode, ctx) {
    const { viewer, camera, scene } = this.earth, ctrl = scene.screenSpaceCameraController, prev = this.mode;
    this.mode = mode; this.drag = null;
    camera.cancelFlight();
    // Tracked/local transforms must not leak into a new mode or launch location.
    viewer.trackedEntity = undefined; camera.lookAtTransform(C.Matrix4.IDENTITY);
    if (["balloon", "chase", "top"].includes(prev)) { // Restore Cesium controls after either manual camera.
      ctrl.enableInputs = true; viewer.__boundsOff = false; if (prev === "balloon") camera.frustum.fov = this.defaultFov;
    }
    if (mode === "balloon") {
      ctrl.enableInputs = false; viewer.__boundsOff = true; this.defaultFov = camera.frustum.fov;
      this.look.heading = rad(ctx.travelHeading); this.look.pitch = rad(-10);
    } else if (mode === "chase") {
      ctrl.enableInputs = false; viewer.__boundsOff = true;
      this.chase = { heading: rad(ctx.travelHeading), pitch: rad(-17), range: 1780 };
    } else {
      if (mode === "top") { ctrl.enableInputs = false; viewer.__boundsOff = true; }
      this.frame(ctx.sphere, ctx.bearing, mode, prev === "orbit" || prev === "top" ? 1.2 : 2.0);
    }
  }

  /** Called every frame before Cesium renders. `pos` is the followed balloon's Earth-fixed position. */
  update(pos, time, fallbackGround = 0) {
    C.Cartesian3.clone(pos, this.followPos);
    if (this.mode === "top" && this.top) {
      const { camera, scene, region } = this.earth, domain = region?.domain;
      this.top.latitude = clamp(this.top.latitude, rad(domain ? domain.lat_min - 0.35 : -85), rad(domain ? domain.lat_max + 0.35 : 85));
      this.top.longitude = clamp(this.top.longitude, rad(domain ? domain.lon_min - 0.35 : -180), rad(domain ? domain.lon_max + 0.35 : 180));
      const c = new C.Cartographic(this.top.longitude, this.top.latitude);
      const terrain = scene.globe.getHeight(c) ?? fallbackGround, reference = scene.verticalExaggerationRelativeHeight ?? 0;
      const floor = reference + (terrain - reference) * scene.verticalExaggeration + 200;
      this.top.height = clamp(Math.max(this.top.height, floor), 1000, 560000);
      camera.setView({ destination: C.Cartesian3.fromRadians(this.top.longitude, this.top.latitude, this.top.height),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      return;
    }
    if (this.mode === "chase") {
      const { camera, scene } = this.earth, target = C.Cartographic.fromCartesian(pos);
      this.chase.pitch = clamp(this.chase.pitch, rad(-85), rad(75));
      this.chase.range = clamp(this.chase.range, 120, 200000);
      for (let pass = 0; pass < 3; pass++) {
        camera.lookAt(pos, new C.HeadingPitchRange(this.chase.heading, this.chase.pitch, this.chase.range));
        const c = C.Cartographic.fromCartesian(camera.positionWC), terrain = scene.globe.getHeight(c) ?? fallbackGround;
        const reference = scene.verticalExaggerationRelativeHeight ?? 0;
        const floor = reference + (terrain - reference) * scene.verticalExaggeration + 4;
        if (c.height >= floor) break;
        // Clamp the orbit state itself: dragging away from the ground responds immediately, without inertia or flips.
        const limit = Math.asin(clamp((target.height - floor) / this.chase.range, -0.999, 0.999));
        this.chase.pitch = clamp(Math.min(this.chase.pitch, limit - 0.002), rad(-85), rad(75));
      }
      return;
    }
    if (this.mode !== "balloon") return;
    const { camera } = this.earth, up = C.Cartesian3.normalize(pos, new C.Cartesian3());
    const dest = C.Cartesian3.add(pos, C.Cartesian3.multiplyByScalar(up, 0.45, new C.Cartesian3()), new C.Cartesian3());
    // the payload swings a little under the balloon; a gentle sway makes the view feel suspended rather than bolted down
    const sway = this.sway.on ? rad(1.1) * Math.sin(time * 0.83) + rad(0.5) * Math.sin(time * 1.9 + 1.3) : 0;
    const swayR = this.sway.on ? rad(1.4) * Math.sin(time * 0.71 + 0.6) : 0;
    camera.frustum.fov = rad(this.look.fov);
    camera.setView({ destination: dest, orientation: { heading: this.look.heading, pitch: clamp(this.look.pitch + sway, rad(-89.5), rad(89.5)), roll: swayR } });
  }

  get headingDeg() { return (deg(this.look.heading) + 360) % 360; }
}
