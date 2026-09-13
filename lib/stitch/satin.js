"use strict";

const {
  blobStats, resamplePolyline, smoothPolyline, tangentAt,
  distanceTransform, zhangSuenThin, traceSkeleton, polyLength,
  contoursWithHoles, erode, dilate, floodBackground, connectedComponents,
  andMask, mooreContour,
} = require("./geom");
const { contourRun } = require("./run");

function sampleDt(dt, w, h, x, y) {
  const xi = Math.max(0, Math.min(w - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(h - 1, Math.round(y)));
  return dt[yi * w + xi];
}

function fallbackCenterline(mask, w, h) {
  const st = blobStats(mask, w, h);
  if (!st) return [];
  const horiz = st.bw >= st.bh;
  const line = [];
  if (horiz) {
    for (let x = st.minX; x <= st.maxX; x++) {
      let y0 = -1, y1 = -1;
      for (let y = st.minY; y <= st.maxY; y++) {
        if (mask[y * w + x]) { if (y0 < 0) y0 = y; y1 = y; }
      }
      if (y0 >= 0) line.push({ x: x, y: (y0 + y1) / 2 });
    }
  } else {
    for (let y = st.minY; y <= st.maxY; y++) {
      let x0 = -1, x1 = -1;
      for (let x = st.minX; x <= st.maxX; x++) {
        if (mask[y * w + x]) { if (x0 < 0) x0 = x; x1 = x; }
      }
      if (x0 >= 0) line.push({ x: (x0 + x1) / 2, y: y });
    }
  }
  return line;
}

function centerlinesFromMask(mask, w, h) {
  const st = blobStats(mask, w, h);
  const aspect = st ? Math.max(st.bw, st.bh) / Math.max(1, Math.min(st.bw, st.bh)) : 1;
  const fillFrac = st ? st.count / (st.bw * st.bh + 1) : 1;
  if (st && aspect > 2.8 && fillFrac > 0.28) {
    const line = fallbackCenterline(mask, w, h);
    if (line.length >= 3) return [smoothPolyline(line, 5)];
  }
  const skel = zhangSuenThin(mask, w, h);
  let paths = traceSkeleton(skel, w, h);
  const minLen = Math.max(8, Math.min(w, h) * 0.022);
  paths = (paths || []).filter((p) => p.length >= 3 && polyLength(p) >= minLen);
  paths.sort((a, b) => polyLength(b) - polyLength(a));
  if (!paths.length) {
    const line = fallbackCenterline(mask, w, h);
    return line.length >= 3 ? [smoothPolyline(line, 5)] : [];
  }
  return paths.slice(0, 18).map((p) => smoothPolyline(p, 6));
}

function centerlineFromMask(mask, w, h, dt) {
  const lines = centerlinesFromMask(mask, w, h);
  return lines[0] || [];
}

function insideMask(mask, w, h, x, y) {
  const xi = Math.round(x), yi = Math.round(y);
  return xi >= 0 && yi >= 0 && xi < w && yi < h && mask[yi * w + xi];
}

function clampEnd(mask, w, h, cx, cy, ax, ay) {
  if (insideMask(mask, w, h, ax, ay)) return { x: ax, y: ay };
  let lo = 0, hi = 1;
  for (let i = 0; i < 10; i++) {
    const m = (lo + hi) / 2;
    const x = cx + (ax - cx) * m, y = cy + (ay - cy) * m;
    if (insideMask(mask, w, h, x, y)) lo = m;
    else hi = m;
  }
  return { x: cx + (ax - cx) * lo, y: cy + (ay - cy) * lo };
}

function columnsFromCenter(center, dt, w, h, spacing, pull, mask, minHalf) {
  const samples = resamplePolyline(center, Math.max(0.55, spacing), false);
  if (samples.length < 2) return [];
  const raw = [];
  for (let i = 0; i < samples.length; i++) {
    const t = tangentAt(samples, i);
    const nx = -t.y, ny = t.x;
    const half = sampleDt(dt, w, h, samples[i].x, samples[i].y) + pull;
    raw.push(Math.max(minHalf || 0.9, Math.min(half, 36)));
  }
  const halves = raw.slice();
  for (let i = 1; i < halves.length - 1; i++) {
    halves[i] = raw[i] * 0.5 + raw[i - 1] * 0.25 + raw[i + 1] * 0.25;
  }
  const columns = [];
  for (let i = 0; i < samples.length; i++) {
    const t = tangentAt(samples, i);
    const nx = -t.y, ny = t.x;
    const halfClamped = halves[i];
    let ax = samples[i].x + nx * halfClamped, ay = samples[i].y + ny * halfClamped;
    let bx = samples[i].x - nx * halfClamped, by = samples[i].y - ny * halfClamped;
    if (mask) {
      const a = clampEnd(mask, w, h, samples[i].x, samples[i].y, ax, ay);
      const b = clampEnd(mask, w, h, samples[i].x, samples[i].y, bx, by);
      ax = a.x; ay = a.y; bx = b.x; by = b.y;
    }
    columns.push({
      x: samples[i].x, y: samples[i].y,
      ax: ax, ay: ay, bx: bx, by: by,
    });
  }
  return columns;
}

function dtInward(dt, w, h, x, y, fallback) {
  const gx = sampleDt(dt, w, h, x + 1, y) - sampleDt(dt, w, h, x - 1, y);
  const gy = sampleDt(dt, w, h, x, y + 1) - sampleDt(dt, w, h, x, y - 1);
  const len = Math.hypot(gx, gy);
  if (len < 0.12) return fallback;
  return { x: gx / len, y: gy / len };
}

function inwardNormal(samples, i, mask, w, h, dt) {
  const t = tangentAt(samples, i);
  const nx = -t.y, ny = t.x;
  const p = samples[i];
  const fromDt = dt ? dtInward(dt, w, h, p.x, p.y, null) : null;
  if (fromDt) return fromDt;
  const d = 1.8;
  const a = insideMask(mask, w, h, p.x + nx * d, p.y + ny * d);
  const b = insideMask(mask, w, h, p.x - nx * d, p.y - ny * d);
  if (a && !b) return { x: nx, y: ny };
  if (b && !a) return { x: -nx, y: -ny };
  return { x: nx, y: ny };
}

/** Closed-loop Laplacian. Open-polyline smooth leaves pixel stairs at the seam. */
function smoothClosed(pts, passes) {
  if (!pts || pts.length < 4) return pts ? pts.slice() : [];
  let cur = pts.slice();
  const last = cur[cur.length - 1], first = cur[0];
  if (Math.hypot(last.x - first.x, last.y - first.y) < 1.6) cur = cur.slice(0, cur.length - 1);
  const nPass = passes == null ? 12 : passes;
  for (let p = 0; p < nPass; p++) {
    const n = cur.length;
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n];
      const b = cur[i];
      const c = cur[(i + 1) % n];
      next[i] = {
        x: b.x * 0.50 + a.x * 0.25 + c.x * 0.25,
        y: b.y * 0.50 + a.y * 0.25 + c.y * 0.25,
      };
    }
    cur = next;
  }
  cur.push({ x: cur[0].x, y: cur[0].y });
  return cur;
}

