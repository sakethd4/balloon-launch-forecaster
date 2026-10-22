"""Scores for a sampled 2-D landing distribution against the real landing offset (km)."""
import numpy as np


def energy_score(samples, y, batch=1000):
    """samples (R, S, 2), y (R, 2) -> energy score per row."""
    out = np.empty(len(y))
    for i in range(0, len(y), batch):
        x, t = samples[i:i + batch], y[i:i + batch]
        a = np.linalg.norm(x - t[:, None, :], axis=-1).mean(axis=1)
        b = np.linalg.norm(x[:, :, None, :] - x[:, None, :, :], axis=-1).mean(axis=(1, 2))
        out[i:i + batch] = a - 0.5 * b
    return out


def score(samples, y):
    r = np.linalg.norm(samples, axis=-1)                      # sampled landing displacement sizes
    r50, r90 = np.quantile(r, [0.5, 0.9], axis=1)
    ry = np.linalg.norm(y, axis=-1)
    return dict(energy=energy_score(samples, y), cover50=ry <= r50, cover90=ry <= r90, r50=r50, r90=r90)
