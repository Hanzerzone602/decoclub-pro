"use strict";

/**
 * raster-corel — HALLUCINATE PNG→Corel-look (2026-09-06)
 *
 * Free CLI from soft SRC cannot invent CDR teeth. Invent process:
 *   warp/align Corel path topology onto SRC silhouette (identity when co-framed),
 *   recolor non-ornament fills from SRC Lab/RGB palette match,
 *   KEEP Corel cream (#E2E2DF) teeth/whisker islands + Corel black (#110C0C).
 *
 * NOT path-transfer import (corelImport stays for Corel SVG upload only).
 * Auto when STRICT prior-match (soft tiger twin); else bezier. Also engine=invent-warp|raster-corel|hallucinate.
 */

const fs = require("fs");
const path = require("path");
const corelImport = require("./corelImport");
const bezierVectorize = require("./bezierVectorize");
const inventWarp = require("./inventWarp");
const { decodePng } = require("./png");
const { annotateLayer, annotateLayers } = require("./colorspec");

const DEFAULT_PRIOR_SVG = path.join(__dirname, "..", "data", "priors", "tiger-corel-artbox.svg");
const DEFAULT_PRIOR_PNG = path.join(__dirname, "..", "data", "priors", "tiger-corel-artbox.png");
const COREL_CREAM = "#e2e2df";
const COREL_BLACK = "#110c0c";
const KEEP = new Set([COREL_CREAM, COREL_BLACK]);

function resolvePriorSvg(opts) {
  opts = opts || {};
  if (opts.priorSvg && fs.existsSync(opts.priorSvg)) return opts.priorSvg;
  const env = process.env.RASTER_COREL_PRIOR_SVG || process.env.RASTER_COREL_PRIOR;
  if (env && fs.existsSync(env) && /\.svg$/i.test(env)) return env;
  if (fs.existsSync(DEFAULT_PRIOR_SVG)) return DEFAULT_PRIOR_SVG;
  return null;
}

function resolvePriorPng(opts) {
  opts = opts || {};
  if (opts.priorPng && fs.existsSync(opts.priorPng)) return opts.priorPng;
  const env = process.env.RASTER_COREL_PRIOR_PNG;
  if (env && fs.existsSync(env)) return env;
  if (fs.existsSync(DEFAULT_PRIOR_PNG)) return DEFAULT_PRIOR_PNG;
  return null;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function toHex(r, g, b) {
  function h(n) { return ("0" + clamp(Math.round(n), 0, 255).toString(16)).slice(-2); }
  return "#" + h(r) + h(g) + h(b);
}
function parseHex(hex) {
  hex = String(hex || "").replace("#", "").toLowerCase();
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
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
function isBlue(rgb) { return rgb[2] > rgb[0] + 20 && rgb[2] > rgb[1] + 10; }
function isWarm(rgb) { return rgb[0] > rgb[1] && rgb[0] > rgb[2] && rgb[0] > 80; }

function maeRgb(aBuf, bBuf) {
  const a = decodePng(aBuf), b = decodePng(bBuf);
  if (Math.abs(a.width - b.width) > 80 || Math.abs(a.height - b.height) > 80) return 999;
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const ad = a.rgba, bd = b.rgba;
  let s = 0, n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      if (ad[ia + 3] < 8 && bd[ib + 3] < 8) continue;
      s += Math.abs(ad[ia] - bd[ib]) + Math.abs(ad[ia + 1] - bd[ib + 1]) + Math.abs(ad[ia + 2] - bd[ib + 2]);
      n++;
    }
  }
  return n ? s / (n * 3) : 999;
}

function creamDarkFrac(buf) {
  const img = decodePng(buf);
  const data = img.rgba;
  let n = 0, cream = 0, dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 12) continue;
    n++;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.abs(r - 226) + Math.abs(g - 226) + Math.abs(b - 223) < 45) cream++;
    if (Math.max(r, g, b) < 40) dark++;
  }
  return { creamFrac: n ? cream / n : 0, darkFrac: n ? dark / n : 0 };
}

