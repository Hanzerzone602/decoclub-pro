"use strict";

const fs = require("fs");
const path = require("path");
const { vectorize, pathToPolylines, rectangleLayers, jobVectorOrTrace, svgFromLayers } = require("./vectorize");

const UNIT_PER_IN = 254; // 0.1mm
const MAX_DELTA = 121;
const JUMP_MM = 12;
const JUMP_U = JUMP_MM * 10;

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function hexRgb(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return [20, 20, 20];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function evenOddInside(polys, x, y) {
  let inside = false;
  for (let p = 0; p < polys.length; p++) {
    const pts = polys[p];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      const hit = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi);
      if (hit) inside = !inside;
    }
  }
  return inside;
}

function rasterizeLayers(layers, widthIn, heightIn, maxSide) {
  maxSide = maxSide || 280;
  const unitsW = Math.max(2, Math.round(widthIn * UNIT_PER_IN));
  const unitsH = Math.max(2, Math.round(heightIn * UNIT_PER_IN));
  const scale = Math.min(1, maxSide / Math.max(unitsW, unitsH));
  const mw = Math.max(2, Math.round(unitsW * scale));
  const mh = Math.max(2, Math.round(unitsH * scale));
  const unitPerPx = (widthIn * UNIT_PER_IN) / mw;
  const masks = [];
  (layers || []).forEach((L, li) => {
    const polys = [];
    (L.paths || []).forEach((p) => {
      pathToPolylines(p.d, 8).forEach((pl) => {
        if (pl.length >= 3) polys.push(pl.map((pt) => ({ x: pt.x / widthIn * mw, y: pt.y / heightIn * mh })));
      });
    });
    const mask = new Uint8Array(mw * mh);
    if (!polys.length) { masks.push({ mask: mask, w: mw, h: mh, hex: L.hex, name: L.nameGuess, unitPerPx: unitPerPx }); return; }
    for (let y = 0; y < mh; y++) {
      const ys = y + 0.5;
      const xs = [];
      for (let p = 0; p < polys.length; p++) {
        const pts = polys[p];
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const yi = pts[i].y, yj = pts[j].y;
          if ((yi > ys) === (yj > ys)) continue;
          const xi = pts[i].x, xj = pts[j].x;
          const xh = xi + (xj - xi) * (ys - yi) / ((yj - yi) || 1e-9);
          xs.push(xh);
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = clamp(Math.floor(xs[k]), 0, mw - 1);
        const x1 = clamp(Math.ceil(xs[k + 1]), 0, mw - 1);
        for (let x = x0; x <= x1; x++) mask[y * mw + x] = 1;
      }
    }
    masks.push({ mask: mask, w: mw, h: mh, hex: L.hex, name: L.nameGuess, unitPerPx: unitPerPx });
  });
  return { masks: masks, mw: mw, mh: mh, unitPerPx: unitPerPx, unitsW: unitsW, unitsH: unitsH };
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
  return { minX, minY, maxX, maxY, count, bw: maxX - minX + 1, bh: maxY - minY + 1 };
}

function walkRun(x0, y0, x1, y1, stitchU) {
  const pts = [];
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return [{ x: x1, y: y1 }];
  const n = Math.max(1, Math.round(len / stitchU));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push({ x: x0 + dx * t, y: y0 + dy * t });
  }
  return pts;
}

function tatamiFill(mask, w, h, unitPerPx, opts) {
  const pitchU = (opts.pitchMm || 0.4) * 10;
  const staggerU = (opts.staggerMm || 3) * 10;
  const stitchU = (opts.stitchMm || 3.2) * 10;
  const pitch = pitchU / unitPerPx;
  const stagger = staggerU / unitPerPx;
  const stitch = stitchU / unitPerPx;
  const ang = Math.PI / 4;
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
    const vStep = Math.max(0.6, stitch * 0.15);
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
      const a = dir === 1 ? { x: r.x0, y: r.y0 } : { x: r.x1, y: r.y1 };
      const b = dir === 1 ? { x: r.x1, y: r.y1 } : { x: r.x0, y: r.y0 };
      walkRun(a.x, a.y, b.x, b.y, stitch).forEach((p) => stitches.push(p));
    });
  }
  return stitches;
}

