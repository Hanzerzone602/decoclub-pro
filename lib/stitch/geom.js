"use strict";

const UNIT_PER_IN = 254; // 0.1 mm

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function parsePathCommands(d) {
  const tokens = String(d || "").replace(/,/g, " ").match(/[MmLlHhVvCcQqTtSsAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const cmds = [];
  let i = 0, x = 0, y = 0, sx = 0, sy = 0;
  function isCmd(t) { return /^[A-Za-z]$/.test(t); }
  function num() { return Number(tokens[i++]); }
  while (i < tokens.length) {
    if (!isCmd(tokens[i])) { i++; continue; }
    let t = tokens[i++];
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
        if (op === "M") {
          cmds.push({ op: "M", x: x, y: y });
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
      } else if (op === "Q") {
        let x1 = num(), y1 = num(), nx = num(), ny = num();
        if (![x1, y1, nx, ny].every(Number.isFinite)) break;
        if (rel) { x1 += x; y1 += y; nx += x; ny += y; }
        const c1x = x + (2 / 3) * (x1 - x), c1y = y + (2 / 3) * (y1 - y);
        const c2x = nx + (2 / 3) * (x1 - nx), c2y = ny + (2 / 3) * (y1 - ny);
        cmds.push({ op: "C", x1: c1x, y1: c1y, x2: c2x, y2: c2y, x: nx, y: ny });
        x = nx; y = ny;
      } else break;
    }
  }
  return cmds;
}

function pathToPolylines(d, steps) {
  steps = steps || 14;
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
      const n = Math.max(4, Math.min(32, Math.round((steps * len) / 0.2) || steps));
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

function layerPolys(layer, widthIn, heightIn) {
  const polys = [];
  (layer.paths || []).forEach((p) => {
    pathToPolylines(p.d, 10).forEach((pl) => {
      if (pl.length >= 2) polys.push(pl);
    });
  });
  return polys;
}

function rasterSize(widthIn, heightIn, maxSide) {
  maxSide = maxSide || 1400;
  const unitsW = Math.max(2, Math.round(widthIn * UNIT_PER_IN));
  const unitsH = Math.max(2, Math.round(heightIn * UNIT_PER_IN));
  const scale = Math.min(1, maxSide / Math.max(unitsW, unitsH));
  const mw = Math.max(2, Math.round(unitsW * scale));
  const mh = Math.max(2, Math.round(unitsH * scale));
  const unitPerPx = (widthIn * UNIT_PER_IN) / mw;
  return { mw: mw, mh: mh, unitPerPx: unitPerPx, unitsW: unitsW, unitsH: unitsH };
}

function polyBBox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, area: Math.max(0, maxX - minX) * Math.max(0, maxY - minY) };
}

function bboxStrictlyInside(a, b) {
  return a.minX > b.minX && a.maxX < b.maxX && a.minY > b.minY && a.maxY < b.maxY;
}

function fillOnePoly(mask, pts, mw, mh, sx, sy, value) {
  fillEvenOdd(mask, [pts], mw, mh, sx, sy, value);
}

function fillEvenOdd(mask, polys, mw, mh, sx, sy, value) {
  if (value == null) value = 1;
  for (let y = 0; y < mh; y++) {
    const ys = y + 0.5;
    const xs = [];
    for (let p = 0; p < polys.length; p++) {
      const pts = polys[p];
      if (!pts || pts.length < 3) continue;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const yi = pts[i].y * sy, yj = pts[j].y * sy;
        if ((yi > ys) === (yj > ys)) continue;
        const xi = pts[i].x * sx, xj = pts[j].x * sx;
        xs.push(xi + (xj - xi) * (ys - yi) / ((yj - yi) || 1e-9));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = y * mw;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = clamp(Math.floor(xs[k]), 0, mw - 1);
      const x1 = clamp(Math.ceil(xs[k + 1]), 0, mw - 1);
      for (let x = x0; x <= x1; x++) mask[row + x] = value;
    }
  }
}

