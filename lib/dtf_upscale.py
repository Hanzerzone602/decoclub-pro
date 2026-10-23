#!/usr/bin/env python3
"""72 DPI client art → true 300 DPI print PNG for DTF.

Edge-preserving bilateral filter, multi-step Lanczos, then a controlled
unsharp so lettering stays crisp. Alpha is kept and de-haloed. Optional
border-connected background removal. PNG is saved with dpi=(300, 300),
which writes a pHYs chunk of 11811 pixels/meter.

usage: dtf_upscale.py IN.png OUT.png [--width-in 12] [--remove-bg]
"""
from __future__ import annotations

import argparse
import json
import sys
import time

import cv2
import numpy as np
from PIL import Image, ImageOps

DPI = 300
MAX_IN = 16.0
DEFAULT_IN = 12.0
# 300 / 0.0254 = 11811.0236 → Pillow stores 11811 px/m.
PHYS_PPM = int(round(DPI / 0.0254))
MAX_EDGE = int(MAX_IN * DPI)  # 4800
MAX_PIXELS = MAX_EDGE * MAX_EDGE
# A 12000×12000 source used about 2 GB. Stop before that decode.
MAX_INPUT_PIXELS = 50_000_000
Image.MAX_IMAGE_PIXELS = MAX_INPUT_PIXELS


def source_dpi(im: Image.Image) -> float:
    dpi = im.info.get("dpi")
    if isinstance(dpi, (tuple, list)) and dpi and dpi[0]:
        try:
            val = float(dpi[0])
            if val > 1:
                return val
        except (TypeError, ValueError):
            pass
    return 72.0


def reject_huge(width: int, height: int) -> None:
    pixels = int(width) * int(height)
    if pixels > MAX_INPUT_PIXELS:
        raise ValueError(
            "This image is too large to upscale (%d×%d px, about %.0f megapixels). Please use an image under 50 megapixels."
            % (int(width), int(height), pixels / 1_000_000.0)
        )


def load_rgba(path: str) -> tuple[np.ndarray, float]:
    try:
        im = Image.open(path)
    except Image.DecompressionBombError:
        raise ValueError(
            "This image is too large to upscale. Please use an image under 50 megapixels."
        ) from None
    reject_huge(*im.size)
    try:
        im = ImageOps.exif_transpose(im)
    except Image.DecompressionBombError:
        raise ValueError(
            "This image is too large to upscale. Please use an image under 50 megapixels."
        ) from None
    reject_huge(*im.size)
    dpi = source_dpi(im)
    if im.mode == "P":
        im = im.convert("RGBA" if "transparency" in im.info else "RGB")
    if im.mode == "RGBA":
        arr = np.array(im)
    elif im.mode == "RGB":
        rgb = np.array(im)
        arr = np.dstack([rgb, np.full(rgb.shape[:2], 255, np.uint8)])
    elif im.mode == "LA":
        la = np.array(im)
        arr = np.dstack([la[:, :, 0], la[:, :, 0], la[:, :, 0], la[:, :, 1]])
    elif im.mode == "L":
        g = np.array(im)
        arr = np.dstack([g, g, g, np.full(g.shape, 255, np.uint8)])
    else:
        im = im.convert("RGBA")
        arr = np.array(im)
    if arr.ndim != 3 or arr.shape[2] != 4:
        raise ValueError("Could not read that image")
    return arr, dpi


def _border_labels(labels: np.ndarray) -> set[int]:
    labs = set(np.unique(labels[0, :]).tolist())
    labs.update(np.unique(labels[-1, :]).tolist())
    labs.update(np.unique(labels[:, 0]).tolist())
    labs.update(np.unique(labels[:, -1]).tolist())
    labs.discard(0)
    return labs