/** Geometric inward (smoothed tangent). DT gradient on a pixel contour is bristly. */
function geometricInward(samples, i, mask, w, h) {
  const t = tangentAt(samples, i);
  const nx = -t.y, ny = t.x;
  const p = samples[i];
  for (let d = 1.6; d <= 4.2; d += 1.3) {
    const a = insideMask(mask, w, h, p.x + nx * d, p.y + ny * d);
    const b = insideMask(mask, w, h, p.x - nx * d, p.y - ny * d);
    if (a && !b) return { x: nx, y: ny };
    if (b && !a) return { x: -nx, y: -ny };
  }
  return { x: nx, y: ny };
}

function shootToEdge(mask, w, h, px, py, nx, ny, maxDist) {
  const step = 0.42;
  let x = px, y = py;
  let last = { x: px, y: py };
  let dist = 0;
  if (!insideMask(mask, w, h, px, py)) {
    x += nx * step; y += ny * step;
    if (!insideMask(mask, w, h, x, y)) return last;
    last = { x: x, y: y };
    dist = step;
  }
  while (dist < maxDist) {
    x += nx * step; y += ny * step; dist += step;
    if (!insideMask(mask, w, h, x, y)) break;
    last = { x: x, y: y };
  }
  return last;
}

function emitColumns(columns, stitches, underlay, opts, asNewRail) {
  if (!columns.length) return;
  if ((opts.underlay || ["edge-run", "zigzag"]).indexOf("zigzag") !== -1) {
    const zigEvery = Math.max(2, Math.round(1.1 / Math.max(0.2, opts.spacingMm || 0.4)));
    let side = 1;
    for (let i = 0; i < columns.length; i += zigEvery) {
      const c = columns[i];
      const mx = (c.ax + c.bx) / 2, my = (c.ay + c.by) / 2;
      const sx = (c.ax - mx) * 0.55, sy = (c.ay - my) * 0.55;
      const pt = { x: mx + sx * side, y: my + sy * side };
      if (i === 0 && asNewRail && underlay.length) pt.jump = true;
      underlay.push(pt);
      side *= -1;
    }
  }
  let side = 1;
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    const pt = side > 0 ? { x: c.ax, y: c.ay } : { x: c.bx, y: c.by };
    if (i === 0 && asNewRail && stitches.length) pt.jump = true;
    stitches.push(pt);
    side *= -1;
  }
}

