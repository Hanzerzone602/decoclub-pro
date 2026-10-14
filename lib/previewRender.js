"use strict";

// Sharp studio preview tiles. The browser never receives the production SVG
// for an unpaid job; it asks for a PNG of the visible region instead.
//
// Query coordinates (x, y, w, h) are normalized fractions of the SVG root
// viewBox, origin top-left, each axis 0..1. They are not raw user units.
// zoom is a fit-relative multiplier (1 = the whole viewBox) clamped to
// 0.1..16 (10%..1600%). When w and h are omitted, the window is a centered
// square of side 1/zoom. pw and ph are the requested output pixel box,
// each clamped to 8..2048. mode is "fill" (default) or "outline".
//
// rsvg-convert 2.60 ignores vector-effect="non-scaling-stroke" (verified),
// so outline strokes are sized in user units as cropWidth / outputWidth,
// which lands on about one device pixel.

const fs = require("fs");
const { spawnSync } = require("child_process");

const MAX_PX = 2048;
const MIN_PX = 8;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 16;
const MIN_WIN = 1 / 16;
const SVG_CACHE_MAX = 32;
const svgTextCache = new Map();

function stripPaperUnderlay(svg) {
  return String(svg || "").replace(/<(path|rect)\b[^>]*\bdata-name\s*=\s*["']paper-underlay["'][^>]*\/?>\s*/gi, "");
}

function loadSvgText(absPath) {
  const st = fs.statSync(absPath);
  const key = absPath + "\0" + st.mtimeMs + "\0" + st.size;
  const hit = svgTextCache.get(key);
  if (hit) return hit;
  let text = fs.readFileSync(absPath, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  svgTextCache.set(key, text);
  while (svgTextCache.size > SVG_CACHE_MAX) {
    const first = svgTextCache.keys().next().value;
    svgTextCache.delete(first);
  }
  return text;
}

function readNum(sp, name) {
  if (!sp || typeof sp.get !== "function" || !sp.has(name)) return undefined;
  const raw = sp.get(name);
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return { bad: name };
  return n;
}

function clampWindow(x, y, w, h) {
  w = Math.min(1, Math.max(MIN_WIN, w));
  h = Math.min(1, Math.max(MIN_WIN, h));
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + w > 1) x = Math.max(0, 1 - w);
  if (y + h > 1) y = Math.max(0, 1 - h);
  return { x: x, y: y, w: w, h: h };
}

function clampPx(n) {
  return Math.max(MIN_PX, Math.min(MAX_PX, Math.round(n)));
}

/** Parse the preview.png query. Returns { ok:false, error } or a clamped spec. */
function parsePreviewQuery(sp) {
  const modeRaw = sp && sp.get ? String(sp.get("mode") || "fill").toLowerCase() : "fill";
  if (modeRaw !== "fill" && modeRaw !== "outline") return { ok: false, error: "Invalid preview mode" };

  const zoomRaw = readNum(sp, "zoom");
  const xRaw = readNum(sp, "x");
  const yRaw = readNum(sp, "y");
  const wRaw = readNum(sp, "w");
  const hRaw = readNum(sp, "h");
  const pwRaw = readNum(sp, "pw");
  const phRaw = readNum(sp, "ph");
  const bad = [zoomRaw, xRaw, yRaw, wRaw, hRaw, pwRaw, phRaw].find(function (v) { return v && v.bad; });
  if (bad) return { ok: false, error: "Invalid preview parameter: " + bad.bad };
  if (zoomRaw !== undefined && zoomRaw <= 0) return { ok: false, error: "Invalid zoom" };
  if (wRaw !== undefined && wRaw <= 0) return { ok: false, error: "Invalid preview window" };
  if (hRaw !== undefined && hRaw <= 0) return { ok: false, error: "Invalid preview window" };
  if (pwRaw !== undefined && pwRaw <= 0) return { ok: false, error: "Invalid preview size" };
  if (phRaw !== undefined && phRaw <= 0) return { ok: false, error: "Invalid preview size" };
  if ((wRaw === undefined) !== (hRaw === undefined)) return { ok: false, error: "Preview window needs both w and h" };

  let zoom = zoomRaw === undefined ? 1 : zoomRaw;
  zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

  let x;
  let y;
  let w;
  let h;
  if (wRaw === undefined) {
    const side = 1 / zoom;
    w = side;
    h = side;
    x = xRaw === undefined ? (1 - side) / 2 : xRaw;
    y = yRaw === undefined ? (1 - side) / 2 : yRaw;
  } else {
    w = wRaw;
    h = hRaw;
    x = xRaw === undefined ? 0 : xRaw;
    y = yRaw === undefined ? 0 : yRaw;
  }
  const win = clampWindow(x, y, w, h);
  return {
    ok: true,
    x: win.x,
    y: win.y,
    w: win.w,
    h: win.h,
    zoom: zoom,
    pw: pwRaw === undefined ? null : clampPx(pwRaw),
    ph: phRaw === undefined ? null : clampPx(phRaw),
    mode: modeRaw,
  };
}

function parseLen(value) {
  const m = String(value == null ? "" : value).match(/([0-9]*\.?[0-9]+)/);
  return m ? Number(m[1]) : NaN;
}

function parseRootViewBox(svg) {
  const open = /<svg\b([^>]*)>/i.exec(svg);
  const attrs = open ? open[1] : "";
  const vb = /viewBox\s*=\s*["']([^"']+)["']/i.exec(attrs);
  if (vb) {
    const n = vb[1].trim().split(/[\s,]+/).map(Number);
    if (n.length === 4 && n.every(function (v) { return Number.isFinite(v); }) && n[2] > 0 && n[3] > 0) {
      return { x: n[0], y: n[1], w: n[2], h: n[3] };
    }
  }
  const wAttr = /(?:^|\s)width\s*=\s*["']([^"']+)["']/i.exec(attrs);
  const hAttr = /(?:^|\s)height\s*=\s*["']([^"']+)["']/i.exec(attrs);
  const w = wAttr ? parseLen(wAttr[1]) : NaN;
  const h = hAttr ? parseLen(hAttr[1]) : NaN;
  if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) return { x: 0, y: 0, w: w, h: h };
  return { x: 0, y: 0, w: 100, h: 100 };
}

function upsertAttr(openTag, name, value) {
  const re = new RegExp("(\\s)" + name + "\\s*=\\s*(\"[^\"]*\"|'[^']*'|[^\\s>]+)", "i");
  if (re.test(openTag)) return openTag.replace(re, " " + name + '="' + value + '"');
  return openTag.replace(/<svg\b/i, '<svg ' + name + '="' + value + '"');
}

function rewriteRoot(svg, vb, pw, ph) {
  return svg.replace(/<svg\b[^>]*>/i, function (open) {
    let t = open;
    if (!/\sxmlns\s*=/i.test(t)) t = t.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    t = upsertAttr(t, "viewBox", vb.x + " " + vb.y + " " + vb.w + " " + vb.h);
    t = upsertAttr(t, "width", String(pw));
    t = upsertAttr(t, "height", String(ph));
    t = upsertAttr(t, "preserveAspectRatio", "none");
    return t;
  });
}

function stripPaint(attrs) {
  let a = attrs;
  a = a.replace(/\sstyle\s*=\s*"([^"]*)"/gi, function (_, style) {
    const s = style.replace(/(?:^|;)\s*(?:fill|stroke|stroke-width|stroke-opacity|vector-effect|fill-opacity)\s*:[^;]*/gi, "").replace(/^;+|;+$/g, "").trim();
    return s ? ' style="' + s + '"' : "";
  });
  a = a.replace(/\sstyle\s*=\s*'([^']*)'/gi, function (_, style) {
    const s = style.replace(/(?:^|;)\s*(?:fill|stroke|stroke-width|stroke-opacity|vector-effect|fill-opacity)\s*:[^;]*/gi, "").replace(/^;+|;+$/g, "").trim();
    return s ? " style='" + s + "'" : "";
  });
  a = a.replace(/\s(?:fill|stroke|stroke-width|stroke-opacity|vector-effect|fill-opacity)\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>]+)/gi, "");
  return a;
}

