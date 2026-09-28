"use strict";

/**
 * Real vector half-tones for DTF / screen / print shops.
 * PNG buffer → luminance → SVG paths / circles / polygons (not embedded raster).
 */

const { decodePng } = require("./png");

const STYLES = [
  { id: "classic-round", name: "Classic Round", kind: "am-round", angle: 45, lpi: 45, contrast: 1, desc: "Standard AM round dots · 45°" },
  { id: "elliptical", name: "Elliptical", kind: "am-ellipse", angle: 45, lpi: 45, contrast: 1, desc: "Elliptical AM · midtone hold" },
  { id: "line", name: "Line", kind: "line", angle: 45, lpi: 40, contrast: 1, desc: "Single-angle line screen" },
  { id: "crosshatch", name: "Crosshatch", kind: "crosshatch", angle: 45, lpi: 35, contrast: 1, desc: "Crossed line screens" },
  { id: "diamond", name: "Diamond", kind: "am-diamond", angle: 45, lpi: 45, contrast: 1, desc: "Diamond / lozenge spots" },
  { id: "square", name: "Square", kind: "am-square", angle: 45, lpi: 45, contrast: 1, desc: "Square AM spots" },
  { id: "stochastic", name: "Stochastic / FM", kind: "fm", angle: 0, lpi: 60, contrast: 1, desc: "Frequency-modulated microdots" },
  { id: "coarse-spot", name: "Coarse Spot", kind: "am-round", angle: 45, lpi: 22, contrast: 1.1, desc: "Low LPI · punchy shop spots" },
  { id: "fine-spot", name: "Fine Spot", kind: "am-round", angle: 45, lpi: 65, contrast: 0.95, desc: "High LPI · fine detail" },
  { id: "dual-tone", name: "Dual Tone", kind: "dual", angle: 45, lpi: 40, contrast: 1, desc: "Two-size round spots" },
  { id: "soft-fade", name: "Soft Fade", kind: "am-round", angle: 45, lpi: 45, contrast: 0.65, desc: "Gentle contrast / soft gain" },
  { id: "hard-punch", name: "Hard Punch", kind: "am-round", angle: 45, lpi: 40, contrast: 1.55, desc: "Hard threshold · poster punch" },
  { id: "newspaper", name: "Newspaper", kind: "am-round", angle: 45, lpi: 28, contrast: 1.15, desc: "Newsprint look · coarse 45°" },
  { id: "comic-dot", name: "Comic Dot", kind: "am-round", angle: 0, lpi: 18, contrast: 1.25, desc: "Ben-Day / comic book dots" },
  { id: "cmyk-cyan", name: "CMYK Cyan angle", kind: "am-round", angle: 15, lpi: 45, contrast: 1, desc: "Process cyan plate angle (15°)" },
  { id: "cmyk-magenta", name: "CMYK Magenta angle", kind: "am-round", angle: 75, lpi: 45, contrast: 1, desc: "Process magenta plate angle (75°)" },
  { id: "cmyk-yellow", name: "CMYK Yellow angle", kind: "am-round", angle: 0, lpi: 45, contrast: 1, desc: "Process yellow plate angle (0°)" },
  { id: "cmyk-black", name: "CMYK Black angle", kind: "am-round", angle: 45, lpi: 45, contrast: 1, desc: "Process black plate angle (45°)" },
  { id: "horizontal-line", name: "Horizontal Line", kind: "line", angle: 0, lpi: 40, contrast: 1, desc: "0° line screen" },
  { id: "vertical-line", name: "Vertical Line", kind: "line", angle: 90, lpi: 40, contrast: 1, desc: "90° line screen" },
  { id: "mesh", name: "Mesh / Wire", kind: "mesh", angle: 0, lpi: 30, contrast: 1, desc: "Orthogonal mesh grid" },
  { id: "triangle", name: "Triangle Spot", kind: "am-triangle", angle: 30, lpi: 40, contrast: 1, desc: "Triangular AM spots" },
  { id: "hex-spot", name: "Hex Spot", kind: "am-hex", angle: 30, lpi: 38, contrast: 1, desc: "Hexagonal AM spots" },
  { id: "grain", name: "Grain / Mezzotint", kind: "grain", angle: 0, lpi: 55, contrast: 1.1, desc: "Random grain mezzotint feel" },
];

const STYLE_MAP = Object.create(null);
STYLES.forEach(function (s) { STYLE_MAP[s.id] = s; });

