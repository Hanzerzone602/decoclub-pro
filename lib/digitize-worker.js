"use strict";
/**
 * Worker for digitize (prep + wq) so the main event loop stays free.
 * Parent still enforces timeout via worker.terminate().
 */
const { parentPort, workerData } = require("worker_threads");

if (!parentPort) {
  module.exports = {};
} else {
  try {
    const { digitizeJob, pickPrepPython } = require("./digitize");
    if (!process.env.DIGITIZE_PYTHON) {
      try { process.env.DIGITIZE_PYTHON = pickPrepPython(); } catch (e) { process.env.DIGITIZE_PYTHON = "python3"; }
    }
    const job = workerData.job || {};
    const uploadsDir = workerData.uploadsDir;
    const opts = workerData.opts || {};
    const result = digitizeJob(job, uploadsDir, opts);
    const pack = {
      stitchCount: result.stitchCount,
      colorStops: result.colorStops,
      preview: result.preview,
      previewSvg: result.previewSvg,
      objects: result.objects,
      exporter: result.exporter,
      usedFallback: !!result.usedFallback,
      fabric: result.fabric || null,
      engine: result.engine || "wq",
      summary: result.summary || null,
      warnings: result.warnings || [],
      textWarnings: result.textWarnings || [],
      minRecommendedWidthIn: result.minRecommendedWidthIn == null ? null : result.minRecommendedWidthIn,
      busyArt: result.busyArt || null,
      stitches: result.stitches || [],
      widthIn: result.widthIn,
      heightIn: result.heightIn,
      densityMm: result.densityMm,
      satinMm: result.satinMm,
      recolored: !!result.recolored,
    };
    if (result.dst && result.dst.length) pack.dst = result.dst.toString("base64");
    if (result.exp && result.exp.length) pack.exp = result.exp.toString("base64");
    if (result.pes && result.pes.length) pack.pes = result.pes.toString("base64");
    parentPort.postMessage({ ok: true, result: pack });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err && err.message || err) });
  }
}
