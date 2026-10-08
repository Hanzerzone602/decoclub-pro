"use strict";

/**
 * WQ engine — general auto-digitizer (vector layers -> stitch stream).
 *
 * Pipeline (all rules are generic, no per-image tuning):
 *  1. Rasterize layers in painter's order into a top-layer label map (~0.1 mm/px).
 *  2. Consolidate colours (Lab ΔE clustering, tiny clusters folded into nearest),
 *     map to Madeira, drop border-connected background, absorb/drop specks.
 *  3. Split each colour into objects (connected parts); stitch type by width
 *     (width = 2 x max distance-transform): <1.2 run, 1.2–10 satin (split >7),
 *     >10 tatami.  Optional per-path `kind` from upstream prep is honoured.
 *  4. Underlap: earlier-sewn colour extends ~0.6 mm under later colours
 *     (skipped when the vector says overlap was already applied).
 *  5. Stitch generation: serpentine tatami with region decomposition and
 *     in-shape travel; satin columns perpendicular to the spine with split
 *     satin; run / triple-bean.  Underlay + pull comp from fabric preset.
 *  6. Sequencing: background -> foreground -> outlines; nearest-neighbour
 *     within colour; hidden travel under later objects; trims only for
 *     visible jumps > 3 mm; tie-in / tie-off around every trim.
 *  7. Clean-up: drop <0.3 mm needle moves, split >7 mm.
 */

const {
  UNIT_PER_IN, pathToPolylines, fillNested, rasterSize, distanceTransform,
  zhangSuenThin, traceSkeleton, smoothPolyline, resamplePolyline, polyLength, mooreContour,
} = require("./geom");
const { nearestMadeira } = require("../madeira");
const { wqFabric } = require("./fabric");

const MM = 10; // stitch units per mm (0.1 mm units)

// ---------------------------------------------------------------- colour
function hexToRgb(hex) {
  const s = String(hex || "#000000").replace("#", "");
  const f = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.padEnd(6, "0");
  return [parseInt(f.slice(0, 2), 16) || 0, parseInt(f.slice(2, 4), 16) || 0, parseInt(f.slice(4, 6), 16) || 0];
}
function rgbToHex(r) {
  return "#" + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
function rgbToLab(rgb) {
  const lin = rgb.map((v) => { v /= 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; });
  const X = (lin[0] * 0.4124 + lin[1] * 0.3576 + lin[2] * 0.1805) / 0.95047;
  const Y = lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
  const Z = (lin[0] * 0.0193 + lin[1] * 0.1192 + lin[2] * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
function dE(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function nearestThread(hex, catalog) { return nearestMadeira(hex, catalog); } // CIEDE2000 inside lib/madeira.js

// ---------------------------------------------------------------- raster
function rasterize(layers, widthIn, heightIn, mw, mh, own, runLines) {
  const label = new Int32Array(mw * mh).fill(-1);
  const kindMap = new Uint8Array(mw * mh); // 0 none, 1 run, 2 satin, 3 fill, 4 centreline run
  const sx = mw / widthIn, sy = mh / heightIn;
  const scratch = new Uint8Array(mw * mh);
  const KIND = { run: 1, bean: 1, satin: 2, column: 2, fill: 3, tatami: 3 };
  layers.forEach((L, li) => {
    let minX = mw, minY = mh, maxX = -1, maxY = -1;
    const holes = [];
    const groups = [];
    (L.paths || []).forEach((p) => {
      // open centreline (kind run / no closepath): stroke it, sew as a run later
      if (typeof p.d === "string" && !p.hole && (p.open === true || (!/[zZ]/.test(p.d) && p.open !== false))) {
        const lines = pathToPolylines(p.d, 16).filter((pl) => pl && pl.length >= 2);
        // never filled, never merged with closed shapes: sewn as its own running stitch
        if (lines.length && runLines) lines.forEach((pl) => runLines.push({ layer: li, widthMm: Number(p.widthMm) || 0, bean: p.bean, sewAfterLayer: p.sewAfterLayer, pts: pl.map((q) => ({ x: q.x * sx, y: q.y * sy })) }));
        return;
      }
      const polys = pathToPolylines(p.d, 16).filter((pl) => pl && pl.length >= 3);
      if (!polys.length) return;
      polys.forEach((pl) => pl.forEach((q) => {
        const x = q.x * sx, y = q.y * sy;
        if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      }));
      if (p.hole) holes.push(polys); else groups.push({ polys, kind: KIND[String(p.kind || "").toLowerCase()] || 0 });
    });
    if (maxX < 0) return;
    const x0 = Math.max(0, Math.floor(minX) - 1), x1 = Math.min(mw - 1, Math.ceil(maxX) + 1);
    const y0 = Math.max(0, Math.floor(minY) - 1), y1 = Math.min(mh - 1, Math.ceil(maxY) + 1);
    for (let y = y0; y <= y1; y++) scratch.fill(0, y * mw + x0, y * mw + x1 + 1);
    const kindScratch = groups.some((g) => g.kind) ? new Map() : null;
    groups.forEach((g) => {
      if (kindScratch && g.kind) {
        const part = new Uint8Array(mw * mh);
        fillNested(part, g.polys, mw, mh, sx, sy);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const i = y * mw + x; if (part[i]) { scratch[i] = 1; kindScratch.set(i, g.kind); }
        }
      } else {
        fillNested(scratch, g.polys, mw, mh, sx, sy);
      }
    });
    holes.forEach((polys) => {
      const part = new Uint8Array(mw * mh);
      fillNested(part, polys, mw, mh, sx, sy);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * mw + x; if (part[i]) scratch[i] = 0; }
    });
    if (own) {
      const w = x1 - x0 + 1, m = new Uint8Array(w * (y1 - y0 + 1));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (scratch[y * mw + x]) m[(y - y0) * w + x - x0] = 1;
      own[li] = { x0, y0, x1, y1, w, m };
    }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * mw + x;
      if (scratch[i]) { label[i] = li; kindMap[i] = kindScratch ? (kindScratch.get(i) || 0) : 0; }
    }
  });
  return { label, kindMap };
}

// 8-connected component labelling of value map (same value = same component).
// Touching letters (tight kerning: "2026" traced as one blob) are split at their
// thin joins: erode, keep the big cores, give every pixel to the nearest core.
function splitTouching(comp, comps, mw, mh, pxPerMm) {
  const n0 = comps.length;
  for (let ci = 0; ci < n0; ci++) {
    const c = comps[ci];
    const bw = c.maxX - c.minX + 1, bh = c.maxY - c.minY + 1;
    if (Math.max(bw, bh) / pxPerMm > 40 || Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)) < 1.5 || c.n < 30) continue;
    const cr = makeCrop(comp, mw, mh, c, 2, (v) => v === c.id);
    const dt = distanceTransform(cr.m, cr.w, cr.h);
    let dmax = 0; for (let i = 0; i < dt.length; i++) if (dt[i] > dmax) dmax = dt[i];
    const wMm = (2 * dmax - 1) / pxPerMm;
    if (wMm < 0.8 || wMm > 4.0) continue;
    // vertical projection (rows of text): cut where a column holds well under one
    // stroke of ink between two letter-sized parts
    const stroke = 2 * dmax, colN = new Int32Array(cr.w);
    for (let y = 0; y < cr.h; y++) for (let x = 0; x < cr.w; x++) if (cr.m[y * cr.w + x]) colN[x]++;
    if (bw < 1.5 * bh) continue;
    const cuts = [];
    let x = 0;
    while (x < cr.w) {
      if (colN[x] > 0 && colN[x] < 0.6 * stroke) {
        let x2 = x, best = x; while (x2 < cr.w && colN[x2] > 0 && colN[x2] < 0.6 * stroke) { if (colN[x2] < colN[best]) best = x2; x2++; }
        const lastCut = cuts.length ? cuts[cuts.length - 1] : (() => { let f = 0; while (f < cr.w && !colN[f]) f++; return f; })();
        if (best - lastCut >= 0.35 * bh) cuts.push(best);
        x = x2;
      } else x++;
    }
    let lastInk = cr.w - 1; while (lastInk > 0 && !colN[lastInk]) lastInk--;
    while (cuts.length && lastInk - cuts[cuts.length - 1] < 0.35 * bh) cuts.pop();
    if (!cuts.length) continue;
    const big = new Array(cuts.length + 1).fill(0);
    const own = new Int32Array(cr.w * cr.h).fill(-1);
    for (let y = 0; y < cr.h; y++) for (let xx = 0; xx < cr.w; xx++) if (cr.m[y * cr.w + xx]) { let k = 0; while (k < cuts.length && xx > cuts[k]) k++; own[y * cr.w + xx] = k; }
    const ids = big.map((k, bi) => (bi === 0 ? c.id : comps.length + bi - 1));
    const stats = big.map(() => ({ n: 0, minX: mw, minY: mh, maxX: 0, maxY: 0, sx: 0, sy: 0, seed: -1 }));
    for (let y = 0; y < cr.h; y++) for (let x = 0; x < cr.w; x++) {
      const i = y * cr.w + x; if (!cr.m[i] || own[i] < 0) continue;
      const gx = x + cr.x0, gy = y + cr.y0, gi = gy * mw + gx, st = stats[own[i]];
      comp[gi] = ids[own[i]];
      st.n++; st.sx += gx; st.sy += gy; if (st.seed < 0) st.seed = gi;
      if (gx < st.minX) st.minX = gx; if (gx > st.maxX) st.maxX = gx; if (gy < st.minY) st.minY = gy; if (gy > st.maxY) st.maxY = gy;
    }
    const base = comps.length;
    stats.forEach((st, bi) => {
      const e = { id: ids[bi], value: c.value, n: st.n, seed: st.seed, minX: st.minX, minY: st.minY, maxX: st.maxX, maxY: st.maxY, cx: st.sx / st.n, cy: st.sy / st.n, border: c.border, splitFrom: c.id };
      if (bi === 0) comps[ci] = e; else comps[base + bi - 1] = e;
    });
  }
}
function labelComponents(map, w, h, skip) {
  const comp = new Int32Array(w * h).fill(-1);
  const comps = [];
  const q = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    const v = map[s];
    if (v === skip || comp[s] >= 0) continue;
    const id = comps.length;
    let qh = 0, qt = 0; q[qt++] = s; comp[s] = id;
    let minX = w, minY = h, maxX = 0, maxY = 0, n = 0, sxs = 0, sys = 0, border = 0;
    while (qh < qt) {
      const i = q[qh++]; const x = i % w, y = (i / w) | 0;
      n++; sxs += x; sys += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (comp[j] < 0 && map[j] === v) { comp[j] = id; q[qt++] = j; }
      }
    }
    comps.push({ id, value: v, n, seed: s, minX, minY, maxX, maxY, cx: sxs / n, cy: sys / n, border });
  }
  return { comp, comps };
}

function clusterColours(layers, areas, opts) {
  const T = opts.noFold ? 0.5 : (opts.mergeDeltaE || 11);
  const order = layers.map((L, i) => i).filter((i) => areas[i] > 0).sort((a, b) => areas[b] - areas[a]);
  const clusters = [];
  const map = new Int32Array(layers.length).fill(-1);
  order.forEach((i) => {
    const rgb = hexToRgb(layers[i].hex || layers[i].threadHex);
    const lab = rgbToLab(rgb);
    let best = -1, bd = 1e9;
    clusters.forEach((c, k) => { const d = dE(c.lab, lab); if (d < bd) { bd = d; best = k; } });
    if (best >= 0 && bd < T) {
      const c = clusters[best];
      c.members.push(i);
      c.rgbSum = c.rgbSum.map((v, t) => v + rgb[t] * areas[i]);
      c.area += areas[i];
      map[i] = best;
    } else {
      map[i] = clusters.length;
      clusters.push({ lab, rgbSum: rgb.map((v) => v * areas[i]), area: areas[i], members: [i], seedHex: layers[i].hex });
    }
  });
  clusters.forEach((c) => { c.rgb = c.rgbSum.map((v) => v / c.area); c.lab = rgbToLab(c.rgb); });
  const total = clusters.reduce((a, c) => a + c.area, 0) || 1;
  const maxColors = opts.maxColors || 12;
  // fold tiny clusters (anti-alias fringes, gradient steps) and cap the count
  let alive = clusters.map((c, k) => k);
  const target = (k) => {
    let best = -1, bd = 1e9;
    alive.forEach((j) => { if (j !== k) { const d = dE(clusters[j].lab, clusters[k].lab); if (d < bd) { bd = d; best = j; } } });
    return { best, bd };
  };
  for (let guard = 0; guard < 4000 && alive.length > 1; guard++) {
    let pick = -1, pickCost = 1e18;
    alive.forEach((k) => {
      const c = clusters[k];
      const frac = c.area / total;
      const t = target(k);
      const tiny = !opts.noFold && frac < (opts.minColorFrac || 0.004) && (t.bd < 14 || frac < 0.001);
      const smallClose = !opts.noFold && frac < 0.015 && t.bd < 15;
      if (tiny || smallClose || alive.length > maxColors) {
        const cost = frac * t.bd;
        if (cost < pickCost) { pickCost = cost; pick = k; }
      }
    });
    if (pick < 0) break;
    const t = target(pick);
    const dst = clusters[t.best], src = clusters[pick];
    // fold into the larger one; keep the larger one's colour dominant
    dst.members = dst.members.concat(src.members);
    dst.rgb = dst.rgb.map((v, i) => (v * dst.area + src.rgb[i] * src.area * 0.25) / (dst.area + src.area * 0.25));
    dst.area += src.area; dst.lab = rgbToLab(dst.rgb);
    src.members.forEach((m) => { map[m] = t.best; });
    alive = alive.filter((k) => k !== pick);
  }
  // re-index
  const remap = new Map();
  const out = [];
  alive.forEach((k) => { remap.set(k, out.length); out.push(clusters[k]); });
  for (let i = 0; i < map.length; i++) if (map[i] >= 0) map[i] = remap.get(map[i]);
  return { clusters: out, layerToCluster: map };
}


// ---------------------------------------------------------------- crop helpers
function makeCrop(full, w, h, bb, pad, test) {
  const x0 = Math.max(0, bb.minX - pad), y0 = Math.max(0, bb.minY - pad);
  const x1 = Math.min(w - 1, bb.maxX + pad), y1 = Math.min(h - 1, bb.maxY + pad);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const m = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const row = (y + y0) * w + x0;
    for (let x = 0; x < cw; x++) if (test(full[row + x], row + x)) m[y * cw + x] = 1;
  }
  return { m, w: cw, h: ch, x0, y0 };
}
function countOn(m) { let n = 0; for (let i = 0; i < m.length; i++) if (m[i]) n++; return n; }
// Distance (px) from every pixel to the nearest ON pixel (0 on ON pixels).
function distToMask(m, w, h) {
  const inv = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 0 : 1;
  return distanceTransform(inv, w, h);
}
function dilateR(m, w, h, r) {
  const d = distToMask(m, w, h); const o = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) o[i] = m[i] || d[i] <= r ? 1 : 0;
  return o;
}
function erodeR(m, w, h, r) {
  const d = distanceTransform(m, w, h); const o = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) o[i] = m[i] && d[i] > r ? 1 : 0;
  return o;
}
function inside(m, w, h, x, y) {
  const xi = Math.round(x), yi = Math.round(y);
  return xi >= 0 && yi >= 0 && xi < w && yi < h && m[yi * w + xi] === 1;
}
function segInside(m, w, h, a, b, frac) {
  const L = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(2, Math.ceil(L / 0.7));
  let ok = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (inside(m, w, h, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) ok++;
  }
  return ok / (n + 1) >= (frac == null ? 0.999 : frac);
}
function largestPart(m, w, h) {
  const { comp, comps } = labelComponents(m, w, h, 0);
  if (comps.length <= 1) return m;
  let best = comps[0];
  comps.forEach((c) => { if (c.n > best.n) best = c; });
  const o = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) if (comp[i] === best.id) o[i] = 1;
  return o;
}
function parts(m, w, h, minPx) {
  const { comp, comps } = labelComponents(m, w, h, 0);
  return comps.filter((c) => c.n >= (minPx || 1)).map((c) => {
    const o = new Uint8Array(m.length);
    for (let i = 0; i < m.length; i++) if (comp[i] === c.id) o[i] = 1;
    return { m: o, n: c.n, cx: c.cx, cy: c.cy };
  });
}
function moments(m, w, h) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) { n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  if (!n) return { n: 0, cx: 0, cy: 0, axisDeg: 0, aspect: 1 };
  const mx = sx / n, my = sy / n;
  const a = sxx / n - mx * mx, b = sxy / n - mx * my, c = syy / n - my * my;
  const th = 0.5 * Math.atan2(2 * b, a - c);
  const r = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  const l1 = (a + c) / 2 + r, l2 = Math.max(1e-6, (a + c) / 2 - r);
  return { n, cx: mx, cy: my, axisDeg: ((th * 180 / Math.PI) % 180 + 180) % 180, aspect: Math.sqrt(l1 / l2), l1, l2 };
}

// ---------------------------------------------------------------- travel inside a mask
// Shortest 8-connected path on a coarse grid; returns px points (crop coords).
function pathInside(m, w, h, a, b, step) {
  const f = Math.max(1, Math.round(step));
  const gw = Math.ceil(w / f), gh = Math.ceil(h / f);
  const g = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) g[((y / f) | 0) * gw + ((x / f) | 0)] = 1;
  const ax = Math.min(gw - 1, Math.max(0, Math.round(a.x / f))), ay = Math.min(gh - 1, Math.max(0, Math.round(a.y / f)));
  const bx = Math.min(gw - 1, Math.max(0, Math.round(b.x / f))), by = Math.min(gh - 1, Math.max(0, Math.round(b.y / f)));
  const start = ay * gw + ax, goal = by * gw + bx;
  g[start] = 1; g[goal] = 1;
  const prev = new Int32Array(gw * gh).fill(-2);
  const q = new Int32Array(gw * gh);
  let qh = 0, qt = 0; q[qt++] = start; prev[start] = -1;
  while (qh < qt) {
    const i = q[qh++]; if (i === goal) break;
    const x = i % gw, y = (i / gw) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const j = ny * gw + nx;
      if (g[j] && prev[j] === -2) { prev[j] = i; q[qt++] = j; }
    }
  }
  if (prev[goal] === -2) return null;
  const pts = [];
  for (let i = goal; i !== -1; i = prev[i]) pts.push({ x: (i % gw) * f + f / 2 - 0.5, y: ((i / gw) | 0) * f + f / 2 - 0.5 });
  pts.reverse();
  pts[0] = { x: a.x, y: a.y }; pts[pts.length - 1] = { x: b.x, y: b.y };
  // string-pull simplification
  const out = [pts[0]];
  let k = 0;
  while (k < pts.length - 1) {
    let j = pts.length - 1;
    while (j > k + 1 && !segInside(m, w, h, pts[k], pts[j], 0.95)) j--;
    out.push(pts[j]); k = j;
  }
  return out;
}
function runAlong(pts, stepPx) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(L / stepPx));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
  }
  return out;
}
// BFS distance field over a coarse grid of mask m from point a.
function bfsField(m, w, h, a, step) {
  const f = Math.max(1, Math.round(step));
  const gw = Math.ceil(w / f), gh = Math.ceil(h / f);
  const g = new Uint8Array(gw * gh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) g[((y / f) | 0) * gw + ((x / f) | 0)] = 1;
  const ax = Math.min(gw - 1, Math.max(0, Math.round(a.x / f))), ay = Math.min(gh - 1, Math.max(0, Math.round(a.y / f)));
  const start = ay * gw + ax; g[start] = 1;
  const dist = new Float32Array(gw * gh).fill(Infinity);
  const prev = new Int32Array(gw * gh).fill(-2);
  const q = new Int32Array(gw * gh * 2);
  let qh = 0, qt = 0; q[qt++] = start; dist[start] = 0; prev[start] = -1;
  while (qh < qt) {
    const i = q[qh++]; const x = i % gw, y = (i / gw) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
      const j = ny * gw + nx;
      if (!g[j]) continue;
      const nd = dist[i] + (dx && dy ? 1.414 : 1);
      if (nd < dist[j] - 1e-6) { dist[j] = nd; prev[j] = i; q[qt++] = j; if (qt >= q.length) qt = q.length - 1; }
    }
  }
  return { f, gw, gh, dist, prev, g, a };
}
function fieldDist(F, p) {
  const gx = Math.min(F.gw - 1, Math.max(0, Math.round(p.x / F.f))), gy = Math.min(F.gh - 1, Math.max(0, Math.round(p.y / F.f)));
  let best = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = gx + dx, y = gy + dy; if (x < 0 || y < 0 || x >= F.gw || y >= F.gh) continue;
    best = Math.min(best, F.dist[y * F.gw + x] + (dx || dy ? 1 : 0));
  }
  return best * F.f;
}
function fieldPath(F, m, w, h, b) {
  const gx = Math.min(F.gw - 1, Math.max(0, Math.round(b.x / F.f))), gy = Math.min(F.gh - 1, Math.max(0, Math.round(b.y / F.f)));
  let goal = -1, bd = Infinity;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = gx + dx, y = gy + dy; if (x < 0 || y < 0 || x >= F.gw || y >= F.gh) continue;
    const d = F.dist[y * F.gw + x]; if (d < bd) { bd = d; goal = y * F.gw + x; }
  }
  if (goal < 0 || !isFinite(bd)) return null;
  const pts = [];
  for (let i = goal; i !== -1; i = F.prev[i]) pts.push({ x: (i % F.gw) * F.f, y: ((i / F.gw) | 0) * F.f });
  pts.reverse();
  pts[0] = { x: F.a.x, y: F.a.y }; pts.push({ x: b.x, y: b.y });
  const out = [pts[0]];
  let k = 0;
  while (k < pts.length - 1) {
    let j = pts.length - 1;
    while (j > k + 1 && !segInside(m, w, h, pts[k], pts[j], 0.97)) j--;
    out.push(pts[j]); k = j;
  }
  return out;
}

