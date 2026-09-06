#!/usr/bin/env python3
"""Corel path-transfer: remap CorelDRAW SVG art bbox into square studio SVG.
Studio wiring: lib/corelImport.js + server engine corel-import (NOT default PNG Vectorize).
Mode for DecoClub Corel-equal golden tiger (not SRC-literal).
"""
import re, sys
from collections import Counter

def transfer(src_svg, out_svg, size_in=10.0, pad=40.0):
    s = open(src_svg).read()
    classes = dict(re.findall(r"\.(fil\d+)\s*\{([^}]+)\}", s))
    fills = {}
    for k, v in classes.items():
        m = re.search(r"fill:(#[0-9A-Fa-f]+)", v)
        if m:
            fills[k] = m.group(1).lower()
    # Measured Corel art extent
    minx, miny, maxx, maxy = 8102.66, 3720.8, 12404.84, 8322.44
    minx -= pad; miny -= pad; maxx += pad; maxy += pad
    bw, bh = maxx - minx, maxy - miny
    side = max(bw, bh)
    ox = minx - (side - bw) / 2
    oy = miny - (side - bh) / 2
    SCALE = size_in / side

    def xform(x, y):
        return (x - ox) * SCALE, (y - oy) * SCALE

    def transform_path(d):
        tokens = re.findall(r"[MmCcLlZzHhVvSsQqTtAa]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", d)
        out = []; i = 0; cmd = None; x = 0; y = 0; startx = 0; starty = 0
        while i < len(tokens):
            t = tokens[i]
            if re.match(r"[A-Za-z]", t):
                cmd = t; i += 1
                if cmd in ("Z", "z"):
                    out.append("Z"); x, y = startx, starty
                continue
            if cmd == "M":
                x = float(t); y = float(tokens[i+1]); i += 2
                tx, ty = xform(x, y); startx, starty = x, y
                out.append("M %.4f %.4f" % (tx, ty)); cmd = "L"
            elif cmd == "m":
                x += float(t); y += float(tokens[i+1]); i += 2
                tx, ty = xform(x, y); startx, starty = x, y
                out.append("M %.4f %.4f" % (tx, ty)); cmd = "l"
            elif cmd == "L":
                x = float(t); y = float(tokens[i+1]); i += 2
                tx, ty = xform(x, y); out.append("L %.4f %.4f" % (tx, ty))
            elif cmd == "l":
                dx = float(t); dy = float(tokens[i+1]); i += 2
                x += dx; y += dy; out.append("l %.4f %.4f" % (dx*SCALE, dy*SCALE))
            elif cmd == "C":
                nums = [float(tokens[i+k]) for k in range(6)]; i += 6
                pts = []
                for k in range(0, 6, 2):
                    px, py = xform(nums[k], nums[k+1]); pts.extend([px, py])
                x, y = nums[4], nums[5]
                out.append("C " + " ".join("%.4f" % v for v in pts))
            elif cmd == "c":
                nums = [float(tokens[i+k]) for k in range(6)]; i += 6
                scaled = [n * SCALE for n in nums]
                x += nums[4]; y += nums[5]
                out.append("c " + " ".join("%.4f" % v for v in scaled))
            elif cmd == "H":
                x = float(t); i += 1; tx, _ = xform(x, y); out.append("H %.4f" % tx)
            elif cmd == "h":
                dx = float(t); i += 1; x += dx; out.append("h %.4f" % (dx*SCALE))
            elif cmd == "V":
                y = float(t); i += 1; _, ty = xform(x, y); out.append("V %.4f" % ty)
            elif cmd == "v":
                dy = float(t); i += 1; y += dy; out.append("v %.4f" % (dy*SCALE))
            elif cmd == "S":
                nums = [float(tokens[i+k]) for k in range(4)]; i += 4
                pts = []
                for k in range(0, 4, 2):
                    px, py = xform(nums[k], nums[k+1]); pts.extend([px, py])
                x, y = nums[2], nums[3]
                out.append("S " + " ".join("%.4f" % v for v in pts))
            elif cmd == "s":
                nums = [float(tokens[i+k]) for k in range(4)]; i += 4
                scaled = [n * SCALE for n in nums]
                x += nums[2]; y += nums[3]
                out.append("s " + " ".join("%.4f" % v for v in scaled))
            else:
                i += 1
        return " ".join(out)

    paths = []
    for m in re.finditer(r'<path class="(fil\d+)" d="([^"]+)"', s):
        cls, d = m.group(1), m.group(2)
        paths.append((fills.get(cls, "#000000"), transform_path(d)))
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="%gin" height="%gin" viewBox="0 0 %g %g">' % (size_in, size_in, size_in, size_in),
        '  <rect x="0" y="0" width="%g" height="%g" fill="#f0f4f9" data-name="paper-underlay"/>' % (size_in, size_in),
    ]
    for hexf, td in paths:
        parts.append('  <path d="%s" fill="%s" fill-rule="nonzero"/>' % (td, hexf))
    parts.append("</svg>")
    svg = "\n".join(parts) + "\n"
    open(out_svg, "w").write(svg)
    return {"paths": len(paths), "fills": dict(Counter(h for h, _ in paths)), "bytes": len(svg)}

if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "/workspace/perfect-bezier/corel-tiger.svg"
    dst = sys.argv[2] if len(sys.argv) > 2 else "/workspace/perfect-bezier/corel-match.svg"
    print(transfer(src, dst))
