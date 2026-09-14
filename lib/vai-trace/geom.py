"""Contour fairing, primitive detection, and Schneider cubic Bézier fitting."""
from __future__ import annotations

import math
from typing import Iterable, List, Optional, Sequence, Tuple

Point = Tuple[float, float]


def vsub(a: Point, b: Point) -> Point:
    return (a[0] - b[0], a[1] - b[1])


def vadd(a: Point, b: Point) -> Point:
    return (a[0] + b[0], a[1] + b[1])


def vscale(a: Point, s: float) -> Point:
    return (a[0] * s, a[1] * s)


def vdot(a: Point, b: Point) -> float:
    return a[0] * b[0] + a[1] * b[1]


def vlen(a: Point) -> float:
    return math.hypot(a[0], a[1])


def vnorm(a: Point) -> Point:
    L = vlen(a) or 1.0
    return (a[0] / L, a[1] / L)


def fmt(n: float, digits: int = 4) -> str:
    x = round(float(n), digits)
    if x == 0:
        return "0"
    s = f"{x:.{digits}f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def ring_area(pts: Sequence[Point]) -> float:
    n = len(pts)
    if n < 3:
        return 0.0
    a = 0.0
    for i in range(n):
        j = (i + 1) % n
        a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
    return a * 0.5


def ring_bbox(pts: Sequence[Point]) -> Tuple[float, float, float, float]:
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def clean_ring(pts: Sequence[Point], min_dist: float = 0.2) -> List[Point]:
    if not pts:
        return []
    ring = list(pts)
    if len(ring) > 1 and math.hypot(ring[0][0] - ring[-1][0], ring[0][1] - ring[-1][1]) < 0.6:
        ring = ring[:-1]
    out: List[Point] = []
    for p in ring:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > min_dist:
            out.append((float(p[0]), float(p[1])))
    if len(out) > 2 and math.hypot(out[0][0] - out[-1][0], out[0][1] - out[-1][1]) < min_dist:
        out.pop()
    return out


def _axis_dir(dx: float, dy: float, axis_eps: float) -> int:
    """1=H+, 2=H-, 3=V+, 4=V-, 0=degen, -1=diagonal."""
    ax, ay = abs(dx), abs(dy)
    if ax < 1e-9 and ay < 1e-9:
        return 0
    if ay <= axis_eps and ax >= 0.28:
        return 1 if dx > 0 else 2
    if ax <= axis_eps and ay >= 0.28:
        return 3 if dy > 0 else 4
    return -1


def _is_pixel_stair_corner(a: Point, b: Point, c: Point, max_leg: float, axis_eps: float) -> bool:
    """True when b is a raster jog (axis H/V turn) rather than a designed corner."""
    abx, aby = b[0] - a[0], b[1] - a[1]
    bcx, bcy = c[0] - b[0], c[1] - b[1]
    lab = math.hypot(abx, aby)
    lbc = math.hypot(bcx, bcy)
    if lab < 0.2 or lbc < 0.2:
        return False
    da = _axis_dir(abx, aby, axis_eps)
    dc = _axis_dir(bcx, bcy, axis_eps)
    if da <= 0 or dc <= 0:
        return False
    # Must be an H↔V turn, not a collinear continuation or a reversal (U-notch).
    pair = {da, dc}
    if pair not in ({1, 3}, {1, 4}, {2, 3}, {2, 4}):
        return False
    short = min(lab, lbc)
    long = max(lab, lbc)
    # 45° unit stairs: both legs short.
    if lab <= max_leg and lbc <= max_leg:
        return True
    # Shallow raster diagonals: long run + 1–2px jog.
    if short <= min(max_leg, 2.6) and long <= max_leg * 6.0:
        return True
    return False


def _collapse_stair_runs(ring: List[Point], closed: bool, rdp_eps: float, axis_eps: float) -> List[Point]:
    """RDP-simplify monotonic axis-aligned stair runs (long-H + short-V diagonals)."""
    n = len(ring)
    if n < 4:
        return ring
    nseg = n if closed else n - 1
    dirs = []
    for i in range(nseg):
        a = ring[i]
        b = ring[(i + 1) % n] if closed else ring[i + 1]
        dirs.append(_axis_dir(b[0] - a[0], b[1] - a[1], axis_eps))
    if not any(d > 0 for d in dirs):
        return ring

    opposite = {1: 2, 2: 1, 3: 4, 4: 3}

    def compatible(cur: set, d: int) -> bool:
        if d <= 0:
            return False
        if d in cur:
            return True
        if opposite.get(d) in cur:
            return False
        if len(cur) >= 2:
            return False
        return True

    used = [False] * nseg
    keep_idx = set()
    if not closed:
        keep_idx.add(0)
        keep_idx.add(n - 1)

    i = 0
    while i < nseg:
        if used[i]:
            i += 1
            continue
        if dirs[i] <= 0:
            keep_idx.add(i)
            keep_idx.add((i + 1) % n if closed else min(n - 1, i + 1))
            i += 1
            continue
        cur = {dirs[i]}
        j = i + 1
        limit = i + nseg if closed else nseg
        while j < limit:
            jj = j % nseg
            if used[jj]:
                break
            d = dirs[jj]
            if not compatible(cur, d):
                break
            cur.add(d)
            j += 1
        run_len = j - i
        segs = [dirs[k % nseg] for k in range(i, i + run_len)]
        n_turn = sum(1 for a, b in zip(segs, segs[1:]) if a != b)
        is_stair = run_len >= 3 and len(cur) == 2 and n_turn >= 2
        pts_run: List[Point] = []
        idx_run: List[int] = []
        for k in range(run_len + 1):
            pi = (i + k) % n if closed else min(n - 1, i + k)
            if not idx_run or idx_run[-1] != pi:
                idx_run.append(pi)
                pts_run.append(ring[pi])
        if is_stair and len(pts_run) >= 3:
            simp = simplify_open(pts_run, rdp_eps)
            keep_idx.add(idx_run[0])
            keep_idx.add(idx_run[-1])
            for p in simp[1:-1]:
                px, py = p
                best = min(
                    range(len(idx_run)),
                    key=lambda t, px=px, py=py: math.hypot(pts_run[t][0] - px, pts_run[t][1] - py),
                )
                keep_idx.add(idx_run[best])
        else:
            for pi in idx_run:
                keep_idx.add(pi)
        for k in range(run_len):
            used[(i + k) % nseg] = True
        if closed:
            i += 1  # wrapping runs mark `used`; scan continues to skip them
        else:
            i += max(1, run_len)

    if closed:
        order = sorted(keep_idx)
        return [ring[k] for k in order] if len(order) >= 3 else ring
    order = [k for k in range(n) if k in keep_idx]
    if not order:
        return ring
    if order[0] != 0:
        order.insert(0, 0)
    if order[-1] != n - 1:
        order.append(n - 1)
    return [ring[k] for k in order]