def remove_background(rgba: np.ndarray) -> np.ndarray:
    """Drop a flat or lightly graded sheet that touches the border.

    Logos that already have a real alpha hole are left alone when the
    border is already mostly transparent.
    """
    rgb = rgba[:, :, :3].astype(np.float32)
    alpha = rgba[:, :, 3]
    h, w = alpha.shape
    if h < 4 or w < 4:
        return rgba
    if float((alpha < 16).mean()) > 0.08 and float(alpha[:2, :].mean()) < 40:
        return rgba
    band = np.concatenate([
        rgb[0, :, :], rgb[-1, :, :], rgb[:, 0, :], rgb[:, -1, :],
    ], axis=0)
    med = np.median(band, axis=0)
    dist = np.sqrt(np.maximum(0.0, ((rgb - med) ** 2).sum(axis=2)))
    # Flat paper is tight; a mild gradient still sits near the border median.
    tol = 18.0 + float(np.median(np.abs(band - med))) * 1.6
    tol = float(np.clip(tol, 18.0, 42.0))
    cand = ((dist <= tol) & (alpha >= 8)).astype(np.uint8)
    n, labels = cv2.connectedComponents(cand, connectivity=8)
    if n <= 1:
        return rgba
    bg = np.isin(labels, list(_border_labels(labels)))
    out = rgba.copy()
    out[bg, 3] = 0
    out[bg, :3] = 0
    return out


def dehalo(rgba: np.ndarray) -> np.ndarray:
    """Replace semi-transparent fringe RGB with nearby opaque ink.

    Stops a white or colored sheet from showing as a halo after the
    background is gone. Fully transparent pixels are zeroed.
    """
    rgb = rgba[:, :, :3]
    alpha = rgba[:, :, 3]
    opaque = alpha >= 250
    clear = alpha <= 8
    fringe = ~(opaque | clear)
    out = rgba.copy()
    if not opaque.any():
        out[clear, :3] = 0
        out[clear, 3] = 0
        return out
    if fringe.any():
        color = rgb.copy()
        known = opaque.copy()
        kernel = np.ones((3, 3), np.uint8)
        # A few dilations cover typical 1–3 px JPEG fringes without walking
        # across a wide soft shadow.
        for _ in range(6):
            grown = cv2.dilate(color, kernel)
            grown_known = cv2.dilate(known.astype(np.uint8), kernel).astype(bool)
            take = fringe & grown_known & ~known
            if not take.any():
                break
            color[take] = grown[take]
            known |= take
        out[:, :, :3] = color
    out[clear, :3] = 0
    out[clear, 3] = 0
    return out


def bilateral_rgb(rgb: np.ndarray) -> np.ndarray:
    h, w = rgb.shape[:2]
    if min(h, w) < 8:
        return rgb
    # Small diameter stays fast on phone-sized client art and still
    # holds letter edges better than a gaussian blur.
    d = 5 if max(h, w) >= 1400 else 7
    return cv2.bilateralFilter(rgb, d=d, sigmaColor=28, sigmaSpace=6)


def target_size(sw: int, sh: int, width_in: float) -> tuple[int, int, float, float]:
    width_in = float(width_in or DEFAULT_IN)
    if not np.isfinite(width_in):
        width_in = DEFAULT_IN
    width_in = float(np.clip(width_in, 1.0, MAX_IN))
    aspect = sh / float(sw) if sw else 1.0
    height_in = width_in * aspect
    if height_in > MAX_IN:
        height_in = MAX_IN
        width_in = height_in / aspect if aspect else MAX_IN
    tw = max(1, int(round(width_in * DPI)))
    th = max(1, int(round(height_in * DPI)))
    tw = min(tw, MAX_EDGE)
    th = min(th, MAX_EDGE)
    if tw * th > MAX_PIXELS:
        scale = (MAX_PIXELS / float(tw * th)) ** 0.5
        tw = max(1, int(tw * scale))
        th = max(1, int(th * scale))
    width_in = tw / float(DPI)
    height_in = th / float(DPI)
    return tw, th, width_in, height_in


