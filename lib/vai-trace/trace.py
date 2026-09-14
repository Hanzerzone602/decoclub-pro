#!/usr/bin/env python3
"""
DecoClub Pro local raster→SVG engine.

General pipeline (no per-artwork paste / no filename branches):
  1. Classify logo / art / poster from size, flats, and palette.
  2. Paper flood, true-alpha flatten; junk-JPEG dens score gates stronger
     denoise / upsample / sheet-dirt merge / warm-flat collapse.
  3. Logo: Lab palette snap, color-preserving upsample, evenodd holes, potrace.
     Junk light-sheet mascots: Lanczos upsample + edge-preserve, then an
     even distance-field keyline (no JPEG stairs), muzzle ridges for
     whiskers, and assigned-dark specks folded away. White chests are fills.
  4. Soft-flat AI/illustration (smooth shading, few semantic regions, many
     unique gradient colors): k-means screenprint inks (8–16), snap the
     raster, regularize cells, potrace plates. Raw vtracer invents thousands
     of near-colors on ChatGPT/Grok Imagine art.
  5. Art / poster: vtracer spline on a size-capped flattened raster
     (Lab plates turned busy illustrations into mush). Junk light-sheet
     soft cartoons stay on cleaned potrace flats (vtracer invents near-colors).

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


def _is_keyline_ink(c) -> bool:
    """True-black outline, not a chromatic dark fill (Imagine purple stripes)."""
    if lum(c) >= 42:
        return False
    return chroma_of_lab(lab_of_rgb([c])[0]) < 20


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


def unique_color_bins(rgb, shift=3) -> int:
    q = (rgb.astype(np.int32) >> shift)
    return int(np.unique(q.reshape(-1, 3), axis=0).shape[0])


def junk_raster_score(rgb) -> float:
    """High when a small soft JPEG invents thousands of near-duplicate colors."""
    h, w = rgb.shape[:2]
    n = unique_color_bins(rgb, 3)
    area = max(1, h * w)
    # Density scaled so tony (~2963 @ 240x320) scores ~39; bee PNG ~3.
    return float(n) * 1000.0 / float(area)


def denoise_jpeg(rgb, paper, grad, force: bool = False):
    """Median/bilateral-filter flat interiors so JPEG ringing does not mint extra inks."""
    nuniq = unique_color_bins(rgb, 3)
    score = junk_raster_score(rgb)
    if not force and nuniq < 180 and score < 6.0:
        return rgb
    out = rgb.copy()
    # Stronger cleanup on junk soft rasters; keep edges for line art.
    if score >= 12.0 or force:
        bil = cv2.bilateralFilter(rgb, 9, 80, 80)
        med = cv2.medianBlur(bil, 5)
        flat = (grad < 36) | paper
        out[flat] = med[flat]
        med2 = cv2.medianBlur(out, 3)
        out[flat] = med2[flat]
    else:
        med = cv2.medianBlur(rgb, 3)
        flat = (grad < 22) | paper
        out[flat] = med[flat]
    return out


def punch_sheet_dirt(rgb, paper, paper_rgb, grad=None):
    """Merge near-paper soft greys into the sheet (white chests, not grey fur).

    Only on light sheets AND junk soft-JPEGs. Clean few-color logos (bee) must
    NOT be punched — mild AA punch invented a third navy fringe ink and ate reds.
    Soft tiger on a mid-grey matte is left alone.
    """
    if lum(paper_rgb) < 200:
        return rgb, paper
    score = junk_raster_score(rgb)
    # Clean logos / crisp PNGs: leave raster alone (morning bee path).
    if score < 12.0:
        return rgb, paper
    lab = to_lab(rgb)
    ch = chroma_map(lab)
    luma = luma_map(rgb)
    p_lab = lab_of_rgb([paper_rgb])[0]
    dist = np.sqrt(np.sum((lab - p_lab) ** 2, axis=2))
    # Junk JPEGs: wide gate. Soft chest islands sit ~Lab 50–70 from pure white.
    d_lim = 88.0
    ch_lim = 26.0
    dirt = (~paper) & (ch < ch_lim) & (luma > 135.0) & (dist < d_lim)
    # Very light AA fringe near paper
    dirt |= (~paper) & (ch < 18.0) & (luma > 195.0) & (dist < d_lim + 12.0)
    # Soft warm paper bleed on white chests (peach/pink JPEG shading → paper)
    r = rgb[:, :, 0].astype(np.float32)
    g = rgb[:, :, 1].astype(np.float32)
    b = rgb[:, :, 2].astype(np.float32)
    warm_soft = (
        (~paper)
        & (luma > 175.0)
        & (luma < 250.0)
        & (ch < 28.0)
        & (r > g - 8)
        & (r > b)
        & (dist < 80.0)
    )
    dirt |= warm_soft
    if grad is not None:
        # Flat dirty interiors only — keep chromatic edge AA for outlines.
        dirt &= grad < 42.0
    if not dirt.any():
        return rgb, paper
    out = rgb.copy()
    fill = np.clip(np.round(paper_rgb), 0, 255).astype(np.uint8)
    out[dirt] = fill
    return out, (paper | dirt)


def collapse_logo_fringe(palette, paper_rgb):
    """Fold minority dark AA fringe inks into nearest major logo ink (bee navy)."""
    if not palette or len(palette) <= 2:
        return palette
    labs = [lab_of_rgb([c])[0] for c in palette]
    # Major = high chroma or very dark outline; fringe = darker mid-chroma cousins.
    majors = []
    fringe = []
    for i, c in enumerate(palette):
        ch = chroma_of_lab(labs[i])
        if lum(c) < 42 and ch < 40:
            majors.append(i)  # outline black stays
            continue
        if ch >= 40 or lum(c) > 90:
            majors.append(i)
        else:
            fringe.append(i)
    if not fringe or not majors:
        return palette
    keep = []
    drop = set()
    for j in fringe:
        # Nearest major by Lab
        best = None
        best_d = 1e9
        for i in majors:
            dvec = labs[i] - labs[j]
            d = math.sqrt(float(np.dot(dvec, dvec)))
            if d < best_d:
                best_d = d
                best = i
        # Fold dark purple/navy AA into blue; keep distinct reds.
        if best is not None and best_d < 55:
            dh = abs(hue_of_lab(labs[best]) - hue_of_lab(labs[j]))
            dh = min(dh, 2 * math.pi - dh)
            # Same-ish family or both cool darks
            if dh < 0.55 or (lum(palette[j]) < 70 and lum(palette[best]) < 120):
                drop.add(j)
                continue
        keep.append(j)
    out = [palette[i] for i in range(len(palette)) if i not in drop]
    return out if out else palette


def refine_flat_palette(palette, paper_rgb, *, noisy: bool):
    """Drop sheet-dirt greys, collapse near-blacks, merge near-duplicate same-hue inks."""
    if not palette:
        return palette
    p_lab = lab_of_rgb([paper_rgb])[0]
    kept = []
    for c in palette:
        la = lab_of_rgb([c])[0]
        ch = chroma_of_lab(la)
        d = math.sqrt(float(np.dot(la - p_lab, la - p_lab)))
        # Light low-chroma → paper (never mint JPEG chest greys as inks).
        grey_dist = 55.0 if noisy else 28.0
        if ch < (20.0 if noisy else 14.0) and lum(c) > 130 and d < grey_dist:
            continue
        if ch < 12.0 and lum(c) > 185 and d < grey_dist + 15.0:
            continue
        kept.append(np.asarray(c, dtype=np.float64))
    if not kept:
        kept = [np.asarray(c, dtype=np.float64) for c in palette]

    # Collapse near-black outline inks to a single dark.
    darks = [c for c in kept if lum(c) < 58 and chroma_of_lab(lab_of_rgb([c])[0]) < 36]
    rest = [c for c in kept if not (lum(c) < 58 and chroma_of_lab(lab_of_rgb([c])[0]) < 36)]
    if darks:
        rest.append(
            np.array([0.0, 0.0, 0.0])
            if min(lum(c) for c in darks) < 40
            else min(darks, key=lum)
        )
    kept = rest

    # Merge near-duplicate midtones. Keep red distinct from orange (hue gate).
    merge_dist = 30.0 if noisy else 16.0
    labs = [lab_of_rgb([c])[0] for c in kept]
    used = [False] * len(kept)
    out = []
    order = sorted(range(len(kept)), key=lambda i: -chroma_of_lab(labs[i]))
    for i in order:
        if used[i]:
            continue
        group = [i]
        used[i] = True
        for j in range(len(kept)):
            if used[j]:
                continue
            dvec = labs[i] - labs[j]
            dist = math.sqrt(float(np.dot(dvec, dvec)))
            if dist > merge_dist:
                continue
            if lum(kept[i]) < 60 and lum(kept[j]) < 60:
                group.append(j)
                used[j] = True
                continue
            ca, cb = chroma_of_lab(labs[i]), chroma_of_lab(labs[j])
            if ca > 12 and cb > 12:
                dh = abs(hue_of_lab(labs[i]) - hue_of_lab(labs[j]))
                dh = min(dh, 2 * math.pi - dh)
                # Narrow hue: oranges/peach merge; red bandana (dh~0.3+) stays separate.
                if dh < 0.25 and abs(float(labs[i][0]) - float(labs[j][0])) < 55:
                    group.append(j)
                    used[j] = True
        if lum(kept[group[0]]) < 60:
            pick = min(group, key=lambda k: lum(kept[k]))
        else:
            pick = max(group, key=lambda k: chroma_of_lab(labs[k]))
        out.append(kept[pick])

    if not noisy:
        return out

    # Extra cap only when still bloated: at most 2 per very-tight hue family.
    labs2 = [lab_of_rgb([c])[0] for c in out]
    used = [False] * len(out)
    capped = []
    for i in range(len(out)):
        if used[i]:
            continue
        fam = [i]
        used[i] = True
        for j in range(i + 1, len(out)):
            if used[j]:
                continue
            ca, cb = chroma_of_lab(labs2[i]), chroma_of_lab(labs2[j])
            if ca < 18 or cb < 18:
                continue
            dh = abs(hue_of_lab(labs2[i]) - hue_of_lab(labs2[j]))
            dh = min(dh, 2 * math.pi - dh)
            if dh > 0.20:
                continue
            dvec = labs2[i] - labs2[j]
            if math.sqrt(float(np.dot(dvec, dvec))) > 36:
                continue
            fam.append(j)
            used[j] = True
        if len(fam) <= 2:
            for k in fam:
                capped.append(out[k])
            continue
        fam_sorted = sorted(fam, key=lambda k: lum(out[k]))
        capped.append(out[fam_sorted[0]])
        capped.append(out[fam_sorted[-1]])
    # Final warm-body collapse: JPEG oranges/peach → at most base + shadow.
    warms, colds = [], []
    for c in capped:
        r, g, b = [float(x) for x in c]
        la = lab_of_rgb([c])[0]
        ch = chroma_of_lab(la)
        if ch > 20 and r > 120 and (r - b) > 40 and g > 35 and lum(c) > 55:
            warms.append(c)
        else:
            colds.append(c)
    if len(warms) > 1:
        body = max(
            warms,
            key=lambda c: chroma_of_lab(lab_of_rgb([c])[0]) * (0.55 + 0.45 * (lum(c) / 255.0)),
        )
        warms = [body]
    # Dark red JPEG shadows (mouth/AA) → black; keep at most one bright bandana red.
    reds, other = [], []
    for c in colds:
        r, g, b = [float(x) for x in c]
        la = lab_of_rgb([c])[0]
        ch = chroma_of_lab(la)
        if ch > 15 and r > b + 25 and r > g and lum(c) < 120:
            reds.append(c)
        else:
            other.append(c)
    if reds:
        # Soft JPEG body shadows are dark red-brown; bandana is brighter true red.
        # Keep at most one bandana (lum>=55); fold darker reds into black outline.
        bright = [c for c in reds if lum(c) >= 55]
        if bright:
            bandana = max(
                bright,
                key=lambda c: (
                    chroma_of_lab(lab_of_rgb([c])[0]),
                    lum(c),
                ),
            )
            other.append(bandana)
        other.append(np.array([0.0, 0.0, 0.0]))
    colds = other
    # Dedup near-blacks
    darks = [c for c in colds if lum(c) < 45]
    rest = [c for c in colds if lum(c) >= 45]
    if darks:
        rest.append(np.array([0.0, 0.0, 0.0]))
    capped = rest + warms
    return capped


def snap_to_palette(rgb, paper, palette, paper_rgb, *, paper_win=1.08, despeckle_min=12):
    """Hard-quantize to intentional flats for tracers that otherwise invent JPEG colors."""
    if not palette:
        return rgb
    assign, _ = assign_pixels(rgb, paper, palette, paper_rgb, paper_win=paper_win)
    if lum(paper_rgb) >= 200:
        assign = punch_near_paper(assign, palette, paper_rgb, max_dist=28.0 if junk_raster_score(rgb) >= 12 else 12.0)
        p_lab = lab_of_rgb([paper_rgb])[0]
        for i, c in enumerate(palette):
            la = lab_of_rgb([c])[0]
            if chroma_of_lab(la) < 18 and lum(c) > 130:
                assign[assign == i] = -1
    assign = despeckle(assign, palette, min_size=despeckle_min)
    out = np.full_like(rgb, np.clip(np.round(paper_rgb), 0, 255).astype(np.uint8))
    for i, c in enumerate(palette):
        out[assign == i] = np.clip(np.round(c), 0, 255).astype(np.uint8)
    return out


def mid_gradient_frac(rgb, paper) -> float:
    """Share of figure pixels in the smooth-shading band (not flat, not a hard edge)."""
    art = ~paper
    if not art.any():
        return 0.0
    g = gradient_mag(rgb)[art]
    return float(((g >= 10.0) & (g < 42.0)).mean())


def cell_luma_p50(rgb, paper, cell: int = 8) -> float:
    """Median 8×8 luma std on the figure. Low = smooth AI shading; high = JPEG dirt / busy texture."""
    luma = luma_map(rgb)
    h, w = luma.shape
    vals = []
    for y in range(0, h - cell + 1, cell):
        for x in range(0, w - cell + 1, cell):
            if float(paper[y : y + cell, x : x + cell].mean()) > 0.6:
                continue
            vals.append(float(luma[y : y + cell, x : x + cell].std()))
    return float(np.median(vals)) if vals else 0.0


def is_soft_flat_illustration(rgb, paper, paper_rgb) -> bool:
    """ChatGPT/Grok Imagine (and similar) soft-flat art: smooth shading, few regions, many unique colors.

    Not photos (high local texture), not busy posters, not few-color logos, not junk-JPEG mascots.
    """
    if lum(paper_rgb) < 190:
        return False
    art = ~paper
    if float(art.mean()) < 0.10:
        return False
    nuniq = unique_color_bins(rgb, 3)
    if nuniq < 1000:
        return False
    midg = mid_gradient_frac(rgb, paper)
    if midg < 0.18:
        return False
    p50 = cell_luma_p50(rgb, paper)
    if p50 > 16.0:
        return False
    return True


def _sample_lab_pixels(pix: np.ndarray, n: int = 22000) -> np.ndarray:
    if len(pix) <= n:
        return pix
    step = len(pix) / float(n)
    idx = (np.arange(n) * step).astype(np.int64)
    return pix[idx]


def kmeans_screenprint_palette(rgb, paper, paper_rgb, *, max_k=12):
    """Lab k-means on figure pixels → 8–16 intentional inks (not JPEG near-colors)."""
    lab = to_lab(rgb)
    art = ~paper
    if int(art.sum()) < 80:
        return []
    pix = lab[art].reshape(-1, 3).astype(np.float32)
    pix_s = _sample_lab_pixels(pix, 22000)
    k = int(max(8, min(16, max_k)))
    k = min(k, max(2, len(pix_s) // 40))
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.4)
    _, _, centers = cv2.kmeans(pix_s, k, None, crit, 4, cv2.KMEANS_PP_CENTERS)
    cents = np.clip(centers, 0, 255).astype(np.uint8).reshape(-1, 1, 3)
    pal = cv2.cvtColor(cents, cv2.COLOR_LAB2RGB).reshape(-1, 3).astype(np.float32)
    pal = _merge_near_inks(pal, thresh=16.0)
    pal = _cap_hue_families(pal, rgb, paper, paper_rgb, max_per=2)
    pal = _collapse_screenprint_neutrals(pal, paper_rgb)
    luma = luma_map(rgb)
    dark_frac = float((luma[art] < 42).mean()) if art.any() else 0.0
    if dark_frac > 0.008 and not any(lum(c) < 48 for c in pal):
        pal.append(np.array([0.0, 0.0, 0.0]))
    return pal


def _merge_near_inks(palette, thresh=16.0):
    if len(palette) <= 2:
        return list(palette)
    labs = [lab_of_rgb([c])[0] for c in palette]
    used = [False] * len(palette)
    out = []
    order = sorted(range(len(palette)), key=lambda i: -chroma_of_lab(labs[i]))
    for i in order:
        if used[i]:
            continue
        used[i] = True
        group = [i]
        for j in range(len(palette)):
            if used[j]:
                continue
            dvec = labs[i] - labs[j]
            dist = math.sqrt(float(np.dot(dvec, dvec)))
            if dist > thresh:
                continue
            if chroma_of_lab(labs[i]) > 14 and chroma_of_lab(labs[j]) > 14:
                dh = abs(hue_of_lab(labs[i]) - hue_of_lab(labs[j]))
                dh = min(dh, 2 * math.pi - dh)
                if dh > 0.32:
                    continue
            used[j] = True
            group.append(j)
        if min(lum(palette[g]) for g in group) < 48:
            pick = min(group, key=lambda g: lum(palette[g]))
        else:
            pick = max(group, key=lambda g: chroma_of_lab(labs[g]))
        out.append(np.asarray(palette[pick], dtype=np.float32))
    return out


def _cap_hue_families(palette, rgb, paper, paper_rgb, max_per=2):
    """At most two inks per hue (fill + shadow). Stops shirt/fur camo from extra shades."""
    if len(palette) <= max_per + 3:
        return list(palette)
    labs = [lab_of_rgb([c])[0] for c in palette]
    assign, _ = assign_pixels(rgb, paper, palette, paper_rgb, paper_win=0.0)
    counts = [int((assign == i).sum()) for i in range(len(palette))]
    chroma_i = [i for i, c in enumerate(palette) if chroma_of_lab(labs[i]) >= 16 and lum(c) >= 40]
    rest = [palette[i] for i in range(len(palette)) if i not in chroma_i]
    used = set()
    families = []
    for i in chroma_i:
        if i in used:
            continue
        fam = [i]
        used.add(i)
        for j in chroma_i:
            if j in used:
                continue
            dh = abs(hue_of_lab(labs[i]) - hue_of_lab(labs[j]))
            dh = min(dh, 2 * math.pi - dh)
            if dh > 0.28:
                continue
            used.add(j)
            fam.append(j)
        families.append(fam)
    out = list(rest)
    for fam in families:
        if len(fam) <= max_per:
            out.extend(palette[i] for i in fam)
            continue
        # keep the largest fill and the darkest shadow
        fill = max(fam, key=lambda i: counts[i])
        dark = min(fam, key=lambda i: lum(palette[i]))
        keep = [fill]
        if dark != fill:
            keep.append(dark)
        else:
            # second: next-most-populous
            rest_f = [i for i in fam if i != fill]
            if rest_f:
                keep.append(max(rest_f, key=lambda i: counts[i]))
        out.extend(palette[i] for i in keep[:max_per])
    return out


def _collapse_screenprint_neutrals(palette, paper_rgb):
    """At most one black, one dark grey, one light grey, one near-white. Keep chroma."""
    p_lab = lab_of_rgb([paper_rgb])[0]
    blacks, lgreys, dgreys, whites, chroma = [], [], [], [], []
    for c in palette:
        c = np.asarray(c, dtype=np.float32)
        la = lab_of_rgb([c])[0]
        ch = chroma_of_lab(la)
        L = lum(c)
        d = math.sqrt(float(np.dot(la - p_lab, la - p_lab)))
        if ch < 16 and L > 210 and d < 42:
            whites.append(c)
        elif ch < 18 and L < 42:
            blacks.append(c)
        elif ch < 18 and L > 155:
            lgreys.append(c)
        elif ch < 18:
            dgreys.append(c)
        else:
            chroma.append(c)
    out = list(chroma)
    if blacks:
        out.append(np.array([0.0, 0.0, 0.0], np.float32))
    if dgreys:
        out.append(min(dgreys, key=lum))
    keep_lg = [c for c in lgreys if lum(c) < 200]
    if keep_lg:
        out.append(max(keep_lg, key=lum))
    if whites:
        out.append(max(whites, key=lum))
    return out


def regularize_assign(assign, palette, *, win=5, min_fill=70):
    """Spatial cell fairing: majority labels, absorb tiny islands, keep thin dark keylines."""
    h, w = assign.shape
    k = len(palette)
    if k < 1:
        return assign
    is_dark = np.array([_is_keyline_ink(c) for c in palette], dtype=bool)
    shifted = (assign + 1).clip(0, 255).astype(np.uint8)
    med = cv2.medianBlur(shifted, win if win % 2 == 1 else win + 1)
    out = med.astype(np.int16) - 1
    # Restore dark keylines / whiskers / pupils eaten by the majority window.
    for i, d in enumerate(is_dark):
        if d:
            out[assign == i] = i
    # Absorb tiny non-dark islands into the neighbor majority.
    for i in range(k):
        if is_dark[i]:
            continue
        mask = (out == i).astype(np.uint8)
        if int(mask.sum()) == 0:
            continue
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        for li in range(1, n):
            area = int(stats[li, cv2.CC_STAT_AREA])
            if area >= min_fill:
                continue
            ys, xs = np.where(labels == li)
            votes = np.zeros(k + 1, np.int32)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (2, 0), (-2, 0), (0, 2), (0, -2)):
                nx = np.clip(xs + dx, 0, w - 1)
                ny = np.clip(ys + dy, 0, h - 1)
                v = out[ny, nx]
                votes[0] += int((v < 0).sum())
                ok = v >= 0
                if ok.any():
                    votes[1:] += np.bincount(v[ok].astype(np.int32), minlength=k)
            # Don't vote for ourselves
            votes[i + 1] = 0
            best = int(np.argmax(votes))
            if votes[best] == 0:
                continue
            out[ys, xs] = -1 if best == 0 else (best - 1)
    # Light close on chromatic fills so shirt/paw plates seal.
    dark_m = np.zeros((h, w), np.uint8)
    for i, d in enumerate(is_dark):
        if d:
            dark_m[out == i] = 1
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    for i, c in enumerate(palette):
        if is_dark[i]:
            continue
        m = (out == i).astype(np.uint8)
        if int(m.sum()) < 40:
            continue
        m2 = cv2.morphologyEx(m, cv2.MORPH_CLOSE, ker, iterations=1)
        m2[dark_m > 0] = 0
        out[m2 > 0] = i
    return out


def flatten_soft_interiors(rgb, paper, grad=None):
    """Mean-shift cells so AI gradients collapse to screenprint flats; keep ink edges."""
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    try:
        ms = cv2.pyrMeanShiftFiltering(bgr, 14, 40)
        out = cv2.cvtColor(ms, cv2.COLOR_BGR2RGB)
    except Exception:
        if grad is None:
            grad = gradient_mag(rgb)
        try:
            bil = cv2.bilateralFilter(rgb, 9, 64, 64)
        except Exception:
            bil = cv2.medianBlur(rgb, 5)
        out = rgb.copy()
        out[grad < 40] = bil[grad < 40]
    med = cv2.medianBlur(out, 3)
    g2 = gradient_mag(out)
    out[(g2 < 12) | paper] = med[(g2 < 12) | paper]
    return out


def fill_small_assign_holes(assign, palette, max_hole=120):
    """Fill tiny interior holes (JPEG/AI distress specks) without merging separate pads."""
    out = assign.copy()
    h, w = assign.shape
    for i, c in enumerate(palette):
        if lum(c) < 50:
            continue
        m = (out == i).astype(np.uint8)
        if int(m.sum()) < 24:
            continue
        inv = (1 - m).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
        for li in range(1, n):
            area = int(stats[li, cv2.CC_STAT_AREA])
            if area <= 0 or area > max_hole:
                continue
            ys, xs = np.where(labels == li)
            if (
                (xs == 0).any()
                or (ys == 0).any()
                or (xs == w - 1).any()
                or (ys == h - 1).any()
            ):
                continue
            out[labels == li] = i
    return out


def absorb_internal_shadows(assign, palette):
    """Shadow inks of a hue family that live inside the fill become the fill (paw pads, not stripes)."""
    if len(palette) < 2:
        return assign
    labs = [lab_of_rgb([c])[0] for c in palette]
    out = assign.copy()
    used = set()
    for i in range(len(palette)):
        if i in used:
            continue
        if chroma_of_lab(labs[i]) < 16:
            continue
        fam = [i]
        for j in range(len(palette)):
            if j == i or j in used:
                continue
            if chroma_of_lab(labs[j]) < 16:
                continue
            dh = abs(hue_of_lab(labs[i]) - hue_of_lab(labs[j]))
            dh = min(dh, 2 * math.pi - dh)
            if dh > 0.28:
                continue
            fam.append(j)
        if len(fam) < 2:
            continue
        for x in fam:
            used.add(x)
        fill_i = max(fam, key=lambda k: int((assign == k).sum()))
        h, w = assign.shape
        fill_m = (out == fill_i).astype(np.uint8)
        if int(fill_m.sum()) < 80:
            continue
        dil = cv2.dilate(fill_m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
        fill_n = int(fill_m.sum())
        for sh in fam:
            if sh == fill_i:
                continue
            if lum(palette[sh]) >= lum(palette[fill_i]) - 8:
                continue
            mask = (out == sh).astype(np.uint8)
            n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
            if n <= 1:
                continue
            largest = max(int(stats[li, cv2.CC_STAT_AREA]) for li in range(1, n))
            # No large shadow plate → gradient shading, not a stripe. Fold into fill.
            if largest < 0.12 * fill_n:
                out[out == sh] = fill_i
                continue
            for li in range(1, n):
                area = int(stats[li, cv2.CC_STAT_AREA])
                if area > 0.30 * fill_n:
                    continue
                ys, xs = np.where(labels == li)
                # absorb if the island sits on/next to the fill (paw pad shadows)
                if float(dil[ys, xs].mean()) < 0.28:
                    continue
                out[labels == li] = fill_i
    return out


def punch_border_strips(assign, *, thick_frac=0.03):
    """Drop thin full-width (or full-height) frame bars that ride the sheet edge."""
    h, w = assign.shape
    out = assign.copy()
    th = max(3, int(round(min(h, w) * thick_frac)))
    # top / bottom
    for sl in (slice(0, th), slice(h - th, h)):
        band = out[sl, :]
        if float((band >= 0).mean()) > 0.65 and float((band >= 0).mean()) > 0:
            # only punch if the band is much inkier than the interior next to it
            neigh = slice(th, min(h, th * 4)) if sl.start == 0 else slice(max(0, h - th * 4), h - th)
            if float((out[neigh, :] >= 0).mean()) < 0.35:
                out[sl, :] = -1
    for sl in (slice(0, th), slice(w - th, w)):
        band = out[:, sl]
        if float((band >= 0).mean()) > 0.65:
            neigh = slice(th, min(w, th * 4)) if sl.start == 0 else slice(max(0, w - th * 4), w - th)
            if float((out[:, neigh] >= 0).mean()) < 0.35:
                out[:, sl] = -1
    return out


def region_adjacency(assign, *, connectivity=4):
    """Build undirected adjacency set of ink labels that share an edge (not paper=-1)."""
    h, w = assign.shape
    pairs = set()
    a = assign
    # right neighbors
    left = a[:, :-1]
    right = a[:, 1:]
    mask = (left >= 0) & (right >= 0) & (left != right)
    if mask.any():
        for u, v in zip(left[mask].tolist(), right[mask].tolist()):
            pairs.add((u, v) if u < v else (v, u))
    # down neighbors
    top = a[:-1, :]
    bot = a[1:, :]
    mask = (top >= 0) & (bot >= 0) & (top != bot)
    if mask.any():
        for u, v in zip(top[mask].tolist(), bot[mask].tolist()):
            pairs.add((u, v) if u < v else (v, u))
    if connectivity == 8:
        # diagonals
        for dy, dx in ((1, 1), (1, -1)):
            y0 = slice(0, h - 1) if dy > 0 else slice(1, h)
            y1 = slice(1, h) if dy > 0 else slice(0, h - 1)
            x0 = slice(0, w - 1) if dx > 0 else slice(1, w)
            x1 = slice(1, w) if dx > 0 else slice(0, w - 1)
            A = a[y0, x0]
            B = a[y1, x1]
            mask = (A >= 0) & (B >= 0) & (A != B)
            if mask.any():
                for u, v in zip(A[mask].tolist(), B[mask].tolist()):
                    pairs.add((u, v) if u < v else (v, u))
    return pairs


def enforce_shared_edges(assign, palette, *, iters: int = 3):
    """
    Vector Graph lite — force neighboring fills onto a single crisp shared boundary.

    Independent per-color tracers invent slightly different edges along the same
    raster seam (fringe / double outline). After palette flatten we own the
    label map: majority-vote every boundary pixel among its 4-neighbors
    (darker wins ties) so both sides share one polyline when traced.
    """
    if assign is None or not len(palette):
        return assign
    out = np.asarray(assign, dtype=np.int32).copy()
    h, w = out.shape
    if h < 3 or w < 3:
        return out
    n_ink = len(palette)
    lums = np.array([float(lum(c)) for c in palette], dtype=np.float32)
    # Rank: higher = better winner. majority first, then darker (lower luma).
    # Encode as score = count * 1000 - luma
    for _ in range(max(1, int(iters))):
        pad = np.pad(out, 1, mode="edge")
        c = pad[1:-1, 1:-1]
        nbs = (
            pad[0:-2, 1:-1],
            pad[2:, 1:-1],
            pad[1:-1, 0:-2],
            pad[1:-1, 2:],
        )
        differ = np.zeros((h, w), dtype=bool)
        for nb in nbs:
            differ |= nb != c
        if not differ.any():
            break
        # Vote among center + 4-neighbors for ink labels only.
        # For each label id, count occurrences in the 5-cell window at boundary pixels.
        best_score = np.full((h, w), -1e18, dtype=np.float64)
        best_lab = c.copy()
        stack = [c] + list(nbs)
        # Unique labels that appear — bound work to palette size
        for lab in range(n_ink):
            cnt = np.zeros((h, w), dtype=np.float32)
            for plane in stack:
                cnt += (plane == lab).astype(np.float32)
            # Only consider where this label appears at least once in window
            present = cnt > 0
            if not present.any():
                continue
            score = cnt * 1000.0 - float(lums[lab])
            better = differ & present & (score > best_score)
            best_score[better] = score[better]
            best_lab[better] = lab
        # Paper pixels at ink/paper fringe: if neighborhood ink majority exists, pull into that ink
        # (closes 1px hairlines). Only when >=3 of 5 votes are the same ink.
        paper = c < 0
        fringe = differ & paper
        if fringe.any():
            for lab in range(n_ink):
                cnt = np.zeros((h, w), dtype=np.float32)
                for plane in stack:
                    cnt += (plane == lab).astype(np.float32)
                strong = fringe & (cnt >= 3)
                if strong.any():
                    best_lab[strong] = lab
        changed = int((best_lab != c).sum())
        out = best_lab.astype(np.int32)
        if changed == 0:
            break
    return out


def _exterior_paper_mask(assign):
    """Paper reachable from the image border (true background, not counters)."""
    a = np.asarray(assign, dtype=np.int32)
    h, w = a.shape
    paper = (a < 0).astype(np.uint8)
    if h < 2 or w < 2 or not paper.any():
        return np.zeros((h, w), dtype=bool)
    lab = paper.copy()
    mask = np.zeros((h + 2, w + 2), np.uint8)
    for x in range(w):
        if lab[0, x] == 1:
            cv2.floodFill(lab, mask, (x, 0), 2)
        if lab[h - 1, x] == 1:
            cv2.floodFill(lab, mask, (x, h - 1), 2)
    for y in range(h):
        if lab[y, 0] == 1:
            cv2.floodFill(lab, mask, (0, y), 2)
        if lab[y, w - 1] == 1:
            cv2.floodFill(lab, mask, (w - 1, y), 2)
    return lab == 2


def collapse_aa_rim(assign, palette, *, max_width=1.7):
    """Fold light-ink sandwiches between exterior paper and a darker ink.

    JPEG gold-black silhouettes grow an AA halo of the lighter ink. After
    upsample a 1px original halo is several working pixels, so 4-neighbor
    is not enough. Distance sandwich up to max_width, but only against
    BORDER-connected paper so interior counters (whiskers, eye whites) stay.
    """
    if assign is None or not len(palette):
        return assign
    a = np.asarray(assign, dtype=np.int32).copy()
    h, w = a.shape
    if h < 4 or w < 4:
        return a
    mw = float(max(0.75, max_width))
    lums = np.array([float(lum(c)) for c in palette], dtype=np.float32)
    dark_ids = [j for j in range(len(palette)) if lums[j] < 72]
    if not dark_ids:
        return a
    k = int(max(3, 2 * int(math.ceil(mw)) + 1))
    if k % 2 == 0:
        k += 1
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    # Peel twice: upsample turns a 1px JPEG halo into several working pixels.
    for _pass in range(2):
        ext = _exterior_paper_mask(a)
        if not ext.any():
            break
        dist_paper = cv2.distanceTransform((~ext).astype(np.uint8), cv2.DIST_L2, 3)
        dark_m = np.zeros((h, w), np.uint8)
        for j in dark_ids:
            dark_m[a == j] = 1
        if int(dark_m.sum()) == 0:
            break
        dist_dark = cv2.distanceTransform(1 - dark_m, cv2.DIST_L2, 3)
        nearest_dark = np.full((h, w), -1, np.int32)
        for j in sorted(dark_ids, key=lambda t: -int((a == t).sum())):
            dil = cv2.dilate((a == j).astype(np.uint8), ker)
            nearest_dark[(dil > 0) & (nearest_dark < 0)] = j
        moved = False
        for i in range(len(palette)):
            if lums[i] < 72:
                continue
            if int((a == i).sum()) < 12:
                continue
            darker = [j for j in dark_ids if lums[j] + 28.0 < lums[i]]
            if not darker:
                continue
            rim = (
                (a == i)
                & (dist_paper <= mw)
                & (dist_dark <= mw)
                & np.isin(nearest_dark, np.array(darker, dtype=np.int32))
            )
            if rim.any():
                a[rim] = nearest_dark[rim]
                moved = True
        if not moved:
            break
    return a


def split_dark_necks(assign, palette, *, max_bridge=18):
    """Break short dark bridges between bulky dark blobs (pupil glued to eye ring).

    Long thin strokes (antennae, whiskers) are left alone — only compact
    necks that touch two different bulky components are folded away.
    """
    if assign is None or not len(palette):
        return assign
    a = np.asarray(assign, dtype=np.int32).copy()
    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    for i, c in enumerate(palette):
        if lum(c) >= 50:
            continue
        mask = (a == i).astype(np.uint8)
        if int(mask.sum()) < 40:
            continue
        dist = cv2.distanceTransform(mask, cv2.DIST_L2, 3)
        bulky = ((mask > 0) & (dist > 1.35)).astype(np.uint8)
        thin = (mask > 0) & (dist <= 1.35)
        if int(bulky.sum()) < 20 or not thin.any():
            continue
        n_b, labels_b = cv2.connectedComponents(bulky, connectivity=8)
        if n_b <= 2:
            continue
        n_t, lab_t, stats, _ = cv2.connectedComponentsWithStats(
            thin.astype(np.uint8), connectivity=8
        )
        for t in range(1, n_t):
            area = int(stats[t, cv2.CC_STAT_AREA])
            bw = int(stats[t, cv2.CC_STAT_WIDTH])
            bh = int(stats[t, cv2.CC_STAT_HEIGHT])
            aspect = max(bw, bh) / float(max(1, min(bw, bh)))
            if aspect >= 4.0 or area > max_bridge or area < 2:
                continue
            comp = lab_t == t
            dil = cv2.dilate(comp.astype(np.uint8), k3) > 0
            touch = labels_b[dil & (bulky > 0)]
            touch = touch[touch > 0]
            if touch.size == 0:
                continue
            if np.unique(touch).size < 2:
                continue
            ring = dil & ~comp
            votes = a[ring]
            votes = votes[votes != i]
            if votes.size:
                inks = votes[votes >= 0]
                if inks.size:
                    a[comp] = int(np.bincount(inks.astype(np.int32)).argmax())
                else:
                    a[comp] = -1
            else:
                a[comp] = -1
    return a


def close_large_plates(assign, palette, *, ksize=5, min_area=None):
    """Morph-close large chromatic plates, filling only interior paper holes.

    Imagine-art shading leaves paper speckles inside a shirt/body. Do not
    grow into exterior paper or into another ink.
    """
    if assign is None or not len(palette):
        return assign
    a = np.asarray(assign, dtype=np.int32).copy()
    h, w = a.shape
    min_area = int(min_area if min_area is not None else max(200, 0.002 * h * w))
    k = int(max(3, ksize))
    if k % 2 == 0:
        k += 1
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    ext = _exterior_paper_mask(a)
    for i, c in enumerate(palette):
        if lum(c) < 50:
            continue
        mask = (a == i).astype(np.uint8)
        if int(mask.sum()) < min_area:
            continue
        ncc, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        large = sum(
            1
            for li in range(1, ncc)
            if int(stats[li, cv2.CC_STAT_AREA]) >= max(80, min_area // 4)
        )
        # Several large islands (paw pads) — hole-fill per CC, do not bridge.
        if large >= 3:
            for li in range(1, ncc):
                if int(stats[li, cv2.CC_STAT_AREA]) < 40:
                    continue
                comp = (labels == li).astype(np.uint8)
                filled = _fill_mask_holes(comp)
                hole = (filled > 0) & (comp == 0) & (a < 0) & (~ext)
                if hole.any():
                    a[hole] = i
            continue
        closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, ker)
        fill = (closed > 0) & (mask == 0) & (a < 0) & (~ext)
        if fill.any():
            a[fill] = i
    return a


def tuck_dark_over_light(assign, palette, *, radius=1):
    """Dilate dark plates into lighter inks so AA gold rims sit under the keyline.

    Does not grow into paper (whisker holes stay holes).
    """
    if assign is None or not len(palette) or radius < 1:
        return assign
    a = np.asarray(assign, dtype=np.int32).copy()
    dark_ids = [i for i, c in enumerate(palette) if lum(c) < 55]
    light_ids = [i for i, c in enumerate(palette) if lum(c) >= 80]
    if not dark_ids or not light_ids:
        return a
    light_m = np.zeros(a.shape[:2], np.uint8)
    for i in light_ids:
        light_m[a == i] = 1
    k = 2 * int(radius) + 1
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    # Larger dark plates first so small pupils don't get overwritten wrongly.
    dark_ids.sort(key=lambda i: -int((a == i).sum()))
    for i in dark_ids:
        m = (a == i).astype(np.uint8)
        dil = cv2.dilate(m, ker, iterations=1)
        grow = (dil > 0) & (light_m > 0)
        a[grow] = i
        light_m[grow] = 0
    return a


def merge_small_islands(assign, palette, *, min_size=48, protect_thin_dark=True):
    """Reassign tiny 4-connected blobs to the majority neighbor (Imagine shards)."""
    if assign is None or not len(palette):
        return assign
    a = np.asarray(assign, dtype=np.int32).copy()
    h, w = a.shape
    k = len(palette)
    is_dark = [_is_keyline_ink(c) for c in palette]
    thin_protect = np.zeros((h, w), dtype=bool)
    if protect_thin_dark:
        dark = np.zeros((h, w), np.uint8)
        for i, d in enumerate(is_dark):
            if d:
                dark[a == i] = 1
        if int(dark.sum()) > 0:
            dist = cv2.distanceTransform(dark, cv2.DIST_L2, 3)
            thin_protect = (dark > 0) & (dist <= 3.0)
    ker = np.ones((3, 3), np.uint8)
    for lab in range(k):
        mask = (a == lab).astype(np.uint8)
        if int(mask.sum()) == 0:
            continue
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        for i in range(1, n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area >= min_size:
                continue
            comp = labels == i
            if protect_thin_dark and is_dark[lab] and float(thin_protect[comp].mean()) > 0.4:
                continue
            bw = int(stats[i, cv2.CC_STAT_WIDTH])
            bh = int(stats[i, cv2.CC_STAT_HEIGHT])
            aspect = max(bw, bh) / max(1, min(bw, bh))
            if is_dark[lab] and aspect >= 3.5 and area >= 6:
                continue
            dil = cv2.dilate(comp.astype(np.uint8), ker) > 0
            border = dil & ~comp
            neigh = a[border]
            if neigh.size == 0:
                a[comp] = -1
                continue
            u, cnt = np.unique(neigh, return_counts=True)
            keep = u != lab
            if not np.any(keep):
                a[comp] = -1
                continue
            u, cnt = u[keep], cnt[keep]
            a[comp] = int(u[int(np.argmax(cnt))])
    return a


def seal_inks_into_paper(assign, *, radius: int = 1):
    """Dilate each ink only into paper so neighboring fills meet with no hairline gap.

    Never eats another ink — shared ownership stays with enforce_shared_edges.
    """
    if assign is None or radius < 1:
        return assign
    out = np.asarray(assign, dtype=np.int32).copy()
    paper = out < 0
    if not paper.any():
        return out
    k = 2 * int(radius) + 1
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    labels = [int(x) for x in np.unique(out) if int(x) >= 0]
    # Paint larger regions first so small accents keep their seats.
    labels.sort(key=lambda i: -int((out == i).sum()))
    for lab in labels:
        mask = (out == lab).astype(np.uint8)
        dil = cv2.dilate(mask, kernel, iterations=1)
        grow = (dil > 0) & (out < 0)
        out[grow] = lab
    return out


# ---------------------------------------------------------------------------
# Vector Graph — path-level shared seams (one cubic per crack)
# ---------------------------------------------------------------------------

def _vg_geom():
    try:
        from geom import (
            fit_cubic_open,
            reverse_open_path_d,
            reverse_closed_path_d,
            fit_cubic_path,
            try_circle,
            try_ellipse,
            try_rect,
            try_triangle,
            destaircase,
            clean_ring,
            circularity,
            ring_area,
            prepare_contour,
            path_from_ring,
            fair_open_polyline,
        )
    except Exception:
        from lib.geom import (
            fit_cubic_open,
            reverse_open_path_d,
            reverse_closed_path_d,
            fit_cubic_path,
            try_circle,
            try_ellipse,
            try_rect,
            try_triangle,
            destaircase,
            clean_ring,
            circularity,
            ring_area,
            prepare_contour,
            path_from_ring,
            fair_open_polyline,
        )
    return {
        "fit_cubic_open": fit_cubic_open,
        "reverse_open_path_d": reverse_open_path_d,
        "reverse_closed_path_d": reverse_closed_path_d,
        "fit_cubic_path": fit_cubic_path,
        "try_circle": try_circle,
        "try_ellipse": try_ellipse,
        "try_rect": try_rect,
        "try_triangle": try_triangle,
        "destaircase": destaircase,
        "clean_ring": clean_ring,
        "circularity": circularity,
        "ring_area": ring_area,
        "prepare_contour": prepare_contour,
        "path_from_ring": path_from_ring,
        "fair_open_polyline": fair_open_polyline,
    }


def _vg_unit_edges(assign):
    """Oriented unit crack edges on the pixel-corner grid (x right, y down)."""
    a = np.asarray(assign, dtype=np.int32)
    h, w = a.shape
    edges = []  # (x0,y0,x1,y1,left,right)
    # Vertical cracks between left/right pixels
    if w >= 2:
        left = a[:, :-1]
        right = a[:, 1:]
        mask = left != right
        ys, xs = np.where(mask)
        for r, c in zip(ys.tolist(), xs.tolist()):
            la = int(left[r, c])
            lb = int(right[r, c])
            # edge x=c+1 from y=r → y=r+1; walking down, left=+x = east = lb
            edges.append((c + 1, r, c + 1, r + 1, lb, la))
    # Horizontal cracks between up/down pixels
    if h >= 2:
        top = a[:-1, :]
        bot = a[1:, :]
        mask = top != bot
        ys, xs = np.where(mask)
        for r, c in zip(ys.tolist(), xs.tolist()):
            la = int(top[r, c])
            lb = int(bot[r, c])
            # edge y=r+1 from x=c → x=c+1; walking right, left=+y = south = lb
            edges.append((c, r + 1, c + 1, r + 1, lb, la))
    return edges



def _crack_sides_from_pts(assign, pts):
    """Re-derive left/right labels for pts[0]→pts[1] using the label map."""
    a = np.asarray(assign, dtype=np.int32)
    h, w = a.shape
    if len(pts) < 2:
        return -1, -1
    x0, y0 = pts[0]
    x1, y1 = pts[1]
    mx = 0.5 * (x0 + x1)
    my = 0.5 * (y0 + y1)
    tx, ty = x1 - x0, y1 - y0
    L = math.hypot(tx, ty) or 1.0
    # Interior-on-left in y-down (x right, y down): (tx, ty) → (ty, -tx).
    # Walking +x, left is -y (up the screen).
    nx, ny = ty / L, -tx / L
    def sample(px, py):
        ix = int(max(0, min(w - 1, math.floor(px))))
        iy = int(max(0, min(h - 1, math.floor(py))))
        return int(a[iy, ix])
    left = sample(mx + nx * 0.45, my + ny * 0.45)
    right = sample(mx - nx * 0.45, my - ny * 0.45)
    return left, right

def label_cracks(assign, *, min_len: int = 2):
    """
    Crack-follow the label map into open polylines split at T-junctions.

    Each crack: {a, b, pts, left, right} where walking pts keeps `left` on the
    left (image y-down). a/b are the two labels (may include paper=-1).
    Neighboring fills reuse the same pts (reversed) — path-level shared seam.
    """
    edges = _vg_unit_edges(assign)
    if not edges:
        return []
    # Undirected adjacency at integer corners: key -> list of outgoing oriented edges
    # Store oriented: from key along (dx,dy) with (left,right)
    from collections import defaultdict

    adj = defaultdict(list)  # (x,y) -> [(nx,ny,left,right)]
    for x0, y0, x1, y1, left, right in edges:
        adj[(x0, y0)].append((x1, y1, left, right))
        # reverse orientation swaps left/right
        adj[(x1, y1)].append((x0, y0, right, left))

    # Degree of undirected graph
    und = defaultdict(set)
    for x0, y0, x1, y1, left, right in edges:
        und[(x0, y0)].add((x1, y1))
        und[(x1, y1)].add((x0, y0))
    degree = {k: len(v) for k, v in und.items()}

    visited = set()  # frozenset of undirected unit edge

    def uedge(p, q):
        return (p, q) if p <= q else (q, p)

    def is_junction(p):
        return degree.get(p, 0) != 2

    cracks = []
    # Start walks from junctions and degree-1 ends; also cover pure loops
    starts = [p for p, d in degree.items() if d != 2]
    # Pure loops: pick any unused edge endpoint
    for p0, outs in list(adj.items()):
        for nx, ny, left, right in outs:
            e = uedge(p0, (nx, ny))
            if e in visited:
                continue
            # Prefer starting at junction
            start = p0
            if not is_junction(p0) and not is_junction((nx, ny)):
                # Will be picked up as loop later unless we start here
                if starts:
                    continue
            # Walk forward
            pts = [start]
            cur = start
            prev = None
            cur_left = None
            cur_right = None
            # Choose first unused outgoing
            chosen = None
            for nx, ny, L, R in adj[cur]:
                if prev is not None and (nx, ny) == prev:
                    continue
                if uedge(cur, (nx, ny)) in visited:
                    continue
                chosen = (nx, ny, L, R)
                break
            if chosen is None:
                continue
            nx, ny, L, R = chosen
            visited.add(uedge(cur, (nx, ny)))
            cur_left, cur_right = L, R
            prev, cur = cur, (nx, ny)
            pts.append(cur)
            guard = 0
            while guard < 200000:
                guard += 1
                if is_junction(cur) and len(pts) > 1:
                    break
                # Continue unique unused forward with same left/right labels
                nxts = []
                for qx, qy, qL, qR in adj[cur]:
                    if prev is not None and (qx, qy) == prev:
                        continue
                    if uedge(cur, (qx, qy)) in visited:
                        continue
                    # Keep seam identity: same unordered label pair
                    if {qL, qR} != {cur_left, cur_right}:
                        continue
                    # Prefer matching orientation (same left)
                    nxts.append((qx, qy, qL, qR, 0 if qL == cur_left else 1))
                if not nxts:
                    break
                nxts.sort(key=lambda t: t[4])
                qx, qy, qL, qR, _ = nxts[0]
                # If orientation flipped, swap bookkeeping
                if qL != cur_left:
                    # walking reverse of original edge orientation
                    cur_left, cur_right = qL, qR
                visited.add(uedge(cur, (qx, qy)))
                prev, cur = cur, (qx, qy)
                pts.append(cur)
                if is_junction(cur):
                    break
                # Closed pure loop
                if cur == start and len(pts) > 3:
                    break
            if len(pts) < min_len:
                continue
            fpts = [(float(x), float(y)) for x, y in pts]
            Llab, Rlab = _crack_sides_from_pts(assign, fpts)
            cracks.append(
                {
                    "a": Llab,
                    "b": Rlab,
                    "left": Llab,
                    "right": Rlab,
                    "pts": fpts,
                }
            )

    # Sweep remaining unused edges (closed loops with all degree-2)
    for p0, outs in list(adj.items()):
        for nx, ny, L, R in outs:
            e0 = uedge(p0, (nx, ny))
            if e0 in visited:
                continue
            start = p0
            pts = [start]
            visited.add(e0)
            prev, cur = start, (nx, ny)
            cur_left, cur_right = L, R
            pts.append(cur)
            guard = 0
            while guard < 200000:
                guard += 1
                nxts = []
                for qx, qy, qL, qR in adj[cur]:
                    if (qx, qy) == prev:
                        continue
                    if uedge(cur, (qx, qy)) in visited:
                        continue
                    if {qL, qR} != {cur_left, cur_right}:
                        continue
                    nxts.append((qx, qy, qL, qR, 0 if qL == cur_left else 1))
                if not nxts:
                    break
                nxts.sort(key=lambda t: t[4])
                qx, qy, qL, qR, _ = nxts[0]
                if qL != cur_left:
                    cur_left, cur_right = qL, qR
                visited.add(uedge(cur, (qx, qy)))
                prev, cur = cur, (qx, qy)
                pts.append(cur)
                if cur == start:
                    break
            if len(pts) >= max(min_len, 4):
                fpts = [(float(x), float(y)) for x, y in pts]
                Llab, Rlab = _crack_sides_from_pts(assign, fpts)
                cracks.append(
                    {
                        "a": Llab,
                        "b": Rlab,
                        "left": Llab,
                        "right": Rlab,
                        "pts": fpts,
                    }
                )
    return cracks


def subpixel_snap_crack(pts, rgb, pal, ink_a, ink_b, *, max_shift: float = 0.65):
    """Push crack vertices to coverage≈0.5 between ink_a and ink_b in original RGB."""
    if rgb is None or pts is None or len(pts) < 2:
        return pts
    h, w = rgb.shape[:2]
    labs = to_lab(rgb)
    out = []
    # Palette labs; paper=-1 uses local mean of near-paper if needed
    def lab_of(idx):
        if idx is None or idx < 0:
            return None
        if idx >= len(pal):
            return None
        return lab_of_rgb([pal[idx]])[0]

    la = lab_of(ink_a)
    lb = lab_of(ink_b)
    for i, (x, y) in enumerate(pts):
        # Tangent from neighbors
        if i == 0:
            tx, ty = pts[1][0] - x, pts[1][1] - y
        elif i == len(pts) - 1:
            tx, ty = x - pts[i - 1][0], y - pts[i - 1][1]
        else:
            tx = pts[i + 1][0] - pts[i - 1][0]
            ty = pts[i + 1][1] - pts[i - 1][1]
        L = math.hypot(tx, ty) or 1.0
        # Normal (left of tangent in y-down = rotate tangent by +90° in y-down?
        # rotate (tx,ty) → (-ty, tx) is CCW in y-down? In math y-up CCW is (-ty,tx).
        # Use (-ty, tx) consistently.
        nx, ny = (-ty / L), (tx / L)
        best_t = 0.0
        best_score = 1e18
        # If both inks known, find 0.5 membership crossing
        if la is not None and lb is not None:
            for k in range(-4, 5):
                t = (k / 4.0) * max_shift
                px = x + nx * t
                py = y + ny * t
                ix = int(max(0, min(w - 1, round(px - 0.5))))
                iy = int(max(0, min(h - 1, round(py - 0.5))))
                pl = labs[iy, ix]
                da = float(np.sum((pl - la) ** 2))
                db = float(np.sum((pl - lb) ** 2))
                # Softmax membership to a: want ≈0.5 → da≈db
                score = abs(da - db)
                if score < best_score:
                    best_score = score
                    best_t = t
        else:
            # Ink vs paper: place near stronger gradient / mid coverage
            for k in range(-4, 5):
                t = (k / 4.0) * max_shift
                px = x + nx * t
                py = y + ny * t
                ix = int(max(0, min(w - 1, round(px - 0.5))))
                iy = int(max(0, min(h - 1, round(py - 0.5))))
                # Prefer positions closer to the ink side slightly inside ink
                if ink_a >= 0 and la is not None:
                    pl = labs[iy, ix]
                    score = float(np.sum((pl - la) ** 2))
                elif ink_b >= 0 and lb is not None:
                    pl = labs[iy, ix]
                    score = float(np.sum((pl - lb) ** 2))
                else:
                    score = 0.0
                if score < best_score:
                    best_score = score
                    best_t = t * 0.35
        out.append((x + nx * best_t, y + ny * best_t))
    return out


def _crack_mean_grad(pts, grad):
    if grad is None or pts is None or len(pts) < 2:
        return 40.0
    h, w = grad.shape[:2]
    acc = 0.0
    n = 0
    for x, y in pts:
        ix = int(max(0, min(w - 1, int(round(x - 0.5)))))
        iy = int(max(0, min(h - 1, int(round(y - 0.5)))))
        acc += float(grad[iy, ix])
        n += 1
    return acc / max(1, n)


def _strip_z(d: str) -> str:
    s = (d or "").strip()
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1].strip()
    return s


def _ensure_crack_fit(c, sx, sy, *, logo=False, grad=None, try_primitives=True):
    """Fit each crack exactly once. Neighbors reuse d_fwd / d_rev (single-owner Béziers)."""
    if c.get("d_fwd"):
        return
    G = _vg_geom()
    pts = list(c.get("pts") or [])
    if len(pts) < 2:
        c["d_fwd"] = ""
        c["d_rev"] = ""
        c["closed_d"] = False
        return
    closed = len(pts) >= 4 and _qkey_pt(pts[0]) == _qkey_pt(pts[-1])
    work = G["fair_open_polyline"](pts, closed=closed, logo=logo)
    if len(work) < 2:
        work = pts
    # ~1px Schneider error: tight enough to hold the edge, loose enough that
    # leftover 0.5px raster stairs get absorbed into one cubic, not split.
    err = 1.15 if logo else 1.35
    ccos = 0.42 if logo else 0.28
    gm = _crack_mean_grad(work, grad)
    if gm < 12:
        err *= 1.75
    elif gm < 20:
        err *= 1.30
    if closed:
        ring = G["clean_ring"](work, 0.2)
        prim = None
        if try_primitives and len(ring) >= 8:
            area = abs(G["ring_area"](ring))
            peri = 0.0
            for i in range(len(ring)):
                j = (i + 1) % len(ring)
                peri += math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1])
            thin = peri > 1e-6 and (4.0 * area / (peri + 1e-6)) < 2.8
            if not thin and area >= 36:
                both_ink = c["left"] >= 0 and c["right"] >= 0
                # Circles are safe at any size (bee head/wings/eyes). Bars and
                # triangles on ink-ink punch bounding-boxes out of curved bodies.
                prim = G["try_circle"](ring, sx, sy, min_r=4.0)
                if not prim:
                    circ = G["circularity"](ring)
                    if both_ink:
                        if circ >= 0.84:
                            prim = G["try_ellipse"](ring, sx, sy)
                    else:
                        prim = (
                            G["try_ellipse"](ring, sx, sy)
                            or G["try_rect"](ring, sx, sy)
                            or (G["try_triangle"](ring, sx, sy) if logo else None)
                        )
        if prim:
            c["d_fwd"] = prim if prim.rstrip().endswith(("Z", "z")) else prim + " Z"
            c["d_rev"] = G["reverse_closed_path_d"](c["d_fwd"])
            c["closed_d"] = True
            c["primitive"] = True
            return
        d = G["fit_cubic_path"](ring, sx, sy, error=err, corner_cos=ccos)
        if not d:
            d = G["fit_cubic_open"](work, sx, sy, error=err, corner_cos=ccos)
        if d and not d.rstrip().endswith(("Z", "z")):
            d = d + " Z"
        c["d_fwd"] = d or ""
        c["d_rev"] = G["reverse_closed_path_d"](c["d_fwd"]) if c["d_fwd"] else ""
        c["closed_d"] = True
        c["primitive"] = False
        return
    c["d_fwd"] = G["fit_cubic_open"](work, sx, sy, error=err, corner_cos=ccos)
    c["d_rev"] = G["reverse_open_path_d"](c["d_fwd"]) if c["d_fwd"] else ""
    c["closed_d"] = False
    c["primitive"] = False


def _fit_crack_fragment(pts, sx, sy, *, logo=False):
    """Back-compat wrapper: open-crack Schneider fit."""
    c = {"pts": list(pts)}
    _ensure_crack_fit(c, sx, sy, logo=logo, try_primitives=False)
    return _strip_z(c.get("d_fwd") or "")


def _ring_points_from_cracks(chain, cracks):
    """chain: list of (crack_idx, forward:bool) → closed point ring."""
    pts = []
    for ci, fwd in chain:
        cpts = cracks[ci]["pts"]
        seq = cpts if fwd else list(reversed(cpts))
        if not pts:
            pts.extend(seq)
        else:
            # skip duplicate joint
            pts.extend(seq[1:])
    return pts


def _qkey_pt(p, q=100.0):
    return (int(round(float(p[0]) * q)), int(round(float(p[1]) * q)))


def _walk_faces(cracks):
    """Planar-map face walk: one cycle per face, interior on the left (y-down).

    At each vertex, outgoing half-edges are sorted by atan2 (y-down, so
    increasing angle is clockwise on screen). The next *counter-clockwise*
    turn is the previous entry in that list — that keeps ink on the left.
    Each face is a list of (crack_idx, forward).
    """
    from collections import defaultdict

    adj = defaultdict(list)  # vertex -> [{ang, ci, fwd, dest}]
    loop_faces = []
    for i, c in enumerate(cracks):
        pts = c["pts"]
        if len(pts) < 2:
            continue
        a, b = pts[0], pts[-1]
        ka, kb = _qkey_pt(a), _qkey_pt(b)
        # Closed crack (no T-junction): the loop is already a face.
        if ka == kb and len(pts) >= 4:
            loop_faces.append([(i, True)])
            loop_faces.append([(i, False)])
            continue
        # Angle of the outgoing *first step*, not the endpoint chord.
        # U-shaped cracks share T-junction endpoints with the shared seam;
        # using the chord makes every outgoing look identical.
        s1 = pts[1]
        e1 = pts[-2]
        ang_f = math.atan2(s1[1] - a[1], s1[0] - a[0])
        ang_r = math.atan2(e1[1] - b[1], e1[0] - b[0])
        adj[ka].append({"ang": ang_f, "ci": i, "fwd": True, "dest": kb})
        adj[kb].append({"ang": ang_r, "ci": i, "fwd": False, "dest": ka})
    for k in adj:
        adj[k].sort(key=lambda t: t["ang"])

    used = set()
    faces = []
    for k, outs in adj.items():
        for out in outs:
            start_sig = (out["ci"], out["fwd"])
            if start_sig in used:
                continue
            chain = []
            cur = out
            closed = False
            guard = 0
            while guard < 200000:
                guard += 1
                sig = (cur["ci"], cur["fwd"])
                if sig in used:
                    break
                used.add(sig)
                chain.append((cur["ci"], cur["fwd"]))
                dest = cur["dest"]
                dest_outs = adj.get(dest) or []
                rev_idx = None
                rev_fwd = not cur["fwd"]
                rev_ci = cur["ci"]
                for j, t in enumerate(dest_outs):
                    if t["ci"] == rev_ci and t["fwd"] == rev_fwd:
                        rev_idx = j
                        break
                if rev_idx is None or not dest_outs:
                    break
                # Next in atan2-sorted order. atan2(y-down) increases clockwise
                # on screen; taking +1 from the reverse half-edge walks the
                # face with interior on the left (CCW on screen).
                nxt = dest_outs[(rev_idx + 1) % len(dest_outs)]
                if (nxt["ci"], nxt["fwd"]) == start_sig:
                    closed = True
                    break
                cur = nxt
            if closed and len(chain) >= 1:
                faces.append(chain)
    return loop_faces + faces


def _assemble_ink_chains(cracks, ink):
    """Closed cycles whose interior label is `ink` (paper = -1 allowed)."""
    faces = _walk_faces(cracks)
    out = []
    for chain in faces:
        ci, fwd = chain[0]
        c = cracks[ci]
        lab = c["left"] if fwd else c["right"]
        if lab == ink:
            out.append(chain)
    return out


def _face_poly(chain, cracks):
    """Shapely polygon for a closed crack chain, or None."""
    try:
        from shapely.geometry import Polygon
    except Exception:
        return None
    ring = _ring_points_from_cracks(chain, cracks)
    if len(ring) < 4:
        return None
    if ring[0] != ring[-1]:
        ring = list(ring) + [ring[0]]
    try:
        poly = Polygon(ring)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty or poly.area < 4.0:
            return None
        return poly
    except Exception:
        return None


def _poly_ink_fraction(poly, assign, ink, n=10):
    """Fraction of interior sample points whose label is `ink`.

    Wrapping hulls (a shirt cycle that walked the outer silhouette) sample
    mostly gold/paper and must not be emitted as a fill over the figure.
    """
    try:
        minx, miny, maxx, maxy = poly.bounds
    except Exception:
        return 1.0
    if maxx - minx < 1.5 or maxy - miny < 1.5:
        return 1.0
    from shapely.geometry import Point

    a = np.asarray(assign, dtype=np.int32)
    h, w = a.shape
    xs = np.linspace(minx + 0.4, maxx - 0.4, int(n))
    ys = np.linspace(miny + 0.4, maxy - 0.4, int(n))
    hit = tot = 0
    for y in ys:
        for x in xs:
            try:
                if not poly.contains(Point(float(x), float(y))):
                    continue
            except Exception:
                continue
            tot += 1
            ix = int(min(w - 1, max(0, math.floor(x))))
            iy = int(min(h - 1, max(0, math.floor(y))))
            if int(a[iy, ix]) == int(ink):
                hit += 1
    if tot < 5:
        return 1.0
    return hit / float(tot)


def _poly_ink(poly, assign):
    """Label under a polygon's representative point (corner-grid → pixel)."""
    a = np.asarray(assign, dtype=np.int32)
    h, w = a.shape
    try:
        pt = poly.representative_point()
        ix = int(max(0, min(w - 1, math.floor(pt.x))))
        iy = int(max(0, min(h - 1, math.floor(pt.y))))
        return int(a[iy, ix])
    except Exception:
        return -1


