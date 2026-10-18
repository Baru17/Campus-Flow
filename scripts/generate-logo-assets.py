"""
Regenerate every CampusFlow logo asset from a single source image.

Usage (from anywhere):

    python scripts/generate-logo-assets.py [SOURCE] [--outdir PUBLIC_DIR]

    SOURCE      Logo image to clean up and export. May be SVG (preferred --
                vector sources are rasterised at 3x for the PNG assets) or a
                raster format (JPEG/PNG, checkerboard or white background).
                Defaults to the first of these that exists:
                    public/campusflow-logo.svg
                    public/campusflow-logo.png
                    public/campusflow-logo.jpeg
    PUBLIC_DIR  Output directory (default: <repo>/public).

Requirements: Python 3 with Pillow, numpy and scipy. SVG sources additionally
need `pip install resvg-py`.

What it does
------------
1. Removes the image background *globally* -- every neutral (gray/white)
   pixel becomes transparent, including checkerboard cells, white patches
   inside the emblem, and JPEG ringing at the edges. Only the saturated
   brand artwork (navy, electric blue, cyan) and its anti-aliased edges
   survive. Genuine transparency in the source is preserved. Tuned to this
   logo family: if a future logo contains genuine white artwork, raise
   NEUTRAL_MIN_MEAN or exempt those areas.
2. Crops to the artwork bounding box + small padding. Aspect ratio is
   always preserved downstream via object-fit: contain / contain-fitting.
3. Writes:
       campusflow-logo.png          transparent UI logo
       pwa-192x192.png              install icon, 'any' purpose
       pwa-512x512.png              install icon, 'any' purpose
       pwa-maskable-192x192.png     Android maskable, solid background
       pwa-maskable-512x512.png     Android maskable, solid background
       apple-touch-icon.png         iOS home-screen icon, solid background
       favicon.svg                  browser icon (vector copy of the source
                                    when the source is SVG, otherwise an
                                    embedded 128px PNG)
4. Verifies the output and exits non-zero if anything looks wrong, so a
   bad source never silently ships.

The original source image is never modified. public/campusflow-logo.jpeg
is kept as the archival copy of the last supplied *raster* source artwork.
"""

import argparse
import base64
import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[1]

# --- tuning ---------------------------------------------------------------
# A pixel is "background" when it is nearly neutral (r ~= g ~= b) and at
# least this bright on average. Covers checkerboard grays (~195/~230),
# pure white patches (255) and their light blends.
NEUTRAL_MAX_SPREAD = 22   # max(r,g,b) - min(r,g,b)
NEUTRAL_MIN_MEAN = 140    # mean(r,g,b)
FRINGE_MAX_MEAN = 140     # dark JPEG ringing hugging the background
SPECK_MAX_PX = 40         # isolated noise blobs in the backdrop
FEATHER_PX = 0.6          # edge softening
PAD_PX = 8                # crop padding around the artwork

# icon layout
ANY_FILL = 0.94           # transparent install icons
MASKABLE_FILL = 0.60      # inside the 80%-diameter maskable safe zone
APPLE_FILL = 0.72         # iOS adds its own crop/padding
FAVICON_FILL = 0.92
ICON_BG = (246, 247, 251, 255)  # manifest background_color #f6f7fb
# --------------------------------------------------------------------------


def rasterize_svg(path, zoom=3.0):
    """Render an SVG source to RGBA at a higher resolution via resvg."""
    import resvg_py

    png = resvg_py.svg_to_bytes(svg_path=str(path), zoom=zoom)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def clean_background(img):
    """Return an RGBA image with the background removed globally.

    Works on both fully-opaque sources (JPEG / checkerboard PNGs) and
    sources with real alpha (SVG renders): existing transparency is kept,
    and any neutral/white pixels -- opaque or not -- are erased.
    """
    src = np.asarray(img.convert("RGBA")).astype(np.int16)
    rgb, alpha_src = src[..., :3], src[..., 3].astype(np.float64)
    spread = rgb.max(-1) - rgb.min(-1)
    mean = rgb.mean(-1)

    bg = (spread <= NEUTRAL_MAX_SPREAD) & (mean >= NEUTRAL_MIN_MEAN) & (alpha_src > 0)
    print(f"  background pixels: {int(bg.sum()):,} ({bg.mean():.1%})")

    # Neutral mid-tone pixels bordering the background are JPEG ringing
    # between the backdrop and the dark navy edge -- feather them out.
    bg_dilated = np.asarray(
        Image.fromarray((bg * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))
    ) > 0
    fringe = (~bg) & (spread <= NEUTRAL_MAX_SPREAD + 4) & (mean >= 60) & bg_dilated
    print(f"  edge-fringe pixels: {int(fringe.sum()):,}")

    removal = bg | fringe

    # Drop isolated noise specks out in the backdrop.
    lab, n = ndimage.label(~removal)
    if n:
        sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
        specks = np.isin(lab, np.where(sizes < SPECK_MAX_PX)[0] + 1)
        if specks.any():
            print(f"  noise specks removed: {int((sizes < SPECK_MAX_PX).sum())} "
                  f"blobs ({int(specks.sum()):,} px)")
            removal |= specks

    # Feather the removal mask, then subtract it from the source alpha so
    # anti-aliased artwork edges keep their original softness.
    soft = np.asarray(
        Image.fromarray((removal * 255).astype(np.uint8)).filter(
            ImageFilter.GaussianBlur(FEATHER_PX)
        )
    ).astype(np.float64) / 255.0
    alpha_out = np.clip(alpha_src * (1.0 - soft), 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb.astype(np.uint8), alpha_out]), "RGBA")