def destaircase(
    pts: Sequence[Point],
    max_leg: float = 8.5,
    closed: bool = True,
    axis_eps: float = 0.85,
) -> List[Point]:
    """Kill raster stairs without flattening designed corners or real curves.

    1. Midpoint-fair 1px H↔V jogs (moves vertices onto the local diagonal).
    2. RDP-simplify monotonic axis-aligned stair runs (long-H + short-V).
    Isolated long-leg corners (rects, teeth, L-shapes) stay.
    """
    if not pts or len(pts) < 4:
        return [(float(p[0]), float(p[1])) for p in pts]
    if closed:
        ring = clean_ring(pts, 0.15)
    else:
        ring = [(float(p[0]), float(p[1])) for p in pts]
        dedup: List[Point] = [ring[0]]
        for p in ring[1:]:
            if math.hypot(p[0] - dedup[-1][0], p[1] - dedup[-1][1]) > 0.15:
                dedup.append(p)
        ring = dedup
    ring = _merge_collinear(ring, closed=closed, cos_keep=0.9995)
    # Pass 1: RDP monotonic axis-aligned stair runs while still on-grid.
    # eps ≥ ~1px so a 5:1 raster diagonal becomes a chord; curvature sagitta
    # bigger than that is kept (quarter-circles, puma cheek).
    # 45° 2px stairs (common after 2× upsample) have perp-dist ≈1.41, so
    # eps must sit above that or antenna/outline jags survive as cubics.
    rdp_eps = 0.48 if max_leg < 2.0 else (1.70 if max_leg < 6.5 else 2.05)
    ring = _collapse_stair_runs(ring, closed, rdp_eps, axis_eps)
    # Pass 2: slide leftover 1px H↔V jogs onto the local AC diagonal.
    for _ in range(6):
        n = len(ring)
        if n < 4:
            break
        moved = 0
        out: List[Point] = [None] * n  # type: ignore
        for i in range(n):
            if not closed and (i == 0 or i == n - 1):
                out[i] = ring[i]
                continue
            a = ring[(i - 1) % n] if closed else ring[i - 1]
            b = ring[i]
            c = ring[(i + 1) % n] if closed else ring[i + 1]
            if _is_pixel_stair_corner(a, b, c, max_leg, axis_eps):
                mid = ((a[0] + c[0]) * 0.5, (a[1] + c[1]) * 0.5)
                if math.hypot(mid[0] - b[0], mid[1] - b[1]) > 0.04:
                    out[i] = mid
                    moved += 1
                    continue
            out[i] = b
        ring = out  # type: ignore
        if not moved:
            break
    # Merge near-collinear leftovers so Schneider sees long spans, not 1px chords.
    ring = _merge_collinear(ring, closed=closed, cos_keep=0.997)
    if not closed and len(ring) >= 2:
        ring[0] = (float(pts[0][0]), float(pts[0][1]))
        ring[-1] = (float(pts[-1][0]), float(pts[-1][1]))
    return ring


def _merge_collinear(pts: Sequence[Point], *, closed: bool, cos_keep: float = 0.998) -> List[Point]:
    if not pts or len(pts) < 3:
        return [(float(p[0]), float(p[1])) for p in pts]
    ring = [(float(p[0]), float(p[1])) for p in pts]
    n = len(ring)
    keep: List[Point] = []
    for i in range(n):
        if not closed and (i == 0 or i == n - 1):
            keep.append(ring[i])
            continue
        a = ring[(i - 1) % n] if closed else ring[i - 1]
        b = ring[i]
        c = ring[(i + 1) % n] if closed else ring[i + 1]
        v1, v2 = vsub(b, a), vsub(c, b)
        l1, l2 = vlen(v1), vlen(v2)
        if l1 < 0.12 or l2 < 0.12:
            continue
        if vdot(vnorm(v1), vnorm(v2)) >= cos_keep:
            continue
        keep.append(b)
    if not closed:
        if not keep or keep[0] != ring[0]:
            keep.insert(0, ring[0])
        if keep[-1] != ring[-1]:
            keep.append(ring[-1])
    if closed and len(keep) < 3:
        return ring
    if not closed and len(keep) < 2:
        return ring
    return keep


def chaikin(
    pts: Sequence[Point],
    rounds: int = 1,
    sharp_cos: float = -0.25,
    closed: bool = True,
) -> List[Point]:
    ring = [(float(p[0]), float(p[1])) for p in pts]
    for _ in range(max(0, rounds)):
        n = len(ring)
        if n < 3:
            break
        sharp = [False] * n
        for i in range(n):
            if not closed and (i == 0 or i == n - 1):
                continue
            a = ring[(i - 1) % n] if closed else ring[i - 1]
            b = ring[i]
            c = ring[(i + 1) % n] if closed else ring[i + 1]
            v1 = vsub(b, a)
            v2 = vsub(c, b)
            l1, l2 = vlen(v1) or 1.0, vlen(v2) or 1.0
            cos = vdot(v1, v2) / (l1 * l2)
            if cos < sharp_cos and l1 > 1.2 and l2 > 1.2:
                sharp[i] = True
        out: List[Point] = []
        if closed:
            for i in range(n):
                a, b = ring[i], ring[(i + 1) % n]
                if sharp[i]:
                    out.append(a)
                    out.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
                else:
                    out.append((a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25))
                    out.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
        else:
            out.append(ring[0])
            for i in range(n - 1):
                a, b = ring[i], ring[i + 1]
                if sharp[i]:
                    if i != 0:
                        out.append(a)
                    out.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
                else:
                    p1 = (a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25)
                    p2 = (a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75)
                    if i != 0:
                        out.append(p1)
                    out.append(p2)
            out.append(ring[-1])
        ring = out
    return ring


def laplacian_smooth(
    pts: Sequence[Point],
    iters: int = 2,
    lam: float = 0.32,
    closed: bool = True,
) -> List[Point]:
    ring = [(float(p[0]), float(p[1])) for p in pts]
    for _ in range(iters):
        n = len(ring)
        if n < 4:
            break
        out = [None] * n
        for i in range(n):
            if not closed and (i == 0 or i == n - 1):
                out[i] = ring[i]
                continue
            prev = ring[(i - 1) % n] if closed else ring[i - 1]
            pt = ring[i]
            nxt = ring[(i + 1) % n] if closed else ring[i + 1]
            v1, v2 = vsub(pt, prev), vsub(nxt, pt)
            l1, l2 = vlen(v1) or 1.0, vlen(v2) or 1.0
            cos = vdot(v1, v2) / (l1 * l2)
            if cos < -0.35:
                out[i] = pt
            else:
                out[i] = (
                    pt[0] + lam * ((prev[0] + nxt[0]) * 0.5 - pt[0]),
                    pt[1] + lam * ((prev[1] + nxt[1]) * 0.5 - pt[1]),
                )
        ring = out  # type: ignore
    return ring


def _open_corners(work: Sequence[Point], ccos: float, min_leg: float = 4.0) -> set:
    n = len(work)
    corners = set()
    for i in range(1, n - 1):
        a, b, c = work[i - 1], work[i], work[i + 1]
        v1, v2 = vsub(b, a), vsub(c, b)
        if vlen(v1) < min_leg or vlen(v2) < min_leg:
            continue
        if _is_pixel_stair_corner(a, b, c, max_leg=min_leg, axis_eps=1.15):
            continue
        if vdot(vnorm(v1), vnorm(v2)) < ccos:
            corners.add(i)
    return corners