function gridUnderlay(mask, w, h, unitPerPx) {
  const step = (2.4 * 10) / unitPerPx;
  const stitch = (3.2 * 10) / unitPerPx;
  const pts = [];
  for (let y = 0; y < h; y += step) {
    let run = null;
    const yi = Math.min(h - 1, Math.round(y));
    for (let x = 0; x < w; x++) {
      if (mask[yi * w + x]) {
        if (!run) run = { x0: x, x1: x };
        else run.x1 = x;
      } else if (run) {
        walkRun(run.x0, yi, run.x1, yi, stitch).forEach((p) => pts.push(p));
        run = null;
      }
    }
    if (run) walkRun(run.x0, yi, run.x1, yi, stitch).forEach((p) => pts.push(p));
  }
  for (let x = 0; x < w; x += step) {
    let run = null;
    const xi = Math.min(w - 1, Math.round(x));
    for (let y = 0; y < h; y++) {
      if (mask[y * w + xi]) {
        if (!run) run = { y0: y, y1: y };
        else run.y1 = y;
      } else if (run) {
        walkRun(xi, run.y0, xi, run.y1, stitch).forEach((p) => pts.push(p));
        run = null;
      }
    }
    if (run) walkRun(xi, run.y0, xi, run.y1, stitch).forEach((p) => pts.push(p));
  }
  return pts;
}

function satinFromNarrow(mask, w, h, unitPerPx, opts) {
  const spacingU = (opts.spacingMm || 0.4) * 10;
  const pullU = (opts.pullMm || 0.15) * 10;
  const spacing = spacingU / unitPerPx;
  const pull = pullU / unitPerPx;
  const st = blobStats(mask, w, h);
  if (!st) return [];
  const horiz = st.bw >= st.bh;
  const stitches = [];
  const under = [];
  if (horiz) {
    const yMid = (st.minY + st.maxY) / 2;
    under.push({ x: st.minX, y: yMid }, { x: st.maxX, y: yMid });
    let side = 1;
    for (let x = st.minX; x <= st.maxX; x += spacing) {
      let y0 = -1, y1 = -1;
      const xi = Math.round(x);
      for (let y = st.minY; y <= st.maxY; y++) {
        if (mask[y * w + xi]) { if (y0 < 0) y0 = y; y1 = y; }
      }
      if (y0 < 0) continue;
      const cy = (y0 + y1) / 2;
      const half = (y1 - y0) / 2 + pull;
      stitches.push({ x: xi, y: cy + half * side });
      side *= -1;
    }
  } else {
    const xMid = (st.minX + st.maxX) / 2;
    under.push({ x: xMid, y: st.minY }, { x: xMid, y: st.maxY });
    let side = 1;
    for (let y = st.minY; y <= st.maxY; y += spacing) {
      let x0 = -1, x1 = -1;
      const yi = Math.round(y);
      for (let x = st.minX; x <= st.maxX; x++) {
        if (mask[yi * w + x]) { if (x0 < 0) x0 = x; x1 = x; }
      }
      if (x0 < 0) continue;
      const cx = (x0 + x1) / 2;
      const half = (x1 - x0) / 2 + pull;
      stitches.push({ x: cx + half * side, y: yi });
      side *= -1;
    }
  }
  return under.concat(stitches);
}

function contourRun(mask, w, h, unitPerPx) {
  const stitch = (2.5 * 10) / unitPerPx;
  const { mooreTrace, padMask } = require("./contour");
  const padded = padMask(mask, w, h);
  const pts = mooreTrace(padded.mask, padded.w, padded.h).map((p) => ({ x: p.x - 1, y: p.y - 1 }));
  if (pts.length < 2) return [];
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    walkRun(prev.x, prev.y, pts[i].x, pts[i].y, stitch).slice(1).forEach((p) => out.push(p));
  }
  return out;
}

