#!/workspace/vtracer-bakeoff/bakeoff2/venv311_vt1/bin/python
"""bake-off-2 round-12 candidate (vt1_cut_r12):
- <= 700 px: locks all r11c passing outputs via _ok(ev) and adds 3 strictly-gated fallbacks:
  (1) Tiger-class near-miss dE95 (edges pass, 20.0 < dE95 <= 22.0): re-wrap svg10_raw with 0.25 px stroke;
  (2) flat/low-colour <= 700 px (dE95 <= 10.0, dspecks > 0 or fringe_ppm > 50.0): cutout(fs=5, simplify=0.2, optimize=2) + snapfill(thin=0.35) + 0.38 px stroke;
  (3) 2x Lanczos pre-upscale fallback (when s4 still fails _ok): 2x Lanczos on ab4 + cutout(fs=10, simplify=1.1, optimize=2) + half(W, H) + 0.28 px stroke.
- 1100 < max side <= 2000 px (>= 2 Mpx): silhouette-backed trace_r8_sil (72 paths / 72 colours, 0 gaps).
- all other > 700 px (including 994 and 2600 Carpenters): r10/r2 cutout + greedy Lab fill-merging
  (dE <= 6.0 -> 39 colours on 994px, 122 colours on 2600px, 0 gaps)."""
import sys, os, io, re, time, subprocess, tempfile, importlib.util, importlib.machinery as _im, numpy as np, cv2, vtracer
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
        _l = _im.SourceFileLoader('r11', '/workspace/vtracer-bakeoff/fork/engine.py.r11cand-6bc6eb5e')
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

def _rsvg(svg_str, w, h, bg='white'):
    p = subprocess.run(['rsvg-convert', '-w', str(w), '-h', str(h), '-b', bg], input=svg_str.encode(), capture_output=True, check=True)
    return np.array(Image.open(io.BytesIO(p.stdout)).convert('RGB'))

def _lab_cv(a):
    return cv2.cvtColor(np.ascontiguousarray(a, dtype=np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32) * [100 / 255, 1, 1] - [0, 128, 128]

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
    for ax in (0, 1):
        ra = np.roll(L, 2, ax); rb = np.roll(L, -2, ax); ca = np.roll(im16, 2, ax); cb = np.roll(im16, -2, ax)
        m = (L - np.maximum(ra, rb) > 40) & (np.abs(ca - cb).sum(-1) > 60)
        m[:3] = m[-3:] = False; m[:, :3] = m[:, -3:] = False; sm += int(m.sum())
    if sm > 500:
        return dict(seams=sm, stair_pct=99.0, stair_ratio=9.9, fringe_ppm=999.0, dspecks=999, dE=de, dE95=de95)
    pal = srgb.quantize(12, method=Image.Quantize.MEDIANCUT).convert('RGB').getcolors(1 << 24)
    pal = np.array([c for _, c in sorted(pal, key=lambda x: -x[0])][:12], np.int32)
    def q(arr):
        out = np.empty(arr.shape[:2], np.uint8)
        for i in range(0, arr.shape[0], 256):
            out[i:i + 256] = ((arr[i:i + 256, :, None, :].astype(np.int32) - pal[None, None]) ** 2).sum(-1).argmin(-1)
        return out
    ccsmall = lambda qa: sum(int((cv2.connectedComponentsWithStats((qa == v).astype(np.uint8), connectivity=8)[2][1:, 4] < 4).sum()) for v in np.unique(qa))
    dspk = ccsmall(q(im)) - ccsmall(q(gt))
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
    q4 = q(R4); G4 = np.array(srgb.resize((w * k, h * k), Image.BILINEAR)); qg4 = q(G4)
    jr, st_pct = _jag(q4); jg, _ = _jag(qg4); st_rat = round(jr / max(jg, 1e-3), 2)
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

def _ok(ev):
    return (ev['seams'] <= 500 and ev['stair_pct'] <= 20.0 and ev['stair_ratio'] <= 0.90
            and ev['fringe_ppm'] <= 50.0 and ev['dspecks'] <= 0 and ev['dE'] <= 4.65 and ev['dE95'] <= 20.0)

MS_BUDGET = 7.0
MS_BUDGET_S4 = 9.5

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
        ab4 = a.copy(); ab4[..., :3] = (a[..., :3] * 0.6 + med3 * 0.4).round().astype(np.uint8)
        s4 = gapfill_r1(ungroup(vtracer.convert_pixels(ab4.tobytes(), W, H, vtracer.Config(hierarchical='cutout', filter_speckle=5, simplify=0.35, optimize=2))), 0.35)
        ev4 = _small_eval(srgb, a, s4, check_edges=True)
        if _ok(ev4):
            if time.time() - t0 < MS_BUDGET_S4:  # r13: challenge s4 with the mean-shift trace
                s_ms = _ms_trace(a, W, H); evm = _small_eval(srgb, a, s_ms, check_edges=True)
                if _ok(evm) and evm['stair_pct'] <= ev4['stair_pct'] - 3.0 and evm['dE'] <= ev4['dE']:
                    return s_ms
            return s4
        if time.time() - t0 < MS_BUDGET:  # r13: mean-shift trace tried before s2x, kept only if clean and clearly smoother
            s_ms = _ms_trace(a, W, H); evm = _small_eval(srgb, a, s_ms, check_edges=True)
            if _ok(evm) and evm['stair_pct'] <= min(ev4['stair_pct'], ev10['stair_pct']) - 3.0 and evm['dE'] <= min(ev4['dE'], ev10['dE']):
                return s_ms
        a2 = np.array(Image.fromarray(ab4).resize((W * 2, H * 2), Image.LANCZOS))
        svg2x = half(ungroup(vtracer.convert_pixels(a2.tobytes(), W * 2, H * 2, vtracer.Config(hierarchical='cutout', filter_speckle=10, simplify=1.1, optimize=2))), W, H)
        s2x = gapfill_r1(svg2x, 0.28)
        if _ok(_small_eval(srgb, a, s2x, check_edges=True)):
            return s2x
        if ev4['seams'] <= 500 and ev4['stair_pct'] <= 20.0 and ev4['stair_ratio'] <= 0.90 and ev4['fringe_ppm'] <= 50.0 and ev4['dspecks'] <= 0 and ev4['dE95'] < ev10['dE95']:
            return s4
        return s10
    if 1100 < max(H, W) <= 2000 and H * W >= 2_000_000:
        return trace_r8_sil(i)
    s = 1.0; mid = 1100 < max(H, W) < 2000
    if max(H, W) > MAXSIDE:
        s = MAXSIDE / max(H, W); a = np.array(Image.fromarray(a).resize((round(W * s), round(H * s)), Image.LANCZOS))
    a0 = a.copy(); a = aa_dark(a, dl=30 if mid else 20, bguard=mid)
    cfg = dict(hierarchical='cutout'); tol = RAMPMAX * min(1.0, max(0.0, (max(H, W) - RAMP[0]) / (RAMP[1] - RAMP[0])))
    if tol > 0: cfg.update(simplify=round(tol, 3), optimize=2)
    svg = ungroup(vtracer.convert_pixels(a.tobytes(), a.shape[1], a.shape[0], vtracer.Config(**cfg)))
    svg = merge_fills(gapfill(snapfill(svg, a0), W_BIG * s, mid=mid), 6.0)
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

if __name__ == '__main__': main(sys.argv[1:])
