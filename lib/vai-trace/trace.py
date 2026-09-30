#!/usr/bin/env python3
"""
DecoClub Pro local raster→SVG engine.

General pipeline (no per-artwork paste / no filename branches):
  1. Classify logo / art / poster from size, flats, and palette.
  2. Paper flood, true-alpha flatten; junk-JPEG dens score gates stronger
     denoise / upsample / sheet-dirt merge / warm-flat collapse.
  3. Logo: Lab palette snap, color-preserving upsample, evenodd holes, potrace.
     Crumb-noisy JPEGs are solidified first (fringe dissolved, crumbs dropped,
     bulky edges snapped). Clean marks and keylined mascots are unchanged.
     Junk light-sheet mascots: Lanczos upsample + edge-preserve, then an
     even distance-field keyline (no JPEG stairs), muzzle ridges for
     whiskers, and assigned-dark specks folded away. White chests are fills.
  4. Soft-flat AI/illustration (smooth shading, few semantic regions, many
     unique gradient colors): k-means screenprint inks (8–16), snap the
     raster, regularize cells, potrace plates. Raw vtracer invents thousands
     of near-colors on ChatGPT/Grok Imagine art.
  5. Plate posters (Canva / screenprint / already-quantized JPEGs): many AA
     unique colors but locally flat cells. Overlay unmix (landscape inpaint
     of high-chroma structure, grey veil α) → Vector Graph on the unmixed
     high-chroma field. The closed eye is the enclosed grey hole. The open
     socket is an ellipse fit to that side's own grey rim (not a copy of
     the closed eye). Tooth walls are the luminance-gated mouth bone after
     a short vertical opening, evenodd fill. Frame is the overlay_support
     circle. Not a spur-walk, not a skeleton-dilate, not a polar-max, not
     a watershed, not a skull-wide plate. Gothic glyphs with a chromatic
     halo stay corner-traced polygons on top. Veil is punched on the
     emitted walls.
  6. Art / poster: vtracer spline on a size-capped flattened raster
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
    lv = lum(c)
    ch = chroma_of_lab(lab_of_rgb([c])[0])
    if lv < 42 and ch < 20:
        return True
    # Cool near-black keylines (Dirt Devils #292b2f lum≈42.9, ch≈3).
    # Narrow band: do not admit brown/orange darks in the raised ceiling.
    return lv < 44 and ch < 10


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


def is_plate_poster(rgb, paper, paper_rgb) -> bool:
    """Canva / screenprint plates: many AA colors, locally flat cells.

    Dark sheets allowed (union badges). Distinct from Imagine soft-flat
    (smooth mid-gradient shading — that path already matches
    is_soft_flat_illustration) and from fur/photos (high 8×8 luma std).
    Few-color logos never reach this gate (classified first).
    """
    art = ~paper
    if float(art.mean()) < 0.08:
        return False
    nuniq = unique_color_bins(rgb, 3)
    if nuniq < 900:
        return False
    p50 = cell_luma_p50(rgb, paper)
    if p50 > 14.0:
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

    Paper counters (eye whites, letter holes) are not overwritten by the ink
    vote. Light fills may only pull EXTERIOR paper (silhouette hairlines);
    dark keylines may still tuck into paper. Soft AA that snaps to a wing/sky
    ink otherwise grows concentric rings into interior paper holes.
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
        ink_pix = c >= 0
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
            # Do not overwrite paper here — paper→ink is gated below.
            better = differ & ink_pix & present & (score > best_score)
            best_score[better] = score[better]
            best_lab[better] = lab
        # Paper pixels at ink/paper fringe: if neighborhood ink majority exists, pull into that ink
        # (closes 1px hairlines). Only when >=3 of 5 votes are the same ink.
        # Light fills: exterior paper only (keep eye/counter holes). Dark may tuck anywhere.
        paper = c < 0
        fringe = differ & paper
        if fringe.any():
            ext = _exterior_paper_mask(out)
            for lab in range(n_ink):
                cnt = np.zeros((h, w), dtype=np.float32)
                for plane in stack:
                    cnt += (plane == lab).astype(np.float32)
                use = fringe if float(lums[lab]) < 72.0 else (fringe & ext)
                strong = use & (cnt >= 3)
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


def protect_interior_light_holes(assign, palette, rgb, paper_rgb):
    """Punch light-ink islands trapped inside interior paper (eye rings).

    Soft AA midtones near a pupil/keyline can snap to a cool wing/sky ink;
    shared-edge cleanup then grows concentric rings into eye whites. Any CC
    that touches exterior/background paper is kept (wings, body flats).
    """
    if assign is None or not len(palette) or rgb is None:
        return assign
    a = np.asarray(assign, dtype=np.int32).copy()
    h, w = a.shape
    if h < 8 or w < 8 or rgb.shape[:2] != (h, w):
        return a
    if lum(paper_rgb) < 180:
        return a
    ext = _exterior_paper_mask(a)
    ker = np.ones((3, 3), np.uint8)
    p_lab = lab_of_rgb([paper_rgb])[0]
    max_area = int(0.02 * h * w)
    for i, col in enumerate(palette):
        if lum(col) < 72.0:
            continue
        mask = (a == i).astype(np.uint8)
        if int(mask.sum()) == 0:
            continue
        n, lab, st, _ = cv2.connectedComponentsWithStats(mask, connectivity=4)
        i_lab = lab_of_rgb([col])[0]
        for li in range(1, n):
            area = int(st[li, cv2.CC_STAT_AREA])
            if area < 6 or area > max_area:
                continue
            comp = lab == li
            dil = cv2.dilate(comp.astype(np.uint8), ker) > 0
            # Touches exterior paper → silhouette / wing; keep.
            if bool((dil & ext).any()):
                continue
            border = dil & ~comp
            neigh = a[border]
            if neigh.size == 0:
                continue
            paper_b = float((neigh < 0).mean())
            dark_b = 0.0
            for j, cc in enumerate(palette):
                if lum(cc) < 72.0:
                    dark_b += float((neigh == j).mean())
            if paper_b + dark_b < 0.65:
                continue
            cols = rgb[comp]
            step = max(1, len(cols) // 80)
            sample = cols[::step]
            labs = lab_of_rgb(sample)
            dp = float(np.sqrt(((labs - p_lab) ** 2).sum(-1)).mean())
            di = float(np.sqrt(((labs - i_lab) ** 2).sum(-1)).mean())
            mean_l = float(np.mean([lum(x) for x in sample]))
            if mean_l >= 130.0 and (paper_b >= 0.30 or dp <= di + 15.0):
                a[comp] = -1
    return a


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


def merge_small_islands(assign, palette, *, min_size=48, protect_thin_dark=True, keep_light_holes=False):
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
            maj = int(u[int(np.argmax(cnt))])
            # Light hole in a darker plate (tooth windows, water foam).
            if (
                keep_light_holes
                and maj >= 0
                and lab >= 0
                and area >= 6
                and lum(palette[lab]) >= lum(palette[maj]) + 16.0
            ):
                continue
            a[comp] = maj
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
            _ellipse_d,
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
            _ellipse_d,
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
        "ellipse_d": _ellipse_d,
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


def _sample_lab_bilinear(labs, x, y):
    """Sub-pixel Lab sample. Crack coords are pixel-corner; Lab is pixel-center."""
    h, w = labs.shape[:2]
    px = float(np.clip(x - 0.5, 0.0, w - 1.001))
    py = float(np.clip(y - 0.5, 0.0, h - 1.001))
    x0 = int(math.floor(px))
    y0 = int(math.floor(py))
    x1 = min(x0 + 1, w - 1)
    y1 = min(y0 + 1, h - 1)
    fx = px - x0
    fy = py - y0
    return (
        (1.0 - fx) * (1.0 - fy) * labs[y0, x0]
        + fx * (1.0 - fy) * labs[y0, x1]
        + (1.0 - fx) * fy * labs[y1, x0]
        + fx * fy * labs[y1, x1]
    )


def _sample_scalar_bilinear(field, x, y):
    h, w = field.shape[:2]
    px = float(np.clip(x - 0.5, 0.0, w - 1.001))
    py = float(np.clip(y - 0.5, 0.0, h - 1.001))
    x0 = int(math.floor(px))
    y0 = int(math.floor(py))
    x1 = min(x0 + 1, w - 1)
    y1 = min(y0 + 1, h - 1)
    fx = px - x0
    fy = py - y0
    return float(
        (1.0 - fx) * (1.0 - fy) * field[y0, x0]
        + fx * (1.0 - fy) * field[y0, x1]
        + (1.0 - fx) * fy * field[y1, x0]
        + fx * fy * field[y1, x1]
    )


def subpixel_snap_crack(
    pts, rgb, pal, ink_a, ink_b, *, max_shift: float = 0.65, iso_fields=None
):
    """Push crack vertices to coverage≈0.5 between ink_a and ink_b in original RGB.

    `iso_fields` maps ink index → float membership; those cracks snap to the
    0.5 iso of that field (bone coverage) instead of Lab argmax.
    """
    if pts is None or len(pts) < 2:
        return pts
    iso_fields = iso_fields or {}
    field = None
    shift = float(max_shift)
    if ink_a in iso_fields:
        field = iso_fields[ink_a]
        shift = max(shift, 1.15)
    elif ink_b in iso_fields:
        field = iso_fields[ink_b]
        shift = max(shift, 1.15)
    labs = to_lab(rgb) if rgb is not None else None
    out = []

    def lab_of(idx):
        if idx is None or idx < 0 or pal is None:
            return None
        if idx >= len(pal):
            return None
        return lab_of_rgb([pal[idx]])[0]

    la = lab_of(ink_a)
    lb = lab_of(ink_b)
    n_samp = 11 if field is not None else 9
    for i, (x, y) in enumerate(pts):
        if i == 0:
            tx, ty = pts[1][0] - x, pts[1][1] - y
        elif i == len(pts) - 1:
            tx, ty = x - pts[i - 1][0], y - pts[i - 1][1]
        else:
            tx = pts[i + 1][0] - pts[i - 1][0]
            ty = pts[i + 1][1] - pts[i - 1][1]
        L = math.hypot(tx, ty) or 1.0
        nx, ny = (-ty / L), (tx / L)
        best_t = 0.0
        best_score = 1e18
        if field is not None:
            for k in range(-n_samp, n_samp + 1):
                t = (k / float(n_samp)) * shift
                v = _sample_scalar_bilinear(field, x + nx * t, y + ny * t)
                score = abs(v - 0.5)
                if score < best_score:
                    best_score = score
                    best_t = t
        elif labs is not None and la is not None and lb is not None:
            for k in range(-n_samp, n_samp + 1):
                t = (k / float(n_samp)) * shift
                pl = _sample_lab_bilinear(labs, x + nx * t, y + ny * t)
                da = float(np.sum((pl - la) ** 2))
                db = float(np.sum((pl - lb) ** 2))
                score = abs(da - db)
                if score < best_score:
                    best_score = score
                    best_t = t
        elif labs is not None:
            for k in range(-n_samp, n_samp + 1):
                t = (k / float(n_samp)) * shift
                pl = _sample_lab_bilinear(labs, x + nx * t, y + ny * t)
                if ink_a >= 0 and la is not None:
                    score = float(np.sum((pl - la) ** 2))
                elif ink_b >= 0 and lb is not None:
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


class _Pt:
    __slots__ = ("x", "y")

    def __init__(self, x, y):
        self.x = float(x)
        self.y = float(y)


class _PolyView:
    """Shapely-free polygon duck-type for face area / ink tests."""

    __slots__ = ("ring", "area", "length", "bounds", "is_valid", "is_empty")

    def __init__(self, ring):
        pts = list(ring)
        if len(pts) >= 2 and pts[0] != pts[-1]:
            pts.append(pts[0])
        self.ring = pts
        a = 0.0
        peri = 0.0
        for i in range(len(pts) - 1):
            x0, y0 = pts[i]
            x1, y1 = pts[i + 1]
            a += x0 * y1 - x1 * y0
            peri += math.hypot(x1 - x0, y1 - y0)
        self.area = abs(a) * 0.5
        self.length = peri
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        self.bounds = (min(xs), min(ys), max(xs), max(ys))
        self.is_valid = True
        self.is_empty = self.area < 1.0

    def representative_point(self):
        n = max(1, len(self.ring) - 1)
        cx = sum(p[0] for p in self.ring[:-1]) / n
        cy = sum(p[1] for p in self.ring[:-1]) / n
        if self.contains(_Pt(cx, cy)):
            return _Pt(cx, cy)
        minx, miny, maxx, maxy = self.bounds
        return _Pt(0.5 * (minx + maxx), 0.5 * (miny + maxy))

    def contains(self, pt):
        x = float(getattr(pt, "x", pt[0] if not isinstance(pt, (int, float)) else pt))
        y = float(getattr(pt, "y", pt[1] if not isinstance(pt, (int, float)) else 0.0))
        if hasattr(pt, "x"):
            x, y = float(pt.x), float(pt.y)
        ring = self.ring
        inside = False
        j = len(ring) - 2
        for i in range(len(ring) - 1):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if ((yi > y) != (yj > y)) and (
                x < (xj - xi) * (y - yi) / ((yj - yi) + 1e-12) + xi
            ):
                inside = not inside
            j = i
        return inside

    def buffer(self, _d):
        return self

    def symmetric_difference(self, other):
        out = _PolyView.__new__(_PolyView)
        out.ring = self.ring
        out.area = float(self.area) + float(getattr(other, "area", 0.0))
        out.length = float(self.length) + float(getattr(other, "length", 0.0))
        out.bounds = self.bounds
        out.is_valid = True
        out.is_empty = out.area < 1.0
        return out


def _face_poly(chain, cracks):
    """Polygon for a closed crack chain (shapely when present, else _PolyView)."""
    ring = _ring_points_from_cracks(chain, cracks)
    if len(ring) < 4:
        return None
    if ring[0] != ring[-1]:
        ring = list(ring) + [ring[0]]
    try:
        from shapely.geometry import Polygon

        poly = Polygon(ring)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty or poly.area < 4.0:
            return None
        return poly
    except Exception:
        pv = _PolyView(ring)
        if pv.is_empty or pv.area < 4.0:
            return None
        return pv


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
    a = np.asarray(assign, dtype=np.int32)
    h, w = a.shape
    xs = np.linspace(minx + 0.4, maxx - 0.4, int(n))
    ys = np.linspace(miny + 0.4, maxy - 0.4, int(n))
    hit = tot = 0
    _Point = None
    try:
        from shapely.geometry import Point as _Point
    except Exception:
        _Point = None
    for y in ys:
        for x in xs:
            try:
                if isinstance(poly, _PolyView) or _Point is None:
                    if not poly.contains(_Pt(float(x), float(y))):
                        continue
                else:
                    if not poly.contains(_Point(float(x), float(y))):
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
    destair_leg: float = 6.0,
    iso_fields=None,
    stroke_dark: bool = True,
    keep_thin_light: bool = False,
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
            pts = Gpre["destaircase"](pts, max_leg=float(destair_leg), closed=closed0)
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

    # Sub-pixel snap using original RGB / coverage fields when available
    if rgb is not None or iso_fields:
        snapped = []
        for c in cracks:
            pts = subpixel_snap_crack(
                c["pts"],
                rgb,
                palette,
                c["left"],
                c["right"],
                max_shift=0.65,
                iso_fields=iso_fields,
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
            if logo:
                continue
            # Face walk missed this ink (shapely-less / wrapping cycles).
            # Potrace the snapped mask so posters don't go coverage=0.
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
            if not ptr:
                continue
            rec = {
                "hex": to_hex(palette[ink]),
                "name": layer_name(palette[ink]),
                "paths": ptr,
                "lum": lum(palette[ink]),
                "n": area,
            }
            if stroke_dark and lum(palette[ink]) < 50:
                rec["stroke"] = True
                rec["sw"] = 1.25 * 0.5 * (sx + sy)
            layers.append(rec)
            graph_area += float(area)
            continue
        ds = []
        acc = None
        light_ink = lum(palette[ink]) >= 180
        face_floor = 2.5 if (keep_thin_light and light_ink) else max(8.0, min_area_px * 0.5)
        for chain, poly in recs:
            if poly.area < face_floor:
                continue
            # Light-ink AA ribbons around a dark keyline (puma gold halo).
            # Keep thin DARK (whiskers). 4*area/peri ≈ twice the width.
            # keep_thin_light: cream highlight chips and brush hairs must stay.
            try:
                peri = float(poly.length)
                width = 4.0 * float(poly.area) / (peri + 1e-6)
            except Exception:
                width = 99.0
            if (
                not keep_thin_light
                and lum(palette[ink]) >= 55
                and width < 2.6
                and float(poly.area) < 0.015 * a.size
            ):
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
        # Callers tracing screenprint type pass stroke_dark=False so the stroke
        # cannot swallow cream highlight chips sitting on the keyline.
        if stroke_dark and lum(palette[ink]) < 50:
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
    cap = 96 if logo else 280
    cap = max(cap, 20 * max(1, n_ink))
    # Solid coverage is not 1000-shard mush — vtracer/potrace fallback is worse.
    too_sharded = (n_loops > cap and coverage < 0.88) or n_loops > 2500
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
            f'  <path d="M 0 0 L {w} 0 L {w} {h} L 0 {h} Z" fill="{paper_hex}" data-name="paper-underlay"/>'
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
        if L.get("stroke_only") and L.get("sw"):
            extra += (
                f' stroke="{hex_}" stroke-width="{fmt(float(L["sw"]), 4)}"'
                f' stroke-linejoin="round" stroke-linecap="round"'
            )
            parts.append(
                f'  <g fill="none" data-name="{_esc(name)}"{extra}>'
            )
        else:
            if L.get("stroke") and L.get("sw"):
                extra += (
                    f' stroke="{hex_}" stroke-width="{fmt(float(L["sw"]), 4)}"'
                    f' stroke-linejoin="round"'
                )
            parts.append(
                f'  <g fill="{hex_}" fill-rule="evenodd" data-name="{_esc(name)}"{extra}>'
            )
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


def _hessian_newton(img, sigma):
    """Constant-scale dark-ridge vesselness + Newton distance to the ridge."""
    g = cv2.GaussianBlur(img.astype(np.float32), (0, 0), float(sigma))
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    ixx = cv2.Sobel(g, cv2.CV_32F, 2, 0, ksize=3)
    iyy = cv2.Sobel(g, cv2.CV_32F, 0, 2, ksize=3)
    ixy = cv2.Sobel(g, cv2.CV_32F, 1, 1, ksize=3)
    tmp = np.sqrt(np.maximum((ixx - iyy) ** 2 + 4.0 * ixy * ixy, 0.0))
    lam1 = 0.5 * (ixx + iyy + tmp)
    lam2 = 0.5 * (ixx + iyy - tmp)
    vx = ixy
    vy = lam1 - ixx
    nrm = np.sqrt(vx * vx + vy * vy)
    alt = nrm < 1e-5
    vx = np.where(alt, np.where(np.abs(ixx) >= np.abs(iyy), 1.0, 0.0), vx / (nrm + 1e-8))
    vy = np.where(alt, np.where(np.abs(ixx) >= np.abs(iyy), 0.0, 1.0), vy / (nrm + 1e-8))
    gn = gx * vx + gy * vy
    dist = gn / (lam1 + 1e-5)
    rb = np.abs(lam2) / (np.abs(lam1) + 1e-6)
    vess = np.where(
        (lam1 > 0.0) & (rb < 0.90),
        lam1 * np.exp(-(rb * rb) / 0.42),
        0.0,
    )
    return vess, dist


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

def _even_width_strokes(mask, max_half=5.5):
    """Skeleton + constant-width dilate; punch original holes so windows stay open.

    Used for poster keylines (tooth walls, sockets, circular frames). A raw
    blob-with-holes skeleton without punching fills the windows.
    """
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) < 30:
        return m
    dist = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    on = m > 0
    half = float(np.median(dist[on]))
    half = float(np.clip(half, 1.2, max_half))
    skel = _morph_skeleton(m)
    if int(skel.sum()) < 16:
        return m
    k = 2 * int(round(half)) + 1
    even = cv2.dilate(skel, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    inv = (m == 0).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(inv, 4)
    hh, ww = m.shape
    for i in range(1, n):
        x, y, bw, bh, aa = (
            int(st[i, cv2.CC_STAT_LEFT]),
            int(st[i, cv2.CC_STAT_TOP]),
            int(st[i, cv2.CC_STAT_WIDTH]),
            int(st[i, cv2.CC_STAT_HEIGHT]),
            int(st[i, cv2.CC_STAT_AREA]),
        )
        if x <= 0 or y <= 0 or (x + bw) >= ww or (y + bh) >= hh:
            continue
        if aa < 4:
            continue
        even[lab == i] = 0
    even = cv2.bitwise_and(even, cv2.dilate(m, np.ones((3, 3), np.uint8)))
    return even


def _thin_olive_strokes(rgb, paper):
    """Thin olive/gold-brown strokes (badge keylines), not thick landscape fills."""
    luma = luma_map(rgb)
    lab = to_lab(rgb)
    ch = chroma_map(lab)
    art = ~paper
    la, lb = lab[:, :, 1], lab[:, :, 2]
    olive = (
        art
        & (luma > 40)
        & (luma < 180)
        & (ch > 10)
        & (ch < 70)
        & (lb > 126)
        & (la > 106)
        & (la < 156)
    )
    bone = olive.astype(np.uint8)
    dist = cv2.distanceTransform(bone, cv2.DIST_L2, 3)
    thin = bone.copy()
    thin[dist > 7.0] = 0
    thin = cv2.morphologyEx(thin, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), 1)
    return thin


def _thin_grey_strokes(rgb, paper):
    """Already-thin grey-taupe keylines (jaw / sockets / frame), not the veil fill.

    Black-hat of luma finds dark even-width strokes on mixed landscape. No
    chroma gate here: a designed grey keyline over sunset mixes warm and
    would fail a Lab olive/grey split. Fat grey fills (veil plates) are
    not dark lines — black-hat does not turn them into a skeleton-dilate
    keyline. Caller hull-gates, punches glyphs, and drops mountain CCs.
    """
    luma = luma_map(rgb)
    art = ~paper
    lu8 = np.clip(luma, 0, 255).astype(np.uint8)
    ksz = int(np.clip(round(0.008 * max(rgb.shape[:2])), 7, 13)) | 1
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz))
    bh = cv2.morphologyEx(lu8, cv2.MORPH_BLACKHAT, k)
    # No chroma/luma-upper gate: a grey keyline over sunset mixes warm/bright.
    # Paper is already excluded. Fixed thr — a percentile of the stroke
    # itself would keep only the hottest tail and drop the jaw.
    m = ((bh > 18.0) & art).astype(np.uint8)
    if int(m.sum()) < 8:
        return m
    # Kill-early: a fat fill is not an already-thin keyline. Do not
    # skeleton-dilate it back to even-width.
    dist = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    on = m > 0
    med = float(np.median(dist[on])) if on.any() else 0.0
    if med > 4.2:
        return np.zeros_like(m)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), 1)
    return m


def _nms_stroke_ridge(mask):
    """1px medial of an already-thin stroke mask (distance NMS, not dilate)."""
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) < 8:
        return m
    dist = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    mx = cv2.dilate(dist, np.ones((3, 3), np.uint8))
    ridge = (m > 0) & (dist + 1e-4 >= mx)
    ridge = ridge | ((m > 0) & (dist <= 1.05))
    return ridge.astype(np.uint8)


def _gate_thin_olive(
    rgb,
    paper,
    hull,
    glyph=None,
    halo=None,
    circle=None,
    *,
    src=None,
    drop_chroma=True,
    drop_eye=True,
):
    """Hull-gate a thin stroke mask, punch glyphs, drop thick/mountain CCs.

    `src` defaults to thin olive. Grey keyline passes `src=_thin_grey_strokes`
    with drop_chroma/drop_eye False: jaw over sunset is mixed-chroma and
    sockets live in the eye band.
    """
    h, w = rgb.shape[:2]
    thin = _thin_olive_strokes(rgb, paper) if src is None else src
    gated = (thin > 0).astype(np.uint8)
    if hull is not None and int(np.sum(hull)) >= 80:
        near = cv2.dilate(
            (hull > 0).astype(np.uint8),
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)),
        )
        gated = ((gated > 0) & (near > 0)).astype(np.uint8)
    if glyph is not None and np.any(glyph):
        punch = (glyph > 0).astype(np.uint8)
        if halo is not None:
            punch = np.maximum(punch, (halo > 0).astype(np.uint8))
        punch = cv2.dilate(punch, np.ones((5, 5), np.uint8))
        gated[punch > 0] = 0
    if int(gated.sum()) < 40:
        return gated, 2.5
    lab = to_lab(rgb)
    ch = chroma_map(lab)
    dist = cv2.distanceTransform(gated, cv2.DIST_L2, 3)
    on = gated > 0
    half = float(np.median(dist[on])) if on.any() else 2.5
    half = float(np.clip(half, 1.4, 5.5))
    on_ring = np.zeros((h, w), np.uint8)
    if circle is not None:
        cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
        yy, xx = np.ogrid[:h, :w]
        band = max(7.0, 0.06 * rad)
        on_ring = (np.abs(np.hypot(xx - cx, yy - cy) - rad) <= band).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(gated, 8)
    keep = np.zeros_like(gated)
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < 14:
            continue
        comp = labels == i
        med_t = float(np.median(dist[comp]))
        mean_ch = float(ch[comp].mean())
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        if med_t > max(5.8, half * 2.4):
            continue
        elong = max(bw, bh) / max(float(min(bw, bh)), 1.0)
        ring_frac = float(on_ring[comp].mean()) if int(on_ring.sum()) else 0.0
        # Long landscape bands (sunset / water) that aren't the circular frame.
        if elong > 6.0 and min(bw, bh) < 10.0 * half and ring_frac < 0.25 and area < 0.01 * h * w:
            continue
        # High-chroma mountain interiors; keep only if the CC *is* the frame ring.
        if drop_chroma and mean_ch > 36.0:
            if ring_frac < 0.40 or (elong > 3.6 and ring_frac < 0.55):
                continue
        keep[comp] = 1
    if int(keep.sum()) < 40:
        keep = gated
    # Eye-band landscape ridges sit in the upper hull interior (not the frame).
    if drop_eye and circle is not None and int(on_ring.sum()) >= 40:
        cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
        yy, xx = np.ogrid[:h, :w]
        # Sockets sit near the circle centre; teeth start ~0.6 rad below.
        eye_band = (yy < cy + 0.20 * rad) & (yy > cy - 0.52 * rad)
        inside = np.hypot(xx.astype(np.float32) - cx, yy.astype(np.float32) - cy) < (rad * 1.18)
        keep[eye_band & inside & (on_ring == 0)] = 0
    if int(keep.sum()) < 40:
        keep = gated
    onk = keep > 0
    if onk.any():
        half = float(np.clip(np.median(dist[onk]), 1.4, 5.5))
    return keep, half


def _ridge_polylines_from_keep(keep, half_w):
    """NMS-walk an already-thin stroke mask. Not skeleton-dilate of a fill."""
    if keep is None or int(keep.sum()) < 40:
        return []
    ridge = _nms_stroke_ridge(keep)
    if int(ridge.sum()) < 24:
        ridge = keep
    rd = cv2.distanceTransform(ridge, cv2.DIST_L2, 3)
    onr = ridge > 0
    med_r = float(np.median(rd[onr])) if onr.any() else 0.5
    if med_r > 1.15:
        skel = _morph_skeleton(ridge)
    else:
        skel = ridge
    if int(skel.sum()) < 24:
        skel = _morph_skeleton(keep)
    skel = _prune_skeleton_spurs(skel, min_branch=max(4, int(round(half_w))))
    polylines = _walk_skeleton_polylines(skel, min_len=4)
    polylines = _join_polylines(polylines, max_gap=max(3.2, 1.6 * half_w))
    out = []
    min_len = max(6.0, 1.8 * half_w)
    _hh, ww = keep.shape
    for pts in polylines:
        if len(pts) < 3:
            continue
        alen = _polyline_arc_len(pts)
        if alen < min_len:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        bw = max(xs) - min(xs)
        bh = max(ys) - min(ys)
        if bh <= 2.2 and bw > 8.0 * max(bh, 0.8) and alen < 0.16 * ww:
            continue
        out.append(pts)
    return out


def _thin_olive_ridge_polylines(rgb, paper, hull, glyph=None, halo=None, circle=None):
    """Graph-walk the already-thin olive ridge into faired-ready polylines.

    Not a coverage-iso medial and not a skeleton-dilate of a fill plate.
    """
    keep, half_w = _gate_thin_olive(rgb, paper, hull, glyph, halo, circle)
    fallback_rgb = np.array([120.0, 90.0, 70.0], np.float32)
    if int(keep.sum()) < 40:
        return [], half_w, keep, fallback_rgb
    out = _ridge_polylines_from_keep(keep, half_w)
    bone_rgb = np.median(rgb[keep > 0].astype(np.float32), axis=0)
    return out, half_w, keep, bone_rgb.astype(np.float32)


def _assign_polylines_to_ink(polylines, grey_keep, olive_keep):
    """Majority-vote each polyline onto grey vs olive keep."""
    grey_pl, olive_pl = [], []
    h, w = grey_keep.shape
    for pts in polylines:
        g = o = 0
        step = max(1, len(pts) // 16)
        for x, y in pts[::step]:
            yi, xi = int(y), int(x)
            if 0 <= yi < h and 0 <= xi < w:
                g += int(grey_keep[yi, xi] > 0)
                o += int(olive_keep[yi, xi] > 0)
        if o > g:
            olive_pl.append(pts)
        else:
            grey_pl.append(pts)
    return grey_pl, olive_pl


def _dual_ink_ridge_keep(rgb, paper, hull, glyph=None, halo=None, circle=None):
    """Grey ∪ gated olive keep. Same mask family as the dual-ink ridge cycle.

    Does not walk spurs. Grey ink prefers low-chroma keep pixels so a
    sunset-mixed jaw does not paint the keyline brown.
    """
    fallback_g = np.array([128.0, 128.0, 132.0], np.float32)
    fallback_o = np.array([120.0, 90.0, 70.0], np.float32)
    grey_src = _thin_grey_strokes(rgb, paper)
    gkeep, ghalf = _gate_thin_olive(
        rgb,
        paper,
        hull,
        glyph,
        halo,
        circle,
        src=grey_src,
        drop_chroma=False,
        drop_eye=False,
    )
    okeep, ohalf = _gate_thin_olive(rgb, paper, hull, glyph, halo, circle)
    if circle is not None and int(okeep.sum()) >= 20:
        h, w = okeep.shape
        cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
        yy, xx = np.ogrid[:h, :w]
        eye_band = (yy < cy + 0.20 * rad) & (yy > cy - 0.52 * rad)
        inside = np.hypot(xx.astype(np.float32) - cx, yy.astype(np.float32) - cy) < (
            rad * 1.18
        )
        on_ring = np.abs(np.hypot(xx - cx, yy - cy) - rad) <= max(7.0, 0.06 * rad)
        okeep = okeep.copy()
        okeep[eye_band & inside & ~on_ring & (gkeep == 0)] = 0
    keep = np.maximum(gkeep, okeep)
    if int(okeep.sum()) >= 40:
        od = cv2.distanceTransform(okeep, cv2.DIST_L2, 3)
        half_w = float(np.clip(np.median(od[okeep > 0]), 1.6, 5.0))
    elif int(gkeep.sum()) >= 40:
        half_w = 2.8
    else:
        half_w = float(ohalf or ghalf or 2.8)
    if int(gkeep.sum()) >= 20:
        lab = to_lab(rgb)
        ch = chroma_map(lab)
        low = (gkeep > 0) & (ch < 24.0)
        if int(low.sum()) >= 40:
            grey_rgb = np.median(rgb[low].astype(np.float32), axis=0)
        else:
            grey_rgb = np.median(rgb[gkeep > 0].astype(np.float32), axis=0)
    else:
        grey_rgb = fallback_g
    if int(okeep.sum()) >= 20:
        olive_rgb = np.median(rgb[okeep > 0].astype(np.float32), axis=0)
    else:
        olive_rgb = fallback_o
    return (
        keep,
        gkeep,
        okeep,
        half_w,
        grey_rgb.astype(np.float32),
        olive_rgb.astype(np.float32),
    )


def _dual_ink_ridge_polylines(rgb, paper, hull, glyph=None, halo=None, circle=None):
    """Grey even-width keyline ∪ gated thin olive → faired-ready polylines.

    Keep extraction is `_dual_ink_ridge_keep`. The spur-walk is retained for
    unit bars; plate-poster emit uses `_emblem_cycle_polylines` instead.
    """
    keep, gkeep, okeep, half_w, grey_rgb, olive_rgb = _dual_ink_ridge_keep(
        rgb, paper, hull, glyph, halo, circle
    )
    if int(keep.sum()) < 40:
        return [], [], half_w, keep, gkeep, okeep, grey_rgb, olive_rgb
    pls = _ridge_polylines_from_keep(keep, half_w)
    grey_pls, olive_pls = _assign_polylines_to_ink(pls, gkeep, okeep)
    if int(gkeep.sum()) < 20:
        grey_pls = []
    if int(okeep.sum()) < 20:
        olive_pls = []
    return (
        grey_pls,
        olive_pls,
        half_w,
        keep,
        gkeep,
        okeep,
        grey_rgb,
        olive_rgb,
    )


def _smooth_circular(vals, k=11):
    v = np.asarray(vals, np.float32)
    n = int(v.size)
    if n < 8:
        return v
    k = max(3, int(k) | 1)
    if k >= n:
        k = n if (n % 2) else n - 1
        k = max(3, k)
    pad = np.concatenate([v[-(k // 2) :], v, v[: k // 2]])
    ker = np.ones(k, np.float32) / float(k)
    sm = np.convolve(pad, ker, mode="valid")
    return sm[:n]


def _close_cycle(pts):
    if not pts or len(pts) < 3:
        return pts
    if math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) > 0.8:
        return list(pts) + [pts[0]]
    return list(pts)


def _mask_outer_cycle(mask, offset=0.0):
    """Outer contour of a blob, optionally dilated (hole→centerline)."""
    m = (mask > 0).astype(np.uint8)
    if offset > 0.4:
        k = 2 * int(round(offset)) + 1
        m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    elif offset < -0.4:
        k = 2 * int(round(-offset)) + 1
        m = cv2.erode(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    if int(m.sum()) < 12:
        return []
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return []
    c = max(cnts, key=lambda x: cv2.arcLength(x, True))
    pts = [(float(p[0][0]) + 0.5, float(p[0][1]) + 0.5) for p in c]
    return _close_cycle(pts)


def _enclosed_holes(stroke, close_k=0):
    """Background components fully enclosed by a stroke drawing."""
    m = (stroke > 0).astype(np.uint8)
    if close_k:
        ksz = max(3, int(close_k) | 1)
        m = cv2.morphologyEx(
            m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz)), 1
        )
    h, w = m.shape
    if h < 4 or w < 4:
        return []
    ff = (m == 0).astype(np.uint8)
    mask = np.zeros((h + 2, w + 2), np.uint8)
    for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if ff[y, x]:
            cv2.floodFill(ff, mask, (int(x), int(y)), 0)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(ff, 8)
    holes = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < 8:
            continue
        holes.append(
            {
                "area": area,
                "cx": float(cents[i, 0]),
                "cy": float(cents[i, 1]),
                "bw": int(stats[i, cv2.CC_STAT_WIDTH]),
                "bh": int(stats[i, cv2.CC_STAT_HEIGHT]),
                "mask": labels == i,
            }
        )
    holes.sort(key=lambda z: -z["area"])
    return holes


def _union_keep(gkeep, okeep):
    g = np.zeros(gkeep.shape, np.uint8) if gkeep is None else (gkeep > 0).astype(np.uint8)
    o = np.zeros(g.shape, np.uint8) if okeep is None else (okeep > 0).astype(np.uint8)
    return np.maximum(g, o)


def _empty_space_dist(keep, hull):
    """Distance from dual-ink keep inside the hull. Zero on keep / outside."""
    h, w = keep.shape
    interior = np.ones((h, w), np.uint8) if hull is None else (hull > 0).astype(np.uint8)
    empty = ((interior > 0) & (keep == 0)).astype(np.uint8)
    dist = cv2.distanceTransform(empty, cv2.DIST_L2, 3)
    return empty, dist


def _peak_in_band(dist, empty, cx, cy, rad, cxrel0, cxrel1, cyrel0, cyrel1):
    """Argmax of empty-space dist in a relative band around the circle."""
    h, w = dist.shape
    yy, xx = np.ogrid[:h, :w]
    band = (
        (empty > 0)
        & ((xx - cx) / rad >= cxrel0)
        & ((xx - cx) / rad <= cxrel1)
        & ((yy - cy) / rad >= cyrel0)
        & ((yy - cy) / rad <= cyrel1)
    )
    if not np.any(band):
        return None
    tmp = dist.copy()
    tmp[~band] = -1.0
    mi = np.unravel_index(int(np.argmax(tmp)), tmp.shape)
    pv = float(tmp[mi])
    if pv < 2.0:
        return None
    return int(mi[1]), int(mi[0]), pv


def _near_keep_basin_cycle(dist, empty, px, py, half_w, rad, *, tau=2.4, cap_frac=0.30):
    """Watershed wall of one empty-space cell: dist>=tau around the peak.

    tau is a few pixels off the keep (the basin *wall*), not 0.25·peak of
    the interior. Thin gaps (dist<tau) do not leak. Disk cap is only a
    last-resort bound so a wide gap cannot flood the hull.
    """
    if px is None:
        return []
    h, w = dist.shape
    cap = max(8.0, float(cap_frac) * rad)
    yy, xx = np.ogrid[:h, :w]
    dpeak = np.hypot(xx.astype(np.float32) - px, yy.astype(np.float32) - py)
    local = ((dpeak <= cap) & (dist >= tau) & (empty > 0)).astype(np.uint8)
    if int(local.sum()) < 16:
        return []
    n, labels, stats, _ = cv2.connectedComponentsWithStats(local, 8)
    yi, xi = int(round(py)), int(round(px))
    if 0 <= yi < h and 0 <= xi < w and labels[yi, xi] > 0:
        blob = (labels == int(labels[yi, xi])).astype(np.uint8)
    else:
        if n <= 1:
            return []
        blob = (labels == (1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA])))).astype(np.uint8)
    if int(blob.sum()) < 20:
        return []
    return _mask_outer_cycle(blob, offset=half_w)


def _polar_keep_minus_frame(keep, cx, cy, rad, n=180, smooth=13):
    """Outer keep cycle after punching the overlay_support frame ring.

    Not polar-max of every keep tick (that hugs the frame). The next
    envelope is the skull / jaw when the jaw keep is present.
    """
    m = (keep > 0).astype(np.uint8)
    ys, xs = np.where(m > 0)
    if xs.size < 40:
        return []
    dx = xs.astype(np.float32) - cx
    dy = ys.astype(np.float32) - cy
    r = np.hypot(dx, dy)
    ang = np.arctan2(dy, dx)
    on_frame = np.abs(r - rad) <= 0.10 * rad
    edges = np.linspace(-math.pi, math.pi, n + 1)
    amids, rmax = [], []
    for i in range(n):
        a0, a1 = float(edges[i]), float(edges[i + 1])
        amid = 0.5 * (a0 + a1)
        # Image +y is down. Allow the chin past the circle; clip the crown
        # so the frame ring cannot win.
        s = max(0.0, math.sin(amid))
        r_hi = rad * (0.90 + 0.32 * s)
        r_lo = rad * (0.55 - 0.08 * s)
        inb = (ang >= a0) & (ang < a1) & (r >= r_lo) & (r <= r_hi) & (~on_frame)
        if int(inb.sum()) < 1:
            continue
        amids.append(amid)
        rmax.append(float(np.max(r[inb])))
    if len(rmax) < 28:
        return []
    sm = _smooth_circular(rmax, k=smooth)
    pts = [
        (cx + float(rp) * math.cos(a), cy + float(rp) * math.sin(a))
        for a, rp in zip(amids, sm)
    ]
    return _close_cycle(pts)


def _watershed_socket_cycles(keep, empty, dist, circle, half_w):
    """Basin walls of the two mid-face empty-space maxima + nasal."""
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    socks = []
    for band in ((-0.40, -0.08, -0.10, 0.30), (0.08, 0.40, -0.10, 0.30)):
        hit = _peak_in_band(dist, empty, cx, cy, rad, *band)
        if hit is None:
            continue
        px, py, _pv = hit
        pts = _near_keep_basin_cycle(
            dist, empty, px, py, half_w, rad, tau=2.4, cap_frac=0.28
        )
        alen = _polyline_arc_len(pts)
        if len(pts) >= 16 and 0.35 * rad <= alen <= 2.6 * rad:
            socks.append(pts)
        if len(socks) >= 2:
            break
    nasal = []
    hit = _peak_in_band(dist, empty, cx, cy, rad, -0.16, 0.16, 0.10, 0.44)
    if hit is not None:
        px, py, _pv = hit
        pts = _near_keep_basin_cycle(
            dist, empty, px, py, half_w, rad, tau=2.2, cap_frac=0.20
        )
        alen = _polyline_arc_len(pts)
        if len(pts) >= 12 and 0.18 * rad <= alen <= 1.6 * rad:
            nasal = [pts]
    return socks, nasal


def _watershed_tooth_cycles(keep, okeep, empty, dist, circle, half_w, hull):
    """Small empty-space basins in the olive lower hull, including hanging teeth.

    Open morph-holes stay closed as dist>=tau cells (the opening is thinner
    than 2*tau so it is not a leak).
    """
    if circle is None:
        return []
    h, w = keep.shape
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    yy, xx = np.ogrid[:h, :w]
    rr = np.hypot(xx.astype(np.float32) - cx, yy.astype(np.float32) - cy)
    band = (
        (yy > cy + 0.30 * rad)
        & (yy < cy + 1.24 * rad)
        & (np.abs(xx - cx) < 0.62 * rad)
        & (rr < 1.16 * rad)
    )
    if hull is not None and int(np.sum(hull)) >= 80:
        band = band & (hull > 0)
    t_empty = ((empty > 0) & band).astype(np.uint8)
    if int(t_empty.sum()) < 20:
        return []
    t_dist = cv2.distanceTransform(t_empty, cv2.DIST_L2, 3)
    tau = 1.7
    cells = ((t_dist >= tau) & (t_empty > 0)).astype(np.uint8)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(cells, 8)
    disk = math.pi * rad * rad
    out = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        ar = area / max(disk, 1.0)
        if ar < 0.00022 or ar > 0.008:
            continue
        tcx, tcy = float(cents[i, 0]), float(cents[i, 1])
        cyrel = (tcy - cy) / rad
        cxrel = (tcx - cx) / rad
        if cyrel < 0.30 or cyrel > 1.22 or abs(cxrel) > 0.58:
            continue
        if okeep is not None and int(okeep.sum()) >= 40:
            yi, xi = int(round(tcy)), int(round(tcx))
            y0, y1 = max(0, yi - 5), min(h, yi + 6)
            x0, x1 = max(0, xi - 5), min(w, xi + 6)
            if float(okeep[y0:y1, x0:x1].mean()) < 0.03:
                continue
        pts = _mask_outer_cycle((labels == i).astype(np.uint8), offset=half_w)
        alen = _polyline_arc_len(pts)
        if len(pts) < 8 or alen < 0.045 * rad or alen > 0.42 * rad:
            continue
        out.append(pts)
        if len(out) >= 14:
            break
    return out


def _ellipse_cycle(ex, ey, a, b, ang_deg, n=64):
    """Closed polyline of an axis-aligned-in-rotated-frame ellipse (full axes a,b)."""
    th = math.radians(float(ang_deg))
    ct, st = math.cos(th), math.sin(th)
    ra, rb = 0.5 * float(a), 0.5 * float(b)
    pts = []
    for i in range(n):
        t = 2.0 * math.pi * i / n
        x = ra * math.cos(t)
        y = rb * math.sin(t)
        pts.append((ex + x * ct - y * st, ey + x * st + y * ct))
    return _close_cycle(pts)


def _snap_cycle_to_keep(pts, keep, max_shift, origin=None):
    """Slide each vertex along its radial ray onto nearby keep.

    Independent nearest-keep snap collapses almonds onto brow/nasal
    blobs. Radial-only search keeps the designed cycle's shape.
    """
    if not pts or keep is None or int(keep.sum()) < 8:
        return pts
    h, w = keep.shape
    inv = (keep == 0).astype(np.uint8)
    dtk = cv2.distanceTransform(inv, cv2.DIST_L2, 3)
    ox, oy = (origin if origin is not None else (0.0, 0.0))
    use_radial = origin is not None
    ms = float(max_shift)
    nstep = max(4, int(round(ms)))
    out = []
    for x, y in pts:
        if use_radial:
            vx, vy = x - ox, y - oy
            L = math.hypot(vx, vy) or 1.0
            nx, ny = vx / L, vy / L
        else:
            nx, ny = 0.0, 0.0
        best = (float(x), float(y))
        best_d = 1e9
        for k in range(-nstep, nstep + 1):
            t = (k / float(nstep)) * ms
            xx = x + nx * t
            yy = y + ny * t
            xi, yi = int(round(xx)), int(round(yy))
            if 0 <= yi < h and 0 <= xi < w:
                d = float(dtk[yi, xi])
                if d < best_d:
                    best_d = d
                    best = (xx, yy)
        out.append(best)
    return _close_cycle(out)


def _radial_pct_cycle(keep, cx, cy, rad, pct=80.0, n=160):
    """Closed cycle: per-angle percentile of keep radius in the outer annulus.

    Not polar-max (outermost tick hugs the frame). The percentile of keep
    mass in 0.62–1.18 rad, with the frame ring punched, traces the skull
    / jaw stroke when that stroke is the dense outer keep.
    """
    m = (keep > 0).astype(np.uint8)
    ys, xs = np.where(m > 0)
    if xs.size < 40:
        return []
    dx = xs.astype(np.float32) - cx
    dy = ys.astype(np.float32) - cy
    r = np.hypot(dx, dy)
    ang = np.arctan2(dy, dx)
    on_frame = np.abs(r - rad) <= 0.10 * rad
    edges = np.linspace(-math.pi, math.pi, n + 1)
    amids, rpick = [], []
    for i in range(n):
        a0, a1 = float(edges[i]), float(edges[i + 1])
        amid = 0.5 * (a0 + a1)
        s = max(0.0, math.sin(amid))
        r_hi = rad * (0.92 + 0.30 * s)
        r_lo = rad * (0.62 + 0.06 * s)
        inb = (ang >= a0) & (ang < a1) & (r >= r_lo) & (r <= r_hi) & (~on_frame)
        if int(inb.sum()) < 2:
            continue
        amids.append(amid)
        rpick.append(float(np.percentile(r[inb], pct)))
    if len(rpick) < 28:
        return []
    sm = _smooth_circular(rpick, k=15)
    pts = [
        (cx + float(rp) * math.cos(a), cy + float(rp) * math.sin(a))
        for a, rp in zip(amids, sm)
    ]
    return _close_cycle(pts)


def _designed_jaw_cycle(keep, cx, cy, rad):
    """Closed skull silhouette primitive: chin drops, crown stays inside the frame."""
    pts = []
    n = 96
    for i in range(n):
        t = 2.0 * math.pi * i / n
        # +sin is down (image y). Jaw hangs below the circular frame.
        s = math.sin(t)
        if s > 0.0:
            r = rad * (0.90 + 0.42 * s)  # chin ~1.32 rad
        else:
            r = rad * (0.90 + 0.18 * s)  # crown ~0.72 rad
        pts.append((cx + r * math.cos(t), cy + r * math.sin(t)))
    return _close_cycle(pts)


def _jaw_cycle(keep, circle, half_w):
    """Skull / jaw closed cycle: radial percentile of keep, else designed U."""
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])

    def _ok(sil):
        if len(sil) < 24:
            return False
        alen = _polyline_arc_len(sil)
        ys = [p[1] for p in sil]
        reaches = bool(ys) and (max(ys) >= cy + 0.88 * rad)
        mean_r = sum(math.hypot(p[0] - cx, p[1] - cy) for p in sil) / max(len(sil), 1)
        rs = [math.hypot(p[0] - cx, p[1] - cy) for p in sil]
        r_hi = max(rs) if rs else 0.0
        # Frame ring is even-radius ≈ rad. A jaw that drops below the circle
        # has r_hi well past rad even if mean_r is similar.
        frame_like = abs(mean_r - rad) < 0.06 * rad and r_hi < 1.12 * rad
        return alen >= 1.4 * rad and reaches and not frame_like

    sil = _designed_jaw_cycle(keep, cx, cy, rad)
    if _ok(sil):
        return [sil]
    sil = _radial_pct_cycle(keep, cx, cy, rad, pct=80.0)
    if _ok(sil):
        return [sil]
    return []


def _socket_ellipse_cycles(keep, circle, half_w):
    """Two almond primitives at mid-face priors, snapped onto keep rims."""
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    specs = (
        (cx - 0.24 * rad, cy + 0.08 * rad, 0.56 * rad, 0.34 * rad, 12.0),
        (cx + 0.24 * rad, cy + 0.08 * rad, 0.56 * rad, 0.34 * rad, -12.0),
    )
    out = []
    for ex, ey, a, b, ang in specs:
        pts = _ellipse_cycle(ex, ey, a, b, ang, n=56)
        alen = _polyline_arc_len(pts)
        if len(pts) >= 16 and 0.50 * rad <= alen <= 2.6 * rad:
            out.append(pts)
    return out


def _nasal_ellipse_cycle(keep, circle, half_w):
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    pts = _ellipse_cycle(cx, cy + 0.28 * rad, 0.20 * rad, 0.16 * rad, 90.0, n=40)
    alen = _polyline_arc_len(pts)
    if len(pts) >= 12 and 0.20 * rad <= alen <= 1.5 * rad:
        return [pts]
    return []


def _tooth_lattice_cycles(okeep, circle, half_w, hull):
    """Designed mouth lattice snapped onto olive keep. Includes hanging row."""
    if okeep is None or int(okeep.sum()) < 20 or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = okeep.shape
    src = (okeep > 0).astype(np.uint8)
    if hull is not None and int(np.sum(hull)) >= 80:
        src = ((src > 0) & (hull > 0)).astype(np.uint8)
    out = []
    # Upper occlusal row (7) + hanging row (6). Slight smile curve.
    rows = (
        (7, 0.74, 0.38, 0.055, 0.062, 0.03),
        (6, 1.02, 0.30, 0.044, 0.095, 0.05),
    )
    yy, xx = np.ogrid[:h, :w]
    for nwin, yrel, xspan, ax, ay, curve in rows:
        for i in range(nwin):
            t = (i - 0.5 * (nwin - 1)) / max(0.5 * (nwin - 1), 1.0)
            px = cx + t * xspan * rad
            py = cy + (yrel + curve * t * t) * rad
            d = np.hypot(xx.astype(np.float32) - px, yy.astype(np.float32) - py)
            # Olive keep is the window *wall*, not the empty centre.
            ra = ax * rad
            ann = (d >= 0.45 * ra) & (d <= 1.35 * ra)
            if int(ann.sum()) < 8 or float(src[ann].mean()) < 0.04:
                continue
            pts = _ellipse_cycle(px, py, 2.0 * ax * rad, 2.0 * ay * rad, 0.0, n=24)
            alen = _polyline_arc_len(pts)
            if len(pts) >= 8 and 0.05 * rad <= alen <= 0.42 * rad:
                out.append(pts)
            if len(out) >= 14:
                return out
    return out


def _emitted_wall_mask(shape, grey_pls, olive_pls, frame_circle, half_w):
    """Raster of emitted overlay walls only — not every dual-ink keep tick."""
    h, w = shape
    m = np.zeros((h, w), np.uint8)
    th = max(2, int(round(2.0 * max(float(half_w), 1.2))))
    for pts in list(grey_pls or []) + list(olive_pls or []):
        if not pts or len(pts) < 2:
            continue
        arr = np.array(
            [[int(round(p[0])), int(round(p[1]))] for p in pts], np.int32
        )
        closed = (
            math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 3.0
        )
        cv2.polylines(m, [arr], isClosed=closed, color=1, thickness=th)
    if frame_circle is not None:
        cx, cy, rad = frame_circle
        cv2.circle(
            m,
            (int(round(cx)), int(round(cy))),
            max(1, int(round(rad))),
            1,
            thickness=th,
        )
    return m


def _local_close_holes(keep, px, py, r_disk, close_k, half_w, rad, *, min_ar, max_ar):
    """Enclosed holes of keep inside a disk after a small morph-close."""
    h, w = keep.shape
    yy, xx = np.ogrid[:h, :w]
    disk = np.hypot(xx.astype(np.float32) - px, yy.astype(np.float32) - py) <= r_disk
    src = ((keep > 0) & disk).astype(np.uint8)
    if int(src.sum()) < 16:
        return []
    ksz = max(3, int(close_k) | 1)
    src = cv2.morphologyEx(
        src, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz))
    )
    holes = _enclosed_holes(src, close_k=0)
    disk_a = math.pi * rad * rad
    out = []
    for z in holes:
        ar = z["area"] / max(disk_a, 1.0)
        if ar < min_ar or ar > max_ar:
            continue
        if math.hypot(z["cx"] - px, z["cy"] - py) > 0.65 * r_disk:
            continue
        pts = _mask_outer_cycle(z["mask"], offset=half_w)
        alen = _polyline_arc_len(pts)
        if len(pts) >= 12 and 0.20 * rad <= alen <= 2.4 * rad:
            out.append(pts)
    out.sort(key=lambda p: -_polyline_arc_len(p))
    return out


def _local_close_jaw(keep, circle, half_w):
    """Outer contour of non-frame keep after a gap-bridging close."""
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = keep.shape
    yy, xx = np.ogrid[:h, :w]
    rr = np.hypot(xx.astype(np.float32) - cx, yy.astype(np.float32) - cy)
    src = (keep > 0).astype(np.uint8)
    src[np.abs(rr - rad) <= 0.10 * rad] = 0
    ksz = max(5, int(round(0.035 * rad)) | 1)
    src = cv2.morphologyEx(
        src, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz))
    )
    n, lab, st, _ = cv2.connectedComponentsWithStats(src, 8)
    if n <= 1:
        return []
    best = 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))
    blob = (lab == best).astype(np.uint8)
    pts = _mask_outer_cycle(blob, offset=0.0)
    alen = _polyline_arc_len(pts)
    ys = [p[1] for p in pts] if pts else []
    reaches = bool(ys) and (max(ys) >= cy + 0.88 * rad)
    if not pts or alen < 1.5 * rad or not reaches:
        return []
    mean_r = sum(math.hypot(p[0] - cx, p[1] - cy) for p in pts) / max(len(pts), 1)
    r_hi = max(math.hypot(p[0] - cx, p[1] - cy) for p in pts)
    if abs(mean_r - rad) < 0.06 * rad and r_hi < 1.12 * rad:
        return []
    return [pts]


def _local_close_teeth(okeep, circle, half_w, hull):
    """Olive keep in the mouth band, closed just enough that hanging U's become cells."""
    if okeep is None or int(okeep.sum()) < 20 or circle is None:
        return []
    h, w = okeep.shape
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    yy, xx = np.ogrid[:h, :w]
    rr = np.hypot(xx.astype(np.float32) - cx, yy.astype(np.float32) - cy)
    band = (
        (yy > cy + 0.32 * rad)
        & (yy < cy + 1.28 * rad)
        & (np.abs(xx - cx) < 0.62 * rad)
        & (rr < 1.20 * rad)
    )
    if hull is not None and int(np.sum(hull)) >= 80:
        band = band & (hull > 0)
    src = ((okeep > 0) & band).astype(np.uint8)
    if int(src.sum()) < 16:
        return []
    ksz = max(5, int(round(0.028 * rad)) | 1)
    src = cv2.morphologyEx(
        src, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz))
    )
    holes = _enclosed_holes(src, close_k=0)
    disk = math.pi * rad * rad
    out = []
    for z in holes:
        ar = z["area"] / max(disk, 1.0)
        if ar < 0.00028 or ar > 0.010:
            continue
        cyrel = (z["cy"] - cy) / rad
        cxrel = (z["cx"] - cx) / rad
        if cyrel < 0.32 or cyrel > 1.24 or abs(cxrel) > 0.58:
            continue
        asp = z["bw"] / max(float(z["bh"]), 1.0)
        if asp > 3.2 or asp < 0.22:
            continue
        pts = _mask_outer_cycle(z["mask"], offset=half_w)
        alen = _polyline_arc_len(pts)
        if len(pts) < 8 or alen < 0.05 * rad or alen > 0.50 * rad:
            continue
        out.append(pts)
        if len(out) >= 14:
            break
    return out


