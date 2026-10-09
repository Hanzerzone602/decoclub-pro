"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { digitizeLayers } = require("../lib/digitize");
const { sampleArt } = require("../lib/stitch/art");
const { nearestMadeira } = require("../lib/madeira");

function almost(a, b, tol) {
  assert.ok(Math.abs(a - b) <= tol, a + " !~ " + b + " tol " + tol);
}

{
  const v = sampleArt("square", 1, 1);
  const d1 = digitizeLayers(v, { name: "SQ1", density: 0.4, previewOnly: false });
  assert.ok(d1.dst && d1.dst.length > 512, "DST longer than header");
  assert.ok(d1.dst[0] === 0x4C && d1.dst[1] === 0x41 && d1.dst[2] === 0x3A, "DST starts with LA:");
  assert.ok(d1.stitchCount > 50, "1in square has real stitches, got " + d1.stitchCount);
  assert.ok(d1.preview && d1.preview.stitches.length > 20, "3D payload present");
  assert.ok(d1.objects && d1.objects.length >= 1, "object IR present");
  assert.strictEqual(d1.objects[0].type, "tatami");
  const d2 = digitizeLayers(sampleArt("square", 1, 1), { name: "SQ2", widthIn: 2, heightIn: 2, density: 0.4, previewOnly: true });
  const ratio = d2.stitchCount / d1.stitchCount;
  assert.ok(ratio > 2.6 && ratio < 5.5, "2in square ~4x stitches of 1in, got " + d1.stitchCount + " → " + d2.stitchCount + " ratio " + ratio.toFixed(2));
  console.log("ok size/density restitch", "1in=" + d1.stitchCount, "2in=" + d2.stitchCount, "ratio=" + ratio.toFixed(2), "exporter=" + d1.exporter);
}

{
  const navy = sampleArt("navy", 1, 1);
  const d = digitizeLayers(navy, { name: "NAVY", previewOnly: true });
  const stop = d.colorStops[0];
  assert.ok(stop && stop.madeiraCode, "colorStops include madeiraCode");
  const near = nearestMadeira("#0d2a5b", "rayon");
  assert.ok(near && near.code, "nearestMadeira works");
  assert.strictEqual(String(stop.madeiraCode), String(near.code));
  console.log("ok madeira", stop.madeiraCode, stop.name, stop.hex);
}

{
  const v = sampleArt("diagonal", 1, 1);
  const d = digitizeLayers(v, { name: "DIAG", satinMm: 2.4, previewOnly: true });
  assert.ok(d.objects[0].type === "satin", "diagonal strip classifies as satin, got " + d.objects[0].type + " widthMm=" + d.objects[0].widthMm);
  const stitches = d.stitches.filter((s) => s.kind === "stitch");
  assert.ok(stitches.length > 20, "satin produced stitches");
  const xs = stitches.map((s) => s.x), ys = stitches.map((s) => s.y);
  const n = xs.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; sumXY += xs[i] * ys[i]; sumXX += xs[i] * xs[i]; }
  const slope = (n * sumXY - sumX * sumY) / ((n * sumXX - sumX * sumX) || 1);
  assert.ok(slope > 0.45 && slope < 2.2, "satin columns follow the diagonal (slope " + slope.toFixed(2) + "), not axis-aligned barcode");
  const trims = d.stitches.filter((s) => s.kind === "trim");
  assert.ok(trims.length >= 1, "TRIM records present");
  console.log("ok satin columns", "type=" + d.objects[0].type, "stitches=" + d.stitchCount, "slope=" + slope.toFixed(2), "trims=" + trims.length);
}

{
  const v = sampleArt("letter", 0.6, 1.2);
  const d = digitizeLayers(v, { name: "I", satinMm: 2.0, previewOnly: true });
  assert.ok(d.objects[0].type === "satin" || d.objects[0].type === "tatami", "letter I classified");
  assert.ok(d.stitchCount > 30, "letter has stitches");
  console.log("ok letter I", "type=" + d.objects[0].type, "stitches=" + d.stitchCount, "widthMm=" + (d.objects[0].widthMm && d.objects[0].widthMm.toFixed(2)));
}