function polyCentroid(pts) {
  let x = 0, y = 0, n = pts.length || 1;
  for (let i = 0; i < pts.length; i++) { x += pts[i].x; y += pts[i].y; }
  return { x: x / n, y: y / n };
}

function polyAbsArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return Math.abs(a) * 0.5;
}

function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const yi = pts[i].y, yj = pts[j].y;
    if ((yi > y) === (yj > y)) continue;
    const xi = pts[i].x, xj = pts[j].x;
    const xint = xi + (xj - xi) * (y - yi) / ((yj - yi) || 1e-9);
    if (xint > x) inside = !inside;
  }
  return inside;
}

function bboxContainsPt(bb, p) {
  return p.x >= bb.minX && p.x <= bb.maxX && p.y >= bb.minY && p.y <= bb.maxY;
}

/**
 * Sibling subpaths UNION; nested subpaths punch as holes. Even-odd of every
 * subpath in one scanline set fills concave bays between sibling islands
 * (antenna→wing chords on the bee).
 */
function nestDepths(polys) {
  const n = polys.length;
  const bbs = polys.map(polyBBox);
  const areas = polys.map(polyAbsArea);
  const cents = polys.map(polyCentroid);
  const parent = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let best = -1, bestA = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j || areas[j] <= areas[i] * 1.02) continue;
      if (!bboxContainsPt(bbs[j], cents[i])) continue;
      if (!pointInPoly(polys[j], cents[i].x, cents[i].y)) continue;
      if (areas[j] < bestA) { bestA = areas[j]; best = j; }
    }
    parent[i] = best;
  }
  const depth = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let d = 0, p = parent[i], guard = n + 1;
    while (p >= 0 && guard-- > 0) { d++; p = parent[p]; }
    depth[i] = d;
  }
  return depth;
}

function fillNested(mask, polys, mw, mh, sx, sy) {
  if (!polys || !polys.length) return;
  if (polys.length === 1) {
    fillEvenOdd(mask, polys, mw, mh, sx, sy, 1);
    return;
  }
  const depth = nestDepths(polys);
  let maxD = 0;
  for (let i = 0; i < depth.length; i++) if (depth[i] > maxD) maxD = depth[i];
  for (let d = 0; d <= maxD; d++) {
    const val = d % 2 === 0 ? 1 : 0;
    for (let i = 0; i < polys.length; i++) {
      if (depth[i] !== d) continue;
      fillOnePoly(mask, polys[i], mw, mh, sx, sy, val);
    }
  }
}

/**
 * Hull+holes evenodd leaves fat triangular bays in concave corners. Those
 * bays are much thicker than the intended stroke. Strip the fat cores and
 * the hull edge that closed them; heal nicks on real strokes.
 */
function hexLumFast(hex) {
  const s = String(hex || "").replace("#", "");
  if (s.length < 6) return 128;
  const r = parseInt(s.slice(0, 2), 16), g = parseInt(s.slice(2, 4), 16), b = parseInt(s.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function killConcaveChords(mask, w, h, hex) {
  if (hex && hexLumFast(hex) > 42) return mask;
  const st = blobStats(mask, w, h);
  if (!st || st.count < 80) return mask;
  const dt = distanceTransform(mask, w, h);
  const samples = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && dt[i] > 0.4) samples.push(dt[i]);
  }
  if (samples.length < 40) return mask;
  samples.sort((a, b) => a - b);
  const p40 = samples[Math.floor(samples.length * 0.40)];
  const median = samples[samples.length >> 1];
  const p90 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.90))];
  if (p40 > 9) return mask;
  if (!(p90 > p40 * 2.6 + 2.5)) return mask;
  const fatR = p40 * 2.15 + 1.4;
  const fatCore = new Uint8Array(mask.length);
  let fatN = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && dt[i] > fatR) { fatCore[i] = 1; fatN++; }
  }
  if (fatN < 18 || fatN / st.count > 0.62) return mask;
  const grow = Math.max(2, Math.ceil(p40 * 1.8) + 2);
  const fat = dilate(fatCore, w, h, grow);
  const thin = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && !fat[i]) thin[i] = 1;
  }
  const nick = dilate(thin, w, h, 1);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = (thin[i] || (nick[i] && mask[i] && !fatCore[i])) ? 1 : 0;
  }
  return mask;
}

