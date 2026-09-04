"use strict";

const { decodePng } = require("./png");
const { padMask, mooreTraceFrom, traceAllContours, simplify, simplifyClosed, optimalPolygon, traceSubpixelContours } = require("./contour");
const { nearestNamed } = require("./palettes");
const { fitCubicPath: fitCubicPathBezier } = require("./bezierfit");

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function fmt(n) {
  const x = Math.round(Number(n) * 10000) / 10000;
  if (Object.is(x, -0)) return "0";
  return String(x);
}

function parseHex(hex) {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length !== 6) return [17, 17, 17];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(r, g, b) {
  function h(n) { return ("0" + clamp(Math.round(n), 0, 255).toString(16)).slice(-2); }
  return "#" + h(r) + h(g) + h(b);
}

function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function channelRange(pixels, ch) {
  let lo = 255, hi = 0;
  for (let i = 0; i < pixels.length; i++) {
    const v = pixels[i][ch];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}

function averageColor(pixels) {
  let r = 0, g = 0, b = 0, n = pixels.length || 1;
  for (let i = 0; i < pixels.length; i++) {
    r += pixels[i][0]; g += pixels[i][1]; b += pixels[i][2];
  }
  return [r / n, g / n, b / n];
}

function medianCut(pixels, nColors) {
  nColors = clamp(nColors || 8, 2, 16);
  if (!pixels.length) return [];
  const unique = new Map();
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    const key = (p[0] << 16) | (p[1] << 8) | p[2];
    const prev = unique.get(key);
    if (prev) prev.n++;
    else unique.set(key, { rgb: [p[0], p[1], p[2]], n: 1 });
  }
  if (unique.size <= nColors) {
    return Array.from(unique.values()).map((u) => u.rgb);
  }
  const boxes = [{ pixels: pixels.slice() }];
  while (boxes.length < nColors) {
    let pick = -1, best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const px = boxes[i].pixels;
      if (px.length < 2) continue;
      const r = Math.max(channelRange(px, 0), channelRange(px, 1), channelRange(px, 2));
      if (r > best) { best = r; pick = i; }
    }
    if (pick < 0) break;
    const box = boxes.splice(pick, 1)[0];
    const px = box.pixels;
    const ranges = [channelRange(px, 0), channelRange(px, 1), channelRange(px, 2)];
    let ch = 0;
    if (ranges[1] > ranges[ch]) ch = 1;
    if (ranges[2] > ranges[ch]) ch = 2;
    px.sort((a, b) => a[ch] - b[ch]);
    const mid = Math.max(1, px.length >> 1);
    boxes.push({ pixels: px.slice(0, mid) });
    boxes.push({ pixels: px.slice(mid) });
  }
  let colors = boxes.map((b) => averageColor(b.pixels));
  colors = mergeNearLab(colors, 8 * 8);
  return colors;
}

function mergeNear(colors, thresh2) {
  const out = colors.map((c) => [c[0], c[1], c[2], 1]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) continue;
      for (let j = i + 1; j < out.length; j++) {
        if (!out[j]) continue;
        if (dist2(out[i], out[j]) <= thresh2) {
          const n = out[i][3] + out[j][3];
          out[i][0] = (out[i][0] * out[i][3] + out[j][0] * out[j][3]) / n;
          out[i][1] = (out[i][1] * out[i][3] + out[j][1] * out[j][3]) / n;
          out[i][2] = (out[i][2] * out[i][3] + out[j][2] * out[j][3]) / n;
          out[i][3] = n;
          out[j] = null;
          changed = true;
        }
      }
    }
  }
  return out.filter(Boolean).map((c) => [c[0], c[1], c[2]]);
}

function downsampleRgba(rgba, w, h, maxEdge) {
  const m = Math.max(w, h);
  if (m <= maxEdge) return { rgba: rgba, w: w, h: h };
  const scale = maxEdge / m;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * h / nh);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / nh));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * w / nw);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / nw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; n++;
        }
      }
      const di = (y * nw + x) * 4;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n; out[di + 3] = a / n;
    }
  }
  return { rgba: out, w: nw, h: nh };
}

