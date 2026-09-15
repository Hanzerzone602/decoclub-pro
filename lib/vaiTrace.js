"use strict";

/**
 * vai-trace — local hierarchical Lab + cubic SVG (Grok Build Vectorizer.AI-class path).
 * Twin soft-tiger stays invent-warp; everything else uses this before VTracer.
 *
 * Prefer vectorizeBufferAsync in HTTP handlers: spawnSync blocks the Node event
 * loop for the whole timeout window and can wedge Railway on huge art.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { annotateLayers } = require("./colorspec");
const { layersFromSvg: parseSvgLayers } = require("./stitch/svgLayers");

const SCRIPT = path.join(__dirname, "vai-trace", "trace.py");
const GEOM = path.join(__dirname, "vai-trace", "geom.py");

function resolvePython() {
  if (process.env.INVENT_WARP_PYTHON && fs.existsSync(process.env.INVENT_WARP_PYTHON)) {
    return process.env.INVENT_WARP_PYTHON;
  }
  const venv = path.join(__dirname, "..", ".venv", "bin", "python3");
  if (fs.existsSync(venv)) return venv;
  return "python3";
}

function pythonPathEnv() {
  return Object.assign({}, process.env, {
    PYTHONPATH: [path.join(__dirname, "vai-trace"), path.join(__dirname, "..", "pydeps"), process.env.PYTHONPATH || ""]
      .filter(Boolean)
      .join(path.delimiter),
  });
}

let _depsOk = null;
let _depsErr = null;

function pythonDepsOk() {
  if (_depsOk !== null) return _depsOk;
  try {
    const py = resolvePython();
    const r = spawnSync(
      py,
      ["-c", "import cv2, numpy, PIL; print('ok')"],
      {
        encoding: "utf8",
        timeout: 20000,
        env: Object.assign({}, process.env, {
          PYTHONPATH: [path.join(__dirname, "..", "pydeps"), process.env.PYTHONPATH || ""]
            .filter(Boolean)
            .join(path.delimiter),
        }),
      }
    );
    _depsOk = r.status === 0;
    _depsErr = _depsOk
      ? null
      : "import fail: " + String(r.stderr || r.stdout || "cv2/numpy/PIL missing").slice(0, 350);
  } catch (e) {
    _depsOk = false;
    _depsErr = String((e && e.message) || e).slice(0, 400);
  }
  return _depsOk;
}

function available() {
  if (!fs.existsSync(SCRIPT) || !fs.existsSync(GEOM)) {
    _depsErr = "vai-trace scripts missing";
    return false;
  }
  return pythonDepsOk();
}

function unavailableReason() {
  if (available()) return null;
  return _depsErr || "vai-trace unavailable";
}

function layersFromSvg(svg, widthIn, heightIn) {
  const parsed = parseSvgLayers(svg, widthIn, heightIn);
  return parsed.layers || [];
}

function looksLikeJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

function looksLikePng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

function looksLikeWebp(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
}

function decodeRasterToPng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (looksLikePng(buf)) return buf;
  const py = resolvePython();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vai-decode-"));
  const inn = path.join(tmpDir, "in.bin");
  const out = path.join(tmpDir, "out.png");
  try {
    fs.writeFileSync(inn, buf);
    const r = spawnSync(
      py,
      [
        "-c",
        "from PIL import Image; import sys; im=Image.open(sys.argv[1]); im.convert('RGBA').save(sys.argv[2], 'PNG')",
        inn,
        out,
      ],
      {
        encoding: "utf8",
        timeout: 30000,
        env: Object.assign({}, process.env, {
          PYTHONPATH: [path.join(__dirname, "..", "pydeps"), process.env.PYTHONPATH || ""]
            .filter(Boolean)
            .join(path.delimiter),
        }),
      }
    );
    if (r.status !== 0 || !fs.existsSync(out)) {
      const err = new Error(String(r.stderr || r.stdout || "Could not decode JPEG/WebP to PNG").slice(0, 400));
      err.code = "DECODE_FAIL";
      throw err;
    }
    return fs.readFileSync(out);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

function buildResult(svg, stdout, widthIn, heightIn) {
  let meta = {};
  try {
    meta = JSON.parse(stdout || "{}");
  } catch (e) {
    meta = { raw: (stdout || "").slice(0, 200) };
  }
  meta.engine = "vai-trace";
  meta.recipe = meta.mode ? "lab-hier-" + meta.mode : "lab-hier-auto";
  meta.paths = (svg.match(/<path\b/g) || []).length;
  const layers = annotateLayers(layersFromSvg(svg, widthIn, heightIn));
  const vec = {
    widthIn: widthIn,
    heightIn: heightIn,
    layers: layers.length ? layers : annotateLayers([{ hex: "#111111", paths: [] }]),
    source: "vai-trace",
    svg: svg,
    meta: meta,
  };
  return { svg: svg, vec: vec, meta: meta, eps: null };
}

function prepareTraceFiles(pngBuf, opts) {
  opts = opts || {};
  if (!available()) {
    const err = new Error(unavailableReason() || "vai-trace unavailable");
    err.code = "NO_VAI_TRACE";
    throw err;
  }
  const widthIn = Number(opts.widthIn) || 10;
  const heightIn = Number(opts.heightIn) || widthIn;
  const inches = Math.max(widthIn, heightIn) || 10;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vai-trace-"));
  const inPng = path.join(tmpDir, "in.png");
  const outSvg = path.join(tmpDir, "out.svg");
  const png = decodeRasterToPng(pngBuf);
  fs.writeFileSync(inPng, png);
  const args = [SCRIPT, "--input", inPng, "--output", outSvg, "--inches", String(inches)];
  if (opts.colors != null && opts.colors !== "") args.push("--colors", String(opts.colors));
  if (opts.mode) args.push("--mode", String(opts.mode));
  return { tmpDir, inPng, outSvg, args, widthIn, heightIn, timeoutMs: opts.timeoutMs || 180000 };
}

/** Sync (blocks event loop). Prefer vectorizeBufferAsync on HTTP paths. */
function vectorizeBuffer(pngBuf, opts) {
  const prep = prepareTraceFiles(pngBuf, opts);
  try {
    const r = spawnSync(resolvePython(), prep.args, {
      encoding: "utf8",
      timeout: prep.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      cwd: path.join(__dirname, "vai-trace"),
      env: pythonPathEnv(),
    });
    if (r.status !== 0 || !fs.existsSync(prep.outSvg)) {
      const err = new Error(String(r.stderr || r.stdout || r.error || "vai-trace failed").slice(0, 500));
      err.code = "VAI_TRACE_FAIL";
      err.status = r.status;
      throw err;
    }
    const svg = fs.readFileSync(prep.outSvg, "utf8");
    return buildResult(svg, r.stdout, prep.widthIn, prep.heightIn);
  } finally {
    try {
      fs.rmSync(prep.tmpDir, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
  }
}

/**
 * Async subprocess — does not block the Node event loop; timeout SIGKILLs the
 * Python child so Railway stays responsive.
 */
function vectorizeBufferAsync(pngBuf, opts) {
  let prep;
  try {
    prep = prepareTraceFiles(pngBuf, opts);
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise(function (resolve, reject) {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(resolvePython(), prep.args, {
      cwd: path.join(__dirname, "vai-trace"),
      env: pythonPathEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch (e) { /* ignore */ }
      try { fs.rmSync(prep.tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      const err = new Error("vai-trace timed out after " + prep.timeoutMs + "ms");
      err.code = "VAI_TRACE_TIMEOUT";
      reject(err);
    }, prep.timeoutMs);

    child.stdout.on("data", function (chunk) { stdout += chunk.toString(); if (stdout.length > 32 * 1024 * 1024) stdout = stdout.slice(0, 1024); });
    child.stderr.on("data", function (chunk) { stderr += chunk.toString(); if (stderr.length > 1024 * 1024) stderr = stderr.slice(-256000); });

    child.on("error", function (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.rmSync(prep.tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      err.code = err.code || "VAI_TRACE_FAIL";
      reject(err);
    });

    child.on("close", function (status) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (status !== 0 || !fs.existsSync(prep.outSvg)) {
          const err = new Error(String(stderr || stdout || "vai-trace failed").slice(0, 500));
          err.code = "VAI_TRACE_FAIL";
          err.status = status;
          reject(err);
          return;
        }
        const svg = fs.readFileSync(prep.outSvg, "utf8");
        resolve(buildResult(svg, stdout, prep.widthIn, prep.heightIn));
      } catch (e) {
        reject(e);
      } finally {
        try { fs.rmSync(prep.tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      }
    });
  });
}

module.exports = {
  available,
  unavailableReason,
  vectorizeBuffer,
  vectorizeBufferAsync,
  decodeRasterToPng,
  looksLikeJpeg,
  looksLikePng,
};