function rasterizeEvenOdd(polys, widthIn, heightIn, mw, mh) {
  const mask = new Uint8Array(mw * mh);
  if (!polys || !polys.length) return mask;
  const sx = mw / (widthIn || 1);
  const sy = mh / (heightIn || 1);
  fillNested(mask, polys, mw, mh, sx, sy);
  killConcaveChords(mask, mw, mh);
  return mask;
}

/**
 * Per-path nested fill (siblings union, nested holes), then UNION across
 * paths of a color. Chord-kill per path so outline hulls lose concave bays
 * without hollowing intended fat bars on sibling paths.
 */
function rasterizeLayer(layer, widthIn, heightIn, mw, mh) {
  const mask = new Uint8Array(mw * mh);
  const sx = mw / (widthIn || 1);
  const sy = mh / (heightIn || 1);
  const paths = layer && layer.paths;
  if (paths && paths.length) {
    for (let i = 0; i < paths.length; i++) {
      const polys = pathToPolylines(paths[i].d, 16).filter((pl) => pl && pl.length >= 3);
      if (!polys.length) continue;
      const part = new Uint8Array(mw * mh);
      fillNested(part, polys, mw, mh, sx, sy);
      killConcaveChords(part, mw, mh, layer.hex);
      orMask(mask, part);
    }
    return mask;
  }
  const polys = (layer && layer.polys) || [];
  fillNested(mask, polys, mw, mh, sx, sy);
  killConcaveChords(mask, mw, mh, layer && layer.hex);
  return mask;
}

function rasterizePolys(polys, widthIn, heightIn, mw, mh) {
  return rasterizeEvenOdd(polys, widthIn, heightIn, mw, mh);
}

function blobStats(mask, w, h) {
  let minX = w, minY = h, maxX = 0, maxY = 0, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      count++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!count) return null;
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, count: count, bw: maxX - minX + 1, bh: maxY - minY + 1 };
}

function walkRun(x0, y0, x1, y1, stitchU) {
  const pts = [];
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 0.4) return [{ x: x1, y: y1 }];
  const n = Math.max(1, Math.round(len / Math.max(0.4, stitchU)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: x0 + dx * t, y: y0 + dy * t });
  }
  return pts;
}

function resamplePolyline(pts, spacing, closed) {
  if (!pts || pts.length < 2) return pts ? pts.slice() : [];
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let x0 = out[out.length - 1].x, y0 = out[out.length - 1].y;
    let x1 = pts[i].x, y1 = pts[i].y;
    let seg = Math.hypot(x1 - x0, y1 - y0);
    if (seg < 1e-6) continue;
    while (acc + seg >= spacing) {
      const t = (spacing - acc) / seg;
      const nx = x0 + (x1 - x0) * t, ny = y0 + (y1 - y0) * t;
      out.push({ x: nx, y: ny });
      x0 = nx; y0 = ny;
      seg = Math.hypot(x1 - x0, y1 - y0);
      acc = 0;
    }
    acc += seg;
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(out[out.length - 1].x - last.x, out[out.length - 1].y - last.y) > spacing * 0.25) {
    out.push({ x: last.x, y: last.y });
  }
  if (closed && out.length > 2) {
    const first = out[0];
    const end = out[out.length - 1];
    if (Math.hypot(end.x - first.x, end.y - first.y) > spacing * 0.25) out.push({ x: first.x, y: first.y });
  }
  return out;
}