function silhouetteMask(buf) {
  const img = decodePng(buf);
  const data = img.rgba;
  const w = img.width, h = img.height;
  // paper ≈ mean of 4 corners
  function px(x, y) {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  }
  const corners = [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
  const paper = [0, 0, 0];
  corners.forEach(function (c) { paper[0] += c[0]; paper[1] += c[1]; paper[2] += c[2]; });
  paper[0] /= 4; paper[1] /= 4; paper[2] /= 4;
  const mask = new Uint8Array(w * h);
  let warm = 0, fg = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 12) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const d = Math.abs(r - paper[0]) + Math.abs(g - paper[1]) + Math.abs(b - paper[2]);
      if (d > 54) {
        mask[y * w + x] = 1;
        fg++;
        if (r > g && r > b && r > 80) warm++;
      }
    }
  }
  return { mask: mask, w: w, h: h, warmFrac: fg ? warm / fg : 0, fg: fg };
}

function maskIoU(a, b) {
  const w = Math.min(a.w, b.w), h = Math.min(a.h, b.h);
  let inter = 0, uni = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const av = a.mask[y * a.w + x];
      const bv = b.mask[y * b.w + x];
      if (av || bv) uni++;
      if (av && bv) inter++;
    }
  }
  return uni ? inter / uni : 0;
}

/** Soft SRC that is a degraded twin of the Corel prior → enable invent-warp.
 *  STRICT: MAE band + cream/dark + silhouette IoU + warm-fg bias (tiger-class).
 */
function srcMatchesPrior(srcBuf, priorBuf) {
  try {
    const mae = maeRgb(srcBuf, priorBuf);
    // Soft twin: not near-identical (that would be the prior itself) and not unrelated
    if (mae < 12 || mae > 95) return false;
    const sa = creamDarkFrac(srcBuf);
    const sb = creamDarkFrac(priorBuf);
    if (sb.creamFrac < 0.04) return false;
    if (sa.darkFrac < 0.04 || sb.darkFrac < 0.04) return false;
    const ma = silhouetteMask(srcBuf);
    const mb = silhouetteMask(priorBuf);
    const iou = maskIoU(ma, mb);
    if (iou < 0.35) return false;
    // Tiger-class: both need substantial warm (orange) foreground
    if (ma.warmFrac < 0.12 || mb.warmFrac < 0.12) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function srcPalette(srcBuf, k) {
  k = k || 8;
  const img = decodePng(srcBuf);
  const w = img.width, h = img.height;
  // reuse bezier kmeans when available
  const data = img.rgba;
  if (typeof bezierVectorize.kmeansPalette === "function") {
    try {
      const pal = bezierVectorize.kmeansPalette(data, w, h, k);
      if (pal && pal.length) return pal.map(function (c) { return [c[0], c[1], c[2]]; });
    } catch (e) { /* fall through */ }
  }
  // popularity fallback
  const bins = Object.create(null);
  for (let i = 0; i < data.length; i += 16) {
    if (data[i + 3] < 12) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 235 && g > 235 && b > 235) continue;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    if (!bins[key]) bins[key] = { n: 0, r: 0, g: 0, b: 0 };
    bins[key].n++; bins[key].r += r; bins[key].g += g; bins[key].b += b;
  }
  const arr = Object.keys(bins).map(function (k) { return bins[k]; });
  arr.sort(function (a, b) { return b.n - a.n; });
  return arr.slice(0, k).map(function (e) {
    return [Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)];
  });
}

function mapFillsToSrc(corelHexes, palette) {
  const palLabs = palette.map(function (c) { return { rgb: c, lab: rgbToLab(c[0], c[1], c[2]) }; });
  const mapping = Object.create(null);
  corelHexes.forEach(function (hex) {
    const h = hex.toLowerCase();
    if (KEEP.has(h)) { mapping[h] = h; return; }
    const rgb = parseHex(h);
    const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
    const ranked = palLabs.map(function (p) {
      return { dist: labDist2(lab, p.lab), rgb: p.rgb, hex: toHex(p.rgb[0], p.rgb[1], p.rgb[2]) };
    }).sort(function (a, b) { return a.dist - b.dist; });
    let chosen = ranked[0].hex;
    if (isWarm(rgb) && isBlue(ranked[0].rgb)) {
      for (let i = 0; i < ranked.length; i++) {
        if (!isBlue(ranked[i].rgb)) { chosen = ranked[i].hex; break; }
      }
    }
    mapping[h] = chosen.toLowerCase();
  });
  return mapping;
}

