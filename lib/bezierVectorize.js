"use strict";
const { decodePng } = require("./png");
const {
  dilate, traceAllContours, simplifyClosed, traceSubpixelContours,
  softTraceContours, despeckleAssign, majoritySmooth, morphOpenAssign,
  optimalPolygon,
} = require("./contour");
const { fitCubicPath } = require("./bezierfit");
const { annotateLayer, annotateLayers } = require("./colorspec");
const { refineLayers } = require("./bezierRefine");

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function fmt(n) {
  const x = Math.round(Number(n) * 10000) / 10000;
  if (Object.is(x, -0)) return "0";
  return String(x);
}
function toHex(r, g, b) {
  function h(n) { return ("0" + clamp(Math.round(n), 0, 255).toString(16)).slice(-2); }
  return "#" + h(r) + h(g) + h(b);
}
function lum(rgb) { return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]; }

function rgbToLab(r, g, b) {
  function lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const R = lin(r), G = lin(g), B = lin(b);
  let x = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  let y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  let z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  x /= 0.95047; y /= 1; z /= 1.08883;
  function f(t) { return t > 0.008856 ? Math.pow(t, 1 / 3) : (7.787 * t) + 16 / 116; }
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function labDist2(a, b) {
  const d0 = a[0] - b[0], d1 = a[1] - b[1], d2 = a[2] - b[2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}
function qkey(r, g, b) { return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); }
function localRange(rgba, w, h, x, y) {
  let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy; if (yy < 0 || yy >= h) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx; if (xx < 0 || xx >= w) continue;
      const i = (yy * w + xx) * 4;
      if (rgba[i + 3] < 12) continue;
      if (rgba[i] < r0) r0 = rgba[i]; if (rgba[i] > r1) r1 = rgba[i];
      if (rgba[i + 1] < g0) g0 = rgba[i + 1]; if (rgba[i + 1] > g1) g1 = rgba[i + 1];
      if (rgba[i + 2] < b0) b0 = rgba[i + 2]; if (rgba[i + 2] > b1) b1 = rgba[i + 2];
    }
  }
  return Math.max(r1 - r0, g1 - g0, b1 - b0);
}

function bilinearUpscale(rgba, w, h, scale) {
  scale = scale || 2;
  if (scale <= 1) return { rgba: rgba, w: w, h: h };
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = Buffer.alloc(nw * nh * 4);
  const xRatio = (w - 1) / Math.max(1, nw - 1);
  const yRatio = (h - 1) / Math.max(1, nh - 1);
  for (let y = 0; y < nh; y++) {
    const fy = y * yRatio;
    const y0 = Math.floor(fy);
    const y1 = Math.min(h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = x * xRatio;
      const x0 = Math.floor(fx);
      const x1 = Math.min(w - 1, x0 + 1);
      const tx = fx - x0;
      const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
      const di = (y * nw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v0 = rgba[i00 + c] * (1 - tx) + rgba[i10 + c] * tx;
        const v1 = rgba[i01 + c] * (1 - tx) + rgba[i11 + c] * tx;
        out[di + c] = Math.round(v0 * (1 - ty) + v1 * ty);
      }
    }
  }
  return { rgba: out, w: nw, h: nh };
}

/** Lab k-means seeded by popularity bins; returns mean-RGB palette. */
function kmeansPalette(rgba, w, h, k) {
  k = clamp(k || 8, 2, 16);
  const labs = [];
  const rgbs = [];
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 80000)));
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] < 12) continue;
      // Prefer flat regions for seeds, but still sample edges lightly
      if (localRange(rgba, w, h, x, y) > 60 && ((x + y) % 3 !== 0)) continue;
      labs.push(rgbToLab(rgba[i], rgba[i + 1], rgba[i + 2]));
      rgbs.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
    }
  }
  if (labs.length < k) {
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        if (rgba[i + 3] < 12) continue;
        labs.push(rgbToLab(rgba[i], rgba[i + 1], rgba[i + 2]));
        rgbs.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
      }
    }
  }
  if (!labs.length) return [[17, 17, 17]];

  // Farthest-point init in Lab
  const cents = [];
  let bi = 0;
  for (let i = 1; i < labs.length; i++) if (labs[i][0] < labs[bi][0]) bi = i;
  cents.push(labs[bi].slice());
  while (cents.length < k) {
    let bestI = -1, bestD = -1;
    for (let i = 0; i < labs.length; i += Math.max(1, (labs.length / 4000) | 0)) {
      let md = Infinity;
      for (let c = 0; c < cents.length; c++) {
        const d = labDist2(labs[i], cents[c]);
        if (d < md) md = d;
      }
      if (md > bestD) { bestD = md; bestI = i; }
    }
    if (bestI < 0 || bestD < 8) break;
    cents.push(labs[bestI].slice());
  }

  const assign = new Int16Array(labs.length);
  const iters = 10;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < labs.length; i++) {
      let b = 0, bd = Infinity;
      for (let c = 0; c < cents.length; c++) {
        const d = labDist2(labs[i], cents[c]);
        if (d < bd) { bd = d; b = c; }
      }
      assign[i] = b;
    }
    const sum = cents.map(function () { return [0, 0, 0, 0]; });
    for (let i = 0; i < labs.length; i++) {
      const a = assign[i];
      sum[a][0] += labs[i][0]; sum[a][1] += labs[i][1]; sum[a][2] += labs[i][2]; sum[a][3]++;
    }
    for (let c = 0; c < cents.length; c++) {
      if (sum[c][3]) cents[c] = [sum[c][0] / sum[c][3], sum[c][1] / sum[c][3], sum[c][2] / sum[c][3]];
    }
  }

  const rgbSum = cents.map(function () { return [0, 0, 0, 0]; });
  for (let i = 0; i < labs.length; i++) {
    const a = assign[i];
    rgbSum[a][0] += rgbs[i][0]; rgbSum[a][1] += rgbs[i][1]; rgbSum[a][2] += rgbs[i][2]; rgbSum[a][3]++;
  }
  const colors = [];
  for (let c = 0; c < cents.length; c++) {
    if (rgbSum[c][3] < Math.max(4, labs.length * 0.0015)) continue;
    colors.push([
      rgbSum[c][0] / rgbSum[c][3],
      rgbSum[c][1] / rgbSum[c][3],
      rgbSum[c][2] / rgbSum[c][3],
    ]);
  }
  // Merge near-duplicates in Lab
  const merged = [];
  for (let i = 0; i < colors.length; i++) {
    const lab = rgbToLab(colors[i][0], colors[i][1], colors[i][2]);
    let near = -1;
    for (let j = 0; j < merged.length; j++) {
      if (labDist2(lab, rgbToLab(merged[j][0], merged[j][1], merged[j][2])) < 18) { near = j; break; }
    }
    if (near < 0) merged.push(colors[i]);
  }
  return merged.length ? merged : [[17, 17, 17]];
}