function kmeansPlus(pixels, k, iters, weights) {
  k = clamp(k || 8, 2, 16);
  if (!pixels.length) return [];
  const unique = new Map();
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    const key = (p[0] << 16) | (p[1] << 8) | p[2];
    const prev = unique.get(key);
    const w = weights && weights[i] != null ? weights[i] : 1;
    if (prev) { prev.n++; prev.w += w; }
    else unique.set(key, { rgb: [p[0], p[1], p[2]], n: 1, w: w });
  }
  if (unique.size <= k) return Array.from(unique.values()).map((u) => u.rgb);

  let sample = pixels;
  let sampleW = weights;
  if (pixels.length > 80000) {
    const step = Math.ceil(pixels.length / 80000);
    sample = [];
    sampleW = weights ? [] : null;
    for (let i = 0; i < pixels.length; i += step) {
      sample.push(pixels[i]);
      if (sampleW) sampleW.push(weights[i]);
    }
  }
  const labs = sample.map((p) => rgbToLab(p[0], p[1], p[2]));
  const centers = [];
  const centerLabs = [];
  let seed = 0;
  if (sampleW) {
    let bestW = -1;
    for (let i = 0; i < sample.length; i++) {
      if (sampleW[i] > bestW) { bestW = sampleW[i]; seed = i; }
    }
  }
  centers.push([sample[seed][0], sample[seed][1], sample[seed][2]]);
  centerLabs.push(labs[seed]);
  const d2 = new Float64Array(sample.length);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < sample.length; i++) {
      let best = Infinity;
      for (let j = 0; j < centerLabs.length; j++) {
        const d = labDist2(labs[i], centerLabs[j]);
        if (d < best) best = d;
      }
      const w = sampleW ? (1 + sampleW[i]) : 1;
      d2[i] = best * w;
      sum += d2[i];
    }
    if (sum <= 0) break;
    let r = sum * ((c * 9973 % 10000) / 10000);
    let pick = sample.length - 1;
    for (let i = 0; i < sample.length; i++) {
      r -= d2[i];
      if (r <= 0) { pick = i; break; }
    }
    centers.push([sample[pick][0], sample[pick][1], sample[pick][2]]);
    centerLabs.push(labs[pick]);
  }
  for (let iter = 0; iter < (iters || 12); iter++) {
    const sums = [];
    for (let c = 0; c < centers.length; c++) sums.push([0, 0, 0, 0]);
    for (let i = 0; i < sample.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < centerLabs.length; c++) {
        const d = labDist2(labs[i], centerLabs[c]);
        if (d < bd) { bd = d; bi = c; }
      }
      const w = sampleW ? (1 + sampleW[i]) : 1;
      sums[bi][0] += sample[i][0] * w;
      sums[bi][1] += sample[i][1] * w;
      sums[bi][2] += sample[i][2] * w;
      sums[bi][3] += w;
    }
    let moved = false;
    for (let c = 0; c < centers.length; c++) {
      if (!sums[c][3]) continue;
      const nr = sums[c][0] / sums[c][3];
      const ng = sums[c][1] / sums[c][3];
      const nb = sums[c][2] / sums[c][3];
      if (Math.abs(nr - centers[c][0]) + Math.abs(ng - centers[c][1]) + Math.abs(nb - centers[c][2]) > 0.35) moved = true;
      centers[c] = [nr, ng, nb];
      centerLabs[c] = rgbToLab(nr, ng, nb);
    }
    if (!moved) break;
  }
  return mergeNearLab(centers, 6 * 6);
}

function majoritySmooth(assign, w, h, passes) {
  const n = w * h;
  for (let p = 0; p < (passes || 2); p++) {
    const next = new Int16Array(assign);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (assign[i] < 0) continue;
        const votes = Object.create(null);
        let bestC = assign[i], bestN = 0, total = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const c = assign[(y + dy) * w + (x + dx)];
            if (c < 0) continue;
            total++;
            votes[c] = (votes[c] || 0) + 1;
            if (votes[c] > bestN) { bestN = votes[c]; bestC = Number(c); }
          }
        }
        if (total >= 6 && bestN >= 5) next[i] = bestC;
      }
    }
    assign.set(next);
  }
}

function despeckleAssign(assign, w, h, minArea) {
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (assign[start] < 0 || seen[start]) continue;
    const color = assign[start];
    let top = 0, area = 0;
    stack[top++] = start;
    seen[start] = 1;
    const cells = [];
    const border = Object.create(null);
    while (top) {
      const i = stack[--top];
      cells.push(i);
      area++;
      const x = i % w, y = (i / w) | 0;
      if (x > 0) {
        const j = i - 1;
        if (assign[j] === color && !seen[j]) { seen[j] = 1; stack[top++] = j; }
        else if (assign[j] >= 0 && assign[j] !== color) border[assign[j]] = (border[assign[j]] || 0) + 1;
      }
      if (x + 1 < w) {
        const j = i + 1;
        if (assign[j] === color && !seen[j]) { seen[j] = 1; stack[top++] = j; }
        else if (assign[j] >= 0 && assign[j] !== color) border[assign[j]] = (border[assign[j]] || 0) + 1;
      }
      if (y > 0) {
        const j = i - w;
        if (assign[j] === color && !seen[j]) { seen[j] = 1; stack[top++] = j; }
        else if (assign[j] >= 0 && assign[j] !== color) border[assign[j]] = (border[assign[j]] || 0) + 1;
      }
      if (y + 1 < h) {
        const j = i + w;
        if (assign[j] === color && !seen[j]) { seen[j] = 1; stack[top++] = j; }
        else if (assign[j] >= 0 && assign[j] !== color) border[assign[j]] = (border[assign[j]] || 0) + 1;
      }
    }
    if (area >= minArea) continue;
    let best = -1, bestN = -1;
    for (const k in border) {
      if (border[k] > bestN) { bestN = border[k]; best = Number(k); }
    }
    if (best < 0) continue;
    for (let c = 0; c < cells.length; c++) assign[cells[c]] = best;
  }
}


