"use strict";

const { decodePng, encodePng } = require("./png");

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function chromaLumaDist(r1, g1, b1, r2, g2, b2) {
  const y1 = luma(r1, g1, b1);
  const y2 = luma(r2, g2, b2);
  const dy = y1 - y2;
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  const cr = dr - dy, cg = dg - dy, cb = db - dy;
  return Math.sqrt(0.6 * dy * dy + 0.4 * (cr * cr + cg * cg + cb * cb) / 3);
}

function clamp8(n) {
  if (n < 0) return 0;
  if (n > 255) return 255;
  return n | 0;
}

function removeBackground(buf) {
  const img = decodePng(buf);
  const w = img.width, h = img.height;
  const rgba = Buffer.from(img.rgba);
  const n = w * h;
  if (!n) return encodePng(w, h, rgba);

  const counts = Object.create(null);
  function sample(x, y) {
    const i = (y * w + x) * 4;
    if (rgba[i + 3] < 16) return;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const key = (r >> 4) + "," + (g >> 4) + "," + (b >> 4);
    let bucket = counts[key];
    if (!bucket) bucket = counts[key] = { n: 0, r: 0, g: 0, b: 0 };
    bucket.n++;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
  }
  for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { sample(0, y); sample(w - 1, y); }

  let best = null;
  Object.keys(counts).forEach(function (k) {
    if (!best || counts[k].n > best.n) best = counts[k];
  });
  const bg = best
    ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)]
    : [255, 255, 255];

  const TIGHT = 22;
  const LOOSE = 44;
  const marked = Buffer.alloc(n);

  function similar(idx, thresh) {
    const o = idx * 4;
    if (rgba[o + 3] < 16) return true;
    return chromaLumaDist(rgba[o], rgba[o + 1], rgba[o + 2], bg[0], bg[1], bg[2]) <= thresh;
  }

  const qx = [];
  const qy = [];
  function tryMark(x, y, thresh) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const idx = y * w + x;
    if (marked[idx]) return;
    if (!similar(idx, thresh)) return;
    marked[idx] = 1;
    qx.push(x);
    qy.push(y);
  }

  for (let x = 0; x < w; x++) { tryMark(x, 0, TIGHT); tryMark(x, h - 1, TIGHT); }
  for (let y = 1; y < h - 1; y++) { tryMark(0, y, TIGHT); tryMark(w - 1, y, TIGHT); }

  let qi = 0;
  while (qi < qx.length) {
    const x = qx[qi], y = qy[qi++];
    tryMark(x + 1, y, TIGHT);
    tryMark(x - 1, y, TIGHT);
    tryMark(x, y + 1, TIGHT);
    tryMark(x, y - 1, TIGHT);
  }

  qx.length = 0;
  qy.length = 0;
  qi = 0;
  for (let i = 0; i < n; i++) {
    if (marked[i]) { qx.push(i % w); qy.push((i / w) | 0); }
  }
  while (qi < qx.length) {
    const x = qx[qi], y = qy[qi++];
    tryMark(x + 1, y, LOOSE);
    tryMark(x - 1, y, LOOSE);
    tryMark(x, y + 1, LOOSE);
    tryMark(x, y - 1, LOOSE);
  }

  const SOFT = 100;
  const out = Buffer.from(rgba);
  function isBg(x, y) {
    if (x < 0 || y < 0 || x >= w || y >= h) return true;
    return marked[y * w + x] === 1;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const o = idx * 4;
      if (marked[idx]) {
        out[o + 3] = 0;
        continue;
      }
      let a = rgba[o + 3];
      let near = false;
      for (let dy = -2; dy <= 2 && !near; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx * dx + dy * dy > 5) continue;
          if (isBg(x + dx, y + dy)) near = true;
        }
      }
      if (near) {
        const cd = chromaLumaDist(rgba[o], rgba[o + 1], rgba[o + 2], bg[0], bg[1], bg[2]);
        if (cd < SOFT) {
          const t = (cd - TIGHT) / (SOFT - TIGHT);
          const aa = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * t * 255);
          if (aa < a) a = aa;
        }
      }
      out[o + 3] = a;
      if (a > 0 && a < 250) {
        const af = a / 255;
        const inv = 1 - af;
        out[o] = clamp8(Math.round((rgba[o] - bg[0] * inv) / af));
        out[o + 1] = clamp8(Math.round((rgba[o + 1] - bg[1] * inv) / af));
        out[o + 2] = clamp8(Math.round((rgba[o + 2] - bg[2] * inv) / af));
      }
    }
  }

  return encodePng(w, h, out);
}

module.exports = { removeBackground, chromaLumaDist };
