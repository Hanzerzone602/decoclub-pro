"use strict";

const { nearestMadeira } = require("../madeira");
const {
  UNIT_PER_IN, layerPolys, rasterSize, rasterizeLayer, blobStats,
  distanceTransform, maxDistance, scalePolys, connectedComponents,
  scaleMask, dilate, erode, floodBackground, orMask, copyMask, andMask,
  contoursWithHoles, polyLength, mooreContour,
} = require("./geom");
const { fabricPreset, applyFabric } = require("./fabric");
const { isPaperHex, parseHexRgb, scalePath } = require("./svgLayers");

const MAX_OBJECTS = 192;
const MIN_COMP_PX = 22;
const DEFAULT_MAX_SIDE = 1400;

function classifyMask(mask, w, h, unitPerPx, opts) {
  const st = blobStats(mask, w, h);
  if (!st) return { type: "empty", stats: null };
  const mmPerPx = unitPerPx * 0.1;
  const minMm = Math.min(st.bw, st.bh) * mmPerPx;
  const maxMm = Math.max(st.bw, st.bh) * mmPerPx;
  const dt = distanceTransform(mask, w, h);
  const maxR = maxDistance(dt, mask, w, h);
  const widthMm = 2 * maxR * mmPerPx;
  const satinMm = opts.satinMm == null ? 2.2 : opts.satinMm;
  const areaMm2 = st.count * mmPerPx * mmPerPx;
  const aspect = maxMm / Math.max(0.01, minMm);
  const fillFrac = st.count / (st.bw * st.bh + 1);
  const outlineLike = fillFrac < 0.38 && widthMm <= 4.2 && areaMm2 > 2.0;
  if (areaMm2 < 0.55 && maxMm < 1.4) return { type: "empty", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac };
  if (maxMm < 1.15 && minMm < 0.55) return { type: "run", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac };
  // Satin is for true columns / outlines. Wide bars (bee stripes, jersey
  // panels) used to classify as satin and sew as a barcode.
  const column = widthMm > 0.28 && widthMm <= 4.0 && aspect > 3.0 && maxMm > 4.0 && areaMm2 < 150 && fillFrac < 0.55;
  const stroke = outlineLike && widthMm > 0.28 && widthMm <= 3.6 && areaMm2 < 160;
  const letter = minMm > 0.32 && minMm <= satinMm && aspect > 2.2 && widthMm <= satinMm * 1.2 && areaMm2 < 36;
  if (column || letter || stroke) {
    return { type: "satin", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac, outlineLike: outlineLike };
  }
  if (areaMm2 > 12) {
    return { type: "tatami", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac, outlineLike: outlineLike };
  }
  if (widthMm > 0.28 && widthMm <= satinMm * 1.15 && maxMm > 1.6 && areaMm2 < 16) {
    return { type: "satin", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac, outlineLike: outlineLike };
  }
  return { type: "tatami", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac, outlineLike: outlineLike };
}

