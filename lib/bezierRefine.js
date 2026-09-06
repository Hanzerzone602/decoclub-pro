"use strict";
/**
 * DiffVG-style hybrid refine for cubic stacked fills (pure JS).
 *
 * Tradeoffs vs full DiffVG / LIVE:
 *  - No autodiff/GPU; residual-driven local CP nudges + robust color LS
 *  - CPU scanline raster of densified cubics (approx); final proofs via cairosvg
 *  - Multi-scale half-res geometry + full-res color for production budget
 * Topology: stacked fills, light outward inflate, no invented hairline gaps.
 */

const { annotateLayer, annotateLayers } = require("./colorspec");

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function fmt(n) {
  const x = Math.round(Number(n) * 10000) / 10000;
  if (Object.is(x, -0)) return "0";
  return String(x);
}
function hexToRgb(hex) {
  const h = String(hex || "#000000").replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}
function toHex(r, g, b) {
  function h(n) { return ("0" + clamp(Math.round(n), 0, 255).toString(16)).slice(-2); }
  return "#" + h(r) + h(g) + h(b);
}
function lum(rgb) { return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]; }
function rgbDist(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function parsePathD(d) {
  const tokens = String(d || "").match(/[MmCcLlZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const subpaths = [];
  let i = 0;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let cur = null;
  function num() { return parseFloat(tokens[i++]); }
  function ensure() {
    if (!cur) { cur = { segs: [] }; subpaths.push(cur); }
  }
  while (i < tokens.length) {
    const t = tokens[i++];
    if (t === "M" || t === "m") {
      const rel = t === "m";
      let x = num(), y = num();
      if (rel) { x += cx; y += cy; }
      cx = x; cy = y; sx = x; sy = y;
      cur = { segs: [] };
      subpaths.push(cur);
      while (i < tokens.length && !/^[MmCcLlZz]$/.test(tokens[i])) {
        let x2 = num(), y2 = num();
        if (rel) { x2 += cx; y2 += cy; }
        cur.segs.push({ p0: { x: cx, y: cy }, p1: { x: cx, y: cy }, p2: { x: x2, y: y2 }, p3: { x: x2, y: y2 }, linear: true });
        cx = x2; cy = y2;
      }
    } else if (t === "C" || t === "c") {
      ensure();
      const rel = t === "c";
      while (i < tokens.length && !/^[MmCcLlZz]$/.test(tokens[i])) {
        let x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
        if (rel) { x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy; }
        cur.segs.push({
          p0: { x: cx, y: cy }, p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 }, p3: { x: x, y: y }, linear: false,
        });
        cx = x; cy = y;
      }
    } else if (t === "L" || t === "l") {
      ensure();
      const rel = t === "l";
      while (i < tokens.length && !/^[MmCcLlZz]$/.test(tokens[i])) {
        let x = num(), y = num();
        if (rel) { x += cx; y += cy; }
        cur.segs.push({ p0: { x: cx, y: cy }, p1: { x: cx, y: cy }, p2: { x: x, y: y }, p3: { x: x, y: y }, linear: true });
        cx = x; cy = y;
      }
    } else if (t === "Z" || t === "z") {
      ensure();
      if (Math.hypot(cx - sx, cy - sy) > 1e-6) {
        cur.segs.push({ p0: { x: cx, y: cy }, p1: { x: cx, y: cy }, p2: { x: sx, y: sy }, p3: { x: sx, y: sy }, linear: true });
      }
      cx = sx; cy = sy;
      cur = null;
    }
  }
  return subpaths;
}

function segsToPathD(segs) {
  if (!segs || !segs.length) return "";
  let d = "M " + fmt(segs[0].p0.x) + " " + fmt(segs[0].p0.y);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    d += " C " + fmt(s.p1.x) + " " + fmt(s.p1.y) + " " + fmt(s.p2.x) + " " + fmt(s.p2.y) + " " + fmt(s.p3.x) + " " + fmt(s.p3.y);
  }
  d += " Z";
  return d;
}

function densifySeg(seg, spacing) {
  spacing = Math.max(0.35, spacing || 0.85);
  const approx = Math.hypot(seg.p3.x - seg.p0.x, seg.p3.y - seg.p0.y) +
    0.5 * Math.hypot(seg.p1.x - seg.p0.x, seg.p1.y - seg.p0.y) +
    0.5 * Math.hypot(seg.p2.x - seg.p3.x, seg.p2.y - seg.p3.y);
  const n = Math.max(2, Math.ceil(approx / spacing));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, i / n));
  return pts;
}

function densifySubpath(sub, spacing) {
  const pts = [];
  for (let i = 0; i < sub.segs.length; i++) {
    const dens = densifySeg(sub.segs[i], spacing);
    for (let j = i === 0 ? 0 : 1; j < dens.length; j++) pts.push(dens[j]);
  }
  return pts;
}