function morphClose(mask, w, h, r) {
  return erode(dilate(mask, w, h, r), w, h, r);
}

function countOnMask(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

function fillContour(pts, w, h) {
  const m = new Uint8Array(w * h);
  if (!pts || pts.length < 4) return m;
  for (let y = 0; y < h; y++) {
    const ys = y + 0.5;
    const xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const yi = pts[i].y, yj = pts[j].y;
      if ((yi > ys) === (yj > ys)) continue;
      const xi = pts[i].x, xj = pts[j].x;
      xs.push(xi + (xj - xi) * (ys - yi) / ((yj - yi) || 1e-9));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = y * w;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(xs[k])));
      const x1 = Math.max(0, Math.min(w - 1, Math.ceil(xs[k + 1])));
      for (let x = x0; x <= x1; x++) m[row + x] = 1;
    }
  }
  return m;
}

function silhouetteBand(mask, w, h, bandPx) {
  const bg = floodBackground(mask, w, h);
  const filled = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] || !bg[i]) filled[i] = 1;
  }
  const inner = erode(filled, w, h, Math.max(2, bandPx));
  const band = new Uint8Array(mask.length);
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (filled[i] && !inner[i]) { band[i] = 1; n++; }
  }
  return n >= 40 ? band : mask;
}

/** Seal a branching stroke cluster, then keep a constant-width outer band. */
function clusterBand(mask, w, h, sealPx, bandPx) {
  const fat = dilate(mask, w, h, Math.max(2, sealPx));
  const bg = floodBackground(fat, w, h);
  const filled = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (fat[i] || !bg[i]) filled[i] = 1;
  }
  const core = erode(filled, w, h, Math.max(2, sealPx));
  if (countOnMask(core) < 80) return null;
  const inner = erode(core, w, h, Math.max(2, bandPx));
  const band = new Uint8Array(mask.length);
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (core[i] && !inner[i]) { band[i] = 1; n++; }
  }
  return n >= 80 ? band : null;
}

function closedCount(pts) {
  if (!pts || pts.length < 4) return pts ? pts.length : 0;
  const a = pts[0], b = pts[pts.length - 1];
  if (Math.hypot(a.x - b.x, a.y - b.y) < 0.9) return pts.length - 1;
  return pts.length;
}

function tangentClosed(pts, i) {
  const n = closedCount(pts) || pts.length;
  const a = pts[(i - 1 + n) % n];
  const b = pts[(i + 1) % n];
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
}

/** Chaikin corner-cut, then close. Kills pixel stairs before Laplacian. */
function chaikinClosed(pts, iters) {
  if (!pts || pts.length < 4) return pts ? pts.slice() : [];
  let cur = pts.slice();
  const last = cur[cur.length - 1], first = cur[0];
  if (Math.hypot(last.x - first.x, last.y - first.y) < 1.6) cur = cur.slice(0, cur.length - 1);
  const nIter = iters == null ? 2 : iters;
  for (let k = 0; k < nIter; k++) {
    const n = cur.length;
    const next = new Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = cur[i], b = cur[(i + 1) % n];
      next[i * 2] = { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 };
      next[i * 2 + 1] = { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 };
    }
    cur = next;
  }
  cur.push({ x: cur[0].x, y: cur[0].y });
  return cur;
}