def _chain_left_ink(chain, cracks):
    """Interior ink from walk orientation (left side). Mixed → None."""
    labs = []
    for ci, fwd in chain:
        c = cracks[ci]
        labs.append(c["left"] if fwd else c["right"])
    if not labs:
        return None
    # Require a dominant label so the outer combined cycle (paper-on-left
    # around two inks) cannot be emitted as a fill.
    from collections import Counter
    cnt = Counter(labs)
    lab, n = cnt.most_common(1)[0]
    if n < max(1, int(0.8 * len(labs))):
        return None
    return int(lab)


def _path_d_from_shared_chain(
    chain, cracks, sx, sy, *, logo=False, try_primitives=True, grad=None
):
    """Build closed path d by concatenating per-crack fitted fragments (shared).

    Never independently refits a loop: ink-ink cubics stay single-owner.
    Primitive swap is allowed only on paper-bounded chains (no neighbor fill)
    or on a closed crack whose reverse is reused by the other face.
    """
    G = _vg_geom()
    for ci, _fwd in chain:
        _ensure_crack_fit(
            cracks[ci], sx, sy, logo=logo, grad=grad, try_primitives=try_primitives
        )
    if len(chain) == 1:
        c = cracks[chain[0][0]]
        if c.get("closed_d") and c.get("d_fwd"):
            return c["d_fwd"] if chain[0][1] else c["d_rev"]
    parts = []
    start_m = None
    for ci, fwd in chain:
        c = cracks[ci]
        frag = c.get("d_fwd") if fwd else c.get("d_rev")
        if not frag:
            continue
        frag = _strip_z(frag)
        if start_m is None:
            parts.append(frag)
            start_m = True
        else:
            m = re.match(
                r"M\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s+([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(.*)$",
                frag.strip(),
            )
            if m:
                rest = m.group(3).strip()
                if rest:
                    parts.append(rest)
            else:
                parts.append(frag)
    if not parts:
        return None
    d = " ".join(parts)
    if not d.rstrip().endswith("Z") and not d.rstrip().endswith("z"):
        d = d + " Z"

    # Primitive swap only when every crack is ink-vs-paper (no neighbor to desync).
    if try_primitives:
        vs_paper = True
        for ci, _ in chain:
            c = cracks[ci]
            if c["left"] >= 0 and c["right"] >= 0:
                vs_paper = False
                break
        if vs_paper:
            ring = G["clean_ring"](_ring_points_from_cracks(chain, cracks), 0.2)
            if len(ring) >= 8:
                area = abs(G["ring_area"](ring))
                peri = 0.0
                for i in range(len(ring)):
                    j = (i + 1) % len(ring)
                    peri += math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1])
                thin = peri > 1e-6 and (4.0 * area / (peri + 1e-6)) < 2.8
                if not thin and area >= 40:
                    prim = (
                        G["try_circle"](ring, sx, sy, min_r=4.5)
                        or G["try_ellipse"](ring, sx, sy)
                        or G["try_rect"](ring, sx, sy)
                        or (G["try_triangle"](ring, sx, sy) if logo else None)
                    )
                    if prim:
                        return prim
    return d