def _keep_to_ridge(keep, min_branch):
    """1px ridge of an already-thin keep. Not skeleton-dilate of a fill."""
    if keep is None or int(keep.sum()) < 16:
        return np.zeros(keep.shape, np.uint8) if keep is not None else None
    ridge = _nms_stroke_ridge(keep)
    if int(ridge.sum()) < 24:
        ridge = keep
    rd = cv2.distanceTransform(ridge, cv2.DIST_L2, 3)
    onr = ridge > 0
    med_r = float(np.median(rd[onr])) if onr.any() else 0.5
    skel = _morph_skeleton(ridge) if med_r > 1.15 else ridge
    if int(skel.sum()) < 24:
        skel = _morph_skeleton(keep)
    return _prune_skeleton_spurs(skel, min_branch=min_branch)


def _poly_heading(pts, end, look=8):
    n = len(pts)
    k = min(look, n - 1)
    if end == 0:
        a, b = pts[0], pts[k]
    else:
        a, b = pts[-1], pts[n - 1 - k]
    vx, vy = a[0] - b[0], a[1] - b[1]
    L = math.hypot(vx, vy) or 1.0
    return vx / L, vy / L


def _chord_mostly_empty(mask, p, q, min_empty=0.50):
    n = max(4, int(math.hypot(q[0] - p[0], q[1] - p[1])))
    h, w = mask.shape
    hit = tot = 0
    for i in range(2, n - 1):
        t = i / float(n)
        xi = int(round(p[0] + t * (q[0] - p[0])))
        yi = int(round(p[1] + t * (q[1] - p[1])))
        if 0 <= yi < h and 0 <= xi < w:
            tot += 1
            hit += int(mask[yi, xi] > 0)
    if tot < 2:
        return True
    return (1.0 - hit / float(tot)) >= min_empty


def _pair_long_stroke_chords(skel, keep, min_alen, max_gap_self, max_gap_cross):
    """Endpoint pairing on long strokes only. Same-chain U-close first."""
    pls = _walk_skeleton_polylines(skel, min_len=5)
    ends = []
    for i, pts in enumerate(pls):
        if len(pts) < 4:
            continue
        alen = _polyline_arc_len(pts)
        if alen < min_alen:
            continue
        gap = math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1])
        if gap < 2.2 and alen > 16:
            continue
        ends.append((i, 0, pts[0], _poly_heading(pts, 0), alen))
        ends.append((i, 1, pts[-1], _poly_heading(pts, 1), alen))
    used = set()
    bridges = []

    def face(ha, hb, pa, pb):
        vx, vy = pb[0] - pa[0], pb[1] - pa[1]
        L = math.hypot(vx, vy) or 1.0
        nx, ny = vx / L, vy / L
        return ha[0] * nx + ha[1] * ny, hb[0] * (-nx) + hb[1] * (-ny)

    cands = []
    for a in range(len(ends)):
        ia, ea, pa, ha, alen_a = ends[a]
        for b in range(a + 1, len(ends)):
            ib, eb, pb, hb, alen_b = ends[b]
            if ia != ib:
                continue
            d = math.hypot(pa[0] - pb[0], pa[1] - pb[1])
            if d < 1.5 or d > max_gap_self or d > 0.55 * alen_a:
                continue
            da, db = face(ha, hb, pa, pb)
            if da < -0.35 and db < -0.35:
                continue
            if not _chord_mostly_empty(keep, pa, pb, 0.45):
                continue
            cands.append((d / max(alen_a, 1.0), a, b))
    cands.sort()
    for _sc, a, b in cands:
        ia, ea, pa, _, _ = ends[a]
        ib, eb, pb, _, _ = ends[b]
        if (ia, ea) in used or (ib, eb) in used:
            continue
        used.add((ia, ea))
        used.add((ib, eb))
        bridges.append((pa, pb))
    cands = []
    for a in range(len(ends)):
        ia, ea, pa, ha, alen_a = ends[a]
        if (ia, ea) in used:
            continue
        for b in range(a + 1, len(ends)):
            ib, eb, pb, hb, alen_b = ends[b]
            if ia == ib or (ib, eb) in used:
                continue
            d = math.hypot(pa[0] - pb[0], pa[1] - pb[1])
            if d < 1.5 or d > max_gap_cross:
                continue
            da, db = face(ha, hb, pa, pb)
            if da < 0.20 or db < 0.20:
                continue
            if not _chord_mostly_empty(keep, pa, pb, 0.55):
                continue
            cands.append((d + 6.0 * (2.0 - da - db), a, b))
    cands.sort()
    for _sc, a, b in cands:
        ia, ea, pa, _, _ = ends[a]
        ib, eb, pb, _, _ = ends[b]
        if (ia, ea) in used or (ib, eb) in used:
            continue
        used.add((ia, ea))
        used.add((ib, eb))
        bridges.append((pa, pb))
    return bridges


def _paint_chords(keep, bridges, thickness):
    out = (keep > 0).astype(np.uint8).copy()
    th = max(2, int(thickness))
    for pa, pb in bridges:
        cv2.line(
            out,
            (int(round(pa[0])), int(round(pa[1]))),
            (int(round(pb[0])), int(round(pb[1]))),
            1,
            th,
        )
    return out


def _seeded_first_keep_cycle(keep, ox, oy, r_lo, r_hi, n=72):
    """First keep hit on rays from a seed. Gap rays interpolate. Not polar-max."""
    h, w = keep.shape
    src = (keep > 0).astype(np.uint8)
    hits = []
    for i in range(n):
        ang = 2.0 * math.pi * i / n
        c, s = math.cos(ang), math.sin(ang)
        hit = None
        r = r_lo
        while r <= r_hi:
            x = ox + r * c
            y = oy + r * s
            xi, yi = int(round(x)), int(round(y))
            if 0 <= yi < h and 0 <= xi < w and src[yi, xi]:
                hit = (x, y, r)
                break
            r += 0.55
        hits.append(hit)
    good = [h[2] for h in hits if h is not None]
    if len(good) < 0.55 * n:
        return []
    med = float(np.median(good))
    lo, hi = 0.45 * med, 1.70 * med
    use = []
    for h in hits:
        if h is None or h[2] < lo or h[2] > hi:
            use.append(None)
        else:
            use.append(h)
    if sum(1 for u in use if u is not None) < 0.50 * n:
        return []
    pts = []
    for i in range(n):
        if use[i] is not None:
            pts.append((use[i][0], use[i][1]))
            continue
        pj = pk = None
        for d in range(1, n):
            j = (i - d) % n
            if use[j] is not None:
                pj = (j, d)
                break
        for d in range(1, n):
            k = (i + d) % n
            if use[k] is not None:
                pk = (k, d)
                break
        if pj is None or pk is None:
            continue
        j, dj = pj
        k, dk = pk
        t = dj / float(dj + dk)
        ang = 2.0 * math.pi * i / n
        rr = use[j][2] * (1.0 - t) + use[k][2] * t
        pts.append((ox + rr * math.cos(ang), oy + rr * math.sin(ang)))
    if len(pts) < 16:
        return []
    return _close_cycle(pts)


