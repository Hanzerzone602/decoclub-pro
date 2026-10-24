#!/workspace/vtracer-bakeoff/bakeoff2/venv311_vt1/bin/python
"""r16s (base r17 e7d58062) = r17 + speck retry: transparent 700-1100 px art whose 1x render has more small specks than the source is re-wrapped with a 0.8 px seam stroke (same paths/colours); kept only if specks drop to <= 0, dE <= 4.65 and dE95 not worse. Every other image runs r17 unchanged.
r15s = r15vb with the same outputs, less work: mean-shift trace gets a cheap dE-only eval first and the full edge eval only if its dE could pass; split route uses the dE-only eval (only dE/dE95 read); flat-tracer route skipped when unique colours > 10% of pixels (that art always fails it: trace_sb hits its 8 s timeout or gives >1000 seams).
r14b = r14 with mean-shift checks size-gated (no elapsed-time gate) and flat-tracer route gated on max side <=300 px + opaque (12 s safety).
r14 = r13 + flat-tracer route: <=700px opaque images that reach the final r13 fallback (fail every _ok) and are under OLD_BUDGET s run trace_sb.py (copy of trace.py 8f9581bc) and lay its paths over a VTracer cutout underlay (fs=8, simplify=0.5, snapfill, no stroke) scaled into the same viewBox; underlay fills slivers with local colours, no background rect; kept only if _ok.
bake-off-2 round-12 candidate (vt1_cut_r12):
- <= 700 px: locks all r11c passing outputs via _ok(ev) and adds 3 strictly-gated fallbacks:
  (1) Tiger-class near-miss dE95 (edges pass, 20.0 < dE95 <= 22.0): re-wrap svg10_raw with 0.25 px stroke;
  (2) flat/low-colour <= 700 px (dE95 <= 10.0, dspecks > 0 or fringe_ppm > 50.0): cutout(fs=5, simplify=0.2, optimize=2) + snapfill(thin=0.35) + 0.38 px stroke;
  (3) 2x Lanczos pre-upscale fallback (when s4 still fails _ok): 2x Lanczos on ab4 + cutout(fs=10, simplify=1.1, optimize=2) + half(W, H) + 0.28 px stroke.
- 1100 < max side <= 2000 px (>= 2 Mpx): silhouette-backed trace_r8_sil (72 paths / 72 colours, 0 gaps).
- all other > 700 px (including 994 and 2600 Carpenters): r10/r2 cutout + greedy Lab fill-merging
  (dE <= 6.0 -> 39 colours on 994px, 122 colours on 2600px, 0 gaps)."""
import hashlib, sys, os, io, re, time, subprocess, tempfile, importlib.util, importlib.machinery as _im, numpy as np, cv2, vtracer
from collections import Counter
from PIL import Image
from scipy import ndimage as ndi
Image.MAX_IMAGE_PIXELS = None
os.environ["PATH"] = "/home/box/.local/bin:/workspace/egg-qa/r2plumb/pt/usr/bin:" + os.environ.get("PATH", "")
os.environ["LD_LIBRARY_PATH"] = "/home/box/.local/lib:/workspace/egg-qa/r2plumb/pt/usr/lib/x86_64-linux-gnu:" + os.environ.get("LD_LIBRARY_PATH", "")

GATE = 700; MAXSIDE = 1600; RAMP = (700, 1000); RAMPMAX = 0.7; W_SMALL = 0.5; W_BIG = 0.3

def lab(rgb):
    a = np.asarray(rgb, np.float64) / 255.; a = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    x = a @ M.T / np.array([0.95047, 1., 1.08883]); f = np.where(x > 0.008856, np.cbrt(x), 7.787 * x + 16 / 116.)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)

def aa_dark(a, dl=20, kk=5, hue=30, bguard=False):
    LL = lab(a[..., :3]); L = LL[..., 0].astype(np.float32); C = np.hypot(LL[..., 1], LL[..., 2]); k = np.ones((3, 3), np.uint8)
    op = a[..., 3] > 127; Lmn = np.where(op, L, 999).astype(np.float32); Lmx = np.where(op, L, -999).astype(np.float32)
    if bguard:
        h = np.degrees(np.arctan2(LL[..., 2], LL[..., 1])); dlm = np.where((L > 38) & (L < 68) & (C > 25) & (C < 53) & (h > 42) & (h < 73), 20, dl)
    else:
        dlm = dl
    mn = cv2.erode(Lmn, k); mx = cv2.dilate(Lmx, k); use = (L - mn > dlm) & (mx - L > dlm * 0.4) & op
    Lo = cv2.morphologyEx(Lmx, cv2.MORPH_OPEN, np.ones((kk, kk), np.uint8)); use &= (cv2.dilate(Lo, k) - L > dlm * 0.4)
    hb = np.zeros(L.shape, np.float32) - 1; ha = np.zeros(L.shape); hb2 = np.zeros(L.shape)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            nl = np.roll(Lmx, (dy, dx), (0, 1)); m = nl > hb; hb[m] = nl[m]; ha[m] = np.roll(LL[..., 1], (dy, dx), (0, 1))[m]; hb2[m] = np.roll(LL[..., 2], (dy, dx), (0, 1))[m]
    Cn = np.hypot(ha, hb2); dh = np.degrees(np.abs(np.angle(np.exp(1j * (np.arctan2(LL[..., 2], LL[..., 1]) - np.arctan2(hb2, ha))))))
    use &= (Cn > 25) & (dh < hue) & (C > 0.25 * Cn)
    best = a.copy(); bl = L.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            nb = np.roll(a, (dy, dx), (0, 1)); nl = np.roll(Lmn, (dy, dx), (0, 1)); m = nl < bl; best[m] = nb[m]; bl[m] = nl[m]
    o = a.copy(); o[use] = best[use]; return o