function hexLum(hex) {
  const rgb = parseHexRgb(hex);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function colorDist(a, b) {
  const A = parseHexRgb(a), B = parseHexRgb(b);
  return Math.abs(A[0] - B[0]) + Math.abs(A[1] - B[1]) + Math.abs(A[2] - B[2]);
}

function mergeSimilarLayers(layers) {
  const out = [];
  (layers || []).forEach((L) => {
    const hit = out.find((o) => colorDist(o.hex, L.hex) < 12);
    if (hit) {
      hit.paths = (hit.paths || []).concat(L.paths || []);
    } else {
      out.push({
        hex: L.hex,
        nameGuess: L.nameGuess,
        paths: (L.paths || []).slice(),
        threadHex: L.threadHex,
        madeiraCode: L.madeiraCode,
        madeiraBrand: L.madeiraBrand,
        threadName: L.threadName,
      });
    }
  });
  return out;
}

function threadForLayer(layer, opts) {
  const hex = layer.hex || layer.threadHex || "#111111";
  const catalog = (opts && opts.madeiraCatalog) || "rayon";
  const made = nearestMadeira(hex, catalog);
  if (layer.madeiraCode) {
    return {
      brand: layer.madeiraBrand || (made && made.brand) || "madeira-rayon",
      code: String(layer.madeiraCode),
      name: layer.threadName || layer.nameGuess || (made && made.name) || "Thread",
      hex: layer.threadHex || (made && made.hex) || hex,
      sourceHex: hex,
    };
  }
  return {
    brand: (made && made.brand) || "madeira-rayon",
    code: made && made.code,
    name: (made && made.name) || layer.nameGuess || "Thread",
    hex: hex,
    madeiraHex: made && made.hex,
    sourceHex: hex,
  };
}

function applyThreadSwap(thread, swap, opts) {
  if (!swap) return thread;
  if (!(swap.hex || swap.code)) return thread;
  const made = swap.code ? null : nearestMadeira(swap.hex, (opts && opts.madeiraCatalog) || "rayon");
  if (swap.code) {
    thread.code = String(swap.code);
    if (swap.hex) thread.hex = swap.hex;
    if (swap.name) thread.name = swap.name;
    if (swap.brand) thread.brand = swap.brand;
  } else if (made) {
    thread.brand = made.brand;
    thread.code = made.code;
    thread.name = made.name;
    thread.hex = made.hex;
  } else if (swap.hex) {
    thread.hex = swap.hex;
  }
  return thread;
}

function splitMixedWidth(comp, mw, mh, unitPerPx, satinMm) {
  const mask = comp.mask;
  const st = blobStats(mask, mw, mh);
  if (!st || st.count < 500) return [comp];
  const fillFrac = st.count / (st.bw * st.bh + 1);
  if (fillFrac > 0.7) return [comp];
  const dt = distanceTransform(mask, mw, mh);
  const maxR = maxDistance(dt, mask, mw, mh);
  const mmPerPx = unitPerPx * 0.1;
  const widthMm = 2 * maxR * mmPerPx;
  // Thin cartoon outlines (Tony face) sit near satinMm at junctions.
  // Only split when a real thick core exists (bee stripes on an outline).
  if (widthMm < satinMm * 1.12) return [comp];
  const thickR = Math.max(2, ((satinMm * 0.9) * 10) / unitPerPx / 2);
  const core = new Uint8Array(mask.length);
  let cn = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && dt[i] >= thickR) { core[i] = 1; cn++; }
  }
  if (cn < 80) return [comp];
  const thick = dilate(core, mw, mh, Math.ceil(thickR));
  const thin = new Uint8Array(mask.length);
  let tn = 0, kn = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) { thick[i] = 0; continue; }
    if (thick[i]) kn++;
    else { thin[i] = 1; tn++; }
  }
  if (kn < 80 || tn < 80) return [comp];
  const thickComps = connectedComponents(thick, mw, mh, 36);
  const thinComps = connectedComponents(thin, mw, mh, 36);
  const out = thickComps.concat(thinComps);
  return out.length ? out : [comp];
}

function layerCoverage(mask, w, h) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n / (w * h || 1);
}

function countOn(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/**
 * Nearest-layer assignment of the source raster. Clips evenodd hull bays
 * (background) and restores graphic interiors (paw toes) the tracer mashed.
 */
function sourceMaskForHex(rgba, sw, sh, mw, mh, hex, allHexes) {
  const target = parseHexRgb(hex);
  const others = (allHexes || [hex]).map(parseHexRgb);
  const out = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / mh));
    for (let x = 0; x < mw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / mw));
      const i = (sy * sw + sx) * 4;
      if (rgba[i + 3] < 18) continue;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const span = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum > 242 && span < 22) continue;
      let bestD = Infinity, bestK = -1;
      for (let k = 0; k < others.length; k++) {
        const d = Math.abs(others[k][0] - r) + Math.abs(others[k][1] - g) + Math.abs(others[k][2] - b);
        if (d < bestD) { bestD = d; bestK = k; }
      }
      const td = Math.abs(target[0] - r) + Math.abs(target[1] - g) + Math.abs(target[2] - b);
      // Must actually match this hex — nearest-of-few-layers would map
      // Tony's cream chest onto orange and fill the white hole.
      if (td > 96) continue;
      if (bestK >= 0 && td <= bestD + 6) out[y * mw + x] = 1;
    }
  }
  return out;
}

function andCount(a, b) {
  const n = Math.min(a.length, b.length);
  let k = 0;
  for (let i = 0; i < n; i++) if (a[i] && b[i]) k++;
  return k;
}

/**
 * Punch pixels that clearly belong to a different layer in the source
 * (jersey purple in a gold paw blob). Then restore source blobs of THIS
 * hex that touch the remaining vector (bee stripes chord-kill dropped).
 * Unassigned pixels (Tony cream chest vs 4 vector colors) stay as vector.
 */
function punchForeignFromSource(mask, mw, mh, rgba, sw, sh, hex, allHexes) {
  const target = parseHexRgb(hex);
  const others = (allHexes || []).map(parseHexRgb).filter((o) => {
    return Math.abs(o[0] - target[0]) + Math.abs(o[1] - target[1]) + Math.abs(o[2] - target[2]) >= 12;
  });
  if (!others.length) return mask;
  const out = copyMask(mask);
  let drop = 0, keep = 0;
  for (let y = 0; y < mh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / mh));
    for (let x = 0; x < mw; x++) {
      const i = y * mw + x;
      if (!mask[i]) continue;
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / mw));
      const p = (sy * sw + sx) * 4;
      if (rgba[p + 3] < 18) { out[i] = 0; drop++; continue; }
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const span = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum > 238 && span < 28) { keep++; continue; }
      const td = Math.abs(target[0] - r) + Math.abs(target[1] - g) + Math.abs(target[2] - b);
      let bestO = Infinity;
      for (let k = 0; k < others.length; k++) {
        const d = Math.abs(others[k][0] - r) + Math.abs(others[k][1] - g) + Math.abs(others[k][2] - b);
        if (d < bestO) bestO = d;
      }
      if (bestO < 90 && bestO + 12 < td) { out[i] = 0; drop++; }
      else keep++;
    }
  }
  const n = drop + keep;
  if (keep < 24) return mask;
  if (n > 0 && drop / n > 0.50) return mask;
  return out;
}