function rgbToLab(r, g, b) {
  function lin(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const R = lin(r), G = lin(g), B = lin(b);
  let x = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
  let y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  let z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
  x /= 0.95047; y /= 1; z /= 1.08883;
  function f(t) { return t > 0.008856 ? Math.cbrt(t) : (7.787037 * t + 16 / 116); }
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labDist2(a, b) {
  const dL = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return dL * dL + da * da + db * db;
}

function mergeNearLab(colors, de2) {
  const labs = colors.map((c) => rgbToLab(c[0], c[1], c[2]));
  const out = colors.map((c, i) => [c[0], c[1], c[2], 1, labs[i]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) continue;
      for (let j = i + 1; j < out.length; j++) {
        if (!out[j]) continue;
        if (labDist2(out[i][4], out[j][4]) <= de2) {
          const n = out[i][3] + out[j][3];
          out[i][0] = (out[i][0] * out[i][3] + out[j][0] * out[j][3]) / n;
          out[i][1] = (out[i][1] * out[i][3] + out[j][1] * out[j][3]) / n;
          out[i][2] = (out[i][2] * out[i][3] + out[j][2] * out[j][3]) / n;
          out[i][3] = n;
          out[i][4] = rgbToLab(out[i][0], out[i][1], out[i][2]);
          out[j] = null;
          changed = true;
        }
      }
    }
  }
  return out.filter(Boolean).map((c) => [c[0], c[1], c[2]]);
}

function lumAt(rgba, i) {
  return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
}

function sobelMagnitude(rgba, w, h) {
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = lumAt(rgba, ((y - 1) * w + (x - 1)) * 4);
      const tc = lumAt(rgba, ((y - 1) * w + x) * 4);
      const tr = lumAt(rgba, ((y - 1) * w + (x + 1)) * 4);
      const ml = lumAt(rgba, (y * w + (x - 1)) * 4);
      const mr = lumAt(rgba, (y * w + (x + 1)) * 4);
      const bl = lumAt(rgba, ((y + 1) * w + (x - 1)) * 4);
      const bc = lumAt(rgba, ((y + 1) * w + x) * 4);
      const br = lumAt(rgba, ((y + 1) * w + (x + 1)) * 4);
      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      mag[i] = Math.abs(gx) + Math.abs(gy);
    }
  }
  return mag;
}

function morphOpenClose(assign, w, h) {
  function erodeOnce(src) {
    const out = new Int16Array(src);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const c = src[i];
        if (c < 0) continue;
        if (src[i - 1] !== c || src[i + 1] !== c || src[i - w] !== c || src[i + w] !== c) {
          const votes = Object.create(null);
          let best = c, bestN = 0;
          const neigh = [src[i - 1], src[i + 1], src[i - w], src[i + w]];
          for (let k = 0; k < 4; k++) {
            const v = neigh[k];
            if (v < 0) continue;
            votes[v] = (votes[v] || 0) + 1;
            if (votes[v] > bestN) { bestN = votes[v]; best = v; }
          }
          out[i] = best;
        }
      }
    }
    return out;
  }
  function dilateOnce(src) {
    const out = new Int16Array(src);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (src[i] >= 0) continue;
        const votes = Object.create(null);
        let best = -1, bestN = 0;
        const neigh = [src[i - 1], src[i + 1], src[i - w], src[i + w]];
        for (let k = 0; k < 4; k++) {
          const v = neigh[k];
          if (v < 0) continue;
          votes[v] = (votes[v] || 0) + 1;
          if (votes[v] > bestN) { bestN = votes[v]; best = v; }
        }
        if (best >= 0) out[i] = best;
      }
    }
    return out;
  }
  let a = erodeOnce(assign);
  a = dilateOnce(a);
  a = dilateOnce(a);
  a = erodeOnce(a);
  assign.set(a);
}


