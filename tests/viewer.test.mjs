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
    dots: { get: () => ({}) }, ends: {}, rings: [], pathPrim: {}, underlay: {}, launchEnt: {}, trail: {} });
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