def fair_open_polyline(
    pts: Sequence[Point],
    *,
    closed: bool = False,
    logo: bool = False,
    max_leg: Optional[float] = None,
) -> List[Point]:
    """Destaircase + Chaikin + corner-preserving Laplacian. Ends pinned on open cracks."""
    if not pts:
        return []
    if len(pts) < 4:
        return [(float(p[0]), float(p[1])) for p in pts]
    if max_leg is None:
        max_leg = 6.0 if logo else 8.5
    work = destaircase(pts, max_leg=max_leg, closed=closed, axis_eps=1.15)
    if len(work) < 4:
        return work
    # Gentle Chaikin (skip ~90° designed corners) then Laplacian.
    # One logo round: two rounds rounded squares into fake circles.
    sharp_cos = 0.35 if logo else 0.08
    work = chaikin(work, rounds=1 if logo else 2, sharp_cos=sharp_cos, closed=closed)
    if not closed:
        if work[0] != pts[0]:
            work[0] = (float(pts[0][0]), float(pts[0][1]))
        if work[-1] != pts[-1]:
            work[-1] = (float(pts[-1][0]), float(pts[-1][1]))
    ccos = 0.42 if logo else 0.28
    lam = 0.22 if logo else 0.34
    iters = 2 if logo else 3
    if closed:
        ring = clean_ring(work, 0.12)
        if len(ring) < 4:
            return ring
        corners = set(detect_corners(ring, ccos))
        # Don't protect leftover pixel stairs as "corners".
        n = len(ring)
        for i in list(corners):
            a, b, c = ring[(i - 1) % n], ring[i], ring[(i + 1) % n]
            if _is_pixel_stair_corner(a, b, c, max_leg=4.5, axis_eps=1.15):
                corners.discard(i)
        for _ in range(iters):
            out: List[Point] = []
            for i in range(n):
                if i in corners:
                    out.append(ring[i])
                    continue
                prev, pt, nxt = ring[(i - 1) % n], ring[i], ring[(i + 1) % n]
                out.append(
                    (
                        pt[0] + lam * ((prev[0] + nxt[0]) * 0.5 - pt[0]),
                        pt[1] + lam * ((prev[1] + nxt[1]) * 0.5 - pt[1]),
                    )
                )
            ring = out
            n = len(ring)
        return ring
    corners = _open_corners(work, ccos, min_leg=4.2)
    for _ in range(iters):
        out = [work[0]]
        n = len(work)
        for i in range(1, n - 1):
            if i in corners:
                out.append(work[i])
                continue
            prev, pt, nxt = work[i - 1], work[i], work[i + 1]
            out.append(
                (
                    pt[0] + lam * ((prev[0] + nxt[0]) * 0.5 - pt[0]),
                    pt[1] + lam * ((prev[1] + nxt[1]) * 0.5 - pt[1]),
                )
            )
        out.append(work[-1])
        work = out
    return work


def resample_closed(pts: Sequence[Point], spacing: float = 0.85) -> List[Point]:
    spacing = max(0.25, spacing)
    if not pts or len(pts) < 3:
        return list(pts)
    ring = [(float(p[0]), float(p[1])) for p in pts]
    if math.hypot(ring[0][0] - ring[-1][0], ring[0][1] - ring[-1][1]) > 0.01:
        ring.append(ring[0])
    seg = []
    total = 0.0
    for i in range(len(ring) - 1):
        L = math.hypot(ring[i + 1][0] - ring[i][0], ring[i + 1][1] - ring[i][1])
        seg.append(L)
        total += L
    if total < spacing * 3:
        return list(pts)
    n_out = max(8, int(round(total / spacing)))
    out: List[Point] = []
    step = total / n_out
    si = 0
    acc = 0.0
    for k in range(n_out):
        target = k * step
        while si < len(seg) - 1 and acc + seg[si] < target:
            acc += seg[si]
            si += 1
        L = seg[si] or 1.0
        t = (target - acc) / L
        a, b = ring[si], ring[si + 1]
        out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
    return out


def perp_dist(p: Point, a: Point, b: Point) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    len2 = dx * dx + dy * dy
    if len2 == 0:
        return math.hypot(p[0] - a[0], p[1] - a[1])
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
    return math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))


def simplify_open(pts: Sequence[Point], eps: float) -> List[Point]:
    if len(pts) < 3:
        return list(pts)
    max_d = 0.0
    idx = 0
    a, b = pts[0], pts[-1]
    for i in range(1, len(pts) - 1):
        d = perp_dist(pts[i], a, b)
        if d > max_d:
            max_d = d
            idx = i
    if max_d > eps:
        left = simplify_open(pts[: idx + 1], eps)
        right = simplify_open(pts[idx:], eps)
        return left[:-1] + right
    return [a, b]


def simplify_closed(pts: Sequence[Point], eps: float) -> List[Point]:
    ring = clean_ring(pts, 0.35)
    if len(ring) < 3:
        return list(pts)
    a = 0
    b = 1
    best = -1.0
    n = len(ring)
    step = 1 if n < 180 else max(1, n // 160)
    for i in range(0, n, step):
        for j in range(i + 1, n, step):
            d = math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1])
            if d > best:
                best = d
                a, b = i, j

    def chain(fr: int, to: int) -> List[Point]:
        out = [ring[fr]]
        i = fr
        while i != to:
            i = (i + 1) % n
            out.append(ring[i])
        return out

    s1 = simplify_open(chain(a, b), eps)
    s2 = simplify_open(chain(b, a), eps)
    out = s1[:-1] + s2[:-1]
    return out if len(out) >= 3 else ring


def inflate_ring(pts: Sequence[Point], px: float) -> List[Point]:
    if not pts or len(pts) < 3 or px == 0:
        return list(pts)
    n = len(pts)
    out: List[Point] = []
    for i in range(n):
        prev, cur, nxt = pts[(i - 1) % n], pts[i], pts[(i + 1) % n]
        ex = -(nxt[1] - prev[1])
        ey = nxt[0] - prev[0]
        L = math.hypot(ex, ey) or 1.0
        out.append((cur[0] + (ex / L) * px, cur[1] + (ey / L) * px))
    a0 = abs(ring_area(pts))
    a1 = abs(ring_area(out))
    if a1 < a0:
        out = []
        for i in range(n):
            prev, cur, nxt = pts[(i - 1) % n], pts[i], pts[(i + 1) % n]
            ex = -(nxt[1] - prev[1])
            ey = nxt[0] - prev[0]
            L = math.hypot(ex, ey) or 1.0
            out.append((cur[0] - (ex / L) * px, cur[1] - (ey / L) * px))
    return out


# --- Schneider cubic fit -----------------------------------------------------

def _cubic_point(p0, p1, p2, p3, t) -> Point:
    u = 1.0 - t
    return (
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    )


def _tangent_at(ring: Sequence[Point], i: int, closed: bool) -> Point:
    n = len(ring)
    if closed:
        return vnorm(vsub(ring[(i + 1) % n], ring[(i - 1) % n]))
    if i == 0:
        return vnorm(vsub(ring[1], ring[0]))
    if i == n - 1:
        return vnorm(vsub(ring[n - 1], ring[n - 2]))
    return vnorm(vsub(ring[i + 1], ring[i - 1]))