function fillPolygons(mask, w, h, polygons) {
  for (let pi = 0; pi < polygons.length; pi++) {
    const pts = polygons[pi];
    if (!pts || pts.length < 3) continue;
    let minY = h, maxY = -1;
    for (let i = 0; i < pts.length; i++) {
      const y = pts[i].y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const y0 = Math.max(0, Math.floor(minY));
    const y1 = Math.min(h - 1, Math.ceil(maxY));
    for (let y = y0; y <= y1; y++) {
      const ys = y + 0.5;
      const xs = [];
      for (let i = 0, n = pts.length; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if ((a.y > ys) === (b.y > ys)) continue;
        const t = (ys - a.y) / ((b.y - a.y) || 1e-12);
        xs.push(a.x + t * (b.x - a.x));
      }
      xs.sort(function (u, v) { return u - v; });
      for (let k = 0; k + 1 < xs.length; k += 2) {
        let xL = Math.ceil(xs[k] - 1e-6);
        let xR = Math.floor(xs[k + 1] + 1e-6);
        if (xL < 0) xL = 0;
        if (xR >= w) xR = w - 1;
        const row = y * w;
        for (let x = xL; x <= xR; x++) mask[row + x] ^= 1;
      }
    }
  }
}

function scaleSegs(segs, s) {
  return segs.map(function (seg) {
    return {
      p0: { x: seg.p0.x * s, y: seg.p0.y * s },
      p1: { x: seg.p1.x * s, y: seg.p1.y * s },
      p2: { x: seg.p2.x * s, y: seg.p2.y * s },
      p3: { x: seg.p3.x * s, y: seg.p3.y * s },
      linear: !!seg.linear,
    };
  });
}

function layersToModel(layers, widthIn, heightIn, pixelW, pixelH) {
  const sx = pixelW / (Number(widthIn) || 1);
  const sy = pixelH / (Number(heightIn) || 1);
  const s = (sx + sy) * 0.5;
  const model = [];
  for (let li = 0; li < layers.length; li++) {
    const L = layers[li];
    const rgb = hexToRgb(L.hex);
    const paths = [];
    for (let pi = 0; pi < (L.paths || []).length; pi++) {
      const subs = parsePathD(L.paths[pi].d);
      for (let si = 0; si < subs.length; si++) {
        if (!subs[si].segs.length) continue;
        paths.push({ segs: scaleSegs(subs[si].segs, s), hole: !!L.paths[pi].hole });
      }
    }
    model.push({ rgb: rgb.slice(), hex: L.hex, paths: paths, nameGuess: L.nameGuess });
  }
  return { model: model, scale: s, widthIn: widthIn, heightIn: heightIn, w: pixelW, h: pixelH };
}

function modelToLayers(modelState) {
  const inv = 1 / (modelState.scale || 1);
  const layers = [];
  for (let li = 0; li < modelState.model.length; li++) {
    const M = modelState.model[li];
    const paths = [];
    for (let pi = 0; pi < M.paths.length; pi++) {
      const d = segsToPathD(scaleSegs(M.paths[pi].segs, inv));
      if (d) paths.push({ d: d, hole: !!M.paths[pi].hole });
    }
    if (!paths.length) continue;
    layers.push(Object.assign(annotateLayer({ hex: toHex(M.rgb[0], M.rgb[1], M.rgb[2]) }), {
      paths: paths, nameGuess: M.nameGuess,
    }));
  }
  return annotateLayers(layers);
}

function rasterizeModel(modelState, spacing) {
  const w = modelState.w, h = modelState.h;
  const rgb = Buffer.alloc(w * h * 3);
  const top = new Int16Array(w * h);
  top.fill(-1);
  for (let li = 0; li < modelState.model.length; li++) {
    const M = modelState.model[li];
    const mask = new Uint8Array(w * h);
    const polys = [];
    for (let pi = 0; pi < M.paths.length; pi++) {
      const dens = densifySubpath(M.paths[pi], spacing || 0.9);
      if (dens.length >= 3) polys.push(dens);
    }
    fillPolygons(mask, w, h, polys);
    const r = M.rgb[0], g = M.rgb[1], b = M.rgb[2];
    for (let i = 0; i < w * h; i++) {
      if (!mask[i]) continue;
      const o = i * 3;
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
      top[i] = li;
    }
  }
  return { rgb: rgb, top: top };
}

function maeVsSource(srcRgba, rastRgb, top, w, h, bg) {
  let sum = 0, gap = 0, n = w * h;
  for (let i = 0; i < n; i++) {
    const so = i * 4, ro = i * 3;
    let sr = srcRgba[so], sg = srcRgba[so + 1], sb = srcRgba[so + 2], sa = srcRgba[so + 3];
    if (sa < 12) { sr = bg[0]; sg = bg[1]; sb = bg[2]; }
    let rr, rg, rb;
    if (top[i] < 0) { rr = bg[0]; rg = bg[1]; rb = bg[2]; }
    else { rr = rastRgb[ro]; rg = rastRgb[ro + 1]; rb = rastRgb[ro + 2]; }
    sum += (Math.abs(sr - rr) + Math.abs(sg - rg) + Math.abs(sb - rb)) / 3;
    const srcNotBg = Math.abs(sr - bg[0]) + Math.abs(sg - bg[1]) + Math.abs(sb - bg[2]) > 40;
    if (srcNotBg && top[i] < 0) gap++;
  }
  return { mae: sum / n, gapPct: (100 * gap) / n };
}

function erodeMask(src, w, h, rad) {
  if (!(rad > 0)) return src;
  const out = new Uint8Array(w * h);
  for (let y = rad; y < h - rad; y++) {
    for (let x = rad; x < w - rad; x++) {
      const i = y * w + x;
      if (!src[i]) continue;
      let ok = 1;
      for (let dy = -rad; dy <= rad && ok; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (!src[(y + dy) * w + (x + dx)]) { ok = 0; break; }
        }
      }
      if (ok) out[i] = 1;
    }
  }
  return out;
}

/**
 * Robust color refine: eroded exclusive mask + reject bg/outlier pixels.
 * Blend conservatively so we never pull a fill toward paper.
 */