// Travel from a to b staying inside m: returns points (excluding a) or null.
function travelInside(m, w, h, a, b, pxPerMm) {
  const step = 3.0 * pxPerMm;
  if (Math.hypot(b.x - a.x, b.y - a.y) < 0.9 * pxPerMm) return [b];
  if (segInside(m, w, h, a, b, 0.97)) return runAlong([a, b], step);
  const p = pathInside(m, w, h, a, b, 0.5 * pxPerMm);
  if (!p) return null;
  return runAlong(p, step);
}


// ---------------------------------------------------------------- tatami
// Serpentine tatami. Rows run along rowDeg; the shape is decomposed into
// monotone regions so no row ever jumps across a gap; regions are joined by
// travel that stays inside the shape. Returns local-crop points.
function tatami(m, w, h, o) {
  const th = (o.rowDeg * Math.PI) / 180;
  const dx = Math.cos(th), dy = Math.sin(th);
  const nx = -dy, ny = dx;
  const X0 = o.x0 || 0, Y0 = o.y0 || 0; // global offset (grid alignment)
  const sp = o.spacingPx, L = o.stitchPx, pull = o.pullPx || 0;
  const minRow = o.minRowPx == null ? 0.5 * o.pxPerMm : o.minRowPx;
  const minEnd = Math.min(1.1 * o.pxPerMm, 0.35 * L);
  let vMin = Infinity, vMax = -Infinity, uMin = Infinity, uMax = -Infinity;
  [[0, 0], [w, 0], [0, h], [w, h]].forEach(([x, y]) => {
    const gx = x + X0, gy = y + Y0;
    const u = gx * dx + gy * dy, v = gx * nx + gy * ny;
    if (u < uMin) uMin = u; if (u > uMax) uMax = u; if (v < vMin) vMin = v; if (v > vMax) vMax = v;
  });
  const rows = [];
  const step = 0.5;
  for (let r = Math.ceil(vMin / sp); r * sp <= vMax; r++) {
    const v = r * sp;
    const ivs = [];
    let cur = null;
    for (let u = uMin; u <= uMax; u += step) {
      const x = u * dx + v * nx - X0, y = u * dy + v * ny - Y0;
      const xi = Math.round(x), yi = Math.round(y);
      const on = xi >= 0 && yi >= 0 && xi < w && yi < h && m[yi * w + xi] === 1;
      if (on) { if (!cur) cur = { u0: u, u1: u }; else cur.u1 = u; }
      else if (cur) { ivs.push(cur); cur = null; }
    }
    if (cur) ivs.push(cur);
    rows.push({ r, v, ivs: ivs.filter((iv) => iv.u1 - iv.u0 >= minRow) });
  }
  // region decomposition
  const regions = [];
  let open = [];
  rows.forEach((row) => {
    const next = [];
    const used = new Array(row.ivs.length).fill(false);
    const ov = (a, b) => Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0) > 0.5;
    open.forEach((reg) => {
      const last = reg.rows[reg.rows.length - 1];
      const hits = [];
      row.ivs.forEach((iv, j) => { if (ov(last, iv)) hits.push(j); });
      if (hits.length !== 1) return;
      const j = hits[0];
      const back = open.filter((r2) => ov(r2.rows[r2.rows.length - 1], row.ivs[j]));
      if (back.length !== 1 || used[j]) return;
      used[j] = true;
      reg.rows.push(Object.assign({ r: row.r, v: row.v }, row.ivs[j]));
      next.push(reg);
    });
    row.ivs.forEach((iv, j) => {
      if (used[j]) return;
      const reg = { rows: [Object.assign({ r: row.r, v: row.v }, iv)] };
      regions.push(reg);
      next.push(reg);
    });
    open = next;
  });
  const toXY = (u, v) => ({ x: u * dx + v * nx - X0, y: u * dy + v * ny - Y0 });
  function rowPoints(row, forward) {
    const s = forward ? row.u0 - pull : row.u1 + pull;
    const e = forward ? row.u1 + pull : row.u0 - pull;
    const pts = [toXY(s, row.v)];
    const frac = (((row.r * 2) % 5) + 5) % 5 / 5;
    const lo = Math.min(s, e) + minEnd, hi = Math.max(s, e) - minEnd;
    const k0 = Math.ceil(lo / L - frac), k1 = Math.floor(hi / L - frac);
    const mids = [];
    for (let k = k0; k <= k1; k++) mids.push((k + frac) * L);
    if (!forward) mids.reverse();
    mids.forEach((u) => pts.push(toXY(u, row.v)));
    pts.push(toXY(e, row.v));
    return pts;
  }
  const out = [];
  let lastExitOpen = "";
  let cur = o.start ? { x: o.start.x, y: o.start.y } : null;
  const left = regions.filter((r) => r.rows.length);
  // region adjacency (rows of A and B on neighbouring scanlines overlap). Sewing a region that is
  // a cut vertex of the unsewn regions strands the rest: travel would then have to go on top of
  // finished rows (or trim). So prefer regions whose removal keeps the unsewn graph connected.
  left.forEach((r, i) => { r.id = i; r.adj = new Set(); r.end0 = new Set(); r.end1 = new Set(); });
  if (left.length > 2 && left.length <= 1500) {
    const byR = new Map();
    left.forEach((reg) => reg.rows.forEach((row) => { if (!byR.has(row.r)) byR.set(row.r, []); byR.get(row.r).push([reg, row]); }));
    byR.forEach((lst, r) => {
      const nx2 = byR.get(r + 1); if (!nx2) return;
      lst.forEach(([ra, a]) => nx2.forEach(([rb, b]) => { if (ra !== rb && Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0) > -0.5) {
        ra.adj.add(rb.id); rb.adj.add(ra.id);
        // which end of each region the contact is at (regions only touch at their first/last rows)
        (a === ra.rows[0] ? ra.end0 : ra.end1).add(rb.id); (b === rb.rows[0] ? rb.end0 : rb.end1).add(ra.id);
      } }));
    });
  }
  const comps = (set, skip) => { // number of connected components of the regions in set, without skip
    const seen = new Set(); let n = 0;
    const ids = new Map(); set.forEach((z) => ids.set(z.id, z));
    set.forEach((r) => {
      if (r === skip || seen.has(r.id)) return; n++;
      const st = [r]; seen.add(r.id);
      while (st.length) { const q = st.pop(); q.adj.forEach((j) => { const t = ids.get(j); if (t && t !== skip && !seen.has(j)) { seen.add(j); st.push(t); } }); }
    });
    return n;
  };
  let done = null;
  while (left.length) {
    let best = null;
    let F = null, free = null;
    let F2 = null;
    if (cur && done) {
      free = new Uint8Array(m.length);
      for (let i = 0; i < m.length; i++) free[i] = m[i] && !done[i] ? 1 : 0;
      F = bfsField(free, w, h, cur, 0.5 * o.pxPerMm);
      // prefer travel away from the edges (fully covered by the coming rows)
      const core = erodeR(free, w, h, 0.45 * o.pxPerMm);
      const r0 = Math.ceil(0.9 * o.pxPerMm);
      for (let yy = -r0; yy <= r0; yy++) for (let xx = -r0; xx <= r0; xx++) {
        const X = Math.round(cur.x) + xx, Y = Math.round(cur.y) + yy;
        if (X >= 0 && Y >= 0 && X < w && Y < h && free[Y * w + X]) core[Y * w + X] = 1;
      }
      F2 = { field: bfsField(core, w, h, cur, 0.5 * o.pxPerMm), mask: core };
    }
    // articulation points of the unsewn-region graph (Tarjan, one pass per step)
    const useGraph = left.length > 2 && left.length <= 1500 && !process.env.WQ_NO_REGION_ORDER;
    const cut = new Set();
    if (useGraph) {
      const ids = new Map(); left.forEach((z) => ids.set(z.id, z));
      const disc = new Map(), low = new Map(); let tm = 0;
      const dfs = (u, parent) => {
        disc.set(u.id, tm); low.set(u.id, tm); tm++;
        let kids = 0;
        u.adj.forEach((j) => {
          const v = ids.get(j); if (!v) return;
          if (!disc.has(j)) {
            kids++; dfs(v, u);
            low.set(u.id, Math.min(low.get(u.id), low.get(j)));
            if (parent && low.get(j) >= disc.get(u.id)) cut.add(u.id);
          } else if (!parent || j !== parent.id) low.set(u.id, Math.min(low.get(u.id), disc.get(j)));
        });
        if (!parent && kids > 1) cut.add(u.id);
      };
      left.forEach((z) => { if (!disc.has(z.id)) dfs(z, null); });
    }
    const baseComps = useGraph ? 1 : 0;
    left.forEach((reg, idx) => {
      const n = reg.rows.length;
      const cutPen = useGraph && cut.has(reg.id) ? 1e4 : 0;
      [[0, true], [0, false], [n - 1, true], [n - 1, false]].forEach(([ri, fw]) => {
        const row = reg.rows[ri];
        const p = toXY(fw ? row.u0 - pull : row.u1 + pull, row.v);
        let d = cur ? Math.hypot(p.x - cur.x, p.y - cur.y) : 0;
        if (F) { const fd = fieldDist(F, p); d = isFinite(fd) ? fd : 1e5 + d; }
        // leave the region at an end that still touches unsewn regions (else the way on is over finished rows)
        let endPen = 0;
        if (baseComps && left.length > 1) {
          const ex = ri === 0 ? reg.end1 : reg.end0;
          let open = false; ex.forEach((j) => { if (j !== reg.id && left.some((z) => z.id === j)) open = true; });
          if (!open) endPen = 3e3;
        }
        const key = d + (d < 1e5 ? cutPen + endPen : 0);
        if (!best || key < best.key) best = { d, key, idx, rev: ri !== 0, fw, p };
      });
    });
    const reg = left.splice(best.idx, 1)[0];
    if (process.env.DEBUG_TJ) { const ex = best.rev ? reg.end0 : reg.end1; let op = 0; ex.forEach((j) => { if (left.some((z) => z.id === j)) op++; }); lastExitOpen = op + "/" + ex.size + " key " + Math.round(best.key); }
    const rr = best.rev ? reg.rows.slice().reverse() : reg.rows;
    if (cur) {
      // travel through the part of the shape that is not sewn yet (gets covered)
      let tr = null;
      if (F && best.d < 1e5) {
        let fp = null;
        if (F2 && isFinite(fieldDist(F2.field, best.p))) fp = fieldPath(F2.field, free, w, h, best.p);
        if (!fp) fp = fieldPath(F, free, w, h, best.p);
        if (fp) tr = runAlong(fp, 4.5 * o.pxPerMm); // under-travel (covered by the coming rows): long stitches
      } else if (F) {
        tr = Math.hypot(best.p.x - cur.x, best.p.y - cur.y) < 0.9 * o.pxPerMm ? [best.p] : null; // no hidden route: jump/trim
        // groove travel: cross at most 1.5 mm of finished rows, then run along the target row's
        // own line (sits in the row groove; the part inside the target region is sewn over next)
        if (!tr && o.role !== "underlay" && !o.scanSatin && process.env.WQ_GROOVE === "1") { // off: tiger 115 -> 111 trims but +30 mm on-top travel
          const ddx = best.p.x - cur.x, ddy = best.p.y - cur.y;
          const du = ddx * dx + ddy * dy, dvv = ddx * nx + ddy * ny;
          if (Math.abs(dvv) <= 1.5 * o.pxPerMm) {
            const pp = out.length >= 2 ? out[out.length - 2] : null;
            const sg = pp && ((pp.x - cur.x) * dx + (pp.y - cur.y) * dy) < 0 ? -1 : 1;
            const inw = pull + 0.5 * o.pxPerMm;
            const cIn = pp ? { x: cur.x + sg * inw * dx, y: cur.y + sg * inw * dy } : cur;
            const s2 = best.fw ? 1 : -1;
            const bIn = { x: best.p.x + s2 * inw * dx, y: best.p.y + s2 * inw * dy };
            const A = { x: cIn.x + dvv * nx, y: cIn.y + dvv * ny };
            const inA = (q) => { const X = Math.round(q.x), Y = Math.round(q.y); return X >= 0 && Y >= 0 && X < w && Y < h && m[Y * w + X]; };
            const okLine = (a, b) => { const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 1.5)); let k = 0; for (let i = 0; i <= n; i++) if (inA({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n })) k++; return k / (n + 1) >= 0.85; };
            if (Math.abs(du) <= 25 * o.pxPerMm && okLine(cIn, A) && okLine(A, bIn)) tr = runAlong([cur, cIn, A, bIn, best.p], 3.0 * o.pxPerMm).slice(1);
          }
        }
      }
      if (!tr && !F) tr = travelInside(m, w, h, cur, best.p, o.pxPerMm);
      if (tr) tr.forEach((p, i) => out.push({ x: p.x, y: p.y, role: "travel" }));
      else { out.push({ x: best.p.x, y: best.p.y, jump: true }); if (process.env.DEBUG_TJDUMP && !global.__tjd) { global.__tjd = 1; require("fs").writeFileSync(process.env.DEBUG_TJDUMP, JSON.stringify({ w, h, free: Array.from(free || []), m: Array.from(m), cur, p: best.p, sp, left: left.map((r) => r.rows.map((row) => [row.u0, row.u1, row.v])), reg: reg.rows.map((row) => [row.u0, row.u1, row.v]), rowDeg: o.rowDeg })); }
          if (process.env.DEBUG_TJ) console.error("TJy prevExitOpen", lastExitOpen, "leftN", left.length, "useGraph", left.length + 1 > 2 && left.length + 1 <= 1500);
          if (process.env.DEBUG_TJ) { let reach = 0, freeN = 0; if (F) for (let i = 0; i < F.dist.length; i++) if (isFinite(F.dist[i])) reach++; if (free) for (let i = 0; i < free.length; i++) freeN += free[i]; console.error("TJx reach", reach, "freePx", freeN, "rowsLeft", left.reduce((a, r) => a + r.rows.length, 0) + reg.rows.length, "mPx", m.reduce((a, v) => a + v, 0)); }
          if (process.env.DEBUG_TJ) { const ddx = best.p.x - cur.x, ddy = best.p.y - cur.y; console.error("TJD", o.role || "fill", (Math.abs(ddx * dx + ddy * dy) / o.pxPerMm).toFixed(1), (Math.abs(ddx * nx + ddy * ny) / o.pxPerMm).toFixed(1)); }
          if (process.env.DEBUG_TJ) console.error("TJ", o.role || "fill", left.length, best.d >= 1e5 ? "unreach" : "near", Math.round(Math.hypot(best.p.x - cur.x, best.p.y - cur.y) / o.pxPerMm * 10) / 10, best.key >= 1e4 ? "cut" : best.key >= 3e3 ? "end" : ""); }
    }
    let fw = best.fw;
    rr.forEach((row, i) => {
      // scanSatin: one stitch per row, end to end (fixed-direction satin): skip each row's start,
      // so the needle zig-zags between the two edges like a satin column
      const pts = o.scanSatin && i > 0 ? rowPoints(row, fw).slice(1) : rowPoints(row, fw);
      pts.forEach((p, k) => { if (!(k === 0 && i === 0 && out.length && cur)) out.push({ x: p.x, y: p.y, role: o.role || "fill" }); else out.push({ x: p.x, y: p.y, role: o.role || "fill" }); });
      fw = !fw;
    });
    if (left.length) {
      if (!done) done = new Uint8Array(w * h);
      reg.rows.forEach((row) => {
        for (let u = row.u0; u <= row.u1; u += 0.7) for (let t = -sp / 2 - 0.5; t <= sp / 2 + 0.5; t += 0.7) {
          const q = toXY(u, row.v + t); const X = Math.round(q.x), Y = Math.round(q.y);
          if (X >= 0 && Y >= 0 && X < w && Y < h) done[Y * w + X] = 1;
        }
      });
    }
    const lp = out[out.length - 1];
    cur = { x: lp.x, y: lp.y };
  }
  return out;
}