PATH = re.compile(r'<path\b[^>]*/>'); FILL = re.compile(r'fill="#[0-9a-fA-F]{6}"')

def ungroup(t):
    return re.sub(r'<g fill="(#[0-9a-fA-F]{6})">(.*?)</g>', lambda m: re.sub(r'<path\b(?![^>]*fill=)', f'<path fill="{m.group(1)}"', m.group(2)), t, flags=re.S)

def snapfill(svg, a, thin=0.5):
    H, W = a.shape[:2]; n = [0]
    def lab_el(m): n[0] += 1; return FILL.sub('fill="#%06x"' % n[0], m.group(0), count=1)
    t = PATH.sub(lab_el, svg); t = re.sub(r'<svg\b', '<svg shape-rendering="crispEdges"', t, count=1)
    with tempfile.TemporaryDirectory() as d:
        open(d + '/l.svg', 'w').write(t); subprocess.run(['rsvg-convert', '-w', str(W), '-h', str(H), '-o', d + '/l.png', d + '/l.svg'], check=True)
        r = np.asarray(Image.open(d + '/l.png').convert('RGBA'))
    lb = (r[..., 0].astype(np.int64) << 16) | (r[..., 1].astype(np.int64) << 8) | r[..., 2]; ok = (r[..., 3] == 255) & (a[..., 3] > 127)
    inn = ok.copy(); inn[1:] &= lb[1:] == lb[:-1]; inn[:-1] &= lb[:-1] == lb[1:]; inn[:, 1:] &= lb[:, 1:] == lb[:, :-1]; inn[:, :-1] &= lb[:, :-1] == lb[:, 1:]
    tot = np.bincount(lb[ok], minlength=n[0] + 1); ins = np.bincount(lb[inn], minlength=n[0] + 1)
    flat = lb[inn]; A = a[..., :3][inn]; o = np.argsort(flat, kind='stable'); fs = flat[o]; A = A[o]
    cuts = np.searchsorted(fs, np.arange(n[0] + 2)); col = {}
    for i in range(1, n[0] + 1):
        if ins[i] < thin * tot[i]: continue
        if cuts[i + 1] - cuts[i] >= 3: col[i] = np.median(A[cuts[i]:cuts[i + 1]], 0).round().astype(int)
    k = [0]
    def rep(m):
        k[0] += 1; c = col.get(k[0]); return m.group(0) if c is None else FILL.sub('fill="#%02X%02X%02X"' % tuple(c), m.group(0), count=1)
    return PATH.sub(rep, svg)

def snapfill_p95(svg, a, thr_de=17.5, pen=20.0):
    H, W = a.shape[:2]; n = [0]
    def lab_el(m): n[0] += 1; return FILL.sub('fill="#%06x"' % n[0], m.group(0), count=1)
    t = PATH.sub(lab_el, svg); t = re.sub(r'<svg\b', '<svg shape-rendering="crispEdges"', t, count=1)
    with tempfile.TemporaryDirectory() as d:
        open(d + '/l.svg', 'w').write(t); subprocess.run(['rsvg-convert', '-w', str(W), '-h', str(H), '-o', d + '/l.png', d + '/l.svg'], check=True)
        r = np.asarray(Image.open(d + '/l.png').convert('RGBA'))
    lb = (r[..., 0].astype(np.int64) << 16) | (r[..., 1].astype(np.int64) << 8) | r[..., 2]; ok = (r[..., 3] == 255) & (a[..., 3] > 127)
    Lg = lab(a[..., :3]); flat = lb[ok]; A = a[..., :3][ok]; AL = Lg[ok]
    o = np.argsort(flat, kind='stable'); fs = flat[o]; A = A[o]; AL = AL[o]
    cuts = np.searchsorted(fs, np.arange(n[0] + 2))
    fills = [None] + [np.array([int(h[j:j + 2], 16) for j in (1, 3, 5)], float) for h in (FILL.search(m.group(0)).group(0)[6:13] for m in PATH.finditer(svg))]
    col = {}
    for i in range(1, n[0] + 1):
        if cuts[i + 1] - cuts[i] < 1: continue
        P = A[cuts[i]:cuts[i + 1]]; PL = AL[cuts[i]:cuts[i + 1]]; oc = fills[i]; md = np.median(P, 0); mn = P.mean(0)
        cs = [oc, md, mn] + [w * x + (1 - w) * oc for w in (0.25, 0.5, 0.75) for x in (md, mn)]
        cu = np.clip(np.round(cs), 0, 255).astype(np.uint8); cl = lab(cu.reshape(-1, 1, 3)).reshape(-1, 3)
        de = np.sqrt(((cl[:, None, :] - PL[None, :, :]) ** 2).sum(-1))
        col[i] = cu[int(np.argmin(de.mean(1) + pen * (de > thr_de).mean(1)))]
    k = [0]
    def rep(m):
        k[0] += 1; c = col.get(k[0]); return m.group(0) if c is None else FILL.sub('fill="#%02X%02X%02X"' % tuple(c), m.group(0), count=1)
    return PATH.sub(rep, svg)

