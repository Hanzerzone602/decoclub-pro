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

function available() {
  return fs.existsSync(SCRIPT) && fs.existsSync(HELPER) && fs.existsSync(DEFAULT_PRIOR_SVG);
}

function vectorizeToSvg(pngBuf, widthIn, heightIn, opts) {
  opts = opts || {};
  if (!available()) {
    const err = new Error("invent-warp not available (script/prior missing)");
    err.code = "NO_INVENT_WARP";
    throw err;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "invent-warp-"));
  const srcPath = path.join(tmp, "src.png");
  fs.writeFileSync(srcPath, pngBuf);
  const outDir = path.join(tmp, "out");
  fs.mkdirSync(outDir, { recursive: true });

  const env = Object.assign({}, process.env, {
    INVENT_WARP_SRC: srcPath,
    INVENT_WARP_OUT: outDir,
    INVENT_WARP_PRIOR_SVG: opts.priorSvg || DEFAULT_PRIOR_SVG,
    INVENT_WARP_PRIOR_PNG: opts.priorPng || DEFAULT_PRIOR_PNG,
    INVENT_WARP_SIZE: String(opts.size || 1092),
  });
  const r = spawnSync("python3", [SCRIPT], {
    encoding: "utf8",
    timeout: opts.timeoutMs || 180000,
    env: env,
    cwd: path.join(__dirname, ".."),
  });
  if (r.status !== 0) {
    const err = new Error((r.stderr || r.stdout || "invent-warp failed").slice(0, 2000));
    err.code = "INVENT_WARP_FAIL";
    throw err;
  }
  const candidates = [
    path.join(outDir, "piecewise-tps.svg"),
    path.join(outDir, "hallucinate.svg"),
    path.join(outDir, "warped.svg"),
  ];
  const svgPath = candidates.find(function (p) { return fs.existsSync(p); });
  if (!svgPath) {
    const err = new Error("invent-warp produced no SVG");
    err.code = "INVENT_WARP_NO_SVG";
    throw err;
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
  vectorizeToSvg: vectorizeToSvg,
  DEFAULT_PRIOR_SVG: DEFAULT_PRIOR_SVG,
  DEFAULT_PRIOR_PNG: DEFAULT_PRIOR_PNG,
};