function refineMaskFromSource(mask, mw, mh, rgba, sw, sh, hex, allHexes) {
  if (!rgba || sw < 4 || sh < 4) return mask;
  const vecN = countOn(mask);
  if (vecN < 24) return mask;
  const punched = punchForeignFromSource(mask, mw, mh, rgba, sw, sh, hex, allHexes);
  const src = sourceMaskForHex(rgba, sw, sh, mw, mh, hex, allHexes);
  const srcN = countOn(src);
  if (srcN < 24) return punched;
  const base = punched;
  const dilated = dilate(base, mw, mh, 5);
  const srcComps = connectedComponents(src, mw, mh, 24);
  const out = copyMask(base);
  srcComps.forEach((c) => {
    if (andCount(c.mask, dilated) < 10) return;
    orMask(out, c.mask);
  });
  const on = countOn(out);
  if (on < 24) return mask;
  if (on > vecN * 4.5) return base;
  return out;
}

function holeLooksLikeInk(comp, mw, mh, rgba, sw, sh) {
  if (!rgba || sw < 4 || sh < 4 || !comp || !comp.mask) return false;
  let dark = 0, light = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(comp.count || 64) / 28));
  for (let y = 0; y < mh; y += step) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / mh));
    for (let x = 0; x < mw; x += step) {
      if (!comp.mask[y * mw + x]) continue;
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / mw));
      const i = (sy * sw + sx) * 4;
      if (rgba[i + 3] < 18) continue;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
      if (lum < 72) dark++;
      else if (lum > 200) light++;
    }
  }
  if (n < 8) return false;
  return dark > n * 0.40 && dark > light;
}

function morphOpen(mask, w, h, r) {
  return dilate(erode(mask, w, h, r), w, h, r);
}

function morphClose(mask, w, h, r) {
  return erode(dilate(mask, w, h, r), w, h, r);
}

function bboxOfMask(mask, w, h) {
  let minX = w, minY = h, maxX = 0, maxY = 0, n = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      n++;
      sx += x; sy += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!n) return null;
  return {
    count: n, minX: minX, minY: minY, maxX: maxX, maxY: maxY,
    bw: maxX - minX + 1, bh: maxY - minY + 1, cx: sx / n, cy: sy / n,
  };
}

function nearTouch(a, b, w, h, dilPx) {
  const p = dilPx || 0;
  if (a.maxX == null || b.maxX == null) return andCount(a.mask, b.mask) >= 4;
  if (a.maxX + p < b.minX || b.maxX + p < a.minX || a.maxY + p < b.minY || b.maxY + p < a.minY) return false;
  const src = (a.count || 0) <= (b.count || 0) ? a : b;
  const dst = src === a ? b : a;
  const r = p;
  for (let y = src.minY; y <= src.maxY; y++) {
    for (let x = src.minX; x <= src.maxX; x++) {
      if (!src.mask[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (dst.mask[ny * w + nx]) return true;
        }
      }
    }
  }
  return false;
}

/** Join tiny outline crumbs onto a touching neighbor. Never fuse two large outlines. */
function coalesceTouching(comps, w, h, dilPx, mmPerPx) {
  if (!comps || comps.length < 2) return comps || [];
  const n = comps.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  }
  const bbs = comps.map((c) => {
    if (c.minX != null && c.maxX != null) return c;
    const bb = bboxOfMask(c.mask, w, h);
    return bb ? Object.assign({}, c, bb) : c;
  });
  const area = bbs.map((c) => (c.count || 0) * (mmPerPx || 0.05) * (mmPerPx || 0.05));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const bothLarge = area[i] >= 22 && area[j] >= 22;
      const p = bothLarge ? Math.min(dilPx, 2) : dilPx;
      if (nearTouch(bbs[i], bbs[j], w, h, p)) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(comps[i]);
  }
  const out = [];
  groups.forEach((g) => {
    if (g.length === 1) { out.push(g[0]); return; }
    const mask = copyMask(g[0].mask);
    for (let k = 1; k < g.length; k++) orMask(mask, g[k].mask);
    const bb = bboxOfMask(mask, w, h);
    out.push({
      mask: mask,
      count: bb ? bb.count : countOn(mask),
      cx: bb ? bb.cx : 0,
      cy: bb ? bb.cy : 0,
      minX: bb && bb.minX, minY: bb && bb.minY,
      maxX: bb && bb.maxX, maxY: bb && bb.maxY,
      bw: bb && bb.bw, bh: bb && bb.bh,
    });
  });
  return out;
}