def vector_graph_layers(
    assign,
    palette,
    sx,
    sy,
    *,
    rgb=None,
    logo=False,
    try_primitives=True,
    min_area_px=12,
    gap_fill=True,
):
    """
    Path-level Vector Graph: one Schneider fit per shared crack, loops reuse it.

    Faces are walked with interior-on-left. Paper cycles contained in an ink
    become evenodd holes (eyes, counters). Neighboring inks stay stacked so
    a darker plate tucks over a lighter one along the same cubic.
    Returns (layers, aux) where aux has crack counts / gap-filler strokes.
    """
    a = np.asarray(assign, dtype=np.int32)
    cracks = label_cracks(a, min_len=2)
    if not cracks:
        return [], {"cracks": 0, "vector_graph": "empty"}

    # Destaircase on the integer pixel-corner grid BEFORE sub-pixel snap.
    # Snap knocks vertices off-axis and used to freeze 1px stairs into cubics.
    Gpre = _vg_geom()
    destaired = []
    for c in cracks:
        pts = list(c.get("pts") or [])
        closed0 = len(pts) >= 4 and _qkey_pt(pts[0]) == _qkey_pt(pts[-1])
        if len(pts) >= 4:
            pts = Gpre["destaircase"](pts, max_leg=6.0, closed=closed0)
            if closed0:
                if len(pts) >= 3 and _qkey_pt(pts[0]) != _qkey_pt(pts[-1]):
                    pts = list(pts) + [pts[0]]
            elif len(pts) >= 2:
                pts[0] = c["pts"][0]
                pts[-1] = c["pts"][-1]
        c = dict(c)
        c["pts"] = pts
        destaired.append(c)
    cracks = destaired

    # Sub-pixel snap using original RGB when available
    if rgb is not None:
        snapped = []
        for c in cracks:
            pts = subpixel_snap_crack(
                c["pts"], rgb, palette, c["left"], c["right"], max_shift=0.65
            )
            # Keep endpoints pinned to junctions (less T-junction drift)
            if len(pts) >= 2:
                pts[0] = c["pts"][0]
                pts[-1] = c["pts"][-1]
            # Closed loops must stay closed after snap.
            if len(c["pts"]) >= 4 and _qkey_pt(c["pts"][0]) == _qkey_pt(c["pts"][-1]):
                if _qkey_pt(pts[0]) != _qkey_pt(pts[-1]):
                    pts[-1] = pts[0]
            c = dict(c)
            c["pts"] = pts
            snapped.append(c)
        cracks = snapped

    grad = None
    if rgb is not None:
        try:
            grad = gradient_mag(rgb)
        except Exception:
            grad = None

    faces = _walk_faces(cracks)
    ink_faces = {i: [] for i in range(len(palette))}  # list of (chain, poly)
    for chain in faces:
        poly = _face_poly(chain, cracks)
        if poly is None:
            continue
        ink = _chain_left_ink(chain, cracks)
        if ink is None:
            ink = _poly_ink(poly, a)
        if ink is None or ink < 0 or ink >= len(palette):
            continue
        ink_faces[ink].append((chain, poly))

    layers = []
    gap_strokes = []
    order = list(range(len(palette)))
    order.sort(key=lambda i: (-lum(palette[i]), -int((a == i).sum())))

    n_loops = 0
    graph_area = 0.0
    n_prim = 0
    for ink in order:
        area = int((a == ink).sum())
        if area < min_area_px:
            continue
        recs = ink_faces.get(ink) or []
        if not recs:
            continue
        ds = []
        acc = None
        for chain, poly in recs:
            if poly.area < max(8.0, min_area_px * 0.5):
                continue
            # Light-ink AA ribbons around a dark keyline (puma gold halo).
            # Keep thin DARK (whiskers). 4*area/peri ≈ twice the width.
            try:
                peri = float(poly.length)
                width = 4.0 * float(poly.area) / (peri + 1e-6)
            except Exception:
                width = 99.0
            if lum(palette[ink]) >= 55 and width < 2.6 and float(poly.area) < 0.015 * a.size:
                continue
            if not logo:
                ink_px = float(int((a == ink).sum()) or 1)
                if float(poly.area) > 1.85 * ink_px:
                    continue
                if _poly_ink_fraction(poly, a, ink) < 0.55:
                    continue
            d = _path_d_from_shared_chain(
                chain,
                cracks,
                sx,
                sy,
                logo=logo,
                try_primitives=try_primitives,
                grad=grad,
            )
            if not d or "M" not in d:
                continue
            ds.append(d)
            n_loops += 1
            try:
                acc = poly if acc is None else acc.symmetric_difference(poly)
            except Exception:
                acc = poly if acc is None else acc
        if not ds and logo:
            continue
        if acc is not None:
            graph_area += float(acc.area)
        this_cov = float(acc.area) / max(1.0, float(area)) if acc is not None else 0.0
        # Logos: one evenodd compound so eyes/whisker holes punch.
        # Soft-flat Imagine: emit faces separately. A wrapping cycle in a
        # joined evenodd d punches the whole gold/purple plate to paper.
        # If the walk missed a chunk (legs/tail), potrace that ink's mask.
        if logo:
            if not ds:
                continue
            paths = [" ".join(ds)]
        elif ds and this_cov >= 0.85:
            paths = list(ds)
        else:
            mask = (a == ink).astype(np.uint8)
            is_dark = lum(palette[ink]) < 50
            ptr = potrace_paths(
                mask,
                sx,
                sy,
                scale=1,
                alphamax=1.2 if is_dark else 1.0,
                opttol=0.14 if is_dark else 0.20,
                turdsize=1 if is_dark else 3,
                smooth=0.12 if is_dark else 0.18,
            )
            paths = ptr if ptr else list(ds)
            if not paths:
                continue
            if acc is None or this_cov < 0.85:
                graph_area += max(0.0, float(area) - (float(acc.area) if acc is not None else 0.0))
        rec = {
            "hex": to_hex(palette[ink]),
            "name": layer_name(palette[ink]),
            "paths": paths,
            "lum": lum(palette[ink]),
            "n": area,
        }
        # Stacked dark plates: a hairline same-color stroke covers lighter-ink
        # overshoot at the silhouette (puma gold fringe) without a gold gap-fill.
        if lum(palette[ink]) < 50:
            rec["stroke"] = True
            rec["sw"] = 1.25 * 0.5 * (sx + sy)
        layers.append(rec)

    if gap_fill and cracks:
        ext = _exterior_paper_mask(a)
        dist_ext = None
        if ext.any():
            dist_ext = cv2.distanceTransform((~ext).astype(np.uint8), cv2.DIST_L2, 3)
        hh, ww = a.shape
        for c in cracks:
            if c["left"] < 0 or c["right"] < 0:
                continue
            if c["left"] >= len(palette) or c["right"] >= len(palette):
                continue
            pts = c.get("pts") or []
            if len(pts) < 2:
                continue
            plen = 0.0
            for i in range(len(pts) - 1):
                plen += math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1])
            if plen < 3.0:
                continue
            # Outer-silhouette sandwiches must not get an avg-color stroke —
            # that is the gold halo around a black keyline.
            if dist_ext is not None:
                near = 0
                n_s = 0
                for x, y in pts[:: max(1, len(pts) // 24)]:
                    ix = int(max(0, min(ww - 1, round(x - 0.5))))
                    iy = int(max(0, min(hh - 1, round(y - 0.5))))
                    n_s += 1
                    if float(dist_ext[iy, ix]) <= 2.8:
                        near += 1
                if n_s and near / n_s >= 0.45:
                    continue
            _ensure_crack_fit(
                c, sx, sy, logo=logo, grad=grad, try_primitives=try_primitives
            )
            dstroke = _strip_z(c.get("d_fwd") or "")
            if not dstroke:
                continue
            rgb_a = np.asarray(palette[c["left"]], dtype=np.float32)
            rgb_b = np.asarray(palette[c["right"]], dtype=np.float32)
            la, lb = lum(rgb_a), lum(rgb_b)
            # High-contrast keyline: stroke in the darker ink so it tucks under
            # the outline instead of painting a gold/olive halo.
            if abs(la - lb) >= 45:
                avg = rgb_a if la <= lb else rgb_b
            else:
                avg = (rgb_a + rgb_b) * 0.5
            sw = 1.5 * 0.5 * (sx + sy)
            gap_strokes.append(
                {
                    "d": dstroke,
                    "hex": to_hex(avg),
                    "sw": sw,
                }
            )

    ink_px = float(sum(int((a == i).sum()) for i in range(len(palette))))
    coverage = (graph_area / ink_px) if ink_px > 0 else 0.0
    n_ink = sum(1 for i in range(len(palette)) if int((a == i).sum()) >= min_area_px)
    # Evenodd compounds hide loop count in Corel; still reject wild Imagine shards.
    # A striped mascot with solid coverage is not 1000-shard mush — vtracer
    # fallback on that case is worse (stairs + melted pads).
    cap = 96 if logo else 180
    cap = max(cap, 16 * max(1, n_ink))
    too_sharded = n_loops > cap and (coverage < 0.88 or n_loops > int(cap * 1.6))
    n_prim = sum(1 for c in cracks if c.get("primitive"))
    seam_ds = [
        {"d_fwd": c.get("d_fwd") or "", "d_rev": c.get("d_rev") or ""}
        for c in cracks
        if c.get("d_fwd") and c["left"] >= 0 and c["right"] >= 0
    ]
    aux = {
        "cracks": len(cracks),
        "loops": n_loops,
        "faces": len(faces),
        "gap_strokes": gap_strokes,
        "vector_graph": "shared-seams",
        "coverage": round(float(coverage), 3),
        "too_sharded": bool(too_sharded),
        "primitives": n_prim,
        "shared_seams": len(seam_ds),
        "seam_ds": seam_ds,
    }
    if coverage < 0.62 or too_sharded:
        aux["vector_graph"] = "shared-seams-reject"
        sys.stderr.write(
            f"vector_graph reject coverage={coverage:.3f} loops={n_loops} "
            f"sharded={too_sharded} cracks={len(cracks)}\n"
        )
        return [], aux
    return layers, aux


def svg_from_layers_with_gaps(
    layers, width_in, height_in, paper_hex=None, gap_strokes=None, overlay_strokes=None
):
    """Like svg_from_layers but draws gap-filler strokes under fills.

    overlay_strokes sit on top (whiskers that must not be faired off the sil).
    """
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
    if gap_strokes:
        parts.append('  <g fill="none" stroke-linejoin="round" stroke-linecap="round" data-name="gap-filler">')
        for g in gap_strokes:
            parts.append(
                f'    <path d="{g["d"]}" stroke="{g["hex"]}" stroke-width="{fmt(g["sw"], 4)}"/>'
            )
        parts.append("  </g>")
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
        if L.get("stroke") and L.get("sw"):
            extra += (
                f' stroke="{hex_}" stroke-width="{fmt(float(L["sw"]), 4)}"'
                f' stroke-linejoin="round"'
            )
        parts.append(f'  <g fill="{hex_}" fill-rule="evenodd" data-name="{_esc(name)}"{extra}>')
        for d in paths:
            parts.append(f'    <path d="{d}"/>')
        parts.append("  </g>")
    if overlay_strokes:
        parts.append(
            '  <g fill="none" stroke-linejoin="round" stroke-linecap="round" data-name="overlay-strokes">'
        )
        for g in overlay_strokes:
            parts.append(
                f'    <path d="{g["d"]}" stroke="{g["hex"]}" stroke-width="{fmt(g["sw"], 4)}"/>'
            )
        parts.append("  </g>")
    parts.append("</svg>")
    return "\n".join(parts) + "\n"


def _overlay_strokes_from_polylines(polylines, sx, sy, hex_, thick_px):
    """Open cubics for thin overlay strokes (whiskers) that graph fairing would eat."""
    G = _vg_geom()
    strokes = []
    sw = 0.5 * (float(sx) + float(sy)) * float(max(1.8, thick_px))
    for chain in polylines or []:
        if len(chain) < 3:
            continue
        pts = [(float(p[0]), float(p[1])) for p in chain]
        work = G["fair_open_polyline"](pts, closed=False, logo=True)
        if len(work) < 2:
            work = pts
        d = G["fit_cubic_open"](work, sx, sy, error=1.15, corner_cos=0.42)
        if not d:
            continue
        strokes.append({"d": _strip_z(d), "hex": hex_, "sw": sw})
    return strokes


def polish_traced_svg(svg_text: str, *, kind: str = "fair", try_primitives: bool = True):
    """Post-trace corner cleanup + curve fairing (+ confident primitives)."""
    try:
        from geom import polish_svg_paths
    except Exception:
        try:
            from lib.geom import polish_svg_paths
        except Exception:
            return svg_text, {}
    return polish_svg_paths(svg_text, kind=kind, try_primitives=try_primitives)


def remap_svg_fills_to_palette(svg_text: str, palette, paper_rgb) -> str:
    """Snap vtracer-invented near-colors back onto the screenprint inks."""
    pal = [np.asarray(c, dtype=np.float32) for c in palette]
    pal.append(np.asarray(paper_rgb, dtype=np.float32))
    pal_labs = [lab_of_rgb([c])[0] for c in pal]
    pal_hex = [to_hex(c) for c in pal]

    def repl(m):
        hx = m.group(1)
        if len(hx) == 4:
            hx = "#" + "".join(ch * 2 for ch in hx[1:])
        try:
            r = int(hx[1:3], 16)
            g = int(hx[3:5], 16)
            b = int(hx[5:7], 16)
        except ValueError:
            return m.group(0)
        lab = lab_of_rgb([np.array([r, g, b], np.float32)])[0]
        best_i, best_d = 0, 1e18
        for i, la in enumerate(pal_labs):
            dvec = lab - la
            d = float(np.dot(dvec, dvec))
            if d < best_d:
                best_d = d
                best_i = i
        return f'fill="{pal_hex[best_i]}"'

    return re.sub(r'fill="(#[0-9A-Fa-f]{3,8})"', repl, svg_text)


def clean_fill_mask(mask, *, min_area=40, close_k=3, open_k=2):
    """Remove speckles and seal small holes in flat fill regions (not thin strokes)."""
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) < 8:
        return m
    if open_k and open_k > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_k, open_k))
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k, iterations=1)
    if close_k and close_k > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_k, close_k))
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k, iterations=1)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=4)
    out = np.zeros_like(m)
    for i in range(1, n):
        if int(stats[i, cv2.CC_STAT_AREA]) >= min_area:
            out[labels == i] = 1
    return out


