"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { decodePng, encodePng } = require("./png");
const { epsFromLayers } = require("./eps");
const { annotateLayers } = require("./colorspec");

const BIN = path.join(__dirname, "..", "bin", "vtracer");

function ensureExecutable() {
  try {
    if (fs.existsSync(BIN)) fs.chmodSync(BIN, 0o755);
  } catch (e) { /* Windows host may ignore */ }
}

function available() {
  try {
    if (!fs.existsSync(BIN) || !fs.statSync(BIN).isFile()) return false;
    ensureExecutable();
    return true;
  } catch (e) {
    return false;
  }
}

function normalizeHex(hex) {
  let h = String(hex || "").trim();
  if (!h) return "#000000";
  if (h[0] !== "#") h = "#" + h;
  if (h.length === 4) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return h.slice(0, 7).toLowerCase();
}

function hexToRgb(hex) {
  const h = normalizeHex(hex).slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r, g, b) {
  function c(n) {
    const s = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return s.length === 1 ? "0" + s : s;
  }
  return "#" + c(r) + c(g) + c(b);
}

function rgbToLab(r, g, b) {
  function lin(c) {
    c = c / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  r = lin(r); g = lin(g); b = lin(b);
  const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  function f(t) {
    return t > 0.008856 ? Math.pow(t, 1 / 3) : (7.787 * t) + 16 / 116;
  }
  const fx = f(x / 0.95047);
  const fy = f(y);
  const fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function labDist(a, b) {
  const d0 = a[0] - b[0];
  const d1 = a[1] - b[1];
  const d2 = a[2] - b[2];
  return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
}

function isNearWhite(hex) {
  const rgb = hexToRgb(hex);
  return rgb[0] >= 245 && rgb[1] >= 245 && rgb[2] >= 245;
}

function translatePath(d, tx, ty) {
  if (!tx && !ty) return String(d || "");
  const tokens = String(d || "").trim().split(/[\s,]+/).filter(Boolean);
  const out = [];
  let cmd = null;
  let nums = [];
  function flush() {
    if (!cmd) return;
    out.push(cmd);
    if (cmd === "Z") { nums = []; return; }
    const stride = cmd === "C" ? 6 : 2;
    for (let i = 0; i + stride - 1 < nums.length; i += stride) {
      for (let j = 0; j < stride; j += 2) {
        out.push(String(Math.round((Number(nums[i + j]) + tx) * 1000) / 1000));
        out.push(String(Math.round((Number(nums[i + j + 1]) + ty) * 1000) / 1000));
      }
    }
    nums = [];
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[MLCZmlcz]$/.test(t)) { flush(); cmd = t.toUpperCase(); }
    else nums.push(t);
  }
  flush();
  return out.join(" ");
}

function scalePathToInches(d, sx, sy) {
  const tokens = String(d || "").trim().split(/[\s,]+/).filter(Boolean);
  const out = [];
  let cmd = null;
  let nums = [];
  function flush() {
    if (!cmd) return;
    out.push(cmd);
    if (cmd === "Z") { nums = []; return; }
    const stride = cmd === "C" ? 6 : 2;
    for (let i = 0; i + stride - 1 < nums.length; i += stride) {
      for (let j = 0; j < stride; j += 2) {
        out.push(String(Math.round(Number(nums[i + j]) * sx * 10000) / 10000));
        out.push(String(Math.round(Number(nums[i + j + 1]) * sy * 10000) / 10000));
      }
    }
    nums = [];
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[MLCZ]$/i.test(t)) { flush(); cmd = t.toUpperCase(); }
    else nums.push(t);
  }
  flush();
  return out.join(" ");
}

function pathBounds(d) {
  const nums = String(d || "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = Number(nums[i]);
    const y = Number(nums[i + 1]);
    if (!isFinite(x) || !isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!isFinite(minX)) return null;
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, w: maxX - minX, h: maxY - minY };
}

