import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Test the flight state transitions without requiring Cesium's WebGL renderer.
class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) { Object.assign(this, { x, y, z }); }
  static lerp(a, b, t, out) { for (const k of ['x', 'y', 'z']) out[k] = a[k] + (b[k] - a[k]) * t; return out; }
  static fromDegrees(x, y, z) { return new Cartesian3(x, y, z); }
}
const color = { withAlpha() { return this; } };
globalThis.window = { Cesium: { Cartesian3, Color: { fromCssColorString: () => color } } };
const asModule = s => 'data:text/javascript;base64,' + Buffer.from(s).toString('base64');
const util = asModule(await readFile(new URL('../web/js/util.js', import.meta.url), 'utf8'));
const source = (await readFile(new URL('../web/js/flight.js', import.meta.url), 'utf8')).replace('"./util.js"', JSON.stringify(util));
const { Flight } = await import(asModule(source));
function fixture() {
  const f = Object.create(Flight.prototype);
  const points = [0, 10, 20].map(x => new Cartesian3(x, 0, 100));
  Object.assign(f, { times: [0, 10, 20], ens: [points], nom: points, selected: null,
    data: { endpoints: [[30, -97]] }, vis: { hidden: false }, selEnt: {}, selRing: {},
    dots: { get: () => ({}) }, ends: [], rings: [], pathPrim: {}, underlay: {}, launchEnt: {}, trail: {} });
  return f;
}
test('follow retains the full projected route after selection closes', () => {
  const f = fixture(); f.select(0); f.update(5, 0); f.select(null); f.update(5, 0);
  assert.equal(f.selEnt.show, true);
  assert.equal(f.selPositions, f.ens[0]);
  assert.equal(f.selPositions.length, 3);
  assert.equal(f.trailPositions.at(-1).x, 5);
});
test('paused frames reuse geometry; changing followed flight invalidates it', () => {
  const f = fixture(); f.update(5, -1); const trail = f.trailPositions;
  f.update(5, -1); assert.equal(f.trailPositions, trail);
  f.update(5, 0); assert.notEqual(f.trailPositions, trail); assert.equal(f.selEnt.show, true);
  f.update(5, -1); assert.equal(f.selEnt.show, false);
});
test('balloon cam hides paths and leaving it restores the followed route while paused', () => {
  const f = fixture(); f.update(5, 0); f.setVisible({ hidden: true }); f.update(5, 0);
  assert.equal(f.selEnt.show, false);
  f.setVisible({ hidden: false }); f.update(5, 0);
  assert.equal(f.selEnt.show, true);
});

const { Grid } = await import(util);
test('forecast interpolation preserves an analytic field across repeated particle samples', () => {
  const levels = [0, 500, 1000], lats = [30, 31, 32], lons = [-98, -97, -96];
  const field = levels.map(z => lats.map(y => lons.map(x => 2 * x + 3 * y + z / 100)));
  const grid = new Grid({ alt_m: levels, lat: lats, lon: lons, u: field, v: field, t: field, rh: field }, 30, -98);
  const out = [];
  for (let i = 1; i < 100; i++) {
    const lat = 30 + i / 100, lon = -98 + i / 70, alt = i * 7;
    grid.at(lat, lon, alt, out);
    for (const value of out) assert.ok(Math.abs(value - (2 * lon + 3 * lat + alt / 100)) < 1e-10);
  }
});

const policy = asModule((await readFile(new URL('../web/js/view-scale.js', import.meta.url), 'utf8')).replace('"./util.js"', JSON.stringify(util)));
const { windFade, cloudFade, BALLOON_DISPLAY_SCALE } = await import(policy);
test('all map cameras fade atmosphere smoothly and fully stop at wide zoom', () => {
  for (const mode of ['orbit', 'chase', 'top']) {
    for (const [fade, start, end] of [[windFade, 35000, 70000], [cloudFade, 65000, 120000]]) {
      assert.equal(fade(mode, start), 1); assert.equal(fade(mode, end), 0);
      let previous = 1;
      for (let d = start; d <= end + 1000; d += 100) {
        const current = fade(mode, d); assert.ok(current <= previous && current >= 0); previous = current;
      }
      assert.equal(fade(mode, 560000), 0);
      assert.equal(fade('balloon', 560000), 1);
    }
  }
  assert.ok(BALLOON_DISPLAY_SCALE > 1);
});

