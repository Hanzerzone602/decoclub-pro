"use strict";

/**
 * Hang-prevention for Vectorize: huge banners / phone photos can wedge
 * vai-trace (spawnSync + Lab pipeline) until Railway needs a restart.
 * Prefer silent downscale before trace; keep original upload on disk.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const MAX_EDGE_TRIGGER = 4000;
const MAX_BYTES_TRIGGER = 12 * 1024 * 1024; // ~12MB
const TARGET_MAX_EDGE = 2800; // mid of 2500–3000

function resolvePython() {
  if (process.env.INVENT_WARP_PYTHON && fs.existsSync(process.env.INVENT_WARP_PYTHON)) {
    return process.env.INVENT_WARP_PYTHON;
  }
  const venv = path.join(__dirname, "..", ".venv", "bin", "python3");
  if (fs.existsSync(venv)) return venv;
  return "python3";
}

function pythonEnv() {
  return Object.assign({}, process.env, {
    PYTHONPATH: [path.join(__dirname, "..", "pydeps"), process.env.PYTHONPATH || ""]
      .filter(Boolean)
      .join(path.delimiter),
  });
}

/** Fast IHDR-only read — never inflate pixel data. */
function readPngDims(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  // PNG signature (8) + IHDR length(4) + "IHDR"(4) + width/height
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

function inspect(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const dims = readPngDims(buf) || { width: 0, height: 0 };
  const longestEdge = Math.max(dims.width || 0, dims.height || 0);
  const bytes = buf.length;
  const needsDownscale =
    longestEdge > MAX_EDGE_TRIGGER || bytes > MAX_BYTES_TRIGGER;
  return {
    width: dims.width,
    height: dims.height,
    longestEdge,
    bytes,
    needsDownscale,
    maxEdgeTrigger: MAX_EDGE_TRIGGER,
    maxBytesTrigger: MAX_BYTES_TRIGGER,
    targetMaxEdge: TARGET_MAX_EDGE,
  };
}

/**
 * Downscale PNG via PIL (LANCZOS). Returns original buf when under limits.
 * Does not rewrite the on-disk upload — only the buffer fed to vectorize.
 */
function downscaleIfNeeded(buf, opts) {
  opts = opts || {};
  const targetMaxEdge = Number(opts.targetMaxEdge) || TARGET_MAX_EDGE;
  const force = !!opts.force;
  const info = inspect(buf);
  if (!force && !info.needsDownscale) {
    return { buf: buf, meta: { sizeGuard: Object.assign({}, info, { downscaled: false }) } };
  }
  if (!info.width || !info.height) {
    // Can't read dims — if oversized by bytes, still try PIL open+resize
    if (!force && info.bytes <= MAX_BYTES_TRIGGER) {
      return { buf: buf, meta: { sizeGuard: Object.assign({}, info, { downscaled: false, note: "no-ihdr" }) } };
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vec-guard-"));
  const inn = path.join(tmpDir, "in.png");
  const out = path.join(tmpDir, "out.png");
  try {
    fs.writeFileSync(inn, buf);
    const py = resolvePython();
    const script =
      "from PIL import Image; import sys, json\n" +
      "im=Image.open(sys.argv[1]).convert('RGBA')\n" +
      "ow,oh=im.size\n" +
      "m=max(ow,oh); t=int(sys.argv[3])\n" +
      "if m>t:\n" +
      "  s=t/float(m)\n" +
      "  im=im.resize((max(1,int(round(ow*s))), max(1,int(round(oh*s)))), Image.Resampling.LANCZOS)\n" +
      "im.save(sys.argv[2],'PNG')\n" +
      "print(json.dumps({'orig_w':ow,'orig_h':oh,'w':im.size[0],'h':im.size[1],'downscaled':max(ow,oh)>t}))\n";
    const r = spawnSync(py, ["-c", script, inn, out, String(targetMaxEdge)], {
      encoding: "utf8",
      timeout: 45000,
      env: pythonEnv(),
      maxBuffer: 4 * 1024 * 1024,
    });
    if (r.status !== 0 || !fs.existsSync(out)) {
      const err = new Error(String(r.stderr || r.stdout || "size-guard downscale failed").slice(0, 400));
      err.code = "SIZE_GUARD_FAIL";
      throw err;
    }
    let pilMeta = {};
    try { pilMeta = JSON.parse((r.stdout || "").trim().split("\n").pop() || "{}"); } catch (e) { pilMeta = {}; }
    const outBuf = fs.readFileSync(out);
    const outInfo = inspect(outBuf);
    const meta = {
      sizeGuard: {
        downscaled: !!(pilMeta.downscaled || info.needsDownscale),
        reason: info.longestEdge > MAX_EDGE_TRIGGER
          ? "longestEdge>" + MAX_EDGE_TRIGGER
          : (info.bytes > MAX_BYTES_TRIGGER ? "bytes>" + MAX_BYTES_TRIGGER : "forced"),
        from: { width: pilMeta.orig_w || info.width, height: pilMeta.orig_h || info.height, bytes: info.bytes },
        to: { width: pilMeta.w || outInfo.width, height: pilMeta.h || outInfo.height, bytes: outBuf.length },
        targetMaxEdge: targetMaxEdge,
        maxEdgeTrigger: MAX_EDGE_TRIGGER,
        maxBytesTrigger: MAX_BYTES_TRIGGER,
      },
    };
    return { buf: outBuf, meta: meta };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

/** JSON body for hard reject (alternate policy). */
function rejectPayload(info) {
  return {
    error: "Artwork too large to vectorize safely",
    code: "IMAGE_TOO_LARGE",
    hint: "Resize so the longest edge is ≤ " + MAX_EDGE_TRIGGER + "px and file size ≤ ~12MB, then retry.",
    longestEdge: info.longestEdge,
    bytes: info.bytes,
    maxEdge: MAX_EDGE_TRIGGER,
    maxBytes: MAX_BYTES_TRIGGER,
  };
}

module.exports = {
  MAX_EDGE_TRIGGER,
  MAX_BYTES_TRIGGER,
  TARGET_MAX_EDGE,
  readPngDims,
  inspect,
  downscaleIfNeeded,
  rejectPayload,
};
