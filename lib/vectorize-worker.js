"use strict";
const { parentPort, workerData } = require("worker_threads");
const { vectorize, svgFromLayers } = require("./vectorize");

try {
  const buf = Buffer.from(workerData.bufB64, "base64");
  const vec = vectorize(buf, workerData.widthIn, workerData.heightIn, workerData.opts || {});
  const svg = svgFromLayers(vec.layers, vec.widthIn, vec.heightIn);
  parentPort.postMessage({ ok: true, vec: vec, svg: svg });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
}
