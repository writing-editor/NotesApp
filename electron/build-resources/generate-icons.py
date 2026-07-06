#!/usr/bin/env python3
"""
Regenerates electron/build-resources/icon.png and icons/*.png from the
existing Play Store icon source, so the Linux desktop build (see
electron/package.json -> build.linux.icon) has a proper multi-resolution
icon set instead of one flat PNG.

Run manually any time the source artwork changes:
    python3 electron/build-resources/generate-icons.py

Requires Pillow: pip install pillow --break-system-packages
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SOURCE = os.path.join(REPO_ROOT, "mobile", "store-assets", "playstore-icon-512.png")
ICONS_DIR = os.path.join(HERE, "icons")
FLAT_ICON = os.path.join(HERE, "icon.png")

SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)

def main():
    os.makedirs(ICONS_DIR, exist_ok=True)
    src = Image.open(SOURCE).convert("RGBA")

    for size in SIZES:
        out_path = os.path.join(ICONS_DIR, f"{size}x{size}.png")
        src.resize((size, size), Image.LANCZOS).save(out_path)
        print(f"wrote {out_path}")

    src.resize((512, 512), Image.LANCZOS).save(FLAT_ICON)
    print(f"wrote {FLAT_ICON}")

if __name__ == "__main__":
    main()