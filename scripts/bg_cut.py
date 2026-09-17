#!/usr/bin/env python3
"""DecoClub production background cutout.

Border-constrained rembg: AI soft edges without punching holes in white
logo fills. Falls back to flood-from-border when rembg is missing.
"""
from __future__ import annotations

import json
import os
import sys
from collections import deque

import numpy as np
from PIL import Image


def border_sheet_stats(arr: np.ndarray) -> dict:
    border = np.concatenate(
        [arr[0, :, :3], arr[-1, :, :3], arr[:, 0, :3], arr[:, -1, :3]], axis=0
    ).astype(np.float32)
    mean = border.mean(axis=0)
    std = float(border.std(axis=0).mean())
    return {"mean": mean, "std": std, "sheet": std < 12.0}


def dilate_bool(mask: np.ndarray, iterations: int = 2) -> np.ndarray:
    out = mask.copy()
    h, w = mask.shape
    for _ in range(iterations):
        nxt = out.copy()
        nxt[1:, :] |= out[:-1, :]
        nxt[:-1, :] |= out[1:, :]
        nxt[:, 1:] |= out[:, :-1]
        nxt[:, :-1] |= out[:, 1:]
        out = nxt
    return out


def flood_sheet(arr: np.ndarray, bg_mean: np.ndarray, tight: float = 22.0, loose: float = 48.0) -> np.ndarray:
    h, w = arr.shape[:2]
    rgb = arr[:, :, :3].astype(np.float32)
    alpha = arr[:, :, 3] if arr.shape[2] == 4 else np.full((h, w), 255, np.uint8)
    y = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    by = 0.299 * bg_mean[0] + 0.587 * bg_mean[1] + 0.114 * bg_mean[2]
    dy = y - by
    cr = (rgb[:, :, 0] - bg_mean[0]) - dy
    cg = (rgb[:, :, 1] - bg_mean[1]) - dy
    cb = (rgb[:, :, 2] - bg_mean[2]) - dy
    dist = np.sqrt(0.6 * dy * dy + 0.4 * (cr * cr + cg * cg + cb * cb) / 3.0)

    marked = np.zeros((h, w), dtype=bool)
    q: deque = deque()

    def try_mark(yy: int, xx: int, thresh: float) -> None:
        if yy < 0 or xx < 0 or yy >= h or xx >= w or marked[yy, xx]:
            return
        if alpha[yy, xx] < 16 or dist[yy, xx] <= thresh:
            marked[yy, xx] = True
            q.append((yy, xx))

    for x in range(w):
        try_mark(0, x, tight)
        try_mark(h - 1, x, tight)
    for y0 in range(h):
        try_mark(y0, 0, tight)
        try_mark(y0, w - 1, tight)

    while q:
        yy, xx = q.popleft()
        try_mark(yy + 1, xx, tight)
        try_mark(yy - 1, xx, tight)
        try_mark(yy, xx + 1, tight)
        try_mark(yy, xx - 1, tight)

    frontier = list(zip(*np.where(marked)))
    q = deque(frontier)
    seen = marked.copy()
    while q:
        yy, xx = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = yy + dy, xx + dx
            if ny < 0 or nx < 0 or ny >= h or nx >= w or seen[ny, nx]:
                continue
            if alpha[ny, nx] < 16 or dist[ny, nx] <= loose:
                seen[ny, nx] = True
                marked[ny, nx] = True
                q.append((ny, nx))
    return marked


