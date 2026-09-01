"use strict";

const assert = require("assert");
const { priceJob, RATES } = require("../lib/price");
const { encodePng, makeRgba, decodePng } = require("../lib/png");
const { contourFromPngBuffer, svgFromContour } = require("../lib/contour");
const { gangSheetSvg, gangLayout, SHEET_W_IN, GAP_IN, laserPlt, cutContourSvg } = require("../lib/exports");
const { generateBadgePng } = require("../lib/demoart");

function squarePng() {
  const w = 48, h = 48;
  const rgba = makeRgba(w, h, [255, 255, 255, 255]);
  for (let y = 12; y < 36; y++) {
    for (let x = 12; x < 36; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 10; rgba[i + 1] = 10; rgba[i + 2] = 10; rgba[i + 3] = 255;
    }
  }
  return encodePng(w, h, rgba);
}

{
  const p = priceJob({ method: "dtf", width_in: 10, height_in: 10, qty: 1 });
  assert.strictEqual(RATES.dtf, 1.15);
  assert.strictEqual(p.unit_price, 117.5);
  assert.strictEqual(p.total, 117.5);
  const ten = priceJob({ method: "dtf", width_in: 10, height_in: 10, qty: 10 });
  assert.strictEqual(ten.total, 1057.5);
  const bulk = priceJob({ method: "dtf", width_in: 10, height_in: 10, qty: 25 });
  assert.strictEqual(bulk.total, 2408.75);
  const laser = priceJob({ method: "laser", width_in: 10, height_in: 4, qty: 24 });
  assert.ok(laser.unit_price > 0 && laser.total > laser.unit_price);
  console.log("ok pricing engine");
}

{
  const buf = squarePng();
  const round = decodePng(buf);
  assert.strictEqual(round.width, 48);
  assert.strictEqual(round.rgba[0], 255);
  const c = contourFromPngBuffer(buf, 4, 4, { epsilon: 0.8 });
  assert.ok(c.d && c.d.length > 10, "contour path should be non-empty");
  assert.ok(/^M /.test(c.d), "path starts with M");
  assert.ok(c.d.indexOf("L") !== -1, "path has line segments");
  const svg = svgFromContour(c);
  assert.ok(svg.indexOf("<path") !== -1);
  assert.ok(/d="M [^"]+"/.test(svg));
  const d = /d="([^"]+)"/.exec(svg)[1];
  assert.ok(d.replace(/[\sMLZ]/g, "").length > 8, "SVG contour path data is non-empty");
  console.log("ok contour SVG non-empty", c.pointCount, "pts");
}

{
  const badge = generateBadgePng();
  const c = contourFromPngBuffer(badge, 6, 6);
  const svg = cutContourSvg({ id: "testjob00", method: "sticker", width_in: 6, height_in: 6, file_path: null }, "/tmp");
  assert.ok(svg.indexOf("<path") !== -1);
  assert.ok(c.d.length > 20);
  console.log("ok badge silhouette");
}

{
  const job = { id: "abc123def456", title: "Run", method: "dtf", width_in: 4, height_in: 3, qty: 6, file_path: null };
  const svg = gangSheetSvg(job);
  const L = gangLayout(job);
  assert.strictEqual(L.sheetW, 22);
  assert.strictEqual(GAP_IN, 0.125);
  assert.ok(svg.indexOf(`width="${SHEET_W_IN}in"`) !== -1);
  assert.ok(svg.indexOf(`height="${L.sheetH}in"`) !== -1);
  assert.ok(svg.indexOf(`viewBox="0 0 ${L.sheetW} ${L.sheetH}"`) !== -1, "gang-sheet viewBox is in inches");
  assert.ok(L.sheetW === 22);
  console.log("ok gang-sheet viewBox in inches", `0 0 ${L.sheetW} ${L.sheetH}`);
}

{
  const buf = squarePng();
  const plt = laserPlt({ id: "plt00001", method: "laser", width_in: 3, height_in: 2, file_path: null }, "/tmp");
  assert.ok(plt.indexOf("IN;") === 0);
  assert.ok(plt.indexOf("PU") !== -1);
  assert.ok(plt.indexOf("PD") !== -1);
  console.log("ok PLT packet");
}

console.log("all tests passed");