function refineColors(modelState, srcRgba, top, bg) {
  const w = modelState.w, h = modelState.h;
  for (let li = 0; li < modelState.model.length; li++) {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (top[i] === li) mask[i] = 1;
    const core = erodeMask(mask, w, h, 2);
    const M = modelState.model[li];
    const cur = M.rgb;
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let i = 0; i < w * h; i++) {
      if (!core[i]) continue;
      const o = i * 4;
      if (srcRgba[o + 3] < 12) continue;
      const s = [srcRgba[o], srcRgba[o + 1], srcRgba[o + 2]];
      // reject paper / far outliers
      if (rgbDist(s, bg) < 36) continue;
      if (rgbDist(s, cur) > 90) continue;
      sr += s[0]; sg += s[1]; sb += s[2]; n++;
    }
    if (n < 24) continue;
    const mean = [sr / n, sg / n, sb / n];
    // Keep darks dark — never lighten black silhouettes toward brown/gray
    if (lum(cur) < 40 && lum(mean) > lum(cur) + 8) {
      mean[0] = Math.min(mean[0], cur[0]);
      mean[1] = Math.min(mean[1], cur[1]);
      mean[2] = Math.min(mean[2], cur[2]);
    }
    const t = 0.55;
    M.rgb[0] = cur[0] * (1 - t) + mean[0] * t;
    M.rgb[1] = cur[1] * (1 - t) + mean[1] * t;
    M.rgb[2] = cur[2] * (1 - t) + mean[2] * t;
    M.hex = toHex(M.rgb[0], M.rgb[1], M.rgb[2]);
  }
}

function ringArea(anchors) {
  let a = 0;
  const n = anchors.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += anchors[i].x * anchors[j].y - anchors[j].x * anchors[i].y;
  }
  return a * 0.5;
}

function fairAndSharpen(segs, opts) {
  opts = opts || {};
  const n = segs.length;
  if (n < 3) return segs;
  const sharpCos = opts.sharpCos == null ? -0.25 : opts.sharpCos;
  const fair = opts.fair == null ? 0.12 : opts.fair;
  const corner = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const prev = segs[(i - 1 + n) % n];
    const cur = segs[i];
    const inDir = { x: cur.p0.x - prev.p2.x, y: cur.p0.y - prev.p2.y };
    const outDir = { x: cur.p1.x - cur.p0.x, y: cur.p1.y - cur.p0.y };
    const L1 = Math.hypot(inDir.x, inDir.y) || 1;
    const L2 = Math.hypot(outDir.x, outDir.y) || 1;
    if ((inDir.x * outDir.x + inDir.y * outDir.y) / (L1 * L2) < sharpCos) corner[i] = 1;
  }
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    if (s.linear) continue;
    if (corner[i]) {
      s.p1.x = s.p0.x + (s.p1.x - s.p0.x) * 0.5;
      s.p1.y = s.p0.y + (s.p1.y - s.p0.y) * 0.5;
    } else if (fair > 0) {
      const chord = { x: s.p3.x - s.p0.x, y: s.p3.y - s.p0.y };
      const t1 = { x: s.p0.x + chord.x / 3, y: s.p0.y + chord.y / 3 };
      s.p1.x += (t1.x - s.p1.x) * fair;
      s.p1.y += (t1.y - s.p1.y) * fair;
    }
    if (corner[(i + 1) % n]) {
      s.p2.x = s.p3.x + (s.p2.x - s.p3.x) * 0.5;
      s.p2.y = s.p3.y + (s.p2.y - s.p3.y) * 0.5;
    } else if (fair > 0) {
      const chord = { x: s.p3.x - s.p0.x, y: s.p3.y - s.p0.y };
      const t2 = { x: s.p0.x + 2 * chord.x / 3, y: s.p0.y + 2 * chord.y / 3 };
      s.p2.x += (t2.x - s.p2.x) * fair;
      s.p2.y += (t2.y - s.p2.y) * fair;
    }
  }
  return segs;
}

function inflateSegs(segs, px) {
  if (!px || segs.length < 3) return segs;
  const n = segs.length;
  const anchors = segs.map(function (s) { return { x: s.p0.x, y: s.p0.y }; });
  const area0 = ringArea(anchors);
  const outA = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = anchors[(i - 1 + n) % n];
    const cur = anchors[i];
    const next = anchors[(i + 1) % n];
    let ex = -(next.y - prev.y), ey = next.x - prev.x;
    const L = Math.hypot(ex, ey) || 1;
    // Positive area (CCW): left normal is INWARD; flip for outward expand.
    const sign = area0 >= 0 ? -1 : 1;
    outA[i] = { dx: sign * (ex / L) * px, dy: sign * (ey / L) * px };
  }
  for (let i = 0; i < n; i++) {
    const s = segs[i];
    const d0 = outA[i], d3 = outA[(i + 1) % n];
    s.p0.x += d0.dx; s.p0.y += d0.dy;
    s.p3.x += d3.dx; s.p3.y += d3.dy;
    s.p1.x += d0.dx; s.p1.y += d0.dy;
    s.p2.x += d3.dx; s.p2.y += d3.dy;
  }
  for (let i = 0; i < n; i++) {
    const cur = segs[i], next = segs[(i + 1) % n];
    next.p0.x = cur.p3.x; next.p0.y = cur.p3.y;
  }
  return segs;
}

