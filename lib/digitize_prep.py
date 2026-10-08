#!/usr/bin/env python3
"""
digitize_prep.py — free/local "digitize prep" front-end.

Raster image -> clean, embroidery-ready vector layers for HZ's stitch
generator (lib/digitize.js -> lib/stitch/ in the DecoClub site repo).

Output contract (matches lib/digitize.js digitizeLayers() + stitch/geom.js):
  {
    widthIn, heightIn,
    layers: [ { hex, nameGuess, paths: [ { d, hole:false, kind, widthMm, ... } ] } ],
    sourceRgba: [r,g,b,a,...] (flat int array; digitize.js indexes it directly),
    sourceW, sourceH,
    fabric, warnings, stats, ...
  }
  * path d is absolute SVG (M/L/C/Z only) in INCHES, origin top-left.
  * Holes: geom.js rasterizeLayer() fills each path with nested even-odd and
    then UNIONs the paths of a layer, ignoring the `hole` flag. A separate
    hole path would therefore be filled in. So every hole ring is emitted as
    a sub-path inside its outer ring's compound `d` (hole:false). `holes`
    carries the number of hole rings for reference.
  * Layer order = stitch order (background-most/largest first). buildObjects
    sequences colours by layerIndex.

Pipeline (all sizes in mm, px/mm = image px width / (widthIn * 25.4)):
  1. fabric (border-connected flat bg / transparency) detection,
     Lab k-means quantization (max-colors cap, merge dE<10), mode filter,
     speck + thin-region merge (<1 mm wide or <1 mm^2 -> neighbour sharing the
     longest border). Exactly one label per pixel.
  2. underlap: each colour grows ~0.7 mm under colours that stitch later
     (never into fabric, never over earlier colours).
  3. per-part widthMm (2 x p90 of distance transform on the skeleton) and
     kind run/satin/fill.
  4. potrace CLI tracing (alphamax 1.0, opttolerance 0.2, turdsize = 1 mm^2)
     on a 2-3x upsampled working raster.
  5. sourceRgba/sourceW/sourceH, nameGuess.
  6. warnings for thin columns and small lettering.
  7. optional SVG preview.

Free/permissive deps only: numpy, opencv, scipy, scikit-image, Pillow,
potrace CLI (GPL binary invoked as a separate process, not linked).
Does NOT import or modify lib/trace.py.
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys

import numpy as np
import cv2
from PIL import Image, ImageOps
from scipy import ndimage as ndi

try:
    from skimage.morphology import skeletonize as _sk_skeletonize
except Exception:  # pragma: no cover
    _sk_skeletonize = None

VERSION = "digitize_prep 1.4"
UNDERLAP_WIDTH_FRAC = 0.15   # underlap <= 15% of the covering shape's local width ...
UNDERLAP_MIN_MM = 0.25       # ... but at least 0.25 mm (no gaps) and at most --fabric underlap (0.7 mm)
TARGET_PPM = 10.0        # working raster: at least 10 px per mm
MAX_WORK_SIDE = 2200     # cap working raster size

# CLI fabric -> (HZ stitch/fabric.js preset id, min width mm, underlap mm)
FABRICS = {
    "tee":   {"hz": "jersey", "minWidthMm": 1.0, "underlapMm": 0.7},
    "polo":  {"hz": "pique",  "minWidthMm": 1.0, "underlapMm": 0.8},
    "cap":   {"hz": "cap",    "minWidthMm": 1.2, "underlapMm": 0.6},
    "towel": {"hz": "fleece", "minWidthMm": 1.5, "underlapMm": 1.0},
    "woven": {"hz": "woven",  "minWidthMm": 0.9, "underlapMm": 0.5},
}

COLOR_NAMES = [
    ("Black", (0, 0, 0)), ("White", (255, 255, 255)), ("Off White", (245, 240, 225)),
    ("Cream", (255, 248, 220)), ("Ivory", (250, 245, 230)), ("Light Gray", (200, 200, 200)),
    ("Gray", (128, 128, 128)), ("Charcoal", (54, 69, 79)), ("Silver", (192, 192, 192)),
    ("Red", (220, 20, 30)), ("Dark Red", (139, 0, 0)), ("Maroon", (110, 20, 40)),
    ("Crimson", (180, 20, 50)), ("Pink", (255, 160, 190)), ("Hot Pink", (255, 70, 160)),
    ("Magenta", (200, 0, 160)), ("Orange", (240, 120, 30)), ("Burnt Orange", (204, 85, 0)),
    ("Dark Orange", (255, 140, 0)), ("Gold", (255, 195, 30)), ("Old Gold", (190, 150, 60)),
    ("Yellow", (255, 230, 0)), ("Light Yellow", (255, 245, 150)), ("Tan", (210, 180, 140)),
    ("Beige", (225, 205, 170)), ("Khaki", (195, 176, 145)), ("Brown", (120, 70, 30)),
    ("Dark Brown", (70, 40, 20)), ("Chocolate", (90, 50, 30)), ("Peach", (255, 200, 160)),
    ("Skin", (235, 190, 160)), ("Olive", (110, 110, 30)), ("Lime", (150, 210, 40)),
    ("Green", (30, 150, 60)), ("Kelly Green", (40, 170, 70)), ("Dark Green", (0, 90, 40)),
    ("Forest Green", (35, 80, 45)), ("Mint", (160, 230, 190)), ("Teal", (0, 128, 128)),
    ("Turquoise", (40, 200, 200)), ("Aqua", (110, 220, 230)), ("Sky Blue", (120, 190, 235)),
    ("Light Blue", (170, 205, 235)), ("Royal Blue", (40, 80, 200)), ("Blue", (20, 70, 180)),
    ("Navy", (25, 40, 75)), ("Dark Navy", (15, 22, 45)), ("Purple", (100, 40, 150)),
    ("Violet", (140, 80, 200)), ("Lavender", (190, 170, 225)), ("Plum", (110, 40, 90)),
]


# ----------------------------------------------------------------- colour ---
def rgb_to_lab(rgb):
    """rgb uint8 (...,3) -> float32 CIE Lab (L 0..100)."""
    a = np.asarray(rgb, dtype=np.float32) / 255.0
    shp = a.shape
    lab = cv2.cvtColor(a.reshape(-1, 1, 3), cv2.COLOR_RGB2LAB)
    return lab.reshape(shp)


def lab_to_rgb(lab):
    a = np.asarray(lab, dtype=np.float32)
    shp = a.shape
    rgb = cv2.cvtColor(a.reshape(-1, 1, 3), cv2.COLOR_LAB2RGB).reshape(shp)
    return np.clip(np.round(rgb * 255.0), 0, 255).astype(np.uint8)


def to_hex(rgb):
    r, g, b = [int(v) for v in rgb]
    return "#%02x%02x%02x" % (r, g, b)


_NAME_LABS = None


def name_guess(rgb):
    global _NAME_LABS
    if _NAME_LABS is None:
        _NAME_LABS = rgb_to_lab(np.array([c for _, c in COLOR_NAMES], np.uint8))
    lab = rgb_to_lab(np.array([rgb], np.uint8))[0]
    d = np.linalg.norm(_NAME_LABS - lab, axis=1)
    return COLOR_NAMES[int(np.argmin(d))][0]


# ------------------------------------------------------------------ input ---
def load_rgba(path):
    im = Image.open(path)
    im = ImageOps.exif_transpose(im).convert("RGBA")
    return np.array(im)


def working_raster(rgba, width_in):
    h, w = rgba.shape[:2]
    ppm_src = w / (width_in * 25.4)
    if ppm_src < TARGET_PPM:
        s = float(min(3, math.ceil(TARGET_PPM / ppm_src)))
    else:
        s = 1.0
    s = min(s, MAX_WORK_SIDE / float(max(w, h)))
    rgb = rgba[:, :, :3]
    alpha = rgba[:, :, 3]
    # light JPEG/noise clean-up at source res (edge preserving)
    rgb = cv2.medianBlur(np.ascontiguousarray(rgb), 3)
    if abs(s - 1.0) > 1e-6:
        nw, nh = max(2, int(round(w * s))), max(2, int(round(h * s)))
        interp = cv2.INTER_CUBIC if s > 1 else cv2.INTER_AREA
        rgb = cv2.resize(rgb, (nw, nh), interpolation=interp)
        alpha = cv2.resize(alpha, (nw, nh), interpolation=cv2.INTER_LINEAR)
    ppm = rgb.shape[1] / (width_in * 25.4)
    return np.ascontiguousarray(rgb), np.ascontiguousarray(alpha), ppm, ppm_src, s


# ------------------------------------------------------------ fabric / bg ---
def border_mask(h, w, t=2):
    b = np.zeros((h, w), bool)
    b[:t, :] = b[-t:, :] = True
    b[:, :t] = b[:, -t:] = True
    return b


def border_connected_guarded(cand, ppm, neck_mm=2.0):
    """Border-connected part of `cand`, not following necks narrower than
    neck_mm. Design areas painted in the background colour (grey fur on a grey
    backdrop) often touch the backdrop through narrow necks: open the mask,
    keep border-connected pieces, then regrow only a thin rim so the true edge
    is restored but necks are not followed into the design."""
    h, w = cand.shape
    bord = border_mask(h, w, 1)
    r = max(1, int(round(0.5 * neck_mm * ppm)))
    opened = cv2.morphologyEx(cand.astype(np.uint8), cv2.MORPH_OPEN, disk(r)).astype(bool)
    n, cc = cv2.connectedComponents(opened.astype(np.uint8), connectivity=8)
    ids = np.unique(cc[bord & opened])
    core = np.isin(cc, ids[ids > 0])
    fab = cand & cv2.dilate(core.astype(np.uint8), disk(r + 2)).astype(bool)
    n, cc = cv2.connectedComponents(fab.astype(np.uint8), connectivity=8)
    ids = np.unique(cc[core])
    return np.isin(cc, ids[ids > 0])


def detect_fabric(lab, alpha, ppm, bg_de=12.0, neck_mm=2.0):
    """Return (fabric_seed_mask, bg_lab or None, info)."""
    h, w = alpha.shape
    bord = border_mask(h, w)
    trans = alpha < 128
    if trans.mean() > 0.01 and trans[bord].mean() > 0.5:
        return trans, None, {"method": "alpha", "fraction": float(trans.mean())}
    blab = lab[bord & ~trans]
    if len(blab) == 0:
        return trans, None, {"method": "none"}
    bg = np.median(blab, axis=0)
    near_b = np.linalg.norm(blab - bg, axis=1) < bg_de
    if near_b.mean() < 0.6:
        return trans, None, {"method": "none", "borderAgreement": float(near_b.mean())}
    cand = (np.linalg.norm(lab - bg, axis=2) < bg_de) | trans
    fab = border_connected_guarded(cand, ppm, neck_mm)
    if fab.mean() > 0.985:
        return trans, None, {"method": "none", "reason": "whole image is background"}
    return fab, bg, {"method": "border-flood", "bgHex": to_hex(lab_to_rgb(bg[None])[0]),
                     "fraction": float(fab.mean())}


# ------------------------------------------------------------- quantize ---
def quantize_palette(lab_pix, max_colors, merge_de=10.0, min_share=0.004, bg_lab=None, seed=7):
    n = len(lab_pix)
    rng = np.random.default_rng(seed)
    samp = lab_pix if n <= 80000 else lab_pix[rng.choice(n, 80000, replace=False)]
    k0 = int(min(16, max_colors + 4, max(1, len(np.unique(samp.round(0), axis=0)))))
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.2)
    cv2.setRNGSeed(seed)
    _, lbl, centers = cv2.kmeans(samp.astype(np.float32), k0, None, crit, 3, cv2.KMEANS_PP_CENTERS)
    centers = [c.astype(np.float64) for c in centers]
    counts = list(np.bincount(lbl.ravel(), minlength=k0).astype(np.float64))
    total = float(sum(counts))

    def drop_empty():
        keep = [i for i in range(len(centers)) if counts[i] > 0]
        return [centers[i] for i in keep], [counts[i] for i in keep]

    centers, counts = drop_empty()
    while len(centers) > 1:
        C = np.array(centers)
        D = np.linalg.norm(C[:, None] - C[None], axis=2)
        np.fill_diagonal(D, np.inf)
        i, j = np.unravel_index(np.argmin(D), D.shape)
        shares = np.array(counts) / total
        small = int(np.argmin(shares))
        if D[i, j] < merge_de:
            a, b = (i, j) if counts[i] >= counts[j] else (j, i)
            wa, wb = counts[a], counts[b]
            centers[a] = (centers[a] * wa + centers[b] * wb) / (wa + wb)
            counts[a] += counts[b]
            counts[b] = 0
        elif len(centers) > max_colors or shares[small] < min_share:
            a = int(np.argmin(D[small]))
            counts[a] += counts[small]
            counts[small] = 0
        else:
            break
        centers, counts = drop_empty()
    # colours that are really the background colour are handled by bg seed
    if bg_lab is not None:
        keep = [i for i, c in enumerate(centers) if np.linalg.norm(c - bg_lab) >= merge_de]
        centers = [centers[i] for i in keep]
    return np.array(centers, np.float32)


def nearest_label(lab_img, centers, chunk=1 << 20):
    flat = lab_img.reshape(-1, 3)
    out = np.empty(len(flat), np.int32)
    C = centers.astype(np.float32)
    for s in range(0, len(flat), chunk):
        x = flat[s:s + chunk]
        d = ((x[:, None, :] - C[None]) ** 2).sum(-1)
        out[s:s + chunk] = np.argmin(d, axis=1)
    return out.reshape(lab_img.shape[:2])


# --------------------------------------------------------------- cleanup ---
def mode_filter(lab_map, n_labels, k):
    if k < 3:
        return lab_map
    best = np.full(lab_map.shape, -1.0, np.float32)
    out = lab_map.copy()
    for l in range(n_labels):
        m = (lab_map == l).astype(np.float32)
        if not m.any():
            continue
        v = cv2.boxFilter(m, -1, (k, k), normalize=False, borderType=cv2.BORDER_REPLICATE)
        v += m * 0.5  # tie-break toward the current label
        upd = v > best
        best[upd] = v[upd]
        out[upd] = l
    return out


def smooth_labels(lab_map, n_labels, sigma):
    """Soft-majority (Gaussian-weighted argmax) boundary smoothing: removes the
    +-1 px jitter of upsampled JPEG edges before potrace. Keeps one label/pixel."""
    if sigma < 0.5:
        return lab_map
    best = np.full(lab_map.shape, -1.0, np.float32)
    out = lab_map.copy()
    for l in range(n_labels):
        m = (lab_map == l).astype(np.float32)
        if not m.any():
            continue
        v = cv2.GaussianBlur(m, (0, 0), sigma, borderType=cv2.BORDER_REPLICATE) + m * 1e-3
        upd = v > best
        best[upd] = v[upd]
        out[upd] = l
    return out


class MergeCtx:
    """Shared state for the clean-up passes."""
    def __init__(self, ppm, label_lab, hole_min_w_mm=0.6, hole_min_area_mm2=0.3):
        self.ppm = ppm
        self.label_lab = label_lab      # label -> Lab colour (None = unknown, e.g. alpha fabric)
        self.hole_min_w_mm = hole_min_w_mm
        self.hole_min_area_mm2 = hole_min_area_mm2
        self.runs = []                  # thin pieces to sew as running stitch
        self.lost = []                  # removed detail (no run produced)
        self.counters = 0               # holes kept open by the counter exemption
        self.lab_img = None             # working Lab image (anti-alias rim split)
        self.rims_split = 0
        self.src_ppm = None
        self.src_de_lab = None     # raw source image in Lab (keyline colour check)
        self.src_scale = 1.0       # working px per source px
        self.rims_kept_by_guard = 0
        self.dots_kept = 0              # small round dots (punctuation) kept by merge_pieces


def is_blend_rim(l, nb_counts, ctx, width_mm):
    """An anti-alias rim: very thin, or its colour is a mix of its two main
    neighbours (orange|black edge quantized to brown)."""
    if width_mm < 0.3:
        return True
    c = ctx.label_lab.get(l)
    if c is None or len(nb_counts) < 2:
        return False
    top = [k for k, _ in sorted(nb_counts.items(), key=lambda kv: -kv[1])[:2]]
    A, B = ctx.label_lab.get(top[0]), ctx.label_lab.get(top[1])
    if A is None or B is None:
        return False
    t = np.linspace(0.1, 0.9, 17)[:, None]
    mix = t * A[None] + (1 - t) * B[None]
    return float(np.min(np.linalg.norm(mix - c[None], axis=1))) < 10.0


def jpeg_seam_sized(width_mm, length_mm, src_ppm):
    """JPEG-fringe guard (shared with edge_fringe_test): a blend-coloured thin
    line is only treated as an anti-alias/JPEG seam when it is a hairline in the
    source (< EDGE_FRINGE_MAX_SRC_PX) AND short (< EDGE_FRINGE_MAX_LEN_MM).
    Longer, wider lines are deliberate keylines."""
    if not src_ppm:
        return True
    return width_mm * src_ppm < EDGE_FRINGE_MAX_SRC_PX and length_mm < EDGE_FRINGE_MAX_LEN_MM


KEYLINE_CORE_DE = 6.0        # a deliberate keyline is solid: its source pixels match its colour


def solid_core(ctx, l, comp, x0, y0):
    """Median source dE of a thin piece to its own colour is small (solid line,
    not a mix of the two sides)."""
    c = ctx.label_lab.get(l) if ctx.label_lab else None
    if c is None or ctx.lab_img is None:
        return False
    sk = _sk_skeletonize(comp) if _sk_skeletonize is not None else comp
    ys, xs = np.nonzero(sk & comp) if (sk & comp).any() else np.nonzero(comp)
    if not len(ys):
        return False
    if ctx.src_de_lab is not None:
        # judge on the RAW source pixels (before median filter and upsampling, which
        # wash out a 1-2 px line): along the centreline, the best-matching source
        # pixel in a 3x3 window. A solid keyline has its colour there; an AA/JPEG
        # mix of the two sides does not.
        src = ctx.src_de_lab
        sh, sw = src.shape[:2]
        sx = np.clip(((xs + x0 + 0.5) / ctx.src_scale).astype(int), 0, sw - 1)
        sy = np.clip(((ys + y0 + 0.5) / ctx.src_scale).astype(int), 0, sh - 1)
        bx0, by0 = max(0, sx.min() - 1), max(0, sy.min() - 1)
        bx1, by1 = min(sw, sx.max() + 2), min(sh, sy.max() + 2)
        de = np.linalg.norm(src[by0:by1, bx0:bx1] - c[None, None], axis=2).astype(np.float32)
        de = cv2.erode(de, np.ones((3, 3), np.uint8))
        v = de[sy - by0, sx - bx0]
    else:
        hh, ww = comp.shape
        de = np.linalg.norm(ctx.lab_img[y0:y0 + hh, x0:x0 + ww] - c[None, None], axis=2).astype(np.float32)
        v = cv2.erode(de, np.ones((3, 3), np.uint8))[ys, xs]
    return float(np.median(v)) <= KEYLINE_CORE_DE


KEYLINE_MIN_W_MM = 0.1       # keylines may be finer than the 0.3 mm run floor (1-2 source px)
KEYLINE_THREAD_FRAC = 3.0    # its colour must be a real thread: >= 3x the line's area elsewhere


def is_keyline(ctx, l, comp, x0, y0, lab_map, area_px, ppm):
    """A thin piece drawn on purpose between two colours: long or wide in the
    source (not JPEG-seam sized), solid colour along its centreline, and in a
    colour that is a real thread elsewhere in the design."""
    if l <= 0 or area_px < 0.3 * ppm * ppm:
        return False
    cw_mm, cl_mm = comp_width_len_mm(comp, ppm)
    if cw_mm < KEYLINE_MIN_W_MM or jpeg_seam_sized(cw_mm, cl_mm, ctx.src_ppm):
        return False
    if int((lab_map == l).sum()) < (1.0 + KEYLINE_THREAD_FRAC) * area_px:
        return False
    return solid_core(ctx, l, comp, x0, y0)


def comp_width_len_mm(comp, ppm):
    """Mean width (area / skeleton length) and skeleton length of a thin piece, mm."""
    sk = skel_len_px(comp)
    return float(comp.sum()) / max(1.0, sk) / ppm, sk / ppm


def skel_len_px(mask):
    if _sk_skeletonize is None:
        return float(mask.sum()) ** 0.5
    return float(_sk_skeletonize(mask).sum())


def is_counter(comp, crop, l, x0, y0, lab_map, ccs, stats_all, ctx, width_mm):
    """A hole/counter: region enclosed by a single other shape E, showing the
    colour that surrounds E (or fabric). Long thin lines are not counters."""
    k3 = np.ones((3, 3), np.uint8)
    ring = cv2.dilate(comp.astype(np.uint8), k3).astype(bool) & ~comp
    nb = crop[ring]
    if len(nb) == 0:
        return False
    cnt = np.bincount(nb)
    n = int(cnt.argmax())
    if n == l or cnt[n] < 0.9 * len(nb):
        return False
    # elongated lines (whiskers inside fur) are not counters
    if skel_len_px(comp) / ctx.ppm > 6.0 * max(width_mm, 0.1):
        return False
    if l == 0:
        return True
    ys, xs = np.nonzero(ring & (crop == n))
    if n not in ccs:
        return False
    cc_n = ccs[n]
    eid = cc_n[ys[0] + y0, xs[0] + x0]
    if eid <= 0:
        return False
    ex, ey, ew, eh = stats_all[n][eid, :4]
    H, W = lab_map.shape
    ex0, ey0, ex1, ey1 = max(0, ex - 2), max(0, ey - 2), min(W, ex + ew + 2), min(H, ey + eh + 2)
    E = cc_n[ey0:ey1, ex0:ex1] == eid
    filled = ndi.binary_fill_holes(E)
    if filled.sum() > 15 * comp.sum():
        return False   # E is a big shape (badge disc), not a glyph with a counter
    outer = cv2.dilate(filled.astype(np.uint8), k3).astype(bool) & ~filled
    ol = lab_map[ey0:ey1, ex0:ex1][outer]
    if len(ol) == 0:
        return True  # E touches the image border all round
    return int(np.bincount(ol).argmax()) == l


def collect_runs(lab_img, lab_map, label_rgb, label_lab, ctx, ppm, min_w_mm, design):
    """Thin lines of each thread colour -> running-stitch centrelines.
    Sources (unioned per colour, so nothing is sewn twice):
      * thin regions / thin branches already removed from the fill (ctx.runs);
      * a line detector on the colour-distance map: a black top-hat finds
        valleys of 'distance to this thread colour' narrower than min_w, which
        catches anti-aliased hairlines (whiskers) whose core + AA rim the
        quantizer split into two colours.
    Lines that are only an anti-alias blend of their two neighbours, narrower
    than 0.3 mm, or shorter than 1.5 mm are rejected."""
    H, W = lab_map.shape
    r = max(1, int(round(0.5 * min_w_mm * ppm)))
    k3 = np.ones((3, 3), np.uint8)
    # thread palette = colours that survive as fills; a thin piece of a colour that
    # only existed as thin/AA pixels is sewn in the nearest surviving thread
    present = [l for l in label_rgb if l > 0 and (lab_map == l).any()]
    plabs = {l: rgb_to_lab(np.array([label_rgb[l]], np.uint8))[0] for l in present}
    for rp in ctx.runs:
        if rp["label"] not in plabs and present:
            c0 = label_lab.get(rp["label"])
            if c0 is None and rp["label"] in label_rgb:
                c0 = rgb_to_lab(np.array([label_rgb[rp["label"]]], np.uint8))[0]
            if c0 is not None:
                rp["label"] = min(present, key=lambda q: float(np.linalg.norm(plabs[q] - c0)))
    cols = sorted(present)
    items = []
    for l in cols:
        c = plabs[l]
        d = np.linalg.norm(lab_img - c[None, None, :], axis=2).astype(np.float32)
        closed = cv2.morphologyEx(d, cv2.MORPH_CLOSE, disk(r))
        line = ((closed - d) > 25.0) & (d < 35.0) & design & (lab_map != l)
        kmask = np.zeros((H, W), bool)
        for rp in ctx.runs:
            if rp["label"] == l:
                hh, ww = rp["mask"].shape
                line[rp["y0"]:rp["y0"] + hh, rp["x0"]:rp["x0"] + ww] |= rp["mask"]
                if rp.get("keyline"):
                    kmask[rp["y0"]:rp["y0"] + hh, rp["x0"]:rp["x0"] + ww] |= rp["mask"]
        line = cv2.morphologyEx(line.astype(np.uint8), cv2.MORPH_CLOSE, k3).astype(bool)
        n, cc, st, _ = cv2.connectedComponentsWithStats(line.astype(np.uint8), connectivity=8)
        for i in range(1, n):
            x, y, ww, hh, area = st[i]
            if max(ww, hh) < 1.2 * ppm or area < 0.2 * ppm * ppm:
                continue
            x0, y0 = max(0, x - 1), max(0, y - 1)
            x1, y1 = min(W, x + ww + 1), min(H, y + hh + 1)
            piece = cc[y0:y1, x0:x1] == i
            ring = cv2.dilate(piece.astype(np.uint8), k3).astype(bool) & ~piece
            nb = lab_map[y0:y1, x0:x1][ring]
            nb = nb[(nb != l)]
            nbc = {int(k): int(v) for k, v in enumerate(np.bincount(nb)) if v > 0} if len(nb) else {}
            pls, wmm, tot = run_polylines(piece, ppm)
            # a keyline kept by the merge stage is real art even below the 0.3 mm floor
            is_kl = bool(kmask[y0:y1, x0:x1][piece].mean() >= 0.5)
            if not pls or (wmm < 0.3 and not is_kl):
                continue
            if not is_kl and is_blend_rim(l, nbc, ctx, wmm):
                continue
            under = lab_map[y0:y1, x0:x1][piece]
            contrast = float(np.mean((closed - d)[y0:y1, x0:x1][piece]))
            items.append({"label": l, "polys": [pl + np.array([x0, y0]) for pl in pls], "widthMm": wmm,
                          "lengthMm": tot, "under": under, "source": "line", "bbox": (x0, y0, x1 - x0, y1 - y0),
                          "piece": piece, "contrast": contrast})
    # one hairline, one thread: an anti-aliased white whisker on black also shows
    # up as grey lines along its edges. Keep the highest-contrast colour.
    items.sort(key=lambda it: -it["contrast"])
    occ = np.zeros((H, W), bool)
    rad = max(1, int(round(0.35 * ppm)))
    kept = []
    for it in items:
        x0, y0, ww, hh = it["bbox"]
        sub = occ[y0:y0 + hh, x0:x0 + ww]
        if sub[it["piece"]].mean() > 0.5:
            continue
        kept.append(it)
        grown = cv2.dilate(it["piece"].astype(np.uint8), disk(rad)).astype(bool)
        sub |= grown
    for it in kept:
        it.pop("piece", None)
    return kept


def merge_small_regions(lab_map, n_labels, ppm, min_w_mm, min_area_mm2, ctx=None, protect_border_label0=True,
                        max_passes=8):
    """Merge every connected region narrower than min_w_mm (2 x max DT) or
    smaller than min_area_mm2 into the neighbour label it shares the longest
    border with. Border-touching fabric (label 0) is never merged.
    * holes/counters (enclosed by one shape, showing the surrounding colour or
      fabric) are kept unless < hole_min_w_mm wide or < hole_min_area_mm2;
    * thin non-rim regions are queued in ctx.runs (sewn as running stitch)
      before their pixels are handed to the neighbour."""
    if ctx is None:
        ctx = MergeCtx(ppm, {})
    h, w = lab_map.shape
    min_area_px = min_area_mm2 * ppm * ppm
    min_dt = 0.5 * min_w_mm * ppm
    hole_area_px = ctx.hole_min_area_mm2 * ppm * ppm
    hole_dt = 0.5 * ctx.hole_min_w_mm * ppm
    bord = border_mask(h, w, 1)
    k3 = np.ones((3, 3), np.uint8)
    total_merged = 0
    exempt = set()
    for _ in range(max_passes):
        cands = []
        ccs, stats_all = {}, {}
        for l in range(n_labels):
            m = lab_map == l
            if not m.any():
                continue
            n, cc, stats, _c = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
            ccs[l], stats_all[l] = cc, stats
            if n <= 1:
                continue
            dt = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 5)
            mx = ndi.maximum(dt, cc, index=np.arange(1, n))
            touch = np.zeros(n, bool)
            if l == 0 and protect_border_label0:
                touch[np.unique(cc[bord])] = True
            for i in range(1, n):
                if touch[i]:
                    continue
                area = stats[i, cv2.CC_STAT_AREA]
                if area < min_area_px or mx[i - 1] < min_dt:
                    x, y, ww, hh = stats[i, :4]
                    if (l, int(x), int(y), int(ww), int(hh), int(area)) in exempt:
                        continue
                    cands.append((area, l, i, x, y, ww, hh, float(mx[i - 1])))
        if not cands:
            break
        cands.sort()
        merged = 0
        for area, l, i, x, y, ww, hh, mxdt in cands:
            x0, y0 = max(0, x - 1), max(0, y - 1)
            x1, y1 = min(w, x + ww + 1), min(h, y + hh + 1)
            crop = lab_map[y0:y1, x0:x1]
            sub = (crop == l).astype(np.uint8)
            n2, cc2 = cv2.connectedComponents(sub, connectivity=8)
            if n2 <= 1:
                continue
            sizes = np.bincount(cc2.ravel())
            sizes[0] = -1
            j = int(np.argmin(np.abs(sizes - area))) if n2 > 2 else 1
            comp = cc2 == j
            width_mm = 2.0 * mxdt / ppm
            # counters / holes keep their shape unless really tiny
            if area >= hole_area_px and mxdt >= hole_dt and \
               is_counter(comp, crop, l, x0, y0, lab_map, ccs, stats_all, ctx, width_mm):
                exempt.add((l, int(x), int(y), int(ww), int(hh), int(area)))
                ctx.counters += 1
                continue
            ring = cv2.dilate(comp.astype(np.uint8), k3).astype(bool) & ~comp
            nb = crop[ring]
            nb = nb[nb != l]
            if len(nb) == 0:
                continue
            nbc = np.bincount(nb)
            target = int(nbc.argmax())
            thin = mxdt < min_dt
            # anti-alias rim between two colours: split it pixel-by-pixel to the
            # nearer neighbour colour so the true edge (and small counters) survive
            if thin and ctx.lab_img is not None and np.count_nonzero(nbc) >= 2:
                nb_counts = {int(k): int(v) for k, v in enumerate(nbc) if v > 0}
                top = [k for k, _ in sorted(nb_counts.items(), key=lambda kv: -kv[1])[:2]]
                A, B = ctx.label_lab.get(top[0]), ctx.label_lab.get(top[1])
                # keep it whole (-> run below) only if it is a real keyline; anything
                # else is split as before
                seam = not is_keyline(ctx, l, comp, x0, y0, lab_map, area, ppm)
                if not seam and is_blend_rim(l, nb_counts, ctx, 1.0):
                    ctx.rims_kept_by_guard += 1
                if seam and A is not None and B is not None and l in ctx.label_lab and ctx.label_lab[l] is not None \
                        and is_blend_rim(l, nb_counts, ctx, 1.0):
                    pix = ctx.lab_img[y0:y1, x0:x1][comp]
                    da = np.linalg.norm(pix - A[None], axis=1)
                    db = np.linalg.norm(pix - B[None], axis=1)
                    vals = np.where(da <= db, top[0], top[1]).astype(crop.dtype)
                    crop[comp] = vals
                    ctx.rims_split += 1
                    merged += 1
                    continue
            keyline = False
            if l > 0 and thin and area >= 0.3 * ppm * ppm:
                nb_counts = {int(k): int(v) for k, v in enumerate(nbc) if v > 0}
                keyline = is_keyline(ctx, l, comp, x0, y0, lab_map, area, ppm)
                if keyline or not is_blend_rim(l, nb_counts, ctx, width_mm):
                    ctx.runs.append({"label": int(l), "mask": comp.copy(), "x0": x0, "y0": y0,
                                     "source": "thin-region", "keyline": bool(keyline)})
                    comp_is_run = True
                else:
                    comp_is_run = False
            else:
                comp_is_run = False
            if comp_is_run and keyline and np.count_nonzero(nbc) >= 2 and ctx.lab_img is not None:
                # a keyline's pixels go back to its two sides pixel-by-pixel (as a
                # rim would), so the fills match the no-keyline result exactly
                nb_counts = {int(k): int(v) for k, v in enumerate(nbc) if v > 0}
                top = [k for k, _ in sorted(nb_counts.items(), key=lambda kv: -kv[1])[:2]]
                A, B = ctx.label_lab.get(top[0]), ctx.label_lab.get(top[1])
                if A is not None and B is not None and is_blend_rim(l, nb_counts, ctx, 1.0):
                    pix = ctx.lab_img[y0:y1, x0:x1][comp]
                    da = np.linalg.norm(pix - A[None], axis=1)
                    db = np.linalg.norm(pix - B[None], axis=1)
                    crop[comp] = np.where(da <= db, top[0], top[1]).astype(crop.dtype)
                    merged += 1
                    continue
            crop[comp] = target
            if (not comp_is_run) and l > 0 and area >= 2.0 * ppm * ppm and thin:
                ctx.lost.append({"label": int(l), "into": target, "areaMm2": area / (ppm * ppm),
                                 "bboxMm": [x / ppm, y / ppm, (x + ww) / ppm, (y + hh) / ppm]})
            merged += 1
        total_merged += merged
        if merged == 0:
            break
    return lab_map, total_merged


def auto_max_colors(max_dim_in):
    """Thread-count cap from finished size (larger dimension, inches)."""
    if max_dim_in <= 4.0:
        return 6
    if max_dim_in <= 8.0:
        return 8
    return 10


def auto_min_piece(max_dim_in, min_w_mm):
    """(min isolated piece area mm^2, thin-fragment width mm) for the size."""
    if max_dim_in <= 4.0:
        return 4.0, 1.5
    return 1.0, min_w_mm


def count_pieces(lab_map, labels):
    out = {}
    for l in labels:
        m = (lab_map == l).astype(np.uint8)
        out[l] = int(cv2.connectedComponents(m, connectivity=8)[0] - 1) if m.any() else 0
    return out


def merge_pieces(lab_map, ppm, min_piece_mm2, thin_mm, ctx, max_passes=6, force_labels=(), dot_min_w=1.0):
    """Size-scaled clean-up of fill colours (labels > 0): isolated pieces under
    min_piece_mm2, and short thin fragments (max width < thin_mm) that are not
    line art, are merged into the neighbour sharing the longest border.
    Counters (holes showing the surrounding colour) are exempt; fabric (label 0)
    is never touched; elongated thin lines (skeleton >= 5 mm and >= 4x width)
    are kept as narrow columns. Runs are collected separately and unaffected."""
    h, w = lab_map.shape
    min_px = min_piece_mm2 * ppm * ppm
    thin_dt = 0.5 * thin_mm * ppm
    k3 = np.ones((3, 3), np.uint8)
    exempt = set()
    total = 0
    for _ in range(max_passes):
        ccs, stats_all, cands = {}, {}, []
        for l in np.unique(lab_map):
            l = int(l)
            m = lab_map == l
            n, cc, st, _c = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
            ccs[l], stats_all[l] = cc, st
            if l == 0 or n <= 1:
                continue
            dt = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 5)
            mx = ndi.maximum(dt, cc, index=np.arange(1, n))
            for i in range(1, n):
                area = int(st[i, cv2.CC_STAT_AREA])
                key = (l,) + tuple(int(v) for v in st[i])
                if key in exempt:
                    continue
                if area < min_px or mx[i - 1] < thin_dt or l in force_labels:
                    cands.append((area, l, i, float(mx[i - 1]), key))
        if not cands:
            break
        cands.sort()
        merged = 0
        for area, l, i, mxdt, key in cands:
            x, y, ww, hh = key[1:5]
            x0, y0 = max(0, x - 1), max(0, y - 1)
            x1, y1 = min(w, x + ww + 1), min(h, y + hh + 1)
            crop = lab_map[y0:y1, x0:x1]
            comp = (ccs[l][y0:y1, x0:x1] == i) & (crop == l)
            if not comp.any():
                continue
            width_mm = 2.0 * mxdt / ppm
            if l in force_labels:
                pass
            elif is_counter(comp, crop, l, x0, y0, lab_map, ccs, stats_all, ctx, width_mm):
                exempt.add(key)
                continue
            # a round solid dot >= dot_min_w across (the period in "EST.") is
            # deliberate detail and sews as a small satin/tack dot: keep it
            if l not in force_labels and area < min_px and width_mm >= dot_min_w:
                cs, _h = cv2.findContours(comp.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
                per = sum(cv2.arcLength(c_, True) for c_ in cs)
                if per > 0 and 4.0 * np.pi * area / (per * per) >= 0.7:
                    exempt.add(key)
                    ctx.dots_kept += 1
                    continue
            if area >= min_px and l not in force_labels:   # thin but big enough: keep line art, merge stubs
                sk = skel_len_px(comp) / ppm
                if sk >= 5.0 and sk >= 4.0 * max(width_mm, 0.1):
                    exempt.add(key)
                    continue
            ring = cv2.dilate(comp.astype(np.uint8), k3).astype(bool) & ~comp
            nb = crop[ring]
            nb = nb[nb != l]
            if len(nb) == 0:
                exempt.add(key)
                continue
            crop[comp] = int(np.bincount(nb).argmax())
            merged += 1
        total += merged
        if merged == 0:
            break
    return lab_map, total


def surround_label(lab_map, n, piece, x0, y0, cache, with_area=False):
    """Dominant label around the label-n component that touches `piece`
    (optionally also the hole-filled area of that component in px)."""
    H, W = lab_map.shape
    if n not in cache:
        cnt, cc, st, _ = cv2.connectedComponentsWithStats((lab_map == n).astype(np.uint8), connectivity=8)
        cache[n] = (cc, st)
    cc, st = cache[n]
    ring = cv2.dilate(piece.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~piece
    ys, xs = np.nonzero(ring)
    ids = cc[np.clip(ys + y0, 0, H - 1), np.clip(xs + x0, 0, W - 1)]
    ids = ids[ids > 0]
    if len(ids) == 0:
        return (-1, 0) if with_area else -1
    eid = int(np.bincount(ids).argmax())
    ex, ey, ew, eh = st[eid, :4]
    ex0, ey0, ex1, ey1 = max(0, ex - 2), max(0, ey - 2), min(W, ex + ew + 2), min(H, ey + eh + 2)
    E = cc[ey0:ey1, ex0:ex1] == eid
    filled = ndi.binary_fill_holes(E)
    outer = cv2.dilate(filled.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~filled
    ol = lab_map[ey0:ey1, ex0:ex1][outer]
    lab_s = int(np.bincount(ol).argmax()) if len(ol) else -1
    return (lab_s, int(filled.sum())) if with_area else lab_s


def extract_thin_branches(lab_map, n_labels, ppm, min_w_mm, ctx):
    """Thin pieces of big regions (whisker roots, fine lines attached to a
    blob): residue of a morphological opening ~min_w wide that is long and
    narrow. Queue as runs and hand the pixels to the neighbouring colour."""
    r = max(1, int((min_w_mm * ppm - 1) // 2))
    k3 = np.ones((3, 3), np.uint8)
    taken = 0
    cc_cache = {}
    for l in range(1, n_labels):
        m = (lab_map == l).astype(np.uint8)
        if not m.any():
            continue
        opened = cv2.morphologyEx(m, cv2.MORPH_OPEN, disk(r))
        res = (m.astype(bool) & ~opened.astype(bool)).astype(np.uint8)
        n, cc, st, _ = cv2.connectedComponentsWithStats(res, connectivity=8)
        dt = cv2.distanceTransform(m, cv2.DIST_L2, 5)
        for i in range(1, n):
            x, y, ww, hh, area = st[i]
            if max(ww, hh) < 1.5 * ppm or area < 0.3 * ppm * ppm:
                continue
            x0, y0, x1, y1 = max(0, x - 1), max(0, y - 1), x + ww + 1, y + hh + 1
            piece = cc[y0:y1, x0:x1] == i
            sk = _sk_skeletonize(piece) if _sk_skeletonize is not None else piece
            L = sk.sum() / ppm
            if L < 1.5:
                continue
            wv = dt[y0:y1, x0:x1][sk]
            wmm = 2.0 * float(np.median(wv)) / ppm if len(wv) else 0.0
            if wmm > 0.85 or L < 3.0 * max(wmm, 0.2):
                continue
            crop = lab_map[y0:y1, x0:x1]
            ring = cv2.dilate(piece.astype(np.uint8), k3).astype(bool) & ~piece
            nb_all = crop[ring]
            # a real branch (whisker root) sticks out into another colour and touches
            # its parent blob only at the base; a fringe sliver along a boundary
            # touches the parent along its whole length -> leave it in the fill.
            if len(nb_all) == 0 or np.mean(nb_all == l) > 0.25:
                continue
            nb = nb_all[nb_all != l]
            if len(nb) == 0:
                continue
            tgt = int(np.bincount(nb).argmax())
            # negative space (gap between letters, notch of a 6): the piece has the
            # colour that surrounds the shape it cuts into -> it is not a line
            if surround_label(lab_map, tgt, piece, x0, y0, cc_cache) == l:
                continue
            ctx.runs.append({"label": int(l), "mask": piece.copy(), "x0": x0, "y0": y0, "source": "thin-branch"})
            crop[piece] = int(np.bincount(nb).argmax())
            taken += 1
    return lab_map, taken


# ------------------------------------------------------------ run stitches ---
_NB8 = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]


def _nbr_count(sk):
    k = np.ones((3, 3), np.float32)
    k[1, 1] = 0
    return cv2.filter2D(sk.astype(np.float32), -1, k, borderType=cv2.BORDER_CONSTANT).astype(np.int32) * sk


def prune_spurs(sk, spur_px, iters=3):
    sk = sk.copy()
    H, W = sk.shape
    for _ in range(iters):
        nb = _nbr_count(sk)
        eps = list(zip(*np.nonzero(nb == 1)))
        removed = False
        for (y, x) in eps:
            if not sk[y, x]:
                continue
            path = [(y, x)]
            seen = {(y, x)}
            cy, cx = y, x
            at_junction = False
            while len(path) <= spur_px:
                nxt = None
                for dy, dx in _NB8:
                    yy, xx = cy + dy, cx + dx
                    if 0 <= yy < H and 0 <= xx < W and sk[yy, xx] and (yy, xx) not in seen:
                        nxt = (yy, xx)
                        break
                if nxt is None:
                    break
                if nb[nxt] >= 3:
                    at_junction = True
                    break
                path.append(nxt)
                seen.add(nxt)
                cy, cx = nxt
            if at_junction and len(path) < spur_px:
                for q in path:
                    sk[q] = False
                removed = True
        if not removed:
            break
    return sk


def trace_polylines(sk):
    """Ordered pixel polylines of a 1-px skeleton, split at junctions; chain
    ends are extended to the touching junction pixel so pieces connect."""
    H, W = sk.shape
    nb = _nbr_count(sk)
    junc = sk & (nb >= 3)
    chain = sk & ~junc
    n, cc = cv2.connectedComponents(chain.astype(np.uint8), connectivity=8)
    polys = []
    for i in range(1, n):
        pts = set(zip(*np.nonzero(cc == i)))
        if not pts:
            continue

        def cnb(p):
            out = []
            for dy, dx in _NB8:
                q = (p[0] + dy, p[1] + dx)
                if q in pts:
                    out.append(q)
            return out
        start = next((p for p in pts if len(cnb(p)) <= 1), next(iter(pts)))
        order = [start]
        seen = {start}
        cur = start
        while True:
            nxt = [q for q in cnb(cur) if q not in seen]
            if not nxt:
                break
            cur = nxt[0]
            order.append(cur)
            seen.add(cur)
        for end_i in (0, -1):
            p = order[end_i]
            for dy, dx in _NB8:
                yy, xx = p[0] + dy, p[1] + dx
                if 0 <= yy < H and 0 <= xx < W and junc[yy, xx]:
                    if end_i == 0:
                        order.insert(0, (yy, xx))
                    else:
                        order.append((yy, xx))
                    break
        polys.append(np.array([(x, y) for (y, x) in order], np.float64))
    return polys


def chaikin(pts, iters=2):
    for _ in range(iters):
        if len(pts) < 3:
            return pts
        q = 0.75 * pts[:-1] + 0.25 * pts[1:]
        r = 0.25 * pts[:-1] + 0.75 * pts[1:]
        mid = np.empty((2 * len(q), 2))
        mid[0::2], mid[1::2] = q, r
        pts = np.vstack([pts[:1], mid, pts[-1:]])
    return pts


def poly_len(p):
    return float(np.sum(np.linalg.norm(np.diff(p, axis=0), axis=1))) if len(p) > 1 else 0.0


def run_polylines(piece, ppm, spur_mm=1.0, simplify_mm=0.1, min_total_mm=1.5):
    """piece: bool mask (crop). Returns (list of polylines in crop px, widthMm, totalLenMm)."""
    if _sk_skeletonize is None:
        return [], 0.0, 0.0
    pad = np.pad(piece, 1)
    dt = cv2.distanceTransform(pad.astype(np.uint8), cv2.DIST_L2, 5)
    sk = _sk_skeletonize(pad)
    wv = dt[sk]
    width_mm = 2.0 * float(np.median(wv)) / ppm if len(wv) else 0.0
    sk = prune_spurs(sk, max(2, int(round(spur_mm * ppm))))
    out = []
    for pl in trace_polylines(sk):
        if len(pl) < 2:
            continue
        ap = cv2.approxPolyDP(pl.astype(np.float32).reshape(-1, 1, 2), simplify_mm * ppm, False).reshape(-1, 2)
        ap = chaikin(ap.astype(np.float64), 2) - 1.0 + 0.5   # undo pad, pixel centre
        if poly_len(ap) / ppm >= 0.3:
            out.append(ap)
    total = sum(poly_len(p) for p in out) / ppm
    if total < min_total_mm:
        return [], width_mm, total
    return out, width_mm, total


# ------------------------------------------------------------ edge fringe ---
EDGE_FRINGE_FRAC = 0.7       # share of the line with two different colours on its two sides
EDGE_FRINGE_SIDE_MM = 1.0    # how far to look sideways (beyond the line's half-width)
EDGE_FRINGE_BLEND_DE = 12.0  # line colour within this dE of the A-B mix line = blend
EDGE_FRINGE_CORE_DE = 10.0   # source never really reaches the thread colour on the line
EDGE_FRINGE_MAX_SRC_PX = 3.5 # JPEG-fringe guard: source width strictly under this many source pixels ...
EDGE_FRINGE_MAX_LEN_MM = 6.0 # ... AND line length under this (else a deliberate keyline: keep)


def edge_fringe_test(polys, l, lab_map, labs, lab_img, ppm, width_mm, src_ppm=None):
    """Is a thin line (run centreline or sliver skeleton) only an edge fringe,
    i.e. a JPEG/anti-alias seam along the boundary between two OTHER colours?
    Fringe when >= 70% of its length has two different non-line, non-fabric
    colours on its two sides (within ~1 mm) AND it is either
      * a colour blend of those two sides (Lab dE to the A-B mix line < 12), or
      * mid-lightness between them with a source core that never matches the
        thread (median dE > 10).
    A line darker/lighter than both sides (keyline, outline) or whose source
    core matches its thread is kept. Returns (is_fringe, info)."""
    H, W = lab_map.shape
    d0 = max(1.0, 0.5 * width_mm * ppm + 1.0)
    dmax = d0 + EDGE_FRINGE_SIDE_MM * ppm
    step = max(1.0, 0.25 * ppm)
    n_s = n_two = 0
    pairs = {}
    core = []
    c_l = labs.get(l)
    for pl in polys:
        pl = np.asarray(pl, np.float64)
        if len(pl) < 2:
            continue
        seg = np.diff(pl, axis=0)
        sl = np.hypot(seg[:, 0], seg[:, 1])
        cum = np.concatenate([[0.0], np.cumsum(sl)])
        if cum[-1] <= 0:
            continue
        ts = np.arange(0.0, cum[-1] + 1e-9, step)
        k = np.clip(np.searchsorted(cum, ts, side="right") - 1, 0, len(seg) - 1)
        xs = np.interp(ts, cum, pl[:, 0])
        ys = np.interp(ts, cum, pl[:, 1])
        tx = seg[k, 0] / np.maximum(sl[k], 1e-9)
        ty = seg[k, 1] / np.maximum(sl[k], 1e-9)
        for x, y, nx, ny in zip(xs, ys, -ty, tx):
            n_s += 1
            sides = []
            for sg in (1.0, -1.0):
                got = None
                for d in np.arange(d0, dmax, 1.0):
                    xi, yi = int(round(x + sg * nx * d)), int(round(y + sg * ny * d))
                    if not (0 <= xi < W and 0 <= yi < H):
                        break
                    v = int(lab_map[yi, xi])
                    if v != l:
                        got = v
                        break
                sides.append(got)
            a, b = sides
            if a is not None and b is not None and a != b and a != 0 and b != 0:
                n_two += 1
                key = (min(a, b), max(a, b))
                pairs[key] = pairs.get(key, 0) + 1
            if lab_img is not None and c_l is not None:
                best = 1e9
                for d in np.arange(-d0, d0 + 1e-6, 0.5):
                    xi, yi = int(round(x + nx * d)), int(round(y + ny * d))
                    if 0 <= xi < W and 0 <= yi < H:
                        best = min(best, float(np.linalg.norm(lab_img[yi, xi] - c_l)))
                core.append(best)
    frac = n_two / float(max(1, n_s))
    info = {"twoColourFrac": round(frac, 2)}
    if frac < EDGE_FRINGE_FRAC or not pairs or c_l is None:
        return False, info
    # guard: only a JPEG-sized seam can be a fringe (hairline in the source AND short)
    len_mm = sum(poly_len(np.asarray(p_, np.float64)) for p_ in polys if len(p_) >= 2) / ppm
    src_px = width_mm * src_ppm if src_ppm else 0.0
    info.update(srcWidthPx=round(src_px, 2), lengthMm=round(len_mm, 1))
    guard_ok = src_px < EDGE_FRINGE_MAX_SRC_PX and len_mm < EDGE_FRINGE_MAX_LEN_MM
    a, b = max(pairs.items(), key=lambda kv: kv[1])[0]
    A, B = labs.get(a), labs.get(b)
    if A is None or B is None:
        return False, info
    AB = B - A
    t = float(np.clip(np.dot(c_l - A, AB) / max(1e-9, float(np.dot(AB, AB))), 0.0, 1.0))
    blend_de = float(np.linalg.norm(c_l - (A + t * AB)))
    between = min(A[0], B[0]) - 5.0 <= c_l[0] <= max(A[0], B[0]) + 5.0
    core_de = float(np.median(core)) if core else 0.0
    info.update(sides=[int(a), int(b)], blendDe=round(blend_de, 1), between=bool(between), coreDe=round(core_de, 1))
    fringe = blend_de < EDGE_FRINGE_BLEND_DE or (between and core_de > EDGE_FRINGE_CORE_DE)
    if fringe and not guard_ok:
        info["keptByGuard"] = True     # passes the colour tests but is too wide/long for a JPEG seam
        return False, info
    return bool(fringe), info


def drop_edge_fringe_slivers(lab_map, label_rgb, lab_img, ppm, max_w_mm=1.2, max_area_mm2=30.0, src_ppm=None):
    """Thin fill slivers (< max_w_mm wide, not enclosed by one colour) that are
    edge fringes: hand each pixel back to the nearest neighbouring colour."""
    H, W = lab_map.shape
    labs = {l: rgb_to_lab(np.array([label_rgb[l]], np.uint8))[0] for l in label_rgb if l > 0}
    dropped = []
    for l in sorted(labs):
        m = lab_map == l
        if not m.any():
            continue
        n, cc, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
        dt = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 5)
        mx = ndi.maximum(dt, cc, index=np.arange(1, n)) if n > 1 else []
        for i in range(1, n):
            x, y, ww, hh, area = [int(v) for v in st[i]]
            if 2.0 * mx[i - 1] >= max_w_mm * ppm or area > max_area_mm2 * ppm * ppm:
                continue
            pad = int(math.ceil((EDGE_FRINGE_SIDE_MM + max_w_mm) * ppm)) + 2
            x0, y0, x1, y1 = max(0, x - pad), max(0, y - pad), min(W, x + ww + pad), min(H, y + hh + pad)
            comp = cc[y0:y1, x0:x1] == i
            pls, wmm, tot = run_polylines(comp, ppm, min_total_mm=1.0)
            if not pls:
                continue
            sub = lab_map[y0:y1, x0:x1]
            ok, info = edge_fringe_test(pls, l, sub, labs, lab_img[y0:y1, x0:x1], ppm, wmm, src_ppm=src_ppm)
            if not ok:
                continue
            # give every sliver pixel to the nearest pixel of another colour
            _, (iy, ix) = ndi.distance_transform_edt(comp, return_indices=True)
            sub[comp] = sub[iy[comp], ix[comp]]
            info.update(kind="sliver", hex=to_hex(label_rgb[l]), widthMm=round(wmm, 2), lengthMm=round(tot, 1),
                        areaMm2=round(area / (ppm * ppm), 2),
                        bboxMm=[round(x / ppm, 1), round(y / ppm, 1), round((x + ww) / ppm, 1), round((y + hh) / ppm, 1)])
            dropped.append(info)
    return lab_map, dropped


# ------------------------------------------------------------ run planning ---
def _end_dir(pl, at_start, ppm, back_mm=1.0):
    """Unit vector pointing OUT of the polyline at one end (estimated over ~1 mm)."""
    pts = pl if not at_start else pl[::-1]
    end = pts[-1]
    need = back_mm * ppm
    acc = 0.0
    ref = pts[0]
    for k in range(len(pts) - 2, -1, -1):
        acc += float(np.hypot(*(pts[k + 1] - pts[k])))
        ref = pts[k]
        if acc >= need:
            break
    v = end - ref
    n = float(np.hypot(*v))
    return v / n if n > 1e-9 else np.zeros(2)


def join_runs(polys, ppm, gap_mm=1.0, max_angle_deg=45.0):
    """Greedily join polylines (same colour) whose endpoints are within gap_mm and
    that continue each other (direction change < max_angle_deg).
    polys: list of dict(poly=Nx2 px, widthMm). Returns (list, n_joins)."""
    cosmax = math.cos(math.radians(max_angle_deg))
    gap = gap_mm * ppm
    items = [dict(it) for it in polys]
    joins = 0
    while True:
        best = None
        for a in range(len(items)):
            pa = items[a]["poly"]
            for ea in (False, True):          # False = end of a, True = start of a
                PA = pa[0] if ea else pa[-1]
                da = _end_dir(pa, ea, ppm)
                for b in range(len(items)):
                    if b == a:
                        continue
                    pb = items[b]["poly"]
                    for eb in (True, False):  # join a's end to b's start (or end)
                        PB = pb[0] if eb else pb[-1]
                        g = PB - PA
                        dist = float(np.hypot(*g))
                        if dist > gap:
                            continue
                        db_in = -_end_dir(pb, eb, ppm)    # direction INTO b at that end
                        if float(np.dot(da, db_in)) < cosmax:
                            continue
                        if dist > 0.3 * ppm and float(np.dot(da, g / dist)) < cosmax:
                            continue
                        score = dist - 2.0 * float(np.dot(da, db_in))
                        if best is None or score < best[0]:
                            best = (score, a, ea, b, eb)
        if best is None:
            break
        _, a, ea, b, eb = best
        pa = items[a]["poly"][::-1] if ea else items[a]["poly"]      # ends at the joint
        pb = items[b]["poly"] if eb else items[b]["poly"][::-1]      # starts at the joint
        la, lb = poly_len(pa), poly_len(pb)
        w = (items[a]["widthMm"] * la + items[b]["widthMm"] * lb) / max(la + lb, 1e-9)
        merged = dict(items[a])
        merged["poly"] = np.vstack([pa, pb])
        merged["widthMm"] = w
        items = [it for k, it in enumerate(items) if k not in (a, b)] + [merged]
        joins += 1
    return items, joins


def clip_covered_run(pl, ppm, cov, step_px, min_piece_mm=3.0, ignore_gap_mm=0.5):
    """Remove the parts of polyline pl that lie on later layers (cov: bool per
    sample, samples every step_px along the line). Covered ends are clipped;
    a covered middle splits the line, and only uncovered pieces >= min_piece_mm
    are kept. Covered gaps shorter than ignore_gap_mm are bridged (the later fill
    hides them anyway; splitting there would only add a trim)."""
    seg = np.diff(pl, axis=0)
    cum = np.concatenate([[0.0], np.cumsum(np.hypot(seg[:, 0], seg[:, 1]))])
    n = len(cov)
    c = cov.copy()
    gap = max(1, int(round(ignore_gap_mm * ppm / step_px)))
    k = 0
    while k < n:                      # bridge short interior covered gaps
        if c[k]:
            j = k
            while j < n and c[j]:
                j += 1
            if k > 0 and j < n and (j - k) < gap:
                c[k:j] = False
            k = j
        else:
            k += 1
    out = []
    k = 0
    while k < n:
        if not c[k]:
            j = k
            while j < n and not c[j]:
                j += 1
            t0, t1 = k * step_px, min((j - 1) * step_px, cum[-1])
            if (t1 - t0) / ppm >= min_piece_mm:
                keep = (cum > t0) & (cum < t1)
                p0 = [np.interp(t0, cum, pl[:, 0]), np.interp(t0, cum, pl[:, 1])]
                p1 = [np.interp(t1, cum, pl[:, 0]), np.interp(t1, cum, pl[:, 1])]
                out.append(np.vstack([np.array(p0)[None], pl[keep], np.array(p1)[None]]))
            k = j
        else:
            k += 1
    return out


def plan_runs(run_items, lab_map, order, label_rgb, ppm, min_len_mm=3.0, clip_frac=0.10, min_late_mm=15.0,
              late_colors="all", light_margin_l=15.0, fold_mode="knockout", lab_img=None, src_ppm=None):
    """Join, drop short runs, and decide which layer each run is sewn in.
    Returns (list of dict(label, host, poly, widthMm, sewAfter), stats).
    Dropped runs need no give-back: run pixels were already handed to the
    surrounding colour when the thin piece left the fill (line detections never
    removed fill pixels)."""
    H, W = lab_map.shape
    idx_of = {l: i for i, l in enumerate(order)}
    lut = np.full(int(lab_map.max()) + 1, -1, np.int32)
    for l, i in idx_of.items():
        if l < len(lut):
            lut[l] = i
    labs = {l: rgb_to_lab(np.array([label_rgb[l]], np.uint8))[0] for l in order if l in label_rgb}
    st = {"runsIn": 0, "runsJoined": 0, "runsDroppedShort": 0, "runsEndClipped": 0,
          "runsLate": 0, "runsMovedToSameColourLayer": 0, "lateVisitColours": 0, "edgeFringeDropped": 0}
    st["edgeFringeRuns"] = []
    by_lab = {}
    for it in run_items:
        for pl in it["polys"]:
            by_lab.setdefault(it["label"], []).append({"poly": np.asarray(pl, np.float64), "widthMm": it["widthMm"]})
            st["runsIn"] += 1
    planned = []
    for l, pls in by_lab.items():
        pls, nj = join_runs(pls, ppm)
        st["runsJoined"] += nj
        own = idx_of[l]
        for it in pls:
            pl = it["poly"]
            if poly_len(pl) / ppm < min_len_mm:
                st["runsDroppedShort"] += 1
                continue
            # JPEG / anti-alias seam between two other colours: not art. Run pixels
            # already belong to the neighbouring colours, so dropping is enough.
            fr, finfo = edge_fringe_test([pl], l, lab_map, labs, lab_img, ppm, it["widthMm"], src_ppm=src_ppm)
            if finfo.get("keptByGuard"):
                st["edgeFringeKeptByGuard"] = st.get("edgeFringeKeptByGuard", 0) + 1
            if fr:
                st["edgeFringeDropped"] += 1
                b = pl / ppm
                finfo.update(kind="run", hex=to_hex(label_rgb[l]), widthMm=round(it["widthMm"], 2),
                             lengthMm=round(poly_len(pl) / ppm, 1),
                             bboxMm=[round(float(b[:, 0].min()), 1), round(float(b[:, 1].min()), 1),
                                     round(float(b[:, 0].max()), 1), round(float(b[:, 1].max()), 1)])
                st["edgeFringeRuns"].append(finfo)
                continue
            # sample the line every ~0.25 px and look at the layer underneath
            seg = np.diff(pl, axis=0)
            sl = np.hypot(seg[:, 0], seg[:, 1])
            cum = np.concatenate([[0.0], np.cumsum(sl)])
            ts = np.arange(0.0, cum[-1] + 1e-9, 0.25)
            xs = np.interp(ts, cum, pl[:, 0])
            ys = np.interp(ts, cum, pl[:, 1])
            xi = np.clip(np.round(xs).astype(int), 0, W - 1)
            yi = np.clip(np.round(ys).astype(int), 0, H - 1)
            under = lut[np.clip(lab_map[yi, xi], 0, len(lut) - 1)]
            cov = under > own
            frac = float(cov.mean()) if len(cov) else 0.0
            need = int(under[cov].max()) if cov.any() else own
            host, sew = l, own
            if 0 < frac < clip_frac:
                # tiny cover: clip covered ends, keep in its own layer (an interior
                # covered bit is simply covered by the later fill, no extra split)
                k0 = int(np.argmax(~cov))
                k1 = len(cov) - int(np.argmax(~cov[::-1]))
                if k0 > 0 or k1 < len(cov):
                    t0, t1 = ts[k0], ts[k1 - 1]
                    keep = (cum > t0) & (cum < t1)
                    p0 = np.array([np.interp(t0, cum, pl[:, 0]), np.interp(t0, cum, pl[:, 1])])
                    p1 = np.array([np.interp(t1, cum, pl[:, 0]), np.interp(t1, cum, pl[:, 1])])
                    pl = np.vstack([p0[None], pl[keep], p1[None]])
                    st["runsEndClipped"] += 1
            elif frac >= clip_frac:
                # same thread in a later layer (>= the layer that would cover it)?
                same = [order[i] for i in range(need, len(order)) if order[i] != l and order[i] in labs
                        and l in labs and float(np.linalg.norm(labs[order[i]] - labs[l])) < 10.0]
                if same:
                    host, sew = same[0], idx_of[same[0]]
                    st["runsMovedToSameColourLayer"] += 1
                else:
                    sew = need
                    st["runsLate"] += 1
            # light detail over darker later fill (whiskers on fur)?
            light_over = False
            if cov.any() and l in labs:
                ul = [labs[order[i]][0] for i in under[cov] if order[i] in labs]
                if ul:
                    light_over = float(labs[l][0]) - float(np.median(ul)) >= light_margin_l
            planned.append({"lightOver": light_over, "covLen": float(cov.sum()) * 0.25 / ppm,
                            "label": l, "host": host, "poly": pl, "widthMm": it["widthMm"], "sewAfter": sew,
                            "late": host == l and sew > own})
    # which colours keep their late visit (one extra colour stop each)?
    #  * enough thread: late runs total >= min_late_mm;
    #  * late_colors="light": only light detail over darker later fill (white
    #    whiskers on grey fur); dark lines are sewn in their own layer and the
    #    bits a later fill would cover are clipped. "all" keeps every late
    #    colour, "none" folds every late colour back.
    late_len, light_len = {}, {}
    for r in planned:
        if r["late"]:
            L_ = poly_len(r["poly"]) / ppm
            late_len[r["label"]] = late_len.get(r["label"], 0.0) + L_
            if r["lightOver"]:
                light_len[r["label"]] = light_len.get(r["label"], 0.0) + L_
    keep_late = set()
    for l, L_ in late_len.items():
        if L_ < min_late_mm or late_colors == "none":
            continue
        if late_colors == "light" and light_len.get(l, 0.0) < 0.5 * L_:
            continue
        keep_late.add(l)
    st["runsLateFolded"] = 0
    st["lateColoursFolded"] = sorted(to_hex(label_rgb[l]) for l in late_len if l not in keep_late)
    st["foldedPiecesDropped"] = 0
    st["foldedRunsSplit"] = 0
    H_, W_ = lab_map.shape
    new_planned = []
    for r in planned:
        if r["late"] and r["label"] not in keep_late:
            own = idx_of[r["label"]]
            pl = r["poly"]
            seg = np.diff(pl, axis=0)
            cum = np.concatenate([[0.0], np.cumsum(np.hypot(seg[:, 0], seg[:, 1]))])
            ts = np.arange(0.0, cum[-1] + 1e-9, 0.25)
            xi = np.clip(np.round(np.interp(ts, cum, pl[:, 0])).astype(int), 0, W_ - 1)
            yi = np.clip(np.round(np.interp(ts, cum, pl[:, 1])).astype(int), 0, H_ - 1)
            under = lut[np.clip(lab_map[yi, xi], 0, len(lut) - 1)]
            st["runsLateFolded"] += 1
            st["runsLate"] -= 1
            if fold_mode == "knockout":
                # keep the whole line in its own layer and cut a corridor for it
                # out of the later fills, so nothing sews over it
                q = dict(r)
                q.update(late=False, sewAfter=own, knockout=True)
                new_planned.append(q)
                st["foldedKnockouts"] = st.get("foldedKnockouts", 0) + 1
                continue
            pieces = clip_covered_run(pl, ppm, under > own, 0.25, min_piece_mm=min_len_mm)
            if not pieces:
                st["foldedPiecesDropped"] += 1
            if len(pieces) > 1:
                st["foldedRunsSplit"] += 1
            for pc in pieces:
                q = dict(r)
                q.update(poly=pc, late=False, sewAfter=own)
                new_planned.append(q)
        else:
            new_planned.append(r)
    planned = new_planned
    # at most ONE late visit per colour: every late run of a colour shares the max
    late_max = {}
    for r in planned:
        if r["late"]:
            late_max[r["label"]] = max(late_max.get(r["label"], 0), r["sewAfter"])
    for r in planned:
        if r["late"]:
            r["sewAfter"] = late_max[r["label"]]
    st["lateVisitColours"] = len(late_max)
    st["runsOut"] = len(planned)
    return planned, st


# ---------------------------------------------------------------- potrace ---
_TOK = re.compile(r"[MmLlCcZz]|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")


def potrace_rings(mask, ox, oy, turdsize, alphamax=1.0, opttol=0.2):
    """Trace a binary mask with the potrace CLI. Returns rings in working-px
    coordinates: list of dict(start=(x,y), segs=[('L',p) | ('C',c1,c2,p)], poly=np.array)."""
    mask = np.ascontiguousarray(mask.astype(np.uint8))
    h, w = mask.shape
    pbm = b"P4\n%d %d\n" % (w, h) + np.packbits(mask, axis=1).tobytes()
    res = subprocess.run(["potrace", "-b", "svg", "-a", str(alphamax), "-O", str(opttol),
                          "-t", str(int(turdsize)), "-o", "-", "-"],
                         input=pbm, capture_output=True, check=True)
    svg = res.stdout.decode("utf-8", "replace")
    m = re.search(r'translate\(([-\d.]+),([-\d.]+)\)\s*scale\(([-\d.]+),([-\d.]+)\)', svg)
    tx, ty, sx, sy = (float(v) for v in m.groups()) if m else (0.0, float(h), 0.1, -0.1)
    rings = []
    for d in re.findall(r'<path[^>]*\sd="([^"]+)"', svg, flags=re.S):
        toks = _TOK.findall(d)
        i = 0
        cx = cy = 0.0
        sx0 = sy0 = 0.0
        cur = None
        op = None

        def P(X, Y):
            return (tx + sx * X + ox, ty + sy * Y + oy)

        while i < len(toks):
            t = toks[i]
            if t in "MmLlCcZz":
                op = t
                i += 1
                if op in "Zz":
                    if cur is not None:
                        rings.append(cur)
                    cur = None
                    cx, cy = sx0, sy0
                    continue
            if op is None:
                i += 1
                continue
            if op in "Mm":
                X, Y = float(toks[i]), float(toks[i + 1])
                i += 2
                if op == "m":  # relative to current point (start of last closed sub-path)
                    X, Y = cx + X, cy + Y
                if cur is not None:
                    rings.append(cur)
                cx, cy = X, Y
                sx0, sy0 = X, Y
                cur = {"start": P(cx, cy), "segs": []}
                op = "l" if op == "m" else "L"
            elif op in "Ll":
                X, Y = float(toks[i]), float(toks[i + 1])
                i += 2
                if op == "l":
                    X, Y = cx + X, cy + Y
                cx, cy = X, Y
                cur["segs"].append(("L", P(cx, cy)))
            elif op in "Cc":
                v = [float(x) for x in toks[i:i + 6]]
                i += 6
                if op == "c":
                    v = [cx + v[0], cy + v[1], cx + v[2], cy + v[3], cx + v[4], cy + v[5]]
                cur["segs"].append(("C", P(v[0], v[1]), P(v[2], v[3]), P(v[4], v[5])))
                cx, cy = v[4], v[5]
        if cur is not None:
            rings.append(cur)
    for r in rings:
        r["poly"] = ring_poly(r)
    return [r for r in rings if len(r["poly"]) >= 3]


def ring_poly(r, steps=6):
    pts = [r["start"]]
    p0 = r["start"]
    for s in r["segs"]:
        if s[0] == "L":
            pts.append(s[1])
            p0 = s[1]
        else:
            c1, c2, p3 = s[1], s[2], s[3]
            for k in range(1, steps + 1):
                t = k / steps
                u = 1 - t
                pts.append((u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p3[0],
                            u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p3[1]))
            p0 = p3
    return np.array(pts, np.float64)


def poly_area(p):
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def point_in_poly(pt, poly):
    x, y = pt
    xs, ys = poly[:, 0], poly[:, 1]
    xj, yj = np.roll(xs, 1), np.roll(ys, 1)
    cond = (ys > y) != (yj > y)
    with np.errstate(divide="ignore", invalid="ignore"):
        xint = xs + (xj - xs) * (y - ys) / (yj - ys)
    return bool(np.count_nonzero(cond & (x < xint)) % 2)


def group_rings(rings):
    """Nest rings: even depth = outer, odd = hole. Return [(outer, [holes])]."""
    n = len(rings)
    areas = [abs(poly_area(r["poly"])) for r in rings]
    parent = [-1] * n
    for i in range(n):
        p = rings[i]["poly"]
        probe = tuple(p[len(p) // 2])
        best, best_a = -1, float("inf")
        for j in range(n):
            if j == i or areas[j] <= areas[i]:
                continue
            if areas[j] < best_a and point_in_poly(probe, rings[j]["poly"]):
                best, best_a = j, areas[j]
        parent[i] = best
    depth = []
    for i in range(n):
        d, p = 0, parent[i]
        while p >= 0 and d <= n:
            d += 1
            p = parent[p]
        depth.append(d)
    groups = []
    for i in range(n):
        if depth[i] % 2 == 0:
            holes = [rings[j] for j in range(n) if parent[j] == i and depth[j] % 2 == 1]
            groups.append((rings[i], holes))
    return groups


def fnum(v):
    s = ("%.4f" % v).rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def ring_d(r, scale):
    def q(p):
        return fnum(p[0] * scale) + " " + fnum(p[1] * scale)
    out = ["M " + q(r["start"])]
    for s in r["segs"]:
        if s[0] == "L":
            out.append("L " + q(s[1]))
        else:
            out.append("C " + q(s[1]) + " " + q(s[2]) + " " + q(s[3]))
    out.append("Z")
    return " ".join(out)


# --------------------------------------------------------------- analysis ---
def disk(r):
    r = max(1, int(round(r)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def robust_width_px(comp, dt):
    """2 x p90 of the distance transform sampled on the skeleton."""
    vals = None
    if _sk_skeletonize is not None and comp.sum() >= 4:
        sk = _sk_skeletonize(comp)
        v = dt[sk]
        if len(v):
            vals = v
    if vals is None:
        vals = dt[comp]
    return 2.0 * float(np.percentile(vals, 90)), 2.0 * float(dt[comp].max())


def classify(width_mm, min_w):
    if width_mm < 1.2:
        # closed but narrow column: a narrow satin. kind "run" is reserved for the
        # open centreline paths (open: true)
        return "satin", ("narrow" if width_mm >= min_w else "below-min-width")
    if width_mm <= 7.0:
        return "satin", None
    if width_mm <= 10.0:
        return "satin", "split"
    return "fill", None


def detect_text(parts, warnings):
    """Very simple lettering detector: >=3 similar-height small parts of one
    colour sitting on a common baseline row."""
    flagged = set()
    by_layer = {}
    for p in parts:
        asp = p["hMm"] / max(0.1, p["wMm"])
        if 0.8 <= p["hMm"] <= 15 and p["areaMm2"] < 120 and 0.6 <= asp <= 6.5:
            by_layer.setdefault(p["layer"], []).append(p)
    groups = []
    for li, ps in by_layer.items():
        ps = sorted(ps, key=lambda q: q["cxMm"])
        used = set()
        for a in ps:
            if id(a) in used:
                continue
            g = [a]
            for b in ps:
                if b is a or id(b) in used:
                    continue
                hm = max(a["hMm"], b["hMm"])
                # letters share top line and baseline and have similar height
                if abs(b["y0Mm"] - a["y0Mm"]) < 0.2 * hm and \
                   abs((b["y0Mm"] + b["hMm"]) - (a["y0Mm"] + a["hMm"])) < 0.2 * hm and \
                   hm / max(0.1, min(a["hMm"], b["hMm"])) < 1.35:
                    g.append(b)
            if len(g) >= 3:
                xs = sorted(q["cxMm"] for q in g)
                gaps = np.diff(xs)
                med_h = float(np.median([q["hMm"] for q in g]))
                # contiguous run of letters: every neighbour gap < 1.6 x letter height
                if len(gaps) and gaps.max() < 1.6 * med_h:
                    for q in g:
                        used.add(id(q))
                    groups.append((li, g, med_h))
    for li, g, med_h in groups:
        for q in g:
            q["likelyText"] = True
            flagged.add(q["id"])
        x0 = min(q["x0Mm"] for q in g)
        y0 = min(q["y0Mm"] for q in g)
        x1 = max(q["x0Mm"] + q["wMm"] for q in g)
        y1 = max(q["y0Mm"] + q["hMm"] for q in g)
        cap_h = max(q["hMm"] for q in g)
        min_stroke = min(q["widthMm"] for q in g)
        w = {"type": "small-text" if cap_h < 5.0 else "text", "layer": li,
             "letterHeightMm": round(cap_h, 2), "minStrokeMm": round(min_stroke, 2),
             "parts": len(g), "bboxMm": [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)]}
        if cap_h < 5.0:
            w["message"] = ("Likely lettering %.1f mm tall (< 5 mm): too small for clean satin "
                            "letters; enlarge the design or simplify the text." % cap_h)
        else:
            w["message"] = "Likely lettering %.1f mm tall; digitize as satin lettering." % cap_h
        if min_stroke < 1.2:
            w["message"] += " Thinnest stroke %.2f mm (< 1.2 mm satin minimum)." % min_stroke
        if cap_h < 5.0 or min_stroke < 1.2:
            warnings.append(w)
        else:
            w["info"] = True
            warnings.append(w)
    return flagged


TEXT_MIN_HEIGHT_MM = 5.0
TEXT_MIN_STROKE_MM = 1.2


def _glyph_stroke_px(comp):
    """Stroke width of one glyph: 2 x distance transform sampled along the
    skeleton, median (minus 1 px for the pixel-centre bias)."""
    pad = np.pad(comp.astype(np.uint8), 2)
    dt = cv2.distanceTransform(pad, cv2.DIST_L2, 5)
    if _sk_skeletonize is not None and pad.sum() >= 4:
        sk = _sk_skeletonize(pad.astype(bool))
        v = dt[sk]
    else:
        v = dt[pad > 0]
    if not len(v):
        return 0.0
    return max(1.0, 2.0 * float(np.median(v)) - 1.0)


def detect_text_warnings(lab_map, order, label_rgb, ppm, width_in, min_h_mm=TEXT_MIN_HEIGHT_MM,
                         min_stroke_mm=TEXT_MIN_STROKE_MM, early_map=None):
    """Small-lettering / thin-stroke check on the final label map (closed shapes
    only; open centreline runs are not in lab_map, so they never count).
    Connected components of one colour are grouped into text lines (similar
    height, shared baseline, close neighbours, >= 3 in a row). Per line: glyph
    height = median component height, stroke = median of per-glyph skeleton
    stroke widths, both in mm at the output size."""
    out = _text_lines(lab_map, order, {l: i for i, l in enumerate(order)}, label_rgb, ppm, width_in,
                      min_h_mm, min_stroke_mm)
    if early_map is not None:
        # lettering the clean-up merged away (pieces < min-piece at small sizes) is
        # still the customer's text: look for it on the mode-filtered map too
        def ov(a, b):
            ix = min(a[2], b[2]) - max(a[0], b[0])
            iy = min(a[3], b[3]) - max(a[1], b[1])
            if ix <= 0 or iy <= 0:
                return 0.0
            return ix * iy / max(1e-9, min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])))
        labs = [l for l in np.unique(early_map).tolist() if l != 0 and l in label_rgb]
        labs.sort(key=lambda l: order.index(l) if l in order else len(order))
        idx = {l: (order.index(l) if l in order else None) for l in labs}
        primary = list(out)
        for w in _text_lines(early_map, labs, idx, label_rgb, ppm, width_in, min_h_mm, min_stroke_mm):
            if any(ov(w["bboxIn"], q["bboxIn"]) > 0.4 for q in primary):
                continue
            w["mostlyRemovedInPrep"] = True
            w["message"] += " (Most of this lettering was merged away by the clean-up at this size.)"
            out.append(w)
    min_rec = max([w["suggestWidthIn"] for w in out], default=None)
    return out, min_rec


def _text_lines(lab_map, labels, layer_idx, label_rgb, ppm, width_in, min_h_mm, min_stroke_mm):
    H, W = lab_map.shape
    out = []
    cc_cache = {}

    def comps_of(l):
        if l not in cc_cache:
            cc_cache[l] = cv2.connectedComponentsWithStats((lab_map == l).astype(np.uint8), connectivity=8)
        return cc_cache[l]

    for l in labels:
        li = layer_idx.get(l)
        if l == 0:
            continue
        n, cc, stats, _ = comps_of(l)
        cand = []
        for i in range(1, n):
            x, y, ww, hh, area = [int(v) for v in stats[i]]
            hmm, wmm, amm = hh / ppm, ww / ppm, area / (ppm * ppm)
            if not (0.8 <= hmm <= 30 and 0.25 <= wmm <= 30 and amm >= 0.25):
                continue
            asp = hh / float(max(1, ww))
            if not (0.35 <= asp <= 9.0):
                continue
            # counters (holes of a small enclosing glyph, e.g. the slot of a 0) are not letters
            x0, y0, x1, y1 = max(0, x - 2), max(0, y - 2), min(W, x + ww + 2), min(H, y + hh + 2)
            comp = cc[y0:y1, x0:x1] == i
            ring = cv2.dilate(comp.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~comp
            nbl = lab_map[y0:y1, x0:x1][ring]
            if len(nbl):
                cnt = np.bincount(nbl)
                nl = int(cnt.argmax())
                if nl not in (0, l) and cnt[nl] >= 0.9 * len(nbl):
                    n2, cc2, st2, _ = comps_of(nl)
                    ys, xs = np.nonzero(ring)
                    j = int(np.bincount(cc2[ys + y0, xs + x0]).argmax())
                    if j > 0 and st2[j][4] <= 15 * area:
                        continue
            cand.append({"i": i, "x0": x, "y0": y, "x1": x + ww, "y1": y + hh, "h": hh, "area": area,
                         "comp": comp, "ox": x0, "oy": y0})
        if len(cand) < 3:
            continue
        cand.sort(key=lambda c: c["x0"])
        par = list(range(len(cand)))

        def find(a):
            while par[a] != a:
                par[a] = par[par[a]]
                a = par[a]
            return a

        def similar(a, b, gap_k):
            hm, hn = max(a["h"], b["h"]), min(a["h"], b["h"])
            if hm / float(max(1, hn)) >= 1.35:
                return False
            if abs(a["y1"] - b["y1"]) > 0.2 * hm or abs(a["y0"] - b["y0"]) > 0.25 * hm:
                return False
            gap = b["x0"] - a["x1"] if b["x0"] >= a["x0"] else a["x0"] - b["x1"]
            return -0.15 * hm <= gap <= gap_k * hm

        for ai in range(len(cand)):
            for bi in range(ai + 1, len(cand)):
                if cand[bi]["x0"] - cand[ai]["x1"] > 1.2 * cand[ai]["h"] * 1.35:
                    break
                if similar(cand[ai], cand[bi], 1.2):
                    par[find(bi)] = find(ai)
        groups = {}
        for k in range(len(cand)):
            groups.setdefault(find(k), []).append(cand[k])
        lines = []
        for g in groups.values():
            if len(g) < 3:
                continue
            for c in g:
                if "stroke" not in c:
                    c["stroke"] = _glyph_stroke_px(c["comp"])
            # lettering has a consistent stroke: drop outliers, re-check count
            # outline rings / AA rims around big shapes are hairlines relative to
            # their height (stroke < 7% of height); real lettering is not
            g = [c for c in g if c["stroke"] >= 0.07 * c["h"] and c["stroke"] >= 0.25 * ppm]
            if len(g) < 3:
                continue
            ms = float(np.median([c["stroke"] for c in g]))
            g = [c for c in g if 0.5 * ms <= c["stroke"] <= 2.0 * ms]
            if len(g) < 3:
                continue
            g.sort(key=lambda c: c["x0"])
            lines.append(g)
        # one text line split by a small mark (period, hyphen) -> merge for reporting
        lines.sort(key=lambda g: g[0]["x0"])
        merged = []
        for g in lines:
            if merged:
                p = merged[-1]
                hp = float(np.median([c["h"] for c in p]))
                hg = float(np.median([c["h"] for c in g]))
                bp = float(np.median([c["y1"] for c in p]))
                bg = float(np.median([c["y1"] for c in g]))
                gap = g[0]["x0"] - max(c["x1"] for c in p)
                if max(hp, hg) / max(1.0, min(hp, hg)) < 1.35 and abs(bp - bg) < 0.2 * max(hp, hg) \
                        and -0.15 * hp <= gap <= 2.5 * max(hp, hg):
                    merged[-1] = p + g
                    continue
            merged.append(g)
        hexv = to_hex(label_rgb[l])
        for g in merged:
            h_mm = float(np.median([c["h"] for c in g])) / ppm
            s_mm = float(np.median([c["stroke"] for c in g])) / ppm
            bx0 = min(c["x0"] for c in g) / ppm / 25.4
            by0 = min(c["y0"] for c in g) / ppm / 25.4
            bx1 = max(c["x1"] for c in g) / ppm / 25.4
            by1 = max(c["y1"] for c in g) / ppm / 25.4
            f = max(min_h_mm / max(h_mm, 1e-6), min_stroke_mm / max(s_mm, 1e-6))
            sug = math.ceil(width_in * f / 0.25 - 1e-9) * 0.25
            base = {"layer": li, "hex": hexv, "glyphs": len(g),
                    "bboxIn": [round(bx0, 3), round(by0, 3), round(bx1, 3), round(by1, 3)],
                    "heightMm": round(h_mm, 2), "strokeMm": round(s_mm, 2),
                    "minHeightMm": min_h_mm, "minStrokeMm": min_stroke_mm,
                    "suggestWidthIn": round(sug, 2)}
            if h_mm < min_h_mm:
                w = dict(base, type="small_text")
                w["message"] = ("Lettering %.1f mm tall (< %.0f mm) will not sew legibly at %.2f in; "
                                "use at least %.2f in wide." % (h_mm, min_h_mm, width_in, sug))
                out.append(w)
            if s_mm < min_stroke_mm:
                w = dict(base, type="thin_stroke")
                w["message"] = ("Lettering strokes %.2f mm (< %.1f mm satin minimum) at %.2f in; "
                                "use at least %.2f in wide." % (s_mm, min_stroke_mm, width_in, sug))
                out.append(w)
    return out


# ------------------------------------------------------------------- main ---
def prep(img_path, width_in, max_colors=None, fabric="tee", source_mode="clean", source_max_side=512,
         interior_bg="stitch", debug_dir=None, alphamax=1.0, opttol=0.2, log=None, underlap_mm=None,
         runs_mode="inline", min_piece_mm2=None, min_late_mm=15.0, late_colors="all", fold_mode="knockout"):
    def say(*a):
        if log:
            print(*a, file=log)

    fab_cfg = FABRICS.get(fabric, FABRICS["tee"])
    min_w = fab_cfg["minWidthMm"]
    underlap_mm = fab_cfg["underlapMm"] if underlap_mm is None else float(underlap_mm)
    min_area = 1.0

    rgba = load_rgba(img_path)
    src_h, src_w = rgba.shape[:2]
    rgb, alpha, ppm, ppm_src, scale = working_raster(rgba, width_in)
    H, W = alpha.shape
    height_in = width_in * src_h / float(src_w)
    max_dim_in = max(width_in, height_in)
    auto_mc = auto_max_colors(max_dim_in)
    if max_colors is None:
        max_colors = auto_mc
    auto_mp, thin_piece_mm = auto_min_piece(max_dim_in, min_w)
    if min_piece_mm2 is None:
        min_piece_mm2 = auto_mp
    else:
        min_piece_mm2 = float(min_piece_mm2)
        thin_piece_mm = 1.5 if min_piece_mm2 > 1.0 else min_w
    lab = rgb_to_lab(rgb)
    say("source %dx%d  %.2f px/mm -> working %dx%d (x%.2f) %.2f px/mm" % (src_w, src_h, ppm_src, W, H, scale, ppm))

    # 1a. fabric
    fab_seed, bg_lab, fab_info = detect_fabric(lab, alpha, ppm)
    design0 = ~fab_seed
    # 1b. palette
    pal = quantize_palette(lab[design0], max_colors, bg_lab=bg_lab)
    K = len(pal)
    centers = pal if bg_lab is None else np.vstack([pal, bg_lab[None].astype(np.float32)])
    raw = nearest_label(lab, centers) + 1          # 1..K palette, K+1 = bg colour
    raw[fab_seed] = 0
    if bg_lab is not None:
        bgc = (raw == K + 1) | (raw == 0)
        outside = border_connected_guarded(bgc, ppm) | fab_seed
        raw[outside] = 0
        if interior_bg == "fabric":
            raw[raw == K + 1] = 0
    n_labels = K + 2
    raw_quant = raw.copy()

    # 1c. clean
    k_mode = max(3, int(round(0.35 * ppm)) | 1)
    lab_map = mode_filter(raw, n_labels, k_mode)
    early_map = lab_map.copy()      # for the lettering check (before small pieces are merged away)
    label_lab = {l: pal[l - 1].astype(np.float64) for l in range(1, K + 1)}
    label_lab[K + 1] = None if bg_lab is None else bg_lab.astype(np.float64)
    label_lab[0] = label_lab[K + 1]
    ctx = MergeCtx(ppm, label_lab)
    ctx.lab_img = lab
    ctx.src_ppm = ppm_src
    ctx.src_de_lab = rgb_to_lab(np.ascontiguousarray(rgba[:, :, :3]))
    ctx.src_scale = scale
    # thin separate regions -> runs (captured before smoothing can erase them)
    lab_map, n_merged = merge_small_regions(lab_map, n_labels, ppm, min_w, min_area, ctx)
    # thin branches of big regions (whisker roots, fine lines on a blob) -> runs
    lab_map, n_branch = extract_thin_branches(lab_map, n_labels, ppm, min_w, ctx)
    lab_map = smooth_labels(lab_map, n_labels, 0.15 * ppm)
    lab_map, n_merged2 = merge_small_regions(lab_map, n_labels, ppm, min_w, min_area, ctx)
    say("palette %d (+bg=%s), mode k=%d, merged %d+%d regions, %d thin branches, %d run pieces, %d counters kept"
        % (K, bg_lab is not None, k_mode, n_merged, n_merged2, n_branch, len(ctx.runs), ctx.counters))

    # colours of labels
    label_rgb = {}
    for l in range(1, K + 1):
        label_rgb[l] = lab_to_rgb(pal[l - 1][None])[0]
    if bg_lab is not None:
        label_rgb[K + 1] = lab_to_rgb(bg_lab[None].astype(np.float32))[0]
    # use the median source colour of the final region (truer than the k-means mean)
    for l in list(label_rgb):
        m = lab_map == l
        if m.sum() > 50:
            label_rgb[l] = np.median(rgb[m], axis=0).astype(np.uint8)

    # final colours closer than dE 10 (e.g. black + dark AA-rim grey) -> one thread
    while True:
        pres = [l for l in label_rgb if (lab_map == l).any()]
        labs = {l: rgb_to_lab(np.array([label_rgb[l]], np.uint8))[0] for l in pres}
        best = None
        for ai, a in enumerate(pres):
            for b in pres[ai + 1:]:
                d = float(np.linalg.norm(labs[a] - labs[b]))
                if d < 10.0 and (best is None or d < best[0]):
                    best = (d, a, b)
        if best is None:
            break
        _, a, b = best
        na, nb = int((lab_map == a).sum()), int((lab_map == b).sum())
        keep, drop = (a, b) if na >= nb else (b, a)
        lab_map[lab_map == drop] = keep
        raw_quant[raw_quant == drop] = keep
        early_map[early_map == drop] = keep
        for rpc in ctx.runs:
            if rpc["label"] == drop:
                rpc["label"] = keep
        say("merged near-duplicate colour %s into %s" % (to_hex(label_rgb[drop]), to_hex(label_rgb[keep])))
        del label_rgb[drop]
    lab_map, n_merged3 = merge_small_regions(lab_map, n_labels, ppm, min_w, min_area, ctx)
    n_merged2 += n_merged3
    # size-scaled piece clean-up (a 4 in design cannot hold 2 mm^2 islands)
    fill_labels = [l for l in label_rgb if l > 0]
    pieces_before = count_pieces(lab_map, fill_labels)
    n_pieces = 0
    # a thread that covers < 0.5% of the design (and < 25 mm^2 x size factor) is
    # not worth a colour change: merge it into its neighbours (its runs, if any,
    # are re-assigned to the nearest surviving thread)
    design_px = int((lab_map > 0).sum())
    tiny = set()
    for l in fill_labels:
        a_l = int((lab_map == l).sum())
        if 0 < a_l < 0.005 * design_px:
            tiny.add(l)
            say("thread %s covers only %.1f mm^2: merged into neighbours" % (to_hex(label_rgb[l]), a_l / (ppm * ppm)))
    if min_piece_mm2 > min_area or thin_piece_mm > min_w or tiny:
        lab_map, n_pieces = merge_pieces(lab_map, ppm, min_piece_mm2, thin_piece_mm, ctx, force_labels=tiny,
                                         dot_min_w=min_w)
    tiny_colours_merged = len(tiny)
    lab_map, fringe_slivers = drop_edge_fringe_slivers(lab_map, label_rgb, lab, ppm, src_ppm=ppm_src)
    if fringe_slivers:
        say("edge-fringe slivers dropped: %d" % len(fringe_slivers))
    pieces_after = count_pieces(lab_map, fill_labels)
    say("max dim %.2f in: maxColors %d (auto %d), minPiece %.1f mm^2, thin fragment < %.1f mm, %d pieces merged"
        % (max_dim_in, max_colors, auto_mc, min_piece_mm2, thin_piece_mm, n_pieces))

    # stacking order: largest first (background-most), details later
    # run-stitch polylines (thin detail sewn as running stitch, not dropped)
    run_items = collect_runs(lab, lab_map, label_rgb, label_lab, ctx, ppm, min_w, raw_quant > 0)
    for it in run_items:
        if it["label"] not in label_rgb:
            label_rgb[it["label"]] = lab_to_rgb(label_lab[it["label"]][None].astype(np.float32))[0]
    present = [l for l in range(1, n_labels) if (lab_map == l).any()]
    areas = {l: int((lab_map == l).sum()) for l in present}
    order = sorted(present, key=lambda l: -areas[l])
    order += sorted({it["label"] for it in run_items} - set(order))   # run-only colours last
    for l in order:
        areas.setdefault(l, 0)
    run_plan, run_stats = plan_runs(run_items, lab_map, order, label_rgb, ppm, min_late_mm=min_late_mm,
                                    late_colors=late_colors, fold_mode=fold_mode, lab_img=lab, src_ppm=ppm_src)
    # knockout corridors: later layers leave a gap where a folded run lies
    knock_maps = None
    kos = [r for r in run_plan if r.get("knockout")]
    if kos:
        knock_maps = []
        acc = np.zeros((H, W), np.uint8)
        idx_o = {lab_: i_ for i_, lab_ in enumerate(order)}
        by_idx = {}
        for r in kos:
            by_idx.setdefault(idx_o[r["label"]], []).append(r)
        for li_ in range(len(order)):
            knock_maps.append(acc.astype(bool))        # corridors of runs sewn in earlier layers
            for r in by_idx.get(li_, []):
                th = max(2, int(round(max(r["widthMm"], 0.45) * ppm)))
                cv2.polylines(acc, [np.round(r["poly"]).astype(np.int32).reshape(-1, 1, 2)], False, 1, th)
        run_stats["knockoutAreaMm2"] = round(float(acc.sum()) / (ppm * ppm), 1)
    say("runs: %(runsIn)d in, %(runsJoined)d joins, %(runsDroppedShort)d dropped < 3 mm, "
        "%(runsEndClipped)d end-clipped, %(runsLate)d late in %(lateVisitColours)d colour(s), "
        "%(runsMovedToSameColourLayer)d moved to a same-colour layer, %(runsLateFolded)d folded back -> %(runsOut)d"
        % run_stats)

    # 2-4. per colour, per part
    r_under = underlap_mm * ppm
    turd = max(1, int(round(0.3 * ppm * ppm * 0.9)))   # potrace turdsize: keep counters >= 0.3 mm^2
    inch_per_px = 1.0 / (ppm * 25.4)
    layers, parts_meta, warnings = [], [], []
    later_union = np.zeros((H, W), bool)
    later_masks = {}
    for idx in range(len(order) - 1, -1, -1):
        later_masks[order[idx]] = later_union.copy()
        later_union |= lab_map == order[idx]
    pad = int(math.ceil(r_under)) + 3
    part_id = 0
    ctr_cache = {}
    # underlap depth budget: 0.7 mm under big shapes (fills), proportionally less
    # under narrow satins (15% of their local width, >= 0.25 mm) so narrow columns
    # are never fully double-stitched and busy art keeps its overlap bands thin.
    depth_ok = np.zeros((H, W), bool)
    if r_under >= 0.5:
        for l in order:
            m = lab_map == l
            if not m.any():
                continue
            dtl = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 5)
            loc = cv2.dilate(dtl, disk(max(2, int(round(1.5 * r_under)))))
            budget = np.clip(UNDERLAP_WIDTH_FRAC * 2.0 * loc, UNDERLAP_MIN_MM * ppm, r_under)
            depth_ok |= m & (dtl <= budget)
    for li, l in enumerate(order):
        m = (lab_map == l).astype(np.uint8)
        later = later_masks[l]
        dt = cv2.distanceTransform(m, cv2.DIST_L2, 5)
        n, cc, stats, cents = cv2.connectedComponentsWithStats(m, connectivity=8)
        hexv = to_hex(label_rgb[l])
        layer = {"hex": hexv, "nameGuess": name_guess(label_rgb[l]), "paths": []}
        if bg_lab is not None and l == K + 1:
            layer["fromBackgroundColour"] = True
        kinds = {"run": 0, "satin": 0, "fill": 0}
        for i in range(1, n):
            x, y, ww, hh, area = stats[i]
            x0, y0 = max(0, x - pad), max(0, y - pad)
            x1, y1 = min(W, x + ww + pad), min(H, y + hh + pad)
            comp = cc[y0:y1, x0:x1] == i
            wpx, maxw_px = robust_width_px(comp, dt[y0:y1, x0:x1])
            width_mm = wpx / ppm
            maxw_mm = maxw_px / ppm
            area_mm2 = area / (ppm * ppm)
            kind, note = classify(width_mm, min_w)
            # counter (hole of another shape showing this colour): negative space,
            # not a stitch column -> never tagged as a closed "run"
            is_ctr = False
            if area_mm2 < 40:
                ringc = cv2.dilate(comp.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~comp
                nbl = lab_map[y0:y1, x0:x1][ringc]
                if len(nbl):
                    cntl = np.bincount(nbl)
                    nl = int(cntl.argmax())
                    sl, sarea = surround_label(lab_map, nl, comp, x0, y0, ctr_cache, with_area=True) \
                        if (nl not in (0, l) and cntl[nl] >= 0.9 * len(nbl)) else (-1, 0)
                    # a counter sits in a small enclosing glyph/shape (the 0 around its
                    # slot); a letter inside a big badge is not a counter of the badge
                    if sl == l and sarea <= 15 * area:
                        is_ctr = True
                        if note in ("narrow", "below-min-width"):
                            note = "counter"
            ext = comp.copy()
            if r_under >= 0.5:
                grow = cv2.dilate(comp.astype(np.uint8), disk(r_under)).astype(bool)
                allow = later[y0:y1, x0:x1].copy()
                # never underlap into this shape's own counters (holes showing the
                # colour around the shape, or fabric)
                filled = ndi.binary_fill_holes(comp)
                holes_m = filled & ~comp
                if holes_m.any():
                    labc = lab_map[y0:y1, x0:x1]
                    rim = cv2.dilate(filled.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~filled
                    outer_l = int(np.bincount(labc[rim]).argmax()) if rim.any() else -1
                    allow &= ~(holes_m & ((labc == 0) | (labc == outer_l)))
                ext |= grow & allow & depth_ok[y0:y1, x0:x1]
            if knock_maps is not None:
                ext &= ~knock_maps[li][y0:y1, x0:x1]
                if not ext.any():
                    continue
            rings = potrace_rings(ext, x0, y0, turd, alphamax, opttol)
            groups = group_rings(rings)
            if not groups:
                continue
            part_id += 1
            for gi, (outer, holes) in enumerate(groups):
                ga = abs(poly_area(outer["poly"])) - sum(abs(poly_area(hh_["poly"])) for hh_ in holes)
                if gi > 0 and ga / (ppm * ppm) < 0.05:
                    continue  # tracing crumb from underlap
                d = " ".join([ring_d(outer, inch_per_px)] + [ring_d(hr, inch_per_px) for hr in holes])
                p = {"d": d, "hole": False, "kind": kind, "widthMm": round(width_mm, 2),
                     "maxWidthMm": round(maxw_mm, 2), "areaMm2": round(area_mm2, 2),
                     "holes": len(holes), "part": part_id}
                if note == "split":
                    p["note"] = "split"
                    p["splitSuggested"] = True
                elif note:
                    p["note"] = note
                if gi > 0:
                    p["underlapFragment"] = True
                if is_ctr:
                    p["counter"] = True
                layer["paths"].append(p)
            kinds[kind] += 1
            meta = {"id": part_id, "layer": li, "hex": hexv, "kind": kind, "widthMm": width_mm,
                    "maxWidthMm": maxw_mm, "areaMm2": area_mm2, "x0Mm": x / ppm, "y0Mm": y / ppm,
                    "wMm": ww / ppm, "hMm": hh / ppm, "cxMm": (x + ww / 2) / ppm, "cyMm": (y + hh / 2) / ppm}
            parts_meta.append(meta)
            # HZ stitch/objects.js (buildObjects, the `hexLum(hex) > 90 && hint.outlineLike &&
            # bboxFrac0 > 0.25 && fillFrac < 0.25` paper-halo guard) silently drops big light rings.
            rr, gg, bb = [int(v) for v in label_rgb[l]]
            lum = 0.2126 * rr + 0.7152 * gg + 0.0722 * bb
            fill_frac = area / float(ww * hh + 1)
            bbox_frac = (ww * hh) / float(W * H)
            if lum > 90 and fill_frac < 0.25 and bbox_frac > 0.25 and maxw_mm <= 4.2:
                warnings.append({"type": "hz-light-ring-dropped", "layer": li, "part": part_id, "hex": hexv,
                                 "bboxFrac": round(bbox_frac, 3), "fillFrac": round(fill_frac, 3),
                                 "message": "Light %s ring/outline spans %.0f%% of the hoop: digitize.js "
                                            "(stitch/objects.js paper-halo guard) drops it as background, so it "
                                            "will not be stitched unless HZ exempts real art." %
                                            (name_guess(label_rgb[l]), 100 * bbox_frac)})
            if note in ("narrow", "below-min-width"):
                warnings.append({"type": "thin-column", "layer": li, "part": part_id, "hex": hexv,
                                 "widthMm": round(width_mm, 2),
                                 "bboxMm": [round(x / ppm, 1), round(y / ppm, 1), round((x + ww) / ppm, 1), round((y + hh) / ppm, 1)],
                                 "message": "Column %.2f mm wide (< 1.2 mm): narrow satin; may sew better as a bean run or thickened." % width_mm})
            elif note == "split":
                warnings.append({"type": "wide-satin", "layer": li, "part": part_id, "hex": hexv,
                                 "widthMm": round(width_mm, 2), "info": True,
                                 "message": "Satin %.1f mm wide (7-10 mm): split satin or switch to fill." % width_mm})
        # open running-stitch centrelines for this colour, after its fills/satins
        n_runs = 0
        for rr in run_plan:
            if rr["host"] != l:
                continue
            part_id += 1
            for pl in [rr["poly"]]:
                pts = pl * inch_per_px
                d = "M " + fnum(pts[0, 0]) + " " + fnum(pts[0, 1]) + "".join(
                    " L " + fnum(x) + " " + fnum(y) for x, y in pts[1:])
                layer["paths"].append({"d": d, "hole": False, "open": True, "kind": "run",
                                       "widthMm": round(rr["widthMm"], 2), "bean": bool(rr["widthMm"] >= 0.6),
                                       "lengthMm": round(poly_len(pl) / ppm, 2), "part": part_id,
                                       "sewAfterLayer": int(rr["sewAfter"])})
                n_runs += 1
        layer["kinds"] = kinds
        layer["openRuns"] = n_runs
        layer["areaMm2"] = round(areas[l] / (ppm * ppm), 1)
        layers.append(layer)
    detect_text(parts_meta, warnings)
    text_warnings, min_rec_w = detect_text_warnings(lab_map, order, label_rgb, ppm, width_in,
                                                    early_map=early_map)
    # detail removed by the min-width rule (whiskers, thin counters/gaps): only
    # regions >= 2 mm^2 whose colour survived as a thread (skip AA blend rims)
    by_lab = {}
    for e in ctx.lost:
        if e["label"] in label_rgb and (lab_map == e["label"]).any():
            by_lab.setdefault(e["label"], []).append(e)
    for l, es in by_lab.items():
        es.sort(key=lambda e: -e["areaMm2"])
        warnings.append({"type": "detail-removed", "hex": to_hex(label_rgb[l]), "regions": len(es),
                         "totalAreaMm2": round(sum(e["areaMm2"] for e in es), 1),
                         "largestBboxesMm": [[round(v, 1) for v in e["bboxMm"]] for e in es[:5]],
                         "message": "%d thin %s region(s) (< %.1f mm wide, %.0f mm^2 total) were merged into neighbours "
                                    "without a run stitch (too short for a run). Enlarge the design or thicken them "
                                    "if they matter." % (len(es), name_guess(label_rgb[l]), min_w,
                                                         sum(e["areaMm2"] for e in es))})

    # 5. source raster
    # overlapApplied: lower layers already extend under later ones (underlap), so
    # the stitch engine must not add its own
    out = {"widthIn": round(width_in, 4), "heightIn": round(height_in, 4), "overlapApplied": True,
           "layers": layers}
    n_open_all = sum(L.get("openRuns", 0) for L in layers)
    n_bean_all = sum(1 for L in layers for p in L["paths"] if p.get("open") and p.get("bean"))
    if runs_mode != "inline":
        # current geom.js rasterizeLayer() closes and fills open paths, so offer a
        # layout that keeps centreline runs out of layers[].paths
        sep = []
        for li, L in enumerate(layers):
            rp = [p for p in L["paths"] if p.get("open")]
            L["paths"] = [p for p in L["paths"] if not p.get("open")]
            if rp and runs_mode == "separate":
                sep.append({"layerIndex": li, "hex": L["hex"], "nameGuess": L["nameGuess"], "paths": rp})
        layers[:] = [L for L in layers if L["paths"]] if runs_mode == "none" else layers
        if runs_mode == "separate":
            out["runs"] = sep
    if source_mode != "none":
        s = min(1.0, source_max_side / float(max(src_w, src_h)))
        sw, sh = max(4, int(round(src_w * s))), max(4, int(round(src_h * s)))
        if source_mode == "raw":
            srgba = cv2.resize(rgba, (sw, sh), interpolation=cv2.INTER_AREA)
        else:  # clean: the final label map rendered in layer colours, fabric transparent
            lut = np.zeros((n_labels, 4), np.uint8)
            for l in present:
                lut[l, :3] = label_rgb[l]
                lut[l, 3] = 255
            small = cv2.resize(lab_map.astype(np.uint8), (sw, sh), interpolation=cv2.INTER_NEAREST)
            srgba = lut[small]
        out["sourceRgba"] = srgba.reshape(-1).astype(int).tolist()
        out["sourceW"] = int(sw)
        out["sourceH"] = int(sh)
        out["sourceMode"] = source_mode
    out["fabric"] = fab_cfg["hz"]
    out["fabricInput"] = fabric
    out["warnings"] = warnings
    out["textWarnings"] = text_warnings
    out["minRecommendedWidthIn"] = min_rec_w
    allk = {"run": 0, "satin": 0, "fill": 0}
    for L in layers:
        for k, v in L["kinds"].items():
            allk[k] += v
    out["stats"] = {
        "generator": VERSION,
        "sourcePx": [src_w, src_h], "workPx": [W, H], "pxPerMmSource": round(ppm_src, 3),
        "pxPerMmWork": round(ppm, 3), "background": fab_info, "colours": len(layers),
        "parts": len(parts_meta), "paths": sum(len(L["paths"]) for L in layers), "kinds": allk,
        "minWidthMm": min_w, "underlapMm": underlap_mm, "stackOrder": [L["hex"] for L in layers],
        "regionsMerged": n_merged + n_merged2,
        "openRuns": n_open_all if runs_mode != "none" else 0,
        "openRunsDropped": n_open_all if runs_mode == "none" else 0,
        "beanRuns": n_bean_all if runs_mode != "none" else 0, "runsMode": runs_mode,
        "autoMaxColors": auto_mc, "maxColors": max_colors, "maxDimIn": round(max_dim_in, 3),
        "minPieceMm2": min_piece_mm2, "thinFragmentMm": thin_piece_mm, "piecesMerged": n_pieces,
        "tinyColoursMerged": tiny_colours_merged, "dotsKept": ctx.dots_kept,
        "piecesPerColour": {to_hex(label_rgb[l]): [pieces_before[l], pieces_after[l]]
                            for l in fill_labels if l in label_rgb and (pieces_before[l] or pieces_after[l])},
        "runPlan": run_stats,
        "edgeFringeDropped": len(fringe_slivers) + run_stats.get("edgeFringeDropped", 0),
        "edgeFringe": {"slivers": fringe_slivers, "runs": run_stats.pop("edgeFringeRuns", [])},
        "blendRimsKeptByGuard": ctx.rims_kept_by_guard,
        "countersKept": ctx.counters, "thinBranchesToRuns": n_branch, "aaRimsSplit": ctx.rims_split,
    }
    if debug_dir:
        os.makedirs(debug_dir, exist_ok=True)
        # source quantized straight to the final thread palette (no cleaning)
        fin = np.array([rgb_to_lab(np.array([label_rgb[l]], np.uint8))[0] for l in present], np.float32)
        quant = np.zeros((H, W), np.uint8)
        dz = raw_quant > 0
        quant[dz] = np.array(present, np.uint8)[nearest_label(lab[dz][:, None, :], fin)[:, 0]]
        np.savez_compressed(os.path.join(debug_dir, "labels.npz"), raw=raw_quant.astype(np.uint8),
                            quant=quant,
                            clean=lab_map.astype(np.uint8), fabric=fab_seed, ppm=ppm,
                            order=np.array(order), work_rgb=rgb,
                            lut=np.array([label_rgb.get(i, (0, 0, 0)) for i in range(n_labels)], np.uint8))
    return out


def preview_svg(vec, px_per_in=300, fabric_hex=None, outline=False):
    w, h = vec["widthIn"], vec["heightIn"]
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %s %s">'
             % (round(w * px_per_in), round(h * px_per_in), fnum(w), fnum(h))]
    if fabric_hex:
        parts.append('<rect width="100%%" height="100%%" fill="%s"/>' % fabric_hex)
    for L in vec["layers"]:
        parts.append('<g fill="%s" fill-rule="evenodd" data-name="%s">' % (L["hex"], L.get("nameGuess", "")))
        for p in L["paths"]:
            if p.get("open"):
                continue
            st = ' stroke="#ff00ff" stroke-width="0.004"' if outline else ""
            parts.append('<path d="%s" data-kind="%s" data-width-mm="%s"%s/>' % (p["d"], p.get("kind", ""), p.get("widthMm", ""), st))
        parts.append("</g>")
    # running stitches drawn on top (they are sewn after the fills they sit on)
    for L in vec["layers"]:
        runs = [p for p in L["paths"] if p.get("open")]
        if not runs:
            continue
        parts.append('<g fill="none" stroke="%s" stroke-linecap="round" stroke-linejoin="round" data-name="%s runs">'
                     % (L["hex"], L.get("nameGuess", "")))
        for p in runs:
            sw = max(float(p.get("widthMm") or 0), 0.35) / 25.4
            parts.append('<path d="%s" stroke-width="%s" data-kind="run" data-bean="%s"/>'
                         % (p["d"], fnum(sw), "1" if p.get("bean") else "0"))
        parts.append("</g>")
    parts.append("</svg>")
    return "\n".join(parts)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Raster -> embroidery-ready vector layers for lib/digitize.js")
    ap.add_argument("-i", "--input", required=True)
    ap.add_argument("--width-in", type=float, required=True, help="finished design width in inches")
    ap.add_argument("--max-colors", type=int, default=None,
                    help="thread cap (default auto from larger dimension: <=4 in 6, <=8 in 8, else 10)")
    ap.add_argument("--min-piece-mm2", type=float, default=None,
                    help="merge isolated fill pieces smaller than this (default auto: 4 at <=4 in, else 1)")
    ap.add_argument("--fabric", choices=sorted(FABRICS), default="tee")
    ap.add_argument("-o", "--output", required=True, help="output JSON")
    ap.add_argument("--svg", help="optional SVG preview path")
    ap.add_argument("--source", choices=["clean", "raw", "none"], default="clean",
                    help="sourceRgba payload: clean label render (default), raw image, or none")
    ap.add_argument("--source-max-side", type=int, default=512)
    ap.add_argument("--interior-bg", choices=["stitch", "fabric"], default="stitch",
                    help="enclosed regions of the background colour: stitch them (default) or leave as fabric")
    ap.add_argument("--runs", choices=["inline", "separate", "none"], default="inline",
                    help="centreline runs: inside layers[].paths with open:true (default), in a top-level "
                         "runs[] array (safe for engines that fill every path), or omitted")
    ap.add_argument("--underlap-mm", type=float, default=None,
                    help="max underlap under later colours (default from --fabric, tee=0.7)")
    ap.add_argument("--min-late-mm", type=float, default=15.0,
                    help="a colour gets a late run visit (extra colour stop) only if its late runs total >= this")
    ap.add_argument("--late-colors", choices=["light", "all", "none"], default="all",
                    help="which run colours may get a late visit (sewn after later layers, one extra colour stop "
                         "per colour): light = only light detail over darker fill, e.g. whiskers; "
                         "all = every colour that needs it (default: details sewn on top, last); none = never. Folded runs are sewn in their own "
                         "layer and kept visible per --fold-mode.")
    ap.add_argument("--fold-mode", choices=["knockout", "clip"], default="knockout",
                    help="how a folded (no late visit) run stays visible: knockout = later fills leave a corridor "
                         "for it (default); clip = cut the run where later layers cover it (pieces < 3 mm dropped)")
    ap.add_argument("--debug-dir", help="dump label maps (npz) for evaluation")
    ap.add_argument("-q", "--quiet", action="store_true")
    a = ap.parse_args(argv)
    if shutil.which("potrace") is None:
        sys.exit("potrace CLI not found (apt install potrace)")
    try:
        subprocess.run(["potrace", "--version"], capture_output=True, check=True)
    except Exception as e:
        sys.exit("potrace CLI not runnable: %s" % e)
    log = None if a.quiet else sys.stderr
    vec = prep(a.input, a.width_in, max_colors=a.max_colors, fabric=a.fabric, source_mode=a.source,
               source_max_side=a.source_max_side, interior_bg=a.interior_bg, debug_dir=a.debug_dir, log=log,
               underlap_mm=a.underlap_mm, runs_mode=a.runs,
               min_piece_mm2=a.min_piece_mm2, min_late_mm=a.min_late_mm, late_colors=a.late_colors,
               fold_mode=a.fold_mode)
    os.makedirs(os.path.dirname(os.path.abspath(a.output)) or ".", exist_ok=True)
    with open(a.output, "w") as f:
        json.dump(vec, f, separators=(",", ":"))
    if a.svg:
        with open(a.svg, "w") as f:
            f.write(preview_svg(vec))
    if log:
        s = vec["stats"]
        print("wrote %s: %d colours, %d parts, kinds %s, %d warnings" %
              (a.output, s["colours"], s["parts"], s["kinds"], len(vec["warnings"])), file=log)
        for L in vec["layers"]:
            print("  %s %-12s paths=%d kinds=%s openRuns=%d area=%.0fmm2" % (L["hex"], L["nameGuess"], len(L["paths"]), L["kinds"], L.get("openRuns", 0), L["areaMm2"]), file=log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