{
  const v = sampleArt("square", 0.4, 0.4);
  const d = digitizeLayers(v, { name: "GOLDEN", density: 0.4, previewOnly: false });
  assert.ok(d.dst[0] === 0x4C && d.dst[1] === 0x41 && d.dst[2] === 0x3A);
  const outDir = path.join(__dirname, "..", "out");
  fs.mkdirSync(outDir, { recursive: true });
  const dstPath = path.join(outDir, "golden-square.dst");
  fs.writeFileSync(dstPath, d.dst);
  const py = process.env.DIGITIZE_PYTHON || (fs.existsSync("/workspace/digitize-wq-venv/bin/python") ? "/workspace/digitize-wq-venv/bin/python" : path.join(__dirname, "..", ".venv", "bin", "python"));
  const reader = `
from pyembroidery import read_dst, STITCH, TRIM, JUMP, COLOR_CHANGE, END
p = read_dst(r"${dstPath}")
n = p.count_stitch_commands(STITCH)
t = p.count_stitch_commands(TRIM)
j = p.count_stitch_commands(JUMP)
print("READ", n, t, j, p.stitches[0][0] if p.stitches else None)
assert n >= 20, n
assert t >= 1, t
print("PASS pyembroidery-read")
`;
  const r = spawnSync(py, ["-c", reader], { encoding: "utf8", timeout: 15000 });
  assert.strictEqual(r.status, 0, "pyembroidery read failed: " + (r.stderr || r.stdout));
  assert.ok(r.stdout.indexOf("PASS") !== -1, r.stdout);
  console.log("ok pyembroidery DST roundtrip", d.exporter, "bytes=" + d.dst.length, r.stdout.trim());
}

{
  const v = sampleArt("square", 1, 1);
  const a = digitizeLayers(v, { name: "D1", density: 0.4, previewOnly: true });
  const b = digitizeLayers(v, { name: "D2", density: 0.25, previewOnly: true });
  assert.ok(b.stitchCount > a.stitchCount * 1.2, "tighter density increases stitch count " + a.stitchCount + " → " + b.stitchCount);
  console.log("ok density", a.stitchCount, "→", b.stitchCount);
}

{
  const v = {
    widthIn: 1, heightIn: 1,
    layers: [{
      hex: "#0d2a5b",
      nameGuess: "union",
      paths: [
        { d: "M 0.05 0.05 L 0.95 0.05 L 0.95 0.95 L 0.05 0.95 Z" },
        { d: "M 0.35 0.35 L 0.65 0.35 L 0.65 0.65 L 0.35 0.65 Z" },
      ],
    }],
  };
  const d = digitizeLayers(v, { name: "UNION", previewOnly: true });
  const inner = d.stitches.filter((s) => {
    if (s.kind !== "stitch") return false;
    return s.x > 0.40 * 254 && s.x < 0.60 * 254 && s.y > 0.40 * 254 && s.y < 0.60 * 254;
  });
  assert.ok(inner.length > 8, "same-color inner island unions (not a hole), got " + inner.length);
  console.log("ok compound union", "inner=" + inner.length, "stitches=" + d.stitchCount);
}