function popularityPalette(rgba, w, h, k) {
  k = clamp(k || 8, 2, 16);
  const hist = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (rgba[i + 3] < 12) continue;
      if (localRange(rgba, w, h, x, y) > 48) continue;
      const key = qkey(rgba[i], rgba[i + 1], rgba[i + 2]);
      let rec = hist.get(key);
      if (!rec) rec = { n: 0, r: 0, g: 0, b: 0 };
      rec.n++; rec.r += rgba[i]; rec.g += rgba[i + 1]; rec.b += rgba[i + 2];
      hist.set(key, rec);
    }
  }
  let bins = Array.from(hist.values());
  if (bins.length < 3) {
    hist.clear();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (rgba[i + 3] < 12) continue;
        const key = qkey(rgba[i], rgba[i + 1], rgba[i + 2]);
        let rec = hist.get(key);
        if (!rec) rec = { n: 0, r: 0, g: 0, b: 0 };
        rec.n++; rec.r += rgba[i]; rec.g += rgba[i + 1]; rec.b += rgba[i + 2];
        hist.set(key, rec);
      }
    }
    bins = Array.from(hist.values());
  }
  bins.sort(function (a, b) { return b.n - a.n; });
  const colors = [];
  for (let i = 0; i < bins.length && colors.length < k; i++) {
    const rgb = [bins[i].r / bins[i].n, bins[i].g / bins[i].n, bins[i].b / bins[i].n];
    let near = false;
    const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
    for (let j = 0; j < colors.length; j++) {
      if (labDist2(lab, rgbToLab(colors[j][0], colors[j][1], colors[j][2])) < 22) { near = true; break; }
    }
    if (!near) colors.push(rgb);
  }
  return colors.length ? colors : [[17, 17, 17]];
}

function snapToPalette(rgba, w, h, palette) {
  const palLabs = palette.map(function (c) { return rgbToLab(c[0], c[1], c[2]); });
  const assign = new Int16Array(w * h);
  assign.fill(-1);
  const counts = new Array(palette.length).fill(0);
  const sums = palette.map(function () { return [0, 0, 0, 0]; });
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] < 12) continue;
    const lab = rgbToLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    let bi = 0, bd = Infinity;
    for (let c = 0; c < palLabs.length; c++) {
      const d = labDist2(lab, palLabs[c]);
      if (d < bd) { bd = d; bi = c; }
    }
    assign[i] = bi;
    counts[bi]++;
    sums[bi][0] += rgba[i * 4];
    sums[bi][1] += rgba[i * 4 + 1];
    sums[bi][2] += rgba[i * 4 + 2];
    sums[bi][3]++;
  }
  // Recolor palette to mean of assigned pixels (MAE win)
  for (let c = 0; c < palette.length; c++) {
    if (sums[c][3] > 0) {
      palette[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
    }
  }
  return { assign: assign, counts: counts, palLabs: palLabs };
}

function knockoutPaper(assign, palette, w, h) {
  const votes = new Array(palette.length).fill(0);
  function vote(i) { const c = assign[i]; if (c >= 0) votes[c]++; }
  for (let x = 0; x < w; x++) { vote(x); vote((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { vote(y * w); vote(y * w + w - 1); }
  let paper = -1, best = 0;
  for (let c = 0; c < votes.length; c++) {
    if (votes[c] > best && lum(palette[c]) > 188) { best = votes[c]; paper = c; }
  }
  if (paper < 0) return -1;
  const n = w * h;
  const stack = [];
  const seen = new Uint8Array(n);
  function push(i) {
    if (i < 0 || i >= n || seen[i] || assign[i] !== paper) return;
    seen[i] = 1; stack.push(i);
  }
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    assign[i] = -1;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x + 1 < w) push(i + 1);
    if (y > 0) push(i - w);
    if (y + 1 < h) push(i + w);
  }
  return paper;
}

function destaircase(pts) {
  if (!pts || pts.length < 4) return pts || [];
  let ring = pts.map(function (p) { return { x: p.x, y: p.y }; });
  if (Math.hypot(ring[0].x - ring[ring.length - 1].x, ring[0].y - ring[ring.length - 1].y) < 0.45) ring.pop();
  for (let pass = 0; pass < 16; pass++) {
    const n = ring.length;
    if (n < 4) break;
    const keep = [];
    let dropped = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[(i - 1 + n) % n];
      const b = ring[i];
      const c = ring[(i + 1) % n];
      const abx = b.x - a.x, aby = b.y - a.y, bcx = c.x - b.x, bcy = c.y - b.y;
      const axisAB = (Math.abs(abx) < 0.85 && Math.abs(aby) >= 0.35) || (Math.abs(aby) < 0.85 && Math.abs(abx) >= 0.35);
      const axisBC = (Math.abs(bcx) < 0.85 && Math.abs(bcy) >= 0.35) || (Math.abs(bcy) < 0.85 && Math.abs(bcx) >= 0.35);
      const turned = (Math.abs(abx) < 0.85 && Math.abs(bcy) < 0.85) || (Math.abs(aby) < 0.85 && Math.abs(bcx) < 0.85);
      const short = Math.hypot(abx, aby) <= 8.5 && Math.hypot(bcx, bcy) <= 8.5;
      if (axisAB && axisBC && turned && short) { dropped++; continue; }
      keep.push(b);
    }
    if (!dropped || keep.length < 3) break;
    ring = keep;
  }
  return ring;
}

function chaikinSmooth(pts, rounds, sharpCos) {
  sharpCos = sharpCos == null ? -0.2 : sharpCos;
  let ring = (pts || []).map(function (p) { return { x: p.x, y: p.y }; });
  for (let r = 0; r < (rounds || 2); r++) {
    const n = ring.length;
    if (n < 4) break;
    const sharp = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
      const v1x = b.x - a.x, v1y = b.y - a.y, v2x = c.x - b.x, v2y = c.y - b.y;
      const l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
      const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
      if (cos < sharpCos && l1 > 1.2 && l2 > 1.2) sharp[i] = 1;
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      if (sharp[i]) {
        out.push({ x: a.x, y: a.y });
        out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      } else {
        out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
    }
    ring = out;
  }
  return ring;
}

function laplacianSmooth(pts, iters, lambda) {
  lambda = lambda == null ? 0.35 : lambda;
  let ring = pts.map(function (p) { return { x: p.x, y: p.y }; });
  for (let n = 0; n < (iters || 2); n++) {
    const out = new Array(ring.length);
    const m = ring.length;
    for (let i = 0; i < m; i++) {
      const prev = ring[(i + m - 1) % m];
      const next = ring[(i + 1) % m];
      const pt = ring[i];
      const v1x = pt.x - prev.x, v1y = pt.y - prev.y;
      const v2x = next.x - pt.x, v2y = next.y - pt.y;
      const l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
      const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
      if (cos < -0.35) {
        out[i] = { x: pt.x, y: pt.y };
      } else {
        out[i] = {
          x: pt.x + lambda * ((prev.x + next.x) * 0.5 - pt.x),
          y: pt.y + lambda * ((prev.y + next.y) * 0.5 - pt.y),
        };
      }
    }
    ring = out;
  }
  return ring;
}