/**
 * Separate a compact multi-lobe fill (jersey paw) into readable pads.
 * If opening does not yield 3–6 similar islands, leave the vector as-is.
 */
/**
 * Branching cartoon outlines (Tony face) have many tiny holes. Filling
 * them and keeping a constant-width outer band sews one contour column
 * instead of a nest of short satins. Real rings (bee) have a few large
 * holes and are left alone for contour-rail satin.
 */
function silhouetteBandIfBranching(comp, w, h, mmPerPx) {
  const mask = comp.mask;
  const st = blobStats(mask, w, h);
  if (!st || st.count < 80) return [comp];
  const ff = st.count / (st.bw * st.bh + 1);
  const areaMm2 = st.count * mmPerPx * mmPerPx;
  if (ff > 0.30 || areaMm2 < 14) return [comp];
  const closeR = Math.max(2, Math.round(0.32 / mmPerPx));
  const closed = morphClose(mask, w, h, closeR);
  const n0 = countOn(mask), n1 = countOn(closed);
  const probe = (n0 > 40 && n1 >= n0 && n1 <= n0 * 1.14) ? closed : mask;
  const rings = contoursWithHoles(probe, w, h, 10);
  if (!rings.length) return [comp];
  const outerL = rings.reduce((n, r) => n + polyLength(r.outer || []), 0);
  const holes = [];
  rings.forEach((r) => (r.holes || []).forEach((hp) => holes.push(hp)));
  const big = holes.filter((hp) => polyLength(hp) * mmPerPx > 8.0).length;
  const tiny = holes.length - big;
  // Real rings (bee) have several large holes — leave them for contour-rail.
  if (big >= 2) return [comp];
  const leaked = holes.length === 0 && ff < 0.22 && areaMm2 > 18;
  if (!(tiny >= 2 && big <= 1) && !leaked) return [comp];
  const src = leaked ? probe : mask;
  const bg = floodBackground(src, w, h);
  const filled = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (src[i] || !bg[i]) filled[i] = 1;
  }
  const filledN = countOn(filled);
  // Filling did not capture interior (gaps still leak to the border).
  if (filledN < st.count * 1.15) return [comp];
  const bandPx = Math.max(2, Math.round(0.92 / mmPerPx));
  const inner = erode(filled, w, h, bandPx);
  const band = new Uint8Array(mask.length);
  let bn = 0;
  for (let i = 0; i < mask.length; i++) {
    if (filled[i] && !inner[i]) { band[i] = 1; bn++; }
  }
  if (bn < 80) return [comp];
  const bb = bboxOfMask(band, w, h);
  const out = [{
    mask: band,
    count: bn,
    cx: bb ? bb.cx : comp.cx,
    cy: bb ? bb.cy : comp.cy,
    minX: bb && bb.minX, minY: bb && bb.minY,
    maxX: bb && bb.maxX, maxY: bb && bb.maxY,
    bw: bb && bb.bw, bh: bb && bb.bh,
  }];
  const leftover = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && !band[i] && inner[i]) leftover[i] = 1;
  }
  const minPix = Math.max(36, Math.round(4.5 / (mmPerPx * mmPerPx)));
  connectedComponents(leftover, w, h, minPix).forEach((p) => {
    const a = p.count * mmPerPx * mmPerPx;
    if (a < 6.0) return;
    const pst = blobStats(p.mask, w, h);
    const pff = pst ? pst.count / (pst.bw * pst.bh + 1) : 0;
    const pr = contoursWithHoles(p.mask, w, h, 10);
    let ph = 0;
    pr.forEach((r) => { ph += (r.holes || []).length; });
    // Keep a real interior ring (eye). Drop branching twigs that scribble.
    if (ph < 1 && pff < 0.30) return;
    out.push(p);
  });
  return out;
}

function convexHull(pts) {
  const p = (pts || []).slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (let i = 0; i < p.length; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
    lower.push(p[i]);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
    upper.push(p[i]);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function convexifyPad(mask, w, h) {
  const outer = mooreContour(mask, w, h);
  if (!outer || outer.length < 8) return mask;
  const hull = convexHull(outer);
  if (hull.length < 4) return mask;
  const filled = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const ys = y + 0.5;
    const xs = [];
    for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
      const yi = hull[i].y, yj = hull[j].y;
      if ((yi > ys) === (yj > ys)) continue;
      const xi = hull[i].x, xj = hull[j].x;
      xs.push(xi + (xj - xi) * (ys - yi) / ((yj - yi) || 1e-9));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = y * w;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(xs[k])));
      const x1 = Math.max(0, Math.min(w - 1, Math.ceil(xs[k + 1])));
      for (let x = x0; x <= x1; x++) filled[row + x] = 1;
    }
  }
  const n0 = countOn(mask), n1 = countOn(filled);
  if (n1 < 24 || n1 > n0 * 1.55) return mask;
  return filled;
}

