"use strict";

const assert = require("assert");
const { priceJob, RATES } = require("../lib/price");
const { encodePng, makeRgba, decodePng } = require("../lib/png");
const { contourFromPngBuffer, svgFromContour } = require("../lib/contour");
const { gangSheetSvg, gangLayout, SHEET_W_IN, GAP_IN, laserPlt, cutContourSvg } = require("../lib/exports");
const { generateBadgePng } = require("../lib/demoart");
const { removeBackground } = require("../lib/matte");
const { pickImagineModel } = require("../lib/imagine");

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

{
  const buf = squarePng();
  const out = removeBackground(buf);
  const img = decodePng(out);
  assert.strictEqual(img.rgba[3], 0, "corner is transparent");
  const mid = ((24 * 48 + 24) * 4) + 3;
  assert.strictEqual(img.rgba[mid], 255, "center stays opaque");
  console.log("ok production matte");
}

{
  assert.strictEqual(pickImagineModel(["grok-imagine-image-1.5", "grok-imagine-image-2.0"]), "grok-imagine-image-2.0");
  assert.strictEqual(pickImagineModel(["grok-imagine-image-2.0", "grok-imagine-image-3.0"]), "grok-imagine-image-3.0");
  console.log("ok imagine newest model pick");
}

{
  const { vectorize, svgFromLayers } = require("../lib/vectorize");
  const { epsFromLayers } = require("../lib/eps");
  const { digitizeLayers } = require("../lib/digitize");
  const { packStonesFromPng } = require("../lib/stones");
  const { listPalettes, nearestNamed } = require("../lib/palettes");
  const buf = squarePng();
  const vec = vectorize(buf, 1, 1);
  assert.ok(vec.layers && vec.layers.length >= 1, "vectorize yields a layer");
  const d = vec.layers[0].paths && vec.layers[0].paths[0] && vec.layers[0].paths[0].d;
  assert.ok(d && /[CL]/.test(d) && /Z/.test(d), "path has C or L and Z");
  assert.ok(/ C /.test(d) || / L /.test(d), "path has segments");
  const svg = svgFromLayers(vec.layers, vec.widthIn, vec.heightIn);
  assert.ok(svg.indexOf("<g") !== -1 && svg.indexOf("<path") !== -1);
  const eps = epsFromLayers(vec.layers, vec.widthIn, vec.heightIn);
  assert.ok(eps.indexOf("%!PS-Adobe") === 0 || eps.indexOf("%!PS-Adobe") !== -1);
  assert.ok(eps.indexOf("setrgbcolor") !== -1);
  const dig = digitizeLayers(vec, { name: "SQUARE" });
  assert.ok(dig.dst && dig.dst.length > 512, "DST longer than header");
  assert.ok(dig.dst[0] === 0x4C && dig.dst[1] === 0x41 && dig.dst[2] === 0x3A, "DST starts with LA:");
  assert.ok(dig.stitchCount > 50, "1in square has real stitches, not 4 jumps");
  const stones = packStonesFromPng(buf, 2, 2, { ss: "SS10" });
  assert.ok(stones.length > 8, "SS10 pack on 2in art is more than a handful");
  const pals = listPalettes();
  assert.ok(pals.vinyl.length >= 20 && pals.thread.length >= 24 && pals.stone.length >= 12);
  pals.vinyl.concat(pals.thread, pals.stone, pals.process).forEach((c) => {
    assert.ok(c.name && c.hex && /^#[0-9a-fA-F]{6}$/.test(c.hex));
  });
  assert.ok(nearestNamed("#017ece", "vinyl").name);
  console.log("ok studio vectorize eps dst stones palettes", "stitches=" + dig.stitchCount, "stones=" + stones.length);
}


{
  const { vectorize, svgFromLayers } = require("../lib/vectorize");
  const { encodePng, makeRgba } = require("../lib/png");
  const w = 80, h = 80;
  const rgba = makeRgba(w, h, [240, 80, 40, 255]);
  for (let y = 18; y < 62; y++) {
    for (let x = 18; x < 62; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 20; rgba[i + 1] = 40; rgba[i + 2] = 160; rgba[i + 3] = 255;
    }
  }
  for (let y = 32; y < 48; y++) {
    for (let x = 32; x < 48; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 240; rgba[i + 1] = 80; rgba[i + 2] = 40; rgba[i + 3] = 255;
    }
  }
  const vec = vectorize(encodePng(w, h, rgba), 4, 4, { colors: 4 });
  assert.ok(vec.layers.length >= 2, "two-color donut yields 2+ layers");
  const svg = svgFromLayers(vec.layers, vec.widthIn, vec.heightIn);
  assert.ok(svg.indexOf('fill-rule="evenodd"') !== -1);
  const hasHole = vec.layers.some((L) => (L.paths || []).some((p) => p.hole));
  assert.ok(hasHole || /Z M /.test(svg) || (svg.match(/Z/g) || []).length >= 2, "hole or stacked paths present");
  console.log("ok layered color vectorize", "layers=" + vec.layers.length);
}

{
  const { vectorize, svgFromLayers } = require("../lib/vectorize");
  const { epsFromLayers } = require("../lib/eps");
  const { encodePng, makeRgba } = require("../lib/png");
  const w = 96, h = 96;
  const rgba = makeRgba(w, h, [255, 255, 255, 0]);
  const cx = 48, cy = 48, r = 34;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) {
        const i = (y * w + x) * 4;
        rgba[i] = 20; rgba[i + 1] = 90; rgba[i + 2] = 200; rgba[i + 3] = 255;
      }
    }
  }
  const vec = vectorize(encodePng(w, h, rgba), 3, 3, { colors: 3, maxEdge: 200, epsilon: 0.55, fitError: 0.65 });
  assert.ok(vec.layers && vec.layers.length >= 1, "disk yields layer");
  const allD = vec.layers.map((L) => (L.paths || []).map((p) => p.d).join(" ")).join(" ");
  assert.ok(/ C /.test(allD), "curved shape paths contain cubic C commands");
  const cCount = (allD.match(/ C /g) || []).length;
  assert.ok(cCount >= 2, "at least 2 cubics on disk, got " + cCount);
  const svg = svgFromLayers(vec.layers, vec.widthIn, vec.heightIn);
  assert.ok(svg.indexOf('fill-rule="evenodd"') !== -1);
  const eps = epsFromLayers(vec.layers, vec.widthIn, vec.heightIn);
  assert.ok(eps.indexOf("curveto") !== -1, "EPS contains curveto for cubic paths");
  console.log("ok curved cubic vectorize", "C=" + cCount, "curveto");
}

{
  const { processArtwork } = require("../lib/artops");
  const { encodePng, makeRgba, decodePng } = require("../lib/png");
  const w = 20, h = 20;
  const rgba = makeRgba(w, h, [200, 40, 40, 255]);
  const out = processArtwork(encodePng(w, h, rgba), { greyscale: true, scale: 2 });
  const img = decodePng(out);
  assert.strictEqual(img.width, 40);
  assert.strictEqual(img.height, 40);
  assert.strictEqual(img.rgba[0], img.rgba[1]);
  assert.strictEqual(img.rgba[1], img.rgba[2]);
  console.log("ok hi-res greyscale");
}

console.log("all tests passed");
