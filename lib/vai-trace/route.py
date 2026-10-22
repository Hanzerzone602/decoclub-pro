#!/usr/bin/env python3
"""Vectorize router. Busy art -> VTracer round 11 (engine_r3.py = r11cand-6bc6eb5e); everything else
-> trace.py unchanged. Routing is engine_r3.decide() exactly as scored (r3final-1709485d).
Any VTracer/router error falls back to trace.py. Engine choice is logged to stderr."""
import json, os, re, runpy, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
TRACE = os.path.join(HERE, "trace.py")

R2 = os.path.join(HERE, "vt1_cut_r2.py")
R2_TIMEOUT = float(os.environ.get("VECTORIZE_R2_TIMEOUT") or 15)

def size_r2(svg, inches):
    """r2 writes pixel width/height (plus a viewBox when it traced downscaled). Live SVGs are sized in
    inches with the longest side = --inches, so set that on the root <svg> and keep geometry via viewBox."""
    m = re.search(r'<svg\b[^>]*>', svg)
    tag = m.group(0)
    W = float(re.search(r'\bwidth="([\d.]+)(?:in)?"', tag).group(1)); H = float(re.search(r'\bheight="([\d.]+)(?:in)?"', tag).group(1))
    vb = re.search(r'viewBox="([^"]*)"', tag)
    vb = vb.group(1) if vb else "0 0 %g %g" % (W, H)
    k = inches / max(W, H)
    new = re.sub(r'\s(width|height|viewBox)="[^"]*"', "", tag)
    new = new[:-1].rstrip() + ' width="%.4fin" height="%.4fin" viewBox="%s">' % (W * k, H * k, vb)
    return svg[:m.start()] + new + svg[m.end():]

def try_r2(inp, out, inches):
    """Round-2 tracer (vt1_cut_r2 = cand-bedf48d7) in its own venv, behind VECTORIZE_R2=1 (default-slider auto mode).
    Returns True on success; any error, timeout or empty SVG returns False (caller falls back to r11)."""
    py = os.environ.get("VECTORIZE_R2_PYTHON") or "/venv-r2/bin/python3"
    tmp = out + ".r2tmp"
    t0 = time.perf_counter()
    try:
        p = subprocess.run([py, R2, "--input", inp, "--output", tmp], capture_output=True, timeout=R2_TIMEOUT)
        if p.returncode != 0:
            raise RuntimeError("exit %d %s" % (p.returncode, p.stderr.decode(errors="replace")[-200:]))
        with open(tmp) as f:
            svg = f.read()
        if "<path" not in svg:
            raise RuntimeError("empty r2 svg")
        with open(out, "w") as f:
            f.write(size_r2(svg, inches))
        os.remove(tmp)
    except Exception as e:
        log("engine=r2 failed, fallback r11: " + repr(e)[:200])
        try: os.remove(tmp)
        except OSError: pass
        return False
    dt = time.perf_counter() - t0
    log("engine=r2 %.2fs" % dt)
    sys.stdout.write(json.dumps({"mode": "r2", "route": "r2-cut", "engine": "r12-6d7aacec", "seconds": round(dt, 2)}) + "\n")
    return True

def _engine_ver():
    import hashlib
    with open(os.path.join(HERE, "engine_r3.py"), "rb") as f:
        return "r11-" + hashlib.md5(f.read()).hexdigest()[:8]
ENGINE_VER = _engine_ver()

def busy_r11(E, inp, inches, rgb):
    """r11 per-image chooser, exactly as E.vectorise: >=2 Mpx -> r8 route only;
    smaller -> trace both, quick_score, choose(). Returns (svg, route label actually chosen)."""
    H, W = rgb.shape[:2]
    if H * W / 1e6 >= E.BIG_MPX:
        return E.trace_busy_r8(inp, inches), "r11-r8-big"
    s3 = E.trace_busy(inp, 10.0); s8 = E.trace_busy_r8(inp, 10.0)
    if E.choose(E.quick_score(inp, s3), E.quick_score(inp, s8)):
        return (s8 if inches == 10.0 else E.trace_busy_r8(inp, inches)), "r11-r8"
    return (s3 if inches == 10.0 else E.trace_busy(inp, inches)), "r11-r3"

def log(msg):
    sys.stderr.write("[vai-route] " + msg + "\n"); sys.stderr.flush()

def run_trace(reason):
    log("engine=trace.py reason=" + reason)
    sys.argv[0] = TRACE
    runpy.run_path(TRACE, run_name="__main__")

def arg(name):
    a = sys.argv
    return a[a.index(name) + 1] if name in a and a.index(name) + 1 < len(a) else None

def main():
    if os.environ.get("VAI_ROUTE_DISABLE") == "1":
        return run_trace("disabled")
    # The server always sends --colors (detail slider) and --cache-dir. Routing ignores both:
    # flat art goes to trace.py with the original args (unchanged), busy art gets VTracer as scored.
    # A live colour drop from cache and explicit non-auto modes stay on trace.py.
    if arg("--from-cache") or (arg("--mode") or "auto") != "auto":
        return run_trace("options")
    inp, out = arg("--input"), arg("--output")
    inches = float(arg("--inches") or 10.0)
    if os.environ.get("VECTORIZE_R2") == "1":
        if arg("--colors") in (None, "8", "14") and not (arg("--merge") or arg("--keep") or arg("--smooth") or arg("--corners")):
            if try_r2(inp, out, inches):
                return
        else:
            log("engine=r2 skipped, slider colors=%s" % arg("--colors"))
    try:
        t0 = time.perf_counter()
        sys.path.insert(0, HERE)
        import engine_r3 as E
        rgb = E.load_rgb(inp)
        _idx, _pr, stats, flat = E.decide(rgb)
        if flat:
            return run_trace("flat k=%d" % stats["k"])
        svg, route = busy_r11(E, inp, inches, rgb)
        if "<path" not in svg:
            raise RuntimeError("empty VTracer svg")
        with open(out, "w") as f:
            f.write(svg)
        dt = time.perf_counter() - t0
        log("engine=%s busy k=%d %.2fs" % (route, stats["k"], dt))
        sys.stdout.write(json.dumps({"mode": "busy", "route": route, "engine": ENGINE_VER, "seconds": round(dt, 2)}) + "\n")
    except SystemExit:
        raise
    except Exception as e:
        return run_trace("vtracer-error " + repr(e)[:200])

if __name__ == "__main__":
    main()
