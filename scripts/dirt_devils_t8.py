#!/usr/bin/env python3
"""Dirt Devils t8 — protected orange plate + cream glyphs, then cubic plates.

Start from the composited source, not a prior SVG.

Alpha below the ink floor is real paper (counters, distress knockouts, the
sheet). It is never hole-filled to black. Opaque cream is a separate ink.

The ANNUAL brush is one orange semantic mask, locked before any keyline
cleanup so rust/brown argmax and a later cream knockout cannot eat it.
The cream DIRT/ANNUAL/BACK/SCHOOL glyphs are locked the same way.

Edges come from a faired soft-membership field. Each ink is a potrace cubic
with its own evenodd holes. No shared-seam compound, so a wrapping cycle
cannot punch the orange plate out. No vtracer. No plate-poster palette.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Production tree: lib/vai-trace. Grind tree: ../vectorizer-build/lib.
_lib_candidates = [
    os.path.join(ROOT, "lib", "vai-trace"),
    os.path.join(ROOT, "lib"),
    os.path.join(os.path.dirname(ROOT), "vectorizer-build", "lib"),
]
for _lib in _lib_candidates:
    if os.path.isfile(os.path.join(_lib, "trace.py")):
        sys.path.insert(0, _lib)
        break
import trace as T  # noqa: E402

_src_candidates = [
    os.path.join(os.path.dirname(ROOT), "vectorizer-build", "tests", "client-dropins", "harder", "dirt-devils-bash-harder.png"),
    os.path.join(ROOT, "tests", "client-dropins", "harder", "dirt-devils-bash-harder.png"),
    os.path.join(ROOT, "test", "fixtures", "vectorize", "dirt-devils-annual-crop.png"),
]
SRC = next((p for p in _src_candidates if os.path.isfile(p)), _src_candidates[0])
OUT = os.path.join(ROOT, "out", "handoff", "dirt-devils")

# Measured medians on this raster (composited on white), family-merged.
PALETTE = [
    (42, 44, 48),       # 0 keyline black
    (92, 92, 94),       # 1 cool gray
    (140, 138, 136),    # 2 mid gray
    (179, 178, 176),    # 3 baseball gray
    (251, 244, 233),    # 4 cream type
    (224, 102, 55),     # 5 orange type / plate / splatter
    (118, 68, 48),      # 6 mascot brown
    (176, 118, 68),     # 7 tan fur
    (214, 150, 72),     # 8 amber bat
    (248, 204, 122),    # 9 gold muzzle
]
BLACK, CREAM, ORANGE = 0, 4, 5
# Beaver body shares the type-orange hue. Do not flat-lock it.
MASCOT = (0.50, 0.28, 0.94, 0.80)  # x0,y0,x1,y1
# ANNUAL brush sits under the arc, above BACK.
PLATE = (0.20, 0.090, 0.78, 0.155)

CROPS = {
    "dirt-ring": (0.12, 0.025, 0.88, 0.125),
    "annual": (0.343, 0.055, 0.896, 0.177),  # reject-crop framing
    "back": (0.05, 0.16, 0.62, 0.46),
    "school-bash": (0.02, 0.36, 0.62, 0.70),
    "banners-date": (0.02, 0.64, 0.98, 0.995),
    "face": (0.50, 0.28, 0.94, 0.78),
}


def _hex(rgb):
    return T.to_hex(np.array(rgb, dtype=np.float32))


def load_comp(work: int):
    rgb0, alpha0 = T.load_rgba(SRC)
    h0, w0 = rgb0.shape[:2]
    s = float(work) / float(max(h0, w0))
    w = max(32, int(round(w0 * s)))
    h = max(32, int(round(h0 * s)))
    rgb = cv2.resize(rgb0, (w, h), interpolation=cv2.INTER_AREA)
    al = cv2.resize(alpha0, (w, h), interpolation=cv2.INTER_AREA)
    a = al.astype(np.float32) / 255.0
    comp = rgb.astype(np.float32) * a[:, :, None] + 255.0 * (1.0 - a[:, :, None])
    comp = np.clip(np.round(comp), 0, 255).astype(np.uint8)
    return comp, al, (h0, w0)


def _channels(comp):
    hsv = cv2.cvtColor(comp, cv2.COLOR_RGB2HSV)
    R = comp[:, :, 0].astype(np.int16)
    G = comp[:, :, 1].astype(np.int16)
    B = comp[:, :, 2].astype(np.int16)
    L = 0.299 * R + 0.587 * G + 0.114 * B
    H = hsv[:, :, 0].astype(np.int16)
    S = hsv[:, :, 1].astype(np.int16)
    V = hsv[:, :, 2].astype(np.int16)
    return R, G, B, L, H, S, V


def border_components(mask):
    m = (mask > 0).astype(np.uint8)
    n, lab = cv2.connectedComponents(m, connectivity=4)
    if n <= 1:
        return np.zeros(mask.shape, bool)
    border_ids = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    keep = np.zeros(n, dtype=bool)
    keep[border_ids] = True
    keep[0] = False
    return keep[lab]


def frac_box(shape, box):
    h, w = shape[:2]
    x0, y0, x1, y1 = box
    return (
        max(0, int(round(y0 * h))),
        max(0, int(round(y1 * h))),
        max(0, int(round(x0 * w))),
        max(0, int(round(x1 * w))),
    )


def in_box(shape, box):
    y0, y1, x0, x1 = frac_box(shape, box)
    m = np.zeros(shape[:2], bool)
    m[y0:y1, x0:x1] = True
    return m


def build_assign(comp, alpha, tech: int):
    """Soft membership, then protected orange-plate and cream locks."""
    R, G, B, L, H, S, V = _channels(comp)
    # Transparent pixels are paper even when the stored RGB is white or junk.
    trans = alpha < 28
    near = (L > 236) & (S < 26) & ~trans
    # Border-connected sheet only. Enclosed opaque near-white is cream ink.
    sheet = border_components(trans | near)
    paper = sheet | trans

    pal = [np.array(c, dtype=np.float32) for c in PALETTE]
    paper_rgb = np.array([255, 255, 255], np.float32)
    mem, _ = T.soft_membership(comp, pal, paper_rgb, tau=11.0)
    mem = T.regularize_membership(mem, sigma=0.50)
    k = len(pal)
    assign = mem.argmax(axis=2).astype(np.int32)
    assign[assign >= k] = -1
    assign[paper] = -1

    cream = (~paper) & (L >= 188) & (S <= 46) & (B >= 160) & (np.abs(R - G) <= 36)
    # True keyline, not the dark-orange AA ramp (that ramp stays orange).
    black = (~paper) & (L <= 78) & (R <= 108) & (S <= 80)
    orange = (
        (~paper)
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
    mascot = in_box(comp.shape, MASCOT)
    # Cap mark and bright splatter inside the beaver box stay orange.
    bright = orange & (S >= 110) & (R >= 210) & (V >= 140)
    orange_lock = (orange & ~mascot) | bright

    assign[orange_lock] = ORANGE

    # Pale brush feather of the ANNUAL plate: only pixels already touching orange,
    # never cream letters and never the beaver.
    plate = in_box(comp.shape, PLATE)
    ker5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    touch_o = cv2.dilate((assign == ORANGE).astype(np.uint8), ker5) > 0
    feather = (
        plate
        & touch_o
        & ~paper
        & ~cream
        & ~black
        & ~mascot
        & (H <= 30)
        & (S >= 22)
        & (R > G)
        & (R > B + 6)
        & (L > 80)
        & (L < 230)
    )
    assign[feather] = ORANGE
    orange_lock = orange_lock | feather

    if tech >= 2:
        # Bridge 1px cracks in the plate only. Restore every protected hole.
        ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        om = (assign == ORANGE).astype(np.uint8)
        closed = cv2.morphologyEx(om, cv2.MORPH_CLOSE, ker)
        grow = (closed > 0) & (assign != ORANGE) & ~paper & ~cream & ~black & ~mascot
        assign[grow] = ORANGE
        orange_lock = orange_lock | ((assign == ORANGE) & ~mascot)

    assign[cream] = CREAM
    assign[black] = BLACK
    assign[paper] = -1

    # Fur salt inside the beaver only. Locks are painted back after.
    assign = _smooth_mascot(assign, mascot, k)
    assign[cream] = CREAM
    assign[black] = BLACK
    assign[orange_lock] = ORANGE
    assign[paper] = -1

    # Thin gray rims where a keyline meets the sheet are AA, not a gray plate.
    # Fold the dark ones into the keyline and drop the light ones to paper.
    # Large gray bodies (baseball) stay; only a 2px rim that touches both.
    assign = _strip_keyline_halo(assign, comp)

    # Paper cracks between a cream glyph and the orange plate become cream,
    # so the glyph sits on the plate instead of a white halo. Distress holes
    # inside orange are not adjacent to cream, so they stay open.
    ker3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    paper_now = assign < 0
    seam = (
        paper_now
        & (cv2.dilate((assign == CREAM).astype(np.uint8), ker3) > 0)
        & (cv2.dilate((assign == ORANGE).astype(np.uint8), ker3) > 0)
    )
    assign[seam] = CREAM

    protect = {
        "cream": cream,
        "black": black,
        "orange": (assign == ORANGE),
        "paper": assign < 0,
    }
    return assign, pal, mem, protect


def _smooth_mascot(assign, mascot, k):
    a = assign.copy()
    yy, xx = np.where(mascot)
    if yy.size == 0:
        return a
    y0, y1 = int(yy.min()), int(yy.max()) + 1
    x0, x1 = int(xx.min()), int(xx.max()) + 1
    sub = a[y0:y1, x0:x1]
    m = mascot[y0:y1, x0:x1]
    locked = m & ((sub == CREAM) | (sub == BLACK) | (sub < 0) | (sub == ORANGE))
    # Orange inside the beaver is fur-ramp, not the plate lock, except bright
    # pixels already stored as ORANGE by the cap-mark rule. Leave those.
    for _ in range(2):
        best_c = np.zeros(sub.shape, np.float32)
        best_l = sub.copy()
        for lab in range(k):
            cnt = cv2.boxFilter(
                (sub == lab).astype(np.float32),
                -1,
                (3, 3),
                normalize=False,
                borderType=cv2.BORDER_REPLICATE,
            )
            take = (cnt >= 6) & (cnt > best_c)
            best_c[take] = cnt[take]
            best_l[take] = lab
        flip = (best_c >= 6) & m & ~locked
        sub[flip] = best_l[flip]
    # Drop fur specks smaller than a whisker. Keep orange splatters and cream teeth.
    for ink in (1, 2, 3, 6, 7, 8, 9):
        mm = ((sub == ink) & m).astype(np.uint8)
        if int(mm.sum()) < 1:
            continue
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mm, connectivity=8)
        kill = np.zeros(n, dtype=bool)
        for i in range(1, n):
            if int(stats[i, cv2.CC_STAT_AREA]) < 18:
                kill[i] = True
        drop = kill[labels]
        if not drop.any():
            continue
        dil = cv2.dilate(drop.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
        neigh = sub[dil & ~drop]
        neigh = neigh[neigh != ink]
        if neigh.size == 0:
            sub[drop] = -1
            continue
        # Per-component majority is expensive; one global majority of the ring is enough
        # for salt. Recompute per component only for the dropped set via nearest ink.
        sub[drop] = -1
    # Fill those -1 specks from neighbors, twice.
    ker = np.ones((3, 3), np.uint8)
    for _ in range(4):
        hole = (sub < 0) & m
        if not hole.any():
            break
        claimed = np.zeros(sub.shape, bool)
        labels = [int(x) for x in np.unique(sub) if int(x) >= 0]
        labels.sort(key=lambda i: -int((sub == i).sum()))
        for lab in labels:
            dil = cv2.dilate((sub == lab).astype(np.uint8), ker) > 0
            take = hole & dil & ~claimed
            sub[take] = lab
            claimed |= take
    a[y0:y1, x0:x1] = sub
    return a


def _strip_keyline_halo(assign, comp):
    R, G, B, L, H, S, V = _channels(comp)
    gray = (assign == 1) | (assign == 2) | (assign == 3)
    if int(gray.sum()) < 20:
        return assign
    paper = assign < 0
    black = assign == BLACK
    k = np.ones((3, 3), np.uint8)
    near_b = cv2.dilate(black.astype(np.uint8), k) > 0
    near_p = cv2.dilate(paper.astype(np.uint8), k) > 0
    dist = cv2.distanceTransform(gray.astype(np.uint8), cv2.DIST_L2, 3)
    halo = gray & (dist <= 2.1) & near_b & near_p
    a = assign.copy()
    a[halo & (L <= 155)] = BLACK
    a[halo & (L > 155)] = -1
    return a


def snap_rgb(assign, pal):
    out = np.full(assign.shape + (3,), 255, np.uint8)
    for i, c in enumerate(pal):
        out[assign == i] = np.clip(np.round(c), 0, 255).astype(np.uint8)
    return out


def _cc_stats(mask):
    m = (mask > 0).astype(np.uint8)
    area = int(m.sum())
    if area < 1:
        return {"area": 0, "cc": 0, "largest": 0, "largest_w": 0, "span_w": 0}
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n <= 1:
        return {"area": 0, "cc": 0, "largest": 0, "largest_w": 0, "span_w": 0}
    areas = stats[1:, cv2.CC_STAT_AREA]
    i = 1 + int(np.argmax(areas))
    xs = np.where(m.any(axis=0))[0]
    span = int(xs[-1] - xs[0] + 1) if xs.size else 0
    return {
        "area": area,
        "cc": int(n - 1),
        "largest": int(stats[i, cv2.CC_STAT_AREA]),
        "largest_w": int(stats[i, cv2.CC_STAT_WIDTH]),
        "span_w": span,
    }


def plate_report(assign, comp, alpha):
    """Orange-plate coverage and cream-ring continuity against the source rules."""
    R, G, B, L, H, S, V = _channels(comp)
    paper = alpha < 28
    y0, y1, x0, x1 = frac_box(comp.shape, PLATE)
    sl = (slice(y0, y1), slice(x0, x1))
    src_orange = (
        (~paper)
        & (H <= 26)
        & (S >= 50)
        & (V >= 70)
        & (R >= 140)
        & (G <= 150)
        & (B <= 115)
    )
    src_cream = (~paper) & (L >= 188) & (S <= 46) & (B >= 160)
    src_black = (~paper) & (L <= 78) & (R <= 108) & (S <= 80)
    got_o = assign == ORANGE
    got_c = assign == CREAM
    got_k = assign == BLACK

    def recall(src, got, region):
        s = src[region]
        if int(s.sum()) < 1:
            return None
        return float((s & got[region]).sum()) / float(s.sum())

    plate_src = _cc_stats(src_orange[sl])
    plate_got = _cc_stats(got_o[sl])
    # Cream ring: light pixels touching both orange and black in the DIRT arc.
    dy0, dy1, dx0, dx1 = frac_box(comp.shape, CROPS["dirt-ring"])
    dsl = (slice(dy0, dy1), slice(dx0, dx1))
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))

    def ring_count(orange_m, black_m, cream_m):
        near_o = cv2.dilate(orange_m.astype(np.uint8), ker) > 0
        near_k = cv2.dilate(black_m.astype(np.uint8), ker) > 0
        return int((cream_m & near_o & near_k).sum())

    src_ring = ring_count(src_orange[dsl], src_black[dsl], src_cream[dsl])
    got_ring = ring_count(got_o[dsl], got_k[dsl], got_c[dsl])
    # How much of the orange|black contact has a cream pixel in between.
    def contact_cream_frac(orange_m, black_m, cream_m):
        edge = orange_m & (cv2.dilate(black_m.astype(np.uint8), ker) > 0)
        if int(edge.sum()) < 1:
            return None
        near_c = cv2.dilate(cream_m.astype(np.uint8), ker) > 0
        return float((edge & near_c).sum()) / float(edge.sum())

    rep = {
        "plate_box": list(PLATE),
        "src_plate": plate_src,
        "assign_plate": plate_got,
        "plate_area_ratio": (plate_got["area"] / plate_src["area"]) if plate_src["area"] else None,
        "plate_width_ratio": (plate_got["largest_w"] / plate_src["largest_w"]) if plate_src["largest_w"] else None,
        "plate_span_ratio": (plate_got["span_w"] / plate_src["span_w"]) if plate_src["span_w"] else None,
        "orange_recall_plate": recall(src_orange, got_o, sl),
        "orange_recall_all": recall(src_orange, got_o, np.s_[:, :]),
        "cream_recall_plate": recall(src_cream, got_c, sl),
        "cream_recall_all": recall(src_cream, got_c, np.s_[:, :]),
        "black_recall_plate": recall(src_black, got_k, sl),
        "cream_on_orange_plate": recall(src_orange, got_c, sl),
        "paper_on_orange_plate": float(((assign[sl] < 0) & src_orange[sl]).sum()) / max(1, float(src_orange[sl].sum())),
        "dirt_cream_ring_src_px": src_ring,
        "dirt_cream_ring_assign_px": got_ring,
        "dirt_ring_ratio": (got_ring / src_ring) if src_ring else None,
        "dirt_contact_cream_src": contact_cream_frac(src_orange[dsl], src_black[dsl], src_cream[dsl]),
        "dirt_contact_cream_assign": contact_cream_frac(got_o[dsl], got_k[dsl], got_c[dsl]),
        "ink_px": {str(i): int((assign == i).sum()) for i in range(len(PALETTE))},
    }
    return rep


def potrace_mask(mask, sx, sy, *, alphamax, opttol, turdsize, sigma=0.55, timeout=240):
    m = (mask > 0).astype(np.uint8)
    if int(m.sum()) < 8:
        return []
    # AA fairing: 0.5 iso of a small Gaussian. sigma 0 keeps the locked mask.
    if sigma and sigma > 0.05:
        mf = cv2.GaussianBlur(m.astype(np.float32), (0, 0), float(sigma))
        fair = (mf >= 0.50).astype(np.uint8)
    else:
        fair = m.copy()
    # Keep source holes that the blur sealed (distress, counters).
    sealed = (fair > 0) & (m == 0)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(sealed.astype(np.uint8), connectivity=4)
    if n > 1:
        kill = np.zeros(n, dtype=bool)
        for i in range(1, n):
            if int(stats[i, cv2.CC_STAT_AREA]) >= 6:
                kill[i] = True
        fair[kill[labels]] = 0
    h, w = fair.shape
    tmp = tempfile.mkdtemp(prefix="dd-ptr-")
    try:
        pbm = os.path.join(tmp, "m.pbm")
        svg_p = os.path.join(tmp, "m.svg")
        T._write_pbm(pbm, fair)
        r = subprocess.run(
            ["potrace", "-s", "-a", str(alphamax), "-O", str(opttol), "-t", str(turdsize), "-u", "10", "-o", svg_p, pbm],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if r.returncode != 0 or not os.path.isfile(svg_p):
            sys.stderr.write("potrace failed " + (r.stderr or "")[:300] + "\n")
            return []
        svg = open(svg_p, encoding="utf-8").read()
    finally:
        for fn in os.listdir(tmp):
            try:
                os.remove(os.path.join(tmp, fn))
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass
    import re

    tm = re.search(r"translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)", svg)
    sm = re.search(r"scale\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)", svg)
    tx = float(tm.group(1)) if tm else 0.0
    ty = float(tm.group(2)) if tm else float(h)
    sx_pt = float(sm.group(1)) if sm else 0.1
    sy_pt = float(sm.group(2)) if sm else -0.1
    ds = []
    for mpath in re.finditer(r'<path\s[^>]*d="([^"]+)"', svg):
        d = T._transform_potrace_d(mpath.group(1), sx_pt, sy_pt, tx, ty, 1, sx, sy)
        if d and "M" in d:
            ds.append(d)
    return ds


def trace_plates(assign, pal, inches, h0, w0):
    """One evenodd cubic compound per ink. Paint light-to-dark, black last.

    Orange is under cream so ANNUAL glyphs sit on the plate. Black is last so
    the keyline stays a separate shape and is not a stroke that eats cream.
    """
    h, w = assign.shape
    width_in = float(inches)
    height_in = float(inches) * (h0 / float(w0))
    sx = width_in / float(w)
    sy = height_in / float(h)
    # Back to front. Black keyline last. Cream above orange.
    order = [3, 2, 1, 6, 7, 8, 9, ORANGE, CREAM, BLACK]
    layers = []
    t0 = time.time()
    for ink in order:
        raw = assign == ink
        area = int(raw.sum())
        if area < 12:
            continue
        # Hug the locked mask. opttol/alphamax stay tight so distress notches
        # and brush bristles are not faired into a smooth cousin.
        # Orange and cream grow 1px under the next ink so a fairing gap cannot
        # open a white hairline. Black is not grown (keyline weight already matches).
        raw_u8 = raw.astype(np.uint8)
        if ink in (ORANGE, CREAM):
            raw_u8 = cv2.dilate(raw_u8, np.ones((3, 3), np.uint8))
        if ink == BLACK:
            alpha_max, opt, turd, sigma = 0.45, 0.02, 0, 0.0
        elif ink == CREAM:
            alpha_max, opt, turd, sigma = 0.55, 0.02, 0, 0.0
        elif ink == ORANGE:
            alpha_max, opt, turd, sigma = 0.55, 0.02, 0, 0.0
        else:
            alpha_max, opt, turd, sigma = 1.0, 0.12, 4, 0.45
        paths = potrace_mask(
            raw_u8, sx, sy,
            alphamax=alpha_max, opttol=opt, turdsize=turd, sigma=sigma,
        )
        if not paths:
            continue
        layers.append(
            {
                "hex": T.to_hex(pal[ink]),
                "name": T.layer_name(pal[ink]),
                "paths": paths,
                "lum": T.lum(pal[ink]),
                "n": area,
            }
        )
        print(f"  ink {ink} {_hex(pal[ink])} paths {len(paths)} px {area}", flush=True)
    svg = T.svg_from_layers(layers, width_in, height_in, "#ffffff")
    meta = {
        "ms": int((time.time() - t0) * 1000),
        "vector_graph": "soft-membership-aa-fair-potrace-plates",
        "paths": svg.count("<path"),
        "colors": len(layers),
        "svg_bytes": len(svg),
        "work": [w, h],
    }
    return svg, meta


def render_svg(svg_path, png_path, w, h):
    r = subprocess.run(
        ["rsvg-convert", "-w", str(w), "-h", str(h), "-o", png_path, svg_path],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if r.returncode != 0:
        raise RuntimeError((r.stderr or "rsvg failed")[:400])


def _save_pair(src, rend, box, path):
    h, w = src.shape[:2]
    y0, y1, x0, x1 = frac_box(src.shape, box)
    a = src[y0:y1, x0:x1]
    b = rend[y0:y1, x0:x1]
    if b.shape[:2] != a.shape[:2]:
        b = cv2.resize(b, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_AREA)
    gap = np.full((a.shape[0], 8, 3), 255, np.uint8)
    pair = np.concatenate([a, gap, b], axis=1)
    Image.fromarray(pair).save(path)
    diff = np.abs(a.astype(np.int16) - b.astype(np.int16)).mean(axis=2)
    mae = float(diff.mean())
    return mae


def qa_render(comp, rend, tag):
    os.makedirs(OUT, exist_ok=True)
    report = {}
    for name, box in CROPS.items():
        path = os.path.join(OUT, f"{tag}-qa-{name}.png")
        mae = _save_pair(comp, rend, box, path)
        report[name] = {"mae": round(mae, 2), "path": path}
        print(f"  crop {name} mae {mae:.2f}", flush=True)
    # Full side by side at 900px
    s = 900 / max(comp.shape[0], 1)
    sw, sh = int(comp.shape[1] * s), int(comp.shape[0] * s)
    a = cv2.resize(comp, (sw, sh), interpolation=cv2.INTER_AREA)
    b = cv2.resize(rend, (sw, sh), interpolation=cv2.INTER_AREA)
    gap = np.full((sh, 8, 3), 255, np.uint8)
    Image.fromarray(np.concatenate([a, gap, b], axis=1)).save(os.path.join(OUT, f"{tag}-qa-full.png"))
    return report


def render_metrics(comp, alpha, rend):
    """Pixel checks on the rendered SVG against composited source."""
    if rend.shape[:2] != comp.shape[:2]:
        rend = cv2.resize(rend, (comp.shape[1], comp.shape[0]), interpolation=cv2.INTER_AREA)
    R, G, B, L, H, S, V = _channels(comp)
    rR, rG, rB, rL, rH, rS, rV = _channels(rend)
    paper = alpha < 28
    src_o = (~paper) & (H <= 26) & (S >= 50) & (V >= 70) & (R >= 140) & (G <= 150) & (B <= 115)
    # Render orange: near the orange ink, not cream and not black.
    got_o = (rR >= 150) & (rG <= 160) & (rB <= 120) & ((rR - rG) >= 30) & (rL < 200) & (rS >= 40)
    got_c = (rL >= 185) & (rS <= 50) & (rB >= 155)
    got_k = (rL <= 90) & (rR <= 120)
    y0, y1, x0, x1 = frac_box(comp.shape, PLATE)
    sl = (slice(y0, y1), slice(x0, x1))
    src_a = int(src_o[sl].sum())
    hit = int((src_o[sl] & got_o[sl]).sum())
    # 2px tolerance: fairing may move the edge by a pixel.
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    near_got = cv2.dilate(got_o.astype(np.uint8), ker) > 0
    hit_d = int((src_o[sl] & near_got[sl]).sum())
    rend_a = int(got_o[sl].sum())
    src_c = (~paper) & (L >= 188) & (S <= 46) & (B >= 160)
    cream_hit = int((src_c[sl] & got_c[sl]).sum())
    # Cream ring continuity on the render, DIRT arc.
    dy0, dy1, dx0, dx1 = frac_box(comp.shape, CROPS["dirt-ring"])
    dsl = (slice(dy0, dy1), slice(dx0, dx1))
    ker5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))

    def ring(om, km, cm):
        return int((cm & (cv2.dilate(om.astype(np.uint8), ker5) > 0) & (cv2.dilate(km.astype(np.uint8), ker5) > 0)).sum())

    return {
        "plate_src_orange_px": src_a,
        "plate_render_orange_px": rend_a,
        "plate_area_ratio": (rend_a / src_a) if src_a else None,
        "plate_orange_recall": (hit / src_a) if src_a else None,
        "plate_orange_recall_2px": (hit_d / src_a) if src_a else None,
        "plate_cream_on_src_orange": int((src_o[sl] & got_c[sl]).sum()) / max(1, src_a),
        "plate_black_on_src_orange": int((src_o[sl] & got_k[sl]).sum()) / max(1, src_a),
        "plate_cream_recall": cream_hit / max(1, int(src_c[sl].sum())),
        "dirt_ring_src": ring(
            src_o[dsl],
            ((~paper) & (L <= 78) & (R <= 108))[dsl],
            src_c[dsl],
        ),
        "dirt_ring_render": ring(got_o[dsl], got_k[dsl], got_c[dsl]),
    }


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "snap"
    work = 1800
    tag = "t8"
    tech = 1
    inches = 10.0
    args = sys.argv[2:]
    i = 0
    while i < len(args):
        if args[i] == "--work":
            work = int(args[i + 1]); i += 2
        elif args[i] == "--tag":
            tag = args[i + 1]; i += 2
        elif args[i] == "--tech":
            tech = int(args[i + 1]); i += 2
        elif args[i] == "--inches":
            inches = float(args[i + 1]); i += 2
        else:
            raise SystemExit("unknown arg " + args[i])
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    print(f"load work={work} tech={tech}", flush=True)
    comp, alpha, (h0, w0) = load_comp(work)
    assign, pal, mem, protect = build_assign(comp, alpha, tech)
    rep = plate_report(assign, comp, alpha)
    rep["prep_ms"] = int((time.time() - t0) * 1000)
    rep["tech"] = tech
    rep["work"] = work
    print(json.dumps({k: rep[k] for k in (
        "plate_area_ratio", "plate_width_ratio", "plate_span_ratio",
        "orange_recall_plate", "cream_recall_plate", "cream_on_orange_plate",
        "paper_on_orange_plate", "dirt_cream_ring_src_px", "dirt_cream_ring_assign_px",
        "dirt_contact_cream_src", "dirt_contact_cream_assign", "prep_ms",
    )}, indent=2), flush=True)
    snapped = snap_rgb(assign, pal)
    snap_path = os.path.join(OUT, f"{tag}-snap.png")
    cv2.imwrite(snap_path, cv2.cvtColor(snapped, cv2.COLOR_RGB2BGR))
    # Assignment crops for a fast visual check before tracing.
    for name in ("annual", "dirt-ring", "back", "school-bash", "face", "banners-date"):
        _save_pair(comp, snapped, CROPS[name], os.path.join(OUT, f"{tag}-snap-{name}.png"))
    with open(os.path.join(OUT, f"{tag}-report.json"), "w") as f:
        json.dump(rep, f, indent=2)
    if mode == "snap":
        print("snap", snap_path, flush=True)
        return 0
    print("trace", flush=True)
    svg, tmeta = trace_plates(assign, pal, inches, h0, w0)
    svg_path = os.path.join(OUT, f"{tag}.svg")
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(svg)
    rep["trace"] = tmeta
    print("render", tmeta, flush=True)
    png_path = os.path.join(OUT, f"{tag}-render.png")
    render_svg(svg_path, png_path, assign.shape[1], assign.shape[0])
    rend = np.array(Image.open(png_path).convert("RGB"))
    q = qa_render(comp, rend, tag)
    rm = render_metrics(comp, alpha, rend)
    rep["render_metrics"] = rm
    rep["crops"] = q
    rep["svg"] = svg_path
    print(json.dumps(rm, indent=2), flush=True)
    with open(os.path.join(OUT, f"{tag}-report.json"), "w") as f:
        json.dump(rep, f, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
