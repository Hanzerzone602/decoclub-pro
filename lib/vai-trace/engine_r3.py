#!/usr/bin/env python3
# Modified for vtracer-bakeoff, Oct 2026
"""Colour vectoriser. Flat art is quantised and traced with potrace; busy art uses VTracer p2_fine.

Modified for vtracer-bakeoff, Oct 2026.
"""
import argparse, os, re, subprocess, sys, tempfile, time
import numpy as np, cv2
from PIL import Image

try:
    import vtracer
except ImportError:
    sys.path.insert(0, "/workspace/vtracer-bakeoff/venv/lib/python3.13/site-packages")
    import vtracer

def to_lab_u8(rgb):
    # Float Lab (L 0..100), same space as to_lab(). Uint8 Lab is a different scale.
    arr = np.clip(np.asarray(rgb, np.float32), 0, 255).reshape(1, -1, 3) / 255.0
    return cv2.cvtColor(arr, cv2.COLOR_RGB2Lab).reshape(-1, 3).astype(np.float32)

def to_lab(rgb):
    return cv2.cvtColor(rgb.astype(np.float32) / 255.0, cv2.COLOR_RGB2Lab)

def lab_to_rgb(lab):
    arr = np.asarray(lab, np.float32).reshape(1, -1, 3)
    rgb = cv2.cvtColor(arr, cv2.COLOR_Lab2RGB).reshape(-1, 3)
    return np.clip(np.round(rgb * 255.0), 0, 255)

def hex_of(rgb):
    c = np.clip(np.round(rgb), 0, 255).astype(int)
    return "#%02x%02x%02x" % (int(c[0]), int(c[1]), int(c[2]))

def chroma(lab):
    return np.hypot(lab[..., 1], lab[..., 2])

def hue_diff(a, b):
    d = abs(np.degrees(np.arctan2(a[2], a[1])) - np.degrees(np.arctan2(b[2], b[1]))) % 360.0
    return min(d, 360.0 - d)

def histogram_palette(rgb):
    """Dominant 4-bit bins, merged perceptually. Keeps the saturated core of each ink."""
    im = rgb.astype(np.uint8)
    H, W = im.shape[:2]
    bits, shift, step = 4, 4, 16
    q = im.astype(np.int32) >> shift
    key = (q[:, :, 0] << (2 * bits)) | (q[:, :, 1] << bits) | q[:, :, 2]
    flatk = key.ravel()
    keys, counts = np.unique(flatk, return_counts=True)
    tot = float(counts.sum())
    order = np.argsort(-counts)
    sel, wts = [], []
    minfrac = 0.00035
    for i in order:
        frac = counts[i] / tot
        if frac < minfrac:
            break
        if len(sel) >= 28:
            break
        sel.append(int(keys[i]))
        wts.append(float(counts[i]))
    pr, pl, ch = [], [], []
    pix = im.reshape(-1, 3)
    for k in sel:
        m = flatk == k
        med = np.median(pix[m], 0).astype(np.float32)
        pr.append(med)
    pr = np.vstack(pr)
    pl = to_lab_u8(pr)
    ch = chroma(pl)
    pw = np.array(wts, np.float64)

    def absorb(i, j):
        """Fold j into i. Prefer the more saturated colour when it is a real share of the ink."""
        nonlocal pl, pr, pw, ch
        wi, wj = pw[i], pw[j]
        if ch[j] > ch[i] + 6 and wj >= 0.08 * (wi + wj) and ch[j] > 20:
            i, j = j, i
        elif wj > wi:
            i, j = j, i
        pw[i] = pw[i] + pw[j]
        pl = np.delete(pl, j, 0)
        pr = np.delete(pr, j, 0)
        pw = np.delete(pw, j, 0)
        ch = np.delete(ch, j, 0)

    while len(pl) > 1:
        best = None
        totw = pw.sum()
        for i in range(len(pl)):
            for j in range(i + 1, len(pl)):
                de = float(np.linalg.norm(pl[i] - pl[j]))
                c1, c2 = float(ch[i]), float(ch[j])
                wi, wj = pw[i] / totw, pw[j] / totw
                hd = hue_diff(pl[i], pl[j]) if c1 > 18 and c2 > 18 else 0.0
                ok = (
                    de < 8
                    or (c1 < 12 and c2 < 12 and de < 24)
                    or (c1 < 18 and c2 < 18 and de < 16)
                    or (min(wi, wj) < 0.006 and de < 32)
                    or (c1 > 18 and c2 > 18 and hd < 16 and de < 14)
                    # AA rims of a small ink (2px type): same hue, keep the saturated core
                    or (c1 > 25 and c2 > 25 and hd < 14 and de < 26 and min(wi, wj) < 0.02)
                    # Small neutral fringes (JPEG/PNG halos), not a real grey ink.
                    or (c1 < 8 and c2 < 8 and min(wi, wj) < 0.02 and de < 48)
                )
                if ok and (best is None or de < best[0]):
                    best = (de, i, j)
        if best is None:
            break
        absorb(best[1], best[2])

    # Rescue a vivid accent the 4-bit bins split into dust (red eyes).
    step_s = max(1, int(max(H, W) / 360))
    small = im[::step_s, ::step_s]
    slab = to_lab(small)
    d = ((slab.reshape(-1, 3)[:, None, :] - pl[None]) ** 2).sum(-1)
    dE = np.sqrt(d.min(1))
    sc = chroma(slab.reshape(-1, 3))
    far = (dE > 18) & (sc > 40)
    if far.mean() > 0.0012 and len(pl) < 12:
        cols = small.reshape(-1, 3)[far].astype(np.float32)
        labs = slab.reshape(-1, 3)[far]
        if len(cols) > 2500:
            take = np.random.default_rng(0).choice(len(cols), 2500, replace=False)
            cols, labs = cols[take], labs[take]
        med = np.median(cols, 0)
        medL = to_lab_u8(med.reshape(1, 3))[0]
        # Far enough that this is a different ink (red eye), not the saturated core of one we already merged.
        if float(np.linalg.norm(pl - medL, axis=1).min()) > 30 and far.mean() > 0.0015:
            pl = np.vstack([pl, medL])
            pr = np.vstack([pr, med])
            pw = np.append(pw, far.mean() * H * W)

    return pl, pr

def add_distant_clusters(rgb, pl, pr):
    """After the histogram peaks, keep a residual mode above 0.02% area.

    A mode qualifies when it sits more than ΔE 12 from every chosen ink and is
    either a different hue or a darker object separated from the nearest ink
    (the bakery brown, not a JPEG shade rung of an ink we already have).
    """
    H, W = rgb.shape[:2]
    tot = float(H * W)
    if tot < 1 or len(pl) == 0:
        return pl, pr
    lab = to_lab(rgb)
    step = 1 if tot < 800000 else 2
    asc = step * step
    slab = lab[::step, ::step].reshape(-1, 3)
    srgb = rgb[::step, ::step].reshape(-1, 3).astype(np.float32)
    dmin = np.linalg.norm(slab[:, None, :] - pl[None], axis=2).min(1)
    fl = slab[dmin > 12.0]
    fc = srgb[dmin > 12.0]
    if len(fl) < 8:
        return pl, pr
    min_pix = 0.0002 * tot
    n_base = len(pl)
    for _ in range(24):
        if len(fl) < 8:
            break
        q = np.floor(fl / 8.0).astype(np.int32)
        q = q - q.min(0)
        key = q[:, 0].astype(np.int64) * 400000 + q[:, 1].astype(np.int64) * 2000 + q[:, 2].astype(np.int64)
        _keys, inv, counts = np.unique(key, return_inverse=True, return_counts=True)
        i = int(counts.argmax())
        seed = np.median(fl[inv == i], 0)
        take = np.linalg.norm(fl - seed, axis=1) <= 12.0
        if int(take.sum()) < 4:
            fl, fc = fl[inv != i], fc[inv != i]
            continue
        med = np.median(fl[take], 0)
        take = np.linalg.norm(fl - med, axis=1) <= 12.0
        med = np.median(fl[take], 0).astype(np.float32)
        rgbm = np.median(fc[take], 0).astype(np.float32)
        n_pix = int(take.sum()) * asc
        fl, fc = fl[~take], fc[~take]
        if n_pix < min_pix:
            continue
        de = np.linalg.norm(pl - med, axis=1)
        j = int(de.argmin())
        dej = float(de[j])
        if dej <= 12.0:
            continue
        ch = float(chroma(med))
        hd_min = 180.0
        if ch > 15:
            for p in pl:
                if float(chroma(p)) > 15:
                    hd_min = min(hd_min, hue_diff(med, p))
        dmode = np.linalg.norm(lab - med, axis=2)
        m = dmode <= 12.0
        big = 0
        if m.any():
            ncc, _labels, stats, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
            if ncc > 1:
                big = int(stats[1:, cv2.CC_STAT_AREA].max())
        mass = float((dmode <= 10).mean())
        mid = (pl[j] + med) / 2.0
        bridge = float((np.linalg.norm(lab - mid, axis=2) <= 8).mean())
        ratio = bridge / max(mass, 1e-8)
        # Hue gap has to clear near-miss mixes (purple AA on a red band) as well as shade rungs.
        hue_ok = hd_min >= 55.0 and ch >= 20.0 and big / tot >= 0.00018
        # Darker object in the same hue family (bakery brown vs the orange it was merged into).
        # A high bridge ratio means the cluster is just the next rung of a gradient.
        # Nearest ink has to be a real colour. A tint of the paper is not a new ink.
        obj_ok = (
            dej >= 22.0 and ch >= 18.0 and float(chroma(pl[j])) >= 15.0
            and big / tot >= 0.00018 and ratio < 1.7
            and float(med[0]) + 12.0 < float(pl[j, 0])
        )
        if not (hue_ok or obj_ok):
            continue
        # Collapse two remnants of the same accent (wristband highlights).
        if len(pl):
            near = np.linalg.norm(pl - med, axis=1)
            if float(near.min()) < 16.0 and int(near.argmin()) >= 0:
                # only skip when the near ink is one we just added (ΔE 12..16)
                jj = int(near.argmin())
                if float(near[jj]) <= 12.0:
                    continue
        pl = np.vstack([pl, med])
        pr = np.vstack([pr, rgbm])
    # Merge an accent we just added into a neighbour within ΔE 14.
    # Original histogram peaks stay: merging those ate the bakery letter ink.
    changed = True
    while changed and len(pl) > n_base:
        changed = False
        for i in range(len(pl)):
            for j in range(i + 1, len(pl)):
                if i < n_base and j < n_base:
                    continue
                if float(np.linalg.norm(pl[i] - pl[j])) >= 14.0:
                    continue
                if i < n_base:
                    drop = j
                elif j < n_base:
                    drop = i
                else:
                    drop = j if float(chroma(pl[i])) >= float(chroma(pl[j])) else i
                pl = np.delete(pl, drop, 0)
                pr = np.delete(pr, drop, 0)
                changed = True
                break
            if changed:
                break
    return pl, pr