def fitted(logo, size, fill_ratio, background):
    """Contain-fit the logo centred on a size x size canvas (never stretched)."""
    canvas = Image.new("RGBA", (size, size), background)
    target = int(size * fill_ratio)
    scale = min(target / logo.width, target / logo.height)
    resized = logo.resize(
        (max(round(logo.width * scale), 1), max(round(logo.height * scale), 1)),
        Image.LANCZOS,
    )
    canvas.alpha_composite(
        resized, ((size - resized.width) // 2, (size - resized.height) // 2)
    )
    return canvas


def default_source():
    for name in ("campusflow-logo.svg", "campusflow-logo.png", "campusflow-logo.jpeg"):
        candidate = ROOT / "public" / name
        if candidate.exists():
            return candidate
    raise SystemExit(
        "FAILED: no default source found -- looked for public/campusflow-logo."
        "{svg,png,jpeg}. Pass one explicitly: python scripts/generate-logo-assets.py <SOURCE>"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("source", nargs="?", default=None)
    ap.add_argument("--outdir", default=str(ROOT / "public"))
    args = ap.parse_args()

    src = Path(args.source) if args.source else default_source()
    out = Path(args.outdir)
    out.mkdir(parents=True, exist_ok=True)
    print(f"source: {src}")

    if src.suffix.lower() == ".svg":
        source_rgba = rasterize_svg(src)
        print(f"  rasterised SVG at {source_rgba.width}x{source_rgba.height}")
    else:
        source_rgba = Image.open(src).convert("RGBA")

    logo = clean_background(source_rgba)

    ys, xs = np.where(np.asarray(logo)[..., 3] > 16)
    if len(xs) == 0:
        raise SystemExit("FAILED: nothing survived background removal")
    box = (max(int(xs.min()) - PAD_PX, 0), max(int(ys.min()) - PAD_PX, 0),
           min(int(xs.max()) + 1 + PAD_PX, logo.width),
           min(int(ys.max()) + 1 + PAD_PX, logo.height))
    logo = logo.crop(box)
    print(f"  cropped artwork: {logo.width}x{logo.height} from {source_rgba.width}x{source_rgba.height}")

    # ---------------------------------------------------------- outputs
    logo.save(out / "campusflow-logo.png", optimize=True)
    fitted(logo, 192, ANY_FILL, (0, 0, 0, 0)).save(out / "pwa-192x192.png", optimize=True)
    fitted(logo, 512, ANY_FILL, (0, 0, 0, 0)).save(out / "pwa-512x512.png", optimize=True)
    fitted(logo, 192, MASKABLE_FILL, ICON_BG).save(out / "pwa-maskable-192x192.png", optimize=True)
    fitted(logo, 512, MASKABLE_FILL, ICON_BG).save(out / "pwa-maskable-512x512.png", optimize=True)
    fitted(logo, 180, APPLE_FILL, ICON_BG).save(out / "apple-touch-icon.png", optimize=True)

    if src.suffix.lower() == ".svg":
        # Vector source: the favicon can be vector too -- sharpest possible
        # browser-tab icon, no 30KB base64 blob.
        (out / "favicon.svg").write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    else:
        buf = io.BytesIO()
        fitted(logo, 128, FAVICON_FILL, (0, 0, 0, 0)).save(buf, "PNG", optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        (out / "favicon.svg").write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="64" height="64">\n'
            f'  <image width="128" height="128" href="data:image/png;base64,{b64}"/>\n'
            "</svg>\n",
            encoding="utf-8",
        )

    # ------------------------------------------------------ verification
    print("verification:")
    for f in ["campusflow-logo.png", "pwa-192x192.png", "pwa-512x512.png",
              "pwa-maskable-192x192.png", "pwa-maskable-512x512.png",
              "apple-touch-icon.png", "favicon.svg"]:
        print(f"  {f}: {(out / f).stat().st_size:,} bytes")

    v = np.asarray(Image.open(out / "campusflow-logo.png")).astype(int)
    rgb, al = v[..., :3], v[..., 3]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    opaque = al > 200
    leftover = opaque & ((rgb.max(-1) - rgb.min(-1)) <= NEUTRAL_MAX_SPREAD + 2) \
        & (rgb.mean(-1) >= NEUTRAL_MIN_MEAN - 20)
    white = opaque & (r > 235) & (g > 235) & (b > 235)
    brand = opaque & (b > r) & (b > 120)
    print(f"  leftover neutral/white opaque px: {int(leftover.sum())} (want 0)")
    print(f"  white opaque px: {int(white.sum())} (want 0)")
    print(f"  brand-coloured opaque px: {int(brand.sum()):,} (must be > 0)")
    if leftover.sum() or white.sum() or not brand.any():
        raise SystemExit("FAILED: verification did not pass")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
