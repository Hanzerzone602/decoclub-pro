"use strict";

/**
 * CorelDRAW path-transfer import (EXPLICIT Studio mode — not default PNG Vectorize).
 *
 * Corel SVG often places art coordinates outside the declared viewBox (page).
 * This remaps path data into a square studio SVG and builds colorspec layers.
 *
 * Triggers (server.js): body.engine === "corel-import", Corel SVG upload,
 * or POST /api/jobs/:id/corel-import — never the default Vectorize button.
 *
 * Port of scripts/corel_path_transfer.py (perfect-bezier gold tiger path).
 */

const colorspec = require("./colorspec");

const TOKEN_RE = /[MmCcLlZzHhVvSsQqTtAa]|[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g;
const CLASS_FILL_RE = /\.(fil\d+)\s*\{([^}]+)\}/g;
const PATH_RE = /<path\s+class="(fil\d+)"\s+d="([^"]+)"/g;
const INLINE_PATH_RE = /<path\b([^>]*)>/gi;

function isCorelSvg(text) {
  if (!text || typeof text !== "string") return false;
  const s = text.slice(0, 8000);
  return (
    /Creator:\s*CorelDRAW/i.test(s) ||
    /xmlns:xodm=["'][^"']*corel\.com/i.test(s) ||
    /CorelCorpID/i.test(s) ||
    (/http:\/\/www\.corel\.com/i.test(s) && /\.fil\d+\s*\{/.test(s))
  );
}

function looksLikeSvg(bufOrText) {
  const s = Buffer.isBuffer(bufOrText)
    ? bufOrText.slice(0, 512).toString("utf8")
    : String(bufOrText || "").slice(0, 512);
  return /^\s*(<\?xml|<!DOCTYPE\s+svg|<svg\b)/i.test(s);
}

function parseFillClasses(svgText) {
  const fills = Object.create(null);
  let m;
  CLASS_FILL_RE.lastIndex = 0;
  while ((m = CLASS_FILL_RE.exec(svgText))) {
    const fillM = /fill:\s*(#[0-9A-Fa-f]{3,8})/i.exec(m[2]);
    if (fillM) fills[m[1]] = fillM[1].toLowerCase();
  }
  return fills;
}

function tokenizePath(d) {
  TOKEN_RE.lastIndex = 0;
  const out = [];
  let m;
  while ((m = TOKEN_RE.exec(d))) out.push(m[0]);
  return out;
}

function walkPath(d, onPoint, onRelScale) {
  const tokens = tokenizePath(d);
  let i = 0;
  let cmd = null;
  let x = 0;
  let y = 0;
  let startx = 0;
  let starty = 0;
  const out = [];

  function emitAbs(nx, ny) {
    x = nx;
    y = ny;
    if (onPoint) onPoint(x, y);
  }

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) {
      cmd = t;
      i += 1;
      if (cmd === "Z" || cmd === "z") {
        out.push("Z");
        x = startx;
        y = starty;
      }
      continue;
    }
    if (!cmd) {
      i += 1;
      continue;
    }

    if (cmd === "M") {
      const nx = +t;
      const ny = +tokens[i + 1];
      i += 2;
      emitAbs(nx, ny);
      startx = x;
      starty = y;
      if (onRelScale) {
        const p = onRelScale.abs(x, y);
        out.push("M " + fmt4(p[0]) + " " + fmt4(p[1]));
      }
      cmd = "L";
    } else if (cmd === "m") {
      const nx = x + +t;
      const ny = y + +tokens[i + 1];
      i += 2;
      emitAbs(nx, ny);
      startx = x;
      starty = y;
      if (onRelScale) {
        const p = onRelScale.abs(x, y);
        out.push("M " + fmt4(p[0]) + " " + fmt4(p[1]));
      }
      cmd = "l";
    } else if (cmd === "L") {
      const nx = +t;
      const ny = +tokens[i + 1];
      i += 2;
      emitAbs(nx, ny);
      if (onRelScale) {
        const p = onRelScale.abs(x, y);
        out.push("L " + fmt4(p[0]) + " " + fmt4(p[1]));
      }
    } else if (cmd === "l") {
      const dx = +t;
      const dy = +tokens[i + 1];
      i += 2;
      emitAbs(x + dx, y + dy);
      if (onRelScale) out.push("l " + fmt4(onRelScale.scale(dx)) + " " + fmt4(onRelScale.scale(dy)));
    } else if (cmd === "C") {
      const nums = [];
      for (let k = 0; k < 6; k++) nums.push(+tokens[i + k]);
      i += 6;
      for (let k = 0; k < 6; k += 2) if (onPoint) onPoint(nums[k], nums[k + 1]);
      x = nums[4];
      y = nums[5];
      if (onRelScale) {
        const pts = [];
        for (let k = 0; k < 6; k += 2) {
          const p = onRelScale.abs(nums[k], nums[k + 1]);
          pts.push(fmt4(p[0]), fmt4(p[1]));
        }
        out.push("C " + pts.join(" "));
      }
    } else if (cmd === "c") {
      const nums = [];
      for (let k = 0; k < 6; k++) nums.push(+tokens[i + k]);
      i += 6;
      for (let k = 0; k < 6; k += 2) if (onPoint) onPoint(x + nums[k], y + nums[k + 1]);
      x += nums[4];
      y += nums[5];
      if (onRelScale) {
        const scaled = nums.map(function (n) { return fmt4(onRelScale.scale(n)); });
        out.push("c " + scaled.join(" "));
      }
    } else if (cmd === "S") {
      const nums = [];
      for (let k = 0; k < 4; k++) nums.push(+tokens[i + k]);
      i += 4;
      for (let k = 0; k < 4; k += 2) if (onPoint) onPoint(nums[k], nums[k + 1]);
      x = nums[2];
      y = nums[3];
      if (onRelScale) {
        const pts = [];
        for (let k = 0; k < 4; k += 2) {
          const p = onRelScale.abs(nums[k], nums[k + 1]);
          pts.push(fmt4(p[0]), fmt4(p[1]));
        }
        out.push("S " + pts.join(" "));
      }
    } else if (cmd === "s") {
      const nums = [];
      for (let k = 0; k < 4; k++) nums.push(+tokens[i + k]);
      i += 4;
      for (let k = 0; k < 4; k += 2) if (onPoint) onPoint(x + nums[k], y + nums[k + 1]);
      x += nums[2];
      y += nums[3];
      if (onRelScale) {
        const scaled = nums.map(function (n) { return fmt4(onRelScale.scale(n)); });
        out.push("s " + scaled.join(" "));
      }
    } else if (cmd === "H") {
      x = +t;
      i += 1;
      if (onPoint) onPoint(x, y);
      if (onRelScale) out.push("H " + fmt4(onRelScale.abs(x, y)[0]));
    } else if (cmd === "h") {
      const dx = +t;
      i += 1;
      x += dx;
      if (onPoint) onPoint(x, y);
      if (onRelScale) out.push("h " + fmt4(onRelScale.scale(dx)));
    } else if (cmd === "V") {
      y = +t;
      i += 1;
      if (onPoint) onPoint(x, y);
      if (onRelScale) out.push("V " + fmt4(onRelScale.abs(x, y)[1]));
    } else if (cmd === "v") {
      const dy = +t;
      i += 1;
      y += dy;
      if (onPoint) onPoint(x, y);
      if (onRelScale) out.push("v " + fmt4(onRelScale.scale(dy)));
    } else {
      i += 1;
    }
  }
  return out.join(" ");
}

function fmt4(n) {
  return (Math.round(Number(n) * 10000) / 10000).toFixed(4);
}

function extractClassPaths(svgText) {
  const fills = parseFillClasses(svgText);
  const paths = [];
  PATH_RE.lastIndex = 0;
  let m;
  while ((m = PATH_RE.exec(svgText))) {
    paths.push({
      hex: fills[m[1]] || "#000000",
      d: m[2],
      className: m[1],
    });
  }
  if (paths.length) return paths;

  // Fallback: inline fill= on <path> (non-class Corel / cleaned SVG)
  INLINE_PATH_RE.lastIndex = 0;
  while ((m = INLINE_PATH_RE.exec(svgText))) {
    const attrs = m[1];
    const dM = /\bd\s*=\s*"([^"]+)"/.exec(attrs) || /\bd\s*=\s*'([^']+)'/.exec(attrs);
    if (!dM) continue;
    let hex = "#000000";
    const fillM = /\bfill\s*=\s*"([^"]+)"/.exec(attrs) || /\bfill\s*=\s*'([^']+)'/.exec(attrs);
    if (fillM && /^#?[0-9a-fA-F]{3,8}$/.test(fillM[1].replace(/\s/g, ""))) {
      hex = fillM[1].trim();
      if (hex[0] !== "#") hex = "#" + hex;
      hex = hex.toLowerCase();
    }
    if (/fill\s*:\s*none/i.test(attrs) || hex === "none") continue;
    paths.push({ hex: hex, d: dM[1], className: null });
  }
  return paths;
}