function tokenizePath(d) {
  return String(d || "").match(/[MLCZHVmlczhv]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
}

function parsePathCommands(d) {
  const tokens = tokenizePath(d);
  const cmds = [];
  let i = 0, x = 0, y = 0, sx = 0, sy = 0;
  function num() { return Number(tokens[i++]); }
  function isCmd(t) { return /^[MLCZHVmlczhv]$/.test(t); }
  while (i < tokens.length) {
    let t = tokens[i++];
    if (!isCmd(t)) continue;
    const rel = t === t.toLowerCase();
    const op = t.toUpperCase();
    if (op === "Z") {
      cmds.push({ op: "Z" });
      x = sx; y = sy;
      continue;
    }
    while (i < tokens.length && !isCmd(tokens[i])) {
      if (op === "M" || op === "L") {
        let nx = num(), ny = num();
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) break;
        if (rel) { nx += x; ny += y; }
        x = nx; y = ny;
        if (op === "M" && cmds.length && cmds[cmds.length - 1].op !== "Z") {
          /* implicit extra M pairs become L after first */
        }
        const kind = (op === "M" && (cmds.length === 0 || cmds[cmds.length - 1].op === "Z" || cmds[cmds.length - 1]._moved)) ? "M" : (op === "M" ? "M" : "L");
        if (op === "M") {
          cmds.push({ op: "M", x: x, y: y, _moved: true });
          sx = x; sy = y;
          t = rel ? "l" : "L";
        } else {
          cmds.push({ op: "L", x: x, y: y });
        }
      } else if (op === "H") {
        let nx = num();
        if (!Number.isFinite(nx)) break;
        if (rel) nx += x;
        x = nx;
        cmds.push({ op: "L", x: x, y: y });
      } else if (op === "V") {
        let ny = num();
        if (!Number.isFinite(ny)) break;
        if (rel) ny += y;
        y = ny;
        cmds.push({ op: "L", x: x, y: y });
      } else if (op === "C") {
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), nx = num(), ny = num();
        if (![x1, y1, x2, y2, nx, ny].every(Number.isFinite)) break;
        if (rel) { x1 += x; y1 += y; x2 += x; y2 += y; nx += x; ny += y; }
        cmds.push({ op: "C", x1: x1, y1: y1, x2: x2, y2: y2, x: nx, y: ny });
        x = nx; y = ny;
      } else break;
      if (op === "M") {
        /* remaining pairs handled as L by flipping op above */
      }
    }
  }
  return cmds.map((c) => { delete c._moved; return c; });
}

function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function pathToPolylines(d, steps) {
  steps = steps || 10;
  const cmds = parsePathCommands(d);
  const polys = [];
  let cur = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    if (c.op === "M") {
      if (cur.length) polys.push(cur);
      cur = [{ x: c.x, y: c.y }];
      x = sx = c.x; y = sy = c.y;
    } else if (c.op === "L") {
      cur.push({ x: c.x, y: c.y });
      x = c.x; y = c.y;
    } else if (c.op === "C") {
      const p0 = { x: x, y: y };
      const p1 = { x: c.x1, y: c.y1 };
      const p2 = { x: c.x2, y: c.y2 };
      const p3 = { x: c.x, y: c.y };
      const len = Math.hypot(p3.x - p0.x, p3.y - p0.y) + Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const n = Math.max(4, Math.min(24, Math.round((steps * len) / 0.2) || steps));
      for (let s = 1; s <= n; s++) cur.push(cubicPoint(p0, p1, p2, p3, s / n));
      x = c.x; y = c.y;
    } else if (c.op === "Z") {
      if (cur.length && (cur[0].x !== x || cur[0].y !== y)) cur.push({ x: sx, y: sy });
      if (cur.length) polys.push(cur);
      cur = [];
      x = sx; y = sy;
    }
  }
  if (cur.length) polys.push(cur);
  return polys;
}

function tangentAt(pts, i) {
  const n = pts.length;
  const a = pts[(i - 1 + n) % n];
  const b = pts[i];
  const c = pts[(i + 1) % n];
  let tx = c.x - a.x, ty = c.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  return { x: tx / len, y: ty / len };
}

function fitCubicPath(pts, scaleX, scaleY, opts) {
  return fitCubicPathBezier(pts, scaleX, scaleY, Object.assign({ fmt: fmt }, opts || {}));
}


function labVariance(labs, idxs) {
  if (!idxs.length) return 0;
  let L = 0, a = 0, b = 0;
  for (let i = 0; i < idxs.length; i++) {
    const p = labs[idxs[i]];
    L += p[0]; a += p[1]; b += p[2];
  }
  const n = idxs.length;
  L /= n; a /= n; b /= n;
  let v = 0;
  for (let i = 0; i < idxs.length; i++) {
    const p = labs[idxs[i]];
    const dL = p[0] - L, da = p[1] - a, db = p[2] - b;
    v += dL * dL + da * da + db * db;
  }
  return v / n;
}

