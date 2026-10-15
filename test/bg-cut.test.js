"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { encodePng, decodePng } = require("../lib/png");
const { removeBackground } = require("../lib/matte");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function clamp8(n) {
  if (n < 0) return 0;
  if (n > 255) return 255;
  return n | 0;
}

function pythonBin() {
  return process.env.DECOCLUB_PYTHON || process.env.DIGITIZE_PYTHON || "python3";
}

function aiAvailable() {
  const py = pythonBin();
  const probe = spawnSync(py, ["-c", "import onnxruntime"], { encoding: "utf8", timeout: 20000 });
  const model = path.join(__dirname, "..", "models", "u2netp.onnx");
  return probe.status === 0 && fs.existsSync(model);
}

/**
 * Noisy linear gradient, a solid shape, a 2px stem, a white inner fill,
 * and an enclosed patch of the same gradient (a hole).
 */
function gradientFixture() {
  const w = 200;
  const h = 160;
  const rgba = Buffer.alloc(w * h * 4);
  const rng = mulberry32(20261014);
  const bgAt = [];
  function bgColour(x, y) {
    const tx = x / (w - 1);
    const ty = y / (h - 1);
    const n1 = (rng() - 0.5) * 26;
    const n2 = (rng() - 0.5) * 26;
    const n3 = (rng() - 0.5) * 26;
    return [
      clamp8(36 + tx * 180 + ty * 10 + n1),
      clamp8(78 + ty * 90 + (1 - tx) * 20 + n2),
      clamp8(176 - tx * 70 + ty * 30 + n3),
    ];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = bgColour(x, y);
      bgAt.push(c[0], c[1], c[2]);
      const i = (y * w + x) * 4;
      rgba[i] = c[0];
      rgba[i + 1] = c[1];
      rgba[i + 2] = c[2];
      rgba[i + 3] = 255;
    }
  }
  const shape = new Uint8Array(w * h);
  const white = new Uint8Array(w * h);
  const hole = new Uint8Array(w * h);
  const line = new Uint8Array(w * h);
  function put(x, y, r, g, b, tag) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    const i = p * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
    shape[p] = tag === "shape" ? 1 : 0;
    white[p] = tag === "white" ? 1 : 0;
    hole[p] = tag === "hole" ? 1 : 0;
    line[p] = tag === "line" ? 1 : 0;
  }
  for (let y = 26; y <= 132; y++) {
    for (let x = 28; x <= 158; x++) put(x, y, 186, 42, 28, "shape");
  }
  for (let y = 48; y <= 92; y++) {
    for (let x = 44; x <= 86; x++) put(x, y, 250, 250, 250, "white");
  }
  // Enclosed gradient, inset so a solid wall surrounds it.
  for (let y = 50; y <= 86; y++) {
    for (let x = 104; x <= 140; x++) {
      const c = bgAt.slice((y * w + x) * 3, (y * w + x) * 3 + 3);
      put(x, y, c[0], c[1], c[2], "hole");
    }
  }
  // 2px stem connected to the shape.
  for (let y = 78; y <= 79; y++) {
    for (let x = 150; x <= 194; x++) put(x, y, 8, 8, 8, "line");
  }
  const bg = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    if (!shape[p] && !white[p] && !line[p]) bg[p] = 1;
  }
  return { w, h, png: encodePng(w, h, rgba), shape, white, hole, line, bg };
}

/** White sheet, black disc, coverage antialiasing on the rim. */
function whiteAntialiasFixture() {
  const w = 120;
  const h = 100;
  const rgba = Buffer.alloc(w * h * 4, 255);
  const cx = 58.5;
  const cy = 48.5;
  const radius = 28;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const cov = Math.max(0, Math.min(1, radius + 0.65 - d));
      const v = clamp8(Math.round(255 * (1 - cov)));
      const i = (y * w + x) * 4;
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return { w, h, png: encodePng(w, h, rgba), cx, cy };
}

function countWhere(mask, pred) {
  let n = 0;
  let hit = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    n++;
    if (pred(i)) hit++;
  }
  return { n, hit, ratio: n ? hit / n : 1 };
}

