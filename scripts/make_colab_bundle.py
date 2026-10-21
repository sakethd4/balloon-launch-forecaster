"""Zip the project code so it can be uploaded to Google Drive and unpacked on Colab.

The GitHub repo is private, so Colab can't clone it without credentials. A zip of the
code (a few dozen KB) uploaded to the shared Drive folder avoids passing any tokens.

Run from the project root:  python -m scripts.make_colab_bundle
Output: dist/balloon_code.zip  (src/, scripts/, configs/ only, plus a list of SondeHub serials already on
the laptop; no data)
"""
import zipfile
from pathlib import Path

from src.paths import PROCESSED_DIR

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "balloon_code.zip"
FOLDERS = ["src", "scripts", "configs"]

OUT.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
    for folder in FOLDERS:
        for path in sorted((ROOT / folder).rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
                zf.write(path, path.relative_to(ROOT).as_posix())
    # Serials of SondeHub tracks the laptop already holds, so Colab does not fetch them again
    have = sorted(f.stem for f in (PROCESSED_DIR / "sondehub_tracks").glob("*.npz"))
    zf.writestr("configs/have_sondehub_serials.txt", "\n".join(have) + "\n")
    names = zf.namelist()
print(f"{OUT}  ({OUT.stat().st_size / 1e3:.0f} KB, {len(names)} files)")
for n in names:
    print("  ", n)