def assign(lab, pl):
    H = lab.shape[0]
    idx = np.empty(lab.shape[:2], np.int32)
    for y in range(0, H, 220):
        sl = lab[y:y + 220]
        d = ((sl[:, :, None, :] - pl[None, None]) ** 2).sum(-1)
        idx[y:y + 220] = d.argmin(-1)
    return idx

def drop_tiny(idx, pl, pr, min_frac=0.0005):
    H, W = idx.shape
    n = len(pl)
    counts = np.bincount(idx.ravel(), minlength=n).astype(np.float64)
    keep = np.ones(n, bool)
    area = float(H * W)
    for k in range(n):
        if counts[k] <= 0:
            keep[k] = False
            continue
        if counts[k] / area >= min_frac:
            continue
        mask = idx == k
        if pl[k, 0] < 45:
            dt = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 3)
            if mask.any() and float(np.median(dt[mask])) <= 2.5:
                continue
        keep[k] = False
    if keep.all():
        return idx, pl, pr
    kept = np.where(keep)[0]
    if len(kept) == 0:
        return idx, pl, pr
    sub = pl[kept]
    mapping = np.arange(n)
    for k in range(n):
        if not keep[k]:
            mapping[k] = kept[int(np.linalg.norm(sub - pl[k], axis=1).argmin())]
    idx = mapping[idx]
    used = []
    remap = np.full(n, -1, np.int32)
    for k in range(n):
        if (idx == k).any():
            remap[k] = len(used)
            used.append(k)
    return remap[idx], pl[used], pr[used]

def fold_fringe(idx, pl, pr):
    """Reassign thin light-neutral halos. Keeps real grey fills and thin dark type."""
    n = len(pl)
    kill = []
    for k in range(n):
        if float(chroma(pl[k])) >= 8 or float(pl[k, 0]) < 45:
            continue
        m = idx == k
        frac = float(m.mean()) if m.size else 0.0
        if frac <= 0 or frac >= 0.03:
            continue
        dt = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 3)
        if float(np.median(dt[m])) <= 1.2:
            kill.append(k)
    if not kill:
        return idx, pl, pr
    keep = np.array([k for k in range(n) if k not in set(kill)], np.int32)
    if len(keep) == 0:
        return idx, pl, pr
    sub = pl[keep]
    mapping = np.arange(n)
    for k in kill:
        mapping[k] = keep[int(np.linalg.norm(sub - pl[k], axis=1).argmin())]
    idx = mapping[idx]
    used, remap = [], np.full(n, -1, np.int32)
    for k in range(n):
        if (idx == k).any():
            remap[k] = len(used)
            used.append(k)
    return remap[idx], pl[used], pr[used]

def _blend_dist(p, a, b):
    ab = b - a
    denom = float(np.dot(ab, ab)) + 1e-6
    t = float(np.clip(np.dot(p - a, ab) / denom, 0.0, 1.0))
    return float(np.linalg.norm(p - (a + t * ab)))

def fold_edge_fringe(idx, pl):
    """Fold 1–2px blend rims into the neighbouring ink.

    A real stroke (1px type, a keyline, a whisker) is kept: it is not a blend
    of the two colours it touches, or it sits on a single field. Only whole
    components that are themselves 1–2px wide are candidates, so the rim of a
    thick fill is left alone.
    """
    H, W = idx.shape
    out = idx.copy()
    kern = np.ones((3, 3), np.uint8)
    n = len(pl)
    for k in range(n):
        m = out == k
        if int(m.sum()) < 2:
            continue
        dt = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 3)
        ncc, labels, stats, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
        for s in range(1, ncc):
            area = int(stats[s, cv2.CC_STAT_AREA])
            if area < 2:
                continue
            x, y, w, h = (int(stats[s, cv2.CC_STAT_LEFT]), int(stats[s, cv2.CC_STAT_TOP]),
                          int(stats[s, cv2.CC_STAT_WIDTH]), int(stats[s, cv2.CC_STAT_HEIGHT]))
            y0, y1 = max(0, y - 1), min(H, y + h + 1)
            x0, x1 = max(0, x - 1), min(W, x + w + 1)
            comp = labels[y0:y1, x0:x1] == s
            on = dt[y0:y1, x0:x1][comp]
            if on.size == 0 or float(np.median(on)) > 1.15:
                continue
            # Longer than ~6px and a steady width, but still fold it when the
            # colour is only the blend of its two neighbours (AA / smear).
            ring = cv2.dilate(comp.astype(np.uint8), kern).astype(bool) & ~comp
            if not ring.any():
                continue
            neigh = out[y0:y1, x0:x1][ring]
            vals, counts = np.unique(neigh, return_counts=True)
            keep = vals != k
            vals, counts = vals[keep], counts[keep]
            if len(vals) < 2:
                continue
            order = np.argsort(-counts)
            share1 = float(counts[order[1]]) / float(counts.sum())
            if share1 < 0.22:
                continue
            a = int(vals[order[0]])
            b = int(vals[order[1]])
            if _blend_dist(pl[k], pl[a], pl[b]) > 14.0:
                continue
            # Prefer the darker neighbour so a pink rim joins the letter, not the paper.
            if float(pl[a, 0]) <= float(pl[b, 0]):
                darker, d_dark, d_light = a, float(np.linalg.norm(pl[k] - pl[a])), float(np.linalg.norm(pl[k] - pl[b]))
            else:
                darker, d_dark, d_light = b, float(np.linalg.norm(pl[k] - pl[b])), float(np.linalg.norm(pl[k] - pl[a]))
            dest = darker if (d_dark < 22.0 or d_dark <= d_light + 6.0) else (a if d_light > d_dark else b)
            if dest == k:
                continue
            out[y0:y1, x0:x1][comp] = dest
    return _fold_speck_inks(out, pl)

def _fold_speck_inks(idx, pl):
    """Fold a thin ink that is only a blend and has no component bigger than a speckle.

    The bee's light-blue AA fails the two-neighbour test on most specks, so the
    per-component pass leaves them. A real accent (red wristband, blue nose)
    has a larger component and stays. Grey keylines are thick and stay.
    """
    n = len(pl)
    if n < 3:
        return idx
    out = idx
    for k in range(n):
        m = out == k
        area = int(m.sum())
        if area < 2:
            continue
        dt = cv2.distanceTransform(m.astype(np.uint8), cv2.DIST_L2, 3)
        if float(np.median(dt[m])) > 1.15:
            continue
        ncc, _labels, stats, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
        if ncc <= 1:
            continue
        if int(stats[1:, cv2.CC_STAT_AREA].max()) > 70:
            continue
        best = None
        for i in range(n):
            if i == k:
                continue
            for j in range(i + 1, n):
                if j == k:
                    continue
                bd = _blend_dist(pl[k], pl[i], pl[j])
                if best is None or bd < best[0]:
                    best = (bd, i, j)
        if best is None or best[0] > 14.0:
            continue
        _, i, j = best
        if float(pl[i, 0]) <= float(pl[j, 0]):
            darker, d_dark, d_light = i, float(np.linalg.norm(pl[k] - pl[i])), float(np.linalg.norm(pl[k] - pl[j]))
        else:
            darker, d_dark, d_light = j, float(np.linalg.norm(pl[k] - pl[j])), float(np.linalg.norm(pl[k] - pl[i]))
        dest = darker if (d_dark < 22.0 or d_dark <= d_light + 6.0) else (i if d_light > d_dark else j)
        if dest == k:
            continue
        if out is idx:
            out = idx.copy()
        out[m] = dest
    return out

def _near_frac(lab, idx, pl, k):
    m = idx == k
    if int(m.sum()) < 8:
        return 0.0
    d = np.linalg.norm(lab[m] - pl[k], axis=1)
    return float((d <= 8.0).mean())