def lanczos_steps(img: np.ndarray, tw: int, th: int) -> np.ndarray:
    """Grow by at most 2× per step so Lanczos does not turn type into mush."""
    h, w = img.shape[:2]
    if w == tw and h == th:
        return img
    # Downscale in one step. Upscale in ≤2× hops, then a final exact size.
    if tw <= w and th <= h:
        return cv2.resize(img, (tw, th), interpolation=cv2.INTER_LANCZOS4)
    guard = 0
    while (w < tw or h < th) and guard < 8:
        guard += 1
        sx = tw / float(w)
        sy = th / float(h)
        step = min(2.0, max(sx, sy))
        if step <= 1.001:
            break
        nw = tw if sx <= step + 1e-6 else min(tw, max(w + 1, int(round(w * step))))
        nh = th if sy <= step + 1e-6 else min(th, max(h + 1, int(round(h * step))))
        # Keep the requested aspect on each hop.
        if w < tw and h < th:
            hop = min(2.0, tw / float(w), th / float(h))
            nw = min(tw, max(w + 1, int(round(w * hop))))
            nh = min(th, max(h + 1, int(round(h * hop))))
        img = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_LANCZOS4)
        h, w = img.shape[:2]
    if w != tw or h != th:
        img = cv2.resize(img, (tw, th), interpolation=cv2.INTER_LANCZOS4)
    return img


def unsharp_edges(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Crisp ink edges, quiet flats. Amount is clamped so halos stay small."""
    blur = cv2.GaussianBlur(rgb, (0, 0), 1.05)
    sharp = cv2.addWeighted(rgb, 1.42, blur, -0.42, 0)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    mag = np.abs(cv2.Laplacian(gray, cv2.CV_16S, ksize=3)).astype(np.float32)
    edge = np.clip((mag - 6.0) / 28.0, 0.0, 1.0)
    edge = cv2.GaussianBlur(edge, (0, 0), 0.7)
    opaque = np.clip((alpha.astype(np.float32) - 200.0) / 55.0, 0.0, 1.0)
    mask = (edge * opaque)[..., None]
    mixed = rgb.astype(np.float32) * (1.0 - mask) + sharp.astype(np.float32) * mask
    return np.clip(mixed, 0, 255).astype(np.uint8)


def upscale(rgba: np.ndarray, width_in: float, remove_bg: bool) -> tuple[np.ndarray, float, float]:
    if remove_bg:
        rgba = remove_background(rgba)
    rgba = dehalo(rgba)
    rgb = bilateral_rgb(rgba[:, :, :3])
    alpha = rgba[:, :, 3]
    sh, sw = rgb.shape[:2]
    tw, th, width_in, height_in = target_size(sw, sh, width_in)
    rgb = lanczos_steps(rgb, tw, th)
    alpha = lanczos_steps(alpha, tw, th)
    rgb = unsharp_edges(rgb, alpha)
    out = np.dstack([rgb, alpha])
    return out, width_in, height_in


def save_png(path: str, rgba: np.ndarray) -> None:
    Image.fromarray(rgba, "RGBA").save(path, format="PNG", dpi=(DPI, DPI))


def run(src: str, dst: str, width_in: float, remove_bg: bool) -> dict:
    t0 = time.perf_counter()
    rgba, src_dpi = load_rgba(src)
    sh, sw = rgba.shape[:2]
    out, width_in, height_in = upscale(rgba, width_in, remove_bg)
    oh, ow = out.shape[:2]
    save_png(dst, out)
    elapsed = time.perf_counter() - t0
    return {
        "ok": True,
        "src_px": [int(sw), int(sh)],
        "out_px": [int(ow), int(oh)],
        "src_dpi": round(float(src_dpi), 2),
        "dpi": DPI,
        "width_in": round(float(width_in), 3),
        "height_in": round(float(height_in), 3),
        "phys_ppm": PHYS_PPM,
        "remove_background": bool(remove_bg),
        "seconds": round(elapsed, 3),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Upscale client art to a 300 DPI DTF PNG")
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--width-in", type=float, default=DEFAULT_IN)
    ap.add_argument("--remove-bg", action="store_true")
    args = ap.parse_args()
    try:
        meta = run(args.src, args.dst, args.width_in, args.remove_bg)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(meta))
    return 0


if __name__ == "__main__":
    sys.exit(main())