function smoothPolyline(pts, passes) {
  if (!pts || pts.length < 3) return pts ? pts.slice() : [];
  let cur = pts.slice();
  const nPass = passes == null ? 2 : passes;
  for (let p = 0; p < nPass; p++) {
    const next = [cur[0]];
    for (let i = 1; i < cur.length - 1; i++) {
      next.push({
        x: cur[i].x * 0.5 + cur[i - 1].x * 0.25 + cur[i + 1].x * 0.25,
        y: cur[i].y * 0.5 + cur[i - 1].y * 0.25 + cur[i + 1].y * 0.25,
      });
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

function tangentAt(pts, i) {
  const a = pts[Math.max(0, i - 1)];
  const b = pts[Math.min(pts.length - 1, i + 1)];
  let tx = b.x - a.x, ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  return { x: tx / len, y: ty / len };
}

function distanceTransform(mask, w, h) {
  const INF = 1e9;
  const dt = new Float32Array(w * h);
  for (let i = 0; i < dt.length; i++) dt[i] = mask[i] ? 0 : INF;
  for (let i = 0; i < dt.length; i++) if (mask[i]) dt[i] = 1e9;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) { dt[y * w + x] = 0; continue; }
      let v = dt[y * w + x];
      if (x > 0) v = Math.min(v, dt[y * w + x - 1] + 1);
      if (y > 0) v = Math.min(v, dt[(y - 1) * w + x] + 1);
      if (x > 0 && y > 0) v = Math.min(v, dt[(y - 1) * w + x - 1] + 1.414);
      if (x + 1 < w && y > 0) v = Math.min(v, dt[(y - 1) * w + x + 1] + 1.414);
      dt[y * w + x] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      if (!mask[y * w + x]) { dt[y * w + x] = 0; continue; }
      let v = dt[y * w + x];
      if (x + 1 < w) v = Math.min(v, dt[y * w + x + 1] + 1);
      if (y + 1 < h) v = Math.min(v, dt[(y + 1) * w + x] + 1);
      if (x + 1 < w && y + 1 < h) v = Math.min(v, dt[(y + 1) * w + x + 1] + 1.414);
      if (x > 0 && y + 1 < h) v = Math.min(v, dt[(y + 1) * w + x - 1] + 1.414);
      dt[y * w + x] = v;
    }
  }
  return dt;
}

function maxDistance(dt, mask, w, h) {
  let m = 0;
  for (let i = 0; i < dt.length; i++) if (mask[i] && dt[i] > m) m = dt[i];
  return m;
}

function neighborCount(img, w, h, x, y) {
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (img[ny * w + nx]) n++;
    }
  }
  return n;
}

function zhangSuenThin(mask, w, h) {
  const img = new Uint8Array(mask);
  function AandB(x, y) {
    const p = [];
    const offs = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
    for (let i = 0; i < 8; i++) {
      const nx = x + offs[i][0], ny = y + offs[i][1];
      p.push(nx >= 0 && ny >= 0 && nx < w && ny < h && img[ny * w + nx] ? 1 : 0);
    }
    let a = 0, b = 0;
    for (let i = 0; i < 8; i++) {
      b += p[i];
      if (p[i] === 0 && p[(i + 1) % 8] === 1) a++;
    }
    return { a: a, b: b, p: p };
  }
  let changed = true, iter = 0;
  while (changed && iter < 80) {
    changed = false;
    iter++;
    for (let step = 0; step < 2; step++) {
      const kill = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!img[y * w + x]) continue;
          const t = AandB(x, y);
          if (t.b < 2 || t.b > 6 || t.a !== 1) continue;
          const p = t.p;
          if (step === 0) {
            if (p[0] * p[2] * p[4]) continue;
            if (p[2] * p[4] * p[6]) continue;
          } else {
            if (p[0] * p[2] * p[6]) continue;
            if (p[0] * p[4] * p[6]) continue;
          }
          kill.push(y * w + x);
        }
      }
      if (kill.length) {
        changed = true;
        for (let i = 0; i < kill.length; i++) img[kill[i]] = 0;
      }
    }
  }
  return img;
}