def _olive_window_cycles(okeep, circle, half_w):
    """Hollow olive windows as holes; filled hanging teeth as CC outer contours."""
    if okeep is None or int(okeep.sum()) < 20 or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = okeep.shape
    yy, xx = np.ogrid[:h, :w]
    rr = np.hypot(xx.astype(np.float32) - cx, yy.astype(np.float32) - cy)
    band = (
        (yy > cy + 0.28 * rad)
        & (yy < cy + 1.32 * rad)
        & (np.abs(xx - cx) < 0.64 * rad)
        & (rr < 1.28 * rad)
    )
    src = ((okeep > 0) & band).astype(np.uint8)
    disk = math.pi * rad * rad
    out = []
    used = np.zeros((h, w), np.uint8)
    off = max(1.0, 0.40 * float(half_w))
    for z in _enclosed_holes(src, close_k=0):
        ar = z["area"] / max(disk, 1.0)
        if ar < 0.00018 or ar > 0.012:
            continue
        cyrel = (z["cy"] - cy) / rad
        cxrel = (z["cx"] - cx) / rad
        if cyrel < 0.28 or cyrel > 1.30 or abs(cxrel) > 0.62:
            continue
        asp = z["bw"] / max(float(z["bh"]), 1.0)
        if asp > 3.6 or asp < 0.16:
            continue
        pts = _mask_outer_cycle(z["mask"], offset=off)
        alen = _polyline_arc_len(pts)
        if len(pts) < 8 or alen < 0.04 * rad or alen > 0.58 * rad:
            continue
        out.append(pts)
        used[z["mask"]] = 1
    n, lab, st, cents = cv2.connectedComponentsWithStats(src, 8)
    for i in range(1, n):
        area = int(st[i, cv2.CC_STAT_AREA])
        ar = area / max(disk, 1.0)
        if ar < 0.00035 or ar > 0.010:
            continue
        tcx, tcy = float(cents[i, 0]), float(cents[i, 1])
        cyrel = (tcy - cy) / rad
        cxrel = (tcx - cx) / rad
        if cyrel < 0.70 or cyrel > 1.28 or abs(cxrel) > 0.58:
            continue
        asp = st[i, cv2.CC_STAT_WIDTH] / max(float(st[i, cv2.CC_STAT_HEIGHT]), 1.0)
        if asp > 2.4 or asp < 0.18:
            continue
        m = lab == i
        if float(used[m].mean()) > 0.15:
            continue
        pts = _mask_outer_cycle(m.astype(np.uint8), offset=0.0)
        alen = _polyline_arc_len(pts)
        if len(pts) < 8 or alen < 0.05 * rad or alen > 0.50 * rad:
            continue
        out.append(pts)
        if len(out) >= 14:
            break
    return out


def _socket_cycles_from_keep(gkeep, circle, half_w):
    """Almond rims: enclosed keep holes, else seeded first-keep polar, else mirror."""
    if gkeep is None or int(gkeep.sum()) < 20 or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    disk = math.pi * rad * rad
    off = max(1.0, 0.40 * float(half_w))
    holes = []
    for z in _enclosed_holes(gkeep, close_k=0):
        ar = z["area"] / max(disk, 1.0)
        if ar < 0.0035 or ar > 0.080:
            continue
        cyrel = (z["cy"] - cy) / rad
        cxrel = (z["cx"] - cx) / rad
        if not (-0.28 <= cyrel <= 0.42 and 0.10 <= abs(cxrel) <= 0.50):
            continue
        asp = z["bw"] / max(float(z["bh"]), 1.0)
        if asp >= 3.6:
            continue
        pts = _mask_outer_cycle(z["mask"], offset=off)
        alen = _polyline_arc_len(pts)
        if len(pts) < 16 or alen < 0.40 * rad or alen > 2.8 * rad:
            continue
        rs = [math.hypot(p[0] - cx, p[1] - cy) for p in pts]
        if max(rs) >= 0.85 * rad:
            continue
        holes.append((cxrel, pts))
    left = [p for c, p in holes if c < 0]
    right = [p for c, p in holes if c > 0]
    socks = []
    if left:
        socks.append(left[0])
    if right:
        socks.append(right[0])

    def _ok_seed(pts, ox, oy, side):
        if len(pts) < 16:
            return False
        alen = _polyline_arc_len(pts)
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        bw = max(xs) - min(xs)
        bh = max(ys) - min(ys)
        if not (0.50 * rad <= alen <= 2.6 * rad):
            return False
        if not (0.16 * rad <= bw <= 0.62 * rad and 0.10 * rad <= bh <= 0.50 * rad):
            return False
        if side < 0 and max(xs) >= cx + 0.12 * rad:
            return False
        if side > 0 and min(xs) <= cx - 0.12 * rad:
            return False
        mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
        if abs(mx - ox) >= 0.16 * rad or abs(my - oy) >= 0.16 * rad:
            return False
        if min(ys) < oy - 0.24 * rad:
            return False
        return True

    # One good almond: mirror it. Polar of a leaking rim is a lumpy brow.
    if len(socks) == 1:
        src = socks[0]
        socks.append(_close_cycle([(2.0 * cx - x, y) for x, y in src]))
        return socks[:2]
    if len(socks) < 2:
        for ox, oy, side in (
            (cx - 0.32 * rad, cy, -1.0),
            (cx + 0.32 * rad, cy, 1.0),
        ):
            if side < 0 and left:
                continue
            if side > 0 and right:
                continue
            pts = _seeded_first_keep_cycle(
                gkeep, ox, oy, r_lo=0.07 * rad, r_hi=0.42 * rad, n=72
            )
            if _ok_seed(pts, ox, oy, side):
                socks.append(pts)
                if side < 0:
                    left = [pts]
                else:
                    right = [pts]
            if len(socks) >= 2:
                break
    if len(socks) == 1:
        src = socks[0]
        socks.append(_close_cycle([(2.0 * cx - x, y) for x, y in src]))
    return socks[:2]


def _dijkstra_keep_path(cost, start_xy, goal_xy):
    """Shortest path on a cost field (0 = blocked). start/goal are (x, y)."""
    h, w = cost.shape
    sx, sy = int(round(start_xy[0])), int(round(start_xy[1]))
    gx, gy = int(round(goal_xy[0])), int(round(goal_xy[1]))
    if not (0 <= sy < h and 0 <= sx < w and cost[sy, sx] > 0):
        return []
    if not (0 <= gy < h and 0 <= gx < w and cost[gy, gx] > 0):
        return []
    import heapq
    dist = np.full((h, w), np.inf, np.float32)
    dist[sy, sx] = 0.0
    parent = {(sy, sx): None}
    heap = [(0.0, sy, sx)]
    offs = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
    found = False
    guard = 0
    lim = int(h * w)
    while heap and guard < lim:
        guard += 1
        d, y, x = heapq.heappop(heap)
        if d > dist[y, x] + 1e-6:
            continue
        if y == gy and x == gx:
            found = True
            break
        for dy, dx in offs:
            ny, nx = y + dy, x + dx
            if not (0 <= ny < h and 0 <= nx < w):
                continue
            c = float(cost[ny, nx])
            if c <= 0.0:
                continue
            step = c * (1.4142 if dy and dx else 1.0)
            nd = d + step
            if nd + 1e-6 < dist[ny, nx]:
                dist[ny, nx] = nd
                parent[(ny, nx)] = (y, x)
                heapq.heappush(heap, (nd, ny, nx))
    if not found or (gy, gx) not in parent:
        return []
    path = []
    cur = (gy, gx)
    while cur is not None:
        path.append((cur[1] + 0.5, cur[0] + 0.5))
        cur = parent[cur]
    path.reverse()
    return path


def _nearest_keep_xy(mask, x, y, max_d):
    ys, xs = np.where(mask > 0)
    if xs.size < 1:
        return None
    d2 = (xs.astype(np.float32) - x) ** 2 + (ys.astype(np.float32) - y) ** 2
    i = int(np.argmin(d2))
    if math.sqrt(float(d2[i])) > max_d:
        return None
    return (float(xs[i]), float(ys[i]))


def _geodesic_jaw(gkeep, circle, half_w, okeep=None):
    """Even-width jaw: Dijkstra on grey keep, chin waypoint, open U.

    Mouth interior is blocked so the path cannot cut through the tooth
    grid. Cost prefers the keep and larger radius (the outer skull).
    Not polar-max, not a morph-close blob, not a designed egg.
    """
    if gkeep is None or int(gkeep.sum()) < 40 or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    yy, xx = np.ogrid[:h, :w]
    rr = np.hypot(xx.astype(np.float32) - cx, yy.astype(np.float32) - cy)
    # Lower/outer band, punch only the UPPER frame so the U can cross
    # the circle at the temples.
    on_upper = (np.abs(rr - rad) <= max(3.0, 0.04 * rad)) & (yy < cy + 0.12 * rad)
    band = (yy > cy + 0.08 * rad) & (rr > 0.62 * rad) & (rr < 1.52 * rad) & (~on_upper)
    src = ((gkeep > 0) & band).astype(np.uint8)
    if int(src.sum()) < 40:
        return []
    # Chin = lowest keep near the midline.
    chin_m = (src > 0) & (np.abs(xx - cx) < 0.20 * rad) & (yy > cy + 1.05 * rad)
    cys, cxs = np.where(chin_m)
    if cxs.size < 1:
        chin_m = (src > 0) & (np.abs(xx - cx) < 0.28 * rad) & (yy > cy + 0.95 * rad)
        cys, cxs = np.where(chin_m)
    if cxs.size < 1:
        return []
    i = int(np.argmax(cys))
    chin = (float(cxs[i]), float(cys[i]))
    left = _nearest_keep_xy(src, cx - 0.72 * rad, cy + 0.55 * rad, 0.32 * rad)
    right = _nearest_keep_xy(src, cx + 0.72 * rad, cy + 0.55 * rad, 0.32 * rad)
    if left is None or right is None:
        return []
    # Cost: prefer keep, allow ~5px gaps so temple/chin fragments join.
    inv = (src == 0).astype(np.uint8)
    dt = cv2.distanceTransform(inv, cv2.DIST_L2, 3)
    walkable = dt <= 5.5
    cost = np.where(walkable, (1.0 + 5.0 * dt).astype(np.float32), np.float32(0.0))
    # Block the mouth so the geodesic cannot shortcut through teeth.
    mouth = np.hypot(
        xx.astype(np.float32) - cx, yy.astype(np.float32) - (cy + 0.80 * rad)
    ) < 0.40 * rad
    cost[mouth] = 0.0
    if okeep is not None and int(okeep.sum()) >= 20:
        cost[(okeep > 0) & (yy > cy + 0.40 * rad)] *= 10.0
    # Prefer the outer skull (larger r) over inner waterlines.
    outer = np.clip((rr - 0.72 * rad) / (0.55 * rad), 0.0, 1.0)
    cost = np.where(cost > 0, cost * (1.7 - 1.1 * outer), cost).astype(np.float32)
    a = _dijkstra_keep_path(cost, left, chin)
    b = _dijkstra_keep_path(cost, chin, right)
    pts = (a + b[1:]) if (len(a) >= 8 and len(b) >= 8) else []
    alen = _polyline_arc_len(pts)
    if len(pts) < 16 or alen < 1.35 * rad:
        return []
    ys = [p[1] for p in pts]
    xs = [p[0] for p in pts]
    if max(ys) < cy + 1.05 * rad:
        return []
    if max(xs) - min(xs) < 0.70 * rad:
        return []
    # Must actually hang below the circular frame at the chin.
    r_hi = max(math.hypot(p[0] - cx, p[1] - cy) for p in pts)
    if r_hi < 1.12 * rad:
        return []
    # Technique 3: lock the geodesic onto the grey keep ridge in a
    # thick band, preferring the outermost long stroke (the designed jaw).
    band = np.zeros((h, w), np.uint8)
    th = max(12, int(round(0.14 * rad)))
    arr = np.array([[int(round(p[0])), int(round(p[1]))] for p in pts], np.int32)
    cv2.polylines(band, [arr], isClosed=False, color=1, thickness=th)
    locked = ((gkeep > 0) & (band > 0)).astype(np.uint8)
    ridge = _nms_stroke_ridge(locked)
    if int(ridge.sum()) >= 40:
        pls = _walk_skeleton_polylines(ridge, min_len=10)
        pls = _join_polylines(pls, max_gap=max(6.0, 0.04 * rad))
        cands = []
        for p in pls:
            al = _polyline_arc_len(p)
            if al < 0.80 * rad:
                continue
            mean_r = sum(math.hypot(x - cx, y - cy) for x, y in p) / max(len(p), 1)
            ymax = max(y for _x, y in p)
            if mean_r > 1.42 * rad or ymax < cy + 0.95 * rad:
                continue
            cands.append((mean_r, al, p))
        if cands:
            cands.sort(key=lambda z: (-z[0], -z[1]))
            cand = cands[0][2]
            if _polyline_arc_len(cand) >= 0.55 * alen:
                pts = cand
    if len(pts) > 56:
        nkeep = 56
        idx = [int(round(i * (len(pts) - 1) / float(nkeep - 1))) for i in range(nkeep)]
        pts = [pts[i] for i in idx]
    return pts


def _resample_cycle(pts, step=1.6, limit=420):
    """Even arc-length samples so fairing sees the wall, not every pixel."""
    if not pts or len(pts) < 4:
        return pts
    closed = math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 1.2
    chain = list(pts[:-1]) if closed and len(pts) > 4 else list(pts)
    if len(chain) < 3:
        return _close_cycle(pts) if closed else list(pts)
    seg = [0.0]
    for i in range(1, len(chain)):
        seg.append(seg[-1] + math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1]))
    if closed:
        seg_end = seg[-1] + math.hypot(chain[0][0] - chain[-1][0], chain[0][1] - chain[-1][1])
    else:
        seg_end = seg[-1]
    if seg_end < 4:
        return _close_cycle(chain) if closed else chain
    n = max(8, min(limit, int(seg_end / max(step, 0.8))))
    out = []
    j = 0
    for i in range(n):
        target = seg_end * (i / float(n if closed else max(n - 1, 1)))
        while j < len(seg) - 2 and seg[j + 1] < target:
            j += 1
        span = seg[j + 1] - seg[j] if j + 1 < len(seg) else 0.0
        t = 0.0 if span < 1e-6 else (target - seg[j]) / span
        if j + 1 < len(chain):
            a, b = chain[j], chain[j + 1]
        else:
            a, b = chain[j], chain[0]
        out.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
    return _close_cycle(out) if closed else out


def _meyer_watershed(empty, dist, seeds_xy):
    """Marker watershed on elevation = -distance. Label 1 is unused.

    Seeds are interior empty-space maxima. A pixel is claimed by the
    seed that reaches it at the highest saddle. Where two labels meet,
    the pixel is a dam (-1), so open U mouths close as cell walls.
    Keep pixels (empty==0) stay 0 — the wall sits on them.
    """
    h, w = empty.shape
    scale = 2.0
    maxb = int(float(dist.max()) * scale) + 2 if dist.size else 2
    maxb = max(maxb, 2)
    lab = np.zeros((h, w), np.int32)
    seed_at = {}
    sid = 1
    for x, y in seeds_xy:
        xi, yi = int(x), int(y)
        if not (0 <= yi < h and 0 <= xi < w):
            continue
        if empty[yi, xi] == 0 or lab[yi, xi] != 0:
            continue
        lab[yi, xi] = sid
        seed_at[sid] = (xi, yi, float(dist[yi, xi]))
        sid += 1
    if sid == 1:
        return lab, seed_at
    from collections import deque

    neigh = ((-1, 0), (1, 0), (0, -1), (0, 1))
    pending = np.zeros((h, w), np.uint8)
    qs = [deque() for _ in range(maxb + 1)]

    def push(y, x, bcur):
        if pending[y, x] or lab[y, x] != 0 or empty[y, x] == 0:
            return
        pending[y, x] = 1
        nb = int(float(dist[y, x]) * scale)
        if nb > bcur:
            nb = bcur
        qs[max(0, min(maxb, nb))].append((int(y), int(x)))

    ysl, xsl = np.where(lab > 0)
    for y, x in zip(ysl.tolist(), xsl.tolist()):
        for dy, dx in neigh:
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w:
                push(ny, nx, maxb)
    for b in range(maxb, -1, -1):
        q = qs[b]
        while q:
            y, x = q.popleft()
            if lab[y, x] != 0:
                continue
            votes = {}
            for dy, dx in neigh:
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w:
                    v = int(lab[ny, nx])
                    if v > 0:
                        votes[v] = votes.get(v, 0) + 1
            if not votes:
                pending[y, x] = 0
                continue
            if len(votes) > 1:
                lab[y, x] = -1
                continue
            lab[y, x] = next(iter(votes))
            for dy, dx in neigh:
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w:
                    push(ny, nx, b)
    return lab, seed_at


def _dist_peaks(empty, dist, min_d, ksz=7):
    if int(empty.sum()) < 8 or float(dist.max()) < min_d:
        return []
    k = max(3, int(ksz) | 1)
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    mx = cv2.dilate(dist, ker)
    m = ((empty > 0) & (dist + 1e-3 >= mx) & (dist >= min_d)).astype(np.uint8)
    n, lp, _, _ = cv2.connectedComponentsWithStats(m, 8)
    out = []
    for i in range(1, n):
        mm = lp == i
        tmp = np.where(mm, dist, -1.0)
        yi, xi = np.unravel_index(int(np.argmax(tmp)), tmp.shape)
        out.append((int(xi), int(yi)))
    return out


def _cell_cycle(mask, half_w):
    pts = _mask_outer_cycle(mask, offset=max(0.0, float(half_w) * 0.85))
    return _resample_cycle(pts, step=1.7, limit=360)


def _bbox_of(mask):
    ys, xs = np.where(mask > 0)
    if xs.size < 4:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1), int(xs.size)


def _watershed_wall_cycles(gkeep, okeep, circle, half_w, hull):
    """Basin walls of the dual-ink empty-space distance.

    Almond / nasal / tooth cycles are the full watershed cell around each
    maximum (the keep that rims the empty), not a 0.25·peak interior blob.
    Open tooth mouths dam where the saddle is narrower than the window.
    The jaw is the outer wall of the chin-side cell when that cell actually
    reaches below the frame. Frame is not emitted here.
    """
    if circle is None or gkeep is None:
        return [], []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    half = float(half_w) if half_w else 2.5
    g = (gkeep > 0).astype(np.uint8)
    o = np.zeros_like(g) if okeep is None else (okeep > 0).astype(np.uint8)
    keep = np.maximum(g, o)
    if hull is None:
        hull = np.ones_like(keep)
    empty, dist = _empty_space_dist(keep, hull)
    h, w = keep.shape
    disk = math.pi * rad * rad
    yy, xx = np.ogrid[:h, :w]

    # --- sockets + nasal: cells of mid-face maxima (full wall) ---
    face = (
        (empty > 0)
        & (yy > cy - 0.40 * rad)
        & (yy < cy + 0.55 * rad)
        & (np.abs(xx - cx) < 0.72 * rad)
    )
    face_empty = face.astype(np.uint8)
    # Distance inside the face band only, so a cheek peak cannot swallow the eye.
    face_dist = cv2.distanceTransform(face_empty, cv2.DIST_L2, 3)
    peaks = _dist_peaks(face_empty, face_dist, min_d=max(4.0, 0.018 * rad), ksz=9)
    lab, seeds = _meyer_watershed(face_empty, face_dist, peaks)
    pos = lab.copy()
    pos[pos < 0] = 0
    areas = np.bincount(pos.ravel()) if pos.size else np.zeros(1, np.int32)

    def _side_almond(sign):
        parts = []
        for sid, (x, y, pv) in seeds.items():
            if sid >= len(areas):
                continue
            a = int(areas[sid])
            xr = (x - cx) / rad
            yr = (y - cy) / rad
            if sign < 0 and not (-0.55 <= xr <= -0.08):
                continue
            if sign > 0 and not (0.08 <= xr <= 0.55):
                continue
            if not (-0.28 <= yr <= 0.22):
                continue
            if not (0.004 * disk <= a <= 0.055 * disk):
                continue
            parts.append((pv, sid, a, xr, yr))
        if not parts:
            return []
        parts.sort(reverse=True)
        # Union the fragments of one eye (a brow stroke often splits the almond).
        chosen = []
        ax = ay = 0.0
        for pv, sid, a, xr, yr in parts:
            if not chosen:
                chosen.append(sid)
                ax, ay = xr, yr
                continue
            if abs(xr - ax) < 0.20 and abs(yr - ay) < 0.18 and len(chosen) < 3:
                chosen.append(sid)
        m = np.zeros((h, w), np.uint8)
        for sid in chosen:
            m[lab == sid] = 1
        bb = _bbox_of(m)
        if bb is None:
            return []
        _x, _y, bw, bh, area = bb
        if bw < 0.16 * rad or bh < 0.07 * rad:
            return []
        asp = bw / max(float(bh), 1.0)
        if asp < 0.70 or asp > 3.6:
            return []
        # Reject a cheek plate: the cell must be rimmed by grey keep.
        ring = cv2.dilate(m, np.ones((3, 3), np.uint8)) & (m == 0)
        if int(ring.sum()) < 12 or float(g[ring > 0].mean()) < 0.15:
            return []
        pts = _cell_cycle(m, half)
        alen = _polyline_arc_len(pts)
        if len(pts) < 16 or not (0.45 * rad <= alen <= 2.8 * rad):
            return []
        return [pts]

    grey = []
    for sign in (-1, 1):
        grey.extend(_side_almond(sign))

    # Nasal: lower-centre maximum, taller-than-wide or compact, not the mouth.
    nasal_best = None
    for sid, (x, y, pv) in seeds.items():
        if sid >= len(areas):
            continue
        a = int(areas[sid])
        xr = (x - cx) / rad
        yr = (y - cy) / rad
        if abs(xr) > 0.22 or not (0.02 <= yr <= 0.46):
            continue
        if not (0.002 * disk <= a <= 0.04 * disk):
            continue
        m = (lab == sid).astype(np.uint8)
        bb = _bbox_of(m)
        if bb is None:
            continue
        _x, _y, bw, bh, _area = bb
        if bh < 0.06 * rad or bw > 0.55 * rad:
            continue
        key = (pv, a)
        if nasal_best is None or key > nasal_best[0]:
            nasal_best = (key, m)
    if nasal_best is not None:
        pts = _cell_cycle(nasal_best[1], half)
        alen = _polyline_arc_len(pts)
        if len(pts) >= 12 and 0.20 * rad <= alen <= 1.8 * rad:
            grey.append(pts)

    # --- tooth windows: small olive-band basins, including open U's ---
    tband = (
        (yy > cy + 0.55 * rad)
        & (yy < cy + 1.26 * rad)
        & (np.abs(xx - cx) < 0.50 * rad)
        & (hull > 0)
        & (keep == 0)
    )
    # Olive walls only — grey waterlines must not split the windows.
    t_empty = tband.astype(np.uint8)
    if int(o.sum()) >= 30:
        near_o = cv2.dilate(o, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
        t_empty = ((t_empty > 0) & (near_o > 0)).astype(np.uint8)
    t_dist = cv2.distanceTransform(t_empty, cv2.DIST_L2, 3) if int(t_empty.sum()) else t_empty.astype(np.float32)
    t_peaks = _dist_peaks(t_empty, t_dist, min_d=2.4, ksz=5)
    tlab, tseeds = _meyer_watershed(t_empty, t_dist, t_peaks)
    tpos = tlab.copy()
    tpos[tpos < 0] = 0
    tareas = np.bincount(tpos.ravel()) if tpos.size else np.zeros(1, np.int32)
    olive = []
    tooth_rows = []
    for sid, (x, y, pv) in tseeds.items():
        if sid >= len(tareas):
            continue
        a = int(tareas[sid])
        xr = (x - cx) / rad
        yr = (y - cy) / rad
        if not (0.58 <= yr <= 1.24 and abs(xr) <= 0.46):
            continue
        amin = max(24, int(0.00028 * disk))
        amax = max(900, int(0.006 * disk))
        if not (amin <= a <= amax) or pv > 11.0:
            continue
        m = (tlab == sid).astype(np.uint8)
        bb = _bbox_of(m)
        if bb is None:
            continue
        _x, _y, bw, bh, _area = bb
        asp = bw / max(float(bh), 1.0)
        if asp > 2.5 or asp < 0.32:
            continue
        compact = a / max(float(bw * bh), 1.0)
        if compact < 0.42:
            continue
        ring = cv2.dilate(m, np.ones((3, 3), np.uint8)) & (m == 0)
        if int(ring.sum()) < 8 or float(o[ring > 0].mean()) < 0.28:
            continue
        tooth_rows.append((yr, -pv, sid, m))
    tooth_rows.sort()
    for _yr, _pv, _sid, m in tooth_rows:
        pts = _cell_cycle(m, half * 0.65)
        alen = _polyline_arc_len(pts)
        if len(pts) < 8 or alen < 0.05 * rad or alen > 0.55 * rad:
            continue
        olive.append(pts)
        if len(olive) >= 14:
            break

    # --- outer wall: chin cell vs the hull-edge flood, grey keep is the ridge ---
    # Flat waterline CCs short the jaw. Drop only those separate CCs.
    barrier = g.copy()
    ncc, clab, cst, _ = cv2.connectedComponentsWithStats(barrier, 8)
    max_h = max(4, int(round(0.025 * rad)))
    min_w = int(round(0.22 * rad))
    for i in range(1, ncc):
        if int(cst[i, cv2.CC_STAT_WIDTH]) >= min_w and int(cst[i, cv2.CC_STAT_HEIGHT]) <= max_h:
            barrier[clab == i] = 0
    j_empty = ((hull > 0) & (barrier == 0) & (yy > cy + 0.15 * rad)).astype(np.uint8)
    if int(j_empty.sum()) > 40:
        # Outside seed: lowest empty pixel near the hull bottom on the midline.
        col = j_empty[:, int(np.clip(round(cx), 0, w - 1))]
        ys = np.where(col > 0)[0]
        seeds_j = []
        if ys.size:
            seeds_j.append((int(round(cx)), int(ys.max())))
        # Interior seed: empty just above the lowest grey keep on the midline
        # that is not a dropped waterline — the chin cup.
        mid = (barrier > 0) & (np.abs(xx - cx) < 0.16 * rad) & (yy > cy + 0.85 * rad)
        mys, mxs = np.where(mid)
        if mys.size:
            k = int(np.argmax(mys))
            iy = int(mys[k]) - max(3, int(round(half)))
            ix = int(mxs[k])
            if 0 <= iy < h and j_empty[iy, ix]:
                seeds_j.append((ix, iy))
        if len(seeds_j) >= 2:
            jlab, jseeds = _meyer_watershed(j_empty, cv2.distanceTransform(j_empty, cv2.DIST_L2, 3), seeds_j)
            # seed 1 is the bottom (outside); seed 2 is the cup
            if 2 in jseeds:
                cup = (jlab == 2).astype(np.uint8)
                bb = _bbox_of(cup)
                if bb is not None:
                    _x, _y, bw, bh, area = bb
                    reaches = (_y + bh) >= cy + 1.02 * rad
                    if 0.01 * disk <= area <= 0.20 * disk and bw >= 0.45 * rad and reaches:
                        pts = _cell_cycle(cup, half)
                        # Keep the lower run (the chin), drop a contour that is the frame.
                        if pts:
                            rs = [math.hypot(p[0] - cx, p[1] - cy) for p in pts]
                            if max(rs) >= 1.08 * rad and min(rs) < 1.35 * rad:
                                low = [p for p in pts if p[1] >= cy + 0.55 * rad]
                                if len(low) >= 16:
                                    grey.insert(0, _resample_cycle(low, step=2.0, limit=240))

    if len(grey) + len(olive) > 18:
        grey = grey[:4]
        olive = olive[:14]
    return grey, olive


def _fit_eye_cycles(gkeep, circle):
    """Ellipse fit of the closed left-eye keep hole, mirrored to the right.

    The right rim is open into the cheek, so it has no cell of its own.
    The fit is the hole's own inertia ellipse, not a fixed brow prior.
    """
    if gkeep is None or circle is None or int(gkeep.sum()) < 40:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    left = None
    for hz in _enclosed_holes(gkeep, 0):
        xr = (hz["cx"] - cx) / rad
        yr = (hz["cy"] - cy) / rad
        if hz["area"] < 0.008 * math.pi * rad * rad:
            continue
        if not (xr < -0.12 and -0.30 <= yr <= 0.18):
            continue
        asp = hz["bw"] / max(float(hz["bh"]), 1.0)
        if asp < 0.80 or asp > 3.8:
            continue
        if left is None or hz["area"] > left["area"]:
            left = hz
    if left is None:
        return []
    m = left["mask"].astype(np.uint8)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return []
    c = max(cnts, key=cv2.contourArea)
    if len(c) < 5:
        return []
    (ex, ey), (ea, eb), ang = cv2.fitEllipse(c)
    # OpenCV's angle spins the minor axis onto the eye. Keep the long axis horizontal.
    if eb > ea:
        ea, eb = eb, ea
        ang = float(ang) + 90.0
    if ea < 0.28 * rad or ea > 0.85 * rad or eb < 0.08 * rad or eb > 0.45 * rad:
        return []
    left_pts = _ellipse_cycle(ex, ey, ea, eb, ang, n=56)
    right_pts = _ellipse_cycle(2.0 * cx - ex, ey, ea, eb, -ang, n=56)
    return [left_pts, right_pts]


def _stiff_jaw_seam(rgb, gkeep, circle):
    """Darkest smooth U from temple to temple. Not a polar max, not a basin.

    A parabola prior only keeps the search near the chin; the path itself
    is the low-luma ridge (with a small bonus on grey keep). High step
    cost stops it cutting through the tooth grid.
    """
    if rgb is None or gkeep is None or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    luma = luma_map(rgb)
    dark = cv2.GaussianBlur((255.0 - luma), (0, 0), 1.4)
    n = max(24, int(1.5 * rad))
    xs = np.linspace(cx - 0.80 * rad, cx + 0.80 * rad, n)
    t = (xs - cx) / (0.80 * rad)
    y_end, y_chin = 0.62, 1.28
    y_prior = cy + (y_end + (y_chin - y_end) * (1.0 - t * t)) * rad
    rad_i = max(4, int(round(0.10 * rad)))
    xs_i = xs.astype(int)
    inf = 1e12
    prev = None
    backs = []
    for i, x in enumerate(xs_i):
        x = int(x)
        yc = int(round(float(y_prior[i])))
        cost = np.full(2 * rad_i + 1, inf, np.float64)
        bp = np.full(2 * rad_i + 1, -1, np.int32)
        for k in range(2 * rad_i + 1):
            y = yc - rad_i + k
            if not (0 <= y < h and 0 <= x < w):
                continue
            c = -float(dark[y, x]) + 1.1 * abs(y - float(y_prior[i]))
            if gkeep[y, x]:
                c -= 14.0
            if prev is None:
                cost[k] = c
                continue
            best, bj = inf, -1
            lo = max(0, k - 1)
            hi = min(int(prev.shape[0]), k + 2)
            for j in range(lo, hi):
                v = float(prev[j]) + c + 8.0 * (k - j) ** 2
                if v < best:
                    best, bj = v, j
            cost[k] = best
            bp[k] = bj
        backs.append(bp)
        prev = cost
    if prev is None or not np.isfinite(prev).any():
        return []
    k = int(np.argmin(prev))
    pts = []
    for i in range(len(xs_i) - 1, -1, -1):
        y = int(round(float(y_prior[i]))) - rad_i + k
        pts.append((float(xs_i[i]), float(y)))
        if i == 0:
            break
        k = int(backs[i][k])
        if k < 0:
            return []
    pts.reverse()
    if max(p[1] for p in pts) < cy + 1.05 * rad:
        return []
    # Moving average so the cubic is an even jaw, not a 1px dither.
    sm = []
    win = 7
    npts = len(pts)
    for i in range(npts):
        accx = accy = 0.0
        c = 0
        for j in range(max(0, i - win), min(npts, i + win + 1)):
            accx += pts[j][0]
            accy += pts[j][1]
            c += 1
        sm.append((accx / c, accy / c))
    return _resample_cycle(sm, step=2.4, limit=180)


def _olive_window_cells(okeep, circle, half_w):
    """Tooth windows: seal only gaps thinner than a window, then take holes.

    A 9px close bridges open hanging mouths without merging windows that
    a real olive wall still separates. Larger closes collapse the grid.
    """
    if okeep is None or circle is None or int(okeep.sum()) < 30:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = okeep.shape
    yy, xx = np.ogrid[:h, :w]
    band = (
        (yy > cy + 0.55 * rad)
        & (yy < cy + 1.28 * rad)
        & (np.abs(xx - cx) < 0.48 * rad)
    )
    src = ((okeep > 0) & band).astype(np.uint8)
    if int(src.sum()) < 40:
        return []
    src = cv2.morphologyEx(
        src, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    )
    out = []
    for hz in _enclosed_holes(src, 0):
        xr = (hz["cx"] - cx) / rad
        yr = (hz["cy"] - cy) / rad
        if not (0.58 <= yr <= 1.24 and abs(xr) <= 0.42):
            continue
        if not (50 <= hz["area"] <= 900):
            continue
        asp = hz["bw"] / max(float(hz["bh"]), 1.0)
        if asp > 2.6 or asp < 0.32:
            continue
        pts = _cell_cycle(hz["mask"].astype(np.uint8), float(half_w) * 0.55)
        alen = _polyline_arc_len(pts)
        if len(pts) < 8 or alen < 0.05 * rad or alen > 0.55 * rad:
            continue
        out.append(pts)
        if len(out) >= 14:
            break
    return out


def _mouth_olive_contours(okeep, circle, half_w):
    """Outer contour of each mouth-band olive component.

    Those contours trace the tooth grid, including the side columns and the
    hanging row. A skeleton of the same components turns the walls into spurs.
    """
    if okeep is None or circle is None or int(okeep.sum()) < 30:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = okeep.shape
    yy, xx = np.ogrid[:h, :w]
    band = (
        (yy > cy + 0.52 * rad)
        & (yy < cy + 1.32 * rad)
        & (np.abs(xx - cx) < 0.58 * rad)
    )
    src = ((okeep > 0) & band).astype(np.uint8)
    n, lab, st, cents = cv2.connectedComponentsWithStats(src, 8)
    rows = []
    for i in range(1, n):
        area = int(st[i, cv2.CC_STAT_AREA])
        if area < 160 or area > 7000:
            continue
        m = (lab == i).astype(np.uint8)
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        if not cnts:
            continue
        c = max(cnts, key=cv2.contourArea)
        pts = [(float(p[0][0]) + 0.5, float(p[0][1]) + 0.5) for p in c]
        pts = _resample_cycle(_close_cycle(pts), step=1.6, limit=280)
        alen = _polyline_arc_len(pts)
        if len(pts) < 8 or alen < 0.08 * rad or alen > 2.4 * rad:
            continue
        rows.append((float(cents[i, 1]), float(cents[i, 0]), pts))
    rows.sort()
    return [p for _y, _x, p in rows[:16]]


def _chin_keep_polyline(gkeep, circle):
    """Lowest grey-keep run under the teeth, per column, then smoothed.

    Search stays below the tooth row so the path cannot ride the upper
    occlusal line. Not a polar max: each column takes the keep tick nearest
    a chin parabola, and columns with no keep are dropped.
    """
    if gkeep is None or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    n = max(28, int(1.3 * rad))
    xs = np.linspace(cx - 0.70 * rad, cx + 0.70 * rad, n)
    t = (xs - cx) / (0.70 * rad)
    y_prior = cy + (0.98 + 0.36 * (1.0 - t * t)) * rad
    y_lo = int(cy + 0.92 * rad)
    y_hi = int(min(h - 1, cy + 1.48 * rad))
    if y_hi <= y_lo + 4:
        return []
    pts = []
    hits = 0
    for x, yp in zip(xs, y_prior):
        xi = int(np.clip(round(float(x)), 0, w - 1))
        col = gkeep[y_lo:y_hi, xi] > 0
        ys = np.where(col)[0]
        if ys.size < 1:
            continue
        abs_y = ys.astype(np.float32) + y_lo
        # Lowest keep in the under-teeth band is the chin bone, not a tooth wall.
        y = float(np.percentile(abs_y, 92))
        if abs(y - float(yp)) > 0.28 * rad:
            continue
        hits += 1
        pts.append((float(xi), y))
    if hits < 0.40 * n or len(pts) < 16:
        return []
    ys = [p[1] for p in pts]
    if max(ys) < cy + 1.08 * rad:
        return []
    sm = []
    win = 10
    for i in range(len(pts)):
        accx = accy = 0.0
        c = 0
        for j in range(max(0, i - win), min(len(pts), i + win + 1)):
            accx += pts[j][0]
            accy += pts[j][1]
            c += 1
        sm.append((accx / c, accy / c))
    return _resample_cycle(sm, step=2.2, limit=160)


def _jaw_tracks_keep(pts, gkeep, min_frac=0.30):
    if not pts or gkeep is None:
        return False
    h, w = gkeep.shape
    inv = (gkeep == 0).astype(np.uint8)
    dt = cv2.distanceTransform(inv, cv2.DIST_L2, 3)
    hit = tot = 0
    for x, y in pts[::2]:
        xi, yi = int(round(x)), int(round(y))
        if 0 <= yi < h and 0 <= xi < w:
            tot += 1
            if float(dt[yi, xi]) <= 3.0:
                hit += 1
    return tot >= 8 and (hit / float(tot)) >= min_frac


def _smooth_chain(pts, win=9, closed=False):
    n = len(pts)
    if n < 4 or win < 3:
        return list(pts)
    r = int(win) // 2
    out = []
    for i in range(n):
        ax = ay = 0.0
        for k in range(-r, r + 1):
            if closed:
                j = (i + k) % n
            else:
                j = min(n - 1, max(0, i + k))
            ax += pts[j][0]
            ay += pts[j][1]
        out.append((ax / (2 * r + 1), ay / (2 * r + 1)))
    return out


def _clip_steep_ends(pts, slope=2.0):
    """Drop vertical end spikes so a chin U does not climb the cheek."""
    pts = list(pts)
    while len(pts) > 12:
        dy = pts[1][1] - pts[0][1]
        dx = abs(pts[1][0] - pts[0][0])
        if abs(dy) > slope * max(dx, 0.5):
            pts.pop(0)
        else:
            break
    while len(pts) > 12:
        dy = pts[-1][1] - pts[-2][1]
        dx = abs(pts[-1][0] - pts[-2][0])
        if abs(dy) > slope * max(dx, 0.5):
            pts.pop()
        else:
            break
    return pts


def _cycle_from_hole(mask, dilate_px):
    m = (mask > 0).astype(np.uint8)
    if dilate_px >= 1:
        k = 2 * int(dilate_px) + 1
        m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return []
    c = max(cnts, key=cv2.contourArea)
    if len(c) < 8:
        return []
    pts = [(float(p[0][0]), float(p[0][1])) for p in c]
    pts = _smooth_chain(pts, win=9, closed=True)
    return _resample_cycle(_close_cycle(pts), step=2.6, limit=72)


def _almond_basin_cycles(gkeep, circle, half_w):
    """Basin wall of each closed eye hole. Mirror the closed side if the
    other rim is open into the cheek (no cell of its own).

    The cycle is the hole boundary pushed onto the rim, not an inertia
    ellipse and not the 0.25·peak blob inside the socket.
    """
    if gkeep is None or circle is None or int(gkeep.sum()) < 30:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    yy, xx = np.ogrid[:h, :w]
    eye = (yy > cy - 0.42 * rad) & (yy < cy + 0.26 * rad) & (np.abs(xx - cx) < 0.72 * rad)
    src = ((gkeep > 0) & eye).astype(np.uint8)
    if int(src.sum()) < 20:
        return []
    disk = math.pi * rad * rad
    amin = max(80.0, 0.006 * disk)
    amax = 0.08 * disk
    found = []
    for hz in _enclosed_holes(src, 0):
        xr = (hz["cx"] - cx) / rad
        yr = (hz["cy"] - cy) / rad
        if not (amin <= hz["area"] <= amax):
            continue
        if not (-0.32 <= yr <= 0.20 and 0.10 <= abs(xr) <= 0.58):
            continue
        asp = hz["bw"] / max(float(hz["bh"]), 1.0)
        if asp < 0.65 or asp > 3.8:
            continue
        found.append((xr, hz))
    if not found:
        return []
    dilate_px = max(1, int(round(float(half_w) * 0.65)))
    left = [hz for xr, hz in found if xr < 0]
    right = [hz for xr, hz in found if xr > 0]
    left.sort(key=lambda hz: -hz["area"])
    right.sort(key=lambda hz: -hz["area"])
    cycles = []
    if left:
        pts = _cycle_from_hole(left[0]["mask"], dilate_px)
        if len(pts) >= 12:
            cycles.append(pts)
            if not right:
                cycles.append([(2.0 * cx - x, y) for x, y in pts])
    if right:
        pts = _cycle_from_hole(right[0]["mask"], dilate_px)
        if len(pts) >= 12:
            cycles.append(pts)
            if not left:
                cycles.append([(2.0 * cx - x, y) for x, y in pts])
    return cycles


def _chin_medial_polyline(gkeep, circle):
    """Faired medial of the lowest grey-keep run under the teeth.

    Each column contributes the bottom of the chin ribbon. Steep end
    spikes (the cheek climb) are clipped, then the run is smoothed so
    the cubic is one even jaw, not a water dither.
    """
    if gkeep is None or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    y0 = int(cy + 1.00 * rad)
    y1 = int(min(h - 1, cy + 1.55 * rad))
    if y1 <= y0 + 6:
        return []
    x0 = int(max(0, cx - 0.74 * rad))
    x1 = int(min(w - 1, cx + 0.74 * rad))
    samples = []
    for x in range(x0, x1 + 1):
        col = np.where(gkeep[y0:y1, x] > 0)[0]
        if col.size < 1:
            continue
        samples.append((float(x), float(int(col.max()) + y0)))
    if len(samples) < 24:
        return []
    # The chin must hang below the circular frame. A run stuck on the
    # frame bottom is the circle, which is emitted as its own primitive.
    if max(p[1] for p in samples) < cy + 1.08 * rad:
        return []
    sm = _smooth_chain(samples, win=21, closed=False)
    sm = _clip_steep_ends(sm, slope=1.6)
    if len(sm) < 16:
        return []
    sm = _smooth_chain(sm, win=17, closed=False)
    # Seat the curve on the outer chin bone. Column maxima ride the inner
    # edge of a thick jaw ribbon.
    drop = max(3.0, 0.022 * rad)
    sm = [(x, y + drop) for x, y in sm]
    ys = [p[1] for p in sm]
    if max(ys) < cy + 1.08 * rad:
        return []
    if max(ys) - min(ys) < 0.08 * rad:
        return []
    return _resample_cycle(sm, step=2.8, limit=80)


def _cheek_silhouette_polylines(gkeep, circle):
    """Outer skull wall, one polyline per side.

    Per row, the outermost grey keep pixel under the eyes, after horizontal
    water runs are dropped. Not a polar max and not a walk of every tick.
    """
    if gkeep is None or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    g = (gkeep > 0).astype(np.uint8)
    water = cv2.morphologyEx(
        g, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (41, 1))
    )
    g = g.copy()
    g[water > 0] = 0
    y0 = int(cy - 0.02 * rad)
    y1 = int(min(h - 1, cy + 1.22 * rad))
    if y1 <= y0 + 20:
        return []

    def side(x_lo, x_hi, pick_max):
        pts = []
        xa = int(max(0, x_lo))
        xb = int(min(w - 1, x_hi))
        if xb <= xa + 4:
            return []
        for y in range(y0, y1 + 1):
            xs = np.where(g[y, xa:xb] > 0)[0]
            if xs.size < 1:
                continue
            x = float(xa + (int(xs.max()) if pick_max else int(xs.min())))
            pts.append((x, float(y)))
        if len(pts) < 40:
            return []
        pts = _smooth_chain(pts, win=31, closed=False)
        # Drop a trace that is just the circular frame.
        rs = [math.hypot(x - cx, y - cy) for x, y in pts]
        if abs(float(np.median(rs)) - rad) < 0.05 * rad and (max(rs) - min(rs)) < 0.12 * rad:
            return []
        return _resample_cycle(pts, step=3.2, limit=90)

    out = []
    left = side(cx - 1.05 * rad, cx - 0.12 * rad, False)
    right = side(cx + 0.12 * rad, cx + 1.05 * rad, True)
    if left:
        out.append(left)
    if right:
        out.append(right)
    return out