def fold_uncentred(idx, lab, pl):
    """Drop an ink that is not a dense core, and fold a same-hue shade rung.

    Pixels within ΔE 8 of the cluster peak are the core. A rung whose pixels
    miss that ball (the maroon patches on the tiger) is not its own ink.
    A darker twin within 5° of hue (the shaded half of a red bandana) joins
    the lighter peak. A tight darker object (bakery brown) has its own core
    and stays.
    """
    n = len(pl)
    if n < 2:
        return idx
    near = np.array([_near_frac(lab, idx, pl, k) for k in range(n)], np.float32)
    present = np.array([np.any(idx == k) and near[k] > 0 for k in range(n)])
    out = idx.copy()
    drop = [k for k in range(n) if present[k] and near[k] < 0.10]
    keep = [i for i in range(n) if present[i] and near[i] >= 0.10]
    if drop and keep:
        sub = pl[keep]
        keep_a = np.array(keep, np.int32)
        for k in drop:
            m = out == k
            if not m.any():
                present[k] = False
                continue
            d = np.linalg.norm(lab[m][:, None, :] - sub[None], axis=2)
            out[m] = keep_a[d.argmin(1)]
            present[k] = False
    for k in range(n):
        if not present[k] or near[k] >= 0.16 or float(chroma(pl[k])) < 18:
            continue
        best = None
        for i in range(n):
            if i == k or not present[i] or near[i] < 0.12 or float(chroma(pl[i])) < 18:
                continue
            if float(pl[i, 0]) < float(pl[k, 0]) + 8.0:
                continue
            if hue_diff(pl[k], pl[i]) > 5.0:
                continue
            de = float(np.linalg.norm(pl[k] - pl[i]))
            if best is None or de < best[0]:
                best = (de, i)
        if best is None:
            continue
        out[out == k] = best[1]
        present[k] = False
    return out

def recolor_core(idx, lab, pl, pr):
    """Ink colour is the median of pixels within ΔE 8 of the cluster peak.

    The median of every assigned pixel is pulled by shade and anti-alias,
    which turned a red bandana brown and an orange field maroon.
    """
    pl = np.array(pl, np.float32, copy=True)
    pr = np.array(pr, np.float32, copy=True)
    for k in range(len(pr)):
        m = idx == k
        if int(m.sum()) < 8:
            continue
        labs = lab[m]
        # A weak grey has no saturated peak; the ΔE 8 ball is just the dark fringe.
        # Chromatic inks (the red bandana, the orange) use that ball.
        if float(chroma(pl[k])) < 22.0:
            med = np.median(labs, 0).astype(np.float32)
        else:
            near = np.linalg.norm(labs - pl[k], axis=1) <= 8.0
            if int(near.sum()) < 8:
                continue
            med = np.median(labs[near], 0).astype(np.float32)
        pl[k] = med
        pr[k] = lab_to_rgb(med)[0]
    return pl, pr

def needs_index_clean(rgb):
    """Small images whose flats chatter around a 3x3 median. Hard synthetics do not.

    The cut is size and residual noise, not the file name. About 220–300px
    JPEG logos qualify; a 160px star or a 220px hard-edged wordmark does not.
    """
    H, W = rgb.shape[:2]
    mside = max(H, W)
    if mside < 140 or mside > 300:
        return False
    med = cv2.medianBlur(rgb, 3)
    d = np.abs(rgb.astype(np.int16) - med.astype(np.int16)).sum(axis=2)
    return float(((d >= 8) & (d <= 70)).mean()) >= 0.06

def clean_index(idx):
    """3x3 mode on the ink index. A pixel with two neighbours of its own colour stays.

    That keeps a 1–2px stroke (it has neighbours along the stroke, including
    a diagonal whisker or an eye slit) and removes isolated JPEG specks.
    """
    H, W = idx.shape
    if H < 3 or W < 3:
        return idx
    n = int(idx.max()) + 1
    if n > 32:
        return idx
    pad = np.pad(idx, 1, mode="edge")
    counts = np.zeros((H, W, n), np.uint8)
    yy = np.arange(H)[:, None]
    xx = np.arange(W)[None, :]
    for dy in range(3):
        for dx in range(3):
            v = pad[dy:dy + H, dx:dx + W]
            counts[yy, xx, v] += 1
    mode = counts.argmax(-1).astype(np.int32)
    mode_n = counts.max(-1)
    c = idx
    friends = (
        (pad[1:H + 1, 0:W] == c).astype(np.uint8)
        + (pad[1:H + 1, 2:W + 2] == c)
        + (pad[0:H, 1:W + 1] == c)
        + (pad[2:H + 2, 1:W + 1] == c)
    )
    diag = (
        (pad[0:H, 0:W] == c).astype(np.uint8)
        + (pad[0:H, 2:W + 2] == c)
        + (pad[2:H + 2, 0:W] == c)
        + (pad[2:H + 2, 2:W + 2] == c)
    )
    protect = (friends >= 2) | (diag >= 2)
    out = idx.copy()
    flip = (~protect) & (mode != c) & (mode_n >= 5)
    out[flip] = mode[flip]
    return out

def close_seams(idx, bg, radius=2.25):
    """Give enclosed paper cracks of at most 4 px² to the nearest ink.

    Anything larger is a counter (the 0 and 2 in "2021") or a real hole
    (the puma eye). Nibbling the edge of a large white region split that eye.
    """
    ids = [i for i in range(int(idx.max()) + 1) if i != bg and np.any(idx == i)]
    if len(ids) < 2:
        return idx
    paper = (idx == bg).astype(np.uint8)
    ncc, labels, stats, _ = cv2.connectedComponentsWithStats(paper, 8)
    if ncc <= 1:
        return idx
    H, W = idx.shape
    border = set(np.unique(np.concatenate([
        labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]
    ])).tolist())
    small = np.zeros((H, W), bool)
    for s in range(1, ncc):
        if s in border:
            continue
        if int(stats[s, cv2.CC_STAT_AREA]) > 4:
            continue
        small[labels == s] = True
    if not small.any():
        return idx
    best = np.full((H, W), 1e9, np.float32)
    second = np.full((H, W), 1e9, np.float32)
    best_id = np.full((H, W), bg, np.int32)
    for i in ids:
        d = cv2.distanceTransform((idx != i).astype(np.uint8), cv2.DIST_L2, 3)
        better = d < best
        mid = (~better) & (d < second)
        second = np.where(better, best, np.where(mid, d, second))
        best_id = np.where(better, i, best_id)
        best = np.where(better, d, best)
    crack = small & (second <= radius)
    if not crack.any():
        return idx
    out = idx.copy()
    out[crack] = best_id[crack]
    return out

