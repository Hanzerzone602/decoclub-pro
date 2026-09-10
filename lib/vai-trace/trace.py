#!/usr/bin/env python3
"""
DecoClub Pro local raster→SVG engine.

General pipeline (no per-artwork paste / no filename branches):
  1. Classify logo / art / poster from size, flats, and palette.
  2. Paper flood, true-alpha flatten, JPEG denoise on flats.
  3. Logo: Lab palette snap, color-preserving upsample, evenodd holes, potrace.
  4. Art / poster: vtracer spline on a size-capped flattened raster
     (Lab plates turned busy illustrations into mush).

Free/local only: potrace, vtracer, OpenCV, Magick, project libs.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import cv2
import numpy as np
from PIL import Image


def fmt(n, digits=4):
    x = round(float(n), digits)
    if x == 0:
        return "0"
    s = f"{x:.{digits}f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def to_hex(rgb) -> str:
    r, g, b = [max(0, min(255, int(round(x)))) for x in rgb]
    return f"#{r:02x}{g:02x}{b:02x}"


def lum(rgb) -> float:
    return 0.299 * float(rgb[0]) + 0.587 * float(rgb[1]) + 0.114 * float(rgb[2])


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
    return arr[:, :, :3].copy(), arr[:, :, 3].copy()


def to_lab(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)


def lab_of_rgb(rgb_list) -> np.ndarray:
    a = np.array(rgb_list, dtype=np.uint8).reshape(-1, 1, 3)
    return cv2.cvtColor(a, cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)


def chroma_of_lab(lab) -> float:
    return float(math.hypot(float(lab[1]) - 128.0, float(lab[2]) - 128.0))


def hue_of_lab(lab) -> float:
    return math.atan2(float(lab[2]) - 128.0, float(lab[1]) - 128.0)


def gradient_mag(rgb: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.magnitude(gx, gy)


def luma_map(rgb: np.ndarray) -> np.ndarray:
    return (
        0.299 * rgb[:, :, 0].astype(np.float32)
        + 0.587 * rgb[:, :, 1].astype(np.float32)
        + 0.114 * rgb[:, :, 2].astype(np.float32)
    )


def chroma_map(lab: np.ndarray) -> np.ndarray:
    return np.hypot(lab[:, :, 1] - 128.0, lab[:, :, 2] - 128.0)


def _esc(s: str) -> str:
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


# ---------------------------------------------------------------------------
# Paper / denoise
# ---------------------------------------------------------------------------

def detect_paper(rgb: np.ndarray, alpha: np.ndarray):
    """Border-connected near-uniform background (light sheet or dark bleed)."""
    h, w = rgb.shape[:2]
    lab = to_lab(rgb)
    border = np.concatenate([rgb[0, :, :], rgb[-1, :, :], rgb[:, 0, :], rgb[:, -1, :]], axis=0)
    q = (border // 8).astype(np.int32)
    keys, counts = np.unique(q, axis=0, return_counts=True)
    mode = keys[int(np.argmax(counts))] * 8 + 4
    paper_rgb = np.clip(mode, 0, 255).astype(np.float32)
    paper_lab = lab_of_rgb([paper_rgb])[0]
    d = lab - paper_lab.reshape(1, 1, 3)
    dist2 = np.sum(d * d, axis=2)
    paper_like = (dist2 < 200.0) | (alpha < 12)
    mask = paper_like.astype(np.uint8)
    mask[0, :] = 1
    mask[-1, :] = 1
    mask[:, 0] = 1
    mask[:, -1] = 1
    n, labels = cv2.connectedComponents(mask, connectivity=4)
    keep = np.zeros(n, dtype=bool)
    border_ids = np.unique(
        np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    )
    keep[border_ids] = True
    keep[0] = False
    paper = keep[labels]
    mean = rgb[paper].mean(axis=0) if paper.any() else paper_rgb
    # If the border is a thin dark frame around a light sheet, prefer the light sheet.
    if lum(mean) < 80 and float(np.std(border.astype(np.float32))) > 25:
        light = (luma_map(rgb) > 220) & (chroma_map(lab) < 14)
        if int(light.sum()) > 0.08 * h * w:
            n2, lab2 = cv2.connectedComponents(light.astype(np.uint8), 4)
            bid = np.unique(np.concatenate([lab2[0], lab2[-1], lab2[:, 0], lab2[:, -1]]))
            keep2 = np.zeros(n2, dtype=bool)
            keep2[bid] = True
            keep2[0] = False
            paper2 = keep2[lab2]
            if int(paper2.sum()) > int(paper.sum()) * 0.5:
                paper = paper2
                mean = rgb[paper].mean(axis=0)
    return paper, np.clip(mean, 0, 255).astype(np.float32)


def denoise_jpeg(rgb, paper, grad):
    """Median-filter flat interiors so JPEG ringing does not mint extra inks."""
    q = (rgb.astype(np.int32) >> 3)
    nuniq = int(np.unique(q.reshape(-1, 3), axis=0).shape[0])
    if nuniq < 180:
        return rgb
    med = cv2.medianBlur(rgb, 3)
    flat = (grad < 22) | paper
    out = rgb.copy()
    out[flat] = med[flat]
    return out


# ---------------------------------------------------------------------------
# Palette
# ---------------------------------------------------------------------------

def can_merge_labs(la, lb, dist, thresh) -> bool:
    ca, cb = chroma_of_lab(la), chroma_of_lab(lb)
    if ca < 12 and cb < 12 and float(la[0]) < 55 and float(lb[0]) < 55:
        return dist < max(thresh, 28.0)
    if dist > thresh:
        return False
    if (ca < 10 and cb > 20) or (cb < 10 and ca > 20):
        return False
    if ca > 14 and cb > 14:
        dh = abs(hue_of_lab(la) - hue_of_lab(lb))
        dh = min(dh, 2 * math.pi - dh)
        if dh > 0.45:
            return False
    if abs(float(la[0]) - float(lb[0])) > 55 and dist > thresh * 0.5:
        return False
    return True


def is_blend(c_rgb, a_rgb, b_rgb, tol=16.0) -> bool:
    a, b, c = [np.asarray(x, dtype=np.float64) for x in (a_rgb, b_rgb, c_rgb)]
    ab = b - a
    n2 = float(np.dot(ab, ab))
    if n2 < 80:
        return False
    t = float(np.dot(c - a, ab) / n2)
    if t < 0.14 or t > 0.86:
        return False
    proj = a + t * ab
    return float(np.linalg.norm(c - proj)) < tol


def build_palette(rgb, paper, grad, max_k=8, min_k=2, merge_thresh=16.0):
    """Agglomerative Lab clustering of flat-region popularity bins."""
    art = ~paper
    gcut = 10.0 if max(rgb.shape[:2]) < 400 else 16.0
    flat = (grad < gcut) & art
    if int(flat.sum()) < 80:
        flat = (grad < 40.0) & art
    if int(flat.sum()) < 40:
        flat = art
    pix = rgb[flat]
    q = pix.astype(np.int32) >> 3
    keys, inv, counts = np.unique(q, axis=0, return_inverse=True, return_counts=True)
    sums = np.zeros((len(keys), 3), np.float64)
    np.add.at(sums, inv, pix)
    means = sums / np.maximum(counts[:, None], 1)
    keep = counts >= max(3, int(0.0003 * max(1, int(art.sum()))))
    if int(keep.sum()) < min_k:
        keep = counts >= 1
    means = means[keep]
    counts = counts[keep].astype(np.float64)
    labs = lab_of_rgb(np.clip(means, 0, 255))
    clusters = [
        {"lab": labs[i].copy(), "rgb": means[i].copy(), "n": float(counts[i])}
        for i in range(len(means))
    ]

    def closest_pair(cs):
        best = (1e18, 0, 1)
        L = np.stack([c["lab"] for c in cs])
        for i in range(len(cs)):
            dvec = L[i + 1 :] - L[i]
            dist = np.sqrt(np.sum(dvec * dvec, axis=1))
            for jrel, val in enumerate(dist):
                val = float(val)
                if val < best[0] and can_merge_labs(L[i], L[i + 1 + jrel], val, 1e9):
                    best = (val, i, i + 1 + jrel)
        if best[0] >= 1e17:
            for i in range(len(cs)):
                dvec = L[i + 1 :] - L[i]
                dist = np.sqrt(np.sum(dvec * dvec, axis=1))
                if dist.size and float(dist.min()) < best[0]:
                    jrel = int(np.argmin(dist))
                    best = (float(dist[jrel]), i, i + 1 + jrel)
        return best

    while len(clusters) > min_k:
        d, i, j = closest_pair(clusters)
        legal = can_merge_labs(clusters[i]["lab"], clusters[j]["lab"], d, merge_thresh)
        if len(clusters) <= 2:
            break
        # Never hue-fold (red into blue, white into gold) just to hit max_k.
        # Drop the smallest junk bin instead.
        if not legal or d > merge_thresh:
            if len(clusters) <= max_k:
                break
            smallest = min(range(len(clusters)), key=lambda ii: clusters[ii]["n"])
            clusters.pop(smallest)
            continue
        a, b = clusters[i], clusters[j]
        n = a["n"] + b["n"]
        ca, cb = chroma_of_lab(a["lab"]), chroma_of_lab(b["lab"])
        if abs(float(a["lab"][0]) - float(b["lab"][0])) > 40:
            # Dark outline inks: keep the darker. Chromatic fills: keep the ink, not the AA wash.
            if ca < 14 and cb < 14:
                keepc = a if float(a["lab"][0]) < float(b["lab"][0]) else b
            else:
                keepc = a if ca >= cb else b
            merged = {"lab": keepc["lab"].copy(), "rgb": keepc["rgb"].copy(), "n": n}
        else:
            merged = {
                "lab": (a["lab"] * a["n"] + b["lab"] * b["n"]) / n,
                "rgb": (a["rgb"] * a["n"] + b["rgb"] * b["n"]) / n,
                "n": n,
            }
        clusters = [c for k, c in enumerate(clusters) if k != i and k != j]
        clusters.append(merged)

    pal = [c["rgb"] for c in clusters]
    ns = [c["n"] for c in clusters]
    dropped = True
    while dropped and len(pal) > min_k:
        dropped = False
        remove = None
        for i in range(len(pal)):
            for j in range(len(pal)):
                if i == j:
                    continue
                for k in range(len(pal)):
                    if k == i or k == j:
                        continue
                    if ns[k] > 0.12 * (ns[i] + ns[j]):
                        continue
                    if is_blend(pal[k], pal[i], pal[j], tol=16):
                        lk = lum(pal[k])
                        if 50 < lk < 220:
                            remove = k
                            break
                if remove is not None:
                    break
            if remove is not None:
                break
        if remove is not None:
            pal.pop(remove)
            ns.pop(remove)
            dropped = True

    # Drop inks that match paper (they become holes / underlay).
    return pal


def drop_paper_inks(palette, paper_rgb, thresh=14.0):
    p_lab = lab_of_rgb([paper_rgb])[0]
    out = []
    for c in palette:
        la = lab_of_rgb([c])[0]
        # Never drop a real chromatic fill (yellow body, blue wings) as paper.
        if chroma_of_lab(la) > 16:
            out.append(c)
            continue
        d = la - p_lab
        if math.sqrt(float(np.dot(d, d))) < thresh:
            continue
        out.append(c)
    return out or list(palette)


def inject_missing_inks(rgb, paper, palette, grad, min_chroma=18.0, min_px=24):
    """If a real chromatic ink was dropped, put it back (bee red, etc.)."""
    if not palette:
        return palette
    lab = to_lab(rgb)
    ch = chroma_map(lab)
    art = ~paper
    cents = lab_of_rgb(np.array(palette)).reshape(1, 1, -1, 3)
    diff = lab[:, :, None, :] - cents
    dmin = np.sqrt(np.sum(diff * diff, axis=3).min(axis=2))
    far = art & (ch > min_chroma) & (dmin > 18) & (grad < 36)
    if int(far.sum()) < min_px:
        return palette
    # Cluster leftover chromatic pixels by 5-bit RGB
    pix = rgb[far]
    q = pix.astype(np.int32) >> 3
    keys, inv, counts = np.unique(q, axis=0, return_inverse=True, return_counts=True)
    order = np.argsort(-counts)
    out = list(palette)
    p_lab = [lab_of_rgb([c])[0] for c in out]
    for idx in order:
        if counts[idx] < min_px:
            continue
        mean = pix[inv == idx].mean(axis=0)
        la = lab_of_rgb([mean])[0]
        if chroma_of_lab(la) < min_chroma:
            continue
        ok = True
        for existing in p_lab:
            dd = la - existing
            if math.sqrt(float(np.dot(dd, dd))) < 18:
                ok = False
                break
        if not ok:
            continue
        out.append(mean)
        p_lab.append(la)
        if len(out) >= len(palette) + 4:
            break
    return out


# ---------------------------------------------------------------------------
# Assignment
# ---------------------------------------------------------------------------

def assign_pixels(rgb, paper, palette, paper_rgb, paper_win=0.0):
    lab = to_lab(rgb)
    k = len(palette)
    cents = lab_of_rgb(np.array(palette)).reshape(1, 1, k, 3)
    diff = lab[:, :, None, :] - cents
    dist2 = np.sum(diff * diff, axis=3)
    assign = dist2.argmin(axis=2).astype(np.int16)
    assign[paper] = -1
    if paper_win and lum(paper_rgb) >= 200:
        p_lab = lab_of_rgb([paper_rgb])[0]
        dpaper = np.sqrt(np.sum((lab - p_lab) ** 2, axis=2))
        dink = np.sqrt(dist2.min(axis=2))
        assign[dpaper <= dink * paper_win] = -1
    return assign, dist2


def punch_near_paper(assign, palette, paper_rgb, max_dist=10.0):
    """Turn inks that are essentially the paper color into holes."""
    p_lab = lab_of_rgb([paper_rgb])[0]
    out = assign.copy()
    for i, c in enumerate(palette):
        d = lab_of_rgb([c])[0] - p_lab
        if math.sqrt(float(np.dot(d, d))) < max_dist:
            out[out == i] = -1
    return out


def despeckle(assign, palette, min_size=4):
    """Merge tiny 4-connected islands; keep thin whiskers / compact eyes."""
    h, w = assign.shape
    k = len(palette)
    out = assign.copy()
    is_bright = np.array([lum(c) > 175 for c in palette], dtype=bool)
    is_dark = np.array([lum(c) < 55 for c in palette], dtype=bool)
    for lab in range(k):
        mask = (out == lab).astype(np.uint8)
        if int(mask.sum()) == 0:
            continue
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        for i in range(1, n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area >= min_size:
                continue
            bw = int(stats[i, cv2.CC_STAT_WIDTH])
            bh = int(stats[i, cv2.CC_STAT_HEIGHT])
            aspect = max(bw, bh) / max(1, min(bw, bh))
            ys, xs = np.where(labels == i)
            if aspect >= 4.0 and area >= 3:
                continue
            votes = np.zeros(k + 1, np.int32)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx = np.clip(xs + dx, 0, w - 1)
                ny = np.clip(ys + dy, 0, h - 1)
                v = out[ny, nx]
                votes[0] += int((v < 0).sum())
                ok = v >= 0
                if ok.any():
                    votes[1:] += np.bincount(v[ok].astype(np.int32), minlength=k)
            # Keep a bright speck on dark (tooth, eye glint)
            if area >= 4 and is_bright[lab]:
                neigh = out[np.clip(ys, 0, h - 1), np.clip(xs, 0, w - 1)]
                # contrast vs majority neighbor
                if votes[1:].sum() and is_dark[int(np.argmax(votes[1:]))]:
                    continue
            best = int(np.argmax(votes))
            if votes[best] == 0:
                continue
            out[ys, xs] = -1 if best == 0 else (best - 1)
    return out


def collapse_aa_inks(assign, palette, grad, min_keep=3):
    """Reassign inks whose pixels live mostly on edges (AA fringe, not a fill)."""
    k = len(palette)
    if k <= min_keep:
        return assign, palette
    labs = lab_of_rgb(np.array(palette))
    drop = []
    for i, c in enumerate(palette):
        sel = assign == i
        n = int(sel.sum())
        if n < 8:
            drop.append(i)
            continue
        mg = float(grad[sel].mean())
        lk = lum(c)
        ch = chroma_of_lab(labs[i])
        # Mid-tone, moderate chroma, lives on edges → AA between two real inks
        if mg > 22 and 45 < lk < 210 and n < 0.12 * assign.size:
            drop.append(i)
    if not drop or k - len(drop) < min_keep:
        return assign, palette
    keep = [i for i in range(k) if i not in drop]
    out = assign.copy()
    for i in drop:
        sel = out == i
        if not sel.any():
            continue
        d = labs[keep] - labs[i]
        dist = np.sqrt(np.sum(d * d, axis=1))
        out[sel] = keep[int(np.argmin(dist))]
    pal2 = [palette[i] for i in keep]
    remap = {old: new for new, old in enumerate(keep)}
    out2 = np.full_like(out, -1)
    m = out >= 0
    # map remaining
    for old, new in remap.items():
        out2[out == old] = new
    return out2, pal2


def recolor_palette(rgb, assign, palette, grad=None):
    out = []
    flat = (grad < 14.0) if grad is not None else None
    for i, c in enumerate(palette):
        sel = assign == i
        if flat is not None:
            sel_f = sel & flat
            if int(sel_f.sum()) >= 12:
                sel = sel_f
        if int(sel.sum()) < 4:
            out.append(c)
            continue
        pix = rgb[sel].astype(np.float32)
        mean = pix.mean(axis=0)
        if lum(mean) < 105:
            out.append(np.percentile(pix, 8, axis=0))
        elif lum(mean) > 220:
            out.append(np.percentile(pix, 88, axis=0))
        else:
            out.append(mean)
    return out


# ---------------------------------------------------------------------------
# Overlay (translucent grey veil sitting on many hues) + olive keyline
# ---------------------------------------------------------------------------

def extract_overlay(rgb, paper, grad):
    """Grey veil on multi-hue art (poster skull, etc.). Tiger-safe: fur has low hue diversity."""
    h, w = rgb.shape[:2]
    if max(h, w) < 700:
        return None
    art = ~paper
    if int(art.sum()) < 8000:
        return None
    lab = to_lab(rgb)
    ch = chroma_map(lab)
    luma = luma_map(rgb)
    seed = art & (ch < 26) & (luma > 78) & (luma < 198)
    mask = seed.astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    keep = np.zeros((h, w), np.uint8)
    k7 = np.ones((7, 7), np.uint8)
    hue = np.arctan2(lab[:, :, 2] - 128.0, lab[:, :, 1] - 128.0)
    scores = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < 250 or area > 0.35 * h * w:
            continue
        comp = (labels == i).astype(np.uint8)
        dist = cv2.distanceTransform(comp, cv2.DIST_L2, 3)
        med_t = float(np.median(dist[comp > 0])) if area else 0.0
        if med_t < 2.2:
            continue
        dil = cv2.dilate(comp, k7)
        ring = (dil > 0) & (comp == 0) & art
        if int(ring.sum()) < 40:
            continue
        nch = float(ch[ring].mean())
        if nch < 14:
            continue
        # Hue diversity of neighbors — overlay sits on sunset+trees+water
        rh = hue[ring]
        # wrap-safe bins
        bins = np.unique(np.round(rh * 4).astype(np.int32))
        if bins.size < 4:
            continue
        scores.append((area * (1.0 + med_t / 6.0), i, area))
    if not scores:
        return None
    scores.sort(reverse=True)
    if scores[0][2] < 0.012 * int(art.sum()):
        return None
    keep[labels == scores[0][1]] = 1
    hull = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (81, 81)))
    for _sc, i, a in scores[1:]:
        piece = labels == i
        if np.any(hull[piece]):
            keep[piece] = 1
    frac = float(keep.sum()) / max(int(art.sum()), 1)
    if frac < 0.012 or frac > 0.38:
        return None
    # Punch chromatic windows (sockets, landscape showing through)
    on = keep > 0
    punch = on & (ch > 38) & (luma > 70)
    keep[punch] = 0
    bright = on & (luma > 215)
    keep[bright] = 0
    # Olive/gold thin keyline near the veil
    la, lb = lab[:, :, 1], lab[:, :, 2]
    orange_halo = (
        (rgb[:, :, 0] > 200)
        & (rgb[:, :, 1] > 90)
        & (rgb[:, :, 1] < 190)
        & (rgb[:, :, 2] < 120)
        & ((rgb[:, :, 0].astype(np.int16) - rgb[:, :, 2]) > 80)
    )
    olive = (
        art
        & (luma > 40)
        & (luma < 175)
        & (ch > 12)
        & (ch < 62)
        & (lb > 128)
        & (la > 110)
        & (la < 152)
        & ~orange_halo
    )
    bone = olive.astype(np.uint8)
    distb = cv2.distanceTransform(bone, cv2.DIST_L2, 3)
    thin = bone.copy()
    thin[distb > 6.5] = 0
    near = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (55, 55)))
    key = ((thin > 0) & (near > 0)).astype(np.uint8)
    key = cv2.morphologyEx(key, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), 2)
    if int(key.sum()) < 80:
        key = np.zeros((h, w), np.uint8)
        key_rgb = None
    else:
        keep[key > 0] = 0
        key_rgb = rgb[key > 0].mean(axis=0).astype(np.float32)
    on = keep > 0
    if int(on.sum()) < 400:
        return None
    G = rgb[on].mean(axis=0).astype(np.float32)
    # Deblend landscape under the veil
    cover = on | (key > 0)
    src = art & (~cover) & (luma > 58)
    wgt = src.astype(np.float32)
    den = cv2.blur(wgt, (41, 41))
    bg = np.zeros_like(rgb, np.float32)
    for c in range(3):
        num = cv2.blur(rgb[:, :, c].astype(np.float32) * wgt, (41, 41))
        bg[:, :, c] = num / np.maximum(den, 1e-3)
    rgb_clean = np.where(cover[:, :, None], np.clip(bg, 0, 255).astype(np.uint8), rgb)
    need = cover & (den < 0.12)
    if int(need.sum()) > 20:
        rgb_clean = cv2.inpaint(rgb_clean, need.astype(np.uint8), 9, cv2.INPAINT_TELEA)
    # Alpha from solid grey vs mixed — keep the veil translucent
    solid = on & (ch < 15)
    alpha = 0.48
    if int(solid.sum()) >= 40:
        bgpx = rgb_clean[solid].astype(np.float32)
        obs = rgb[solid].astype(np.float32)
        denom = G.reshape(1, 3) - bgpx
        den2 = np.sum(denom * denom, axis=1) + 1e-6
        a = np.sum((obs - bgpx) * denom, axis=1) / den2
        a = a[(a > 0.15) & (a < 0.98)]
        if a.size >= 20:
            alpha = float(np.clip(np.median(a), 0.36, 0.54))
    return {
        "mask": keep,
        "key": key,
        "key_rgb": key_rgb,
        "rgb": G,
        "alpha": alpha,
        "rgb_clean": rgb_clean,
    }


# ---------------------------------------------------------------------------
# Lettering (dark glyphs with a chromatic halo)
# ---------------------------------------------------------------------------

def extract_letters(rgb, paper):
    h, w = rgb.shape[:2]
    if max(h, w) < 700:
        return np.zeros((h, w), dtype=bool), np.zeros((h, w), dtype=bool), None
    luma = luma_map(rgb)
    lab = to_lab(rgb)
    ch = chroma_map(lab)
    art = ~paper
    black = art & (luma < 52) & (ch < 32)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    orange = art & (r > 200) & (g > 100) & (g < 185) & (b < 115) & ((r.astype(np.int16) - b) > 80)
    ncc, labels, stats, _ = cv2.connectedComponentsWithStats(black.astype(np.uint8), 4)
    if ncc <= 2:
        return np.zeros((h, w), dtype=bool), np.zeros((h, w), dtype=bool), None
    areas = [(i, int(stats[i, cv2.CC_STAT_AREA])) for i in range(1, ncc)]
    areas.sort(key=lambda t: -t[1])
    skip = areas[0][0] if areas else -1
    k5 = np.ones((5, 5), np.uint8)
    max_area = 0.04 * h * w
    glyph = np.zeros((h, w), dtype=bool)
    for ci, area in areas:
        if ci == skip or area < 50 or area > max_area:
            continue
        bw = int(stats[ci, cv2.CC_STAT_WIDTH])
        bh = int(stats[ci, cv2.CC_STAT_HEIGHT])
        if max(bw, bh) > 0.55 * max(h, w):
            continue
        dist = cv2.distanceTransform((labels == ci).astype(np.uint8), cv2.DIST_L2, 3)
        on = dist > 0
        if not on.any() or float(np.median(dist[on])) < 1.6:
            continue
        comp = labels == ci
        dil = cv2.dilate(comp.astype(np.uint8), k5)
        ring = (dil > 0) & (~comp)
        if int(ring.sum()) < 12:
            continue
        ofrac = float(orange[ring].mean())
        if ofrac < 0.18:
            continue
        glyph[comp] = True
    if not glyph.any():
        return glyph, np.zeros((h, w), dtype=bool), None
    dist = cv2.distanceTransform((~glyph).astype(np.uint8), cv2.DIST_L2, 3)
    on = orange & (dist > 0.6) & (dist < 14)
    width = 5
    if int(on.sum()) >= 40:
        width = int(np.clip(round(float(np.percentile(dist[on], 68))), 3, 10))
    ksz = 2 * width + 1
    near = cv2.dilate(glyph.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz)))
    halo = (near > 0) & (~glyph)
    halo_rgb = rgb[orange & halo].mean(axis=0) if (orange & halo).any() else rgb[halo].mean(axis=0)
    return glyph, halo, halo_rgb.astype(np.float32)


# ---------------------------------------------------------------------------
# Potrace
# ---------------------------------------------------------------------------

_PATH_TOK = re.compile(r"[A-Za-z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")


def _write_pbm(path, mask):
    h, w = mask.shape
    bits = mask > 0
    rowb = (w + 7) // 8
    buf = bytearray(h * rowb)
    i = 0
    for y in range(h):
        row = bits[y]
        for xb in range(rowb):
            byte = 0
            base = xb * 8
            for b in range(8):
                x = base + b
                if x < w and row[x]:
                    byte |= 0x80 >> b
            buf[i] = byte
            i += 1
    with open(path, "wb") as f:
        f.write(f"P4\n{w} {h}\n".encode())
        f.write(buf)


def _transform_potrace_d(d, sx_pt, sy_pt, tx, ty, upsample, sx, sy):
    toks = _PATH_TOK.findall(d)
    out = []
    i = 0
    cx = cy = 0.0
    sx0 = sy0 = 0.0
    cmd = "M"

    def xf(x, y):
        px = (tx + x * sx_pt) / upsample * sx
        py = (ty + y * sy_pt) / upsample * sy
        return fmt(px), fmt(py)

    def read_n(n):
        nonlocal i
        vals = [float(toks[i + k]) for k in range(n)]
        i += n
        return vals

    while i < len(toks):
        t = toks[i]
        if re.match(r"[A-Za-z]$", t):
            cmd = t
            i += 1
            if cmd in "Zz":
                out.append("Z")
                cx, cy = sx0, sy0
            continue
        try:
            if cmd in "Mm":
                x, y = read_n(2)
                if cmd == "m":
                    x += cx
                    y += cy
                cx, cy = x, y
                sx0, sy0 = cx, cy
                x1, y1 = xf(cx, cy)
                out.append(f"M {x1} {y1}")
                cmd = "l" if cmd == "m" else "L"
            elif cmd in "Ll":
                x, y = read_n(2)
                if cmd == "l":
                    x += cx
                    y += cy
                cx, cy = x, y
                x1, y1 = xf(cx, cy)
                out.append(f"L {x1} {y1}")
            elif cmd in "Cc":
                vals = read_n(6)
                if cmd == "c":
                    vals[0] += cx
                    vals[1] += cy
                    vals[2] += cx
                    vals[3] += cy
                    vals[4] += cx
                    vals[5] += cy
                p1, p2, p3 = xf(vals[0], vals[1]), xf(vals[2], vals[3]), xf(vals[4], vals[5])
                cx, cy = vals[4], vals[5]
                out.append(f"C {p1[0]} {p1[1]} {p2[0]} {p2[1]} {p3[0]} {p3[1]}")
            elif cmd in "Hh":
                x = read_n(1)[0]
                if cmd == "h":
                    x += cx
                cx = x
                x1, y1 = xf(cx, cy)
                out.append(f"L {x1} {y1}")
            elif cmd in "Vv":
                y = read_n(1)[0]
                if cmd == "v":
                    y += cy
                cy = y
                x1, y1 = xf(cx, cy)
                out.append(f"L {x1} {y1}")
            else:
                i += 1
        except (IndexError, ValueError):
            i += 1
    return " ".join(out)


def potrace_paths(
    mask, sx, sy, *, scale=1, alphamax=1.0, opttol=0.2, turdsize=2, smooth=0.0
):
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) < 8:
        return []
    if scale > 1:
        m = cv2.resize(
            m, (m.shape[1] * scale, m.shape[0] * scale), interpolation=cv2.INTER_NEAREST
        )
    if smooth and smooth > 0:
        mf = cv2.GaussianBlur(m.astype(np.float32), (0, 0), float(smooth))
        m = (mf >= 0.50).astype(np.uint8)
    h, w = m.shape
    tmp = tempfile.mkdtemp(prefix="ptrace-")
    try:
        pbm = os.path.join(tmp, "m.pbm")
        svg_p = os.path.join(tmp, "m.svg")
        _write_pbm(pbm, m)
        r = subprocess.run(
            [
                "potrace",
                "-s",
                "-a",
                str(alphamax),
                "-O",
                str(opttol),
                "-t",
                str(turdsize),
                "-u",
                "10",
                "-o",
                svg_p,
                pbm,
            ],
            capture_output=True,
            text=True,
            timeout=45,
        )
        if r.returncode != 0 or not os.path.isfile(svg_p):
            return []
        svg = open(svg_p, encoding="utf-8").read()
    except Exception:
        return []
    finally:
        try:
            for fn in os.listdir(tmp):
                os.remove(os.path.join(tmp, fn))
            os.rmdir(tmp)
        except Exception:
            pass
    tm = re.search(r"translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)", svg)
    sm = re.search(r"scale\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)", svg)
    tx = float(tm.group(1)) if tm else 0.0
    ty = float(tm.group(2)) if tm else float(h)
    sx_pt = float(sm.group(1)) if sm else 0.1
    sy_pt = float(sm.group(2)) if sm else -0.1
    ds = []
    for mpath in re.finditer(r'<path\s[^>]*d="([^"]+)"', svg):
        d = _transform_potrace_d(mpath.group(1), sx_pt, sy_pt, tx, ty, scale, sx, sy)
        if d and "M" in d:
            ds.append(d)
    return ds


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
        extra = ""
        op = L.get("opacity")
        if op is not None and 0.05 < float(op) < 0.999:
            extra = f' fill-opacity="{fmt(float(op), 3)}"'
        parts.append(f'  <g fill="{hex_}" fill-rule="evenodd" data-name="{_esc(name)}"{extra}>')
        for d in paths:
            parts.append(f'    <path d="{d}"/>')
        parts.append("  </g>")
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


# ---------------------------------------------------------------------------
# Classify
# ---------------------------------------------------------------------------

def classify(rgb, paper, palette, rec_err, mode: str, paper_rgb=None) -> str:
    if mode in ("logo", "art", "poster"):
        return mode
    h, w = rgb.shape[:2]
    k = len(palette)
    maxe = max(h, w)
    paper_light = lum(paper_rgb) >= 190 if paper_rgb is not None else True
    # Light-sheet few-color marks (mascots, wordmarks). Grey-bg illustrations stay art.
    if paper_light and maxe < 420 and k <= 6:
        return "logo"
    if paper_light and maxe < 550 and k <= 5:
        return "logo"
    if paper_light and k <= 4 and rec_err < 20:
        return "logo"
    if paper_light and k <= 8 and rec_err < 14:
        return "logo"
    if paper_light and k <= 6 and rec_err < 28 and maxe < 1000:
        return "logo"
    if maxe >= 900 and k >= 7:
        return "poster"
    if maxe >= 700 and k >= 8:
        return "poster"
    return "art"


# ---------------------------------------------------------------------------
# vtracer backend (art / poster) — Lab plates mush busy illustrations
# ---------------------------------------------------------------------------

def find_vtracer() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    candidates = (
        os.path.join(here, "..", "..", "bin", "vtracer"),  # /app/bin/vtracer on Railway
        os.path.join(here, "..", "..", "bin", "vtracer.exe"),
        os.path.expanduser("~/.local/bin/vtracer"),
        "/workspace/decoclub-railway/bin/vtracer",
        "/usr/local/bin/vtracer",
        "/app/bin/vtracer",
    )
    for p in candidates:
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return os.path.realpath(p)
    w = shutil.which("vtracer")
    if w:
        return w
    raise FileNotFoundError("vtracer not found")


def flatten_alpha(rgb, alpha, paper, paper_rgb):
    """Composite true-alpha pixels onto the detected sheet so tracers don't see junk."""
    out = rgb.copy()
    paper2 = paper.copy()
    prgb = paper_rgb.copy()
    low = alpha < 12
    if float(low.mean()) > 0.02:
        if lum(prgb) >= 160:
            prgb = np.array([255.0, 255.0, 255.0], np.float32)
            fill = np.array([255, 255, 255], np.uint8)
        else:
            fill = np.clip(np.round(prgb), 0, 255).astype(np.uint8)
        out[low] = fill
        paper2 = paper2 | low
    return out, paper2, prgb