def _mouth_olive_mask(okeep, circle):
    """Thin olive ribbons in the mouth band (tooth walls), specks opened away."""
    if okeep is None or circle is None:
        return None
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = okeep.shape
    yy, xx = np.ogrid[:h, :w]
    band = (
        (yy > cy + 0.42 * rad)
        & (yy < cy + 1.32 * rad)
        & (np.abs(xx - cx) < 0.56 * rad)
    )
    src = ((okeep > 0) & band).astype(np.uint8)
    if int(src.sum()) < 40:
        return None
    # Close hairline cracks in the ribbon. Do not open: hanging teeth are
    # only a few pixels wide and an open deletes that row.
    src = cv2.morphologyEx(
        src, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    )
    return src


def _nasal_grey_mask(gkeep, circle):
    """Grey keep in the nasal box only — the cavity outline, not the skull plate."""
    if gkeep is None or circle is None:
        return None
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    yy, xx = np.ogrid[:h, :w]
    box = (
        (yy > cy + 0.00 * rad)
        & (yy < cy + 0.50 * rad)
        & (np.abs(xx - cx) < 0.30 * rad)
    )
    src = ((gkeep > 0) & box).astype(np.uint8)
    if int(src.sum()) < 30:
        return None
    n, lab, st, _ = cv2.connectedComponentsWithStats(src, 8)
    out = np.zeros_like(src)
    for i in range(1, n):
        a = int(st[i, cv2.CC_STAT_AREA])
        bw = int(st[i, cv2.CC_STAT_WIDTH])
        bh = int(st[i, cv2.CC_STAT_HEIGHT])
        if a < 28:
            continue
        if bh <= 3 and bw > 18:
            continue
        out[lab == i] = 1
    if int(out.sum()) < 30:
        return None
    return out


def _tooth_window_cycles(okeep, circle, half_w):
    """Closed tooth-window walls (enclosed olive holes), for the unit bar.

    The poster paints the mouth olive ribbon itself so open hanging teeth
    stay in the drawing; these cycles are the basins that ribbon encloses.
    """
    src = _mouth_olive_mask(okeep, circle)
    if src is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    disk = math.pi * rad * rad
    out = []
    for hz in _enclosed_holes(src, 0):
        xr = (hz["cx"] - cx) / rad
        yr = (hz["cy"] - cy) / rad
        if not (0.50 <= yr <= 1.28 and abs(xr) <= 0.48):
            continue
        if not (max(20.0, 0.00015 * disk) <= hz["area"] <= 0.012 * disk):
            continue
        asp = hz["bw"] / max(float(hz["bh"]), 1.0)
        if asp > 3.2 or asp < 0.28:
            continue
        pts = _cycle_from_hole(hz["mask"], max(1, int(round(float(half_w) * 0.45))))
        if len(pts) < 8:
            continue
        out.append(pts)
        if len(out) >= 14:
            break
    return out


def _basin_interiors(gkeep, okeep, circle, almond_cycles):
    """Eye basins and enclosed tooth windows — veil openings, not keep ticks."""
    if circle is None:
        return None
    h, w = (gkeep if gkeep is not None else okeep).shape
    m = np.zeros((h, w), np.uint8)
    for pts in almond_cycles or []:
        if len(pts) < 6:
            continue
        arr = np.array([[int(round(p[0])), int(round(p[1]))] for p in pts], np.int32)
        cv2.fillPoly(m, [arr], 1)
    src = _mouth_olive_mask(okeep, circle)
    if src is not None:
        for hz in _enclosed_holes(src, 0):
            if hz["area"] < 24:
                continue
            m[hz["mask"]] = 1
    # Shrink one pixel so the opening does not eat the wall.
    m = cv2.erode(m, np.ones((3, 3), np.uint8))
    if int(m.sum()) < 20:
        return None
    return m


def _almond_hole_cycles(gkeep, circle, half_w):
    """Full cell of each enclosed mid-face hole — the rim, not the interior blob."""
    if gkeep is None or circle is None or int(gkeep.sum()) < 30:
        return [], []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    yy, xx = np.ogrid[:h, :w]
    eye = (yy > cy - 0.42 * rad) & (yy < cy + 0.30 * rad) & (np.abs(xx - cx) < 0.70 * rad)
    src = ((gkeep > 0) & eye).astype(np.uint8)
    disk = math.pi * rad * rad
    found = []
    for z in _enclosed_holes(src, 0):
        xr = (z["cx"] - cx) / rad
        yr = (z["cy"] - cy) / rad
        if not (0.010 * disk <= z["area"] <= 0.070 * disk):
            continue
        if not (-0.28 <= yr <= 0.22 and 0.12 <= abs(xr) <= 0.55):
            continue
        asp = z["bw"] / max(float(z["bh"]), 1.0)
        if asp < 0.80 or asp > 3.5:
            continue
        if z["bh"] > 0.48 * rad or z["bw"] < 0.18 * rad:
            continue
        pts = _cell_cycle(z["mask"].astype(np.uint8), half_w)
        alen = _polyline_arc_len(pts)
        if len(pts) < 16 or not (0.45 * rad <= alen <= 2.8 * rad):
            continue
        found.append((xr, z, pts))
    left = [t for xr, _z, t in found if xr < 0]
    right = [t for xr, _z, t in found if xr > 0]
    # Largest hole per side (the almond, not a brow speck).
    out = []
    if left:
        out.append(max(left, key=_polyline_arc_len))
    if right:
        out.append(max(right, key=_polyline_arc_len))
    masks = []
    if left:
        masks.append(max((z for xr, z, _t in found if xr < 0), key=lambda z: z["area"]))
    if right:
        masks.append(max((z for xr, z, _t in found if xr > 0), key=lambda z: z["area"]))
    return out, masks


def _seat_open_socket(mask, rgb, gkeep, circle, half_w):
    """Seat a closed almond wall onto the open socket by warm overlap.

    The open rim has no watershed cell of its own (it leaks into the cheek).
    The closed cell is translated, not redrawn, and kept only when most of
    its interior lands on the same red and its rim still touches grey keep.
    """
    if rgb is None or mask is None or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    m = mask["mask"]
    ys, xs = np.where(m)
    if xs.size < 80:
        return []
    # Mirror across the frame centre, then search a small seat.
    mx = (2.0 * cx - xs).astype(np.int32)
    my = ys.astype(np.int32)
    ok = (mx >= 0) & (mx < w) & (my >= 0) & (my < h)
    if int(ok.sum()) < 80:
        return []
    rr = rgb[:, :, 0].astype(np.int16)
    gg = rgb[:, :, 1].astype(np.int16)
    bb = rgb[:, :, 2].astype(np.int16)
    # Left-socket red is dark in g. The open socket is a lighter pink, so
    # the gate is loose on g but still rejects the sun and the orange cheek.
    warm = (rr > 150) & (rr > gg + 22) & (gg < 185) & (bb < 190) & ~((rr > 235) & (gg > 210))
    near = cv2.dilate((gkeep > 0).astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    best = None
    # Stay on the open eye's line. A downward search seats the wall on the cheek.
    src_yr = (float(np.mean(ys)) - cy) / rad
    for dy in range(-int(0.04 * rad), int(0.05 * rad) + 1, 2):
        for dx in range(-int(0.08 * rad), int(0.08 * rad) + 1, 2):
            x2 = mx[ok] + dx
            y2 = my[ok] + dy
            inn = (x2 >= 0) & (x2 < w) & (y2 >= 0) & (y2 < h)
            if int(inn.sum()) < 80:
                continue
            x2, y2 = x2[inn], y2[inn]
            # Stay on the open side of the frame.
            if float(np.mean(x2)) < cx + 0.08 * rad or float(np.mean(x2)) > cx + 0.55 * rad:
                continue
            seat_yr = (float(np.mean(y2)) - cy) / rad
            if abs(seat_yr - src_yr) > 0.08:
                continue
            warm_f = float(warm[y2, x2].mean())
            rim = float(near[y2, x2].mean())
            # Rim contact matters: a cheek seat is warm but not on the grey lid.
            score = warm_f + 0.35 * rim
            if best is None or score > best[0]:
                best = (score, warm_f, rim, dx, dy, x2, y2)
    if best is None or best[1] < 0.34 or best[2] < 0.15:
        return []
    _sc, warm_f, rim, dx, dy, _x2, _y2 = best
    seated = np.zeros((h, w), np.uint8)
    x2 = mx[ok] + dx
    y2 = my[ok] + dy
    inn = (x2 >= 0) & (x2 < w) & (y2 >= 0) & (y2 < h)
    seated[y2[inn], x2[inn]] = 1
    if int(seated.sum()) < 0.008 * math.pi * rad * rad:
        return []
    pts = _cell_cycle(seated, half_w)
    alen = _polyline_arc_len(pts)
    if len(pts) < 16 or not (0.45 * rad <= alen <= 2.8 * rad):
        return []
    return [pts]


def _olive_basin_cycles(okeep, circle, half_w, hull):
    """Tooth windows: Meyer cells of olive-only empty, including open U's.

    Grey waterlines are not barriers here — they split the windows into
    spur-sized gaps. An exterior seed below the grid dams a hanging mouth
    at its opening. Cells are the full basin, not a 0.25·peak blob.
    """
    if okeep is None or circle is None or int(okeep.sum()) < 30:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = okeep.shape
    yy, xx = np.ogrid[:h, :w]
    disk = math.pi * rad * rad
    mb = (
        (yy > cy + 0.50 * rad)
        & (yy < cy + 1.24 * rad)
        & (np.abs(xx - cx) < 0.50 * rad)
    )
    if hull is not None:
        mb = mb & (hull > 0)
    barrier = ((okeep > 0) & mb).astype(np.uint8)
    if int(barrier.sum()) < 40:
        return []
    # Hairline cracks in a wall only. A 9px close merges the grid.
    barrier = cv2.morphologyEx(
        barrier, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    )
    tempty = (mb & (barrier == 0)).astype(np.uint8)
    if int(tempty.sum()) < 30:
        return []
    tdist = cv2.distanceTransform(tempty, cv2.DIST_L2, 5)
    ksz = max(5, int(round(0.045 * rad)) | 1)
    peaks = _dist_peaks(tempty, tdist, min_d=max(2.4, 0.9 * float(half_w)), ksz=ksz)
    tooth, exterior = [], []
    for x, y in peaks:
        d = float(tdist[y, x])
        xr = (x - cx) / rad
        yr = (y - cy) / rad
        if 0.55 <= yr <= 1.22 and abs(xr) <= 0.42 and d <= 0.08 * rad:
            tooth.append((x, y, d))
        else:
            exterior.append((x, y))
    under_y = int(np.clip(round(cy + 1.20 * rad), 0, h - 1))
    under_x = int(np.clip(round(cx), 0, w - 1))
    if tempty[under_y, under_x]:
        exterior.append((under_x, under_y))
    if not tooth:
        return []
    seeds = [(a, b) for a, b, _d in tooth] + exterior[:12]
    tlab, _seeds = _meyer_watershed(tempty, tdist, seeds)
    out = []
    for i, (x, y, d) in enumerate(tooth, start=1):
        cell = (tlab == i).astype(np.uint8)
        area = int(cell.sum())
        if area < 8:
            continue
        bb = _bbox_of(cell)
        if bb is None:
            continue
        _x, _y, bw, bh, _area = bb
        yr = (y - cy) / rad
        asp = bw / max(float(bh), 1.0)
        rel = area / disk
        ring = cv2.dilate(cell, np.ones((3, 3), np.uint8)) & (cell == 0)
        ofrac = float((okeep > 0)[ring > 0].mean()) if int(ring.sum()) else 0.0
        # Upper windows are the larger squarer basins. Hanging teeth are
        # the taller cells under them. Nasal specks sit above and are smaller.
        if 0.55 <= yr < 0.98:
            if not (0.0016 <= rel <= 0.012 and 0.55 <= asp <= 1.85 and ofrac >= 0.35 and bh >= 0.04 * rad):
                continue
        elif 0.98 <= yr <= 1.22:
            if not (0.00040 <= rel <= 0.008 and 0.35 <= asp <= 1.7 and ofrac >= 0.40 and bh >= 0.035 * rad):
                continue
        else:
            continue
        pts = _cell_cycle(cell, max(1.2, float(half_w) * 0.45))
        alen = _polyline_arc_len(pts)
        if len(pts) < 8 or alen < 0.04 * rad or alen > 0.65 * rad:
            continue
        out.append((yr, pts))
        if len(out) >= 14:
            break
    out.sort()
    return [p for _yr, p in out]


def _jaw_lower_wall(gkeep, circle):
    """Faired outer wall of the skull component that reaches the chin.

    Wide horizontal water is dropped first, so a sunset arc under the chin
    is not the bone. The component must reach both the cheeks and the chin;
    its lower envelope is the jaw. Smoothed to one even U.
    """
    if gkeep is None or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    g = (gkeep > 0).astype(np.uint8)
    yy, xx = np.ogrid[:h, :w]
    rr = np.hypot(xx.astype(np.float32) - cx, yy.astype(np.float32) - cy)
    on_frame = np.abs(rr - rad) <= max(3.0, 0.045 * rad)
    water = cv2.morphologyEx(
        g, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (41, 1))
    )
    src = g.copy()
    src[water > 0] = 0
    src[on_frame] = 0
    # Keep the search inside the skull's horizontal span.
    src[:, : int(max(0, cx - 0.85 * rad))] = 0
    src[:, int(min(w, cx + 0.85 * rad)) :] = 0
    n, lab, st, _ = cv2.connectedComponentsWithStats(src, 8)
    best = None
    for i in range(1, n):
        top = int(st[i, cv2.CC_STAT_TOP])
        height = int(st[i, cv2.CC_STAT_HEIGHT])
        width = int(st[i, cv2.CC_STAT_WIDTH])
        bot = top + height
        if bot < cy + 1.12 * rad:
            continue
        if top > cy + 0.72 * rad:
            continue
        if width < 0.40 * rad:
            continue
        area = int(st[i, cv2.CC_STAT_AREA])
        if best is None or area > best[0]:
            best = (area, i)
    if best is None:
        return []
    comp = lab == best[1]
    y0 = int(cy + 0.70 * rad)
    y1 = int(min(h - 1, cy + 1.48 * rad))
    x0 = int(max(0, cx - 0.78 * rad))
    x1 = int(min(w - 1, cx + 0.78 * rad))
    pts = []
    for x in range(x0, x1 + 1):
        col = np.where(comp[y0:y1, x])[0]
        if col.size < 1:
            continue
        yb = int(col.max())
        ya = yb
        while ya > int(col.min()) and comp[y0 + ya - 1, x]:
            ya -= 1
        if (yb - ya + 1) > 0.09 * rad:
            continue
        pts.append((float(x), y0 + 0.5 * (ya + yb)))
    if len(pts) < 18:
        return []
    kept = []
    for i, (x, y) in enumerate(pts):
        lo = max(0, i - 5)
        hi = min(len(pts), i + 6)
        local = float(np.median([pts[j][1] for j in range(lo, hi)]))
        if abs(y - local) > 0.07 * rad:
            continue
        kept.append((x, y))
    if len(kept) < 16:
        return []
    sm = _smooth_chain(kept, win=23, closed=False)
    sm = _clip_steep_ends(sm, slope=1.25)
    if len(sm) < 12:
        return []
    sm = _smooth_chain(sm, win=17, closed=False)
    ys = [p[1] for p in sm]
    xs = [p[0] for p in sm]
    if max(ys) < cy + 1.10 * rad:
        return []
    if max(ys) - min(ys) < 0.06 * rad:
        return []
    if max(xs) - min(xs) < 0.35 * rad:
        return []
    mid_y = sm[len(sm) // 2][1]
    if mid_y + 0.03 * rad < max(sm[0][1], sm[-1][1]):
        return []
    return _resample_cycle(sm, step=2.8, limit=80)


def _watershed_empty_walls(gkeep, okeep, circle, half_w, hull=None, rgb=None):
    """Basin walls of the dual-ink empty-space distance.

    Almond rims are the full enclosed cells. An open socket is that same
    wall seated onto the warm pixels of the other eye. Tooth windows are
    olive-only watershed cells, hanging mouths included. The jaw is the
    faired lower grey wall. Not a spur-walk, not a skeleton dilate, not a
    filled plate, not a polar max.
    """
    if circle is None:
        return [], []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    if rad < 20.0:
        return [], []
    half = float(half_w) if half_w else 2.5
    grey = []
    holes = []
    try:
        cycles, holes = _almond_hole_cycles(gkeep, circle, half)
    except Exception:
        cycles, holes = [], []
    grey.extend(cycles)
    # One closed almond and an open other side: seat the closed wall.
    if rgb is not None and len(holes) == 1 and len(cycles) == 1:
        seated = _seat_open_socket(holes[0], rgb, gkeep, circle, half)
        grey.extend(seated)
    jaw = _jaw_lower_wall(gkeep, circle)
    if jaw:
        grey.insert(0, jaw)
    olive = _olive_basin_cycles(okeep, circle, half, hull)
    if len(grey) > 6:
        grey = grey[:6]
    if len(olive) > 14:
        olive = olive[:14]
    return grey, olive


def _strict_socket_red(rgb):
    """Dark socket red. Cheek orange and the sun fail this gate."""
    rr = rgb[:, :, 0].astype(np.int16)
    gg = rgb[:, :, 1].astype(np.int16)
    bb = rgb[:, :, 2].astype(np.int16)
    return (rr > 170) & (rr > gg + 30) & (gg < 155) & (bb < 165)


def _seat_on_red_centroid(mask, rgb, circle, half_w):
    """Translate the closed almond onto the other eye, same height.

    The wall is the closed hole, not a brow component. Recoloring is left
    to the caller, and only when the interior is actually socket red.
    """
    if rgb is None or mask is None or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = rgb.shape[:2]
    m = mask["mask"]
    ys, xs = np.where(m)
    if xs.size < 80:
        return []
    side = 1.0 if float(xs.mean()) < cx else -1.0
    src_yr = (float(ys.mean()) - cy) / rad
    rr = rgb[:, :, 0].astype(np.int16)
    gg = rgb[:, :, 1].astype(np.int16)
    bb = rgb[:, :, 2].astype(np.int16)
    red = (rr > 160) & (rr > gg + 22) & (gg < 175) & (bb < 170) & ~((rr > 235) & (gg > 210))
    yy, xx = np.ogrid[:h, :w]
    if side > 0:
        band = (xx > cx + 0.05 * rad) & (xx < cx + 0.62 * rad)
    else:
        band = (xx < cx - 0.05 * rad) & (xx > cx - 0.62 * rad)
    band = band & (yy > cy + (src_yr - 0.16) * rad) & (yy < cy + (src_yr + 0.20) * rad)
    src = (red & band).astype(np.uint8)
    n, lab, st, cents = cv2.connectedComponentsWithStats(src, 8)
    target_a = float(xs.size)
    best = None
    for i in range(1, n):
        area = int(st[i, cv2.CC_STAT_AREA])
        if area < 0.20 * target_a:
            continue
        xr = (float(cents[i, 0]) - cx) / rad
        yr = (float(cents[i, 1]) - cy) / rad
        if side > 0 and not (0.12 <= xr <= 0.55):
            continue
        if side < 0 and not (-0.55 <= xr <= -0.12):
            continue
        if abs(yr - src_yr) > 0.12:
            continue
        err = abs(yr - src_yr) * 4.0 + abs(area - target_a) / target_a
        if best is None or err < best[0]:
            best = (err, float(cents[i, 0]), float(cents[i, 1]))
    if best is None:
        return []
    _err, tx, ty = best
    mx = 2.0 * cx - xs.astype(np.float32)
    my = ys.astype(np.float32)
    dx = tx - float(mx.mean())
    dy = ty - float(my.mean()) + 0.05 * rad
    x2 = np.clip(np.rint(mx + dx).astype(np.int32), 0, w - 1)
    y2 = np.clip(np.rint(my + dy).astype(np.int32), 0, h - 1)
    seated = np.zeros((h, w), np.uint8)
    seated[y2, x2] = 1
    if int(seated.sum()) < 0.008 * math.pi * rad * rad:
        return []
    pts = _cell_cycle(seated, half_w)
    alen = _polyline_arc_len(pts)
    if len(pts) < 16 or not (0.45 * rad <= alen <= 2.8 * rad):
        return []
    return [pts]


def _dark_bone_cycles(gkeep, okeep, circle, half_w, hull=None, rgb=None):
    """Dark-bone tooth lattice. Not a watershed and not a bright-water trace.

    Sunset stripes that leak into the keep are bright. Skull lines are not.
    Almonds are the enclosed eye hole; the open socket is that hole seated
    on the strict-red centroid. Tooth windows are holes in the dark mouth
    bone after a short vertical cap (open tops close, neighbouring windows
    stay apart). The jaw is the faired lower run of that dark bone.
    """
    if circle is None or gkeep is None:
        return [], []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    if rad < 20.0:
        return [], []
    half = float(half_w) if half_w else 2.5
    h, w = gkeep.shape
    g = (gkeep > 0).astype(np.uint8)
    o = np.zeros_like(g) if okeep is None else (okeep > 0).astype(np.uint8)
    union = np.maximum(g, o)
    if rgb is not None:
        bone = (union > 0) & (luma_map(rgb) < 172.0)
        bone = bone.astype(np.uint8)
    else:
        bone = union
    grey = []
    cycles, holes = _almond_hole_cycles(g, circle, half)
    grey.extend(cycles)
    if rgb is not None and len(holes) == 1 and len(cycles) == 1:
        grey.extend(_seat_on_red_centroid(holes[0], rgb, circle, half))

    # Teeth. A tall 3px-wide cap closes an open window top. It does not
    # bridge the horizontal gap between neighbouring teeth.
    yy, xx = np.ogrid[:h, :w]
    disk = math.pi * rad * rad
    mb = (yy > cy + 0.55 * rad) & (yy < cy + 1.28 * rad) & (np.abs(xx - cx) < 0.50 * rad)
    if hull is not None:
        mb = mb & (hull > 0)
    src = ((bone > 0) & mb).astype(np.uint8)
    olive = []
    if int(src.sum()) >= 40:
        # 5px cap. Wider than a hairline crack in a tooth wall, narrower
        # than the gap that separates two windows.
        src = cv2.morphologyEx(
            src, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7))
        )
        rows = []
        for z in _enclosed_holes(src, 0):
            xr = (z["cx"] - cx) / rad
            yr = (z["cy"] - cy) / rad
            if not (0.58 <= yr <= 1.24 and abs(xr) <= 0.46):
                continue
            rel = z["area"] / disk
            asp = z["bw"] / max(float(z["bh"]), 1.0)
            if 0.58 <= yr < 1.00:
                if not (0.0008 <= rel <= 0.014 and 0.40 <= asp <= 2.1 and z["bh"] >= 0.03 * rad):
                    continue
            else:
                if not (0.00045 <= rel <= 0.008 and 0.28 <= asp <= 1.5 and z["bh"] >= z["bw"] * 0.6):
                    continue
            pts = _cell_cycle(z["mask"].astype(np.uint8), max(1.2, half * 0.45))
            alen = _polyline_arc_len(pts)
            if len(pts) < 8 or alen < 0.04 * rad or alen > 0.7 * rad:
                continue
            rows.append((yr, xr, pts))
        rows.sort()
        olive = [p for _yr, _xr, p in rows[:14]]

    jaw = _jaw_of_dark_bone(bone, circle)
    if jaw:
        grey.insert(0, jaw)
    if len(grey) > 6:
        grey = grey[:6]
    return grey, olive