function outlineShapes(svg, strokeWidth) {
  const sw = String(strokeWidth);
  const paint = ' fill="none" stroke="#00a0ff" stroke-width="' + sw + '" vector-effect="non-scaling-stroke"';
  return svg.replace(/<(path|circle|ellipse|polygon|polyline|rect|line|use|g|svg)\b([^>]*?)(\/?)\s*>/gi, function (_, tag, attrs, slash) {
    return "<" + tag + stripPaint(attrs) + paint + (slash ? "/" : "") + ">";
  });
}

function watermarkMarkup(vb) {
  const cx = vb.x + vb.w / 2;
  const cy = vb.y + vb.h / 2;
  const span = Math.hypot(vb.w, vb.h) || 1;
  const fontSize = Math.max(span * 0.055, Math.min(vb.w, vb.h) * 0.08);
  const stepY = fontSize * 2.6;
  const stepX = fontSize * 9.5;
  const reach = span * 1.35;
  let texts = "";
  for (let y = cy - reach; y <= cy + reach + 0.01; y += stepY) {
    for (let x = cx - reach; x <= cx + reach + 0.01; x += stepX) {
      texts += '<text x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '">DECOCLUB PRO · PREVIEW</text>';
    }
  }
  return '<g fill="#017ece" fill-opacity="0.45" stroke="none" font-family="sans-serif" font-weight="700" font-size="' +
    fontSize.toFixed(2) + '" transform="rotate(-24 ' + cx.toFixed(2) + " " + cy.toFixed(2) + ')">' + texts + "</g>";
}