def despeck(idx, pl, max_area=2):
    H, W = idx.shape
    bad = np.zeros((H, W), bool)
    for k in range(len(pl)):
        m = (idx == k).astype(np.uint8)
        cc, lab, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
        if cc <= 1:
            continue
        drop = []
        for s in range(1, cc):
            if st[s, cv2.CC_STAT_AREA] > max_area:
                continue
            if pl[k, 0] < 45 and max(st[s, cv2.CC_STAT_WIDTH], st[s, cv2.CC_STAT_HEIGHT]) >= 4:
                continue
            drop.append(s)
        if drop:
            bad |= np.isin(lab, np.array(drop, np.int32))
    if not bad.any():
        return idx
    _, lab_ = cv2.distanceTransformWithLabels(bad.astype(np.uint8), cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    m = np.zeros(int(lab_.max()) + 1, np.int32)
    m[lab_[~bad]] = idx[~bad]
    return np.where(bad, m[lab_], idx)

def quantize(rgb):
    pl, pr = histogram_palette(rgb)
    lab = to_lab(rgb)
    idx = assign(lab, pl)
    idx, pl, pr = drop_tiny(idx, pl, pr)
    idx, pl, pr = fold_fringe(idx, pl, pr)
    idx = despeck(idx, pl, 2)
    step = max(1, int(max(rgb.shape[:2]) / 280))
    sl = lab[::step, ::step]
    si = idx[::step, ::step]
    dE = np.sqrt(((sl - pl[si]) ** 2).sum(-1))
    stats = dict(k=int(len(pl)), cover10=float((dE < 10).mean()), mean=float(dE.mean()),
                 p90=float(np.percentile(dE, 90)))
    return idx, pl, pr, stats

def quantize_flat(rgb):
    """Flat-route palette. Routing still uses quantize() so busy images stay put."""
    pl, pr = histogram_palette(rgb)
    pl, pr = add_distant_clusters(rgb, pl, pr)
    lab = to_lab(rgb)
    idx = assign(lab, pl)
    idx, pl, pr = drop_tiny(idx, pl, pr, min_frac=0.0002)
    idx, pl, pr = fold_fringe(idx, pl, pr)
    if needs_index_clean(rgb):
        idx = clean_index(idx)
    idx = fold_uncentred(idx, lab, pl)
    pl, pr = recolor_core(idx, lab, pl, pr)
    idx = fold_edge_fringe(idx, pl)
    idx = despeck(idx, pl, 2)
    frame = np.concatenate([idx[0], idx[-1], idx[:, 0], idx[:, -1]])
    bg = int(np.bincount(frame).argmax()) if frame.size else 0
    idx = close_seams(idx, bg, 2.25)
    used = [k for k in range(len(pr)) if np.any(idx == k)]
    if len(used) != len(pr):
        remap = np.full(len(pr), -1, np.int32)
        for i, k in enumerate(used):
            remap[k] = i
        idx = remap[idx]
        pl, pr = pl[used], pr[used]
    return idx, pl, pr

def is_flat(stats):
    k, c, m = stats["k"], stats["cover10"], stats["mean"]
    if k <= 8 and c >= 0.845 and m <= 4.05:
        return True
    # Few inks and a soft photo of a logo (JPEG AA lifts mean ΔE).
    if k <= 4 and c >= 0.76 and m <= 6.6:
        return True
    return False

def potrace(fg, color, alphamax=1.0, scale=1, opttol=0.2):
    if int(fg.sum()) < 2:
        return ""
    mask = fg
    if scale > 1:
        mask = cv2.resize(
            fg.astype(np.uint8), (fg.shape[1] * scale, fg.shape[0] * scale),
            interpolation=cv2.INTER_NEAREST,
        ).astype(bool)
    td = tempfile.mkdtemp(prefix="pot")
    src, dst = os.path.join(td, "m.ppm"), os.path.join(td, "m.svg")
    try:
        Image.fromarray(np.where(mask, 0, 255).astype(np.uint8), "L").save(src, "PPM")
        subprocess.run(
            ["potrace", "-s", "--flat", "-t", "0", "-a", f"{alphamax:.2f}", "-O", f"{opttol:.2f}",
             "-u", "10", "-x", "1", "-C", color, "-o", dst, src],
            check=True, capture_output=True,
        )
        txt = open(dst).read()
        m = re.search(r"(<g\b.*</g>)", txt, re.S)
        if not m:
            return ""
        g = m.group(1)
        if scale > 1:
            H = fg.shape[0]
            s = 0.1 / float(scale)
            g = re.sub(
                r"translate\([^)]*\)\s*scale\([^)]*\)",
                f"translate(0.000000,{H:.6f}) scale({s:.6f},{-s:.6f})",
                g, count=1,
            )
        return g
    finally:
        if os.path.exists(src):
            os.remove(src)
        if os.path.exists(dst):
            os.remove(dst)
        if os.path.isdir(td):
            os.rmdir(td)

def stroke_width(mask):
    """Approximate stroke width. A 1px run is ~1; a filled disc is its radius."""
    m = mask.astype(np.uint8)
    area = int(m.sum())
    if area < 4:
        return 9.0
    cnts, _ = cv2.findContours(m, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
    peri = sum(cv2.arcLength(c, True) for c in cnts) or 1.0
    return float(2.0 * area / peri)

def mask_is_star(mask):
    """Concave many-point polygon (the low-res star). Organic silhouettes are not."""
    m = mask.astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        return False
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    if int(stats[i, cv2.CC_STAT_AREA]) < 80:
        return False
    comp = (labels == i).astype(np.uint8)
    cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return False
    c = max(cnts, key=cv2.contourArea)
    peri = cv2.arcLength(c, True)
    area = cv2.contourArea(c)
    if peri < 20 or area < 20:
        return False
    hull_a = cv2.contourArea(cv2.convexHull(c)) or 1.0
    sol = area / hull_a
    if not (0.35 < sol < 0.68):
        return False
    approx = cv2.approxPolyDP(c, 0.03 * peri, True).reshape(-1, 2).astype(np.float32)
    if not (9 <= len(approx) <= 14):
        return False
    angs = []
    npt = len(approx)
    for k in range(npt):
        p0, p1, p2 = approx[k - 1], approx[k], approx[(k + 1) % npt]
        v1, v2 = p0 - p1, p2 - p1
        n1, n2 = float(np.linalg.norm(v1)), float(np.linalg.norm(v2))
        if n1 < 0.04 * peri or n2 < 0.04 * peri:
            continue
        cos = float(np.clip(np.dot(v1, v2) / (n1 * n2 + 1e-9), -1.0, 1.0))
        angs.append(np.degrees(np.arccos(cos)))
    return bool(angs) and min(angs) < 55.0

def mask_is_round(mask):
    """Disks and rings. A star, a square, or an organic silhouette is not round."""
    m = mask.astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    saw = False
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < 40:
            continue
        saw = True
        comp = (labels == i).astype(np.uint8)
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        if not cnts:
            return False
        c = max(cnts, key=cv2.contourArea)
        peri = cv2.arcLength(c, True)
        ca = cv2.contourArea(c)
        if peri < 8 or ca < 20:
            continue
        circ = 4.0 * np.pi * ca / (peri * peri)
        pts = c.reshape(-1, 2).astype(np.float32)
        cx, cy = pts.mean(0)
        r = np.hypot(pts[:, 0] - cx, pts[:, 1] - cy)
        cv = float(r.std() / (r.mean() + 1e-6))
        if circ < 0.82 or cv > 0.10:
            return False
    return saw

def has_small_counter(mask):
    """An enclosed hole of 5–160 px². Letter counters, not the middle of a ring."""
    inv = (~mask).astype(np.uint8)
    ncc, labels, stats, _ = cv2.connectedComponentsWithStats(inv, 4)
    if ncc <= 1:
        return False
    border = set(int(v) for v in np.unique(np.concatenate([
        labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]
    ])))
    for s in range(1, ncc):
        if s in border:
            continue
        a = int(stats[s, cv2.CC_STAT_AREA])
        if 4 < a <= 160:
            return True
    return False

def trace_style(mask):
    """(alphamax, opttol, upscale). Circles stay smooth. 1px type is a 4x polygon."""
    if not mask.any():
        return 1.0, 0.2, 1
    dt = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 3)
    med = float(np.median(dt[mask]))
    sw = stroke_width(mask)
    if sw <= 1.35 and med <= 1.25:
        return 0.0, 0.2, 4
    # Thin lettering. alphamax 1.0 seals a counter only a few pixels wide.
    if has_small_counter(mask) and sw <= 4.2 and med <= 1.7:
        return 0.0, 0.2, 4
    if mask_is_star(mask):
        # Acute inner corners. alphamax 1.0 turns them into bulges.
        return 0.15, 0.08, 1
    # Circles, rings, and organic silhouettes stay smooth.
    return 1.0, 0.2, 1

def grow_under(mask, cover, radius):
    """Grow `mask` by `radius` px into `cover` only. The silhouette against paper stays."""
    if not mask.any() or not cover.any():
        return mask
    dist = cv2.distanceTransform((~mask).astype(np.uint8), cv2.DIST_L2, 5)
    halo = (dist <= radius) & cover & ~mask
    if not halo.any():
        return mask
    return mask | halo

def trace_flat(idx, pr, inches):
    H, W = idx.shape
    frame = np.concatenate([idx[0], idx[-1], idx[:, 0], idx[:, -1]])
    bg = int(np.bincount(frame).argmax())
    areas = np.bincount(idx.ravel(), minlength=len(pr))
    fg_ids = [c for c in range(len(pr)) if c != bg and areas[c] > 0]
    # Largest underneath, smallest on top, so a detail keeps the pixels it was given.
    fg_ids.sort(key=lambda c: (-int(areas[c]), c))
    masks = {c: (idx == c) for c in fg_ids}
    # Each lower layer grows 2px under every ink painted later. That later ink
    # covers the growth, so the visible colour is unchanged apart from the
    # seam. Style (star corners, letter counters, circles) is taken from the
    # real mask. A star has nothing above it, so its trace is unchanged.
    above = np.zeros((H, W), bool)
    jobs = {}
    for c in reversed(fg_ids):
        m = masks[c]
        alpha, opt, scale = trace_style(m)
        gmask = grow_under(m, above, 2.0) if above.any() else m
        jobs[c] = (gmask, alpha, opt, scale)
        above |= m
    parts = []
    for c in fg_ids:
        gmask, alpha, opt, scale = jobs[c]
        g = potrace(gmask, hex_of(pr[c]), alpha, scale=scale, opttol=opt)
        if g:
            parts.append(g)
    hin = inches * H / float(W)
    sc = inches / float(W)
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{inches:.4f}in" height="{hin:.4f}in" '
        f'viewBox="0 0 {inches:.4f} {hin:.4f}">'
        f'<g transform="scale({sc:.8f})">'
        f'<rect width="{W}" height="{H}" fill="{hex_of(pr[bg])}"/>'
        + "".join(parts) + "</g></svg>\n"
    )
    return svg

def load_rgb(path):
    im = Image.open(path).convert("RGBA")
    a = np.array(im).astype(np.float32)
    rgb = a[:, :, :3] * (a[:, :, 3:4] / 255.0) + 255.0 * (1.0 - a[:, :, 3:4] / 255.0)
    return rgb.astype(np.uint8)

def decide(rgb):
    """Palette fit. Full-resolution label map only when the image is small or actually flat."""
    H, W = rgb.shape[:2]
    if max(H, W) <= 2000:
        idx, pl, pr, stats = quantize(rgb)
        return idx, pr, stats, is_flat(stats)
    step = max(1, int(round(max(H, W) / 640.0)))
    _, _, _, stats = quantize(rgb[::step, ::step])
    if not is_flat(stats):
        return None, None, stats, False
    idx, pl, pr, stats = quantize(rgb)
    return idx, pr, stats, is_flat(stats)

def wrap_vtracer(svg, inches):
    m = re.search(r'<svg([^>]*?)width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)">', svg)
    if not m:
        raise RuntimeError("VTracer SVG has no pixel width/height")
    tw, th = float(m.group(2)), float(m.group(3))
    hin = inches * th / tw
    sc = inches / tw
    svg = (
        svg[:m.start()]
        + f'<svg{m.group(1)}width="{inches:.4f}in" height="{hin:.4f}in" '
        + f'viewBox="0 0 {inches:.4f} {hin:.4f}"><g transform="scale({sc:.8f})">'
        + svg[m.end():]
    )
    end = svg.rstrip()
    if not end.endswith("</svg>"):
        raise RuntimeError("VTracer SVG has no closing tag")
    return end[:-6] + "</g></svg>\n"

def trace_busy(path, inches):
    """p2_fine. Images above 2800px on a side are traced at 2000px so one core stays under 15s."""
    im = Image.open(path)
    W, H = im.size
    cp = 7
    src = path
    tmp = None
    if max(W, H) > 2800:
        scale = 2000.0 / float(max(W, H))
        tw, th = max(1, int(round(W * scale))), max(1, int(round(H * scale)))
        im = im.convert("RGBA").resize((tw, th), Image.Resampling.LANCZOS)
        tmp = tempfile.mktemp(suffix=".png")
        im.save(tmp)
        src = tmp
        cp = 6
    out = tempfile.mktemp(suffix=".svg")
    try:
        vtracer.convert_image_to_svg_py(
            src, out,
            colormode="color",
            hierarchical="stacked",
            mode="spline",
            filter_speckle=4,
            color_precision=cp,
            layer_difference=10,
            corner_threshold=60,
            length_threshold=4.0,
            max_iterations=10,
            splice_threshold=45,
            path_precision=3,
        )
        svg = wrap_vtracer(open(out).read(), inches)
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)
        if os.path.exists(out):
            os.remove(out)
    return svg

