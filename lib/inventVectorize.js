"use strict";

/**
 * Invent vectorize paths (perfect-bezier/invent bake-off 2026-09-06).
 *
 * Winner for Corel-equal: path-transfer (A) via corelImport with viewBox framing.
 * Runner-up free raster: corelTrace (B) — VTracer cutout tuned on Corel rasters.
 * Hybrid (C): SRC bezier + Corel ROI grafts — experimental, usually worse than A.
 *
 * Optional engines (server): invent | invent-transfer | invent-trace | invent-hybrid
 * Default PNG Vectorize stays bezier unless engine is set.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const corelImport = require("./corelImport");
const bezierVectorize = require("./bezierVectorize");
const vtracer = require("./vtracer");
const colorspec = require("./colorspec");

const VTRACER_BIN = path.join(__dirname, "..", "bin", "vtracer");

function pathTransfer(svgInput, opts) {
  opts = opts || {};
  const result = corelImport.transfer(svgInput, Object.assign({
    sizeIn: opts.sizeIn || opts.widthIn || 10,
    preferViewBox: opts.preferViewBox !== false,
    paperUnderlay: opts.paperUnderlay !== false,
    pad: opts.pad,
    bbox: opts.bbox,
  }, opts));
  if (result.vec) result.vec.source = "invent-path-transfer";
  if (result.vec && result.vec.meta) result.vec.meta.invent = "A-path-transfer";
  return result;
}

/**
 * B) Trace a Corel-like (or any) raster with VTracer cutout settings that
 * scored best vs Corel gold among free tracers in invent/.
 */
function corelTrace(pngBuf, widthIn, heightIn, opts) {
  opts = opts || {};
  widthIn = Number(widthIn) || 10;
  heightIn = Number(heightIn) || widthIn;
  if (!vtracer.available()) {
    const err = new Error("VTracer binary missing");
    err.code = "NO_VTRACER";
    throw err;
  }
  // Prefer dedicated invent flags; fall back to lib/vtracer defaults
  const result = vtracer.vectorizeBuffer(pngBuf, {
    widthIn: widthIn,
    heightIn: heightIn,
    colors: opts.colors,
    timeoutMs: opts.timeoutMs || 120000,
    // Hint — vtracer.js may ignore unknown keys; also run raw below if needed
    filterSpeckle: opts.filterSpeckle != null ? opts.filterSpeckle : 8,
    colorPrecision: opts.colorPrecision != null ? opts.colorPrecision : 6,
    gradientStep: opts.gradientStep != null ? opts.gradientStep : 16,
    hierarchical: "cutout",
    mode: "spline",
  });
  if (result.vec) {
    result.vec.source = "invent-corel-trace";
    result.vec.meta = Object.assign({}, result.vec.meta || {}, {
      engine: "invent-trace",
      invent: "B-vtracer-cutout",
    });
  }
  return result;
}

/**
 * Raw VTracer with invent-B flags when vtracer.vectorizeBuffer doesn't expose them.
 */
