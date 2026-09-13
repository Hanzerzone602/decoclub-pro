"use strict";

/**
 * SVG → digitize layers with real path `d` data.
 * DecoClub vai-trace currently stores empty paths[] on job.vector; this
 * parser is the general path for any dropped image's vector SVG.
 */

function attr(attrs, name) {
  const re = new RegExp("\\b" + name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i");
  const m = String(attrs || "").match(re);
  return m ? m[1] : null;
}

function normalizeHex(fill) {
  if (!fill) return null;
  let s = String(fill).trim().toLowerCase();
  if (s === "none" || s === "transparent") return null;
  if (s.indexOf("url(") !== -1) return null;
  if (s[0] !== "#") {
    const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!rgb) return s;
    const h = (n) => ("0" + Number(rgb[n]).toString(16)).slice(-2);
    s = "#" + h(1) + h(2) + h(3);
  }
  if (s.length === 4) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  if (s.length >= 7) s = s.slice(0, 7);
  return s;
}

function parseHexRgb(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return [17, 17, 17];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function isPaperHex(hex) {
  const rgb = parseHexRgb(hex);
  const max = Math.max(rgb[0], rgb[1], rgb[2]);
  const min = Math.min(rgb[0], rgb[1], rgb[2]);
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return lum > 242 && (max - min) < 22;
}

function isNearWhiteHex(hex) {
  const rgb = parseHexRgb(hex);
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return lum > 210;
}

function parseViewBox(svg) {
  const vb = String(svg).match(/viewBox\s*=\s*["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/i);
  if (vb) {
    return { x: Number(vb[1]), y: Number(vb[2]), w: Number(vb[3]), h: Number(vb[4]) };
  }
  const wM = String(svg).match(/\bwidth\s*=\s*["']([\d.]+)(in|px|mm)?["']/i);
  const hM = String(svg).match(/\bheight\s*=\s*["']([\d.]+)(in|px|mm)?["']/i);
  return {
    x: 0, y: 0,
    w: Number(wM && wM[1]) || 1,
    h: Number(hM && hM[1]) || 1,
  };
}

function svgIsInches(svg, vb) {
  if (vb && vb.w > 0 && vb.w <= 40 && vb.h > 0 && vb.h <= 40) return true;
  return false;
}

function svgHoopInches(svg, vb, widthIn, heightIn) {
  const wAttr = String(svg).match(/\bwidth\s*=\s*["']([\d.]+)(in|px|mm)?["']/i);
  const hAttr = String(svg).match(/\bheight\s*=\s*["']([\d.]+)(in|px|mm)?["']/i);
  const unit = ((wAttr && wAttr[2]) || "").toLowerCase();
  const attrW = wAttr ? Number(wAttr[1]) : 0;
  const attrH = hAttr ? Number(hAttr[1]) : 0;
  if (widthIn && heightIn) return { wIn: Number(widthIn), hIn: Number(heightIn) };
  if (unit === "in" && attrW > 0) return { wIn: attrW, hIn: attrH || attrW };
  if (unit === "mm" && attrW > 0) return { wIn: attrW / 25.4, hIn: (attrH || attrW) / 25.4 };
  if (vb && vb.w <= 40 && vb.h <= 40) return { wIn: vb.w, hIn: vb.h };
  return { wIn: 3, hIn: 3 * ((vb.h || 1) / (vb.w || 1)) };
}

function parseTranslate(tr) {
  const s = String(tr || "");
  const m = s.match(/translate\(\s*([-+\d.eE]+)(?:[ ,]+([-+\d.eE]+))?\s*\)/);
  if (!m) return { tx: 0, ty: 0 };
  return { tx: Number(m[1]) || 0, ty: Number(m[2]) || 0 };
}

function scalePath(d, sx, sy, ox, oy) {
  if (sx === 1 && sy === 1 && !ox && !oy) return d;
  const tokens = String(d || "").replace(/,/g, " ").match(/[MmLlHhVvCcQqTtSsAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const out = [];
  let i = 0;
  function isCmd(t) { return /^[A-Za-z]$/.test(t); }
  function num() { return Number(tokens[i++]); }
  let x = 0, y = 0;
  while (i < tokens.length) {
    if (!isCmd(tokens[i])) { i++; continue; }
    const raw = tokens[i++];
    const rel = raw === raw.toLowerCase();
    const op = raw.toUpperCase();
    out.push(raw);
    if (op === "Z") continue;
    const take = op === "H" || op === "V" ? 1 : op === "M" || op === "L" || op === "T" ? 2 : op === "S" || op === "Q" ? 4 : op === "C" ? 6 : op === "A" ? 7 : 0;
    while (i < tokens.length && !isCmd(tokens[i])) {
      if (op === "H") {
        let nx = num();
        if (rel) { nx += x; }
        x = nx;
        out.push(((x - ox) * sx).toFixed(4));
      } else if (op === "V") {
        let ny = num();
        if (rel) { ny += y; }
        y = ny;
        out.push(((y - oy) * sy).toFixed(4));
      } else if (op === "A") {
        const rx = num(), ry = num(), rot = num(), laf = num(), sf = num();
        let nx = num(), ny = num();
        if (rel) { nx += x; ny += y; }
        x = nx; y = ny;
        out.push((rx * sx).toFixed(4), (ry * sy).toFixed(4), rot, laf, sf, ((x - ox) * sx).toFixed(4), ((y - oy) * sy).toFixed(4));
      } else {
        const n = take || 2;
        const pts = [];
        for (let k = 0; k < n; k++) pts.push(num());
        if (n % 2 === 0) {
          for (let k = 0; k < n; k += 2) {
            let nx = pts[k], ny = pts[k + 1];
            if (rel) { nx += x; ny += y; }
            if (k === n - 2) { x = nx; y = ny; }
            out.push(((nx - ox) * sx).toFixed(4), ((ny - oy) * sy).toFixed(4));
          }
        } else {
          pts.forEach((p) => out.push(p));
        }
      }
    }
  }
  return out.join(" ");
}

function pathRoughArea(d) {
  return String(d || "").length;
}

function layersFromSvg(svgText, widthIn, heightIn) {
  const svg = String(svgText || "");
  const vb = parseViewBox(svg);
  const hoop = svgHoopInches(svg, vb, widthIn, heightIn);
  const wIn = hoop.wIn;
  const hIn = hoop.hIn;
  const sx = wIn / (vb.w || wIn);
  const sy = hIn / (vb.h || hIn);
  const ox = vb.x || 0, oy = vb.y || 0;

  const byFill = new Map();
  const stack = [{ fill: null, rule: "nonzero", tx: 0, ty: 0 }];
  const tagRe = /<(\/?)([a-zA-Z][\w:-]*)([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(svg))) {
    const close = !!m[1];
    const name = m[2].toLowerCase();
    const attrs = m[3] || "";
    const selfClose = /\/\s*$/.test(attrs);
    if (name === "g") {
      if (close) {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const parent = stack[stack.length - 1];
      const fill = normalizeHex(attr(attrs, "fill")) || parent.fill;
      const rule = attr(attrs, "fill-rule") || parent.rule;
      const dataName = (attr(attrs, "data-name") || "").toLowerCase();
      const tr = parseTranslate(attr(attrs, "transform"));
      stack.push({
        fill: fill, rule: rule,
        paper: dataName.indexOf("paper") !== -1,
        tx: (parent.tx || 0) + tr.tx,
        ty: (parent.ty || 0) + tr.ty,
      });
      if (!selfClose) continue;
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (close) continue;
    const parent = stack[stack.length - 1];
    if (parent && parent.paper) continue;
    if (name === "rect") {
      const dataName = (attr(attrs, "data-name") || "").toLowerCase();
      if (dataName.indexOf("paper") !== -1) continue;
      continue;
    }
    if (name !== "path") continue;
    const d0 = attr(attrs, "d");
    if (!d0) continue;
    const fill = normalizeHex(attr(attrs, "fill")) || (parent && parent.fill);
    if (!fill) continue;
    const tr = parseTranslate(attr(attrs, "transform"));
    const tx = ((parent && parent.tx) || 0) + tr.tx;
    const ty = ((parent && parent.ty) || 0) + tr.ty;
    const d = scalePath(d0, sx, sy, ox - tx, oy - ty);
    const rule = (attr(attrs, "fill-rule") || (parent && parent.rule) || "evenodd").toLowerCase();
    if (!byFill.has(fill)) byFill.set(fill, []);
    byFill.get(fill).push({ d: d, hole: false, fillRule: rule });
  }

  const layers = [];
  byFill.forEach((paths, hex) => {
    if (!paths.length) return;
    layers.push({
      hex: hex,
      nameGuess: "Layer " + (layers.length + 1),
      paths: paths,
    });
  });
  layers.forEach((L, i) => { L.nameGuess = "Layer " + (i + 1); });
  return {
    widthIn: wIn,
    heightIn: hIn,
    layers: layers,
    source: "svg",
  };
}

function hasRealPaths(vector) {
  const layers = (vector && vector.layers) || [];
  for (let i = 0; i < layers.length; i++) {
    const ps = layers[i].paths || [];
    for (let j = 0; j < ps.length; j++) {
      if (ps[j] && ps[j].d && String(ps[j].d).length > 8) return true;
    }
  }
  return false;
}

module.exports = {
  layersFromSvg,
  hasRealPaths,
  normalizeHex,
  isPaperHex,
  isNearWhiteHex,
  parseHexRgb,
  parseViewBox,
  scalePath,
};