def is_junk_mascot(noisy, kind, paper_rgb, palette) -> bool:
    """Noisy light-sheet cartoon/mascot: chromatic fills + a dark ink."""
    if not noisy or kind != "logo":
        return False
    if lum(paper_rgb) < 200:
        return False
    if not palette or len(palette) < 2:
        return False
    has_dark = any(lum(c) < 55 for c in palette)
    has_chroma = any(chroma_of_lab(lab_of_rgb([c])[0]) > 18 and lum(c) >= 55 for c in palette)
    return bool(has_dark and has_chroma)


def _ink_masks(assign, palette):
    dark_i = [i for i, c in enumerate(palette) if lum(c) < 55]
    chrom_i = [
        i
        for i, c in enumerate(palette)
        if i not in dark_i and chroma_of_lab(lab_of_rgb([c])[0]) > 16
    ]
    h, w = assign.shape
    dark_m = np.zeros((h, w), np.uint8)
    chrom_m = np.zeros((h, w), np.uint8)
    for i in dark_i:
        dark_m[assign == i] = 1
    for i in chrom_i:
        chrom_m[assign == i] = 1
    return dark_i, chrom_i, dark_m, chrom_m


def keep_accent_ccs(assign, palette, dark_i):
    """Keep large CCs of non-body chromatic inks (bandana, nose); fold specks into body."""
    areas = []
    for i, c in enumerate(palette):
        if i in dark_i:
            continue
        if chroma_of_lab(lab_of_rgb([c])[0]) < 16:
            continue
        areas.append((int((assign == i).sum()), i))
    if len(areas) < 2:
        return assign
    areas.sort(reverse=True)
    body_i = areas[0][1]
    out = assign.copy()
    for _n, i in areas[1:]:
        mask = (out == i).astype(np.uint8)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        if n <= 2:
            continue
        sizes = [(int(stats[li, cv2.CC_STAT_AREA]), li) for li in range(1, n)]
        sizes.sort(reverse=True)
        keep_ids = set()
        total = sum(s for s, _ in sizes) or 1
        for idx, (s, li) in enumerate(sizes):
            bw = int(stats[li, cv2.CC_STAT_WIDTH])
            bh = int(stats[li, cv2.CC_STAT_HEIGHT])
            aspect = max(bw, bh) / max(1.0, min(bw, bh))
            compact = s / float(max(1, bw * bh))
            # Largest blob always; extra CCs must be compact fills, not AA streaks.
            if idx == 0:
                keep_ids.add(li)
                continue
            if s >= max(100, int(0.08 * total)) and aspect < 4.5 and compact > 0.18:
                keep_ids.add(li)
        for li in range(1, n):
            if li not in keep_ids:
                out[labels == li] = body_i
    return out


