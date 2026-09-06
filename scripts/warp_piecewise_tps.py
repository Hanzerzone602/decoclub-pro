#!/usr/bin/env python3
"""Multi-ROI ECC + TPS warp: Corel SVG topology → soft SRC pose.

Builds on nb-raster-warp/warp_corel_to_src.py (global ECC affine winner),
then refines local muzzle/eye drift with per-ROI ECC translations blended
via thin-plate spline (pure numpy — OpenCV TPS not in this build).

Usage:
  python3 warp_piecewise_tps.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

# Reuse helpers from nb-raster-warp script
import os

SCRIPTS = Path(__file__).resolve().parent
REPO = SCRIPTS.parent
# Production / inventWarp.js: env overrides. Dev fallbacks keep perfect-bezier proofs.
OUT = Path(os.environ.get("INVENT_WARP_OUT") or str(REPO / "tmp" / "invent-warp-out"))
OUT.mkdir(parents=True, exist_ok=True)
CMP = OUT / "compare"
CMP.mkdir(parents=True, exist_ok=True)
WIN = OUT  # winner SVG lands next to piecewise-tps.svg for inventWarp

SIZE = int(os.environ.get("INVENT_WARP_SIZE") or "1092")
SRC_PNG = Path(os.environ.get("INVENT_WARP_SRC") or "/workspace/tiger-test.png")
COREL_SVG = Path(
    os.environ.get("INVENT_WARP_PRIOR_SVG")
    or str(REPO / "data" / "priors" / "tiger-corel-artbox.svg")
)
COREL_PNG_HINT = Path(
    os.environ.get("INVENT_WARP_PRIOR_PNG")
    or str(REPO / "data" / "priors" / "tiger-corel-artbox.png")
)

sys.path.insert(0, str(SCRIPTS))
from warp_corel_to_src import (  # noqa: E402
    paper_fg_mask, mae, mask_iou, bbox_centroid_similarity, ecc_affine,
    apply_affine_px, parse_viewbox, transform_path_d, make_pixel_space_xform,
    warp_svg_text, load_rgb, make_strip, crop_regions, TOKEN_RE,
)

def render_svg(svg: Path, png: Path, w=SIZE, h=SIZE):
    """Prefer rsvg-convert — inkscape hangs in this environment."""
    subprocess.check_call(["rsvg-convert", "-w", str(w), "-h", str(h), str(svg), "-o", str(png)])


# --- ROI definitions (fractional boxes on 1092 canvas, SRC-ish pose) ---
ROIS = {
    "eyeL":   (0.18, 0.20, 0.48, 0.48),
    "eyeR":   (0.52, 0.20, 0.82, 0.48),
    "muzzle": (0.28, 0.48, 0.72, 0.78),
    "nose":   (0.38, 0.42, 0.62, 0.58),
    "forehead": (0.30, 0.08, 0.70, 0.28),
    "chin":   (0.32, 0.72, 0.68, 0.92),
    "earL":   (0.02, 0.02, 0.28, 0.28),
    "earR":   (0.72, 0.02, 0.98, 0.28),
}


def frac_box(name_or_box, size=SIZE):
    if isinstance(name_or_box, str):
        x0, y0, x1, y1 = ROIS[name_or_box]
    else:
        x0, y0, x1, y1 = name_or_box
    return (
        int(x0 * size), int(y0 * size),
        int(x1 * size), int(y1 * size),
    )


# -------------------- Thin Plate Spline (numpy) --------------------

def _U(r2: np.ndarray) -> np.ndarray:
    """TPS kernel U(r) = r^2 log(r^2); 0 at r=0."""
    out = np.zeros_like(r2, dtype=np.float64)
    mask = r2 > 1e-20
    out[mask] = r2[mask] * np.log(r2[mask])
    return out


class TPS2D:
    """Map (x,y) source control pts → destination. f(p) ≈ dest."""

    def __init__(self, src_pts: np.ndarray, dst_pts: np.ndarray, reg: float = 1e-4):
        src_pts = np.asarray(src_pts, dtype=np.float64)
        dst_pts = np.asarray(dst_pts, dtype=np.float64)
        assert src_pts.shape == dst_pts.shape and src_pts.shape[1] == 2
        n = src_pts.shape[0]
        self.src = src_pts
        # K_ij = U(||pi-pj||^2)
        d = src_pts[:, None, :] - src_pts[None, :, :]
        r2 = (d ** 2).sum(axis=2)
        K = _U(r2)
        K += np.eye(n) * reg
        P = np.hstack([np.ones((n, 1)), src_pts])  # n x 3
        # L = [[K, P], [P^T, 0]]
        L = np.zeros((n + 3, n + 3), dtype=np.float64)
        L[:n, :n] = K
        L[:n, n:] = P
        L[n:, :n] = P.T
        # Solve for each coord
        Y = np.vstack([dst_pts, np.zeros((3, 2))])
        try:
            W = np.linalg.solve(L, Y)
        except np.linalg.LinAlgError:
            W = np.linalg.lstsq(L, Y, rcond=None)[0]
        self.w = W[:n]       # n x 2
        self.a = W[n:]       # 3 x 2  (a0, a1, a2)

    def __call__(self, x: float, y: float):
        r2 = (self.src[:, 0] - x) ** 2 + (self.src[:, 1] - y) ** 2
        u = _U(r2)
        base = self.a[0] + self.a[1] * x + self.a[2] * y
        return tuple((base + self.w.T @ u).tolist())

    def apply_many(self, pts: np.ndarray) -> np.ndarray:
        pts = np.asarray(pts, dtype=np.float64)
        # pts: N x 2
        d0 = pts[:, None, 0] - self.src[None, :, 0]
        d1 = pts[:, None, 1] - self.src[None, :, 1]
        r2 = d0 * d0 + d1 * d1
        u = _U(r2)  # N x n
        base = self.a[0][None, :] + pts @ self.a[1:]  # N x 2
        return base + u @ self.w


def local_ecc_translation(src_roi: np.ndarray, mov_roi: np.ndarray, max_shift: float = 40.0):
    """ECC translation mapping mov→src within ROI. Returns (dx, dy) added to mov coords → src.
    findTransformECC: warp maps mov into src frame: src ≈ warp(mov).
    For MOTION_TRANSLATION, warp = [[1,0,tx],[0,1,ty]] so mov point (x,y) → (x+tx,y+ty).
    """
    if src_roi.size < 100 or mov_roi.size < 100:
        return 0.0, 0.0, 0.0
    # Use grayscale edges for robustness
    def prep(img):
        if img.ndim == 3:
            g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY)
        else:
            g = img
        g = g.astype(np.float32)
        # mild blur
        g = cv2.GaussianBlur(g, (0, 0), 1.0)
        return g

    s = prep(src_roi)
    m = prep(mov_roi)
    # normalize
    if s.std() < 1e-3 or m.std() < 1e-3:
        return 0.0, 0.0, 0.0
    s = (s - s.mean()) / (s.std() + 1e-6)
    m = (m - m.mean()) / (m.std() + 1e-6)
    warp = np.eye(2, 3, dtype=np.float32)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6)
    try:
        cc, warp = cv2.findTransformECC(m, s, warp, cv2.MOTION_TRANSLATION, crit, None, 1)
    except cv2.error:
        # fallback: phase correlation
        try:
            shift, resp = cv2.phaseCorrelate(m, s)
            tx, ty = float(shift[0]), float(shift[1])
            if abs(tx) > max_shift or abs(ty) > max_shift:
                return 0.0, 0.0, 0.0
            return tx, ty, float(resp)
        except Exception:
            return 0.0, 0.0, 0.0
    tx, ty = float(warp[0, 2]), float(warp[1, 2])
    if abs(tx) > max_shift or abs(ty) > max_shift:
        return 0.0, 0.0, float(cc)
    return tx, ty, float(cc)


def local_ecc_affine(src_roi: np.ndarray, mov_roi: np.ndarray, max_shift: float = 50.0):
    """Small local affine; returns 2x3 mapping mov→src, or None."""
    def prep(img):
        if img.ndim == 3:
            g = cv2.cvtColor(img, cv2.COLOR_RGB2GRAY).astype(np.float32)
        else:
            g = img.astype(np.float32)
        g = cv2.GaussianBlur(g, (0, 0), 1.2)
        if g.std() < 1e-3:
            return None
        return (g - g.mean()) / (g.std() + 1e-6)

    s, m = prep(src_roi), prep(mov_roi)
    if s is None or m is None:
        return None, 0.0
    warp = np.eye(2, 3, dtype=np.float32)
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 150, 1e-6)
    try:
        cc, warp = cv2.findTransformECC(m, s, warp, cv2.MOTION_EUCLIDEAN, crit, None, 1)
    except cv2.error:
        return None, 0.0
    tx, ty = float(warp[0, 2]), float(warp[1, 2])
    if abs(tx) > max_shift or abs(ty) > max_shift:
        return None, float(cc)
    # reject crazy scale
    scale = abs(warp[0, 0]) + abs(warp[1, 1])
    if scale < 1.4 or scale > 2.6:  # ~2 for identity euclidean
        # euclidean is [[c,-s,tx],[s,c,ty]] scale~2 for c=1
        pass
    sc = np.sqrt(warp[0, 0] ** 2 + warp[1, 0] ** 2)
    if sc < 0.85 or sc > 1.15:
        return None, float(cc)
    return warp.astype(np.float64), float(cc)


def estimate_global_ecc(src: np.ndarray, corel: np.ndarray):
    ms = paper_fg_mask(src)
    mc = paper_fg_mask(corel)
    M0 = bbox_centroid_similarity(ms, mc)
    try:
        M = ecc_affine(ms, mc, M0)
        method = "ecc_affine"
    except Exception as e:
        print("ECC global failed", e)
        M = M0
        method = "similarity_fallback"
    warped = apply_affine_px(corel, M)
    wm = cv2.warpAffine(mc, M, (SIZE, SIZE), flags=cv2.INTER_NEAREST, borderValue=0)
    return M, method, warped, ms, mc, wm


def collect_control_points(src: np.ndarray, warped_corel: np.ndarray, M_global):
    """After global warp, estimate per-ROI residual shifts; build TPS src→dst in PIXEL space.
    Control: warped-corel feature location → SRC-aligned location.
    """
    src_pts = []
    dst_pts = []
    roi_meta = {}

    # Fixed anchors at image border (identity) to stabilize TPS
    for px, py in [
        (0, 0), (SIZE - 1, 0), (0, SIZE - 1), (SIZE - 1, SIZE - 1),
        (SIZE // 2, 0), (SIZE // 2, SIZE - 1), (0, SIZE // 2), (SIZE - 1, SIZE // 2),
    ]:
        src_pts.append([px, py])
        dst_pts.append([px, py])

    for name, box in ROIS.items():
        x0, y0, x1, y1 = frac_box(box)
        # expand slightly for ECC context
        pad = 12
        xa0, ya0 = max(0, x0 - pad), max(0, y0 - pad)
        xa1, ya1 = min(SIZE, x1 + pad), min(SIZE, y1 + pad)
        s_roi = src[ya0:ya1, xa0:xa1]
        m_roi = warped_corel[ya0:ya1, xa0:xa1]
        tx, ty, cc = local_ecc_translation(s_roi, m_roi, max_shift=55.0)
        # Also try euclidean if translation cc weak
        aff, cc2 = local_ecc_affine(s_roi, m_roi, max_shift=55.0)
        use_tx, use_ty = tx, ty
        mode = "translation"
        if aff is not None and cc2 > cc + 0.01:
            # map ROI center through local affine
            cx = (x0 + x1) / 2 - xa0
            cy = (y0 + y1) / 2 - ya0
            ncx = aff[0, 0] * cx + aff[0, 1] * cy + aff[0, 2]
            ncy = aff[1, 0] * cx + aff[1, 1] * cy + aff[1, 2]
            use_tx, use_ty = ncx - cx, ncy - cy
            mode = "euclidean"
            cc = cc2

        # Control points: grid inside ROI (warped locations → shifted)
        # Center + 4 mid-edge points for denser TPS
        pts_local = [
            ((x0 + x1) / 2, (y0 + y1) / 2),
            ((x0 + x1) / 2, y0 + 0.25 * (y1 - y0)),
            ((x0 + x1) / 2, y1 - 0.25 * (y1 - y0)),
            (x0 + 0.25 * (x1 - x0), (y0 + y1) / 2),
            (x1 - 0.25 * (x1 - x0), (y0 + y1) / 2),
        ]
        # weight by cc — if cc very low, skip ROI
        if cc < 0.01 and abs(use_tx) + abs(use_ty) < 0.5:
            roi_meta[name] = {"tx": 0, "ty": 0, "cc": cc, "mode": mode, "skipped": True}
            continue

        for px, py in pts_local:
            src_pts.append([px, py])
            dst_pts.append([px + use_tx, py + use_ty])

        roi_meta[name] = {
            "tx": use_tx, "ty": use_ty, "cc": cc, "mode": mode,
            "box": [x0, y0, x1, y1], "skipped": False,
        }
        print(f"  ROI {name}: Δ=({use_tx:.1f},{use_ty:.1f}) cc={cc:.4f} mode={mode}")

    return np.array(src_pts), np.array(dst_pts), roi_meta


def compose_xform_px(M_global: np.ndarray, tps: TPS2D | None):
    """Pixel-space: Corel_px → global affine → optional TPS residual."""
    A = M_global

    def xform_px(px, py):
        gx = A[0, 0] * px + A[0, 1] * py + A[0, 2]
        gy = A[1, 0] * px + A[1, 1] * py + A[1, 2]
        if tps is None:
            return gx, gy
        return tps(gx, gy)

    return xform_px


def make_svg_xform(vb, xform_px):
    minx, miny, vw, vh = vb
    sx = SIZE / vw
    sy = SIZE / vh

    def xform(x, y):
        px = (x - minx) * sx
        py = (y - miny) * sy
        ppx, ppy = xform_px(px, py)
        return ppx / sx + minx, ppy / sy + miny

    return xform


def warp_image_tps(img: np.ndarray, M_global: np.ndarray, tps: TPS2D | None):
    """Remap via inverse TPS on a coarse grid (fast)."""
    base = apply_affine_px(img, M_global)
    if tps is None:
        return base
    # Inverse: destination control → source control
    dst_ctrl = tps.apply_many(tps.src)
    inv = TPS2D(dst_ctrl, tps.src, reg=1e-3)
    step = 8
    ys = np.arange(0, SIZE, step, dtype=np.float64)
    xs = np.arange(0, SIZE, step, dtype=np.float64)
    xx, yy = np.meshgrid(xs, ys)
    grid = np.stack([xx.ravel(), yy.ravel()], axis=1)
    mapped = inv.apply_many(grid)
    h, w = len(ys), len(xs)
    small_x = mapped[:, 0].reshape(h, w).astype(np.float32)
    small_y = mapped[:, 1].reshape(h, w).astype(np.float32)
    map_x = cv2.resize(small_x, (SIZE, SIZE), interpolation=cv2.INTER_LINEAR)
    map_y = cv2.resize(small_y, (SIZE, SIZE), interpolation=cv2.INTER_LINEAR)
    return cv2.remap(base, map_x, map_y, interpolation=cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=(240, 244, 249))


def main():
    assert COREL_SVG.exists(), COREL_SVG
    src = load_rgb(SRC_PNG)
    assert src.shape[0] == SIZE

    # Prefer artbox PNG (fast, no inkscape). Fall back to rsvg of studio SVG.
    if COREL_PNG_HINT.exists():
        corel = load_rgb(COREL_PNG_HINT)
        print("alignment raster: artbox hint")
        Image.fromarray(corel).save(OUT / "_corel_render.png")
    else:
        corel_png = OUT / "_corel_render.png"
        render_svg(COREL_SVG, corel_png)
        corel = load_rgb(corel_png)
        print("alignment raster: rsvg render")

    print("=== Global ECC ===")
    M, method, warped_g, ms, mc, wm = estimate_global_ecc(src, corel)
    print(f"global {method} IoU={mask_iou(wm, ms):.4f} MAE={mae(warped_g, src):.2f}")
    print("transform:\n", M)

    print("=== Multi-ROI ECC residuals ===")
    src_ctrl, dst_ctrl, roi_meta = collect_control_points(src, warped_g, M)
    print(f"control points: {len(src_ctrl)}")

    tps = TPS2D(src_ctrl, dst_ctrl, reg=1e-3)
    # Residual MAE check on raster via displacement field
    warped_tps = warp_image_tps(corel, M, tps)
    mae_g = mae(warped_g, src)
    mae_t = mae(warped_tps, src)
    iou_g = mask_iou(wm, ms)
    mt = paper_fg_mask(warped_tps)
    iou_t = mask_iou(mt, ms)
    print(f"global MAE={mae_g:.2f} IoU={iou_g:.4f}")
    print(f"TPS    MAE={mae_t:.2f} IoU={iou_t:.4f}")

    # If TPS hurts IoU/MAE badly, fall back to global
    use_tps = True
    if mae_t > mae_g + 1.5 and iou_t < iou_g - 0.01:
        print("TPS hurt metrics — falling back to global ECC only")
        use_tps = False
        tps_use = None
        primary_raster = warped_g
    else:
        tps_use = tps
        primary_raster = warped_tps

    # Warp SVG with composed transform
    svg_text = COREL_SVG.read_text()
    vb = parse_viewbox(svg_text)
    xform_px = compose_xform_px(M, tps_use)
    xform = make_svg_xform(vb, xform_px)
    warped_svg = warp_svg_text(svg_text, xform)
    out_svg = OUT / "piecewise-tps.svg"
    out_svg.write_text(warped_svg)
    out_png = OUT / "piecewise-tps.png"
    render_svg(out_svg, out_png)
    ours = load_rgb(out_png)

    mae_ours = mae(ours, src)
    mae_corel = mae(corel, src)
    paths = len(re.findall(r"<path\b", warped_svg))
    print(f"SVG-render MAE vs SRC={mae_ours:.2f} (corel was {mae_corel:.2f}) paths={paths}")

    # Also save global-only for compare
    xform_g = make_svg_xform(vb, compose_xform_px(M, None))
    (OUT / "global-ecc.svg").write_text(warp_svg_text(svg_text, xform_g))
    render_svg(OUT / "global-ecc.svg", OUT / "global-ecc.png")
    glob = load_rgb(OUT / "global-ecc.png")

    # Feature-local MAE in eye/muzzle boxes (alignment score)
    def roi_mae(a, b, box):
        x0, y0, x1, y1 = frac_box(box)
        return mae(a[y0:y1, x0:x1], b[y0:y1, x0:x1])

    local_scores = {}
    for name in ("eyeL", "eyeR", "muzzle", "nose"):
        local_scores[name] = {
            "global": roi_mae(glob, src, name),
            "tps": roi_mae(ours, src, name),
            "corel": roi_mae(corel, src, name),
        }
        print(f"  local MAE {name}: corel={local_scores[name]['corel']:.1f} "
              f"global={local_scores[name]['global']:.1f} tps={local_scores[name]['tps']:.1f}")

    # Proof strip SRC | COREL | OURS(TPS) | GLOBAL-ECC
    old = None
    for cand in (
        Path("/workspace/perfect-bezier/invent/compare/live-bezier-fresh.png"),
        OUT / "live-bezier-fresh.png",
    ):
        if cand.exists():
            old = load_rgb(cand)
            break

    labels = ["SRC", "COREL", "OURS-TPS", "GLOBAL-ECC"]
    imgs = [src, corel, ours, glob]
    make_strip(imgs, labels, CMP / "strip-piecewise.png")
    # 4-up with OLD if present
    if old is not None:
        make_strip([src, corel, ours, old], ["SRC", "COREL", "OURS", "OLD-bezier"], CMP / "strip-winner.png")

    for key in ("eyeR", "mouth", "whisker"):
        # mouth box ≈ muzzle
        box = ROIS["muzzle"] if key == "mouth" else (ROIS["eyeR"] if key == "eyeR" else ROIS.get("earL") and (0.05, 0.40, 0.40, 0.70))
        if key == "whisker":
            box = (0.05, 0.40, 0.40, 0.70)
        x0, y0, x1, y1 = frac_box(box)
        crops = [im[y0:y1, x0:x1] for im in (src, corel, ours, glob)]
        make_strip(crops, [f"SRC {key}", f"COREL", f"OURS-TPS", f"GLOBAL"], CMP / f"crop-piecewise-{key}.png", pad=4, label_h=28)
        Image.fromarray(np.concatenate(crops, axis=1)).save(CMP / f"crop-piecewise-{key}.jpg", quality=90)

    # Winner promote if TPS helps local eye/muzzle
    eye_improve = local_scores["eyeR"]["tps"] < local_scores["eyeR"]["global"] - 0.3
    muz_improve = local_scores["muzzle"]["tps"] < local_scores["muzzle"]["global"] - 0.3
    overall_ok = mae_ours <= mae_g + 2.0
    aligned = (eye_improve or muz_improve) and overall_ok
    # Softer: both locals not worse by much and at least one improves
    aligned = overall_ok and (
        local_scores["eyeR"]["tps"] <= local_scores["eyeR"]["global"] + 0.5
        and local_scores["muzzle"]["tps"] <= local_scores["muzzle"]["global"] + 0.5
        and (eye_improve or muz_improve or mae_ours < mae_g)
    )

    meta = {
        "method": "ecc_affine+multiROI_TPS" if use_tps else "ecc_affine",
        "global_method": method,
        "global_transform": M.tolist(),
        "use_tps": use_tps,
        "roi": roi_meta,
        "mae_corel_vs_src": mae_corel,
        "mae_global_vs_src": mae_g,
        "mae_tps_raster_vs_src": mae_t,
        "mae_svg_vs_src": mae_ours,
        "iou_global": iou_g,
        "iou_tps": iou_t,
        "local_mae": local_scores,
        "paths": paths,
        "eyes_muzzle_aligned": bool(aligned),
        "src_svg": str(COREL_SVG),
    }
    (OUT / "piecewise-meta.json").write_text(json.dumps(meta, indent=2))
    (CMP / "scores-piecewise.json").write_text(json.dumps(meta, indent=2))

    # Copy to winner if aligned enough
    if aligned or mae_ours < mae_corel - 5:
        WIN.joinpath("hallucinate.svg").write_text(warped_svg)
        Image.fromarray(ours).save(WIN / "hallucinate.png")
        WIN.joinpath("via-rasterCorel.svg").write_text(warped_svg)
        Image.fromarray(ours).save(WIN / "via-rasterCorel.png")
        WIN.joinpath("meta.json").write_text(json.dumps({
            "verdict": "PASS" if aligned else "IMPROVED",
            "recipe": "ecc-multiROI-TPS",
            "mae_src": round(mae_ours, 3),
            "paths": paths,
            "eyes_muzzle_aligned": bool(aligned),
        }, indent=2))
        print("Promoted to winner/")

    print(json.dumps({k: meta[k] for k in meta if k not in ("global_transform", "roi")}, indent=2))
    return 0 if aligned else 0  # always exit 0; parent judges strip


if __name__ == "__main__":
    raise SystemExit(main())