// ---------------------------------------------------------------- skeleton paths
function closedPath(p) { return p.length > 8 && Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y) <= 2.5; }
function mergePaths(paths, dist) {
  const used = new Uint8Array(paths.length);
  const out = [];
  const tan = (p, atEnd) => {
    const n = p.length, k = Math.min(n - 1, 6);
    const a = atEnd ? p[n - 1 - k] : p[k], b = atEnd ? p[n - 1] : p[0];
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / L, y: (b.y - a.y) / L }; // pointing outward
  };
  for (let i = 0; i < paths.length; i++) {
    if (used[i]) continue;
    let cur = paths[i].slice(); used[i] = 1;
    let grew = true;
    while (grew) {
      grew = false;
      let best = null;
      for (let j = 0; j < paths.length; j++) {
        if (used[j]) continue;
        const p = paths[j];
        const cands = [
          [cur[cur.length - 1], p[0], true, false], [cur[cur.length - 1], p[p.length - 1], true, true],
          [cur[0], p[p.length - 1], false, false], [cur[0], p[0], false, true],
        ];
        cands.forEach(([a, b, atEnd, rev]) => {
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d > dist) return;
          const t1 = tan(cur, atEnd);
          const pp = rev ? p.slice().reverse() : p;
          const t2 = atEnd ? tan(pp, false) : tan(pp, true); // outward of joining end
          const align = -(t1.x * t2.x + t1.y * t2.y); // 1 = straight continuation
          if (align < 0.3) return;
          if (!best || align > best.align) best = { j, atEnd, rev, align };
        });
      }
      if (best) {
        const p = best.rev ? paths[best.j].slice().reverse() : paths[best.j];
        cur = best.atEnd ? cur.concat(p.slice(1)) : p.slice(0, -1).concat(cur);
        used[best.j] = 1; grew = true;
      }
    }
    out.push(cur);
  }
  return out;
}
// even arc-length resampling (geom.resamplePolyline measures from the last
// output point, which bunches samples on dense pixel polylines)
function resampleArc(pts, spacing) {
  if (!pts || pts.length < 2) return pts ? pts.slice() : [];
  const out = [{ x: pts[0].x, y: pts[0].y }];
  let need = spacing;
  for (let i = 1; i < pts.length; i++) {
    let ax = pts[i - 1].x, ay = pts[i - 1].y;
    const bx = pts[i].x, by = pts[i].y;
    let seg = Math.hypot(bx - ax, by - ay);
    while (seg >= need) {
      const t = need / seg;
      ax += (bx - ax) * t; ay += (by - ay) * t;
      out.push({ x: ax, y: ay });
      seg -= need; need = spacing;
    }
    need -= seg;
  }
  const last = pts[pts.length - 1], e = out[out.length - 1];
  const rem = Math.hypot(last.x - e.x, last.y - e.y);
  if (rem > spacing * 0.35) out.push({ x: last.x, y: last.y });
  else if (out.length > 1) out[out.length - 1] = { x: last.x, y: last.y };
  return out;
}
function shoot(m, w, h, p, nx, ny, maxD) {
  let d = 0; const st = 0.35;
  while (d < maxD) {
    const x = p.x + nx * (d + st), y = p.y + ny * (d + st);
    if (!inside(m, w, h, x, y)) break;
    d += st;
  }
  return d;
}
function sampleDt(dt, w, h, p) {
  const xi = Math.max(0, Math.min(w - 1, Math.round(p.x))), yi = Math.max(0, Math.min(h - 1, Math.round(p.y)));
  return dt[yi * w + xi];
}
function spinePaths(m, w, h, dt) {
  let dtMax = 0; for (let i = 0; i < dt.length; i++) if (dt[i] > dtMax) dtMax = dt[i];
  // smooth ragged traced edges first so the skeleton has few spurs
  let ms = m;
  const r = Math.max(1, Math.round(0.2 * dtMax));
  if (dtMax >= 4) {
    const op = dilateR(erodeR(m, w, h, r), w, h, r);
    const cl = erodeR(dilateR(op, w, h, r), w, h, r);
    for (let i = 0; i < cl.length; i++) cl[i] = cl[i] && m[i] ? 1 : 0;
    if (countOn(cl) > countOn(m) * 0.85) ms = cl;
  }
  const skel = zhangSuenThin(ms, w, h);
  let paths = traceSkeleton(skel, w, h) || [];
  const minLen = Math.max(3, 0.9 * dtMax);
  {
    // drop spurs (short branches with a free end) before merging the main spine
    const endKey = (pt) => Math.round(pt.x) + "," + Math.round(pt.y);
    for (let it = 0; it < 4 && paths.length > 1; it++) {
      const touches = (pt, self) => paths.some((q) => q !== self && q.some((r) => Math.abs(r.x - pt.x) <= 1.5 && Math.abs(r.y - pt.y) <= 1.5));
      paths = paths.filter((p) => {
        if (p.length < 2) return false;
        const a = touches(p[0], p), b = touches(p[p.length - 1], p);
        if (a && b) return true; // connector between two branches: keep
        if (!a && !b) return true; // isolated stroke
        const j = a ? p[0] : p[p.length - 1];
        const lim = Math.max(minLen, 2.2 * sampleDt(dt, w, h, j) + 2);
        return polyLength(p) >= lim;
      });
      paths = mergePaths(paths, 2.9);
    }
  }
  paths = mergePaths(paths.filter((p) => p.length >= 2), 2.9);
  if (paths.length > 1) {
    const longest = Math.max.apply(null, paths.map(polyLength));
    paths = paths.filter((p) => polyLength(p) >= minLen || polyLength(p) >= longest * 0.999);
  }
  paths = paths.filter((p) => polyLength(p) >= 1.5);
  if (!paths.length) {
    const mo = moments(m, w, h);
    const t = (mo.axisDeg * Math.PI) / 180;
    const c = { x: mo.cx, y: mo.cy };
    const a = shoot(m, w, h, c, Math.cos(t), Math.sin(t), w + h), b = shoot(m, w, h, c, -Math.cos(t), -Math.sin(t), w + h);
    paths = [[{ x: c.x - Math.cos(t) * b * 0.7, y: c.y - Math.sin(t) * b * 0.7 }, { x: c.x + Math.cos(t) * a * 0.7, y: c.y + Math.sin(t) * a * 0.7 }]];
  }
  const nearOther = (pt, self) => paths.some((q) => q !== self && q.some((r) => Math.abs(r.x - pt.x) + Math.abs(r.y - pt.y) <= 3));
  return paths.map((p) => {
    const endTol = Math.max(2.5, 0.8 * sampleDt(dt, w, h, p[0]));
    const closed = p.length > 8 && Math.hypot(p[0].x - p[p.length - 1].x, p[0].y - p[p.length - 1].y) <= endTol && polyLength(p) > 4 * endTol;
    const freeA = !nearOther(p[0], p), freeB = !nearOther(p[p.length - 1], p);
    let q = p.length > 4 ? smoothPolyline(p, 3) : p.slice();
    if (!closed) {
      // extend free ends to the shape edge (Zhang-Suen stops ~half a width short)
      const ext = (end) => {
        const n = q.length, k = Math.min(n - 1, 5);
        const a = end ? q[n - 1 - k] : q[k], b = end ? q[n - 1] : q[0];
        const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
        // walk the distance-transform ridge to the stroke end (thinning can stop
        // far short on diagonal strokes), then run straight to the edge
        let px = b.x, py = b.y, dx = ux, dy = uy;
        const walk = [];
        const d0 = Math.max(1, sampleDt(dt, w, h, b));
        for (let k2 = 0; k2 < w + h; k2++) {
          const nx0 = px + dx * 2, ny0 = py + dy * 2;
          let best = null, bdv = 0;
          for (let o2 = -2; o2 <= 2; o2++) {
            const cx = nx0 - dy * o2, cy = ny0 + dx * o2;
            const v = sampleDt(dt, w, h, { x: cx, y: cy });
            if (inside(m, w, h, cx, cy) && v > bdv) { bdv = v; best = { x: cx, y: cy }; }
          }
          if (!best || bdv < Math.max(1.5, 0.5 * d0)) break;
          let ndx = best.x - px, ndy = best.y - py; const nl = Math.hypot(ndx, ndy) || 1; ndx /= nl; ndy /= nl;
          dx = dx * 0.75 + ndx * 0.25; dy = dy * 0.75 + ndy * 0.25; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
          if (dx * ux + dy * uy < 0.7) break; // do not wander round corners
          // stop when the walk reaches ground another spine (or this one) already sews
          const rr = Math.max(2, 0.9 * d0);
          let hit = false;
          for (let pi = 0; pi < paths.length && !hit; pi++) {
            const pp = paths[pi];
            for (let qi = 0; qi < pp.length; qi += 2) {
              const r = pp[qi];
              if (pp === p && Math.hypot(r.x - b.x, r.y - b.y) < 3 * d0) continue;
              if (Math.abs(r.x - best.x) <= rr && Math.abs(r.y - best.y) <= rr && Math.hypot(r.x - best.x, r.y - best.y) <= rr) { hit = true; break; }
            }
          }
          if (hit) break;
          px = best.x; py = best.y; if (k2 % 3 === 2) walk.push({ x: px, y: py });
        }
        walk.push({ x: px, y: py });
        if (process.env.DEBUG_WALK) console.error("WALK", end, JSON.stringify(b), ux.toFixed(2), uy.toFixed(2), "->", px.toFixed(1), py.toFixed(1), walk.length, d0);
        const d = shoot(m, w, h, { x: px, y: py }, dx, dy, w + h);
        walk.push({ x: px + dx * Math.max(0, d - 0.6), y: py + dy * Math.max(0, d - 0.6) });
        if (end) walk.forEach((pt) => q.push(pt)); else walk.forEach((pt) => q.unshift(pt));
      };
      if (q.length >= 2) { if (freeB) ext(true); if (freeA) ext(false); }
    }
    return { pts: q, closed };
  });
}

// ---------------------------------------------------------------- lettering strokes
// Thin shapes (letters, numerals, thin marks): skeleton graph -> prune spurs ->
// merge through degree-2 nodes -> split at sharp corners. Every stroke is sewn
// as its own satin column with stitches perpendicular to the stroke (constant
// on straight strokes), the way lettering is digitized, instead of
// chord-searched columns that fan out at corners and junctions.
function dpSimplify(pts, tol) {
  if (pts.length < 3) return pts.map((p, i) => i);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b]; const L = Math.hypot(B.x - A.x, B.y - A.y) || 1e-9;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((B.x - A.x) * (A.y - pts[i].y) - (A.x - pts[i].x) * (B.y - A.y)) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out = []; for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
  return out;
}
function strokePaths(m, w, h, dt, pxPerMm) {
  let dtMax = 0; for (let i = 0; i < dt.length; i++) if (m[i] && dt[i] > dtMax) dtMax = dt[i];
  const skel = zhangSuenThin(m, w, h);
  const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && skel[y * w + x];
  const nb = (i) => { const x = i % w, y = (i / w) | 0, out = []; for (const [dx, dy] of N8) if (on(x + dx, y + dy)) out.push((y + dy) * w + x + dx); return out; };
  const pix = []; for (let i = 0; i < skel.length; i++) if (skel[i]) pix.push(i);
  if (pix.length < 2) return null;
  // nodes: end pixels (1 neighbour) and junction clusters (>=3 neighbours)
  const nodeOf = new Int32Array(w * h).fill(-1);
  const nodes = [];
  pix.forEach((i) => {
    const k = nb(i).length;
    if (k === 2 || nodeOf[i] >= 0) return;
    if (k <= 1) { nodeOf[i] = nodes.length; nodes.push({ px: [i], end: true }); return; }
    // junction cluster (flood over adjacent junction pixels)
    const id = nodes.length, q = [i], px = []; nodeOf[i] = id;
    while (q.length) { const j = q.pop(); px.push(j); nb(j).forEach((n) => { if (nodeOf[n] < 0 && nb(n).length >= 3) { nodeOf[n] = id; q.push(n); } }); }
    nodes.push({ px, end: false });
  });
  const P = (i) => ({ x: i % w, y: (i / w) | 0 });
  const edges = [];
  const used = new Uint8Array(w * h);
  const seenPair = new Set();
  nodes.forEach((nd, a) => {
    nd.px.forEach((s) => nb(s).forEach((n0) => {
      if (nodeOf[n0] === a) return;
      if (nodeOf[n0] >= 0) { // node touching node directly
        const key = Math.min(a, nodeOf[n0]) + "-" + Math.max(a, nodeOf[n0]) + ":" + Math.min(s, n0) + "-" + Math.max(s, n0);
        if (!seenPair.has(key)) { seenPair.add(key); edges.push({ a, b: nodeOf[n0], pts: [P(s), P(n0)] }); }
        return;
      }
      if (used[n0]) return;
      const chain = [P(s)]; let prev = s, cur = n0;
      const inChain = new Set([s]);
      for (let guard = 0; guard < w * h; guard++) {
        used[cur] = 1; chain.push(P(cur)); inChain.add(cur);
        if (nodeOf[cur] >= 0) break;
        const cand = nb(cur).filter((n) => n !== prev && !inChain.has(n));
        // finish on a node pixel when one is adjacent (own start node only after a real loop)
        const nodeN = cand.find((n) => nodeOf[n] >= 0 && (nodeOf[n] !== a || chain.length > 4));
        const nn = nodeN != null ? nodeN : cand.find((n) => nodeOf[n] < 0 && !used[n]);
        if (nn == null) break;
        prev = cur; cur = nn;
      }
      const last = chain[chain.length - 1], li = last.y * w + last.x;
      edges.push({ a, b: nodeOf[li] >= 0 ? nodeOf[li] : -1, pts: chain });
    }));
  });
  // closed loops without nodes (O, 0 drawn as a ring)
  pix.forEach((i) => {
    if (used[i] || nodeOf[i] >= 0) return;
    const chain = [P(i)]; used[i] = 1; let prev = -1, cur = i;
    for (let guard = 0; guard < w * h; guard++) {
      const nx = nb(cur).filter((n) => n !== prev && !used[n]);
      if (!nx.length) break;
      prev = cur; cur = nx[0]; used[cur] = 1; chain.push(P(cur));
    }
    if (chain.length > 6) edges.push({ a: -2, b: -2, pts: chain.concat([chain[0]]), loop: true });
  });
  if (!edges.length) return null;
  const elen = (e) => polyLength(e.pts);
  if (process.env.DEBUG_STROKE) edges.forEach((e) => console.error("edge", e.a, e.b, e.a >= 0 && nodes[e.a].end, e.b >= 0 && nodes[e.b].end, e.pts.length, JSON.stringify(e.pts[0]), JSON.stringify(e.pts[e.pts.length - 1])));
  // prune spurs: edges to a free end shorter than ~ the local stroke width
  for (let it = 0; it < 3; it++) {
    const deg = new Map(); edges.forEach((e) => { [e.a, e.b].forEach((n) => { if (n >= 0) deg.set(n, (deg.get(n) || 0) + 1); }); });
    const rm = new Set();
    edges.forEach((e, k) => {
      if (e.loop) return;
      const aEnd = e.a < 0 || nodes[e.a].end, bEnd = e.b < 0 || nodes[e.b].end;
      if (aEnd && bEnd) return;
      const j = aEnd ? e.pts[e.pts.length - 1] : e.pts[0];
      // corner spurs are shorter than the local half-width; real arms (T bar, E middle) are longer
      const dJ = sampleDt(dt, w, h, j);
      const lim = Math.max(2.0, 0.9 * dJ);
      // reach = spur length + the run out to the outline past its free end; a corner spur
      // reaches ~1.4x the junction half-width, a real arm (E middle bar) clearly further
      const fe = aEnd ? e.pts[0] : e.pts[e.pts.length - 1], fq = aEnd ? e.pts[Math.min(3, e.pts.length - 1)] : e.pts[Math.max(0, e.pts.length - 4)];
      const fl = Math.hypot(fe.x - fq.x, fe.y - fq.y) || 1;
      const reach = elen(e) + shoot(m, w, h, fe, (fe.x - fq.x) / fl, (fe.y - fq.y) / fl, 4 * dJ + 4);
      if (process.env.DEBUG_STROKE) console.error("prune?", elen(e).toFixed(1), lim.toFixed(1), reach.toFixed(1), dJ.toFixed(1));
      if ((aEnd || bEnd) && elen(e) < lim && reach < 1.7 * dJ) rm.add(k);
    });
    if (!rm.size) break;
    for (let k = edges.length - 1; k >= 0; k--) if (rm.has(k)) edges.splice(k, 1);
    // mark junctions that lost their spur as plain (degree recomputed below)
  }
  // merge chains through nodes of degree 2
  const throughDone = new Set(), throughNodes = new Set();
  for (let guard = 0; guard < 200; guard++) {
    const inc = new Map(); edges.forEach((e, k) => { if (e.loop) return; [e.a, e.b].forEach((n) => { if (n >= 0) { if (!inc.has(n)) inc.set(n, []); inc.get(n).push(k); } }); });
    let did = false;
    for (const [n, ks] of inc) {
      if (ks.length !== 2 || ks[0] === ks[1]) continue;
      const e1 = edges[ks[0]], e2 = edges[ks[1]];
      const p1 = e1.b === n ? e1.pts : e1.pts.slice().reverse();
      const p2 = e2.a === n ? e2.pts : e2.pts.slice().reverse();
      const na = e1.b === n ? e1.a : e1.b, nb2 = e2.a === n ? e2.b : e2.a;
      const merged = { a: na, b: nb2, pts: p1.concat(p2.slice(1)), through: !!(e1.through || e2.through) };
      if (na === nb2 && na >= 0 && nodes[na] && !nodes[na].end && inc.get(na) && inc.get(na).length === 2) merged.loop = true;
      edges.splice(Math.max(ks[0], ks[1]), 1); edges.splice(Math.min(ks[0], ks[1]), 1); edges.push(merged);
      did = true; break;
    }
    if (did) continue;
    // straight-through pairing at junctions (stem of E/F/T/H keeps going; arm ends at it)
    for (const [n, ks] of inc) {
      if (ks.length < 3 || throughDone.has(n)) continue;
      throughDone.add(n);
      const dirOut = (k) => {
        const e = edges[k], pts = e.a === n ? e.pts : e.pts.slice().reverse();
        let acc = 0, j = 1; for (; j < pts.length; j++) { acc += Math.hypot(pts[j].x - pts[j - 1].x, pts[j].y - pts[j - 1].y); if (acc >= Math.max(3, 2 * dtMax)) break; }
        const q = pts[Math.min(j, pts.length - 1)]; return Math.atan2(q.y - pts[0].y, q.x - pts[0].x);
      };
      let best = null;
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) {
        if (ks[i] === ks[j]) continue;
        let d = Math.abs(dirOut(ks[i]) - dirOut(ks[j])) * 180 / Math.PI; if (d > 180) d = 360 - d;
        const dev = 180 - d; if (dev < 30 && (!best || dev < best.dev)) best = { i: ks[i], j: ks[j], dev };
      }
      if (!best) continue;
      const e1 = edges[best.i], e2 = edges[best.j];
      if (e1.loop || e2.loop) continue;
      const p1 = e1.b === n ? e1.pts : e1.pts.slice().reverse();
      const p2 = e2.a === n ? e2.pts : e2.pts.slice().reverse();
      const na = e1.b === n ? e1.a : e1.b, nb2 = e2.a === n ? e2.b : e2.a;
      edges.splice(Math.max(best.i, best.j), 1); edges.splice(Math.min(best.i, best.j), 1);
      edges.push({ a: na, b: nb2, pts: p1.concat(p2.slice(1)), through: true });
      throughNodes.add(n);
      did = true; break;
    }
    if (!did) break;
  }
  // split at sharp corners; extend ends to the outline / through junctions
  const strokeW = Math.max(2, 2 * dtMax);
  const cornerDeg = 55; // tried 75 and no-split for small type: both sewed worse (11:37)
  const out = [];
  edges.forEach((e) => {
    let pts = e.pts.length > 4 ? smoothPolyline(e.pts, 2) : e.pts.slice();
    if (polyLength(pts) < 1.5) return;
    pts = pts.map((q) => ({ x: q.x, y: q.y }));
    let keep = dpSimplify(pts, Math.max(0.8, 0.22 * strokeW));
    // a skeleton turns a sharp corner (L, top of E) into a short diagonal chamfer:
    // collapse it to the intersection of the two straight legs so the corner splits cleanly
    for (let k = 1; k + 2 < keep.length; k++) {
      const A = pts[keep[k - 1]], B = pts[keep[k]], C = pts[keep[k + 1]], D = pts[keep[k + 2]];
      if (Math.hypot(C.x - B.x, C.y - B.y) > 1.1 * strokeW) continue;
      const a1 = Math.atan2(B.y - A.y, B.x - A.x), a3 = Math.atan2(D.y - C.y, D.x - C.x);
      let d = Math.abs(a3 - a1) * 180 / Math.PI; if (d > 180) d = 360 - d;
      if (d < 60) continue;
      const r1x = B.x - A.x, r1y = B.y - A.y, r2x = D.x - C.x, r2y = D.y - C.y;
      const den = r1x * r2y - r1y * r2x; if (Math.abs(den) < 1e-6) continue;
      const t = ((C.x - A.x) * r2y - (C.y - A.y) * r2x) / den;
      const X = { x: A.x + t * r1x, y: A.y + t * r1y };
      if (Math.hypot(X.x - (B.x + C.x) / 2, X.y - (B.y + C.y) / 2) > 1.5 * strokeW) continue;
      if (X.x < 0 || X.y < 0 || X.x >= w || X.y >= h) continue;
      // rebuild pts: A-leg .. X .. D-leg
      pts = pts.slice(0, keep[k] + 1).slice(0, -1).concat([X], pts.slice(keep[k + 1] + 1));
      const shift = keep[k + 1] - keep[k];
      keep = keep.slice(0, k).concat([keep[k]], keep.slice(k + 2).map((v) => v - shift));
    }
    const cuts = [0];
    for (let k = 1; k < keep.length - 1; k++) {
      const A = pts[keep[k - 1]], B = pts[keep[k]], C = pts[keep[k + 1]];
      const a1 = Math.atan2(B.y - A.y, B.x - A.x), a2 = Math.atan2(C.y - B.y, C.x - B.x);
      let d = Math.abs(a2 - a1) * 180 / Math.PI; if (d > 180) d = 360 - d;
      if (d > cornerDeg) cuts.push(keep[k]); // corners split into separate strokes
    }
    cuts.push(pts.length - 1);
    const closedLoop = !!e.loop && cuts.length === 2;
    for (let c = 0; c + 1 < cuts.length; c++) {
      let seg = pts.slice(cuts[c], cuts[c + 1] + 1);
      if (seg.length < 2) continue;
      const startFree = c === 0 ? (e.a >= 0 && nodes[e.a].end) || e.a === -1 : false;
      const endFree = c + 2 === cuts.length ? (e.b >= 0 && nodes[e.b].end) || e.b === -1 : false;
      let sJ = false, eJ = false;
      if (!closedLoop) {
        const extend = (atEnd, full) => {
          const n = seg.length, k = Math.min(n - 1, 4);
          const a = atEnd ? seg[n - 1 - k] : seg[k], b = atEnd ? seg[n - 1] : seg[0];
          const L = Math.hypot(b.x - a.x, b.y - a.y) || 1, ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
          const d = shoot(m, w, h, b, ux, uy, strokeW * 1.5 + 2);
          const go = full ? Math.max(0, d - 0.6) : Math.min(Math.max(0, d - 0.6), 0.5 * strokeW);
          if (go < 0.5) return;
          const q = { x: b.x + ux * go, y: b.y + uy * go };
          if (atEnd) seg.push(q); else seg.unshift(q);
        };
        // free ends and corner ends run to the outline; junction ends reach half a width in
        const retract = (atEnd, node) => { // arm meeting a through stroke: stop just inside its edge
          const nd = nodes[node]; const c0 = P(nd.px[0]);
          const r = Math.max(0, sampleDt(dt, w, h, c0) - 2);
          let acc = 0;
          while (seg.length > 2) {
            const i0 = atEnd ? seg.length - 1 : 0, i1 = atEnd ? seg.length - 2 : 1;
            const L = Math.hypot(seg[i0].x - seg[i1].x, seg[i0].y - seg[i1].y);
            if (acc + L > r) { const f = (r - acc) / L; const q = { x: seg[i0].x + (seg[i1].x - seg[i0].x) * f, y: seg[i0].y + (seg[i1].y - seg[i0].y) * f }; seg[i0] = q; break; }
            acc += L; seg.splice(i0, 1);
          }
        };
        const trimArc = (atEnd, r) => { // drop the skeleton's rounded chamfer next to a corner cut
          let acc = 0;
          while (seg.length > 2) {
            const i0 = atEnd ? seg.length - 1 : 0, i1 = atEnd ? seg.length - 2 : 1;
            const L = Math.hypot(seg[i0].x - seg[i1].x, seg[i0].y - seg[i1].y);
            if (acc + L > r) break;
            acc += L; seg.splice(i0, 1);
          }
        };
        if (process.env.DEBUG_STROKE) console.error("seg", c, cuts.length, JSON.stringify(seg.map((q) => [+q.x.toFixed(1), +q.y.toFixed(1)])));
        if (c > 0 && polyLength(seg) > 0.65 * strokeW) trimArc(false, 0.4 * strokeW);
        if (c + 2 < cuts.length && polyLength(seg) > 0.65 * strokeW) trimArc(true, 0.4 * strokeW);
        sJ = c === 0 && e.a >= 0 && !nodes[e.a].end && throughNodes.has(e.a);
        eJ = c + 2 === cuts.length && e.b >= 0 && !nodes[e.b].end && throughNodes.has(e.b);
        if (sJ) retract(false, e.a); else extend(false, startFree || c > 0);
        if (eJ) retract(true, e.b); else extend(true, endFree || c + 2 < cuts.length);
      }
      if (polyLength(seg) < (sJ || eJ ? 0.3 : 0.6) * strokeW && !closedLoop) continue;
      out.push({ pts: seg, closed: closedLoop, normalOnly: true, wPx: strokeW, through: !!e.through });
    }
  });
  return out.length ? out : null;
}