def _chord_param(pts: Sequence[Point]) -> List[float]:
    u = [0.0]
    for i in range(1, len(pts)):
        u.append(u[-1] + math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
    total = u[-1] or 1.0
    return [x / total for x in u]


def _generate_bezier(pts, u, t_hat1, t_hat2):
    n = len(pts)
    p0, p3 = pts[0], pts[-1]
    C00 = C01 = C11 = X0 = X1 = 0.0
    for i in range(n):
        t = u[i]
        s = 1.0 - t
        b = (s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t)
        a0 = vscale(t_hat1, b[1])
        a1 = vscale(t_hat2, b[2])
        C00 += vdot(a0, a0)
        C01 += vdot(a0, a1)
        C11 += vdot(a1, a1)
        tmp = (
            pts[i][0] - (b[0] + b[1]) * p0[0] - (b[2] + b[3]) * p3[0],
            pts[i][1] - (b[0] + b[1]) * p0[1] - (b[2] + b[3]) * p3[1],
        )
        X0 += vdot(a0, tmp)
        X1 += vdot(a1, tmp)
    det = C00 * C11 - C01 * C01
    seg_len = math.hypot(p3[0] - p0[0], p3[1] - p0[1])
    if abs(det) < 1e-12:
        alpha1 = alpha2 = seg_len / 3.0
    else:
        alpha1 = (C11 * X0 - C01 * X1) / det
        alpha2 = (C00 * X1 - C01 * X0) / det
    eps = 1e-6 * (seg_len or 1.0)
    if not (alpha1 >= eps and alpha2 >= eps and math.isfinite(alpha1) and math.isfinite(alpha2)):
        alpha1 = alpha2 = (seg_len or 1.0) / 3.0
    max_a = (seg_len or 1.0) * 2.5
    alpha1 = min(alpha1, max_a)
    alpha2 = min(alpha2, max_a)
    return [p0, vadd(p0, vscale(t_hat1, alpha1)), vadd(p3, vscale(t_hat2, alpha2)), p3]


def _bezier_d1(bez, t) -> Point:
    s = 1.0 - t
    d0 = vsub(bez[1], bez[0])
    d1 = vsub(bez[2], bez[1])
    d2 = vsub(bez[3], bez[2])
    return (
        3 * s * s * d0[0] + 6 * s * t * d1[0] + 3 * t * t * d2[0],
        3 * s * s * d0[1] + 6 * s * t * d1[1] + 3 * t * t * d2[1],
    )


def _bezier_d2(bez, t) -> Point:
    s = 1.0 - t
    d0 = vsub(vsub(bez[2], bez[1]), vsub(bez[1], bez[0]))
    d1 = vsub(vsub(bez[3], bez[2]), vsub(bez[2], bez[1]))
    return (6 * s * d0[0] + 6 * t * d1[0], 6 * s * d0[1] + 6 * t * d1[1])


def _newton(bez, p, u) -> float:
    q = _cubic_point(*bez, u)
    d1 = _bezier_d1(bez, u)
    d2 = _bezier_d2(bez, u)
    num = (q[0] - p[0]) * d1[0] + (q[1] - p[1]) * d1[1]
    den = d1[0] ** 2 + d1[1] ** 2 + (q[0] - p[0]) * d2[0] + (q[1] - p[1]) * d2[1]
    if abs(den) < 1e-12:
        return u
    nu = u - num / den
    if nu < 0 or nu > 1 or not math.isfinite(nu):
        return u
    return nu


def _max_error(pts, u, bez):
    max_d = 0.0
    split = len(pts) // 2
    for i in range(1, len(pts) - 1):
        q = _cubic_point(*bez, u[i])
        d = (q[0] - pts[i][0]) ** 2 + (q[1] - pts[i][1]) ** 2
        if d > max_d:
            max_d = d
            split = i
    return math.sqrt(max_d), split


def _fit_segment(pts, t_hat1, t_hat2, error, depth=0):
    if len(pts) < 2:
        return []
    if len(pts) == 2 or depth > 12:
        dist = math.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1]) / 3.0
        return [[pts[0], vadd(pts[0], vscale(t_hat1, dist)), vadd(pts[-1], vscale(t_hat2, dist)), pts[-1]]]
    u = _chord_param(pts)
    bez = _generate_bezier(pts, u, t_hat1, t_hat2)
    max_d, split = _max_error(pts, u, bez)
    if max_d < error:
        return [bez]
    if max_d < error * 4:
        for _ in range(4):
            u = [_newton(bez, pts[i], u[i]) for i in range(len(pts))]
            bez = _generate_bezier(pts, u, t_hat1, t_hat2)
            max_d, split = _max_error(pts, u, bez)
            if max_d < error:
                return [bez]
    split = max(1, min(len(pts) - 2, split))
    t_center = _tangent_at(pts, split, False)
    left = pts[: split + 1]
    right = pts[split:]
    return _fit_segment(left, t_hat1, vscale(t_center, -1), error, depth + 1) + _fit_segment(
        right, t_center, t_hat2, error, depth + 1
    )


def detect_corners(ring: Sequence[Point], cos_thresh: float = 0.5) -> List[int]:
    n = len(ring)
    if n < 3:
        return []
    flagged = [False] * n
    spans = [1, 2, 3] if n >= 24 else ([1, 2] if n >= 12 else [1])
    min_leg = 3.2 if n < 80 else 5.0
    for i in range(n):
        hit = False
        for k in spans:
            prev = ring[(i - k) % n]
            cur = ring[i]
            nxt = ring[(i + k) % n]
            raw1 = vsub(cur, prev)
            raw2 = vsub(nxt, cur)
            if vlen(raw1) < min_leg or vlen(raw2) < min_leg:
                continue
            thr = cos_thresh - (k - 1) * 0.08
            if vdot(vnorm(raw1), vnorm(raw2)) < thr:
                hit = True
                break
        flagged[i] = hit
    corners = []
    for i in range(n):
        if not flagged[i]:
            continue
        prev, cur, nxt = ring[(i - 1) % n], ring[i], ring[(i + 1) % n]
        sharp = 1 - vdot(vnorm(vsub(cur, prev)), vnorm(vsub(nxt, cur)))
        sharp_l = -1.0
        sharp_r = -1.0
        if flagged[(i - 1) % n]:
            a = ring[(i - 2) % n]
            b = ring[(i - 1) % n]
            sharp_l = 1 - vdot(vnorm(vsub(b, a)), vnorm(vsub(cur, b)))
        if flagged[(i + 1) % n]:
            d = ring[(i + 2) % n]
            sharp_r = 1 - vdot(vnorm(vsub(nxt, cur)), vnorm(vsub(d, nxt)))
        if sharp >= sharp_l and sharp >= sharp_r:
            corners.append(i)
    return corners


def _splice(ring: Sequence[Point], splits: Sequence[int]):
    n = len(ring)
    if not splits:
        return [{"pts": list(ring), "i0": 0, "i1": 0}]
    splits = sorted(set(int(s) % n for s in splits))
    segs = []
    for s, i0 in enumerate(splits):
        i1 = splits[(s + 1) % len(splits)]
        seg = [ring[i0]]
        i = i0
        while True:
            i = (i + 1) % n
            seg.append(ring[i])
            if i == i1:
                break
        if len(seg) >= 2:
            segs.append({"pts": seg, "i0": i0, "i1": i1})
    return segs


def g1_fair_cubics(
    cubics: Sequence[Sequence[Point]],
    *,
    corner_cos: float = 0.32,
    closed: bool = False,
) -> List[List[Point]]:
    """Force G1 (shared unit tangent) at non-corner cubic joints.

    Handle lengths are preserved so we do not flatten curvature. Sharp joints
    (incoming·outgoing < corner_cos) stay C0.
    """
    if not cubics or len(cubics) < 2:
        return [list(b) for b in cubics]
    out = [[tuple(p) for p in b] for b in cubics]
    n = len(out)
    last = n if closed else n - 1
    for i in range(last):
        a = out[i]
        b = out[(i + 1) % n]
        # a[3] should equal b[0] (C0). Incoming handle a[3]-a[2], outgoing b[1]-b[0].
        vin = vsub(a[3], a[2])
        vout = vsub(b[1], b[0])
        lin, lout = vlen(vin), vlen(vout)
        if lin < 1e-8 or lout < 1e-8:
            continue
        nin, nout = vnorm(vin), vnorm(vout)
        if vdot(nin, nout) < corner_cos:
            continue
        t = vnorm(vadd(nin, nout))
        if vlen(t) < 0.5:
            continue
        a[2] = vsub(a[3], vscale(t, lin))
        b[1] = vadd(b[0], vscale(t, lout))
        out[i] = a
        out[(i + 1) % n] = b
    return out


def _cubic_path_d(cubics: Sequence[Sequence[Point]], scale_x: float, scale_y: float, closed: bool) -> str:
    d = f"M {fmt(cubics[0][0][0] * scale_x)} {fmt(cubics[0][0][1] * scale_y)}"
    for b in cubics:
        d += (
            f" C {fmt(b[1][0] * scale_x)} {fmt(b[1][1] * scale_y)}"
            f" {fmt(b[2][0] * scale_x)} {fmt(b[2][1] * scale_y)}"
            f" {fmt(b[3][0] * scale_x)} {fmt(b[3][1] * scale_y)}"
        )
    if closed:
        d += " Z"
    return d


