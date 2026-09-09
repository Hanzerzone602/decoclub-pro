#!/usr/bin/env python3
"""
DecoClub Pro local image→vector engine.

Hierarchical Lab clustering, edge-aware assignment, AA-fringe suppression,
speck removal, stacked cubic Bézier SVG. General — no artwork-specific paste.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from collections import defaultdict

import cv2
import numpy as np
from PIL import Image

from geom import (
    fmt,
    path_from_ring,
    prepare_contour,
    ring_area,
    ring_bbox,
)

# OpenCV Lab: L in [0,255], a/b in [0,255] (128-centered)


def to_hex(rgb) -> str:
    r, g, b = [max(0, min(255, int(round(x)))) for x in rgb]
    return f"#{r:02x}{g:02x}{b:02x}"


def lum(rgb) -> float:
    return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]


def rgb_to_cmyk(rgb):
    r, g, b = [x / 255.0 for x in rgb]
    k = 1.0 - max(r, g, b)
    if k >= 0.999:
        return 0, 0, 0, 100
    c = (1 - r - k) / (1 - k)
    m = (1 - g - k) / (1 - k)
    y = (1 - b - k) / (1 - k)
    return int(round(c * 100)), int(round(m * 100)), int(round(y * 100)), int(round(k * 100))


def layer_name(rgb) -> str:
    r, g, b = [int(round(x)) for x in rgb]
    c, m, y, k = rgb_to_cmyk(rgb)
    return f"R{r} G{g} B{b} · C{c} M{m} Y{y} K{k}"


def load_rgba(path: str):
    im = Image.open(path)
    im = im.convert("RGBA")
    arr = np.array(im)
    rgb = arr[:, :, :3].copy()
    alpha = arr[:, :, 3].copy()
    return rgb, alpha


def gradient_mag(rgb: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.magnitude(gx, gy)


def to_lab(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)


def lab_of_rgb(rgb_list) -> np.ndarray:
    a = np.array(rgb_list, dtype=np.uint8).reshape(-1, 1, 3)
    return cv2.cvtColor(a, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)


def chroma_of_lab(lab) -> float:
    a = float(lab[1]) - 128.0
    b = float(lab[2]) - 128.0
    return math.hypot(a, b)


def hue_of_lab(lab) -> float:
    return math.atan2(float(lab[2]) - 128.0, float(lab[1]) - 128.0)


def can_merge_labs(la, lb, dist, thresh) -> bool:
    """Hue/chroma-aware merge: never fold white into pastels or yellow into black."""
    ca, cb = chroma_of_lab(la), chroma_of_lab(lb)
    # Multiple near-black inks are one outline color
    if ca < 16 and cb < 16 and float(la[0]) < 85 and float(lb[0]) < 85:
        return dist < max(thresh, 42.0)
    if dist > thresh:
        return False
    # Neutral (paper-white / gray / black) vs saturated color
    if (ca < 10 and cb > 22) or (cb < 10 and ca > 22):
        return False
    # Two chromatic colors: keep distinct hues (yellow vs blue, etc.)
    if ca > 16 and cb > 16:
        dh = abs(hue_of_lab(la) - hue_of_lab(lb))
        dh = min(dh, 2 * math.pi - dh)
        if dh > 0.55:  # ~31 degrees
            return False
    # Light vs dark of similar hue still merge only if very close
    if abs(float(la[0]) - float(lb[0])) > 70 and dist > thresh * 0.45:
        return False
    return True


def detect_paper(rgb: np.ndarray, alpha: np.ndarray):
    """Flood from the border through near-uniform bright (or dominant) paper."""
    h, w = rgb.shape[:2]
    lab = to_lab(rgb)
    border = np.concatenate(
        [rgb[0, :, :], rgb[-1, :, :], rgb[:, 0, :], rgb[:, -1, :]], axis=0
    )
    # Mode of quantized border
    q = (border // 8).astype(np.int32)
    keys, counts = np.unique(q, axis=0, return_counts=True)
    mode = keys[int(np.argmax(counts))] * 8 + 4
    paper_rgb = np.clip(mode, 0, 255).astype(np.float32)
    paper_lab = lab_of_rgb([paper_rgb])[0]
    # Distance in Lab of every pixel to paper
    d = lab - paper_lab.reshape(1, 1, 3)
    dist2 = np.sum(d * d, axis=2)
    # Adaptive threshold: paper is tight; AA fringe is looser
    paper_like = dist2 < 140.0
    paper_like |= alpha < 12
    # Must be connected to the border
    mask = np.zeros((h, w), np.uint8)
    mask[paper_like] = 1
    # Force border seeds
    mask[0, :] = 1
    mask[-1, :] = 1
    mask[:, 0] = 1
    mask[:, -1] = 1
    # Flood only through paper_like
    seed = np.zeros((h + 2, w + 2), np.uint8)
    fill = mask.copy()
    # Use connected components of paper_like; keep those touching border
    n, labels = cv2.connectedComponents(mask, connectivity=4)
    keep = np.zeros(n, dtype=bool)
    keep[0] = False
    border_labs = np.unique(
        np.concatenate(
            [labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]]
        )
    )
    keep[border_labs] = True
    paper = keep[labels]
    # If almost everything is paper, still OK (logo on sheet)
    paper_rgb_mean = rgb[paper].mean(axis=0) if paper.any() else paper_rgb
    if lum(paper_rgb_mean) < 170:
        # Dark border — treat as no paper knockout (full-bleed art)
        return np.zeros((h, w), dtype=bool), paper_rgb_mean
    return paper, paper_rgb_mean


def hierarchical_palette(rgb, paper, grad, max_k=12, min_k=4, merge_thresh=18.0):
    """Agglomerative Lab clustering of flat-region popularity bins."""
    h, w = rgb.shape[:2]
    art = ~paper
    flat = (grad < 18.0) & art
    if int(flat.sum()) < 200:
        flat = (grad < 40.0) & art
    if int(flat.sum()) < 80:
        flat = art
    pix = rgb[flat]
    # 5-bit bins
    q = (pix.astype(np.int32) >> 3)
    keys, inv, counts = np.unique(q, axis=0, return_inverse=True, return_counts=True)
    # Mean RGB per bin
    sums = np.zeros((len(keys), 3), np.float64)
    np.add.at(sums, inv, pix)
    means = sums / np.maximum(counts[:, None], 1)
    labs = lab_of_rgb(means.clip(0, 255))

    # Drop tiny bins
    keep = counts >= max(4, int(0.00015 * max(1, int(art.sum()))))
    if keep.sum() < min_k:
        keep = counts >= 1
    labs = labs[keep]
    means = means[keep]
    counts = counts[keep].astype(np.float64)

    clusters = [
        {"lab": labs[i].copy(), "rgb": means[i].copy(), "n": float(counts[i])}
        for i in range(len(labs))
    ]

    def closest_pair(cs):
        best = (1e18, 0, 1)
        labs_a = np.stack([c["lab"] for c in cs])
        for i in range(len(cs)):
            dvec = labs_a[i + 1 :] - labs_a[i]
            dist = np.sqrt(np.sum(dvec * dvec, axis=1))
            if dist.size == 0:
                continue
            for jrel, val in enumerate(dist):
                val = float(val)
                if val >= best[0]:
                    continue
                if not can_merge_labs(labs_a[i], labs_a[i + 1 + jrel], val, 1e9):
                    # Still allow merge if we are above max_k and this is the only way
                    continue
                best = (val, i, i + 1 + jrel)
        if best[0] >= 1e17:
            # No hue-legal pair: fall back to nearest regardless (must reduce k)
            for i in range(len(cs)):
                dvec = labs_a[i + 1 :] - labs_a[i]
                dist = np.sqrt(np.sum(dvec * dvec, axis=1))
                if dist.size and float(dist.min()) < best[0]:
                    jrel = int(np.argmin(dist))
                    best = (float(dist[jrel]), i, i + 1 + jrel)
        return best

    while len(clusters) > min_k:
        d, i, j = closest_pair(clusters)
        legal = can_merge_labs(clusters[i]["lab"], clusters[j]["lab"], d, merge_thresh)
        if len(clusters) <= max_k and (d > merge_thresh or not legal):
            break
        if len(clusters) <= 2:
            break
        a, b = clusters[i], clusters[j]
        n = a["n"] + b["n"]
        merged = {
            "lab": (a["lab"] * a["n"] + b["lab"] * b["n"]) / n,
            "rgb": (a["rgb"] * a["n"] + b["rgb"] * b["n"]) / n,
            "n": n,
        }
        clusters = [c for k, c in enumerate(clusters) if k != i and k != j]
        clusters.append(merged)

    # Sort by count desc
    clusters.sort(key=lambda c: -c["n"])
    palette = [c["rgb"] for c in clusters[:max_k]]
    return palette


def kmeans_refine(rgb, paper, palette, samples=12000):
    art_idx = np.flatnonzero((~paper).ravel())
    if art_idx.size == 0:
        return palette
    rng = np.random.default_rng(0)
    take = art_idx
    if take.size > samples:
        take = rng.choice(take, samples, replace=False)
    pix = rgb.reshape(-1, 3)[take].astype(np.float32)
    lab = lab_of_rgb(pix)
    k = len(palette)
    if k < 2:
        return palette
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 25, 0.4)
    _, labels, cents = cv2.kmeans(
        lab, k, None, criteria, 4, cv2.KMEANS_PP_CENTERS
    )
    # Map Lab centers back via mean RGB of assigned samples
    out = []
    for i in range(k):
        sel = labels.ravel() == i
        if sel.sum() < 4:
            out.append(np.array(palette[i], dtype=np.float64))
        else:
            out.append(pix[sel].mean(axis=0))
    return out if out else palette


def assign_pixels(rgb, paper, palette):
    h, w = rgb.shape[:2]
    k = len(palette)
    lab = to_lab(rgb)
    cents = lab_of_rgb(np.array(palette)).reshape(1, 1, k, 3)
    diff = lab[:, :, None, :] - cents
    dist2 = np.sum(diff * diff, axis=3)
    assign = dist2.argmin(axis=2).astype(np.int16)
    assign[paper] = -1
    return assign, dist2


def edge_aware_smooth(assign, dist2, grad, k, passes=3):
    """ICM majority on high-gradient / ambiguous (AA) pixels only."""
    h, w = assign.shape
    amb = (grad > 10) | (dist2.min(axis=2) > 40)
    amb &= assign >= 0
    out = assign.copy()
    for _ in range(passes):
        p = np.pad(out, 1, mode="edge")
        votes = np.zeros((h, w, k), np.int16)
        for dy in range(3):
            for dx in range(3):
                sl = p[dy : dy + h, dx : dx + w]
                for lab in range(k):
                    votes[:, :, lab] += sl == lab
        # Paper (-1) should not steal interior via pad; already excluded
        maj = votes.argmax(axis=2).astype(np.int16)
        out = np.where(amb, maj, out)
        out[assign < 0] = -1
    return out


def majority_all(assign, k, passes=1, protect=None):
    h, w = assign.shape
    out = assign.copy()
    for _ in range(passes):
        p = np.pad(out, 1, mode="edge")
        votes = np.zeros((h, w, k), np.int16)
        for dy in range(3):
            for dx in range(3):
                sl = p[dy : dy + h, dx : dx + w]
                for lab in range(k):
                    votes[:, :, lab] += sl == lab
        maj = votes.argmax(axis=2).astype(np.int16)
        keep_paper = out < 0
        src = out
        out = maj
        out[keep_paper] = -1
        if protect is not None:
            out = np.where(protect, src, out)
    return out


def despeckle(assign, palette, min_size, protect=True):
    """Merge tiny 4-connected components into neighbor majority. Keep detail islands."""
    h, w = assign.shape
    k = len(palette)
    out = assign.copy()
    is_bright = np.array([lum(c) > 175 for c in palette], dtype=bool)
    is_dark = np.array([lum(c) < 55 for c in palette], dtype=bool)
    for lab in range(k):
        mask = (out == lab).astype(np.uint8)
        if mask.sum() == 0:
            continue
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        for i in range(1, n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area >= min_size:
                continue
            ys, xs = np.where(labels == i)
            keep = False
            if protect and area >= 5:
                # Compact high-contrast island (eye, tooth) or thin whisker
                bw = int(stats[i, cv2.CC_STAT_WIDTH])
                bh = int(stats[i, cv2.CC_STAT_HEIGHT])
                aspect = max(bw, bh) / max(1, min(bw, bh))
                # Neighbor labels
                neigh = []
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx = np.clip(xs + dx, 0, w - 1)
                    ny = np.clip(ys + dy, 0, h - 1)
                    neigh.append(out[ny, nx])
                neigh = np.concatenate(neigh)
                foreign = neigh[(neigh >= 0) & (neigh != lab)]
                if foreign.size:
                    # Contrast vs dominant neighbor
                    dom = int(np.bincount(foreign.astype(np.int32), minlength=k).argmax())
                    contrast = abs(lum(palette[lab]) - lum(palette[dom]))
                    if is_bright[lab] and is_dark[dom] and contrast > 80 and area >= 6:
                        keep = True
                    elif aspect >= 5 and area >= 8 and contrast > 40:
                        keep = True
            if keep:
                continue
            # Vote neighbors
            votes = np.zeros(k, np.int32)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx = np.clip(xs + dx, 0, w - 1)
                ny = np.clip(ys + dy, 0, h - 1)
                v = out[ny, nx]
                ok = (v >= 0) & (v != lab)
                if ok.any():
                    for val in v[ok]:
                        votes[int(val)] += 1
            best = int(votes.argmax()) if votes.sum() else -1
            if best >= 0 and votes[best] > 0:
                out[ys, xs] = best
    return out


def recolor_palette(rgb, assign, palette, grad=None):
    """Mean of confident (flat) pixels so AA mix does not muddy fills."""
    out = []
    flat = None
    if grad is not None:
        flat = grad < 14.0
    for i, c in enumerate(palette):
        sel = assign == i
        if flat is not None:
            sel_f = sel & flat
            if int(sel_f.sum()) >= 12:
                sel = sel_f
        if sel.sum() < 4:
            out.append(c)
        else:
            out.append(rgb[sel].mean(axis=0))
    return out


def detect_logo(rgb, paper, palette, assign) -> bool:
    """Logo = few large flat shapes. Illustrations have many components."""
    k = len(palette)
    n_art = int((assign >= 0).sum())
    if n_art < 50:
        return True
    if k >= 10:
        return False
    comps = 0
    large = 0
    for i in range(k):
        mask = (assign == i).astype(np.uint8)
        if int(mask.sum()) < 16:
            continue
        n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        for j in range(1, n):
            a = int(stats[j, cv2.CC_STAT_AREA])
            if a >= 16:
                comps += 1
            if a >= 400:
                large += 1
    rec = np.zeros_like(rgb)
    for i, c in enumerate(palette):
        rec[assign == i] = np.clip(c, 0, 255)
    art = assign >= 0
    err = float(np.abs(rgb[art].astype(np.float32) - rec[art].astype(np.float32)).mean()) if art.any() else 0.0
    if comps > 80:
        return False
    if comps <= 40 and k <= 7 and err < 14 and large <= 18:
        return True
    return False


def contours_from_mask(mask: np.ndarray, scale: int = 2):
    """Subpixel-ish contours via upsample + findContours (outer + holes)."""
    m = (mask > 0).astype(np.uint8) * 255
    if scale > 1:
        m = cv2.resize(m, (m.shape[1] * scale, m.shape[0] * scale), interpolation=cv2.INTER_NEAREST)
    # Close 1px pinholes at 2x without swallowing gaps
    kernel = np.ones((3, 3), np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, kernel, iterations=1)
    cnts, hier = cv2.findContours(m, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return []
    hier = hier[0]
    inv = 1.0 / scale
    out = []
    for i, c in enumerate(cnts):
        pts = [(p[0][0] * inv, p[0][1] * inv) for p in c]
        if len(pts) < 5:
            continue
        parent = int(hier[i][3])
        hole = parent >= 0
        out.append({"pts": pts, "hole": hole, "parent": parent, "i": i, "area": abs(ring_area(pts))})
    return out


def compound_path(outers_holes, sx, sy, error, corner_cos, logo, inflate, min_area):
    """Build SVG path strings. Holes ride with their outer as evenodd compound."""
    by_parent = defaultdict(list)
    outers = []
    for c in outers_holes:
        if c["hole"]:
            by_parent[c["parent"]].append(c)
        else:
            outers.append(c)
    outers.sort(key=lambda c: -c["area"])
    paths = []
    for oc in outers:
        if oc["area"] < min_area:
            continue
        spacing = 0.85 if logo else 0.7
        simp = 0.38 if logo else 0.26
        ring = prepare_contour(
            oc["pts"], inflate=inflate, spacing=spacing, simplify_eps=simp, logo=logo
        )
        if not ring:
            continue
        d = path_from_ring(
            ring, sx, sy, error=error, corner_cos=corner_cos, logo=logo, min_area=min_area * 0.7
        )
        if not d:
            continue
        # Holes
        hole_ds = []
        for hc in by_parent.get(oc["i"], []):
            if hc["area"] < min_area * 0.5:
                continue
            hring = prepare_contour(
                hc["pts"], inflate=-inflate * 0.3 if inflate else 0.0,
                spacing=spacing, simplify_eps=simp, logo=logo,
            )
            if not hring:
                continue
            hd = path_from_ring(
                hring, sx, sy, error=error, corner_cos=corner_cos, logo=logo, min_area=min_area * 0.4
            )
            if hd:
                hole_ds.append(hd)
        if hole_ds:
            paths.append(" ".join([d] + hole_ds))
        else:
            paths.append(d)
    return paths


def svg_from_layers(layers, width_in, height_in, paper_hex=None):
    w = fmt(width_in, 4)
    h = fmt(height_in, 4)
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}in" height="{h}in" viewBox="0 0 {w} {h}">',
    ]
    if paper_hex:
        parts.append(
            f'  <rect x="0" y="0" width="{w}" height="{h}" fill="{paper_hex}" data-name="paper-underlay"/>'
        )
    for L in layers:
        hex_ = L["hex"]
        name = L.get("name") or ""
        paths = L.get("paths") or []
        if not paths:
            continue
        parts.append(f'  <g fill="{hex_}" fill-rule="evenodd" data-name="{_esc(name)}">')
        for d in paths:
            parts.append(f'    <path d="{d}"/>')
        parts.append("  </g>")
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def _esc(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def vectorize(path: str, inches: float = 10.0, colors=None, mode: str = "auto"):
    t0 = time.time()
    rgb, alpha = load_rgba(path)
    h0, w0 = rgb.shape[:2]
    # Working resolution
    max_edge = max(w0, h0)
    work_cap = 1100
    scale_in = 1.0
    if max_edge > work_cap:
        scale_in = work_cap / max_edge
        rgb = cv2.resize(rgb, (int(round(w0 * scale_in)), int(round(h0 * scale_in))), interpolation=cv2.INTER_AREA)
        alpha = cv2.resize(alpha, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_NEAREST)
    # Bilateral helps logo AA; it melts illustration detail (teeth, whiskers)
    if max(w0, h0) < 700:
        rgb_f = cv2.bilateralFilter(rgb, d=5, sigmaColor=18, sigmaSpace=5)
    else:
        rgb_f = rgb
    h, w = rgb_f.shape[:2]

    paper, paper_rgb = detect_paper(rgb_f, alpha)
    grad = gradient_mag(rgb_f)
    # Absorb only light AA halo into paper — never eat dark outline strokes
    luma = 0.299 * rgb_f[:, :, 0] + 0.587 * rgb_f[:, :, 1] + 0.114 * rgb_f[:, :, 2]
    paper = paper | (
        cv2.dilate(paper.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=1).astype(bool)
        & (grad > 10)
        & (luma > 150)
    )
    art_n = int((~paper).sum())
    if art_n < 20:
        # Nothing but paper
        width_in = inches
        height_in = inches * (h0 / w0)
        svg = svg_from_layers([], width_in, height_in, to_hex(paper_rgb))
        return svg, {"paths": 0, "colors": 0, "mode": "empty", "ms": int((time.time() - t0) * 1000)}

    # Color budget
    if colors is None:
        max_k = 12
        min_k = 5
        merge = 12.0
    else:
        max_k = max(2, min(24, int(colors)))
        min_k = max(2, min(max_k, 3))
        merge = 12.0

    palette = hierarchical_palette(rgb_f, paper, grad, max_k=max_k, min_k=min_k, merge_thresh=merge)
    palette = merge_near(palette, 10.0)
    if colors is not None:
        palette = palette[: int(colors)]

    assign, dist2 = assign_pixels(rgb_f, paper, palette)
    k = len(palette)
    assign = geodesic_aa_fill(assign, paper, grad, k, rgb_f, palette, radius=3)
    assign = edge_aware_smooth(assign, dist2, grad, k, passes=2)
    protect_dark = np.zeros(assign.shape, dtype=bool)
    for i, c in enumerate(palette):
        if lum(c) < 55:
            protect_dark |= assign == i
    assign = majority_all(assign, k, passes=1, protect=protect_dark)
    min_pix = max(8, int(art_n * 0.00008))
    assign = despeckle(assign, palette, min_pix, protect=True)
    assign, palette = recover_white_islands(rgb_f, paper, assign, palette)
    k = len(palette)
    palette = recolor_palette(rgb_f, assign, palette, grad=grad)

    logo = detect_logo(rgb_f, paper, palette, assign) if mode == "auto" else (mode == "logo")
    if mode == "art":
        logo = False

    if logo:
        dark_ids = [
            i for i, c in enumerate(palette)
            if lum(c) < 72 and chroma_of_lab(lab_of_rgb([c])[0]) < 22
        ]
        if len(dark_ids) > 1:
            keep = min(dark_ids, key=lambda i: lum(palette[i]))
            for i in dark_ids:
                if i != keep:
                    assign[assign == i] = keep
        assign = constrain_light_islands(assign, palette)
        assign = despeckle(assign, palette, max(min_pix, 16), protect=True)
        palette = recolor_palette(rgb_f, assign, palette, grad=grad)

    counts = [(i, int((assign == i).sum())) for i in range(k)]
    counts = [(i, n) for i, n in counts if n >= min_pix]
    specs = []
    for i, n in counts:
        specs.append({"i": i, "n": n, "rgb": palette[i], "lum": lum(palette[i])})
    if logo:
        # Light → dark: black outlines cover seams
        specs.sort(key=lambda s: (-s["lum"], -s["n"]))
    else:
        # Dark → light: cream teeth / eye whites sit on top of black
        specs.sort(key=lambda s: (s["lum"], -s["n"]))

    # User-space: inches, matching source aspect
    if w0 >= h0:
        width_in = float(inches)
        height_in = float(inches) * (h0 / float(w0))
    else:
        height_in = float(inches)
        width_in = float(inches) * (w0 / float(h0))
    sx = width_in / w
    sy = height_in / h

    fit_err = 1.45 if logo else 0.62
    corner_cos = 0.05 if logo else 0.42
    inflate = 0.55 if logo else 0.28
    min_area = 12.0 if logo else 2.2
    contour_scale = 3 if logo else 2

    layers = []
    n_paths = 0
    for spec in specs:
        mask = (assign == spec["i"]).astype(np.uint8)
        is_dark = lum(spec["rgb"]) < 60
        if is_dark and logo:
            # Reconnect thin outline strokes; steal only from paper
            closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), iterations=1)
            mask = np.where((closed > 0) & (assign < 0), 1, mask).astype(np.uint8)
            dil = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=1)
            steal = (dil > 0) & (mask == 0) & (assign < 0)
            mask = mask.copy()
            mask[steal] = 1
        elif logo:
            dil = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=1)
            steal = (dil > 0) & (mask == 0) & (assign < 0)
            mask = mask.copy()
            mask[steal] = 1
        cnts = contours_from_mask(mask, scale=contour_scale)
        paths = compound_path(
            cnts, sx, sy,
            error=fit_err,
            corner_cos=corner_cos,
            logo=logo,
            inflate=inflate if lum(spec["rgb"]) < 70 else inflate * 0.7,
            min_area=min_area,
        )
        if not paths:
            continue
        layers.append({
            "hex": to_hex(spec["rgb"]),
            "name": layer_name(spec["rgb"]),
            "paths": paths,
            "lum": spec["lum"],
            "n": spec["n"],
        })
        n_paths += len(paths)

    paper_hex = to_hex(paper_rgb) if lum(paper_rgb) >= 180 else None
    svg = svg_from_layers(layers, width_in, height_in, paper_hex)
    meta = {
        "engine": "decoclub-vector",
        "mode": "logo" if logo else "art",
        "paths": n_paths,
        "colors": len(layers),
        "palette": [to_hex(s["rgb"]) for s in specs],
        "pixel": [w0, h0],
        "work": [w, h],
        "inches": [width_in, height_in],
        "ms": int((time.time() - t0) * 1000),
        "paper": paper_hex,
    }
    return svg, meta


def merge_dark_neutrals(palette, lum_cut=72):
    """Collapse multiple near-black inks into one outline color."""
    dark, rest = [], []
    for c in palette:
        lab = lab_of_rgb([c])[0]
        if lum(c) < lum_cut and chroma_of_lab(lab) < 22:
            dark.append(np.array(c, dtype=np.float64))
        else:
            rest.append(c)
    if len(dark) <= 1:
        return list(palette)
    # Prefer the darkest ink (outlines), not the mean (which muddies to gray)
    dark.sort(key=lambda c: lum(c))
    rest.append(dark[0])
    return rest


def merge_near(palette, thresh):
    labs = lab_of_rgb(np.array(palette))
    used = [False] * len(palette)
    out = []
    for i in range(len(palette)):
        if used[i]:
            continue
        acc = np.array(palette[i], dtype=np.float64)
        n = 1
        used[i] = True
        for j in range(i + 1, len(palette)):
            if used[j]:
                continue
            d = labs[i] - labs[j]
            dist = math.sqrt(float(np.dot(d, d)))
            if can_merge_labs(labs[i], labs[j], dist, thresh):
                acc += palette[j]
                n += 1
                used[j] = True
        out.append(acc / n)
    return out


def geodesic_aa_fill(assign, paper, grad, k, rgb, palette, radius=4):
    """Replace mixed AA pixels with nearest confident label. Keep solid strokes."""
    h, w = assign.shape
    rec = np.zeros_like(rgb, dtype=np.float32)
    for i, c in enumerate(palette):
        rec[assign == i] = c
    rec[paper] = 0
    err = np.abs(rgb.astype(np.float32) - rec).sum(axis=2)
    luma = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    dark_ids = [i for i, c in enumerate(palette) if lum(c) < 80]
    ink = np.zeros(assign.shape, dtype=bool)
    for i in dark_ids:
        ink |= assign == i
    ink &= luma < 120
    # Confident: low reconstruction error OR solid/soft dark ink strokes
    confident = paper | ((assign >= 0) & ((err < 48) | ink))
    if int((~confident).sum()) < 20:
        return assign
    work = assign.copy()
    unknown = ~confident
    work[unknown] = -2
    work[paper] = -1
    for _ in range(max(1, radius)):
        if not (work == -2).any():
            break
        p = np.pad(work, 1, constant_values=-2)
        votes = np.zeros((h, w, k + 1), np.int16)
        for dy in range(3):
            for dx in range(3):
                sl = p[dy : dy + h, dx : dx + w]
                for lab in range(k):
                    votes[:, :, lab] += sl == lab
                votes[:, :, k] += sl == -1
        maj = votes.argmax(axis=2).astype(np.int16)
        known_n = votes.sum(axis=2)
        fill = unknown & (work == -2) & (known_n > 0)
        new = np.where(maj == k, -1, maj).astype(np.int16)
        work = np.where(fill, new, work)
    leftover = work == -2
    if leftover.any():
        work[leftover] = assign[leftover]
    work[paper] = -1
    return work


def recover_white_islands(rgb, paper, assign, palette):
    """If compact near-white islands exist (eyes), add a white palette slot."""
    has_white = any(lum(c) > 220 and chroma_of_lab(lab_of_rgb([c])[0]) < 14 for c in palette)
    if has_white:
        return assign, palette
    lab = to_lab(rgb)
    L = lab[:, :, 0]
    ch = np.hypot(lab[:, :, 1] - 128.0, lab[:, :, 2] - 128.0)
    cand = (~paper) & (L > 210) & (ch < 16)
    if int(cand.sum()) < 30:
        return assign, palette
    mask = cand.astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
    keep = np.zeros_like(mask)
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        if 20 <= area <= 8000 and max(bw, bh) / max(1, min(bw, bh)) < 2.8:
            keep[labels == i] = 1
    if keep.sum() < 20:
        return assign, palette
    white_rgb = rgb[keep > 0].mean(axis=0)
    palette = list(palette) + [white_rgb]
    idx = len(palette) - 1
    assign = assign.copy()
    assign[keep > 0] = idx
    return assign, palette


def constrain_light_islands(assign, palette, min_size=18, max_size=6000):
    """Near-white should only survive as compact islands (eyes). Scatter becomes neighbor."""
    h, w = assign.shape
    k = len(palette)
    out = assign.copy()
    for lab, c in enumerate(palette):
        # Only near-white neutrals (eyes), never yellow/pastel fills
        if lum(c) < 220 or chroma_of_lab(lab_of_rgb([c])[0]) > 16:
            continue
        mask = (out == lab).astype(np.uint8)
        if mask.sum() == 0:
            continue
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        for i in range(1, n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            bw = int(stats[i, cv2.CC_STAT_WIDTH])
            bh = int(stats[i, cv2.CC_STAT_HEIGHT])
            aspect = max(bw, bh) / max(1, min(bw, bh))
            compact = aspect < 2.6 and 0.55 * bw * bh >= area * 0.45
            keep = compact and min_size <= area <= max_size
            if keep:
                continue
            ys, xs = np.where(labels == i)
            votes = np.zeros(k, np.int32)
            paper_n = 0
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx = np.clip(xs + dx, 0, w - 1)
                ny = np.clip(ys + dy, 0, h - 1)
                v = out[ny, nx]
                paper_n += int((v < 0).sum())
                ok = (v >= 0) & (v != lab)
                if ok.any():
                    for val in v[ok]:
                        votes[int(val)] += 1
            best = int(votes.argmax()) if votes.sum() else -1
            if votes.sum() == 0 or paper_n > votes.sum():
                out[ys, xs] = -1
            elif best >= 0:
                out[ys, xs] = best
    return out


def main():
    ap = argparse.ArgumentParser(description="DecoClub Pro local vectorizer")
    ap.add_argument("--input", "-i", required=True)
    ap.add_argument("--output", "-o", required=True)
    ap.add_argument("--inches", type=float, default=10.0)
    ap.add_argument("--colors", type=int, default=None)
    ap.add_argument("--mode", choices=["auto", "logo", "art"], default="auto")
    args = ap.parse_args()
    # Allow running as `python lib/trace.py` from repo root or lib/
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    svg, meta = vectorize(args.input, inches=args.inches, colors=args.colors, mode=args.mode)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(svg)
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    # Ensure geom import works when executed as a script
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
