// Draw the balloon inside Cesium so it shares the globe's terrain depth, not on the atmosphere canvas.
// The Three scene remains the animation source and supplies the cloud-occlusion distance pass.
import * as THREE from "three";
const C = window.Cesium;
export function createNativeBalloon(S, root) {
  const objects = []; root.traverse(object => { object.name = `balloon_${object.uuid}`; object.layers.set(1); objects.push(object); });
  let model = null, bindings = null, url = null, failed = false;
  const fail = error => {
    if (failed) return;
    failed = true; if (model) model.show = false;
    root.traverse(object => object.layers.set(0));
    if (url) URL.revokeObjectURL(url); url = null;
    console.error("Native balloon renderer failed:", error.message);
    S.reportVisualError?.("The terrain-aware balloon model could not load. Refresh to retry.");
  };
  const ready = (async () => {
    const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");
    // Export a snapshot: simulation updates must not mutate transforms while the exporter awaits buffers.
    const snapshot = root.clone(true), temporaryMaterials = [];
    snapshot.traverse(object => {
      if (object.isLine) {
        const material = new THREE.MeshBasicMaterial({ color: object.material.color, transparent: object.material.transparent, opacity: object.material.opacity });
        object.material = material; temporaryMaterials.push(material);
      }
    });
    let bytes;
    try { bytes = await new GLTFExporter().parseAsync(snapshot, { binary: true, onlyVisible: false, trs: false }); }
    finally { temporaryMaterials.forEach(material => material.dispose()); }
    url = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
    model = await C.Model.fromGltfAsync({ url, modelMatrix: C.Matrix4.IDENTITY, show: false,
      upAxis: C.Axis.Z, forwardAxis: C.Axis.X, allowPicking: false, minimumPixelSize: 0,
      enableVerticalExaggeration: false, cull: false, incrementallyLoadTextures: false });
    model.errorEvent?.addEventListener(fail);
    S.earth.scene.primitives.add(model);
  })().catch(fail);
  return {
    ready,
    get failed() { return failed; },
    update() {
      if (failed || !model || !model.ready || !S.overlay.enuMatrix) return;
      if (!bindings) {
        bindings = objects.map(object => ({ object, node: model.getNode(object.name), matrix: new C.Matrix4() })).filter(b => b.node);
        if (url) URL.revokeObjectURL(url); url = null;
      }
      model.modelMatrix = S.overlay.enuMatrix;
      model.show = root.visible;
      for (const { object, node, matrix } of bindings) {
        object.updateMatrix();
        C.Matrix4.fromArray(object.matrix.elements, 0, matrix); node.matrix = matrix;
        node.show = object.visible && !(object.material?.transparent && object.material.opacity < 0.01);
      }
    },
  };
}