def fit_cubic_path(pts: Sequence[Point], scale_x: float, scale_y: float, error: float = 0.75, corner_cos: float = 0.5) -> str:
    ring = clean_ring(pts)
    if len(ring) < 2:
        return ""
    if len(ring) < 4:
        d = f"M {fmt(ring[0][0] * scale_x)} {fmt(ring[0][1] * scale_y)}"
        for p in ring[1:]:
            d += f" L {fmt(p[0] * scale_x)} {fmt(p[1] * scale_y)}"
        return d + " Z"
    corners = detect_corners(ring, corner_cos)
    nring = len(ring)
    corners = [
        i
        for i in corners
        if not _is_pixel_stair_corner(
            ring[(i - 1) % nring], ring[i], ring[(i + 1) % nring], max_leg=4.5, axis_eps=1.15
        )
    ]
    if corners:
        segments = _splice(ring, corners)
    else:
        n_seg = 4 if len(ring) >= 16 else 2
        fake = [int((k * len(ring)) / n_seg) for k in range(n_seg)]
        segments = _splice(ring, fake)
    cubics = []
    for seg in segments:
        pts_s = seg["pts"]
        if len(pts_s) < 2:
            continue
        i0, i1 = seg["i0"], seg["i1"]
        sharp_s = i0 in corners
        sharp_e = i1 in corners
        t1 = vnorm(vsub(pts_s[1], pts_s[0])) if sharp_s else _tangent_at(ring, i0, True)
        t2 = vnorm(vsub(pts_s[-2], pts_s[-1])) if sharp_e else vscale(_tangent_at(ring, i1, True), -1)
        cubics.extend(_fit_segment(pts_s, t1, t2, error, 0))
    if not cubics:
        d = f"M {fmt(ring[0][0] * scale_x)} {fmt(ring[0][1] * scale_y)}"
        for p in ring[1:]:
            d += f" L {fmt(p[0] * scale_x)} {fmt(p[1] * scale_y)}"
        return d + " Z"
    cubics = g1_fair_cubics(cubics, corner_cos=max(0.2, corner_cos - 0.15), closed=True)
    return _cubic_path_d(cubics, scale_x, scale_y, True)


def fit_cubic_open(
    pts: Sequence[Point],
    scale_x: float,
    scale_y: float,
    error: float = 0.95,
    corner_cos: float = 0.5,
) -> str:
    """Open polyline → M + C/L (no Z). Used for shared Vector-Graph cracks."""
    if not pts or len(pts) < 2:
        return ""
    ring = [(float(p[0]), float(p[1])) for p in pts]
    # Dedup consecutive
    cleaned: List[Point] = [ring[0]]
    for p in ring[1:]:
        if math.hypot(p[0] - cleaned[-1][0], p[1] - cleaned[-1][1]) > 0.05:
            cleaned.append(p)
    if len(cleaned) < 2:
        return ""
    if len(cleaned) == 2:
        a, b = cleaned
        # Smooth cubic along the chord (not a 1px stair of L's).
        dist = math.hypot(b[0] - a[0], b[1] - a[1]) / 3.0
        t = vnorm(vsub(b, a))
        c1 = vadd(a, vscale(t, dist))
        c2 = vsub(b, vscale(t, dist))
        return _cubic_path_d([[a, c1, c2, b]], scale_x, scale_y, False)
    # Corner splits on open chain (not wrapping). Skip leftover pixel stairs.
    n = len(cleaned)
    corners = sorted(_open_corners(cleaned, corner_cos, min_leg=4.2))
    splits = [0] + corners + [n - 1]
    # unique sorted
    splits = sorted(set(splits))
    cubics = []
    for s in range(len(splits) - 1):
        i0, i1 = splits[s], splits[s + 1]
        seg = cleaned[i0 : i1 + 1]
        if len(seg) < 2:
            continue
        sharp_s = i0 in corners or i0 == 0
        sharp_e = i1 in corners or i1 == n - 1
        t1 = vnorm(vsub(seg[1], seg[0]))
        t2 = vnorm(vsub(seg[-2], seg[-1]))
        if not sharp_s and i0 > 0:
            t1 = _tangent_at(cleaned, i0, False)
        if not sharp_e and i1 < n - 1:
            t2 = vscale(_tangent_at(cleaned, i1, False), -1)
        cubics.extend(_fit_segment(seg, t1, t2, error, 0))
    if not cubics:
        d = f"M {fmt(cleaned[0][0] * scale_x)} {fmt(cleaned[0][1] * scale_y)}"
        for p in cleaned[1:]:
            d += f" L {fmt(p[0] * scale_x)} {fmt(p[1] * scale_y)}"
        return d
    cubics = g1_fair_cubics(cubics, corner_cos=max(0.2, corner_cos - 0.15), closed=False)
    return _cubic_path_d(cubics, scale_x, scale_y, False)


def reverse_open_path_d(d: str) -> str:
    """Reverse an open M/C/L path so shared cracks can be reused by the neighbor."""
    if not d or "M" not in d:
        return d
    # Parse into cubics/lines ending at absolute points
    tokens = _re.findall(
        r"[MmLlCc]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?",
        d,
    )
    if not tokens:
        return d
    i = 0
    cx = cy = 0.0
    segs = []  # each: ("L", x,y) or ("C", x1,y1,x2,y2,x,y) with absolute ends
    start = None
    while i < len(tokens):
        t = tokens[i]
        if t in ("M", "m"):
            i += 1
            x = float(tokens[i]); y = float(tokens[i + 1]); i += 2
            if t == "m" and start is not None:
                x += cx; y += cy
            cx, cy = x, y
            start = (cx, cy)
        elif t in ("L", "l"):
            i += 1
            x = float(tokens[i]); y = float(tokens[i + 1]); i += 2
            if t == "l":
                x += cx; y += cy
            segs.append(("L", cx, cy, x, y))
            cx, cy = x, y
        elif t in ("C", "c"):
            i += 1
            nums = [float(tokens[i + k]) for k in range(6)]
            i += 6
            if t == "c":
                nums[0] += cx; nums[1] += cy
                nums[2] += cx; nums[3] += cy
                nums[4] += cx; nums[5] += cy
            segs.append(("C", cx, cy, nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]))
            cx, cy = nums[4], nums[5]
        else:
            i += 1
    if not segs:
        return d
    # Reverse
    out = []
    # New start = old end
    last = segs[-1]
    if last[0] == "L":
        sx, sy = last[3], last[4]
    else:
        sx, sy = last[7], last[8]
    out.append(f"M {fmt(sx)} {fmt(sy)}")
    for seg in reversed(segs):
        if seg[0] == "L":
            # seg: L x0 y0 x1 y1 — reverse goes to x0,y0
            out.append(f"L {fmt(seg[1])} {fmt(seg[2])}")
        else:
            # C x0 y0  c1x c1y  c2x c2y  x1 y1
            # reverse: from x1 to x0 with handles c2 then c1
            _x0, _y0, c1x, c1y, c2x, c2y, x1, y1 = seg[1:]
            out.append(
                f"C {fmt(c2x)} {fmt(c2y)} {fmt(c1x)} {fmt(c1y)} {fmt(_x0)} {fmt(_y0)}"
            )
    return " ".join(out)


def reverse_closed_path_d(d: str) -> str:
    """Reverse a closed M/C/L/Z path so the neighbor reuses the same cubics."""
    if not d or "M" not in d:
        return d
    s = d.strip()
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1].strip()
    rev = reverse_open_path_d(s)
    if not rev:
        return d
    if not rev.rstrip().endswith("Z") and not rev.rstrip().endswith("z"):
        rev = rev + " Z"
    return rev


# --- Geometric primitives (logo-quality circles / ellipses / triangles) ------

KAPPA = 0.5522847498307936


def _ellipse_d(cx: float, cy: float, rx: float, ry: float, sx: float, sy: float) -> str:
    k = KAPPA
    def P(x, y):
        return f"{fmt((cx + x) * sx)} {fmt((cy + y) * sy)}"
    return (
        f"M {P(rx, 0)}"
        f" C {P(rx, k * ry)} {P(k * rx, ry)} {P(0, ry)}"
        f" C {P(-k * rx, ry)} {P(-rx, k * ry)} {P(-rx, 0)}"
        f" C {P(-rx, -k * ry)} {P(-k * rx, -ry)} {P(0, -ry)}"
        f" C {P(k * rx, -ry)} {P(rx, -k * ry)} {P(rx, 0)} Z"
    )


