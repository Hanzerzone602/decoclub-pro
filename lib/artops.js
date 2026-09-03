"use strict";

const { decodePng, encodePng } = require("./png");
const { removeBackground } = require("./matte");

function hexRgb(hex) {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function dist2(a, b) {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

function processArtwork(buf, ops) {
  ops = ops || {};
  if (ops.remove_background || ops.knockout === "production" || ops.knockout === "auto") {
    buf = removeBackground(buf);
  }
  const img = decodePng(buf);
  const rgba = Buffer.from(img.rgba);
  const knockout = ops && ops.knockout;
  const swap = ops && ops.color_swap;
  const koTarget = knockout === true || knockout === "white"
    ? [255, 255, 255]
    : hexRgb(knockout && knockout.target);
  const koTol = Number((knockout && knockout.tolerance) != null ? knockout.tolerance : 28);
  const from = swap ? hexRgb(swap.from) : null;
  const to = swap ? hexRgb(swap.to) : null;
  const swapTol = Number(swap && swap.tolerance != null ? swap.tolerance : 36);
  for (let i = 0; i < rgba.length; i += 4) {
    const px = [rgba[i], rgba[i + 1], rgba[i + 2]];
    if (koTarget && dist2(px, koTarget) <= koTol * koTol) {
      rgba[i + 3] = 0;
      continue;
    }
    if (from && to && dist2(px, from) <= swapTol * swapTol) {
      rgba[i] = to[0];
      rgba[i + 1] = to[1];
      rgba[i + 2] = to[2];
    }
  }
  return encodePng(img.width, img.height, rgba);
}

module.exports = { processArtwork, hexRgb };