// ---------------------------------------------------------------- satin
// unit vector from p to the nearest background pixel (feature transform, local search)
function featureDir(m, w, h, p, r) {
  const R = Math.ceil(r) + 2;
  const px = Math.round(p.x), py = Math.round(p.y);
  let best = null, bd = Infinity;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const d2 = dx * dx + dy * dy; if (d2 >= bd || d2 === 0) continue;
    const x = px + dx, y = py + dy;
    const on = x >= 0 && y >= 0 && x < w && y < h && m[y * w + x];
    if (!on) { bd = d2; best = { x: dx, y: dy }; }
  }
  if (!best) return null;
  const L = Math.sqrt(bd);
  return { x: best.x / L, y: best.y / L };
}
// Columns are evaluated on a fine spine step, then kept so that neither edge
// is wider apart than the satin spacing (outer side of curves stays closed);
// on the inner side of tight curves alternate stitches are shortened.
function satinColumnsFor(path, m, w, h, dt, o) {
  const fine = satinColumnsAt(path, m, w, h, dt, Object.assign({}, o, { spacingPx: o.spacingPx / 8, turnSpacingPx: o.spacingPx / 2 }));
  if (fine.length < 2) return fine;
  // satin spacing is the same-side (peak-to-peak) distance, as in Wilcom / Ink/Stitch:
  // consecutive stitches alternate sides, so successive columns sit half of it apart
  const sp = o.spacingPx / 2, out = [fine[0]];
  let last = fine[0], alt = false;
  for (let i = 1; i < fine.length; i++) {
    const c = fine[i];
    const da = Math.hypot(c.a.x - last.a.x, c.a.y - last.a.y), db = Math.hypot(c.b.x - last.b.x, c.b.y - last.b.y);
    const dc = Math.hypot(c.c.x - last.c.x, c.c.y - last.c.y);
    // auto spacing: narrow columns (tapered tips, thin strokes) open up, up to 1.6x below 0.6 mm
    const Wmm = (c.da + c.db) / o.pxPerMm;
    const spl = sp * (Wmm >= 2 ? 1 : 1 + 0.6 * Math.min(1, (2 - Wmm) / 1.4));
    if (Math.max(da, db) >= spl || dc >= spl * 1.6 || i === fine.length - 1) {
      let col = c;
      const inner = Math.min(da, db);
      if (inner < sp * 0.5 && (c.da + c.db) > 2.5 * o.pxPerMm) {
        alt = !alt;
        if (alt) { // short stitch on the crowded side
          const k = 0.6;
          col = Object.assign({}, c);
          if (da < db) { col.da = c.da * k; col.a = { x: c.c.x + c.nx * (col.da + o.pullPx), y: c.c.y + c.ny * (col.da + o.pullPx) }; }
          else { col.db = c.db * k; col.b = { x: c.c.x - c.nx * (col.db + o.pullPx), y: c.c.y - c.ny * (col.db + o.pullPx) }; }
        }
      }
      out.push(col); last = c;
    }
  }
  return out;
}
function satinColumnsAt(path, m, w, h, dt, o) {
  let s = resampleArc(path.pts, o.spacingPx);
  if (path.closed && s.length > 3) s = s.concat([s[0]]);
  const n = s.length;
  if (n < 2) return [];
  // pass 1: column direction per sample = the shortest chord through the spine
  // point within +-45 deg of the spine normal (robust to ragged skeletons)
  const dirs = new Array(n), locs = new Float64Array(n);
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const loc = sampleDt(dt, w, h, s[i]); locs[i] = loc;
    const k = Math.max(2, Math.round((loc * 1.2) / Math.max(0.5, o.spacingPx)));
    let a, b;
    // (k scales with the fine step automatically)
    if (path.closed) { a = s[(i - k + n - 1) % (n - 1)]; b = s[(i + k) % (n - 1)]; }
    else { a = s[Math.max(0, i - k)]; b = s[Math.min(n - 1, i + k)]; }
    let tx = b.x - a.x, ty = b.y - a.y; const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const base = Math.atan2(tx, -ty); // normal (-ty, tx)
    const lim = loc * 3 + 4;
    let best = base, bl = Infinity, baseLen = 0;
    if (path.normalOnly) { dirs[i] = base; continue; } // lettering stroke: perpendicular to the stroke
    for (let d = -45; d <= 45; d += 7.5) {
      const t = base + d * Math.PI / 180, cx = Math.cos(t), cy = Math.sin(t);
      const L = shoot(m, w, h, s[i], cx, cy, lim) + shoot(m, w, h, s[i], -cx, -cy, lim) + Math.abs(d) * 0.004 * loc;
      if (d === 0) baseLen = L;
      if (L < bl - 1e-6) { bl = L; best = t; }
    }
    if (bl < baseLen * 0.7) bad++;
    dirs[i] = best;
  }
  // pass 2: smooth directions (axial average) and limit the turn rate
  const sm = new Array(n);
  for (let i = 0; i < n; i++) {
    const k = Math.max(2, Math.round((locs[i] * 1.0) / Math.max(0.5, o.spacingPx)));
    let sx = 0, sy = 0;
    for (let j = i - k; j <= i + k; j++) {
      let jj = j;
      if (path.closed) jj = ((j % (n - 1)) + (n - 1)) % (n - 1); else if (j < 0 || j >= n) continue;
      const wgt = 1 - Math.abs(j - i) / (k + 1);
      sx += wgt * Math.cos(2 * dirs[jj]); sy += wgt * Math.sin(2 * dirs[jj]);
    }
    sm[i] = 0.5 * Math.atan2(sy, sx);
  }
  const cols = [], raw = [];
  let pn = null;
  for (let i = 0; i < n; i++) {
    const loc = locs[i];
    let nx = Math.cos(sm[i]), ny = Math.sin(sm[i]);
    if (pn && nx * pn.x + ny * pn.y < 0) { nx = -nx; ny = -ny; }
    if (pn) {
      const tsp = o.turnSpacingPx || o.spacingPx, frac = o.spacingPx / tsp;
      const lim = Math.min(0.35, Math.max(0.03, (0.9 * tsp) / Math.max(1, loc))) * frac;
      const ang = Math.atan2(pn.x * ny - pn.y * nx, pn.x * nx + pn.y * ny);
      if (Math.abs(ang) > lim) {
        const a2 = Math.sign(ang) * lim, ca = Math.cos(a2), sa = Math.sin(a2);
        nx = pn.x * ca - pn.y * sa; ny = pn.x * sa + pn.y * ca;
      }
    }
    pn = { x: nx, y: ny };
    // reach the art edge, then at most the underlap further into the sew mask
    const lim = path.wPx ? 0.75 * path.wPx + 2 : loc * 2 + 3;
    raw.push({ i, nx, ny, lim, ea: shoot(m, w, h, s[i], nx, ny, lim), eb: shoot(m, w, h, s[i], -nx, -ny, lim) });
  }
  // lettering strokes: no side may run further than ~1.3x the stroke's own median
  // half-width (stops junction columns from running along a crossing arm)
  let cap = Infinity;
  if (path.normalOnly && raw.length >= 3) {
    const hw = raw.map((r) => Math.min(r.ea, r.eb)).sort((a, b) => a - b)[raw.length >> 1];
    cap = 1.15 * hw + 0.5;
  }
  for (const r of raw) {
    const { i, nx, ny } = r;
    const lim = Math.min(r.lim, cap + 0.6);
    const ea = Math.min(r.ea, lim), eb = Math.min(r.eb, lim);
    const ext = o.underPx != null ? o.underPx + 1 : 0.9 * o.pxPerMm;
    // (only extend past a real art edge: a capped shot is still inside the shape)
    let da = o.sew && ea < lim - 0.5 ? Math.max(ea, shoot(o.sew, w, h, s[i], nx, ny, ea + ext)) : ea;
    let db = o.sew && eb < lim - 0.5 ? Math.max(eb, shoot(o.sew, w, h, s[i], -nx, -ny, eb + ext)) : eb;
    if (da + db < 0.25 * o.pxPerMm) continue;
    const pw = 2 * (o.pullPx || 0); // columns >= 1.2 mm as sewn (pull compensation included)
    if (o.minWidthPx && da + db + pw < o.minWidthPx) { const add = (o.minWidthPx - da - db - pw) / 2; da += add; db += add; }
    cols.push({ c: s[i], nx, ny, da, db,
      a: { x: s[i].x + nx * (da + o.pullPx), y: s[i].y + ny * (da + o.pullPx) },
      b: { x: s[i].x - nx * (db + o.pullPx), y: s[i].y - ny * (db + o.pullPx) } });
  }
  if (n >= 3 && bad > n * 0.5 && !o.keepSpurs && !path.normalOnly) return []; // spur: spine runs into the edge
  return cols;
}
function emitSatin(cols, o, role) {
  const out = [];
  let prev = null;
  const split = o.splitPx;
  cols.forEach((c, i) => {
    const p = i % 2 === 0 ? c.a : c.b;
    if (prev && split && Math.hypot(p.x - prev.x, p.y - prev.y) > split) {
      const L = Math.hypot(p.x - prev.x, p.y - prev.y);
      const parts = Math.ceil(L / split);
      for (let k = 1; k < parts; k++) {
        const jit = ((i % 3) - 1) * 0.12 / parts;
        const t = k / parts + jit;
        out.push({ x: prev.x + (p.x - prev.x) * t, y: prev.y + (p.y - prev.y) * t, role });
      }
    }
    out.push({ x: p.x, y: p.y, role });
    prev = p;
  });
  return out;
}
function fillQuad(cnt, w, h, q) {
  let minY = Infinity, maxY = -Infinity;
  q.forEach((p) => { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
  const y0 = Math.max(0, Math.ceil(minY)), y1 = Math.min(h - 1, Math.floor(maxY));
  for (let y = y0; y <= y1; y++) {
    const xs = [];
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k])), xb = Math.min(w - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) if (cnt[y * w + x] < 250) cnt[y * w + x]++;
    }
  }
}
// Build satin columns for every spine path and measure how well they describe
// the shape. Irregular blobs (poor coverage / heavy overlap) go to tatami.
function segX(p1, p2, p3, p4) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function planWith(paths, m, sew, w, h, dt, o) {
  const cnt = new Uint8Array(w * h);
  const plan = [];
  let pairs = 0, cross = 0;
  paths.forEach((p) => {
    const cols = satinColumnsFor(p, m, w, h, dt, Object.assign({}, o, { sew, pullPx: 0 }));
    if (cols.length < 2) return;
    for (let i = 1; i < cols.length; i++) {
      const A = cols[i - 1], B = cols[i];
      fillQuad(cnt, w, h, [A.a, B.a, B.b, A.b]);
      pairs++; if (segX(A.a, A.b, B.a, B.b)) cross++;
    }
    plan.push(p);
  });
  let on = 0, cov = 0, tot = 0, covered = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i]) { on++; if (cnt[i]) cov++; }
    if (cnt[i]) { covered++; tot += cnt[i]; }
  }
  return { paths: plan, coverage: on ? cov / on : 0, overlap: covered ? tot / covered : 9, nPaths: plan.length, crossing: pairs ? cross / pairs : 0, cnt };
}
// Lettering strokes can leave a blob uncovered (the shallow V of an M): add a satin patch
// (shape-spine columns) for every leftover piece >= ~0.5 mm2
function patchUncovered(sp, cnt, m, w, h, pxPerMm) {
  const res = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) res[i] = m[i] && !cnt[i] ? 1 : 0;
  const core = erodeR(res, w, h, 1);
  const lab = new Int32Array(w * h); for (let i = 0; i < core.length; i++) lab[i] = core[i] ? 1 : 0;
  const { comp, comps } = labelComponents(lab, w, h, 0);
  const out = sp.slice();
  comps.forEach((c) => {
    if (process.env.DEBUG_PATCH) console.error("PATCH comp", (c.n / pxPerMm / pxPerMm).toFixed(2), "mm2 at", (c.cx / pxPerMm).toFixed(1), (c.cy / pxPerMm).toFixed(1));
    if (c.n < 1.5 * pxPerMm * pxPerMm) return; // smaller leftovers (S terminals) sew worse as fans
    const pm = new Uint8Array(w * h);
    for (let i = 0; i < comp.length; i++) if (comp[i] === c.id) pm[i] = 1;
    const grown = dilateR(pm, w, h, 2); for (let i = 0; i < grown.length; i++) grown[i] = grown[i] && m[i] ? 1 : 0;
    const paths = spinePaths(grown, w, h, distanceTransform(grown, w, h));
    (paths || []).forEach((p) => out.push(Object.assign({}, p, { patch: true })));
  });
  return out;
}
// Closed-loop spine for a thin shape with exactly one hole (rings, O): the
// contour of the distance-transform ridge band, as one closed path.
function loopSpine(m, w, h, dt) {
  let holes = 0;
  const inv = new Int32Array(w * h);
  for (let i = 0; i < m.length; i++) inv[i] = m[i] ? 1 : 0;
  const { comps } = labelComponents(inv, w, h, 1);
  comps.forEach((c) => { if (c.border === 0 && c.n >= 4) holes++; });
  if (holes !== 1) return null;
  let dtMax = 0; for (let i = 0; i < dt.length; i++) if (dt[i] > dtMax) dtMax = dt[i];
  const band = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) band[i] = m[i] && dt[i] >= Math.max(1, dtMax * 0.55) ? 1 : 0;
  const lp = largestPart(band, w, h);
  if (countOn(lp) < 8) return null;
  let c = mooreContour(lp, w, h);
  if (!c || c.length < 12) return null;
  c = smoothPolyline(c.concat([c[0]]), 3);
  return [{ pts: c, closed: true }];
}
function bestSpine(m, sew, w, h, dt, o) {
  const prim = spinePaths(m, w, h, dt);
  const loop = loopSpine(m, w, h, dt);
  if (!loop) return { paths: prim, plan: null };
  const a = planWith(prim, m, sew, w, h, dt, o), b = planWith(loop, m, sew, w, h, dt, o);
  const sc = (p) => p.coverage - Math.max(0, p.overlap - 1) * 0.8 - p.crossing;
  return sc(b) > sc(a) ? { paths: loop, plan: b } : { paths: prim, plan: a };
}
function planSatin(m, sew, w, h, o) {
  const dt = distanceTransform(m, w, h);
  const bs = bestSpine(m, m, w, h, dt, o);
  return bs.plan || planWith(bs.paths, m, sew, w, h, dt, o);
}
function satinObject(m, sew, w, h, o) {
  const dt = distanceTransform(m, w, h);
  let paths = o.paths || bestSpine(m, m, w, h, dt, Object.assign({}, o, { pullPx: 0 })).paths;
  const sewn = new Uint8Array(w * h);
  const out = [];
  let cur = o.start ? { x: o.start.x, y: o.start.y } : null;
  const emitted = new Set();
  let pending = paths.slice();
  // lettering: pick stroke order + directions that minimise travel. A stroke ends at its far
  // end when its passes (underlay + satin) are odd, at its start when even.
  let fixedOrder = false, combined = false;
  if (pending.length >= 2 && pending.length <= 6 && pending.every((p) => p.normalOnly || p.patch)) {
    const info = pending.map((p) => {
      const cl = satinColumnsFor(p, m, w, h, dt, Object.assign({}, o, { sew }));
      const wm = cl.length ? cl.map((c) => (c.da + c.db) / o.pxPerMm).sort((a, b) => a - b)[cl.length >> 1] : 0;
      const ul = o.underlayFor(wm);
      const flips = 1 + (ul.indexOf("center-run") >= 0 ? 1 : 0) + (ul.indexOf("zigzag") >= 0 ? 1 : 0);
      // coverage of this stroke's satin (travel drawn over it after it is sewn would show)
      const cov = new Uint8Array(w * h);
      cl.forEach((c) => { for (let t = -c.db; t <= c.da; t += 0.7) { const x = Math.round(c.c.x + c.nx * t), y = Math.round(c.c.y + c.ny * t); if (x >= 0 && y >= 0 && x < w && y < h) cov[y * w + x] = 1; } });
      return { far: flips % 2 === 1, a: p.pts[0], b: p.pts[p.pts.length - 1], ul, cov };
    });
    // centre-walk-only letters: walk the whole letter first, then satin back over it
    combined = info.some((q) => q.ul.length) && info.every((q) => q.ul.every((u) => u === "center-run"));
    if (combined) info.forEach((q) => { q.far = true; });
    const n = pending.length, used = new Array(n).fill(false);
    let best = null;
    // geodesic (inside-the-letter) distances between stroke ends: a travel has to stay inside
    const geo = new Map();
    const bfs = (q) => {
      const key = Math.round(q.x) + "," + Math.round(q.y);
      if (geo.has(key)) return geo.get(key);
      const D = new Float32Array(w * h).fill(Infinity);
      const sx = Math.max(0, Math.min(w - 1, Math.round(q.x))), sy = Math.max(0, Math.min(h - 1, Math.round(q.y)));
      const qu = [sy * w + sx]; D[qu[0]] = 0;
      for (let qi = 0; qi < qu.length; qi++) {
        const i = qu[qi], x = i % w, y = (i / w) | 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx; if (!sew[j] || D[j] <= D[i] + 1) continue;
          D[j] = D[i] + 1; qu.push(j);
        }
      }
      geo.set(key, D); return D;
    };
    const d = (p, q) => {
      if (!p) return 0;
      const e = Math.hypot(p.x - q.x, p.y - q.y);
      const D = bfs(p); const g = D[Math.max(0, Math.min(h - 1, Math.round(q.y))) * w + Math.max(0, Math.min(w - 1, Math.round(q.x)))];
      return Number.isFinite(g) ? Math.max(e, 0.85 * g) : 3 * e + 2 * o.pxPerMm;
    };
    const rec = (k, at, cost, seq) => {
      if (best && cost >= best.cost) return;
      if (k === n) {
        // leave towards the next letter (walk-then-satin letters finish where the walk began)
        const ex = combined ? (seq.length ? (seq[0][1] ? info[seq[0][0]].b : info[seq[0][0]].a) : at) : at;
        const c2 = cost + (o.exitHint && ex ? 1.0 * Math.hypot(ex.x - o.exitHint.x, ex.y - o.exitHint.y) : 0);
        if (!best || c2 < best.cost) best = { cost: c2, seq: seq.slice() };
        return;
      }
      // branch-first (stem after its arms) is preferred, not forced: a stem sewn early costs ~1.5 mm
      const branchLeft = !combined && pending.some((p, i) => !used[i] && !p.through);
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        const pen = branchLeft && pending[i].through ? 1.5 * o.pxPerMm : 0;
        used[i] = true;
        for (const rev of [false, true]) {
          const st = rev ? info[i].b : info[i].a, en = info[i].far ? (rev ? info[i].a : info[i].b) : st;
          let dIn = k === 0 ? (at ? Math.hypot(at.x - st.x, at.y - st.y) : 0) : d(at, st); // entry from outside: straight hop
          if (k > 0 && !combined && at) { // travel on top of a stroke that is already sewn shows: 3x
            const L = Math.hypot(st.x - at.x, st.y - at.y), ns = Math.ceil(L);
            let over = 0;
            for (let q = 1; q < ns; q++) {
              const x = Math.round(at.x + (st.x - at.x) * q / ns), y = Math.round(at.y + (st.y - at.y) * q / ns);
              if (x < 0 || y < 0 || x >= w || y >= h) continue;
              const ii = y * w + x;
              for (let jj = 0; jj < n; jj++) if (used[jj] && jj !== i && info[jj].cov[ii]) { over++; break; }
            }
            dIn += 3 * over * (L / Math.max(1, ns));
          }
          seq.push([i, rev]); rec(k + 1, en, cost + pen + dIn, seq); seq.pop();
        }
        used[i] = false;
      }
    };
    rec(0, cur, 0, []);
    if (process.env.DEBUG_ORDER) console.error("order", n, "combined", combined, "cur", cur && [Math.round(cur.x), Math.round(cur.y)], "exit", o.exitHint && [Math.round(o.exitHint.x), Math.round(o.exitHint.y)], "best", best && JSON.stringify(best.seq), best && best.cost.toFixed(1), JSON.stringify(info.map((q) => [Math.round(q.a.x), Math.round(q.a.y), Math.round(q.b.x), Math.round(q.b.y), q.far ? 1 : 0])));
    if (best) {
      pending = best.seq.map(([i, rev]) => (rev ? Object.assign({}, pending[i], { pts: pending[i].pts.slice().reverse() }) : pending[i]));
      fixedOrder = true;
    }
  }
  if (combined) {
    // satin order = reverse of the walk; columns computed in satin order (junction trimming)
    const sat = pending.slice().reverse().map((p) => Object.assign({}, p, { pts: p.pts.slice().reverse() }));
    const colsOf = [];
    for (const path of sat) {
      let cols = satinColumnsFor(path, m, w, h, dt, Object.assign({}, o, { sew }));
      while (cols.length && sewn[Math.round(cols[0].c.y) * w + Math.round(cols[0].c.x)]) cols.shift();
      while (cols.length && sewn[Math.round(cols[cols.length - 1].c.y) * w + Math.round(cols[cols.length - 1].c.x)]) cols.pop();
      if (cols.length < 2) { colsOf.push(null); continue; }
      const sewnPrev = sewn.slice();
      cols.forEach((c) => { for (let t = -c.db; t <= c.da; t += 0.7) { const x = Math.round(c.c.x + c.nx * t), y = Math.round(c.c.y + c.ny * t); if (x >= 0 && y >= 0 && x < w && y < h) sewn[y * w + x] = 1; } });
      colsOf.push({ cols, sewnPrev, path });
    }
    const goTo = (p, mask, strict) => {
      if (!cur) { cur = { x: p.x, y: p.y }; return true; }
      let tr = mask ? travelInside(mask, w, h, cur, p, o.pxPerMm) : null;
      // strict (satin pass): no fallback over the letter's finished satin unless the hop is short
      if (!tr && (!strict || Math.hypot(p.x - cur.x, p.y - cur.y) <= 1.5 * o.pxPerMm)) tr = travelInside(sew, w, h, cur, p, o.pxPerMm);
      if (tr) { tr.slice(0, -1).forEach((q) => out.push({ x: q.x, y: q.y, role: "travel" })); return true; }
      return false;
    };
    // walk: strokes in walk order (= satin order reversed, columns reversed)
    const step = Math.max(1, Math.round((2.0 * o.pxPerMm) / o.spacingPx));
    let first = true;
    for (let k = colsOf.length - 1; k >= 0; k--) {
      const e = colsOf[k]; if (!e) continue;
      const cs = e.cols.slice().reverse();
      const walk = []; for (let i = 0; i < cs.length; i += step) walk.push(cs[i].c); walk.push(cs[cs.length - 1].c);
      const okT = goTo(walk[0], m);
      walk.forEach((q, i) => out.push({ x: q.x, y: q.y, role: "underlay", jump: i === 0 && (!okT || (first && o.start == null && false)) }));
      first = false;
      cur = { x: walk[walk.length - 1].x, y: walk[walk.length - 1].y };
      emitted.add("center-run");
    }
    // satin back over the walk
    for (const e of colsOf) {
      if (!e) continue;
      const seq = emitSatin(e.cols, o, "satin");
      const sp3 = dilateR(e.sewnPrev, w, h, Math.max(1, Math.round(0.25 * o.pxPerMm)));
      const free = new Uint8Array(w * h); for (let i = 0; i < free.length; i++) free[i] = m[i] && !sp3[i] ? 1 : 0;
      if (!goTo(seq[0], free, true)) seq[0].jump = true;
      seq.forEach((q) => out.push(q));
      const lp = out[out.length - 1]; cur = { x: lp.x, y: lp.y };
    }
    pending = [];
  }
  while (pending.length) {
    // nearest path end
    let bi = 0, brev = false, bd = fixedOrder ? -1 : Infinity;
    // lettering: arms/branches first, the strokes they attach to (E/F/T stem) last, so the
    // travel between arms runs inside the still-unsewn stem and gets covered by it
    const branchLeft = pending.some((p) => p.normalOnly && !p.through);
    pending.forEach((p, i) => {
      if (fixedOrder || (branchLeft && p.through)) return;
      const a = p.pts[0], b = p.pts[p.pts.length - 1];
      const da = cur ? Math.hypot(a.x - cur.x, a.y - cur.y) : 0, db = cur ? Math.hypot(b.x - cur.x, b.y - cur.y) : 1;
      if (da < bd) { bd = da; bi = i; brev = false; }
      if (db < bd) { bd = db; bi = i; brev = true; }
    });
    const path = pending.splice(bi, 1)[0];
    if (brev) path.pts = path.pts.slice().reverse();
    let cols = satinColumnsFor(path, m, w, h, dt, Object.assign({}, o, { sew }));
    // trim ends that are already covered by an earlier column (junctions)
    while (cols.length && sewn[Math.round(cols[0].c.y) * w + Math.round(cols[0].c.x)]) cols.shift();
    while (cols.length && sewn[Math.round(cols[cols.length - 1].c.y) * w + Math.round(cols[cols.length - 1].c.x)]) cols.pop();
    if (cols.length < 2) continue;
    if (process.env.DEBUG_SAT) { let sp = 0, an = 0; for (let i = 1; i < cols.length; i++) { sp += Math.hypot(cols[i].c.x - cols[i - 1].c.x, cols[i].c.y - cols[i - 1].c.y); an += Math.abs(Math.atan2(cols[i - 1].nx * cols[i].ny - cols[i - 1].ny * cols[i].nx, cols[i - 1].nx * cols[i].nx + cols[i - 1].ny * cols[i].ny)); } console.error("SAT", path.pts.length, cols.length, (sp / (cols.length - 1) / o.pxPerMm).toFixed(3), (an / (cols.length - 1) * 57.3).toFixed(1), o.spacingPx.toFixed(2), o.pxPerMm.toFixed(2)); }
    const seq = [];
    // lettering strokes: typical (median) column width decides underlay, not the widest junction column
    const widthMm = path.normalOnly
      ? cols.map((c) => (c.da + c.db) / o.pxPerMm).sort((a, b) => a - b)[cols.length >> 1]
      : cols.reduce((a, c) => Math.max(a, (c.da + c.db) / o.pxPerMm), 0);
    const ul = o.underlayFor(widthMm);
    ul.forEach((u) => emitted.add(u));
    const step = Math.max(1, Math.round((2.0 * o.pxPerMm) / o.spacingPx));
    let forward = true;
    if (ul.indexOf("edge-run") >= 0) {
      const ins = 0.45 * o.pxPerMm;
      for (let i = 0; i < cols.length; i += step) { const c = cols[i]; const d = Math.max(0, c.da - ins); seq.push({ x: c.c.x + c.nx * d, y: c.c.y + c.ny * d, role: "underlay" }); }
      for (let i = cols.length - 1; i >= 0; i -= step) { const c = cols[i]; const d = Math.max(0, c.db - ins); seq.push({ x: c.c.x - c.nx * d, y: c.c.y - c.ny * d, role: "underlay" }); }
      forward = true; // back at start
    }
    if (ul.indexOf("center-run") >= 0) {
      for (let i = 0; i < cols.length; i += step) seq.push({ x: cols[i].c.x, y: cols[i].c.y, role: "underlay" });
      seq.push({ x: cols[cols.length - 1].c.x, y: cols[cols.length - 1].c.y, role: "underlay" });
      forward = !forward;
    }
    if (ul.indexOf("zigzag") >= 0) {
      const zs = Math.max(1, Math.round((o.zigMm || 2.0) * o.pxPerMm / o.spacingPx));
      const list = forward ? cols : cols.slice().reverse();
      let side = 1;
      for (let i = 0; i < list.length; i += zs) {
        const c = list[i]; const d = (side > 0 ? c.da : c.db) * 0.72;
        seq.push({ x: c.c.x + c.nx * d * side, y: c.c.y + c.ny * d * side, role: "underlay" }); side = -side;
      }
      forward = !forward;
    }
    const top = forward ? cols : cols.slice().reverse();
    emitSatin(top, o, "satin").forEach((p) => seq.push(p));
    const sewnPrev = path.normalOnly ? sewn.slice() : null;
    // mark sewn (centre +- half width) for junction trimming
    cols.forEach((c) => {
      const steps = Math.ceil(c.da + c.db);
      for (let t = -c.db; t <= c.da; t += 0.7) {
        const x = Math.round(c.c.x + c.nx * t), y = Math.round(c.c.y + c.ny * t);
        if (x >= 0 && y >= 0 && x < w && y < h) sewn[y * w + x] = 1;
      }
    });
    if (cur && seq.length) {
      let tr = null;
      if (path.normalOnly) { // prefer travel over ink that is still to be sewn (hidden afterwards)
        // grow the sewn marking a little: its edge slivers are not free (a hop along them lies on top)
        const sp2 = dilateR(sewnPrev, w, h, Math.max(1, Math.round(0.25 * o.pxPerMm)));
        const free = new Uint8Array(w * h);
        for (let i = 0; i < free.length; i++) free[i] = m[i] && !sp2[i] ? 1 : 0;
        tr = travelInside(free, w, h, cur, seq[0], o.pxPerMm);
      }
      if (!tr) {
        tr = travelInside(sew, w, h, cur, seq[0], o.pxPerMm);
        // lettering: a hop that runs > 1.5 mm on top of strokes already sewn shows (T crossbar): jump instead
        if (tr && path.normalOnly) {
          let top = 0;
          for (let i = 1; i < tr.length; i++) {
            const a = i === 1 ? cur : tr[i - 1], b = tr[i], L = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(L / 1.5));
            for (let k = 0; k < n; k++) { const X = Math.round(a.x + (b.x - a.x) * k / n), Y = Math.round(a.y + (b.y - a.y) * k / n); if (X >= 0 && Y >= 0 && X < w && Y < h && sewnPrev[Y * w + X]) top += L / n; }
          }
          if (top > 1.5 * o.pxPerMm) tr = null;
        }
      }
      if (tr) tr.slice(0, -1).forEach((p) => out.push({ x: p.x, y: p.y, role: "travel" }));
      else seq[0].jump = true;
    }
    seq.forEach((p) => out.push(p));
    const lp = out[out.length - 1];
    if (lp) cur = { x: lp.x, y: lp.y };
  }
  return { pts: out, underlay: Array.from(emitted) };
}

