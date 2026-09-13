"use strict";

/**
 * Any-dropped-image digitize path.
 * Raster → PNG → DecoClub vectorize (vai-trace default, JS tracer fallback)
 * → SVG layers with real path data → digitize.
 * Does NOT call invent-warp. Does not special-case filenames.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { layersFromSvg, hasRealPaths } = require("./svgLayers");
const { decodePng } = require("../png");

function attachSourceRaster(parsed, pngBuf) {
  if (!parsed || !pngBuf) return parsed;
  try {
    const img = decodePng(pngBuf);
    if (img && img.rgba && img.width > 4) {
      parsed.sourceRgba = img.rgba;
      parsed.sourceW = img.width;
      parsed.sourceH = img.height;
    }
  } catch (e) { /* keep vector-only */ }
  return parsed;
}

function pythonCandidates() {
  const env = process.env.DIGITIZE_PYTHON || process.env.INVENT_WARP_PYTHON;
  return [
    env,
    path.join(__dirname, "..", "..", ".venv", "bin", "python"),
    path.join(__dirname, "..", "..", "..", "digitize-build", ".venv", "bin", "python"),
    "/venv/bin/python3",
    "python3",
    "python",
  ].filter(Boolean);
}

function resolveLib(rel) {
  const here = path.join(__dirname, "..", rel); // railway: lib/stitch → lib/rel
  const rail = path.join("/workspace/decoclub-railway/lib", rel);
  const sibling = path.join(__dirname, "..", "..", "..", "decoclub-railway", "lib", rel);
  const tries = [here, sibling, rail];
  for (let i = 0; i < tries.length; i++) {
    try {
      if (fs.existsSync(tries[i] + ".js") || fs.existsSync(tries[i])) return require(tries[i]);
    } catch (e) { /* next */ }
  }
  return null;
}

function looksPng(buf) {
  return buf && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function looksJpeg(buf) {
  return buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
}

function looksWebp(buf) {
  return buf && buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
}

function looksSvg(buf) {
  const head = buf.slice(0, 200).toString("utf8");
  return /<svg[\s>]/i.test(head);
}

function ensurePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (looksPng(buf)) return buf;
  if (looksSvg(buf)) {
    throw new Error("SVG input should be parsed via layersFromSvg, not rasterized");
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-img-"));
  const inp = path.join(tmp, "in.bin");
  const outp = path.join(tmp, "out.png");
  fs.writeFileSync(inp, buf);
  const script = [
    "from PIL import Image",
    "import sys",
    "im = Image.open(sys.argv[1])",
    "if im.mode not in ('RGB','RGBA'): im = im.convert('RGBA')",
    "else: im = im.convert('RGBA')",
    "im.save(sys.argv[2], 'PNG')",
  ].join("\n");
  let last = "";
  for (const py of pythonCandidates()) {
    const r = spawnSync(py, ["-c", script, inp, outp], { encoding: "utf8", timeout: 20000 });
    if (r.status === 0 && fs.existsSync(outp)) {
      const png = fs.readFileSync(outp);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
      return png;
    }
    last = (r.stderr || r.stdout || "").toString().slice(0, 300);
  }
  const magick = spawnSync("convert", [inp, "png:" + outp], { encoding: "utf8", timeout: 20000 });
  if (magick.status === 0 && fs.existsSync(outp)) {
    const png = fs.readFileSync(outp);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    return png;
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  throw new Error("Could not convert artwork to PNG: " + last);
}

function vectorizeAny(pngBuf, widthIn, heightIn, opts) {
  opts = opts || {};
  const w = Number(widthIn) || 3;
  const h = Number(heightIn) || 3;
  const vai = resolveLib("vaiTrace");
  if (vai && typeof vai.available === "function" && vai.available() && typeof vai.vectorizeBuffer === "function") {
    const r = vai.vectorizeBuffer(pngBuf, {
      widthIn: w,
      heightIn: h,
      colors: opts.colors,
      mode: opts.mode || "auto",
      timeoutMs: opts.timeoutMs || 180000,
    });
    // SVG is already in inches (usually a square of max(w,h)). Keep native
    // coordinates — do not squash to a different aspect.
    const parsed = layersFromSvg(r.svg);
    if (parsed.layers && parsed.layers.length) {
      parsed.source = "vai-trace";
      parsed.svg = r.svg;
      parsed.meta = r.meta;
      return attachSourceRaster(parsed, pngBuf);
    }
  }
  const vz = resolveLib("vectorize");
  if (vz && typeof vz.vectorize === "function") {
    const vec = vz.vectorize(pngBuf, w, h, {
      colors: opts.colors == null ? 8 : opts.colors,
      maxEdge: opts.maxEdge || 720,
    });
    if (vec && vec.layers && vec.layers.length) {
      vec.source = vec.source || "vectorize";
      return attachSourceRaster(vec, pngBuf);
    }
  }
  throw new Error("No vectorize engine available (vai-trace / vectorize.js)");
}

function vectorFromInput(input, widthIn, heightIn, opts) {
  opts = opts || {};
  if (input && input.layers && hasRealPaths(input)) {
    return {
      widthIn: Number(widthIn || input.widthIn) || 1,
      heightIn: Number(heightIn || input.heightIn) || 1,
      layers: input.layers,
      source: input.source || "vector",
    };
  }
  if (typeof input === "string" && /<svg[\s>]/i.test(input)) {
    return layersFromSvg(input, widthIn, heightIn);
  }
  let buf = input;
  if (typeof input === "string" && fs.existsSync(input)) buf = fs.readFileSync(input);
  if (!Buffer.isBuffer(buf)) throw new Error("Need image buffer, SVG, or vector layers");
  if (looksSvg(buf)) return layersFromSvg(buf.toString("utf8"), widthIn, heightIn);
  const png = ensurePng(buf);
  return vectorizeAny(png, widthIn, heightIn, opts);
}

function hoopFromImage(buf, longIn) {
  longIn = Number(longIn) || 3;
  // Best-effort aspect from PNG header
  let w = 1, h = 1;
  try {
    const png = looksPng(buf) ? buf : ensurePng(buf);
    if (png[0] === 0x89) {
      w = png.readUInt32BE(16);
      h = png.readUInt32BE(20);
    }
  } catch (e) { w = 1; h = 1; }
  const aspect = (w || 1) / (h || 1);
  if (aspect >= 1) return { widthIn: longIn, heightIn: longIn / aspect };
  return { widthIn: longIn * aspect, heightIn: longIn };
}

module.exports = {
  ensurePng,
  vectorizeAny,
  vectorFromInput,
  hoopFromImage,
  looksPng,
  looksJpeg,
  looksSvg,
  hasRealPaths,
  layersFromSvg,
};