function traceSkeleton(skel, w, h) {
  const used = new Uint8Array(w * h);
  const paths = [];
  function nbrs(x, y) {
    const out = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (skel[ny * w + nx]) out.push({ x: nx, y: ny });
      }
    }
    return out;
  }
  const seeds = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!skel[y * w + x]) continue;
      const n = neighborCount(skel, w, h, x, y);
      if (n <= 1) seeds.push({ x: x, y: y, pri: 0 });
      else if (n >= 3) seeds.push({ x: x, y: y, pri: 1 });
    }
  }
  seeds.sort((a, b) => a.pri - b.pri);
  function walk(sx, sy) {
    if (used[sy * w + sx]) return;
    const pts = [];
    let x = sx, y = sy;
    while (true) {
      used[y * w + x] = 1;
      pts.push({ x: x, y: y });
      const ns = nbrs(x, y).filter((p) => !used[p.y * w + p.x]);
      if (!ns.length) break;
      ns.sort((a, b) => neighborCount(skel, w, h, a.x, a.y) - neighborCount(skel, w, h, b.x, b.y));
      x = ns[0].x; y = ns[0].y;
    }
    if (pts.length >= 2) paths.push(pts);
  }
  for (let i = 0; i < seeds.length; i++) walk(seeds[i].x, seeds[i].y);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (skel[y * w + x] && !used[y * w + x]) walk(x, y);
    }
  }
  return paths;
}

function mooreContour(mask, w, h) {
  const dirs = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  let sx = -1, sy = -1;
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { sx = x; sy = y; break outer; }
    }
  }
  if (sx < 0) return [];
  const pts = [];
  let x = sx, y = sy, dir = 4;
  const startKey = sy * w + sx;
  let guard = w * h * 4;
  do {
    pts.push({ x: x, y: y });
    let look = (dir + 6) % 8;
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (look + k) % 8;
      const nx = x + dirs[d][0], ny = y + dirs[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (mask[ny * w + nx]) {
        x = nx; y = ny; dir = d; found = true; break;
      }
    }
    if (!found) break;
    guard--;
  } while ((y * w + x) !== startKey && guard > 0);
  return pts;
}

function contoursWithHoles(mask, w, h, minPix) {
  const comps = connectedComponents(mask, w, h, minPix == null ? 12 : minPix);
  const out = [];
  for (let c = 0; c < comps.length; c++) {
    const comp = comps[c];
    const outer = mooreContour(comp.mask, w, h);
    if (outer.length < 8) continue;
    const bg = floodBackground(comp.mask, w, h);
    const holePix = new Uint8Array(w * h);
    for (let i = 0; i < holePix.length; i++) {
      if (!comp.mask[i] && !bg[i]) holePix[i] = 1;
    }
    const holeComps = connectedComponents(holePix, w, h, minPix == null ? 12 : minPix);
    const holes = [];
    for (let k = 0; k < holeComps.length; k++) {
      const hp = mooreContour(holeComps[k].mask, w, h);
      if (hp.length >= 8) holes.push(hp);
    }
    out.push({
      mask: comp.mask,
      count: comp.count,
      outer: outer,
      holes: holes,
      cx: comp.cx,
      cy: comp.cy,
    });
  }
  return out;
}

function erode(mask, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      let ok = 1;
      for (let dy = -r; dy <= r && ok; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) { ok = 0; break; }
        }
      }
      out[y * w + x] = ok;
    }
  }
  return out;
}

