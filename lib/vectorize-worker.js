"use strict";
const { parentPort, workerData } = require("worker_threads");
const bezier = require("./bezierVectorize");

try {
  const buf = Buffer.from(workerData.bufB64, "base64");
  const opts = workerData.opts || {};
  const packed = bezier.vectorizeToSvg(buf, workerData.widthIn, workerData.heightIn, opts);
  parentPort.postMessage({ ok: true, vec: packed.vec, svg: packed.svg });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
}