function averagedInward(samples, i, mask, w, h, win) {
  const n = closedCount(samples) || samples.length;
  win = win == null ? 4 : win;
  let tx = 0, ty = 0;
  for (let k = -win; k <= win; k++) {
    const t = tangentClosed(samples, (i + k + n * 4) % n);
    tx += t.x; ty += t.y;
  }
  const len = Math.hypot(tx, ty) || 1;
  tx /= len; ty /= len;
  const nx = -ty, ny = tx;
  const p = samples[i];
  for (let d = 1.8; d <= 5.2; d += 1.4) {
    const a = insideMask(mask, w, h, p.x + nx * d, p.y + ny * d);
    const b = insideMask(mask, w, h, p.x - nx * d, p.y - ny * d);
    if (a && !b) return { x: nx, y: ny };
    if (b && !a) return { x: -nx, y: -ny };
  }
  return { x: nx, y: ny };
}

/**
 * Two-rail satin along the main contours of an outline network.
 * Hairline-gap rings (bee) are recovered by a light close; each large hole
 * is one constant-width column. Spike-splits are not used — they sew as
 * a nest of short satins on cartoon faces.
 */
function outlineRailSatin(mask, w, h, unitPerPx, opts, dt) {
  const spacingU = (opts.spacingMm || 0.34) * 10;
  const spacing = Math.max(0.75, spacingU / unitPerPx);
  const maxHalf = Math.max(5, (2.4 * 10) / unitPerPx);
  const minHalf = Math.max(0.8, (0.28 * 10) / unitPerPx);
  const minLen = Math.max(12, Math.min(w, h) * 0.035);
  const mmPerPx = unitPerPx * 0.1;
  let ringMask = mask;
  {
    const closeR = Math.max(2, Math.round(0.32 / mmPerPx));
    const closed = morphClose(mask, w, h, closeR);
    const n0 = countOnMask(mask), n1 = countOnMask(closed);
    if (n0 > 40 && n1 >= n0 && n1 <= n0 * 1.14) ringMask = closed;
  }
  const rings = contoursWithHoles(ringMask, w, h, 10);
  const covered = new Uint8Array(w * h);
  const stitches = [];
  const underlay = [];
  const used = [];

  function markCovered(ax, ay, bx, by) {
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    const pad = 2;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = Math.round(ax + (bx - ax) * t);
      const y = Math.round(ay + (by - ay) * t);
      for (let dy = -pad; dy <= pad; dy++) {
        for (let dx = -pad; dx <= pad; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          covered[yy * w + xx] = 1;
        }
      }
    }
  }

  function markMask(src) {
    for (let i = 0; i < src.length; i++) if (src[i]) covered[i] = 1;
  }

  function railFromContour(raw, shootMask) {
    if (!raw || raw.length < 8) return;
    if (polyLength(raw) < minLen) return;
    const shoot = shootMask || ringMask;
    const loop = smoothClosed(chaikinClosed(raw, 3), 22);
    const samples = resamplePolyline(loop, spacing, true);
    if (samples.length < 8) return;
    const n = closedCount(samples) || samples.length;
    const rawCols = [];
    let already = 0;
    for (let i = 0; i < n; i++) {
      const p = samples[i];
      const nrm = averagedInward(samples, i, shoot, w, h, 7);
      const far = shootToEdge(shoot, w, h, p.x, p.y, nrm.x, nrm.y, maxHalf);
      const half = Math.hypot(far.x - p.x, far.y - p.y);
      const xi = Math.round(p.x), yi = Math.round(p.y);
      if (xi >= 0 && yi >= 0 && xi < w && yi < h && covered[yi * w + xi]) already++;
      rawCols.push({ p: p, nrm: nrm, half: half });
    }
    if (rawCols.length < 8) return;
    if (already > rawCols.length * 0.72) return;
    const valid = rawCols.map((c) => c.half).filter((hv) => hv >= minHalf && hv <= maxHalf);
    if (valid.length < 6) return;
    const sorted = valid.slice().sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    const cap = Math.min(maxHalf, Math.max(minHalf * 2, median * 1.35));
    const floor = Math.max(minHalf, median * 0.72);
    const columns = [];
    for (let i = 0; i < rawCols.length; i++) {
      let half = rawCols[i].half;
      if (half < floor || half > cap) half = median;
      else half = half * 0.12 + median * 0.88;
      half = Math.max(floor, Math.min(cap, half));
      const p = rawCols[i].p, nrm = rawCols[i].nrm;
      let bx = p.x + nrm.x * half, by = p.y + nrm.y * half;
      if (!insideMask(shoot, w, h, bx, by)) {
        const c = clampEnd(shoot, w, h, p.x, p.y, bx, by);
        bx = c.x; by = c.y;
      }
      columns.push({ ax: p.x, ay: p.y, bx: bx, by: by, x: (p.x + bx) / 2, y: (p.y + by) / 2 });
    }
    if (columns.length < 8) return;
    columns.push(columns[0]);
    emitColumns(columns, stitches, underlay, opts, used.length > 0);
    columns.forEach((c) => markCovered(c.ax, c.ay, c.bx, c.by));
    used.push(columns);
  }

  const bandPx = Math.max(2, Math.round(1.85 / mmPerPx));
  const sealPx = Math.max(7, Math.round(1.05 / mmPerPx));
  const largeHoles = [];
  {
    const fat = dilate(ringMask, w, h, sealPx);
    contoursWithHoles(fat, w, h, 16).forEach((ring) => {
      (ring.holes || []).forEach((hp) => {
        if (polyLength(hp) * mmPerPx < 10) return;
        largeHoles.push({ hp: hp, fromFat: true });
      });
    });
  }
  if (!largeHoles.length) {
    rings.forEach((ring) => {
      (ring.holes || []).forEach((hp) => {
        const L = polyLength(hp);
        if (L * mmPerPx < 8.0) return;
        if (L < minLen * 1.8) return;
        largeHoles.push({ hp: hp, fromFat: false });
      });
    });
  }
  largeHoles.sort((a, b) => polyLength(b.hp) - polyLength(a.hp));

  const st0 = blobStats(ringMask, w, h);
  const ff0 = st0 ? st0.count / (st0.bw * st0.bh + 1) : 1;
  const sparse = ff0 < 0.22;
  // One fat-dilate "hole" on a cartoon face is a fjord, not a ring. Rail it
  // and the muzzle fills with short columns. Two-plus large holes are bee rings.
  const railHoles = !(sparse && largeHoles.length < 2);
  if (railHoles) {
    largeHoles.forEach((item) => {
      const holeFill = fillContour(item.hp, w, h);
      let interior = holeFill;
      if (item.fromFat) {
        const grown = dilate(holeFill, w, h, sealPx);
        interior = new Uint8Array(grown.length);
        for (let i = 0; i < grown.length; i++) interior[i] = grown[i] && !ringMask[i] ? 1 : 0;
      }
      if (countOnMask(interior) < 40) return;
      const inner = mooreContour(interior, w, h);
      const ringBand = andMask(dilate(interior, w, h, bandPx), ringMask);
      if (countOnMask(ringBand) < 40) return;
      railFromContour(inner.length >= 8 ? inner : item.hp, ringBand);
      markMask(ringBand);
    });
  }
  if (sparse && largeHoles.length < 2) {
    const band = clusterBand(ringMask, w, h, sealPx, Math.max(2, Math.round(0.92 / mmPerPx)));
    if (band) {
      railFromContour(mooreContour(band, w, h), band);
      markMask(band);
    }
  } else if (!sparse && largeHoles.length <= 1) {
    rings.forEach((ring) => {
      railFromContour(ring.outer, ringMask);
    });
  }

  const leftover = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) {
    if (ringMask[i] && !covered[i]) leftover[i] = 1;
  }
  const minPix = Math.max(36, Math.round(3.5 / (mmPerPx * mmPerPx)));
  connectedComponents(leftover, w, h, minPix).forEach((comp) => {
    const st = blobStats(comp.mask, w, h);
    if (!st) return;
    const areaMm2 = st.count * mmPerPx * mmPerPx;
    if (areaMm2 < 4.0) return;
    const ff = st.count / (st.bw * st.bh + 1);
    if (ff < 0.24) {
      const band = clusterBand(comp.mask, w, h, sealPx, Math.max(2, Math.round(0.90 / mmPerPx)))
        || silhouetteBand(comp.mask, w, h, Math.max(2, Math.round(0.90 / mmPerPx)));
      const outer = mooreContour(band, w, h);
      railFromContour(outer, band);
    } else {
      const line = fallbackCenterline(comp.mask, w, h);
      if (line.length >= 4) {
        const columns = columnsFromCenter(
          smoothPolyline(line, 8), distanceTransform(comp.mask, w, h),
          w, h, spacing, 0, comp.mask, minHalf
        );
        if (columns.length >= 6) {
          emitColumns(columns, stitches, underlay, opts, used.length > 0);
          columns.forEach((c) => markCovered(c.ax, c.ay, c.bx, c.by));
          used.push(columns);
        }
      }
    }
  });

  if (stitches.length >= 8) {
    if ((opts.underlay || ["edge-run"]).indexOf("edge-run") !== -1) {
      contourRun(mask, w, h, unitPerPx, { stitchMm: 2.2, insetMm: 0.2 }).forEach((p) => underlay.unshift(p));
    }
    return {
      underlay: underlay,
      stitches: stitches,
      center: used[0] ? used[0].map((c) => ({ x: c.x, y: c.y })) : [],
      railCount: used.length,
    };
  }
  return null;
}