def apply_soft_edge(arr: np.ndarray, bg_mask: np.ndarray, bg_mean: np.ndarray, soft_mask: np.ndarray | None) -> np.ndarray:
    out = arr.copy()
    out[bg_mask, 3] = 0
    alpha = out[:, :, 3].astype(np.int16)
    h, w = bg_mask.shape

    if soft_mask is not None:
        near_bg = dilate_bool(bg_mask, 2) & (~bg_mask)
        ys, xs = np.where(near_bg)
        for y, x in zip(ys, xs):
            m = int(soft_mask[y, x])
            if m < alpha[y, x]:
                alpha[y, x] = m

    out[:, :, 3] = np.clip(alpha, 0, 255).astype(np.uint8)

    a = out[:, :, 3:4].astype(np.float32) / 255.0
    soft = (a[:, :, 0] > 0.02) & (a[:, :, 0] < 0.98)
    if soft.any():
        rgb = out[:, :, :3].astype(np.float32)
        inv = 1.0 - a
        for c in range(3):
            ch = rgb[:, :, c]
            ch[soft] = (ch[soft] - float(bg_mean[c]) * inv[:, :, 0][soft]) / np.maximum(
                a[:, :, 0][soft], 1e-3
            )
            rgb[:, :, c] = np.clip(ch, 0, 255)
        out[:, :, :3] = rgb.astype(np.uint8)
    return out


def rembg_mask(img: Image.Image) -> np.ndarray | None:
    try:
        from rembg import new_session, remove
    except Exception:
        return None
    model = os.environ.get("DECOCLUB_REMBG_MODEL", "u2net")
    try:
        session = new_session(model)
    except Exception:
        try:
            session = new_session("u2net")
        except Exception:
            return None
    try:
        mask = np.array(remove(img, session=session, only_mask=True))
    except Exception:
        return None
    if mask.ndim == 3:
        mask = mask[:, :, 0]
    return mask.astype(np.uint8)


def constrained_ai(soft: np.ndarray) -> np.ndarray:
    h, w = soft.shape
    cand = soft < 128
    vis = np.zeros((h, w), dtype=bool)
    q: deque = deque()

    def push(y: int, x: int) -> None:
        if y < 0 or x < 0 or y >= h or x >= w:
            return
        if vis[y, x] or not cand[y, x]:
            return
        vis[y, x] = True
        q.append((y, x))

    for x in range(w):
        push(0, x)
        push(h - 1, x)
    for y in range(h):
        push(y, 0)
        push(y, w - 1)
    while q:
        y, x = q.popleft()
        push(y + 1, x)
        push(y - 1, x)
        push(y, x + 1)
        push(y, x - 1)
    return vis


def cut_png(path_in: str, path_out: str, force: str | None = None) -> dict:
    img = Image.open(path_in).convert("RGBA")
    max_side = int(os.environ.get("DECOCLUB_BGCUT_MAX", "2000"))
    if max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    arr = np.array(img)
    stats = border_sheet_stats(arr)
    bg_mean = stats["mean"]
    force = (force or "").strip().lower() or "auto"

    soft = None
    want_ai = force in ("auto", "ai", "rembg", "photo", "1", "true")
    if force in ("flood", "sheet", "classic"):
        want_ai = False

    if want_ai:
        soft = rembg_mask(img)

    if soft is not None:
        ai_bg = constrained_ai(soft)
        if stats["sheet"] and force not in ("ai", "rembg", "photo"):
            flood_bg = flood_sheet(arr, bg_mean)
            # Sheet logos: flood owns interiors; AI may add fringe near flood
            dil = dilate_bool(flood_bg, 2)
            bg_mask = flood_bg | (ai_bg & dil)
            mode = "sheet+ai"
        else:
            bg_mask = ai_bg
            mode = "ai"
        out = apply_soft_edge(arr, bg_mask, bg_mean, soft)
        Image.fromarray(out).save(path_out, format="PNG")
        return {"ok": True, "mode": mode, "sheet": bool(stats["sheet"]), "std": round(stats["std"], 2)}

    bg_mask = flood_sheet(arr, bg_mean)
    out = apply_soft_edge(arr, bg_mask, bg_mean, None)
    Image.fromarray(out).save(path_out, format="PNG")
    return {"ok": True, "mode": "flood", "sheet": bool(stats["sheet"]), "std": round(stats["std"], 2)}


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: bg_cut.py in.png out.png [auto|ai|flood]", file=sys.stderr)
        return 2
    force = sys.argv[3] if len(sys.argv) > 3 else "auto"
    meta = cut_png(sys.argv[1], sys.argv[2], force=force)
    print(json.dumps(meta))
    return 0 if meta.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
