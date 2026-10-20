"""Where data lives.

Data is kept OUTSIDE the project folder (which is synced by OneDrive) so large
files don't get synced. Override with the BALLOON_DATA_DIR environment variable,
e.g. on Colab: /content/drive/MyDrive/balloon-forecaster
"""
import os
from pathlib import Path

DATA_ROOT = Path(os.environ.get("BALLOON_DATA_DIR", Path.home() / "balloon-data"))
RAW_DIR = DATA_ROOT / "raw"
PROCESSED_DIR = DATA_ROOT / "processed"
