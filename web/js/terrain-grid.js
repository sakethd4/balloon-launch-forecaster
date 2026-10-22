// Sample source Mercator pixels across tile borders so adjacent heightmaps share identical edge heights.
// Source pixel centres are offset by half a pixel from tile boundaries.
import { clamp } from "./util.js";
export async function mercatorHeightmap(x, y, level, fetchTile, maxLevel = 14, size = 65) {
  const z = Math.min(level, maxLevel), divisor = 2 ** (level - z), tilesPerSide = 2 ** z;
  const west = x * 256 / divisor - 0.5, north = y * 256 / divisor - 0.5;
  const span = 256 / divisor, tiles = new Map(), jobs = [];
  const wrap = x => ((x % tilesPerSide) + tilesPerSide) % tilesPerSide;
  for (let ty = Math.floor(north / 256); ty <= Math.floor((north + span + 1) / 256); ty++) {
    for (let tx = Math.floor(west / 256); tx <= Math.floor((west + span + 1) / 256); tx++) {
      const xx = wrap(tx), yy = clamp(ty, 0, tilesPerSide - 1), key = `${xx},${yy}`;
      if (tiles.has(key)) continue;
      tiles.set(key, null);
      jobs.push(Promise.resolve(fetchTile(z, xx, yy)).then(data => {
        if (!data) throw new Error(`Elevation tile unavailable: ${z}/${xx}/${yy}`);
        tiles.set(key, data);
      }));
    }
  }
  await Promise.all(jobs);
  const at = (px, py) => {
    const yy = clamp(py, 0, tilesPerSide * 256 - 1), tx = Math.floor(px / 256), ty = Math.floor(yy / 256);
    return tiles.get(`${wrap(tx)},${ty}`)[(yy - ty * 256) * 256 + (px - tx * 256)];
  };
  const out = new Float32Array(size * size);
  for (let j = 0; j < size; j++) {
    const fy = north + span * j / (size - 1), iy = Math.floor(fy), b = fy - iy;
    for (let i = 0; i < size; i++) {
      const fx = west + span * i / (size - 1), ix = Math.floor(fx), a = fx - ix;
      out[j * size + i] = Math.max(0, (at(ix, iy) * (1 - a) + at(ix + 1, iy) * a) * (1 - b)
        + (at(ix, iy + 1) * (1 - a) + at(ix + 1, iy + 1) * a) * b);
    }
  }
  return out;
}

// undefined is Cesium's retry/parent-fallback signal. Never replace a failed request with zero elevation.
export function heightmapRequests(load, { concurrency = 6, capacity = 300, now = () => performance.now() } = {}) {
  const ready = new Map(), pending = new Set(), retries = new Map();
  return (x, y, level) => {
    const key = `${level}/${x}/${y}`;
    if (ready.has(key)) { const tile = ready.get(key); ready.delete(key); ready.set(key, tile); return tile; }
    if (pending.has(key) || pending.size >= concurrency || (retries.get(key) ?? 0) > now()) return undefined;
    pending.add(key);
    Promise.resolve().then(() => load(x, y, level)).then(tile => {
      ready.set(key, tile); retries.delete(key);
      if (ready.size > capacity) ready.delete(ready.keys().next().value);
    }).catch(() => { retries.set(key, now() + 3000); }).finally(() => { pending.delete(key); });
    return undefined;
  };
}
