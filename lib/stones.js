"use strict";

const fs = require("fs");
const path = require("path");
const { decodePng } = require("./png");
const { nearestNamed } = require("./palettes");
const { pathToPolylines, jobVectorOrTrace } = require("./vectorize");

const SS_MM = { SS6: 2.0, SS8: 2.3, SS10: 2.8, SS12: 3.0 };

function packMask(mask, mw, mh, widthIn, heightIn, ss, hex, name) {
  const mm = SS_MM[ss] || SS_MM.SS10;
  const gapMm = 0.15;
  const spacingIn = (mm + gapMm) / 25.4;
  const rIn = (mm / 2) / 25.4;
  const rowH = spacingIn * Math.sqrt(3) / 2;
  const sx = widthIn / mw;
  const sy = heightIn / mh;
  const rPx = rIn / sx;
  const stones = [];
  let row = 0;
  for (let yIn = rIn; yIn <= heightIn - rIn + 1e-9; yIn += rowH, row++) {
    const xOff = (row % 2) * (spacingIn / 2);
    for (let xIn = rIn + xOff; xIn <= widthIn - rIn + 1e-9; xIn += spacingIn) {
      const px = xIn / sx;
      const py = yIn / sy;
      if (centerAccepted(mask, mw, mh, px, py, rPx * 0.4)) {
        stones.push({ xIn: round4(xIn), yIn: round4(yIn), ss: ss, hex: hex, name: name });
      }
    }
  }
  return stones;
}

function round4(n) { return Math.round(n * 10000) / 10000; }

function sampleMask(mask, w, h, x, y) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 0;
  return mask[yi * w + xi];
}

function centerAccepted(mask, w, h, x, y, tolPx) {
  if (sampleMask(mask, w, h, x, y)) return true;
  const r = Math.max(1, Math.ceil(tolPx));
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > tolPx * tolPx) continue;
      if (sampleMask(mask, w, h, x + dx, y + dy)) return true;
    }
  }
  return false;
}

function maskFromPng(buf, skipLightEdge) {
  const img = decodePng(buf);
  const w = img.width, h = img.height;
  const rgba = img.rgba;
  const mask = new Uint8Array(w * h);
  const edge = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3];
      if (a < 12) continue;
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      const onEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (skipLightEdge && lum > 242 && onEdge) continue;
      if (lum > 242) {
        // may still be background; mark separately
        mask[y * w + x] = 2;
      } else {
        mask[y * w + x] = 1;
      }
    }
  }
  let dark = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) dark++;
  if (dark > 8) {
    for (let i = 0; i < mask.length; i++) mask[i] = mask[i] === 1 ? 1 : 0;
  } else {
    for (let i = 0; i < mask.length; i++) mask[i] = mask[i] ? 1 : 0;
  }
  return { mask: mask, w: w, h: h, rgba: rgba };
}

function colorAt(rgba, w, h, xIn, yIn, widthIn, heightIn) {
  const px = clamp(Math.floor(xIn / widthIn * w), 0, w - 1);
  const py = clamp(Math.floor(yIn / heightIn * h), 0, h - 1);
  const i = (py * w + px) * 4;
  const hex = "#" + ["0","1","2"].map((k) => ("0" + rgba[i + Number(k)].toString(16)).slice(-2)).join("");
  return hex;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function packStonesFromPng(buf, widthIn, heightIn, opts) {
  opts = opts || {};
  const ss = SS_MM[opts.ss] ? opts.ss : "SS10";
  const wIn = Number(widthIn) || 1;
  const hIn = Number(heightIn) || 1;
  const built = maskFromPng(buf, true);
  let hex = opts.hex || "#eef4f8";
  let name = opts.name;
  if (built.rgba) {
    for (let i = 0; i < built.w * built.h; i++) {
      if (built.mask[i]) {
        const o = i * 4;
        hex = "#" + [built.rgba[o], built.rgba[o + 1], built.rgba[o + 2]].map((n) => ("0" + n.toString(16)).slice(-2)).join("");
        break;
      }
    }
  }
  const named = nearestNamed(hex, "stone");
  if (!name) name = named ? named.name : "Crystal";
  if (named) hex = named.hex;
  return packMask(built.mask, built.w, built.h, wIn, hIn, ss, hex, name);
}

function packStonesFromVector(vector, opts) {
  opts = opts || {};
  const ss = SS_MM[opts.ss] ? opts.ss : "SS10";
  const wIn = Number(vector.widthIn) || 1;
  const hIn = Number(vector.heightIn) || 1;
  const mw = Math.max(32, Math.round(wIn * 80));
  const mh = Math.max(32, Math.round(hIn * 80));
  const mask = new Uint8Array(mw * mh);
  (vector.layers || []).forEach((L) => {
    const lum = hexLum(L.hex);
    if (lum > 242) return;
    const polys = [];
    (L.paths || []).forEach((p) => {
      pathToPolylines(p.d, 8).forEach((pl) => {
        if (pl.length >= 3) polys.push(pl.map((pt) => ({ x: pt.x / wIn * mw, y: pt.y / hIn * mh })));
      });
    });
    for (let y = 0; y < mh; y++) {
      const ys = y + 0.5;
      const xs = [];
      polys.forEach((pts) => {
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const yi = pts[i].y, yj = pts[j].y;
          if ((yi > ys) === (yj > ys)) continue;
          const xi = pts[i].x, xj = pts[j].x;
          xs.push(xi + (xj - xi) * (ys - yi) / ((yj - yi) || 1e-9));
        }
      });
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const x0 = Math.max(0, Math.floor(xs[k]));
        const x1 = Math.min(mw - 1, Math.ceil(xs[k + 1]));
        for (let x = x0; x <= x1; x++) mask[y * mw + x] = 1;
      }
    }
  });
  let hex = (vector.layers && vector.layers[0] && vector.layers[0].hex) || "#eef4f8";
  const named = nearestNamed(hex, "stone");
  return packMask(mask, mw, mh, wIn, hIn, ss, named ? named.hex : hex, named ? named.name : "Crystal");
}