function clusterPalette(hexes, maxColors) {
  const max = Math.max(2, Math.min(24, Number(maxColors) || 8));
  const counts = Object.create(null);
  hexes.forEach(function (h) {
    const n = normalizeHex(h);
    counts[n] = (counts[n] || 0) + 1;
  });
  let clusters = Object.keys(counts).map(function (hex) {
    const rgb = hexToRgb(hex);
    return {
      hex: hex,
      lab: rgbToLab(rgb[0], rgb[1], rgb[2]),
      members: [hex],
      weight: counts[hex],
      sumR: rgb[0] * counts[hex],
      sumG: rgb[1] * counts[hex],
      sumB: rgb[2] * counts[hex],
    };
  });
  while (clusters.length > max) {
    let bestD = Infinity, bi = 0, bj = 1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = labDist(clusters[i].lab, clusters[j].lab);
        if (d < bestD) { bestD = d; bi = i; bj = j; }
      }
    }
    const a = clusters[bi];
    const b = clusters[bj];
    const keep = a.weight >= b.weight ? a : b;
    const drop = keep === a ? b : a;
    keep.members = keep.members.concat(drop.members);
    keep.weight += drop.weight;
    keep.sumR += drop.sumR;
    keep.sumG += drop.sumG;
    keep.sumB += drop.sumB;
    const rr = keep.sumR / keep.weight;
    const gg = keep.sumG / keep.weight;
    const bb = keep.sumB / keep.weight;
    keep.hex = rgbToHex(rr, gg, bb);
    keep.lab = rgbToLab(rr, gg, bb);
    clusters = clusters.filter(function (_, idx) { return idx !== bi && idx !== bj; });
    clusters.push(keep);
  }
  const map = Object.create(null);
  clusters.forEach(function (c) {
    c.members.forEach(function (m) { map[m] = c.hex; });
  });
  return { map: map, palette: clusters.map(function (c) { return c.hex; }) };
}

function remapSvgFills(svgText, map) {
  return svgText.replace(/fill="(#[0-9A-Fa-f]{3,8})"/g, function (all, hex) {
    const n = normalizeHex(hex);
    const to = map[n];
    if (!to) return all;
    return 'fill="' + to + '"';
  });
}

function sealSvgPaths(svgText) {
  const wMatch = svgText.match(/\bwidth="([\d.]+)"/);
  const hMatch = svgText.match(/\bheight="([\d.]+)"/);
  const pxW = Number(wMatch && wMatch[1]) || 1000;
  const pxH = Number(hMatch && hMatch[1]) || 1000;
  const sw = Math.max(1.25, Math.min(pxW, pxH) * 0.0032);
  return svgText.replace(/<path\s+([^>]+?)\s*\/>/g, function (full, attrs) {
    const m = attrs.match(/fill="(#[0-9A-Fa-f]{3,8})"/i);
    if (!m) return full;
    const hex = normalizeHex(m[1]);
    let a = attrs
      .replace(/\s*stroke="[^"]*"/gi, "")
      .replace(/\s*stroke-width="[^"]*"/gi, "")
      .replace(/\s*stroke-linejoin="[^"]*"/gi, "")
      .replace(/\s*stroke-linecap="[^"]*"/gi, "")
      .replace(/\s*paint-order="[^"]*"/gi, "");
    a = a.replace(/fill="(#[0-9A-Fa-f]{3,8})"/i,
      'fill="' + hex + '" stroke="' + hex + '" stroke-width="' + sw.toFixed(2) +
      '" stroke-linejoin="round" stroke-linecap="round" paint-order="stroke fill"');
    return "<path " + a + " />";
  });
}

function stripFullCanvasFills(svgText) {
  const wMatch = svgText.match(/\bwidth="([\d.]+)"/);
  const hMatch = svgText.match(/\bheight="([\d.]+)"/);
  const pxW = Number(wMatch && wMatch[1]) || 0;
  const pxH = Number(hMatch && hMatch[1]) || 0;
  if (!pxW || !pxH) return svgText;
  return svgText.replace(/<path\s+([^>]+?)\s*\/>/g, function (full, attrs) {
    const dM = attrs.match(/\bd="([^"]*)"/);
    const tM = attrs.match(/\btransform="translate\(([^)]+)\)"/);
    if (!dM) return full;
    let tx = 0, ty = 0;
    if (tM) {
      const parts = tM[1].split(/[\s,]+/).map(Number);
      tx = parts[0] || 0;
      ty = parts[1] || 0;
    }
    const d = translatePath(dM[1], tx, ty);
    const b = pathBounds(d);
    if (b && b.w >= pxW * 0.98 && b.h >= pxH * 0.98) return "";
    return full;
  });
}

