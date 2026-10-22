// A balloon-only distance buffer lets cloud rays stop at visible geometry while preserving clouds in front of it.
import * as THREE from "three";
export const CLOUD_DEPTH_FAR = 1500000;
export function createOccluderDepth(O) {
  const target = new THREE.WebGLRenderTarget(4, 4, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false,
  });
  const material = new THREE.ShaderMaterial({
    depthTest: true, depthWrite: true, side: THREE.DoubleSide,
    vertexShader: `
      varying vec3 vWorldPosition;
      #include <common>
      #include <logdepthbuf_pars_vertex>
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      varying vec3 vWorldPosition;
      #include <packing>
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        // The overlay uses camera-relative world coordinates: its camera is at the origin.
        gl_FragColor = packDepthToRGBA(clamp(length(vWorldPosition) / ${CLOUD_DEPTH_FAR.toFixed(1)}, 0.0, 0.9999999));
      }`,
  });
  return {
    texture: target.texture,
    render(width, height) {
      if (target.width !== width || target.height !== height) target.setSize(width, height);
      const hidden = [], hide = object => { hidden.push([object, object.visible]); object.visible = false; };
      const previous = O.scene.overrideMaterial;
      try {
        for (const object of O.scene.children) if (object !== O.world) hide(object);
        for (const object of O.world.children) if (object !== O.occluders) hide(object);
        O.occluders.traverseVisible(object => {
          // Invisible burst flashes must not cut holes in the clouds.
          if (object.isMesh && object.material.transparent && object.material.opacity < 0.01) hide(object);
        });
        O.scene.overrideMaterial = material;
        O.renderer.setRenderTarget(target); O.renderer.setClearColor(0xffffff, 1); O.renderer.clear();
        O.renderer.render(O.scene, O.camera);
      } finally {
        O.scene.overrideMaterial = previous;
        for (const [object, visible] of hidden) object.visible = visible;
        O.renderer.setRenderTarget(null); O.renderer.setClearColor(0x000000, 0);
      }
    },
  };
}