def _unsharp(rgb, sigma=1.05, amount=1.35):
    blur = cv2.GaussianBlur(rgb, (0, 0), float(sigma))
    out = cv2.addWeighted(rgb, 1.0 + float(amount), blur, -float(amount), 0)
    return np.clip(out, 0, 255).astype(np.uint8)


def _geom_fairing():
    try:
        from geom import destaircase, resample_closed, chaikin, laplacian_smooth
    except ImportError:
        from lib.geom import destaircase, resample_closed, chaikin, laplacian_smooth
    return destaircase, resample_closed, chaikin, laplacian_smooth


def _fair_mask(mask, *, max_leg=28.0, spacing=2.2, chaikin_rounds=2, lap_iters=3, lap_lam=0.38):
    """Destair JPEG jogs and Laplacian-fair a binary silhouette so potrace sees cubics."""
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) < 24:
        return m
    destaircase, resample_closed, chaikin, laplacian_smooth = _geom_fairing()
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return m
    out = np.zeros_like(m)
    max_leg = float(max(8.0, max_leg))
    spacing = float(max(1.0, spacing))
    for cnt in cnts:
        if cv2.contourArea(cnt) < 40:
            continue
        pts = [(float(p[0][0]), float(p[0][1])) for p in cnt]
        ring = destaircase(pts, max_leg=max_leg)
        if len(ring) < 8:
            cv2.drawContours(out, [cnt], -1, 1, thickness=-1)
            continue
        ring = resample_closed(ring, spacing)
        if len(ring) < 8:
            cv2.drawContours(out, [cnt], -1, 1, thickness=-1)
            continue
        ring = chaikin(ring, int(chaikin_rounds), -0.55)
        ring = destaircase(ring, max_leg=max_leg)
        ring = laplacian_smooth(ring, int(lap_iters), float(lap_lam))
        arr = np.round(np.asarray(ring, dtype=np.float32)).astype(np.int32)
        if arr.shape[0] >= 3:
            cv2.fillPoly(out, [arr], 1)
    if int(out.sum()) < 0.55 * int(m.sum()):
        return m
    return out


def _fill_shallow_bites(mask, max_depth=28.0):
    """Fill shallow convexity defects (JPEG bites on a finger) without closing deep gaps."""
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) < 40:
        return m
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return m
    cnt = max(cnts, key=cv2.contourArea)
    if len(cnt) < 8:
        return m
    hull = cv2.convexHull(cnt, returnPoints=False)
    if hull is None or len(hull) < 3:
        return m
    try:
        defects = cv2.convexityDefects(cnt, hull)
    except cv2.error:
        return m
    if defects is None:
        return m
    out = m.copy()
    rows = defects.reshape(-1, 4)
    for s, e, f, d in rows:
        depth = float(d) / 256.0
        if depth <= 1.5 or depth > float(max_depth):
            continue
        try:
            pts = np.array([cnt[int(s)][0], cnt[int(f)][0], cnt[int(e)][0]], np.int32)
        except (IndexError, TypeError):
            continue
        cv2.fillConvexPoly(out, pts, 1)
    return out


def _fill_tip_notches(mask, *, tip_h_frac=0.072, tip_w_frac=0.085, max_depth_frac=0.018):
    """Fair JPEG bites on the highest thin protrusion (a pointing finger).

    Convexity defects of the *whole* silhouette cannot see a fingertip notch
    (the hull jumps from head to tip). Run shallow-bite fill on a tip crop
    that stops above the finger–hand gap.
    """
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) < 80:
        return m
    h, w = m.shape
    ys, xs = np.where(m > 0)
    if ys.size < 40:
        return m
    y_tip = int(ys.min())
    y_bot = int(ys.max())
    sil_h = max(1, y_bot - y_tip)
    x_tip = int(np.round(xs[ys == y_tip].mean()))
    th = max(18, int(float(tip_h_frac) * sil_h))
    tw = max(16, int(float(tip_w_frac) * sil_h))
    y0 = max(0, y_tip - 2)
    y1 = min(h, y_tip + th)
    x0 = max(0, x_tip - tw)
    x1 = min(w, x_tip + tw)
    crop = m[y0:y1, x0:x1]
    if int(crop.sum()) < 20:
        return m
    max_depth = max(8.0, float(max_depth_frac) * sil_h)
    filled = _fill_shallow_bites(crop, max_depth=max_depth)
    rad = max(3, int(round(0.0045 * max(h, w)))) | 1
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * rad + 1, 2 * rad + 1))
    filled = cv2.morphologyEx(filled, cv2.MORPH_CLOSE, k)
    out = m.copy()
    out[y0:y1, x0:x1] = np.maximum(out[y0:y1, x0:x1], filled)
    return out


def _pyramid_fair_mask(mask, *, block=8, sigma=1.05, thr=0.42):
    """Fair a binary mask by smoothing at JPEG-block scale, keep topology."""
    m = (mask > 0).astype(np.float32)
    if float(m.sum()) < 24:
        return (m > 0).astype(np.uint8)
    h, w = m.shape
    b = max(4, int(block))
    nw, nh = max(16, w // b), max(16, h // b)
    small = cv2.resize(m, (nw, nh), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), float(sigma))
    up = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    out = (up >= float(thr)).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(out, connectivity=8)
    if n > 1:
        best = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
        out = (lab == best).astype(np.uint8)
    return _fill_mask_holes(out)


def _hessian_ridges(luma, sigmas=(0.9, 1.5, 2.3, 3.2)):
    """Dark-line vesselness from the Hessian (no skimage)."""
    img = luma.astype(np.float32)
    acc = np.zeros_like(img)
    for s in sigmas:
        g = cv2.GaussianBlur(img, (0, 0), float(s))
        ixx = cv2.Sobel(g, cv2.CV_32F, 2, 0, ksize=3)
        iyy = cv2.Sobel(g, cv2.CV_32F, 0, 2, ksize=3)
        ixy = cv2.Sobel(g, cv2.CV_32F, 1, 1, ksize=3)
        tmp = np.sqrt(np.maximum((ixx - iyy) ** 2 + 4.0 * ixy * ixy, 0.0))
        lam1 = 0.5 * (ixx + iyy + tmp)
        lam2 = 0.5 * (ixx + iyy - tmp)
        rb = np.abs(lam2) / (np.abs(lam1) + 1e-6)
        v = np.where(lam1 > 0.0, lam1 * np.exp(-(rb * rb) / 0.5), 0.0)
        acc = np.maximum(acc, v)
    return acc


def _fill_mask_holes(mask):
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) < 8:
        return m
    h, w = m.shape
    ff = m.copy()
    pad = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(ff, pad, (0, 0), 255)
    m[ff == 0] = 1
    return m


def _even_ring(mask, width=2.4, sigma=1.7, outer_scale=0.55):
    """Smooth even stroke around a filled mask (distance field, not morph-gradient)."""
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) < 8:
        return m
    mf = cv2.GaussianBlur(m.astype(np.float32), (0, 0), float(sigma))
    ms = (mf >= 0.45).astype(np.uint8)
    din = cv2.distanceTransform(ms, cv2.DIST_L2, 5)
    dout = cv2.distanceTransform((1 - ms).astype(np.uint8), cv2.DIST_L2, 5)
    ring = ((ms > 0) & (din <= width)) | ((ms == 0) & (dout <= width * outer_scale))
    return ring.astype(np.uint8)


def _line_kernel(length, width, angle_deg):
    length = int(max(7, length)) | 1
    k = np.zeros((length, length), np.uint8)
    c = length // 2
    cv2.line(k, (0, c), (length - 1, c), 1, thickness=max(1, int(width)))
    M = cv2.getRotationMatrix2D((float(c), float(c)), float(angle_deg), 1.0)
    kr = cv2.warpAffine(k, M, (length, length))
    return (kr > 0).astype(np.uint8)


def _directional_blackhat(luma, length=23, width=2, n_ang=16):
    acc = np.zeros(luma.shape, np.float32)
    src = luma.astype(np.uint8)
    for i in range(int(n_ang)):
        ang = i * (180.0 / float(n_ang))
        k = _line_kernel(length, width, ang)
        bh = cv2.morphologyEx(src, cv2.MORPH_BLACKHAT, k)
        acc = np.maximum(acc, bh.astype(np.float32))
    return acc


def _morph_skeleton(mask):
    img = (mask > 0).astype(np.uint8)
    if int(img.sum()) < 4:
        return img
    skel = np.zeros_like(img)
    kernel = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    while int(img.sum()) > 0:
        eroded = cv2.erode(img, kernel)
        opened = cv2.dilate(eroded, kernel)
        skel |= cv2.subtract(img, opened)
        img = eroded
    return skel


def _extend_skeleton(skel, score, gate, max_step=36, origin=None, coast=0):
    """Walk skeleton endpoints along a ridge so JPEG ticks become strokes.

    `origin` (x, y) is the muzzle centre: walk the end that points away from it.
    After the ridge dies, `coast` extra steps continue the same heading so a
    JPEG-broken hair can finish without inventing a new one.
    """
    sk = (skel > 0).astype(np.uint8)
    if int(sk.sum()) < 4:
        return sk
    h, w = sk.shape
    nbr = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], np.float32)
    ncnt = cv2.filter2D(sk.astype(np.float32), -1, nbr)
    ends = np.argwhere((sk > 0) & (ncnt <= 1.5))
    if ends.shape[0] == 0 or ends.shape[0] > 240:
        return sk
    n, labels, stats, cents = cv2.connectedComponentsWithStats(sk, connectivity=8)
    out = sk.copy()
    ox, oy = (None, None) if origin is None else (float(origin[0]), float(origin[1]))
    for y, x in ends:
        li = int(labels[y, x])
        if li <= 0:
            continue
        cx = float(cents[li, 0])
        cy = float(cents[li, 1])
        if ox is not None:
            vx, vy = float(x) - ox, float(y) - oy
        else:
            vx, vy = float(x) - cx, float(y) - cy
        nrm = math.hypot(vx, vy) or 1.0
        dx, dy = vx / nrm, vy / nrm
        # Skip the inward end (points toward muzzle).
        if ox is not None:
            inward = (float(x) - ox) * dx + (float(y) - oy) * dy
            if inward < 0:
                continue
        s0 = float(score[y, x])
        floor = max(0.018 * s0, 0.02)
        px, py = float(x), float(y)
        walked = 0
        for _ in range(int(max_step)):
            best, bdx, bdy = -1.0, dx, dy
            for ang in (-0.40, -0.22, 0.0, 0.22, 0.40):
                ca, sa = math.cos(ang), math.sin(ang)
                rx = dx * ca - dy * sa
                ry = dx * sa + dy * ca
                ix = int(round(px + rx))
                iy = int(round(py + ry))
                if ix < 1 or iy < 1 or ix >= w - 1 or iy >= h - 1:
                    continue
                if gate[iy, ix] == 0:
                    continue
                val = float(score[iy, ix])
                if val > best:
                    best, bdx, bdy = val, rx, ry
            if best < floor:
                break
            n2 = math.hypot(bdx, bdy) or 1.0
            dx, dy = bdx / n2, bdy / n2
            px += dx
            py += dy
            ix, iy = int(round(px)), int(round(py))
            out[max(0, iy - 1) : iy + 2, max(0, ix - 1) : ix + 2] = 1
            walked += 1
        extra = int(coast) if walked >= 4 else min(int(coast), max(0, int(0.55 * walked)))
        for _ in range(extra):
            px += dx
            py += dy
            ix, iy = int(round(px)), int(round(py))
            if ix < 1 or iy < 1 or ix >= w - 1 or iy >= h - 1:
                break
            if gate[iy, ix] == 0:
                break
            out[max(0, iy - 1) : iy + 2, max(0, ix - 1) : ix + 2] = 1
    return out


