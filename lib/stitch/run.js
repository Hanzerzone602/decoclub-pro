"use strict";

const { walkRun, mooreContour, resamplePolyline, erode } = require("./geom");

function contourRun(mask, w, h, unitPerPx, opts) {
  opts = opts || {};
  const stitchPx = ((opts.stitchMm || 2.4) * 10) / unitPerPx;
  const insetPx = ((opts.insetMm || 0) * 10) / unitPerPx;
  let src = mask;
  if (insetPx >= 1) src = erode(mask, w, h, insetPx);
  const raw = mooreContour(src, w, h);
  if (raw.length < 2) return [];
  const sampled = resamplePolyline(raw, Math.max(0.8, stitchPx), true);
  return sampled;
}

function runFromPolyline(pts, stitchU) {
  if (!pts || pts.length < 2) return [];
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    walkRun(prev.x, prev.y, pts[i].x, pts[i].y, stitchU).slice(1).forEach((p) => out.push(p));
  }
  return out;
}

module.exports = { contourRun, runFromPolyline };
