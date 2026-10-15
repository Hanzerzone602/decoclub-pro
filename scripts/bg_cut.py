#!/usr/bin/env python3
"""DecoClub production background cutout.

Flat sheets use a border flood. Gradient and noisy backgrounds fit a smooth
colour model and flood on distance to that model, combined with a small
u2netp ONNX mask when onnxruntime and models/u2netp.onnx are available.
Falls back to the non-AI path if either is missing. No rembg.
"""
from __future__ import annotations

import gc
import json
import os
import sys
import time
import traceback
from functools import lru_cache

import numpy as np
from PIL import Image

try:
    from scipy import ndimage
except Exception:  # pragma: no cover - scipy is a production dependency
    ndimage = None

_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], np.float32)
_STRUCT8 = np.ones((3, 3), np.uint8)


def _debug() -> bool:
    return bool(os.environ.get("DECOCLUB_BGCUT_DEBUG"))


def chroma_dist(rgb: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Luma-weighted distance. bg is HxWx3 or a length-3 colour."""
    if bg.ndim == 1:
        bg = bg.reshape(1, 1, 3)
    y = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    by = 0.299 * bg[..., 0] + 0.587 * bg[..., 1] + 0.114 * bg[..., 2]
    dy = y - by
    cr = (rgb[..., 0] - bg[..., 0]) - dy
    cg = (rgb[..., 1] - bg[..., 1]) - dy
    cb = (rgb[..., 2] - bg[..., 2]) - dy
    return np.sqrt(np.maximum(0.0, 0.6 * dy * dy + 0.4 * (cr * cr + cg * cg + cb * cb) / 3.0))


def _border_mask(h: int, w: int, bw: int) -> np.ndarray:
    b = np.zeros((h, w), dtype=bool)
    bw = max(1, min(bw, h // 2, w // 2))
    b[:bw, :] = True
    b[-bw:, :] = True
    b[:, :bw] = True
    b[:, -bw:] = True
    return b


def border_stats(rgb: np.ndarray, alpha: np.ndarray) -> dict:
    h, w = rgb.shape[:2]
    band = _border_mask(h, w, 3) & (alpha >= 16)
    samples = rgb[band]
    if samples.shape[0] < 8:
        med = np.array([255.0, 255.0, 255.0], np.float32)
        return {"median": med, "mean": med, "std": 0.0, "mad": 0.0, "sheet": True}
    med = np.median(samples, axis=0).astype(np.float32)
    mad = float(np.median(np.abs(samples - med)) * 1.4826)
    std = float(samples.std(axis=0).mean())
    # Low scatter → flat sheet (logos on white / solid paper).
    sheet = mad < 12.0 and std < 16.0
    return {"median": med, "mean": samples.mean(axis=0).astype(np.float32), "std": std, "mad": mad, "sheet": sheet}


def _label(mask: np.ndarray, connectivity: int = 1):
    if connectivity == 2:
        return ndimage.label(mask, structure=_STRUCT8)
    return ndimage.label(mask)


def border_connected(mask: np.ndarray) -> np.ndarray:
    if mask is None or not np.any(mask):
        return np.zeros(mask.shape, dtype=bool)
    lab, n = _label(mask, 1)
    if n <= 0:
        return np.zeros(mask.shape, dtype=bool)
    edge = np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]])
    ids = np.unique(edge)
    ids = ids[ids != 0]
    if ids.size == 0:
        return np.zeros(mask.shape, dtype=bool)
    return np.isin(lab, ids)


def _components_touching(host: np.ndarray, seeds: np.ndarray) -> np.ndarray:
    """Pixels of `host` in components that intersect `seeds`."""
    if not np.any(host):
        return np.zeros(host.shape, dtype=bool)
    lab, n = _label(host, 1)
    if n <= 0:
        return np.zeros(host.shape, dtype=bool)
    ids = np.unique(lab[seeds & (lab > 0)]) if np.any(seeds) else np.array([], dtype=lab.dtype)
    ids = ids[ids != 0] if ids.size else ids
    if ids.size == 0:
        return np.zeros(host.shape, dtype=bool)
    return np.isin(lab, ids)


def flood_sheet(rgb: np.ndarray, alpha: np.ndarray, bg_colour: np.ndarray,
                tight: float = 22.0, loose: float = 48.0) -> np.ndarray:
    """Border flood on distance to one flat colour. Vectorised equivalent of the old BFS."""
    dist = chroma_dist(rgb, bg_colour)
    h, w = dist.shape
    border = _border_mask(h, w, 1)
    open_px = alpha < 16
    tight_m = open_px | (dist <= tight)
    seeds = border & tight_m
    bg = _components_touching(tight_m, seeds)
    loose_m = open_px | (dist <= loose)
    return _components_touching(loose_m, bg | seeds)


def _denoise(rgb: np.ndarray) -> np.ndarray:
    """Gaussian blur kills grain before the background fit and the distance flood.

    A 3x3 median was tried; on a 1500px image it cost ~1s and a large temporary.
    Gaussian sigma 1.15 is enough for the grain in photo/gradient uploads and
    stays well inside the time and RAM budget. Least-squares on the border
    averages whatever noise remains.
    """
    out = np.empty_like(rgb)
    for c in range(3):
        out[:, :, c] = ndimage.gaussian_filter(rgb[:, :, c], sigma=1.15, mode="nearest")
    return out


def _fit_quadratic(blur: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Per-channel quadratic over a border band, with one residual clip.

    The field is evaluated with broadcasting so a 1500px frame does not
    allocate a stacked float64 basis (that temporary alone was ~100MB).
    """
    h, w = blur.shape[:2]
    bw = max(2, min(8, min(h, w) // 16))
    band = _border_mask(h, w, bw) & (alpha >= 16)
    ys, xs = np.nonzero(band)
    if ys.size < 12:
        med = np.median(blur.reshape(-1, 3), axis=0)
        pred = np.empty_like(blur)
        pred[:] = med
        return pred
    xn = xs.astype(np.float64) / max(w - 1, 1) * 2.0 - 1.0
    yn = ys.astype(np.float64) / max(h - 1, 1) * 2.0 - 1.0
    A = np.stack([xn * xn, yn * yn, xn * yn, xn, yn, np.ones_like(xn)], axis=1)
    coefs = []
    for c in range(3):
        z = blur[ys, xs, c].astype(np.float64)
        coef, *_ = np.linalg.lstsq(A, z, rcond=None)
        resid = np.abs(A @ coef - z)
        med = np.median(resid)
        mad = np.median(np.abs(resid - med)) + 1e-6
        keep = resid < max(14.0, med + 4.0 * 1.4826 * mad)
        if int(keep.sum()) > 30 and int(keep.sum()) < keep.size:
            coef, *_ = np.linalg.lstsq(A[keep], z[keep], rcond=None)
        coefs.append(coef.astype(np.float32))
    xs_n = np.linspace(-1.0, 1.0, w, dtype=np.float32)[None, :]
    ys_n = np.linspace(-1.0, 1.0, h, dtype=np.float32)[:, None]
    xx = xs_n * xs_n
    yy = ys_n * ys_n
    pred = np.empty((h, w, 3), np.float32)
    for c, coef in enumerate(coefs):
        a, b, cxy, d, e, f = (float(v) for v in coef)
        pred[:, :, c] = a * xx + b * yy + cxy * (xs_n * ys_n) + d * xs_n + e * ys_n + f
    return np.clip(pred, 0.0, 255.0, out=pred)


def _pred_is_flat(pred: np.ndarray) -> bool:
    flat = pred.reshape(-1, 3)
    if flat.shape[0] > 200000:
        # subsample for the range test
        step = max(1, flat.shape[0] // 200000)
        flat = flat[::step]
    lo = np.percentile(flat, 2, axis=0)
    hi = np.percentile(flat, 98, axis=0)
    return float((hi - lo).mean()) < 16.0


def _model_path() -> str | None:
    env = os.environ.get("DECOCLUB_U2NETP")
    if env and os.path.isfile(env):
        return env
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models", "u2netp.onnx")
    if os.path.isfile(here):
        return here
    return None


@lru_cache(maxsize=1)
def _u2_session():
    if os.environ.get("DECOCLUB_BGCUT_DISABLE_AI"):
        return None
    path = _model_path()
    if not path:
        return None
    try:
        import onnxruntime as ort
    except Exception:
        return None
    try:
        return ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    except Exception:
        try:
            return ort.InferenceSession(path)
        except Exception:
            return None


def u2net_foreground(img: Image.Image) -> np.ndarray | None:
    """Foreground probability in 0..1 at the image size, or None if unavailable."""
    sess = _u2_session()
    if sess is None:
        return None
    try:
        resized = img.convert("RGB").resize((320, 320), Image.Resampling.LANCZOS)
        arr = np.asarray(resized).astype(np.float32)
        scale = max(float(arr.max()), 1e-6)
        arr = arr / scale
        arr = (arr - _IMAGENET_MEAN) / _IMAGENET_STD
        inp = np.transpose(arr, (2, 0, 1))[None].astype(np.float32)
        name = sess.get_inputs()[0].name
        pred = sess.run(None, {name: inp})[0][0, 0]
        mn = float(pred.min())
        mx = float(pred.max())
        if mx - mn < 1e-6:
            pred = np.zeros_like(pred, dtype=np.float32)
        else:
            pred = ((pred - mn) / (mx - mn)).astype(np.float32)
        mask = Image.fromarray(pred, mode="F").resize(img.size, Image.Resampling.BILINEAR)
        return np.asarray(mask, dtype=np.float32)
    except Exception:
        if _debug():
            traceback.print_exc()
        return None


def gradient_flood(rgb: np.ndarray, alpha: np.ndarray):
    """Border flood on distance to a quadratic background, plus enclosed holes.

    Distance for the first flood is measured on the blurred image so grain
    cannot wall the fill off. A second grow on the sharp image snaps the
    contour up to real edges (the blur distance rises a few pixels early).
    Returns (bg, pred, sharp_dist, blur_dist), or (None, pred, None, None)
    when the fitted field is flat and the caller should use the sheet flood.
    """
    blur = _denoise(rgb)
    pred = _fit_quadratic(blur, alpha)
    if _pred_is_flat(pred):
        del blur
        return None, pred, None, None
    db = chroma_dist(blur, pred)
    del blur
    ds = chroma_dist(rgb, pred)
    open_px = alpha < 16

    # Flood from the border on the blurred distance.
    bg = border_connected(open_px | (db <= 12.0))
    # Snap through sharp pixels that still match the predicted background.
    sharp = open_px | (ds <= 24.0)
    bg = _components_touching(sharp, bg) | border_connected(sharp)

    # Enclosed regions that match the predicted background (tail loop, holes).
    # Colour match alone: a white logo fill does not match a varying gradient,
    # and this must work when u2netp is absent.
    low = db <= 13.5
    holes = low & ~border_connected(low | open_px)
    bg = bg | holes
    return bg, pred, ds, db


def apply_u2(bg: np.ndarray, ds: np.ndarray, db: np.ndarray, prob: np.ndarray) -> np.ndarray:
    """Combine the gradient flood with u2netp.

    Background if the flood says so, or u2netp is confidently background
    (<0.15) and the colour is near the predicted background. Confident
    foreground (>0.6) is kept unless the colour matches the background
    very closely (noisy patches the net sometimes claims).
    """
    near = (ds <= 22.0) & (db <= 18.0)
    bg = bg | ((prob < 0.15) & near)
    very = ds <= 18.0
    return bg & ~((prob > 0.6) & ~very)


def cleanup_specks(bg: np.ndarray) -> np.ndarray:
    """Drop tiny foreground islands far from the subject and fill tiny pinholes.

    Threshold is ~0.02% of the image. 8-connectivity keeps diagonal strokes
    (antennae, whiskers) attached to the subject. Islands that touch a small
    dilation of the main component are kept so a one-pixel gap cannot delete
    a thin stroke. Enclosed background holes larger than the threshold
    (tail loop, inner cutouts) are not filled.
    """
    h, w = bg.shape
    min_area = max(4, int(round(0.0002 * h * w)))
    fg = ~bg
    if not np.any(fg):
        return bg
    lab, n = _label(fg, 2)
    if n <= 0:
        return bg
    counts = np.bincount(lab.ravel())
    main_id = 1 + int(np.argmax(counts[1:]))
    main = lab == main_id
    near = ndimage.binary_dilation(main, structure=_STRUCT8, iterations=3)
    small_ids = np.flatnonzero(counts < min_area)
    small_ids = small_ids[small_ids != 0]
    if small_ids.size:
        small = np.isin(lab, small_ids)
        fg[small & ~near] = False

    bg2 = ~fg
    labb, nb = _label(bg2, 1)
    if nb <= 0:
        return bg2
    bc = np.bincount(labb.ravel())
    edge = np.concatenate([labb[0, :], labb[-1, :], labb[:, 0], labb[:, -1]])
    border_ids = set(int(i) for i in np.unique(edge) if i != 0)
    kill = [i for i in range(1, nb + 1) if i not in border_ids and bc[i] < min_area]
    if kill:
        bg2[np.isin(labb, np.array(kill, dtype=labb.dtype))] = False
    return bg2


def _row_luma_chroma(col: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    luma = 0.299 * col[:, 0] + 0.587 * col[:, 1] + 0.114 * col[:, 2]
    chroma = col.max(axis=1) - col.min(axis=1)
    return luma, chroma


def defringe(rgb: np.ndarray, bg: np.ndarray, pred: np.ndarray) -> np.ndarray:
    """Crisp alpha and decontaminated edge colour.

    Light-grey anti-alias pixels on the 1px rim become transparent or are
    unmixed off the background colour. Interior fills sit deeper than that
    rim (white wing, white chest) and keep their colour. Partial alpha is
    written only on the rim. The rim is an 8-neighbour of the background,
    which is the same set as Euclidean distance < 2, without a full-frame
    distance transform.
    """
    h, w = bg.shape
    fg = ~bg
    out = np.zeros((h, w, 4), np.uint8)
    if not np.any(fg):
        out[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
        return out

    luma = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    chroma = rgb.max(axis=2) - rgb.min(axis=2)
    touch = ndimage.binary_dilation(~fg, structure=_STRUCT8)
    # One pass. A second pass would step into enclosed white fills.
    bg = bg | (fg & touch & (chroma < 32.0) & (luma > 128.0))
    del luma, chroma
    fg = ~bg
    ring = fg & ndimage.binary_dilation(bg, structure=_STRUCT8)
    core = fg & ~ring

    flat = np.clip(rgb, 0, 255).astype(np.uint8)
    out[:, :, :3] = flat
    del flat
    out[core, 3] = 255
    ys, xs = np.nonzero(ring)
    if ys.size == 0:
        return out

    C = rgb[ys, xs]
    if pred.ndim == 3 and pred.shape[0] == h and pred.shape[1] == w:
        B = pred[ys, xs]
    else:
        B = np.broadcast_to(np.reshape(pred, (1, 3)), C.shape)
    luma, chroma = _row_luma_chroma(C)
    solid = (chroma >= 28.0) | (luma <= 110.0)
    light = (chroma < 26.0) & (luma > 128.0)
    dist = chroma_dist(C, B)
    a = np.clip(dist / 80.0, 0.0, 1.0)
    a_safe = np.maximum(a, 0.35)
    unmixed = (C - (1.0 - a_safe)[:, None] * B) / a_safe[:, None]
    unmixed = np.clip(unmixed, 0.0, 255.0)
    fl, fc = _row_luma_chroma(unmixed)
    light = light | ((fc < 26.0) & (fl > 128.0) & ~solid)
    keep = ~light
    colour = np.where(solid[:, None], np.clip(C, 0, 255), unmixed)
    alpha = np.where(solid | (a >= 0.82), 255.0, np.clip(a, 0.0, 1.0) * 255.0)
    if np.any(keep):
        out[ys[keep], xs[keep], :3] = colour[keep].astype(np.uint8)
        out[ys[keep], xs[keep], 3] = np.clip(alpha[keep], 0, 255).astype(np.uint8)
    return out


def _want_ai(force: str) -> bool:
    if os.environ.get("DECOCLUB_BGCUT_DISABLE_AI"):
        return False
    if force in ("flood", "sheet", "classic", "noai"):
        return False
    return force in ("", "auto", "ai", "rembg", "photo", "u2", "u2net", "1", "true")


def cut_array(rgb: np.ndarray, alpha: np.ndarray, img_for_ai: Image.Image | None, force: str) -> tuple[np.ndarray, dict]:
    if ndimage is None:
        raise RuntimeError("scipy is required for background cutout")
    stats = border_stats(rgb, alpha)
    sheet = bool(stats["sheet"])
    # u2netp is only combined on gradient / noisy backgrounds. Flat sheets
    # stay on the flood so white logo fills are not punched out. The net is
    # loaded after the geometric flood so its activations do not stack on
    # the blur / distance temporaries.
    pred = None
    bg = None
    mode = "sheet"
    used_u2 = False
    if not sheet:
        bg, pred, ds, db = gradient_flood(rgb, alpha)
        if bg is None:
            sheet = True
            mode = "sheet"
        else:
            prob = None
            if _want_ai(force) and img_for_ai is not None:
                gc.collect()
                prob = u2net_foreground(img_for_ai)
            if prob is not None:
                bg = apply_u2(bg, ds, db, prob)
                used_u2 = True
                del prob
            del ds, db
            mode = "gradient+u2" if used_u2 else "gradient"
    if sheet:
        # Flat paper: flood owns interiors so white logo fills stay.
        # Do not let u2netp punch them out.
        bg = flood_sheet(rgb, alpha, stats["median"])
        pred = stats["median"].reshape(1, 1, 3)
        mode = "sheet"

    bg = cleanup_specks(bg)
    out = defringe(rgb, bg, pred)
    # Honour an already-transparent source.
    out[:, :, 3] = np.minimum(out[:, :, 3], alpha)
    meta = {
        "ok": True,
        "mode": mode,
        "sheet": bool(sheet and mode == "sheet"),
        "std": round(float(stats["std"]), 2),
        "mad": round(float(stats["mad"]), 2),
        "u2": bool(used_u2),
    }
    return out, meta


def cut_png(path_in: str, path_out: str, force: str | None = None) -> dict:
    t0 = time.perf_counter()
    img = Image.open(path_in).convert("RGBA")
    max_side = int(os.environ.get("DECOCLUB_BGCUT_MAX", "2000"))
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    arr = np.asarray(img)
    rgb = arr[:, :, :3].astype(np.float32)
    alpha = arr[:, :, 3]
    force = (force or "").strip().lower() or "auto"
    out, meta = cut_array(rgb, alpha, img, force)
    Image.fromarray(out, mode="RGBA").save(path_out, format="PNG", optimize=False)
    if _debug():
        try:
            import resource
            peak_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            # Linux reports kilobytes. macOS would be bytes; this deploy is Linux.
            peak_mb = peak_kb / 1024.0
        except Exception:
            peak_mb = -1.0
        ms = (time.perf_counter() - t0) * 1000.0
        print(
            f"bg_cut time_ms={ms:.0f} peak_mb={peak_mb:.1f} mode={meta['mode']} u2={meta['u2']}",
            file=sys.stderr,
        )
    return meta


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: bg_cut.py in.png out.png [auto|ai|flood]", file=sys.stderr)
        return 2
    force = sys.argv[3] if len(sys.argv) > 3 else "auto"
    try:
        meta = cut_png(sys.argv[1], sys.argv[2], force=force)
    except Exception as exc:
        if _debug():
            traceback.print_exc()
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 1
    print(json.dumps(meta))
    return 0 if meta.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