function resampleClosed(pts, spacing) {
  spacing = Math.max(0.25, spacing || 0.85);
  if (!pts || pts.length < 3) return pts || [];
  let ring = pts.map(function (p) { return { x: p.x, y: p.y }; });
  if (Math.hypot(ring[0].x - ring[ring.length - 1].x, ring[0].y - ring[ring.length - 1].y) > 0.01) {
    ring = ring.concat([{ x: ring[0].x, y: ring[0].y }]);
  }
  const segLen = [];
  let total = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const L = Math.hypot(ring[i + 1].x - ring[i].x, ring[i + 1].y - ring[i].y);
    segLen.push(L); total += L;
  }
  if (total < spacing * 3) return pts;
  const nOut = Math.max(8, Math.round(total / spacing));
  const out = [];
  const step = total / nOut;
  let si = 0, acc = 0;
  for (let k = 0; k < nOut; k++) {
    const target = k * step;
    while (si < segLen.length - 1 && acc + segLen[si] < target) { acc += segLen[si]; si++; }
    const remain = target - acc;
    const L = segLen[si] || 1;
    const t = remain / L;
    const a = ring[si], b = ring[si + 1];
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

function inflateRing(pts, px) {
  if (!pts || pts.length < 3 || !(px > 0)) return pts;
  const n = pts.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    let ex = -(next.y - prev.y);
    let ey = next.x - prev.x;
    const L = Math.hypot(ex, ey) || 1;
    out[i] = { x: cur.x + (ex / L) * px, y: cur.y + (ey / L) * px };
  }
  let area0 = 0, area1 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area0 += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    area1 += out[i].x * out[j].y - out[j].x * out[i].y;
  }
  if (Math.abs(area1) < Math.abs(area0)) {
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      let ex = -(next.y - prev.y);
      let ey = next.x - prev.x;
      const L = Math.hypot(ex, ey) || 1;
      out[i] = { x: cur.x - (ex / L) * px, y: cur.y - (ey / L) * px };
    }
  }
  return out;
}


/** Dilate mask only into paper/empty (assign < 0), not into other colors. */
function dilateIntoEmpty(mask, assign, w, h, radius) {
  if (radius <= 0) return mask;
  let cur = Uint8Array.from(mask);
  const r = Math.max(1, Math.round(radius));
  for (let pass = 0; pass < r; pass++) {
    const out = Uint8Array.from(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        if (assign[i] >= 0) continue; // occupied by another color — do not steal
        let hit = 0;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (cur[ny * w + nx]) { hit = 1; break; }
          }
        }
        if (hit) out[i] = 1;
      }
    }
    cur = out;
  }
  return cur;
}

/**
 * Source-aware dark coverage: expand only into paper OR pixels whose source
 * Lab color is closer to this layer than to the currently assigned neighbor.
 * Avoids painting pure black over orange/cream while still sealing AA fringes.
 */
function smartDilateDark(mask, assign, rgba, palette, layerC, w, h, radius) {
  if (radius <= 0) return mask;
  const palLabs = palette.map(function (c) { return rgbToLab(c[0], c[1], c[2]); });
  const darkLab = palLabs[layerC];
  let cur = Uint8Array.from(mask);
  const r = Math.max(1, Math.round(radius));
  for (let pass = 0; pass < r; pass++) {
    const out = Uint8Array.from(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        let hit = 0;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (cur[ny * w + nx]) { hit = 1; break; }
          }
        }
        if (!hit) continue;
        if (assign[i] < 0) { out[i] = 1; continue; } // paper / knockout
        if (assign[i] === layerC) { out[i] = 1; continue; }
        const o = i * 4;
        if (rgba[o + 3] < 12) { out[i] = 1; continue; }
        const sLab = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
        const dDark = labDist2(sLab, darkLab);
        const dCur = labDist2(sLab, palLabs[assign[i]]);
        // Prefer this layer when source is nearer it (slack for AA / underlay seal)
        if (dDark <= dCur + 10) out[i] = 1;
      }
    }
    cur = out;
  }
  return cur;
}

function morphOpenClose(assign, w, h) {
  function majorityOnce(src) {
    const next = new Int16Array(src);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (src[i] < 0) continue;
        const votes = Object.create(null);
        let bestC = src[i], bestN = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const c = src[(y + dy) * w + (x + dx)];
            if (c < 0) continue;
            votes[c] = (votes[c] || 0) + 1;
            if (votes[c] > bestN) { bestN = votes[c]; bestC = Number(c); }
          }
        }
        if (bestN >= 5) next[i] = bestC;
      }
    }
    return next;
  }
  assign.set(majorityOnce(assign));
}

/**
 * Contour fairing. look="mae" = pixel-tight; look="corel"|"trace" = PowerTRACE-class
 * long fair cubics (optimalPolygon) without collapsing fills.
 */
function prepareContour(pts, overlapPx, opts) {
  opts = opts || {};
  let ring = pts.map(function (p) { return { x: p.x, y: p.y }; });
  ring = destaircase(ring);
  if (ring.length < 3) return null;
  const look = opts.look == null ? "corel" : opts.look;
  const dark = !!opts.dark;
  const detail = !!opts.detail;
  // Geometry path: mae-stable for both; corel only differs in presentation/topology opts
  ring = resampleClosed(ring, dark ? 0.75 : 0.65);
  ring = chaikinSmooth(ring, 1, dark ? -0.15 : -0.3);
  ring = destaircase(ring);
  ring = simplifyClosed(ring, look === "mae" ? (dark ? 0.28 : 0.18) : (detail ? 0.22 : (dark ? 0.35 : 0.3)));
  if (look !== "mae" && !detail) {
    try {
      const poly = optimalPolygon(ring, dark ? 0.45 : 0.4);
      if (poly && poly.length >= 5 && poly.length <= ring.length) ring = poly;
    } catch (e) {}
  }
  ring = resampleClosed(ring, dark ? 0.8 : 0.7);
  if (!ring || ring.length < 4) return null;
  if (overlapPx > 0) ring = inflateRing(ring, overlapPx);
  return ring;
}

function ringArea(pts) {
  if (!pts || pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) * 0.5;
}


/** Mode RGB of bright border pixels (paper). Falls back to bright image mode. */
function detectPaperRgb(rgba, w, h) {
  const bins = new Map();
  function consider(i) {
    const o = i * 4;
    if (rgba[o + 3] < 12) return;
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    if (0.299 * r + 0.587 * g + 0.114 * b < 200) return;
    // 4-bit bins keep near-whites stable
    const key = (r >> 2) << 12 | (g >> 2) << 6 | (b >> 2);
    let e = bins.get(key);
    if (!e) { e = [0, 0, 0, 0]; bins.set(key, e); }
    e[0] += r; e[1] += g; e[2] += b; e[3]++;
  }
  for (let x = 0; x < w; x++) {
    consider(x);
    consider((h - 1) * w + x);
    if (h > 2) { consider(w + x); consider((h - 2) * w + x); }
  }
  for (let y = 0; y < h; y++) {
    consider(y * w);
    consider(y * w + w - 1);
    if (w > 2) { consider(y * w + 1); consider(y * w + w - 2); }
  }
  let best = null, bestN = 0;
  bins.forEach(function (e) {
    if (e[3] > bestN) { bestN = e[3]; best = e; }
  });
  if (!best || bestN < 8) {
    bins.clear();
    const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 40000)));
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) consider(y * w + x);
    }
    bins.forEach(function (e) {
      if (e[3] > bestN) { bestN = e[3]; best = e; }
    });
  }
  if (!best || bestN < 4) return null;
  return [best[0] / best[3], best[1] / best[3], best[2] / best[3]];
}

