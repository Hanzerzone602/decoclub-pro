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

function greyscaleHiRes(buf, scale) {
  const img = decodePng(buf);
  let s = Number(scale) || 2;
  if (s < 1) s = 1;
  if (s > 3) s = 3;
  let nw = Math.round(img.width * s);
  let nh = Math.round(img.height * s);
  const max = 2400;
  if (Math.max(nw, nh) > max) {
    const k = max / Math.max(nw, nh);
    nw = Math.max(1, Math.round(nw * k));
    nh = Math.max(1, Math.round(nh * k));
  }
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y * img.height / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x * img.width / nw));
      const si = (sy * img.width + sx) * 4;
      const g = Math.round(0.299 * img.rgba[si] + 0.587 * img.rgba[si + 1] + 0.114 * img.rgba[si + 2]);
      const di = (y * nw + x) * 4;
      out[di] = g; out[di + 1] = g; out[di + 2] = g; out[di + 3] = img.rgba[si + 3];
    }
  }
  return encodePng(nw, nh, out);
}

function processArtwork(buf, ops) {
  ops = ops || {};
  if (ops.remove_background || ops.knockout === "production" || ops.knockout === "auto") {
    buf = removeBackground(buf);
  }
  if (ops.greyscale) {
    return greyscaleHiRes(buf, ops.scale);
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

module.exports = { processArtwork, hexRgb, greyscaleHiRes };