{
  const v = {
    widthIn: 1, heightIn: 1,
    layers: [{
      hex: "#c4281c",
      nameGuess: "body",
      paths: [{
        d: "M 0.05 0.05 L 0.95 0.05 L 0.95 0.95 L 0.05 0.95 Z M 0.32 0.32 L 0.68 0.32 L 0.68 0.68 L 0.32 0.68 Z",
      }],
    }],
  };
  // legacy engine: interior hole sewn as white thread (kept for engine:"legacy")
  const d = digitizeLayers(v, { name: "HOLE", previewOnly: true, engine: "legacy" });
  const white = (d.objects || []).filter((o) => o.interiorWhite || (o.thread && /white/i.test(String(o.thread.name || ""))));
  assert.ok(white.length >= 1, "interior evenodd hole becomes white thread, objects=" + JSON.stringify((d.objects || []).map((o) => o.type + ":" + (o.thread && o.thread.name))));
  console.log("ok interior white (legacy)", "whiteObjs=" + white.length, "objs=" + d.objects.length);
  // default engine: even-odd hole stays open fabric (no needle inside the hole)
  const d2 = digitizeLayers(v, { name: "HOLE2", previewOnly: true });
  const inHole = d2.stitches.filter((s) => s.kind === "stitch" && s.x > 0.36 * 254 && s.x < 0.64 * 254 && s.y > 0.36 * 254 && s.y < 0.64 * 254 && s.role !== "travel");
  assert.strictEqual(inHole.length, 0, "even-odd hole stays open, needles inside=" + inHole.length);
  console.log("ok even-odd hole open (wq)", "objs=" + d2.objects.length);
}

{
  const { MAX_OBJECTS } = require("../lib/stitch/objects");
  assert.ok(MAX_OBJECTS >= 120, "object cap raised above 48, got " + MAX_OBJECTS);
  console.log("ok object cap", MAX_OBJECTS);
}

{
  const v = {
    widthIn: 1, heightIn: 1,
    layers: [{
      hex: "#111111",
      nameGuess: "siblings",
      paths: [{
        d: "M 0.05 0.15 L 0.40 0.15 L 0.40 0.85 L 0.05 0.85 Z M 0.60 0.15 L 0.95 0.15 L 0.95 0.85 L 0.60 0.85 Z",
        fillRule: "evenodd",
      }],
    }],
  };
  const d = digitizeLayers(v, { name: "SIB", previewOnly: true });
  const left = d.stitches.filter((s) => s.kind === "stitch" && s.x > 0.08 * 254 && s.x < 0.35 * 254);
  const gap = d.stitches.filter((s) => s.kind === "stitch" && s.x > 0.45 * 254 && s.x < 0.55 * 254 && s.y > 0.30 * 254 && s.y < 0.70 * 254);
  assert.ok(left.length > 8, "left sibling island sews, got " + left.length);
  assert.ok(gap.length < 8, "sibling evenodd does not fill the bay, gap=" + gap.length);
  console.log("ok sibling union", "left=" + left.length, "gap=" + gap.length);
}

{
  const { rasterizeLayer, rasterSize } = require("../lib/stitch/geom");
  const layer = {
    hex: "#111111",
    paths: [{
      d: "M 0.02 0.02 L 0.98 0.02 L 0.98 0.98 L 0.02 0.98 Z M 0.08 0.10 L 0.38 0.10 L 0.38 0.90 L 0.08 0.90 Z M 0.62 0.10 L 0.92 0.10 L 0.92 0.90 L 0.62 0.90 Z",
      fillRule: "evenodd",
    }],
  };
  const rs = rasterSize(1, 1, 1400);
  const mask = rasterizeLayer(layer, 1, 1, rs.mw, rs.mh);
  let bay = 0, frame = 0;
  for (let y = 0; y < rs.mh; y++) {
    for (let x = 0; x < rs.mw; x++) {
      if (!mask[y * rs.mw + x]) continue;
      const X = x / rs.mw, Y = y / rs.mh;
      if (X > 0.44 && X < 0.56 && Y > 0.30 && Y < 0.70) bay++;
      if (X < 0.10) frame++;
    }
  }
  assert.ok(frame > 200, "outer frame remains, px=" + frame);
  assert.ok(bay < 80, "concave evenodd chord killed in mask, bayPx=" + bay);
  const d = digitizeLayers({ widthIn: 1, heightIn: 1, layers: [layer] }, { name: "CHORD", previewOnly: true });
  assert.ok(d.stitchCount > 40, "frame still sews, stitches=" + d.stitchCount);
  console.log("ok chord kill", "framePx=" + frame, "bayPx=" + bay, "stitches=" + d.stitchCount);
}