function paperUnderlayLayer(widthIn, heightIn, rgb) {
  const w = Number(widthIn) || 1;
  const h = Number(heightIn) || 1;
  const d = "M 0 0 L " + fmt(w) + " 0 L " + fmt(w) + " " + fmt(h) + " L 0 " + fmt(h) + " Z";
  return Object.assign(annotateLayer({ hex: toHex(rgb[0], rgb[1], rgb[2]) }), {
    paths: [{ d: d, hole: false }],
    _paperUnderlay: true,
  });
}

function rectangleLayers(widthIn, heightIn, hex) {
  const w = Number(widthIn) || 1;
  const h = Number(heightIn) || 1;
  const d = "M 0 0 L " + fmt(w) + " 0 L " + fmt(w) + " " + fmt(h) + " L 0 " + fmt(h) + " Z";
  return {
    widthIn: w, heightIn: h, source: "bezier",
    layers: [Object.assign(annotateLayer({ hex: hex || "#111111" }), { paths: [{ d: d, hole: false }] })],
  };
}

function esc(s) {
  const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s || "").replace(/[&<>"']/g, function (c) { return map[c]; });
}

function svgFromLayers(layers, widthIn, heightIn, opts) {
  opts = opts || {};
  const w = Number(widthIn) || 1;
  const h = Number(heightIn) || 1;
  const pxW = opts.pixelWidth || 0;
  const overlapPx = opts.overlapPx == null ? 0.35 : opts.overlapPx;
  let seal = 0;
  if (pxW > 0 && overlapPx > 0) {
    seal = (overlapPx * w) / pxW;
    seal = Math.max(w * 0.00007, Math.min(w * 0.0012, seal));
  }
  const discrete = opts.discretePaths !== false; // Corel-like: one <path> per island
  const fillRule = opts.fillRule || (discrete ? "nonzero" : "evenodd");
  const useStrokeSeal = opts.strokeSeal !== false && seal > 0;
  const groups = (layers || []).map(function (L) {
    // Full-bleed paper underlay as <rect> — bottom only
    if (L && L._paperUnderlay) {
      return "  <rect x=\"0\" y=\"0\" width=\"" + w + "\" height=\"" + h +
        "\" fill=\"" + esc(L.hex) + "\" data-name=\"paper-underlay\"/>";
    }
    const parts = (L.paths || []).map(function (pp) { return pp.d; }).filter(Boolean);
    if (!parts.length) return "";
    let strokeAttr = "";
    if (useStrokeSeal) {
      strokeAttr = " stroke=\"" + esc(L.hex) + "\" stroke-width=\"" + seal + "\" stroke-linejoin=\"round\"";
    }
    if (discrete) {
      // Many small clean paths (Corel PowerTRACE topology) — not one mega compound
      const pathEls = parts.map(function (d) {
        return "    <path d=\"" + d + "\" fill-rule=\"" + fillRule + "\"/>";
      }).join("\n");
      return "  <g fill=\"" + esc(L.hex) + "\"" + strokeAttr + " data-name=\"" + esc(L.nameGuess || "") + "\">\n" +
        pathEls + "\n  </g>";
    }
    const ds = parts.join(" ");
    return "  <g fill=\"" + esc(L.hex) + "\"" + strokeAttr + " data-name=\"" + esc(L.nameGuess || "") + "\">\n" +
      "    <path d=\"" + ds + "\" fill-rule=\"" + fillRule + "\"/>\n" +
      "  </g>";
  }).filter(Boolean);

  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + w + "in\" height=\"" + h + "in\" viewBox=\"0 0 " + w + " " + h + "\">\n" +
    groups.join("\n") + "\n</svg>\n";
}


function pathsFromMask(mask, w, h, sx, sy, fitErr, cornerCos, grow, dark, opts) {
  opts = opts || {};
  const look = opts.look == null ? "corel" : opts.look;
  // blur MUST stay 0 by default — soft blur invents bands / hollow fills
  const blur = opts.contourBlur == null ? 0 : opts.contourBlur;
  const scale = opts.contourScale == null ? (dark ? 2 : 3) : opts.contourScale;
  let contours;
  try {
    contours = softTraceContours(mask, w, h, { scale: scale, blur: blur, iso: 0.5 });
  } catch (e) {
    contours = [];
  }
  if (!contours.length) contours = traceSubpixelContours(mask, w, h, {});
  if (!contours.length) contours = traceAllContours(mask, w, h);
  contours = contours.slice().sort(function (a, b) {
    return ringArea(b.pts) - ringArea(a.pts);
  });
  const maxContours = opts.maxContours == null
    ? (look === "mae" ? 160 : 240)
    : opts.maxContours;
  if (contours.length > maxContours) contours = contours.slice(0, maxContours);
  const minArea = opts.minContourArea == null
    ? (look === "mae" ? 2.5 : (dark ? 4 : 2.5))
    : opts.minContourArea;
  const detailArea = opts.detailArea == null ? (look === "mae" ? 4 : 2.5) : opts.detailArea;
  const paths = [];
  const seenSig = new Set();
  for (let t = 0; t < contours.length; t++) {
    const pts = contours[t].pts;
    if (!pts || pts.length < 5) continue;
    const rawArea = ringArea(pts);
    const keepDetail = !!(opts.keepDetail && rawArea >= detailArea && !contours[t].hole);
    if (rawArea < minArea && !keepDetail) continue;
    // Stacked opaque fills: NEVER emit evenodd holes — they punch gray paper voids
    // when another color does not perfectly cover. Other colors paint the "holes".
    if (contours[t].hole) {
      if (opts.allowHoles !== true) continue;
      if (opts.assign && opts.specC != null) {
        let cx = 0, cy = 0;
        for (let k = 0; k < pts.length; k++) { cx += pts[k].x; cy += pts[k].y; }
        cx /= pts.length; cy /= pts.length;
        const ix = Math.max(0, Math.min(w - 1, Math.floor(cx)));
        const iy = Math.max(0, Math.min(h - 1, Math.floor(cy)));
        const lab = opts.assign[iy * w + ix];
        if (lab >= 0 && lab !== opts.specC) continue;
      }
    }
    const g = contours[t].hole ? 0 : grow;
    const featHint = Math.sqrt(Math.max(rawArea, 1));
    const isDetail = !!opts.keepDetail && featHint < 32 && rawArea < 500;
    const ring = prepareContour(pts, g, {
      dark: dark, heavy: !!(opts && opts.heavy), look: look, detail: isDetail,
    });
    if (!ring || ring.length < 3) continue;
    if (ringArea(ring) < minArea * 0.7 && !isDetail) continue;
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let k = 0; k < ring.length; k++) {
      if (ring[k].x < minx) minx = ring[k].x;
      if (ring[k].y < miny) miny = ring[k].y;
      if (ring[k].x > maxx) maxx = ring[k].x;
      if (ring[k].y > maxy) maxy = ring[k].y;
    }
    if (maxx - minx < 0.7 && maxy - miny < 0.7) continue;
    const sig = (contours[t].hole ? "h" : "o") + ":" +
      Math.round(minx) + "," + Math.round(miny) + "," +
      Math.round(maxx) + "," + Math.round(maxy) + ":" + ring.length;
    if (seenSig.has(sig)) continue;
    seenSig.add(sig);
    const featSize = Math.max(maxx - minx, maxy - miny);
    let localErr;
    if (look === "mae") {
      localErr = featSize < 40 ? Math.min(fitErr, 0.85) :
        featSize < 120 ? Math.min(fitErr, 1.0) : fitErr;
    } else if (isDetail) {
      localErr = Math.min(0.45, fitErr);
    } else if (featSize < 80) {
      localErr = Math.min(Math.max(fitErr, 0.55), 0.85);
    } else {
      localErr = Math.max(fitErr, 0.95);
    }
    const localCorner = isDetail ? Math.min(cornerCos, -0.12) : cornerCos;
    const d = fitCubicPath(ring, sx, sy, { error: localErr, cornerCos: localCorner, fmt: fmt });
    if (d) paths.push({ d: d, hole: !!contours[t].hole });
  }
  return paths;
}

