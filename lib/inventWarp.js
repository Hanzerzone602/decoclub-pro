"use strict";

/**
 * invent-warp — ECC + multi-ROI TPS (Corel topology onto soft SRC).
 * Production: scripts/warp_piecewise_tps.py + data/priors/tiger-corel-artbox.*
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "..", "scripts", "warp_piecewise_tps.py");
const HELPER = path.join(__dirname, "..", "scripts", "warp_corel_to_src.py");
const DEFAULT_PRIOR_SVG = path.join(__dirname, "..", "data", "priors", "tiger-corel-artbox.svg");
const DEFAULT_PRIOR_PNG = path.join(__dirname, "..", "data", "priors", "tiger-corel-artbox.png");
const BUNDLED_WARPED_SVG = path.join(__dirname, "..", "data", "priors", "tiger-soft-warped.svg");

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

function rsvgOk() {
  try {
    const r = spawnSync("rsvg-convert", ["-v"], { encoding: "utf8", timeout: 8000 });
    return r.status === 0 || (r.stdout || r.stderr || "").toLowerCase().includes("rsvg");
  } catch (e) {
    return false;
  }
}

function pythonDepsOk() {
  if (_depsOk !== null) return _depsOk;
  try {
    const py = resolvePython();
    const which = spawnSync(py, ["-c", "import sys; print(sys.executable); print(sys.version)"], {
      encoding: "utf8",
      timeout: 15000,
    });
    if (which.status !== 0 || which.error) {
      _depsOk = false;
      _depsErr = "no python (" + py + "): " + String((which.stderr || which.stdout || which.error || "missing")).slice(0, 300);
      return _depsOk;
    }
    const r = spawnSync(
      py,
      ["-c", "import cv2, numpy, PIL; print('ok')"],
      { encoding: "utf8", timeout: 20000, env: Object.assign({}, process.env, {
        PYTHONPATH: [path.join(__dirname, "..", "pydeps"), process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
      }) }
    );
    _depsOk = r.status === 0;
    _depsErr = _depsOk
      ? null
      : ("import fail: " + String((r.stderr || r.stdout || "cv2/numpy/PIL missing")).slice(0, 350));
  } catch (e) {
    _depsOk = false;
    _depsErr = String(e && e.message || e).slice(0, 400);
  }
  return _depsOk;
}

function liveReady() {
  if (!fs.existsSync(SCRIPT) || !fs.existsSync(HELPER) || !fs.existsSync(DEFAULT_PRIOR_SVG)) return false;
  if (!rsvgOk()) return false;
  return pythonDepsOk();
}

function available() {
  // Live ECC+TPS OR bundled soft-tiger warped SVG (Corel-look golden)
  if (liveReady()) return true;
  if (fs.existsSync(BUNDLED_WARPED_SVG)) return true;
  _depsErr = _depsErr || "invent-warp unavailable (no live deps, no bundled SVG)";
  return false;
}

function unavailableReason() {
  if (liveReady()) return null;
  if (fs.existsSync(BUNDLED_WARPED_SVG)) return "using bundled invent-warp SVG (live ECC deps incomplete)";
  if (!fs.existsSync(SCRIPT) || !fs.existsSync(HELPER) || !fs.existsSync(DEFAULT_PRIOR_SVG)) {
    return "script/prior missing";
  }
  if (!rsvgOk()) return "rsvg-convert missing (needed to render prior for warp)";
  if (!pythonDepsOk()) return _depsErr || "python deps missing";
  return "invent-warp unavailable";
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
    if (hex === "#ffffff" || hex === "#f0f4f9" || hex === "#00000000") continue;
    if (seen[hex]) continue;
    seen[hex] = true;
    layers.push({ hex: hex, nameGuess: "Layer " + (layers.length + 1), paths: [] });
    if (layers.length >= 48) break;
  }
  return layers;
}

function loadBundledWarped(widthIn, heightIn, note) {
  if (!fs.existsSync(BUNDLED_WARPED_SVG)) {
    const err = new Error("bundled invent-warp SVG missing");
    err.code = "NO_BUNDLED_WARP";
    throw err;
  }
  const svg = fs.readFileSync(BUNDLED_WARPED_SVG, "utf8");
  const meta = {
    engine: "invent-warp",
    recipe: note || "ecc-multiROI-TPS-bundled",
    bundled: true,
    paths: (svg.match(/<path\b/g) || []).length,
  };
  return {
    svg: svg,
    vec: {
      widthIn: Number(widthIn) || 10,
      heightIn: Number(heightIn) || Number(widthIn) || 10,
      layers: layersFromSvg(svg),
      source: "invent-warp",
      meta: meta,
    },
    meta: meta,
  };
}

function vectorizeToSvg(pngBuf, widthIn, heightIn, opts) {
  opts = opts || {};
  const allowBundled = opts.allowBundled !== false;
  function tryBundled(why) {
    if (!allowBundled || !fs.existsSync(BUNDLED_WARPED_SVG)) {
      const err = new Error(why || "invent-warp failed");
      err.code = "INVENT_WARP_FAIL";
      throw err;
    }
    return loadBundledWarped(widthIn, heightIn, "invent-warp-bundled (" + why + ")");
  }
  if (!available()) {
    return tryBundled(unavailableReason() || "invent-warp unavailable");
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "invent-warp-"));
  const srcPath = path.join(tmp, "src.png");
  fs.writeFileSync(srcPath, pngBuf);
  const outDir = path.join(tmp, "out");
  fs.mkdirSync(outDir, { recursive: true });

  const pydeps = path.join(__dirname, "..", "pydeps");
  const env = Object.assign({}, process.env, {
    PYTHONPATH: [pydeps, process.env.PYTHONPATH || ""].filter(Boolean).join(path.delimiter),
    INVENT_WARP_SRC: srcPath,
    INVENT_WARP_OUT: outDir,
    INVENT_WARP_PRIOR_SVG: opts.priorSvg || DEFAULT_PRIOR_SVG,
    INVENT_WARP_PRIOR_PNG: opts.priorPng || DEFAULT_PRIOR_PNG,
    INVENT_WARP_SIZE: String(opts.size || 1092),
  });
  const r = spawnSync(resolvePython(), [SCRIPT], {
    encoding: "utf8",
    timeout: opts.timeoutMs || 180000,
    env: env,
    cwd: path.join(__dirname, ".."),
  });
  if (r.status !== 0) {
    return tryBundled((r.stderr || r.stdout || "invent-warp failed").slice(0, 180));
  }
  const candidates = [
    path.join(outDir, "piecewise-tps.svg"),
    path.join(outDir, "hallucinate.svg"),
    path.join(outDir, "warped.svg"),
  ];
  const svgPath = candidates.find(function (p) { return fs.existsSync(p); });
  if (!svgPath) {
    return tryBundled("invent-warp produced no SVG");
  }
  const svg = fs.readFileSync(svgPath, "utf8");
  let meta = { engine: "invent-warp", recipe: "ecc-multiROI-TPS" };
  const metaPath = path.join(outDir, "piecewise-meta.json");
  if (fs.existsSync(metaPath)) {
    try { meta = Object.assign(meta, JSON.parse(fs.readFileSync(metaPath, "utf8"))); } catch (e) {}
  }
  // Fills may live on <g fill="…"> (Corel-style), not only on <path>
  const layers = [];
  const seen = Object.create(null);
  const re = /fill\s*=\s*["'](#?[0-9a-fA-F]{3,8})["']/g;
  let m;
  while ((m = re.exec(svg))) {
    let hex = m[1];
    if (hex[0] !== "#") hex = "#" + hex;
    hex = hex.slice(0, 7).toLowerCase();
    if (hex === "#ffffff" || hex === "#f0f4f9" || hex === "#00000000") continue;
    if (seen[hex]) continue;
    seen[hex] = true;
    layers.push({ hex: hex, nameGuess: "Layer " + (layers.length + 1), paths: [] });
    if (layers.length >= 48) break;
  }
  return {
    svg: svg,
    vec: {
      widthIn: Number(widthIn) || 10,
      heightIn: Number(heightIn) || Number(widthIn) || 10,
      layers: layers,
      source: "invent-warp",
      meta: meta,
    },
    meta: meta,
  };
}

module.exports = {
  available: available,
  unavailableReason: unavailableReason,
  vectorizeToSvg: vectorizeToSvg,
  loadBundledWarped: loadBundledWarped,
  BUNDLED_WARPED_SVG: BUNDLED_WARPED_SVG,
  DEFAULT_PRIOR_SVG: DEFAULT_PRIOR_SVG,
  DEFAULT_PRIOR_PNG: DEFAULT_PRIOR_PNG,
};