/**
 * Gap-aware residual nudge: expand into source-not-bg holes near this layer;
 * shrink where this layer covers a clearly better-matching neighbor/source.
 */
function nudgeGeometry(modelState, srcRgba, rast, bg, opts) {
  opts = opts || {};
  const step = opts.step == null ? 0.35 : opts.step;
  const maxShift = opts.maxShift == null ? 1.25 : opts.maxShift;
  const w = modelState.w, h = modelState.h;
  const top = rast.top;

  for (let li = 0; li < modelState.model.length; li++) {
    const M = modelState.model[li];
    const isDark = lum(M.rgb) < 55;
    for (let pi = 0; pi < M.paths.length; pi++) {
      const path = M.paths[pi];
      if (path.hole) continue;
      const segs = path.segs;
      const n = segs.length;
      if (n < 3) continue;
      const anchors = segs.map(function (s) { return { x: s.p0.x, y: s.p0.y }; });
      const area = ringArea(anchors);
      const orient = area >= 0 ? -1 : 1;

      const ax = new Float64Array(n);
      const ay = new Float64Array(n);
      const aw = new Float64Array(n);

      for (let si = 0; si < n; si++) {
        const seg = segs[si];
        const samples = 5;
        for (let k = 0; k <= samples; k++) {
          const t = k / samples;
          const p = cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, t);
          const a = cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, Math.max(0, t - 0.03));
          const b = cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, Math.min(1, t + 0.03));
          let tx = b.x - a.x, ty = b.y - a.y;
          const tL = Math.hypot(tx, ty) || 1;
          tx /= tL; ty /= tL;
          // outward normal
          let nx = -ty * orient, ny = tx * orient;

          function srcAt(x, y) {
            const xx = clamp(Math.round(x), 0, w - 1);
            const yy = clamp(Math.round(y), 0, h - 1);
            const i = yy * w + xx;
            const o = i * 4;
            let sr = srcRgba[o], sg = srcRgba[o + 1], sb = srcRgba[o + 2];
            if (srcRgba[o + 3] < 12) { sr = bg[0]; sg = bg[1]; sb = bg[2]; }
            return { rgb: [sr, sg, sb], top: top[i], i: i };
          }

          let force = 0;
          const out = srcAt(p.x + nx * 1.2, p.y + ny * 1.2);
          const inn = srcAt(p.x - nx * 1.2, p.y - ny * 1.2);
          const outDistLay = rgbDist(out.rgb, M.rgb);
          const outDistBg = rgbDist(out.rgb, bg);
          const inDistLay = rgbDist(inn.rgb, M.rgb);

          // Expand into gaps that match this layer
          if (out.top < 0 && outDistBg > 45 && outDistLay < 70) {
            force += isDark ? 1.0 : 0.55;
          } else if (out.top >= 0 && out.top !== li && outDistLay + 18 < rgbDist(out.rgb, modelState.model[out.top].rgb)) {
            force += 0.25;
          }
          // Shrink if interior source is far from this layer (misassigned bulge)
          if (inn.top === li && inDistLay > 70 && rgbDist(inn.rgb, bg) > 40) {
            force -= 0.4;
          }

          if (Math.abs(force) < 0.08) continue;
          const w0 = 1 - t, w1 = t;
          ax[si] += nx * force * w0; ay[si] += ny * force * w0; aw[si] += Math.abs(w0);
          const sj = (si + 1) % n;
          ax[sj] += nx * force * w1; ay[sj] += ny * force * w1; aw[sj] += Math.abs(w1);
        }
      }

      for (let i = 0; i < n; i++) {
        if (aw[i] < 0.15) continue;
        let dx = (ax[i] / aw[i]) * step;
        let dy = (ay[i] / aw[i]) * step;
        const mag = Math.hypot(dx, dy);
        if (mag > maxShift) { dx *= maxShift / mag; dy *= maxShift / mag; }
        const seg = segs[i];
        const prev = segs[(i - 1 + n) % n];
        seg.p0.x += dx; seg.p0.y += dy;
        prev.p3.x += dx; prev.p3.y += dy;
        seg.p1.x += dx; seg.p1.y += dy;
        prev.p2.x += dx; prev.p2.y += dy;
      }
      fairAndSharpen(segs, { sharpCos: -0.28, fair: 0.1 });
    }
  }
}

function scaleModelInPlace(modelState, factor) {
  modelState.w = Math.max(1, Math.round(modelState.w * factor));
  modelState.h = Math.max(1, Math.round(modelState.h * factor));
  modelState.scale *= factor;
  for (let li = 0; li < modelState.model.length; li++) {
    for (let pi = 0; pi < modelState.model[li].paths.length; pi++) {
      modelState.model[li].paths[pi].segs = scaleSegs(modelState.model[li].paths[pi].segs, factor);
    }
  }
}

function downscaleRgba(rgba, w, h, nw, nh) {
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(h - 1, Math.floor(y * h / nh));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor(x * w / nw));
      const si = (sy * w + sx) * 4, di = (y * nw + x) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  return out;
}

function scoreState(state, srcRgba, bg, spacing) {
  const rast = rasterizeModel(state, spacing || 0.9);
  return { rast: rast, score: maeVsSource(srcRgba, rast.rgb, rast.top, state.w, state.h, bg) };
}


/**
 * Promote each non-tiny path to its own layer colored by eroded coverage mean.
 * Mimics Vectorizer.AI / VTracer many-near-duplicate fills for MAE.
 */
