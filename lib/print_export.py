#!/usr/bin/env python3
"""Print exports from a production SVG: DXF (cut/laser), PDF (vector),
TIFF / PNG (300 DPI at true print size) with optional DTF white underbase.

Underbase rules (DTF): white only under fully opaque pixels, choked in
by 1-4 px (default 2) so no white shows at the edges.

usage: print_export.py FORMAT in.svg out.file --width-in W [--height-in H]
       [--dpi 300] [--underbase] [--choke 2]
"""
import argparse, io, math, re, subprocess, sys, xml.etree.ElementTree as ET

def svg_size(root):
    vb = root.get("viewBox")
    if vb:
        p = [float(v) for v in re.split(r"[ ,]+", vb.strip())]
        return p[0], p[1], p[2], p[3]
    def num(s):
        m = re.match(r"[-\d.]+", s or "0"); return float(m.group(0)) if m else 0.0
    return 0.0, 0.0, num(root.get("width")) or 1.0, num(root.get("height")) or 1.0

def target_px(root, width_in, height_in, dpi):
    _, _, vw, vh = svg_size(root)
    w = float(width_in or 0) or 10.0
    h = float(height_in or 0) or (w * vh / vw if vw else w)
    return max(1, int(round(w * dpi))), max(1, int(round(h * dpi))), w, h

def rsvg(svg_path, fmt, w_px, h_px, dpi=None):
    cmd = ["rsvg-convert", "-f", fmt, "-w", str(w_px), "-h", str(h_px)]
    if dpi: cmd += ["-d", str(dpi), "-p", str(dpi)]
    cmd.append(svg_path)
    return subprocess.run(cmd, check=True, capture_output=True).stdout

def raster(svg_path, root, a):
    from PIL import Image
    w, h, win, hin = target_px(root, a.width_in, a.height_in, a.dpi)
    img = Image.open(io.BytesIO(rsvg(svg_path, "png", w, h))).convert("RGBA")
    return img, win, hin

def underbase(img, choke):
    """White underbase mask: fully opaque pixels only, choked in by `choke` px."""
    import numpy as np
    from PIL import Image
    from scipy import ndimage
    choke = min(4.0, max(1.0, float(choke)))
    alpha = np.asarray(img.getchannel("A"))
    solid = alpha >= 255
    # distance (px) from each solid pixel to nearest non-solid pixel
    dist = ndimage.distance_transform_edt(np.pad(solid, 1, constant_values=False))[1:-1, 1:-1]
    # edge pixels sit at dist 1 (centre 0.5 px from boundary); choke trims coverage
    cov = np.clip(dist - 0.5 - choke, 0.0, 1.0)
    ub = np.where(solid, np.round(cov * 255), 0).astype("uint8")
    return Image.fromarray(ub, "L")

