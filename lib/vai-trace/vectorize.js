"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function vectorizeFile(input, output, opts) {
  opts = opts || {};
  const script = path.join(__dirname, "trace.py");
  const args = [script, "--input", input, "--output", output];
  if (opts.colors != null) args.push("--colors", String(opts.colors));
  if (opts.inches != null) args.push("--inches", String(opts.inches));
  if (opts.mode) args.push("--mode", String(opts.mode));
  const r = spawnSync("python3", args, {
    encoding: "utf8",
    timeout: opts.timeoutMs || 180000,
    maxBuffer: 32 * 1024 * 1024,
    cwd: path.join(__dirname, ".."),
  });
  if (r.status !== 0) {
    const err = new Error((r.stderr || r.stdout || r.error || "vectorize failed").toString().slice(0, 400));
    err.status = r.status;
    throw err;
  }
  let meta = {};
  try {
    meta = JSON.parse(r.stdout || "{}");
  } catch (e) {
    meta = { raw: r.stdout };
  }
  return { svg: fs.readFileSync(output, "utf8"), meta: meta };
}

module.exports = { vectorizeFile };