def _poly_d(pts: Sequence[Point], sx: float, sy: float) -> str:
    d = f"M {fmt(pts[0][0] * sx)} {fmt(pts[0][1] * sy)}"
    for p in pts[1:]:
        d += f" L {fmt(p[0] * sx)} {fmt(p[1] * sy)}"
    return d + " Z"


def circularity(pts: Sequence[Point]) -> float:
    a = abs(ring_area(pts))
    if a < 1e-6:
        return 0.0
    n = len(pts)
    peri = 0.0
    for i in range(n):
        j = (i + 1) % n
        peri += math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1])
    if peri < 1e-6:
        return 0.0
    return 4.0 * math.pi * a / (peri * peri)


def try_circle(pts: Sequence[Point], sx: float, sy: float, min_r: float = 4.0) -> Optional[str]:
    if len(pts) < 6:
        return None
    circ = circularity(pts)
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    rs = [math.hypot(p[0] - cx, p[1] - cy) for p in pts]
    r = sum(rs) / len(rs)
    if r < min_r:
        return None
    # Small discs (pupils, antenna knobs) are staircased; large organic flanks
    # must stay cubics. True Canva circles (bee head/wings) sit at circ≥0.90.
    if r < 16.0:
        if circ < 0.64:
            return None
    elif circ < 0.72:
        return None
    if r >= 22.0 and circ < 0.90:
        return None
    mean = r
    var = sum((x - mean) ** 2 for x in rs) / len(rs)
    rms_abs = math.sqrt(var)
    rms = rms_abs / mean
    # High circularity: allow ~1 px AA jitter so Canva discs become 4 cubics.
    # Lower circularity: keep tight so puma flanks stay organic.
    if circ >= 0.90:
        if rms_abs > 1.15 and rms > 0.12:
            return None
    elif circ >= 0.82:
        if rms_abs > 0.80 and rms > 0.09:
            return None
    else:
        if rms > 0.07 or rms_abs > 0.70:
            return None
    return _ellipse_d(cx, cy, r, r, sx, sy)


def try_ellipse(pts: Sequence[Point], sx: float, sy: float) -> Optional[str]:
    if len(pts) < 10:
        return None
    circ = circularity(pts)
    # Below a confident circle (caller tries circle first). 0.93+ is a disc.
    # Organic mascot flanks sit well under 0.66 after fairing.
    if circ < 0.66 or circ >= 0.93:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    cx = sum(xs) / len(xs)
    cy = sum(ys) / len(ys)
    # PCA radii
    xx = xy = yy = 0.0
    n = len(pts)
    for x, y in pts:
        dx, dy = x - cx, y - cy
        xx += dx * dx
        xy += dx * dy
        yy += dy * dy
    xx /= n
    xy /= n
    yy /= n
    tr = xx + yy
    det = xx * yy - xy * xy
    disc = max(0.0, tr * tr / 4 - det)
    l1 = tr / 2 + math.sqrt(disc)
    l2 = tr / 2 - math.sqrt(disc)
    rx = math.sqrt(max(l1, 1e-6)) * 2.0  # 2-sigma ~ bounding
    ry = math.sqrt(max(l2, 1e-6)) * 2.0
    # Refine: mean projection onto axes
    if abs(xy) > 1e-9 or abs(xx - yy) > 1e-9:
        # Only accept axis-aligned-ish ellipses (logo wings/body). Rotated handled by cubics.
        ang = 0.5 * math.atan2(2 * xy, xx - yy)
        if abs(math.sin(2 * ang)) > 0.35:
            return None
    minx, miny, maxx, maxy = ring_bbox(pts)
    rx = (maxx - minx) * 0.5
    ry = (maxy - miny) * 0.5
    cx = (minx + maxx) * 0.5
    cy = (miny + maxy) * 0.5
    if rx < 5 or ry < 5:
        return None
    aspect = max(rx, ry) / max(1e-6, min(rx, ry))
    if aspect > 3.2:
        return None
    # Residual vs ellipse
    err = 0.0
    for x, y in pts:
        nx = (x - cx) / rx
        ny = (y - cy) / ry
        err += abs(nx * nx + ny * ny - 1.0)
    if err / n > 0.18:
        return None
    return _ellipse_d(cx, cy, rx, ry, sx, sy)


def try_triangle(pts: Sequence[Point], sx: float, sy: float) -> Optional[str]:
    if len(pts) < 6:
        return None
    simp = simplify_closed(pts, max(1.2, math.sqrt(abs(ring_area(pts))) * 0.08))
    if len(simp) != 3:
        # try a bit looser
        simp = simplify_closed(pts, max(1.8, math.sqrt(abs(ring_area(pts))) * 0.14))
    if len(simp) != 3:
        return None
    a = abs(ring_area(simp))
    a0 = abs(ring_area(pts))
    if a0 < 20 or a < a0 * 0.78:
        return None
    return _poly_d(simp, sx, sy)


def try_rect(pts: Sequence[Point], sx: float, sy: float) -> Optional[str]:
    if len(pts) < 6:
        return None
    minx, miny, maxx, maxy = ring_bbox(pts)
    bw, bh = maxx - minx, maxy - miny
    if bw < 6 or bh < 4:
        return None
    a = abs(ring_area(pts))
    rect_a = bw * bh
    if rect_a < 1 or a / rect_a < 0.90:
        return None
    # Check axis-aligned-ness: most edges near axis
    n = len(pts)
    axis = 0
    hug = 0
    for i in range(n):
        j = (i + 1) % n
        dx = abs(pts[j][0] - pts[i][0])
        dy = abs(pts[j][1] - pts[i][1])
        if dx < 1.05 or dy < 1.05:
            axis += 1
        x, y = pts[i]
        if min(abs(x - minx), abs(x - maxx), abs(y - miny), abs(y - maxy)) < 1.15:
            hug += 1
    if axis / n < 0.70:
        return None
    # True rect rings hug the bbox; curved bars (bee stripes) do not.
    if hug / n < 0.72:
        return None
    # Reject near-square blobs that are actually round badges (circle wins first).
    aspect = max(bw, bh) / max(1e-6, min(bw, bh))
    if aspect < 1.12 and circularity(pts) >= 0.78:
        return None
    return _poly_d([(minx, miny), (maxx, miny), (maxx, maxy), (minx, maxy)], sx, sy)