function dominantLabAxis(labs, idxs) {
  let L0 = 0, a0 = 0, b0 = 0;
  for (let i = 0; i < idxs.length; i++) {
    const p = labs[idxs[i]];
    L0 += p[0]; a0 += p[1]; b0 += p[2];
  }
  const n = idxs.length || 1;
  L0 /= n; a0 /= n; b0 /= n;
  let vL = 0, va = 0, vb = 0;
  for (let i = 0; i < idxs.length; i++) {
    const p = labs[idxs[i]];
    vL += (p[0] - L0) * (p[0] - L0);
    va += (p[1] - a0) * (p[1] - a0);
    vb += (p[2] - b0) * (p[2] - b0);
  }
  if (va >= vL && va >= vb) return 1;
  if (vb >= vL && vb >= va) return 2;
  return 0;
}

function averageRgbFromIdx(pixels, idxs) {
  let r = 0, g = 0, b = 0, n = idxs.length || 1;
  for (let i = 0; i < idxs.length; i++) {
    const p = pixels[idxs[i]];
    r += p[0]; g += p[1]; b += p[2];
  }
  return [r / n, g / n, b / n];
}

/** Recursive binary Lab split (hierarchical). Optional edge weights bias seeds. */
function hierarchicalLabPalette(pixels, nColors, weights) {
  nColors = clamp(nColors || 8, 2, 16);
  if (!pixels.length) return [];
  const labs = pixels.map((p) => rgbToLab(p[0], p[1], p[2]));
  // Dedup shortcut
  const unique = new Map();
  for (let i = 0; i < pixels.length; i++) {
    const p = pixels[i];
    const key = (p[0] << 16) | (p[1] << 8) | p[2];
    if (!unique.has(key)) unique.set(key, [p[0], p[1], p[2]]);
  }
  if (unique.size <= nColors) return Array.from(unique.values());

  // Sample for speed on huge images
  let idxs = [];
  const step = pixels.length > 100000 ? Math.ceil(pixels.length / 100000) : 1;
  for (let i = 0; i < pixels.length; i += step) idxs.push(i);

  let clusters = [idxs];
  while (clusters.length < nColors) {
    let pick = -1, best = -1;
    for (let c = 0; c < clusters.length; c++) {
      if (clusters[c].length < 2) continue;
      const score = labVariance(labs, clusters[c]) * clusters[c].length;
      if (score > best) { best = score; pick = c; }
    }
    if (pick < 0) break;
    const group = clusters.splice(pick, 1)[0];
    const axis = dominantLabAxis(labs, group);
    group.sort((i, j) => labs[i][axis] - labs[j][axis]);
    // Weighted median split if weights present
    let mid = group.length >> 1;
    if (weights) {
      let total = 0;
      for (let k = 0; k < group.length; k++) total += 1 + (weights[group[k]] || 0);
      let acc = 0, target = total * 0.5;
      for (let k = 0; k < group.length; k++) {
        acc += 1 + (weights[group[k]] || 0);
        if (acc >= target) { mid = Math.max(1, Math.min(group.length - 1, k)); break; }
      }
    }
    mid = Math.max(1, Math.min(group.length - 1, mid));
    clusters.push(group.slice(0, mid));
    clusters.push(group.slice(mid));
  }

  let colors = clusters.map((g) => averageRgbFromIdx(pixels, g));
  // Light Lab k-means refine (few iters) seeded by hierarchical centers
  const centerLabs = colors.map((c) => rgbToLab(c[0], c[1], c[2]));
  for (let iter = 0; iter < 8; iter++) {
    const sums = [];
    for (let c = 0; c < colors.length; c++) sums.push([0, 0, 0, 0]);
    for (let i = 0; i < idxs.length; i++) {
      const pi = idxs[i];
      let bi = 0, bd = Infinity;
      for (let c = 0; c < centerLabs.length; c++) {
        const d = labDist2(labs[pi], centerLabs[c]);
        if (d < bd) { bd = d; bi = c; }
      }
      const w = weights ? (1 + (weights[pi] || 0)) : 1;
      sums[bi][0] += pixels[pi][0] * w;
      sums[bi][1] += pixels[pi][1] * w;
      sums[bi][2] += pixels[pi][2] * w;
      sums[bi][3] += w;
    }
    let moved = false;
    for (let c = 0; c < colors.length; c++) {
      if (!sums[c][3]) continue;
      const nr = sums[c][0] / sums[c][3];
      const ng = sums[c][1] / sums[c][3];
      const nb = sums[c][2] / sums[c][3];
      if (Math.abs(nr - colors[c][0]) + Math.abs(ng - colors[c][1]) + Math.abs(nb - colors[c][2]) > 0.3) moved = true;
      colors[c] = [nr, ng, nb];
      centerLabs[c] = rgbToLab(nr, ng, nb);
    }
    if (!moved) break;
  }
  // Merge near-identical colors ΔE² < ~6.25 (ΔE ≈ 2.5)
  return mergeNearLab(colors, 2.5 * 2.5);
}

