"""Draw the core picture of the app for one launch: the nominal flight and where it could land.

Flies the learned wind-error ensemble (src/uncertainty) through one archived GFS forecast from a
launch point and saves a map: the nominal path coloured by altitude, a few sampled paths, every
sampled landing, and the 50% / 90% landing-zone circles around the nominal landing.

Run from the project root:
  python -u -W ignore -m scripts.demo_ensemble [--day 2026-10-18] [--launch-lead 25] [--lat 30.27 --lon -97.74]
`--launch-lead` is hours after the 12Z run starts (25 = 13Z the next day).
"""
import argparse
from datetime import date

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import xarray as xr
from matplotlib.collections import LineCollection
from matplotlib.colors import LinearSegmentedColormap

from src.baselines.trajectory4d import WindField4D
from src.ingest import gefs, gfs
from src.paths import PROCESSED_DIR
from src.uncertainty.ensemble import KM_PER_DEG, fly_ensemble
from src.uncertainty.features import situation_features

# Reference palette (light mode): chart surface, ink, hairlines, blue sequential ramp, categorical orange
SURFACE, INK, INK2, MUTED, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#898781", "#e1e0d9"
BLUE_RAMP = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281", "#0d366b"]
ORANGE = "#eb6834"

p = argparse.ArgumentParser()
p.add_argument("--day", type=date.fromisoformat, default=date(2026, 10, 18))
p.add_argument("--launch-lead", type=float, default=25.0)
p.add_argument("--lat", type=float, default=30.27)    # Austin
p.add_argument("--lon", type=float, default=-97.74)
p.add_argument("--n", type=int, default=100)
args = p.parse_args()

with xr.open_dataset(gfs.output_path(args.day, 12)) as g, xr.open_dataset(gefs.output_path(args.day)) as s:
    g, s = g.load(), s.load()
field = WindField4D.from_dataset(g)
spread, wind = situation_features(s, g, args.lat, args.lon, args.launch_lead)
valid = np.datetime64(f"{args.day}T12:00") + np.timedelta64(int(args.launch_lead * 60), "m")
situation = dict(lead_h=args.launch_lead, month=int(str(valid)[5:7]), gfs_wind_ms=float(wind[0]), spread_ms=float(spread[0]))
model = joblib.load(PROCESSED_DIR / "wind_error_full.joblib")
ens = fly_ensemble(field, model, situation, args.lat, args.lon, args.launch_lead, n=args.n, keep_paths=25,
                   rng=np.random.default_rng(0))

nom = ens.nominal
east = lambda lon: (np.asarray(lon) - args.lon) * KM_PER_DEG * np.cos(np.radians(args.lat))
north = lambda lat: (np.asarray(lat) - args.lat) * KM_PER_DEG
d = ens.displacement_km()
lx, ly = float(east(nom.landing[1])), float(north(nom.landing[0]))
r50, r90 = ens.radius_km(0.5), ens.radius_km(0.9)

# Extents first, then a figure whose axes have exactly the data's shape (1 km east = 1 km north on screen)
pts = np.column_stack([east(nom.lon_deg), north(nom.lat_deg)])
xs = np.concatenate([[0.0], pts[:, 0], lx + d[:, 0], [lx - r90, lx + r90]])
ys = np.concatenate([[0.0], pts[:, 1], ly + d[:, 1], [ly - r90, ly + r90]])
xlim, ylim = (xs.min() - 5, xs.max() + 5), (ys.min() - 5, ys.max() + 5)
AX_W = 7.2
ax_h = float(np.clip(AX_W * (ylim[1] - ylim[0]) / (xlim[1] - xlim[0]), 3.0, 6.5))
fig_w, fig_h = 9.0, ax_h + 2.1
fig = plt.figure(figsize=(fig_w, fig_h), facecolor=SURFACE)
ax = fig.add_axes([0.85 / fig_w, 0.75 / fig_h, AX_W / fig_w, ax_h / fig_h], facecolor=SURFACE)
cax = fig.add_axes([(0.85 + AX_W + 0.25) / fig_w, 0.75 / fig_h, 0.16 / fig_w, ax_h / fig_h])
for f in ens.paths:                                   # a few sampled flights: where the wind errors could take it
    ax.plot(east(f.lon_deg), north(f.lat_deg), color=BLUE_RAMP[1], lw=0.8, alpha=0.25, zorder=1)
