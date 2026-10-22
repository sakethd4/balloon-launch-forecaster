// Flight paths are map annotations: clear only a narrow strip of the cloud composite over their projected strokes.
// The original Cesium lines retain their altitude colours, selection styling and terrain depth tests.
import * as THREE from "three";

const CLIP_PLANES = [[0,1],[0,-1],[1,1],[1,-1],[2,1],[2,-1]];

// Clip in homogeneous coordinates before dividing by w, avoiding giant strokes across the view near the camera.
export function clipRouteSegment(a, b) {
  let enter = 0, exit = 1;
  for (const [axis, sign] of CLIP_PLANES) {
    const fa = a[3] + sign * a[axis], fb = b[3] + sign * b[axis];
    if (fa < 0 && fb < 0) return null;
    if (fa < 0) enter = Math.max(enter, fa / (fa - fb));
    if (fb < 0) exit = Math.min(exit, fa / (fa - fb));
  }
  if (enter > exit) return null;
  if (enter === 0 && exit === 1) return [a,b];
  const at = t => a.map((v,i) => v + (b[i] - v) * t);
  const p = at(enter), q = at(exit);
  return p[3] > 0 && q[3] > 0 ? [p, q] : null;
}

export function createRouteMask(O) {
  const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
  canvas.width = canvas.height = 2;
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = false;
  const matrix = new THREE.Matrix4(), point = new THREE.Vector4();
  let previous = null, previousFlight = null, blank = false;
  return {
    texture,
    update(flight, follow, time, width, height) {
      const hidden = !flight || flight.vis?.hidden;
      if (hidden && blank && canvas.width === width && canvas.height === height) return;
      const key = [...O.camera.matrixWorld.elements, ...O.camera.projectionMatrix.elements, O.cam.x, O.cam.y, O.cam.z,
        width, height, hidden, follow, time, flight?.selected, flight?.pathPrim.show, flight?.selEnt.show, flight?.trail.show];
      if (previousFlight === flight && previous && key.every((v,i) => v === previous[i])) return;
      previousFlight = flight; previous = key;
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      context.clearRect(0, 0, width, height);
      if (!hidden) {
        matrix.multiplyMatrices(O.camera.projectionMatrix, O.camera.matrixWorldInverse);
        const project = p => {
          point.set(p.x - O.cam.x, p.y - O.cam.y, p.z - O.cam.z, 1).applyMatrix4(matrix);
          return [point.x, point.y, point.z, point.w];
        };
        const cssWidth = O.renderer.domElement.clientWidth || O.renderer.domElement.width / O.renderer.getPixelRatio();
        const pixelRatio = width / cssWidth;
        context.strokeStyle = "white"; context.lineCap = context.lineJoin = "round";
        const stroke = (positions, cssWidth) => {
          if (!positions || positions.length < 2) return;
          context.lineWidth = cssWidth * pixelRatio; context.beginPath();
          let a = project(positions[0]);
          for (let i = 1; i < positions.length; i++) {
            const b = project(positions[i]), segment = clipRouteSegment(a,b); a = b;
            if (!segment) continue;
            const [p,q] = segment;
            context.moveTo((p[0]/p[3]+1)*width/2, (1-p[1]/p[3])*height/2);
            context.lineTo((q[0]/q[3]+1)*width/2, (1-q[1]/q[3])*height/2);
          }
          context.stroke();
        };
        if (flight.pathPrim.show) stroke(flight.nom, 8);
        if (flight.selEnt.show) stroke(flight.selPositions, 8);
        if (flight.trail.show) stroke(flight.trailPositions, 8);
      }
      blank = hidden; texture.needsUpdate = true;
    },
  };
}
