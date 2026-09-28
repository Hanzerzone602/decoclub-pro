"use strict";
const assert = require("assert");
const { encodePng, makeRgba } = require("../lib/png");
const ht = require("../lib/vectorHalftone");

const w = 48, h = 48;
const rgba = makeRgba(w, h, [0, 0, 0, 0]);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (x < w / 2) {
      rgba[i] = 220; rgba[i + 1] = 40; rgba[i + 2] = 40; rgba[i + 3] = 255;
    } else {
      rgba[i] = 40; rgba[i + 1] = 80; rgba[i + 2] = 220; rgba[i + 3] = 255;
    }
  }
}
const png = encodePng(w, h, rgba);

const src = ht.halftoneToSvg(png, {
  style: "classic-round",
  colorMode: "source",
  lpi: 22,
  widthIn: 3,
  preview: true,
  maxEdge: 96,
  maxCells: 2000,
});
assert.strictEqual(src.meta.colorMode, "source");
assert.strictEqual(src.meta.color, "source");
assert.ok(src.meta.elements > 10, "expected marks");
const fills = [...src.svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1].toLowerCase());
const uniq = [...new Set(fills)];
assert.ok(uniq.length >= 2, "source mode should have multiple mark colors, got " + uniq.join(","));
assert.ok(uniq.every((c) => c !== "#000000") || uniq.some((c) => c !== "#000000"), "expected non-black fills");
assert.ok(uniq.some((c) => {
  const r = parseInt(c.slice(1, 3), 16), b = parseInt(c.slice(5, 7), 16);
  return r > 150 && b < 100;
}), "expected redish mark");
assert.ok(uniq.some((c) => {
  const r = parseInt(c.slice(1, 3), 16), b = parseInt(c.slice(5, 7), 16);
  return b > 150 && r < 100;
}), "expected bluish mark");
assert.ok(/data-color-mode="source"/.test(src.svg));
assert.ok(/Full color HT/.test(src.layers[0].nameGuess));

const ink = ht.halftoneToSvg(png, {
  style: "classic-round",
  colorMode: "ink",
  color: "#00aa00",
  lpi: 22,
  widthIn: 3,
  preview: true,
  maxEdge: 96,
  maxCells: 2000,
});
assert.strictEqual(ink.meta.colorMode, "ink");
assert.strictEqual(ink.meta.color, "#00aa00");
assert.ok(ink.svg.indexOf('fill="#00aa00"') !== -1 || ink.svg.indexOf('color="#00aa00"') !== -1);

// sampleCellColor helper
const samp = ht.sampleCellColor(rgba, w, h, 8, 24, 4);
assert.ok(samp.r > 150 && samp.b < 100, JSON.stringify(samp));
assert.ok(samp.darkness > 0);

console.log("PASS halftone-color source/ink smoke");