cmap = LinearSegmentedColormap.from_list("alt", BLUE_RAMP)
seg = np.stack([pts[:-1], pts[1:]], axis=1)
lc = LineCollection(seg, cmap=cmap, norm=plt.Normalize(0, nom.alt_m.max() / 1000), lw=2.4, zorder=3)
lc.set_array(nom.alt_m[:-1] / 1000)
ax.add_collection(lc)
ax.scatter(lx + d[:, 0], ly + d[:, 1], s=16, color=ORANGE, edgecolor=SURFACE, linewidth=0.6, zorder=4)
for r, style, label in ((r50, "-", "50%"), (r90, (0, (4, 3)), "90%")):
    ax.add_patch(plt.Circle((lx, ly), r, fill=False, ec=INK2, lw=1.0, ls=style, zorder=2))
    ax.annotate(label, (lx, ly - r), xytext=(0, -3), textcoords="offset points", ha="center", va="top", color=INK2,
                fontsize=9, bbox=dict(boxstyle="round,pad=0.15", fc=SURFACE, ec="none", alpha=0.9), zorder=6)
ax.scatter([0], [0], s=40, color=INK, zorder=5)
ax.annotate("Launch", (0, 0), xytext=(7, -4), textcoords="offset points", color=INK, fontsize=9, va="top")
b = nom.burst_index
ax.scatter([pts[b, 0]], [pts[b, 1]], s=26, color=SURFACE, edgecolor=INK, linewidth=1.2, zorder=5)
ax.annotate(f"Burst, {nom.alt_m[b] / 1000:.1f} km", (pts[b, 0], pts[b, 1]), xytext=(-6, 12), textcoords="offset points",
            color=INK, fontsize=9, ha="right", bbox=dict(boxstyle="round,pad=0.15", fc=SURFACE, ec="none", alpha=0.9), zorder=6)
ax.scatter([lx], [ly], s=44, marker="X", color=INK, edgecolor=SURFACE, linewidth=0.8, zorder=6)
ax.annotate("Nominal landing", (lx, ly), xytext=(34, -62), textcoords="offset points", color=INK, fontsize=9,
            arrowprops=dict(arrowstyle="-", color=MUTED, lw=0.8), zorder=6)

ax.set_xlim(*xlim)
ax.set_ylim(*ylim)
ax.set_aspect("equal")
ax.grid(color=GRID, lw=0.6)
ax.set_axisbelow(True)
for sp in ax.spines.values():
    sp.set_visible(False)
ax.tick_params(colors=MUTED, labelsize=9, length=0)
ax.set_xlabel("km east of launch", color=MUTED, fontsize=9)
ax.set_ylabel("km north of launch", color=MUTED, fontsize=9)
cb = fig.colorbar(lc, cax=cax)
cb.set_label("altitude, km", color=MUTED, fontsize=9)
cb.outline.set_visible(False)
cb.ax.tick_params(colors=MUTED, labelsize=9, length=0)
fig.text(0.1 / fig_w * 0.85, 1 - 0.18 / fig_h, f"Where could the balloon land? Launch {args.lat:.2f}N, {abs(args.lon):.2f}W",
         color=INK, fontsize=13, fontweight="bold", ha="left", va="top")
fig.text(0.1 / fig_w * 0.85, 1 - 0.55 / fig_h, f"GFS run {args.day} 12Z, launch {args.launch_lead:.0f} h in. {args.n} sampled wind-error flights (orange dots).\n"
         f"Ensemble spread {spread[0]:.1f} m/s, forecast wind {wind[0]:.0f} m/s at 200-500 hPa.\n"
         f"Rings: half of the sampled landings fall within {r50:.1f} km of the nominal landing, nine in ten within {r90:.1f} km.", color=INK2, fontsize=9,
         ha="left", va="top", linespacing=1.5)
fig.text(0.1 / fig_w * 0.85, 0.08 / fig_h, "Advisory only: not a go/no-go decision. Zones come from a model trained on 2021-2024 forecast errors.",
         color=MUTED, fontsize=8, ha="left", va="bottom")
out = PROCESSED_DIR / "demo" / f"ensemble_{args.day}_lead{args.launch_lead:.0f}.png"
out.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(out, dpi=150, facecolor=SURFACE)
print(f"nominal landing {nom.landing[0]:.3f}N {nom.landing[1]:.3f}E, {np.hypot(lx, ly):.1f} km from launch")
print(f"50% of sampled landings within {r50:.1f} km of it, 90% within {r90:.1f} km; saved {out}")
