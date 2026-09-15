"use strict";
/**
 * Worker for heavy vectorize so the main event loop stays free.
 * engines: "bezier" (default) | "vai-trace"
 * Parent still enforces timeout via worker.terminate().
 */
const { parentPort, workerData } = require("worker_threads");

if (!parentPort) {
  module.exports = {};
} else {
  try {
    const buf = Buffer.from(workerData.bufB64, "base64");
    const opts = workerData.opts || {};
    const engine = workerData.engine || "bezier";

    if (engine === "vai-trace") {
      const vaiTrace = require("./vaiTrace");
      const result = vaiTrace.vectorizeBuffer(buf, {
        widthIn: workerData.widthIn,
        heightIn: workerData.heightIn,
        colors: opts.colors,
        mode: opts.mode || "auto",
        timeoutMs: opts.timeoutMs || 180000,
      });
      parentPort.postMessage({
        ok: true,
        engine: "vai-trace",
        vec: result.vec,
        svg: result.svg,
        meta: result.meta,
      });
    } else {
      const bezier = require("./bezierVectorize");
      const packed = bezier.vectorizeToSvg(buf, workerData.widthIn, workerData.heightIn, opts);
      parentPort.postMessage({ ok: true, engine: "bezier", vec: packed.vec, svg: packed.svg });
    }
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
  }
}