function mergeEndToEnd(paths, dist) {
  const used = new Uint8Array(paths.length);
  const out = [];
  for (let i = 0; i < paths.length; i++) {
    if (used[i]) continue;
    let cur = paths[i].slice();
    used[i] = 1;
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < paths.length; j++) {
        if (used[j] || paths[j].length < 2) continue;
        const h = cur[0], t = cur[cur.length - 1];
        const p = paths[j], ph = p[0], pt = p[p.length - 1];
        const d = dist;
        if (Math.hypot(t.x - ph.x, t.y - ph.y) <= d) {
          cur = cur.concat(p.slice(1)); used[j] = 1; grew = true;
        } else if (Math.hypot(t.x - pt.x, t.y - pt.y) <= d) {
          cur = cur.concat(p.slice().reverse().slice(1)); used[j] = 1; grew = true;
        } else if (Math.hypot(h.x - pt.x, h.y - pt.y) <= d) {
          cur = p.slice(0, -1).concat(cur); used[j] = 1; grew = true;
        } else if (Math.hypot(h.x - ph.x, h.y - ph.y) <= d) {
          cur = p.slice().reverse().slice(0, -1).concat(cur); used[j] = 1; grew = true;
        }
      }
    }
    out.push(cur);
  }
  return out;
}

function prunedCenterlines(mask, w, h, minLen) {
  const skel = zhangSuenThin(mask, w, h);
  let paths = (traceSkeleton(skel, w, h) || []).filter((p) => p.length >= 4);
  paths = mergeEndToEnd(paths, 2.4);
  paths = paths.filter((p) => polyLength(p) >= minLen);
  paths.sort((a, b) => polyLength(b) - polyLength(a));
  return paths.slice(0, 5).map((p) => smoothPolyline(p, 8));
}