def _stroke_skeleton(skel, thickness=3):
    """Even-width polyline stroke of each skeleton CC (survives potrace, looks like hair)."""
    sk = (skel > 0).astype(np.uint8)
    if int(sk.sum()) < 4:
        return sk
    h, w = sk.shape
    canvas = np.zeros((h, w), np.uint8)
    n, labels, _, _ = cv2.connectedComponentsWithStats(sk, connectivity=8)
    t = max(2, int(thickness))
    for i in range(1, n):
        ys, xs = np.where(labels == i)
        if ys.size < 5:
            canvas[labels == i] = 255
            continue
        pts = np.stack([xs.astype(np.float64), ys.astype(np.float64)], axis=1)
        mean = pts.mean(axis=0)
        centered = pts - mean
        cov = np.cov(centered.T)
        if cov.shape != (2, 2) or not np.all(np.isfinite(cov)):
            canvas[labels == i] = 255
            continue
        eigvals, eigvecs = np.linalg.eigh(cov)
        axis = eigvecs[:, int(np.argmax(eigvals))]
        proj = centered @ axis
        ordered = pts[np.argsort(proj)]
        # Light moving-average so JPEG jogs don't become kinks.
        k = 3 if ordered.shape[0] >= 9 else 1
        if k > 1:
            ker = np.ones(k) / float(k)
            xs_s = np.convolve(ordered[:, 0], ker, mode="same")
            ys_s = np.convolve(ordered[:, 1], ker, mode="same")
            xs_s[: k // 2] = ordered[: k // 2, 0]
            ys_s[: k // 2] = ordered[: k // 2, 1]
            xs_s[-(k // 2) :] = ordered[-(k // 2) :, 0]
            ys_s[-(k // 2) :] = ordered[-(k // 2) :, 1]
            ordered = np.stack([xs_s, ys_s], axis=1)
        step = max(1, ordered.shape[0] // 28)
        poly = ordered[::step]
        if math.hypot(poly[-1, 0] - ordered[-1, 0], poly[-1, 1] - ordered[-1, 1]) > 1.5:
            poly = np.vstack([poly, ordered[-1]])
        poly_i = np.round(poly).astype(np.int32)
        cv2.polylines(canvas, [poly_i], False, 255, thickness=t, lineType=cv2.LINE_8)
    return (canvas > 0).astype(np.uint8)


def _walk_ridge(score, gate, x, y, dx, dy, max_step, floor, gap=4):
    """Trace a dark ridge from (x,y) along heading (dx,dy) with a small snap cone.

    A short coast (`gap` steps) bridges JPEG breaks; the walk still has to ride
    a real ridge — it will not invent a fan across empty paper.
    """
    h, w = score.shape
    nrm = math.hypot(dx, dy) or 1.0
    dx, dy = dx / nrm, dy / nrm
    path = [(int(x), int(y))]
    px, py = float(x), float(y)
    cur_floor = float(floor)
    missed = 0
    for _ in range(int(max_step)):
        best, bdx, bdy = -1.0, dx, dy
        for step in (1.2, 1.8):
            for ang in (-0.50, -0.28, 0.0, 0.28, 0.50):
                ca, sa = math.cos(ang), math.sin(ang)
                rx = dx * ca - dy * sa
                ry = dx * sa + dy * ca
                ix = int(round(px + rx * step))
                iy = int(round(py + ry * step))
                if ix < 1 or iy < 1 or ix >= w - 1 or iy >= h - 1:
                    continue
                if gate[iy, ix] == 0:
                    continue
                val = float(score[iy, ix])
                if val > best:
                    best, bdx, bdy = val, rx, ry
        if best < cur_floor:
            missed += 1
            if missed > int(gap):
                break
            px += dx * 1.4
            py += dy * 1.4
            ix, iy = int(round(px)), int(round(py))
            if ix < 1 or iy < 1 or ix >= w - 1 or iy >= h - 1:
                break
            if gate[iy, ix] == 0:
                break
            if path and abs(ix - path[-1][0]) + abs(iy - path[-1][1]) == 0:
                continue
            path.append((ix, iy))
            cur_floor = max(0.35 * float(floor), cur_floor * 0.92)
            continue
        missed = 0
        n2 = math.hypot(bdx, bdy) or 1.0
        dx, dy = bdx / n2, bdy / n2
        px += dx * 1.4
        py += dy * 1.4
        ix, iy = int(round(px)), int(round(py))
        if path and abs(ix - path[-1][0]) + abs(iy - path[-1][1]) == 0:
            continue
        path.append((ix, iy))
        cur_floor = max(0.40 * float(floor), cur_floor * 0.985)
    return path


def _stroke_polylines(paths, shape, thickness=3):
    canvas = np.zeros(shape, np.uint8)
    t = max(2, int(thickness))
    for path in paths:
        if len(path) < 3:
            continue
        poly = np.round(np.asarray(path, dtype=np.float32)).astype(np.int32)
        cv2.polylines(canvas, [poly], False, 255, thickness=t, lineType=cv2.LINE_8)
    return (canvas > 0).astype(np.uint8)


def _junk_mascot_whiskers(
    luma, ch, muz_f, sil, assign, red_i, dark_m, inner, maxe, sil_h
):
    """Long thin muzzle-flank hairs from Hessian ridges, not short ticks.

    JPEG breaks each hair into dashes. Cluster those dashes by angle from a
    *filled* muzzle and stitch radial bins — a walk must sit on real ridge
    pixels (occupancy), never an invented fan.
    """
    h, w = luma.shape
    if int(muz_f.sum()) < 40:
        return np.zeros((h, w), np.uint8), []
    k5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    k7 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    muz = _fill_mask_holes(muz_f)
    hess = _hessian_ridges(luma, sigmas=(0.6, 1.0, 1.6, 2.4, 3.4))
    hn = hess / (float(hess.max()) or 1.0)

    ys_m, xs_m = np.where(muz > 0)
    xmid = float(xs_m.mean())
    ymid = float(ys_m.mean())
    mw = float(xs_m.max() - xs_m.min() + 1)
    mh = float(ys_m.max() - ys_m.min() + 1)
    xx = np.arange(w, dtype=np.float32)[None, :]
    yy = np.arange(h, dtype=np.float32)[:, None]
    rx = max(40.0, 1.50 * mw)
    ry = max(28.0, 1.05 * mh)
    ell = (((xx - xmid) / rx) ** 2 + ((yy - ymid) / ry) ** 2) <= 1.0
    thick_dark = cv2.morphologyEx(dark_m, cv2.MORPH_OPEN, k5)
    if red_i is not None:
        red_d = cv2.dilate((assign == red_i).astype(np.uint8), k7)
    else:
        red_d = np.zeros((h, w), np.uint8)
    gate = (ell & (thick_dark == 0) & (red_d == 0) & (muz == 0)).astype(np.uint8)
    pos = hn[gate > 0]
    if pos.size < 40:
        return np.zeros((h, w), np.uint8), []
    t_lo = float(np.percentile(pos, 90))
    cand = ((hn >= t_lo) & (gate > 0)).astype(np.uint8)
    dist = cv2.distanceTransform(cand, cv2.DIST_L2, 3)
    cand[dist > max(2.2, 0.0016 * maxe)] = 0
    sk = _morph_skeleton(cand)
    py, px = np.where(sk > 0)
    if px.size < 24:
        return np.zeros((h, w), np.uint8), []
    dx = px.astype(np.float32) - xmid
    dy = py.astype(np.float32) - ymid
    rad = np.hypot(dx, dy)
    ang = np.arctan2(dy, dx)
    # Whisker cones: sideways, not ears/chin. Right can tilt up toward an arm.
    right_cone = (ang >= -0.95) & (ang <= 0.45)
    left_cone = (ang >= 2.82) | (ang <= -2.82)
    ok = (right_cone | left_cone) & (rad > 0.10 * mw) & (rad < 1.70 * mw)
    if int(ok.sum()) < 16:
        return np.zeros((h, w), np.uint8), []

    nbins = 144
    edges = np.linspace(-math.pi, math.pi, nbins + 1)
    hist, _ = np.histogram(ang[ok], bins=edges)
    peaks = []
    for i in range(nbins):
        if hist[i] < 10:
            continue
        if hist[i] >= hist[(i - 1) % nbins] and hist[i] >= hist[(i + 1) % nbins]:
            peaks.append((int(hist[i]), 0.5 * (edges[i] + edges[i + 1])))
    peaks.sort(reverse=True)

    def _ray_chain(sel, bin_r=10.0):
        idx = np.where(sel)[0]
        if idx.size < 8:
            return None, 0.0
        rmin = float(rad[idx].min())
        rmax = float(rad[idx].max())
        rs = np.arange(rmin, rmax + 0.5, bin_r)
        raw = []
        hit = 0
        for r in rs:
            inbin = idx[(rad[idx] >= r) & (rad[idx] < r + bin_r)]
            if inbin.size >= 1:
                raw.append(
                    (float(np.median(px[inbin])), float(np.median(py[inbin])))
                )
                hit += 1
            else:
                raw.append(None)
        while raw and raw[-1] is None:
            raw.pop()
        occ = hit / float(max(1, len(rs)))
        chain = []
        for i, p in enumerate(raw):
            if p is not None:
                chain.append(p)
                continue
            j = i + 1
            while j < len(raw) and raw[j] is None:
                j += 1
            if not chain or j >= len(raw):
                continue
            a, b = chain[-1], raw[j]
            t = 1.0 / (j - i + 1)
            chain.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        return chain, occ

    def _clip(chain):
        out = []
        for x, y in chain:
            ix, iy = int(round(x)), int(round(y))
            if ix < 1 or iy < 1 or ix >= w - 1 or iy >= h - 1:
                break
            r = math.hypot(x - xmid, y - ymid)
            # Bandana is below the muzzle. Hairs that leave into paper must
            # not be clipped by a dilated red halo around the scarf.
            if red_d[iy, ix] and sil[iy, ix] and y > ymid + 0.22 * mh:
                break
            if dark_m[iy, ix] and r > 0.70 * mw:
                break
            # Paper hairs may leave the sil; only clip on-figure rays that
            # have already cleared the muzzle.
            if sil[iy, ix]:
                if r > 1.50 * mw:
                    break
            elif r > 1.90 * mw:
                break
            out.append((x, y))
        return out

    def _smooth(chain, k=3):
        if len(chain) < k + 2:
            return chain
        xs = np.array([p[0] for p in chain], np.float32)
        ys = np.array([p[1] for p in chain], np.float32)
        ker = np.ones(k, np.float32) / float(k)
        xs2 = np.convolve(xs, ker, "same")
        ys2 = np.convolve(ys, ker, "same")
        xs2[: k // 2] = xs[: k // 2]
        ys2[: k // 2] = ys[: k // 2]
        xs2[-(k // 2) :] = xs[-(k // 2) :]
        ys2[-(k // 2) :] = ys[-(k // 2) :]
        return list(zip(xs2.tolist(), ys2.tolist()))

    paths = []
    for _count, a0 in peaks[:16]:
        da = np.abs(ang - a0)
        da = np.minimum(da, 2.0 * math.pi - da)
        sel = ok & (da < 0.072)
        chain, occ = _ray_chain(sel, 10.0)
        if chain is None or occ < 0.28:
            continue
        chain = _clip(chain)
        if len(chain) < 6:
            continue
        chain = _smooth(chain, 5)
        if len(chain) > 10:
            step = max(1, (len(chain) - 1) // 7)
            simp = chain[::step]
            if simp[-1] != chain[-1]:
                simp.append(chain[-1])
            chain = simp
        span = math.hypot(chain[-1][0] - chain[0][0], chain[-1][1] - chain[0][1])
        ca, sa = math.cos(a0), math.sin(a0)
        rms = math.sqrt(
            float(
                np.mean(
                    [((x - xmid) * sa - (y - ymid) * ca) ** 2 for x, y in chain]
                )
            )
        )
        if span < 0.18 * mw or rms > 18.0:
            continue
        side_r = math.cos(a0) > 0.0
        paths.append((span, chain, a0, side_r))

    paths.sort(key=lambda t: -t[0])
    kept = []
    n_left = n_right = 0
    for span, chain, a0, side_r in paths:
        if side_r and n_right >= 5:
            continue
        if (not side_r) and n_left >= 5:
            continue
        twin = False
        for _sp, _ch, kang, _sr in kept:
            dang = abs(a0 - kang)
            dang = min(dang, 2.0 * math.pi - dang)
            if dang < 0.12:
                twin = True
                break
        if twin:
            continue
        kept.append((span, chain, a0, side_r))
        if side_r:
            n_right += 1
        else:
            n_left += 1

    thick = max(2, int(round(0.0017 * maxe)))
    int_paths = [
        [(int(round(x)), int(round(y))) for x, y in ch] for _s, ch, _a, _r in kept
    ]
    out = _stroke_polylines(int_paths, (h, w), thickness=thick)

    dbg = os.environ.get("VECTORIZER_DEBUG")
    if dbg:
        os.makedirs(dbg, exist_ok=True)

        def _sv(name, a):
            Image.fromarray((a > 0).astype(np.uint8) * 255).save(os.path.join(dbg, name))

        _sv("w-gate.png", gate)
        _sv("w-cand.png", cand)
        _sv("w-keep.png", sk)
        _sv("w-skel.png", out)
        _sv("w-sk2.png", out)
        hn8 = (np.clip(hn, 0, 1) * 255).astype(np.uint8)
        Image.fromarray(hn8).save(os.path.join(dbg, "w-score.png"))
    return out, int_paths


def _fold_unkept_dark(assign, di, keep):
    """Reassign dark specks (not in keep) to neighboring non-dark ink or paper."""
    fold = (assign == di) & (keep == 0)
    if not fold.any():
        return assign
    out = assign.copy()
    n, labels, stats, _ = cv2.connectedComponentsWithStats(fold.astype(np.uint8), connectivity=4)
    h, w = assign.shape
    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    for i in range(1, n):
        comp = labels == i
        ring = cv2.dilate(comp.astype(np.uint8), k3) > 0
        ring &= ~comp
        votes = out[ring]
        votes = votes[(votes >= 0) & (votes != di)]
        if votes.size:
            out[comp] = int(np.bincount(votes.astype(np.int32)).argmax())
        else:
            out[comp] = -1
    return out


def apply_junk_mascot_keyline(rgb_edge, assign, palette):
    """Edge-aware black keyline + interior-white seal for junk light-sheet mascots.

    Builds a silhouette by flooding paper around chromatic/dark walls, then:
      - even outer keyline (smoothed distance-field stroke — kills JPEG stairs)
      - inner rings on muzzle / chest-against-chroma / compact pads
      - thin dark ridges on the muzzle (whiskers), skeletonized + extended
      - bandana script kept only if letter-like; otherwise omitted
    Assigned-dark specks are folded away (they used to survive as ear/finger dirt).
    Exterior (ground shadow) is punched to paper. General — not per-artwork.
    """
    h, w = assign.shape
    luma = luma_map(rgb_edge)
    lab = to_lab(rgb_edge)
    ch = chroma_map(lab)
    dark_i, chrom_i, dark_m, chrom_m = _ink_masks(assign, palette)
    if not dark_i or not chrom_i:
        return assign, palette, None

    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    k5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    k7 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
    maxe = float(max(h, w))
    stroke_w = max(2.3, 0.0021 * maxe)

    local = cv2.GaussianBlur(luma, (0, 0), 1.8)
    edge_dark = ((luma + 16 < local) & (luma < 80)).astype(np.uint8)
    hard = (luma < 38).astype(np.uint8)
    chrom_m = cv2.morphologyEx(chrom_m, cv2.MORPH_CLOSE, k5)
    chromish = ((ch > 16) & (luma < 235)).astype(np.uint8)
    chromish = cv2.morphologyEx(chromish, cv2.MORPH_CLOSE, k5)
    walls = ((dark_m > 0) | (chrom_m > 0) | (chromish > 0) | (edge_dark > 0) | (hard > 0)).astype(np.uint8)
    walls = cv2.morphologyEx(walls, cv2.MORPH_CLOSE, k7)

    passable = (1 - walls).astype(np.uint8)
    passable[0, :] = 1
    passable[-1, :] = 1
    passable[:, 0] = 1
    passable[:, -1] = 1
    nlab, labels = cv2.connectedComponents(passable, connectivity=4)
    keep = np.zeros(nlab, dtype=bool)
    bids = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    keep[bids] = True
    keep[0] = False
    exterior = keep[labels]
    sil = (~exterior).astype(np.uint8)
    sil = cv2.morphologyEx(sil, cv2.MORPH_CLOSE, k7)
    sil = cv2.morphologyEx(sil, cv2.MORPH_OPEN, k5)
    # Dilate thin extremities (pointing finger) so they survive fairing.
    sil = cv2.dilate(sil, k3)
    # Close fingertip JPEG bites before the pyramid can keep them as notches.
    k9 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    sil = cv2.morphologyEx(sil, cv2.MORPH_CLOSE, k9)
    # JPEG 8×8 stairs become tens of px at trace res. Smooth at block scale
    # (keeps a pointing finger) rather than destaircasing a self-intersecting contour.
    sil = _pyramid_fair_mask(sil, block=8, sigma=1.05, thr=0.40)
    sil = cv2.morphologyEx(sil, cv2.MORPH_CLOSE, k7)
    sil = cv2.dilate(sil, k3)
    sf = cv2.GaussianBlur(sil.astype(np.float32), (0, 0), max(1.2, 0.0010 * maxe))
    sil = (sf >= 0.38).astype(np.uint8)
    sil = _fill_mask_holes(sil)
    # JPEG notch on a pointing fingertip: fair only the highest protrusion.
    sil = _fill_tip_notches(sil, tip_h_frac=0.072, tip_w_frac=0.085, max_depth_frac=0.018)

    ys = np.arange(h)[:, None]
    chrom_d = cv2.dilate(chrom_m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31)))
    shadow = (
        (sil > 0)
        & (ch < 18)
        & (luma > 100)
        & (luma < 210)
        & (chrom_d == 0)
        & (ys > 0.68 * h)
    )
    sil[shadow] = 0
    if int(sil.sum()) > 0:
        ff = sil.copy()
        mh = np.zeros((h + 2, w + 2), np.uint8)
        cv2.floodFill(ff, mh, (0, 0), 255)
        sil[ff == 0] = 1

    # Fair silhouette + even ring: morph-only rings copy JPEG stairs; a pure
    # distance-field ring used to pinch thin fingers. OR of both on a faired sil.
    rad = max(3, int(round(0.0034 * maxe)))
    k_out = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * rad + 1, 2 * rad + 1))
    rin = max(1, rad - 2)
    k_in = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * rin + 1, 2 * rin + 1))
    outer_morph = ((cv2.dilate(sil, k_out) > 0) & (cv2.erode(sil, k_in) == 0)).astype(np.uint8)
    outer_even = _even_ring(sil, width=max(2.4, 0.0024 * maxe), sigma=max(1.4, 0.0012 * maxe), outer_scale=0.65)
    outer = cv2.bitwise_or(outer_morph, outer_even)

    # Paper-assigned interiors. Do not require low chroma on the Lanczos
    # original — a cream muzzle is warm in the JPEG and would lose to a
    # paler finger pad / arm bite.
    interior_light = ((sil > 0) & (assign < 0) & (luma > 148) & (ch < 52)).astype(np.uint8)
    interior_light = cv2.morphologyEx(interior_light, cv2.MORPH_CLOSE, k5)
    # Drop paper AA on the silhouette fringe so hole-fill cannot flood the body.
    interior_light[cv2.erode(sil, k7) == 0] = 0
    n, labels, stats, _ = cv2.connectedComponentsWithStats(interior_light, connectivity=8)
    filled_il = np.zeros_like(interior_light)
    for i in range(1, n):
        comp = (labels == i).astype(np.uint8)
        filled_il = cv2.bitwise_or(filled_il, _fill_mask_holes(comp))
    interior_light = filled_il
    # Break thin paper-AA necks so an inner-arm JPEG bite cannot merge into the chest.
    k_split = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    split = cv2.erode(interior_light, k_split)
    n_s, lab_s, st_s, _ = cv2.connectedComponentsWithStats(split, connectivity=8)
    if n_s > 2:
        recovered = np.zeros_like(interior_light)
        for i in range(1, n_s):
            rec = cv2.dilate((lab_s == i).astype(np.uint8), k_split)
            recovered = cv2.bitwise_or(recovered, cv2.bitwise_and(rec, interior_light))
        if int(recovered.sum()) > 0.50 * int(interior_light.sum()):
            interior_light = recovered
    n, labels, stats, _ = cv2.connectedComponentsWithStats(interior_light, connectivity=8)
    ys_idx = np.where(sil > 0)[0]
    y0 = int(ys_idx.min()) if ys_idx.size else 0
    y1 = int(ys_idx.max()) if ys_idx.size else h
    sil_h = max(1, y1 - y0)
    sil_a = max(int(sil.sum()), 1)

    muz = np.zeros((h, w), np.uint8)
    chest = np.zeros((h, w), np.uint8)
    best_m, best_mi = 0, -1
    best_c, best_ci = 0, -1
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh_ = int(stats[i, cv2.CC_STAT_HEIGHT])
        top = int(stats[i, cv2.CC_STAT_TOP])
        compact = area / float(max(1, bw * bh_))
        if area < 80:
            continue
        cy_comp = top + 0.5 * bh_
        rel_y = (cy_comp - y0) / float(sil_h)
        # Face sits in the upper-middle of the sil; pointing-hand pads are higher.
        if 0.16 <= rel_y <= 0.50 and compact > 0.14 and bh_ < 0.42 * sil_h and area > best_m:
            best_m, best_mi = area, i
        if bh_ >= 0.22 * sil_h and area > best_c:
            best_c, best_ci = area, i
    if best_mi > 0:
        muz[labels == best_mi] = 1
    if best_ci > 0:
        chest[labels == best_ci] = 1

    muz_f = _fill_mask_holes(muz) if int(muz.sum()) else muz
    if int(muz_f.sum()):
        k15 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
        muz_f = _fill_mask_holes(cv2.morphologyEx(muz_f, cv2.MORPH_CLOSE, k15))
        mf = cv2.GaussianBlur(muz_f.astype(np.float32), (0, 0), 2.2)
        muz_f = _fill_mask_holes((mf >= 0.42).astype(np.uint8))
    inner = _even_ring(muz_f, width=max(1.8, 0.0017 * maxe), sigma=2.0) if int(muz_f.sum()) else muz_f
    if int(chest.sum()) > 0:
        cr = _even_ring(chest, width=max(1.8, 0.0017 * maxe), sigma=1.5)
        cr = cv2.bitwise_and(cr, cv2.dilate(chrom_m, k7))
        cr = cv2.bitwise_and(cr, (1 - cv2.dilate(outer, k3)))
        inner = cv2.bitwise_or(inner, cr)
    # Compact pads (finger, inner ear) — skip: even-rings on JPEG pads mint holes.

    # Paper leftovers inside the sil that are not muzzle/chest/hand-pad are
    # JPEG bites (inner arm). Fill them with body later; keep high compact pads.
    leftover = interior_light.copy()
    leftover[cv2.dilate(chest, k7) > 0] = 0
    leftover[cv2.dilate(muz_f, k7) > 0] = 0
    leftover[cv2.erode(sil, k7) == 0] = 0
    n_l, lab_l, st_l, _ = cv2.connectedComponentsWithStats(leftover, connectivity=8)
    arm_bite = np.zeros((h, w), np.uint8)
    for i in range(1, n_l):
        area = int(st_l[i, cv2.CC_STAT_AREA])
        top = int(st_l[i, cv2.CC_STAT_TOP])
        bw = int(st_l[i, cv2.CC_STAT_WIDTH])
        bh_ = int(st_l[i, cv2.CC_STAT_HEIGHT])
        cy_comp = top + 0.5 * bh_
        rel_y = (cy_comp - y0) / float(sil_h)
        if rel_y < 0.16:
            continue
        if area > 0.06 * sil_a:
            continue
        comp = lab_l == i
        ring = cv2.dilate(comp.astype(np.uint8), k5) > 0
        ring &= ~comp
        chrom_frac = float(chrom_m[ring].mean()) if ring.any() else 0.0
        if chrom_frac >= 0.42 and rel_y >= 0.24:
            arm_bite[comp] = 1

    red_i = None
    best_red = -1.0
    for i, c in enumerate(palette):
        r, g, b = [float(x) for x in c]
        if r > 140 and r > g + 40 and r > b + 40 and g < 80:
            score = (r - g) + (r - b)
            if score > best_red:
                best_red = score
                red_i = i

    # --- Whiskers: long thin muzzle-flank hairs (paper halo + orange fur) ---
    whisk_raw, whisk_polylines = _junk_mascot_whiskers(
        luma, ch, muz_f, sil, assign, red_i, dark_m, inner, maxe, sil_h
    )

    # 6–12px JPEG "lettering" becomes a black smudge — omit. Always fold
    # dark-on-red mush to red so the bandana stays a clean fill.
    script = np.zeros((h, w), np.uint8)
    script_omit = np.zeros((h, w), np.uint8)

    # Assigned dark: keep stripes / eyes / mouth; drop compact JPEG specks.
    n_d, lab_d, st_d, _ = cv2.connectedComponentsWithStats(dark_m, connectivity=4)
    dark_clean = np.zeros_like(dark_m)
    min_blob = max(220, int(0.00022 * h * w))
    for i in range(1, n_d):
        area = int(st_d[i, cv2.CC_STAT_AREA])
        bw = int(st_d[i, cv2.CC_STAT_WIDTH])
        bh_ = int(st_d[i, cv2.CC_STAT_HEIGHT])
        aspect = max(bw, bh_) / max(1.0, min(bw, bh_))
        compact = area / float(max(1, bw * bh_))
        if aspect >= 2.8 and area >= 80:
            dark_clean[lab_d == i] = 1
        elif area >= min_blob:
            dark_clean[lab_d == i] = 1
        elif area >= 120 and compact > 0.38 and aspect < 2.3:
            # Eyes/nose live on the muzzle. Compact specks on an arm are dirt.
            muz_hit = int(cv2.dilate(muz_f, k7)[lab_d == i].sum()) if int(muz_f.sum()) else 0
            if muz_hit > 0:
                dark_clean[lab_d == i] = 1

    # Dark islands sitting on the bandana are mushy script — omit unless letter-like.
    if red_i is not None:
        red_d = cv2.dilate((assign == red_i).astype(np.uint8), k5)
        n5, lab5, st5, _ = cv2.connectedComponentsWithStats(dark_clean, connectivity=4)
        for i in range(1, n5):
            comp = lab5 == i
            area = int(st5[i, cv2.CC_STAT_AREA])
            frac = float(red_d[comp].mean()) if area else 0.0
            if frac > 0.55 and area < 0.018 * sil_a:
                if int(script[comp].sum()) == 0:
                    dark_clean[comp] = 0
                    script_omit[comp] = 1

    outer = cv2.morphologyEx(outer, cv2.MORPH_CLOSE, k5)
    # Clip bulky key to the silhouette; whiskers may extend into paper.
    # Keep whisker pixels OUT of bulky so Schneider cannot fair hairs off the sil.
    bulky = (dark_clean | outer | inner | script).astype(np.uint8)
    if int(whisk_raw.sum()) > 8:
        bulky[whisk_raw > 0] = 0
    near = cv2.dilate(sil, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13)))
    bulky[near == 0] = 0
    key = bulky.astype(np.uint8)

    n, labels, stats, _ = cv2.connectedComponentsWithStats(key, connectivity=8)
    key2 = np.zeros_like(key)
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh_ = int(stats[i, cv2.CC_STAT_HEIGHT])
        aspect = max(bw, bh_) / max(1.0, min(bw, bh_))
        if area >= 24 or (aspect >= 3.2 and area >= 8):
            key2[labels == i] = 1

    out = assign.copy()
    out[sil == 0] = -1
    di = dark_i[0]
    pal = list(palette)
    pal[di] = np.array([0.0, 0.0, 0.0])
    for extra in dark_i[1:]:
        out[out == extra] = di
    keep_dark = ((dark_clean > 0) | (key2 > 0) | (whisk_raw > 0)).astype(np.uint8)
    out = _fold_unkept_dark(out, di, keep_dark)
    out[key2 > 0] = di
    # Isolate whisker strokes: 1px paper gap at 4-connect to bulky dark so
    # they are their own graph faces instead of silhouette spikes.
    if int(whisk_raw.sum()) > 8:
        other = ((out == di) & (whisk_raw == 0)).astype(np.uint8)
        ker4 = np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]], np.uint8)
        root = (whisk_raw > 0) & (cv2.dilate(other, ker4) > 0)
        out[root] = -1
        out[(whisk_raw > 0) & ~root] = di
    # Small paper bites inside the silhouette (JPEG stairs on a thin finger)
    # become body fill so the keyline isn't a dashed line on white.
    if chrom_i:
        body_i = max(chrom_i, key=lambda ii: int((assign == ii).sum()))
        holes = ((sil > 0) & (out < 0)).astype(np.uint8)
        holes[cv2.dilate(chest, k7) > 0] = 0
        holes[cv2.dilate(muz_f, k7) > 0] = 0
        n_h, lab_h, st_h, _ = cv2.connectedComponentsWithStats(holes, connectivity=4)
        # Only JPEG-stair pinholes, not a pointing-hand pad or muzzle.
        max_pocket = max(80, int(0.0020 * sil_a))
        for i in range(1, n_h):
            area = int(st_h[i, cv2.CC_STAT_AREA])
            top = int(st_h[i, cv2.CC_STAT_TOP])
            bw = int(st_h[i, cv2.CC_STAT_WIDTH])
            bh_ = int(st_h[i, cv2.CC_STAT_HEIGHT])
            compact = area / float(max(1, bw * bh_))
            if top <= y0 + 0.16 * sil_h:
                continue
            if area <= max_pocket or (area <= int(0.008 * sil_a) and compact > 0.24):
                out[lab_h == i] = body_i
        if int(arm_bite.sum()):
            out[arm_bite > 0] = body_i
        # Orange leaking into the white muzzle (JPEG mix on the inner ring).
        if int(muz_f.sum()):
            muz_in = cv2.erode(muz_f, k5)
            accent = np.zeros(out.shape, dtype=bool)
            for ii, cc in enumerate(pal):
                if ii == di or ii == body_i:
                    continue
                if chroma_of_lab(lab_of_rgb([cc])[0]) > 16:
                    accent |= out == ii
            leak = (muz_in > 0) & (out == body_i)
            out[leak] = -1
            # Keep blue/other accents; muzzle interior that's not dark is paper.
            mush = (muz_in > 0) & (out != di) & (~accent) & (out >= 0)
            out[mush] = -1
    if red_i is not None:
        if script_omit.any():
            out[script_omit > 0] = red_i
        # Fill holes in the assigned red (script punches) so interior dirt
        # is red, not black. Compute from assign so already-black script counts.
        red_fill = _fill_mask_holes((assign == red_i).astype(np.uint8))
        red_in = cv2.erode(red_fill, k3)
        dirt = (out == di) & (red_in > 0) & (outer == 0)
        out[dirt] = red_i
        key2[dirt] = 0
    out = keep_accent_ccs(out, pal, [di])
    dbg = os.environ.get("VECTORIZER_DEBUG")
    if dbg:
        os.makedirs(dbg, exist_ok=True)
        def _sv(name, a):
            Image.fromarray((a > 0).astype(np.uint8) * 255).save(os.path.join(dbg, name))
        _sv("sil.png", sil)
        _sv("outer.png", outer)
        _sv("inner.png", inner)
        _sv("whisk.png", whisk_raw)
        _sv("dark_clean.png", dark_clean)
        _sv("key2.png", key2)
        _sv("muz.png", muz_f)
        _sv("script_omit.png", script_omit)
        _sv("intlight.png", interior_light)
        _sv("arm_bite.png", arm_bite)
    return out, pal, {
        "keyline": True,
        "dark_i": di,
        "script": bool(int(script.sum()) > 0),
        "whisk": whisk_raw,
        "whisk_polylines": whisk_polylines or [],
        "whisk_thick": max(2, int(round(0.0017 * maxe))),
    }


def upsample_small(rgb, alpha, target=1000):
    """Edge-aware upsample of tiny client uploads before quantize/trace."""
    h, w = rgb.shape[:2]
    maxe = max(h, w)
    if maxe >= target or maxe >= 500:
        return rgb, alpha
    s = float(target) / float(maxe)
    nw, nh = int(round(w * s)), int(round(h * s))
    up = cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_CUBIC)
    au = cv2.resize(alpha, (nw, nh), interpolation=cv2.INTER_NEAREST)
    return up, au


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
    """If a real chromatic ink was dropped, put it back (bee red, blue nose, etc.)."""
    if not palette:
        return palette
    lab = to_lab(rgb)
    ch = chroma_map(lab)
    art = ~paper
    cents = lab_of_rgb(np.array(palette)).reshape(1, 1, -1, 3)
    diff = lab[:, :, None, :] - cents
    dmin = np.sqrt(np.sum(diff * diff, axis=3).min(axis=2))
    # Allow slightly busier edges so small accent inks (noses, wristbands) survive.
    far = art & (ch > min_chroma) & (dmin > 18) & (grad < 55)
    if int(far.sum()) < min_px:
        return palette
    # Cluster leftover chromatic pixels by 5-bit RGB
    pix = rgb[far]
    q = pix.astype(np.int32) >> 3
    keys, inv, counts = np.unique(q, axis=0, return_inverse=True, return_counts=True)
    # Prefer hue-distinct accents (blue nose) over more orange JPEG variants.
    scored = []
    for idx in range(len(counts)):
        if counts[idx] < min_px:
            continue
        mean = pix[inv == idx].mean(axis=0)
        la = lab_of_rgb([mean])[0]
        ch = chroma_of_lab(la)
        if ch < min_chroma:
            continue
        scored.append((idx, mean, la, ch, int(counts[idx])))
    out = list(palette)
    p_lab = [lab_of_rgb([c])[0] for c in out]

    def hue_sep(la):
        best = 1e9
        for existing in p_lab:
            if chroma_of_lab(existing) < 12:
                continue
            dh = abs(hue_of_lab(la) - hue_of_lab(existing))
            dh = min(dh, 2 * math.pi - dh)
            best = min(best, dh)
        return best if best < 1e8 else 1.0

    # Sort: large hue separation first, then chroma, then population.
    scored.sort(key=lambda t: (-hue_sep(t[2]), -t[3], -t[4]))
    for idx, mean, la, ch, n in scored:
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
        if len(out) >= len(palette) + 6:
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

def classify(rgb, paper, palette, rec_err, mode: str, paper_rgb=None, src_maxe=None) -> str:
    if mode in ("logo", "art", "poster"):
        return mode
    h, w = rgb.shape[:2]
    k = len(palette)
    # Prefer original upload size so tiny junk upsamples don't become "posters".
    maxe = int(src_maxe) if src_maxe is not None else max(h, w)
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


def vtracer_settings(maxe: int, kind: str, *, soft_flat: bool = False) -> dict:
    """General settings — size-based, not per-artwork."""
    # Keep thin keylines (tooth walls, foam, gothic serifs) at native poster res.
    if soft_flat:
        # Palette-snapped soft cartoons: do not re-invent JPEG greys/oranges.
        speckle = 12 if maxe < 1200 else 16
        return {
            "mode": "spline",
            "hierarchical": "stacked",
            "filter_speckle": str(speckle),
            "color_precision": "4",
            "gradient_step": "18",
            "corner_threshold": "60",
            "path_precision": "2",
        }
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


def vectorize_vtracer(
    rgb, paper_rgb, inches, kind, t0, h0, w0, rec_err, palette, *, soft_flat: bool = False
):
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
    settings = vtracer_settings(max(wh, ww), kind, soft_flat=soft_flat)
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
    polish_kind = "fair" if soft_flat else ("logo" if kind == "logo" else "fair")
    svg, polish_stats = polish_traced_svg(
        svg, kind=polish_kind, try_primitives=(kind == "logo" or soft_flat)
    )
    n_paths = len(re.findall(r"<path\b", svg, re.I)) or n_paths
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
        "soft_flat": bool(soft_flat),
        "polish": polish_stats,
    }
    return svg, meta


def slic_merge_assign(work, assign, pal, *, n_segments=400):
    """Majority-vote SLIC cells onto the ink map so Imagine parts stay islands.

    Protects thin dark (lum<50, width≤3) — whiskers / keylines must not vote away.
    """
    try:
        from skimage.segmentation import slic as _slic
    except Exception:
        return assign
    a = np.asarray(assign, dtype=np.int32)
    h, w = a.shape
    if h < 24 or w < 24 or not len(pal):
        return a
    dark = np.zeros((h, w), dtype=np.uint8)
    for i, c in enumerate(pal):
        if _is_keyline_ink(c):
            dark[a == i] = 1
    thin = np.zeros((h, w), dtype=bool)
    if int(dark.sum()) > 0:
        dist = cv2.distanceTransform(dark, cv2.DIST_L2, 3)
        thin = (dark > 0) & (dist <= 3.0)
    chroma_light = np.zeros((h, w), dtype=bool)
    for i, c in enumerate(pal):
        if lum(c) >= 80 and chroma_of_lab(lab_of_rgb([c])[0]) >= 20:
            chroma_light[a == i] = True
    nseg = int(max(80, min(int(n_segments), max(80, (h * w) // 400))))
    try:
        img = work.astype(np.float32) / 255.0
        if img.ndim == 2:
            img = np.stack([img, img, img], axis=-1)
        elif img.shape[-1] > 3:
            img = img[..., :3]
        seg = _slic(
            img,
            n_segments=nseg,
            compactness=12.0,
            start_label=1,
            channel_axis=-1,
            enforce_connectivity=True,
        )
    except Exception:
        return a
    out = a.copy()
    for lab in np.unique(seg):
        m = seg == lab
        if thin[m].mean() > 0.35:
            continue
        vals = a[m]
        ink_vals = vals[vals >= 0]
        if ink_vals.size < 8:
            continue
        # Superpixel is mostly paper — do not grow a halo around the figure.
        if ink_vals.size < 0.55 * vals.size:
            continue
        u, counts = np.unique(ink_vals, return_counts=True)
        maj = int(u[int(np.argmax(counts))])
        write = m & ~thin & (a >= 0)
        # Dark majority must not swallow gold cheeks / paw pads.
        if lum(pal[maj]) < 55:
            write = write & ~chroma_light
        out[write] = maj
    return out


def recast_miscolored_islands(work, assign, pal):
    """Recast a CC whose mean RGB is clearly closer to another ink (Imagine cheek blobs)."""
    if assign is None or not len(pal) or work is None:
        return assign
    a = np.asarray(assign, dtype=np.int32).copy()
    pal_f = [np.asarray(c, dtype=np.float32) for c in pal]
    rgb = np.asarray(work, dtype=np.float32)
    k = len(pal_f)
    for i in range(k):
        m = (a == i).astype(np.uint8)
        if int(m.sum()) < 40:
            continue
        n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=4)
        for li in range(1, n):
            area = int(stats[li, cv2.CC_STAT_AREA])
            if area < 40:
                continue
            ys, xs = np.where(labels == li)
            mean = rgb[ys, xs].mean(axis=0)
            dists = [float(np.linalg.norm(mean - c)) for c in pal_f]
            best = int(np.argmin(dists))
            if best == i:
                continue
            if dists[best] < 0.72 * max(dists[i], 1.0):
                a[labels == li] = best
    return a


def _soft_flat_assign(work, paper_w, pal, paper_rgb):
    assign, _ = assign_pixels(work, paper_w, pal, paper_rgb, paper_win=0.0)
    assign = despeckle(assign, pal, min_size=6)
    assign = fill_small_assign_holes(
        assign, pal, max_hole=max(40, int(0.00012 * assign.size))
    )
    min_fill = max(48, int(0.00014 * assign.size))
    assign = regularize_assign(assign, pal, win=3, min_fill=min_fill)
    assign = absorb_internal_shadows(assign, pal)
    assign = punch_border_strips(assign, thick_frac=0.028)
    assign = despeckle(assign, pal, min_size=max(10, int(0.00004 * assign.size)))
    # Shared-boundary vote, then SLIC so paw/muzzle/shirt stay islands.
    # Do not seal inks into paper — that grew a dark halo around Imagine art.
    assign = enforce_shared_edges(assign, pal, iters=3)
    assign = slic_merge_assign(work, assign, pal, n_segments=280)
    assign = merge_small_islands(
        assign, pal, min_size=max(80, int(0.00030 * assign.size))
    )
    assign = close_large_plates(assign, pal, ksize=3)
    assign = fill_small_assign_holes(
        assign, pal, max_hole=max(100, int(0.00028 * assign.size))
    )
    # Tight sandwiches only — a wide exterior-paper peel eats Imagine
    # muzzles/foreheads that sit near the sheet edge.
    assign = collapse_aa_rim(assign, pal, max_width=1.8)
    assign = despeckle(assign, pal, min_size=max(12, int(0.00005 * assign.size)))
    return assign


def compact_assign_palette(assign, pal):
    """Drop inks with no pixels after absorb so remap cannot revive them."""
    keep = []
    remap = {}
    for i, c in enumerate(pal):
        if int((assign == i).sum()) < 12:
            remap[i] = -1
            continue
        remap[i] = len(keep)
        keep.append(c)
    if not keep:
        return assign, pal
    out = np.full_like(assign, -1)
    for i, j in remap.items():
        if j >= 0:
            out[assign == i] = j
    return out, keep


def _soft_flat_raster(assign, pal, paper_rgb):
    out = np.full(
        (assign.shape[0], assign.shape[1], 3),
        np.clip(np.round(paper_rgb), 0, 255).astype(np.uint8),
    )
    for i, c in enumerate(pal):
        out[assign == i] = np.clip(np.round(c), 0, 255).astype(np.uint8)
    return out


def vectorize_soft_flat(rgb, paper, paper_rgb, inches, kind, t0, h0, w0, rec_err):
    """Snap smooth AI/illustration art to screenprint inks, then Vector-Graph trace."""
    work = flatten_soft_interiors(rgb, paper)
    h, w = work.shape[:2]
    cap = 900
    if max(h, w) > cap:
        s = cap / float(max(h, w))
        work = cv2.resize(
            work,
            (int(round(w * s)), int(round(h * s))),
            interpolation=cv2.INTER_AREA,
        )
        paper = cv2.resize(
            paper.astype(np.uint8),
            (work.shape[1], work.shape[0]),
            interpolation=cv2.INTER_NEAREST,
        ) > 0
        h, w = work.shape[:2]
    paper_w = paper
    pal = kmeans_screenprint_palette(work, paper_w, paper_rgb, max_k=12)
    if not pal:
        pal = [np.array([20.0, 20.0, 20.0])]
    pal = drop_paper_inks(pal, paper_rgb, thresh=10.0)
    if not pal:
        pal = [np.array([20.0, 20.0, 20.0])]

    assign = _soft_flat_assign(work, paper_w, pal, paper_rgb)
    assign, pal = compact_assign_palette(assign, pal)
    snapped = _soft_flat_raster(assign, pal, paper_rgb)
    adj = region_adjacency(assign)

    if w0 >= h0:
        width_in = float(inches)
        height_in = float(inches) * (h0 / float(w0))
    else:
        height_in = float(inches)
        width_in = float(inches) * (w0 / float(h0))

    up = 2 if max(h, w) < 1100 else 1
    if up > 1:
        assign_u = cv2.resize(
            assign.astype(np.int16),
            (w * up, h * up),
            interpolation=cv2.INTER_NEAREST,
        ).astype(np.int32)
        work_u = cv2.resize(work, (w * up, h * up), interpolation=cv2.INTER_LINEAR)
    else:
        assign_u = assign.astype(np.int32)
        work_u = work
    sx = width_in / assign_u.shape[1]
    sy = height_in / assign_u.shape[0]

    # PRIMARY: path-level Vector Graph (shared Béziers / knockout seams).
    try:
        layers, aux = vector_graph_layers(
            assign_u,
            pal,
            sx,
            sy,
            rgb=work_u,
            logo=False,
            try_primitives=True,
            min_area_px=16,
            gap_fill=True,
        )
        n_paths = sum(len(L["paths"]) for L in layers)
        cov = float(aux.get("coverage") or 0.0)
        if layers and n_paths >= 3 and cov >= 0.62 and not aux.get("too_sharded"):
            svg = svg_from_layers_with_gaps(
                layers,
                width_in,
                height_in,
                to_hex(paper_rgb),
                gap_strokes=aux.get("gap_strokes") or [],
            )
            # Do not polish: independent fairing would break shared-seam cubics.
            n_paths = len(re.findall(r"<path\b", svg, re.I))
            meta = {
                "engine": "decoclub-vector",
                "backend": "vector-graph",
                "mode": kind,
                "paths": n_paths,
                "colors": len(layers),
                "palette": [to_hex(c) for c in pal],
                "pixel": [w0, h0],
                "work": [w, h],
                "up": up,
                "inches": [width_in, height_in],
                "ms": int((time.time() - t0) * 1000),
                "paper": to_hex(paper_rgb),
                "overlay": False,
                "rec_err": round(float(rec_err), 2),
                "soft_flat": True,
                "keyline": False,
                "shared_edge": True,
                "adjacency": len(adj),
                "cracks": aux.get("cracks"),
                "loops": aux.get("loops"),
                "coverage": aux.get("coverage"),
                "vector_graph": "shared-seams",
                "primitives": aux.get("primitives"),
                "shared_seams": aux.get("shared_seams"),
                "polish": {},
            }
            return svg, meta
    except Exception as e:
        sys.stderr.write(f"vector_graph soft_flat failed: {e}\n")
        pass

    plates_svg = None
    plates_meta = None
    try:
        layers = []
        order = list(range(len(pal)))
        order.sort(key=lambda i: (-lum(pal[i]), -int((assign_u == i).sum())))
        for i in order:
            mask = (assign_u == i).astype(np.uint8)
            if int(mask.sum()) < 16:
                continue
            is_dark = lum(pal[i]) < 50
            paths = potrace_paths(
                mask,
                sx,
                sy,
                scale=1,
                alphamax=1.333 if is_dark else 1.0,
                opttol=0.14 if is_dark else 0.20,
                turdsize=1 if is_dark else 3,
                smooth=0.12 if is_dark else 0.18,
            )
            if not paths:
                continue
            layers.append(
                {
                    "hex": to_hex(pal[i]),
                    "name": layer_name(pal[i]),
                    "paths": paths,
                    "lum": lum(pal[i]),
                    "n": int(mask.sum()),
                }
            )
        if layers and sum(len(L["paths"]) for L in layers) >= 4:
            psvg = svg_from_layers(layers, width_in, height_in, to_hex(paper_rgb))
            psvg, polish_stats = polish_traced_svg(psvg, kind="logo", try_primitives=True)
            n_paths = len(re.findall(r"<path\b", psvg, re.I))
            plates_svg = psvg
            plates_meta = {
                "engine": "decoclub-vector",
                "backend": "potrace",
                "mode": kind,
                "paths": n_paths,
                "colors": len(layers),
                "palette": [to_hex(c) for c in pal],
                "pixel": [w0, h0],
                "work": [w, h],
                "up": up,
                "inches": [width_in, height_in],
                "ms": int((time.time() - t0) * 1000),
                "paper": to_hex(paper_rgb),
                "overlay": False,
                "rec_err": round(float(rec_err), 2),
                "soft_flat": True,
                "keyline": False,
                "shared_edge": True,
                "adjacency": len(adj),
                "vector_graph": "lite-plates",
                "polish": polish_stats,
            }
    except Exception:
        plates_svg = None
        plates_meta = None

    # Fallback: spline trace of the *snapped* shared-edge raster.
    try:
        settings = {
            "mode": "spline",
            "hierarchical": "stacked",
            "filter_speckle": "4",
            "color_precision": "8",
            "gradient_step": "64",
            "corner_threshold": "55",
            "path_precision": "2",
        }
        tmp = tempfile.mkdtemp(prefix="sflat-")
        try:
            png_p = os.path.join(tmp, "in.png")
            svg_p = os.path.join(tmp, "out.svg")
            Image.fromarray(snapped).save(png_p)
            run_vtracer(png_p, svg_p, settings)
            raw = open(svg_p, encoding="utf-8").read()
        finally:
            try:
                for fn in os.listdir(tmp):
                    os.remove(os.path.join(tmp, fn))
                os.rmdir(tmp)
            except Exception:
                pass
        svg, n_paths, vpal = wrap_vtracer_svg(raw, width_in, height_in)
        svg = remap_svg_fills_to_palette(svg, pal, paper_rgb)
        svg, polish_stats = polish_traced_svg(svg, kind="fair", try_primitives=True)
        fills = re.findall(r'fill="(#[0-9A-Fa-f]{3,8})"', svg)
        n_paths = len(re.findall(r"<path\b", svg, re.I))
        pal_out = []
        seen = set()
        for f in fills:
            u = f.upper()
            if u not in seen:
                seen.add(u)
                pal_out.append(u)
        meta = {
            "engine": "decoclub-vector",
            "backend": "vtracer",
            "mode": kind,
            "paths": n_paths,
            "colors": len(pal_out),
            "palette": pal_out[:24],
            "pixel": [w0, h0],
            "work": [w, h],
            "up": 1,
            "inches": [width_in, height_in],
            "ms": int((time.time() - t0) * 1000),
            "paper": to_hex(paper_rgb),
            "overlay": False,
            "rec_err": round(float(rec_err), 2),
            "vtracer": settings,
                        "soft_flat": True,
            "keyline": False,
            "shared_edge": True,
            "adjacency": len(adj),
            "vector_graph": "lite-snap",
            "polish": polish_stats,
        }
        return svg, meta
    except Exception:
        pass

    if plates_svg is not None and plates_meta is not None:
        plates_meta["ms"] = int((time.time() - t0) * 1000)
        return plates_svg, plates_meta

    # Last-resort potrace plates on hard cells (up / assign_u already set above).
    layers = []
    order = list(range(len(pal)))
    order.sort(key=lambda i: (-lum(pal[i]), -int((assign_u == i).sum())))
    for i in order:
        mask = (assign_u == i).astype(np.uint8)
        if int(mask.sum()) < 16:
            continue
        is_dark = lum(pal[i]) < 50
        paths = potrace_paths(
            mask,
            sx,
            sy,
            scale=1,
            alphamax=1.333 if is_dark else 1.0,
            opttol=0.14 if is_dark else 0.22,
            turdsize=1 if is_dark else 4,
            smooth=0.15 if is_dark else 0.22,
        )
        if not paths:
            continue
        layers.append(
            {
                "hex": to_hex(pal[i]),
                "name": layer_name(pal[i]),
                "paths": paths,
                "lum": lum(pal[i]),
                "n": int(mask.sum()),
            }
        )
    svg = svg_from_layers(layers, width_in, height_in, to_hex(paper_rgb))
    svg, polish_stats = polish_traced_svg(svg, kind="fair", try_primitives=True)
    n_paths = sum(len(L["paths"]) for L in layers)
    n_paths = len(re.findall(r"<path\b", svg, re.I)) or n_paths
    meta = {
        "engine": "decoclub-vector",
        "backend": "potrace",
        "mode": kind,
        "paths": n_paths,
        "colors": len(layers),
        "palette": [to_hex(c) for c in pal],
        "pixel": [w0, h0],
        "work": [w, h],
        "up": up,
        "inches": [width_in, height_in],
        "ms": int((time.time() - t0) * 1000),
        "paper": to_hex(paper_rgb),
        "overlay": False,
        "rec_err": round(float(rec_err), 2),
        "soft_flat": True,
        "keyline": False,
        "shared_edge": True,
        "vector_graph": "fallback-plates",
        "polish": polish_stats,
    }
    return svg, meta


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def vectorize(path: str, inches: float = 10.0, colors=None, mode: str = "auto"):
    t0 = time.time()
    rgb0, alpha0 = load_rgba(path)
    h0, w0 = rgb0.shape[:2]
    src_score = junk_raster_score(rgb0)
    # Score the ORIGINAL upload only — cubic upsample invents colors and must not
    # flip clean logos (bee) into the junk-JPEG recipe.
    noisy = src_score >= 12.0

    # Tiny junk uploads: upsample BEFORE paper/palette so flats exist to cluster.
    # Palette stays near 1000px (1800px denoise merged bandana red into body).
    # Hair-thin strokes are recovered later by a junk-mascot keyline upsample.
    rgb_work, alpha_work = rgb0, alpha0
    if noisy and max(h0, w0) < 500:
        rgb_work, alpha_work = upsample_small(rgb0, alpha0, target=1000)

    # Working resolution: downsample huge posters.
    cap = 1200
    rgb, alpha = rgb_work, alpha_work
    if max(rgb.shape[0], rgb.shape[1]) > cap:
        s = cap / max(rgb.shape[0], rgb.shape[1])
        rgb = cv2.resize(
            rgb_work,
            (int(round(rgb_work.shape[1] * s)), int(round(rgb_work.shape[0] * s))),
            interpolation=cv2.INTER_AREA,
        )
        alpha = cv2.resize(alpha_work, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_NEAREST)
    h, w = rgb.shape[:2]

    paper, paper_rgb = detect_paper(rgb, alpha)
    rgb, paper, paper_rgb = flatten_alpha(rgb, alpha, paper, paper_rgb)
    grad = gradient_mag(rgb)
    # Edge-preserving copy for junk-mascot keylines (median on flats eats whiskers).
    # Rebuild from the original raster with Lanczos so thin strokes aren't
    # interpolated from the palette-work cubic. Unsharp runs after upsample.
    if noisy:
        src_e = rgb0
        if src_e.shape[:2] != rgb.shape[:2]:
            src_e = cv2.resize(
                rgb0, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_LANCZOS4
            )
        try:
            rgb_edge = cv2.edgePreservingFilter(src_e, flags=1, sigma_s=48, sigma_r=0.38)
        except Exception:
            rgb_edge = cv2.bilateralFilter(src_e, 9, 60, 60)
    else:
        rgb_edge = rgb
    rgb = denoise_jpeg(rgb, paper, grad, force=noisy)
    grad = gradient_mag(rgb)
    rgb, paper = punch_sheet_dirt(rgb, paper, paper_rgb, grad=grad)
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
        elif noisy and max(h0, w0) < 600:
            max_k, min_k, merge = 10, 3, 18.0
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
    if noisy:
        palette = refine_flat_palette(palette, paper_rgb, noisy=True)
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
    kind = classify(rgb_q, paper_q, palette, rec_err, mode, paper_rgb=paper_rgb, src_maxe=max(h0, w0))

    if kind == "logo":
        # Rebuild with a tight merge so AA doesn't mint three near-black outlines.
        logo_k = 6 if noisy else 4
        palette = build_palette(
            rgb_q, paper_q, grad_q, max_k=logo_k, min_k=2, merge_thresh=22.0 if noisy else 20.0
        )
        palette = inject_missing_inks(rgb_q, paper_q, palette, grad_q)
        palette = drop_paper_inks(
            palette, paper_rgb, thresh=14.0 if lum(paper_rgb) >= 200 else 8.0
        )
        if noisy:
            # Dirt merge + warm collapse, then accents (blue), then collapse warms again.
            palette = refine_flat_palette(palette, paper_rgb, noisy=True)
            palette = inject_missing_inks(rgb_q, paper_q, palette, grad_q, min_chroma=16.0, min_px=16)
            palette = drop_paper_inks(palette, paper_rgb, thresh=12.0 if lum(paper_rgb) >= 200 else 8.0)
            palette = refine_flat_palette(palette, paper_rgb, noisy=True)
        else:
            # Clean logos: mild refine + fringe fold so AA cannot mint a 3rd navy.
            palette = refine_flat_palette(palette, paper_rgb, noisy=False)
            palette = collapse_logo_fringe(palette, paper_rgb)
        palette = collapse_logo_fringe(palette, paper_rgb)
        if not palette:
            palette = [np.array([20.0, 20.0, 20.0])]

    # Art / poster: vtracer spline on a flattened, size-capped raster.
    # Logos stay palette-snap + potrace (vtracer invents AA inks on 2-color marks).
    # Noisy light-sheet soft cartoons: snap to flats then potrace (not raw vtracer).
    if kind != "logo":
        rgb_full, alpha_full = rgb_work, alpha_work
        paper_f, paper_rgb_f = detect_paper(rgb_full, alpha_full)
        rgb_full, paper_f, paper_rgb_f = flatten_alpha(
            rgb_full, alpha_full, paper_f, paper_rgb_f
        )
        grad_f = gradient_mag(rgb_full)
        noisy_f = noisy
        # Detect on the flattened original. Denoise collapses unique-color count
        # and would miss smooth AI gradients.
        soft_flat = is_soft_flat_illustration(rgb_full, paper_f, paper_rgb_f)
        rgb_full = denoise_jpeg(rgb_full, paper_f, grad_f, force=noisy_f)
        grad_f = gradient_mag(rgb_full)
        rgb_full, paper_f = punch_sheet_dirt(rgb_full, paper_f, paper_rgb_f, grad=grad_f)
        # Soft-flat AI/illustration: snap to 8–16 inks then potrace. Must run
        # before raw vtracer (which invents thousands of near-colors on gradients).
        if soft_flat:
            return vectorize_soft_flat(
                rgb_full,
                paper_f,
                paper_rgb_f,
                inches,
                kind,
                t0,
                h0,
                w0,
                rec_err,
            )
        if noisy_f and lum(paper_rgb_f) >= 200:
            pal_f = list(palette)
            if len(pal_f) < 3 or len(pal_f) > 12:
                g2 = gradient_mag(rgb_full)
                pal_f = build_palette(rgb_full, paper_f, g2, max_k=10, min_k=3, merge_thresh=18.0)
                pal_f = inject_missing_inks(rgb_full, paper_f, pal_f, g2)
                pal_f = drop_paper_inks(pal_f, paper_rgb_f, thresh=16.0)
                pal_f = refine_flat_palette(pal_f, paper_rgb_f, noisy=True)
            if pal_f:
                rgb_full = snap_to_palette(
                    rgb_full,
                    paper_f,
                    pal_f,
                    paper_rgb_f,
                    paper_win=1.12,
                    despeckle_min=max(16, int(0.00008 * rgb_full.shape[0] * rgb_full.shape[1])),
                )
                # Fall through to potrace plates on hard flats.
                rgb_q = rgb_full
                paper_q = paper_f
                paper_rgb = paper_rgb_f
                grad_q = gradient_mag(rgb_q)
                palette = pal_f
                kind = "logo"
                h, w = rgb_q.shape[:2]
                rgb_edge = cv2.bilateralFilter(rgb_full, 7, 50, 50)
        if kind != "logo":
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
                    soft_flat=False,
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
    # Junk light-sheet mascots: trace at ≥1800px so whiskers/keylines are cubics.
    if (
        noisy
        and kind == "logo"
        and lum(paper_rgb) >= 200
        and max(h, w) < 1600
    ):
        up_scale = max(up_scale, int(math.ceil(1800.0 / float(max(h, w)))))

    if up_scale > 1:
        # Linear on junk (not nearest) so silhouette stairs don't get 2× blockier.
        # Cubic stays for clean logos; cubic-on-junk re-invents JPEG greys.
        interp = cv2.INTER_LINEAR if noisy else cv2.INTER_CUBIC
        up = cv2.resize(
            rgb_q, (w * up_scale, h * up_scale), interpolation=interp
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
        rgb_edge_up = cv2.resize(
            rgb_edge, (up.shape[1], up.shape[0]), interpolation=cv2.INTER_CUBIC
        )
    else:
        up, paper_up, grad_up = rgb_q, paper_q, grad_q
        rgb_edge_up = rgb_edge
        if rgb_edge_up.shape[:2] != up.shape[:2]:
            rgb_edge_up = cv2.resize(
                rgb_edge, (up.shape[1], up.shape[0]), interpolation=cv2.INTER_CUBIC
            )
    if noisy and kind == "logo" and lum(paper_rgb) >= 200:
        # Lanczos the original to trace res. Edge-preserving at work res eats
        # hair-thin whiskers; cubic-of-EP cannot put them back.
        rgb_edge_up = cv2.resize(
            rgb0, (up.shape[1], up.shape[0]), interpolation=cv2.INTER_LANCZOS4
        )
        rgb_edge_up = _unsharp(rgb_edge_up, 0.95, 1.55)

    paper_win = (1.12 if noisy else 1.06) if kind == "logo" and lum(paper_rgb) >= 200 else 0.0
    assign, _ = assign_pixels(up, paper_up, palette, paper_rgb, paper_win=paper_win)
    if kind == "logo" and lum(paper_rgb) >= 200:
        assign = punch_near_paper(assign, palette, paper_rgb, max_dist=28.0 if noisy else 10.0)
        if noisy:
            for i, c in enumerate(palette):
                la = lab_of_rgb([c])[0]
                if chroma_of_lab(la) < 18 and lum(c) > 130:
                    assign[assign == i] = -1
            # Tiny red speckles only (not bandana): fold into orange body.
            orange_i = None
            for j, oc in enumerate(palette):
                rr, gg, bb = [float(x) for x in oc]
                if rr > 140 and (rr - bb) > 50 and gg > 55 and lum(oc) > 85:
                    orange_i = j
                    break
            if orange_i is not None:
                for i, c in enumerate(palette):
                    r, g, b = [float(x) for x in c]
                    if not (r > 140 and r > b + 35 and lum(c) >= 50):
                        continue
                    mask = (assign == i).astype(np.uint8)
                    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
                    for li in range(1, n):
                        area = int(stats[li, cv2.CC_STAT_AREA])
                        if area < max(30, int(0.004 * mask.size)):
                            assign[labels == li] = orange_i

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
    keylined = False
    whisk_m = None
    kmeta = None
    if is_junk_mascot(noisy, kind, paper_rgb, palette):
        assign, palette, kmeta = apply_junk_mascot_keyline(rgb_edge_up, assign, palette)
        keylined = bool(kmeta)
        if kmeta:
            whisk_m = kmeta.get("whisk")
    if not keylined:
        assign = despeckle(assign, palette, min_size=speckle)
    # Shared-edge cleanup after flats settle. Keyline owns dark topology —
    # still peel light AA rims (gold halo) and merge tiny non-dark islands.
    mw = max(3.2, 0.008 * max(assign.shape))
    if not keylined:
        assign = enforce_shared_edges(assign, palette, iters=2 if kind == "logo" else 3)
        assign = collapse_aa_rim(assign, palette, max_width=mw)
        if kind == "logo":
            assign = split_dark_necks(assign, palette)
            assign = tuck_dark_over_light(assign, palette, radius=1)
            assign = merge_small_islands(
                assign, palette, min_size=max(14, int(0.00004 * assign.size))
            )
    else:
        assign = collapse_aa_rim(assign, palette, max_width=mw)
        assign = merge_small_islands(
            assign, palette, min_size=max(28, int(0.00008 * assign.size))
        )
    if kind != "logo":
        assign, palette = collapse_aa_inks(assign, palette, grad_up, min_keep=4 if kind == "art" else 8)
    # Junk soft-JPEG logos: keep intentional screenprint inks. Recolor averages
    # soft shadows into the bandana slot and turns #e91a25 → muddy #920201.
    if not (noisy and kind == "logo"):
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

    # Path-level Vector Graph (shared seams / knockout).
    # Keylined junk mascots: keyline is already unioned into the dark ink;
    # try the graph first (no primitive swap on whiskers). Fall through to
    # potrace plates if coverage fails so finger/whiskers survive.
    if kind == "logo" and glyph is None and ov_mask is None:
        try:
            glayers, gaux = vector_graph_layers(
                assign.astype(np.int32),
                palette,
                sx,
                sy,
                rgb=rgb_edge_up if rgb_edge_up is not None else up,
                logo=True,
                try_primitives=(not keylined),
                min_area_px=max(4 if keylined else 10, int(0.00003 * assign.size)),
                gap_fill=True,
            )
            gpaths = sum(len(L["paths"]) for L in glayers)
            cov = float(gaux.get("coverage") or 0.0)
            if (
                glayers
                and gpaths >= 2
                and cov >= (0.55 if keylined else 0.62)
                and not gaux.get("too_sharded")
            ):
                paper_hex = to_hex(paper_rgb)
                overlay = []
                if keylined and kmeta:
                    di = kmeta.get("dark_i")
                    dark_hex = to_hex(palette[di]) if di is not None else "#000000"
                    overlay = _overlay_strokes_from_polylines(
                        kmeta.get("whisk_polylines") or [],
                        sx,
                        sy,
                        dark_hex,
                        kmeta.get("whisk_thick") or 2,
                    )
                svg = svg_from_layers_with_gaps(
                    glayers,
                    width_in,
                    height_in,
                    paper_hex,
                    gap_strokes=gaux.get("gap_strokes") or [],
                    overlay_strokes=overlay,
                )
                n_paths = len(re.findall(r"<path\b", svg, re.I)) or gpaths
                meta = {
                    "engine": "decoclub-vector",
                    "backend": "vector-graph",
                    "mode": kind,
                    "paths": n_paths,
                    "colors": len(glayers),
                    "palette": [to_hex(c) for c in palette],
                    "pixel": [w0, h0],
                    "work": [w, h],
                    "up": up_scale,
                    "inches": [width_in, height_in],
                    "ms": int((time.time() - t0) * 1000),
                    "paper": paper_hex,
                    "overlay": bool(overlay is not None),
                    "rec_err": round(rec_err, 2),
                    "keyline": bool(keylined),
                    "shared_edge": True,
                    "cracks": gaux.get("cracks"),
                    "loops": gaux.get("loops"),
                    "coverage": gaux.get("coverage"),
                    "vector_graph": "shared-seams",
                    "primitives": gaux.get("primitives"),
                    "shared_seams": gaux.get("shared_seams"),
                    "polish": {},
                }
                return svg, meta
        except Exception as e:
            sys.stderr.write(f"vector_graph logo failed: {e}\n")
            pass

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
        is_dark = lum(palette[i]) < 50
        if noisy and kind == "logo" and lum(palette[i]) > 45 and not keylined:
            min_a = max(24, int(0.0002 * assign.size))
            mask = clean_fill_mask(
                mask.astype(np.uint8),
                min_area=min_a,
                close_k=5 if chroma_of_lab(lab_of_rgb([palette[i]])[0]) > 18 else 3,
                open_k=2,
            )
        if keylined and is_dark:
            bulky = mask.astype(np.uint8)
            if whisk_m is not None:
                bulky = bulky.copy()
                bulky[whisk_m > 0] = 0
            rec = emit(
                bulky,
                palette[i],
                alphamax=1.333,
                opttol=0.24,
                turdsize=2,
                smooth=0.45,
            )
            if rec:
                layers.append(rec)
            if whisk_m is not None and int(np.asarray(whisk_m).sum()) > 8:
                wrec = emit(
                    whisk_m,
                    palette[i],
                    alphamax=1.333,
                    opttol=0.08,
                    turdsize=1,
                    smooth=0.0,
                )
                if wrec:
                    layers.append(wrec)
            continue
        else:
            rec = emit(
                mask,
                palette[i],
                alphamax=amax,
                opttol=0.18 if kind == "logo" else 0.22,
                turdsize=max(2, (speckle // 3 if noisy else speckle // 4)),
                smooth=0.85 if (noisy and kind == "logo" and not keylined) else logo_smooth,
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
    # Keylined mascots: skip SVG fairing — compound whisker/keyline paths melt.
    polish_stats = {}
    if not keylined:
        polish_kind = "logo" if kind == "logo" else "fair"
        svg, polish_stats = polish_traced_svg(
            svg, kind=polish_kind, try_primitives=(kind == "logo")
        )
    n_paths = len(re.findall(r"<path\b", svg, re.I)) or sum(len(L["paths"]) for L in layers)
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
        "keyline": bool(keylined),
        "shared_edge": (not keylined),
        "polish": polish_stats,
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