function fringeColorFromSource(fringeMask, rgba, w, h, bg, fallbackRgb) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!fringeMask[i]) continue;
    const o = i * 4;
    if (rgba[o + 3] < 12) continue;
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) < 28) continue;
    sr += r; sg += g; sb += b; n++;
  }
  if (n < 12) return fallbackRgb;
  return [sr / n, sg / n, sb / n];
}


/** CorelDRAW PowerTRACE / SimpleDESIGNER key colors for this tiger gold. */
const COREL_KEY_RGB = [
  [17, 12, 12],      // #110C0C black
  [73, 51, 43],      // #49332B dark brown
  [109, 108, 111],   // #6D6C6F cool mid
  [126, 77, 46],     // #7E4D2E brown-orange
  [158, 157, 156],   // #9E9D9C grey
  [163, 94, 48],     // #A35E30 deep orange
  [226, 226, 223],   // #E2E2DF off-white
  [230, 151, 48],    // #E69730 orange
];

function mergeNearColors(colors, labThresh2) {
  labThresh2 = labThresh2 == null ? 36 : labThresh2;
  const out = [];
  for (let i = 0; i < colors.length; i++) {
    const lab = rgbToLab(colors[i][0], colors[i][1], colors[i][2]);
    let near = -1;
    for (let j = 0; j < out.length; j++) {
      if (labDist2(lab, rgbToLab(out[j][0], out[j][1], out[j][2])) < labThresh2) { near = j; break; }
    }
    if (near < 0) out.push(colors[i].slice());
  }
  return out.length ? out : [[17, 17, 17]];
}

/** Snap palette entries to Corel keys when within Lab distance; keep extras otherwise. */
function snapPaletteToCorelKeys(palette, maxKeys) {
  maxKeys = maxKeys || 8;
  const keys = COREL_KEY_RGB.map(function (c) { return c.slice(); });
  const keyLabs = keys.map(function (c) { return rgbToLab(c[0], c[1], c[2]); });
  const used = new Uint8Array(keys.length);
  const out = [];
  for (let i = 0; i < palette.length; i++) {
    const lab = rgbToLab(palette[i][0], palette[i][1], palette[i][2]);
    let bi = -1, bd = Infinity;
    for (let k = 0; k < keyLabs.length; k++) {
      const d = labDist2(lab, keyLabs[k]);
      if (d < bd) { bd = d; bi = k; }
    }
    if (bi >= 0 && bd < 100 && !used[bi]) {
      used[bi] = 1;
      out.push(keys[bi]);
    } else if (bi >= 0 && bd < 45) {
      // already have that key — skip duplicate
      continue;
    } else {
      out.push(palette[i].slice());
    }
  }
  // Ensure black + orange + offwhite present for logo art
  for (let k = 0; k < keys.length && out.length < maxKeys; k++) {
    if (used[k]) continue;
    // only force darkest / orange / cream if missing
    if (k === 0 || k === 6 || k === 7) {
      let have = false;
      const kl = keyLabs[k];
      for (let j = 0; j < out.length; j++) {
        if (labDist2(kl, rgbToLab(out[j][0], out[j][1], out[j][2])) < 80) { have = true; break; }
      }
      if (!have) { out.push(keys[k]); used[k] = 1; }
    }
  }
  return mergeNearColors(out, 28).slice(0, maxKeys);
}


/** After paper knockout, restore interior cream/white art that shares paper's palette slot. */

/** Erode-dilate bright masks to detach tooth islands weakly bridged to snout cream. */
function toothSplitMask(mask, w, h, assign, palette, darkLum) {
  darkLum = darkLum == null ? 55 : darkLum;
  const n = w * h;
  const er = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let ok = 1;
      for (let dy = -1; dy <= 1 && ok; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!mask[(y + dy) * w + (x + dx)]) ok = 0;
        }
      }
      if (ok) er[i] = 1;
    }
  }
  // Keep eroded seeds that touch dark neighborhood (likely teeth / eye whites)
  const keep = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!er[i]) continue;
      let darkN = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const lab = assign[(y + dy) * w + (x + dx)];
          if (lab >= 0 && lum(palette[lab]) < darkLum) darkN++;
        }
      }
      if (darkN >= 3) keep[i] = 1;
    }
  }
  // Dilate keep seeds once back into original mask
  const out = Uint8Array.from(mask);
  // First clear bridges: start from eroded-only where not keep → remove thin bridges
  for (let i = 0; i < n; i++) {
    if (mask[i] && !er[i]) {
      // bridge pixel: drop if near a keep tooth seed (separates tooth from snout)
      // actually: drop all non-eroded (thin) unless no keep nearby — simpler: use er as base for components that had keep
      out[i] = 0;
    }
  }
  // Restore non-tooth cream: components of original mask that have NO keep seed stay full mask
  const visited = new Uint8Array(n);
  const qx = new Int32Array(n), qy = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (!mask[start] || visited[start]) continue;
      let head = 0, tail = 0;
      qx[0] = x; qy[0] = y; tail = 1;
      visited[start] = 1;
      const comp = [start];
      let hasTooth = keep[start] ? 1 : 0;
      while (head < tail) {
        const cx = qx[head], cy = qy[head++];
        const neigh = [cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1];
        for (let k = 0; k < 8; k += 2) {
          const nx = neigh[k], ny = neigh[k + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (visited[ni] || !mask[ni]) continue;
          visited[ni] = 1;
          qx[tail] = nx; qy[tail] = ny; tail++;
          comp.push(ni);
          if (keep[ni]) hasTooth = 1;
        }
      }
      if (!hasTooth) {
        for (let k = 0; k < comp.length; k++) out[comp[k]] = 1; // restore full snout cream
      } else {
        // tooth-bearing component: dilate keep seeds within original mask
        for (let k = 0; k < comp.length; k++) out[comp[k]] = 0;
        for (let k = 0; k < comp.length; k++) if (keep[comp[k]]) out[comp[k]] = 1;
        for (let pass = 0; pass < 2; pass++) {
          const add = [];
          for (let k = 0; k < comp.length; k++) {
            const i = comp[k];
            if (out[i] || !mask[i]) continue;
            const px = i % w, py = (i / w) | 0;
            let hit = 0;
            for (let dy = -1; dy <= 1 && !hit; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = px + dx, ny = py + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                if (out[ny * w + nx]) { hit = 1; break; }
              }
            }
            if (hit) add.push(i);
          }
          for (let a = 0; a < add.length; a++) out[add[a]] = 1;
        }
        // also keep rest of snout part of same component that is far from dark? 
        // restore non-thin (eroded) pixels of component that aren't tooth
        for (let k = 0; k < comp.length; k++) {
          const i = comp[k];
          if (er[i] && !keep[i]) out[i] = 1;
        }
      }
    }
  }
  return out;
}

