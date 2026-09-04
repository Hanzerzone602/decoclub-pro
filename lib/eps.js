"use strict";

const { parsePathCommands, fmt } = require("./vectorize");

function pt(n) { return fmt(n); }

function epsFromLayers(layers, widthIn, heightIn) {
  const wIn = Number(widthIn) || 1;
  const hIn = Number(heightIn) || 1;
  const wPt = wIn * 72;
  const hPt = hIn * 72;
  const lines = [
    "%!PS-Adobe-3.0 EPSF-3.0",
    "%%BoundingBox: 0 0 " + Math.ceil(wPt) + " " + Math.ceil(hPt),
    "%%Creator: DecoClub Pro Studio",
    "%%Pages: 1",
    "%%EndComments",
    "gsave",
  ];
  function X(x) { return x * 72; }
  function Y(y) { return (hIn - y) * 72; }
  (layers || []).forEach((L) => {
    const rgb = parseRgb(L.hex);
    const paths = L.paths || [];
    let hasHole = paths.some((p) => p.hole);
    lines.push("newpath");
    paths.forEach((p) => {
      const cmds = parsePathCommands(p.d);
      if (!cmds.length) return;
      cmds.forEach((c) => {
        if (c.op === "M") lines.push(pt(X(c.x)) + " " + pt(Y(c.y)) + " moveto");
        else if (c.op === "L") lines.push(pt(X(c.x)) + " " + pt(Y(c.y)) + " lineto");
        else if (c.op === "C") {
          lines.push(
            pt(X(c.x1)) + " " + pt(Y(c.y1)) + " " +
            pt(X(c.x2)) + " " + pt(Y(c.y2)) + " " +
            pt(X(c.x)) + " " + pt(Y(c.y)) + " curveto"
          );
        } else if (c.op === "Z") lines.push("closepath");
      });
    });
    const col = fmt(rgb[0] / 255) + " " + fmt(rgb[1] / 255) + " " + fmt(rgb[2] / 255) + " setrgbcolor";
    lines.push("gsave");
    lines.push(col);
    lines.push(hasHole ? "eofill" : "fill");
    lines.push("grestore");
    lines.push(col);
    lines.push(fmt(Math.max(wPt, hPt) * 0.0018) + " setlinewidth");
    lines.push("1 setlinejoin");
    lines.push("stroke");
  });
  lines.push("grestore", "showpage", "%%EOF", "");
  return lines.join("\n");
}

function parseRgb(hex) {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length !== 6) return [0.07, 0.07, 0.07];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

module.exports = { epsFromLayers };