def _jaw_of_dark_bone(bone, circle):
    """Lower envelope of dark bone under the teeth, spikes dropped.

    Bright water is already out of `bone`. A wide flat run (a remaining
    horizon) is dropped before the envelope so the U is the chin bone.
    """
    if bone is None or circle is None or int(bone.sum()) < 30:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = bone.shape
    src = (bone > 0).astype(np.uint8)
    water = cv2.morphologyEx(
        src, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (max(21, int(0.16 * rad)) | 1, 1))
    )
    src = src.copy()
    src[water > 0] = 0
    # Stay under the hanging teeth. A higher start cuts through the grid.
    y0 = int(cy + 1.18 * rad)
    y1 = int(min(h - 1, cy + 1.46 * rad))
    x0 = int(max(0, cx - 0.72 * rad))
    x1 = int(min(w - 1, cx + 0.72 * rad))
    if y1 <= y0 + 6:
        return []
    pts = []
    for x in range(x0, x1 + 1):
        col = np.where(src[y0:y1, x] > 0)[0]
        if col.size < 2:
            continue
        yb = int(col.max())
        ya = yb
        while ya > int(col.min()) and src[y0 + ya - 1, x]:
            ya -= 1
        thick = yb - ya + 1
        if thick > 0.07 * rad:
            continue
        pts.append((float(x), y0 + 0.5 * (ya + yb)))
    if len(pts) < 16:
        return []
    kept = []
    for i, (x, y) in enumerate(pts):
        lo = max(0, i - 5)
        hi = min(len(pts), i + 6)
        local = float(np.median([pts[j][1] for j in range(lo, hi)]))
        if abs(y - local) > 0.06 * rad:
            continue
        kept.append((x, y))
    if len(kept) < 14:
        return []
    sm = _smooth_chain(kept, win=25, closed=False)
    sm = _clip_steep_ends(sm, slope=1.2)
    if len(sm) < 12:
        return []
    sm = _smooth_chain(sm, win=17, closed=False)
    ys = [p[1] for p in sm]
    xs = [p[0] for p in sm]
    if max(ys) < cy + 1.08 * rad or max(ys) - min(ys) < 0.04 * rad:
        return []
    if max(xs) - min(xs) < 0.30 * rad:
        return []
    if sm[len(sm) // 2][1] + 0.02 * rad < max(sm[0][1], sm[-1][1]):
        return []
    return _resample_cycle(sm, step=2.8, limit=80)


def _dark_mouth_mask(gkeep, okeep, rgb, circle, hull=None):
    """Luminance-gated mouth bone. Sunset stripes are brighter than the grid."""
    if gkeep is None or circle is None or rgb is None:
        return None
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    g = (gkeep > 0).astype(np.uint8)
    o = np.zeros_like(g) if okeep is None else (okeep > 0).astype(np.uint8)
    bone = ((np.maximum(g, o) > 0) & (luma_map(rgb) < 172.0)).astype(np.uint8)
    yy, xx = np.ogrid[:h, :w]
    mb = (yy > cy + 0.62 * rad) & (yy < cy + 1.38 * rad) & (np.abs(xx - cx) < 0.48 * rad)
    if hull is not None:
        mb = mb & (hull > 0)
    src = ((bone > 0) & mb).astype(np.uint8)
    if int(src.sum()) < 400:
        return None
    src = cv2.morphologyEx(
        src, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    )
    return src


def _waterline_skull_mask(gkeep, okeep, circle):
    """Dual-ink keep with long horizontal sunset stripes removed.

    Water and cheek stripes run straight across the face. The jaw, both
    socket rims, and the tooth grid curve, so a horizontal opening longer
    than a tooth rail deletes the stripes and leaves the skull lines.
    The circular frame is not part of this mask — overlay_support draws it.
    Not a watershed, not a luma-gated mouth plate, not a skeleton.
    """
    if gkeep is None or circle is None:
        return None
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    if rad < 20.0:
        return None
    h, w = gkeep.shape
    g = (gkeep > 0).astype(np.uint8)
    o = np.zeros_like(g) if okeep is None else (okeep > 0).astype(np.uint8)
    union = np.maximum(g, o)
    yy, xx = np.ogrid[:h, :w]
    near = (np.hypot(xx - cx, yy - cy) < rad * 1.35) & (yy > cy - 0.58 * rad) & (
        yy < cy + 1.70 * rad
    )
    union = ((union > 0) & near).astype(np.uint8)
    if int(union.sum()) < 80:
        return None
    # Long horizontal runs are sunset stripes. A thick jaw or almond lid
    # has the same direction but a larger distance-to-edge, so only the
    # thin runs are water. Tooth windows are ~0.05 rad wide; this does not
    # fill them.
    kw = max(41, int(round(0.22 * rad)) | 1)
    horiz = cv2.morphologyEx(
        union, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (kw, 1))
    )
    dist = cv2.distanceTransform(union, cv2.DIST_L2, 3)
    water = (horiz > 0) & (dist < 2.15)
    clean = union.copy()
    clean[water] = 0
    ring = np.abs(np.hypot(xx - cx, yy - cy) - rad) <= max(4.0, 0.028 * rad)
    clean[ring] = 0
    # Seal cracks in a stroke. 5px stays under the tooth-window width.
    clean = cv2.morphologyEx(
        clean, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    )
    # Speck holes are sunset chips, not tooth windows.
    inv = (clean == 0).astype(np.uint8)
    n_h, lab_h, st_h, _ = cv2.connectedComponentsWithStats(inv, 4)
    for i in range(1, n_h):
        if int(st_h[i, cv2.CC_STAT_AREA]) <= 48:
            x, y, bw, bh, _a = [int(st_h[i, k]) for k in range(5)]
            # A hole that touches the image border is the exterior.
            if x <= 0 or y <= 0 or x + bw >= w - 1 or y + bh >= h - 1:
                continue
            clean[lab_h == i] = 1
    n, labels, stats, _ = cv2.connectedComponentsWithStats(clean, 8)
    out = np.zeros_like(clean)
    for i in range(1, n):
        if int(stats[i, cv2.CC_STAT_AREA]) >= 40:
            out[labels == i] = 1
    if int(out.sum()) < 200:
        return None
    return out


def _vertical_tooth_mask(gkeep, okeep, rgb, circle, hull=None):
    """Mouth bone with horizontal rails opened away.

    The luminance gate drops bright sunset water. A short vertical opening
    then cuts the remaining horizontal connectors so neighbouring tooth
    windows do not fuse into one plate. Not a watershed and not a fill of
    the whole keep.
    """
    bone = _dark_mouth_mask(gkeep, okeep, rgb, circle, hull)
    if bone is None or circle is None:
        return bone
    _cx, _cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    kh = max(7, int(round(0.035 * rad)) | 1)
    opened = cv2.morphologyEx(
        bone, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (3, kh))
    )
    n, labels, stats, _ = cv2.connectedComponentsWithStats(opened, 8)
    out = np.zeros_like(opened)
    for i in range(1, n):
        if int(stats[i, cv2.CC_STAT_AREA]) >= 28:
            out[labels == i] = 1
    if int(out.sum()) < 400:
        return bone
    return out


def _right_rim_cycle(gkeep, circle, half_w, left_hole):
    """Open socket from its own grey rim. Does not copy the closed eye.

    Horizontal water in the eye band is removed. The kept contour is the
    one whose box matches the closed almond's width and sits on the same
    line. A brow hook fails that test.
    """
    if gkeep is None or circle is None or left_hole is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    m = left_hole["mask"]
    ys, xs = np.where(m)
    if xs.size < 80:
        return []
    bw = float(xs.max() - xs.min() + 1)
    src_yr = (float(ys.mean()) - cy) / rad
    side = 1.0 if float(xs.mean()) < cx else -1.0
    if side > 0:
        x0 = int(cx + 0.04 * rad)
        x1 = int(min(w - 1, cx + 0.70 * rad))
    else:
        x0 = int(max(0, cx - 0.70 * rad))
        x1 = int(cx - 0.04 * rad)
    y0 = int(max(0, cy + (src_yr - 0.26) * rad))
    y1 = int(min(h - 1, cy + (src_yr + 0.24) * rad))
    if x1 <= x0 + 8 or y1 <= y0 + 8:
        return []
    eye = np.zeros((h, w), np.uint8)
    eye[y0:y1, x0:x1] = (gkeep[y0:y1, x0:x1] > 0).astype(np.uint8)
    kw = max(13, int(round(0.09 * rad)) | 1)
    horiz = cv2.morphologyEx(
        eye, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (kw, 1))
    )
    eye[horiz > 0] = 0
    n, labels, stats, _ = cv2.connectedComponentsWithStats(eye, 8)
    kept = np.zeros_like(eye)
    for i in range(1, n):
        if int(stats[i, cv2.CC_STAT_AREA]) >= 36:
            kept[labels == i] = 1
    if int(kept.sum()) < 40:
        return []
    cnts, _ = cv2.findContours(kept, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    best = None
    for c in cnts:
        alen = float(cv2.arcLength(c, False))
        if alen < 0.45 * rad:
            continue
        x, y, cw, ch = cv2.boundingRect(c)
        if ch < 6:
            continue
        asp = cw / float(ch)
        if not (1.15 <= asp <= 4.2):
            continue
        # A short hook is not the socket. The closed eye's width is the bar.
        if not (0.72 * bw <= cw <= 1.25 * bw):
            continue
        M = cv2.moments(c)
        if M["m00"] < 1:
            continue
        yr = ((M["m01"] / M["m00"]) - cy) / rad
        if abs(yr - src_yr) > 0.14:
            continue
        # Prefer the almond-shaped arc, not a longer brow scribble.
        err = abs(asp - 2.0) + abs(yr - src_yr) * 3.0 + abs(cw - bw) / bw
        score = alen / rad - 2.5 * err
        if best is None or score > best[0]:
            best = (score, c)
    if best is None:
        return []
    c = best[1]
    pts = [(float(p[0][0]) + 0.5, float(p[0][1]) + 0.5) for p in c]
    if len(pts) < 12:
        return []
    gap = math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1])
    if gap < 0.18 * rad:
        pts = _close_cycle(pts)
    return _resample_cycle(pts, step=2.0, limit=180)


def _open_socket_ellipse(gkeep, circle, half_w, left_hole):
    """Ellipse fit to the open socket's own grey rim.

    The rim is not a closed contour (it opens into the sun), so a single
    chain is a fragment. The pixels still lie on an almond. This fits that
    almond. It does not copy the closed eye and it does not recolor.
    """
    if gkeep is None or circle is None or left_hole is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    m = left_hole["mask"]
    ys, xs = np.where(m)
    if xs.size < 80:
        return []
    left_major = float(max(xs.max() - xs.min(), ys.max() - ys.min()) + 1)
    src_yr = (float(ys.mean()) - cy) / rad
    side = 1.0 if float(xs.mean()) < cx else -1.0
    yy, xx = np.ogrid[:h, :w]
    band = (yy > cy + (src_yr - 0.22) * rad) & (yy < cy + (src_yr + 0.20) * rad)
    if side > 0:
        band = band & (xx > cx + 0.05 * rad) & (xx < cx + 0.66 * rad)
    else:
        band = band & (xx < cx - 0.05 * rad) & (xx > cx - 0.66 * rad)
    eye = ((gkeep > 0) & band).astype(np.uint8)
    kw = max(13, int(round(0.10 * rad)) | 1)
    horiz = cv2.morphologyEx(
        eye, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (kw, 1))
    )
    eye[horiz > 0] = 0
    pts = np.column_stack(np.where(eye > 0))
    if pts.shape[0] < 180:
        return []
    ell = cv2.fitEllipse(pts[:, ::-1].astype(np.float32))
    (ex, ey), (aw, ah), ang = ell
    major = float(max(aw, ah))
    minor = float(min(aw, ah))
    if minor < 8 or major / minor < 1.25 or major / minor > 3.4:
        return []
    if not (0.55 * left_major <= major <= 1.45 * left_major):
        return []
    xr = (float(ex) - cx) / rad
    yr = (float(ey) - cy) / rad
    if side > 0 and not (0.12 <= xr <= 0.58):
        return []
    if side < 0 and not (-0.58 <= xr <= -0.12):
        return []
    if abs(yr - src_yr) > 0.14:
        return []
    # OpenCV angle matches a clockwise rotation in image y. The cycle helper
    # rotates the same way when the angle is negated (y-down).
    cyc = _ellipse_cycle(float(ex), float(ey), float(aw), float(ah), -float(ang), n=72)
    if len(cyc) < 16:
        return []
    return cyc


def _jaw_under_teeth(gkeep, circle, teeth):
    """Bottom of the grey keep below the tooth grid. One open curve.

    Columns that still hold a tooth are skipped, so the curve cannot cut
    the hanging row. A flat water line (no dip) is dropped.
    """
    if gkeep is None or circle is None:
        return []
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    h, w = gkeep.shape
    ban = np.zeros((h, w), np.uint8)
    if teeth is not None:
        ban = cv2.dilate(
            (teeth > 0).astype(np.uint8),
            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)),
        )
    y0 = int(cy + 1.10 * rad)
    y1 = int(min(h - 1, cy + 1.58 * rad))
    x0 = int(max(0, cx - 0.70 * rad))
    x1 = int(min(w - 1, cx + 0.70 * rad))
    if y1 <= y0 + 8:
        return []
    pts = []
    for x in range(x0, x1 + 1):
        col = gkeep[y0:y1, x]
        blocked = ban[y0:y1, x]
        ys = np.where((col > 0) & (blocked == 0))[0]
        if ys.size < 2:
            continue
        yb = int(ys.max())
        ya = yb
        while ya > int(ys.min()) and gkeep[y0 + ya - 1, x] and not ban[y0 + ya - 1, x]:
            ya -= 1
        if yb - ya + 1 > 0.07 * rad:
            continue
        pts.append((float(x), y0 + 0.5 * (ya + yb)))
    if len(pts) < 18:
        return []
    kept = []
    for i, (x, y) in enumerate(pts):
        lo = max(0, i - 6)
        hi = min(len(pts), i + 7)
        local = float(np.median([pts[j][1] for j in range(lo, hi)]))
        if abs(y - local) > 0.05 * rad:
            continue
        kept.append((x, y))
    if len(kept) < 16:
        return []
    sm = _smooth_chain(kept, win=27, closed=False)
    sm = _clip_steep_ends(sm, slope=1.15)
    if len(sm) < 12:
        return []
    sm = _smooth_chain(sm, win=19, closed=False)
    ys = [p[1] for p in sm]
    xs = [p[0] for p in sm]
    if max(ys) < cy + 1.18 * rad:
        return []
    if max(ys) - min(ys) < 0.035 * rad:
        return []
    if max(xs) - min(xs) < 0.34 * rad:
        return []
    # Centre of a chin sits lower on the page than the corners.
    if sm[len(sm) // 2][1] + 0.012 * rad < max(sm[0][1], sm[-1][1]):
        return []
    return _resample_cycle(sm, step=2.6, limit=80)


def _emblem_cycle_polylines(gkeep, okeep, circle, half_w, hull=None, rgb=None):
    """Frame plus socket rims and the jaw. Teeth are a separate fill.

    With a raster the closed eye is the enclosed grey hole and the open
    socket is its own rim, not a translated copy. The jaw is the grey run
    under the tooth grid. Without a raster, dark-bone cycles still locate
    the synthetic rings. Frame is overlay_support, not a cycle here.
    """
    if circle is None:
        return [], [], None
    cx, cy, rad = float(circle[0]), float(circle[1]), float(circle[2])
    if rad < 20.0:
        return [], [], None
    if rgb is None:
        grey, olive = _dark_bone_cycles(gkeep, okeep, circle, half_w, hull, rgb=None)
        return grey, olive, (cx, cy, rad)
    half = float(half_w) if half_w else 2.5
    cycles, holes = _almond_hole_cycles(gkeep, circle, half)
    grey = list(cycles)
    if len(holes) == 1:
        rim = _right_rim_cycle(gkeep, circle, half, holes[0])
        if not rim:
            rim = _open_socket_ellipse(gkeep, circle, half, holes[0])
        if rim:
            grey.append(rim)
    # No jaw stroke. The lowest grey run is a shallow arc through the
    # hanging teeth, and the chin is not a separate curve in this keep.
    if len(grey) > 6:
        grey = grey[:6]
    return grey, [], (cx, cy, rad)


def _circle_primitive_stroke(cx, cy, rad, sx, sy, half_w, hex_):
    """Even-width circle from overlay_support, not a walked ridge."""
    G = _vg_geom()
    d = G["ellipse_d"](float(cx), float(cy), float(rad), float(rad), float(sx), float(sy))
    sw = 0.5 * (float(sx) + float(sy)) * float(2.0 * max(half_w, 1.2))
    return {"d": d, "hex": hex_, "sw": sw}


def _destair_glyph_paths(paths):
    """Keep gothic terminals: destair 1px jogs, corner-preserving cubics."""
    if not paths:
        return paths
    try:
        from geom import sample_path_d, destaircase, path_from_ring, clean_ring, ring_bbox
    except Exception:
        try:
            from lib.geom import (
                sample_path_d,
                destaircase,
                path_from_ring,
                clean_ring,
                ring_bbox,
            )
        except Exception:
            return paths
    out = []
    for d in paths:
        rings = sample_path_d(d, curve_samples=3)
        if not rings:
            out.append(d)
            continue
        all_pts = [pt for ring in rings for pt in ring]
        if len(all_pts) < 3:
            out.append(d)
            continue
        minx, miny, maxx, maxy = ring_bbox(all_pts)
        diag = math.hypot(maxx - minx, maxy - miny) or 1.0
        scale_up = (80.0 / diag) if diag < 40.0 else 1.0
        parts = []
        ok = True
        for ring in rings:
            ring = clean_ring(ring, 0.02 if diag < 40 else 0.12)
            if len(ring) < 4:
                continue
            work = (
                [(p[0] * scale_up, p[1] * scale_up) for p in ring]
                if scale_up != 1.0
                else list(ring)
            )
            faired = destaircase(work, max_leg=2.4, closed=True)
            if len(faired) < 3:
                ok = False
                break
            if scale_up != 1.0:
                faired = [(p[0] / scale_up, p[1] / scale_up) for p in faired]
            # Polygon only — cubic fit rounds gothic terminals into blobs.
            pd = f"M {fmt(faired[0][0])} {fmt(faired[0][1])}"
            for p in faired[1:]:
                pd += f" L {fmt(p[0])} {fmt(p[1])}"
            pd += " Z"
            parts.append(pd)
        out.append(" ".join(parts) if ok and parts else d)
    return out


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
    keep = None
    key = np.zeros((h, w), np.uint8)
    thin = _thin_olive_strokes(rgb, paper)
    # Circular stroke frame + grey-shifted interior = overlay hull.
    # Tiger fur scores high ring-mass on edge circles but low interior grey.
    if int(thin.sum()) >= 400:
        blur = cv2.GaussianBlur((thin * 255).astype(np.uint8), (5, 5), 0)
        min_r = int(0.10 * min(h, w))
        max_r = int(0.36 * min(h, w))
        circles = None
        try:
            circles = cv2.HoughCircles(
                blur,
                cv2.HOUGH_GRADIENT,
                dp=1.2,
                minDist=int(0.18 * min(h, w)),
                param1=80,
                param2=22,
                minRadius=min_r,
                maxRadius=max_r,
            )
        except Exception:
            circles = None
        if circles is not None:
            yy, xx = np.ogrid[:h, :w]
            best = None
            for c in circles[0]:
                cx, cy, rad = float(c[0]), float(c[1]), float(c[2])
                if rad < min_r or rad > max_r:
                    continue
                ring = np.abs(np.hypot(xx - cx, yy - cy) - rad) <= max(4.0, 0.03 * rad)
                ring &= art
                if int(ring.sum()) < 40:
                    continue
                cov = float(thin[ring].mean())
                interior = np.hypot(xx - cx, yy - cy) <= rad
                art_in = interior & art
                if int(art_in.sum()) < 800:
                    continue
                ov = art_in & (luma > 70) & (luma < 205) & (ch < 42)
                ofrac = float(ov[art_in].mean())
                border = min(cx, cy, w - 1.0 - cx, h - 1.0 - cy) / max(rad, 1.0)
                if cov < 0.20 or ofrac < 0.35 or border < 0.80:
                    continue
                score = cov * ofrac * min(border, 2.5) * (rad / float(min(h, w)))
                if best is None or score > best[0]:
                    best = (score, cx, cy, rad)
            if best is not None:
                _sc, cx, cy, rad = best
                distc = np.hypot(xx.astype(np.float32) - cx, yy.astype(np.float32) - cy)
                # Emblem (jaw, chin) often hangs below the scored circular frame.
                interior = distc <= rad * 1.02
                below = (distc <= rad * 1.38) & (yy > (cy - 0.12 * rad))
                hull = interior | below
                keep = (
                    hull & art & (luma > 68) & (luma < 205) & (ch < 48)
                ).astype(np.uint8)
                punch = hull & art & (ch > 36) & (luma > 72)
                keep[punch] = 0
                keep[hull & (luma > 215)] = 0
                nkeep, klab, kst, _ = cv2.connectedComponentsWithStats(keep, 8)
                keep2 = np.zeros_like(keep)
                min_a = max(80, int(0.0005 * keep.size))
                for i in range(1, nkeep):
                    if int(kst[i, cv2.CC_STAT_AREA]) >= min_a:
                        keep2[klab == i] = 1
                keep = keep2
                near = distc <= rad * 1.38
                key = ((thin > 0) & near).astype(np.uint8)
                # Drop landscape ridges: keep strokes on the ring or next to the veil.
                near_ov = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
                ring_band = np.abs(distc - rad) <= max(8.0, 0.05 * rad)
                key = (key > 0) & ((near_ov > 0) | ring_band)
                key = key.astype(np.uint8)
                on_ring = (np.abs(distc - rad) <= 7.0) & (thin > 0)
                half = 2.8
                if int(on_ring.sum()) >= 40:
                    rd = cv2.distanceTransform((thin > 0).astype(np.uint8), cv2.DIST_L2, 3)
                    half = float(np.clip(np.median(rd[on_ring]), 1.6, 5.5))
                frame = (np.abs(distc - rad) <= half).astype(np.uint8)
                if float(thin[frame > 0].mean()) >= 0.22:
                    key = np.maximum(key, frame)
                key = _even_width_strokes(key, max_half=5.5)
                keep[key > 0] = 0
                if int(keep.sum()) < 400:
                    keep = None
                    key = np.zeros((h, w), np.uint8)
    if keep is None:
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
            rh = hue[ring]
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
        on = keep > 0
        punch = on & (ch > 38) & (luma > 70)
        keep[punch] = 0
        bright = on & (luma > 215)
        keep[bright] = 0
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
        thin_fb = bone.copy()
        thin_fb[distb > 6.5] = 0
        near = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (55, 55)))
        key = ((thin_fb > 0) & (near > 0)).astype(np.uint8)
        key = cv2.morphologyEx(key, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8), 2)
        if int(key.sum()) >= 80:
            key = _even_width_strokes(key, max_half=5.5)
            keep[key > 0] = 0
        else:
            key = np.zeros((h, w), np.uint8)
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
    """Dark glyphs with a chromatic (gold/orange) halo — Canva gothic/script wordmarks.

    The whole arched word is often one CC (AA merges letters). Do not reject
    large haloed CCs; trees/frames fail the halo gate instead.
    """
    h, w = rgb.shape[:2]
    if max(h, w) < 700:
        return np.zeros((h, w), dtype=bool), np.zeros((h, w), dtype=bool), None
    luma = luma_map(rgb)
    lab = to_lab(rgb)
    ch = chroma_map(lab)
    art = ~paper
    black = art & (luma < 58) & (ch < 36)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    # Gold/orange halo (gothic Canva wordmarks). Mid G keeps red-mountain rims out.
    warm = (
        art
        & (r > 185)
        & (g > 90)
        & (g < 195)
        & (b < 130)
        & ((r.astype(np.int16) - b) > 60)
        & (ch > 18)
    )
    ncc, labels, stats, _ = cv2.connectedComponentsWithStats(black.astype(np.uint8), 4)
    if ncc <= 2:
        return np.zeros((h, w), dtype=bool), np.zeros((h, w), dtype=bool), None
    areas = [(i, int(stats[i, cv2.CC_STAT_AREA])) for i in range(1, ncc)]
    areas.sort(key=lambda t: -t[1])
    k5 = np.ones((5, 5), np.uint8)
    max_area = 0.12 * h * w
    glyph = np.zeros((h, w), dtype=bool)
    for ci, area in areas:
        if area < max(200, int(0.00012 * h * w)) or area > max_area:
            continue
        bw = int(stats[ci, cv2.CC_STAT_WIDTH])
        bh = int(stats[ci, cv2.CC_STAT_HEIGHT])
        if max(bw, bh) > 0.92 * max(h, w):
            continue
        dist = cv2.distanceTransform((labels == ci).astype(np.uint8), cv2.DIST_L2, 3)
        on = dist > 0
        if not on.any() or float(np.median(dist[on])) < 1.35:
            continue
        comp = labels == ci
        dil = cv2.dilate(comp.astype(np.uint8), k5)
        ring = (dil > 0) & (~comp)
        if int(ring.sum()) < 12:
            continue
        ofrac = float(warm[ring].mean()) if ring.any() else 0.0
        if ofrac < 0.18:
            continue
        glyph[comp] = True
    if not glyph.any():
        return glyph, np.zeros((h, w), dtype=bool), None
    dist = cv2.distanceTransform((~glyph).astype(np.uint8), cv2.DIST_L2, 3)
    on = warm & (dist > 0.6) & (dist < 16)
    width = 5
    if int(on.sum()) >= 40:
        width = int(np.clip(round(float(np.percentile(dist[on], 68))), 3, 12))
    ksz = 2 * width + 1
    near = cv2.dilate(
        glyph.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksz, ksz))
    )
    halo = (near > 0) & (~glyph)
    halo_rgb = rgb[warm & halo].mean(axis=0) if (warm & halo).any() else rgb[halo].mean(axis=0)
    return glyph, halo, halo_rgb.astype(np.float32)