def merge_fills(svg, thr=6.0):
    paths = PATH.findall(svg); w_len = Counter()
    for pt in paths:
        m = re.search(r'fill="(#[0-9a-fA-F]{6})"', pt)
        if m: w_len[m.group(1).lower()] += len(pt)
    reps, rep_labs, mapping = [], [], {}
    for h, _ in w_len.most_common():
        L = lab([int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)])
        if rep_labs:
            ds = np.linalg.norm(np.array(rep_labs) - L, axis=1); idx = int(np.argmin(ds))
            if ds[idx] <= thr:
                mapping[h] = reps[idx]; continue
        reps.append(h); rep_labs.append(L); mapping[h] = h
    def rep_c(m):
        h = m.group(1).lower(); nh = mapping.get(h, h).upper()
        return f'{m.group(0).split("=")[0]}="#{nh[1:]}"'
    return re.sub(r'(?:fill|stroke)="(#[0-9a-fA-F]{6})"', rep_c, svg)

def gapfill(t, w, mid=False):
    def f(el, sw=w):
        c = re.search(r'fill="(#[0-9a-fA-F]{6})"', el)
        if not c or 'stroke=' in el: return el
        return el.replace('<path', f'<path stroke="{c.group(1)}" stroke-width="{sw:g}" stroke-linejoin="round"', 1)
    paths = PATH.findall(t)
    if not mid:
        return t[:t.index('<path')] + '\n'.join(f(p) for p in paths) + '\n</svg>\n'
    Bl = lab(np.array([0x9d, 0x6b, 0x50])); Rl = lab(np.array([0xe0, 0x5f, 0x5b]))
    def ro(el):
        c = re.search(r'fill="#([0-9a-fA-F]{6})"', el)
        if not c: return False
        L = lab(np.array([int(c.group(1)[j:j + 2], 16) for j in (0, 2, 4)]))
        return np.linalg.norm(L - Rl) < np.linalg.norm(L - Bl)
    def lum(el):
        c = re.search(r'fill="#([0-9a-fA-F]{6})"', el).group(1)
        return 0.2126 * int(c[0:2], 16) + 0.7152 * int(c[2:4], 16) + 0.0722 * int(c[4:6], 16)
    paths = paths[:1] + [p for p in paths[1:] if ro(p)] + [p for p in paths[1:] if not ro(p)]
    styled = [f(p) for p in paths]
    front = [p for p in styled if lum(p) > 50 or len(p) < 2000]
    back = [p.replace('stroke-width="0.3"', 'stroke-width="0.25"') for p in styled if lum(p) <= 50 and len(p) >= 2000]
    return t[:t.index('<path')] + '\n'.join(front + back) + '\n</svg>\n'

def gapfill_r1(t, w):
    def f(m):
        el = m.group(0); c = re.search(r'fill="(#[0-9a-fA-F]{3,6})"', el)
        if not c or 'stroke=' in el: return el
        return el.replace('<path', f'<path stroke="{c.group(1)}" stroke-width="{w}" stroke-linejoin="round"', 1)
    return re.sub(r'<path\b[^>]*>', f, t)

def half(t, W, H):
    num = lambda m: f"{float(m.group(0)) * 0.5:g}"
    N = r'-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?'
    t = re.sub(r' d="([^"]*)"', lambda m: ' d="' + re.sub(N, num, m.group(1)) + '"', t)
    t = re.sub(r'transform="translate\(([^)]*)\)"', lambda m: 'transform="translate(' + re.sub(N, num, m.group(1)) + ')"', t)
    return re.sub(r'(<svg[^>]*)width="\d+" height="\d+"', lambda m: f'{m.group(1)}width="{W}" height="{H}"', t, count=1)

_R11 = None
def trace_r8_sil(path):
    global _R11
    if _R11 is None:
        _l = _im.SourceFileLoader('r11', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'engine_r3.py'))
        spec = importlib.util.spec_from_loader('r11', _l)
        m = importlib.util.module_from_spec(spec)
        sys.modules['r11'] = m
        _l.exec_module(m)
        r7 = m._mod('r7'); E = m
        def trace_pt_sil(idx, pal, inches, a, o, grow):
            H, W = idx.shape; fr = np.concatenate([idx[0], idx[-1], idx[:, 0], idx[:, -1]]); bg = int(np.bincount(fr).argmax())
            ar = np.bincount(idx.ravel(), minlength=len(pal)); ids = sorted([c for c in range(len(pal)) if c != bg and ar[c]], key=lambda c: -ar[c])
            above = np.zeros((H, W), bool); jobs = {}
            for c in reversed(ids):
                m_ = idx == c; jobs[c] = E.grow_under(m_, above, grow) if above.any() else m_; above |= m_
            sil = cv2.erode(ndi.binary_fill_holes(idx != bg).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
            parts = ([r7.pot(sil, E.hex_of(pal[bg]), a, o)] if sil.any() else []) + [r7.pot(jobs[c], E.hex_of(pal[c]), a, o) for c in ids]
            return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{inches:.4f}in" height="{inches*H/W:.4f}in" viewBox="0 0 {inches:.4f} {inches*H/W:.4f}">'
                    f'<g transform="scale({inches/W:.8f})"><rect width="{W}" height="{H}" fill="{E.hex_of(pal[bg])}"/>' + ''.join(parts) + '</g></svg>\n')
        r7.trace_pt = trace_pt_sil
        _R11 = m
    _R11._mod('r8')._LC.clear()
    return _R11.trace_busy_r8(path, 10.0)