function mergeTinyAreas(assign, palette, palLabs, counts, minArea, deMerge) {
  deMerge = deMerge == null ? 3 * 3 : deMerge;
  // Merge palette entries that are both tiny and close in Lab
  for (let i = 0; i < palette.length; i++) {
    if (!counts[i] || counts[i] >= minArea) continue;
    let best = -1, bestD = deMerge;
    for (let j = 0; j < palette.length; j++) {
      if (i === j || !counts[j]) continue;
      const d = labDist2(palLabs[i], palLabs[j]);
      if (d < bestD) { bestD = d; best = j; }
    }
    if (best < 0) continue;
    for (let p = 0; p < assign.length; p++) if (assign[p] === i) assign[p] = best;
    counts[best] += counts[i];
    counts[i] = 0;
  }
}

/** Soft α field for AA iso-0.5: 1 inside mask, ~0.5 on anti-aliased boundary pixels. */
function softMaskField(rgba, w, h, mask, assign, palLabs, memberSet) {
  const field = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (mask[i]) { field[i] = 1; continue; }
    if (rgba[i * 4 + 3] < 12) { field[i] = 0; continue; }
    // Boundary softness from original RGB vs nearest member palette color
    let near = false;
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && mask[i - 1]) near = true;
    else if (x + 1 < w && mask[i + 1]) near = true;
    else if (y > 0 && mask[i - w]) near = true;
    else if (y + 1 < h && mask[i + w]) near = true;
    if (!near) { field[i] = 0; continue; }
    const lab = rgbToLab(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    let bestMem = Infinity, bestOut = Infinity;
    for (let c = 0; c < palLabs.length; c++) {
      const d = labDist2(lab, palLabs[c]);
      if (memberSet && memberSet.has(c)) {
        if (d < bestMem) bestMem = d;
      } else {
        if (d < bestOut) bestOut = d;
      }
    }
    bestMem = Math.sqrt(bestMem);
    bestOut = Math.sqrt(bestOut === Infinity ? bestMem + 1 : bestOut);
    field[i] = bestOut / (bestMem + bestOut + 1e-6);
  }
  return field;
}

function softMembershipField(rgba, w, h, assign, colorIdx, palLabs) {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (assign[i] === colorIdx) mask[i] = 1;
  return softMaskField(rgba, w, h, mask, assign, palLabs, new Set([colorIdx]));
}

function qualityPreset(opts) {
  const maxEdge = clamp(opts.maxEdge || 900, 200, 1400);
  const colors = clamp(opts.colors == null ? 8 : Number(opts.colors), 2, 16);
  const fine = maxEdge >= 1200 || colors >= 12;
  const simple = maxEdge <= 900 && colors <= 4;
  return {
    maxEdge: maxEdge,
    colors: colors,
    fine: fine,
    simple: simple,
    epsilon: opts.epsilon == null ? (fine ? 0.35 : simple ? 0.85 : 0.55) : Number(opts.epsilon),
    fitError: opts.fitError == null ? (fine ? 0.4 : simple ? 0.9 : 0.65) : Number(opts.fitError),
    cornerCos: fine ? 0.48 : 0.55,
    smoothPasses: fine ? 2 : 2,
    minPixFrac: fine ? 0.0007 : 0.0012,
  };
}


function lum(rgb) { return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]; }