def vectorise(path, out_path, inches):
    t0 = time.perf_counter()
    rgb = load_rgb(path)
    idx, pr, stats, flat = decide(rgb)
    if flat:
        idx, _pl, pr = quantize_flat(rgb)
        svg = trace_flat(idx, pr, inches)
        mode = "flat"
        colours = [hex_of(c) for c in pr]
    else:
        svg = trace_busy(path, inches)
        mode = "busy"
        colours = []
    open(out_path, "w").write(svg)
    dt = time.perf_counter() - t0
    print(
        f"{os.path.basename(path)} {mode} {dt:.2f}s k={stats['k']} "
        f"cover10={stats['cover10']:.3f} mean={stats['mean']:.2f} {colours}",
        file=sys.stderr, flush=True,
    )
    return dt, mode

def main():
    ap = argparse.ArgumentParser(description="Colour vectoriser (potrace flats, VTracer busy art)")
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--inches", type=float, default=10.0)
    a = ap.parse_args()
    vectorise(a.input, a.output, a.inches)


# ---- round 11 (from round 9): palette-locked potrace busy route + per-image chooser ----
import types as _types, json as _json, io as _io, contextlib as _ctx
_R3 = sys.modules[__name__]
_SRC = {'pl': '#!/usr/bin/env python3\n"""Optional "Max colours" palette limit for busy (vtracer-r3) SVG output.\n\nRuns after the engine; engine_r3.py and trace.py are untouched. Geometry is kept as\ntraced, only fills are remapped, so stacked VTracer layers stay seam-free.\n\nColour pick is perceptual, not plain frequency: colours are weighed by source-pixel\narea in CIE Lab, then picked greedily by area x distance from the colours already\nchosen, so a small but distinct colour (Carpenters brown) beats one more shade of\nthe dominant colour. A short weighted k-means pass then refines the picks, and each\npick is snapped back to a real source colour so hues are not averaged into mud.\n"""\nimport re\nimport numpy as np\nfrom PIL import Image\n\nFILL_RE = re.compile(r\'fill="(#[0-9A-Fa-f]{6})"\')\n\n\ndef _lab(rgb):\n    c = np.asarray(rgb, np.float64) / 255.0\n    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)\n    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])\n    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])\n    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16.0 / 116.0)\n    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)\n\n\ndef is_brown(L):\n    l, a, b = L[..., 0], L[..., 1], L[..., 2]\n    c = np.hypot(a, b)\n    h = np.degrees(np.arctan2(b, a))\n    return (l > 25) & (l < 68) & (c > 12) & (c < 60) & (h > 25) & (h < 75)\n\n\ndef source_histogram(path, max_px=500):\n    im = Image.open(path).convert("RGBA")\n    im.thumbnail((max_px, max_px))\n    a = np.asarray(im).reshape(-1, 4).astype(np.float64)\n    a = a[a[:, 3] > 127, :3]\n    if not len(a):\n        a = np.array([[0.0, 0.0, 0.0]])\n    q = (a.astype(np.int64) >> 3)  # 5-bit bins\n    key = (q[:, 0] << 10) | (q[:, 1] << 5) | q[:, 2]\n    uk, inv, cnt = np.unique(key, return_inverse=True, return_counts=True)\n    mean = np.zeros((len(uk), 3))\n    np.add.at(mean, inv, a)\n    mean /= cnt[:, None]\n    return mean, cnt.astype(np.float64)\n\n\ndef pick_palette(rgb, w, k):\n    lab = _lab(rgb)\n    k = int(min(k, len(rgb)))\n    # mass = area within dE 6, so noisy bins of one colour count as one colour\n    picks = []\n    mass = np.zeros(len(rgb))\n    for i in range(0, len(lab), 256):\n        d = np.linalg.norm(lab[i:i + 256, None, :] - lab[None, :, :], axis=-1)\n        mass[i:i + 256] = (d < 6.0).astype(np.float64) @ w\n    picks.append(int(np.argmax(mass)))\n    dmin = np.linalg.norm(lab - lab[picks[0]], axis=1)\n    while len(picks) < k:\n        score = np.sqrt(mass) * np.minimum(dmin, 60.0) ** 2\n        score[picks] = -1\n        j = int(np.argmax(score))\n        if score[j] <= 0:\n            break\n        picks.append(j)\n        dmin = np.minimum(dmin, np.linalg.norm(lab - lab[j], axis=1))\n    cent = lab[picks].copy()\n    for _ in range(6):\n        lbl = np.argmin(np.linalg.norm(lab[:, None] - cent[None], axis=-1), 1)\n        for c in range(len(cent)):\n            m = lbl == c\n            if m.any():\n                cent[c] = (lab[m] * w[m, None]).sum(0) / w[m].sum()\n    # snap each centre to the heaviest real source colour near it (keeps hue honest)\n    lbl = np.argmin(np.linalg.norm(lab[:, None] - cent[None], axis=-1), 1)\n    pal = []\n    for c in range(len(cent)):\n        m = np.where(lbl == c)[0]\n        if not len(m):\n            continue\n        d = np.linalg.norm(lab[m] - cent[c], axis=1)\n        j = m[np.argmin(d)]\n        pal.append(rgb[j])\n    return np.array(pal)\n\n\ndef quality(rgb, w, pal):\n    """Cheap preview of what the cap costs, on the source colours (no render)."""\n    lab, pl = _lab(rgb), _lab(pal)\n    d = np.linalg.norm(lab[:, None] - pl[None], axis=-1).min(1)\n    br = is_brown(lab)\n    out = {"colour_error": round(float((d * w).sum() / w.sum()), 2),\n           "detail_kept_pct": round(100.0 * float(w[d < 10].sum() / w.sum()), 1)}\n    if w[br].sum() > 0.002 * w.sum():\n        out["brown_kept_pct"] = round(100.0 * float(w[br & (d < 10)].sum() / w[br].sum()), 1)\n    else:\n        out["brown_kept_pct"] = None\n    return out\n\n\ndef warning_for(q):\n    bad = []\n    if q.get("brown_kept_pct") is not None and q["brown_kept_pct"] < 85:\n        bad.append("brown kept %.0f%%" % q["brown_kept_pct"])\n    if q["detail_kept_pct"] < 90:\n        bad.append("detail kept %.0f%%" % q["detail_kept_pct"])\n    if q["colour_error"] > 6:\n        bad.append("colour error %.1f" % q["colour_error"])\n    if not bad:\n        return None\n    return "This colour limit loses detail on this art (" + ", ".join(bad) + "). Try a higher Max colours or Full detail."\n\n\ndef limit_svg(svg, src_path, max_colours):\n    rgb, w = source_histogram(src_path)\n    pal = pick_palette(rgb, w, max_colours)\n    fills = sorted(set(h.lower() for h in FILL_RE.findall(svg)))\n    if fills:\n        frgb = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in fills], np.float64)\n        idx = np.argmin(np.linalg.norm(_lab(frgb)[:, None] - _lab(pal)[None], axis=-1), 1)\n        hexes = ["#%02x%02x%02x" % tuple(int(round(v)) for v in pal[i]) for i in idx]\n        mp = dict(zip(fills, hexes))\n        svg = FILL_RE.sub(lambda m: \'fill="%s"\' % mp[m.group(1).lower()], svg)\n    q = quality(rgb, w, pal)\n    q["colours"] = len(set(h.lower() for h in FILL_RE.findall(svg)))\n    q["max_colours"] = int(max_colours)\n    q["warning"] = warning_for(q)\n', 'fs': '#!/usr/bin/env python3\n"""Seam/island defect check (V7). Usage: python3 scripts/seam-check.py IMAGE SVG [--out DIR] [--inches 4]\nRenders the SVG crisp (no anti-aliasing, test-only copy) at 4x a 100-dpi print of INCHES width,\nlabels pixels by exact SVG fill colour, and FAILS on:\n  island : a component < ~0.5 mm diameter-equivalent fully inside ONE other colour (not transparent),\n           whose colour is not what the source shows there (dE76 > 20)\n  sliver : a thin component (max half-width <= 0.15 mm) along a seam touching >= 2 other labels,\n           whose colour is not what the source shows there  (third-colour / light hairline seams)\n  gap    : transparent pixels enclosed between inks (not connected to the frame) where the source is ink\nPrints PASS/FAIL line and writes JSON + a marked PNG."""\nimport argparse, json, re, subprocess, sys, tempfile, os\nimport numpy as np\nfrom PIL import Image\nfrom scipy import ndimage as nd\ndef lab(rgb):\n    a = rgb.astype(np.float64) / 255.0\n    a = np.where(a > 0.04045, ((a + 0.055) / 1.055) ** 2.4, a / 12.92)\n    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])\n    xyz = a @ M.T / np.array([0.95047, 1.0, 1.08883])\n    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)\n    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)\ndef main():\n    ap = argparse.ArgumentParser(); ap.add_argument("image"); ap.add_argument("svg"); ap.add_argument("--out", default=None); ap.add_argument("--inches", type=float, default=4.0)\n    a = ap.parse_args()\n    W = int(round(a.inches * 100 * 4)); pxmm = W / (a.inches * 25.4)\n    txt = open(a.svg).read()\n    txt = re.sub(r"<svg\\b", \'<svg shape-rendering="crispEdges"\', txt, count=1)\n    td = tempfile.mkdtemp(); sp = os.path.join(td, "c.svg"); open(sp, "w").write(txt); rp = os.path.join(td, "r.png")\n    subprocess.run(["rsvg-convert", "-w", str(W), sp, "-o", rp], check=True)\n    r = np.asarray(Image.open(rp).convert("RGBA")); H = r.shape[0]\n    alpha = r[..., 3] > 127\n    rgb = r[..., :3].astype(np.int32)\n    key = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]\n    key = np.where(alpha, key, -1)\n    vals, inv = np.unique(key, return_inverse=True); L = inv.reshape(key.shape)\n    src = np.asarray(Image.open(a.image).convert("RGB").resize((W, H), Image.LANCZOS)); srclab = lab(src)\n    def pal(i):\n        v = int(vals[i]); return np.array([(v >> 16) & 255, (v >> 8) & 255, v & 255])\n    island_max = np.pi * (0.25 * pxmm) ** 2; thin_half = 0.15 * pxmm\n    defects = []; mark = np.zeros((H, W), bool)\n    st = np.ones((3, 3), bool)\n    order = np.argsort(L, axis=None, kind="stable"); cuts = np.searchsorted(L.ravel()[order], np.arange(len(vals) + 1))\n    Lfull = L; Hf, Wf = H, W\n    for li, v in enumerate(vals):\n        pix = order[cuts[li]:cuts[li + 1]]; ys, xs = pix // Wf, pix % Wf\n        by0, by1 = max(ys.min() - 3, 0), min(ys.max() + 4, Hf); bx0, bx1 = max(xs.min() - 3, 0), min(xs.max() + 4, Wf)\n        Lb = Lfull[by0:by1, bx0:bx1]; srcb = src[by0:by1, bx0:bx1]; srclabb = srclab[by0:by1, bx0:bx1]\n        m = Lb == li\n        comp, n = nd.label(m, structure=st)\n        if n == 0: continue\n        areas = nd.sum(m, comp, range(1, n + 1)); objs = nd.find_objects(comp)\n        for k in range(n):\n            ar = areas[k]; sl = objs[k]\n            H, W = Lb.shape\n            y0, y1 = max(sl[0].start - 2, 0), min(sl[0].stop + 2, H); x0, x1 = max(sl[1].start - 2, 0), min(sl[1].stop + 2, W)\n            cm = comp[y0:y1, x0:x1] == k + 1\n            ring = nd.binary_dilation(cm, st, iterations=1) & ~cm\n            nb = np.unique(Lb[y0:y1, x0:x1][ring])\n            nb = [x for x in nb if x != li]\n            touches_frame = sl[0].start + by0 == 0 or sl[1].start + bx0 == 0 or sl[0].stop + by0 == Hf or sl[1].stop + bx0 == Wf\n            kind = None\n            if v == -1:\n                if not touches_frame and ar >= 4:\n                    # enclosed transparency: a gap if the source is not paper-like there\n                    s = srcb[y0:y1, x0:x1][cm]\n                    if len(nb) >= 1 and np.median(s.min(1)) < 235: kind = "gap"\n            else:\n                if ar < island_max and len(nb) == 1 and vals[nb[0]] != -1 and ar >= 3: kind = "island"\n                elif len(nb) >= 2 and ar >= 6:\n                    dt = nd.distance_transform_edt(np.pad(cm, 1))\n                    if dt.max() <= thin_half + 0.5: kind = "sliver"\n                if kind:\n                    de = np.sqrt(((srclabb[y0:y1, x0:x1][cm] - lab(pal(li)[None, None, :])[0, 0]) ** 2).sum(-1))\n                    if np.median(de) <= 20: kind = None  # the source really has this colour here (designed)\n            if kind:\n                cy, cx = [int(c) for c in nd.center_of_mass(cm)]\n                defects.append({"kind": kind, "color": "#%06x" % v if v >= 0 else "transparent", "area_px": int(ar), "xy": [int(bx0 + x0 + cx), int(by0 + y0 + cy)]})\n                mark[by0 + y0:by0 + y1, bx0 + x0:bx0 + x1] |= cm\n    H, W = Hf, Wf\n    cnt = {k: sum(d["kind"] == k for d in defects) for k in ("island", "sliver", "gap")}\n    res = {"status": "FAIL" if defects else "PASS", "counts": cnt, "render_w": W, "px_per_mm": round(pxmm, 2), "defects": defects}\n    if a.out:\n        os.makedirs(a.out, exist_ok=True); json.dump(res, open(os.path.join(a.out, "seam.json"), "w"), indent=1)\n        vis = r[..., :3].copy(); vis[~alpha] = [128, 128, 128]\n        big = nd.binary_dilation(mark, iterations=6) & ~nd.binary_dilation(mark, iterations=3); vis[big] = [255, 0, 255]\n        Image.fromarray(vis).save(os.path.join(a.out, "seam-marked.png"))\n    print(f"{res[\'status\']} seam-check islands={cnt[\'island\']} slivers={cnt[\'sliver\']} gaps={cnt[\'gap\']}")\n    return 1 if defects else 0\nif __name__ == "__main__": sys.exit(main())\n', 'r7': 'import sys,os,json,time,tempfile,subprocess,re,numpy as np,cv2\nfrom PIL import Image\nfrom scipy import ndimage as ndi\nP=_mod(\'pl\'); E=_R3; import vtracer\ndef quant(path,k,pre,bp,mode):\n    im=Image.open(path).convert(\'RGB\'); W,H=im.size\n    if max(W,H)>2800:\n        s=2000/max(W,H); im=im.resize((round(W*s),round(H*s)),Image.Resampling.LANCZOS)\n    a=np.asarray(im)\n    if pre==\'bil\': a=cv2.bilateralFilter(a,5,30,30)\n    elif pre==\'ep\': a=cv2.edgePreservingFilter(a,flags=1,sigma_s=20,sigma_r=0.15)\n    rgb,w=P.source_histogram(path); pal=P.pick_palette(rgb,w,k)\n    if bp:\n        L=P._lab(a[::4,::4].reshape(-1,3).astype(float)); bm=P.is_brown(L)\n        if bm.mean()>0.002:\n            bl=L[bm]; ab=a[::4,::4].reshape(-1,3)[bm]; cent=bl[np.linspace(0,len(bl)-1,bp).astype(int)]\n            for _ in range(8):\n                lb=np.argmin(((bl[:,None]-cent[None])**2).sum(-1),1)\n                cent=np.array([bl[lb==c].mean(0) if (lb==c).any() else cent[c] for c in range(bp)])\n            pal=np.vstack([pal,[ab[np.argmin(((bl-c)**2).sum(-1))] for c in cent]])\n    # LUT over 6-bit/channel bins\n    g=np.arange(0,256,4)+2; grid=np.stack(np.meshgrid(g,g,g,indexing=\'ij\'),-1).reshape(-1,3).astype(float)\n    gl=P._lab(grid); pl=P._lab(pal)\n    lut=np.argmin(((gl[:,None]-pl[None])**2).sum(-1),1).astype(np.int32)\n    q=(a>>2).astype(np.int32); idx=lut[(q[...,0]<<12)|(q[...,1]<<6)|q[...,2]]\n    for _ in range(mode):\n        bc=np.zeros(idx.shape,np.float32); bi=idx.copy()\n        for c in np.unique(idx):\n            f=cv2.blur((idx==c).astype(np.float32),(3,3)); m=f>bc+1e-6; bc[m]=f[m]; bi[m]=c\n        idx=bi\n    return idx,pal.astype(np.uint8)\ndef merge_small(idx,T):\n    if T<=0: return idx\n    bad=np.zeros(idx.shape,bool)\n    for c in np.unique(idx):\n        lab,n=ndi.label(idx==c)\n        if n==0: continue\n        ar=np.bincount(lab.ravel()); small=ar<T; small[0]=False; bad|=small[lab]\n    if not bad.any(): return idx\n    _,(iy,ix)=ndi.distance_transform_edt(bad,return_indices=True)\n    return idx[iy,ix]\ndef pot(mask,color,a,o):\n    if mask.sum()<2: return \'\'\n    td=tempfile.mkdtemp(); src,dst=td+\'/m.pbm\',td+\'/m.svg\'\n    Image.fromarray(~mask).convert(\'1\').save(src)\n    subprocess.run([\'potrace\',\'-s\',\'--flat\',\'-t\',\'0\',\'-a\',str(a),\'-O\',str(o),\'-u\',\'10\',\'-C\',color,\'-o\',dst,src],check=True,capture_output=True)\n    t=open(dst).read(); os.remove(src); os.remove(dst); os.rmdir(td)\n    m=re.search(r\'(<g\\b.*</g>)\',t,re.S); return m.group(1) if m else \'\'\ndef trace_pt(idx,pal,inches,a,o,grow):\n    H,W=idx.shape; fr=np.concatenate([idx[0],idx[-1],idx[:,0],idx[:,-1]]); bg=int(np.bincount(fr).argmax())\n    ar=np.bincount(idx.ravel(),minlength=len(pal)); ids=sorted([c for c in range(len(pal)) if c!=bg and ar[c]],key=lambda c:-ar[c])\n    above=np.zeros((H,W),bool); jobs={}\n    for c in reversed(ids):\n        m=idx==c; jobs[c]=E.grow_under(m,above,grow) if above.any() else m; above|=m\n    parts=[pot(jobs[c],E.hex_of(pal[c]),a,o) for c in ids]\n    return (f\'<svg xmlns="http://www.w3.org/2000/svg" width="{inches:.4f}in" height="{inches*H/W:.4f}in" viewBox="0 0 {inches:.4f} {inches*H/W:.4f}">\'\n      f\'<g transform="scale({inches/W:.8f})"><rect width="{W}" height="{H}" fill="{E.hex_of(pal[bg])}"/>\'+\'\'.join(parts)+\'</g></svg>\\n\')\ndef trace_vt(idx,pal,inches,ld,fs,lt):\n    src=tempfile.mktemp(suffix=\'.png\'); Image.fromarray(pal[idx]).save(src); out=tempfile.mktemp(suffix=\'.svg\')\n    vtracer.convert_image_to_svg_py(src,out,colormode="color",hierarchical="stacked",mode="spline",filter_speckle=fs,color_precision=8,layer_difference=ld,corner_threshold=60,length_threshold=lt,max_iterations=10,splice_threshold=45,path_precision=3)\n    s=E.wrap_vtracer(open(out).read(),inches); os.remove(src); os.remove(out); return s\ndef run(path,c):\n    idx,pal=quant(path,c[\'k\'],c.get(\'pre\'),c.get(\'bp\',0),c.get(\'mode\',1))\n    H,W=idx.shape; T=int(c.get(\'T\',0)*(W*H)/1e6)  # T = min area in px per Mpx\n    idx=merge_small(idx,max(T,c.get(\'Tmin\',0)))\n    if c[\'eng\']==\'pt\': return trace_pt(idx,pal,10.0,c.get(\'a\',1.0),c.get(\'o\',0.4),c.get(\'grow\',2.0))\n    return trace_vt(idx,pal,10.0,c.get(\'ld\',1),c.get(\'fs\',4),c.get(\'lt\',4.0))\n', 'r8': 'import sys,os,json,time,numpy as np,cv2\nfrom PIL import Image\nfrom scipy import ndimage as ndi\nr7=_mod(\'r7\'); P=_mod(\'pl\'); E=_R3\n_GU=E.grow_under\ndef _grow(mask,cover,radius):\n    ys=np.flatnonzero(mask.any(1)); xs=np.flatnonzero(mask.any(0))\n    if not len(ys) or not cover.any(): return mask\n    H,W=mask.shape; r=int(np.ceil(radius))+1\n    y0,y1,x0,x1=max(ys[0]-r,0),min(ys[-1]+r+1,H),max(xs[0]-r,0),min(xs[-1]+r+1,W)\n    out=mask.copy(); out[y0:y1,x0:x1]=_GU(mask[y0:y1,x0:x1],cover[y0:y1,x0:x1],radius); return out\nE.grow_under=_grow\ndef merge_hue(idx,pl,T,keep_brown=False):\n    """Small regions are filled from the neighbour ink closest in Lab (not just nearest pixel), so merges don\'t cross hue edges."""\n    if T<=0: return idx\n    bad=np.zeros(idx.shape,bool)\n    for c in np.unique(idx):\n        m=idx==c; ys=np.flatnonzero(m.any(1)); xs=np.flatnonzero(m.any(0))\n        y0,y1,x0,x1=ys[0],ys[-1]+1,xs[0],xs[-1]+1\n        n,lab,st,_=cv2.connectedComponentsWithStats(m[y0:y1,x0:x1].astype(np.uint8),connectivity=8)\n        sm=st[:,4]<T; sm[0]=False\n        if sm.any(): bad[y0:y1,x0:x1]|=sm[lab]\n    own=idx.copy(); out=idx.copy(); D=((pl[:,None]-pl[None])**2).sum(-1)\n    if keep_brown:\n        b=P.is_brown(pl); D[np.ix_(b,~b)]=np.inf\n    H,W=idx.shape; o=out.ravel(); b=bad.ravel().copy(); ow=own.ravel()\n    p=np.flatnonzero(b)\n    for _ in range(60):\n        if not len(p): break\n        y,x=p//W,p%W; best=np.full(len(p),np.inf); bl=o[p].copy(); grown=np.zeros(len(p),bool)\n        for ok0,q in ((y>0,p-W),(y<H-1,p+W),(x>0,p-1),(x<W-1,p+1)):\n            q=np.where(ok0,q,p); ok=ok0&~b[q]; nb=o[q]; d=D[ow[p],nb]; ok&=np.isfinite(d)\n            m=ok&(d<best); best[m]=d[m]; bl[m]=nb[m]; grown|=ok\n        o[p[grown]]=bl[grown]; b[p[grown]]=False; p=p[~grown]\n        if not grown.any(): break\n    out=o.reshape(H,W)\n    return out\ndef snap(idx,a,pal):\n    """Each ink becomes the median source colour of its own pixels (no averaged hue drift)."""\n    p=pal.copy()\n    flat=idx.ravel(); A=a.reshape(-1,3)\n    order=np.argsort(flat,kind=\'stable\'); cuts=np.searchsorted(flat[order],np.arange(len(pal)+1))\n    for c in range(len(pal)):\n        s=order[cuts[c]:cuts[c+1]]\n        if len(s)>=20: p[c]=np.median(A[s[::max(1,len(s)//5000)]],0)\n    return p.astype(np.uint8)\ndef load(path):\n    im=Image.open(path).convert(\'RGB\'); W,H=im.size\n    if max(W,H)>2800:\n        s=2000/max(W,H); im=im.resize((round(W*s),round(H*s)),Image.Resampling.LANCZOS)\n    return np.asarray(im)\n_LC={}\nER=0\ndef lockbrown(idx,a,pal,LOCKMODE=1):\n    k=id(a)\n    if k not in _LC: _LC.clear(); _LC[k]=P._lab(a.astype(np.float32))\n    L=_LC[k]; bm=P.is_brown(L); pl=P._lab(pal.astype(float)); pb=np.where(P.is_brown(pl))[0]\n    if bm.mean()<0.002 or not len(pb): return idx\n    # only lock brown px currently on a warmer/brighter non-brown ink (orange AA), not darks\n    if ER: bm=cv2.erode(bm.astype(np.uint8),np.ones((2*ER+1,2*ER+1),np.uint8)).astype(bool)\n    bad=bm&~np.isin(idx,pb)&((pl[idx][...,0]>L[...,0]) if LOCKMODE==1 else True)\n    idx=idx.copy()\n    if LOCKMODE==3:\n        # AA band: give it to the darkest neighbouring ink when that ink is darker than the pixel\n        Lp=pl[:,0]; li=Lp[idx]; dk=cv2.erode(li.astype(np.float32),np.ones((3,3),np.uint8))\n        # index of darkest neighbour: search the 8 neighbours\n        H,W=idx.shape; best=idx.copy(); bl=li.copy()\n        for dy in (-1,0,1):\n            for dx in (-1,0,1):\n                nb=np.roll(idx,(dy,dx),(0,1)); m=Lp[nb]<bl; best[m]=nb[m]; bl[m]=Lp[nb][m]\n        use=bad&(bl<L[...,0]); idx[use]=best[use]; bad=bad&~use\n    d=((L[bad][:,None]-pl[pb][None])**2).sum(-1); idx[bad]=pb[np.argmin(d,1)]; return idx\ndef run(path,c):\n    global ER; ER=c.get(\'er\',0)\n    idx,pal=r7.quant(path,c[\'k\'],None,c.get(\'bp\',4),c.get(\'mode\',1)); a=load(path)\n    if c.get(\'lock\'): idx=lockbrown(idx,a,pal,c[\'lock\'])\n    H,W=idx.shape; T=max(int(c.get(\'T\',10)*W*H/1e6),c.get(\'Tmin\',3))\n    if c.get(\'hue\',1): idx=merge_hue(idx,P._lab(pal.astype(float)),T)\n    else: idx=r7.merge_small(idx,T)\n    if c.get(\'lock2\'):\n        idx=lockbrown(idx,a,pal,c[\'lock2\'])\n        if c.get(\'remerge\'): idx=merge_hue(idx,P._lab(pal.astype(float)),max(2,int(T*c[\'remerge\'])),True)\n    if c.get(\'snap\',1): pal=snap(idx,a,pal)\n    return r7.trace_pt(idx,pal,10.0,1.0,c.get(\'o\',0.4),2.0)\n', 'st': 'import numpy as np,cv2,subprocess,tempfile,os,re\nfrom PIL import Image\ndef _lab_L(a):\n    c=a.astype(np.float32)/255.; c=np.where(c<=0.04045,c/12.92,((c+0.055)/1.055)**2.4)\n    y=c@np.array([0.2126,0.7152,0.0722],np.float32); f=np.where(y>0.008856,np.cbrt(y),7.787*y+16/116.); return 116*f-16\ndef stroke_mask(a,dl=15,core=25,minlen=40,minarea=30,maxw=4.0):\n    L=_lab_L(a); L8=np.clip(L*2.55,0,255).astype(np.uint8); md=cv2.medianBlur(L8,9).astype(np.float32)/2.55\n    d=L-md; m=(d>dl).astype(np.uint8)\n    m=cv2.morphologyEx(m,cv2.MORPH_CLOSE,np.ones((3,3),np.uint8))\n    n,lab,st,_=cv2.connectedComponentsWithStats(m,connectivity=8)\n    dt=cv2.distanceTransform(m,cv2.DIST_L2,3); out=np.zeros(m.shape,bool); comps=[]\n    for i in range(1,n):\n        x,y,w,h,ar=st[i]\n        if max(w,h)<minlen or ar<minarea: continue\n        cm=lab[y:y+h,x:x+w]==i\n        if dt[y:y+h,x:x+w][cm].max()>maxw: continue           # thin only\n        if (d[y:y+h,x:x+w][cm]>core).sum()<10: continue      # must have a real light core\n        out[y:y+h,x:x+w]|=cm; comps.append(i)\n    return out,d\nCORECOL=0\nCM=0\ndef overlay(a,ref=None,up=4,amax=1.2,opt=0.4,minw=1,blur=0.6,lost=0.4,colq=50):\n    """ref: RGB of what the base trace shows (same size); only streaks the base lost are drawn."""\n    m,d=stroke_mask(a)\n    if not m.any(): return \'\'\n    H,W=m.shape; n,lab=cv2.connectedComponents(m.astype(np.uint8),connectivity=8)\n    Ls=_lab_L(a); Lr=_lab_L(ref) if ref is not None else None\n    parts=[]\n    for i in range(1,n):\n        cm=lab==i; ys,xs=np.nonzero(cm); y0,y1,x0,x1=max(ys.min()-3,0),min(ys.max()+4,H),max(xs.min()-3,0),min(xs.max()+4,W)\n        c=cm[y0:y1,x0:x1]; dd=d[y0:y1,x0:x1]; core=(dd>25)&c\n        if Lr is not None and (Ls[y0:y1,x0:x1][c]-Lr[y0:y1,x0:x1][c]>15).mean()<lost: continue\n        if CM: c=cv2.dilate(((dd>CM)&c).astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool)&c\n        if minw: c=c|(cv2.dilate(core.astype(np.uint8),np.ones((2*minw+1,2*minw+1),np.uint8)).astype(bool)&cv2.dilate(c.astype(np.uint8),np.ones((3,3),np.uint8)).astype(bool))\n        src=core if (CORECOL and core.sum()>=5) else c; col=np.percentile(a[y0:y1,x0:x1][src],colq,axis=0).astype(int)\n        h,w=c.shape; big=cv2.resize(c.astype(np.uint8)*255,(w*up,h*up),interpolation=cv2.INTER_LINEAR)\n        if blur: big=cv2.GaussianBlur(big,(0,0),up*blur)\n        big=big>127\n        td=tempfile.mkdtemp(); src,dst=td+\'/m.pbm\',td+\'/m.svg\'\n        Image.fromarray(~big).convert(\'1\').save(src)\n        subprocess.run([\'potrace\',\'-s\',\'--flat\',\'-t\',str(2*up*up),\'-a\',str(amax),\'-O\',str(opt),\'-u\',\'10\',\'-C\',\'#%02x%02x%02x\'%tuple(col),\'-o\',dst,src],check=True,capture_output=True)\n        t=open(dst).read(); os.remove(src); os.remove(dst); os.rmdir(td)\n        g=re.search(r\'(<g\\b.*</g>)\',t,re.S)\n        if g: parts.append(re.sub(r\'translate\\([^)]*\\)\\s*scale\\([^)]*\\)\',f\'translate({x0:.6f},{y0+h:.6f}) scale({0.1/up:.6f},{-0.1/up:.6f})\',g.group(1),count=1))\n    return \'\'.join(parts)\ndef add(svg,a,**k):\n    g=overlay(a,**k)\n    if not g: return svg\n    i=svg.rindex(\'</g></svg>\'); return svg[:i]+g+svg[i:]\n'}
_MODS = {}
def _mod(name):
    if name not in _MODS:
        m = _types.ModuleType("r8_" + name); _MODS[name] = m; m.__dict__.update(_mod=_mod, _R3=_R3)
        exec(compile(_SRC[name], "<r8_%s>" % name, "exec"), m.__dict__)
    return _MODS[name]