def wrap_vtracer_svg(svg_text: str, width_in: float, height_in: float) -> tuple[str, int, list]:
    """Keep vtracer paint order (stacked fills). Scale via viewBox + inch size."""
    if re.search(r"<image\b|data:image", svg_text, re.I):
        raise ValueError("vtracer svg contained an embedded raster")
    wm = re.search(r'\bwidth="([0-9.]+)"', svg_text)
    hm = re.search(r'\bheight="([0-9.]+)"', svg_text)
    pw = float(wm.group(1)) if wm else 0.0
    ph = float(hm.group(1)) if hm else 0.0
    inner_m = re.search(r"<svg\b[^>]*>(.*)</svg>", svg_text, re.S | re.I)
    if not inner_m or pw < 1 or ph < 1:
        raise ValueError("unreadable vtracer svg")
    inner = inner_m.group(1)
    fills = re.findall(r'fill="(#[0-9A-Fa-f]{3,8})"', inner)
    n_paths = len(re.findall(r"<path\b", inner, re.I))
    pal = []
    seen = set()
    for f in fills:
        u = f.upper()
        if u not in seen:
            seen.add(u)
            pal.append(u)
    w = fmt(width_in, 4)
    h = fmt(height_in, 4)
    out = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}in" height="{h}in" '
        f'viewBox="0 0 {fmt(pw, 2)} {fmt(ph, 2)}">\n'
        f"{inner.strip()}\n"
        "</svg>\n"
    )
    return out, n_paths, pal