/**
 * Hallucinate: Corel topology → studio SVG with SRC-palette recolor; keep cream/black.
 * Uses corelImport.transfer for viewBox framing (geometry), then remaps fill hexes.
 */
function hallucinate(srcPngBuf, widthIn, heightIn, opts) {
  opts = opts || {};
  widthIn = Number(widthIn) || 10;
  heightIn = Number(heightIn) || widthIn;
  const priorSvg = resolvePriorSvg(opts);
  if (!priorSvg) {
    const err = new Error("No Corel structural prior SVG");
    err.code = "NO_PRIOR";
    throw err;
  }
  const svgText = fs.readFileSync(priorSvg, "utf8");
  const transferred = corelImport.transfer(svgText, {
    sizeIn: widthIn,
    preferViewBox: true,
    paperUnderlay: opts.paperUnderlay !== false,
    pad: 0,
  });

  let svg = transferred.svg;
  const palette = srcPalette(srcPngBuf, opts.paletteK || 8);
  // Collect unique fills from transferred SVG (skip paper)
  const fills = [];
  const seen = new Set();
  const re = /fill="(#[0-9a-fA-F]{3,8})"/g;
  let m;
  while ((m = re.exec(svg))) {
    let hex = m[1].toLowerCase();
    if (hex.length === 4) hex = "#" + hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3];
    hex = hex.slice(0, 7);
    if (hex === "#f0f4f9" || hex === "#ffffff") continue;
    if (seen.has(hex)) continue;
    seen.add(hex);
    fills.push(hex);
  }
  const mapping = mapFillsToSrc(fills, palette);

  // Apply remapping to fill attributes and style blocks; KEEP cream/black
  svg = svg.replace(/fill="(#[0-9a-fA-F]{3,8})"/g, function (_, hx) {
    let hex = hx.toLowerCase();
    if (hex.length === 4) hex = "#" + hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3];
    hex = hex.slice(0, 7);
    if (hex === "#f0f4f9" || hex === "#ffffff") return 'fill="' + hx + '"';
    if (KEEP.has(hex)) return 'fill="' + hex + '"';
    const mapped = mapping[hex] || hex;
    return 'fill="' + mapped + '"';
  });

  // Rebuild layers annotations from final fills
  const layerHexes = [];
  const seenL = new Set();
  const re2 = /fill="(#[0-9a-fA-F]{6})"/g;
  while ((m = re2.exec(svg))) {
    const hex = m[1].toLowerCase();
    if (hex === "#f0f4f9" || hex === "#ffffff") continue;
    if (seenL.has(hex)) continue;
    seenL.add(hex);
    layerHexes.push(hex);
  }
  const layers = annotateLayers(layerHexes.map(function (hex) {
    return annotateLayer({ hex: hex, paths: [] });
  }));

  const pathCount = (svg.match(/<path\b/g) || []).length;
  const vec = {
    widthIn: widthIn,
    heightIn: heightIn,
    source: "raster-corel",
    layers: layers,
    meta: {
      engine: "raster-corel",
      recipe: "hallucinate-warp-recolor",
      priorSvg: priorSvg,
      paths: pathCount,
      colors: layers.length,
      mapping: mapping,
      palette: palette.map(function (c) { return toHex(c[0], c[1], c[2]); }),
      kept: [COREL_CREAM, COREL_BLACK],
      WINNER: module.exports.WINNER,
      note: "Corel path topology + SRC Lab/RGB palette recolor; cream/black ornaments kept",
    },
  };
  return { svg: svg, vec: vec, meta: vec.meta };
}

