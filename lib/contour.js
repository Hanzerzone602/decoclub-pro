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

module.exports = {
  buildMask,
  dilate,
  padMask,
  mooreTrace,
  mooreTraceFrom,
  traceAllContours,
  simplify,
  simplifyClosed,
  contourFromPngBuffer,
  svgFromContour,
  boundsPath,
  pathFromPoints,
};