def _overlay_support(rgb, paper):
    """Skull-hull mask + optional (cx, cy, rad) of the circular frame.

    Hough / enclosing circle on thin olive, preferring a frame-sized ring
    over a small grey mouth blob. Grey-CC fallback is last.
    """
    h, w = rgb.shape[:2]
    lab = to_lab(rgb)
    ch = chroma_map(lab)
    luma = luma_map(rgb)
    art = ~paper
    thin = _thin_olive_strokes(rgb, paper)
    hull = np.zeros((h, w), np.uint8)
    circle = None
    if int(thin.sum()) >= 400:
        blur = cv2.GaussianBlur((thin * 255).astype(np.uint8), (5, 5), 0)
        min_r = int(0.10 * min(h, w))
        max_r = int(0.48 * min(h, w))
        circles = None
        try:
            circles = cv2.HoughCircles(
                blur,
                cv2.HOUGH_GRADIENT,
                dp=1.2,
                minDist=int(0.16 * min(h, w)),
                param1=70,
                param2=14,
                minRadius=min_r,
                maxRadius=max_r,
            )
        except Exception:
            circles = None
        yy, xx = np.ogrid[:h, :w]
        best = None
        hue = np.arctan2(lab[:, :, 2] - 128.0, lab[:, :, 1] - 128.0)
        cands = []
        if circles is not None:
            cands.extend(circles[0])
        pts = np.column_stack(np.where(thin > 0))
        if pts.shape[0] >= 80:
            (ccx, ccy), crad = cv2.minEnclosingCircle(
                pts[:, ::-1].astype(np.float32)
            )
            if min_r <= crad <= max_r * 1.08:
                cands.append((ccx, ccy, crad))
        # Skip arched wordmarks: enclosing circle of the emblem band ≈ frame.
        ys, xs = np.where(thin > 0)
        band = (ys > 0.16 * h) & (ys < 0.78 * h)
        if int(band.sum()) >= 80:
            (ccx, ccy), crad = cv2.minEnclosingCircle(
                np.column_stack((xs[band], ys[band])).astype(np.float32)
            )
            if min_r <= crad <= max_r * 1.08:
                cands.append((ccx, ccy, crad))
        for c in cands:
            cx, cy, rad = float(c[0]), float(c[1]), float(c[2])
            if rad < min_r or rad > max_r * 1.08:
                continue
            ring = np.abs(np.hypot(xx - cx, yy - cy) - rad) <= max(5.0, 0.03 * rad)
            ring &= art
            if int(ring.sum()) < 40:
                continue
            cov = float(thin[ring].mean())
            ring_thin = float(thin[ring].sum())
            interior = np.hypot(xx - cx, yy - cy) <= rad
            art_in = interior & art
            if int(art_in.sum()) < 800:
                continue
            ov = art_in & (luma > 70) & (luma < 205) & (ch < 42)
            ofrac = float(ov[art_in].mean()) if int(art_in.sum()) else 0.0
            rh = hue[art_in]
            bins = np.unique(np.round(rh * 3).astype(np.int32))
            border = min(cx, cy, w - 1.0 - cx, h - 1.0 - cy) / max(rad, 1.0)
            if bins.size < 4 or border < 0.32:
                continue
            if cov < 0.08 and ofrac < 0.10:
                continue
            # Frame-sized ring beats a small grey mouth blob.
            rfrac = rad / float(min(h, w))
            score = (
                (0.15 + cov)
                * (0.22 + ofrac)
                * min(border, 2.2)
                * (0.30 + 0.70 * rfrac)
                * (1.0 + math.log1p(ring_thin / 80.0))
            )
            if best is None or score > best[0]:
                best = (score, cx, cy, rad)
        if best is not None:
            _sc, cx, cy, rad = best
            circle = (cx, cy, rad)
            distc = np.hypot(xx.astype(np.float32) - cx, yy.astype(np.float32) - cy)
            interior = distc <= rad * 1.18
            below = (distc <= rad * 1.34) & (yy > (cy - 0.08 * rad))
            hull = ((interior | below) & art).astype(np.uint8)
    if int(hull.sum()) < 400:
        seed = art & (ch < 28) & (luma > 72) & (luma < 192)
        n, labels, stats, cents = cv2.connectedComponentsWithStats(seed.astype(np.uint8), 8)
        hue = np.arctan2(lab[:, :, 2] - 128.0, lab[:, :, 1] - 128.0)
        k7 = np.ones((7, 7), np.uint8)
        cx0, cy0 = 0.5 * w, 0.5 * h
        scores = []
        for i in range(1, n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area < 250 or area > 0.32 * h * w:
                continue
            bw = int(stats[i, cv2.CC_STAT_WIDTH])
            bh = int(stats[i, cv2.CC_STAT_HEIGHT])
            if bw / max(bh, 1) > 2.4 and cents[i, 1] > 0.58 * h:
                continue
            if max(bw, bh) > 0.90 * max(h, w):
                continue
            comp = (labels == i).astype(np.uint8)
            dist = cv2.distanceTransform(comp, cv2.DIST_L2, 3)
            med_t = float(np.median(dist[comp > 0])) if area else 0.0
            if med_t < 1.8:
                continue
            dil = cv2.dilate(comp, k7)
            ring = (dil > 0) & (comp == 0) & art
            if int(ring.sum()) < 40:
                continue
            nch = float(ch[ring].mean())
            if nch < 14:
                continue
            rh = hue[ring]
            bins = np.unique(np.round(rh * 4).astype(np.int32))
            if bins.size < 4:
                continue
            ccx, ccy = float(cents[i, 0]), float(cents[i, 1])
            cent = 1.0 - math.hypot(ccx - cx0, ccy - cy0) / (0.5 * math.hypot(h, w))
            cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            peri = float(cv2.arcLength(cnts[0], True)) if cnts else 0.0
            compact = (4.0 * math.pi * area / (peri * peri + 1e-6)) if peri else 0.0
            scores.append((area * (1.0 + med_t / 6.0) * (0.4 + cent) * (0.5 + compact), i, area))
        if scores:
            scores.sort(reverse=True)
            keep = np.zeros((h, w), np.uint8)
            keep[labels == scores[0][1]] = 1
            grow = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (61, 61)))
            for _sc, i, _a in scores[1:6]:
                piece = labels == i
                if np.any(grow[piece]):
                    keep[piece] = 1
            hull = keep
            near = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (47, 47)))
            hull = np.maximum(hull, ((thin > 0) & (near > 0)).astype(np.uint8))
            hull = cv2.morphologyEx(
                hull, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))
            )
            if circle is None:
                pts_h = np.column_stack(np.where(hull > 0))
                if pts_h.shape[0] >= 40:
                    (ccx, ccy), crad = cv2.minEnclosingCircle(
                        pts_h[:, ::-1].astype(np.float32)
                    )
                    circle = (float(ccx), float(ccy), float(crad))
    frac = float(hull.sum()) / max(int(art.sum()), 1)
    if frac < 0.025 or frac > 0.55:
        return None, None
    return hull, circle


def _overlay_hull(rgb, paper):
    """Spatial support of a grey veil on multi-hue landscape (badge overlay)."""
    hull, _circle = _overlay_support(rgb, paper)
    return hull


def overlay_unmix(rgb, paper):
    """Unmix designed overlay: landscape + grey veil α.

    Landscape = inpaint/bilateral of high-chroma structure. Residual toward a
    global grey = veil α. Overlay strokes are a separate dual-ink ridge-follow
    of thin grey ∪ thin olive (not a coverage-field 0.5 iso). Returns None when
    the raster has no overlay hull.
    """
    h, w = rgb.shape[:2]
    if max(h, w) < 700:
        return None
    hull, circle = _overlay_support(rgb, paper)
    if hull is None or int(hull.sum()) < 400:
        return None
    lab = to_lab(rgb)
    ch = chroma_map(lab)
    luma = luma_map(rgb)
    art = (~paper).astype(np.float32)
    chroma_gate = np.clip((38.0 - ch) / 14.0, 0.0, 1.0)

    # --- landscape: keep original high-chroma structure; inpaint overlay ---
    thin = _thin_olive_strokes(rgb, paper)
    # Overlay fill (grey veil) + bone strokes are not landscape.
    overlay_px = (hull > 0) & (ch < 36.0) & (luma > 38) & (luma < 205)
    overlay_px = overlay_px | ((thin > 0) & (hull > 0))
    overlay_px = cv2.dilate(overlay_px.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    overlay_px &= hull > 0
    wgt = np.clip((ch - 16.0) / 26.0, 0.0, 1.0) * art
    wgt[overlay_px] = 0.0
    sigma_l = max(8.0, 0.016 * max(h, w))
    den = cv2.GaussianBlur(wgt, (0, 0), sigma_l)
    land = np.zeros_like(rgb, np.float32)
    rf = rgb.astype(np.float32)
    for c in range(3):
        num = cv2.GaussianBlur(rf[:, :, c] * wgt, (0, 0), sigma_l)
        land[:, :, c] = num / np.maximum(den, 1e-3)
    keep = ~overlay_px
    land = np.where(keep[:, :, None], rf, land)
    need = overlay_px & (den < 0.18)
    out = np.clip(land, 0, 255).astype(np.uint8)
    if int(need.sum()) > 30:
        out = cv2.inpaint(out, need.astype(np.uint8), 9, cv2.INPAINT_TELEA)
    if int(overlay_px.sum()) > 30:
        bil = cv2.bilateralFilter(out, 7, 26, 26)
        out = np.where(overlay_px[:, :, None], bil, out)
    out[paper] = rgb[paper]
    out[keep] = rgb[keep]
    land = out

    # --- veil α: residual toward a global grey inside the hull ---
    cand = (hull > 0) & (ch < 26) & (luma > 72) & (luma < 188) & (thin == 0)
    if int(cand.sum()) < 80:
        G = np.array([132.0, 134.0, 138.0], np.float32)
    else:
        G = np.median(rgb[cand].astype(np.float32), axis=0)
    r = G.reshape(1, 1, 3) - land.astype(np.float32)
    diff = rf - land.astype(np.float32)
    den2 = np.sum(r * r, axis=2) + 1e-4
    alpha = np.clip(np.sum(diff * r, axis=2) / den2, 0.0, 1.0)
    alpha *= chroma_gate
    alpha *= cv2.GaussianBlur(hull.astype(np.float32), (0, 0), 1.6)
    alpha *= art

    # Overlay strokes are ridge-followed in vectorize_plate_poster.
    # Punch veil at thin olive ∪ thin grey so sockets/jaw stay landscape windows.
    grey = _thin_grey_strokes(rgb, paper)
    thin_h = (((thin > 0) | (grey > 0)) & (hull > 0)).astype(np.uint8)
    if int(thin_h.sum()) >= 40:
        distt = cv2.distanceTransform(thin_h, cv2.DIST_L2, 3)
        onb = thin_h > 0
        half_w = float(np.clip(np.median(distt[onb]), 1.6, 4.5))
        bone_rgb = np.median(rgb[onb].astype(np.float32), axis=0)
        dt_out = cv2.distanceTransform((thin_h == 0).astype(np.uint8), cv2.DIST_L2, 3)
        mem = 0.5 * (1.0 + np.tanh((half_w - dt_out) / 0.72))
        mem = np.where(hull > 0, mem, 0.0).astype(np.float32)
        dist = distt
    else:
        half_w = 3.0
        bone_rgb = np.array([120.0, 90.0, 70.0], np.float32)
        mem = np.zeros((h, w), np.float32)
        dist = np.zeros((h, w), np.float32)
        thin_h = np.zeros((h, w), np.uint8)
    # Veil: one evenodd plate, punched at high chroma and at thin olive.
    veil = (alpha > 0.22) & (hull > 0) & (thin_h == 0) & (ch < 26) & (luma < 198)
    veil = cv2.morphologyEx(veil.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    veil[ch > 24] = 0
    veil[luma > 198] = 0
    veil[thin_h > 0] = 0
    veil[paper] = 0
    if int(veil.sum()) < 200:
        veil = np.zeros((h, w), np.uint8)
        v_alpha = 0.0
    else:
        onv = veil > 0
        v_alpha = float(np.clip(np.median(alpha[onv]), 0.18, 0.32)) if onv.any() else 0.26
    return {
        "land": land,
        "alpha": alpha,
        "bone": mem,
        "hull": hull,
        "circle": circle,
        "grey": G,
        "bone_rgb": bone_rgb,
        "veil": veil,
        "veil_alpha": v_alpha,
        "sigma": 0.0,
        "half_w": half_w,
        "dist": dist,
    }


def _polyline_arc_len(pts):
    if not pts or len(pts) < 2:
        return 0.0
    acc = 0.0
    for i in range(1, len(pts)):
        acc += math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    return acc


def _prune_skeleton_spurs(sk, min_branch=7):
    """Delete short degree-1 branches. Does not peel real strokes."""
    out = (sk > 0).astype(np.uint8)
    if int(out.sum()) < 8:
        return out
    h, w = out.shape
    offs = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
    changed = True
    guard = 0
    while changed and guard < 6:
        guard += 1
        changed = False
        ys, xs = np.where(out > 0)
        pix = set(zip(ys.tolist(), xs.tolist()))
        nbr = {}
        for y, x in pix:
            n = []
            for dy, dx in offs:
                p = (y + dy, x + dx)
                if p in pix:
                    n.append(p)
            nbr[(y, x)] = n
        drop = []
        for p, n in nbr.items():
            if len(n) != 1:
                continue
            chain = [p]
            prev, cur = p, n[0]
            while True:
                chain.append(cur)
                nxts = [q for q in nbr[cur] if q != prev]
                if len(nxts) != 1:
                    break
                if len(chain) > min_branch:
                    break
                prev, cur = cur, nxts[0]
            if len(chain) <= min_branch and len(nbr.get(chain[-1], [])) != 1:
                drop.extend(chain[:-1])
                changed = True
        for y, x in drop:
            out[y, x] = 0
    return out


def _walk_skeleton_polylines(sk, min_len=6):
    """Graph-walk a 1px 8-connected ridge into open/closed polylines."""
    sk = (sk > 0).astype(np.uint8)
    ys, xs = np.where(sk > 0)
    if ys.size < min_len:
        return []
    pix = set(zip(ys.tolist(), xs.tolist()))
    offs = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
    nbr = {}
    for y, x in pix:
        n = []
        for dy, dx in offs:
            p = (y + dy, x + dx)
            if p in pix:
                n.append(p)
        nbr[(y, x)] = n
    nodes = {p for p, n in nbr.items() if len(n) != 2}
    used = set()

    def walk(start, nxt):
        chain = [start, nxt]
        prev, cur = start, nxt
        used.add((start, nxt))
        used.add((nxt, start))
        while True:
            cands = [p for p in nbr[cur] if p != prev and (cur, p) not in used]
            if not cands:
                break
            if len(cands) > 1 and cur in nodes and cur != start:
                break
            vy, vx = cur[0] - prev[0], cur[1] - prev[1]
            cands.sort(key=lambda p: -(vy * (p[0] - cur[0]) + vx * (p[1] - cur[1])))
            nxtp = cands[0]
            used.add((cur, nxtp))
            used.add((nxtp, cur))
            chain.append(nxtp)
            prev, cur = cur, nxtp
            if cur == start:
                break
            if cur in nodes and cur != start:
                break
        return chain

    polylines = []
    starts = list(nodes) if nodes else list(pix)
    for n in starts:
        for nb in nbr.get(n, []):
            if (n, nb) in used:
                continue
            chain = walk(n, nb)
            if len(chain) >= min_len:
                polylines.append([(p[1] + 0.5, p[0] + 0.5) for p in chain])
    for p in pix:
        for nb in nbr[p]:
            if (p, nb) in used:
                continue
            chain = walk(p, nb)
            if len(chain) >= min_len:
                pts = [(q[1] + 0.5, q[0] + 0.5) for q in chain]
                if math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) < 2.0:
                    pts.append(pts[0])
                polylines.append(pts)
    return polylines


def _join_polylines(polylines, max_gap=2.8):
    """Greedy endpoint join so skeleton T-splits become long strokes."""
    if len(polylines) < 2:
        return polylines
    work = [list(p) for p in polylines if p and len(p) >= 2]
    changed = True
    guard = 0
    while changed and guard < 24:
        guard += 1
        changed = False
        n = len(work)
        used = [False] * n
        ends = []
        for i, pts in enumerate(work):
            ends.append((i, 0, pts[0], pts[1] if len(pts) > 1 else pts[0]))
            ends.append((i, 1, pts[-1], pts[-2] if len(pts) > 1 else pts[-1]))
        best = None
        for a in range(len(ends)):
            ia, ea, pa, ha = ends[a]
            for b in range(a + 1, len(ends)):
                ib, eb, pb, hb = ends[b]
                if ia == ib:
                    continue
                d = math.hypot(pa[0] - pb[0], pa[1] - pb[1])
                if d > max_gap:
                    continue
                # Heading: (pa-ha) vs (pb-hb) should oppose (they meet).
                vax, vay = pa[0] - ha[0], pa[1] - ha[1]
                vbx, vby = pb[0] - hb[0], pb[1] - hb[1]
                la = math.hypot(vax, vay) or 1.0
                lb = math.hypot(vbx, vby) or 1.0
                dot = (vax * vbx + vay * vby) / (la * lb)
                # Prefer continuing (dot negative: headings point at each other).
                score = d + 0.6 * max(0.0, dot + 0.15)
                if best is None or score < best[0]:
                    best = (score, ia, ea, ib, eb, d)
        if best is None:
            break
        _sc, ia, ea, ib, eb, _d = best
        a, b = list(work[ia]), list(work[ib])
        if ea == 0:
            a = list(reversed(a))
        if eb == 1:
            b = list(reversed(b))
        merged = a + b[1:]
        nxt = [work[k] for k in range(n) if k != ia and k != ib]
        nxt.append(merged)
        work = nxt
        changed = True
    return work


def _iso_centerline_polylines(mem, dist=None, half_w=3.0):
    """Medial of the 0.5 iso — even-width stroke paths, not a filled plate.

    Skeleton of mem>=0.5 is the coverage ridge (Newton dist≈0). Not a
    skeleton-dilate keyline: we emit these polylines as cubics with
    stroke-width = 2 * half_w instead of dilating back to a fill.
    """
    support = (mem >= 0.5).astype(np.uint8)
    h, w = support.shape
    if int(support.sum()) < 80:
        return []
    ncc, labb, st, _ = cv2.connectedComponentsWithStats(support, 8)
    for i in range(1, ncc):
        bw = int(st[i, cv2.CC_STAT_WIDTH])
        bh = int(st[i, cv2.CC_STAT_HEIGHT])
        aa = int(st[i, cv2.CC_STAT_AREA])
        if bh <= max(3, int(half_w * 1.4)) and bw > 6 * max(bh, 1) and aa < 0.01 * h * w:
            support[labb == i] = 0
    if int(support.sum()) < 80:
        return []
    skel = _morph_skeleton(support)
    skel = _prune_skeleton_spurs(skel, min_branch=max(5, int(round(half_w))))
    if int(skel.sum()) < 40:
        skel = _morph_skeleton(support)
    polylines = _walk_skeleton_polylines(skel, min_len=5)
    polylines = _join_polylines(polylines, max_gap=max(2.2, 0.85 * half_w))
    if dist is not None:
        polylines = _snap_polylines_to_ridge(polylines, mem, dist, max_shift=1.15)
    out = []
    min_len = max(7.0, 2.2 * half_w)
    for pts in polylines:
        if len(pts) < 3:
            continue
        alen = _polyline_arc_len(pts)
        if alen < min_len:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        bw = max(xs) - min(xs)
        bh = max(ys) - min(ys)
        if bh <= 2.4 and bw > 7.0 * max(bh, 0.8) and alen < 0.18 * w:
            continue
        out.append(pts)
    return out


def _snap_polylines_to_ridge(polylines, mem, dist, max_shift=1.15):
    """Subpixel: slide each vertex to the membership ridge (dist≈0 / mem max)."""
    out = []
    n_samp = 9
    for pts in polylines:
        if len(pts) < 3:
            out.append(pts)
            continue
        snapped = []
        n = len(pts)
        for i, (x, y) in enumerate(pts):
            if i == 0:
                tx, ty = pts[1][0] - x, pts[1][1] - y
            elif i == n - 1:
                tx, ty = x - pts[i - 1][0], y - pts[i - 1][1]
            else:
                tx = pts[i + 1][0] - pts[i - 1][0]
                ty = pts[i + 1][1] - pts[i - 1][1]
            L = math.hypot(tx, ty) or 1.0
            nx, ny = -ty / L, tx / L
            best_t = 0.0
            best = -1e18
            for k in range(-n_samp, n_samp + 1):
                t = (k / float(n_samp)) * max_shift
                v = _sample_scalar_bilinear(mem, x + nx * t, y + ny * t)
                if v > best:
                    best = v
                    best_t = t
            snapped.append((x + nx * best_t, y + ny * best_t))
        out.append(snapped)
    return out


def _iso_stroke_cubics(polylines, sx, sy, half_w, hex_):
    """Fair 0.5-iso centerlines → open/closed cubics, even-width strokes."""
    G = _vg_geom()
    sw = 0.5 * (float(sx) + float(sy)) * float(2.0 * max(half_w, 1.2))
    strokes = []
    for chain in polylines or []:
        if len(chain) < 3:
            continue
        gap = math.hypot(chain[0][0] - chain[-1][0], chain[0][1] - chain[-1][1])
        alen = _polyline_arc_len(chain)
        closed = len(chain) >= 8 and gap < max(1.8, 0.04 * max(alen, 1.0))
        work = G["fair_open_polyline"](chain, closed=closed, logo=False, max_leg=6.0)
        if len(work) < 2:
            work = [(float(p[0]), float(p[1])) for p in chain]
        if closed:
            d = G["fit_cubic_path"](work, sx, sy, error=1.20, corner_cos=0.36)
        else:
            d = G["fit_cubic_open"](work, sx, sy, error=1.20, corner_cos=0.36)
        if not d:
            continue
        strokes.append({"d": d, "hex": hex_, "sw": sw})
    return strokes


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


def capped_iso_mask(mask, *, sigma=0.8, cap_px=0.8):
    """0.5-iso of a sigma<=1 blur, restricted to cap_px of the hard contour.

    Pixels farther than cap_px from the unblurred boundary stay as in `mask`.
    This is a bounded seam smoother, not a free fairing pass.
    """
    m = (np.asarray(mask) > 0).astype(np.uint8)
    if int(m.sum()) < 8:
        return m
    sigma = float(min(1.0, max(0.0, sigma)))
    cap = float(min(0.8, max(0.0, cap_px)))
    if sigma <= 1e-6 or cap <= 1e-6:
        return m
    dist_in = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    dist_out = cv2.distanceTransform((1 - m).astype(np.uint8), cv2.DIST_L2, 3)
    dist_c = np.where(m > 0, dist_in, dist_out)
    blur = cv2.GaussianBlur(m.astype(np.float32), (0, 0), sigma)
    iso = blur >= 0.50
    out = m.astype(bool)
    out[dist_c <= cap] = iso[dist_c <= cap]
    return out.astype(np.uint8)


def _marching_squares_rings(field, level=0.5):
    """Subpixel 0.5-iso rings of a scalar field. Pixel centers are integer coords.

    The field is padded with zeros so a component that touches the image
    border still closes (the pad is outside the bitmap).
    """
    f0 = np.asarray(field, dtype=np.float32)
    if f0.shape[0] < 2 or f0.shape[1] < 2:
        return []
    f = np.pad(f0, 1, mode="constant", constant_values=0.0)
    h, w = f.shape

    def interp(p1, v1, p2, v2):
        den = float(v2) - float(v1)
        t = 0.5 if abs(den) < 1e-8 else (float(level) - float(v1)) / den
        if t < 0.0:
            t = 0.0
        elif t > 1.0:
            t = 1.0
        return (p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1]))

    segs = []
    for y in range(h - 1):
        r0 = f[y]
        r1 = f[y + 1]
        for x in range(w - 1):
            v00 = float(r0[x])
            v10 = float(r0[x + 1])
            v11 = float(r1[x + 1])
            v01 = float(r1[x])
            idx = 0
            if v00 >= level:
                idx |= 1
            if v10 >= level:
                idx |= 2
            if v11 >= level:
                idx |= 4
            if v01 >= level:
                idx |= 8
            if idx == 0 or idx == 15:
                continue
            t = interp((x, y), v00, (x + 1, y), v10)
            r = interp((x + 1, y), v10, (x + 1, y + 1), v11)
            b = interp((x, y + 1), v01, (x + 1, y + 1), v11)
            l = interp((x, y), v00, (x, y + 1), v01)
            # Saddle (5, 10): split by the cell-center value.
            if idx == 5 or idx == 10:
                center = 0.25 * (v00 + v10 + v11 + v01)
                if (idx == 5 and center >= level) or (idx == 10 and center < level):
                    segs.append((l, t))
                    segs.append((r, b))
                else:
                    segs.append((t, r))
                    segs.append((l, b))
                continue
            pairs = {
                1: (l, t),
                2: (t, r),
                3: (l, r),
                4: (r, b),
                6: (t, b),
                7: (l, b),
                8: (b, l),
                9: (b, t),
                11: (b, r),
                12: (r, l),
                13: (r, t),
                14: (t, l),
            }
            pair = pairs.get(idx)
            if pair is not None:
                segs.append(pair)
    if not segs:
        return []

    def qk(p):
        return (int(round(p[0] * 100.0)), int(round(p[1] * 100.0)))

    coord = {}
    edges = []
    for a, b in segs:
        ka, kb = qk(a), qk(b)
        if ka == kb:
            continue
        coord[ka] = a
        coord[kb] = b
        edges.append((ka, kb))
    adj = {}
    for i, (a, b) in enumerate(edges):
        adj.setdefault(a, []).append(i)
        adj.setdefault(b, []).append(i)
    used = set()
    rings = []
    for i0 in range(len(edges)):
        if i0 in used:
            continue
        a0, b0 = edges[i0]
        used.add(i0)
        ring = [a0, b0]
        cur = b0
        guard = 0
        closed = False
        while guard < len(edges) + 2:
            guard += 1
            nxt_e = None
            nxt_p = None
            for ei in adj.get(cur, ()):
                if ei in used:
                    continue
                u, v = edges[ei]
                nxt_e = ei
                nxt_p = v if u == cur else u
                break
            if nxt_e is None:
                break
            used.add(nxt_e)
            if nxt_p == a0:
                closed = True
                break
            ring.append(nxt_p)
            cur = nxt_p
        if closed and len(ring) >= 3:
            rings.append([(coord[k][0] - 1.0, coord[k][1] - 1.0) for k in ring])
    return rings


def _clamp_ring_to_contour(ring, mask, cap=0.8):
    """Project ring vertices back inside the cap band around the hard contour."""
    pts = np.asarray(ring, dtype=np.float32)
    if len(pts) < 3:
        return pts
    m = (np.asarray(mask) > 0).astype(np.uint8)
    h, w = m.shape
    din = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    dout = cv2.distanceTransform((1 - m).astype(np.uint8), cv2.DIST_L2, 3)
    sd_img = din - dout
    gx = cv2.Sobel(sd_img, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(sd_img, cv2.CV_32F, 0, 1, ksize=3)

    def sample(img, xs, ys):
        x0 = np.floor(xs).astype(np.int32)
        y0 = np.floor(ys).astype(np.int32)
        x1 = np.clip(x0 + 1, 0, w - 1)
        y1 = np.clip(y0 + 1, 0, h - 1)
        x0c = np.clip(x0, 0, w - 1)
        y0c = np.clip(y0, 0, h - 1)
        fx = np.clip(xs - x0, 0.0, 1.0)
        fy = np.clip(ys - y0, 0.0, 1.0)
        return (
            img[y0c, x0c] * (1 - fx) * (1 - fy)
            + img[y0c, x1] * fx * (1 - fy)
            + img[y1, x0c] * (1 - fx) * fy
            + img[y1, x1] * fx * fy
        )

    xs = np.clip(pts[:, 0], 0.0, w - 1.001)
    ys = np.clip(pts[:, 1], 0.0, h - 1.001)
    sd = sample(sd_img, xs, ys)
    dist = np.abs(sd)
    over = dist - float(cap)
    move = np.where(over > 0.0, over, 0.0)
    if float(move.max()) <= 0.0:
        return pts
    gxv = sample(gx, xs, ys)
    gyv = sample(gy, xs, ys)
    mag = np.hypot(gxv, gyv) + 1e-6
    direction = np.where(sd >= 0.0, -1.0, 1.0)
    pts = pts.copy()
    pts[:, 0] = xs + direction * move * (gxv / mag)
    pts[:, 1] = ys + direction * move * (gyv / mag)
    return pts


def _rings_to_evenodd_d(rings, sx, sy):
    parts = []
    for ring in rings:
        if ring is None or len(ring) < 3:
            continue
        x0, y0 = float(ring[0][0]) * sx, float(ring[0][1]) * sy
        parts.append(f"M {fmt(x0, 4)} {fmt(y0, 4)}")
        for p in ring[1:]:
            parts.append(f"L {fmt(float(p[0]) * sx, 4)} {fmt(float(p[1]) * sy, 4)}")
        parts.append("Z")
    return " ".join(parts)


def _iso_capped_paths(mask, sx, sy, *, sigma=0.8, cap_px=0.8):
    """Marching-squares 0.5-iso, hard-capped, one evenodd compound."""
    m = (np.asarray(mask) > 0).astype(np.uint8)
    sigma = float(min(1.0, max(0.0, sigma)))
    cap = float(min(0.8, max(0.0, cap_px)))
    field = cv2.GaussianBlur(m.astype(np.float32), (0, 0), sigma if sigma > 0 else 0.01)
    # Cap the field itself so the iso cannot leave the 0.8px band, then trace it.
    capped = capped_iso_mask(m, sigma=sigma, cap_px=cap).astype(np.float32)
    # Blend: use the blur only where the cap mask agrees, so the level set
    # stays on the capped contour. Hard capped mask's boundary is the limit.
    field = np.where(capped > 0.5, np.maximum(field, 0.5), np.minimum(field, 0.499))
    rings = _marching_squares_rings(field, 0.5)
    if not rings:
        return []
    kept = []
    for ring in rings:
        pts = np.asarray(ring, dtype=np.float32).reshape(-1, 1, 2)
        approx = cv2.approxPolyDP(pts, 0.35, True).reshape(-1, 2)
        if len(approx) < 3:
            continue
        clamped = _clamp_ring_to_contour(approx, m, cap=cap)
        if len(clamped) >= 3:
            kept.append(clamped)
    if not kept:
        return []
    d = _rings_to_evenodd_d(kept, sx, sy)
    if not d or "M" not in d:
        return []
    return [d]


def _boundary_curve_gap_px(mask, paths, sx, sy):
    """p75 distance (px) from the hard mask edge to the traced curve.

    A hug of the pixel crack sits near 0.5–1px. Larger values mean the cubic
    retreated and a shared seam can open onto paper.
    """
    try:
        from geom import sample_path_d
    except Exception:
        from lib.geom import sample_path_d
    m = (np.asarray(mask) > 0).astype(np.uint8)
    h, w = m.shape
    if h < 2 or w < 2 or sx <= 0 or sy <= 0:
        return 0.0
    er = cv2.erode(m, np.ones((3, 3), np.uint8))
    edge = (m > 0) & (er == 0)
    ys, xs = np.nonzero(edge)
    if len(xs) < 30:
        return 0.0
    if len(xs) > 6000:
        step = int(len(xs) // 6000) + 1
        xs = xs[::step]
        ys = ys[::step]
    canvas = np.zeros((h, w), np.uint8)
    drew = False
    for d in paths or []:
        try:
            rings = sample_path_d(d, curve_samples=4)
        except Exception:
            continue
        for ring in rings:
            if len(ring) < 2:
                continue
            pts = np.array([[p[0] / float(sx), p[1] / float(sy)] for p in ring], dtype=np.float32)
            pi = np.round(pts).astype(np.int32)
            pi[:, 0] = np.clip(pi[:, 0], 0, w - 1)
            pi[:, 1] = np.clip(pi[:, 1], 0, h - 1)
            if len(pi) >= 2:
                cv2.polylines(canvas, [pi], True, 1, 1, cv2.LINE_8)
                drew = True
    if not drew:
        return 99.0
    dist = cv2.distanceTransform((1 - canvas).astype(np.uint8), cv2.DIST_L2, 3)
    return float(np.percentile(dist[ys, xs], 75))


def _neighbor_mode(assign, comp, banned):
    """Majority label in the 8-ring around a component. Paper wins when it outnumbers ink."""
    dil = cv2.dilate(comp.astype(np.uint8), np.ones((3, 3), np.uint8))
    ring = (dil > 0) & ~comp
    if not np.any(ring):
        return None
    vals = np.asarray(assign)[ring]
    vals = vals[vals != banned]
    if vals.size == 0:
        return None
    shifted = vals.astype(np.int32) + 1
    if int(shifted.min()) < 0:
        return None
    bc = np.bincount(shifted)
    paper_n = int(bc[0]) if bc.size else 0
    ink_n = int(bc[1:].sum()) if bc.size > 1 else 0
    if paper_n > ink_n:
        return -1
    if ink_n <= 0:
        return -1
    return int(np.argmax(bc[1:]))


def _drop_small_components(assign, n_labels, max_area, protect=None):
    """Reassign connected crumbs under max_area to the surrounding label."""
    a = assign
    for lab in range(int(n_labels)):
        m = a == lab
        if not np.any(m):
            continue
        _n, labels, stats, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
        for i in range(1, _n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if area <= 0 or area >= max_area:
                continue
            comp = labels == i
            pick = _neighbor_mode(a, comp, lab)
            if pick is None:
                continue
            bw = int(stats[i, cv2.CC_STAT_WIDTH])
            bh = int(stats[i, cv2.CC_STAT_HEIGHT])
            aspect = max(bw, bh) / float(max(1, min(bw, bh)))
            # Keep a locked vein tip (long). Round crumbs are mosquito noise,
            # including ones sitting on a fill.
            if (
                protect is not None
                and pick != -1
                and area >= 8
                and aspect >= 3.5
                and float(protect[comp].mean()) >= 0.5
            ):
                continue
            a[comp] = pick
    return a


def _long_thin_stroke_mask(mask, unit):
    """Long, narrow components. Stairs and round crumbs fail the gates.

    Half-width is the median distance-transform radius. Whiskers pass;
    a bulky fill does not, even when its outline is jagged.
    """
    m = (np.asarray(mask) > 0).astype(np.uint8)
    lock = np.zeros(m.shape, bool)
    if int(m.sum()) < 24:
        return lock
    dist = cv2.distanceTransform(m, cv2.DIST_L2, 3)
    half_max = max(1.35, 2.2 * float(unit))
    len_min = max(24.0, 32.0 * float(unit))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < 20:
            continue
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        long = float(max(bw, bh))
        short = float(max(1, min(bw, bh)))
        if long < len_min or (long / short) < 4.0:
            continue
        comp = labels == i
        if float(np.median(dist[comp])) <= half_max:
            lock[comp] = True
    return lock


def solidify_jpeg_logo_assign(assign, palette):
    """Solidify a crumb-noisy JPEG logo mask before potrace.

    Canva JPEGs leave a low-chroma fringe plate and a cloud of dark crumbs,
    and bulky edges stay sawtoothed so potrace hugs the stairs. When the dark
    plate has many disconnected crumbs: dissolve that fringe into the nearest
    real plate, delete the crumbs, and snap bulky boundaries onto a Gaussian
    isocontour. Thin dark strokes (wing veins) stay locked. A clean mark with
    few crumbs is returned unchanged, so its potrace output stays put.

    Whisker-dense logos (long-narrow stroke mass on any ink) skip the whole
    pass even when crumbs pass the floor — snap eats those strokes.
    """
    a0 = np.asarray(assign, dtype=np.int32)
    if a0.size == 0 or not len(palette):
        return a0, {"applied": False, "crumbs": 0}
    h, w = a0.shape
    unit = float(max(h, w)) / 1422.0
    crumb_area = max(12, int(round(48.0 * unit * unit)))
    dark = []
    for i, c in enumerate(palette):
        if lum(c) < 42 and chroma_of_lab(lab_of_rgb([c])[0]) < 28:
            dark.append(i)
    crumbs = 0
    for di in dark:
        _n, _labels, stats, _ = cv2.connectedComponentsWithStats((a0 == di).astype(np.uint8), 8)
        for i in range(1, _n):
            area = int(stats[i, cv2.CC_STAT_AREA])
            if 0 < area < crumb_area:
                crumbs += 1
    if crumbs < 12 or not dark:
        return a0, {"applied": False, "crumbs": int(crumbs)}

    whisker = np.zeros(a0.shape, bool)
    for lab in range(len(palette)):
        whisker |= _long_thin_stroke_mask(a0 == lab, unit)
    whisker_px = int(whisker.sum())
    ink_px = int((a0 >= 0).sum())
    whisker_frac = (whisker_px / float(ink_px)) if ink_px else 0.0
    whisker_px_min = max(1500, int(round(2000.0 * unit * unit)))
    if whisker_px >= whisker_px_min:
        return a0, {
            "applied": False,
            "crumbs": int(crumbs),
            "whisker_gate": True,
            "thin": whisker_px,
            "thin_frac": round(whisker_frac, 5),
        }

    a = a0.copy()
    med_lim = 4.5 * unit
    fringe = []
    for i, c in enumerate(palette):
        if i in dark:
            continue
        lv = lum(c)
        ch = chroma_of_lab(lab_of_rgb([c])[0])
        m = a == i
        n = int(m.sum())
        if n < 30 or not (ch < 24.0 and 50.0 < lv < 190.0):
            continue
        er = cv2.erode(m.astype(np.uint8), np.ones((3, 3), np.uint8))
        edge_frac = float((m & (er == 0)).sum()) / float(n)
        if edge_frac < 0.22:
            continue
        dist = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 3)
        if float(np.median(dist[m])) <= med_lim:
            fringe.append(i)
    if fringe:
        best_d = np.full(a.shape, np.float32(1e9), np.float32)
        best_l = np.full(a.shape, -1, np.int32)
        targets = [-1] + [i for i in range(len(palette)) if i not in fringe]
        for lab in targets:
            src_u = ((a < 0) if lab < 0 else (a == lab)).astype(np.uint8)
            if int(src_u.sum()) == 0:
                continue
            d = cv2.distanceTransform((1 - src_u).astype(np.uint8), cv2.DIST_L2, 3)
            d[src_u > 0] = 0
            better = d < best_d
            best_d[better] = d[better]
            best_l[better] = lab
        fm = np.zeros(a.shape, bool)
        for i in fringe:
            fm |= a == i
        a[fm] = best_l[fm]

    a = _drop_small_components(a, len(palette), crumb_area)

    ksize = int(round(7.0 * unit))
    if ksize < 5:
        ksize = 5
    if ksize % 2 == 0:
        ksize += 1
    kern = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksize, ksize))
    thin = np.zeros(a.shape, bool)
    for di in dark:
        m = (a == di).astype(np.uint8)
        if int(m.sum()) == 0:
            continue
        opened = cv2.morphologyEx(m, cv2.MORPH_OPEN, kern)
        # Pixels farther than a 1px ring from the bulky core are the vein.
        # The ring itself stays unlocked so outline sawteeth can be snapped.
        near = cv2.dilate(opened, np.ones((3, 3), np.uint8))
        thin |= (m > 0) & (near == 0)

    sigma = max(0.8, 4.5 * unit)
    cap = sigma * 1.35
    src = a.copy()
    src[thin] = -2
    fields = []
    for lab in range(len(palette)):
        fields.append(cv2.GaussianBlur((src == lab).astype(np.float32), (0, 0), sigma))
    idx = np.argmax(np.stack(fields, 0), 0).astype(np.int32)
    sil = a >= 0
    din = cv2.distanceTransform(sil.astype(np.uint8), cv2.DIST_L2, 3)
    dout = cv2.distanceTransform((~sil).astype(np.uint8), cv2.DIST_L2, 3)
    sil_iso = cv2.GaussianBlur(sil.astype(np.float32), (0, 0), sigma) >= 0.50
    sil_new = sil.copy()
    band_in = (din <= cap) & (din > 0)
    band_out = (dout <= cap) & (dout > 0) & (~sil)
    sil_new[band_in] = sil_iso[band_in]
    sil_new[band_out] = sil_iso[band_out]
    out = np.full(a.shape, -1, np.int32)
    out[sil_new] = idx[sil_new]
    out[thin] = a[thin]
    # A locked vein can lose its neck to the isocontour. Close 1–2px gaps
    # only where that ink already was, so the vein stays attached and the
    # shaved sawteeth stay shaved.
    bridge = np.ones((3, 3), np.uint8)
    for di in dark:
        orig = a == di
        cur = (out == di).astype(np.uint8)
        if int(cur.sum()) == 0 or not np.any(orig):
            continue
        closed = cv2.morphologyEx(cur, cv2.MORPH_CLOSE, bridge)
        out[(closed > 0) & orig] = di
    # Snap can pinch off a round stub larger than the original crumb floor.
    out = _drop_small_components(
        out, len(palette), max(crumb_area, int(round(100.0 * unit * unit))), protect=thin
    )
    return out, {
        "applied": True,
        "crumbs": int(crumbs),
        "fringe": len(fringe),
        "sigma": round(float(sigma), 2),
        "thin": int(thin.sum()),
    }