test('selecting a second balloon previews its route until following is switched', () => {
  const f = fixture(); f.ens.push(f.ens[0].map(p => new Cartesian3(p.x, 50, p.z)));
  f.data.endpoints.push([31, -98]);
  f.update(5, 0); f.select(1); f.update(5, 0);
  assert.equal(f.selPositions, f.ens[1]);
  f.update(6, 0); assert.equal(f.selPositions, f.ens[1]);
  f.select(null); f.update(6, 1); assert.equal(f.selPositions, f.ens[1]);
  f.update(7, 1); assert.equal(f.trailPositions.at(-1).y, 50);
  f.select(0); f.update(7, 1); assert.equal(f.selPositions, f.ens[0]);
  f.select(null); f.update(7, 1); assert.equal(f.selPositions, f.ens[1]);
});
const terrainSource = (await readFile(new URL('../web/js/terrain-grid.js', import.meta.url), 'utf8')).replace('"./util.js"', JSON.stringify(util));
const { mercatorHeightmap, heightmapRequests } = await import(asModule(terrainSource));
const syntheticDEM = async (z, x, y) => Float32Array.from({length:256*256}, (_,i) =>
  100 + (x*256 + i%256 + 0.5) / 2**z + 2*(y*256 + Math.floor(i/256) + 0.5) / 2**z);
test('adjacent terrain tiles and parent/child refinements agree on shared edges', async () => {
  const a = await mercatorHeightmap(2,2,3,syntheticDEM);
  const b = await mercatorHeightmap(3,2,3,syntheticDEM);
  for (let row=0;row<65;row++) assert.equal(a[row*65+64], b[row*65]);
  const parent = await mercatorHeightmap(1,1,2,syntheticDEM);
  for (let row=0;row<=32;row++) for (let col=0;col<=32;col++)
    assert.equal(parent[row*65+col], a[row*2*65+col*2]);
  const fine = await mercatorHeightmap(4,4,4,syntheticDEM,3);
  for (let row=0;row<=32;row++) for (let col=0;col<=32;col++)
    assert.equal(a[row*65+col], fine[row*2*65+col*2]);
});
test('missing elevation never produces a bogus zero-height tile', async () => {
  await assert.rejects(mercatorHeightmap(2,2,3,async () => null), /Elevation tile unavailable/);
});
test('terrain requests coalesce, limit concurrent work, retain parent fallback and retry failures', async () => {
  let count=0, time=0, fail=true;
  const callback=heightmapRequests(async () => {count++; if(fail) throw Error('network'); return new Float32Array([123]);},
    {concurrency:1,now:()=>time});
  assert.equal(callback(0,0,0),undefined); assert.equal(callback(0,0,0),undefined);
  assert.equal(callback(1,0,0),undefined);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(count,1);
  assert.equal(callback(0,0,0),undefined);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(count,1);
  fail=false; time=3001; callback(0,0,0);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(callback(0,0,0),new Float32Array([123])); assert.equal(count,2);
});

// Exercise the actual imagery wrapper and DOM event handlers with small host adapters.
window.Cesium.UrlTemplateImageryProvider = class {
  constructor() { this.throttled=true; this.image={tile:true}; }
  requestImage() { return this.throttled ? undefined : Promise.resolve(this.image); }
};
const earthSource = (await readFile(new URL('../web/js/earth.js', import.meta.url), 'utf8'))
  .replace('"./util.js"',JSON.stringify(util)).replace('"./terrain-grid.js"',JSON.stringify(asModule(terrainSource)))
  + '\nexport { reliefImagery };';