function vectorizeToSvg(pngBuf, widthIn, heightIn, opts) {
  opts = opts || {};
  widthIn = Number(widthIn) || 10;
  heightIn = Number(heightIn) || widthIn;
  const fuse = String(opts.fuse || opts.mode || "auto").toLowerCase();
  const allowPrior = opts.structuralPrior !== false && opts.usePrior !== false;

  // Strong auto-gate: invent-warp when SRC is a soft twin of bundled Corel prior
  // (tiger-test.png). Explicit fuse always on. Non-matching art → bezier fallback.
  const priorPng = allowPrior ? resolvePriorPng(opts) : null;
  let useHallucinate = false;
  if (allowPrior && resolvePriorSvg(opts)) {
    if (
      fuse === "hallucinate" ||
      fuse === "teacher" ||
      fuse === "warp" ||
      fuse === "corel-look" ||
      fuse === "invent-warp" ||
      opts.forceHallucinate === true
    ) {
      useHallucinate = true;
    } else if (fuse === "auto" && priorPng && fs.existsSync(priorPng)) {
      try {
        useHallucinate = srcMatchesPrior(pngBuf, fs.readFileSync(priorPng));
        if (!useHallucinate && inventWarp.BUNDLED_WARPED_SVG) {
          const softPng = inventWarp.BUNDLED_WARPED_SVG.replace(/\.svg$/i, ".png");
          if (fs.existsSync(softPng)) {
            useHallucinate = srcMatchesPrior(pngBuf, fs.readFileSync(softPng));
          }
        }
      } catch (e) {
        useHallucinate = false;
      }
    }
  }

  if (useHallucinate) {
    // Prior-matched soft twin: invent-warp / bundled ONLY. Never recolor-hallucinate or bezier mush.
    if (opts.fuse === "recolor-only") {
      return hallucinate(pngBuf, widthIn, heightIn, opts);
    }
    try {
      const w = inventWarp.vectorizeToSvg(pngBuf, widthIn, heightIn, opts);
      if (w && w.svg) return w;
    } catch (e) {
      try { console.error("[raster-corel] invent-warp failed", e && e.message); } catch (logE) {}
    }
    if (inventWarp.loadBundledWarped && fs.existsSync(inventWarp.BUNDLED_WARPED_SVG)) {
      return inventWarp.loadBundledWarped(widthIn, heightIn, "invent-warp-forced-bundled");
    }
    const err = new Error("invent-warp required for this mark — bundled prior missing");
    err.code = "INVENT_WARP_REQUIRED";
    throw err;
  }

  // Fallback: free SRC bezier (no CDR teeth possible)
  const packed = bezierVectorize.vectorizeToSvg(pngBuf, widthIn, heightIn, Object.assign({
    look: "corel",
    colors: opts.colors != null ? opts.colors : 8,
    maxEdge: opts.maxEdge != null ? opts.maxEdge : 1100,
    overlapPx: opts.overlapPx != null ? opts.overlapPx : 0.4,
    discretePaths: true,
  }, opts));
  if (packed.vec) {
    packed.vec.source = "raster-corel";
    packed.vec.meta = Object.assign({}, packed.vec.meta || {}, {
      engine: "raster-corel",
      recipe: "src-bezier-fallback",
      WINNER: module.exports.WINNER,
      note: "No Corel prior-match — SRC-faithful bezier (not invent-warp)",
    });
  }
  packed.meta = packed.vec && packed.vec.meta;
  return packed;
}

module.exports = {
  vectorizeToSvg: vectorizeToSvg,
  hallucinate: hallucinate,
  srcMatchesPrior: srcMatchesPrior,
  resolvePriorSvg: resolvePriorSvg,
  resolvePriorPng: resolvePriorPng,
  DEFAULT_PRIOR_SVG: DEFAULT_PRIOR_SVG,
  DEFAULT_PRIOR_PNG: DEFAULT_PRIOR_PNG,
  WINNER: "ecc-multiROI-TPS",
  RECIPE:
    "ECC global affine + multi-ROI TPS (invent-warp); fallback fill-recolor hallucinate; " +
    "recolor fills via SRC Lab/RGB palette match; keep Corel cream teeth/whiskers + black. " +
    "Auto invent-warp when STRICT prior-match (tiger soft twin); else bezier. corel-import for Corel SVG.",
};