function parseSvg(svgText, widthIn, heightIn) {
  const wMatch = svgText.match(/\bwidth="([\d.]+)"/);
  const hMatch = svgText.match(/\bheight="([\d.]+)"/);
  const pxW = Number(wMatch && wMatch[1]) || 1;
  const pxH = Number(hMatch && hMatch[1]) || 1;
  const wIn = Number(widthIn) || 10;
  const hIn = Number(heightIn) || 10;
  const sx = wIn / pxW;
  const sy = hIn / pxH;

  const re = /<path\s+([^>]+?)\s*\/>/g;
  const byFill = new Map();
  let m;
  while ((m = re.exec(svgText))) {
    const attrs = m[1];
    const dM = attrs.match(/\bd="([^"]*)"/);
    const fM = attrs.match(/\bfill="([^"]*)"/);
    const tM = attrs.match(/\btransform="translate\(([^)]+)\)"/);
    if (!dM || !fM) continue;
    let fill = normalizeHex(fM[1]);
    if (fill === "none" || fill === "#00000000") continue;
    let tx = 0, ty = 0;
    if (tM) {
      const parts = tM[1].split(/[\s,]+/).map(Number);
      tx = parts[0] || 0;
      ty = parts[1] || 0;
    }
    let d = translatePath(dM[1], tx, ty);
    const b = pathBounds(d);
    if (b && b.w >= pxW * 0.98 && b.h >= pxH * 0.98) continue;
    if (isNearWhite(fill) && b && b.w >= pxW * 0.9 && b.h >= pxH * 0.9) continue;
    d = scalePathToInches(d, sx, sy);
    if (!byFill.has(fill)) byFill.set(fill, []);
    byFill.get(fill).push({ d: d, hole: false });
  }

  const layers = [];
  byFill.forEach(function (paths, hex) {
    layers.push({ hex: hex, nameGuess: "Layer " + (layers.length + 1), paths: paths });
  });
  layers.sort(function (a, b) {
    const sa = (a.paths || []).reduce(function (n, p) { return n + (p.d || "").length; }, 0);
    const sb = (b.paths || []).reduce(function (n, p) { return n + (p.d || "").length; }, 0);
    return sb - sa;
  });
  const annotated = annotateLayers(layers.length ? layers : [{ hex: "#111111", paths: [] }]);

  return {
    source: "vtracer",
    widthIn: wIn,
    heightIn: hIn,
    pixelWidth: pxW,
    pixelHeight: pxH,
    layers: annotated,
  };
}

/* --- raster preprocess: quantize + 1px trap + optional upscale --- */

function colorKey(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

function quantizeRgba(rgba, width, height, maxColors) {
  const n = Math.max(2, Math.min(24, maxColors || 8));
  const counts = Object.create(null);
  const keys = [];
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3];
    if (a < 40) continue;
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const k = colorKey(r, g, b);
    if (counts[k] == null) {
      counts[k] = 0;
      keys.push(k);
    }
    counts[k]++;
  }
  let clusters = keys.map(function (k) {
    const r = (k >> 16) & 255;
    const g = (k >> 8) & 255;
    const b = k & 255;
    return {
      key: k,
      r: r, g: g, b: b,
      lab: rgbToLab(r, g, b),
      weight: counts[k],
      sumR: r * counts[k],
      sumG: g * counts[k],
      sumB: b * counts[k],
      members: [k],
    };
  });
  while (clusters.length > n) {
    let bestD = Infinity, bi = 0, bj = 1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = labDist(clusters[i].lab, clusters[j].lab);
        if (d < bestD) { bestD = d; bi = i; bj = j; }
      }
    }
    const a = clusters[bi];
    const b = clusters[bj];
    const keep = a.weight >= b.weight ? a : b;
    const drop = keep === a ? b : a;
    keep.members = keep.members.concat(drop.members);
    keep.weight += drop.weight;
    keep.sumR += drop.sumR;
    keep.sumG += drop.sumG;
    keep.sumB += drop.sumB;
    keep.r = Math.round(keep.sumR / keep.weight);
    keep.g = Math.round(keep.sumG / keep.weight);
    keep.b = Math.round(keep.sumB / keep.weight);
    keep.lab = rgbToLab(keep.r, keep.g, keep.b);
    clusters = clusters.filter(function (_, idx) { return idx !== bi && idx !== bj; });
    clusters.push(keep);
  }
  const map = Object.create(null);
  clusters.forEach(function (c) {
    c.members.forEach(function (m) { map[m] = c; });
  });
  const out = Buffer.from(rgba);
  for (let i = 0; i < width * height; i++) {
    if (out[i * 4 + 3] < 40) {
      out[i * 4] = 255; out[i * 4 + 1] = 255; out[i * 4 + 2] = 255; out[i * 4 + 3] = 0;
      continue;
    }
    const k = colorKey(out[i * 4], out[i * 4 + 1], out[i * 4 + 2]);
    const c = map[k];
    if (!c) continue;
    out[i * 4] = c.r;
    out[i * 4 + 1] = c.g;
    out[i * 4 + 2] = c.b;
    out[i * 4 + 3] = 255;
  }
  return { rgba: out, palette: clusters.map(function (c) { return [c.r, c.g, c.b]; }) };
}