function listStyles() {
  return STYLES.map(function (s) {
    return { id: s.id, name: s.name, desc: s.desc, defaultAngle: s.angle, defaultLpi: s.lpi };
  });
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function parseColor(c) {
  const s = String(c || "#000000").trim();
  if (/^#([0-9a-fA-F]{6})$/.test(s)) return s.toLowerCase();
  if (/^#([0-9a-fA-F]{3})$/.test(s)) {
    const h = s.slice(1);
    return ("#" + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]).toLowerCase();
  }
  return "#000000";
}

function applyContrast(t, contrast) {
  // t in 0..1 darkness. contrast >1 punches; <1 softens.
  const c = clamp(Number(contrast) || 1, 0.25, 2.5);
  const x = clamp(t, 0, 1);
  if (c === 1) return x;
  // Smoothstep-ish power curve around midtone
  const mid = 0.5;
  const shifted = (x - mid) * c + mid;
  return clamp(shifted, 0, 1);
}

function luminanceAt(rgba, w, h, x, y) {
  const xi = clamp(Math.round(x), 0, w - 1);
  const yi = clamp(Math.round(y), 0, h - 1);
  const i = (yi * w + xi) * 4;
  const a = rgba[i + 3] / 255;
  if (a < 0.04) return 0; // transparent = no ink
  const r = rgba[i];
  const g = rgba[i + 1];
  const b = rgba[i + 2];
  // Perceived luminance; darkness = 1 - Y, modulated by alpha
  const yLin = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const darkness = (1 - yLin) * a;
  return darkness;
}

function sampleCell(rgba, w, h, cx, cy, cell) {
  // Average a few samples in the cell for smoother tone
  const half = cell * 0.28;
  const samples = [
    [cx, cy],
    [cx - half, cy - half],
    [cx + half, cy - half],
    [cx - half, cy + half],
    [cx + half, cy + half],
  ];
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += luminanceAt(rgba, w, h, samples[i][0], samples[i][1]);
  }
  return sum / samples.length;
}

function fmt(n) {
  return (Math.round(n * 1000) / 1000).toString();
}

function circleEl(cx, cy, r, minR, ink) {
  const floor = minR != null ? minR : 0.15;
  if (r < floor) {
    if (r < 0.08) return "";
    r = floor;
  }
  const fill = ink || "inherit";
  return '<circle cx="' + fmt(cx) + '" cy="' + fmt(cy) + '" r="' + fmt(r) + '" fill="' + fill + '"/>';
}

function ellipseEl(cx, cy, rx, ry, angleDeg, minR, ink) {
  const floor = minR != null ? minR : 0.15;
  if (rx < floor && ry < floor) {
    if (rx < 0.08 && ry < 0.08) return "";
    rx = Math.max(rx, floor);
    ry = Math.max(ry, floor);
  }
  const fill = ink || "inherit";
  const a = angleDeg || 0;
  if (Math.abs(a) < 0.01) {
    return '<ellipse cx="' + fmt(cx) + '" cy="' + fmt(cy) + '" rx="' + fmt(rx) + '" ry="' + fmt(ry) + '" fill="' + fill + '"/>';
  }
  return '<ellipse cx="' + fmt(cx) + '" cy="' + fmt(cy) + '" rx="' + fmt(rx) + '" ry="' + fmt(ry) +
    '" transform="rotate(' + fmt(a) + " " + fmt(cx) + " " + fmt(cy) + ')" fill="' + fill + '"/>';
}

function polyEl(pts, ink) {
  if (!pts || pts.length < 3) return "";
  let d = "M " + fmt(pts[0][0]) + " " + fmt(pts[0][1]);
  for (let i = 1; i < pts.length; i++) d += " L " + fmt(pts[i][0]) + " " + fmt(pts[i][1]);
  d += " Z";
  const fill = ink || "inherit";
  return '<path d="' + d + '" fill="' + fill + '"/>';
}

function diamondPts(cx, cy, r) {
  return [[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]];
}