function splitPathsByColor(modelState, srcRgba, bg) {
  const w = modelState.w, h = modelState.h;
  const rast = rasterizeModel(modelState, 0.95);
  // Build per-path masks by painting paths individually is expensive; instead
  // sample source along densified path interior via evenodd of single path.
  const newModel = [];
  for (let li = 0; li < modelState.model.length; li++) {
    const M = modelState.model[li];
    for (let pi = 0; pi < M.paths.length; pi++) {
      const path = M.paths[pi];
      const mask = new Uint8Array(w * h);
      const dens = densifySubpath(path, 0.95);
      if (dens.length < 3) continue;
      fillPolygons(mask, w, h, [dens]);
      const core = erodeMask(mask, w, h, path.hole ? 0 : 1);
      let sr = 0, sg = 0, sb = 0, n = 0;
      let area = 0;
      for (let i = 0; i < w * h; i++) {
        if (!mask[i]) continue;
        area++;
        if (!core[i] && !path.hole) continue;
        const o = i * 4;
        if (srcRgba[o + 3] < 12) continue;
        const s = [srcRgba[o], srcRgba[o + 1], srcRgba[o + 2]];
        if (rgbDist(s, bg) < 28) continue;
        sr += s[0]; sg += s[1]; sb += s[2]; n++;
      }
      if (area < 12) continue;
      let rgb = M.rgb.slice();
      if (n >= 12) {
        const mean = [sr / n, sg / n, sb / n];
        // Conservative blend; keep darks from lightening too much
        const t = lum(M.rgb) < 45 ? 0.35 : 0.7;
        rgb[0] = M.rgb[0] * (1 - t) + mean[0] * t;
        rgb[1] = M.rgb[1] * (1 - t) + mean[1] * t;
        rgb[2] = M.rgb[2] * (1 - t) + mean[2] * t;
        if (lum(M.rgb) < 40 && lum(rgb) > lum(M.rgb) + 12) {
          rgb = [Math.min(rgb[0], M.rgb[0] + 6), Math.min(rgb[1], M.rgb[1] + 6), Math.min(rgb[2], M.rgb[2] + 6)];
        }
      }
      newModel.push({
        rgb: rgb,
        hex: toHex(rgb[0], rgb[1], rgb[2]),
        paths: [{ segs: path.segs, hole: !!path.hole }],
        nameGuess: M.nameGuess,
        area: area,
      });
    }
  }
  // Paint large areas first (bottom)
  newModel.sort(function (a, b) { return (b.area || 0) - (a.area || 0); });
  newModel.forEach(function (m) { delete m.area; });
  modelState.model = newModel.length ? newModel : modelState.model;
  return modelState;
}


/** Build per-layer target masks from source nearest-color (exclude bg). */
function buildTargetMasks(modelState, srcRgba, bg) {
  const w = modelState.w, h = modelState.h;
  const masks = modelState.model.map(function () { return new Uint8Array(w * h); });
  const labs = modelState.model.map(function (M) { return M.rgb; });
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (srcRgba[o + 3] < 12) continue;
    const s = [srcRgba[o], srcRgba[o + 1], srcRgba[o + 2]];
    if (rgbDist(s, bg) < 40) continue;
    let bi = 0, bd = Infinity;
    for (let c = 0; c < labs.length; c++) {
      const d = rgbDist(s, labs[c]);
      if (d < bd) { bd = d; bi = c; }
    }
    if (bd < 95) masks[bi][i] = 1;
  }
  return masks;
}

/**
 * Snap path geometry toward target mask boundary along normals (DiffVG-lite / LIVE style).
 * Moves anchors so edge samples land on mask transitions.
 */
function snapToMask(modelState, masks, opts) {
  opts = opts || {};
  const step = opts.step == null ? 0.55 : opts.step;
  const maxShift = opts.maxShift == null ? 2.0 : opts.maxShift;
  const w = modelState.w, h = modelState.h;
  for (let li = 0; li < modelState.model.length; li++) {
    const M = modelState.model[li];
    const mask = masks[li];
    if (!mask) continue;
    for (let pi = 0; pi < M.paths.length; pi++) {
      const path = M.paths[pi];
      if (path.hole) continue;
      const segs = path.segs;
      const n = segs.length;
      if (n < 3) continue;
      const anchors = segs.map(function (s) { return { x: s.p0.x, y: s.p0.y }; });
      const area = ringArea(anchors);
      const orient = area >= 0 ? -1 : 1; // outward
      const ax = new Float64Array(n);
      const ay = new Float64Array(n);
      const aw = new Float64Array(n);

      for (let si = 0; si < n; si++) {
        const seg = segs[si];
        for (let k = 0; k <= 5; k++) {
          const t = k / 5;
          const p = cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, t);
          const a = cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, Math.max(0, t - 0.04));
          const b = cubicPoint(seg.p0, seg.p1, seg.p2, seg.p3, Math.min(1, t + 0.04));
          let tx = b.x - a.x, ty = b.y - a.y;
          const tL = Math.hypot(tx, ty) || 1;
          tx /= tL; ty /= tL;
          const nx = -ty * orient, ny = tx * orient;

          // Search along normal for mask boundary (inside=1 outside=0)
          function at(x, y) {
            const xx = clamp(Math.round(x), 0, w - 1);
            const yy = clamp(Math.round(y), 0, h - 1);
            return mask[yy * w + xx];
          }
          const inside0 = at(p.x - nx * 0.5, p.y - ny * 0.5);
          let best = 0;
          // If outside, move inward to find mask; if deep inside, move outward to boundary
          if (!inside0) {
            for (let d = 0.5; d <= 4.0; d += 0.5) {
              if (at(p.x - nx * d, p.y - ny * d)) { best = -d; break; }
            }
          } else {
            for (let d = 0.5; d <= 4.0; d += 0.5) {
              if (!at(p.x + nx * d, p.y + ny * d)) { best = d - 0.25; break; }
            }
          }
          if (Math.abs(best) < 0.2) continue;
          const w0 = 1 - t, w1 = t;
          ax[si] += nx * best * w0; ay[si] += ny * best * w0; aw[si] += w0;
          const sj = (si + 1) % n;
          ax[sj] += nx * best * w1; ay[sj] += ny * best * w1; aw[sj] += w1;
        }
      }
      for (let i = 0; i < n; i++) {
        if (aw[i] < 0.15) continue;
        let dx = (ax[i] / aw[i]) * step;
        let dy = (ay[i] / aw[i]) * step;
        const mag = Math.hypot(dx, dy);
        if (mag > maxShift) { dx *= maxShift / mag; dy *= maxShift / mag; }
        const seg = segs[i];
        const prev = segs[(i - 1 + n) % n];
        seg.p0.x += dx; seg.p0.y += dy;
        prev.p3.x += dx; prev.p3.y += dy;
        seg.p1.x += dx; seg.p1.y += dy;
        prev.p2.x += dx; prev.p2.y += dy;
      }
      fairAndSharpen(segs, { sharpCos: -0.3, fair: 0.08 });
    }
  }
}