R8CFG = {"k": 64, "bp": 4, "T": 10, "Tmin": 3, "lock": 1, "lock2": 3, "remerge": 0.5}
BIG_MPX = 2.0   # at or above this, r8 route only (both would not fit 15 s on 1 core)

def _lab8(rgb):
    return _mod("pl")._lab(rgb.astype(np.float32))

def quick_score(path, svg):
    """Fixed chooser metrics: seam-check slivers/islands at 4 in, dE95, hue-shift %."""
    td = tempfile.mkdtemp(); sp = os.path.join(td, "s.svg"); open(sp, "w").write(svg)
    fs = _mod("fs"); old = sys.argv; buf = _io.StringIO()
    try:
        sys.argv = ["fs", path, sp, "--inches", "4"]
        with _ctx.redirect_stdout(buf):
            fs.main()
    finally:
        sys.argv = old
    m = re.search(r"islands=(\d+) slivers=(\d+) gaps=(\d+)", buf.getvalue())
    isl, sl, gp = (int(x) for x in m.groups())
    s = np.asarray(Image.open(path).convert("RGB")); H, W = s.shape[:2]
    rp = os.path.join(td, "r.png")
    subprocess.run(["rsvg-convert", "-w", str(W), "-h", str(H), "-b", "white", "-o", rp, sp], check=True)
    r = np.asarray(Image.open(rp).convert("RGB"))
    for f in (sp, rp): os.remove(f)
    os.rmdir(td)
    Ls, Lr = _lab8(s), _lab8(r)
    dE = np.sqrt(((Ls - Lr) ** 2).sum(-1))
    cs = np.hypot(Ls[..., 1], Ls[..., 2]); cr = np.hypot(Lr[..., 1], Lr[..., 2])
    hr = np.degrees(np.arctan2(Lr[..., 2], Lr[..., 1])); hs = np.degrees(np.arctan2(Ls[..., 2], Ls[..., 1]))
    dh = np.abs((hr - hs + 180) % 360 - 180)
    ch = (cs > 15) & (cr > 15)
    # seam px aligned to eggbot's count: crisp render 1600 px wide, px >30 L lighter than source and >10 L above a 5x5 median
    W2 = 1600; H2 = round(H * W2 / W); txt = re.sub(r"<svg\b", '<svg shape-rendering="crispEdges"', svg, count=1)
    td = tempfile.mkdtemp(); sp = os.path.join(td, "c.svg"); rp = os.path.join(td, "c.png"); open(sp, "w").write(txt)
    subprocess.run(["rsvg-convert", "-w", str(W2), "-h", str(H2), "-b", "white", "-o", rp, sp], check=True)
    rc = np.asarray(Image.open(rp).convert("RGB")); os.remove(sp); os.remove(rp); os.rmdir(td)
    s2 = np.asarray(Image.open(path).convert("RGB").resize((W2, H2), Image.LANCZOS))
    L2 = _lab8(rc)[..., 0]; Ls2 = _lab8(s2)[..., 0]
    spx = int(((L2 - Ls2 > 30) & (L2 - cv2.medianBlur(L2.astype(np.float32), 5) > 10)).sum())
    return dict(spx=spx, sl=sl, isl=isl, gaps=gp, dE95=float(np.percentile(dE, 95)),
                hue=float(100 * (dh[ch] > 20).mean()) if ch.any() else 0.0)

