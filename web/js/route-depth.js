// Geometry-only flight strokes for cloud depth testing. Their widths match the visible Cesium lines;
// no cloud pixels outside the actual strokes are removed.
import * as THREE from "three";
import { CLOUD_DEPTH_FAR } from "./depth-pass.js";
export function createRouteDepth(O) {
  const group = new THREE.Group(); group.layers.set(1); group.visible = false; O.world.add(group);
  const quad = new THREE.PlaneGeometry(1, 1), geometry = new THREE.InstancedBufferGeometry();
  geometry.index = quad.index; geometry.setAttribute("position", quad.attributes.position);
  const material = new THREE.ShaderMaterial({ depthTest: true, depthWrite: true, side: THREE.DoubleSide,
    uniforms: { uResolution: { value: new THREE.Vector2() }, uPixelRatio: { value: 1 }, uNear: { value: 0.3 } },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      attribute vec3 aStart, aEnd; attribute float aWidth;
      uniform vec2 uResolution; uniform float uPixelRatio, uNear;
      varying vec3 vWorldPosition;
      void main() {
        vec3 start = aStart, end = aEnd;
        vec4 a = modelViewMatrix * vec4(start, 1.0), b = modelViewMatrix * vec4(end, 1.0);
        if (a.z > -uNear && b.z > -uNear) {gl_Position=vec4(3,3,3,1);return;}
        if (a.z > -uNear) {float t=(-uNear-a.z)/(b.z-a.z);start=mix(start,end,t);a=modelViewMatrix*vec4(start,1);}
        if (b.z > -uNear) {float t=(-uNear-b.z)/(a.z-b.z);end=mix(end,start,t);b=modelViewMatrix*vec4(end,1);}
        vec4 ca=projectionMatrix*a, cb=projectionMatrix*b;
        vec2 d=(cb.xy/cb.w-ca.xy/ca.w)*uResolution;
        vec2 n=vec2(-d.y,d.x)/max(length(d),0.001);
        float s=position.x+0.5;
        gl_Position=mix(ca,cb,s);
        gl_Position.xy += n * position.y * aWidth * uPixelRatio * 2.0 / uResolution * gl_Position.w;
        vWorldPosition=(modelMatrix*vec4(mix(start,end,s),1)).xyz;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <packing>
      #include <logdepthbuf_pars_fragment>
      varying vec3 vWorldPosition;
      void main() {
        #include <logdepthbuf_fragment>
        gl_FragColor=packDepthToRGBA(clamp(length(vWorldPosition)/${CLOUD_DEPTH_FAR.toFixed(1)},0.0,0.9999999));
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material); mesh.layers.set(1); mesh.frustumCulled = false; group.add(mesh);
  let capacity = 0, starts, ends, widths, previous = null;
  const start = new THREE.Vector3(), end = new THREE.Vector3();
  return {
    group,
    update(S, width, height) {
      material.uniforms.uResolution.value.set(width,height); material.uniforms.uNear.value=O.camera.near;
      const cssWidth=O.renderer.domElement.clientWidth || O.renderer.domElement.width/O.renderer.getPixelRatio();
      material.uniforms.uPixelRatio.value=width/cssWidth;
      const f=S.flight, key=[f,f?.selected,S.follow,S.t,f?.vis?.hidden,f?.pathPrim.show,f?.selEnt.show,f?.trail.show];
      if(previous && key.every((v,i)=>v===previous[i])) return false;
      previous=key; group.visible=!!f && !f.vis?.hidden;
      if(!group.visible) {geometry.instanceCount=0;return true;}
      const routes=[];
      if(f.pathPrim.show) routes.push([f.nom,3]);
      if(f.selEnt.show) routes.push([f.selPositions,3.5]);
      if(f.trail.show) routes.push([f.trailPositions,4]);
      const count=routes.reduce((sum,[points])=>sum+Math.max(0,points.length-1),0);
      if(count>capacity) {
        capacity=2**Math.ceil(Math.log2(Math.max(count,16)));
        starts=new Float32Array(capacity*3); ends=new Float32Array(capacity*3); widths=new Float32Array(capacity);
        for(const [name,array,size] of [['aStart',starts,3],['aEnd',ends,3],['aWidth',widths,1]])
          geometry.setAttribute(name,new THREE.InstancedBufferAttribute(array,size).setUsage(THREE.DynamicDrawUsage));
      }
      let i=0;
      for(const [points,lineWidth] of routes) for(let j=1;j<points.length;j++,i++) {
        O.ecefToEnu(points[j-1],start); O.ecefToEnu(points[j],end);
        start.toArray(starts,i*3); end.toArray(ends,i*3); widths[i]=lineWidth;
      }
      geometry.instanceCount=count; group.visible=count>0;
      for(const attribute of Object.values(geometry.attributes)) if(attribute.isInstancedBufferAttribute) attribute.needsUpdate=true;
      return true;
    },
  };
}