function corelTraceRaw(pngBuf, widthIn, heightIn, opts) {
  opts = opts || {};
  widthIn = Number(widthIn) || 10;
  heightIn = Number(heightIn) || widthIn;
  if (!fs.existsSync(VTRACER_BIN)) {
    return corelTrace(pngBuf, widthIn, heightIn, opts);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "invent-vt-"));
  const inp = path.join(tmp, "in.png");
  const out = path.join(tmp, "out.svg");
  try {
    fs.writeFileSync(inp, pngBuf);
    const args = [
      "--input", inp, "--output", out,
      "--colormode", "color",
      "--hierarchical", "cutout",
      "--filter_speckle", String(opts.filterSpeckle != null ? opts.filterSpeckle : 8),
      "--color_precision", String(opts.colorPrecision != null ? opts.colorPrecision : 6),
      "--gradient_step", String(opts.gradientStep != null ? opts.gradientStep : 16),
      "--corner_threshold", String(opts.cornerThreshold != null ? opts.cornerThreshold : 60),
      "--segment_length", String(opts.segmentLength != null ? opts.segmentLength : 4),
      "--path_precision", String(opts.pathPrecision != null ? opts.pathPrecision : 8),
      "--mode", "spline",
    ];
    const r = spawnSync(VTRACER_BIN, args, { encoding: "utf8", timeout: opts.timeoutMs || 120000 });
    if (r.status !== 0 || !fs.existsSync(out)) {
      const err = new Error(r.stderr || r.stdout || "vtracer failed");
      err.code = "VTRACER_FAIL";
      throw err;
    }
    let svg = fs.readFileSync(out, "utf8");
    // Remap to studio inches if needed — keep native; studio often accepts pixel viewBox
    // Wrap in studio size when viewBox is pixel-based
    if (!/width="[^"]*in"/.test(svg)) {
      const vb = /viewBox="0 0 ([0-9.]+) ([0-9.]+)"/.exec(svg);
      if (vb) {
        const pw = parseFloat(vb[1]), ph = parseFloat(vb[2]);
        // scale group into inch space
        const sx = widthIn / pw, sy = heightIn / ph;
        svg =
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="' + widthIn + 'in" height="' + heightIn +
          'in" viewBox="0 0 ' + widthIn + " " + heightIn + '">\n' +
          '  <rect x="0" y="0" width="' + widthIn + '" height="' + heightIn +
          '" fill="#f0f4f9" data-name="paper-underlay"/>\n' +
          '  <g transform="scale(' + sx + " " + sy + ')">\n' +
          svg.replace(/^[\s\S]*?<svg[^>]*>/i, "").replace(/<\/svg>\s*$/i, "") +
          "\n  </g>\n</svg>\n";
      }
    }
    const layers = colorspec.annotateLayers(
      guessLayersFromSvg(svg)
    );
    const vec = {
      widthIn: widthIn,
      heightIn: heightIn,
      source: "invent-corel-trace",
      layers: layers,
      meta: { engine: "invent-trace", invent: "B-vtracer-cutout-raw", colors: layers.length },
    };
    return { svg: svg, vec: vec, meta: vec.meta };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

function guessLayersFromSvg(svg) {
  const fills = [];
  const seen = new Set();
  const re = /fill\s*=\s*["'](#[0-9a-fA-F]{3,8})["']/g;
  let m;
  while ((m = re.exec(svg))) {
    let hex = m[1].toLowerCase();
    if (hex.length === 4) hex = "#" + hex[1]+hex[1]+hex[2]+hex[2]+hex[3]+hex[3];
    hex = hex.slice(0, 7);
    if (hex === "#ffffff" || hex === "#f0f4f9") continue;
    if (seen.has(hex)) continue;
    seen.add(hex);
    fills.push(hex);
  }
  return fills.map(function (hex) {
    return colorspec.annotateLayer({ hex: hex, paths: [] });
  });
}

/**
 * Dispatch invent modes.
 * @param {Buffer|string} input - PNG buffer, or Corel SVG text/buffer for path-transfer
 * @param {number} widthIn
 * @param {number} heightIn
 * @param {object} opts - { mode: 'transfer'|'trace'|'hybrid'|'auto', ... }
 */
function vectorizeToSvg(input, widthIn, heightIn, opts) {
  opts = opts || {};
  const mode = String(opts.mode || opts.invent || "auto").toLowerCase();

  const isSvg = corelImport.looksLikeSvg(input);
  if (mode === "transfer" || mode === "path-transfer" || mode === "a" ||
      (mode === "auto" && isSvg && corelImport.isCorelSvg(
        Buffer.isBuffer(input) ? input.toString("utf8") : String(input)
      ))) {
    return pathTransfer(input, Object.assign({}, opts, { sizeIn: widthIn || opts.sizeIn || 10 }));
  }

  if (mode === "trace" || mode === "corel-trace" || mode === "b" || mode === "auto") {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    try {
      return corelTraceRaw(buf, widthIn, heightIn, opts);
    } catch (e) {
      return corelTrace(buf, widthIn, heightIn, opts);
    }
  }

  if (mode === "hybrid" || mode === "c") {
    /* Experimental hybrid grafts deferred — use path-transfer (Corel SVG) or bezier (PNG). */
    return bezierVectorize.vectorizeToSvg(input, widthIn, heightIn, Object.assign({}, opts, { look: "corel" }));
  }

  return bezierVectorize.vectorizeToSvg(input, widthIn, heightIn, opts);
}

module.exports = {
  pathTransfer: pathTransfer,
  corelTrace: corelTrace,
  corelTraceRaw: corelTraceRaw,
  vectorizeToSvg: vectorizeToSvg,
  WINNER: "A-path-transfer",
  RUNNER_UP: "B-vtracer-cutout",
};