/**
 * Steal repair: dark dilate painted over lighter source — inflate the preferred
 * non-dark layer and lightly deflate dark. Keep only MAE-improving passes.
 */
function stealRepair(modelState, srcRgba, bg, opts) {
  opts = opts || {};
  const maxPasses = opts.passes == null ? 6 : opts.passes;
  const px = opts.px == null ? 0.7 : opts.px;
  const w = modelState.w, h = modelState.h;
  const widthIn = modelState.widthIn, heightIn = modelState.heightIn;
  let bestLayers = modelToLayers(modelState);
  let best;
  {
    const rast = rasterizeModel(modelState, 0.9);
    best = maeVsSource(srcRgba, rast.rgb, rast.top, w, h, bg);
  }

  for (let pass = 0; pass < maxPasses; pass++) {
    const rast = rasterizeModel(modelState, 0.95);
    const need = new Float64Array(modelState.model.length);
    const darkBad = new Float64Array(modelState.model.length);
    let nSteal = 0;
    for (let i = 0; i < w * h; i++) {
      const top = rast.top[i];
      if (top < 0) continue;
      const Mtop = modelState.model[top];
      if (lum(Mtop.rgb) >= 60) continue;
      const o = i * 4;
      if (srcRgba[o + 3] < 12) continue;
      const s = [srcRgba[o], srcRgba[o + 1], srcRgba[o + 2]];
      if (rgbDist(s, bg) < 40) continue;
      if (lum(s) < 70) continue;
      let bi = -1, bd = Infinity;
      for (let li = 0; li < modelState.model.length; li++) {
        const d = rgbDist(s, modelState.model[li].rgb);
        if (d < bd) { bd = d; bi = li; }
      }
      if (bi < 0 || bi === top) continue;
      if (lum(modelState.model[bi].rgb) < 55) continue;
      if (bd + 18 >= rgbDist(s, Mtop.rgb)) continue;
      need[bi] += 1;
      darkBad[top] += 1;
      nSteal++;
    }
    if (nSteal < 80) break;

    for (let li = 0; li < modelState.model.length; li++) {
      if (need[li] < 40) continue;
      const amount = px * (0.55 + Math.min(1.2, need[li] / 2500)) * (1 - pass * 0.08);
      const M = modelState.model[li];
      for (let pi = 0; pi < M.paths.length; pi++) {
        if (M.paths[pi].hole) continue;
        inflateSegs(M.paths[pi].segs, amount);
      }
    }
    for (let li = 0; li < modelState.model.length; li++) {
      if (darkBad[li] < 80) continue;
      if (lum(modelState.model[li].rgb) >= 60) continue;
      const amount = -px * 0.28 * (1 - pass * 0.1);
      const M = modelState.model[li];
      for (let pi = 0; pi < M.paths.length; pi++) {
        if (M.paths[pi].hole) continue;
        inflateSegs(M.paths[pi].segs, amount);
      }
    }

    const rast2 = rasterizeModel(modelState, 0.9);
    const sc = maeVsSource(srcRgba, rast2.rgb, rast2.top, w, h, bg);
    if (sc.mae < best.mae - 0.005) {
      best = sc;
      bestLayers = modelToLayers(modelState);
    } else {
      const reverted = layersToModel(bestLayers, widthIn, heightIn, w, h);
      modelState.model = reverted.model;
      break;
    }
  }
  return best;
}


/**
 * Gap-close: iteratively inflate dark (and optionally all) paths where source
 * is not-bg but raster is bg. Cheap DiffVG-lite coverage pass.
 */