// ---------------------------------------------------------------- run
function runObject(m, w, h, o) {
  const dt = distanceTransform(m, w, h);
  const paths = spinePaths(m, w, h, dt);
  const out = [];
  let cur = o.start ? { x: o.start.x, y: o.start.y } : null;
  const pending = paths.slice();
  while (pending.length) {
    let bi = 0, brev = false, bd = Infinity;
    pending.forEach((p, i) => {
      const a = p.pts[0], b = p.pts[p.pts.length - 1];
      const da = cur ? Math.hypot(a.x - cur.x, a.y - cur.y) : 0, db = cur ? Math.hypot(b.x - cur.x, b.y - cur.y) : 1;
      if (da < bd) { bd = da; bi = i; brev = false; }
      if (db < bd) { bd = db; bi = i; brev = true; }
    });
    const path = pending.splice(bi, 1)[0];
    let pts = brev ? path.pts.slice().reverse() : path.pts;
    pts = resampleArc(path.closed && pts.length > 2 ? pts.concat([pts[0]]) : pts, o.runPx);
    if (pts.length < 2) continue;
    if (cur) {
      const d = Math.hypot(pts[0].x - cur.x, pts[0].y - cur.y);
      if (d > 0.9 * o.pxPerMm) out.push({ x: pts[0].x, y: pts[0].y, jump: true });
    }
    out.push({ x: pts[0].x, y: pts[0].y, role: "run" });
    for (let i = 1; i < pts.length; i++) {
      if (o.bean) { out.push({ x: pts[i].x, y: pts[i].y, role: "run" }); out.push({ x: pts[i - 1].x, y: pts[i - 1].y, role: "run" }); }
      out.push({ x: pts[i].x, y: pts[i].y, role: "run" });
    }
    cur = pts[pts.length - 1];
  }
  return { pts: out };
}

// edge-run contour (inset) for fill underlay
function edgeRun(m, w, h, insetPx, stepPx, start) {
  const er = largestPart(erodeR(m, w, h, insetPx), w, h);
  if (countOn(er) < 6) return [];
  let c = mooreContour(er, w, h);
  if (c.length < 6) return [];
  c = smoothPolyline(c.concat([c[0]]), 2);
  let pts = resampleArc(c, stepPx);
  if (start && pts.length > 2) {
    let bi = 0, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.hypot(p.x - start.x, p.y - start.y); if (d < bd) { bd = d; bi = i; } });
    const ring = pts.slice(0, pts.length - 1);
    pts = ring.slice(bi).concat(ring.slice(0, bi + 1));
  }
  return pts.map((p) => ({ x: p.x, y: p.y, role: "underlay" }));
}


// ---------------------------------------------------------------- main
function angDiff(a, b) { const d = Math.abs(((a - b) % 180 + 180) % 180); return Math.min(d, 180 - d); }

// mode colour of the source raster border (null when there is no source)
function sourceBorderRgb(vector) {
  const rgba = vector && vector.sourceRgba, sw = vector && vector.sourceW, sh = vector && vector.sourceH;
  if (!rgba || !(sw > 4) || !(sh > 4)) return null;
  const bins = new Map();
  const add = (x, y) => {
    const p = (y * sw + x) * 4; if (rgba[p + 3] < 18) return;
    const k = ((rgba[p] >> 4) << 8) | ((rgba[p + 1] >> 4) << 4) | (rgba[p + 2] >> 4);
    const b = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += rgba[p]; b.g += rgba[p + 1]; b.b += rgba[p + 2]; bins.set(k, b);
  };
  for (let x = 0; x < sw; x++) { add(x, 0); add(x, sh - 1); }
  for (let y = 1; y < sh - 1; y++) { add(0, y); add(sw - 1, y); }
  let best = null; bins.forEach((b) => { if (!best || b.n > best.n) best = b; });
  return best ? [best.r / best.n, best.g / best.n, best.b / best.n] : null;
}
function prepareArt(vector, widthIn, heightIn, opts) {
  opts = opts || {};
  const vW = Number(vector.widthIn || vector.width_in) || widthIn;
  const vH = Number(vector.heightIn || vector.height_in) || heightIn;
  const rs = rasterSize(widthIn, heightIn, opts.maxSide || 2000);
  const mw = rs.mw, mh = rs.mh;
  const pxPerMm = mw / (widthIn * 25.4);
  const layers = (vector.layers || []).filter((L) => L && L.paths && L.paths.length);
  const own = opts.keepOwn ? [] : null;
  const runLines = [];
  const { label, kindMap } = rasterize(layers, vW, vH, mw, mh, own, runLines);
  const areas = new Float64Array(layers.length);
  for (let i = 0; i < label.length; i++) if (label[i] >= 0) areas[label[i]]++;
  // centreline runs count by their sewn footprint so their colour survives
  runLines.forEach((r) => {
    let len = 0; for (let k = 1; k < r.pts.length; k++) len += Math.hypot(r.pts[k].x - r.pts[k - 1].x, r.pts[k].y - r.pts[k - 1].y);
    areas[r.layer] += len * Math.max(0.5, r.widthMm || 0.5) * pxPerMm;
  });
  const cc = clusterColours(layers, areas, opts);
  const cmap = new Int32Array(mw * mh).fill(-1);
  for (let i = 0; i < label.length; i++) if (label[i] >= 0) cmap[i] = cc.layerToCluster[label[i]];
  const warnings = [];
  const nIn = layers.length;
  // Madeira mapping; clusters that land on the same spool become one colour
  const catalog = opts.madeiraCatalog || "rayon";
  let clusters = cc.clusters.map((c, k) => {
    const hex = rgbToHex(c.rgb);
    const made = nearestThread(hex, catalog);
    return { k, hex, area: c.area, members: c.members, madeira: made };
  });
  const byCode = new Map();
  const remap = new Int32Array(clusters.length);
  const merged = [];
  clusters.sort((a, b) => b.area - a.area).forEach((c) => {
    const key = c.madeira && c.madeira.code ? String(c.madeira.code) : c.hex;
    if (byCode.has(key)) { const t = byCode.get(key); remap[c.k] = t; merged[t].area += c.area; merged[t].members = merged[t].members.concat(c.members); }
    else { byCode.set(key, merged.length); remap[c.k] = merged.length; merged.push(Object.assign({}, c)); }
  });
  for (let i = 0; i < cmap.length; i++) if (cmap[i] >= 0) cmap[i] = remap[cmap[i]];
  clusters = merged;
  // background: border-connected parts of the colour that owns most of the border
  if (!opts.keepBackground) {
    const borderCount = new Float64Array(clusters.length);
    let nb = 0;
    const addB = (i) => { nb++; if (cmap[i] >= 0) borderCount[cmap[i]]++; };
    for (let x = 0; x < mw; x++) { addB(x); addB((mh - 1) * mw + x); }
    for (let y = 1; y < mh - 1; y++) { addB(y * mw); addB(y * mw + mw - 1); }
    let bg = -1, bs = 0;
    borderCount.forEach((v, k) => { if (v > bs) { bs = v; bg = k; } });
    if (bg >= 0 && bs / nb >= 0.35) {
      const lab = rgbToLab(hexToRgb(clusters[bg].hex));
      // paper only if light, or if it matches the source image's border colour
      const srcBg = sourceBorderRgb(vector);
      const matchesSrc = srcBg ? dE(rgbToLab(srcBg), lab) < 12 : false;
      const { comp, comps } = labelComponents(cmap, mw, mh, -1);
      let total = 0, killN = 0;
      comps.forEach((c) => { total += c.n; if (c.value === bg && c.border > 0) killN += c.n; });
      const leavesArt = total - killN >= Math.max(50, total * 0.08);
      if (leavesArt && (lab[0] >= 72 ? (srcBg ? matchesSrc || lab[0] >= 90 : true) : matchesSrc)) {
        const kill = new Set(comps.filter((c) => c.value === bg && c.border > 0).map((c) => c.id));
        let removed = 0;
        for (let i = 0; i < cmap.length; i++) if (kill.has(comp[i])) { cmap[i] = -1; removed++; }
        if (removed) warnings.push({ code: "background-removed", message: "Background colour " + clusters[bg].hex + " treated as fabric (not stitched)." });
      }
    }
  }
  // specks: absorb into the surrounding colour, or drop
  const speckPx = Math.max(4, Math.round(1.0 * pxPerMm * pxPerMm));
  let dropped = 0, absorbed = 0;
  for (let pass = 0; pass < 2; pass++) {
    const { comp, comps } = labelComponents(cmap, mw, mh, -1);
    comps.forEach((c) => {
      if (c.n >= speckPx) return;
      if (c.n >= 3 && kindMap[c.seed != null ? c.seed : -1] === 4) return; // explicit centreline detail
      const votes = new Map();
      for (let y = Math.max(0, c.minY - 1); y <= Math.min(mh - 1, c.maxY + 1); y++) for (let x = Math.max(0, c.minX - 1); x <= Math.min(mw - 1, c.maxX + 1); x++) {
        const i = y * mw + x; if (comp[i] === c.id) continue;
        let adj = false;
        for (let dy = -1; dy <= 1 && !adj; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < mw && ny < mh && comp[ny * mw + nx] === c.id) { adj = true; break; } }
        if (adj) votes.set(cmap[i], (votes.get(cmap[i]) || 0) + 1);
      }
      let best = -1, bv = -1, tot = 0;
      votes.forEach((v, k) => { tot += v; if (k >= 0 && v > bv) { bv = v; best = k; } });
      const val = best >= 0 && bv >= tot * 0.5 ? best : -1;
      for (let y = c.minY; y <= c.maxY; y++) for (let x = c.minX; x <= c.maxX; x++) { const i = y * mw + x; if (comp[i] === c.id) cmap[i] = val; }
      if (val >= 0) absorbed++; else dropped++;
    });
  }
  // hairline slivers (< 0.5 mm) between two colours belong to a neighbour
  {
    const r = 0.25 * pxPerMm;
    for (let k = 0; k < clusters.length; k++) {
      const m = new Uint8Array(cmap.length);
      for (let i = 0; i < cmap.length; i++) if (cmap[i] === k) m[i] = 1;
      const opened = dilateR(erodeR(m, mw, mh, r), mw, mh, r + 0.5);
      for (let i = 0; i < m.length; i++) {
        if (!m[i] || opened[i] || kindMap[i] === 4) continue;
        const x = i % mw, y = (i / mw) | 0;
        const votes = new Map(); let bgv = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) { bgv++; continue; }
          const v = cmap[ny * mw + nx]; if (v === k) continue; if (v < 0) bgv++; else votes.set(v, (votes.get(v) || 0) + 1);
        }
        let best = -1, bv = 0; votes.forEach((v, kk) => { if (v > bv) { bv = v; best = kk; } });
        if (best >= 0 && bv > bgv) cmap[i] = best;
      }
    }
  }
  if (dropped) warnings.push({ code: "specks-dropped", count: dropped, message: dropped + " tiny specks (<1 mm²) dropped — too small to stitch." });
  if (nIn > clusters.length) warnings.push({ code: "colours-merged", message: nIn + " traced colours consolidated to " + clusters.length + " thread colours." });
  const area = new Float64Array(clusters.length);
  for (let i = 0; i < cmap.length; i++) if (cmap[i] >= 0) area[cmap[i]]++;
  clusters.forEach((c, k) => { c.area = area[k]; });
  let ownCluster = null, clusterFirstLayer = null;
  if (own) {
    // full (unoccluded) footprint of each thread colour, and its first layer index
    ownCluster = clusters.map(() => null);
    clusterFirstLayer = clusters.map(() => 1e9);
    own.forEach((o, li) => {
      if (!o) return;
      const k = remap[cc.layerToCluster[li]];
      if (k == null || k < 0) return;
      if (li < clusterFirstLayer[k]) clusterFirstLayer[k] = li;
      const M = ownCluster[k] || (ownCluster[k] = new Uint8Array(mw * mh));
      for (let y = o.y0; y <= o.y1; y++) for (let x = o.x0; x <= o.x1; x++) if (o.m[(y - o.y0) * o.w + x - o.x0]) M[y * mw + x] = 1;
    });
  }
  const layerCluster = layers.map((L, li) => { const k = cc.layerToCluster[li]; return k == null || k < 0 ? -1 : remap[k]; });
  runLines.forEach((r) => { r.cluster = layerCluster[r.layer]; });
  return { cmap, kindMap, mw, mh, pxPerMm, unitPerPx: (widthIn * UNIT_PER_IN) / mw, clusters, warnings, specksAbsorbed: absorbed, ownCluster, clusterFirstLayer, runLines, layerCluster };
}