function squarePts(cx, cy, r, angleDeg) {
  const a = ((angleDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const corners = [[-r, -r], [r, -r], [r, r], [-r, r]];
  return corners.map(function (p) {
    return [cx + p[0] * cos - p[1] * sin, cy + p[0] * sin + p[1] * cos];
  });
}

function trianglePts(cx, cy, r, angleDeg) {
  const a0 = ((angleDeg || 0) * Math.PI) / 180;
  const pts = [];
  for (let i = 0; i < 3; i++) {
    const a = a0 + (i * 2 * Math.PI) / 3 - Math.PI / 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function hexPts(cx, cy, r, angleDeg) {
  const a0 = ((angleDeg || 0) * Math.PI) / 180;
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = a0 + (i * Math.PI) / 3;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function lineSeg(x1, y1, x2, y2, strokeW, ink) {
  if (strokeW < 0.12) return "";
  const stroke = ink || "#000000";
  return '<path d="M ' + fmt(x1) + " " + fmt(y1) + " L " + fmt(x2) + " " + fmt(y2) +
    '" fill="none" stroke="' + stroke + '" stroke-width="' + fmt(strokeW) +
    '" stroke-linecap="butt"/>';
}

function hash01(x, y, salt) {
  // Deterministic cheap hash → 0..1
  let n = (x * 374761393 + y * 668265263 + (salt || 0) * 1274126177) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  n = n ^ (n >>> 16);
  return ((n >>> 0) % 10000) / 10000;
}

/**
 * @param {Buffer} pngBuf
 * @param {object} opts
 * @returns {{ svg: string, meta: object, layers: array }}
 */
function halftoneToSvg(pngBuf, opts) {
  opts = opts || {};
  const styleId = String(opts.style || "classic-round");
  const style = STYLE_MAP[styleId] || STYLE_MAP["classic-round"];
  const img = decodePng(pngBuf);
  let w = img.width;
  let h = img.height;
  let rgba = img.rgba;

  const isPreview = !!(opts.preview);
  const previewPlate = !!(opts.previewPlate);
  // Apply: higher edge + mark budget so LPI styles stay distinct (not one coarse decoy grid).
  // Preview: lighter budget but same relative pitch math so thumbs/live plate match Apply look.
  const defaultEdge = isPreview ? 420 : 840;
  const defaultMaxCells = isPreview ? 9000 : 52000;
  const minVisibleR = isPreview ? 0.32 : 0.12;
  // Cap resolution — preview stays fast/readable; Apply keeps higher quality
  const maxEdge = Math.max(200, Math.min(900, Number(opts.maxEdge) || defaultEdge));
  if (Math.max(w, h) > maxEdge) {
    // Box-average downsample — nearest-neighbor made midtone spots look blocky/mushy.
    const scale = maxEdge / Math.max(w, h);
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));
    const nr = Buffer.alloc(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const y0 = Math.floor(y / scale);
      const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) / scale)));
      for (let x = 0; x < nw; x++) {
        const x0 = Math.floor(x / scale);
        const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) / scale)));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            const si = (sy * w + sx) * 4;
            r += rgba[si]; g += rgba[si + 1]; b += rgba[si + 2]; a += rgba[si + 3]; n++;
          }
        }
        const di = (y * nw + x) * 4;
        nr[di] = (r / n) | 0;
        nr[di + 1] = (g / n) | 0;
        nr[di + 2] = (b / n) | 0;
        nr[di + 3] = (a / n) | 0;
      }
    }
    w = nw;
    h = nh;
    rgba = nr;
  }

  const widthIn = Number(opts.widthIn) || Number(opts.width_in) || 10;
  const heightIn = Number(opts.heightIn) || Number(opts.height_in) || (widthIn * h / w);
  const lpi = clamp(Number(opts.lpi != null ? opts.lpi : style.lpi) || style.lpi, 8, 120);
  const angle = Number(opts.angle != null ? opts.angle : style.angle) || 0;
  const contrast = Number(opts.contrast != null ? opts.contrast : style.contrast) || 1;
  const color = parseColor(opts.color || "#000000");
  const knockout = !!(opts.knockout || opts.knockoutWhite || opts.whiteBg);

  // Cell from true LPI, then ONE shared budget factor (ref 45 LPI).
  // Do NOT floor before budgeting — that made fine-spot == classic-round.
  // Per-style renormalization to maxCells also collapsed every style to ~same pitch.
  const ppi = w / Math.max(0.5, widthIn);
  const absMinCell = isPreview ? 0.7 : 0.55;
  const maxCells = Math.max(2000, Math.min(90000, Number(opts.maxCells) || defaultMaxCells));
  const kind = style.kind;
  const anglePasses = (kind === "crosshatch" || kind === "mesh") ? 2 : 1;
  const refLpi = 45;
  const refIdeal = Math.max(0.4, ppi / refLpi);
  const refCols = Math.ceil(w / refIdeal) + 2;
  const refRows = Math.ceil(h / refIdeal) + 2;
  const refMarks = refCols * refRows;
  let budgetFactor = 1;
  if (refMarks > maxCells) budgetFactor = Math.sqrt(refMarks / maxCells);
  let cell = (ppi / Math.max(1, lpi)) * budgetFactor;
  if (!Number.isFinite(cell) || cell < absMinCell) cell = absMinCell;
  if (cell > Math.min(w, h) / 4) cell = Math.min(w, h) / 4;
  // Soft cap only if this style (fine / dual / 2-pass) still wildly over budget
  const estCols = Math.ceil(w / cell) + 2;
  const estRows = Math.ceil(h / cell) + 2;
  const estMarks = estCols * estRows * anglePasses;
  const hardCap = maxCells * (kind === "dual" || anglePasses > 1 ? 1.7 : 1.4);
  if (estMarks > hardCap) {
    cell *= Math.sqrt(estMarks / hardCap);
  }

  const rad = (angle * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const parts = [];
  let count = 0;

  // Bounding box in rotated space
  const corners = [[0, 0], [w, 0], [w, h], [0, h]];
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  corners.forEach(function (p) {
    const u = p[0] * cosA + p[1] * sinA;
    const v = -p[0] * sinA + p[1] * cosA;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  });

  function toXY(u, v) {
    return [u * cosA - v * sinA, u * sinA + v * cosA];
  }

  if (kind === "line" || kind === "crosshatch" || kind === "mesh") {
    const angles = kind === "crosshatch" ? [angle, angle + 90]
      : kind === "mesh" ? [0, 90]
      : [angle];
    angles.forEach(function (ang, ai) {
      const r2 = (ang * Math.PI) / 180;
      const c2 = Math.cos(r2);
      const s2 = Math.sin(r2);
      let mnU = Infinity, mxU = -Infinity, mnV = Infinity, mxV = -Infinity;
      corners.forEach(function (p) {
        const u = p[0] * c2 + p[1] * s2;
        const v = -p[0] * s2 + p[1] * c2;
        if (u < mnU) mnU = u;
        if (u > mxU) mxU = u;
        if (v < mnV) mnV = v;
        if (v > mxV) mxV = v;
      });
      for (let v = mnV - cell; v <= mxV + cell; v += cell) {
        // Sample along the line at several points; use average darkness for stroke width
        // Draw as short segments so tone can vary
        const step = cell;
        for (let u = mnU - cell; u <= mxU + cell; u += step) {
          const xy1 = [u * c2 - v * s2, u * s2 + v * c2];
          const xy2 = [(u + step) * c2 - v * s2, (u + step) * s2 + v * c2];
          const mx = (xy1[0] + xy2[0]) / 2;
          const my = (xy1[1] + xy2[1]) / 2;
          if (mx < -cell || my < -cell || mx > w + cell || my > h + cell) continue;
          let t = applyContrast(sampleCell(rgba, w, h, mx, my, cell), contrast);
          if (kind === "crosshatch" && ai === 1) t *= 0.85;
          if (t < 0.04) continue;
          const sw = t * cell * 0.92;
          const el = lineSeg(xy1[0], xy1[1], xy2[0], xy2[1], sw, color);
          if (el) { parts.push(el); count++; }
        }
      }
    });
  } else if (kind === "fm" || kind === "grain") {
    const micro = Math.max(1.2, cell * (kind === "grain" ? 0.35 : 0.42));
    const pitch = micro * (kind === "grain" ? 1.6 : 1.85);
    for (let y = pitch * 0.5; y < h; y += pitch) {
      for (let x = pitch * 0.5; x < w; x += pitch) {
        const t = applyContrast(luminanceAt(rgba, w, h, x, y), contrast);
        if (t < 0.03) continue;
        const rnd = hash01(Math.round(x), Math.round(y), kind === "grain" ? 7 : 3);
        if (kind === "fm") {
          // Probability of placing a fixed-size microdot
          if (rnd > t) continue;
          const jx = (hash01(Math.round(x), Math.round(y), 11) - 0.5) * pitch * 0.6;
          const jy = (hash01(Math.round(x), Math.round(y), 17) - 0.5) * pitch * 0.6;
          const el = circleEl(x + jx, y + jy, micro * 0.48, minVisibleR, color);
          if (el) { parts.push(el); count++; }
        } else {
          // Grain: variable tiny spots
          if (rnd > Math.min(0.98, t * 1.15)) continue;
          const rr = micro * (0.25 + t * 0.55) * (0.6 + rnd * 0.8);
          const jx = (hash01(Math.round(x), Math.round(y), 21) - 0.5) * pitch;
          const jy = (hash01(Math.round(x), Math.round(y), 27) - 0.5) * pitch;
          const el = circleEl(x + jx, y + jy, rr, minVisibleR, color);
          if (el) { parts.push(el); count++; }
        }
      }
    }
  } else {
    // AM family (round, ellipse, diamond, square, triangle, hex, dual)
    for (let v = minV - cell; v <= maxV + cell; v += cell) {
      for (let u = minU - cell; u <= maxU + cell; u += cell) {
        const xy = toXY(u, v);
        const cx = xy[0];
        const cy = xy[1];
        if (cx < -cell || cy < -cell || cx > w + cell || cy > h + cell) continue;
        let t = applyContrast(sampleCell(rgba, w, h, cx, cy, cell), contrast);
        if (t < 0.03) continue;
        // Spot size: area ≈ t * cell² → radius scales with sqrt(t).
        // 0.48 leaves a hair of cell gap so solids stay discrete (0.52 overlapped ~4%).
        const rMax = cell * 0.48;
        let r = rMax * Math.sqrt(t);
        if (isPreview && t >= 0.08 && r < minVisibleR) r = minVisibleR;
        let el = "";
        if (kind === "am-ellipse") {
          const rx = r * (0.7 + 0.3 * t);
          const ry = r * (1.15 - 0.25 * t);
          el = ellipseEl(cx, cy, rx, ry, angle, minVisibleR, color);
        } else if (kind === "am-diamond") {
          el = polyEl(diamondPts(cx, cy, r), color);
        } else if (kind === "am-square") {
          el = polyEl(squarePts(cx, cy, r * 0.78, angle), color);
        } else if (kind === "am-triangle") {
          el = polyEl(trianglePts(cx, cy, r * 1.05, angle), color);
        } else if (kind === "am-hex") {
          el = polyEl(hexPts(cx, cy, r * 0.95, angle), color);
        } else if (kind === "dual") {
          if (t < 0.45) {
            el = circleEl(cx, cy, r * 0.85, minVisibleR, color);
          } else {
            // Dual: large + small offset satellite for punchy midtones
            el = circleEl(cx, cy, r, minVisibleR, color);
            const r2 = rMax * 0.22 * Math.sqrt(t);
            const off = cell * 0.28;
            const sat = circleEl(cx + off * cosA, cy + off * sinA, r2, minVisibleR, color);
            if (sat) { parts.push(sat); count++; }
          }
        } else {
          el = circleEl(cx, cy, r, minVisibleR, color);
        }
        if (el) { parts.push(el); count++; }
      }
    }
  }

  const vbW = w;
  const vbH = h;
  // Export: knockout checkbox → white plate. Preview: optional white plate for screen readability.
  // Otherwise transparent so ink marks stay visible on checkerboard CSS / Corel.
  const bg = (knockout || previewPlate)
    ? '<rect x="0" y="0" width="' + vbW + '" height="' + vbH + '" fill="#ffffff"/>\n'
    : "";
  const svg =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + fmt(widthIn) + 'in" height="' + fmt(heightIn) +
    'in" viewBox="0 0 ' + vbW + " " + vbH + '" data-halftone="' + style.id + '">\n' +
    bg +
    '<g fill="' + color + '" stroke="none" color="' + color + '" data-name="halftone-' + style.id + '">\n' +
    parts.join("\n") +
    "\n</g>\n</svg>\n";

  const layer = {
    hex: color,
    nameGuess: "Halftone · " + style.name,
    paths: [], // geometry lives in SVG markup (circles/paths) — same pattern as vai-trace empty paths
    rgb: hexToRgb(color),
    cmyk: { c: 0, m: 0, y: 0, k: color === "#000000" ? 100 : 0 },
  };

  const meta = {
    engine: "vector-halftone",
    style: style.id,
    styleName: style.name,
    kind: kind,
    lpi: lpi,
    angle: angle,
    contrast: contrast,
    color: color,
    knockout: knockout,
    preview: isPreview,
    elements: count,
    pixel: [w, h],
    inches: [widthIn, heightIn],
    cell: Math.round(cell * 1000) / 1000,
  };

  return {
    svg: svg,
    meta: meta,
    layers: [layer],
    widthIn: widthIn,
    heightIn: heightIn,
  };
}

function hexToRgb(hex) {
  const h = String(hex || "#000000").replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  };
}

function resolveStyle(id) {
  return STYLE_MAP[String(id || "")] || null;
}

module.exports = {
  STYLES: STYLES,
  listStyles: listStyles,
  halftoneToSvg: halftoneToSvg,
  resolveStyle: resolveStyle,
};