# ---------- DXF ----------
NUM = r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
def path_polys(d, steps=12):
    toks = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|" + NUM, d or "")
    polys, cur, i = [], [], 0
    x = y = sx = sy = 0.0; cmd = None; lc = None
    def nums(n):
        nonlocal i
        v = [float(t) for t in toks[i:i + n]]; i += n; return v
    while i < len(toks):
        t = toks[i]
        if re.match(r"[A-Za-z]", t): cmd = t; i += 1
        if cmd is None: break
        rel = cmd.islower(); C = cmd.upper()
        if C == "Z":
            if cur: cur.append(cur[0]); polys.append(cur); cur = []
            x, y = sx, sy; lc = None; cmd = None; continue
        if i >= len(toks) or re.match(r"[A-Za-z]", toks[i]): continue
        ox, oy = (x, y) if rel else (0.0, 0.0)
        if C == "M":
            if len(cur) > 1: polys.append(cur)
            px, py = nums(2); x, y = ox + px, oy + py; sx, sy = x, y; cur = [(x, y)]
            cmd = "l" if rel else "L"; lc = None
        elif C == "L": px, py = nums(2); x, y = ox + px, oy + py; cur.append((x, y)); lc = None
        elif C == "H": v, = nums(1); x = (x if rel else 0) + v; cur.append((x, y)); lc = None
        elif C == "V": v, = nums(1); y = (y if rel else 0) + v; cur.append((x, y)); lc = None
        elif C in "CSQT":
            if C == "C": a = nums(6); p1 = (ox + a[0], oy + a[1]); p2 = (ox + a[2], oy + a[3]); e = (ox + a[4], oy + a[5])
            elif C == "S":
                a = nums(4); p1 = (2 * x - lc[0], 2 * y - lc[1]) if lc else (x, y)
                p2 = (ox + a[0], oy + a[1]); e = (ox + a[2], oy + a[3])
            elif C == "Q":
                a = nums(4); q = (ox + a[0], oy + a[1]); e = (ox + a[2], oy + a[3])
                p1 = (x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y)); p2 = (e[0] + 2 / 3 * (q[0] - e[0]), e[1] + 2 / 3 * (q[1] - e[1]))
            else:
                a = nums(2); q = (2 * x - lc[0], 2 * y - lc[1]) if lc else (x, y); e = (ox + a[0], oy + a[1])
                p1 = (x + 2 / 3 * (q[0] - x), y + 2 / 3 * (q[1] - y)); p2 = (e[0] + 2 / 3 * (q[0] - e[0]), e[1] + 2 / 3 * (q[1] - e[1]))
            for k in range(1, steps + 1):
                s = k / steps; m = 1 - s
                cur.append((m**3 * x + 3 * m * m * s * p1[0] + 3 * m * s * s * p2[0] + s**3 * e[0],
                            m**3 * y + 3 * m * m * s * p1[1] + 3 * m * s * s * p2[1] + s**3 * e[1]))
            lc = p2; x, y = e
        elif C == "A":
            a = nums(7); x, y = ox + a[5], oy + a[6]; cur.append((x, y)); lc = None  # rare in traces: chord
        else: i += 1
    if len(cur) > 1: polys.append(cur)
    return polys

def mat_mul(A, B):
    return (A[0]*B[0]+A[2]*B[1], A[1]*B[0]+A[3]*B[1], A[0]*B[2]+A[2]*B[3], A[1]*B[2]+A[3]*B[3],
            A[0]*B[4]+A[2]*B[5]+A[4], A[1]*B[4]+A[3]*B[5]+A[5])

def parse_tf(s):
    M = (1, 0, 0, 1, 0, 0)
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", s or ""):
        v = [float(t) for t in re.findall(NUM, args)]
        if name == "matrix" and len(v) == 6: T = tuple(v)
        elif name == "translate": T = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == "scale": T = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            r = math.radians(v[0]); c, s_ = math.cos(r), math.sin(r); T = (c, s_, -s_, c, 0, 0)
            if len(v) == 3: T = mat_mul(mat_mul((1, 0, 0, 1, v[1], v[2]), T), (1, 0, 0, 1, -v[1], -v[2]))
        else: continue
        M = mat_mul(M, T)
    return M

def tag(el): return el.tag.split("}")[-1]

def color_of(el, inherited):
    fill = el.get("fill"); st = el.get("style") or ""
    m = re.search(r"fill\s*:\s*([^;]+)", st)
    if m: fill = m.group(1).strip()
    return fill if fill else inherited