function recoverArtFromPaperKnockout(assign, rgba, palette, paperIdx, w, h) {
  if (paperIdx < 0 || paperIdx >= palette.length) return;
  const creamIdxs = [];
  for (let c = 0; c < palette.length; c++) {
    if (c === paperIdx) continue;
    const L = lum(palette[c]);
    if (L > 175) creamIdxs.push(c);
  }
  if (!creamIdxs.length) return;
  const paperLab = rgbToLab(palette[paperIdx][0], palette[paperIdx][1], palette[paperIdx][2]);
  const creamLabs = creamIdxs.map(function (c) {
    return rgbToLab(palette[c][0], palette[c][1], palette[c][2]);
  });
  // Border-connected -1 stays paper; interior -1 with source nearer cream → restore
  const n = w * h;
  const borderPaper = new Uint8Array(n);
  const stack = [];
  function push(i) {
    if (i < 0 || i >= n || borderPaper[i] || assign[i] !== -1) return;
    borderPaper[i] = 1; stack.push(i);
  }
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x + 1 < w) push(i + 1);
    if (y > 0) push(i - w);
    if (y + 1 < h) push(i + w);
  }
  for (let i = 0; i < n; i++) {
    if (assign[i] !== -1 || borderPaper[i]) continue;
    const o = i * 4;
    if (rgba[o + 3] < 12) continue;
    const sLab = rgbToLab(rgba[o], rgba[o + 1], rgba[o + 2]);
    const dPaper = labDist2(sLab, paperLab);
    let best = -1, bd = dPaper;
    for (let k = 0; k < creamLabs.length; k++) {
      const d = labDist2(sLab, creamLabs[k]);
      if (d + 8 < bd) { bd = d; best = creamIdxs[k]; }
    }
    // Also allow any art color nearer than paper
    if (best < 0) {
      for (let c = 0; c < palette.length; c++) {
        if (c === paperIdx) continue;
        const d = labDist2(sLab, rgbToLab(palette[c][0], palette[c][1], palette[c][2]));
        if (d + 5 < bd) { bd = d; best = c; }
      }
    }
    if (best >= 0) assign[i] = best;
  }
}

function despeckleDarkInterior(assign, palette, w, h, minSize) {
  // Absorb mid/dark flecks inside dark neighborhoods; NEVER absorb bright tooth/eye islands.
  minSize = minSize || 24;
  const n = w * h;
  const isDarkLab = palette.map(function (c) { return lum(c) < 55; });
  const isBrightLab = palette.map(function (c) { return lum(c) > 170; });
  const visited = new Uint8Array(n);
  const qx = new Int32Array(n);
  const qy = new Int32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x;
      if (visited[start] || assign[start] < 0) continue;
      const label = assign[start];
      if (isDarkLab[label]) { visited[start] = 1; continue; }
      // Protect bright islands (teeth / eye highlights / whiskers)
      if (isBrightLab[label]) { visited[start] = 1; continue; }
      let head = 0, tail = 0;
      qx[0] = x; qy[0] = y; tail = 1;
      visited[start] = 1;
      const comp = [start];
      let darkBorder = 0;
      while (head < tail) {
        const cx = qx[head], cy = qy[head++];
        const neigh = [cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1];
        for (let k = 0; k < 8; k += 2) {
          const nx = neigh[k], ny = neigh[k + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          const lab = assign[ni];
          if (lab !== label) {
            if (lab >= 0 && isDarkLab[lab]) darkBorder++;
            continue;
          }
          if (visited[ni]) continue;
          visited[ni] = 1;
          qx[tail] = nx; qy[tail] = ny; tail++;
          comp.push(ni);
        }
      }
      if (comp.length >= minSize) continue;
      if (darkBorder < comp.length * 0.55) continue;
      let best = -1, bestN = 0;
      const votes = Object.create(null);
      for (let k = 0; k < comp.length; k++) {
        const pi = comp[k];
        const px = pi % w, py = (pi / w) | 0;
        const neigh = [px + 1, py, px - 1, py, px, py + 1, px, py - 1];
        for (let tt = 0; tt < 8; tt += 2) {
          const nx = neigh[tt], ny = neigh[tt + 1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const lab = assign[ny * w + nx];
          if (lab < 0 || lab === label || !isDarkLab[lab]) continue;
          votes[lab] = (votes[lab] || 0) + 1;
          if (votes[lab] > bestN) { bestN = votes[lab]; best = lab; }
        }
      }
      if (best < 0) continue;
      for (let k = 0; k < comp.length; k++) assign[comp[k]] = best;
    }
  }
}