def prepare_contour(
    pts: Sequence[Point],
    *,
    inflate: float = 0.0,
    spacing: float = 0.7,
    simplify_eps: float = 0.28,
    logo: bool = False,
    sharp: bool = False,
    kind: Optional[str] = None,
) -> Optional[List[Point]]:
    """Fair a closed ring. kind: letter | fair | sharp | logo | overlay | None."""
    if kind == "logo":
        logo = True
    if kind == "sharp":
        sharp = True
    if kind == "letter":
        ring = destaircase(pts, max_leg=1.25)
        if len(ring) < 3:
            return None
        ring = resample_closed(ring, 0.38)
        ring = chaikin(ring, 1, 0.55)
        ring = destaircase(ring, max_leg=1.25)
        ring = simplify_closed(ring, min(simplify_eps, 0.07))
        ring = resample_closed(ring, min(spacing, 0.42))
        ring = laplacian_smooth(ring, 1, 0.07)
    elif kind == "fair":
        ring = destaircase(pts, max_leg=14.0)
        if len(ring) < 3:
            return None
        ring = resample_closed(ring, 0.85)
        ring = chaikin(ring, 3, -0.65)
        ring = destaircase(ring, max_leg=14.0)
        ring = simplify_closed(ring, max(simplify_eps, 0.42))
        ring = resample_closed(ring, max(spacing, 0.90))
        ring = laplacian_smooth(ring, 4, 0.44)
    elif kind == "overlay":
        ring = destaircase(pts, max_leg=5.5)
        if len(ring) < 3:
            return None
        ring = resample_closed(ring, 0.48)
        ring = chaikin(ring, 2, -0.08)
        ring = destaircase(ring, max_leg=5.5)
        ring = simplify_closed(ring, min(simplify_eps, 0.16))
        ring = resample_closed(ring, min(spacing, 0.52))
        ring = laplacian_smooth(ring, 2, 0.22)
    elif logo:
        # Identical-line logos: destair pixel jogs only; do not melt corners.
        ring = destaircase(pts, max_leg=2.4)
        if len(ring) < 3:
            return None
        ring = resample_closed(ring, 0.50)
        ring = chaikin(ring, 1, 0.18)
        ring = destaircase(ring, max_leg=2.4)
        ring = simplify_closed(ring, min(simplify_eps, 0.16))
        ring = resample_closed(ring, min(spacing, 0.52))
        ring = laplacian_smooth(ring, 1, 0.12)
    else:
        # Gothic lettering / pine tips: destaircase only tiny pixel jogs, keep spikes.
        ring = destaircase(pts, max_leg=2.6 if sharp else 8.5)
        if len(ring) < 3:
            return None
        ring = resample_closed(ring, 0.50 if sharp else 0.7)
        if sharp:
            ring = chaikin(ring, 1, 0.12)
        else:
            ring = chaikin(ring, 1, -0.28)
        ring = destaircase(ring, max_leg=2.6 if sharp else 8.5)
        eps = simplify_eps
        if sharp:
            eps = min(simplify_eps, 0.14)
        ring = simplify_closed(ring, eps)
        ring = resample_closed(ring, spacing)
        if sharp:
            ring = laplacian_smooth(ring, 1, 0.14)
        else:
            ring = laplacian_smooth(ring, 2, 0.28)
    if not ring or len(ring) < 4:
        return None
    if inflate:
        ring = inflate_ring(ring, inflate)
    return ring


def path_from_ring(
    pts: Sequence[Point],
    sx: float,
    sy: float,
    *,
    error: float = 0.75,
    corner_cos: float = 0.5,
    logo: bool = False,
    min_area: float = 2.5,
    sharp: bool = False,
    kind: Optional[str] = None,
) -> Optional[str]:
    if not pts or len(pts) < 3:
        return None
    if abs(ring_area(pts)) < min_area:
        return None
    if kind == "logo":
        logo = True
    if kind == "sharp":
        sharp = True
    if logo:
        d = try_circle(pts, sx, sy) or try_ellipse(pts, sx, sy) or try_triangle(pts, sx, sy) or try_rect(pts, sx, sy)
        if d:
            return d
    if kind == "letter":
        err = min(error, 0.22)
        ccos = max(corner_cos, 0.70)
    elif kind == "fair":
        err = max(error, 1.05)
        ccos = min(corner_cos, 0.12)
    elif kind == "overlay":
        err = min(error, 0.38)
        ccos = max(corner_cos, 0.40)
    else:
        err = min(error, 0.38) if sharp else error
        ccos = max(corner_cos, 0.55) if sharp else corner_cos
    return fit_cubic_path(pts, sx, sy, error=err, corner_cos=ccos)


# --- SVG path sample / fair / primitive polish (post-trace) -----------------

import re as _re


def _cubic_sample(p0: Point, p1: Point, p2: Point, p3: Point, n: int = 8) -> List[Point]:
    out: List[Point] = []
    for i in range(n):
        t = i / float(n)
        out.append(_cubic_point(p0, p1, p2, p3, t))
    return out


def sample_path_d(d: str, *, curve_samples: int = 6) -> List[List[Point]]:
    """Approximate SVG path `d` into closed/open rings (pixel or viewBox units)."""
    if not d:
        return []
    tokens = _re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", d)
    if not tokens:
        return []
    rings: List[List[Point]] = []
    cur: List[Point] = []
    cx = cy = 0.0
    start = (0.0, 0.0)
    i = 0
    cmd = "M"

    def _num():
        nonlocal i
        if i >= len(tokens):
            raise StopIteration
        v = float(tokens[i])
        i += 1
        return v

    try:
        while i < len(tokens):
            t = tokens[i]
            if _re.match(r"[A-Za-z]", t):
                cmd = t
                i += 1
            elif cmd == "Z" or cmd == "z":
                cmd = "L"
            # implicit repeat of prior command
            if cmd in ("M", "m"):
                if cur and len(cur) >= 3:
                    rings.append(cur)
                x, y = _num(), _num()
                if cmd == "m":
                    x += cx
                    y += cy
                cx, cy = x, y
                start = (cx, cy)
                cur = [(cx, cy)]
                cmd = "l" if cmd == "m" else "L"
            elif cmd in ("L", "l"):
                x, y = _num(), _num()
                if cmd == "l":
                    x += cx
                    y += cy
                cx, cy = x, y
                cur.append((cx, cy))
            elif cmd in ("H", "h"):
                x = _num()
                if cmd == "h":
                    x += cx
                cx = x
                cur.append((cx, cy))
            elif cmd in ("V", "v"):
                y = _num()
                if cmd == "v":
                    y += cy
                cy = y
                cur.append((cx, cy))
            elif cmd in ("C", "c"):
                x1, y1 = _num(), _num()
                x2, y2 = _num(), _num()
                x, y = _num(), _num()
                if cmd == "c":
                    x1 += cx
                    y1 += cy
                    x2 += cx
                    y2 += cy
                    x += cx
                    y += cy
                p0 = (cx, cy)
                samples = _cubic_sample(p0, (x1, y1), (x2, y2), (x, y), max(3, curve_samples))
                cur.extend(samples[1:])
                cur.append((x, y))
                cx, cy = x, y
            elif cmd in ("Q", "q"):
                x1, y1 = _num(), _num()
                x, y = _num(), _num()
                if cmd == "q":
                    x1 += cx
                    y1 += cy
                    x += cx
                    y += cy
                # elevate quadratic → cubic
                p0 = (cx, cy)
                c1 = (p0[0] + 2.0 / 3.0 * (x1 - p0[0]), p0[1] + 2.0 / 3.0 * (y1 - p0[1]))
                c2 = (x + 2.0 / 3.0 * (x1 - x), y + 2.0 / 3.0 * (y1 - y))
                samples = _cubic_sample(p0, c1, c2, (x, y), max(3, curve_samples))
                cur.extend(samples[1:])
                cur.append((x, y))
                cx, cy = x, y
            elif cmd in ("S", "s"):
                # smooth cubic — reflect prior control if unknown use current
                x2, y2 = _num(), _num()
                x, y = _num(), _num()
                if cmd == "s":
                    x2 += cx
                    y2 += cy
                    x += cx
                    y += cy
                x1, y1 = cx, cy
                p0 = (cx, cy)
                samples = _cubic_sample(p0, (x1, y1), (x2, y2), (x, y), max(3, curve_samples))
                cur.extend(samples[1:])
                cur.append((x, y))
                cx, cy = x, y
            elif cmd in ("Z", "z"):
                if cur and len(cur) >= 3:
                    if math.hypot(cur[0][0] - cur[-1][0], cur[0][1] - cur[-1][1]) > 0.5:
                        cur.append(cur[0])
                    rings.append(cur)
                cur = []
                cx, cy = start
            else:
                # unsupported (A/a/T/t) — skip one number pair best-effort
                try:
                    _num()
                    _num()
                except StopIteration:
                    break
    except (StopIteration, ValueError, IndexError):
        pass
    if cur and len(cur) >= 3:
        rings.append(cur)
    return rings


