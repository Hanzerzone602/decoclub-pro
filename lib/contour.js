"use strict";

const { decodePng } = require("./png");

function luminance(r, g, b, a) {
  if (a < 12) return 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function buildMask(rgba, w, h) {
  const dark = new Uint8Array(w * h);
  const alpha = new Uint8Array(w * h);
  let opaque = 0;
  let darkCount = 0;
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (a > 12) opaque++;
    alpha[i] = a > 12 ? 1 : 0;
    if (a > 12 && luminance(r, g, b, a) < 200) {
      dark[i] = 1;
      darkCount++;
    }
  }
  const alphaRatio = opaque / (w * h);
  if (alphaRatio < 0.97 && opaque > 20) return { mask: alpha, w, h };
  if (darkCount > 20 && darkCount < opaque * 0.95) return { mask: dark, w, h };
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    inv[i] = a > 12 && luminance(r, g, b, a) > 80 ? 1 : 0;
  }
  return { mask: inv, w, h };
}

function dilate(mask, w, h, radius) {
  if (radius <= 0) return mask;
  const out = new Uint8Array(w * h);
  const r = Math.max(1, Math.round(radius));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let dy = -r; dy <= r && !hit; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (dx * dx + dy * dy > r * r) continue;
          if (mask[ny * w + nx]) { hit = 1; break; }
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

function padMask(mask, w, h) {
  const nw = w + 2, nh = h + 2;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) {
    out.set(mask.subarray(y * w, y * w + w), (y + 1) * nw + 1);
  }
  return { mask: out, w: nw, h: nh };
}

const DIRS = [
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

function mooreTraceFrom(mask, w, h, sx, sy) {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h || !mask[sy * w + sx]) return [];
  const pts = [];
  let x = sx, y = sy;
  let dir = 4;
  const startKey = sy * w + sx;
  let guard = w * h * 4;
  do {
    pts.push({ x, y });
    let look = (dir + 6) % 8;
    let found = false;
    for (let i = 0; i < 8; i++) {
      const d = (look + i) % 8;
      const nx = x + DIRS[d][0];
      const ny = y + DIRS[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (mask[ny * w + nx]) {
        x = nx;
        y = ny;
        dir = d;
        found = true;
        break;
      }
    }
    if (!found) break;
    guard--;
  } while ((y * w + x) !== startKey && guard > 0);
  return pts;
}

function mooreTrace(mask, w, h) {
  let sx = -1, sy = -1;
  for (let y = 0; y < h && sx < 0; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { sx = x; sy = y; break; }
    }
  }
  if (sx < 0) return [];
  return mooreTraceFrom(mask, w, h, sx, sy);
}

function floodFill4(src, w, h, visited, sx, sy, pred) {
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
  const stack = [sx, sy];
  while (stack.length) {
    const y = stack.pop();
    const x = stack.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x;
    if (visited[i]) continue;
    if (!pred(i, x, y)) continue;
    visited[i] = 1;
    stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
}

function traceAllContours(mask, w, h) {
  const padded = padMask(mask, w, h);
  const M = padded.mask, W = padded.w, H = padded.h;
  const contours = [];
  const usedOuter = new Uint8Array(W * H);

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!M[i] || M[i - 1] || usedOuter[i]) continue;
      const pts = mooreTraceFrom(M, W, H, x, y);
      if (pts.length < 3) continue;
      for (let k = 0; k < pts.length; k++) usedOuter[pts[k].y * W + pts[k].x] = 1;
      contours.push({ pts: pts.map((p) => ({ x: p.x - 1, y: p.y - 1 })), hole: false });
    }
  }

  const exterior = new Uint8Array(W * H);
  floodFill4(M, W, H, exterior, 0, 0, function (i) { return !M[i]; });

  const holeMask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!M[i] && !exterior[i]) holeMask[i] = 1;
  }
  const usedHole = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (!holeMask[i] || holeMask[i - 1] || usedHole[i]) continue;
      const pts = mooreTraceFrom(holeMask, W, H, x, y);
      if (pts.length < 3) continue;
      for (let k = 0; k < pts.length; k++) usedHole[pts[k].y * W + pts[k].x] = 1;
      contours.push({ pts: pts.map((p) => ({ x: p.x - 1, y: p.y - 1 })), hole: true });
    }
  }
  return contours;
}

