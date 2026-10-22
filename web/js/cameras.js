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
    this.followEntity = earth.viewer.entities.add({ position: new C.CallbackProperty(() => this.followPos, false), point: { pixelSize: 0 } });
    this.defaultFov = earth.camera.frustum.fov;
    this.drag = null;
    this.sway = { on: true };
    const canvas = earth.viewer.canvas;
    canvas.addEventListener("pointerdown", (e) => { if (this.mode !== "balloon") return; this.drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => {
      if (this.mode !== "balloon" || !this.drag) return;
      const k = rad(this.look.fov) / canvas.clientWidth;                                       // radians of view per pixel dragged
      this.look.heading = (this.look.heading - (e.clientX - this.drag.x) * k + 2 * Math.PI) % (2 * Math.PI);
      this.look.pitch = clamp(this.look.pitch + (e.clientY - this.drag.y) * k, rad(-89), rad(89));
      this.drag = { x: e.clientX, y: e.clientY };
    });
    const end = () => { this.drag = null; };
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (e) => { if (this.mode !== "balloon") return; e.preventDefault(); this.look.fov = clamp(this.look.fov * (1 + Math.sign(e.deltaY) * 0.08), 40, 120); }, { passive: false });
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
    const side = bearingRad + Math.PI / 2;
    const pose = mode === "top" ? new C.HeadingPitchRange(0, rad(-90), sphere.radius * 3.4) : new C.HeadingPitchRange(side, rad(-27), sphere.radius * 3.1);
    camera.flyToBoundingSphere(sphere, { offset: pose, duration });
  }

  setMode(mode, ctx) {
    const { viewer, camera, scene } = this.earth, ctrl = scene.screenSpaceCameraController, prev = this.mode;
    this.mode = mode;
    if (prev === "balloon") {                                                                  // leaving the balloon cam: restore normal controls
      ctrl.enableInputs = true; viewer.__boundsOff = false; camera.frustum.fov = this.defaultFov;
    }
    viewer.trackedEntity = undefined;
    if (mode === "balloon") {
      ctrl.enableInputs = false; viewer.__boundsOff = true; this.defaultFov = camera.frustum.fov;
      this.look.heading = rad(ctx.travelHeading); this.look.pitch = rad(-10);
    } else if (mode === "chase") {
      const b = rad(ctx.travelHeading), back = 1700;
      this.followEntity.viewFrom = new C.Cartesian3(-Math.sin(b) * back, -Math.cos(b) * back, 520);
      viewer.trackedEntity = this.followEntity;
    } else {
      this.frame(ctx.sphere, ctx.bearing, mode, prev === "orbit" || prev === "top" ? 1.2 : 2.0);
    }
  }

  /** Called every frame before Cesium renders. `pos` is the followed balloon's Earth-fixed position. */
  update(pos, time) {
    C.Cartesian3.clone(pos, this.followPos);
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