def fair_ring_corners(
    pts: Sequence[Point],
    *,
    kind: str = "fair",
    try_primitives: bool = True,
) -> Optional[str]:
    """
    Corner-preserving fair + optional primitive replace.
    Returns a fresh path `d` in the same coordinate space as `pts`, or None
    if the ring is too small / unfit to change.
    """
    ring = clean_ring(pts, 0.15)
    if len(ring) < 6:
        return None
    area = abs(ring_area(ring))
    if area < 8.0:
        return None

    if try_primitives:
        # Strict confidence: only replace when geom helpers are sure.
        prim = (
            try_circle(ring, 1.0, 1.0, min_r=6.0)
            or try_ellipse(ring, 1.0, 1.0)
            or try_rect(ring, 1.0, 1.0)
        )
        if prim:
            return prim

    prepared = prepare_contour(
        ring,
        kind=kind if kind in ("logo", "fair", "letter", "overlay", "sharp") else "fair",
        spacing=0.85 if kind == "fair" else 0.55,
        simplify_eps=0.35 if kind == "fair" else 0.18,
    )
    if not prepared or len(prepared) < 4:
        return None
    # Reject if fairing collapsed area too much (melted detail).
    if abs(ring_area(prepared)) < area * 0.72:
        return None
    k = kind if kind in ("logo", "fair", "letter", "overlay", "sharp") else "fair"
    # path_from_ring already tries primitives when kind/logo — disable by using fair kind
    # when caller asked not to replace with primitives after fairing.
    fit_kind = k if try_primitives else ("fair" if k == "logo" else k)
    return path_from_ring(
        prepared,
        1.0,
        1.0,
        kind=fit_kind,
        min_area=4.0,
        logo=False if not try_primitives else (k == "logo"),
    )


def polish_path_d(
    d: str,
    *,
    kind: str = "fair",
    try_primitives: bool = True,
    min_area: float = 0.0,
) -> str:
    """Fair + optional primitive-fit each closed subpath; keep original if weak.

    Coordinates may be pixels (vtracer) or inches (potrace) — thresholds scale
    from the path's own bbox so both work.
    """
    # Compound evenodd paths (holes / shared-seam assemblies): do not
    # independently fair each subpath — that opens hairlines and melts
    # logo outlines. Primitive-swap only fires on simple single rings.
    n_moves = len(_re.findall(r"[Mm]", d))
    if n_moves > 1 and kind in ("logo", "fair"):
        return d
    rings = sample_path_d(d, curve_samples=5)
    if not rings:
        return d
    # Adaptive scale from overall bbox diagonal.
    all_pts = [pt for ring in rings for pt in ring]
    if len(all_pts) < 3:
        return d
    minx, miny, maxx, maxy = ring_bbox(all_pts)
    diag = math.hypot(maxx - minx, maxy - miny) or 1.0
    # Skip flecks smaller than ~0.15% of diag^2; fair shapes above ~0.4%.
    area_floor = min_area if min_area > 0 else (diag * diag) * 1.5e-5
    fair_floor = (diag * diag) * 4.0e-5
    # Destaircase / spacing in prepare_contour is pixel-oriented; scale for inches.
    # If bbox is small (< 40), treat as inch-space and upsample rings for fairing.
    inch_space = diag < 40.0
    parts: List[str] = []
    changed = False
    for ring in rings:
        ring = clean_ring(ring, 0.02 if inch_space else 0.12)
        area = abs(ring_area(ring))
        if len(ring) < 6 or area < area_floor:
            # Flecks: leave the original path alone rather than invent crumbs.
            return d
        # Work in a normalized pixel-ish space for fairing when coords are inches.
        scale_up = (80.0 / diag) if inch_space else 1.0
        work = [(p[0] * scale_up, p[1] * scale_up) for p in ring] if scale_up != 1.0 else ring
        # Stair-step heuristic: lots of axis-aligned short legs → fair harder.
        n = len(work)
        axis = 0
        ax_eps = 0.9 if scale_up == 1.0 else 0.9
        for i in range(n):
            j = (i + 1) % n
            dx = abs(work[j][0] - work[i][0])
            dy = abs(work[j][1] - work[i][1])
            if (dx < ax_eps and dy >= 0.4) or (dy < ax_eps and dx >= 0.4):
                axis += 1
        use_kind = kind
        if axis / max(1, n) > 0.45:
            use_kind = "fair"
        elif kind == "logo":
            use_kind = "logo"

        new_d = None
        min_r = 6.0 if scale_up == 1.0 else max(4.0, 6.0)
        if try_primitives and area >= fair_floor:
            new_d = (
                try_circle(work, 1.0, 1.0, min_r=min_r)
                or try_ellipse(work, 1.0, 1.0)
                or try_rect(work, 1.0, 1.0)
            )
        if not new_d and area >= fair_floor:
            if use_kind == "logo":
                # Logos: destaircase only — heavy fair melts intentional geometry.
                prepared = prepare_contour(work, kind="logo")
            else:
                prepared = prepare_contour(work, kind=use_kind)
            if prepared and abs(ring_area(prepared)) >= abs(ring_area(work)) * 0.72:
                new_d = path_from_ring(
                    prepared,
                    1.0,
                    1.0,
                    kind=use_kind,
                    min_area=2.0,
                    logo=(use_kind == "logo"),
                )
        if new_d and "M" in new_d:
            if scale_up != 1.0:
                # Scale path numbers back to inch space.
                def _scale_num(m):
                    return m.group(1) + fmt(float(m.group(2)) / scale_up) 
                new_d = _re.sub(r"([\s,])([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)", _scale_num, " " + new_d).strip()
            parts.append(new_d)
            changed = True
        else:
            # Fallback: corner-aware cubic re-fit without heavy fairing
            refit = fit_cubic_path(work, 1.0, 1.0, error=0.65, corner_cos=0.42)
            if refit:
                if scale_up != 1.0:
                    def _scale_num2(m):
                        return m.group(1) + fmt(float(m.group(2)) / scale_up)
                    refit = _re.sub(r"([\s,])([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)", _scale_num2, " " + refit).strip()
                parts.append(refit)
                changed = True
            else:
                return d
    if not changed or not parts:
        return d
    # Join subpaths (compound path)
    return " ".join(p for p in parts if p)


def polish_svg_paths(
    svg_text: str,
    *,
    kind: str = "fair",
    try_primitives: bool = True,
    max_paths: int = 4000,
) -> Tuple[str, dict]:
    """
    Post-trace corner cleanup + curve fairing on every <path d="...">.
    Primitive fitting only when confident. Returns (svg, stats).
    """
    stats = {"polished": 0, "skipped": 0, "primitives": 0, "paths": 0}
    if not svg_text or "<path" not in svg_text:
        return svg_text, stats

    count = 0

    def repl(m: "_re.Match[str]") -> str:
        nonlocal count
        count += 1
        stats["paths"] += 1
        if count > max_paths:
            stats["skipped"] += 1
            return m.group(0)
        prefix, d, suffix = m.group(1), m.group(2), m.group(3)
        before = d
        # Detect if original already looks like a clean 4-cubic circle/ellipse
        # (skip) — cheap length gate
        if len(d) < 24:
            stats["skipped"] += 1
            return m.group(0)
        new_d = polish_path_d(d, kind=kind, try_primitives=try_primitives)
        if not new_d or new_d == before:
            stats["skipped"] += 1
            return m.group(0)
        stats["polished"] += 1
        # crude primitive detection: ellipse kappa path has exactly 4 C commands
        if try_primitives and new_d.count(" C ") == 4 and "L " not in new_d:
            # could be circle/ellipse replacement
            rings = sample_path_d(before, curve_samples=4)
            if rings and circularity(clean_ring(rings[0])) >= 0.70:
                stats["primitives"] += 1
        return f'{prefix}{new_d}{suffix}'

    out = _re.sub(r'(<path\b[^>]*\bd=")([^"]+)(")', repl, svg_text)
    return out, stats
