"""Zip the project code so it can be uploaded to Google Drive and unpacked on Colab.

The GitHub repo is private, so Colab can't clone it without credentials. A zip of the
code (a few dozen KB) uploaded to the shared Drive folder avoids passing any tokens.

Run from the project root:  python -m scripts.make_colab_bundle
Output: dist/balloon_code.zip  (src/, scripts/, configs/ only; no data)
"""
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dist" / "balloon_code.zip"
FOLDERS = ["src", "scripts", "configs"]

OUT.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
    for folder in FOLDERS:
        for path in sorted((ROOT / folder).rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
                zf.write(path, path.relative_to(ROOT).as_posix())
    names = zf.namelist()
print(f"{OUT}  ({OUT.stat().st_size / 1e3:.0f} KB, {len(names)} files)")
for n in names:
    print("  ", n)
