"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { digitizeLayers, summarize, ensureStitchFiles } = require("../lib/digitize");
const { sampleArt } = require("../lib/stitch/art");

{
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(app.indexOf("design.pes") !== -1, "Digitize tab offers PES");
  assert.ok(app.indexOf("paintDigitizeStats") !== -1, "tab paints stitch/thread stats");
  assert.ok(app.indexOf("textWarnings") !== -1, "tab shows prep textWarnings");
  assert.ok(app.indexOf("minRecommendedWidthIn") !== -1, "tab shows minRecommendedWidthIn");
  assert.ok(app.indexOf("busyArt") !== -1, "tab reads busy-art fields defensively");
  assert.ok(app.indexOf("digSimplify") !== -1, "tab has simplify busy-art control");
  console.log("ok digitize tab UI wires PES + stats + busy-art");
}

{
  const v = sampleArt("square", 1, 1);
  const d = digitizeLayers(v, { name: "TAB", density: 0.4, fabric: "tee", previewOnly: true });
  assert.strictEqual(d.engine, "wq");
  assert.ok(d.summary && d.summary.stitchCount > 50, "summary stitch count");
  assert.ok(d.summary.colours >= 1);
  assert.ok(d.summary.trims >= 1);
  assert.ok(Array.isArray(d.textWarnings));
  assert.ok("minRecommendedWidthIn" in d);
  assert.ok("busyArt" in d);
  const stitches = (d.stitches || []).filter((s) => s.kind === "stitch");
  let last = null, bad = 0;
  stitches.forEach((s) => {
    if (last) {
      const mm = Math.hypot(s.x - last.x, s.y - last.y) / 10;
      if (mm < 0.3 - 1e-6 || mm > 7 + 1e-6) bad++;
    }
    last = s;
  });
  assert.strictEqual(bad, 0, "no stitch <0.3 mm or >7 mm, bad=" + bad);
  const files = ensureStitchFiles({
    stitches: d.stitches, colorStops: d.colorStops, widthIn: 1, heightIn: 1, dst: Buffer.alloc(0),
  }, "TAB");
  assert.ok(files.dst && files.dst.length > 512, "ensureStitchFiles DST");
  assert.ok(files.exp && files.exp.length > 8, "ensureStitchFiles EXP");
  assert.ok(files.pes && files.pes.length > 16, "ensureStitchFiles PES");
  console.log("ok wq preview + stitch length + DST/EXP/PES from cache", "stitches=" + d.stitchCount, "exporter=" + files.exporter);
}

{
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(app.indexOf("previewOnly: true") !== -1);
  const exp = fs.readFileSync(path.join(__dirname, "..", "lib", "exports.js"), "utf8");
  assert.ok(exp.indexOf("engine: \"legacy\"") !== -1, "Vectorize packet DST path stays legacy");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.indexOf("stitchFileForJob") !== -1, "tab downloads use cached wq result");
  assert.ok(srv.indexOf("digitizeJobCached") !== -1, "digitize runs off the event loop");
  console.log("ok downloads + worker + vectorize packet split");
}

console.log("PASS digitize-tab");
