"""
Regenerate every CampusFlow logo asset from a single source image.

Usage (from anywhere):

    python scripts/generate-logo-assets.py [SOURCE] [--outdir PUBLIC_DIR]

    SOURCE      Logo image to clean up and export. May be SVG (preferred --
                vector sources are rasterised, capped around 2400px) or a
                raster format (JPEG/PNG).
                Defaults to the first entry of SOURCE_PREFERENCE that
                exists in public/ -- currently public/CampusFlow_Logo.jpeg.
    PUBLIC_DIR  Output directory (default: <repo>/public).

Requirements: Python 3 with Pillow, numpy and scipy. SVG sources additionally
need `pip install resvg-py`.

What it does
------------
1. Removes the image background *dynamically*: the dominant neutral tones
   found along the image border (checkerboard grays, white, light gray ...)
   are detected first, then every pixel matching those tones -- anywhere in
   the image, including patches enclosed inside the emblem -- becomes
   transparent, together with the anti-aliasing bands chaining them to the
   brand artwork. Works for white backgrounds, light AND dark checkerboards,
   and already-transparent sources alike. Tuned to this logo family (navy /
   electric blue / cyan): if a future logo contains genuine neutral-gray
   artwork, relax the constants below.
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
                                    when the source SVG is small, otherwise
                                    an embedded 128px PNG)
4. Verifies the output and exits non-zero if anything looks wrong, so a
   bad source never silently ships.

The source file itself is never modified. public/CampusFlow_Logo.jpeg is the
current master artwork -- swap that file to rebrand, then re-run the script.
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

# --- background detection -------------------------------------------------
NEUTRAL_MAX_SPREAD = 30   # max(r,g,b) - min(r,g,b): "gray enough" to be bg/AA
NEUTRAL_MIN_MEAN = 140    # light neutrals (white patches) are always background
TONE_TOL = 16             # luminance tolerance when matching a border tone
TONE_MIN_SHARE = 0.02     # a border cluster must cover 2% of the border row
CHAIN_FLOOR_CAP = 60      # never chain-absorb neutrals darker than this ...
CHAIN_FLOOR_RATIO = 0.55  # ... or darker than 55% of the darkest bg tone
SPECK_MAX_PX = 40         # isolated noise blobs in the backdrop
BRIGHT_FRINGE_LUM = 140    # near-white pixels this bright, this close to the
BRIGHT_FRINGE_SPREAD = 48  # edge and this barely-coloured = JPEG ringing, not
BRIGHT_FRINGE_DIST = 10    # artwork (brand colours stay far more saturated)
FEATHER_PX = 0.6          # edge softening
PAD_PX = 8                # crop padding around the artwork
MAX_RASTER_EDGE = 2400    # SVG rasterisation cap (output pixels)
VECTOR_FAVICON_MAX = 65 * 1024  # small SVGs become the favicon directly

# icon layout
ANY_FILL = 0.94           # transparent install icons
MASKABLE_FILL = 0.60      # inside the 80%-diameter maskable safe zone
APPLE_FILL = 0.72         # iOS adds its own crop/padding
FAVICON_FILL = 0.92
ICON_BG = (246, 247, 251, 255)  # manifest background_color #f6f7fb

# Master source, checked in this order when the script is run with no
# arguments. Put the file you actually swap FIRST -- everything else in
# public/ is generated output.
SOURCE_PREFERENCE = (
    "CampusFlow_Logo.jpeg",   # <-- the file you edit/swap
    "campusflow-logo.svg",
    "campusflow-logo.png",
    "campusflow-logo.jpeg",
)
# --------------------------------------------------------------------------


def detect_bg_tones(rgb, alpha):
    """Dominant neutral luminances along the image border = background tones."""
    h, w, _ = rgb.shape
    ring = np.concatenate([
        rgb[:6].reshape(-1, 3), rgb[-6:].reshape(-1, 3),
        rgb[:, :6].reshape(-1, 3), rgb[:, -6:].reshape(-1, 3),
    ])
    ring_a = np.concatenate([
        alpha[:6].ravel(), alpha[-6:].ravel(),
        alpha[:, :6].ravel(), alpha[:, -6:].ravel(),
    ])
    spread = ring.max(-1) - ring.min(-1)
    keep = (spread <= NEUTRAL_MAX_SPREAD) & (ring_a > 10)
    lum = ring[keep].mean(-1)
    if lum.size < 50:
        return []
    hist, edges = np.histogram(lum, bins=range(0, 266, 5))
    tones = []
    for i in np.argsort(hist)[::-1]:
        if hist[i] < TONE_MIN_SHARE * lum.size:
            break
        centre = (edges[i] + edges[i + 1]) / 2
        if all(abs(centre - t) > TONE_TOL * 2 for t in tones):
            tones.append(centre)
        if len(tones) >= 3:
            break
    return sorted(tones)


def rasterize_svg(path):
    """Render an SVG source to RGBA, capped around MAX_RASTER_EDGE px."""
    import resvg_py

    probe = Image.open(io.BytesIO(resvg_py.svg_to_bytes(svg_path=str(path), zoom=0.1)))
    native_max = max(probe.width, probe.height, 1) * 10  # probe was rendered at 0.1x
    zoom = min(3.0, MAX_RASTER_EDGE / native_max)
    png = resvg_py.svg_to_bytes(svg_path=str(path), zoom=zoom)
    return Image.open(io.BytesIO(png)).convert("RGBA")


def clean_background(img):
    """Return RGBA with the detected background removed globally.

    Works on fully-opaque sources (JPEG / checkerboard PNGs / traced SVGs)
    and on sources with real alpha: existing transparency is kept.
    """
    src = np.asarray(img.convert("RGBA")).astype(np.int16)
    rgb, alpha_src = src[..., :3].astype(np.float64), src[..., 3].astype(np.float64)
    spread = rgb.max(-1) - rgb.min(-1)
    lum = rgb.mean(-1)
    neutral = spread <= NEUTRAL_MAX_SPREAD

    tones = detect_bg_tones(rgb.astype(np.uint8), alpha_src.astype(np.uint8))
    floor = min(CHAIN_FLOOR_CAP, CHAIN_FLOOR_RATIO * min(tones)) if tones else None
    print(f"  detected background tones: {[round(t) for t in tones] or 'none'}"
          + (f" | chain floor: {floor:.0f}" if tones else ""))

    # Seed = pixel matching a detected tone (anywhere -- catches cells seen
    # through holes in the emblem too), plus any light neutral (white
    # patches are background in every source variant seen so far).
    if tones:
        tone_match = np.minimum.reduce([np.abs(lum - t) for t in tones]) <= TONE_TOL
        seeds = (alpha_src > 0) & neutral & tone_match
    else:
        seeds = np.zeros(lum.shape, bool)
    seeds |= (alpha_src > 0) & neutral & (lum >= NEUTRAL_MIN_MEAN)

    removal = seeds.copy()
    print(f"  seed background pixels: {int(removal.sum()):,} "
          f"({removal.mean():.1%})")

    if tones:
        # Chain-absorb the anti-aliasing bands connecting background to
        # artwork: expand through neutral pixels down to the floor.
        allowed = neutral & (lum >= floor) & (alpha_src > 0)
        prev = -1
        for _ in range(400):
            count = int(removal.sum())
            if count == prev:
                break
            prev = count
            grown = ndimage.binary_dilation(removal, structure=np.ones((3, 3), bool))
            removal |= grown & allowed
        print(f"  after chain absorption: {int(removal.sum()):,} "
              f"({removal.mean():.1%})")
    else:
        # No border tones (already-clean transparent source): only feather
        # light neutrals sitting right next to transparency.
        if removal.any():
            dil = ndimage.binary_dilation(removal, structure=np.ones((7, 7), bool))
            fringe = (~removal) & neutral & (lum >= 60) & (alpha_src > 0) & dil
            removal |= fringe
            print(f"  edge-fringe pixels: {int(fringe.sum()):,}")

    # JPEG ringing: bright, barely-coloured pixels hugging the artwork edge.
    # Real brand artwork is far more saturated (see BRIGHT_FRINGE_SPREAD), so
    # this only ever strips compression speckle around the silhouette.
    opaque = alpha_src > 0
    edge = ndimage.binary_dilation(
        (~opaque) | removal, structure=np.ones((2 * BRIGHT_FRINGE_DIST + 1,) * 2, bool)
    )
    ringing = (~removal) & opaque & edge & (lum >= BRIGHT_FRINGE_LUM) & (spread <= BRIGHT_FRINGE_SPREAD)
    if ringing.any():
        print(f"  bright edge-ringing pixels: {int(ringing.sum()):,}")
        removal |= ringing

    # Drop isolated noise specks in the backdrop.
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
    return (
        Image.fromarray(np.dstack([rgb.astype(np.uint8), alpha_out])),
        tones,
        floor,
    )


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
    # Edit SOURCE_PREFERENCE to change which file wins when no argument is
    # given. Keep the master source listed here in sync with your logo file.
    for name in SOURCE_PREFERENCE:
        candidate = ROOT / "public" / name
        if candidate.exists():
            return candidate
    raise SystemExit(
        "FAILED: no default source found -- looked in public/ for "
        + ", ".join(SOURCE_PREFERENCE)
        + ". Pass one explicitly: python scripts/generate-logo-assets.py <SOURCE>"
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

    logo, tones, floor = clean_background(source_rgba)

    ys, xs = np.where(np.asarray(logo)[..., 3] > 16)
    if len(xs) == 0:
        raise SystemExit("FAILED: nothing survived background removal")
    box = (max(int(xs.min()) - PAD_PX, 0), max(int(ys.min()) - PAD_PX, 0),
           min(int(xs.max()) + 1 + PAD_PX, logo.width),
           min(int(ys.max()) + 1 + PAD_PX, logo.height))
    logo = logo.crop(box)
    print(f"  cropped artwork: {logo.width}x{logo.height} "
          f"from {source_rgba.width}x{source_rgba.height}")

    # ---------------------------------------------------------- outputs
    logo.save(out / "campusflow-logo.png", optimize=True)
    fitted(logo, 192, ANY_FILL, (0, 0, 0, 0)).save(out / "pwa-192x192.png", optimize=True)
    fitted(logo, 512, ANY_FILL, (0, 0, 0, 0)).save(out / "pwa-512x512.png", optimize=True)
    fitted(logo, 192, MASKABLE_FILL, ICON_BG).save(out / "pwa-maskable-192x192.png", optimize=True)
    fitted(logo, 512, MASKABLE_FILL, ICON_BG).save(out / "pwa-maskable-512x512.png", optimize=True)
    fitted(logo, 180, APPLE_FILL, ICON_BG).save(out / "apple-touch-icon.png", optimize=True)

    if src.suffix.lower() == ".svg" and src.stat().st_size <= VECTOR_FAVICON_MAX:
        # Small vector source: the favicon can be vector too.
        (out / "favicon.svg").write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    else:
        # Large (e.g. traced) SVGs are too heavy for a browser tab -- embed
        # a crisp raster instead.
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
    rgb_v, al_v = v[..., :3], v[..., 3]
    spread_v = rgb_v.max(-1) - rgb_v.min(-1)
    lum_v = rgb_v.mean(-1)
    neutral_v = spread_v <= NEUTRAL_MAX_SPREAD + 2
    opaque = al_v > 200
    # Anything at/above the midpoint between the chain floor and the darkest
    # background tone that is still neutral = a background cell that survived.
    flag = ((floor + min(tones)) / 2) if tones else 120
    leftover = opaque & neutral_v & (lum_v >= flag)
    white = opaque & (rgb_v[..., 0] > 235) & (rgb_v[..., 1] > 235) & (rgb_v[..., 2] > 235)
    brand = opaque & (rgb_v[..., 2] > rgb_v[..., 0]) & (rgb_v[..., 2] > 120)
    print(f"  leftover background-tone px (flag >= {flag:.0f}): "
          f"{int(leftover.sum())} (want 0)")
    print(f"  white opaque px: {int(white.sum())} (want 0)")
    print(f"  brand-coloured opaque px: {int(brand.sum()):,} (must be > 0)")
    if leftover.sum() or white.sum() or not brand.any():
        raise SystemExit("FAILED: verification did not pass")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
