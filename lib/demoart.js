"use strict";

const { encodePng, makeRgba } = require("./png");

function inStar(px, py, cx, cy, rOuter, rInner, n) {
  const dx = px - cx, dy = py - cy;
  const ang = Math.atan2(dy, dx) + Math.PI / 2;
  const a = (Math.PI * 2) / n;
  let t = ang % a;
  if (t < 0) t += a;
  const half = a / 2;
  const r = t < half
    ? rOuter + (rInner - rOuter) * (t / half)
    : rInner + (rOuter - rInner) * ((t - half) / half);
  return dx * dx + dy * dy <= r * r;
}

function inCircle(px, py, cx, cy, r) {
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function generateBadgePng() {
  const w = 420, h = 420;
  const rgba = makeRgba(w, h, [0, 0, 0, 0]);
  const cx = 210, cy = 210;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (inCircle(x, y, cx, cy, 188) && !inCircle(x, y, cx, cy, 168)) {
        rgba[i] = 212; rgba[i + 1] = 120; rgba[i + 2] = 60; rgba[i + 3] = 255;
      } else if (inStar(x, y, cx, cy, 140, 62, 5)) {
        const t = (y / h);
        rgba[i] = Math.round(240 - t * 40);
        rgba[i + 1] = Math.round(192 - t * 50);
        rgba[i + 2] = Math.round(144 - t * 40);
        rgba[i + 3] = 255;
      }
    }
  }
  return encodePng(w, h, rgba);
}

module.exports = { generateBadgePng };
