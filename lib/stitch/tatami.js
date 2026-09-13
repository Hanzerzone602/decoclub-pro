"use strict";

const { walkRun, blobStats, erode } = require("./geom");
const { contourRun } = require("./run");

function inMask(mask, w, h, x, y) {
  const xi = Math.round(x), yi = Math.round(y);
  return xi >= 0 && yi >= 0 && xi < w && yi < h && mask[yi * w + xi];
}

function tatamiFill(mask, w, h, unitPerPx, opts) {
  opts = opts || {};
  const pitchU = (opts.pitchMm || 0.4) * 10;
  const staggerU = (opts.staggerMm || 2.8) * 10;
  const stitchU = (opts.stitchMm || 3.2) * 10;
  const pullU = (opts.pullMm == null ? 0.15 : opts.pullMm) * 10;
  const pitch = pitchU / unitPerPx;
  const stagger = staggerU / unitPerPx;
  const stitch = stitchU / unitPerPx;
  const pull = pullU / unitPerPx;
  const ang = ((opts.angleDeg == null ? 45 : opts.angleDeg) * Math.PI) / 180;
  const c = Math.cos(ang), s = Math.sin(ang);
  const corners = [[0, 0], [w, 0], [w, h], [0, h]];
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  corners.forEach(([x, y]) => {
    const u = x * c + y * s;
    const v = -x * s + y * c;
    if (u < uMin) uMin = u; if (u > uMax) uMax = u;
    if (v < vMin) vMin = v; if (v > vMax) vMax = v;
  });
  const stitches = [];
  let row = 0;
  for (let u = uMin; u <= uMax + 0.001; u += pitch, row++) {
    const vOff = (row % 2) ? stagger * 0.5 : 0;
    const pts = [];
    let run = null;
    const vStep = Math.max(0.35, stitch * 0.08);
    for (let v = vMin + vOff; v <= vMax; v += vStep) {
      const x = Math.round(u * c - v * s);
      const y = Math.round(u * s + v * c);
      const inside = x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
      if (inside) {
        if (!run) run = { v0: v, v1: v, x0: x, y0: y, x1: x, y1: y };
        else { run.v1 = v; run.x1 = x; run.y1 = y; }
      } else if (run) {
        pts.push(run);
        run = null;
      }
    }
    if (run) pts.push(run);
    const dir = row % 2 === 0 ? 1 : -1;
    const ordered = dir === 1 ? pts : pts.slice().reverse();
    ordered.forEach((r) => {
      let ax = r.x0, ay = r.y0, bx = r.x1, by = r.y1;
      const rx = bx - ax, ry = by - ay;
      const rlen = Math.hypot(rx, ry) || 1;
      if (rlen < 1.15) return;
      const px = (rx / rlen) * pull, py = (ry / rlen) * pull;
      let nax = ax, nay = ay, nbx = bx, nby = by;
      if (dir === 1) {
        nax -= px; nay -= py; nbx += px; nby += py;
      } else {
        nax += px; nay += py; nbx -= px; nby -= py;
      }
      if (!inMask(mask, w, h, nax, nay)) { nax = ax; nay = ay; }
      if (!inMask(mask, w, h, nbx, nby)) { nbx = bx; nby = by; }
      const a = dir === 1 ? { x: nax, y: nay } : { x: nbx, y: nby };
      const b = dir === 1 ? { x: nbx, y: nby } : { x: nax, y: nay };
      const runPts = walkRun(a.x, a.y, b.x, b.y, stitch);
      if (runPts[0]) runPts[0].jump = true;
      runPts.forEach((p) => stitches.push(p));
    });
  }
  return stitches;
}

function latticeUnderlay(mask, w, h, unitPerPx) {
  const step = (2.6 * 10) / unitPerPx;
  const stitch = (3.2 * 10) / unitPerPx;
  const pts = [];
  function pushRun(x0, y0, x1, y1) {
    const runPts = walkRun(x0, y0, x1, y1, stitch);
    if (runPts[0]) runPts[0].jump = true;
    runPts.forEach((p) => pts.push(p));
  }
  for (let y = 0; y < h; y += step) {
    let run = null;
    const yi = Math.min(h - 1, Math.round(y));
    for (let x = 0; x < w; x++) {
      if (mask[yi * w + x]) {
        if (!run) run = { x0: x, x1: x };
        else run.x1 = x;
      } else if (run) {
        pushRun(run.x0, yi, run.x1, yi);
        run = null;
      }
    }
    if (run) pushRun(run.x0, yi, run.x1, yi);
  }
  for (let x = 0; x < w; x += step) {
    let run = null;
    const xi = Math.min(w - 1, Math.round(x));
    for (let y = 0; y < h; y++) {
      if (mask[y * w + xi]) {
        if (!run) run = { y0: y, y1: y };
        else run.y1 = y;
      } else if (run) {
        pushRun(xi, run.y0, xi, run.y1);
        run = null;
      }
    }
    if (run) pushRun(xi, run.y0, xi, run.y1);
  }
  return pts;
}

function tatamiWithUnderlay(mask, w, h, unitPerPx, opts) {
  opts = opts || {};
  const under = [];
  const st = blobStats(mask, w, h);
  const mmPerPx = unitPerPx * 0.1;
  const areaMm2 = st ? st.count * mmPerPx * mmPerPx : 0;
  let kinds = (opts.underlay || ["edge-run", "lattice"]).slice();
  if (areaMm2 < 2500) kinds = kinds.filter((u) => u !== "lattice");
  if (kinds.indexOf("edge-run") !== -1) {
    contourRun(mask, w, h, unitPerPx, { stitchMm: 2.4, insetMm: 0.3 }).forEach((p) => under.push(p));
  }
  if (kinds.indexOf("zigzag") !== -1 && areaMm2 >= 420) {
    tatamiFill(mask, w, h, unitPerPx, {
      pitchMm: 1.15,
      staggerMm: 0,
      stitchMm: 3.4,
      angleDeg: ((opts.angleDeg || 45) + 90) % 180,
      pullMm: 0,
    }).forEach((p) => under.push(p));
  }
  const mmPerPx2 = unitPerPx * 0.1;
  const insetPx = Math.max(1, Math.round(0.10 / Math.max(0.04, mmPerPx2)));
  const inset = erode(mask, w, h, insetPx);
  const insetCount = blobStats(inset, w, h);
  const fill = tatamiFill(insetCount && insetCount.count > 24 ? inset : mask, w, h, unitPerPx, opts);
  return { underlay: under, stitches: fill };
}

module.exports = { tatamiFill, latticeUnderlay, tatamiWithUnderlay };
