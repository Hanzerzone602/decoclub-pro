#!/usr/bin/env python3
"""Pattern IR JSON (stdin or --in) → DST and/or EXP via pyembroidery.

JSON:
{
  "name": "DESIGN",
  "stitches": [{"x": 0, "y": 0, "cmd": "stitch"|"jump"|"trim"|"color"|"end"}],
  "threads": [{"hex": "#1e4482", "code": "1166", "name": "Royal", "brand": "madeira-rayon"}]
}

Units: 0.1 mm (Tajima). Writes files given as --dst / --exp, or DST bytes to stdout.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pyembroidery import (
    COLOR_CHANGE,
    END,
    JUMP,
    STITCH,
    TRIM,
    EmbPattern,
    EmbThread,
    write_dst,
    write_exp,
)

try:
    from pyembroidery import write_pes
except Exception:  # older wheels
    write_pes = None

CMD = {
    "stitch": STITCH,
    "jump": JUMP,
    "trim": TRIM,
    "color": COLOR_CHANGE,
    "color_change": COLOR_CHANGE,
    "end": END,
}


def hex_to_thread(t: dict) -> EmbThread:
    hx = str(t.get("hex") or "#111111")
    if not hx.startswith("#"):
        hx = "#" + hx
    return EmbThread(
        thread=hx,
        description=str(t.get("name") or "Thread"),
        catalog_number=str(t.get("code") or ""),
        brand=str(t.get("brand") or "Madeira"),
        chart="Rayon 40",
        weight="40",
    )


def pattern_from_ir(ir: dict) -> EmbPattern:
    p = EmbPattern()
    name = str(ir.get("name") or "DESIGN")[:16]
    p.extras["name"] = name
    threads = ir.get("threads") or []
    if not threads:
        threads = [{"hex": "#111111", "code": "1000", "name": "Black", "brand": "madeira-rayon"}]
    for t in threads:
        p.add_thread(hex_to_thread(t))
    last_x, last_y = 0, 0
    for s in ir.get("stitches") or []:
        cmd = CMD.get(str(s.get("cmd") or s.get("kind") or "stitch").lower(), STITCH)
        x = int(round(float(s.get("x") or 0)))
        y = int(round(float(s.get("y") or 0)))
        if cmd in (TRIM, COLOR_CHANGE, END):
            p.add_stitch_absolute(cmd, last_x, last_y)
        else:
            p.add_stitch_absolute(cmd, x, y)
            last_x, last_y = x, y
    p.add_command(END)
    return p


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="infile", default="-")
    ap.add_argument("--dst", dest="dst", default="")
    ap.add_argument("--exp", dest="exp", default="")
    ap.add_argument("--pes", dest="pes", default="")
    ap.add_argument("--stdout", choices=["dst", "exp", "none"], default="none")
    args = ap.parse_args()
    raw = sys.stdin.read() if args.infile in ("", "-") else Path(args.infile).read_text(encoding="utf-8")
    ir = json.loads(raw)
    pat = pattern_from_ir(ir)
    if args.dst:
        Path(args.dst).parent.mkdir(parents=True, exist_ok=True)
        write_dst(pat, args.dst)
    if args.exp:
        Path(args.exp).parent.mkdir(parents=True, exist_ok=True)
        write_exp(pat, args.exp)
    if args.pes:
        if write_pes is None:
            raise SystemExit("pyembroidery write_pes is not available")
        Path(args.pes).parent.mkdir(parents=True, exist_ok=True)
        write_pes(pat, args.pes)
    if args.stdout == "dst":
        import io
        buf = io.BytesIO()
        write_dst(pat, buf)
        sys.stdout.buffer.write(buf.getvalue())
    elif args.stdout == "exp":
        import io
        buf = io.BytesIO()
        write_exp(pat, buf)
        sys.stdout.buffer.write(buf.getvalue())
    meta = {
        "ok": True,
        "exporter": "pyembroidery",
        "stitchCount": pat.count_stitch_commands(STITCH),
        "trimCount": pat.count_stitch_commands(TRIM),
        "colorChanges": pat.count_stitch_commands(COLOR_CHANGE),
        "threads": len(pat.threadlist),
        "dst": args.dst or None,
        "exp": args.exp or None,
    }
    if args.stdout == "none":
        sys.stdout.write(json.dumps(meta) + "\n")
    else:
        sys.stderr.write(json.dumps(meta) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