function splitLobes(comp, w, h, unitPerPx) {
  const mask = comp.mask;
  const st = blobStats(mask, w, h);
  if (!st || st.count < 90) return [comp];
  const fillFrac = st.count / (st.bw * st.bh + 1);
  const aspect = Math.max(st.bw, st.bh) / Math.max(1, Math.min(st.bw, st.bh));
  if (fillFrac < 0.28 || fillFrac > 0.90) return [comp];
  if (aspect > 2.6) return [comp];
  const mmPerPx = unitPerPx * 0.1;
  const areaMm2 = st.count * mmPerPx * mmPerPx;
  if (areaMm2 < 10 || areaMm2 > 160) return [comp];
  const closeR = Math.max(2, Math.min(6, Math.round(Math.min(st.bw, st.bh) * 0.055)));
  const healed = morphClose(mask, w, h, closeR);
  const r0 = Math.max(2, Math.min(8, Math.round(Math.min(st.bw, st.bh) * 0.07)));
  const minPart = Math.max(28, Math.round(st.count * 0.05));
  let best = null;
  for (let dr = -1; dr <= 4; dr++) {
    const r = r0 + dr;
    if (r < 2) continue;
    const opened = morphOpen(healed, w, h, r);
    const parts = connectedComponents(opened, w, h, minPart);
    if (parts.length < 3 || parts.length > 6) continue;
    const sizes = parts.map((p) => p.count).sort((a, b) => b - a);
    if (sizes[0] > sizes[sizes.length - 1] * 5.5) continue;
    const score = (parts.length === 4 || parts.length === 5) ? 2 : 1;
    if (!best || score > best.score || (score === best.score && parts.length > best.parts.length)) {
      best = { r: r, parts: parts, score: score };
    }
    if (parts.length === 4 || parts.length === 5) break;
  }
  if (!best) return [comp];
  const grow = Math.max(1, best.r - 1);
  const out = [];
  best.parts.forEach((p) => {
    let fat = andMask(dilate(p.mask, w, h, grow), healed);
    fat = morphClose(fat, w, h, 2);
    fat = convexifyPad(fat, w, h);
    const n = countOn(fat);
    if (n < minPart) return;
    const bb = bboxOfMask(fat, w, h);
    out.push({
      mask: fat,
      count: n,
      cx: bb ? bb.cx : p.cx,
      cy: bb ? bb.cy : p.cy,
      minX: bb && bb.minX, minY: bb && bb.minY,
      maxX: bb && bb.maxX, maxY: bb && bb.maxY,
      bw: bb && bb.bw, bh: bb && bb.bh,
    });
  });
  return out.length >= 3 ? out : [comp];
}

function clipPaperFromSource(mask, mw, mh, rgba, sw, sh) {
  if (!rgba || sw < 4 || sh < 4) return mask;
  for (let y = 0; y < mh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / mh));
    for (let x = 0; x < mw; x++) {
      if (!mask[y * mw + x]) continue;
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / mw));
      const i = (sy * sw + sx) * 4;
      if (rgba[i + 3] < 18) { mask[y * mw + x] = 0; continue; }
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const span = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum > 238 && span < 28) mask[y * mw + x] = 0;
    }
  }
  return mask;
}

function nearestUnused(g, used, last) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < g.length; i++) {
    if (used[i]) continue;
    if (!last) return i;
    const dx = (g[i].cx || 0) - last.cx, dy = (g[i].cy || 0) - last.cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function sequenceByColor(list) {
  const groups = [];
  const index = new Map();
  list.forEach((o) => {
    const key = String((o.thread && o.thread.code) || "") + "|" + String((o.thread && o.thread.hex) || "");
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push([]);
    }
    groups[index.get(key)].push(o);
  });
  groups.sort((A, B) => {
    const la = Math.min.apply(null, A.map((o) => o.layerIndex || 0));
    const lb = Math.min.apply(null, B.map((o) => o.layerIndex || 0));
    return la - lb;
  });
  const out = [];
  groups.forEach((g) => {
    g.sort((a, b) => (b.areaMm2 || 0) - (a.areaMm2 || 0));
    const used = new Uint8Array(g.length);
    let last = null;
    for (let n = 0; n < g.length; n++) {
      const best = nearestUnused(g, used, last);
      if (best < 0) break;
      used[best] = 1;
      out.push(g[best]);
      last = g[best];
    }
  });
  return out;
}