def _cie_lab(rgb):
    """CIE L*a*b* (D65, sRGB). rgb is (..., 3) in 0..255."""
    x = np.asarray(rgb, dtype=np.float64)
    flat = np.clip(x.reshape(-1, 3), 0.0, 255.0) / 255.0
    lin = np.where(flat <= 0.04045, flat / 12.92, ((flat + 0.055) / 1.055) ** 2.4)
    mat = np.array(
        [
            [0.4124564, 0.3575761, 0.1804375],
            [0.2126729, 0.7151522, 0.0721750],
            [0.0193339, 0.1191920, 0.9503041],
        ],
        dtype=np.float64,
    )
    xyz = lin @ mat.T
    t = xyz / np.array([0.95047, 1.0, 1.08883], dtype=np.float64)
    eps = 216.0 / 24389.0
    kappa = 24389.0 / 27.0
    f = np.where(t > eps, np.cbrt(t), (kappa * t + 16.0) / 116.0)
    lab = np.stack(
        [116.0 * f[:, 1] - 16.0, 500.0 * (f[:, 0] - f[:, 1]), 200.0 * (f[:, 1] - f[:, 2])],
        axis=1,
    )
    return lab.reshape(x.shape[:-1] + (3,))


def _de76(a, b):
    d = np.asarray(a, dtype=np.float64) - np.asarray(b, dtype=np.float64)
    return np.sqrt(np.sum(d * d, axis=-1))


def drop_invented_jpeg_slivers(assign, palette, src_rgb, paper_rgb):
    """Reassign thin chromatic ink the source does not support.

    JPEG anti-alias fringe lands in the nearest palette slot (mauve hairlines
    on pale fur, and the same ink ghosting along white whiskers) even when no
    source pixel under the stroke is that colour. A component is invented when
    it is thin (median distance-transform radius <= ~2px at the 1422 reference),
    small (a hairline, not a plate-sized web), and CIE76 to its own ink is high
    (median >= 22 and under 10% of pixels within 18). Only dusty chromatic inks
    are donors (CIE C* 8–36). Saturated gold, orange, and yellow stay even when
    a thin sample's source ΔE is high — those strokes are the art. Pixels go to
    the neighbour label closest to the source under the stroke. Solid regions
    (the nose) and source-backed thin fur stay. Black is never a donor or a
    target, so a fringe cannot become a new speck.

    A component that passes those gates is still kept when it is a neutral
    grey hairline on white: under 30% of its outline touches black, at least
    70% of that outline touches paper, the source under it is at least 10 L*
    darker than the paper-labelled pixels in a 2px ring, that ring itself is
    white (median L* >= 89), and the source median is near-neutral (RGB
    channel spread <= 12). That is a real whisker drawn in the wrong dusty
    ink. Those kept components are recoloured to one grey ink: the rounded
    median RGB of their darker core (centerline pixels at or below the
    component's median L*). Fringe that hugs a black edge, and ghost arcs on
    blue-grey fur, still drop.
    """
    a0 = np.asarray(assign, dtype=np.int32)
    empty = {"applied": False, "components": 0, "dropped_px": 0}
    if a0.size == 0 or not len(palette):
        return a0, empty
    src = np.asarray(src_rgb)
    if src.ndim != 3 or src.shape[2] < 3:
        return a0, empty
    src = src[:, :, :3]
    if src.shape[:2] != a0.shape[:2]:
        src = cv2.resize(src, (a0.shape[1], a0.shape[0]), interpolation=cv2.INTER_CUBIC)
    if src.dtype != np.uint8:
        src = np.clip(np.round(src), 0, 255).astype(np.uint8)
    h, w = a0.shape
    unit = float(max(h, w)) / 1422.0
    half_max = max(1.5, 2.0 * float(unit))
    min_area = max(20, int(round(20.0 * unit * unit)))
    src_lab = _cie_lab(src)
    pr = np.clip(np.round(np.asarray(paper_rgb, dtype=np.float64).reshape(-1)[:3]), 0, 255)
    paper_lab = _cie_lab(pr.reshape(1, 3))[0]
    pal_u8 = np.clip(np.round(np.stack([np.asarray(c, dtype=np.float64).reshape(-1)[:3] for c in palette], 0)), 0, 255)
    ink_lab = _cie_lab(pal_u8.astype(np.uint8))
    is_black = []
    for c in palette:
        is_black.append(bool(lum(c) < 42 and chroma_of_lab(lab_of_rgb([c])[0]) < 28))
    # CIE C* of each ink. Fringe slots are dusty; saturated brand inks are not.
    ink_chroma = [float(np.hypot(ink_lab[i][1], ink_lab[i][2])) for i in range(len(palette))]
    max_area = max(700, int(round(800.0 * unit * unit)))
    color_of = {-1: paper_lab}
    for i in range(len(palette)):
        color_of[i] = ink_lab[i]
    out = a0.copy()
    n_comp = 0
    dropped_px = 0
    to_paper = 0
    to_black = 0
    n_kept = 0
    kept_px = 0
    kept_comps = []
    core_chunks = []
    # Grey hairline on white. Gaps on the 45 mauve components of
    # OIP-981884430 at 1422: outer whiskers are black-adj 0.01–0.04,
    # paper-adj 0.99–1.00, ΔL 26–39, paper-ring L* 91–95, source spread 0.
    # Cheek-channel ghosts that are also low-black sit at paper-adj 0.51–0.56
    # or, when paper-adj is high, ring L* 86–87 and source spread 18–21.
    # Black-edge fringe is black-adj >= 0.42.
    black_adj_max = 0.30
    paper_adj_min = 0.70
    dl_min = 10.0
    ground_L_min = 89.0
    spread_max = 12.0
    kern = np.ones((3, 3), np.uint8)
    ring_k = np.ones((5, 5), np.uint8)
    black_m = np.zeros(a0.shape, bool)
    for i, ib in enumerate(is_black):
        if ib:
            black_m |= a0 == i
    paper_m = a0 < 0
    black_touch = cv2.dilate(black_m.astype(np.uint8), kern) > 0
    paper_touch = cv2.dilate(paper_m.astype(np.uint8), kern) > 0
    Lch = src_lab[:, :, 0]
    for ink in range(len(palette)):
        if is_black[ink]:
            continue
        if not (8.0 <= ink_chroma[ink] <= 36.0):
            continue
        m = (a0 == ink).astype(np.uint8)
        if int(m.sum()) < min_area:
            continue
        dist = cv2.distanceTransform(m, cv2.DIST_L2, 3)
        n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
        own = ink_lab[ink]
        for ci in range(1, n):
            area = int(stats[ci, cv2.CC_STAT_AREA])
            if area < min_area or area > max_area:
                continue
            comp = labels == ci
            if float(np.median(dist[comp])) > half_max:
                continue
            de = _de76(src_lab[comp], own)
            med = float(np.median(de))
            frac_close = float(np.mean(de < 18.0))
            # Unsupported: the ink is not in the source under this stroke.
            # Real thin fur still has a core within ΔE 18 (brown chin on 981
            # stays above 0.30). Invented mauve fringe sits at 0.00 / median ~30.
            if not (med >= 22.0 and frac_close < 0.10):
                continue
            er = cv2.erode(comp.astype(np.uint8), kern)
            boundary = comp & (er == 0)
            nb = int(boundary.sum())
            if nb:
                black_adj = float((boundary & black_touch).sum()) / float(nb)
                paper_adj = float((boundary & paper_touch).sum()) / float(nb)
                ring_dil = cv2.dilate(comp.astype(np.uint8), ring_k)
                pring = (ring_dil > 0) & (~comp) & paper_m
                if int(pring.sum()) >= 12:
                    ground_L = float(np.median(Lch[pring]))
                    dL = ground_L - float(np.median(Lch[comp]))
                else:
                    ground_L = 0.0
                    dL = 0.0
                src_med = np.median(src[comp], axis=0)
                spread = float(src_med.max() - src_med.min())
                if (
                    black_adj < black_adj_max
                    and paper_adj >= paper_adj_min
                    and dL >= dl_min
                    and ground_L >= ground_L_min
                    and spread <= spread_max
                ):
                    n_kept += 1
                    kept_px += area
                    # Darker core: centerline (dist >= median) and at or below
                    # the component's median L*. Pale JPEG halo stays out of
                    # the sample so the flat ink matches the hair, not the fade.
                    Ls = Lch[comp]
                    sel = (dist[comp] >= float(np.median(dist[comp]))) & (Ls <= float(np.median(Ls)))
                    if int(sel.sum()) < 8:
                        sel = Ls <= float(np.median(Ls))
                    if int(sel.sum()) < 8:
                        sel = np.ones(int(comp.sum()), dtype=bool)
                    core_chunks.append(src[comp][sel])
                    kept_comps.append(comp)
                    continue
            dil = cv2.dilate(comp.astype(np.uint8), kern)
            ring = (dil > 0) & (~comp)
            if not np.any(ring):
                continue
            neigh = a0[ring]
            vals = np.unique(neigh)
            med_src = np.median(src_lab[comp], axis=0)
            cands = []
            for v in vals:
                v = int(v)
                d = float(np.linalg.norm(med_src - color_of[v]))
                cands.append((d, v))
            cands.sort()
            chosen = None
            for _d, v in cands:
                # Never paint the fringe into black. That is a new speck.
                if v >= 0 and is_black[v]:
                    continue
                chosen = v
                break
            if chosen is None or chosen == ink:
                continue
            out[comp] = chosen
            n_comp += 1
            dropped_px += area
            if chosen < 0:
                to_paper += area
            elif is_black[chosen]:
                to_black += area
    grey_hex = None
    if kept_comps:
        pooled = np.concatenate(core_chunks, axis=0)
        grey = np.clip(np.round(np.median(pooled, axis=0)), 0, 255).astype(np.float64)
        grey_idx = None
        for i, c in enumerate(palette):
            if np.all(np.round(np.asarray(c, dtype=np.float64).reshape(-1)[:3]) == grey):
                grey_idx = i
                break
        if grey_idx is None:
            palette.append(grey)
            grey_idx = len(palette) - 1
        for comp in kept_comps:
            out[comp] = grey_idx
        grey_hex = to_hex(grey)
    if n_comp == 0 and grey_hex is None:
        return a0, {
            "applied": False,
            "components": 0,
            "dropped_px": 0,
            "kept": int(n_kept),
            "kept_px": int(kept_px),
            "half_max": round(float(half_max), 3),
        }
    meta = {
        "applied": True,
        "components": int(n_comp),
        "dropped_px": int(dropped_px),
        "to_paper": int(to_paper),
        "to_black": int(to_black),
        "kept": int(n_kept),
        "kept_px": int(kept_px),
        "half_max": round(float(half_max), 3),
    }
    if grey_hex is not None:
        meta["grey"] = grey_hex
        meta["recolored"] = int(n_kept)
    return out, meta


def logo_potrace_mask_layers(assign, palette, sx, sy, *, min_area_px=10):
    """Per-ink potrace of the assign mask. Evenodd compounds, no shared-crack Schneider.

    alphamax/opttol are potrace's own defaults so corners that are actually
    sharp stay corners and the cubic stays on the bitmap. If a fit retreats
    off the shared seam, that ink is replaced by a marching-squares 0.5-iso
    of a sigma<=1 blur, hard-capped to 0.8px from the unblurred contour.
    """
    a = np.asarray(assign, dtype=np.int32)
    order = list(range(len(palette)))
    order.sort(key=lambda i: (-lum(palette[i]), -int((a == i).sum())))
    layers = []
    iso_n = 0
    # p75 gap above this (px) means the cubic left the pixel crack.
    gap_trigger = 1.8
    for ink in order:
        area = int((a == ink).sum())
        if area < int(min_area_px):
            continue
        mask = (a == ink).astype(np.uint8)
        paths = potrace_paths(
            mask,
            sx,
            sy,
            scale=1,
            alphamax=1.0,
            opttol=0.2,
            turdsize=0,
            smooth=0.0,
        )
        if paths:
            try:
                gap = _boundary_curve_gap_px(mask, paths, sx, sy)
            except Exception:
                gap = 0.0
            if gap > gap_trigger:
                iso_paths = _iso_capped_paths(mask, sx, sy, sigma=0.8, cap_px=0.8)
                if iso_paths:
                    paths = iso_paths
                    iso_n += 1
        if not paths:
            continue
        rec = {
            "hex": to_hex(palette[ink]),
            "name": layer_name(palette[ink]),
            "paths": paths,
            "lum": lum(palette[ink]),
            "n": area,
        }
        layers.append(rec)
    return layers, {
        "vector_graph": "logo-potrace-mask",
        "iso_fallback": iso_n,
        "colors": len(layers),
    }


