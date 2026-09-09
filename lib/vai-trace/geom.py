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


def destaircase(pts: Sequence[Point], max_leg: float = 8.5) -> List[Point]:
    if not pts or len(pts) < 4:
        return [(float(p[0]), float(p[1])) for p in pts]
    ring = clean_ring(pts, 0.15)
    for _ in range(16):
        n = len(ring)
        if n < 4:
            break
        keep: List[Point] = []
        dropped = 0
        for i in range(n):
            a = ring[(i - 1) % n]
            b = ring[i]
            c = ring[(i + 1) % n]
            abx, aby = b[0] - a[0], b[1] - a[1]
            bcx, bcy = c[0] - b[0], c[1] - b[1]
            axis_ab = (abs(abx) < 0.85 and abs(aby) >= 0.35) or (abs(aby) < 0.85 and abs(abx) >= 0.35)
            axis_bc = (abs(bcx) < 0.85 and abs(bcy) >= 0.35) or (abs(bcy) < 0.85 and abs(bcx) >= 0.35)
            turned = (abs(abx) < 0.85 and abs(bcy) < 0.85) or (abs(aby) < 0.85 and abs(bcx) < 0.85)
            short = math.hypot(abx, aby) <= max_leg and math.hypot(bcx, bcy) <= max_leg
            if axis_ab and axis_bc and turned and short:
                dropped += 1
                continue
            keep.append(b)
        if not dropped or len(keep) < 3:
            break
        ring = keep
    return ring


def chaikin(pts: Sequence[Point], rounds: int = 1, sharp_cos: float = -0.25) -> List[Point]:
    ring = [(float(p[0]), float(p[1])) for p in pts]
    for _ in range(max(0, rounds)):
        n = len(ring)
        if n < 4:
            break
        sharp = [False] * n
        for i in range(n):
            a, b, c = ring[(i - 1) % n], ring[i], ring[(i + 1) % n]
            v1 = vsub(b, a)
            v2 = vsub(c, b)
            l1, l2 = vlen(v1) or 1.0, vlen(v2) or 1.0
            cos = vdot(v1, v2) / (l1 * l2)
            if cos < sharp_cos and l1 > 1.2 and l2 > 1.2:
                sharp[i] = True
        out: List[Point] = []
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            if sharp[i]:
                out.append(a)
                out.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
            else:
                out.append((a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25))
                out.append((a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75))
        ring = out
    return ring


def laplacian_smooth(pts: Sequence[Point], iters: int = 2, lam: float = 0.32) -> List[Point]:
    ring = [(float(p[0]), float(p[1])) for p in pts]
    for _ in range(iters):
        n = len(ring)
        if n < 4:
            break
        out = [None] * n
        for i in range(n):
            prev, pt, nxt = ring[(i - 1) % n], ring[i], ring[(i + 1) % n]
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
    for i in range(n):
        hit = False
        for k in spans:
            prev = ring[(i - k) % n]
            cur = ring[i]
            nxt = ring[(i + k) % n]
            raw1 = vsub(cur, prev)
            raw2 = vsub(nxt, cur)
            if vlen(raw1) < 6 or vlen(raw2) < 6:
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
    d = f"M {fmt(cubics[0][0][0] * scale_x)} {fmt(cubics[0][0][1] * scale_y)}"
    for b in cubics:
        d += (
            f" C {fmt(b[1][0] * scale_x)} {fmt(b[1][1] * scale_y)}"
            f" {fmt(b[2][0] * scale_x)} {fmt(b[2][1] * scale_y)}"
            f" {fmt(b[3][0] * scale_x)} {fmt(b[3][1] * scale_y)}"
        )
    return d + " Z"


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
    if len(pts) < 8:
        return None
    circ = circularity(pts)
    if circ < 0.80:
        return None
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    rs = [math.hypot(p[0] - cx, p[1] - cy) for p in pts]
    r = sum(rs) / len(rs)
    if r < min_r:
        return None
    mean = r
    var = sum((x - mean) ** 2 for x in rs) / len(rs)
    if math.sqrt(var) / mean > 0.07:
        return None
    return _ellipse_d(cx, cy, r, r, sx, sy)


def try_ellipse(pts: Sequence[Point], sx: float, sy: float) -> Optional[str]:
    if len(pts) < 10:
        return None
    circ = circularity(pts)
    if circ < 0.70 or circ >= 0.80:
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
    if rect_a < 1 or a / rect_a < 0.88:
        return None
    # Check axis-aligned-ness: most edges near axis
    n = len(pts)
    axis = 0
    for i in range(n):
        j = (i + 1) % n
        dx = abs(pts[j][0] - pts[i][0])
        dy = abs(pts[j][1] - pts[i][1])
        if dx < 0.9 or dy < 0.9:
            axis += 1
    if axis / n < 0.7:
        return None
    return _poly_d([(minx, miny), (maxx, miny), (maxx, maxy), (minx, maxy)], sx, sy)


def prepare_contour(
    pts: Sequence[Point],
    *,
    inflate: float = 0.0,
    spacing: float = 0.7,
    simplify_eps: float = 0.28,
    logo: bool = False,
) -> Optional[List[Point]]:
    ring = destaircase(pts)
    if len(ring) < 3:
        return None
    ring = resample_closed(ring, 0.9 if logo else 0.7)
    ring = chaikin(ring, 2 if logo else 1, -0.08 if logo else -0.28)
    ring = destaircase(ring)
    ring = simplify_closed(ring, simplify_eps if not logo else max(simplify_eps, 0.45))
    ring = resample_closed(ring, spacing)
    ring = laplacian_smooth(ring, 2, 0.34 if logo else 0.28)
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
) -> Optional[str]:
    if not pts or len(pts) < 3:
        return None
    if abs(ring_area(pts)) < min_area:
        return None
    if logo:
        d = try_circle(pts, sx, sy) or try_ellipse(pts, sx, sy) or try_triangle(pts, sx, sy) or try_rect(pts, sx, sy)
        if d:
            return d
    return fit_cubic_path(pts, sx, sy, error=error, corner_cos=corner_cos)