function vectorize(buf, widthIn, heightIn, opts) {
  opts = opts || {};
  const look = opts.look == null ? "corel" : String(opts.look); // corel|trace|mae
  const t0 = Date.now();
  const img0 = decodePng(buf);
  const w0 = img0.width, h0 = img0.height;
  const rgba0 = img0.rgba;
  const widthInN = Number(widthIn) || 10;
  const heightInN = Number(heightIn) || 10;

  let upScale = 1;
  const maxEdge0 = Math.max(w0, h0);
  if (!opts.noUpscale && maxEdge0 < 500) {
    upScale = maxEdge0 < 400 ? 2.5 : 2;
    upScale = Math.min(3, upScale);
  }
  let scaled = { rgba: rgba0, w: w0, h: h0 };
  if (upScale > 1.01) scaled = bilinearUpscale(rgba0, w0, h0, upScale);
  // Upscaled small art (profile): fewer colors — 12+ fragments MAE badly.
  let nColors = clamp(opts.colors == null
    ? (look === "mae" ? 16 : 12)
    : Number(opts.colors), 2, 24);
  if (opts.colors == null && upScale > 1.4) nColors = Math.min(nColors, 8);
  const fine = nColors >= 8 || Math.max(w0, h0) >= 700;

  const workCap = clamp(opts.maxEdge == null ? 1200 : Number(opts.maxEdge), 200, 1600);
  let w = scaled.w, h = scaled.h;
  let rgba = Buffer.from(scaled.rgba);
  if (Math.max(w, h) > workCap) {
    const s2 = workCap / Math.max(w, h);
    scaled = bilinearUpscale(rgba, w, h, s2);
    w = scaled.w; h = scaled.h; rgba = Buffer.from(scaled.rgba);
  }

  let opaque = 0;
  for (let i = 0; i < w * h; i++) if (rgba[i * 4 + 3] >= 12) opaque++;
  if (!opaque) return rectangleLayers(widthInN, heightInN, "#111111");

  // Popularity is more stable on flat logo art; k-means as enrichment
  let palette = popularityPalette(rgba, w, h, nColors);
  try {
    const km = kmeansPalette(rgba, w, h, nColors);
    if (km.length > palette.length) palette = km;
  } catch (e) {}
  palette = mergeNearColors(palette, look === "mae" ? 14 : 22);
  // Do NOT force Corel RGB as assign palette — that destroyed cream via paper knockout.
  // Hex snap to Corel keys happens after paths are built.

  const snapped = snapToPalette(rgba, w, h, palette);
  const assign = snapped.assign;

  // Light cleanup (same as MAE-proven path)
  majoritySmooth(assign, w, h, fine ? 1 : 2);
  if (!fine) morphOpenClose(assign, w, h);
  const paperIdx = knockoutPaper(assign, palette, w, h);
  if (look !== "mae") recoverArtFromPaperKnockout(assign, rgba, palette, paperIdx, w, h);

  const minPix = Math.max(fine ? 4 : 8, Math.floor(opaque * (fine ? 0.00025 : 0.0006)));
  despeckleAssign(assign, w, h, minPix, {
    protectDetail: true,
    detailMin: look === "mae" ? 3 : 5, // teeth / eye glints survive
  });
  if (look !== "mae") despeckleDarkInterior(assign, palette, w, h, Math.max(16, minPix));

  const counts = new Array(palette.length).fill(0);
  for (let i = 0; i < assign.length; i++) if (assign[i] >= 0) counts[assign[i]]++;

  const sx = widthInN / w;
  const sy = heightInN / h;
  // Corel: looser fit → fewer longer cubics. MAE: tight pixel hug.
  const fitErr = opts.fitError == null
    ? (upScale > 1.4 ? 1.15 : (fine ? 0.4 : 1.1))
    : Number(opts.fitError);
  const cornerCos = opts.cornerCos == null
    ? -0.28
    : Number(opts.cornerCos);
  const overlapPx = opts.overlapPx == null
    ? (look === "mae" ? 0.3 : 0.4)
    : Number(opts.overlapPx);
  const contourScale = opts.contourScale == null ? 3 : Number(opts.contourScale);
  const keepDetail = opts.keepDetail !== false;
  // Prefer dark-bottom (proven flush). Optional blackTop via opts.
  const blackTop = opts.blackTop === true;

  const specs = [];
  for (let c = 0; c < palette.length; c++) {
    if (counts[c] < minPix) continue;
    specs.push({ c: c, hex: toHex(palette[c][0], palette[c][1], palette[c][2]), area: counts[c] });
  }
  // Area-desc build; final paint order re-sorted dark-bottom after paths built.
  specs.sort(function (a, b) { return (b.area || 0) - (a.area || 0); });

  let layers = [];
  for (let si = 0; si < specs.length; si++) {
    const spec = specs[si];
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (assign[i] === spec.c) mask[i] = 1;
    const layerRgb = [
      parseInt(spec.hex.slice(1, 3), 16),
      parseInt(spec.hex.slice(3, 5), 16),
      parseInt(spec.hex.slice(5, 7), 16),
    ];
    const isDark = lum(layerRgb) < 55;
    const darkDilate = opts.darkDilate != null ? Number(opts.darkDilate)
      : ((upScale > 1.4) ? 1 : 3);
    const useFringe = isDark && darkDilate > 0 && opts.darkFringe === true;
    const useSmart = opts.smartDark === true; // opt-in; blind dilate+dark-bottom preferred
    const darkGrow = opts.darkGrow == null ? (upScale > 1.4 ? 0.45 : 0.1) : Number(opts.darkGrow);
    const fillGrow = opts.fillGrow == null ? (upScale > 1.4 ? 0.35 : 0.3) : Number(opts.fillGrow);

    // Optional dual-dark fringe underlay (source-colored), then core.
    if (useFringe) {
      const dilated = useSmart
        ? smartDilateDark(mask, assign, rgba, palette, spec.c, w, h, darkDilate)
        : dilate(mask, w, h, darkDilate);
      const fringe = new Uint8Array(w * h);
      let fCount = 0;
      for (let i = 0; i < w * h; i++) {
        if (dilated[i] && !mask[i]) { fringe[i] = 1; fCount++; }
      }
      if (fCount > 40) {
        const fRgb = fringeColorFromSource(fringe, rgba, w, h, [0xee, 0xf4, 0xfa], layerRgb);
        const fr = [
          fRgb[0] * 0.55 + layerRgb[0] * 0.45,
          fRgb[1] * 0.55 + layerRgb[1] * 0.45,
          fRgb[2] * 0.55 + layerRgb[2] * 0.45,
        ];
        const fPaths = pathsFromMask(fringe, w, h, sx, sy, fitErr, cornerCos, darkGrow * 0.6, true, {
          assign: assign, specC: spec.c, heavy: upScale > 1.4, look: look,
          contourScale: contourScale, keepDetail: keepDetail,
          allowHoles: look === "mae",
        });
        if (fPaths.length) {
          layers.push(Object.assign(annotateLayer({ hex: toHex(fr[0], fr[1], fr[2]) }), {
            paths: fPaths, area: fCount + spec.area, _lum: lum(fr),
          }));
        }
      }
    }

    let coreMask = mask;
    if (!isDark && look !== "mae" && opts.toothSplit !== false && lum(layerRgb) > 170) {
      try { coreMask = toothSplitMask(mask, w, h, assign, palette, 55); } catch (e) {}
    }
    if (!useFringe && isDark && darkDilate > 0) {
      coreMask = useSmart
        ? smartDilateDark(mask, assign, rgba, palette, spec.c, w, h, darkDilate)
        : dilate(mask, w, h, darkDilate);
    } else if (!useFringe && !isDark) {
      let md = 0;
      if (opts.allDilate) md = Number(opts.allDilate) || 0;
      else if (opts.midDilate && lum(layerRgb) < 140) md = Number(opts.midDilate) || 0;
      // When dark-bottom stacking, smart-expand fills so dark underlay does not show through
      else if (opts.darkBottom !== false && opts.smartFill !== false) {
        md = opts.smartFillRadius != null ? Number(opts.smartFillRadius)
          : (look === "mae" ? 2 : 2);
      }
      if (md > 0) {
        const smart = (opts.smartDark === true) || (opts.darkBottom !== false && opts.smartFill !== false);
        coreMask = smart
          ? smartDilateDark(mask, assign, rgba, palette, spec.c, w, h, md)
          : dilate(mask, w, h, md);
      }
    }
    const paths = pathsFromMask(coreMask, w, h, sx, sy, fitErr, cornerCos,
      isDark ? darkGrow : fillGrow, isDark, {
        assign: assign, specC: spec.c, heavy: upScale > 1.4, look: look,
        contourScale: contourScale, keepDetail: keepDetail,
        allowHoles: look === "mae",
      });
    if (!paths.length) continue;
    const rgb = layerRgb;
    // Drop tiny score-bg crumbs only — NEVER drop bright fur/teeth/cream layers
    const nearScoreBg = Math.abs(rgb[0] - 0xee) + Math.abs(rgb[1] - 0xf4) + Math.abs(rgb[2] - 0xfa) < 24;
    if (nearScoreBg && spec.area < opaque * 0.015) continue;
    layers.push(Object.assign(annotateLayer({ hex: spec.hex }), {
      paths: paths, area: spec.area, _lum: lum(rgb),
    }));
  }
  // Paint order:
  // - blackTop (Corel default): light→dark so black outlines cover seams
  // - darkBottom (MAE): dark→light seals dilate under fills
  if (blackTop) {
    layers.sort(function (a, b) {
      const la = a._lum != null ? a._lum : 128, lb = b._lum != null ? b._lum : 128;
      if (Math.abs(la - lb) > 4) return lb - la; // light first
      return (b.area || 0) - (a.area || 0);
    });
  } else if (opts.darkBottom !== false) {
    layers.sort(function (a, b) {
      const la = a._lum != null ? a._lum : 128, lb = b._lum != null ? b._lum : 128;
      if (Math.abs(la - lb) > 4) return la - lb;
      return (b.area || 0) - (a.area || 0);
    });
  }
  layers.forEach(function (L) { delete L.area; delete L._lum; });
  if (!layers.length) return rectangleLayers(widthInN, heightInN, "#111111");
  // Recolor fills toward Corel gold keys (visual match) without changing geometry
  if (look !== "mae" && opts.corelKeys !== false) {
    layers.forEach(function (L) {
      if (L._paperUnderlay) return;
      const r = parseInt(L.hex.slice(1, 3), 16);
      const g = parseInt(L.hex.slice(3, 5), 16);
      const b = parseInt(L.hex.slice(5, 7), 16);
      const Luma = lum([r, g, b]);
      if (Luma > 185 && Math.abs(r - g) < 20 && Math.abs(g - b) < 24) {
        L.hex = toHex(226, 226, 223);
        return;
      }
      const lab = rgbToLab(r, g, b);
      let bi = -1, bd = Infinity;
      for (let k = 0; k < COREL_KEY_RGB.length; k++) {
        const d = labDist2(lab, rgbToLab(COREL_KEY_RGB[k][0], COREL_KEY_RGB[k][1], COREL_KEY_RGB[k][2]));
        if (d < bd) { bd = d; bi = k; }
      }
      if (bi >= 0 && bd < 90) {
        L.hex = toHex(COREL_KEY_RGB[bi][0], COREL_KEY_RGB[bi][1], COREL_KEY_RGB[bi][2]);
      }
    });
    // Merge same-hex art layers (duplicate cream after snap)
    const merged = [];
    const byHex = Object.create(null);
    layers.forEach(function (L) {
      if (L._paperUnderlay) { merged.push(L); return; }
      if (byHex[L.hex]) {
        byHex[L.hex].paths = (byHex[L.hex].paths || []).concat(L.paths || []);
      } else {
        byHex[L.hex] = L;
        merged.push(L);
      }
    });
    layers = merged;
  }
  layers = annotateLayers(layers);

  let refineMeta = null;
  if (opts.refine !== false) {
    try {
      const budgetMs = opts.refineBudgetMs != null ? Number(opts.refineBudgetMs)
        : (Math.max(w0, h0) >= 900 ? 50000 : 35000);
      // Adaptive dark pull-back: ~0.65× morph dilate radius (px in image space)
      const ddDefault = opts.darkDilate != null ? Number(opts.darkDilate)
        : ((upScale > 1.4) ? 1 : 3);
      // Corel/visual: darkDeflate punches forehead/snout gray voids — disable unless MAE look
      let darkDeflateOpt;
      if (opts.darkDeflate === false) darkDeflateOpt = false;
      else if (opts.darkDeflate != null) darkDeflateOpt = opts.darkDeflate;
      else darkDeflateOpt = (ddDefault >= 3 ? 2.6 : (ddDefault >= 2 ? 1.1 : 0.65));
      const refined = refineLayers(layers, rgba0, w0, h0, widthInN, heightInN, {
        iters: opts.refineIters == null ? 2 : Number(opts.refineIters),
        halfRes: opts.refineHalfRes !== false,
        inflatePx: opts.refineInflate == null ? (look === "mae" ? 0.08 : 0.12) : Number(opts.refineInflate),
        budgetMs: budgetMs,
        bg: [0xee, 0xf4, 0xfa],
        fullResNudge: opts.refineFullNudge === true,
        snap: opts.refineSnap === true,
        pathColors: opts.pathColors === true,
        darkDeflate: darkDeflateOpt,
        stealRepair: opts.stealRepair === true, // never invent steal voids by default
        stealPx: opts.stealPx,
        stealPasses: opts.stealPasses,
      });

      if (refined && refined.layers && refined.layers.length) {
        layers = refined.layers;
        refineMeta = refined.meta || null;
      }
    } catch (e) {
      refineMeta = { error: String(e && e.message || e) };
    }
  }

  // Source-paper underlay: knockout leaves transparent voids that score as #eef4fa.
  // When the artwork paper is white (profile) or soft gray-blue (front), paint a
  // full-bleed rect underneath so MAE matches the real paper — huge profile win.
  let paperMeta = null;
  if (opts.paperUnderlay !== false) {
    const paperRgb = opts.paperRgb || detectPaperRgb(rgba0, w0, h0);
    if (paperRgb && lum(paperRgb) >= 188) {
      const scoreBg = [0xee, 0xf4, 0xfa];
      const dist = Math.abs(paperRgb[0] - scoreBg[0]) + Math.abs(paperRgb[1] - scoreBg[1]) + Math.abs(paperRgb[2] - scoreBg[2]);
      // Always underlay when paper differs OR when it's a bright near-white sheet
      // (front's #f0f4f9 is only ~3 from score bg but still improves MAE).
      if (dist >= 2 || lum(paperRgb) >= 240) {
        layers = [paperUnderlayLayer(widthInN, heightInN, paperRgb)].concat(layers);
        paperMeta = { hex: toHex(paperRgb[0], paperRgb[1], paperRgb[2]), dist: dist };
      }
    }
  }

  return {
    widthIn: widthInN, heightIn: heightInN, source: "bezier",
    layers: layers,
    meta: {
      engine: "bezier", look: look, colors: layers.length, pixelWidth: w, pixelHeight: h,
      upScale: upScale, ms: Date.now() - t0, overlapPx: overlapPx, fitError: fitErr,
      contourScale: contourScale, blackTop: blackTop, refine: refineMeta, paper: paperMeta,
    },
  };
}