function sequenceObjects(objects) {
  if (!objects.length) return objects;
  const fills = objects.filter((o) => o.type === "tatami");
  const rest = objects.filter((o) => o.type !== "tatami");
  return sequenceByColor(fills).concat(sequenceByColor(rest));
}

function makeObject(comp, hint, type, L, li, ci, polys, paths, rs, mmPerPx, densityMm, satinMm, fabric, opts) {
  const override = (opts.typeOverrides || []).find((o) => Number(o.layerIndex) === li);
  if (override && override.type) type = override.type;
  const thread = applyThreadSwap(threadForLayer(L, opts), (opts.threads || []).find((t) => Number(t.layerIndex) === li), opts);
  let angleDeg = opts.angleDeg == null ? 45 : Number(opts.angleDeg);
  if (opts.angleDeg == null && hint.stats) {
    if (hint.stats.bw > hint.stats.bh * 2.5) angleDeg = 90;
    else if (hint.stats.bh > hint.stats.bw * 2.5) angleDeg = 0;
    else {
      const hsh = Math.abs((Math.round(comp.cx || 0) * 13 + Math.round(comp.cy || 0) * 31) | 0);
      angleDeg = [25, 45, 70, 110, 135, 155][hsh % 6];
    }
  }
  const ff = hint.fillFrac == null ? 1 : hint.fillFrac;
  const outlineLike = !!(hint.outlineLike) || (type === "satin" && ff < 0.42);
  const thinFill = type === "tatami" && ((hint.widthMm || 99) < 18 || (hint.areaMm2 || 0) < 320);
  let params = {
    densityMm: densityMm,
    stitchMm: type === "run" ? 2.4 : 3.15,
    angleDeg: angleDeg,
    satinSpacingMm: opts.satinSpacingMm == null ? (outlineLike ? 0.32 : 0.38) : Number(opts.satinSpacingMm),
    pullMm: type === "satin" ? (outlineLike ? 0.10 : 0.16) : 0.14,
    underlay: type === "satin" ? (outlineLike ? ["edge-run"] : ["edge-run", "zigzag"]) : (thinFill ? ["edge-run"] : ["edge-run", "lattice"]),
    satinMm: satinMm,
    outlineLike: outlineLike,
  };
  params = applyFabric(params, type, fabric);
  if (outlineLike) {
    params.pullMm = Math.min(params.pullMm || 0.2, 0.12);
    if (opts.satinSpacingMm == null) params.satinSpacingMm = 0.34;
  }
  if (thinFill && params.underlay) {
    params.underlay = params.underlay.filter((u) => u !== "lattice");
    if (params.underlay.indexOf("edge-run") < 0) params.underlay.unshift("edge-run");
  }
  return {
    id: "obj-" + li + "-" + ci,
    layerIndex: li,
    type: type,
    polys: polys,
    paths: paths,
    mask: comp.mask,
    maskW: rs.mw,
    maskH: rs.mh,
    thread: thread,
    params: params,
    sourceWidthIn: opts._wIn,
    sourceHeightIn: opts._hIn,
    widthMm: hint.widthMm,
    areaMm2: hint.areaMm2 || 0,
    fillFrac: hint.fillFrac || 0,
    cx: (comp.cx || 0) * mmPerPx,
    cy: (comp.cy || 0) * mmPerPx,
  };
}

function capObjects(objects, max) {
  if (objects.length <= max) return objects;
  const kept = [];
  const seen = new Set();
  const keyOf = (o) => String((o.thread && o.thread.code) || "") + "|" + String((o.thread && o.thread.hex) || "");
  objects.forEach((o) => {
    const k = keyOf(o);
    if (seen.has(k)) return;
    seen.add(k);
    kept.push(o);
  });
  objects.forEach((o) => {
    if (kept.length >= max) return;
    if (kept.indexOf(o) < 0) kept.push(o);
  });
  return kept.slice(0, max);
}