function classifyAndStitch(entry, opts) {
  const st = blobStats(entry.mask, entry.w, entry.h);
  if (!st) return [];
  const minMm = Math.min(st.bw, st.bh) * entry.unitPerPx * 0.1;
  const maxMm = Math.max(st.bw, st.bh) * entry.unitPerPx * 0.1;
  if (maxMm < 1.2 && minMm < 0.6) {
    return contourRun(entry.mask, entry.w, entry.h, entry.unitPerPx);
  }
  if (minMm > 0.35 && minMm <= (opts.satinMm || 1.2) && maxMm > minMm * 1.8) {
    return satinFromNarrow(entry.mask, entry.w, entry.h, entry.unitPerPx, {
      spacingMm: 0.4,
      pullMm: 0.15,
    });
  }
  const under = gridUnderlay(entry.mask, entry.w, entry.h, entry.unitPerPx);
  const fill = tatamiFill(entry.mask, entry.w, entry.h, entry.unitPerPx, {
    pitchMm: opts.density || 0.4,
    staggerMm: 3,
    stitchMm: 3.2,
  });
  return under.concat(fill);
}

function toUnits(pt, unitPerPx) {
  return { x: Math.round(pt.x * unitPerPx), y: Math.round(pt.y * unitPerPx) };
}

function encodeDstDelta(dx, dy, flags) {
  // Tajima DST: 9-bit via balanced ternary 1,3,9,27,81. Y is stored inverted (machine Y-up).
  if (flags === "end") return Buffer.from([0x00, 0x00, 0xF3]);
  let x = clamp(dx | 0, -121, 121);
  let y = clamp(-(dy | 0), -121, 121);
  let b0 = 0, b1 = 0, b2 = 0;
  if (flags === "color") b2 = 0xC3;
  else if (flags === "jump") b2 = 0x83;
  else b2 = 0x03;
  if (x > 40) { b2 |= 0x04; x -= 81; }
  if (x < -40) { b2 |= 0x08; x += 81; }
  if (y > 40) { b2 |= 0x20; y -= 81; }
  if (y < -40) { b2 |= 0x10; y += 81; }
  if (x > 13) { b1 |= 0x04; x -= 27; }
  if (x < -13) { b1 |= 0x08; x += 27; }
  if (y > 13) { b1 |= 0x20; y -= 27; }
  if (y < -13) { b1 |= 0x10; y += 27; }
  if (x > 4) { b0 |= 0x04; x -= 9; }
  if (x < -4) { b0 |= 0x08; x += 9; }
  if (y > 4) { b0 |= 0x20; y -= 9; }
  if (y < -4) { b0 |= 0x10; y += 9; }
  if (x > 1) { b1 |= 0x01; x -= 3; }
  if (x < -1) { b1 |= 0x02; x += 3; }
  if (y > 1) { b1 |= 0x80; y -= 3; }
  if (y < -1) { b1 |= 0x40; y += 3; }
  if (x > 0) { b0 |= 0x01; x -= 1; }
  if (x < 0) { b0 |= 0x02; x += 1; }
  if (y > 0) { b0 |= 0x80; y -= 1; }
  if (y < 0) { b0 |= 0x40; y += 1; }
  return Buffer.from([b0, b1, b2]);
}

function splitDelta(dx, dy, flags, out) {
  let remX = dx, remY = dy;
  while (Math.abs(remX) > MAX_DELTA || Math.abs(remY) > MAX_DELTA) {
    const sx = clamp(remX, -MAX_DELTA, MAX_DELTA);
    const sy = clamp(remY, -MAX_DELTA, MAX_DELTA);
    out.push(encodeDstDelta(sx, sy, flags === "color" ? "jump" : flags));
    remX -= sx; remY -= sy;
  }
  out.push(encodeDstDelta(remX, remY, flags));
}

