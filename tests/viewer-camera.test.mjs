import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const vendor=new URL('../dist/viewer-check/cesium.cjs',import.meta.url);
let installed=true; try {await access(vendor);} catch {installed=false;}
if(!installed) {
  test('Cesium camera checks (download pinned runtime to dist/viewer-check/cesium.cjs)',{skip:true},()=>{});
} else {
  const scope={console,atob,TextDecoder,TextEncoder,URL,setTimeout,clearTimeout,performance,
    TransformStream,ReadableStream,WritableStream,AbortController,Blob,Response,Request,Headers};
  scope.global=scope;
  vm.runInNewContext(await readFile(vendor,'utf8'),scope);
  const C=scope.Cesium;
  globalThis.window={Cesium:C,addEventListener(){}};
  const asModule=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
  const util=asModule(await readFile(new URL('../web/js/util.js',import.meta.url),'utf8'));
  const source=(await readFile(new URL('../web/js/cameras.js',import.meta.url),'utf8')).replace('"./util.js"',JSON.stringify(util));
  const {Cameras}=await import(asModule(source));
  function fixture() {
    const handlers={};
    const scene={mapProjection:new C.GeographicProjection(),canvas:{clientWidth:1280,clientHeight:720,
      addEventListener(key,fn){handlers[key]=fn;},setPointerCapture(){}},
      drawingBufferWidth:1280,drawingBufferHeight:720,mode:C.SceneMode.SCENE3D,scene3DOnly:true,
      globe:{ellipsoid:C.Ellipsoid.WGS84,getHeight:()=>200},verticalExaggeration:1.8,
      screenSpaceCameraController:{enableInputs:true},tweens:new C.TweenCollection()};
    const camera=new C.Camera(scene); scene.camera=camera;
    const earth={scene,camera,viewer:{canvas:scene.canvas}};
    const cameras=new Cameras(earth);
    const ctx={travelHeading:40,sphere:new C.BoundingSphere(C.Cartesian3.fromDegrees(-97.743,30.267,400),10000),bearing:0};
    return {cameras,camera,scene,earth,handlers,ctx};
  }
  test('chase drag and wheel remain upright above exaggerated terrain at minimum zoom',()=>{
    const {cameras,camera,handlers,ctx}=fixture();
    cameras.setMode('chase',ctx);
    const target=C.Cartesian3.fromDegrees(-97.743,30.267,400);
    for(let i=0;i<100;i++) handlers.wheel({deltaY:-1,preventDefault(){}});
    assert.equal(cameras.chase.range,120);
    handlers.pointerdown({clientX:0,clientY:0,pointerId:1});
    for(let i=0;i<30;i++) {
      handlers.pointermove({clientX:i*100,clientY:i*100}); cameras.update(target,i,200);
      assert.ok(C.Cartographic.fromCartesian(camera.positionWC).height>=363.9);
      const up=C.Cartesian3.normalize(target,new C.Cartesian3());
      assert.ok(C.Cartesian3.dot(camera.upWC,up)>0,'camera must stay upright');
      const direction=C.Cartesian3.normalize(C.Cartesian3.subtract(target,camera.positionWC,new C.Cartesian3()),new C.Cartesian3());
      assert.ok(C.Cartesian3.dot(direction,camera.directionWC)>0.99999);
    }
    const before=cameras.chase.pitch;
    handlers.pointermove({clientX:2900,clientY:2800}); cameras.update(target,31,200);
    assert.ok(cameras.chase.pitch<before,'dragging away from the ground responds immediately');
  });
  test('relocating a launch rebuilds local vertical and keeps the new flight centred',()=>{
    const {cameras,camera,ctx}=fixture();
    cameras.setMode('chase',ctx); cameras.update(C.Cartesian3.fromDegrees(-97.743,30.267,1000),0);
    const next=C.Cartesian3.fromDegrees(-102,33,3000);
    cameras.setMode('chase',{...ctx,travelHeading:210}); cameras.update(next,1);
    const direction=C.Cartesian3.normalize(C.Cartesian3.subtract(next,camera.positionWC,new C.Cartesian3()),new C.Cartesian3());
    assert.ok(C.Cartesian3.dot(direction,camera.directionWC)>0.99999);
    assert.ok(C.Cartesian3.dot(camera.upWC,C.Cartesian3.normalize(next,new C.Cartesian3()))>0.9);
    cameras.setMode('balloon',{...ctx,travelHeading:210}); cameras.update(next,2);
    assert.ok(C.Matrix4.equals(camera.transform,C.Matrix4.IDENTITY));
    assert.equal(cameras.earth.scene.screenSpaceCameraController.enableInputs,false);
  });
}