def choose(a, b):
    """True = take r8 (b). Biased to r8: fall back to r3 only when r8 is clearly worse:
    more than 2 added specks, dE95 more than 3 worse, gaps, or aligned seam px more than 2.5x r3."""
    return (b["gaps"] <= a["gaps"] and b["isl"] <= a["isl"] + 2
            and b["dE95"] <= a["dE95"] + 3.0 and b["spx"] <= 2.5 * max(a["spx"], 1))

# round 11: thin light streaks the base trace lost are re-drawn on top as solid, smoothed, tapered
# filled paths (one per streak, min width ~3 px). Only for images of 2 Mpx and up whose long side is
# at most 2000 px (carpenters-original size class); everything else is byte-identical to r9.
STREAKCFG = {"lost": 0.25}
def _add_streaks(path, svg):
    a = np.asarray(Image.open(path).convert("RGB")); H, W = a.shape[:2]
    td = tempfile.mkdtemp(); sp = os.path.join(td, "b.svg"); rp = os.path.join(td, "b.png"); open(sp, "w").write(svg)
    subprocess.run(["rsvg-convert", "-w", str(W), "-h", str(H), "-b", "white", "-o", rp, sp], check=True)
    ref = np.asarray(Image.open(rp).convert("RGB")); os.remove(sp); os.remove(rp); os.rmdir(td)
    return _mod("st").add(svg, a, ref=ref, **STREAKCFG)