function assertCut(label, buf, fx) {
  const img = decodePng(buf);
  assert.strictEqual(img.width, fx.w);
  assert.strictEqual(img.height, fx.h);
  const rgba = img.rgba;
  const bg = countWhere(fx.bg, (i) => rgba[i * 4 + 3] === 0);
  const line = countWhere(fx.line, (i) => rgba[i * 4 + 3] > 200 && luma(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) < 80);
  const white = countWhere(fx.white, (i) => {
    const o = i * 4;
    return rgba[o + 3] > 200 && luma(rgba[o], rgba[o + 1], rgba[o + 2]) > 220;
  });
  // Inset the hole by 3px so the subject's inner edge is not counted as background.
  const holeCore = new Uint8Array(fx.hole.length);
  for (let y = 53; y <= 83; y++) {
    for (let x = 107; x <= 137; x++) holeCore[y * fx.w + x] = 1;
  }
  const hole = countWhere(holeCore, (i) => rgba[i * 4 + 3] < 16);
  const shape = countWhere(fx.shape, (i) => rgba[i * 4 + 3] > 200);
  const msg = `${label} bg=${bg.ratio.toFixed(3)} line=${line.ratio.toFixed(3)} white=${white.ratio.toFixed(3)} hole=${hole.ratio.toFixed(3)} shape=${shape.ratio.toFixed(3)}`;
  assert.ok(bg.ratio > 0.98, msg + " bg removed");
  assert.ok(line.ratio > 0.9, msg + " thin line kept");
  assert.ok(white.ratio > 0.95, msg + " white fill kept");
  assert.ok(hole.ratio > 0.98, msg + " enclosed hole removed");
  assert.ok(shape.ratio > 0.9, msg + " shape kept");
  console.log("ok", msg);
}

function assertNoLightFringe(label, buf, fx) {
  const img = decodePng(buf);
  const rgba = img.rgba;
  let bad = 0;
  let opaqueCenter = false;
  for (let y = 0; y < fx.h; y++) {
    for (let x = 0; x < fx.w; x++) {
      const o = (y * fx.w + x) * 4;
      const a = rgba[o + 3];
      if (a > 0 && luma(rgba[o], rgba[o + 1], rgba[o + 2]) > 128) bad++;
      if (Math.abs(x - fx.cx) < 8 && Math.abs(y - fx.cy) < 8 && a > 240 && luma(rgba[o], rgba[o + 1], rgba[o + 2]) < 40) {
        opaqueCenter = true;
      }
    }
  }
  assert.strictEqual(rgba[3], 0, label + " corner transparent");
  assert.ok(opaqueCenter, label + " black center kept");
  assert.strictEqual(bad, 0, label + " light-grey edge pixels " + bad);
  console.log("ok", label, "no light-grey fringe");
}

function runCut(png, extraEnv) {
  const prev = process.env.DECOCLUB_BGCUT_DISABLE_AI;
  if (extraEnv && Object.prototype.hasOwnProperty.call(extraEnv, "DECOCLUB_BGCUT_DISABLE_AI")) {
    if (extraEnv.DECOCLUB_BGCUT_DISABLE_AI) process.env.DECOCLUB_BGCUT_DISABLE_AI = extraEnv.DECOCLUB_BGCUT_DISABLE_AI;
    else delete process.env.DECOCLUB_BGCUT_DISABLE_AI;
  }
  try {
    return removeBackground(png, { mode: "auto" });
  } finally {
    if (prev === undefined) delete process.env.DECOCLUB_BGCUT_DISABLE_AI;
    else process.env.DECOCLUB_BGCUT_DISABLE_AI = prev;
  }
}

function scriptMeta(png) {
  const py = pythonBin();
  const script = path.join(__dirname, "..", "scripts", "bg_cut.py");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-cut-meta-"));
  const inn = path.join(dir, "in.png");
  const out = path.join(dir, "out.png");
  fs.writeFileSync(inn, png);
  const env = Object.assign({}, process.env);
  delete env.DECOCLUB_BGCUT_DISABLE_AI;
  const r = spawnSync(py, [script, inn, out, "auto"], { encoding: "utf8", timeout: 60000, env });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, "bg_cut meta failed " + (r.stderr || r.stdout));
  return JSON.parse(String(r.stdout).trim().split("\n").pop());
}

{
  const hasAi = aiAvailable();
  const grad = gradientFixture();
  assertCut("gradient", runCut(grad.png), grad);
  assertCut("gradient-no-ai", runCut(grad.png, { DECOCLUB_BGCUT_DISABLE_AI: "1" }), grad);

  const aa = whiteAntialiasFixture();
  assertNoLightFringe("white-aa", runCut(aa.png), aa);
  assertNoLightFringe("white-aa-no-ai", runCut(aa.png, { DECOCLUB_BGCUT_DISABLE_AI: "1" }), aa);

  if (!hasAi) {
    console.log("skip AI-specific assertions (onnxruntime or u2netp model unavailable)");
  } else {
    const meta = scriptMeta(grad.png);
    assert.strictEqual(meta.ok, true);
    assert.strictEqual(meta.u2, true, "u2netp should run on a gradient background: " + JSON.stringify(meta));
    assert.ok(String(meta.mode).indexOf("gradient") !== -1, meta.mode);
    console.log("ok u2netp path", meta.mode);
  }
}
