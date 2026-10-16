#!/usr/bin/env python3
"""Vectorize router. Busy art -> VTracer round 11 (engine_r3.py = r11cand-6bc6eb5e); everything else
-> trace.py unchanged. Routing is engine_r3.decide() exactly as scored (r3final-1709485d).
Any VTracer/router error falls back to trace.py. Engine choice is logged to stderr."""
import json, os, runpy, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
TRACE = os.path.join(HERE, "trace.py")

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