function underlayRule(type, wMm, fab) {
  const heavy = fab.underlayStep > 0;
  if (type === "satin") {
    if (wMm <= 2.0) return heavy ? ["center-run"] : [];
    if (wMm <= 4.0) return heavy ? ["center-run", "zigzag"] : ["center-run"];
    return ["edge-run", "zigzag"];
  }
  return ["edge-run", "tatami"];
}

// Input already prepared by digitize_prep.py (colours cleaned, fabric removed,
// lower colours extended under upper ones).
// lettering rows: letters of one colour on one baseline (similar height, small gaps,
// periods inside the band); rows of >= 3 shapes, each sorted left to right
function letterRows(objs, pxPerMm) {
  const L = objs.filter((o) => o.letter && o.bb);
  const box = (o) => ({ x0: o.bb.minX / pxPerMm, x1: o.bb.maxX / pxPerMm, y0: o.bb.minY / pxPerMm, y1: o.bb.maxY / pxPerMm });
  const par = new Map(L.map((o) => [o, o]));
  const find = (o) => { while (par.get(o) !== o) o = par.get(o); return o; };
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const a = box(L[i]), b = box(L[j]);
    const ha = a.y1 - a.y0, hb = b.y1 - b.y0, H = Math.max(ha, hb), hmin = Math.min(ha, hb);
    const gap = Math.max(a.x0 - b.x1, b.x0 - a.x1);
    if (gap > 1.2 * H) continue;
    const sameSize = hmin >= 0.6 * H && Math.abs((a.y0 + a.y1) - (b.y0 + b.y1)) / 2 < 0.3 * H;
    // a dot/period sits inside the taller letter's band
    const tall = ha >= hb ? a : b, small = ha >= hb ? b : a;
    const inBand = hmin < 0.6 * H && small.y0 >= tall.y0 - 0.15 * H && small.y1 <= tall.y1 + 0.15 * H;
    if (sameSize || inBand) par.set(find(L[i]), find(L[j]));
  }
  const groups = new Map();
  L.forEach((o) => { const r = find(o); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(o); });
  return Array.from(groups.values()).filter((g) => g.length >= 3 && g.filter((o) => (o.bb.maxY - o.bb.minY) > 0.6 * Math.max(...g.map((q) => q.bb.maxY - q.bb.minY))).length >= 2)
    .map((g) => g.sort((a, b) => a.bb.minX - b.bb.minX));
}