function dilateTrap(rgba, width, height, radius) {
  const rad = radius == null ? 1 : radius;
  if (rad < 1) return rgba;
  const out = Buffer.from(rgba);
  const dirs = rad <= 1
    ? [[1,0],[-1,0],[0,1],[0,-1]]
    : (function () {
        const d = [];
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            if (dx === 0 && dy === 0) continue;
            if (dx * dx + dy * dy <= rad * rad + 0.1) d.push([dx, dy]);
          }
        }
        return d;
      })();
  // Count area per opaque color
  const area = Object.create(null);
  for (let i = 0; i < width * height; i++) {
    if (rgba[i * 4 + 3] < 40) continue;
    const k = colorKey(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    area[k] = (area[k] || 0) + 1;
  }
  // Dilate larger colors first into smaller neighbors (trap underlap)
  const order = Object.keys(area).map(Number).sort(function (a, b) { return area[b] - area[a]; });
  order.forEach(function (k) {
    const r = (k >> 16) & 255;
    const g = (k >> 8) & 255;
    const b = k & 255;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (rgba[i * 4 + 3] < 40) continue;
        const ck = colorKey(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
        if (ck !== k) continue;
        for (let d = 0; d < dirs.length; d++) {
          const nx = x + dirs[d][0];
          const ny = y + dirs[d][1];
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = ny * width + nx;
          // expand into opaque differently-colored pixels only
          if (rgba[j * 4 + 3] < 40) continue;
          const nk = colorKey(rgba[j * 4], rgba[j * 4 + 1], rgba[j * 4 + 2]);
          if (nk === k) continue;
          if ((area[nk] || 0) >= (area[k] || 0)) continue; // only eat smaller
          out[j * 4] = r;
          out[j * 4 + 1] = g;
          out[j * 4 + 2] = b;
          out[j * 4 + 3] = 255;
        }
      }
    }
  });
  return out;
}

function nearestUpscale(rgba, width, height, scale) {
  const s = Math.max(1, Math.min(4, scale | 0));
  if (s === 1) return { rgba: rgba, width: width, height: height };
  const nw = width * s;
  const nh = height * s;
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = (y / s) | 0;
    for (let x = 0; x < nw; x++) {
      const sx = (x / s) | 0;
      const si = (sy * width + sx) * 4;
      const di = (y * nw + x) * 4;
      out[di] = rgba[si];
      out[di + 1] = rgba[si + 1];
      out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return { rgba: out, width: nw, height: nh };
}

function preprocessPng(pngBuf, opts) {
  opts = opts || {};
  const decoded = decodePng(pngBuf);
  const colors = Math.max(2, Math.min(16, Number(opts.colors) || 8));
  /* Fast posterize: snap channels to coarse bins, then map to nearest of top-N colors by count */
  const rgba = Buffer.from(decoded.rgba);
  const w = decoded.width;
  const h = decoded.height;
  const counts = Object.create(null);
  const step = colors <= 6 ? 32 : 24;
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] < 40) {
      rgba[i * 4] = 255; rgba[i * 4 + 1] = 255; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 0;
      continue;
    }
    const r = Math.min(255, Math.round(rgba[i * 4] / step) * step);
    const g = Math.min(255, Math.round(rgba[i * 4 + 1] / step) * step);
    const b = Math.min(255, Math.round(rgba[i * 4 + 2] / step) * step);
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
    const k = colorKey(r, g, b);
    counts[k] = (counts[k] || 0) + 1;
  }
  const top = Object.keys(counts).map(Number).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, colors);
  const pals = top.map(function (k) {
    return { k: k, r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255 };
  });
  for (let i = 0; i < w * h; i++) {
    if (rgba[i * 4 + 3] < 40) continue;
    let best = pals[0];
    let bestD = 1e18;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    for (let p = 0; p < pals.length; p++) {
      const dr = r - pals[p].r, dg = g - pals[p].g, db = b - pals[p].b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = pals[p]; }
    }
    rgba[i * 4] = best.r; rgba[i * 4 + 1] = best.g; rgba[i * 4 + 2] = best.b;
  }
  /* 1px 4-neighbor trap: expand each pixel into differently-colored neighbors (same color write) */
  if ((opts.trap == null ? 1 : opts.trap) > 0) {
    const src = Buffer.from(rgba);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (src[i * 4 + 3] < 40) continue;
        const r = src[i * 4], g = src[i * 4 + 1], b = src[i * 4 + 2];
        for (let d = 0; d < dirs.length; d++) {
          const nx = x + dirs[d][0], ny = y + dirs[d][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (src[j * 4 + 3] < 40) continue;
          if (src[j * 4] === r && src[j * 4 + 1] === g && src[j * 4 + 2] === b) continue;
          /* overlap into neighbor — keeps seams closed after vectorize */
          rgba[j * 4] = r; rgba[j * 4 + 1] = g; rgba[j * 4 + 2] = b; rgba[j * 4 + 3] = 255;
        }
      }
    }
  }
  const maxEdge = Math.max(w, h);
  const scale = opts.scale || (maxEdge < 700 ? 2 : 1);
  const up = nearestUpscale(rgba, w, h, scale);
  return encodePng(up.width, up.height, up.rgba);
}