function hexLum(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return 0;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function stonesSvg(stones, widthIn, heightIn) {
  const w = Number(widthIn) || 1;
  const h = Number(heightIn) || 1;
  const circles = (stones || []).map((s) => {
    const mm = SS_MM[s.ss] || 2.8;
    const r = (mm / 2) / 25.4;
    return '<circle cx="' + s.xIn + '" cy="' + s.yIn + '" r="' + round4(r) + '" fill="' + s.hex + '" stroke="#222" stroke-width="0.005"/>';
  });
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + w + "in\" height=\"" + h + "in\" viewBox=\"0 0 " + w + " " + h + "\">\n" +
    "  <rect width=\"" + w + "\" height=\"" + h + "\" fill=\"#f4f4f1\"/>\n  " +
    circles.join("\n  ") + "\n</svg>\n";
}

function stonesCsv(stones) {
  const rows = ["x_in,y_in,ss,mm,color_name,hex"];
  (stones || []).forEach((s) => {
    const mm = SS_MM[s.ss] || 2.8;
    rows.push([s.xIn, s.yIn, s.ss, mm, csvEsc(s.name), s.hex].join(","));
  });
  return rows.join("\n") + "\n";
}

function csvEsc(s) {
  const t = String(s || "");
  if (/[",\n]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
  return t;
}

function stonesPlt(stones, heightIn) {
  const unit = 1016;
  const cmds = ["IN;", "SP1;"];
  (stones || []).forEach((s) => {
    const X = Math.round(s.xIn * unit);
    const Y = Math.round(((Number(heightIn) || 1) - s.yIn) * unit);
    cmds.push("PU" + X + "," + Y + ";");
    cmds.push("PD" + X + "," + Y + ";");
  });
  cmds.push("PU;", "SP0;");
  return cmds.join("\n") + "\n";
}

function loadArtwork(job, uploadsDir) {
  if (!job || !job.file_path || !uploadsDir) return null;
  const abs = path.join(uploadsDir, path.basename(job.file_path));
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

function stonesForJob(job, uploadsDir, opts) {
  opts = opts || {};
  const ss = opts.ss || "SS10";
  const w = Number(job.width_in) || 1;
  const h = Number(job.height_in) || 1;
  const buf = loadArtwork(job, uploadsDir);
  let stones;
  if (job.vector && job.vector.layers && job.vector.layers.length) {
    stones = packStonesFromVector(job.vector, { ss: ss });
  } else if (buf) {
    try { stones = packStonesFromPng(buf, w, h, { ss: ss }); }
    catch (e) { stones = packStonesFromVector(jobVectorOrTrace(job, null), { ss: ss }); }
  } else {
    stones = packStonesFromVector(jobVectorOrTrace(job, null), { ss: ss });
  }
  return {
    stones: stones,
    count: stones.length,
    ss: ss,
    svg: stonesSvg(stones, w, h),
    csv: stonesCsv(stones),
    plt: stonesPlt(stones, h),
  };
}

module.exports = {
  SS_MM,
  packStonesFromPng,
  packStonesFromVector,
  stonesForJob,
  stonesSvg,
  stonesCsv,
  stonesPlt,
};