function dstHeader(name, stitchCount, colorCount, minX, minY, maxX, maxY) {
  function padNum(n, w) {
    const s = String(Math.abs(n | 0));
    return ("       " + s).slice(-w);
  }
  const nm = String(name || "DESIGN").replace(/[^\x20-\x7E]/g, " ").slice(0, 16);
  const parts = [
    "LA:" + (nm + "                ").slice(0, 16),
    "ST:" + padNum(stitchCount, 7),
    "CO:" + padNum(colorCount, 3),
    "+X:" + padNum(maxX, 5),
    "-X:" + padNum(Math.abs(minX), 5),
    "+Y:" + padNum(maxY, 5),
    "-Y:" + padNum(Math.abs(minY), 5),
    "AX:+" + padNum(0, 6),
    "AY:+" + padNum(0, 6),
    "MX:+" + padNum(0, 6),
    "MY:+" + padNum(0, 6),
    "PD:******",
  ];
  const text = parts.join("\r") + "\r";
  const buf = Buffer.alloc(512, 0x20);
  Buffer.from(text, "ascii").copy(buf, 0, 0, Math.min(text.length, 511));
  buf[511] = 0x1A;
  return buf;
}

function writeDst(stitches, name) {
  const recs = [];
  let x = 0, y = 0;
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  let colors = 0;
  let stitchN = 0;
  stitches.forEach((s) => {
    if (s.kind === "color") {
      recs.push(encodeDstDelta(0, 0, "color"));
      colors++;
      return;
    }
    const dx = s.x - x;
    const dy = s.y - y;
    const flags = s.kind === "jump" ? "jump" : "stitch";
    splitDelta(dx, dy, flags, recs);
    x = s.x; y = s.y;
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    if (flags === "stitch") stitchN++;
  });
  recs.push(encodeDstDelta(0, 0, "end"));
  const header = dstHeader(name, stitchN, colors, minX, minY, maxX, maxY);
  return Buffer.concat([header].concat(recs));
}

function writeExp(stitches) {
  // Melco EXP: two signed bytes per stitch (dx, dy). Y stored inverted.
  // Commands (first byte 0x80): 0x80 0x01 jump (then dx,dy), 0x80 0x04 color change, 0x80 0x80 end.
  const chunks = [];
  let x = 0, y = 0;
  function emitPair(dx, dy) {
    let remX = dx, remY = dy;
    if (remX === 0 && remY === 0) {
      chunks.push(Buffer.from([0, 0]));
      return;
    }
    while (remX !== 0 || remY !== 0) {
      const sx = clamp(remX, -127, 127);
      const sy = clamp(remY, -127, 127);
      const bx = sx < 0 ? (256 + sx) : sx;
      const by = sy < 0 ? (256 + sy) : sy;
      chunks.push(Buffer.from([bx, by]));
      remX -= sx; remY -= sy;
    }
  }
  stitches.forEach((s) => {
    if (s.kind === "color") {
      chunks.push(Buffer.from([0x80, 0x04]));
      return;
    }
    const dx = s.x - x;
    let dy = s.y - y;
    const invY = -dy;
    if (s.kind === "jump") {
      chunks.push(Buffer.from([0x80, 0x01]));
      emitPair(dx, invY);
    } else {
      emitPair(dx, invY);
    }
    x = s.x; y = s.y;
  });
  chunks.push(Buffer.from([0x80, 0x80]));
  return Buffer.concat(chunks);
}

function stitchPreviewSvg(stitches, widthIn, heightIn, colorStops) {
  const w = Number(widthIn) || 1;
  const h = Number(heightIn) || 1;
  const groups = [];
  let d = "";
  let color = "#017ece";
  let ci = 0;
  function flush() {
    if (!d) return;
    groups.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="0.012" stroke-linecap="round"/>');
    d = "";
  }
  stitches.forEach((s) => {
    if (s.kind === "color") {
      flush();
      ci++;
      color = (colorStops && colorStops[ci] && colorStops[ci].hex) || color;
      return;
    }
    const x = s.x / UNIT_PER_IN;
    const y = s.y / UNIT_PER_IN;
    if (s.kind === "jump" || !d) d += (d ? " M " : "M ") + x.toFixed(3) + " " + y.toFixed(3);
    else d += " L " + x.toFixed(3) + " " + y.toFixed(3);
  });
  flush();
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + w + "in\" height=\"" + h + "in\" viewBox=\"0 0 " + w + " " + h + "\">\n" +
    "  <rect width=\"" + w + "\" height=\"" + h + "\" fill=\"#f7f7f4\"/>\n  " +
    groups.join("\n  ") + "\n</svg>\n";
}

