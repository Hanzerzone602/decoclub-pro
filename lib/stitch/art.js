"use strict";

function rectLayer(w, h, hex) {
  return {
    hex: hex,
    nameGuess: "Fill",
    paths: [{ d: "M 0 0 L " + w + " 0 L " + w + " " + h + " L 0 " + h + " Z", hole: false }],
  };
}

function barLayer(w, h, hex, inset) {
  const t = inset == null ? 0.42 : inset;
  const x0 = w * t, x1 = w * (1 - t);
  return {
    hex: hex,
    nameGuess: "Bar",
    paths: [{ d: "M " + x0 + " 0 L " + x1 + " 0 L " + x1 + " " + h + " L " + x0 + " " + h + " Z", hole: false }],
  };
}

function diagonalBarLayer(w, h, hex, thickness) {
  const t = thickness == null ? Math.min(w, h) * 0.035 : thickness;
  const n = Math.hypot(w, h) || 1;
  const nx = (-h / n) * t, ny = (w / n) * t;
  const a = { x: t, y: t }, b = { x: w - t, y: h - t };
  const d = [
    "M", a.x + nx, a.y + ny,
    "L", b.x + nx, b.y + ny,
    "L", b.x - nx, b.y - ny,
    "L", a.x - nx, a.y - ny,
    "Z",
  ].join(" ");
  return { hex: hex, nameGuess: "Stroke", paths: [{ d: d, hole: false }] };
}

function letterI(w, h, hex) {
  const stem = Math.min(w, h) * 0.10;
  const x0 = (w - stem) / 2, x1 = x0 + stem;
  const pad = h * 0.06;
  return {
    hex: hex,
    nameGuess: "I",
    paths: [{ d: "M " + x0 + " " + pad + " L " + x1 + " " + pad + " L " + x1 + " " + (h - pad) + " L " + x0 + " " + (h - pad) + " Z", hole: false }],
  };
}

function navyLogo(w, h) {
  return { widthIn: w, heightIn: h, layers: [rectLayer(w, h, "#0d2a5b")] };
}

function sampleArt(kind, w, h) {
  w = Number(w) || 1;
  h = Number(h) || 1;
  if (kind === "bar") return { widthIn: w, heightIn: h, layers: [barLayer(w, h, "#c4281c")] };
  if (kind === "diagonal") return { widthIn: w, heightIn: h, layers: [diagonalBarLayer(w, h, "#1e4482")] };
  if (kind === "letter") return { widthIn: w, heightIn: h, layers: [letterI(w, h, "#c4281c")] };
  if (kind === "navy") return navyLogo(w, h);
  if (kind === "two") {
    return {
      widthIn: w, heightIn: h,
      layers: [rectLayer(w, h, "#0d2a5b"), letterI(w, h, "#e3e5fb")],
    };
  }
  return { widthIn: w, heightIn: h, layers: [rectLayer(w, h, "#111111")] };
}

module.exports = { rectLayer, barLayer, diagonalBarLayer, letterI, navyLogo, sampleArt };
