"use strict";

/**
 * vai-trace — local hierarchical Lab + cubic SVG (Grok Build Vectorizer.AI-class path).
 * Twin soft-tiger stays invent-warp; everything else uses this before VTracer.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { annotateLayers } = require("./colorspec");

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

function layersFromSvg(svg) {
  const layers = [];
  const seen = Object.create(null);
  const re = /fill\s*=\s*["'](#?[0-9a-fA-F]{3,8})["']/g;
  let m;
  while ((m = re.exec(svg))) {
    let hex = m[1];
    if (hex[0] !== "#") hex = "#" + hex;
    hex = hex.slice(0, 7).toLowerCase();
    if (hex === "#ffffff" || hex === "#f0f4f9" || hex === "#f4f5f0" || hex === "#00000000") continue;
    if (seen[hex]) continue;
    seen[hex] = true;
    layers.push({ hex: hex, nameGuess: "Layer " + (layers.length + 1), paths: [] });
    if (layers.length >= 48) break;
  }
  return layers;
}

function vectorizeBuffer(pngBuf, opts) {
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
  try {
    fs.writeFileSync(inPng, pngBuf);
    const args = [SCRIPT, "--input", inPng, "--output", outSvg, "--inches", String(inches)];
    if (opts.colors != null && opts.colors !== "") args.push("--colors", String(opts.colors));
    if (opts.mode) args.push("--mode", String(opts.mode));
    const r = spawnSync(resolvePython(), args, {
      encoding: "utf8",
      timeout: opts.timeoutMs || 180000,
      maxBuffer: 32 * 1024 * 1024,
      cwd: path.join(__dirname, "vai-trace"),
      env: Object.assign({}, process.env, {
        PYTHONPATH: [path.join(__dirname, "vai-trace"), path.join(__dirname, "..", "pydeps"), process.env.PYTHONPATH || ""]
          .filter(Boolean)
          .join(path.delimiter),
      }),
    });
    if (r.status !== 0 || !fs.existsSync(outSvg)) {
      const err = new Error(String(r.stderr || r.stdout || r.error || "vai-trace failed").slice(0, 500));
      err.code = "VAI_TRACE_FAIL";
      err.status = r.status;
      throw err;
    }
    const svg = fs.readFileSync(outSvg, "utf8");
    let meta = {};
    try {
      meta = JSON.parse(r.stdout || "{}");
    } catch (e) {
      meta = { raw: (r.stdout || "").slice(0, 200) };
    }
    meta.engine = "vai-trace";
    meta.recipe = meta.mode ? "lab-hier-" + meta.mode : "lab-hier-auto";
    meta.paths = (svg.match(/<path\b/g) || []).length;
    const layers = annotateLayers(layersFromSvg(svg));
    const vec = {
      widthIn: widthIn,
      heightIn: heightIn,
      layers: layers.length ? layers : annotateLayers([{ hex: "#111111", paths: [] }]),
      source: "vai-trace",
      meta: meta,
    };
    return { svg: svg, vec: vec, meta: meta, eps: null };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) { /* ignore */ }
  }
}

module.exports = {
  available,
  unavailableReason,
  vectorizeBuffer,
};
