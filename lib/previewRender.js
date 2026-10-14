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
// rsvg-convert 2.60 honors vector-effect="non-scaling-stroke" and then reads
// stroke-width as device pixels. A width computed in user units (crop/output,
// about one device pixel) becomes a fraction of a pixel and the line vanishes.
// Outline therefore sets vector-effect:none and forces fill/stroke with an
// inline !important style so parent presentation attributes, group style=""
// and <style> class rules cannot paint the shape back in.
//
// The watermark is a second SVG in output-pixel space (1 user unit = 1 px,
// DejaVu Sans at a fixed size) composited onto the art. Putting the text in
// the art viewBox makes the glyphs track zoom and fall apart when the crop
// is a fraction of a unit.

const fs = require("fs");
const { spawnSync } = require("child_process");
const { decodePng, encodePng } = require("./png");

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

const SHAPE_TAG = "path|circle|ellipse|polygon|polyline|rect|line|use";
const OUTLINE_COLOR = "#ff00aa";
const WM_LABEL = "DECOCLUB PRO · PREVIEW";
const WM_FONT = 18;

function formatUserUnit(n) {
  if (!(n > 0) || !Number.isFinite(n)) return "0.01";
  let s = n.toFixed(6);
  if (s.indexOf(".") !== -1) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "0" ? "0.000001" : s;
}

function stripPaintDecls(style) {
  return String(style || "")
    .replace(/(?:^|;)\s*(?:fill|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|vector-effect|fill-opacity)\s*:[^;]*/gi, "")
    .replace(/^[\s;]+|[\s;]+$/g, "")
    .replace(/;;+/g, ";")
    .trim();
}

