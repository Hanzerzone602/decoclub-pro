"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { epsFromLayers } = require("./eps");

const BIN = path.join(__dirname, "..", "bin", "vtracer");

function available() {
  try {
    return fs.existsSync(BIN) && fs.statSync(BIN).isFile();
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
    if (cmd === "Z") {
      nums = [];
      return;
    }
    const stride = cmd === "C" ? 6 : 2;
    for (let i = 0; i + stride - 1 < nums.length; i += stride) {
      for (let j = 0; j < stride; j += 2) {
        const x = Number(nums[i + j]) + tx;
        const y = Number(nums[i + j + 1]) + ty;
        out.push(String(Math.round(x * 1000) / 1000));
        out.push(String(Math.round(y * 1000) / 1000));
      }
    }
    nums = [];
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[MLCZmlcz]$/.test(t)) {
      flush();
      cmd = t.toUpperCase();
    } else {
      nums.push(t);
    }
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
    if (cmd === "Z") {
      nums = [];
      return;
    }
    const stride = cmd === "C" ? 6 : 2;
    for (let i = 0; i + stride - 1 < nums.length; i += stride) {
      for (let j = 0; j < stride; j += 2) {
        const x = Number(nums[i + j]) * sx;
        const y = Number(nums[i + j + 1]) * sy;
        out.push(String(Math.round(x * 10000) / 10000));
        out.push(String(Math.round(y * 10000) / 10000));
      }
    }
    nums = [];
  }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[MLCZ]$/i.test(t)) {
      flush();
      cmd = t.toUpperCase();
    } else {
      nums.push(t);
    }
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
    let bestD = Infinity;
    let bi = 0;
    let bj = 1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const d = labDist(clusters[i].lab, clusters[j].lab);
        if (d < bestD) {
          bestD = d;
          bi = i;
          bj = j;
        }
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
    layers.push({
      hex: hex,
      nameGuess: "Layer " + (layers.length + 1),
      paths: paths,
    });
  });
  layers.sort(function (a, b) {
    const sa = (a.paths || []).reduce(function (n, p) { return n + (p.d || "").length; }, 0);
    const sb = (b.paths || []).reduce(function (n, p) { return n + (p.d || "").length; }, 0);
    return sb - sa;
  });
  layers.forEach(function (L, i) { L.nameGuess = "Layer " + (i + 1); });

  return {
    source: "vtracer",
    widthIn: wIn,
    heightIn: hIn,
    pixelWidth: pxW,
    pixelHeight: pxH,
    layers: layers.length ? layers : [{ hex: "#111111", nameGuess: "Art", paths: [] }],
  };
}

function buildArgs(inPng, outSvg, opts) {
  const colors = Number(opts.colors) || 8;
  const args = ["-i", inPng, "-o", outSvg];
  if (opts.preset) {
    args.push("--preset", String(opts.preset));
  } else if (colors <= 6) {
    args.push("--preset", "poster");
  }
  args.push(
    "--colormode", "color",
    "--hierarchical", opts.hierarchical || "stacked",
    "--mode", "spline",
    "--filter_speckle", String(opts.filterSpeckle != null ? opts.filterSpeckle : (colors <= 4 ? 12 : colors <= 8 ? 8 : 4)),
    "--color_precision", String(opts.colorPrecision != null ? opts.colorPrecision : (colors <= 4 ? 4 : colors <= 8 ? 5 : 6)),
    "--corner_threshold", String(opts.cornerThreshold != null ? opts.cornerThreshold : 60),
    "--segment_length", String(opts.segmentLength != null ? opts.segmentLength : 4),
    "--splice_threshold", String(opts.spliceThreshold != null ? opts.spliceThreshold : 45),
    "--path_precision", String(opts.pathPrecision != null ? opts.pathPrecision : 2)
  );
  if (opts.gradientStep != null) {
    args.push("--gradient_step", String(opts.gradientStep));
  } else if (colors <= 8) {
    args.push("--gradient_step", "20");
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
    fs.writeFileSync(inPng, pngBuf);
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
};