function vectorize(buf, widthIn, heightIn, opts) {
  opts = opts || {};
  const img0 = decodePng(buf);
  const q = qualityPreset(opts);
  const maxEdge = q.maxEdge;
  const scaled = downsampleRgba(img0.rgba, img0.width, img0.height, maxEdge);
  const w = scaled.w, h = scaled.h;
  const rgba = scaled.rgba;
  const widthInN = Number(widthIn) || 1;
  const heightInN = Number(heightIn) || 1;
  const nColors = q.colors;
  const highQ = q.fine;
  const pixels = [];
  const pixIdx = [];
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3];
    if (a < 12) continue;
    pixels.push([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
    pixIdx.push(i);
  }
  if (!pixels.length) {
    return rectangleLayers(widthInN, heightInN, "#111111", "Fill");
  }

  const edgeMag = sobelMagnitude(rgba, w, h);
  let edgeMax = 1e-6;
  for (let i = 0; i < edgeMag.length; i++) if (edgeMag[i] > edgeMax) edgeMax = edgeMag[i];
  const weights = new Float32Array(pixels.length);
  for (let k = 0; k < pixels.length; k++) {
    const m = edgeMag[pixIdx[k]] / edgeMax;
    weights[k] = m * m * 4;
  }

  // 1) Lab hierarchical / recursive binary split (+ light refine, merge ΔE≲2.5)
  let palette = hierarchicalLabPalette(pixels, nColors, weights);
  if (!palette.length) palette = kmeansPlus(pixels, nColors, highQ ? 18 : 12, weights);
  if (!palette.length) return rectangleLayers(widthInN, heightInN, "#111111", "Fill");

  let palLabs = palette.map((c) => rgbToLab(c[0], c[1], c[2]));
  const assign = new Int16Array(w * h);
  assign.fill(-1);
  const counts = new Array(palette.length).fill(0);
  for (let k = 0; k < pixels.length; k++) {
    const lab = rgbToLab(pixels[k][0], pixels[k][1], pixels[k][2]);
    let bi = 0, bd = Infinity;
    for (let c = 0; c < palLabs.length; c++) {
      const d = labDist2(lab, palLabs[c]);
      if (d < bd) { bd = d; bi = c; }
    }
    assign[pixIdx[k]] = bi;
    counts[bi]++;
  }
  majoritySmooth(assign, w, h, q.smoothPasses);
  if (!q.simple) morphOpenClose(assign, w, h);
  const minPix = Math.max(highQ ? 8 : 12, Math.floor(pixels.length * q.minPixFrac));
  despeckleAssign(assign, w, h, minPix);
  counts.fill(0);
  for (let i = 0; i < assign.length; i++) if (assign[i] >= 0) counts[assign[i]]++;
  // Merge tiny near-duplicate colors (ΔE < ~3)
  mergeTinyAreas(assign, palette, palLabs, counts, minPix, 3 * 3);
  // Recompute palette averages for surviving labels
  for (let c = 0; c < palette.length; c++) {
    if (!counts[c]) continue;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < assign.length; i++) {
      if (assign[i] !== c) continue;
      r += rgba[i * 4]; g += rgba[i * 4 + 1]; b += rgba[i * 4 + 2]; n++;
    }
    if (n) {
      palette[c] = [r / n, g / n, b / n];
      palLabs[c] = rgbToLab(palette[c][0], palette[c][1], palette[c][2]);
      counts[c] = n;
    }
  }

  const edgeHits = new Array(palette.length).fill(0);
  let edgeTotal = 0;
  function edgePixel(x, y) {
    const i = y * w + x;
    if (assign[i] < 0) return;
    edgeHits[assign[i]]++;
    edgeTotal++;
  }
  for (let x = 0; x < w; x++) { edgePixel(x, 0); edgePixel(x, h - 1); }
  for (let y = 0; y < h; y++) { edgePixel(0, y); edgePixel(w - 1, y); }

  const sx = widthInN / w;
  const sy = heightInN / h;
  const dpEps = q.epsilon;
  const fitErr = q.fitError;

  // Build layer specs sorted large → small for stacked cutouts
  const specs = [];
  for (let c = 0; c < palette.length; c++) {
    if (counts[c] < minPix) continue;
    const rgb = palette[c];
    const hex = toHex(rgb[0], rgb[1], rgb[2]);
    const edgeFrac = edgeTotal ? edgeHits[c] / edgeTotal : 0;
    if (lum(rgb) > 242 && edgeFrac > 0.28) continue;
    specs.push({ c: c, hex: hex, rgb: rgb, area: counts[c] });
  }
  specs.sort((a, b) => (b.area || 0) - (a.area || 0));

  // 5) Stacked cutouts: each lower layer includes union of itself + all layers above
  // so hairline gaps disappear when drawn large→small with evenodd compound paths.
  const layers = [];
  for (let si = 0; si < specs.length; si++) {
    const spec = specs[si];
    const above = new Set();
    for (let uj = si; uj < specs.length; uj++) above.add(specs[uj].c);

    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (assign[i] >= 0 && above.has(assign[i])) mask[i] = 1;
    }

    // 2) Sub-pixel AA: Fine → soft α=0.5 iso on union mask; else 2× upsample → scale 0.5
    let contours;
    if (highQ) {
      const soft = softMaskField(rgba, w, h, mask, assign, palLabs, above);
      contours = traceSubpixelContours(mask, w, h, { softField: soft, iso: 0.5 });
    } else {
      contours = traceSubpixelContours(mask, w, h, {});
    }
    if (!contours.length) contours = traceAllContours(mask, w, h);

    // Stacked cutouts: keep union outers + true background holes only
    const paths = [];
    const seenSig = new Set();
    for (let t = 0; t < contours.length; t++) {
      let pts = contours[t].pts;
      if (pts.length < 3) continue;

      if (contours[t].hole) {
        let cx = 0, cy = 0;
        for (let k = 0; k < pts.length; k++) { cx += pts[k].x; cy += pts[k].y; }
        cx /= pts.length; cy /= pts.length;
        const ix = Math.max(0, Math.min(w - 1, Math.floor(cx)));
        const iy = Math.max(0, Math.min(h - 1, Math.floor(cy)));
        const lab = assign[iy * w + ix];
        // Skip holes that are just upper stacked colors (they'll paint over)
        if (lab >= 0 && above.has(lab) && lab !== spec.c) continue;
      }

      // 3) Potrace-style optimal polygon within ε
      pts = optimalPolygon(pts, dpEps);
      if (!pts || pts.length < 3) pts = simplifyClosed(contours[t].pts, dpEps);
      if (!pts || pts.length < 3) continue;

      // Dedupe near-identical rings
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (let k = 0; k < pts.length; k++) {
        if (pts[k].x < minx) minx = pts[k].x;
        if (pts[k].y < miny) miny = pts[k].y;
        if (pts[k].x > maxx) maxx = pts[k].x;
        if (pts[k].y > maxy) maxy = pts[k].y;
      }
      const sig = (contours[t].hole ? "h" : "o") + ":" +
        Math.round(minx * 4) + "," + Math.round(miny * 4) + "," +
        Math.round(maxx * 4) + "," + Math.round(maxy * 4) + ":" + pts.length;
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);

      // 4) Corner splice + Schneider cubics (never cubic across corners; split if over τ)
      const d = fitCubicPath(pts, sx, sy, { error: fitErr, cornerCos: q.cornerCos });
      if (d) paths.push({ d: d, hole: !!contours[t].hole });
    }
    if (!paths.length) continue;
    const named = nearestNamed(spec.hex, "vinyl") || nearestNamed(spec.hex, "thread");
    layers.push({
      hex: spec.hex,
      nameGuess: named ? named.name : ("Color " + (layers.length + 1)),
      paths: paths,
      area: spec.area,
    });
  }

  // Already large→small; strip area
  layers.forEach((L) => { delete L.area; });
  if (!layers.length) return rectangleLayers(widthInN, heightInN, "#111111", "Fill");
  return { widthIn: widthInN, heightIn: heightInN, layers: layers };
}