{
  // Thin ring must sew as contour satin, not a scribble across the hole.
  const ring = {
    widthIn: 1, heightIn: 1,
    layers: [{
      hex: "#111111",
      nameGuess: "ring",
      paths: [{
        d: "M 0.50 0.08 C 0.73 0.08 0.92 0.27 0.92 0.50 C 0.92 0.73 0.73 0.92 0.50 0.92 C 0.27 0.92 0.08 0.73 0.08 0.50 C 0.08 0.27 0.27 0.08 0.50 0.08 Z M 0.50 0.18 C 0.32 0.18 0.18 0.32 0.18 0.50 C 0.18 0.68 0.32 0.82 0.50 0.82 C 0.68 0.82 0.82 0.68 0.82 0.50 C 0.82 0.32 0.68 0.18 0.50 0.18 Z",
        fillRule: "evenodd",
      }],
    }],
  };
  const d = digitizeLayers(ring, { name: "RING", previewOnly: true });
  assert.ok(d.objects.some((o) => o.type === "satin"), "ring classifies as satin, types=" + JSON.stringify(d.objects.map((o) => o.type)));
  const hole = d.stitches.filter((s) => {
    if (s.kind !== "stitch") return false;
    const x = s.x / 254 - 0.5, y = s.y / 254 - 0.5;
    return Math.hypot(x, y) < 0.16;
  });
  const ringPts = d.stitches.filter((s) => {
    if (s.kind !== "stitch") return false;
    const x = s.x / 254 - 0.5, y = s.y / 254 - 0.5;
    const r = Math.hypot(x, y);
    return r > 0.22 && r < 0.48;
  });
  assert.ok(ringPts.length > 30, "satin sits on the ring, got " + ringPts.length);
  assert.ok(hole.length < ringPts.length * 0.15, "hole is not scribbled, holePts=" + hole.length + " ring=" + ringPts.length);
  console.log("ok contour satin", "ring=" + ringPts.length, "hole=" + hole.length, "stitches=" + d.stitchCount);
}

{
  // Source raster restores a dark bar the vector hull turned into a hole,
  // and does not fill that hole with interior white.
  const w = 40, h = 40;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inBar = y >= 16 && y <= 24 && x >= 2 && x <= 37;
      const inFrame = x < 3 || x > 36 || y < 3 || y > 36;
      const on = inBar || inFrame;
      rgba[i] = on ? 17 : 255;
      rgba[i + 1] = on ? 17 : 255;
      rgba[i + 2] = on ? 17 : 255;
      rgba[i + 3] = 255;
    }
  }
  const v = {
    widthIn: 1, heightIn: 1,
    sourceRgba: rgba, sourceW: w, sourceH: h,
    layers: [{
      hex: "#111111",
      nameGuess: "frame",
      paths: [{
        d: "M 0.02 0.02 L 0.98 0.02 L 0.98 0.98 L 0.02 0.98 Z M 0.08 0.08 L 0.92 0.08 L 0.92 0.92 L 0.08 0.92 Z",
        fillRule: "evenodd",
      }],
    }],
  };
  const d = digitizeLayers(v, { name: "STRIPE", previewOnly: true, sourceRgba: rgba, sourceW: w, sourceH: h, engine: "legacy" }); // legacy source-restore heuristic
  const bar = d.stitches.filter((s) => {
    if (s.kind !== "stitch") return false;
    const X = s.x / 254, Y = s.y / 254;
    return X > 0.20 && X < 0.80 && Y > 0.38 && Y < 0.62;
  });
  const whiteBar = (d.objects || []).filter((o) => {
    if (!o.interiorWhite) return false;
    const X = (o.cx || 0) / 25.4, Y = (o.cy || 0) / 25.4;
    return X > 0.20 && X < 0.80 && Y > 0.35 && Y < 0.65;
  });
  assert.ok(bar.length > 8, "source dark bar sews, barPts=" + bar.length);
  assert.ok(whiteBar.length === 0, "dark source bar is not interior white, whiteBar=" + whiteBar.length);
  console.log("ok source restore", "bar=" + bar.length, "whiteBar=" + whiteBar.length, "objs=" + d.objects.length);
}

console.log("PASS stitch engine");
