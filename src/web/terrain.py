"""Ground elevation from the free AWS Terrain Tiles (Terrarium encoding), cached on disk.

The simulator needs the ground height at the launch point (the balloon starts there and the 10 m wind applies there).
Tile pixel value: height_m = R * 256 + G + B / 256 - 32768. Web-Mercator tiles, one PNG per (zoom, x, y).
"""
import io
import math
from functools import lru_cache

import numpy as np
import requests
from PIL import Image

from src.paths import RAW_DIR

URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
ZOOM = 11                                            # ~75 m per pixel at Austin's latitude


def _tile_xy(lat, lon, z):
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


@lru_cache(maxsize=64)
def _tile(z, x, y) -> np.ndarray:
    path = RAW_DIR / "terrain" / str(z) / str(x) / f"{y}.png"
    if path.exists():
        data = path.read_bytes()
    else:
        r = requests.get(URL.format(z=z, x=x, y=y), timeout=30)
        r.raise_for_status()
        data = r.content
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    rgb = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=float)
    return rgb[..., 0] * 256.0 + rgb[..., 1] + rgb[..., 2] / 256.0 - 32768.0


def elevation_m(lat: float, lon: float, z: int = ZOOM) -> float:
    """Ground height (m above sea level) at a point, bilinear between the tile's pixels."""
    fx, fy = _tile_xy(lat, lon, z)
    tile = _tile(z, int(fx), int(fy))
    px, py = (fx - int(fx)) * 256.0 - 0.5, (fy - int(fy)) * 256.0 - 0.5
    x0, y0 = int(np.clip(math.floor(px), 0, 254)), int(np.clip(math.floor(py), 0, 254))
    tx, ty = float(np.clip(px - x0, 0, 1)), float(np.clip(py - y0, 0, 1))
    top = tile[y0, x0] * (1 - tx) + tile[y0, x0 + 1] * tx
    bottom = tile[y0 + 1, x0] * (1 - tx) + tile[y0 + 1, x0 + 1] * tx
    return float(top * (1 - ty) + bottom * ty)