function satinColumns(mask, w, h, unitPerPx, opts) {
  opts = opts || {};
  const spacingU = (opts.spacingMm || 0.4) * 10;
  const pullU = (opts.pullMm == null ? 0.18 : opts.pullMm) * 10;
  const spacing = spacingU / unitPerPx;
  const pull = pullU / unitPerPx;
  const dt = distanceTransform(mask, w, h);
  const st = blobStats(mask, w, h);
  const fillFrac = st ? st.count / (st.bw * st.bh + 1) : 1;
  const outlineLike = !!(opts.outlineLike) || (fillFrac < 0.38 && st && st.count > 40);

  let lines = centerlinesFromMask(mask, w, h);
  if (outlineLike) {
    // Branching cartoon outlines (Tony face, bee rings) scribble if sewn
    // on skeleton twigs. Prefer one continuous contour rail.
    const rail = outlineRailSatin(mask, w, h, unitPerPx, opts, dt);
    if (rail && rail.stitches.length >= 8) return rail;
    const minLen = Math.max(16, Math.min(w, h) * 0.055);
    const pruned = prunedCenterlines(mask, w, h, minLen);
    if (pruned.length) lines = pruned;
    else if (lines.length > 3) lines = lines.slice(0, 2);
  }
  if (!lines.length) return { underlay: [], stitches: [], center: [] };

  const underlay = [];
  if ((opts.underlay || ["edge-run", "zigzag"]).indexOf("edge-run") !== -1) {
    contourRun(mask, w, h, unitPerPx, { stitchMm: 2.2, insetMm: 0.25 }).forEach((p) => underlay.push(p));
  }

  const stitches = [];
  lines.forEach((center) => {
    const minHalf = Math.max(0.9, (0.42 * 10) / unitPerPx);
    const columns = columnsFromCenter(center, dt, w, h, spacing, pull, mask, minHalf);
    if (!columns.length) return;
    emitColumns(columns, stitches, underlay, opts);
  });
  return { underlay: underlay, stitches: stitches, center: lines[0] };
}

module.exports = { satinColumns, centerlineFromMask, centerlinesFromMask };