function dilate(mask, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { out[y * w + x] = 1; continue; }
      let hit = 0;
      for (let dy = -r; dy <= r && !hit; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (mask[ny * w + nx]) { hit = 1; break; }
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

function knockoutMask(mask, other, w, h) {
  const n = w * h;
  for (let i = 0; i < n; i++) {
    if (other[i]) mask[i] = 0;
  }
  return mask;
}

function orMask(dst, src) {
  const n = Math.min(dst.length, src.length);
  for (let i = 0; i < n; i++) if (src[i]) dst[i] = 1;
  return dst;
}

function andMask(a, b) {
  const n = Math.min(a.length, b.length);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i] && b[i] ? 1 : 0;
  return out;
}

function floodBackground(occupied, w, h) {
  const bg = new Uint8Array(w * h);
  const qx = new Int32Array(w * h);
  const qy = new Int32Array(w * h);
  let qh = 0, qt = 0;
  function seed(x, y) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (occupied[i] || bg[i]) return;
    bg[i] = 1;
    qx[qt] = x; qy[qt] = y; qt++;
  }
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  while (qh < qt) {
    const x = qx[qh], y = qy[qh];
    qh++;
    seed(x + 1, y); seed(x - 1, y); seed(x, y + 1); seed(x, y - 1);
  }
  return bg;
}

function copyMask(mask) {
  return Uint8Array.from(mask);
}

function scaleMask(src, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return Uint8Array.from(src);
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / dw));
      out[y * dw + x] = src[sy * sw + sx];
    }
  }
  return out;
}

function connectedComponents(mask, w, h, minPix) {
  minPix = minPix == null ? 12 : minPix;
  const seen = new Uint8Array(w * h);
  const comps = [];
  const qx = new Int32Array(w * h);
  const qy = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const seed = y * w + x;
      if (!mask[seed] || seen[seed]) continue;
      let qh = 0, qt = 0;
      qx[0] = x; qy[0] = y; qt = 1;
      seen[seed] = 1;
      const pixels = [];
      let minX = x, minY = y, maxX = x, maxY = y;
      while (qh < qt) {
        const cx = qx[qh], cy = qy[qh];
        qh++;
        pixels.push(cy * w + cx);
        if (cx < minX) minX = cx;
        if (cy < minY) minY = cy;
        if (cx > maxX) maxX = cx;
        if (cy > maxY) maxY = cy;
        const nbs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
        for (let k = 0; k < 8; k++) {
          const nx = cx + nbs[k][0], ny = cy + nbs[k][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!mask[ni] || seen[ni]) continue;
          seen[ni] = 1;
          qx[qt] = nx; qy[qt] = ny; qt++;
        }
      }
      if (pixels.length < minPix) continue;
      const cm = new Uint8Array(w * h);
      for (let i = 0; i < pixels.length; i++) cm[pixels[i]] = 1;
      comps.push({
        mask: cm,
        count: pixels.length,
        minX: minX, minY: minY, maxX: maxX, maxY: maxY,
        bw: maxX - minX + 1, bh: maxY - minY + 1,
        cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
      });
    }
  }
  comps.sort((a, b) => b.count - a.count);
  return comps;
}

function scalePolys(polys, sx, sy) {
  return (polys || []).map((pl) => pl.map((p) => ({ x: p.x * sx, y: p.y * sy })));
}

function polyLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

function longestPath(paths) {
  let best = null, bestL = -1;
  (paths || []).forEach((p) => {
    const L = polyLength(p);
    if (L > bestL) { bestL = L; best = p; }
  });
  return best;
}

module.exports = {
  UNIT_PER_IN,
  clamp,
  pathToPolylines,
  parsePathCommands,
  layerPolys,
  rasterSize,
  rasterizePolys,
  rasterizeEvenOdd,
  rasterizeLayer,
  fillNested,
  killConcaveChords,
  nestDepths,
  contoursWithHoles,
  blobStats,
  walkRun,
  resamplePolyline,
  smoothPolyline,
  tangentAt,
  distanceTransform,
  maxDistance,
  zhangSuenThin,
  traceSkeleton,
  mooreContour,
  erode,
  dilate,
  knockoutMask,
  orMask,
  andMask,
  floodBackground,
  copyMask,
  scaleMask,
  connectedComponents,
  scalePolys,
  polyLength,
  longestPath,
};