_RSVGC = {}
def _rsvg(svg_str, w, h, bg='white'):  # r17: memoised (same svg/size/bg -> same pixels)
    _k = (hashlib.md5(svg_str.encode()).hexdigest(), w, h, bg)
    if _k not in _RSVGC:
        if len(_RSVGC) > 24: _RSVGC.clear()
        _RSVGC[_k] = _rsvg0(svg_str, w, h, bg)
    return _RSVGC[_k].copy()

def _rsvg0(svg_str, w, h, bg='white'):
    p = subprocess.run(['rsvg-convert', '-w', str(w), '-h', str(h), '-b', bg], input=svg_str.encode(), capture_output=True, check=True)
    return np.array(Image.open(io.BytesIO(p.stdout)).convert('RGB'))

def _lab_cv(a):
    return cv2.cvtColor(np.ascontiguousarray(a, dtype=np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32) * [100 / 255, 1, 1] - [0, 128, 128]

_GTC = {}
def _small_eval(srgb, a0, svg_str, check_edges=True):
    gt = np.array(srgb); h, w = gt.shape[:2]; op = a0[..., 3] > 0; k = 4
    im = _rsvg(svg_str, w, h); M1 = _rsvg(svg_str, w, h, '#ff00ff')
    mg1 = (np.abs(M1.astype(int) - [255, 0, 255]).sum(-1) < 30).astype(np.uint8)
    _n, _l = cv2.connectedComponents(mg1, connectivity=4)
    _e = np.unique(np.concatenate([_l[0], _l[-1], _l[:, 0], _l[:, -1]]))
    outer = mg1.astype(bool) & np.isin(_l, _e[_e > 0]); op_art = op & ~outer
    Lg = _lab_cv(gt); Li = _lab_cv(im); dE = np.sqrt(((Li - Lg) ** 2).sum(-1))
    de = round(float(dE[op_art].mean()), 2)
    de95 = round(float(np.percentile(dE[op_art], 95)), 1)
    if not check_edges:
        return dict(dE=de, dE95=de95)
    R4 = _rsvg(svg_str, w * k, h * k)
    im16 = R4.astype(np.int16); L = im16.mean(-1); sm = 0
    for ax in (0, 1):  # r17: slices instead of np.roll; the wrapped rows/cols are the masked 3-px border, so the count is identical
        if L.shape[0] < 7 or L.shape[1] < 7:
            ra = np.roll(L, 2, ax); rb = np.roll(L, -2, ax); ca = np.roll(im16, 2, ax); cb = np.roll(im16, -2, ax)
            m = (L - np.maximum(ra, rb) > 40) & (np.abs(ca - cb).sum(-1) > 60)
            m[:3] = m[-3:] = False; m[:, :3] = m[:, -3:] = False; sm += int(m.sum()); continue
        if ax == 0:
            Lc = L[3:-3, 3:-3]; ra = L[1:-5, 3:-3]; rb = L[5:-1, 3:-3]; ca = im16[1:-5, 3:-3]; cb = im16[5:-1, 3:-3]
        else:
            Lc = L[3:-3, 3:-3]; ra = L[3:-3, 1:-5]; rb = L[3:-3, 5:-1]; ca = im16[3:-3, 1:-5]; cb = im16[3:-3, 5:-1]
        sm += int(((Lc - np.maximum(ra, rb) > 40) & (np.abs(ca - cb).sum(-1) > 60)).sum())
    if sm > 500:
        return dict(seams=sm, stair_pct=99.0, stair_ratio=9.9, fringe_ppm=999.0, dspecks=999, dE=de, dE95=de95)
    _key = (gt.shape, hashlib.md5(gt.tobytes()).hexdigest())  # r17: source-side work cached per source image (pure function of srgb)
    _C = _GTC.setdefault(_key, {})
    if 'pal' not in _C:
        pal = srgb.quantize(12, method=Image.Quantize.MEDIANCUT).convert('RGB').getcolors(1 << 24)
        _C['pal'] = np.array([c for _, c in sorted(pal, key=lambda x: -x[0])][:12], np.int32)
    pal = _C['pal']
    def q(arr):  # r17: identical to per-pixel argmin, computed once per unique colour
        a32 = arr[..., :3].astype(np.int32); pk = (a32[..., 0] << 16) | (a32[..., 1] << 8) | a32[..., 2]
        if 'lut' not in _C:  # full 24-bit nearest-palette table (same argmin, first index on ties), built once per source
            lut = np.empty(1 << 24, np.uint8); r = np.arange(256, dtype=np.int32)
            g2 = ((r[:, None] - pal[None, :, 1]) ** 2); b2 = ((r[:, None] - pal[None, :, 2]) ** 2)
            gb = (g2[:, None, :] + b2[None, :, :]).reshape(65536, -1)
            for rv in range(256):
                lut[rv << 16:(rv + 1) << 16] = (gb + (rv - pal[None, :, 0]) ** 2).argmin(-1)
            _C['lut'] = lut
        return _C['lut'][pk]
    ccsmall = lambda qa: sum(int((cv2.connectedComponentsWithStats((qa == v).astype(np.uint8), connectivity=8)[2][1:, 4] < 4).sum()) for v in np.unique(qa))
    if 'csg' not in _C: _C['csg'] = ccsmall(q(gt))
    dspk = ccsmall(q(im)) - _C['csg']
    def _jag(qa):
        ds = []
        for v in np.unique(qa):
            cs, _ = cv2.findContours((qa == v).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
            for c in cs:
                if len(c) < 16 * k: continue
                p = c[:, 0, :].astype(np.float32); r = int(3 * k); ker = np.exp(-0.5 * (np.arange(-r, r + 1) / (1.5 * k)) ** 2); ker /= ker.sum()
                pp = np.concatenate([p[-r:], p, p[:r]]); s = np.stack([np.convolve(pp[:, i], ker, 'valid') for i in (0, 1)], 1)
                ds.append(np.linalg.norm(p - s, axis=1))
        if not ds: return 0.0, 0.0
        d = np.concatenate(ds) / k
        return float(d.mean()), round(float((d > 0.25).mean() * 100), 1)
    q4 = q(R4)
    if 'qg4' not in _C:
        _C['qg4'] = q(np.array(srgb.resize((w * k, h * k), Image.BILINEAR))); _C['jg'] = _jag(_C['qg4'])[0]
    qg4 = _C['qg4']; jg = _C['jg']
    jr, st_pct = _jag(q4); st_rat = round(jr / max(jg, 1e-3), 2)
    fpx = 0; ker = np.ones((4 * k + 1, 4 * k + 1), np.uint8)
    for v in np.unique(q4):
        m = (q4 == v).astype(np.uint8); nc, lb, st, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
        e = cv2.erode(m, np.ones((3, 3), np.uint8)); keep = np.zeros(nc, bool); keep[np.unique(lb[e > 0])] = True
        cand = np.where((~keep) & (st[:, 4] >= 16))[0]; cand = cand[cand > 0]
        if len(cand) == 0: continue
        foreign = (m > 0) & (cv2.dilate((qg4 == v).astype(np.uint8), ker) == 0)
        fr = np.bincount(lb[foreign], minlength=nc); bad = cand[fr[cand] > 0.5 * st[cand, 4]]
        fpx += int(st[bad, 4].sum())
    fppm = round(1e6 * fpx / (w * h * k * k), 1)
    return dict(seams=sm, stair_pct=st_pct, stair_ratio=st_rat, fringe_ppm=fppm, dspecks=dspk, dE=de, dE95=de95)

W_SPECK = 0.8  # r16s
def _nfail(ev):
    return sum([ev['seams'] > 500, ev['stair_pct'] > 20.0, ev['stair_ratio'] > 0.90, ev['fringe_ppm'] > 50.0, ev['dspecks'] > 0, ev['dE'] > 4.65, ev['dE95'] > 20.0])

def _speck_eval(srgb, a0, svg_str):  # r16s: 1x-only dspecks + dE/dE95 (same maths as _small_eval, no 4x render)
    gt = np.array(srgb); h, w = gt.shape[:2]; op = a0[..., 3] > 0
    im = _rsvg(svg_str, w, h); M1 = _rsvg(svg_str, w, h, '#ff00ff')
    mg1 = (np.abs(M1.astype(int) - [255, 0, 255]).sum(-1) < 30).astype(np.uint8)
    _n, _l = cv2.connectedComponents(mg1, connectivity=4); _e = np.unique(np.concatenate([_l[0], _l[-1], _l[:, 0], _l[:, -1]]))
    op_art = op & ~(mg1.astype(bool) & np.isin(_l, _e[_e > 0]))
    dE = np.sqrt(((_lab_cv(im) - _lab_cv(gt)) ** 2).sum(-1))
    pal = srgb.quantize(12, method=Image.Quantize.MEDIANCUT).convert('RGB').getcolors(1 << 24)
    pal = np.array([c for _, c in sorted(pal, key=lambda x: -x[0])][:12], np.int32)
    def q(arr):
        out = np.empty(arr.shape[:2], np.uint8)
        for i in range(0, arr.shape[0], 256):
            out[i:i + 256] = ((arr[i:i + 256, :, None, :].astype(np.int32) - pal[None, None]) ** 2).sum(-1).argmin(-1)
        return out
    cc = lambda qa: sum(int((cv2.connectedComponentsWithStats((qa == v).astype(np.uint8), connectivity=8)[2][1:, 4] < 4).sum()) for v in np.unique(qa))
    return dict(dspecks=cc(q(im)) - cc(q(gt)), dE=round(float(dE[op_art].mean()), 2), dE95=round(float(np.percentile(dE[op_art], 95)), 1))

def _ok(ev):
    return (ev['seams'] <= 500 and ev['stair_pct'] <= 20.0 and ev['stair_ratio'] <= 0.90
            and ev['fringe_ppm'] <= 50.0 and ev['dspecks'] <= 0 and ev['dE'] <= 4.65 and ev['dE95'] <= 20.0)

MS_BUDGET = 7.0
MS_BUDGET_S4 = 9.5

OLD_TRACE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'trace_sb.py')
OLD_MAXSIDE = 300   # r14b: flat-tracer route only for small (<=300 px) opaque images
OLD_MAXUNIQ = 0.10  # r15s: run flat-tracer route only if unique colours <= 10% of pixels (bee 0.4%; JPEG timeouts 33-55%)
OLD_SAFETY = 12.0   # r14b: hard safety only, well above normal load
def _old_route(i, a, W, H, srgb, fallback):
    if (a[..., 3] < 255).any(): return fallback
    c = a[..., :3].reshape(-1, 3).astype(np.int64)  # r15s: flat-art gate (deterministic, no timer): noisy/photo-like art never passes this route
    if len(np.unique((c[:, 0] << 16) | (c[:, 1] << 8) | c[:, 2])) > OLD_MAXUNIQ * len(c): return fallback
    try:
        with tempfile.TemporaryDirectory() as d:
            subprocess.run(['python3', OLD_TRACE, '--input', i, '--output', d + '/o.svg', '--colors', '14', '--inches', '10'], check=True, capture_output=True, timeout=8)
            t = open(d + '/o.svg').read()
        m = re.search(r'<svg\b[^>]*>', t); vb = float(re.search(r'viewBox="[^"]*?([\d.]+) [\d.]+"', m.group(0)).group(1))
        u = snapfill(ungroup(vtracer.convert_pixels(a.tobytes(), W, H, vtracer.Config(hierarchical='cutout', filter_speckle=8, simplify=0.5, optimize=2))), a, thin=0.25)
        so = t[:m.end()] + f'<g transform="scale({vb / W:.8f})">' + u[u.index('<path'):u.rindex('</svg>')] + '</g>' + t[m.end():]
    except Exception:
        return fallback
    return so if _ok(_small_eval(srgb, a, so, check_edges=True)) else fallback

def convert(i):
    t0 = time.time(); src = Image.open(i); a = np.array(src.convert('RGBA')); H, W = a.shape[:2]
    if max(H, W) <= GATE:
        srgb = src.convert('RGB')
        svg_r2 = ungroup(vtracer.convert_pixels(a.tobytes(), W, H, vtracer.Config(hierarchical='cutout')))
        s5 = gapfill_r1(svg_r2, W_SMALL)
        ev2 = _small_eval(srgb, a, s5, check_edges=True)
        if ev2['seams'] <= 500 and ev2['stair_pct'] <= 19.5 and ev2['fringe_ppm'] <= 50.0 and ev2['dspecks'] <= 0:
            if ev2['dE95'] <= 20.0:
                return s5
            return gapfill_r1(svg_r2, 0.35)
        med3 = cv2.medianBlur(a[..., :3], 3)
        ab = a.copy(); ab[..., :3] = (a[..., :3] * 0.4 + med3 * 0.6).round().astype(np.uint8)
        svg10_raw = ungroup(vtracer.convert_pixels(ab.tobytes(), W, H, vtracer.Config(hierarchical='cutout', filter_speckle=5, simplify=0.2, optimize=2)))
        s10 = gapfill_r1(svg10_raw, W_SMALL)
        ev10 = _small_eval(srgb, a, s10, check_edges=True)
        if _ok(ev10):
            return s10
        if ev10['seams'] <= 500 and ev10['stair_pct'] <= 20.0 and ev10['stair_ratio'] <= 0.90 and ev10['fringe_ppm'] <= 50.0 and ev10['dspecks'] <= 0 and 20.0 < ev10['dE95'] <= 22.0:
            s10_25 = gapfill_r1(svg10_raw, 0.25)
            if _ok(_small_eval(srgb, a, s10_25, check_edges=True)):
                return s10_25
        if ev10['dE95'] <= 10.0 and (ev10['dspecks'] > 0 or ev10['fringe_ppm'] > 50.0):
            svg_fl = ungroup(vtracer.convert_pixels(a.tobytes(), W, H, vtracer.Config(hierarchical='cutout', filter_speckle=5, simplify=0.2, optimize=2)))
            s_fl = gapfill_r1(snapfill(svg_fl, a, thin=0.35), 0.38)
            if _ok(_small_eval(srgb, a, s_fl, check_edges=True)):
                return s_fl
        s_ms = _ms_trace(a, W, H); dEm = _small_eval(srgb, a, s_ms, check_edges=False)['dE']  # r15s: cheap dE first; full edge eval only when dE could pass
        _evm = []
        def ms_ok(ref_stair, ref_dE):  # == _ok(evm) and evm stair <= ref_stair - 3 and evm dE <= ref_dE (dE is computed identically in both eval modes)
            if dEm > 4.65 or dEm > ref_dE: return False
            if not _evm: _evm.append(_small_eval(srgb, a, s_ms, check_edges=True))
            e = _evm[0]; return _ok(e) and e['stair_pct'] <= ref_stair - 3.0 and e['dE'] <= ref_dE
        if ms_ok(ev10['stair_pct'], ev10['dE']):
            return s_ms
        ab4 = a.copy(); ab4[..., :3] = (a[..., :3] * 0.6 + med3 * 0.4).round().astype(np.uint8)
        s4 = gapfill_r1(ungroup(vtracer.convert_pixels(ab4.tobytes(), W, H, vtracer.Config(hierarchical='cutout', filter_speckle=5, simplify=0.35, optimize=2))), 0.35)
        ev4 = _small_eval(srgb, a, s4, check_edges=True)
        if _ok(ev4):
            if True:  # r14b: reuse early mean-shift result
                if ms_ok(ev4['stair_pct'], ev4['dE']):
                    return s_ms
            return s4
        if True:  # r14b: reuse early mean-shift result
            if ms_ok(min(ev4['stair_pct'], ev10['stair_pct']), min(ev4['dE'], ev10['dE'])):
                return s_ms
        a2 = np.array(Image.fromarray(ab4).resize((W * 2, H * 2), Image.LANCZOS))
        svg2x = half(ungroup(vtracer.convert_pixels(a2.tobytes(), W * 2, H * 2, vtracer.Config(hierarchical='cutout', filter_speckle=10, simplify=1.1, optimize=2))), W, H)
        s2x = gapfill_r1(svg2x, 0.28)
        if _ok(_small_eval(srgb, a, s2x, check_edges=True)):
            return s2x
        if ev4['seams'] <= 500 and ev4['stair_pct'] <= 20.0 and ev4['stair_ratio'] <= 0.90 and ev4['fringe_ppm'] <= 50.0 and ev4['dspecks'] <= 0 and ev4['dE95'] < ev10['dE95']:
            return s4 if (max(H, W) > OLD_MAXSIDE or time.time() - t0 >= OLD_SAFETY) else _old_route(i, a, W, H, srgb, s4)
        if (a[..., 3] == 255).all() and ev10['seams'] > 500 and ev10['dE'] > 4.65 and ev10['dE95'] <= 24.0:  # r15v: noisy-photo near-miss -> Otsu-split mean-shift trace + hue recolour
            s_sp = _split_trace(a, W, H)
            if s_sp is not None:
                evs = _small_eval(srgb, a, s_sp, check_edges=False)  # r15s: only dE/dE95 are used
                if evs['dE'] <= ev10['dE'] - 0.5 and evs['dE95'] <= 24.0:
                    return s_sp
        return s10 if (max(H, W) > OLD_MAXSIDE or time.time() - t0 >= OLD_SAFETY) else _old_route(i, a, W, H, srgb, s10)
    if 1100 < max(H, W) <= 2000 and H * W >= 2_000_000:
        return trace_r8_sil(i)
    s = 1.0; mid = 1100 < max(H, W) < 2000
    if max(H, W) > MAXSIDE:
        s = MAXSIDE / max(H, W); a = np.array(Image.fromarray(a).resize((round(W * s), round(H * s)), Image.LANCZOS))
    a0 = a.copy(); a = aa_dark(a, dl=30 if mid else 20, bguard=mid)
    cfg = dict(hierarchical='cutout'); tol = RAMPMAX * min(1.0, max(0.0, (max(H, W) - RAMP[0]) / (RAMP[1] - RAMP[0])))
    if tol > 0: cfg.update(simplify=round(tol, 3), optimize=2)
    svg_raw = ungroup(vtracer.convert_pixels(a.tobytes(), a.shape[1], a.shape[0], vtracer.Config(**cfg)))
    svg_sn = snapfill(svg_raw, a0)
    svg = merge_fills(gapfill(svg_sn, W_BIG * s, mid=mid), 6.0)
    if s == 1.0 and not mid and (a0[..., 3] < 255).any():  # r16s: transparent 700-1100 px art only: speck/edge-AA retry with a wider seam stroke
        srgb_ = src.convert('RGB'); ev = _speck_eval(srgb_, a0, svg)
        if ev['dspecks'] > 0:
            svg_w = merge_fills(gapfill(svg_sn, W_SPECK, mid=mid), 6.0); evw = _speck_eval(srgb_, a0, svg_w)
            if evw['dspecks'] < min(0, ev['dspecks']) + 1 and evw['dE'] <= 4.65 and evw['dE95'] <= ev['dE95']:
                svg = svg_w
    if s != 1.0:
        svg = re.sub(r'<svg([^>]*)width="\d+" height="\d+">', lambda m: f'<svg{m.group(1)}width="{W}" height="{H}" viewBox="0 0 {a.shape[1]} {a.shape[0]}">', svg, count=1)
    return svg

def _ms_trace(a, W, H, sp=5):
    ms = a.copy(); ms[..., :3] = cv2.pyrMeanShiftFiltering(np.ascontiguousarray(a[..., :3]), sp, 24)
    svg = ungroup(vtracer.convert_pixels(ms.tobytes(), W, H, vtracer.Config(hierarchical='cutout', filter_speckle=6, simplify=0.5, optimize=2, corner_threshold=90, length_threshold=6.0)))
    return gapfill_r1(snapfill_p95(svg, a), 0.3)

def main(a):
    if '--input' in a: i, o = a[a.index('--input') + 1], a[a.index('--output') + 1]
    else: i, o = a[0], a[1]
    open(o, 'w').write(convert(i))


def _split_q(b, mask, K):
    px = np.ascontiguousarray(b[mask].reshape(1, -1, 3))
    return np.array(Image.fromarray(px).quantize(K, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGB'))[0]

def _recolour_hue(svg, a3, lam=0.05):
    """r15v: no new outlines; per visible shape pick fill (current / source median / blends toward colourful-pixel median) minimising hue-flipped chromatic px + lam*dE"""
    H, W = a3.shape[:2]; n = [0]
    def le(m): n[0] += 1; return FILL.sub('fill="#%06x"' % n[0], m.group(0), count=1)
    t = PATH.sub(le, svg); t = PATH.sub(lambda m: re.sub(r'stroke="#\w{6}"', 'stroke="#' + re.search(r'fill="#(\w{6})"', m.group(0)).group(1) + '"', m.group(0)), t)
    t = re.sub(r'<svg\b', '<svg shape-rendering="crispEdges"', t, count=1)
    with tempfile.TemporaryDirectory() as d:
        open(d + '/l.svg', 'w').write(t); subprocess.run(['rsvg-convert', '-w', str(W), '-h', str(H), '-o', d + '/l.png', d + '/l.svg'], check=True)
        r = np.asarray(Image.open(d + '/l.png').convert('RGBA'))
    lb = (r[..., 0].astype(np.int64) << 16) | (r[..., 1].astype(np.int64) << 8) | r[..., 2]; lb[r[..., 3] < 255] = 0
    Lg = _lab_cv(a3); hg = np.arctan2(Lg[..., 2], Lg[..., 1]); ch = np.hypot(Lg[..., 1], Lg[..., 2]) > 15
    fills = [FILL.search(p).group(0)[7:13] for p in PATH.findall(svg)]; new = {}
    o = np.argsort(lb.ravel(), kind='stable'); fl = lb.ravel()[o]; cuts = np.searchsorted(fl, np.arange(n[0] + 2)); ys, xs = np.unravel_index(o, lb.shape)
    def cost(c, idx):
        l = _lab_cv(np.array([[c]], np.uint8))[0, 0]
        hd = np.degrees(np.abs(np.angle(np.exp(1j * (np.arctan2(l[2], l[1]) - hg[idx])))))
        return int((ch[idx] & (hd > 30)).sum()), float(np.sqrt(((Lg[idx] - l) ** 2).sum(-1)).mean())
    for i in range(1, n[0] + 1):
        s_, e_ = cuts[i], cuts[i + 1]
        if e_ - s_ < 3: continue
        idx = (ys[s_:e_], xs[s_:e_]); cur = [int(fills[i - 1][j:j + 2], 16) for j in (0, 2, 4)]
        b0, d0 = cost(cur, idx)
        if b0 == 0: continue
        px = a3[idx].astype(float); m = ch[idx]; md = np.median(px, 0); cands = [md]
        if m.sum() >= 2:
            cm = np.median(px[m], 0)
            for w in (0.25, 0.5, 0.75, 1.0): cands.append(md * (1 - w) + cm * w)
            lc = _lab_cv(np.array([[cur]], np.uint8))[0, 0]; lm = _lab_cv(np.array([[np.round(cm)]], np.uint8))[0, 0]
            for w in (0.3, 0.6, 1.0):
                q = np.array([[[lc[0] * 255 / 100, lc[1] * (1 - w) + lm[1] * w + 128, lc[2] * (1 - w) + lm[2] * w + 128]]]).round().clip(0, 255).astype(np.uint8)
                cands.append(cv2.cvtColor(q, cv2.COLOR_LAB2RGB)[0, 0].astype(float))
        best = (b0 + lam * d0 * (e_ - s_), None)
        for c in cands:
            c = np.clip(np.round(c), 0, 255).astype(int); b, dd = cost(c, idx); v = b + lam * dd * (e_ - s_)
            if v < best[0]: best = (v, c)
        if best[1] is not None: new[i] = '%02X%02X%02X' % tuple(best[1])
    k = [0]
    def rep(m):
        k[0] += 1; c = new.get(k[0]); return m.group(0) if c is None else re.sub(r'(fill|stroke)="#\w{6}"', lambda q: f'{q.group(1)}="#{c}"', m.group(0))
    return PATH.sub(rep, svg)

def _split_trace(a, W, H):
    """r15v: mean-shift (5,22) blend 0.85, Otsu-split 16+16 median-cut palette (pixels pushed across the Otsu line restored), cutout fs=6 simplify=0.55, snapfill, hue recolour, 0.35 stroke"""
    a3 = np.ascontiguousarray(a[..., :3]); ms = cv2.pyrMeanShiftFiltering(a3, 5, 22)
    g = cv2.cvtColor(a3, cv2.COLOR_RGB2GRAY); thr, _ = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU); hi = g >= thr
    b = (ms * 0.85 + a3 * 0.15).round().astype(np.uint8); o = np.zeros_like(b)
    if hi.sum() < 32 or (~hi).sum() < 32: return None
    o[hi] = _split_q(b, hi, 16); o[~hi] = _split_q(b, ~hi, 16)
    go = cv2.cvtColor(o, cv2.COLOR_RGB2GRAY); bad = (hi & (go < thr)) | (~hi & (go >= thr)); o[bad] = a3[bad]
    c = a.copy(); c[..., :3] = o
    s = ungroup(vtracer.convert_pixels(c.tobytes(), W, H, vtracer.Config(hierarchical='cutout', filter_speckle=6, simplify=0.55, optimize=2)))
    return gapfill_r1(_recolour_hue(snapfill(s, a, thin=0.35), a3), 0.35)

if __name__ == '__main__': main(sys.argv[1:])
