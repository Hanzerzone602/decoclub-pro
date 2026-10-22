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

/**
 * EPS straight from the final SVG via rsvg-convert (cairo), so every SVG
 * transform (vtracer/potrace scale + flipped translate) is applied exactly
 * like the PDF/SVG downloads. Vector output. Page = exact widthIn x heightIn;
 * cairo crops %%BoundingBox to ink, so we restore the full page box plus an
 * exact %%HiResBoundingBox. Returns null on any failure (caller falls back).
 */
function epsFromSvg(svgText, widthIn, heightIn) {
  const wIn = Number(widthIn), hIn = Number(heightIn);
  if (!svgText || !(wIn > 0) || !(hIn > 0)) return null;
  const fs = require("fs"), os = require("os"), path = require("path");
  const { spawnSync } = require("child_process");
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-eps-"));
    const inSvg = path.join(tmp, "in.svg"), outEps = path.join(tmp, "out.eps");
    fs.writeFileSync(inSvg, svgText);
    const run = spawnSync("rsvg-convert", ["-f", "eps", "-w", wIn.toFixed(4) + "in", "-h", hIn.toFixed(4) + "in", "-o", outEps, inSvg],
      { timeout: 60000, maxBuffer: 1 << 20 });
    if (run.error || run.status !== 0 || !fs.existsSync(outEps)) return null;
    let eps = fs.readFileSync(outEps, "latin1");
    if (!/^%!PS-Adobe-3\.0 EPSF/.test(eps)) return null;
    const wPt = wIn * 72, hPt = hIn * 72;
    eps = eps.replace(/^%%BoundingBox:.*$/m,
      "%%BoundingBox: 0 0 " + Math.ceil(wPt - 1e-6) + " " + Math.ceil(hPt - 1e-6) +
      "\n%%HiResBoundingBox: 0 0 " + wPt.toFixed(4) + " " + hPt.toFixed(4));
    eps = eps.replace(/^1 0 0 -1 0 [0-9.]+ cm/m, "1 0 0 -1 0 " + hPt.toFixed(4) + " cm");
    return Buffer.from(eps, "latin1");
  } catch (e) {
    return null;
  } finally {
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  }
}

module.exports = { epsFromLayers, epsFromSvg };