function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left = simplify(pts.slice(0, idx + 1), eps);
    const right = simplify(pts.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

function simplifyClosed(pts, eps) {
  if (!pts || pts.length < 3) return pts || [];
  let ring = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = ring[ring.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.35) ring.push(p);
  }
  if (ring.length > 1) {
    const a = ring[0], b = ring[ring.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.6) ring = ring.slice(0, -1);
  }
  if (ring.length < 3) return pts;
  let a = 0, b = 1, best = -1;
  for (let i = 0; i < ring.length; i++) {
    for (let j = i + 1; j < ring.length; j++) {
      const d = Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y);
      if (d > best) { best = d; a = i; b = j; }
    }
  }
  function chain(from, to) {
    const out = [];
    let i = from;
    out.push(ring[i]);
    while (i !== to) {
      i = (i + 1) % ring.length;
      out.push(ring[i]);
    }
    return out;
  }
  const s1 = simplify(chain(a, b), eps);
  const s2 = simplify(chain(b, a), eps);
  let out = s1.slice(0, -1).concat(s2.slice(0, -1));
  if (out.length < 3) return ring;
  return out;
}

function marchingSquares(mask, w, h) {
  const pts = [];
  function interp(x0, y0, x1, y1, a, b) {
    if (a === b) return { x: x0, y: y0 };
    const t = a / (a - b);
    return { x: x0 + t * (x1 - x0), y: y0 + t * (y1 - y0) };
  }
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = mask[y * w + x] ? 1 : 0;
      const tr = mask[y * w + x + 1] ? 1 : 0;
      const bl = mask[(y + 1) * w + x] ? 1 : 0;
      const br = mask[(y + 1) * w + x + 1] ? 1 : 0;
      const idx = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (!idx || idx === 15) continue;
      const top = interp(x, y, x + 1, y, tl - 0.5, tr - 0.5);
      const right = interp(x + 1, y, x + 1, y + 1, tr - 0.5, br - 0.5);
      const bottom = interp(x, y + 1, x + 1, y + 1, bl - 0.5, br - 0.5);
      const left = interp(x, y, x, y + 1, tl - 0.5, bl - 0.5);
      const segs = {
        1: [left, bottom], 2: [bottom, right], 3: [left, right],
        4: [top, right], 5: [left, top, bottom, right], 6: [top, bottom],
        7: [left, top], 8: [left, top], 9: [top, bottom],
        10: [left, bottom, top, right], 11: [top, right],
        12: [left, right], 13: [bottom, right], 14: [left, bottom],
      }[idx];
      if (segs) for (let i = 0; i < segs.length; i += 2) pts.push(segs[i], segs[i + 1]);
    }
  }
  return pts;
}

function pathFromPoints(pts, scaleX, scaleY, ox, oy) {
  if (!pts.length) return "";
  const fmt = (n) => Math.round(n * 1000) / 1000;
  let d = "";
  for (let i = 0; i < pts.length; i++) {
    const x = fmt((pts[i].x + (ox || 0)) * scaleX);
    const y = fmt((pts[i].y + (oy || 0)) * scaleY);
    d += (i ? " L " : "M ") + x + " " + y;
  }
  d += " Z";
  return d;
}

function boundsPath(widthIn, heightIn) {
  const w = Number(widthIn) || 1;
  const h = Number(heightIn) || 1;
  return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
}

function contourFromPngBuffer(buf, widthIn, heightIn, opts) {
  opts = opts || {};
  const img = decodePng(buf);
  const built = buildMask(img.rgba, img.width, img.height);
  let mask = built.mask;
  if (opts.dilatePx) mask = dilate(mask, img.width, img.height, opts.dilatePx);
  const padded = padMask(mask, img.width, img.height);
  let pts = mooreTrace(padded.mask, padded.w, padded.h);
  if (pts.length < 8) {
    const ms = marchingSquares(padded.mask, padded.w, padded.h);
    pts = ms.filter((_, i) => i % 2 === 0);
  }
  pts = simplify(pts, opts.epsilon == null ? 1.4 : opts.epsilon);
  const sx = (Number(widthIn) || 1) / img.width;
  const sy = (Number(heightIn) || 1) / img.height;
  const d = pathFromPoints(pts, sx, sy, -1, -1);
  return {
    d: d || boundsPath(widthIn, heightIn),
    widthIn: Number(widthIn) || 1,
    heightIn: Number(heightIn) || 1,
    pixelWidth: img.width,
    pixelHeight: img.height,
    pointCount: pts.length,
  };
}