def trace_busy_r8(path, inches):
    svg = _mod("r8").run(path, R8CFG)
    w, h = Image.open(path).size
    if w * h / 1e6 >= BIG_MPX and max(w, h) <= 2000:
        svg = _add_streaks(path, svg)
    if inches != 10.0:
        svg = svg.replace('width="10.0000in"', 'width="%.4fin"' % inches)
    return svg

def vectorise(path, out_path, inches):
    t0 = time.perf_counter()
    rgb = load_rgb(path)
    idx, pr, stats, flat = decide(rgb)
    if flat:
        idx, _pl, pr = quantize_flat(rgb)
        svg = trace_flat(idx, pr, inches); mode = "flat"
    else:
        H, W = rgb.shape[:2]
        if H * W / 1e6 >= BIG_MPX:
            svg = trace_busy_r8(path, inches); mode = "busy-r8(big)"
        else:
            s3 = trace_busy(path, 10.0); s8 = trace_busy_r8(path, 10.0)
            q3, q8 = quick_score(path, s3), quick_score(path, s8)
            pick8 = choose(q3, q8)
            svg = trace_busy_r8(path, inches) if (pick8 and inches != 10.0) else (s8 if pick8 else (s3 if inches == 10.0 else trace_busy(path, inches)))
            mode = "busy-r8" if pick8 else "busy-r3"
    open(out_path, "w").write(svg)
    dt = time.perf_counter() - t0
    print(f"{os.path.basename(path)} {mode} {dt:.2f}s", file=sys.stderr, flush=True)
    return dt, mode

if __name__ == "__main__":
    main()