function isPrepped(vector) {
  if (!vector) return false;
  // explicit top-level flag wins (prep v4+); older prep output is recognised by its generator
  if (typeof vector.overlapApplied === "boolean") return vector.overlapApplied;
  return vector.prep === "digitize_prep" ||
    /^digitize_prep/.test(String((vector.stats && vector.stats.generator) || vector.generator || ""));
}
function digitizeWQ(vector, widthIn, heightIn, opts) {
  opts = opts || {};
  const fab = Object.assign({}, wqFabric(opts.fabric));
  // explicit spacing overrides (manual edit in the UI); presets otherwise
  if (Number(opts.density) > 0) fab.fillSpacingMm = Number(opts.density);
  if (Number(opts.satinSpacingMm) > 0) fab.satinSpacingMm = Number(opts.satinSpacingMm);
  // upstream prep (digitize_prep.py) already grew lower colours under upper ones
  const overlapDone = isPrepped(vector);
  if (overlapDone) opts = Object.assign({}, opts, { keepBackground: true, noFold: true }); // fabric already removed upstream
  const art = prepareArt(vector, widthIn, heightIn, Object.assign({}, opts, { keepOwn: overlapDone }));
  const { cmap, kindMap, mw, mh, pxPerMm, unitPerPx, clusters } = art;
  const warnings = art.warnings.slice();
  // pass upstream prep warnings (thin columns, small lettering, ...) through to the meta output
  if (overlapDone && Array.isArray(vector.warnings)) vector.warnings.forEach((w) => {
    if (w && typeof w === "object") warnings.push(Object.assign({}, w, { code: "prep-" + (w.type || w.code || "warning"), source: "prep" }));
  });
  // prep v1.1 lettering flags (letters < 5 mm tall / strokes < 1.2 mm) + the width that fixes them
  const prepText = overlapDone && Array.isArray(vector.textWarnings) ? vector.textWarnings : [];
  prepText.forEach((w) => { if (w && typeof w === "object") warnings.push(Object.assign({}, w, { code: "prep-text-" + (w.type || "warning"), source: "prep" })); });
  const minRecommendedWidthIn = overlapDone && vector.minRecommendedWidthIn != null ? Number(vector.minRecommendedWidthIn) : null;
  const underR = overlapDone ? 0 : (opts.underlapMm == null ? 0.6 : Number(opts.underlapMm)) * pxPerMm;
  const minObjPx = Math.max(4, Math.round(1.0 * pxPerMm * pxPerMm));
  const { comp, comps } = labelComponents(cmap, mw, mh, -1);
  splitTouching(comp, comps, mw, mh, pxPerMm);
  const objects = [];
  let thinRun = 0, smallText = 0, tinyDrop = 0, splitSat = 0;
  comps.forEach((c) => {
    if (c.n < minObjPx) { tinyDrop++; return; }
    const pad = Math.ceil(overlapDone ? 1.1 * pxPerMm : underR) + 3;
    const cr = makeCrop(comp, mw, mh, c, pad, (v) => v === c.id);
    const dt = distanceTransform(cr.m, cr.w, cr.h);
    let dmax = 0; for (let i = 0; i < dt.length; i++) if (dt[i] > dmax) dmax = dt[i];
    const wMm = Math.max(0.1, (2 * dmax - 1) / pxPerMm);
    const areaMm2 = c.n / (pxPerMm * pxPerMm);
    const elong = areaMm2 / (wMm * wMm);
    // upstream kind (teammate prep) wins when present
    const kv = new Map();
    for (let y = 0; y < cr.h; y++) for (let x = 0; x < cr.w; x++) if (cr.m[y * cr.w + x]) { const k = kindMap[(y + cr.y0) * mw + x + cr.x0]; if (k) kv.set(k, (kv.get(k) || 0) + 1); }
    let kindIn = null, kb = 0; kv.forEach((v, k) => { if (v > kb) { kb = v; kindIn = k; } });
    if (kb < c.n * 0.5) kindIn = null;
    const bbMaxMm0 = Math.max(c.maxX - c.minX + 1, c.maxY - c.minY + 1) / pxPerMm;
    // small thin shapes (letters, numerals, marks up to 12 mm): lettering candidates,
    // sewn as satin strokes widened to >= 1.2 mm rather than as running stitch
    const letterish = bbMaxMm0 <= 15 && wMm >= 0.8 && wMm <= 4.0 && kindIn !== 1 && kindIn !== 4 && kindIn !== 3;
    let type;
    if (kindIn === 1 || kindIn === 4) type = "run";
    else if (kindIn === 2) type = wMm > 10 ? "tatami" : (wMm < 1.2 && !letterish ? "run" : "satin");
    else if (kindIn === 3) type = "tatami";
    else if (wMm < 1.2) type = letterish ? "satin" : "run";
    else if (wMm <= 10 && (elong >= 1.8 || wMm < 4)) type = "satin";
    else type = "tatami";
    let strokes = null, altType = null, strokeCov = 1;
    if (type === "satin") { // upstream "satin" is a hint: still verify the column plan covers the shape
      const popt = { spacingPx: 0.4 * pxPerMm, pxPerMm, pullPx: 0 };
      const pl = planSatin(cr.m, cr.m, cr.w, cr.h, popt);
      let okSatin = pl.nPaths > 0 && pl.coverage >= 0.86 && pl.overlap <= 1.2 && pl.crossing <= 0.08 && pl.nPaths <= Math.max(3, Math.round(areaMm2 / (wMm * wMm * 0.8)));
      if (letterish) {
        let sp = strokePaths(cr.m, cr.w, cr.h, dt, pxPerMm);
        if (!sp && bbMaxMm0 <= 3) { // dot / tiny mark: one short column run along its long axis
          const mo0 = moments(cr.m, cr.w, cr.h), t0 = (mo0.axisDeg * Math.PI) / 180, cc0 = { x: mo0.cx, y: mo0.cy };
          const ea0 = shoot(cr.m, cr.w, cr.h, cc0, Math.cos(t0), Math.sin(t0), cr.w + cr.h), eb0 = shoot(cr.m, cr.w, cr.h, cc0, -Math.cos(t0), -Math.sin(t0), cr.w + cr.h);
          const k0 = 0.5;
          sp = [{ pts: [{ x: cc0.x - Math.cos(t0) * eb0 * k0 * 1.6, y: cc0.y - Math.sin(t0) * eb0 * k0 * 1.6 }, { x: cc0.x + Math.cos(t0) * ea0 * k0 * 1.6, y: cc0.y + Math.sin(t0) * ea0 * k0 * 1.6 }], closed: false, normalOnly: true, wPx: Math.max(2, 2 * dmax) }];
        }
        if (sp) {
          let ps = planWith(sp, cr.m, cr.m, cr.w, cr.h, dt, Object.assign({}, popt, { minWidthPx: 1.2 * pxPerMm }));
          strokeCov = ps.coverage;
          if (ps.coverage < 0.97 && sp.length > 1) {
            const sp2 = patchUncovered(sp, ps.cnt, cr.m, cr.w, cr.h, pxPerMm);
            if (process.env.DEBUG_PATCH) console.error("PATCH letter cov", ps.coverage.toFixed(3), "paths", sp.length, "->", sp2.length, "bbox", (cr.x0||0), (cr.y0||0));
            if (sp2.length > sp.length) {
              const ps2 = planWith(sp2, cr.m, cr.m, cr.w, cr.h, dt, Object.assign({}, popt, { minWidthPx: 1.2 * pxPerMm }));
              if (ps2.coverage > ps.coverage + 0.02 && ps2.crossing <= 0.1) { sp = sp2; ps = ps2; }
            }
          }
          // strokes overlap at corners/junctions by design (covered column ends are trimmed when sewn)
          const okS = ps.nPaths > 0 && ps.coverage >= 0.85 && ps.crossing <= 0.1 && ps.overlap <= 3.2;
          if (okS && (!okSatin || ps.coverage >= Math.min(0.9, pl.coverage - 0.03))) {
            altType = wMm < 1.2 ? "run" : okSatin ? "satin" : (wMm < 2.0 && pl.coverage < 0.5 ? "run" : "tatami");
            strokes = sp; okSatin = true;
          }
          if (process.env.DEBUG_WQ) console.error("letter?", wMm.toFixed(2), bbMaxMm0.toFixed(1), "strokes", sp.length, "cov", ps.coverage.toFixed(2), "ovl", ps.overlap.toFixed(2), "x", ps.crossing.toFixed(2), okS ? "ok" : "no", strokes ? "USE" : "");
        }
      }
      if (!okSatin) type = wMm < 2.0 && pl.coverage < 0.5 ? "run" : (wMm < 1.2 ? "run" : "tatami");
      else if (!strokes && wMm < 1.2) type = "run"; // thin non-lettering marks stay running stitch
      if (process.env.DEBUG_WQ) console.error("satin?", wMm.toFixed(2), areaMm2.toFixed(1), "cov", pl.coverage.toFixed(2), "ovl", pl.overlap.toFixed(2), "paths", pl.nPaths, "x", pl.crossing.toFixed(2), "->", type);
    }
    if (type === "run" && !kindIn) thinRun++;
    const mo = moments(cr.m, cr.w, cr.h);
    const bbMaxMm = Math.max(c.maxX - c.minX + 1, c.maxY - c.minY + 1) / pxPerMm;
    if (type !== "tatami" && bbMaxMm < 5) smallText++;
    if (type === "satin" && wMm > 7) splitSat++;
    objects.push({ cid: c.id, cluster: c.value, type, wMm, areaMm2, elong, crop: cr, bbMaxMm, kindIn, strokes, letter: !!strokes, altType, strokeCov,
      cx: (cr.x0 + mo.cx) / pxPerMm, cy: (cr.y0 + mo.cy) / pxPerMm, axisDeg: mo.axisDeg, aspect: mo.aspect,
      bb: { minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY } });
  });
  // lettering strokes only for shapes that sit in a text row; lone marks keep the shape planner
  {
    const byC = new Map();
    objects.forEach((o) => { if (o.letter) { if (!byC.has(o.cluster)) byC.set(o.cluster, []); byC.get(o.cluster).push(o); } });
    const keep = new Set();
    byC.forEach((L) => letterRows(L, pxPerMm).forEach((g) => g.forEach((o) => keep.add(o))));
    objects.forEach((o) => { if (o.letter && !keep.has(o)) { o.letter = false; o.strokes = null; o.type = o.altType || o.type; } });
    // letters below the 5-6 mm / 1.2 mm satin limits: fixed-direction satin per letter
    let nSmall = 0, nScanLow = 0;
    objects.forEach((o) => {
      if (!o.letter) return;
      const hMm = (o.bb.maxY - o.bb.minY + 1) / pxPerMm;
      if ((hMm < 6 || o.wMm < 1.2) && !process.env.WQ_NO_SCAN) { o.scanSmall = true; o.type = "satin"; nSmall++; }
      // strokes leave a big hole (the shallow V of a wide M): one fixed-direction satin instead
      else if (o.strokeCov < 0.9 && !process.env.WQ_NO_SCAN) { o.scanSmall = true; o.type = "satin"; nScanLow++; }
    });
    if (nScanLow) warnings.push({ code: "letter-fixed-direction", count: nScanLow, message: nScanLow + " letters did not split cleanly into strokes: sewn as one fixed-direction satin each." });
    if (nSmall) warnings.push({ code: "small-lettering", count: nSmall, message: nSmall + " letters are under 6 mm tall or have strokes under 1.2 mm: sewn as one fixed-direction satin per letter (cleaner than column satins at this size). Enlarge the text for proper satin lettering." });
  }
  // open centreline paths from upstream (kind run): their own running-stitch objects
  (art.runLines || []).forEach((r) => {
    if (r.cluster == null || r.cluster < 0 || r.pts.length < 2) return;
    let len = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sx = 0, sy = 0;
    r.pts.forEach((p, i) => {
      if (i) len += Math.hypot(p.x - r.pts[i - 1].x, p.y - r.pts[i - 1].y);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); sx += p.x; sy += p.y;
    });
    if (len < 0.8 * pxPerMm) return;
    const wMm = r.widthMm || 0.5;
    objects.push({ type: "runline", line: r.pts, cluster: r.cluster, wMm, areaMm2: (len / pxPerMm) * wMm, kindIn: 4,
      bean: r.bean != null ? !!r.bean : wMm >= 0.8, sewAfterLayer: Number.isFinite(Number(r.sewAfterLayer)) && r.sewAfterLayer !== null ? Number(r.sewAfterLayer) : null,
      crop: { x0: 0, y0: 0, w: 1, h: 1, m: new Uint8Array(1) }, sew: new Uint8Array(1), bbMaxMm: Math.max(maxX - minX, maxY - minY) / pxPerMm,
      cx: sx / r.pts.length / pxPerMm, cy: sy / r.pts.length / pxPerMm, axisDeg: 0, aspect: 1,
      bb: { minX: Math.floor(minX), minY: Math.floor(minY), maxX: Math.ceil(maxX), maxY: Math.ceil(maxY) } });
  });
  // colour order: background -> foreground (by area), outline-ish colours last
  const cInfo = clusters.map((cl, k) => {
    const mine = objects.filter((o) => o.cluster === k);
    const a = mine.reduce((s, o) => s + o.areaMm2, 0) || 1;
    const thin = mine.filter((o) => o.type !== "tatami" && o.wMm <= 4).reduce((s, o) => s + o.areaMm2, 0);
    return { k, area: a, outline: thin / a > 0.6 };
  });
  // with upstream overlap the layer order is the stacking contract: keep it
  const order = cInfo.filter((c) => objects.some((o) => o.cluster === c.k))
    .sort((a, b) => overlapDone ? (art.clusterFirstLayer[a.k] - art.clusterFirstLayer[b.k])
      : ((a.outline - b.outline) || (b.area - a.area))).map((c) => c.k);
  const rank = new Int32Array(clusters.length).fill(1e6);
  order.forEach((k, i) => { rank[k] = i; });
  // underlap + sew masks
  objects.forEach((o) => {
    if (o.type === "runline") return;
    const cr = o.crop;
    let sew = cr.m;
    if (overlapDone && o.type !== "run" && art.ownCluster && art.ownCluster[o.cluster]) {
      // honour the upstream underlap: own footprint hidden under later colours, near this object
      const M = art.ownCluster[o.cluster], reach = 1.1 * pxPerMm;
      const d = distToMask(cr.m, cr.w, cr.h);
      sew = new Uint8Array(cr.m.length);
      const myRank = rank[o.cluster];
      for (let y = 0; y < cr.h; y++) for (let x = 0; x < cr.w; x++) {
        const i = y * cr.w + x;
        if (cr.m[i]) { sew[i] = 1; continue; }
        if (d[i] > reach) continue;
        const gi = (y + cr.y0) * mw + x + cr.x0;
        const v = cmap[gi];
        if (M[gi] && v >= 0 && rank[v] > myRank) sew[i] = 1;
      }
    } else if (underR > 0 && o.type !== "run") {
      const d = distToMask(cr.m, cr.w, cr.h);
      sew = new Uint8Array(cr.m.length);
      const myRank = rank[o.cluster];
      for (let y = 0; y < cr.h; y++) for (let x = 0; x < cr.w; x++) {
        const i = y * cr.w + x;
        if (cr.m[i]) { sew[i] = 1; continue; }
        if (d[i] > underR) continue;
        const v = cmap[(y + cr.y0) * mw + x + cr.x0];
        if (v >= 0 && rank[v] > myRank) sew[i] = 1;
      }
    }
    o.sew = sew;
  });
  // fill angles: follow the long axis; neighbours differ >= 30 deg
  const fills = objects.filter((o) => o.type === "tatami").sort((a, b) => b.areaMm2 - a.areaMm2);
  const near = (a, b) => !(a.bb.maxX + 3 * pxPerMm < b.bb.minX || b.bb.maxX + 3 * pxPerMm < a.bb.minX || a.bb.maxY + 3 * pxPerMm < b.bb.minY || b.bb.maxY + 3 * pxPerMm < a.bb.minY);
  // nearest other fill by centre (within 25 mm): neighbours in both directions must differ >= 30 deg
  const nnOf = fills.map((o, i) => {
    let bd = 25, bj = -1;
    fills.forEach((p, j) => { if (j === i) return; const d = Math.hypot(p.cx - o.cx, p.cy - o.cy); if (d < bd) { bd = d; bj = j; } });
    return bj;
  });
  const nbrs = fills.map((o, i) => {
    const set = new Set();
    fills.forEach((p, j) => { if (j !== i && (near(o, p) || nnOf[i] === j || nnOf[j] === i)) set.add(j); });
    return Array.from(set);
  });
  const candsOf = (o) => {
    const base = o.aspect >= 1.3 ? o.axisDeg : 45;
    // elongated shapes keep their rows within 30 deg of the long axis
    const offs = o.aspect >= 1.6 ? [0, 29, -29, 15, -15] : [0, 45, -45, 90, 30, -30, 60, -60];
    return offs.map((d) => (((base + d) % 180) + 180) % 180);
  };
  fills.forEach((o) => { o.rowDeg = null; });
  for (let pass = 0; pass < 3; pass++) {
    fills.forEach((o, i) => {
      const nb = nbrs[i].map((j) => fills[j].rowDeg).filter((a) => a != null);
      const cands = candsOf(o);
      let best = cands[0], bs = -Infinity;
      cands.forEach((a, ci) => {
        const md = nb.length ? Math.min.apply(null, nb.map((b) => angDiff(a, b))) : 90;
        const sc = Math.min(md, 30) * 10 - ci; // first candidate meeting 30 deg to every neighbour wins
        if (sc > bs) { bs = sc; best = a; }
      });
      o.rowDeg = best;
    });
  }
  if (opts.angleDeg != null) fills.forEach((o) => { o.rowDeg = Number(opts.angleDeg) + 90; });
  // sequence: colours in order; nearest-neighbour inside a colour; centre-out start
  // visits: one per colour; run lines whose sewAfterLayer comes after their
  // colour's slot get a late visit right after that layer's colour
  const visits = order.map((k) => ({ k, key: overlapDone ? art.clusterFirstLayer[k] : rank[k], objs: [] }));
  const vByK = new Map(visits.map((v) => [v.k, v]));
  const late = new Map();
  objects.forEach((o) => {
    const v = vByK.get(o.cluster); if (!v) return;
    // a run only needs the late visit if later colours would sew over it
    let buried = 0;
    if (o.type === "runline") {
      let n = 0;
      o.line.forEach((pt) => { const x = Math.round(pt.x), y = Math.round(pt.y); if (x < 0 || y < 0 || x >= mw || y >= mh) return; n++; const cv = cmap[y * mw + x]; if (cv >= 0 && cv !== o.cluster && (overlapDone ? art.clusterFirstLayer[cv] > v.key : rank[cv] > rank[o.cluster])) buried++; });
      buried = n ? buried / n : 0;
    }
    if (o.type === "runline" && o.sewAfterLayer != null && buried > 0.2) {
      const ak = art.layerCluster[o.sewAfterLayer];
      const afterKey = overlapDone ? o.sewAfterLayer : (ak != null && ak >= 0 ? rank[ak] : -1);
      if (afterKey >= v.key && !(ak === o.cluster)) {
        // at most one extra visit per colour, after the latest layer its runs sit on
        const id = o.cluster;
        if (!late.has(id)) late.set(id, { k: o.cluster, key: afterKey + 0.5, objs: [] });
        const lv = late.get(id); lv.key = Math.max(lv.key, afterKey + 0.5); lv.objs.push(o); return;
      }
    }
    v.objs.push(o);
  });
  late.forEach((v) => visits.push(v));
  visits.sort((a, b) => a.key - b.key);
  // Only shapes that actually overlap need their stacking order. Greedy
  // topological order: stay on the current colour whenever its next visit has
  // no pending predecessor (fewer colour changes), else lowest key first.
  if (visits.length > 1) {
    const G = Math.max(1, Math.round(1.0 * pxPerMm)), gw = Math.ceil(mw / G), gh = Math.ceil(mh / G);
    const occ = visits.map((v) => {
      const g = new Uint8Array(gw * gh);
      const mark = (gx, gy) => { for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = gx + dx, y = gy + dy; if (x >= 0 && y >= 0 && x < gw && y < gh) g[y * gw + x] = 1; } };
      v.objs.forEach((o) => {
        if (o.type === "runline") { o.line.forEach((pt) => mark((pt.x / G) | 0, (pt.y / G) | 0)); return; }
        const cr = o.crop;
        for (let y = 0; y < cr.h; y += 2) for (let x = 0; x < cr.w; x += 2) if (o.sew[y * cr.w + x]) g[(((y + cr.y0) / G) | 0) * gw + (((x + cr.x0) / G) | 0)] = 1;
      });
      return g;
    });
    const overl = (a, b) => { const A = occ[a], B = occ[b]; for (let i = 0; i < A.length; i++) if (A[i] && B[i]) return true; return false; };
    const pred = visits.map(() => []);
    for (let i = 0; i < visits.length; i++) for (let j = 0; j < visits.length; j++) {
      if (i !== j && visits[i].key < visits[j].key && visits[i].k !== visits[j].k && overl(i, j)) pred[j].push(i);
      else if (i !== j && visits[i].key < visits[j].key && visits[i].k === visits[j].k) pred[j].push(i); // same colour keeps its own order
    }
    const done = new Array(visits.length).fill(false), outV = [];
    let curK = -1;
    for (let step = 0; step < visits.length; step++) {
      let pick = -1;
      for (let j = 0; j < visits.length; j++) {
        if (done[j] || pred[j].some((i) => !done[i])) continue;
        if (pick < 0 || (visits[j].k === curK && visits[pick].k !== curK) || ((visits[j].k === curK) === (visits[pick].k === curK) && visits[j].key < visits[pick].key)) pick = j;
      }
      if (pick < 0) { for (let j = 0; j < visits.length; j++) if (!done[j]) { pick = j; break; } }
      done[pick] = true; outV.push(visits[pick]); curK = visits[pick].k;
    }
    visits.length = 0; outV.forEach((v) => visits.push(v));
  }
  const seq = [];
  let curMm = { x: widthIn * 12.7, y: heightIn * 12.7 };
  visits.forEach((vis) => {
    // lettering rows: letters of one colour on one baseline are sewn as a unit, left to right
    const rows = letterRows(vis.objs, pxPerMm);
    const inRow = new Set(); rows.forEach((g) => g.forEach((o) => inRow.add(o)));
    const left = vis.objs.filter((o) => !inRow.has(o)).concat(rows.map((g) => ({ row: g, type: "row", bb: { minX: Math.min(...g.map((o) => o.bb.minX)), maxX: Math.max(...g.map((o) => o.bb.maxX)), minY: Math.min(...g.map((o) => o.bb.minY)), maxY: Math.max(...g.map((o) => o.bb.maxY)) }, cx: g[0].cx, cy: g[0].cy })));
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((o, i) => {
        let d;
        if (o.type === "runline") {
          // an open run starts at whichever end is nearer and leaves the needle at the other end
          const a = o.line[0], b = o.line[o.line.length - 1];
          d = Math.min(Math.hypot(a.x / pxPerMm - curMm.x, a.y / pxPerMm - curMm.y), Math.hypot(b.x / pxPerMm - curMm.x, b.y / pxPerMm - curMm.y));
        } else {
          const bb = o.type === "row" ? o.row[0].bb : o.bb; // a text row is entered at its first letter
          const x0 = bb.minX / pxPerMm, x1 = bb.maxX / pxPerMm, y0 = bb.minY / pxPerMm, y1 = bb.maxY / pxPerMm;
          const dx = Math.max(x0 - curMm.x, 0, curMm.x - x1), dy = Math.max(y0 - curMm.y, 0, curMm.y - y1);
          d = Math.hypot(dx, dy) + 0.01 * Math.hypot(o.cx - curMm.x, o.cy - curMm.y);
        }
        if (d < bd) { bd = d; bi = i; }
      });
      const o = left.splice(bi, 1)[0];
      if (o.type === "row") { o.row.forEach((q) => seq.push(q)); const lq = o.row[o.row.length - 1]; curMm = { x: lq.cx, y: lq.cy }; continue; }
      seq.push(o);
      if (o.type === "runline") {
        const a = o.line[0], b = o.line[o.line.length - 1];
        const da = Math.hypot(a.x / pxPerMm - curMm.x, a.y / pxPerMm - curMm.y), db = Math.hypot(b.x / pxPerMm - curMm.x, b.y / pxPerMm - curMm.y);
        const e = da <= db ? b : a;
        curMm = { x: e.x / pxPerMm, y: e.y / pxPerMm };
      } else curMm = { x: o.cx, y: o.cy };
    }
  });
  // pending coverage (for hidden travel)
  const pending = new Uint16Array(mw * mh);
  const CF = Math.max(1, Math.round(0.5 * pxPerMm));
  const cgw = Math.ceil(mw / CF), cgh = Math.ceil(mh / CF);
  const pendCell = new Int32Array(cgw * cgh);
  const addPending = (o, v) => {
    const cr = o.crop;
    for (let y = 0; y < cr.h; y++) for (let x = 0; x < cr.w; x++) if (o.sew[y * cr.w + x]) {
      const gx = x + cr.x0, gy = y + cr.y0, i = gy * mw + gx;
      const before = pending[i]; pending[i] += v;
      if (before === 0 && pending[i] > 0) pendCell[((gy / CF) | 0) * cgw + ((gx / CF) | 0)]++;
      else if (before > 0 && pending[i] === 0) pendCell[((gy / CF) | 0) * cgw + ((gx / CF) | 0)]--;
    }
  };
  // hidden route under not-yet-sewn objects (coarse BFS); px points or null
  const MAX_ON_TOP_LETTER_MM = process.env.WQ_ONTOP_MM != null ? Number(process.env.WQ_ONTOP_MM) : 1.5; // 2.5 left visible hops across the tops of 2026 (Oct 7)
  let allowTop = false, innerFill = false;
  const INNER_TOP_MM = process.env.WQ_INNER_TOP_MM != null ? Number(process.env.WQ_INNER_TOP_MM) : 3.0;
  const capMm = () => (innerFill ? INNER_TOP_MM : letterHop ? MAX_ON_TOP_LETTER_MM : MAX_ON_TOP_MM); // underlay phase: the object's own top layer will still cover the travel
  const MAX_ON_TOP_MM = process.env.WQ_ONTOP_MM != null ? Number(process.env.WQ_ONTOP_MM) : 1.5;
  function hiddenRoute(a, b, loose) {
    const need = Math.max(1, Math.round(CF * CF * 0.7));
    const okCell = (j) => pendCell[j] + sameCell[j] >= need;
    const edgeNeed = Math.max(1, Math.round(CF * CF * 0.3));
    const pass = (j) => okCell(j);
    const ax = Math.min(cgw - 1, (a.x / CF) | 0), ay = Math.min(cgh - 1, (a.y / CF) | 0);
    const bx = Math.min(cgw - 1, (b.x / CF) | 0), by = Math.min(cgh - 1, (b.y / CF) | 0);
    const start = ay * cgw + ax, goal = by * cgw + bx;
    const prev = new Int32Array(cgw * cgh).fill(-2);
    const q = new Int32Array(cgw * cgh);
    let qh = 0, qt = 0; q[qt++] = start; prev[start] = -1;
    const straight = Math.hypot(b.x - a.x, b.y - a.y) / CF;
    {
      // cheapest route: under not-yet-sewn objects costs 1, over sewn same-colour thread 2.5
      // (it shows as a raised line), open background 40 and only for letter-to-letter hops
      // in one text row, accepted when it crosses at most ~1 mm of background (a kerning gap)
      const mg = loose ? 12 : Math.max(20, Math.round(straight * 1.25) + 10);
      const x0 = Math.max(0, Math.min(ax, bx) - mg), x1 = Math.min(cgw - 1, Math.max(ax, bx) + mg);
      const y0 = Math.max(0, Math.min(ay, by) - mg), y1 = Math.min(cgh - 1, Math.max(ay, by) + mg);
      const D = new Float64Array(cgw * cgh).fill(Infinity); D[start] = 0;
      const heap = [[0, start]];
      const hpush = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const pa = (i - 1) >> 1; if (heap[pa][0] <= heap[i][0]) break; [heap[pa], heap[i]] = [heap[i], heap[pa]]; i = pa; } };
      const hpop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m2 = i; if (l < heap.length && heap[l][0] < heap[m2][0]) m2 = l; if (r < heap.length && heap[r][0] < heap[m2][0]) m2 = r; if (m2 === i) break; [heap[m2], heap[i]] = [heap[i], heap[m2]]; i = m2; } } return top; };
      while (heap.length) {
        const [dd, i] = hpop(); if (dd > D[i]) continue; if (i === goal) break;
        const x = i % cgw, y = (i / cgw) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy; if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
          const j = ny * cgw + nx;
          // edge cells (>= 30% under a later object) hug that object's border: its underlap hides the line
          const pc = j === goal || pendCell[j] >= need ? 1 : pendCell[j] + sameCell[j] >= need ? (pendCell[j] >= edgeNeed ? 1.3 : topCell[j] >= edgeNeed ? 4 : 2.5) : loose ? 40 : -1;
          if (pc < 0) continue;
          const c = (dx && dy ? 1.414 : 1) * pc;
          if (dd + c < D[j]) { D[j] = dd + c; prev[j] = i; hpush([D[j], j]); }
        }
      }
      if (prev[goal] === -2) { if (process.env.DEBUG_ROUTE) console.error("ROUTE none", Math.round(a.x / pxPerMm * 10), Math.round(a.y / pxPerMm * 10), "->", Math.round(b.x / pxPerMm * 10), Math.round(b.y / pxPerMm * 10)); return null; }
      let vis = 0; for (let i = goal; i !== -1; i = prev[i]) if (i !== goal && i !== start && !okCell(i)) vis++;
      if (vis * CF > 1.0 * pxPerMm + 0.5) return null;
      // thread laid on top of finished same-colour stitching shows as a raised line:
      // allow at most ~1.5 mm of it per hop, otherwise trim
      let onTop = 0; for (let i = goal; i !== -1; i = prev[i]) if (i !== goal && i !== start && !(pendCell[i] >= edgeNeed) && okCell(i) && topCell[i] >= edgeNeed) onTop++;
      if (process.env.DEBUG_ROUTE) console.error("ROUTE", Math.round(a.x / pxPerMm * 10), Math.round(a.y / pxPerMm * 10), "->", Math.round(b.x / pxPerMm * 10), Math.round(b.y / pxPerMm * 10), "vis", vis, "onTop", onTop, "loose", !!loose);
      // letter-to-letter hops may cross up to ~2.5 mm of the letter just sewn (its end), never a fill
      if (!allowTop && onTop * CF > capMm() * pxPerMm) return null;
      qt = 0; // skip the plain BFS below
    }
    while (qh < qt) {
      const i = q[qh++]; if (i === goal) break;
      const x = i % cgw, y = (i / cgw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= cgw || ny >= cgh) continue;
        const j = ny * cgw + nx;
        if (prev[j] !== -2) continue;
        if (j !== goal && !pass(j)) continue;
        prev[j] = i; q[qt++] = j;
      }
    }
    if (prev[goal] === -2) return null;
    const pts = [];
    for (let i = goal; i !== -1; i = prev[i]) pts.push({ x: (i % cgw) * CF + CF / 2, y: ((i / cgw) | 0) * CF + CF / 2 });
    pts.reverse(); pts[0] = { x: a.x, y: a.y }; pts[pts.length - 1] = { x: b.x, y: b.y };
    let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (len / CF > straight * 2.5 + 20) return null;
    const out = [pts[0]]; let k = 0;
    while (k < pts.length - 1) { let j = pts.length - 1; while (j > k + 1 && !hiddenLine(pts[k], pts[j], loose)) j--; out.push(pts[j]); k = j; }
    return out;
  }
  seq.forEach((o) => addPending(o, 1));
  // areas of the current colour (sewn or being sewn): travel there is thread on
  // same-colour thread, so it counts as hidden; cleared at each colour change
  const sameMask = new Uint8Array(mw * mh);
  const sameCell = new Int32Array(cgw * cgh);
  let sameList = [];
  const topCell = new Int32Array(cgw * cgh);
  const markSame = (o) => {
    const cr = o.crop; if (o.type === "runline") return;
    const capTop = o.type === "tatami" || !!o.letter;
    for (let y = 0; y < cr.h; y++) for (let x = 0; x < cr.w; x++) if (o.sew[y * cr.w + x]) {
      const gx = x + cr.x0, gy = y + cr.y0, i = gy * mw + gx;
      if (!sameMask[i]) { sameMask[i] = 1; sameCell[((gy / CF) | 0) * cgw + ((gx / CF) | 0)]++; }
      // finished fills and lettering: travel on top of them shows (capped in hiddenRoute/hiddenLine)
      if (capTop && sameMask[i] !== 2) { sameMask[i] = 2; topCell[((gy / CF) | 0) * cgw + ((gx / CF) | 0)]++; }
    }
    sameList.push(o);
  };
  const clearSame = () => {
    sameList.forEach((o) => { const cr = o.crop; for (let y = 0; y < cr.h; y++) for (let x = 0; x < cr.w; x++) if (o.sew[y * cr.w + x]) sameMask[(y + cr.y0) * mw + x + cr.x0] = 0; });
    sameCell.fill(0); topCell.fill(0); sameList = [];
  };
  // knockdown base (towel): low-density fill under everything, first colour
  let knock = null;
  if (fab.knockdown && seq.length) {
    const all = new Uint8Array(mw * mh);
    seq.forEach((o) => { const cr = o.crop; for (let y = 0; y < cr.h; y++) for (let x = 0; x < cr.w; x++) if (o.sew[y * cr.w + x]) all[(y + cr.y0) * mw + x + cr.x0] = 1; });
    const kd = dilateR(all, mw, mh, 1.0 * pxPerMm);
    knock = { type: "tatami", knockdown: true, cluster: seq[0].cluster, crop: { m: kd, w: mw, h: mh, x0: 0, y0: 0 }, sew: kd, rowDeg: 45, wMm: 99, areaMm2: countOn(kd) / (pxPerMm * pxPerMm), cx: widthIn * 12.7, cy: heightIn * 12.7, axisDeg: 0, aspect: 1, bb: { minX: 0, minY: 0, maxX: mw - 1, maxY: mh - 1 } };
    seq.unshift(knock);
  }
  // ---- generate + assemble
  const stream = [];
  const threads = [];
  const objMeta = [];
  let curPx = null, curCluster = -1, needTieIn = true;
  const toU = (p) => ({ x: Math.round(p.x * unitPerPx), y: Math.round(p.y * unitPerPx) });
  const push = (kind, p, obj, role) => { const u = toU(p); stream.push({ kind, x: u.x, y: u.y, obj, role: role || "" }); };
  const lastNeedle = () => { for (let i = stream.length - 1; i >= 0; i--) { const s = stream[i]; if (s.kind === "stitch") return s; if (s.kind === "trim" || s.kind === "color") return null; } return null; };
  function tieOff(objIdx) {
    const n = stream.length; if (!n) return;
    let e = -1, pp = -1;
    for (let i = n - 1; i >= 0; i--) { if (stream[i].kind !== "stitch") break; if (e < 0) e = i; else { const d = Math.hypot(stream[i].x - stream[e].x, stream[i].y - stream[e].y); if (d >= 3) { pp = i; break; } } }
    if (e < 0 || pp < 0) return;
    const E = stream[e], P = stream[pp];
    const L = Math.hypot(P.x - E.x, P.y - E.y); const t = Math.min(10, L) / L;
    const q = { x: Math.round(E.x + (P.x - E.x) * t), y: Math.round(E.y + (P.y - E.y) * t) };
    stream.push({ kind: "stitch", x: q.x, y: q.y, obj: objIdx, role: "tie" });
    stream.push({ kind: "stitch", x: E.x, y: E.y, obj: objIdx, role: "tie" });
    stream.push({ kind: "stitch", x: q.x, y: q.y, obj: objIdx, role: "tie" });
    stream.push({ kind: "stitch", x: E.x, y: E.y, obj: objIdx, role: "tie" });
  }
  function tieIn(pts, i0, objIdx) {
    const a = pts[i0];
    let b = null;
    for (let i = i0 + 1; i < pts.length; i++) { if (pts[i].jump) break; if (Math.hypot(pts[i].x - a.x, pts[i].y - a.y) >= 0.3 * pxPerMm) { b = pts[i]; break; } }
    push("stitch", a, objIdx, "tie");
    if (!b) return;
    const L = Math.hypot(b.x - a.x, b.y - a.y); const t = Math.min(1.0 * pxPerMm, L) / L;
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    push("stitch", q, objIdx, "tie"); push("stitch", a, objIdx, "tie"); push("stitch", q, objIdx, "tie"); push("stitch", a, objIdx, "tie");
  }
  function hiddenLine(a, b, loose) {
    const L = Math.hypot(b.x - a.x, b.y - a.y); const n = Math.max(2, Math.ceil(L / 1.5));
    let ok = 0, top = 0;
    for (let i = 0; i <= n; i++) { const x = Math.round(a.x + (b.x - a.x) * i / n), y = Math.round(a.y + (b.y - a.y) * i / n); if (x >= 0 && y >= 0 && x < mw && y < mh && (pending[y * mw + x] > 0 || sameMask[y * mw + x])) { ok++; if (!(pending[y * mw + x] > 0) && sameMask[y * mw + x] === 2) top++; } }
    if (!allowTop && top * L / n > capMm() * pxPerMm + 1) return false; // on top of finished thread: visible
    if (loose) return (n + 1 - ok) * L / n <= 1.0 * pxPerMm + 1; // at most ~1 mm of open background
    return ok / (n + 1) >= 0.95;
  }
  function moveTo(p, objIdx, sameColour) {
    // returns true if a tie-in is needed (after trim)
    if (!curPx) { push("jump", p, objIdx); return true; }
    const d = Math.hypot(p.x - curPx.x, p.y - curPx.y) / pxPerMm;
    if (sameColour && d <= 1.0) { return false; }
    if (sameColour && hiddenLine(curPx, p)) {
      runAlong([curPx, p], 3.0 * pxPerMm).slice(0, -1).forEach((q) => push("stitch", q, objIdx, "travel"));
      return false;
    }
    if (sameColour && d > 3.0) {
      const route = hiddenRoute(curPx, p) || (letterHop ? hiddenRoute(curPx, p, true) : null);
      if (route) { runAlong(route, 3.0 * pxPerMm).slice(0, -1).forEach((q) => push("stitch", q, objIdx, "travel")); return false; }
    }
    // short unhidden hop (1-3 mm): sew it as one connector stitch instead of a jump —
    // a DST jump would leave a loose float, and Brother machines trim on every PEC jump.
    if (sameColour && d <= 3.0) { return false; }
    if (sameColour) { tieOff(objIdx); const ln = lastNeedle(); if (ln) stream.push({ kind: "trim", x: ln.x, y: ln.y, obj: objIdx, role: "" }); }
    push("jump", p, objIdx);
    return true;
  }
  let letterHop = false;
  seq.forEach((o, si) => {
    const objIdx = objMeta.length;
    letterHop = !!(o.letter && si > 0 && seq[si - 1].letter && seq[si - 1].cluster === o.cluster);
    const cl = clusters[o.cluster];
    const cr = o.crop;
    const startLocal = curPx ? { x: curPx.x - cr.x0, y: curPx.y - cr.y0 } : null;
    let pts = [], params = {};
    const smallText = o.type === "satin" && o.bbMaxMm < 6;
    if (o.type === "tatami") {
      const spacing = o.knockdown ? 1.4 : fab.fillSpacingMm;
      const big = o.areaMm2 >= 60 && !o.knockdown;
      const under = [];
      let ul = [];
      if (!o.knockdown) {
        ul = edgeRun(o.sew, cr.w, cr.h, 0.45 * pxPerMm, 2.5 * pxPerMm, startLocal);
        if (ul.length) under.push("edge-run");
      }
      let ut = [];
      if (big) {
        const inner = erodeR(o.sew, cr.w, cr.h, 0.6 * pxPerMm);
        if (countOn(inner) > 20) {
          const st = ul.length ? ul[ul.length - 1] : startLocal;
          ut = tatami(inner, cr.w, cr.h, { rowDeg: o.rowDeg + 90, spacingPx: (fab.underlayStep > 0 ? 1.8 : 2.2) * pxPerMm, stitchPx: 3.0 * pxPerMm, pullPx: 0, pxPerMm, start: st, x0: cr.x0, y0: cr.y0, role: "underlay", minRowPx: 1.0 * pxPerMm });
          if (ut.length) under.push("tatami");
        }
      }
      const st2 = ut.length ? ut[ut.length - 1] : (ul.length ? ul[ul.length - 1] : startLocal);
      const top = tatami(o.sew, cr.w, cr.h, { rowDeg: o.rowDeg, spacingPx: spacing * pxPerMm, stitchPx: (o.knockdown ? 3.0 : fab.fillStitchMm) * pxPerMm, pullPx: o.knockdown ? 0 : fab.pullFillMm * pxPerMm, pxPerMm, start: st2, x0: cr.x0, y0: cr.y0, role: o.knockdown ? "knockdown" : "fill" });
      // join passes with in-shape travel
      const join = (seqA, seqB, mask) => {
        if (!seqA.length) return seqB;
        if (!seqB.length) return seqA;
        const a = seqA[seqA.length - 1], b = seqB[0];
        const tr = travelInside(mask, cr.w, cr.h, a, b, pxPerMm);
        const mid = tr ? tr.slice(0, -1).map((p) => ({ x: p.x, y: p.y, role: "travel" })) : [];
        if (!tr) seqB[0].jump = true;
        return seqA.concat(mid, seqB);
      };
      pts = join(join(ul, ut, o.sew), top, o.sew);
      params = { densityMm: spacing, stitchMm: fab.fillStitchMm, angleDeg: ((o.rowDeg - 90) % 180 + 180) % 180, rowDeg: o.rowDeg, pullMm: o.knockdown ? 0 : fab.pullFillMm, underlay: under, underlayEmitted: under };
    } else if (o.type === "satin" && o.letter && o.scanSmall) {
      // small lettering (< 6 mm tall or < 1.2 mm strokes): stroke satins turn into fans and
      // blobs at this size; one fixed-direction satin per letter (horizontal stitches, edge to
      // edge, no underlay) keeps the glyph outline crisp and readable
      const spacing = 0.45, pullMm = Math.min(fab.pullSatinMm, 0.28); // knit pull floor (0.2 left 2/25 objects outside the jersey range)
      pts = tatami(o.sew, cr.w, cr.h, { rowDeg: o.scanDeg || 0, spacingPx: (spacing / 2) * pxPerMm, stitchPx: 4.5 * pxPerMm, pullPx: pullMm * pxPerMm, pxPerMm, start: startLocal, x0: 0, y0: 0, role: "satin", scanSatin: true, minRowPx: 0.25 * pxPerMm });
      params = { satinSpacingMm: spacing, pullMm, underlay: [], underlayEmitted: [], lettering: true, style: "fixed-direction-satin", smallLetterFallback: true, minColumnMm: 1.2 };
    } else if (o.type === "satin") {
      const spacing = smallText || o.letter ? Math.max(fab.satinSpacingMm, 0.45) : fab.satinSpacingMm;
      // lettering: no underlay under 2 mm columns (it would fill the counters and blur the letter)
      // 2-4 mm letters: centre walk only (sews out and back, so a stroke ends where it began)
      const ulFor = (w) => (o.letter && w < 2.0 ? [] : o.letter && w <= 4.0 ? ["center-run"] : underlayRule("satin", w, fab));
      // small lettering: lighter pull (0.35 mm/side on a 1.3 mm stroke closes counters and joins letters)
      const pullMm = o.letter && o.wMm < 3 ? Math.min(fab.pullSatinMm, 0.28) : fab.pullSatinMm;
      const nx = seq[si + 1];
      const exitHint = o.letter && nx && nx.letter && nx.cluster === o.cluster && nx.bb && nx.bb.minY < o.bb.maxY && nx.bb.maxY > o.bb.minY ? { x: nx.bb.minX - cr.x0, y: (nx.bb.minY + nx.bb.maxY) / 2 - cr.y0 } : null;
      const r = satinObject(cr.m, o.sew, cr.w, cr.h, { exitHint, spacingPx: spacing * pxPerMm, pullPx: pullMm * pxPerMm, pxPerMm, splitPx: 7.0 * pxPerMm, start: startLocal, underPx: overlapDone ? 0.8 * pxPerMm : underR, underlayFor: ulFor, zigMm: fab.underlayStep > 0 ? 1.8 : 2.2,
        paths: o.strokes ? o.strokes.map((p) => Object.assign({}, p, { pts: p.pts.slice() })) : undefined, minWidthPx: o.letter ? 1.2 * pxPerMm : 0 });
      pts = r.pts;
      if (process.env.DEBUG_DUMP && o.bbMaxMm < 16) {
        require("fs").writeFileSync(process.env.DEBUG_DUMP + "/sat-" + objIdx + ".json", JSON.stringify({ w: cr.w, h: cr.h, x0: cr.x0, y0: cr.y0, pxPerMm, wMm: o.wMm, m: Buffer.from(cr.m).toString("base64"), sew: Buffer.from(o.sew).toString("base64"), strokes: o.strokes ? o.strokes.map((p) => p.pts.map((q) => [q.x, q.y])) : null, pull: fab.pullSatinMm, pts: r.pts.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, p.role, p.jump ? 1 : 0]) }));
      }
      params = { satinSpacingMm: spacing, pullMm, underlay: ulFor(o.wMm), underlayEmitted: r.underlay, split: o.wMm > 7, lettering: !!o.letter, minColumnMm: o.letter ? 1.2 : undefined };
    } else if (o.type === "runline") {
      // running stitch along the given centreline, bean (triple) for bold lines
      const bean = !!o.bean;
      let line = o.line;
      if (curPx && Math.hypot(line[line.length - 1].x - curPx.x, line[line.length - 1].y - curPx.y) < Math.hypot(line[0].x - curPx.x, line[0].y - curPx.y)) line = line.slice().reverse();
      const rs = resampleArc(line, (bean ? 2.2 : 2.3) * pxPerMm);
      pts = [{ x: rs[0].x, y: rs[0].y, role: "run" }];
      for (let i = 1; i < rs.length; i++) {
        if (bean) { pts.push({ x: rs[i].x, y: rs[i].y, role: "run" }); pts.push({ x: rs[i - 1].x, y: rs[i - 1].y, role: "run" }); }
        pts.push({ x: rs[i].x, y: rs[i].y, role: "run" });
      }
      params = { stitchMm: bean ? 2.2 : 2.3, pullMm: 0, underlay: [], underlayEmitted: [], bean, centreline: true };
    } else {
      const bean = o.wMm >= 0.9;
      pts = runObject(cr.m, cr.w, cr.h, { runPx: (bean ? 2.2 : 2.0) * pxPerMm, pxPerMm, start: startLocal, bean }).pts;
      params = { stitchMm: 2.0, pullMm: 0, underlay: [], underlayEmitted: [], bean };
    }
    pts = pts.map((p) => ({ x: p.x + cr.x0, y: p.y + cr.y0, role: p.role, jump: p.jump }));
    let pendingDropped = false;
    // drop leading internal jumps
    while (pts.length && pts[0].jump && pts.length > 1 && false) pts.shift();
    if (pts.length < 2) { addPending(o, -1); return; }
    // colour change
    let tie = false;
    const sameColour = o.cluster === curCluster;
    if (!sameColour) {
      clearSame();
      if (stream.length) { tieOff(objIdx); const ln = lastNeedle(); if (ln) stream.push({ kind: "trim", x: ln.x, y: ln.y, obj: objIdx, role: "" }); stream.push({ kind: "color", x: ln ? ln.x : 0, y: ln ? ln.y : 0, obj: objIdx, role: "" }); }
      threads.push({ hex: cl.madeira && cl.madeira.hex ? cl.madeira.hex : cl.hex, sourceHex: cl.hex, code: cl.madeira && cl.madeira.code, name: cl.madeira && cl.madeira.name, brand: cl.madeira && cl.madeira.brand, layerIndex: o.cluster, type: o.type });
      curPx = curPx; // keep position for the jump
      push("jump", pts[0], objIdx);
      tie = true;
      curCluster = o.cluster;
    } else {
      tie = moveTo(pts[0], objIdx, true);
    }
    if (tie) tieIn(pts, 0, objIdx); else push("stitch", pts[0], objIdx, pts[0].role);
    addPending(o, -1); pendingDropped = true; // own area no longer "pending"...
    markSame(o); // ...but it is current-colour thread, so travel over it stays hidden
    let firstTop = pts.findIndex((q) => q.role === "fill" || q.role === "satin");
    if (firstTop < 0) firstTop = 0;
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (p.jump) {
        const prev = pts[i - 1];
        curPx = prev;
        allowTop = i < firstTop;
        // hop between two regions of the same fill: up to INNER_TOP_MM on top of its own rows
        innerFill = o.type === "tatami" && !allowTop;
        const t2 = moveTo(p, objIdx, true);
        allowTop = false; innerFill = false;
        if (t2) tieIn(pts, i, objIdx); else push("stitch", p, objIdx, p.role);
        continue;
      }
      push("stitch", p, objIdx, p.role);
    }
    curPx = pts[pts.length - 1];
    if (!pendingDropped) addPending(o, -1);
    objMeta.push({
      id: "wq-" + objIdx, layerIndex: o.cluster, type: o.type === "runline" ? "run" : o.type, knockdown: !!o.knockdown,
      thread: { hex: cl.madeira && cl.madeira.hex ? cl.madeira.hex : cl.hex, code: cl.madeira && cl.madeira.code, name: cl.madeira && cl.madeira.name, brand: cl.madeira && cl.madeira.brand },
      // lettering columns are sewn at >= 1.2 mm (pull included): report the sewn width, keep the art width
      widthMm: +(o.letter && o.type === "satin" ? Math.max(o.wMm, 1.2) : o.wMm).toFixed(2), artWidthMm: o.letter ? +o.wMm.toFixed(2) : undefined,
      areaMm2: +o.areaMm2.toFixed(1), cx: +o.cx.toFixed(2), cy: +o.cy.toFixed(2),
      axisDeg: +o.axisDeg.toFixed(1), aspect: +o.aspect.toFixed(2), kindIn: o.kindIn ? ["", "run", "satin", "fill", "run-centreline"][o.kindIn] : null, params,
    });
  });
  if (stream.length) { tieOff(objMeta.length - 1); const ln = lastNeedle(); if (ln) stream.push({ kind: "trim", x: ln.x, y: ln.y, obj: objMeta.length - 1, role: "" }); }
  // ---- pile-up guard: keep each 1 mm2 cell under ~15 needle hits. Hot spots were the inner
  // side of tight satin turns and narrow satin ends (one object stacking 20-30 hits per mm2).
  // A satin point landing in a cell that already has HOT hits is dropped together with its
  // partner on the other side (parity kept: the column just gets one wider gap there);
  // underlay points there are dropped singly.
  if (!process.env.WQ_NO_PILEUP) {
    const HOT = 13, cw = Math.ceil(mw / pxPerMm) + 2;
    const hits = new Map();
    const key = (p) => ((p.y / pxPerMm) | 0) * cw + ((p.x / pxPerMm) | 0);
    const kept = [];
    let dropped = 0;
    for (let i = 0; i < stream.length; i++) {
      const s = stream[i];
      if (s.kind === "stitch" && (s.role === "satin" || s.role === "underlay" || s.role === "travel")) {
        const k = key(s), n = hits.get(k) || 0;
        const nx = stream[i + 1], prevK = kept[kept.length - 1];
        if (n >= HOT && prevK && prevK.kind === "stitch" && nx && nx.kind === "stitch" && nx.role === s.role) {
          const skipPair = s.role === "satin";
          const after = skipPair ? stream[i + 2] : nx;
          if (after && after.kind === "stitch" && Math.hypot(after.x - prevK.x, after.y - prevK.y) <= 6.5 * pxPerMm) {
            dropped += skipPair ? 2 : 1; if (skipPair) i++; continue;
          }
        }
      }
      if (s.kind === "stitch") { const k = key(s); hits.set(k, (hits.get(k) || 0) + 1); }
      kept.push(s);
    }
    if (dropped) { stream.length = 0; kept.forEach((s) => stream.push(s)); }
  }
  // ---- clean-up: min 0.3 mm, max 7 mm
  const out = [];
  let last = null;
  stream.forEach((s, i) => {
    if (s.kind !== "stitch") { out.push(s); if (s.kind === "jump") last = { x: s.x, y: s.y }; if (s.kind === "color") last = last; return; }
    if (last) {
      const d = Math.hypot(s.x - last.x, s.y - last.y);
      const nxt = stream[i + 1];
      const keepTie = s.role === "tie" && d >= 3;
      if (d < 3 && !keepTie) { if (!(nxt && nxt.kind !== "stitch")) return; if (d < 1) return; return; }
      if (d > 70) {
        const n = Math.ceil(d / 65);
        for (let k = 1; k < n; k++) out.push({ kind: "stitch", x: Math.round(last.x + (s.x - last.x) * k / n), y: Math.round(last.y + (s.y - last.y) * k / n), obj: s.obj, role: s.role });
      }
    }
    out.push(s); last = { x: s.x, y: s.y };
  });
  if (thinRun) warnings.push({ code: "thin-as-run", count: thinRun, message: thinRun + " details thinner than 1.2 mm sewn as running stitch (too thin for satin)." });
  if (smallText) warnings.push({ code: "small-detail", count: smallText, message: smallText + " shapes are under 5 mm tall (small text/detail) — may not sew legibly at this size; consider enlarging." });
  if (tinyDrop) warnings.push({ code: "tiny-dropped", count: tinyDrop, message: tinyDrop + " shapes under 1 mm² dropped." });
  if (splitSat) warnings.push({ code: "split-satin", count: splitSat, message: splitSat + " columns 7–10 mm wide sewn as split satin." });
  return { stitches: out, threads, objects: objMeta, warnings, textWarnings: prepText, minRecommendedWidthIn, raster: { mw, mh, unitPerPx, pxPerMm }, art };
}

module.exports = {
  hexToRgb, rgbToHex, rgbToLab, dE, rasterize, labelComponents, clusterColours,
  tatami, satinObject, runObject, edgeRun, travelInside, moments, prepareArt, digitizeWQ, isPrepped, underlayRule, _planSatin: planSatin, _spinePaths: spinePaths, _satinColumnsFor: satinColumnsFor, _strokePaths: strokePaths,
};