function addInteriorWhite(objects, rs, mmPerPx, densityMm, satinMm, fabric, opts) {
  if (!objects.length) return;
  const occupied = new Uint8Array(rs.mw * rs.mh);
  objects.forEach((o) => {
    if (!o.mask) return;
    orMask(occupied, o.mask);
  });
  const bg = floodBackground(occupied, rs.mw, rs.mh);
  const holes = new Uint8Array(occupied.length);
  for (let i = 0; i < holes.length; i++) {
    if (!occupied[i] && !bg[i]) holes[i] = 1;
  }
  const minPix = Math.max(36, Math.round(2.4 / (mmPerPx * mmPerPx)));
  const comps = connectedComponents(holes, rs.mw, rs.mh, minPix);
  const whiteThread = threadForLayer({ hex: "#e3e5fb", nameGuess: "White" }, opts);
  comps.forEach((comp, ci) => {
    const hint = classifyMask(comp.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
    if (hint.type === "empty") return;
    if ((hint.areaMm2 || 0) < 4.0) return;
    if ((hint.fillFrac || 0) < 0.18) return;
    if (holeLooksLikeInk(comp, rs.mw, rs.mh, opts.sourceRgba, opts.sourceW || 0, opts.sourceH || 0)) return;
    const type = (hint.type === "run") ? "tatami" : (hint.widthMm <= 2.4 && hint.type === "satin" ? "satin" : "tatami");
    const obj = makeObject(
      comp, hint, type,
      { hex: "#e3e5fb", nameGuess: "White" },
      900, ci, [], [], rs, mmPerPx, densityMm, satinMm, fabric,
      Object.assign({}, opts, { _wIn: opts._wIn, _hIn: opts._hIn })
    );
    obj.thread = whiteThread;
    obj.id = "obj-white-" + ci;
    obj.interiorWhite = true;
    objects.push(obj);
  });
}

function buildObjects(layers, widthIn, heightIn, opts) {
  opts = opts || {};
  const wIn = Number(widthIn) || 1;
  const hIn = Number(heightIn) || 1;
  opts._wIn = wIn;
  opts._hIn = hIn;
  const rs = rasterSize(wIn, hIn, opts.maxSide || DEFAULT_MAX_SIDE);
  const densityMm = opts.density == null ? 0.4 : Number(opts.density);
  const satinMm = opts.satinMm == null ? 2.2 : Number(opts.satinMm);
  const fabric = fabricPreset(opts.fabric);
  const mmPerPx = rs.unitPerPx * 0.1;
  const minPix = Math.max(MIN_COMP_PX, Math.round(1.1 / (mmPerPx * mmPerPx)));
  const objects = [];
  const merged = mergeSimilarLayers(layers || []);
  const srcRgba = opts.sourceRgba;
  const srcW = opts.sourceW || 0;
  const srcH = opts.sourceH || 0;
  const allHexes = merged.map((L) => L.hex || L.threadHex).filter(Boolean);
  merged.forEach((L, li) => {
    const hex = L.hex || L.threadHex;
    let mask = rasterizeLayer(L, wIn, hIn, rs.mw, rs.mh);
    if (srcRgba && srcW > 4) {
      const before = countOn(mask);
      const clipped = clipPaperFromSource(Uint8Array.from(mask), rs.mw, rs.mh, srcRgba, srcW, srcH);
      const after = countOn(clipped);
      if (before > 40 && after > before * 0.62) mask = clipped;
      mask = refineMaskFromSource(mask, rs.mw, rs.mh, srcRgba, srcW, srcH, hex, allHexes);
    }
    const cov = layerCoverage(mask, rs.mw, rs.mh);
    if (cov > 0.55 && isPaperHex(hex)) return;
    if (cov > 0.78 && hexLum(hex) > 220) return;
    let nOn = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) nOn++;
    if (nOn < minPix) return;
    const polys = layerPolys(L, wIn, hIn);
    const paths = (L.paths || []).slice();
    const comps = connectedComponents(mask, rs.mw, rs.mh, minPix);
    const split = [];
    (comps.length ? comps : [{ mask: mask, count: nOn, cx: rs.mw / 2, cy: rs.mh / 2 }]).forEach((c) => {
      splitMixedWidth(c, rs.mw, rs.mh, rs.unitPerPx, satinMm).forEach((p) => split.push(p));
    });
    const pieces = split.length ? split : [{ mask: mask, count: nOn, cx: rs.mw / 2, cy: rs.mh / 2 }];
    const prepared = [];
    pieces.forEach((comp) => {
      const hint = classifyMask(comp.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
      if (hint.type === "empty") return;
      if ((hint.areaMm2 || 0) < 1.2 && (hint.widthMm || 0) < 0.7) return;
      const bboxFrac0 = hint.stats ? (hint.stats.bw * hint.stats.bh) / (rs.mw * rs.mh) : 0;
      if (hexLum(hex) > 90 && hint.outlineLike && bboxFrac0 > 0.25 && (hint.fillFrac || 0) < 0.25) {
        return;
      }
      prepared.push({ comp: comp, hint: hint });
    });
    const outlineComps = [];
    const restPrepared = [];
    prepared.forEach((p) => {
      if (p.hint.outlineLike && p.hint.type === "satin") outlineComps.push(p.comp);
      else restPrepared.push(p);
    });
    const gapPx = Math.max(2, Math.min(6, Math.round(0.55 / mmPerPx)));
    const mergedOutlines = [];
    coalesceTouching(outlineComps, rs.mw, rs.mh, gapPx, mmPerPx).forEach((c) => {
      silhouetteBandIfBranching(c, rs.mw, rs.mh, mmPerPx).forEach((piece) => {
        const hint = classifyMask(piece.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
        hint.outlineLike = true;
        if (hint.type !== "run") hint.type = "satin";
        mergedOutlines.push({ comp: piece, hint: hint });
      });
    });
    const allPrep = restPrepared.concat(mergedOutlines);
    let ci = 0;
    allPrep.forEach((p) => {
      let chunks = [p.comp];
      if (p.hint.type === "tatami" && !p.hint.outlineLike) {
        chunks = splitLobes(p.comp, rs.mw, rs.mh, rs.unitPerPx);
      }
      chunks.forEach((comp) => {
        let work = comp;
        let hint = chunks.length === 1 ? p.hint : classifyMask(work.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
        if (hint.type === "empty") return;
        if (hint.type === "tatami" && !hint.outlineLike && hint.stats) {
          const ast = hint.stats;
          const aspect = Math.max(ast.bw, ast.bh) / Math.max(1, Math.min(ast.bw, ast.bh));
          if (aspect < 1.9 && (hint.fillFrac || 0) > 0.45 && (hint.areaMm2 || 0) >= 8 && (hint.areaMm2 || 0) <= 55) {
            const healed = morphClose(work.mask, rs.mw, rs.mh, 2);
            const cvx = convexifyPad(healed, rs.mw, rs.mh);
            work = Object.assign({}, work, { mask: cvx, count: countOn(cvx) });
            hint = classifyMask(work.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
          }
        }
        if (hint.type === "satin" && ((hint.fillFrac || 1) < 0.45 || hint.outlineLike)) {
          const maxMm = hint.stats ? Math.max(hint.stats.bw, hint.stats.bh) * mmPerPx : 0;
          if ((hint.areaMm2 || 0) < 4.8 && maxMm < 12.0) return;
          const targetMm = 0.95;
          const growMm = (targetMm - (hint.widthMm || 0)) / 2;
          if (growMm > 0.06 && (hint.areaMm2 || 0) >= 8.0) {
            const dilPx = Math.max(1, Math.round(Math.min(0.36, growMm) / mmPerPx));
            const fattened = dilate(work.mask, rs.mw, rs.mh, dilPx);
            work = Object.assign({}, work, { mask: fattened });
            hint = classifyMask(work.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
            hint.outlineLike = true;
          }
        }
        if (hint.type === "empty") return;
        const bboxFrac = hint.stats ? (hint.stats.bw * hint.stats.bh) / (rs.mw * rs.mh) : 0;
        if (hexLum(hex) > 90 && hint.outlineLike && bboxFrac > 0.32 && (hint.fillFrac || 0) < 0.22 && (hint.areaMm2 || 0) < 140) {
          return;
        }
        objects.push(makeObject(work, hint, hint.type, L, li, ci, polys, paths, rs, mmPerPx, densityMm, satinMm, fabric, opts));
        ci++;
      });
    });
  });
  addInteriorWhite(objects, rs, mmPerPx, densityMm, satinMm, fabric, opts);
  objects.sort((a, b) => (b.areaMm2 || 0) - (a.areaMm2 || 0));
  const kept = capObjects(objects, opts.maxObjects || MAX_OBJECTS);
  const sequenced = sequenceObjects(kept);
  return {
    objects: sequenced,
    sourceWidthIn: wIn,
    sourceHeightIn: hIn,
    raster: { mw: rs.mw, mh: rs.mh, unitPerPx: rs.unitPerPx },
    fabric: fabric ? fabric.id : null,
  };
}

function objectsAtSize(pack, widthIn, heightIn) {
  const wIn = Number(widthIn) || pack.sourceWidthIn || 1;
  const hIn = Number(heightIn) || pack.sourceHeightIn || 1;
  const sx = wIn / (pack.sourceWidthIn || wIn);
  const sy = hIn / (pack.sourceHeightIn || hIn);
  return {
    objects: (pack.objects || []).map((o) => {
      const next = Object.assign({}, o, {
        polys: scalePolys(o.polys, sx, sy),
        paths: (o.paths || []).map((p) => ({
          d: scalePath(p.d, sx, sy, 0, 0),
          hole: p.hole,
          fillRule: p.fillRule,
        })),
        cx: (o.cx || 0) * sx,
        cy: (o.cy || 0) * sy,
        areaMm2: (o.areaMm2 || 0) * sx * sy,
        sourceWidthIn: wIn,
        sourceHeightIn: hIn,
      });
      return next;
    }),
    sourceWidthIn: wIn,
    sourceHeightIn: hIn,
    raster: pack.raster,
    fabric: pack.fabric,
  };
}

function scaledMaskFor(obj, mw, mh) {
  if (!obj.mask || !obj.maskW) return null;
  return scaleMask(obj.mask, obj.maskW, obj.maskH, mw, mh);
}

module.exports = {
  buildObjects,
  objectsAtSize,
  classifyMask,
  threadForLayer,
  sequenceObjects,
  scaledMaskFor,
  MAX_OBJECTS,
  UNIT_PER_IN,
};