function parseViewBox(svgText) {
  const m = /viewBox\s*=\s*"([^"]+)"/i.exec(svgText);
  if (!m) return null;
  const p = m[1].trim().split(/[\s,]+/).map(Number);
  if (p.length < 4 || p.some(function (n) { return !isFinite(n); })) return null;
  return { x: p[0], y: p[1], w: p[2], h: p[3] };
}

function measureBBox(paths) {

  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  let n = 0;
  for (let i = 0; i < paths.length; i++) {
    walkPath(paths[i].d, function (x, y) {
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
      n += 1;
    }, null);
  }
  if (!n || !isFinite(minx)) {
    return { minx: 0, miny: 0, maxx: 1, maxy: 1, points: 0 };
  }
  return { minx: minx, miny: miny, maxx: maxx, maxy: maxy, points: n };
}

function buildXform(bbox, sizeIn, pad) {
  let minx = bbox.minx - pad;
  let miny = bbox.miny - pad;
  let maxx = bbox.maxx + pad;
  let maxy = bbox.maxy + pad;
  const bw = maxx - minx;
  const bh = maxy - miny;
  const side = Math.max(bw, bh) || 1;
  const ox = minx - (side - bw) / 2;
  const oy = miny - (side - bh) / 2;
  const SCALE = sizeIn / side;
  return {
    sizeIn: sizeIn,
    scale: SCALE,
    ox: ox,
    oy: oy,
    side: side,
    abs: function (x, y) {
      return [(x - ox) * SCALE, (y - oy) * SCALE];
    },
    scaleDelta: function (n) {
      return n * SCALE;
    },
  };
}