function gapCloseInflate(modelState, srcRgba, bg, opts) {
  opts = opts || {};
  const maxPasses = opts.passes == null ? 4 : opts.passes;
  const px = opts.px == null ? 0.55 : opts.px;
  const w = modelState.w, h = modelState.h;
  let last = null;
  for (let pass = 0; pass < maxPasses; pass++) {
    const rast = rasterizeModel(modelState, 0.95);
    last = maeVsSource(srcRgba, rast.rgb, rast.top, w, h, bg);
    // Count gaps near each layer
    const gapNeed = new Float64Array(modelState.model.length);
    for (let i = 0; i < w * h; i++) {
      if (rast.top[i] >= 0) continue;
      const o = i * 4;
      if (srcRgba[o + 3] < 12) continue;
      const s = [srcRgba[o], srcRgba[o + 1], srcRgba[o + 2]];
      if (rgbDist(s, bg) < 45) continue;
      // nearest layer color
      let bi = 0, bd = Infinity;
      for (let li = 0; li < modelState.model.length; li++) {
        const d = rgbDist(s, modelState.model[li].rgb);
        if (d < bd) { bd = d; bi = li; }
      }
      if (bd < 85) gapNeed[bi] += 1;
    }
    let any = false;
    for (let li = 0; li < modelState.model.length; li++) {
      if (gapNeed[li] < 30) continue;
      const M = modelState.model[li];
      const isDark = lum(M.rgb) < 60;
      const amount = px * (isDark ? 1.0 : 0.45) * (1 - pass * 0.15);
      for (let pi = 0; pi < M.paths.length; pi++) {
        if (M.paths[pi].hole) continue;
        inflateSegs(M.paths[pi].segs, amount);
        any = true;
      }
    }
    if (!any) break;
  }
  return last;
}