def vtracer_settings(maxe: int, kind: str) -> dict:
    """General settings — size-based, not per-artwork."""
    # Keep thin keylines (tooth walls, foam, gothic serifs) at native poster res.
    if maxe < 1600:
        speckle = 4
    else:
        speckle = 6
    return {
        "mode": "spline",
        "hierarchical": "stacked",
        "filter_speckle": str(speckle),
        "color_precision": "6",
        "gradient_step": "12" if kind == "poster" else "14",
        "corner_threshold": "60",
        "path_precision": "2",
    }


def run_vtracer(png_path: str, svg_path: str, settings: dict, timeout: int = 180):
    exe = find_vtracer()
    cmd = [
        exe,
        "--input",
        png_path,
        "--output",
        svg_path,
        "--colormode",
        "color",
        "--mode",
        settings["mode"],
        "--hierarchical",
        settings["hierarchical"],
        "--filter_speckle",
        settings["filter_speckle"],
        "--color_precision",
        settings["color_precision"],
        "--gradient_step",
        settings["gradient_step"],
        "--corner_threshold",
        settings["corner_threshold"],
        "--path_precision",
        settings["path_precision"],
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0 or not os.path.isfile(svg_path):
        raise RuntimeError((r.stderr or r.stdout or "vtracer failed").strip()[:400])
    return r


def vectorize_vtracer(rgb, paper_rgb, inches, kind, t0, h0, w0, rec_err, palette):
    """Color spline trace of a cleaned raster. Paint order preserved."""
    h, w = rgb.shape[:2]
    cap = 1800
    work = rgb
    if max(h, w) > cap:
        s = cap / float(max(h, w))
        work = cv2.resize(
            rgb,
            (int(round(w * s)), int(round(h * s))),
            interpolation=cv2.INTER_AREA,
        )
    wh, ww = work.shape[:2]
    if w0 >= h0:
        width_in = float(inches)
        height_in = float(inches) * (h0 / float(w0))
    else:
        height_in = float(inches)
        width_in = float(inches) * (w0 / float(h0))
    settings = vtracer_settings(max(wh, ww), kind)
    tmp = tempfile.mkdtemp(prefix="vtr-")
    try:
        png_p = os.path.join(tmp, "in.png")
        svg_p = os.path.join(tmp, "out.svg")
        Image.fromarray(work).save(png_p)
        run_vtracer(png_p, svg_p, settings)
        raw = open(svg_p, encoding="utf-8").read()
    finally:
        try:
            for fn in os.listdir(tmp):
                os.remove(os.path.join(tmp, fn))
            os.rmdir(tmp)
        except Exception:
            pass
    svg, n_paths, pal = wrap_vtracer_svg(raw, width_in, height_in)
    meta = {
        "engine": "decoclub-vector",
        "backend": "vtracer",
        "mode": kind,
        "paths": n_paths,
        "colors": len(pal),
        "palette": pal[:24],
        "pixel": [w0, h0],
        "work": [ww, wh],
        "up": 1,
        "inches": [width_in, height_in],
        "ms": int((time.time() - t0) * 1000),
        "paper": to_hex(paper_rgb),
        "overlay": False,
        "rec_err": round(float(rec_err), 2),
        "vtracer": settings,
    }
    return svg, meta


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def vectorize(path: str, inches: float = 10.0, colors=None, mode: str = "auto"):
    t0 = time.time()
    rgb0, alpha0 = load_rgba(path)
    h0, w0 = rgb0.shape[:2]

    # Working resolution: downsample huge posters; keep small logos native
    # (color-preserving upsample happens after the palette is known).
    cap = 1200
    rgb, alpha = rgb0, alpha0
    if max(h0, w0) > cap:
        s = cap / max(h0, w0)
        rgb = cv2.resize(
            rgb0,
            (int(round(w0 * s)), int(round(h0 * s))),
            interpolation=cv2.INTER_AREA,
        )
        alpha = cv2.resize(alpha0, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_NEAREST)
    h, w = rgb.shape[:2]

    paper, paper_rgb = detect_paper(rgb, alpha)
    rgb, paper, paper_rgb = flatten_alpha(rgb, alpha, paper, paper_rgb)
    grad = gradient_mag(rgb)
    rgb = denoise_jpeg(rgb, paper, grad)
    grad = gradient_mag(rgb)

    # Overlay deblend is only for the potrace-poster fallback. Art/poster use
    # vtracer on the flattened raster (Lab overlay plates were mush).
    overlay = None
    rgb_q = rgb
    grad_q = grad
    paper_q = paper

    if colors is None:
        if overlay is not None or max(h0, w0) >= 900:
            max_k, min_k, merge = 20, 12, 9.5
        elif max(h0, w0) < 400:
            max_k, min_k, merge = 5, 2, 16.0
        elif max(h0, w0) < 600:
            max_k, min_k, merge = 10, 4, 13.0
        else:
            max_k, min_k, merge = 14, 5, 12.0
    else:
        max_k = max(2, min(24, int(colors)))
        min_k = max(2, min(max_k, max_k // 3 if max_k > 6 else 2))
        merge = 12.0

    palette = build_palette(rgb_q, paper_q, grad_q, max_k=max_k, min_k=min_k, merge_thresh=merge)
    palette = inject_missing_inks(rgb_q, paper_q, palette, grad_q)
    palette = drop_paper_inks(palette, paper_rgb, thresh=12.0 if lum(paper_rgb) >= 200 else 8.0)
    if not palette:
        palette = [np.array([20.0, 20.0, 20.0])]

    # Quick reconstruction error at native res for classify
    assign_n, _ = assign_pixels(rgb_q, paper_q, palette, paper_rgb, paper_win=0.0)
    rec = np.zeros_like(rgb_q, dtype=np.float32)
    for i, c in enumerate(palette):
        rec[assign_n == i] = c
    rec[paper_q] = paper_rgb
    art = ~paper_q
    rec_err = (
        float(np.abs(rgb_q[art].astype(np.float32) - rec[art]).mean()) if art.any() else 0.0
    )
    kind = classify(rgb_q, paper_q, palette, rec_err, mode, paper_rgb=paper_rgb)

    if kind == "logo":
        # Rebuild with a tight merge so AA doesn't mint three near-black outlines.
        palette = build_palette(
            rgb_q, paper_q, grad_q, max_k=4, min_k=2, merge_thresh=20.0
        )
        palette = inject_missing_inks(rgb_q, paper_q, palette, grad_q)
        palette = drop_paper_inks(
            palette, paper_rgb, thresh=14.0 if lum(paper_rgb) >= 200 else 8.0
        )
        if not palette:
            palette = [np.array([20.0, 20.0, 20.0])]

    # Art / poster: vtracer spline on a flattened, size-capped raster.
    # Logos stay palette-snap + potrace (vtracer invents AA inks on 2-color marks).
    if kind != "logo":
        rgb_full, alpha_full = rgb0, alpha0
        paper_f, paper_rgb_f = detect_paper(rgb_full, alpha_full)
        rgb_full, paper_f, paper_rgb_f = flatten_alpha(
            rgb_full, alpha_full, paper_f, paper_rgb_f
        )
        grad_f = gradient_mag(rgb_full)
        rgb_full = denoise_jpeg(rgb_full, paper_f, grad_f)
        try:
            return vectorize_vtracer(
                rgb_full,
                paper_rgb_f,
                inches,
                kind,
                t0,
                h0,
                w0,
                rec_err,
                palette,
            )
        except Exception:
            # Fall through to potrace plates if vtracer is missing/broken.
            overlay = extract_overlay(rgb_q, paper_q, grad_q) if max(h0, w0) >= 700 else None
            if overlay is not None:
                rgb_q = overlay["rgb_clean"]
                grad_q = gradient_mag(rgb_q)

    # Color-preserving upsample then snap (small logos / art). Posters stay native.
    if kind == "logo" and max(h, w) < 400:
        up_scale = 4
    elif kind == "logo" and max(h, w) < 900:
        up_scale = 2 if max(h, w) >= 700 else 3
    elif kind == "art" and max(h, w) < 700:
        up_scale = 2
    elif kind == "art":
        up_scale = 2
    else:
        up_scale = 1

    if up_scale > 1:
        up = cv2.resize(
            rgb_q, (w * up_scale, h * up_scale), interpolation=cv2.INTER_CUBIC
        )
        paper_up = (
            cv2.resize(
                paper_q.astype(np.uint8),
                (up.shape[1], up.shape[0]),
                interpolation=cv2.INTER_NEAREST,
            )
            > 0
        )
        grad_up = gradient_mag(up)
    else:
        up, paper_up, grad_up = rgb_q, paper_q, grad_q

    paper_win = 1.06 if kind == "logo" and lum(paper_rgb) >= 200 else 0.0
    assign, _ = assign_pixels(up, paper_up, palette, paper_rgb, paper_win=paper_win)
    if kind == "logo" and lum(paper_rgb) >= 200:
        assign = punch_near_paper(assign, palette, paper_rgb, max_dist=10.0)
    elif kind == "art" and 80 < lum(paper_rgb) < 200 and chroma_of_lab(lab_of_rgb([paper_rgb])[0]) < 18:
        # Grey-bg illustrations: mid-grey inks are the paper showing through fur.
        p_lab = lab_of_rgb([paper_rgb])[0]
        for i, c in enumerate(palette):
            la = lab_of_rgb([c])[0]
            if chroma_of_lab(la) > 34:
                continue
            d = la - p_lab
            if math.sqrt(float(np.dot(d, d))) < 38:
                assign[assign == i] = -1
    speckle = max(6 if kind == "logo" else 10, int(0.00012 * assign.size))
    assign = despeckle(assign, palette, min_size=speckle)
    if kind != "logo":
        assign, palette = collapse_aa_inks(assign, palette, grad_up, min_keep=4 if kind == "art" else 8)
    palette = recolor_palette(up, assign, palette, grad=grad_up)
    # Recolor can pull a leftover AA ink toward paper-grey; punch those holes.
    if kind == "art" and 80 < lum(paper_rgb) < 200:
        p_lab = lab_of_rgb([paper_rgb])[0]
        if chroma_of_lab(p_lab) < 18:
            for i, c in enumerate(palette):
                la = lab_of_rgb([c])[0]
                d = math.sqrt(float(np.dot(la - p_lab, la - p_lab)))
                if chroma_of_lab(la) < 28 and d < 50 and 70 < lum(c) < 185:
                    assign[assign == i] = -1

    # Letters / overlay masks need to match working (possibly upsampled) size
    def _resize_mask(m, like):
        if m is None:
            return None
        if m.shape[:2] == like.shape[:2]:
            return m
        return cv2.resize(
            m.astype(np.uint8), (like.shape[1], like.shape[0]), interpolation=cv2.INTER_NEAREST
        )

    glyph, halo, halo_rgb = (
        extract_letters(rgb, paper) if kind == "poster" else (None, None, None)
    )
    if glyph is not None:
        glyph = _resize_mask(glyph.astype(np.uint8), assign) > 0
        halo = _resize_mask(halo.astype(np.uint8), assign) > 0

    ov_mask = ov_key = None
    ov_alpha = ov_rgb = ov_key_rgb = None
    if overlay is not None and kind != "logo":
        ov_mask = _resize_mask(overlay["mask"], assign)
        ov_key = _resize_mask(overlay["key"], assign)
        ov_alpha = overlay["alpha"]
        ov_rgb = overlay["rgb"]
        ov_key_rgb = overlay["key_rgb"]
        # Don't let landscape inks redraw the veil
        if ov_mask is not None:
            assign[ov_mask > 0] = -1
        if ov_key is not None:
            assign[ov_key > 0] = -1
    if glyph is not None and glyph.any():
        assign[glyph] = -1
        if halo is not None:
            assign[halo] = -1

    if w0 >= h0:
        width_in = float(inches)
        height_in = float(inches) * (h0 / float(w0))
    else:
        height_in = float(inches)
        width_in = float(inches) * (w0 / float(h0))
    sx = width_in / assign.shape[1]
    sy = height_in / assign.shape[0]

    def emit(mask, rgb_c, *, alphamax=1.0, opttol=0.2, turdsize=2, smooth=0.55, opacity=None, suffix=""):
        m = (mask > 0).astype(np.uint8)
        if int(m.sum()) < 12:
            return None
        # Corner-preserving for lettering
        paths = potrace_paths(
            m,
            sx,
            sy,
            scale=1,
            alphamax=alphamax,
            opttol=opttol,
            turdsize=turdsize,
            smooth=smooth,
        )
        if not paths:
            return None
        rec = {
            "hex": to_hex(rgb_c),
            "name": layer_name(rgb_c) + suffix,
            "paths": paths,
            "lum": lum(rgb_c),
            "n": int(m.sum()),
        }
        if opacity is not None:
            rec["opacity"] = float(opacity)
        return rec

    layers = []
    # Landscape / logo plates, light → dark so outlines sit on top
    order = list(range(len(palette)))
    order.sort(key=lambda i: (-lum(palette[i]), -int((assign == i).sum())))
    logo_smooth = 0.70 if kind == "logo" else (0.25 if kind == "poster" else 0.40)
    amax = 1.0 if kind != "poster" else 0.90
    for i in order:
        mask = assign == i
        if glyph is not None:
            mask = mask & ~glyph
            if halo is not None:
                mask = mask & ~halo
        rec = emit(
            mask,
            palette[i],
            alphamax=amax,
            opttol=0.18 if kind == "logo" else 0.22,
            turdsize=max(2, speckle // 4),
            smooth=logo_smooth,
        )
        if rec:
            layers.append(rec)

    if ov_mask is not None and int(ov_mask.sum()) > 80:
        rec = emit(
            ov_mask,
            ov_rgb,
            alphamax=0.92,
            opttol=0.16,
            turdsize=2,
            smooth=0.40,
            opacity=ov_alpha,
            suffix=" · overlay",
        )
        if rec:
            layers.append(rec)
    if ov_key is not None and ov_key_rgb is not None and int(ov_key.sum()) > 40:
        rec = emit(
            ov_key,
            ov_key_rgb,
            alphamax=0.70,
            opttol=0.10,
            turdsize=1,
            smooth=0.30,
            suffix=" · keyline",
        )
        if rec:
            layers.append(rec)

    if glyph is not None and glyph.any():
        if halo is not None and halo.any() and halo_rgb is not None:
            rec = emit(
                halo.astype(np.uint8),
                halo_rgb,
                alphamax=0.88,
                opttol=0.12,
                turdsize=1,
                smooth=0.35,
                suffix=" · letter-halo",
            )
            if rec:
                layers.append(rec)
        dark = min(palette, key=lambda c: lum(c)) if palette else np.array([10, 10, 10])
        rec = emit(
            glyph.astype(np.uint8),
            dark,
            alphamax=0.46,
            opttol=0.055,
            turdsize=1,
            smooth=0.22,
            suffix=" · lettering",
        )
        if rec:
            layers.append(rec)

    paper_hex = to_hex(paper_rgb)
    # Dark full-bleed: still paint the underlay so holes aren't transparent.
    svg = svg_from_layers(layers, width_in, height_in, paper_hex)
    n_paths = sum(len(L["paths"]) for L in layers)
    meta = {
        "engine": "decoclub-vector",
        "backend": "potrace",
        "mode": kind,
        "paths": n_paths,
        "colors": len(layers),
        "palette": [to_hex(c) for c in palette],
        "pixel": [w0, h0],
        "work": [w, h],
        "up": up_scale,
        "inches": [width_in, height_in],
        "ms": int((time.time() - t0) * 1000),
        "paper": paper_hex,
        "overlay": bool(overlay is not None),
        "rec_err": round(rec_err, 2),
    }
    return svg, meta


def main():
    ap = argparse.ArgumentParser(description="DecoClub local raster→SVG")
    ap.add_argument("--input", "-i", required=True)
    ap.add_argument("--output", "-o", required=True)
    ap.add_argument("--colors", type=int, default=None)
    ap.add_argument("--inches", type=float, default=10.0)
    ap.add_argument("--mode", default="auto", choices=["auto", "logo", "art", "poster"])
    args = ap.parse_args()
    svg, meta = vectorize(args.input, inches=args.inches, colors=args.colors, mode=args.mode)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(svg)
    sys.stdout.write(json.dumps(meta) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