function normalizeHex(hex) {
  let h = String(hex || "#000000").trim().toLowerCase();
  if (h[0] !== "#") h = "#" + h;
  if (h.length === 4) h = "#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return h.slice(0, 7);
}

/**
 * @param {string|Buffer} svgInput - CorelDRAW SVG text or buffer
 * @param {object} [opts]
 * @param {number} [opts.sizeIn=10] - studio square size in inches
 * @param {number} [opts.pad=40] - padding in source units before square fit
 * @param {object} [opts.bbox] - optional {minx,miny,maxx,maxy} override (tiger gold used measured extent)
 * @param {boolean} [opts.paperUnderlay=true]
 * @returns {{ svg: string, vec: object, meta: object }}
 */
function transfer(svgInput, opts) {
  opts = opts || {};
  const text = Buffer.isBuffer(svgInput) ? svgInput.toString("utf8") : String(svgInput || "");
  if (!looksLikeSvg(text)) {
    const err = new Error("Not an SVG document");
    err.code = "NOT_SVG";
    throw err;
  }

  const sizeIn = Number(opts.sizeIn) > 0 ? Number(opts.sizeIn) : 10;
  const pad = opts.pad != null ? Number(opts.pad) : 40;
  const paths = extractClassPaths(text);
  if (!paths.length) {
    const err = new Error("No transferable paths found in SVG");
    err.code = "NO_PATHS";
    throw err;
  }

  let bbox;
  let usedViewBox = false;
  const vb = parseViewBox(text);
  if (opts.bbox && opts.bbox.minx != null) {
    bbox = {
      minx: +opts.bbox.minx,
      miny: +opts.bbox.miny,
      maxx: +opts.bbox.maxx,
      maxy: +opts.bbox.maxy,
      points: 0,
    };
  } else if (opts.preferViewBox !== false && vb && vb.w > 0 && vb.h > 0) {
    // Invent A winner: honor Corel artbox/page viewBox exactly (no pad expand).
    // Square or near-square viewBoxes frame PowerTRACE exports cleanly.
    const aspect = vb.w / vb.h;
    if (aspect > 0.85 && aspect < 1.18) {
      bbox = { minx: vb.x, miny: vb.y, maxx: vb.x + vb.w, maxy: vb.y + vb.h, points: 0 };
      usedViewBox = true;
    }
  }
  if (!bbox) bbox = measureBBox(paths);

  // When using declared viewBox, invent-A recipe uses pad=0 for pixel-match framing
  const padEff = usedViewBox && opts.pad == null ? 0 : pad;
  const xf = buildXform(bbox, sizeIn, padEff);
  const xformApi = {
    abs: xf.abs,
    scale: xf.scaleDelta,
  };

  const transferred = [];
  for (let i = 0; i < paths.length; i++) {
    const hex = normalizeHex(paths[i].hex);
    const d = walkPath(paths[i].d, null, xformApi);
    transferred.push({ hex: hex, d: d });
  }

  // Group by fill → studio layers (preserve paint order within each color)
  const byHex = Object.create(null);
  const order = [];
  for (let i = 0; i < transferred.length; i++) {
    const hex = transferred[i].hex;
    if (!byHex[hex]) {
      byHex[hex] = [];
      order.push(hex);
    }
    byHex[hex].push({ d: transferred[i].d, hole: false });
  }

  const layers = order.map(function (hex) {
    return colorspec.annotateLayer({
      hex: hex,
      paths: byHex[hex],
    });
  });

  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      sizeIn +
      'in" height="' +
      sizeIn +
      'in" viewBox="0 0 ' +
      sizeIn +
      " " +
      sizeIn +
      '">',
  ];
  if (opts.paperUnderlay !== false) {
    parts.push(
      '  <rect x="0" y="0" width="' +
        sizeIn +
        '" height="' +
        sizeIn +
        '" fill="#f0f4f9" data-name="paper-underlay"/>'
    );
  }
  for (let i = 0; i < transferred.length; i++) {
    parts.push(
      '  <path d="' +
        transferred[i].d +
        '" fill="' +
        transferred[i].hex +
        '" fill-rule="nonzero"/>'
    );
  }
  parts.push("</svg>");
  const svg = parts.join("\n") + "\n";

  const fillCounts = Object.create(null);
  for (let i = 0; i < transferred.length; i++) {
    const h = transferred[i].hex;
    fillCounts[h] = (fillCounts[h] || 0) + 1;
  }

  const vec = {
    widthIn: sizeIn,
    heightIn: sizeIn,
    source: "corel-import",
    layers: layers,
    meta: {
      engine: "corel-import",
      paths: transferred.length,
      colors: layers.length,
      corelDetected: isCorelSvg(text),
      bbox: { minx: bbox.minx, miny: bbox.miny, maxx: bbox.maxx, maxy: bbox.maxy },
      pad: padEff,
      usedViewBox: usedViewBox,
      scale: xf.scale,
    },
  };

  return {
    svg: svg,
    vec: vec,
    meta: {
      paths: transferred.length,
      fills: fillCounts,
      bytes: Buffer.byteLength(svg, "utf8"),
      corelDetected: isCorelSvg(text),
    },
  };
}

function transferBuffer(buf, opts) {
  return transfer(buf, opts);
}

module.exports = {
  transfer: transfer,
  transferBuffer: transferBuffer,
  isCorelSvg: isCorelSvg,
  looksLikeSvg: looksLikeSvg,
  measureBBox: measureBBox,
  extractClassPaths: extractClassPaths,
  parseViewBox: parseViewBox,
};