function svgFromContour(contour, extra) {
  extra = extra || {};
  const stroke = extra.stroke || "#e106d7";
  const fill = extra.fill || "none";
  const sw = extra.strokeWidth || 0.02;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${contour.widthIn}in" height="${contour.heightIn}in" viewBox="0 0 ${contour.widthIn} ${contour.heightIn}">`,
    extra.inner || "",
    `<path d="${contour.d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`,
    `</svg>`,
  ].join("\n");
}


function despeckleAssign(assign, w, h, minSize) {
  minSize = Math.max(1, minSize == null ? 10 : minSize);
  const n = w * h;
  const visited = new Uint8Array(n);
  const qx = new Int32Array(n);
  const qy = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (visited[start] || assign[start] < 0) continue;
      const label = assign[start];
      let head = 0, tail = 0;
      qx[0] = x; qy[0] = y; tail = 1;
      visited[start] = 1;
      const comp = [start];
      while (head < tail) {
        const cx = qx[head], cy = qy[head++];
        const neigh = [cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1];
        for (let k = 0; k < 8; k += 2) {
          const nx = neigh[k], ny = neigh[k + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (visited[ni] || assign[ni] !== label) continue;
          visited[ni] = 1;
          qx[tail] = nx; qy[tail] = ny; tail++;
          comp.push(ni);
        }
      }
      if (comp.length >= minSize) continue;
      const votes = new Int32Array(16);
      let best = -1, bestN = 0;
      for (let k = 0; k < comp.length; k++) {
        const pi = comp[k];
        const px = pi % w, py = (pi / w) | 0;
        const neigh = [px + 1, py, px - 1, py, px, py + 1, px, py - 1];
        for (let t = 0; t < 8; t += 2) {
          const nx = neigh[t], ny = neigh[t + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const lab = assign[ny * w + nx];
          if (lab < 0 || lab === label || lab > 15) continue;
          votes[lab]++;
          if (votes[lab] > bestN) { bestN = votes[lab]; best = lab; }
        }
      }
      if (best < 0) continue;
      for (let k = 0; k < comp.length; k++) assign[comp[k]] = best;
    }
  }
  return assign;
}

function majoritySmooth(assign, w, h, passes) {
  passes = passes == null ? 2 : passes;
  const n = w * h;
  const buf = new Int16Array(n);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const cur = assign[i];
        if (cur < 0) { buf[i] = -1; continue; }
        const hist = new Int32Array(16);
        let best = cur, bestN = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const lab = assign[ny * w + nx];
            if (lab < 0 || lab > 15) continue;
            hist[lab]++;
          }
        }
        for (let lab = 0; lab < 16; lab++) {
          if (hist[lab] > bestN || (hist[lab] === bestN && lab === cur)) {
            bestN = hist[lab];
            best = lab;
          }
        }
        buf[i] = bestN ? best : cur;
      }
    }
    assign.set(buf);
  }
  return assign;
}


function keyXY(x, y) { return (y * 65536) + x; }