// Drop paint presentation attributes and inline paint declarations. Quoted
// values (path data) are copied through so a coordinate cannot look like an
// attribute.
function stripPaintAttrs(attrs) {
  let out = "";
  let keptStyle = "";
  let i = 0;
  while (i < attrs.length) {
    const c = attrs.charAt(i);
    if (c === '"' || c === "'") {
      const j = attrs.indexOf(c, i + 1);
      const end = j === -1 ? attrs.length : j + 1;
      out += attrs.slice(i, end);
      i = end;
      continue;
    }
    const rest = attrs.slice(i);
    const name = /^\s+(?:fill|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|vector-effect|fill-opacity)(?=\s*=)/i.exec(rest);
    if (name) {
      let k = name[0].length;
      const eq = /^\s*=\s*/.exec(rest.slice(k));
      if (!eq) { out += c; i++; continue; }
      k += eq[0].length;
      const q = rest.charAt(k);
      if (q === '"' || q === "'") {
        const j = rest.indexOf(q, k + 1);
        i += j === -1 ? rest.length : j + 1;
      } else {
        const v = /^[^\s"'=<>]*/.exec(rest.slice(k));
        i += k + (v ? v[0].length : 0);
      }
      continue;
    }
    const styleAttr = /^\s+style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(rest);
    if (styleAttr) {
      const kept = stripPaintDecls(styleAttr[2] != null ? styleAttr[2] : styleAttr[3]);
      if (kept) keptStyle = keptStyle ? keptStyle + ";" + kept : kept;
      i += styleAttr[0].length;
      continue;
    }
    out += c;
    i++;
  }
  return { attrs: out, style: keptStyle.replace(/"/g, "'") };
}

function outlineShapes(svg, strokeWidth) {
  const sw = formatUserUnit(strokeWidth);
  // Inline !important beats a <style> class rule and an inherited group style.
  // vector-effect:none keeps the width in user units (see file header).
  const paint = "fill:none !important;stroke:" + OUTLINE_COLOR + " !important;stroke-width:" + sw +
    " !important;stroke-opacity:1 !important;vector-effect:none !important;stroke-linejoin:round;stroke-linecap:round";
  const re = new RegExp("<(" + SHAPE_TAG + ")\\b([^>]*?)(\\/?)\\s*>", "gi");
  return svg.replace(re, function (_, tag, attrs, slash) {
    const stripped = stripPaintAttrs(attrs);
    const style = stripped.style ? stripped.style + ";" + paint : paint;
    return "<" + tag + stripped.attrs + ' style="' + style + '"' + (slash ? "/" : "") + ">";
  });
}

function watermarkSvg(pw, ph) {
  const fontSize = WM_FONT;
  const textW = 248;
  const stepX = 310;
  const stepY = 62;
  const angle = -28;
  const rad = angle * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = pw / 2;
  const cy = ph / 2;
  const span = Math.hypot(pw, ph) + textW;
  let texts = "";
  let row = 0;
  for (let y = cy - span; y <= cy + span; y += stepY, row++) {
    const shift = (row % 2) * (stepX * 0.5);
    for (let x = cx - span + shift; x <= cx + span; x += stepX) {
      const dx = x - cx;
      const dy = y - cy;
      const rx = cx + dx * cos - dy * sin;
      const ry = cy + dx * sin + dy * cos;
      const dx2 = (x + textW) - cx;
      const ex = cx + dx2 * cos - dy * sin;
      const ey = cy + dx2 * sin + dy * cos;
      const minX = Math.min(rx, ex);
      const maxX = Math.max(rx, ex);
      const minY = Math.min(ry, ey) - fontSize;
      const maxY = Math.max(ry, ey) + 4;
      if (maxX < -4 || minX > pw + 4 || maxY < -4 || minY > ph + 4) continue;
      texts += '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '">' + WM_LABEL + "</text>";
    }
  }
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + pw + '" height="' + ph + '" viewBox="0 0 ' + pw + " " + ph + '">' +
    '<g fill="#f2f2f2" fill-opacity="0.32" stroke="#1a1a1a" stroke-opacity="0.40" stroke-width="0.7" ' +
    'font-family="DejaVu Sans" font-weight="700" font-size="' + fontSize + '" ' +
    'transform="rotate(' + angle + " " + cx.toFixed(1) + " " + cy.toFixed(1) + ')">' +
    texts + "</g></svg>";
}

function rsvgPng(svg, pw, ph) {
  const r = spawnSync("rsvg-convert", ["-w", String(pw), "-h", String(ph), "-f", "png", "-"], {
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

function compositeOver(baseBuf, overBuf) {
  const base = decodePng(baseBuf);
  const over = decodePng(overBuf);
  if (base.width !== over.width || base.height !== over.height) throw new Error("Watermark size mismatch");
  const rgba = Buffer.from(base.rgba);
  const o = over.rgba;
  for (let i = 0; i < rgba.length; i += 4) {
    const oa = o[i + 3];
    if (!oa) continue;
    const ba = rgba[i + 3];
    const oaN = oa / 255;
    const baN = ba / 255;
    const outA = oaN + baN * (1 - oaN);
    if (outA <= 0) {
      rgba[i + 3] = 0;
      continue;
    }
    const inv = 1 / outA;
    const keep = baN * (1 - oaN);
    rgba[i] = Math.round((o[i] * oaN + rgba[i] * keep) * inv);
    rgba[i + 1] = Math.round((o[i + 1] * oaN + rgba[i + 1] * keep) * inv);
    rgba[i + 2] = Math.round((o[i + 2] * oaN + rgba[i + 2] * keep) * inv);
    rgba[i + 3] = Math.round(outA * 255);
  }
  return encodePng(base.width, base.height, rgba);
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
    // ~1 device px on the finer axis. Width is user units; vector-effect stays off.
    const stroke = Math.min(crop.w / px.pw, crop.h / px.ph);
    svg = outlineShapes(svg, stroke);
  }
  svg = rewriteRoot(svg, crop, px.pw, px.ph);
  const art = rsvgPng(svg, px.pw, px.ph);
  if (!opts.watermark) return art;
  return compositeOver(art, rsvgPng(watermarkSvg(px.pw, px.ph), px.pw, px.ph));
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