function rectangleLayers(widthIn, heightIn, hex, name) {
  const w = Number(widthIn) || 1;
  const h = Number(heightIn) || 1;
  const d = "M 0 0 L " + fmt(w) + " 0 L " + fmt(w) + " " + fmt(h) + " L 0 " + fmt(h) + " Z";
  return {
    widthIn: w,
    heightIn: h,
    layers: [{ hex: hex || "#111111", nameGuess: name || "Fill", paths: [{ d: d, hole: false }] }],
  };
}

function esc(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function svgFromLayers(layers, widthIn, heightIn) {
  const w = Number(widthIn) || 1;
  const h = Number(heightIn) || 1;
  const groups = (layers || []).map((L) => {
    const ds = (L.paths || []).map((p) => p.d).filter(Boolean).join(" ");
    return "  <g fill=\"" + esc(L.hex) + "\" stroke=\"none\" data-name=\"" + esc(L.nameGuess || "") + "\">\n" +
      "    <path d=\"" + ds + "\" fill-rule=\"evenodd\"/>\n" +
      "  </g>";
  });
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + w + "in\" height=\"" + h + "in\" viewBox=\"0 0 " + w + " " + h + "\">\n" +
    groups.join("\n") + "\n</svg>\n";
}

function jobVectorOrTrace(job, buf) {
  if (job && job.vector && Array.isArray(job.vector.layers) && job.vector.layers.length) {
    return job.vector;
  }
  const w = Number(job && job.width_in) || 1;
  const h = Number(job && job.height_in) || 1;
  if (buf) {
    try { return vectorize(buf, w, h); } catch (e) { /* raster-only */ }
  }
  return rectangleLayers(w, h, "#111111", "Fill");
}

module.exports = {
  vectorize,
  svgFromLayers,
  rectangleLayers,
  parsePathCommands,
  pathToPolylines,
  jobVectorOrTrace,
  fmt,
};