def svg_from_layers(layers, width_in, height_in, paper_hex=None):
    w = fmt(width_in, 4)
    h = fmt(height_in, 4)
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}in" height="{h}in" viewBox="0 0 {w} {h}">',
    ]
    if paper_hex:
        parts.append(
            f'  <path d="M 0 0 L {w} 0 L {w} {h} L 0 {h} Z" fill="{paper_hex}" data-name="paper-underlay"/>'
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
# Busy type-poster plate lock (Dirt Devils t8c → Studio Vectorize)
# Composite-on-white + cream/orange locks + per-ink evenodd (no shared-seam punch)
# ---------------------------------------------------------------------------

def is_busy_type_poster(rgb, paper, paper_rgb, alpha=None) -> bool:
    """Busy screenprint posters with cream glyphs + warm orange type plates.

    These must NOT use logo=True shared-seam compounds — a wrapping cycle can
    punch the orange plate out. Prefer per-ink evenodd cubics (t8c).
    """
    art = ~paper
    if float(art.mean()) < 0.12:
        return False
    alpha_frac = float((alpha < 28).mean()) if alpha is not None else 0.0
    paper_ok = paper_rgb is None or lum(paper_rgb) >= 160 or alpha_frac >= 0.08
    if not paper_ok:
        return False
    h, w = rgb.shape[:2]
    if max(h, w) < 280:
        return False
    R = rgb[:, :, 0].astype(np.int16)
    G = rgb[:, :, 1].astype(np.int16)
    B = rgb[:, :, 2].astype(np.int16)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    S = hsv[:, :, 1].astype(np.int16)
    H = hsv[:, :, 0].astype(np.int16)
    L = 0.299 * R + 0.587 * G + 0.114 * B
    cream = art & (L >= 188) & (S <= 46) & (B >= 160) & (np.abs(R - G) <= 36)
    orange = (
        art
        & (R >= 142)
        & (G <= 148)
        & (B <= 112)
        & ((R - G) >= 38)
        & ((R - B) >= 40)
        & (L >= 58)
        & (L <= 215)
        & (S >= 42)
        & (H <= 26)
    )
    cream_frac = float(cream.mean())
    orange_frac = float(orange.mean())
    if cream_frac < 0.01 or orange_frac < 0.01:
        return False
    nuniq = unique_color_bins(rgb, 3)
    # Busy posters: many AA colors OR large cream+orange coverage.
    if nuniq < 400 and (cream_frac + orange_frac) < 0.08:
        return False
    return True


def _ink_ids_by_kind(palette):
    """Classify palette indices into cream / warm-orange / keyline-black."""
    cream_ids, orange_ids, black_ids = [], [], []
    for i, c in enumerate(palette):
        r, g, b = float(c[0]), float(c[1]), float(c[2])
        lv = lum(c)
        ch = chroma_of_lab(lab_of_rgb([c])[0])
        if lv >= 188 and ch < 28 and b >= 150:
            cream_ids.append(i)
        elif (
            lv >= 55
            and lv <= 210
            and r >= 140
            and g <= 160
            and b <= 120
            and (r - g) >= 30
            and (r - b) >= 35
        ):
            orange_ids.append(i)
        elif _is_keyline_ink(c) or (lv < 48 and ch < 22):
            black_ids.append(i)
    return cream_ids, orange_ids, black_ids


def protect_cream_orange_plates(assign, palette, rgb, paper):
    """Lock cream glyphs and warm orange plates before keyline cleanup.

    Prevents rust/brown argmax and cream knockout from eating the orange
    type plate (ANNUAL brush failure mode). Does not invent Dirt-Devils
    geometry — uses palette + color rules only.
    """
    if assign is None or not len(palette):
        return assign
    a = np.asarray(assign, dtype=np.int32).copy()
    cream_ids, orange_ids, black_ids = _ink_ids_by_kind(palette)
    if not cream_ids and not orange_ids:
        return a
    R = rgb[:, :, 0].astype(np.int16)
    G = rgb[:, :, 1].astype(np.int16)
    B = rgb[:, :, 2].astype(np.int16)
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    S = hsv[:, :, 1].astype(np.int16)
    H = hsv[:, :, 0].astype(np.int16)
    L = 0.299 * R + 0.587 * G + 0.114 * B
    art = ~paper
    cream_m = art & (L >= 188) & (S <= 46) & (B >= 160) & (np.abs(R - G) <= 36)
    orange_m = (
        art
        & (R >= 142)
        & (G <= 148)
        & (B <= 112)
        & ((R - G) >= 38)
        & ((R - B) >= 40)
        & (L >= 58)
        & (L <= 215)
        & (S >= 42)
        & (H <= 26)
    )
    black_m = art & (L <= 78) & (R <= 108) & (S <= 80)
    # Prefer existing palette slots; else skip lock for that family.
    if orange_ids:
        oi = max(orange_ids, key=lambda i: int((a == i).sum()))
        a[orange_m] = oi
        # 1px feather of pale orange touching the plate (not cream/black).
        ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        touch = cv2.dilate((a == oi).astype(np.uint8), ker) > 0
        feather = (
            touch
            & art
            & ~cream_m
            & ~black_m
            & (H <= 30)
            & (S >= 22)
            & (R > G)
            & (R > B + 6)
            & (L > 80)
            & (L < 230)
        )
        a[feather] = oi
    if cream_ids:
        ci = max(cream_ids, key=lambda i: int((a == i).sum()))
        a[cream_m] = ci
        # Paper seams between cream glyph and orange become cream (glyph on plate).
        if orange_ids:
            oi = max(orange_ids, key=lambda i: int((a == i).sum()))
            ker3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
            near_c = cv2.dilate((a == ci).astype(np.uint8), ker3) > 0
            near_o = cv2.dilate((a == oi).astype(np.uint8), ker3) > 0
            seam = (a < 0) & near_c & near_o & ~black_m
            a[seam] = ci
    if black_ids:
        bi = min(black_ids, key=lambda i: lum(palette[i]))
        a[black_m] = bi
    a[paper] = -1
    return a


def plate_paint_order(palette):
    """Back-to-front: midtones, warm orange, cream, keyline black last.

    Orange under cream so type glyphs sit on the plate; black last so the
    keyline is a separate fill, not a stroke that punches cream.
    """
    cream_ids, orange_ids, black_ids = _ink_ids_by_kind(palette)
    special = set(cream_ids) | set(orange_ids) | set(black_ids)
    mid = [i for i in range(len(palette)) if i not in special]
    mid.sort(key=lambda i: (-lum(palette[i]), -i))
    orange_ids = sorted(orange_ids, key=lambda i: -int(lum(palette[i])))
    cream_ids = sorted(cream_ids, key=lambda i: -int(lum(palette[i])))
    black_ids = sorted(black_ids, key=lambda i: lum(palette[i]))
    return mid + orange_ids + cream_ids + black_ids


def emit_per_ink_evenodd_plates(
    assign,
    palette,
    sx,
    sy,
    *,
    paper_rgb,
    width_in,
    height_in,
    grow_cream_orange=True,
):
    """One evenodd cubic compound per ink (t8c). No shared-seam punch."""
    layers = []
    order = plate_paint_order(palette)
    cream_ids, orange_ids, black_ids = _ink_ids_by_kind(palette)
    for ink in order:
        raw = assign == ink
        area = int(raw.sum())
        if area < 12:
            continue
        raw_u8 = raw.astype(np.uint8)
        if grow_cream_orange and ink in (set(cream_ids) | set(orange_ids)):
            raw_u8 = cv2.dilate(raw_u8, np.ones((3, 3), np.uint8))
        is_black = ink in black_ids or lum(palette[ink]) < 48
        is_type = ink in cream_ids or ink in orange_ids
        if is_black:
            alphamax, opttol, turd, smooth = 0.45, 0.02, 0, 0.0
        elif is_type:
            alphamax, opttol, turd, smooth = 0.55, 0.02, 0, 0.0
        else:
            alphamax, opttol, turd, smooth = 1.0, 0.12, 4, 0.45
        paths = potrace_paths(
            raw_u8,
            sx,
            sy,
            scale=1,
            alphamax=alphamax,
            opttol=opttol,
            turdsize=turd,
            smooth=smooth,
        )
        if not paths:
            continue
        layers.append(
            {
                "hex": to_hex(palette[ink]),
                "name": layer_name(palette[ink]),
                "paths": paths,
                "lum": lum(palette[ink]),
                "n": area,
            }
        )
    if not layers:
        return None, {}
    paper_hex = to_hex(paper_rgb) if paper_rgb is not None else "#ffffff"
    svg = svg_from_layers(layers, width_in, height_in, paper_hex)
    meta = {
        "vector_graph": "per-ink-evenodd-plates",
        "paths": len(re.findall(r"<path\b", svg, re.I)),
        "colors": len(layers),
        "shared_seams": 0,
        "plate_lock": True,
    }
    return svg, meta


def vectorize_busy_type_poster(rgb, paper, paper_rgb, inches, kind, t0, h0, w0, rec_err):
    """Screenprint / type posters: soft membership + cream/orange locks + per-ink plates."""
    h, w = rgb.shape[:2]
    cap = 1600
    work = rgb
    paper_w = paper
    if max(h, w) > cap:
        s = cap / float(max(h, w))
        work = cv2.resize(
            rgb,
            (int(round(w * s)), int(round(h * s))),
            interpolation=cv2.INTER_AREA,
        )
        paper_w = (
            cv2.resize(
                paper.astype(np.uint8),
                (work.shape[1], work.shape[0]),
                interpolation=cv2.INTER_NEAREST,
            )
            > 0
        )
        h, w = work.shape[:2]

    grad = gradient_mag(work)
    pal = kmeans_screenprint_palette(work, paper_w, paper_rgb, max_k=12)
    if not pal:
        pal = build_palette(work, paper_w, grad, max_k=12, min_k=6, merge_thresh=11.0)
    pal = drop_paper_inks(pal, paper_rgb, thresh=10.0 if lum(paper_rgb) >= 200 else 8.0)
    if not pal:
        pal = [np.array([20.0, 20.0, 20.0])]

    # Soft membership + fairing (t8c), then semantic locks.
    try:
        mem, _ = soft_membership(work, pal, paper_rgb, tau=11.0)
        mem = regularize_membership(mem, sigma=0.50)
        assign = mem.argmax(axis=2).astype(np.int32)
        assign[assign >= len(pal)] = -1
        assign[paper_w] = -1
    except Exception:
        assign, _ = assign_pixels(work, paper_w, pal, paper_rgb, paper_win=0.0)

    assign = protect_cream_orange_plates(assign, pal, work, paper_w)
    # Do NOT tuck dark over cream/orange — that punches type plates.
    assign = merge_small_islands(
        assign, pal, min_size=24, protect_thin_dark=True, keep_light_holes=True
    )
    assign = protect_cream_orange_plates(assign, pal, work, paper_w)
    assign, pal = compact_assign_palette(assign, pal)

    if w0 >= h0:
        width_in = float(inches)
        height_in = float(inches) * (h0 / float(w0))
    else:
        height_in = float(inches)
        width_in = float(inches) * (w0 / float(h0))
    sx = width_in / float(assign.shape[1])
    sy = height_in / float(assign.shape[0])

    # Prefer per-ink evenodd; fall back to vector-graph with logo=False + keep_thin_light.
    svg, pmeta = emit_per_ink_evenodd_plates(
        assign, pal, sx, sy, paper_rgb=paper_rgb, width_in=width_in, height_in=height_in
    )
    if svg is None:
        try:
            layers, aux = vector_graph_layers(
                assign.astype(np.int32),
                pal,
                sx,
                sy,
                rgb=work,
                logo=False,
                try_primitives=False,
                min_area_px=12,
                gap_fill=True,
                keep_thin_light=True,
            )
            if layers:
                svg = svg_from_layers_with_gaps(
                    layers, width_in, height_in, to_hex(paper_rgb), gap_strokes=aux.get("gap_strokes") or []
                )
                pmeta = {
                    "vector_graph": "shared-seams-no-logo",
                    "paths": len(re.findall(r"<path\b", svg, re.I)),
                    "colors": len(layers),
                    "coverage": aux.get("coverage"),
                    "plate_lock": True,
                    "shared_seams": aux.get("shared_seams"),
                }
        except Exception as e:
            sys.stderr.write(f"busy_type_poster graph fallback failed: {e}\n")
            raise RuntimeError("busy type poster trace failed")

    n_paths = len(re.findall(r"<path\b", svg, re.I))
    meta = {
        "engine": "decoclub-vector",
        "backend": "potrace" if pmeta.get("vector_graph") == "per-ink-evenodd-plates" else "vector-graph",
        "mode": kind,
        "paths": n_paths,
        "colors": pmeta.get("colors") or len(pal),
        "palette": [to_hex(c) for c in pal],
        "pixel": [w0, h0],
        "work": [w, h],
        "up": 1,
        "inches": [width_in, height_in],
        "ms": int((time.time() - t0) * 1000),
        "paper": to_hex(paper_rgb),
        "overlay": False,
        "rec_err": round(float(rec_err), 2),
        "keyline": False,
        "shared_edge": False,
        "busy_type_poster": True,
        "plate_lock": True,
        "vector_graph": pmeta.get("vector_graph"),
        "shared_seams": pmeta.get("shared_seams", 0),
        "polish": {},
    }
    return svg, meta


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
    """Composite alpha onto the sheet (Dirt Devils t8c plate-lock).

    Transparent / low-alpha pixels are real paper: counters, distress knockouts,
    the sheet. Stored RGB under alpha-0 is often junk near-white — never treat
    it as ink and never hole-fill those counters to black.
    """
    a = np.asarray(alpha, dtype=np.float32) / 255.0
    prgb = np.asarray(paper_rgb, dtype=np.float32).copy()
    alpha_frac = float((alpha < 28).mean())
    border = np.concatenate([alpha[0], alpha[-1], alpha[:, 0], alpha[:, -1]])
    border_hole = float((border < 28).mean()) if border.size else 0.0
    # Light sheet, or alpha holes that reach the border (cutout PNG / type poster).
    if lum(prgb) >= 140 or (alpha_frac > 0.04 and border_hole > 0.20):
        prgb = np.array([255.0, 255.0, 255.0], np.float32)
    fill = prgb.reshape(1, 1, 3)
    out = rgb.astype(np.float32) * a[:, :, None] + fill * (1.0 - a[:, :, None])
    out = np.clip(np.round(out), 0, 255).astype(np.uint8)
    paper2 = np.asarray(paper, dtype=bool) | (alpha < 28)
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
            keep_thin_light=True,
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
        order = plate_paint_order(pal)
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


def soft_membership(rgb, palette, paper_rgb, tau=12.0):
    """Softmax Lab membership to palette inks + paper. Last channel is paper.

    Vector Magic / Vectorizer.AI: keep original RGB; the 0.5 iso between the
    two flanking inks is the true AA edge. Hard posterize-then-trace throws
    that coverage away.
    """
    lab = to_lab(rgb)
    k = len(palette)
    if k < 1:
        h, w = rgb.shape[:2]
        mem = np.ones((h, w, 1), np.float32)
        return mem, np.zeros((h, w, 1), np.float32)
    cents = lab_of_rgb(np.array(palette)).reshape(1, 1, k, 3)
    diff = lab[:, :, None, :] - cents
    dist2 = np.sum(diff * diff, axis=3)
    p_lab = lab_of_rgb([paper_rgb])[0]
    dpaper = np.sum((lab - p_lab) ** 2, axis=2, keepdims=True)
    all_d = np.concatenate([np.sqrt(np.maximum(dist2, 0.0)), np.sqrt(np.maximum(dpaper, 0.0))], axis=2)
    z = np.exp(-all_d / float(max(4.0, tau)))
    z /= np.maximum(z.sum(axis=2, keepdims=True), 1e-12)
    return z.astype(np.float32), dist2


def regularize_membership(mem, sigma=0.65):
    """Fair membership with a small Gaussian — sub-pixel AA, not a new palette."""
    out = np.asarray(mem, dtype=np.float32).copy()
    if sigma > 0.05:
        for i in range(out.shape[2]):
            out[:, :, i] = cv2.GaussianBlur(out[:, :, i], (0, 0), float(sigma))
    out /= np.maximum(out.sum(axis=2, keepdims=True), 1e-12)
    return out


def _punch_chroma_from_neutrals(rgb, assign, pal, chroma_cut=30.0):
    """High-chroma pixels must not sit on a grey veil ink (sockets, mountains)."""
    a = np.asarray(assign, dtype=np.int32).copy()
    ch = chroma_map(to_lab(rgb))
    pal_lab = lab_of_rgb(np.array(pal))
    chroma_ids = [
        j
        for j, c in enumerate(pal)
        if chroma_of_lab(pal_lab[j]) >= 18.0
    ]
    if not chroma_ids:
        return a
    rgb_f = rgb.astype(np.float32)
    pal_f = [np.asarray(c, dtype=np.float32) for c in pal]
    for i, c in enumerate(pal):
        if chroma_of_lab(pal_lab[i]) > 22.0:
            continue
        if not (60.0 <= lum(c) <= 190.0):
            continue
        punch = (a == i) & (ch > chroma_cut)
        if not punch.any():
            continue
        ys, xs = np.where(punch)
        pix = rgb_f[ys, xs]
        best = None
        best_d = None
        for j in chroma_ids:
            d = np.sum((pix - pal_f[j]) ** 2, axis=1)
            if best is None:
                best = np.full(d.shape, j, np.int32)
                best_d = d
            else:
                hit = d < best_d
                best[hit] = j
                best_d[hit] = d[hit]
        a[ys, xs] = best
    return a


def _is_veil_ink(c, assign, i) -> bool:
    """Low-chroma mid-luma plate sitting on many other inks (translucent overlay)."""
    if not (75.0 <= lum(c) <= 175.0):
        return False
    if chroma_of_lab(lab_of_rgb([c])[0]) > 26.0:
        return False
    m = assign == i
    area = int(m.sum())
    if area < 0.018 * assign.size or area > 0.40 * assign.size:
        return False
    dil = cv2.dilate(m.astype(np.uint8), np.ones((3, 3), np.uint8))
    ring = (dil > 0) & (~m)
    neigh = assign[ring]
    neigh = neigh[neigh >= 0]
    if neigh.size < 40:
        return False
    return int(np.unique(neigh).size) >= 4


def _plate_poster_palette(rgb, paper, paper_rgb, grad):
    """Hierarchical flats palette — k-means samples AA and invents mud inks."""
    pal = build_palette(rgb, paper, grad, max_k=16, min_k=8, merge_thresh=10.5)
    pal = inject_missing_inks(rgb, paper, pal, grad, min_chroma=14.0, min_px=18)
    pal = drop_paper_inks(pal, paper_rgb, thresh=10.0 if lum(paper_rgb) >= 200 else 8.0)
    pal = _merge_near_inks(pal, thresh=12.0)
    if not pal:
        pal = [np.array([20.0, 20.0, 20.0], np.float32)]
    return pal


def _plate_poster_assign(work, paper_w, pal, paper_rgb):
    """Soft membership + shared-edge cleanup. Protects thin bone / gothic."""
    assign, pal2, _mem = _plate_graph_assign(work, paper_w, pal, paper_rgb)
    return assign, pal2


def _plate_graph_assign(work, paper_w, pal, paper_rgb):
    """Softmax membership → argmax labels. Light cleanup only.

    SLIC / morph-close / median windows seal tooth windows and water foam
    into neighboring plates. Shared-edge vote is enough for the graph.
    """
    mem, _dist2 = soft_membership(work, pal, paper_rgb, tau=9.0)
    mem = regularize_membership(mem, sigma=0.35)
    k = len(pal)
    assign = mem.argmax(axis=2).astype(np.int32)
    assign[assign == k] = -1
    assign[paper_w] = -1
    pal2 = recolor_palette(work, assign, pal, grad=gradient_mag(work))
    # Specks only. Majority-vote / darker-wins / island-merge fills tooth
    # windows and water foam (light holes in a darker plate).
    assign = despeckle(assign, pal2, min_size=6)
    assign = fill_small_assign_holes(
        assign, pal2, max_hole=max(8, int(0.000015 * assign.size))
    )
    assign = merge_small_islands(
        assign,
        pal2,
        min_size=max(22, int(0.00005 * assign.size)),
        keep_light_holes=True,
    )
    assign = _punch_chroma_from_neutrals(work, assign, pal2, chroma_cut=22.0)
    assign, pal2 = compact_assign_palette(assign, pal2)
    return assign, pal2, mem


def vectorize_plate_poster(rgb, paper, paper_rgb, inches, kind, t0, h0, w0, rec_err):
    """Canva/screenprint plates: overlay unmix + tooth grid + socket strokes.

    Landscape graphs from the unmixed high-chroma raster. The closed eye is
    the enclosed grey hole. The open socket is an ellipse fit to that side's
    grey rim. Tooth walls are the luma-gated mouth bone after a short
    vertical opening. Frame circle from overlay_support. Veil is punched on
    those walls. Gothic with a chromatic halo stays destair polygons on top.
    """
    h, w = rgb.shape[:2]
    glyph, halo, halo_rgb = extract_letters(rgb, paper)
    if glyph is not None and not np.any(glyph):
        glyph = halo = halo_rgb = None

    cap = 1200
    work = rgb
    paper_w = paper
    if max(h, w) > cap:
        s = cap / float(max(h, w))
        work = cv2.resize(
            rgb,
            (int(round(w * s)), int(round(h * s))),
            interpolation=cv2.INTER_AREA,
        )
        paper_w = (
            cv2.resize(
                paper.astype(np.uint8),
                (work.shape[1], work.shape[0]),
                interpolation=cv2.INTER_NEAREST,
            )
            > 0
        )
        h, w = work.shape[:2]

    def _resize_mask(m, like):
        if m is None:
            return None
        if m.shape[:2] == like.shape[:2]:
            return m
        return cv2.resize(
            m.astype(np.uint8), (like.shape[1], like.shape[0]), interpolation=cv2.INTER_NEAREST
        )

    if glyph is not None:
        glyph = _resize_mask(glyph.astype(np.uint8), work) > 0
        halo = _resize_mask(halo.astype(np.uint8), work) > 0 if halo is not None else None

    unmix = overlay_unmix(work, paper_w)
    veil_rec_mask = None
    graph_rgb = work
    ridge_keep = None
    grey_keep = None
    olive_keep = None
    grey_pls = []
    olive_pls = []
    ridge_half = 3.0
    grey_rgb = np.array([128.0, 128.0, 132.0], np.float32)
    olive_rgb = np.array([120.0, 90.0, 70.0], np.float32)
    frame_circle = None
    tooth_mask = None
    nasal_mask = None
    if unmix is not None:
        graph_rgb = unmix["land"]
        if glyph is not None and np.any(glyph):
            unmix["veil"][glyph] = 0
            if halo is not None:
                unmix["veil"][halo] = 0
        (
            ridge_keep,
            grey_keep,
            olive_keep,
            ridge_half,
            grey_rgb,
            olive_rgb,
        ) = _dual_ink_ridge_keep(
            work,
            paper_w,
            unmix["hull"],
            glyph=glyph,
            halo=halo,
            circle=unmix.get("circle"),
        )
        mouth_bone = _vertical_tooth_mask(
            grey_keep, olive_keep, work, unmix.get("circle"), unmix.get("hull")
        )
        grey_pls, olive_pls, frame_circle = _emblem_cycle_polylines(
            grey_keep,
            olive_keep,
            unmix.get("circle"),
            ridge_half,
            unmix["hull"],
            rgb=work,
        )
        # Closed cycles are the almonds and the tooth windows. The jaw, if
        # present, is the open first polyline. Punch veil inside the closed
        # ones only — not along every keep tick, and not as a ribbon fill.
        closed_cycles = [
            p
            for p in list(grey_pls or []) + list(olive_pls or [])
            if p and math.hypot(p[0][0] - p[-1][0], p[0][1] - p[-1][1]) < 3.0
        ]
        almond_cycles = [
            p
            for p in (grey_pls or [])
            if p and math.hypot(p[0][0] - p[-1][0], p[0][1] - p[-1][1]) < 3.0
        ]
        interiors = _basin_interiors(
            grey_keep, olive_keep, unmix.get("circle"), closed_cycles
        )
        # Socket openings are one flat warm color so the graph cannot drop
        # a dark wedge in the eye. Tooth windows keep the original sunset.
        if interiors is not None:
            graph_rgb = graph_rgb.copy()
            graph_rgb[interiors > 0] = work[interiors > 0]
            unmix["veil"][interiors > 0] = 0
            red = _strict_socket_red(work)
            for pts in almond_cycles:
                sock = np.zeros(work.shape[:2], np.uint8)
                arr = np.array(
                    [[int(round(p[0])), int(round(p[1]))] for p in pts], np.int32
                )
                cv2.fillPoly(sock, [arr], 1)
                sock = cv2.erode(sock, np.ones((3, 3), np.uint8))
                n_sock = int(sock.sum())
                pix = work[(sock > 0) & red]
                # A cheek seat is not socket red. Leave those pixels alone
                # so the graph cannot paint an orange bar.
                if n_sock < 40 or pix.shape[0] < 0.22 * n_sock:
                    continue
                flat = np.median(pix.astype(np.float32), axis=0)
                # Only a true socket red is flattened. An orange median is
                # the sun leaking in; those pixels stay the raster.
                if float(flat[1]) > 120.0 or float(flat[0]) < float(flat[1]) + 45.0:
                    continue
                graph_rgb[sock > 0] = np.clip(flat, 0, 255).astype(np.uint8)
        grad = gradient_mag(graph_rgb)
        pal = _plate_poster_palette(graph_rgb, paper_w, paper_rgb, grad)
        assign, pal, _mem = _plate_graph_assign(graph_rgb, paper_w, pal, paper_rgb)
        # Overlay strokes are NOT filled assign inks — ridge cubics.
        assign = assign.copy()
        assign[paper_w] = -1
        punch = None
        # Punch veil along emitted walls (eyes, jaw, frame) and inside the
        # basins those walls enclose. Not every keep tick.
        wall_pls = list(grey_pls or []) + list(olive_pls or [])
        if wall_pls or frame_circle is not None:
            punch = _emitted_wall_mask(
                work.shape[:2],
                wall_pls,
                [],
                frame_circle,
                float(ridge_half),
            )
        else:
            punch = np.zeros(work.shape[:2], np.uint8)
        if interiors is not None:
            punch = np.maximum(punch, interiors)
        # Tooth walls leave the landscape graph. Windows (holes) stay,
        # so the sunset shows through the grid.
        if mouth_bone is not None and int(mouth_bone.sum()) >= 800:
            punch = np.maximum(punch, mouth_bone)
        if int(punch.sum()) >= 20:
            # Walls leave the landscape graph. Openings stay in the graph
            # (sunset through the windows) and only lose the veil.
            walls = punch.copy()
            if interiors is not None:
                walls[interiors > 0] = 0
            assign[walls > 0] = -1
            unmix["veil"][punch > 0] = 0
        else:
            punch = None
        veil_rec_mask = unmix["veil"]
        if os.environ.get("VECTORIZE_DEBUG_UNMIX"):
            dbg = os.path.join("out", "handoff", "paid-tracer", "debug", "unmix-live")
            os.makedirs(dbg, exist_ok=True)
            Image.fromarray(graph_rgb).save(os.path.join(dbg, "land.png"))
            Image.fromarray((ridge_keep * 255).astype(np.uint8) if ridge_keep is not None else np.zeros(work.shape[:2], np.uint8)).save(
                os.path.join(dbg, "bone.png")
            )
            Image.fromarray((grey_keep * 255).astype(np.uint8) if grey_keep is not None else np.zeros(work.shape[:2], np.uint8)).save(
                os.path.join(dbg, "grey.png")
            )
            Image.fromarray((veil_rec_mask * 255).astype(np.uint8)).save(
                os.path.join(dbg, "veil.png")
            )
            Image.fromarray((unmix["hull"] * 255).astype(np.uint8)).save(
                os.path.join(dbg, "hull.png")
            )
    else:
        grad = gradient_mag(work)
        pal = _plate_poster_palette(work, paper_w, paper_rgb, grad)
        assign, pal, _mem = _plate_graph_assign(work, paper_w, pal, paper_rgb)
    if not pal:
        pal = [np.array([20.0, 20.0, 20.0], np.float32)]
        assign = np.full(work.shape[:2], 0, np.int32)
        assign[paper_w] = -1
    if glyph is not None and np.any(glyph):
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

    def _stroke_layer(pls, rgb_c, suffix, n_px, extra=None):
        cubics = _iso_stroke_cubics(
            pls,
            sx,
            sy,
            float(ridge_half),
            to_hex(rgb_c),
        ) if pls else []
        if extra:
            cubics = list(extra) + list(cubics)
        if not cubics:
            return None
        return {
            "hex": to_hex(rgb_c),
            "name": layer_name(rgb_c) + suffix,
            "paths": [c["d"] for c in cubics],
            "lum": lum(rgb_c),
            "n": int(n_px),
            "stroke_only": True,
            "sw": float(cubics[0]["sw"]),
        }

    keyline_stroke_layer = None
    bone_stroke_layer = None
    mouth_bone = None
    if unmix is not None:
        frame_extra = []
        if frame_circle is not None:
            frame_extra.append(
                _circle_primitive_stroke(
                    frame_circle[0],
                    frame_circle[1],
                    frame_circle[2],
                    sx,
                    sy,
                    float(ridge_half),
                    to_hex(grey_rgb),
                )
            )
        keyline_stroke_layer = _stroke_layer(
            grey_pls,
            grey_rgb,
            " · keyline-stroke",
            int(grey_keep.sum()) if grey_keep is not None else 0,
            extra=frame_extra,
        )
        # Tooth grid only. Eyes and the jaw are strokes, not this fill.
        mouth_bone = _vertical_tooth_mask(
            grey_keep, olive_keep, work, unmix.get("circle"), unmix.get("hull")
        )
        bone_src = [] if (mouth_bone is not None and int(mouth_bone.sum()) >= 800) else olive_pls
        bone_stroke_layer = _stroke_layer(
            bone_src,
            olive_rgb,
            " · bone-stroke",
            int(olive_keep.sum()) if olive_keep is not None else 0,
        )

    def emit(
        mask,
        rgb_c,
        *,
        alphamax=1.0,
        opttol=0.2,
        turdsize=2,
        smooth=0.12,
        suffix="",
        scale=1,
        opacity=None,
        destair=False,
    ):
        m = (mask > 0).astype(np.uint8)
        if int(m.sum()) < 12:
            return None
        hh, ww = m.shape
        corners = (m[0, 0], m[0, ww - 1], m[hh - 1, 0], m[hh - 1, ww - 1])
        if sum(int(c) for c in corners) >= 3 and int(m.mean()) > 0.45:
            w_s, h_s = fmt(width_in, 4), fmt(height_in, 4)
            paths = [f"M 0 0 L {w_s} 0 L {w_s} {h_s} L 0 {h_s} Z"]
        else:
            paths = potrace_paths(
                m,
                sx,
                sy,
                scale=scale,
                alphamax=alphamax,
                opttol=opttol,
                turdsize=turdsize,
                smooth=smooth,
            )
            if destair and paths:
                paths = _destair_glyph_paths(paths)
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

    tooth_fill_layer = None
    nasal_fill_layer = None
    if (
        unmix is not None
        and mouth_bone is not None
        and int(mouth_bone.sum()) >= 800
    ):
        # Low-chroma grey. A median of every mask pixel picks up sunset
        # that leaked into the keep and paints the skull brown.
        bone_col = grey_rgb
        tooth_fill_layer = emit(
            mouth_bone,
            bone_col,
            alphamax=1.0,
            opttol=0.2,
            turdsize=8,
            smooth=0.16,
            suffix=" · tooth-wall",
        )

    layers = []
    gap_strokes = []
    vg_aux = {
        "vector_graph": "empty",
        "coverage": 0,
        "cracks": 0,
        "loops": 0,
        "primitives": 0,
        "shared_seams": 0,
        "too_sharded": False,
    }
    try:
        glayers, gaux = vector_graph_layers(
            assign.astype(np.int32),
            pal,
            sx,
            sy,
            rgb=graph_rgb,
            logo=False,
            try_primitives=True,
            min_area_px=12,
            gap_fill=True,
            destair_leg=6.0,
        )
        gpaths = sum(len(L["paths"]) for L in glayers)
        cov = float(gaux.get("coverage") or 0.0)
        if glayers and gpaths >= 3 and cov >= 0.50 and not gaux.get("too_sharded"):
            layers = glayers
            gap_strokes = gaux.get("gap_strokes") or []
            vg_aux = gaux
            if unmix is None:
                hex_to_i = {to_hex(c).lower(): j for j, c in enumerate(pal)}
                for L in layers:
                    j = hex_to_i.get((L.get("hex") or "").lower())
                    if j is not None and _is_veil_ink(pal[j], assign, j):
                        L["opacity"] = 0.40
                        nm = L.get("name") or ""
                        if "overlay" not in nm:
                            L["name"] = nm + " · overlay"
            elif unmix is not None:
                veil_layer = None
                if veil_rec_mask is not None and int(veil_rec_mask.sum()) >= 200:
                    veil_layer = emit(
                        veil_rec_mask,
                        unmix["grey"],
                        alphamax=0.90,
                        opttol=0.16,
                        turdsize=2,
                        smooth=0.35,
                        opacity=float(unmix.get("veil_alpha") or 0.28),
                        suffix=" · overlay",
                    )
                if veil_layer:
                    layers.append(veil_layer)
                if nasal_fill_layer:
                    layers.append(nasal_fill_layer)
                if tooth_fill_layer:
                    layers.append(tooth_fill_layer)
                if keyline_stroke_layer:
                    layers.append(keyline_stroke_layer)
                if bone_stroke_layer:
                    layers.append(bone_stroke_layer)
                vg_aux = dict(vg_aux)
                vg_aux["overlay_unmix"] = True
                vg_aux["bone_px"] = int(ridge_keep.sum()) if ridge_keep is not None else 0
                vg_aux["bone_strokes"] = len(bone_stroke_layer["paths"]) if bone_stroke_layer else 0
                vg_aux["keyline_strokes"] = (
                    len(keyline_stroke_layer["paths"]) if keyline_stroke_layer else 0
                )
                vg_aux["emblem_cycles"] = (
                    (len(grey_pls) if grey_pls else 0)
                    + (len(olive_pls) if olive_pls else 0)
                    + (1 if frame_circle is not None else 0)
                )
    except Exception as e:
        sys.stderr.write(f"vector_graph plate failed: {e}\n")

    if not layers:
        order = list(range(len(pal)))
        order.sort(key=lambda i: (-lum(pal[i]), -int((assign == i).sum())))
        for i in order:
            mask = assign == i
            is_dark = lum(pal[i]) < 50
            rec = emit(
                mask,
                pal[i],
                alphamax=0.70 if is_dark else 0.95,
                opttol=0.10 if is_dark else 0.16,
                turdsize=1 if is_dark else 2,
                smooth=0.08 if is_dark else 0.12,
            )
            if rec:
                if unmix is None and _is_veil_ink(pal[i], assign, i):
                    rec["opacity"] = 0.40
                    rec["name"] = rec.get("name", "") + " · overlay"
                layers.append(rec)
        vg_aux["vector_graph"] = "plate-potrace-fallback"
        if unmix is not None:
            veil_layer = None
            if veil_rec_mask is not None and int(veil_rec_mask.sum()) >= 200:
                veil_layer = emit(
                    veil_rec_mask,
                    unmix["grey"],
                    alphamax=0.90,
                    opttol=0.16,
                    turdsize=2,
                    smooth=0.35,
                    opacity=float(unmix.get("veil_alpha") or 0.28),
                    suffix=" · overlay",
                )
            if veil_layer:
                layers.append(veil_layer)
            if nasal_fill_layer:
                layers.append(nasal_fill_layer)
            if tooth_fill_layer:
                layers.append(tooth_fill_layer)
            if keyline_stroke_layer:
                layers.append(keyline_stroke_layer)
            if bone_stroke_layer:
                layers.append(bone_stroke_layer)
            vg_aux["overlay_unmix"] = True
            vg_aux["bone_px"] = int(ridge_keep.sum()) if ridge_keep is not None else 0
            vg_aux["bone_strokes"] = (
                len(bone_stroke_layer["paths"]) if bone_stroke_layer else 0
            )
            vg_aux["keyline_strokes"] = (
                len(keyline_stroke_layer["paths"]) if keyline_stroke_layer else 0
            )
            vg_aux["emblem_cycles"] = (
                (len(grey_pls) if grey_pls else 0)
                + (len(olive_pls) if olive_pls else 0)
                + (1 if frame_circle is not None else 0)
            )

    if halo is not None and halo_rgb is not None and np.any(halo):
        rec = emit(
            halo.astype(np.uint8),
            halo_rgb,
            alphamax=0.88,
            opttol=0.12,
            turdsize=1,
            smooth=0.0,
            scale=2,
            suffix=" · letter-halo",
        )
        if rec:
            layers.append(rec)
    if glyph is not None and np.any(glyph):
        dark = min(pal, key=lambda c: lum(c)) if pal else np.array([10.0, 10.0, 10.0])
        rec = emit(
            glyph.astype(np.uint8),
            dark,
            alphamax=0.0,
            opttol=0.2,
            turdsize=1,
            smooth=0.0,
            scale=2,
            suffix=" · lettering",
            destair=True,
        )
        if rec:
            layers.append(rec)

    n_paths = sum(len(L["paths"]) for L in layers)
    used_graph = str(vg_aux.get("vector_graph") or "") == "shared-seams"
    if layers and n_paths >= 3:
        svg = svg_from_layers_with_gaps(
            layers,
            width_in,
            height_in,
            to_hex(paper_rgb),
            gap_strokes=gap_strokes,
        )
        n_paths = len(re.findall(r"<path\b", svg, re.I)) or n_paths
        has_veil = any(
            (L.get("opacity") is not None and float(L.get("opacity")) < 0.95)
            for L in layers
        )
        meta = {
            "engine": "decoclub-vector",
            "backend": "vector-graph" if used_graph else "potrace",
            "mode": kind,
            "paths": n_paths,
            "colors": len(layers),
            "palette": [to_hex(c) for c in pal],
            "pixel": [w0, h0],
            "work": [w, h],
            "up": 1,
            "inches": [width_in, height_in],
            "ms": int((time.time() - t0) * 1000),
            "paper": to_hex(paper_rgb),
            "overlay": bool(has_veil),
            "rec_err": round(float(rec_err), 2),
            "soft_flat": False,
            "plate_poster": True,
            "keyline": False,
            "shared_edge": bool(used_graph),
            "cracks": vg_aux.get("cracks"),
            "loops": vg_aux.get("loops"),
            "coverage": vg_aux.get("coverage"),
            "vector_graph": vg_aux.get("vector_graph"),
            "primitives": vg_aux.get("primitives"),
            "shared_seams": vg_aux.get("shared_seams"),
            "overlay_unmix": bool(unmix is not None),
            "bone_px": vg_aux.get("bone_px"),
            "bone_strokes": vg_aux.get("bone_strokes"),
            "keyline_strokes": vg_aux.get("keyline_strokes"),
            "emblem_cycles": vg_aux.get("emblem_cycles"),
            "polish": {},
        }
        return svg, meta

    svg = svg_from_layers(layers, width_in, height_in, to_hex(paper_rgb))
    n_paths = len(re.findall(r"<path\b", svg, re.I))
    meta = {
        "engine": "decoclub-vector",
        "backend": "potrace",
        "mode": kind,
        "paths": n_paths,
        "colors": len(layers),
        "palette": [to_hex(c) for c in pal],
        "pixel": [w0, h0],
        "work": [w, h],
        "up": 1,
        "inches": [width_in, height_in],
        "ms": int((time.time() - t0) * 1000),
        "paper": to_hex(paper_rgb),
        "overlay": False,
        "rec_err": round(float(rec_err), 2),
        "soft_flat": False,
        "plate_poster": True,
        "keyline": False,
        "vector_graph": "plate-empty",
        "polish": {},
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
        plate = is_plate_poster(rgb_full, paper_f, paper_rgb_f)
        busy_type = is_busy_type_poster(rgb_full, paper_f, paper_rgb_f, alpha=alpha_full)
        # Soft-flat AI/illustration: snap to 8–16 inks then potrace. Must run
        # before raw vtracer (which invents thousands of near-colors on gradients).
        if soft_flat and not busy_type:
            rgb_full = denoise_jpeg(rgb_full, paper_f, grad_f, force=noisy_f)
            grad_f = gradient_mag(rgb_full)
            rgb_full, paper_f = punch_sheet_dirt(rgb_full, paper_f, paper_rgb_f, grad=grad_f)
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
        # Busy type posters (cream glyphs + orange plates, e.g. Dirt Devils):
        # t8c plate-lock — per-ink evenodd, never logo shared-seam punch.
        if busy_type:
            return vectorize_busy_type_poster(
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
        # Canva / screenprint plates: already-flat cells, many AA colors.
        # Do not bilateral-blur gothic serifs / foam before the snap.
        if plate:
            return vectorize_plate_poster(
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
        rgb_full = denoise_jpeg(rgb_full, paper_f, grad_f, force=noisy_f)
        grad_f = gradient_mag(rgb_full)
        rgb_full, paper_f = punch_sheet_dirt(rgb_full, paper_f, paper_rgb_f, grad=grad_f)
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
        # Tiny clean mascots: nearest keeps hard edges. Cubic on 225px palette
        # logos invents wobble destaircase cannot kill (not H/V stairs).
        if noisy:
            interp = cv2.INTER_LINEAR
        elif kind == "logo" and max(h, w) <= 260:
            interp = cv2.INTER_NEAREST
        else:
            interp = cv2.INTER_CUBIC
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
        if kind == "logo" and lum(paper_rgb) >= 200:
            assign = protect_interior_light_holes(assign, palette, up, paper_rgb)
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

    # Logo plates: potrace each assign-mask ink (evenodd). Shared-crack
    # Schneider is what dropped thin inlets on clean marks. The keyline
    # mask (whisker ridges included) is traced as-is. Busy-type plate-lock
    # returns before this branch. Crumb-noisy JPEG logos are solidified
    # first; keylined mascots and clean marks are not.
    solid_meta = None
    sliver_meta = None
    if kind == "logo" and glyph is None and ov_mask is None and not keylined:
        assign, solid_meta = solidify_jpeg_logo_assign(assign, palette)
    if kind == "logo" and glyph is None and ov_mask is None:
        # Original raster, not the denoised working image: denoise pulls JPEG
        # fringe toward the palette and would hide an invented sliver.
        src_support = rgb0
        if src_support.shape[:2] != assign.shape[:2]:
            src_support = cv2.resize(
                rgb0,
                (assign.shape[1], assign.shape[0]),
                interpolation=cv2.INTER_CUBIC,
            )
        assign, sliver_meta = drop_invented_jpeg_slivers(
            assign, palette, src_support, paper_rgb
        )
    if kind == "logo" and glyph is None and ov_mask is None:
        try:
            glayers, gaux = logo_potrace_mask_layers(
                assign.astype(np.int32),
                palette,
                sx,
                sy,
                min_area_px=max(4 if keylined else 10, int(0.00003 * assign.size)),
            )
            gpaths = sum(len(L.get("paths") or []) for L in glayers)
            if glayers and gpaths >= 1:
                paper_hex = to_hex(paper_rgb)
                # Whisker ridges are already in the keyline assign mask.
                # A second Schneider stroke on top doubles them.
                svg = svg_from_layers_with_gaps(
                    glayers,
                    width_in,
                    height_in,
                    paper_hex,
                    gap_strokes=[],
                    overlay_strokes=[],
                )
                n_paths = len(re.findall(r"<path\b", svg, re.I)) or gpaths
                meta = {
                    "engine": "decoclub-vector",
                    "backend": "potrace",
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
                    "overlay": False,
                    "rec_err": round(rec_err, 2),
                    "keyline": bool(keylined),
                    "shared_edge": False,
                    "vector_graph": "logo-potrace-mask",
                    "iso_fallback": gaux.get("iso_fallback", 0),
                    "jpeg_solidify": solid_meta or {"applied": False},
                    "jpeg_invented_sliver": sliver_meta or {"applied": False},
                    "polish": {},
                }
                return svg, meta
        except Exception as e:
            sys.stderr.write(f"logo potrace mask failed: {e}\n")
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