function buildArgs(inPng, outSvg, opts) {
  const colors = Number(opts.colors) || 8;
  const args = ["-i", inPng, "-o", outSvg];
  args.push("--preset", String(opts.preset || "poster"));
  args.push(
    "--colormode", "color",
    /* stacked overlaps layers — cutout causes hairline gaps */
    "--hierarchical", opts.hierarchical || "stacked",
    "--mode", "spline",
    "--filter_speckle", String(opts.filterSpeckle != null ? opts.filterSpeckle : (colors <= 4 ? 2 : colors <= 8 ? 1 : 0)),
    "--color_precision", String(opts.colorPrecision != null ? opts.colorPrecision : 4),
    "--corner_threshold", String(opts.cornerThreshold != null ? opts.cornerThreshold : 55),
    "--segment_length", String(opts.segmentLength != null ? opts.segmentLength : 3.5),
    "--splice_threshold", String(opts.spliceThreshold != null ? opts.spliceThreshold : 45),
    "--path_precision", String(opts.pathPrecision != null ? opts.pathPrecision : 3)
  );
  if (opts.gradientStep != null) {
    args.push("--gradient_step", String(opts.gradientStep));
  }
  return args;
}

function vectorizeBuffer(pngBuf, opts) {
  opts = opts || {};
  if (!available()) {
    const err = new Error("VTracer binary missing");
    err.code = "NO_VTRACER";
    throw err;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-vt-"));
  const inPng = path.join(tmp, "in.png");
  const outSvg = path.join(tmp, "out.svg");
  try {
    let workBuf = pngBuf;
    try {
      workBuf = preprocessPng(pngBuf, opts);
    } catch (e) {
      workBuf = pngBuf;
    }
    fs.writeFileSync(inPng, workBuf);
    const args = buildArgs(inPng, outSvg, opts);
    const run = spawnSync(BIN, args, {
      encoding: "utf8",
      timeout: opts.timeoutMs || 120000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.error) throw run.error;
    if (run.status !== 0) {
      throw new Error((run.stderr || run.stdout || "VTracer failed").slice(0, 400));
    }
    if (!fs.existsSync(outSvg)) throw new Error("VTracer produced no SVG");
    let svg = fs.readFileSync(outSvg, "utf8");
    svg = stripFullCanvasFills(svg);
    const fillList = [];
    svg.replace(/fill="(#[0-9A-Fa-f]{3,8})"/g, function (_, hex) {
      fillList.push(hex);
      return _;
    });
    const maxColors = Math.max(2, Math.min(24, Number(opts.colors) || 8));
    const clustered = clusterPalette(fillList, maxColors);
    svg = remapSvgFills(svg, clustered.map);
    svg = sealSvgPaths(svg);
    // keep stroke hex in sync after remap already done — seal uses current fill
    const vec = parseSvg(svg, opts.widthIn, opts.heightIn);
    let eps = null;
    try {
      eps = Buffer.from(epsFromLayers(vec.layers, vec.widthIn, vec.heightIn), "utf8");
    } catch (e) {
      eps = null;
    }
    return { svg: svg, vec: vec, eps: eps, args: args, palette: clustered.palette };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

module.exports = {
  available: available,
  binaryPath: BIN,
  vectorizeBuffer: vectorizeBuffer,
  parseSvg: parseSvg,
  clusterPalette: clusterPalette,
  preprocessPng: preprocessPng,
  sealSvgPaths: sealSvgPaths,
};
