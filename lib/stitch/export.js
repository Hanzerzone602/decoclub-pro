"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { UNIT_PER_IN, clamp } = require("./geom");

const MAX_DELTA = 121;

function encodeDstDelta(dx, dy, flags) {
  if (flags === "end") return Buffer.from([0x00, 0x00, 0xF3]);
  let x = clamp(dx | 0, -121, 121);
  let y = clamp(-(dy | 0), -121, 121);
  let b0 = 0, b1 = 0, b2 = 0;
  if (flags === "color") b2 = 0xC3;
  else if (flags === "jump" || flags === "trim") b2 = 0x83;
  else b2 = 0x03;
  if (x > 40) { b2 |= 0x04; x -= 81; }
  if (x < -40) { b2 |= 0x08; x += 81; }
  if (y > 40) { b2 |= 0x20; y -= 81; }
  if (y < -40) { b2 |= 0x10; y += 81; }
  if (x > 13) { b1 |= 0x04; x -= 27; }
  if (x < -13) { b1 |= 0x08; x += 27; }
  if (y > 13) { b1 |= 0x20; y -= 27; }
  if (y < -13) { b1 |= 0x10; y += 27; }
  if (x > 4) { b0 |= 0x04; x -= 9; }
  if (x < -4) { b0 |= 0x08; x += 9; }
  if (y > 4) { b0 |= 0x20; y -= 9; }
  if (y < -4) { b0 |= 0x10; y += 9; }
  if (x > 1) { b1 |= 0x01; x -= 3; }
  if (x < -1) { b1 |= 0x02; x += 3; }
  if (y > 1) { b1 |= 0x80; y -= 3; }
  if (y < -1) { b1 |= 0x40; y += 3; }
  if (x > 0) { b0 |= 0x01; x -= 1; }
  if (x < 0) { b0 |= 0x02; x += 1; }
  if (y > 0) { b0 |= 0x80; y -= 1; }
  if (y < 0) { b0 |= 0x40; y += 1; }
  return Buffer.from([b0, b1, b2]);
}

function splitDelta(dx, dy, flags, out) {
  let remX = dx, remY = dy;
  while (Math.abs(remX) > MAX_DELTA || Math.abs(remY) > MAX_DELTA) {
    const sx = clamp(remX, -MAX_DELTA, MAX_DELTA);
    const sy = clamp(remY, -MAX_DELTA, MAX_DELTA);
    out.push(encodeDstDelta(sx, sy, flags === "color" ? "jump" : flags));
    remX -= sx; remY -= sy;
  }
  out.push(encodeDstDelta(remX, remY, flags));
}

function dstHeader(name, stitchCount, colorCount, minX, minY, maxX, maxY) {
  function padNum(n, w) {
    const s = String(Math.abs(n | 0));
    return ("       " + s).slice(-w);
  }
  const nm = String(name || "DESIGN").replace(/[^\x20-\x7E]/g, " ").slice(0, 16);
  const parts = [
    "LA:" + (nm + "                ").slice(0, 16),
    "ST:" + padNum(stitchCount, 7),
    "CO:" + padNum(colorCount, 3),
    "+X:" + padNum(maxX, 5),
    "-X:" + padNum(Math.abs(minX), 5),
    "+Y:" + padNum(maxY, 5),
    "-Y:" + padNum(Math.abs(minY), 5),
    "AX:+" + padNum(0, 6),
    "AY:+" + padNum(0, 6),
    "MX:+" + padNum(0, 6),
    "MY:+" + padNum(0, 6),
    "PD:******",
  ];
  const text = parts.join("\r") + "\r";
  const buf = Buffer.alloc(512, 0x20);
  Buffer.from(text, "ascii").copy(buf, 0, 0, Math.min(text.length, 511));
  buf[511] = 0x1A;
  return buf;
}

function writeDst(stitches, name) {
  const recs = [];
  let x = 0, y = 0;
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  let colors = 0;
  let stitchN = 0;
  (stitches || []).forEach((s) => {
    if (s.kind === "color") {
      recs.push(encodeDstDelta(0, 0, "color"));
      colors++;
      return;
    }
    if (s.kind === "trim") {
      recs.push(encodeDstDelta(-2, -2, "jump"));
      recs.push(encodeDstDelta(4, 4, "jump"));
      recs.push(encodeDstDelta(-2, -2, "jump"));
      return;
    }
    if (s.kind === "end") return;
    const dx = s.x - x;
    const dy = s.y - y;
    const flags = s.kind === "jump" ? "jump" : "stitch";
    splitDelta(dx, dy, flags, recs);
    x = s.x; y = s.y;
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    if (flags === "stitch") stitchN++;
  });
  recs.push(encodeDstDelta(0, 0, "end"));
  const header = dstHeader(name, stitchN, colors, minX, minY, maxX, maxY);
  return Buffer.concat([header].concat(recs));
}