function insertBeforeEnd(svg, inner) {
  const i = svg.toLowerCase().lastIndexOf("</svg>");
  if (i === -1) return svg + inner;
  return svg.slice(0, i) + inner + svg.slice(i);
}

function outputPixels(cropW, cropH, pw, ph) {
  const aspect = cropW / cropH;
  if (pw && ph) return { pw: pw, ph: ph };
  if (pw && !ph) return { pw: pw, ph: clampPx(pw / aspect) };
  if (ph && !pw) return { pw: clampPx(ph * aspect), ph: ph };
  if (aspect >= 1) return { pw: 768, ph: clampPx(768 / aspect) };
  return { pw: clampPx(768 * aspect), ph: 768 };
}

/**
 * Rasterize a preview PNG.
 * opts: { x, y, w, h, pw, ph, mode, watermark }
 * x,y,w,h are normalized viewBox fractions (see file header).
 */
function renderPreviewPng(svgText, opts) {
  opts = opts || {};
  let svg = stripPaperUnderlay(svgText);
  if (!/<svg\b/i.test(svg)) throw new Error("SVG has no root element");
  const root = parseRootViewBox(svg);
  const x = Number(opts.x) || 0;
  const y = Number(opts.y) || 0;
  const w = Number(opts.w) > 0 ? Number(opts.w) : 1;
  const h = Number(opts.h) > 0 ? Number(opts.h) : 1;
  const crop = {
    x: root.x + x * root.w,
    y: root.y + y * root.h,
    w: w * root.w,
    h: h * root.h,
  };
  if (!(crop.w > 0) || !(crop.h > 0)) throw new Error("Empty preview crop");
  const px = outputPixels(crop.w, crop.h, opts.pw, opts.ph);
  if (opts.mode === "outline") {
    // ~1 device pixel. rsvg ignores vector-effect, so this user-unit width is the one that renders.
    const stroke = crop.w / px.pw;
    svg = outlineShapes(svg, stroke);
  }
  svg = rewriteRoot(svg, crop, px.pw, px.ph);
  if (opts.watermark) svg = insertBeforeEnd(svg, watermarkMarkup(crop));
  const r = spawnSync("rsvg-convert", ["-w", String(px.pw), "-h", String(px.ph), "-f", "png", "-"], {
    input: Buffer.from(svg, "utf8"),
    timeout: 20000,
    maxBuffer: 24 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 || !r.stdout || r.stdout.length < 8) {
    const errText = r.stderr ? String(r.stderr).slice(0, 400) : ("status " + r.status);
    throw new Error("rsvg-convert failed: " + errText);
  }
  return r.stdout;
}

module.exports = {
  MAX_PX: MAX_PX,
  MIN_ZOOM: MIN_ZOOM,
  MAX_ZOOM: MAX_ZOOM,
  parsePreviewQuery: parsePreviewQuery,
  loadSvgText: loadSvgText,
  renderPreviewPng: renderPreviewPng,
  parseRootViewBox: parseRootViewBox,
};
