import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { test } from 'node:test';
const vendor = new URL('../dist/viewer-check/three.mjs', import.meta.url);
let installed = true; try { await access(vendor); } catch { installed = false; }
// Optional integration checks use the exact browser library, downloaded into ignored dist/ (see web/README.md).
if (!installed) {
  test('Three.js integration checks (download pinned module to dist/viewer-check/three.mjs)', { skip: true }, () => {});
} else {
  const THREE = await import(vendor.href);
  const asModule = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64');
  const adapter = asModule(`export * from ${JSON.stringify(vendor.href)};
    import { Texture } from ${JSON.stringify(vendor.href)};
    export class WebGLRenderer {
      constructor({canvas}) {this.domElement = canvas; this.calls = 0;}
      setClearColor() {} setPixelRatio(v) {this.pr = v;} getPixelRatio() {return this.pr || 1;}
      setSize(w,h) {this.domElement.width=w; this.domElement.height=h;}
      setRenderTarget() {} clear() {}
      render(scene,camera) {if(this.beforeRender) this.beforeRender(scene,camera); scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.calls++;}
    }
    export class PMREMGenerator {fromScene() {return {texture: new Texture()};} dispose() {}}
  `);
  const cache = new Map();
  async function load(name) {
    if (cache.has(name)) return cache.get(name);
    let s = await readFile(new URL('../web/js/' + name, import.meta.url), 'utf8');
    const matches = [...s.matchAll(/"\.\/([\w-]+\.js)"/g)];
    for (const m of matches) s = s.replace(m[0], JSON.stringify(await load(m[1])));
    s = s.replace('"three"', JSON.stringify(adapter));
    const url = asModule(s); cache.set(name,url); return url;
  }
  globalThis.location = {search: ''};
  globalThis.window = {Cesium: {Cartesian3: THREE.Vector3}};
  globalThis.document = {createElement: () => ({width:1280,height:720,style:{}}), getElementById: () => ({appendChild(){}})};
  const {createOverlay} = await import(await load('overlay.js'));
  const earth = {viewer: {canvas: {clientWidth:1280,clientHeight:720}},
    scene: {postRender: {addEventListener(){}}},
    camera: {positionWC: new THREE.Vector3(4000,0,0), directionWC: new THREE.Vector3(-1,0,0),
      upWC: new THREE.Vector3(0,0,1), rightWC: new THREE.Vector3(0,1,0), frustum: {fovy:Math.PI/3}}};
  const O = createOverlay(earth); O.anchor = new THREE.Vector3(); O.Rinv = new THREE.Matrix4(); O.sync();
  test('copied globe camera survives renderer matrix updates and projects its target at screen centre', () => {
    const expected = O.camera.matrixWorld.clone();
    O.camera.updateMatrixWorld(true);
    assert.deepEqual(O.camera.matrixWorld.elements, expected.elements);
    const p = new THREE.Vector3(0,0,0).applyMatrix4(O.world.matrix).project(O.camera);
    assert.ok(Math.abs(p.x) < 1e-10 && Math.abs(p.y) < 1e-10);
    assert.ok(p.z > -1 && p.z < 1);
  });
  const S = {overlay:O, cam:'chase', enu:new THREE.Vector3(0,0,1000), cur:{alt:1000},
    data:{meta:{burst_time_s:2400,launch:{ground_m:0}}}, site:{lat:30,lon:-97}, quality:1,
    sun:{k:1,el:45,az:180}, t:100, playing:false, timeScale:6};
  const {createBalloon} = await import(await load('balloon.js'));
  test('balloon stays anchored and keeps its world size when zoom changes', () => {
    const balloon = createBalloon(S); const root = O.occluders.children.at(-1);
    balloon.update(S,0); const train = root.children[0];
    const scale = train.scale.clone(); const position = root.position.clone();
    O.camEnu.set(8000,0,1000); balloon.update(S,0);
    assert.deepEqual(train.scale,scale); assert.deepEqual(root.position,position);
    assert.equal(root.visible,true); assert.equal(train.scale.x,60);
  });
  const {createWind} = await import(await load('wind.js'));
  test('ribbons keep metre dimensions, stay horizontal and skip forecast sampling after zoom fade', () => {
    let calls = 0; S.grid = {at(lat,lon,alt,out) {calls++; out[0]=12;out[1]=4;out[2]=280;out[3]=70;}};
    O.camEnu.set(4000,0,1000);
    const wind = createWind(S); const mesh = O.world.children.at(-1);
    wind.update(S,0.016); assert.equal(mesh.visible,true); assert.equal(mesh.geometry.instanceCount,2560);
    const geometry = mesh.geometry, widths = geometry.attributes.aWidth.array.slice();
    const a = geometry.attributes.aHead.array, b = geometry.attributes.aTail.array;
    for (let i=0;i<geometry.instanceCount;i++) {
      const j=i*3, length=Math.hypot(a[j]-b[j],a[j+1]-b[j+1],a[j+2]-b[j+2]);
      assert.ok(length >= 119.99 && length <= 600.01); assert.equal(a[j+2],b[j+2]);
    }
    O.camEnu.set(8000,0,1000); wind.update(S,0);
    assert.deepEqual(geometry.attributes.aWidth.array,widths);
    O.camEnu.set(25000,0,1000); wind.update(S,0);
    assert.ok(Array.from(geometry.attributes.aColor.array).some((v,i)=>i%4===3 && v>0.05));
    S.cam='balloon'; O.camEnu.copy(S.enu); wind.update(S,0);
    for (let i=0;i<geometry.instanceCount;i++) assert.ok(geometry.attributes.aWidth.array[i] <= 4.5);
    S.cam='chase';
    const before=calls; O.camEnu.set(80000,0,1000); wind.update(S,0.016);
    assert.equal(mesh.visible,false); assert.equal(calls,before);
  });
  const {createClouds} = await import(await load('clouds.js'));
  test('wide map views bypass cloud rendering; payload view restores it', () => {
    const field = [[[95,95],[95,95]],[[95,95],[95,95]]];
    S.data.grid = {lat:[29,31],lon:[-98,-96],alt_m:[0,14000],rh:field};
    Object.assign(S.grid,{eMin:-96000,eMax:96000,nMin:-111000,nMax:111000,zMax:14000});
    const clouds = createClouds(S); clouds.onCase(S);
    const hook = O.frameHooks.at(-1), comp = O.scene.children.at(-1);
    S.cam='orbit'; O.camEnu.set(0,0,130000); const before=O.renderer.calls;
    hook(); assert.equal(comp.visible,false); assert.equal(O.renderer.calls,before);
    S.cam='balloon'; O.camEnu.copy(S.enu); hook();
    assert.equal(comp.visible,true); assert.equal(O.renderer.calls,before+2);
  });

  test('cloud distance pass isolates balloon geometry, skips invisible flashes and restores scene state', () => {
    const previous=O.scene.overrideMaterial, nonBalloon=O.world.children.filter(o=>o!==O.occluders);
    const visibility=nonBalloon.map(o=>o.visible); let checked=false;
    const flashes=[]; O.occluders.traverse(o=>{if(o.isMesh && o.material.transparent && o.material.opacity===0) flashes.push(o);});
    const flashVisibility=flashes.map(o=>o.visible);
    O.renderer.beforeRender=scene=>{
      assert.ok(scene.overrideMaterial.isShaderMaterial);
      assert.equal(scene.overrideMaterial.side,THREE.DoubleSide);
      for(const object of nonBalloon) assert.equal(object.visible,false);
      for(const flash of flashes) assert.equal(flash.visible,false);
      checked=true;
    };
    O.depth.render(64,64); assert.equal(checked,true);
    assert.equal(O.scene.overrideMaterial,previous);
    assert.deepEqual(nonBalloon.map(o=>o.visible),visibility);
    assert.deepEqual(flashes.map(o=>o.visible),flashVisibility);
    O.renderer.beforeRender=()=>{throw Error('GPU error');};
    assert.throws(()=>O.depth.render(64,64),/GPU error/);
    assert.equal(O.scene.overrideMaterial,previous);
    assert.deepEqual(nonBalloon.map(o=>o.visible),visibility);
    delete O.renderer.beforeRender;
  });

}