function refineLayers(layers, srcRgba, pixelW, pixelH, widthIn, heightIn, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const budgetMs = opts.budgetMs == null ? 55000 : opts.budgetMs;
  const bg = opts.bg || [0xee, 0xf4, 0xfa];
  const iters = opts.iters == null ? 3 : opts.iters;
  const useHalf = opts.halfRes !== false;
  const inflatePx = opts.inflatePx == null ? 0.25 : opts.inflatePx;

  let state = layersToModel(layers, widthIn, heightIn, pixelW, pixelH);
  const base = scoreState(state, srcRgba, bg, 1.0);
  let bestScore = base.score.mae;
  let bestLayers = layers;

  // Corner sharpen + curve fair (classical Vectorizer.AI-like cleanup)
  for (let li = 0; li < state.model.length; li++) {
    const M = state.model[li];
    for (let pi = 0; pi < M.paths.length; pi++) {
      if (M.paths[pi].hole) continue;
      fairAndSharpen(M.paths[pi].segs, { sharpCos: -0.28, fair: 0.1 });
    }
  }
  // Neighbor flush seed inflate (skip when darkDeflate owns coverage tradeoff)
  if (inflatePx > 0 && opts.darkDeflate === false) {
    for (let li = 0; li < state.model.length; li++) {
      const M = state.model[li];
      for (let pi = 0; pi < M.paths.length; pi++) {
        if (M.paths[pi].hole) continue;
        inflateSegs(M.paths[pi].segs, inflatePx * (lum(M.rgb) < 55 ? 0.15 : 0.35));
      }
    }
  }
  // DiffVG-lite gap close (coverage vs source) — skip when darkDeflate path active
  if (opts.darkDeflate === false) {
    gapCloseInflate(state, srcRgba, bg, { passes: 5, px: 0.6 });
  }

  // Dark-deflate: morph dilate seals gaps but overpaints neighbors — pull dark
  // contours back toward true silhouettes (biggest MAE lever toward Vectorizer.AI).
  // Apply on a fresh clone of the *input* geometry (skip seed inflate/gapClose which
  // fight deflate), accept only if MAE beats current best.
  if (opts.darkDeflate !== false) {
    const dd = opts.darkDeflate == null ? 2.6 : Number(opts.darkDeflate);
    if (dd > 0) {
      const trial = layersToModel(layers, widthIn, heightIn, pixelW, pixelH);
      // light fair only — no seed inflate
      for (let li = 0; li < trial.model.length; li++) {
        const M = trial.model[li];
        for (let pi = 0; pi < M.paths.length; pi++) {
          if (M.paths[pi].hole) continue;
          fairAndSharpen(M.paths[pi].segs, { sharpCos: -0.28, fair: 0.06 });
        }
      }
      for (let li = 0; li < trial.model.length; li++) {
        const M = trial.model[li];
        if (lum(M.rgb) >= 55) continue;
        for (let pi = 0; pi < M.paths.length; pi++) {
          if (M.paths[pi].hole) continue;
          inflateSegs(M.paths[pi].segs, -dd);
        }
      }
      const after = scoreState(trial, srcRgba, bg, 0.85).score;
      if (after.mae < bestScore - 0.01) {
        bestScore = after.mae;
        bestLayers = modelToLayers(trial);
        state = trial;
      }
    }
  }

  // Optional residual steal repair (inflate preferred lights)
  if (opts.stealRepair === true) {
    stealRepair(state, srcRgba, bg, {
      passes: opts.stealPasses == null ? 6 : Number(opts.stealPasses),
      px: opts.stealPx == null ? 0.75 : Number(opts.stealPx),
    });
    const sc2 = scoreState(state, srcRgba, bg, 0.9).score;
    if (sc2.mae <= bestScore) {
      bestScore = sc2.mae;
      bestLayers = modelToLayers(state);
    }
  }

  let geoState = state;
  let geoSrc = srcRgba;
  let halfFactor = 1;
  if (useHalf && Math.max(pixelW, pixelH) > 500) {
    halfFactor = 0.5;
    geoState = layersToModel(modelToLayers(state), widthIn, heightIn, pixelW, pixelH);
    scaleModelInPlace(geoState, halfFactor);
    geoSrc = downscaleRgba(srcRgba, pixelW, pixelH, geoState.w, geoState.h);
  }

  // Optional mask-snap geometry (off by default — can fight dilate coverage)
  if (opts.snap === true) {
    const masksFull = buildTargetMasks(state, srcRgba, bg);
    let masksGeo = masksFull;
    if (halfFactor !== 1) {
      masksGeo = masksFull.map(function (m) {
        const out = new Uint8Array(geoState.w * geoState.h);
        for (let y = 0; y < geoState.h; y++) {
          const sy = Math.min(state.h - 1, Math.floor(y / halfFactor));
          for (let x = 0; x < geoState.w; x++) {
            const sx = Math.min(state.w - 1, Math.floor(x / halfFactor));
            out[y * geoState.w + x] = m[sy * state.w + sx];
          }
        }
        return out;
      });
    }
    for (let it = 0; it < iters; it++) {
      if (Date.now() - t0 > budgetMs * 0.7) break;
      snapToMask(geoState, masksGeo, {
        step: 0.45 * (1 - it * 0.12),
        maxShift: 1.6 - it * 0.2,
      });
      const rast = rasterizeModel(geoState, 0.95);
      refineColors(geoState, geoSrc, rast.top, bg);
    }
    if (halfFactor !== 1) {
      state = layersToModel(modelToLayers(geoState), widthIn, heightIn, pixelW, pixelH);
    } else {
      state = geoState;
    }
  } else {
    // gapClose already applied on full-res state; skip half-res snap
    state = state;
  }

  // Path-level color split (optional; can break evenodd holes)
  if (opts.pathColors === true && Date.now() - t0 < budgetMs) {
    splitPathsByColor(state, srcRgba, bg);
  }

  // Full-res color refine (+ optional snap/nudge); keep improvement only
  if (Date.now() - t0 < budgetMs) {
    if (opts.snap === true) {
      const masks = buildTargetMasks(state, srcRgba, bg);
      snapToMask(state, masks, { step: 0.35, maxShift: 1.2 });
    }
    let rast = rasterizeModel(state, 0.85);
    refineColors(state, srcRgba, rast.top, bg);
    rast = rasterizeModel(state, 0.85);
    if (opts.fullResNudge === true && Date.now() - t0 < budgetMs * 0.9) {
      nudgeGeometry(state, srcRgba, rast, bg, { step: 0.15, maxShift: 0.6 });
      rast = rasterizeModel(state, 0.85);
      refineColors(state, srcRgba, rast.top, bg);
      rast = rasterizeModel(state, 0.85);
    }
    const sc = maeVsSource(srcRgba, rast.rgb, rast.top, state.w, state.h, bg);
    const outLayers = modelToLayers(state);
    if (opts.force || sc.mae <= bestScore * 1.02) {
      bestScore = sc.mae;
      bestLayers = outLayers;
      return {
        layers: bestLayers,
        meta: {
          refineMs: Date.now() - t0,
          score: sc,
          baseMae: base.score.mae,
          iters: iters,
          halfRes: halfFactor !== 1,
          improved: sc.mae < base.score.mae,
        },
      };
    }
    // Reject regression — return lightly faired original with color-only if better
  }

  // Prefer darkDeflate/steal-improved geometry if we already beat base
  if (bestScore < base.score.mae - 0.02) {
    return {
      layers: bestLayers,
      meta: {
        refineMs: Date.now() - t0,
        score: { mae: bestScore },
        baseMae: base.score.mae,
        iters: iters,
        halfRes: halfFactor !== 1,
        improved: true,
        fallback: "darkDeflate-best",
      },
    };
  }

  // Color-only fallback on original geometry
  {
    const st = layersToModel(layers, widthIn, heightIn, pixelW, pixelH);
    if (inflatePx > 0) {
      for (let li = 0; li < st.model.length; li++) {
        for (let pi = 0; pi < st.model[li].paths.length; pi++) {
          if (st.model[li].paths[pi].hole) continue;
          inflateSegs(st.model[li].paths[pi].segs, inflatePx * 0.5);
        }
      }
    }
    let rast = rasterizeModel(st, 0.85);
    refineColors(st, srcRgba, rast.top, bg);
    rast = rasterizeModel(st, 0.85);
    const sc = maeVsSource(srcRgba, rast.rgb, rast.top, st.w, st.h, bg);
    const outLayers = modelToLayers(st);
    if (sc.mae <= bestScore) {
      return {
        layers: outLayers,
        meta: {
          refineMs: Date.now() - t0,
          score: sc,
          baseMae: base.score.mae,
          iters: iters,
          halfRes: false,
          improved: sc.mae < base.score.mae,
          fallback: "color+light-inflate",
        },
      };
    }
  }

  return {
    layers: bestLayers,
    meta: {
      refineMs: Date.now() - t0,
      score: base.score,
      baseMae: base.score.mae,
      iters: iters,
      halfRes: halfFactor !== 1,
      improved: false,
      fallback: "original",
    },
  };
}

module.exports = {
  refineLayers: refineLayers,
  stealRepair: stealRepair,
  inflateSegs: inflateSegs,
  gapCloseInflate: gapCloseInflate,
  parsePathD: parsePathD,
  rasterizeModel: rasterizeModel,
  layersToModel: layersToModel,
  modelToLayers: modelToLayers,
  maeVsSource: maeVsSource,
  fairAndSharpen: fairAndSharpen,
};