function writeExp(stitches) {
  const chunks = [];
  let x = 0, y = 0;
  function emitPair(dx, dy) {
    let remX = dx, remY = dy;
    if (remX === 0 && remY === 0) {
      chunks.push(Buffer.from([0, 0]));
      return;
    }
    while (remX !== 0 || remY !== 0) {
      const sx = clamp(remX, -127, 127);
      const sy = clamp(remY, -127, 127);
      const bx = sx < 0 ? (256 + sx) : sx;
      const by = sy < 0 ? (256 + sy) : sy;
      chunks.push(Buffer.from([bx, by]));
      remX -= sx; remY -= sy;
    }
  }
  (stitches || []).forEach((s) => {
    if (s.kind === "color") {
      chunks.push(Buffer.from([0x80, 0x04]));
      return;
    }
    if (s.kind === "trim") {
      chunks.push(Buffer.from([0x80, 0x80, 0x07, 0x00]));
      return;
    }
    if (s.kind === "end") return;
    const dx = s.x - x;
    const dy = s.y - y;
    const invY = -dy;
    if (s.kind === "jump") {
      chunks.push(Buffer.from([0x80, 0x01]));
      emitPair(dx, invY);
    } else {
      emitPair(dx, invY);
    }
    x = s.x; y = s.y;
  });
  chunks.push(Buffer.from([0x80, 0x80]));
  return Buffer.concat(chunks);
}

function pythonCandidates() {
  const env = process.env.DIGITIZE_PYTHON || process.env.INVENT_WARP_PYTHON;
  const here = path.join(__dirname, "..", "..", ".venv", "bin", "python");
  const sibling = path.join(__dirname, "..", "..", "..", "digitize-build", ".venv", "bin", "python");
  const railVenv = path.join(__dirname, "..", "..", "..", "decoclub-railway", ".venv", "bin", "python");
  return [env, here, sibling, "/venv/bin/python3", railVenv, "python3", "python"].filter(Boolean);
}

function sidecarScript() {
  const a = path.join(__dirname, "..", "..", "scripts", "write_dst.py");
  const b = path.join(__dirname, "..", "..", "..", "decoclub-railway", "scripts", "write_dst.py");
  if (fs.existsSync(a)) return a;
  if (fs.existsSync(b)) return b;
  return a;
}

function exporterMode() {
  const flag = String(process.env.DIGITIZE_EXPORTER || "pyembroidery").toLowerCase();
  if (flag === "legacy" || flag === "js") return "legacy";
  return "pyembroidery";
}

function patternToIr(pattern, name) {
  return {
    name: String(name || "DESIGN").slice(0, 16),
    stitches: (pattern.stitches || []).map((s) => ({
      x: s.x, y: s.y, cmd: s.kind || s.cmd || "stitch",
    })),
    threads: (pattern.threads || []).map((t) => ({
      hex: t.hex, code: t.code, name: t.name, brand: t.brand,
    })),
  };
}

function writeWithPyembroidery(pattern, name, extra) {
  extra = extra || {};
  const script = sidecarScript();
  if (!fs.existsSync(script)) return null;
  const ir = JSON.stringify(patternToIr(pattern, name));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-dst-"));
  const dstPath = path.join(tmp, "design.dst");
  const expPath = path.join(tmp, "design.exp");
  const pesPath = path.join(tmp, "design.pes");
  let lastErr = "";
  for (const py of pythonCandidates()) {
    const args = [script, "--dst", dstPath, "--exp", expPath];
    if (extra.pes) args.push("--pes", pesPath);
    const r = spawnSync(py, args, {
      input: ir,
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (r.status === 0 && fs.existsSync(dstPath) && fs.statSync(dstPath).size > 512) {
      const dst = fs.readFileSync(dstPath);
      const exp = fs.existsSync(expPath) ? fs.readFileSync(expPath) : Buffer.alloc(0);
      const pes = extra.pes && fs.existsSync(pesPath) ? fs.readFileSync(pesPath) : Buffer.alloc(0);
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
      return { dst: dst, exp: exp, pes: pes, exporter: "pyembroidery", python: py };
    }
    lastErr = (r.stderr || r.stdout || r.error && r.error.message || "").toString().slice(0, 400);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  return { error: lastErr };
}

function exportPattern(pattern, name, extra) {
  extra = extra || {};
  const nm = String(name || "DESIGN").replace(/[^\w\- ]+/g, "").slice(0, 16) || "DESIGN";
  if (exporterMode() === "pyembroidery") {
    const py = writeWithPyembroidery(pattern, nm, extra);
    if (py && py.dst) return py;
  }
  return {
    dst: writeDst(pattern.stitches, nm),
    exp: writeExp(pattern.stitches),
    pes: Buffer.alloc(0),
    exporter: "legacy",
  };
}

module.exports = {
  writeDst,
  writeExp,
  exportPattern,
  exporterMode,
  patternToIr,
  UNIT_PER_IN,
};
