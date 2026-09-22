"use strict";
/**
 * Smoke: dirt-devils annual crop hits t8c plate-lock path (per-ink evenodd).
 * Skips if Python deps (cv2/numpy/PIL) or potrace are missing.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const FIXTURE = path.join(__dirname, "fixtures", "vectorize", "dirt-devils-annual-crop.png");
const TRACE = path.join(__dirname, "..", "lib", "vai-trace", "trace.py");
const OUT = path.join(__dirname, "..", "out", "plate-lock-test.svg");

function resolvePython() {
  const venv = path.join(__dirname, "..", ".venv", "bin", "python3");
  if (fs.existsSync(venv)) return venv;
  return "python3";
}

{
  assert.ok(fs.existsSync(FIXTURE), "fixture missing");
  assert.ok(fs.existsSync(TRACE), "trace.py missing");
  const py = resolvePython();
  const env = Object.assign({}, process.env, {
    PYTHONPATH: [path.join(__dirname, "..", "lib", "vai-trace"), path.join(__dirname, "..", "pydeps"), process.env.PYTHONPATH || ""]
      .filter(Boolean)
      .join(path.delimiter),
  });
  const deps = spawnSync(py, ["-c", "import cv2, numpy, PIL; print('ok')"], { encoding: "utf8", timeout: 20000, env });
  if (deps.status !== 0) {
    console.log("skip plate_lock (python deps missing)");
    process.exit(0);
  }
  const ptr = spawnSync("potrace", ["--version"], { encoding: "utf8" });
  if (ptr.status !== 0 && ptr.error) {
    console.log("skip plate_lock (potrace missing)");
    process.exit(0);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const r = spawnSync(
    py,
    [TRACE, "--input", FIXTURE, "--output", OUT, "--inches", "4", "--mode", "auto"],
    { encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024, env }
  );
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    process.exit(1);
  }
  let meta = {};
  try { meta = JSON.parse(r.stdout || "{}"); } catch (e) { meta = {}; }
  const svg = fs.readFileSync(OUT, "utf8");
  assert.ok(svg.indexOf("<svg") !== -1, "svg missing");
  assert.ok(svg.toLowerCase().indexOf("<image") === -1, "must be true vector");
  assert.ok((svg.match(/<path\b/g) || []).length >= 10, "too few paths");
  assert.strictEqual(meta.plate_lock, true, "expected plate_lock meta, got " + JSON.stringify(meta));
  assert.strictEqual(meta.busy_type_poster, true, "expected busy_type_poster");
  assert.ok(
    meta.vector_graph === "per-ink-evenodd-plates" || meta.vector_graph === "shared-seams-no-logo",
    "unexpected vector_graph " + meta.vector_graph
  );
  console.log("ok plate_lock", meta.vector_graph, "paths", meta.paths, "ms", meta.ms);
}