def collect(el, M, fill, out):
    M = mat_mul(M, parse_tf(el.get("transform")))
    fill = color_of(el, fill); t = tag(el)
    if t in ("defs", "clipPath", "mask", "title", "metadata", "style"): return
    polys = []
    f = lambda k: float(el.get(k) or 0)
    if t == "path": polys = path_polys(el.get("d"))
    elif t in ("polygon", "polyline"):
        v = [float(n) for n in re.findall(NUM, el.get("points") or "")]
        polys = [list(zip(v[0::2], v[1::2]))]
        if t == "polygon" and polys[0]: polys[0].append(polys[0][0])
    elif t == "rect":
        x, y, w, h = f("x"), f("y"), f("width"), f("height")
        polys = [[(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]]
    elif t in ("circle", "ellipse"):
        cx, cy = f("cx"), f("cy"); rx = f("r") if t == "circle" else f("rx"); ry = f("r") if t == "circle" else f("ry")
        n = 24 if max(rx, ry) < 5 else 48
        polys = [[(cx + rx * math.cos(2 * math.pi * k / n), cy + ry * math.sin(2 * math.pi * k / n)) for k in range(n + 1)]]
    if polys and (fill or "black") != "none":
        out.append((fill or "#000000", [[(M[0]*px + M[2]*py + M[4], M[1]*px + M[3]*py + M[5]) for px, py in p] for p in polys]))
    for c in el: collect(c, M, fill, out)

def hex_rgb(s):
    s = (s or "").strip()
    m = re.match(r"#([0-9a-fA-F]{6})$", s)
    if m: return tuple(int(m.group(1)[k:k+2], 16) for k in (0, 2, 4))
    m = re.match(r"#([0-9a-fA-F]{3})$", s)
    if m: return tuple(int(c * 2, 16) for c in m.group(1))
    m = re.match(r"rgb\(\s*(\d+)\D+(\d+)\D+(\d+)", s)
    if m: return tuple(int(g) for g in m.groups())
    return (0, 0, 0)

def dxf(root, a):
    vx, vy, vw, vh = svg_size(root)
    _, _, win, hin = target_px(root, a.width_in, a.height_in, 1)
    sx, sy = win / vw, hin / vh  # inches per user unit; DXF in inches, Y up
    items = []; collect(root, (1, 0, 0, 1, 0, 0), None, items)
    layers = {}
    for fill, _ in items:
        layers.setdefault(fill, "INK_%d" % (len(layers) + 1))
    L = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$INSUNITS", "70", "1",
         "9", "$EXTMIN", "10", "0", "20", "0", "9", "$EXTMAX", "10", "%.4f" % win, "20", "%.4f" % hin,
         "0", "ENDSEC", "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", str(len(layers))]
    for fill, name in layers.items():
        r, g, b = hex_rgb(fill)
        aci = 7 if max(r, g, b) < 40 or min(r, g, b) > 215 else 1 + (int(math.degrees(math.atan2(math.sqrt(3) * (g - b), 2 * r - g - b)) % 360) // 60)
        L += ["0", "LAYER", "2", name, "70", "0", "62", str(aci), "6", "CONTINUOUS"]
    L += ["0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"]
    for fill, polys in items:
        for p in polys:
            if len(p) < 2: continue
            closed = len(p) > 2 and abs(p[0][0] - p[-1][0]) < 1e-6 and abs(p[0][1] - p[-1][1]) < 1e-6
            if closed: p = p[:-1]
            L += ["0", "POLYLINE", "8", layers[fill], "66", "1", "10", "0", "20", "0", "30", "0", "70", "1" if closed else "0"]
            for px, py in p:
                L += ["0", "VERTEX", "8", layers[fill], "10", "%.5f" % ((px - vx) * sx), "20", "%.5f" % (hin - (py - vy) * sy), "30", "0"]
            L += ["0", "SEQEND", "8", layers[fill]]
    L += ["0", "ENDSEC", "0", "EOF"]
    return ("\n".join(L) + "\n").encode("ascii")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("format", choices=["dxf", "pdf", "tiff", "png", "underbase"])
    ap.add_argument("svg"); ap.add_argument("out")
    ap.add_argument("--width-in", type=float, default=0); ap.add_argument("--height-in", type=float, default=0)
    ap.add_argument("--dpi", type=int, default=300); ap.add_argument("--underbase", action="store_true")
    ap.add_argument("--choke", type=float, default=2.0)
    a = ap.parse_args()
    root = ET.parse(a.svg).getroot()
    if a.format == "dxf":
        data = dxf(root, a)
    elif a.format == "pdf":
        _, _, win, hin = target_px(root, a.width_in, a.height_in, 1)
        data = rsvg(a.svg, "pdf", "%.4fin" % win, "%.4fin" % hin, dpi=72)  # 1pt = 1/72 in, vector
    else:
        img, _, _ = raster(a.svg, root, a); buf = io.BytesIO(); dpi = (a.dpi, a.dpi)
        if a.format == "underbase":
            underbase(img, a.choke).save(buf, "PNG", dpi=dpi)
        elif a.format == "png":
            img.save(buf, "PNG", dpi=dpi)
        else:
            if a.underbase:
                ub = underbase(img, a.choke)
                ub.info["dpi"] = dpi
                img.save(buf, "TIFF", dpi=dpi, compression="tiff_lzw", save_all=True, append_images=[ub],
                         description="DecoClub Pro: page 1 art RGBA, page 2 DTF white underbase (choked %.2fpx)" % min(4.0, max(1.0, a.choke)))
            else:
                img.save(buf, "TIFF", dpi=dpi, compression="tiff_lzw")
        data = buf.getvalue()
    with open(a.out, "wb") as fh: fh.write(data)

if __name__ == "__main__":
    main()