const earthURL=asModule(earthSource), {reliefImagery}=await import(earthURL);
test('imagery preserves the synchronous retry signal and returns loaded images',async()=>{
  const provider=reliefImagery(); assert.equal(provider.requestImage(0,0,0),undefined);
  provider.throttled=false; assert.equal(await provider.requestImage(0,0,0),provider.image);
});
const timelineURL=asModule((await readFile(new URL('../web/js/timeline.js',import.meta.url),'utf8')).replace('"./util.js"',JSON.stringify(util)));
const {bindTimeline}=await import(timelineURL);
const uiSource=(await readFile(new URL('../web/js/ui.js',import.meta.url),'utf8'))
  .replace('"./util.js"',JSON.stringify(util)).replace('"./earth.js"',JSON.stringify(earthURL)).replace('"./timeline.js"',JSON.stringify(timelineURL));
const UI=await import(asModule(uiSource));
test('follow controls toggle follow/stop without treating the stop button as a camera mode',()=>{
  const elements=new Map();
  globalThis.document={activeElement:{tagName:'BODY'}, querySelectorAll:()=>[], getElementById(id){
    if(!elements.has(id)) elements.set(id,{style:{},listeners:{},addEventListener(event,fn){this.listeners[event]=fn;}});
    return elements.get(id);
  }};
  window.addEventListener=()=>{};
  const state={selected:2,follow:1}; const calls=[];
  UI.initUI(state,{follow:k=>calls.push(['follow',k]),setCam:k=>calls.push(['cam',k])});
  UI.setFollowing(2); assert.equal(elements.get('stopFollow').hidden,false);
  elements.get('dFollow').listeners.click(); assert.deepEqual(calls.pop(),['follow',2]);
  state.follow=2; elements.get('dFollow').listeners.click(); assert.deepEqual(calls.pop(),['follow',-1]);
  elements.get('stopFollow').listeners.click(); assert.deepEqual(calls.pop(),['follow',-1]);
  elements.get('camModes').listeners.click({target:{closest:()=>({dataset:{}})}}); assert.equal(calls.length,0);
  UI.setFollowing(-1); assert.equal(elements.get('stopFollow').hidden,true);
});

const {windColor,tempGradientCss}=await import(util);
test('temperature legend uses the rendered fixed colour scale including both endpoints',()=>{
  const cold=windColor(-60), warm=windColor(40), freezing=windColor(0), css=tempGradientCss();
  assert.ok(cold[2]>cold[0]); assert.ok(warm[0]>warm[2]);
  assert.ok(Math.abs(freezing[0]-freezing[2])<0.02);
  const rgb=c=>`rgb(${c.map(v=>Math.round(v*255)).join(',')})`;
  assert.ok(css.includes(rgb(cold)+' 0%')); assert.ok(css.includes(rgb(warm)+' 100%'));
});


test('timeline captures continuous drags, clamps the ends and cleans up cancellations',()=>{
  const listeners={}, state={data:{}, t:50, tEnd:100, playing:true}; let captured=null;
  const chart={addEventListener:(name,fn)=>listeners[name]=fn, focus(){},
    getBoundingClientRect:()=>({left:100,width:720}), setPointerCapture:id=>captured=id,
    hasPointerCapture:id=>captured===id, releasePointerCapture:()=>captured=null};
  window.addEventListener=()=>{};
  bindTimeline(chart,state,{seek:f=>state.t=f*state.tEnd});
  const ev=(x,id=1)=>({clientX:x,pointerId:id,button:0,preventDefault(){}});
  listeners.pointerdown(ev(480)); assert.equal(state.scrubbing,true); assert.equal(captured,1);
  assert.equal(state.t,50);
  listeners.pointermove(ev(1000,2)); assert.equal(state.t,50);
  listeners.pointermove(ev(1000)); assert.equal(state.t,100);
  listeners.pointermove(ev(0)); assert.equal(state.t,0);
  listeners.pointerup(ev(640)); assert.equal(state.t,75); assert.equal(state.scrubbing,false);
  assert.equal(captured,null); assert.equal(state.playing,true);
  listeners.pointerdown(ev(480)); listeners.pointercancel(ev(480)); assert.equal(state.scrubbing,false);
  listeners.pointerdown(ev(480)); listeners.lostpointercapture(ev(480)); assert.equal(state.scrubbing,false);
  listeners.keydown({key:'End',preventDefault(){}}); assert.equal(state.t,100);
  listeners.keydown({key:'ArrowLeft',preventDefault(){}}); assert.equal(state.t,90);
});