function perpDist2(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (!len2) {
    const ex = p.x - a.x, ey = p.y - a.y;
    return ex * ex + ey * ey;
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * dx, qy = a.y + t * dy;
  const ex = p.x - qx, ey = p.y - qy;
  return ex * ex + ey * ey;
}

/** Potrace-inspired optimal polygon via DP within ε (original JS; not a GPL port). */
function optimalPolygon(pts, eps) {
  if (!pts || pts.length < 3) return pts || [];
  const epsN = eps == null ? 0.75 : eps;
  // Pre-decimate dense raster rings so DP stays O(n²) tractable
  let ring = pts;
  if (ring.length > 400) {
    ring = simplifyClosed(ring, Math.max(0.35, epsN * 0.45));
  }
  if (!ring || ring.length < 3) ring = pts;
  const eps2 = epsN * epsN;
  const cleaned = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const prev = cleaned[cleaned.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1e-6) cleaned.push({ x: p.x, y: p.y });
  }
  if (cleaned.length > 2) {
    const a = cleaned[0], b = cleaned[cleaned.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-6) cleaned.pop();
  }
  ring = cleaned;
  const n = ring.length;
  if (n < 3) return pts.slice(0, Math.min(pts.length, 8));
  if (n > 280) {
    // Extreme rings: fall back to closed Douglas-Peucker
    return simplifyClosed(ring, epsN);
  }

  function segmentOk(i, j) {
    const a = ring[i], b = ring[j];
    let k = (i + 1) % n;
    while (k !== j) {
      if (perpDist2(ring[k], a, b) > eps2) return false;
      k = (k + 1) % n;
      if (k === i) break;
    }
    return true;
  }

  let a0 = 0, b0 = Math.min(1, n - 1), bestD = -1;
  // Sample diameter search for speed
  const step = n > 200 ? Math.ceil(n / 200) : 1;
  for (let i = 0; i < n; i += step) {
    for (let j = i + 1; j < n; j += step) {
      const d = Math.hypot(ring[i].x - ring[j].x, ring[i].y - ring[j].y);
      if (d > bestD) { bestD = d; a0 = i; b0 = j; }
    }
  }

  function chainIndices(from, to) {
    const idx = [from];
    let i = from;
    while (i !== to) {
      i = (i + 1) % n;
      idx.push(i);
    }
    return idx;
  }

  function dpChain(idx) {
    const m = idx.length;
    if (m < 2) return idx.slice();
    const prev = new Int32Array(m);
    const cost = new Float64Array(m);
    cost.fill(Infinity);
    cost[0] = 0;
    prev[0] = -1;
    const maxSpan = Math.min(m - 1, Math.max(24, Math.floor(m * 0.35)));
    for (let j = 1; j < m; j++) {
      const iMin = Math.max(0, j - maxSpan);
      for (let i = iMin; i < j; i++) {
        if (!segmentOk(idx[i], idx[j])) continue;
        const c = cost[i] + 1;
        if (c < cost[j]) { cost[j] = c; prev[j] = i; }
      }
      if (prev[j] < 0) {
        prev[j] = j - 1;
        cost[j] = cost[j - 1] + 1;
      }
    }
    const out = [];
    for (let j = m - 1; j >= 0; j = prev[j]) {
      out.push(idx[j]);
      if (prev[j] < 0) break;
    }
    out.reverse();
    return out;
  }

  const c1 = dpChain(chainIndices(a0, b0));
  const c2 = dpChain(chainIndices(b0, a0));
  const merged = c1.slice(0, -1).concat(c2.slice(0, -1));
  if (merged.length < 3) return simplifyClosed(ring, epsN);
  return merged.map((i) => ({ x: ring[i].x, y: ring[i].y }));
}

function isFg(mask, w, h, x, y) {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  return mask[y * w + x] !== 0;
}

function upsampleMask2x(mask, w, h) {
  const nw = w * 2, nh = h * 2;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = mask[y * w + x] ? 1 : 0;
      const y2 = y * 2, x2 = x * 2;
      out[y2 * nw + x2] = v;
      out[y2 * nw + x2 + 1] = v;
      out[(y2 + 1) * nw + x2] = v;
      out[(y2 + 1) * nw + x2 + 1] = v;
    }
  }
  return { mask: out, w: nw, h: nh };
}

/**
 * Dual-grid style contours via 2× Moore trace, then scale 0.5.
 * Yields half-pixel boundary placement vs original raster.
 */
function traceCornerContours(mask, w, h) {
  const up = upsampleMask2x(mask, w, h);
  const raw = traceAllContours(up.mask, up.w, up.h);
  return raw.map((c) => ({
    hole: !!c.hole,
    pts: c.pts.map((p) => ({ x: p.x * 0.5 + 0.25, y: p.y * 0.5 + 0.25 })),
  }));
}

/**
 * Soft α=0.5 iso-contour via marching squares on a float field,
 * or 2× hard-label upsample → Moore → scale 0.5.
 */
function traceSubpixelContours(mask, w, h, opts) {
  opts = opts || {};
  const soft = opts.softField;
  if (soft && soft.length === w * h) {
    const iso = opts.iso == null ? 0.5 : opts.iso;
    const hard = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) hard[i] = soft[i] >= iso ? 1 : 0;
    // 2× the thresholded soft field for sub-pixel, then scale
    return traceCornerContours(hard, w, h);
  }
  return traceCornerContours(mask, w, h);
}


module.exports = {
  buildMask,
  dilate,
  padMask,
  mooreTrace,
  mooreTraceFrom,
  traceAllContours,
  simplify,
  simplifyClosed,
  optimalPolygon,
  traceCornerContours,
  traceSubpixelContours,
  despeckleAssign,
  majoritySmooth,
  contourFromPngBuffer,
  svgFromContour,
  boundsPath,
  pathFromPoints,
};