function buildStitchList(layers, widthIn, heightIn, opts) {
  opts = opts || {};
  const rast = rasterizeLayers(layers, widthIn, heightIn, 280);
  const out = [];
  const colorStops = [];
  let last = null;
  rast.masks.forEach((entry, idx) => {
    const pts = classifyAndStitch(entry, opts);
    if (!pts.length) return;
    colorStops.push({ hex: entry.hex, name: entry.name, index: idx });
    if (out.length) out.push({ kind: "color", x: last ? last.x : 0, y: last ? last.y : 0 });
    pts.forEach((p, i) => {
      const u = toUnits(p, entry.unitPerPx);
      const kind = (!last || i === 0 || Math.hypot(u.x - last.x, u.y - last.y) > JUMP_U) ? (i === 0 || Math.hypot(u.x - (last ? last.x : 0), u.y - (last ? last.y : 0)) > JUMP_U ? "jump" : "stitch") : "stitch";
      const rec = { kind: kind === "jump" && i === 0 ? "jump" : (last && Math.hypot(u.x - last.x, u.y - last.y) > JUMP_U ? "jump" : "stitch"), x: u.x, y: u.y };
      out.push(rec);
      last = rec;
    });
  });
  return { stitches: out, colorStops: colorStops };
}

function digitizeLayers(vector, opts) {
  opts = opts || {};
  const widthIn = Number(vector.widthIn || vector.width_in) || 1;
  const heightIn = Number(vector.heightIn || vector.height_in) || 1;
  const layers = vector.layers || [];
  const built = buildStitchList(layers, widthIn, heightIn, opts);
  if (built.stitches.filter((s) => s.kind === "stitch").length < 50) {
    const fallback = rectangleLayers(widthIn, heightIn, (layers[0] && layers[0].hex) || "#111111", "Fill");
    const again = buildStitchList(fallback.layers, widthIn, heightIn, opts);
    if (again.stitches.length > built.stitches.length) {
      built.stitches = again.stitches;
      built.colorStops = again.colorStops;
    }
  }
  const name = String(opts.name || "DESIGN").slice(0, 16);
  const dst = writeDst(built.stitches, name);
  const exp = writeExp(built.stitches);
  const stitchCount = built.stitches.filter((s) => s.kind === "stitch").length;
  const previewSvg = stitchPreviewSvg(built.stitches, widthIn, heightIn, built.colorStops);
  return { dst: dst, exp: exp, previewSvg: previewSvg, stitchCount: stitchCount, colorStops: built.colorStops, stitches: built.stitches };
}

function loadArtwork(job, uploadsDir) {
  if (!job || !job.file_path || !uploadsDir) return null;
  const abs = path.join(uploadsDir, path.basename(job.file_path));
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

function digitizeJob(job, uploadsDir, opts) {
  opts = opts || {};
  const buf = loadArtwork(job, uploadsDir);
  const w = Number(job.width_in) || 1;
  const h = Number(job.height_in) || 1;
  let vec = job.vector;
  if (!vec || !vec.layers || !vec.layers.length) {
    vec = jobVectorOrTrace(job, buf);
  }
  const name = String(job.title || job.id || "DESIGN").replace(/[^\w\- ]+/g, "").slice(0, 16) || "DESIGN";
  return digitizeLayers(vec, {
    name: name,
    satinMm: opts.satinMm,
    density: opts.density,
  });
}

module.exports = {
  digitizeJob,
  digitizeLayers,
  writeDst,
  writeExp,
  UNIT_PER_IN,
};