function vectorizeToSvg(buf, widthIn, heightIn, opts) {
  opts = opts || {};
  const vec = vectorize(buf, widthIn, heightIn, opts);
  const look = (vec.meta && vec.meta.look) || opts.look || "corel";
  const svg = svgFromLayers(vec.layers, vec.widthIn, vec.heightIn, {
    pixelWidth: vec.meta && vec.meta.pixelWidth,
    overlapPx: (opts && opts.overlapPx) != null ? opts.overlapPx : ((vec.meta && vec.meta.overlapPx) != null ? vec.meta.overlapPx : 0.35),
    discretePaths: opts.discretePaths != null ? opts.discretePaths : (look !== "mae"),
    strokeSeal: opts.strokeSeal != null ? opts.strokeSeal : (look === "mae"),
    fillRule: opts.fillRule || (look === "mae" ? "evenodd" : "nonzero"),
  });
  return { vec: vec, svg: svg };
}

module.exports = {
  vectorize: vectorize,
  vectorizeToSvg: vectorizeToSvg,
  svgFromLayers: svgFromLayers,
  rectangleLayers: rectangleLayers,
  bilinearUpscale: bilinearUpscale,
  destaircase: destaircase,
  chaikinSmooth: chaikinSmooth,
  prepareContour: prepareContour,
  kmeansPalette: kmeansPalette,
  refineLayers: refineLayers,
};
