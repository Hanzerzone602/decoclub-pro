"use strict";

const { nearestMadeira } = require("../madeira");
const {
  UNIT_PER_IN, layerPolys, rasterSize, rasterizeLayer, blobStats,
  distanceTransform, maxDistance, scalePolys, connectedComponents,
  scaleMask, dilate, erode, floodBackground, orMask, copyMask, andMask,
  contoursWithHoles, polyLength, mooreContour,
} = require("./geom");
const { fabricPreset, applyFabric } = require("./fabric");
const { isPaperHex, parseHexRgb, scalePath } = require("./svgLayers");

const MAX_OBJECTS = 192;
const MIN_COMP_PX = 22;
const DEFAULT_MAX_SIDE = 1400;

function classifyMask(mask, w, h, unitPerPx, opts) {
  const st = blobStats(mask, w, h);
  if (!st) return { type: "empty", stats: null };
  const mmPerPx = unitPerPx * 0.1;
  const minMm = Math.min(st.bw, st.bh) * mmPerPx;
  const maxMm = Math.max(st.bw, st.bh) * mmPerPx;
  const dt = distanceTransform(mask, w, h);
  const maxR = maxDistance(dt, mask, w, h);
  const widthMm = 2 * maxR * mmPerPx;
  const satinMm = opts.satinMm == null ? 2.2 : opts.satinMm;
  const areaMm2 = st.count * mmPerPx * mmPerPx;
  const aspect = maxMm / Math.max(0.01, minMm);
  const fillFrac = st.count / (st.bw * st.bh + 1);
  // Small outline crumbs look "filled" in their bbox (Tony face junctions).
  // Treat thin stroke-width pieces as outlineLike so they coalesce into one rail.
  let outlineLike = fillFrac < 0.38 && widthMm <= 4.2 && areaMm2 > 2.0;
  if (!outlineLike && widthMm > 0.28 && widthMm <= 3.2 && areaMm2 > 2.0 && areaMm2 < 22 && fillFrac < 0.78) {
    outlineLike = true;
  }
  if (areaMm2 < 0.55 && maxMm < 1.4) return { type: "empty", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac };
  if (maxMm < 1.15 && minMm < 0.55) return { type: "run", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac };
  // Satin is for true columns / outlines. Wide bars (bee stripes, jersey
  // panels) used to classify as satin and sew as a barcode.
  const column = widthMm > 0.28 && widthMm <= 4.0 && aspect > 3.0 && maxMm > 4.0 && areaMm2 < 150 && fillFrac < 0.55;
  const stroke = outlineLike && widthMm > 0.28 && widthMm <= 3.6 && areaMm2 < 160;
  const letter = minMm > 0.32 && minMm <= satinMm && aspect > 2.2 && widthMm <= satinMm * 1.2 && areaMm2 < 36;
  if (column || letter || stroke) {
    return { type: "satin", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac, outlineLike: outlineLike };
  }
  if (areaMm2 > 12) {
    return { type: "tatami", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac, outlineLike: outlineLike };
  }
  if (widthMm > 0.28 && widthMm <= satinMm * 1.15 && maxMm > 1.6 && areaMm2 < 16) {
    return { type: "satin", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac, outlineLike: outlineLike };
  }
  return { type: "tatami", stats: st, widthMm: widthMm, dt: dt, areaMm2: areaMm2, fillFrac: fillFrac, outlineLike: outlineLike };
}

function hexLum(hex) {
  const rgb = parseHexRgb(hex);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function colorDist(a, b) {
  const A = parseHexRgb(a), B = parseHexRgb(b);
  return Math.abs(A[0] - B[0]) + Math.abs(A[1] - B[1]) + Math.abs(A[2] - B[2]);
}

function mergeSimilarLayers(layers) {
  const out = [];
  (layers || []).forEach((L) => {
    const hit = out.find((o) => colorDist(o.hex, L.hex) < 12);
    if (hit) {
      hit.paths = (hit.paths || []).concat(L.paths || []);
    } else {
      out.push({
        hex: L.hex,
        nameGuess: L.nameGuess,
        paths: (L.paths || []).slice(),
        threadHex: L.threadHex,
        madeiraCode: L.madeiraCode,
        madeiraBrand: L.madeiraBrand,
        threadName: L.threadName,
      });
    }
  });
  return out;
}

function threadForLayer(layer, opts) {
  const hex = layer.hex || layer.threadHex || "#111111";
  const catalog = (opts && opts.madeiraCatalog) || "rayon";
  const made = nearestMadeira(hex, catalog);
  if (layer.madeiraCode) {
    return {
      brand: layer.madeiraBrand || (made && made.brand) || "madeira-rayon",
      code: String(layer.madeiraCode),
      name: layer.threadName || layer.nameGuess || (made && made.name) || "Thread",
      hex: layer.threadHex || (made && made.hex) || hex,
      sourceHex: hex,
    };
  }
  return {
    brand: (made && made.brand) || "madeira-rayon",
    code: made && made.code,
    name: (made && made.name) || layer.nameGuess || "Thread",
    hex: hex,
    madeiraHex: made && made.hex,
    sourceHex: hex,
  };
}

function applyThreadSwap(thread, swap, opts) {
  if (!swap) return thread;
  if (!(swap.hex || swap.code)) return thread;
  const made = swap.code ? null : nearestMadeira(swap.hex, (opts && opts.madeiraCatalog) || "rayon");
  if (swap.code) {
    thread.code = String(swap.code);
    if (swap.hex) thread.hex = swap.hex;
    if (swap.name) thread.name = swap.name;
    if (swap.brand) thread.brand = swap.brand;
  } else if (made) {
    thread.brand = made.brand;
    thread.code = made.code;
    thread.name = made.name;
    thread.hex = made.hex;
  } else if (swap.hex) {
    thread.hex = swap.hex;
  }
  return thread;
}

function splitMixedWidth(comp, mw, mh, unitPerPx, satinMm) {
  const mask = comp.mask;
  const st = blobStats(mask, mw, mh);
  if (!st || st.count < 500) return [comp];
  const fillFrac = st.count / (st.bw * st.bh + 1);
  if (fillFrac > 0.7) return [comp];
  const dt = distanceTransform(mask, mw, mh);
  const maxR = maxDistance(dt, mask, mw, mh);
  const mmPerPx = unitPerPx * 0.1;
  const widthMm = 2 * maxR * mmPerPx;
  // Thin cartoon outlines (Tony face) sit near satinMm at junctions.
  // Only split when a real thick core exists (bee stripes on an outline).
  if (widthMm < satinMm * 1.12) return [comp];
  const thickR = Math.max(2, ((satinMm * 0.9) * 10) / unitPerPx / 2);
  const core = new Uint8Array(mask.length);
  let cn = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && dt[i] >= thickR) { core[i] = 1; cn++; }
  }
  if (cn < 80) return [comp];
  const thick = dilate(core, mw, mh, Math.ceil(thickR));
  const thin = new Uint8Array(mask.length);
  let tn = 0, kn = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) { thick[i] = 0; continue; }
    if (thick[i]) kn++;
    else { thin[i] = 1; tn++; }
  }
  if (kn < 80 || tn < 80) return [comp];
  const thickComps = connectedComponents(thick, mw, mh, 36);
  const thinComps = connectedComponents(thin, mw, mh, 36);
  const out = thickComps.concat(thinComps);
  return out.length ? out : [comp];
}

function layerCoverage(mask, w, h) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n / (w * h || 1);
}

function countOn(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/**
 * Nearest-layer assignment of the source raster. Clips evenodd hull bays
 * (background) and restores graphic interiors (paw toes) the tracer mashed.
 */
function sourceMaskForHex(rgba, sw, sh, mw, mh, hex, allHexes) {
  const target = parseHexRgb(hex);
  const others = (allHexes || [hex]).map(parseHexRgb);
  const out = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / mh));
    for (let x = 0; x < mw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / mw));
      const i = (sy * sw + sx) * 4;
      if (rgba[i + 3] < 18) continue;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const span = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum > 242 && span < 22) continue;
      let bestD = Infinity, bestK = -1;
      for (let k = 0; k < others.length; k++) {
        const d = Math.abs(others[k][0] - r) + Math.abs(others[k][1] - g) + Math.abs(others[k][2] - b);
        if (d < bestD) { bestD = d; bestK = k; }
      }
      const td = Math.abs(target[0] - r) + Math.abs(target[1] - g) + Math.abs(target[2] - b);
      // Must actually match this hex — nearest-of-few-layers would map
      // Tony's cream chest onto orange and fill the white hole.
      if (td > 96) continue;
      if (bestK >= 0 && td <= bestD + 6) out[y * mw + x] = 1;
    }
  }
  return out;
}

function andCount(a, b) {
  const n = Math.min(a.length, b.length);
  let k = 0;
  for (let i = 0; i < n; i++) if (a[i] && b[i]) k++;
  return k;
}

/**
 * Punch pixels that clearly belong to a different layer in the source
 * (jersey purple in a gold paw blob). Then restore source blobs of THIS
 * hex that touch the remaining vector (bee stripes chord-kill dropped).
 * Unassigned pixels (Tony cream chest vs 4 vector colors) stay as vector.
 */
function punchForeignFromSource(mask, mw, mh, rgba, sw, sh, hex, allHexes) {
  const target = parseHexRgb(hex);
  const others = (allHexes || []).map(parseHexRgb).filter((o) => {
    return Math.abs(o[0] - target[0]) + Math.abs(o[1] - target[1]) + Math.abs(o[2] - target[2]) >= 12;
  });
  if (!others.length) return mask;
  const out = copyMask(mask);
  let drop = 0, keep = 0;
  for (let y = 0; y < mh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / mh));
    for (let x = 0; x < mw; x++) {
      const i = y * mw + x;
      if (!mask[i]) continue;
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / mw));
      const p = (sy * sw + sx) * 4;
      if (rgba[p + 3] < 18) { out[i] = 0; drop++; continue; }
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const span = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum > 238 && span < 28) { keep++; continue; }
      const td = Math.abs(target[0] - r) + Math.abs(target[1] - g) + Math.abs(target[2] - b);
      let bestO = Infinity;
      for (let k = 0; k < others.length; k++) {
        const d = Math.abs(others[k][0] - r) + Math.abs(others[k][1] - g) + Math.abs(others[k][2] - b);
        if (d < bestO) bestO = d;
      }
      if (bestO < 90 && bestO + 12 < td) { out[i] = 0; drop++; }
      else keep++;
    }
  }
  const n = drop + keep;
  if (keep < 24) return mask;
  if (n > 0 && drop / n > 0.50) return mask;
  return out;
}

function refineMaskFromSource(mask, mw, mh, rgba, sw, sh, hex, allHexes) {
  if (!rgba || sw < 4 || sh < 4) return mask;
  const vecN = countOn(mask);
  if (vecN < 24) return mask;
  const punched = punchForeignFromSource(mask, mw, mh, rgba, sw, sh, hex, allHexes);
  const src = sourceMaskForHex(rgba, sw, sh, mw, mh, hex, allHexes);
  const srcN = countOn(src);
  if (srcN < 24) return punched;
  const base = punched;
  const dilated = dilate(base, mw, mh, 5);
  const srcComps = connectedComponents(src, mw, mh, 24);
  const out = copyMask(base);
  srcComps.forEach((c) => {
    if (andCount(c.mask, dilated) < 10) return;
    orMask(out, c.mask);
  });
  const on = countOn(out);
  if (on < 24) return mask;
  if (on > vecN * 4.5) return base;
  return out;
}

function holeLooksLikeInk(comp, mw, mh, rgba, sw, sh) {
  if (!rgba || sw < 4 || sh < 4 || !comp || !comp.mask) return false;
  let dark = 0, light = 0, n = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(comp.count || 64) / 28));
  for (let y = 0; y < mh; y += step) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / mh));
    for (let x = 0; x < mw; x += step) {
      if (!comp.mask[y * mw + x]) continue;
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / mw));
      const i = (sy * sw + sx) * 4;
      if (rgba[i + 3] < 18) continue;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      n++;
      if (lum < 72) dark++;
      else if (lum > 200) light++;
    }
  }
  if (n < 8) return false;
  return dark > n * 0.40 && dark > light;
}

function morphOpen(mask, w, h, r) {
  return dilate(erode(mask, w, h, r), w, h, r);
}

function morphClose(mask, w, h, r) {
  return erode(dilate(mask, w, h, r), w, h, r);
}

/**
 * Bee stinger / pointed tip: outline rail sews a bulbous tip as a weak loop.
 * Detect a distal protrusion past a thin neck, replace it with a solid
 * pointed wedge, and return [body, tip] so the tip sews as fill satin.
 * No-op when geometry does not look like a tip (asp gate / no neck).
 */
function tipWedgeFromOutline(comp, hint, w, h, mmPerPx) {
  if (!comp || !comp.mask || !hint) return null;
  const st = hint.stats || blobStats(comp.mask, w, h);
  if (!st) return null;
  const area = hint.areaMm2 || (st.count * mmPerPx * mmPerPx);
  const maxMm = Math.max(st.bw, st.bh) * mmPerPx;
  const minMm = Math.min(st.bw, st.bh) * mmPerPx;
  const asp = minMm > 0 ? maxMm / minMm : 0;
  const ff = hint.fillFrac == null ? 1 : hint.fillFrac;
  // Pointed protrusion: long-ish, sparse-ish, not a huge outline net.
  if (asp < 1.85 || area < 8 || area > 55 || ff > 0.45 || maxMm < 5.0) return null;
  if ((hint.widthMm || 99) > 3.6 && ff > 0.28) return null;

  const mask = comp.mask;
  const bb = bboxOfMask(mask, w, h) || st;
  const cx = bb.cx != null ? bb.cx : (st.minX + st.maxX) / 2;
  const cy = bb.cy != null ? bb.cy : (st.minY + st.maxY) / 2;
  // Candidate tips: bbox extremes (on-pixel). Arc ends are far but wide;
  // a stinger tip has a thin neck before the body — score by neck quality.
  const cands = [];
  let south = null, north = null, east = null, west = null;
  for (let y = st.minY; y <= st.maxY; y++) {
    for (let x = st.minX; x <= st.maxX; x++) {
      if (!mask[y * w + x]) continue;
      if (!south || y > south.y || (y === south.y && Math.abs(x - cx) < Math.abs(south.x - cx))) south = { x: x, y: y };
      if (!north || y < north.y || (y === north.y && Math.abs(x - cx) < Math.abs(north.x - cx))) north = { x: x, y: y };
      if (!east || x > east.x || (x === east.x && Math.abs(y - cy) < Math.abs(east.y - cy))) east = { x: x, y: y };
      if (!west || x < west.x || (x === west.x && Math.abs(y - cy) < Math.abs(west.y - cy))) west = { x: x, y: y };
    }
  }
  [south, north, east, west].forEach((p) => { if (p) cands.push(p); });

  function profileFrom(tipX0, tipY0) {
    let vx = tipX0 - cx, vy = tipY0 - cy;
    const vlen = Math.hypot(vx, vy) || 1;
    vx /= vlen; vy /= vlen;
    const out = [];
    const maxSteps = Math.round(Math.min(maxMm, 12) / mmPerPx);
    for (let t = 0; t <= maxSteps; t++) {
      const px = tipX0 - vx * t;
      const py = tipY0 - vy * t;
      const qx = -vy, qy = vx;
      let mn = 1e9, mx = -1e9, n = 0, sx = 0, sy = 0;
      const halfScan = Math.round(4.0 / mmPerPx);
      for (let s = -halfScan; s <= halfScan; s++) {
        const x = Math.round(px + qx * s);
        const y = Math.round(py + qy * s);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (!mask[y * w + x]) continue;
        n++;
        sx += x; sy += y;
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      if (!n) { out.push({ t: t, w: 0, cx: px, cy: py }); break; }
      out.push({ t: t, w: mx - mn + 1, cx: sx / n, cy: sy / n });
    }
    return { profile: out, vx: vx, vy: vy, tipX: tipX0, tipY: tipY0 };
  }

  let best = null;
  cands.forEach((c) => {
    const got = profileFrom(c.x, c.y);
    const profile = got.profile;
    if (profile.length < 10) return;
    let bodyT = -1;
    for (let i = 2; i < profile.length; i++) {
      const prev = profile[i - 1].w, cur = profile[i].w;
      if (cur >= Math.max(18, prev * 2.1) && prev > 0 && prev <= 16) { bodyT = i; break; }
    }
    if (bodyT < 8) return;
    let neckT = 0, neckW = 1e9;
    for (let i = 0; i < bodyT; i++) {
      if (profile[i].w > 0 && profile[i].w < neckW) { neckW = profile[i].w; neckT = i; }
    }
    const tipLenMm = neckT * mmPerPx;
    if (tipLenMm < 2.2 || tipLenMm > 9.0) return;
    if (neckW > 14) return;
    let maxBlobW = 0;
    for (let i = 0; i < neckT; i++) if (profile[i].w > maxBlobW) maxBlobW = profile[i].w;
    if (maxBlobW < 6) return;
    // Prefer thinner neck + longer tip (real stinger over arc end).
    const score = (1 / Math.max(1, neckW)) * tipLenMm * (maxBlobW / Math.max(1, neckW));
    if (!best || score > best.score) {
      best = Object.assign({ score: score, bodyT: bodyT, neckT: neckT, neckW: neckW, maxBlobW: maxBlobW }, got);
    }
  });
  if (!best) return null;

  const profile = best.profile;
  const tipX = best.tipX, tipY = best.tipY;
  const vx = best.vx, vy = best.vy;
  const neckT = best.neckT, bodyT = best.bodyT, maxBlobW = best.maxBlobW;

  // Start wedge at body attach (just before width jump) so the skinny neck
  // does not sew as a weak loop — continuous solid wedge into the tip.
  const startT = Math.max(neckT, bodyT - 2);
  const start = profile[Math.min(startT, profile.length - 1)];
  const baseHalf = Math.max(5, Math.round(Math.min(Math.max(maxBlobW, 14), 26) * 0.55));

  const body = copyMask(mask);
  const tip = new Uint8Array(mask.length);
  // Clear distal region from body; paint solid pointed wedge into tip.
  for (let t = 0; t <= startT + 1; t++) {
    const px = tipX - vx * t;
    const py = tipY - vy * t;
    const qx = -vy, qy = vx;
    const halfScan = Math.round(4.5 / mmPerPx);
    for (let s = -halfScan; s <= halfScan; s++) {
      const x = Math.round(px + qx * s);
      const y = Math.round(py + qy * s);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      body[y * w + x] = 0;
    }
  }
  for (let t = 0; t <= startT; t++) {
    const frac = startT <= 0 ? 1 : t / startT; // 0 at tip .. 1 at base
    const half = Math.max(0.55, baseHalf * frac);
    const px = tipX - vx * t;
    const py = tipY - vy * t;
    const qx = -vy, qy = vx;
    // Center line: lerp tip → start center
    const mx = tipX + (start.cx - tipX) * frac;
    const my = tipY + (start.cy - tipY) * frac;
    for (let s = -Math.ceil(half); s <= Math.ceil(half); s++) {
      const x = Math.round(mx + qx * s);
      const y = Math.round(my + qy * s);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      tip[y * w + x] = 1;
    }
  }
  // Fatten tip slightly so satin columns read as a solid wedge, not 2 dots.
  const tipFat = dilate(tip, w, h, Math.max(1, Math.round(0.28 / mmPerPx)));
  for (let i = 0; i < tip.length; i++) tip[i] = tipFat[i] ? 1 : 0;
  const bodyBb = bboxOfMask(body, w, h);
  const tipBb = bboxOfMask(tip, w, h);
  if (!bodyBb || !tipBb || tipBb.count < 20 || bodyBb.count < 40) return null;
  const tipArea = tipBb.count * mmPerPx * mmPerPx;
  if (tipArea < 2.0 || tipArea > 45) return null;
  return [
    {
      mask: body,
      count: bodyBb.count,
      cx: bodyBb.cx, cy: bodyBb.cy,
      minX: bodyBb.minX, minY: bodyBb.minY, maxX: bodyBb.maxX, maxY: bodyBb.maxY,
      bw: bodyBb.bw, bh: bodyBb.bh,
      _tipBody: true,
    },
    {
      mask: tip,
      count: tipBb.count,
      cx: tipBb.cx, cy: tipBb.cy,
      minX: tipBb.minX, minY: tipBb.minY, maxX: tipBb.maxX, maxY: tipBb.maxY,
      bw: tipBb.bw, bh: tipBb.bh,
      _tipWedge: true,
    },
  ];
}


function bboxOfMask(mask, w, h) {
  let minX = w, minY = h, maxX = 0, maxY = 0, n = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      n++;
      sx += x; sy += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!n) return null;
  return {
    count: n, minX: minX, minY: minY, maxX: maxX, maxY: maxY,
    bw: maxX - minX + 1, bh: maxY - minY + 1, cx: sx / n, cy: sy / n,
  };
}

function nearTouch(a, b, w, h, dilPx) {
  const p = dilPx || 0;
  if (a.maxX == null || b.maxX == null) return andCount(a.mask, b.mask) >= 4;
  if (a.maxX + p < b.minX || b.maxX + p < a.minX || a.maxY + p < b.minY || b.maxY + p < a.minY) return false;
  const src = (a.count || 0) <= (b.count || 0) ? a : b;
  const dst = src === a ? b : a;
  const r = p;
  for (let y = src.minY; y <= src.maxY; y++) {
    for (let x = src.minX; x <= src.maxX; x++) {
      if (!src.mask[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (dst.mask[ny * w + nx]) return true;
        }
      }
    }
  }
  return false;
}

/** Join tiny outline crumbs onto a touching neighbor. Never fuse two large outlines. */
function coalesceTouching(comps, w, h, dilPx, mmPerPx) {
  if (!comps || comps.length < 2) return comps || [];
  const n = comps.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) {
    a = find(a); b = find(b);
    if (a !== b) parent[b] = a;
  }
  const bbs = comps.map((c) => {
    if (c.minX != null && c.maxX != null) return c;
    const bb = bboxOfMask(c.mask, w, h);
    return bb ? Object.assign({}, c, bb) : c;
  });
  const area = bbs.map((c) => (c.count || 0) * (mmPerPx || 0.05) * (mmPerPx || 0.05));
  const thinish = bbs.map((c) => {
    const st = blobStats(c.mask, w, h);
    if (!st) return false;
    const ff = st.count / (st.bw * st.bh + 1);
    return ff < 0.42;
  });
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const bothLarge = area[i] >= 22 && area[j] >= 22;
      // Thin outline networks (Tony face/body) must bridge junctions even
      // when both pieces are large — a 2px cap left face as a nest.
      let p = dilPx;
      if (bothLarge && !(thinish[i] && thinish[j])) p = Math.min(dilPx, 2);
      else if (thinish[i] || thinish[j]) p = Math.max(dilPx, Math.round(0.75 / (mmPerPx || 0.05)));
      if (nearTouch(bbs[i], bbs[j], w, h, p)) union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(comps[i]);
  }
  const out = [];
  groups.forEach((g) => {
    if (g.length === 1) { out.push(g[0]); return; }
    const mask = copyMask(g[0].mask);
    for (let k = 1; k < g.length; k++) orMask(mask, g[k].mask);
    const bb = bboxOfMask(mask, w, h);
    out.push({
      mask: mask,
      count: bb ? bb.count : countOn(mask),
      cx: bb ? bb.cx : 0,
      cy: bb ? bb.cy : 0,
      minX: bb && bb.minX, minY: bb && bb.minY,
      maxX: bb && bb.maxX, maxY: bb && bb.maxY,
      bw: bb && bb.bw, bh: bb && bb.bh,
    });
  });
  return out;
}

/**
 * Separate a compact multi-lobe fill (jersey paw) into readable pads.
 * If opening does not yield 3–6 similar islands, leave the vector as-is.
 */
/**
 * Branching cartoon outlines (Tony face) have many tiny holes. Filling
 * them and keeping a constant-width outer band sews one contour column
 * instead of a nest of short satins. Real rings (bee) have a few large
 * holes and are left alone for contour-rail satin.
 */
function silhouetteBandIfBranching(comp, w, h, mmPerPx) {
  const mask = comp.mask;
  const st = blobStats(mask, w, h);
  if (!st || st.count < 80) return [comp];
  const ff = st.count / (st.bw * st.bh + 1);
  const areaMm2 = st.count * mmPerPx * mmPerPx;
  if (ff > 0.30 || areaMm2 < 14) return [comp];
  const closeR = Math.max(2, Math.round(0.42 / mmPerPx));
  const closed = morphClose(mask, w, h, closeR);
  const n0 = countOn(mask), n1 = countOn(closed);
  const probe = (n0 > 40 && n1 >= n0 && n1 <= n0 * 1.22) ? closed : mask;
  const rings = contoursWithHoles(probe, w, h, 10);
  if (!rings.length) return [comp];
  const outerL = rings.reduce((n, r) => n + polyLength(r.outer || []), 0);
  const holes = [];
  rings.forEach((r) => (r.holes || []).forEach((hp) => holes.push(hp)));
  const big = holes.filter((hp) => polyLength(hp) * mmPerPx > 8.0).length;
  const tiny = holes.length - big;
  // Real rings (bee) have several large holes — leave them for contour-rail.
  if (big >= 2) return [comp];
  const leaked = holes.length === 0 && ff < 0.22 && areaMm2 > 18;
  if (!(tiny >= 2 && big <= 1) && !leaked) return [comp];
  const src = leaked ? probe : mask;
  const bg = floodBackground(src, w, h);
  const filled = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (src[i] || !bg[i]) filled[i] = 1;
  }
  const filledN = countOn(filled);
  // Filling did not capture interior (gaps still leak to the border).
  if (filledN < st.count * 1.15) return [comp];
  const bandPx = Math.max(2, Math.round(1.05 / mmPerPx));
  const inner = erode(filled, w, h, bandPx);
  const band = new Uint8Array(mask.length);
  let bn = 0;
  for (let i = 0; i < mask.length; i++) {
    if (filled[i] && !inner[i]) { band[i] = 1; bn++; }
  }
  if (bn < 80) return [comp];
  // Fold original stroke pixels that touch the band back into it so junctions
  // stay on the continuous rail instead of spawning short satins.
  {
    const touch = dilate(band, w, h, Math.max(2, Math.round(0.45 / mmPerPx)));
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && touch[i] && !band[i]) { band[i] = 1; bn++; }
    }
  }
  const bb = bboxOfMask(band, w, h);
  const out = [{
    mask: band,
    count: bn,
    cx: bb ? bb.cx : comp.cx,
    cy: bb ? bb.cy : comp.cy,
    minX: bb && bb.minX, minY: bb && bb.minY,
    maxX: bb && bb.maxX, maxY: bb && bb.maxY,
    bw: bb && bb.bw, bh: bb && bb.bh,
  }];
  const leftover = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && !band[i] && inner[i]) leftover[i] = 1;
  }
  const minPix = Math.max(48, Math.round(7.0 / (mmPerPx * mmPerPx)));
  connectedComponents(leftover, w, h, minPix).forEach((p) => {
    const a = p.count * mmPerPx * mmPerPx;
    if (a < 9.0) return;
    const pst = blobStats(p.mask, w, h);
    const pff = pst ? pst.count / (pst.bw * pst.bh + 1) : 0;
    const pr = contoursWithHoles(p.mask, w, h, 10);
    let ph = 0;
    pr.forEach((r) => { ph += (r.holes || []).length; });
    // Keep a real interior ring (eye). Drop branching twigs that scribble.
    if (ph < 1 && pff < 0.42) return;
    out.push(p);
  });
  return out;
}

function convexHull(pts) {
  const p = (pts || []).slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (let i = 0; i < p.length; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p[i]) <= 0) lower.pop();
    lower.push(p[i]);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
    upper.push(p[i]);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function convexifyPad(mask, w, h) {
  const outer = mooreContour(mask, w, h);
  if (!outer || outer.length < 8) return mask;
  const hull = convexHull(outer);
  if (hull.length < 4) return mask;
  const filled = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    const ys = y + 0.5;
    const xs = [];
    for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
      const yi = hull[i].y, yj = hull[j].y;
      if ((yi > ys) === (yj > ys)) continue;
      const xi = hull[i].x, xj = hull[j].x;
      xs.push(xi + (xj - xi) * (ys - yi) / ((yj - yi) || 1e-9));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = y * w;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.min(w - 1, Math.floor(xs[k])));
      const x1 = Math.max(0, Math.min(w - 1, Math.ceil(xs[k + 1])));
      for (let x = x0; x <= x1; x++) filled[row + x] = 1;
    }
  }
  const n0 = countOn(mask), n1 = countOn(filled);
  if (n1 < 24 || n1 > n0 * 1.55) return mask;
  return filled;
}

function splitLobes(comp, w, h, unitPerPx) {
  const mask = comp.mask;
  const st = blobStats(mask, w, h);
  if (!st || st.count < 90) return [comp];
  const fillFrac = st.count / (st.bw * st.bh + 1);
  const aspect = Math.max(st.bw, st.bh) / Math.max(1, Math.min(st.bw, st.bh));
  if (fillFrac < 0.28 || fillFrac > 0.90) return [comp];
  if (aspect > 2.6) return [comp];
  const mmPerPx = unitPerPx * 0.1;
  const areaMm2 = st.count * mmPerPx * mmPerPx;
  if (areaMm2 < 10 || areaMm2 > 160) return [comp];
  const closeR = Math.max(2, Math.min(7, Math.round(Math.min(st.bw, st.bh) * 0.06)));
  const healed = morphClose(mask, w, h, closeR);
  const r0 = Math.max(2, Math.min(9, Math.round(Math.min(st.bw, st.bh) * 0.075)));
  const minPart = Math.max(24, Math.round(st.count * 0.045));
  let best = null;
  for (let dr = -3; dr <= 7; dr++) {
    const r = r0 + dr;
    if (r < 2) continue;
    const opened = morphOpen(healed, w, h, r);
    const parts = connectedComponents(opened, w, h, minPart);
    if (parts.length < 3 || parts.length > 6) continue;
    const sizes = parts.map((p) => p.count).sort((a, b) => b - a);
    if (sizes[0] > sizes[sizes.length - 1] * 5.5) continue;
    // Prefer a true 4-toe print; 5 is palm+toes. Do not invent geometry.
    let score = 1;
    if (parts.length === 4) score = 5;
    else if (parts.length === 5) score = 3;
    else if (parts.length === 3) score = 1;
    const sim = sizes[sizes.length - 1] / Math.max(1, sizes[0]);
    if (parts.length === 4 && sim >= 0.35) score += 1;
    if (!best || score > best.score || (score === best.score && parts.length === 4)) {
      best = { r: r, parts: parts, score: score };
    }
    if (parts.length === 4 && sim >= 0.35) break;
  }
  if (!best) return [comp];
  const grow = Math.max(1, best.r - 1);
  const out = [];
  best.parts.forEach((p) => {
    let fat = andMask(dilate(p.mask, w, h, grow), healed);
    fat = morphClose(fat, w, h, 2);
    fat = convexifyPad(fat, w, h);
    const n = countOn(fat);
    if (n < minPart) return;
    const bb = bboxOfMask(fat, w, h);
    out.push({
      mask: fat,
      count: n,
      cx: bb ? bb.cx : p.cx,
      cy: bb ? bb.cy : p.cy,
      minX: bb && bb.minX, minY: bb && bb.minY,
      maxX: bb && bb.maxX, maxY: bb && bb.maxY,
      bw: bb && bb.bw, bh: bb && bb.bh,
    });
  });
  return out.length >= 3 ? out : [comp];
}

function clipPaperFromSource(mask, mw, mh, rgba, sw, sh) {
  if (!rgba || sw < 4 || sh < 4) return mask;
  for (let y = 0; y < mh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y + 0.5) * sh / mh));
    for (let x = 0; x < mw; x++) {
      if (!mask[y * mw + x]) continue;
      const sx = Math.min(sw - 1, Math.floor((x + 0.5) * sw / mw));
      const i = (sy * sw + sx) * 4;
      if (rgba[i + 3] < 18) { mask[y * mw + x] = 0; continue; }
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const span = Math.max(r, g, b) - Math.min(r, g, b);
      if (lum > 238 && span < 28) mask[y * mw + x] = 0;
    }
  }
  return mask;
}

function nearestUnused(g, used, last) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < g.length; i++) {
    if (used[i]) continue;
    if (!last) return i;
    const dx = (g[i].cx || 0) - last.cx, dy = (g[i].cy || 0) - last.cy;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function sequenceByColor(list) {
  const groups = [];
  const index = new Map();
  list.forEach((o) => {
    const key = String((o.thread && o.thread.code) || "") + "|" + String((o.thread && o.thread.hex) || "");
    if (!index.has(key)) {
      index.set(key, groups.length);
      groups.push([]);
    }
    groups[index.get(key)].push(o);
  });
  groups.sort((A, B) => {
    const la = Math.min.apply(null, A.map((o) => o.layerIndex || 0));
    const lb = Math.min.apply(null, B.map((o) => o.layerIndex || 0));
    return la - lb;
  });
  const out = [];
  groups.forEach((g) => {
    g.sort((a, b) => (b.areaMm2 || 0) - (a.areaMm2 || 0));
    const used = new Uint8Array(g.length);
    let last = null;
    for (let n = 0; n < g.length; n++) {
      const best = nearestUnused(g, used, last);
      if (best < 0) break;
      used[best] = 1;
      out.push(g[best]);
      last = g[best];
    }
  });
  return out;
}

function threadKey(o) {
  return String((o.thread && o.thread.code) || "") + "|" + String((o.thread && o.thread.hex) || "");
}

/** Like sequenceByColor but optionally starts with preferKey (same-spool fill→outline). */
function sequenceByColorPrefer(list, preferKey) {
  if (!preferKey) return sequenceByColor(list);
  const prefer = list.filter((o) => threadKey(o) === preferKey);
  const other = list.filter((o) => threadKey(o) !== preferKey);
  return sequenceByColor(prefer).concat(sequenceByColor(other));
}

function sequenceObjects(objects) {
  if (!objects.length) return objects;
  const fills = sequenceByColor(objects.filter((o) => o.type === "tatami"));
  const rest = objects.filter((o) => o.type !== "tatami");
  // Cheap COLOR_CHANGE cut: continue the last fill spool that also has
  // outline/run work — avoids a free re-thread at the fill→outline boundary.
  const restKeys = new Set(rest.map(threadKey));
  let prefer = null;
  for (let i = fills.length - 1; i >= 0; i--) {
    const k = threadKey(fills[i]);
    if (restKeys.has(k)) { prefer = k; break; }
  }
  return fills.concat(sequenceByColorPrefer(rest, prefer));
}

function makeObject(comp, hint, type, L, li, ci, polys, paths, rs, mmPerPx, densityMm, satinMm, fabric, opts) {
  const override = (opts.typeOverrides || []).find((o) => Number(o.layerIndex) === li);
  if (override && override.type) type = override.type;
  const thread = applyThreadSwap(threadForLayer(L, opts), (opts.threads || []).find((t) => Number(t.layerIndex) === li), opts);
  let angleDeg = opts.angleDeg == null ? 45 : Number(opts.angleDeg);
  if (opts.angleDeg == null && hint.stats) {
    if (hint.stats.bw > hint.stats.bh * 2.5) angleDeg = 90;
    else if (hint.stats.bh > hint.stats.bw * 2.5) angleDeg = 0;
    else {
      const hsh = Math.abs((Math.round(comp.cx || 0) * 13 + Math.round(comp.cy || 0) * 31) | 0);
      angleDeg = [25, 45, 70, 110, 135, 155][hsh % 6];
    }
  }
  const ff = hint.fillFrac == null ? 1 : hint.fillFrac;
  const outlineLike = !!(hint.outlineLike) || (type === "satin" && ff < 0.42);
  const thinFill = type === "tatami" && ((hint.widthMm || 99) < 18 || (hint.areaMm2 || 0) < 320);
  const tipWedge = !!(comp && comp._tipWedge);
  let params = {
    densityMm: densityMm,
    stitchMm: type === "run" ? 2.4 : 3.15,
    angleDeg: angleDeg,
    satinSpacingMm: opts.satinSpacingMm == null
      ? (tipWedge ? 0.28 : (outlineLike ? 0.32 : 0.38))
      : Number(opts.satinSpacingMm),
    pullMm: type === "satin" ? (outlineLike ? 0.10 : (tipWedge ? 0.12 : 0.16)) : 0.22,
    underlay: type === "satin" ? (outlineLike ? ["edge-run"] : ["edge-run", "zigzag"]) : (thinFill ? ["edge-run"] : ["edge-run", "lattice"]),
    satinMm: tipWedge ? Math.max(satinMm, 2.4) : satinMm,
    outlineLike: outlineLike,
  };
  params = applyFabric(params, type, fabric);
  if (outlineLike) {
    params.pullMm = Math.min(params.pullMm || 0.2, 0.12);
    if (opts.satinSpacingMm == null) params.satinSpacingMm = 0.34;
  }
  if (tipWedge && type === "tatami") {
    // Dense solid tip — shop wants a pointed wedge, not two sparse dots.
    params.densityMm = Math.min(params.densityMm || 0.4, 0.28);
    params.pullMm = Math.min(params.pullMm || 0.2, 0.14);
    if (params.underlay && params.underlay.indexOf("edge-run") < 0) params.underlay.unshift("edge-run");
  }
  if (thinFill && params.underlay) {
    params.underlay = params.underlay.filter((u) => u !== "lattice");
    if (params.underlay.indexOf("edge-run") < 0) params.underlay.unshift("edge-run");
  }
  const out = {
    id: "obj-" + li + "-" + ci,
    layerIndex: li,
    type: type,
    polys: polys,
    paths: paths,
    mask: comp.mask,
    maskW: rs.mw,
    maskH: rs.mh,
    thread: thread,
    params: params,
    sourceWidthIn: opts._wIn,
    sourceHeightIn: opts._hIn,
    widthMm: hint.widthMm,
    areaMm2: hint.areaMm2 || 0,
    fillFrac: hint.fillFrac || 0,
    cx: (comp.cx || 0) * mmPerPx,
    cy: (comp.cy || 0) * mmPerPx,
  };
  if (tipWedge) out._tipWedge = true;
  return out;
}

function capObjects(objects, max) {
  if (objects.length <= max) return objects;
  const kept = [];
  const seen = new Set();
  const keyOf = (o) => String((o.thread && o.thread.code) || "") + "|" + String((o.thread && o.thread.hex) || "");
  objects.forEach((o) => {
    const k = keyOf(o);
    if (seen.has(k)) return;
    seen.add(k);
    kept.push(o);
  });
  objects.forEach((o) => {
    if (kept.length >= max) return;
    if (kept.indexOf(o) < 0) kept.push(o);
  });
  return kept.slice(0, max);
}

function addInteriorWhite(objects, rs, mmPerPx, densityMm, satinMm, fabric, opts) {
  if (!objects.length) return;
  const occupied = new Uint8Array(rs.mw * rs.mh);
  objects.forEach((o) => {
    if (!o.mask) return;
    orMask(occupied, o.mask);
  });
  const bg = floodBackground(occupied, rs.mw, rs.mh);
  const holes = new Uint8Array(occupied.length);
  for (let i = 0; i < holes.length; i++) {
    if (!occupied[i] && !bg[i]) holes[i] = 1;
  }
  const minPix = Math.max(36, Math.round(2.4 / (mmPerPx * mmPerPx)));
  const comps = connectedComponents(holes, rs.mw, rs.mh, minPix);
  const whiteThread = threadForLayer({ hex: "#e3e5fb", nameGuess: "White" }, opts);
  comps.forEach((comp, ci) => {
    const hint = classifyMask(comp.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
    if (hint.type === "empty") return;
    if ((hint.areaMm2 || 0) < 4.0) return;
    if ((hint.fillFrac || 0) < 0.18) return;
    if (holeLooksLikeInk(comp, rs.mw, rs.mh, opts.sourceRgba, opts.sourceW || 0, opts.sourceH || 0)) return;
    const type = (hint.type === "run") ? "tatami" : (hint.widthMm <= 2.4 && hint.type === "satin" ? "satin" : "tatami");
    const obj = makeObject(
      comp, hint, type,
      { hex: "#e3e5fb", nameGuess: "White" },
      900, ci, [], [], rs, mmPerPx, densityMm, satinMm, fabric,
      Object.assign({}, opts, { _wIn: opts._wIn, _hIn: opts._hIn })
    );
    obj.thread = whiteThread;
    obj.id = "obj-white-" + ci;
    obj.interiorWhite = true;
    objects.push(obj);
  });
}

// Detected fabric/background colour: mode of the source image border (falls
// back to white paper when there is no source raster).
function detectBackgroundRgb(rgba, sw, sh) {
  if (!rgba || !(sw > 4) || !(sh > 4)) return [255, 255, 255];
  const bins = new Map();
  const add = (x, y) => {
    const p = (y * sw + x) * 4;
    if (rgba[p + 3] < 18) return;
    const k = ((rgba[p] >> 4) << 8) | ((rgba[p + 1] >> 4) << 4) | (rgba[p + 2] >> 4);
    const b = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
    b.n++; b.r += rgba[p]; b.g += rgba[p + 1]; b.b += rgba[p + 2]; bins.set(k, b);
  };
  for (let x = 0; x < sw; x++) { add(x, 0); add(x, sh - 1); }
  for (let y = 1; y < sh - 1; y++) { add(0, y); add(sw - 1, y); }
  let best = null;
  bins.forEach((b) => { if (!best || b.n > best.n) best = b; });
  return best ? [best.r / best.n, best.g / best.n, best.b / best.n] : [255, 255, 255];
}
function maskTouchesBorder(mask, mw, mh, pad) {
  for (let y = 0; y < mh; y++) {
    const edgeRow = y < pad || y >= mh - pad;
    for (let x = 0; x < mw; x++) {
      if (!edgeRow && x >= pad && x < mw - pad) { x = mw - pad - 1; continue; }
      if (mask[y * mw + x]) return true;
    }
  }
  return false;
}
// A light halo is only paper when it touches the canvas border AND matches
// the detected background colour. Prepped input never gets the heuristic.
function looksLikePaperHalo(mask, hex, rs, opts) {
  if (opts.prepped) return false;
  const c = parseHexRgb(hex), bg = opts._bgRgb || [255, 255, 255];
  const d = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
  if (d > 36) return false;
  return maskTouchesBorder(mask, rs.mw, rs.mh, 2);
}
function buildObjects(layers, widthIn, heightIn, opts) {
  opts = opts || {};
  const wIn = Number(widthIn) || 1;
  const hIn = Number(heightIn) || 1;
  opts._wIn = wIn;
  opts._hIn = hIn;
  const rs = rasterSize(wIn, hIn, opts.maxSide || DEFAULT_MAX_SIDE);
  const densityMm = opts.density == null ? 0.4 : Number(opts.density);
  const satinMm = opts.satinMm == null ? 2.2 : Number(opts.satinMm);
  const fabric = fabricPreset(opts.fabric);
  const mmPerPx = rs.unitPerPx * 0.1;
  const minPix = Math.max(MIN_COMP_PX, Math.round(1.1 / (mmPerPx * mmPerPx)));
  const objects = [];
  const merged = mergeSimilarLayers(layers || []);
  const srcRgba = opts.sourceRgba;
  const srcW = opts.sourceW || 0;
  const srcH = opts.sourceH || 0;
  const allHexes = merged.map((L) => L.hex || L.threadHex).filter(Boolean);
  const prepped = !!opts.prepped;
  opts._bgRgb = detectBackgroundRgb(srcRgba, srcW, srcH);
  merged.forEach((L, li) => {
    const hex = L.hex || L.threadHex;
    let mask = rasterizeLayer(L, wIn, hIn, rs.mw, rs.mh);
    // prepped input (digitize_prep): colours, underlap and fabric are already
    // decided upstream; source pixels are only used for stitch angles.
    if (srcRgba && srcW > 4 && !prepped) {
      const before = countOn(mask);
      const clipped = clipPaperFromSource(Uint8Array.from(mask), rs.mw, rs.mh, srcRgba, srcW, srcH);
      const after = countOn(clipped);
      if (before > 40 && after > before * 0.62) mask = clipped;
      mask = refineMaskFromSource(mask, rs.mw, rs.mh, srcRgba, srcW, srcH, hex, allHexes);
    }
    const cov = layerCoverage(mask, rs.mw, rs.mh);
    if (!prepped && cov > 0.55 && isPaperHex(hex)) return;
    if (!prepped && cov > 0.78 && hexLum(hex) > 220) return;
    let nOn = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) nOn++;
    if (nOn < minPix) return;
    const polys = layerPolys(L, wIn, hIn);
    const paths = (L.paths || []).slice();
    // Seal hairline gaps in sparse outline networks (Tony body outline).
    // Do not seal ring layers (bee) — close would weld stripes together.
    {
      const stAll = blobStats(mask, rs.mw, rs.mh);
      const ffAll = stAll ? stAll.count / (stAll.bw * stAll.bh + 1) : 1;
      if (ffAll < 0.28 && nOn > 80) {
        const probe = contoursWithHoles(mask, rs.mw, rs.mh, 10);
        let bigH = 0;
        probe.forEach((r) => (r.holes || []).forEach((hp) => {
          if (polyLength(hp) * mmPerPx > 8) bigH++;
        }));
        // Only seal when there are NO large holes. A single ring (unit test /
        // bee wing) has bigH===1 — closing that welds the hole shut.
        if (bigH === 0) {
          const darkSparse = hexLum(hex) < 55 && ffAll < 0.22;
          const sealR = Math.max(1, Math.round((darkSparse ? 0.38 : 0.28) / mmPerPx));
          const sealed = morphClose(mask, rs.mw, rs.mh, sealR);
          const n1 = countOn(sealed);
          const maxGrow = darkSparse ? 1.26 : 1.18;
          if (n1 >= nOn && n1 <= nOn * maxGrow) mask = sealed;
        }
      }
    }
    const comps = connectedComponents(mask, rs.mw, rs.mh, minPix);
    const split = [];
    (comps.length ? comps : [{ mask: mask, count: nOn, cx: rs.mw / 2, cy: rs.mh / 2 }]).forEach((c) => {
      splitMixedWidth(c, rs.mw, rs.mh, rs.unitPerPx, satinMm).forEach((p) => split.push(p));
    });
    const pieces = split.length ? split : [{ mask: mask, count: nOn, cx: rs.mw / 2, cy: rs.mh / 2 }];
    const prepared = [];
    pieces.forEach((comp) => {
      const hint = classifyMask(comp.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
      if (hint.type === "empty") return;
      if ((hint.areaMm2 || 0) < 1.2 && (hint.widthMm || 0) < 0.7) return;
      const bboxFrac0 = hint.stats ? (hint.stats.bw * hint.stats.bh) / (rs.mw * rs.mh) : 0;
      if (hexLum(hex) > 90 && hint.outlineLike && bboxFrac0 > 0.25 && (hint.fillFrac || 0) < 0.25 && looksLikePaperHalo(comp.mask, hex, rs, opts)) {
        return;
      }
      prepared.push({ comp: comp, hint: hint });
    });
    const outlineComps = [];
    const restPrepared = [];
    prepared.forEach((p) => {
      if (p.hint.outlineLike && p.hint.type === "satin") outlineComps.push(p.comp);
      else restPrepared.push(p);
    });
    const gapPx = Math.max(3, Math.min(8, Math.round(0.72 / mmPerPx)));
    let mergedOutlines = [];
    coalesceTouching(outlineComps, rs.mw, rs.mh, gapPx, mmPerPx).forEach((c) => {
      silhouetteBandIfBranching(c, rs.mw, rs.mh, mmPerPx).forEach((piece) => {
        const hint = classifyMask(piece.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
        hint.outlineLike = true;
        if (hint.type !== "run") hint.type = "satin";
        mergedOutlines.push({ comp: piece, hint: hint });
      });
    });
    // Dark outline networks (Tony face/body): second coalesce so face+body
    // rails that almost meet become one continuous column. Skip when the
    // layer looks like real rings (bee) — fusing those mashes stripes.
    // Do NOT second-coalesce warm face-color satins here: OR+silhouette
    // turns orange fragments into an empty outline rail (face goes hollow).
    if (hexLum(hex) < 50 && mergedOutlines.length >= 2) {
      let holeScore = 0;
      mergedOutlines.forEach((p) => {
        const rings = contoursWithHoles(p.comp.mask, rs.mw, rs.mh, 10);
        rings.forEach((r) => { holeScore += (r.holes || []).length; });
      });
      if (holeScore < 2) {
        const bridge = Math.max(gapPx + 2, Math.round(1.05 / mmPerPx));
        const fused = coalesceTouching(mergedOutlines.map((p) => p.comp), rs.mw, rs.mh, bridge, mmPerPx);
        if (fused.length < mergedOutlines.length) {
          mergedOutlines = fused.map((c) => {
            const hint = classifyMask(c.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
            hint.outlineLike = true;
            if (hint.type !== "run") hint.type = "satin";
            return { comp: c, hint: hint };
          });
        }
      }
    }
    // Absorb nest-of-crumbs: small satins that touch a large outline rail
    // of this layer get OR'd into the rail instead of sewing as short columns.
    let prepList = restPrepared.concat(mergedOutlines);
    {
      const rails = [];
      const crumbs = [];
      prepList.forEach((p, idx) => {
        const ol = !!(p.hint.outlineLike) || (p.hint.type === "satin" && (p.hint.fillFrac || 1) < 0.45);
        const area = p.hint.areaMm2 || 0;
        if (ol && p.hint.type === "satin" && area >= 22) rails.push(idx);
        else if (p.hint.type === "satin" && area > 0 && area < 18) crumbs.push(idx);
      });
      if (rails.length && crumbs.length) {
        const take = new Uint8Array(prepList.length);
        crumbs.forEach((ci0) => {
          const c = prepList[ci0].comp;
          const bb = c.minX != null ? c : Object.assign({}, c, bboxOfMask(c.mask, rs.mw, rs.mh) || {});
          let hit = -1;
          for (let r = 0; r < rails.length; r++) {
            const rail = prepList[rails[r]].comp;
            const rbb = rail.minX != null ? rail : Object.assign({}, rail, bboxOfMask(rail.mask, rs.mw, rs.mh) || {});
            if (nearTouch(bb, rbb, rs.mw, rs.mh, Math.max(3, gapPx))) { hit = rails[r]; break; }
          }
          if (hit < 0) return;
          orMask(prepList[hit].comp.mask, c.mask);
          const bb2 = bboxOfMask(prepList[hit].comp.mask, rs.mw, rs.mh);
          if (bb2) {
            prepList[hit].comp = Object.assign({}, prepList[hit].comp, bb2, { mask: prepList[hit].comp.mask, count: bb2.count });
            prepList[hit].hint = classifyMask(prepList[hit].comp.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
            prepList[hit].hint.outlineLike = true;
            if (prepList[hit].hint.type !== "run") prepList[hit].hint.type = "satin";
          }
          take[ci0] = 1;
        });
        prepList = prepList.filter((_, i) => !take[i]);
      }
    }
    // Same-layer face satins → absorb into touching tatami fills (Tony
    // orange/white). Coalescing them as outline rails hollows the face;
    // folding short satins into the neighboring fill keeps TrueView dense.
    // Never absorb dark outline rails into fills (Tony black silhouette).
    // Only warm/cream face colors (Tony orange/white) — purple jersey pads
    // must not be mashed into one fill (paw 4-toe honesty).
    const rgb = parseHexRgb(hex);
    const lum = hexLum(hex);
    const span = Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2]);
    const warmFace = lum >= 55 && (span >= 40 && rgb[0] >= rgb[2] + 15 || lum >= 200);
    if (warmFace) {
      const fills = [];
      const sats = [];
      prepList.forEach((p, idx) => {
        const area = p.hint.areaMm2 || 0;
        if (p.hint.type === "tatami" && !p.hint.outlineLike && area >= 10) fills.push(idx);
        else if (p.hint.type === "satin" && area > 0 && area < 36) sats.push(idx);
      });
      if (fills.length && sats.length) {
        const take = new Uint8Array(prepList.length);
        const bridge = Math.max(gapPx + 2, Math.round(1.15 / mmPerPx));
        sats.forEach((si) => {
          const c = prepList[si].comp;
          const bb = c.minX != null ? c : Object.assign({}, c, bboxOfMask(c.mask, rs.mw, rs.mh) || {});
          let hit = -1;
          for (let f = 0; f < fills.length; f++) {
            const fill = prepList[fills[f]].comp;
            const fbb = fill.minX != null ? fill : Object.assign({}, fill, bboxOfMask(fill.mask, rs.mw, rs.mh) || {});
            if (nearTouch(bb, fbb, rs.mw, rs.mh, bridge)) { hit = fills[f]; break; }
          }
          if (hit < 0) return;
          const sh = prepList[si].hint;
          // Keep long outline-like strokes as satin (not mush into fill).
          if (sh.outlineLike && (sh.fillFrac || 1) < 0.32 && (sh.areaMm2 || 0) >= 18) return;
          orMask(prepList[hit].comp.mask, c.mask);
          const bb2 = bboxOfMask(prepList[hit].comp.mask, rs.mw, rs.mh);
          if (bb2) {
            prepList[hit].comp = Object.assign({}, prepList[hit].comp, bb2, { mask: prepList[hit].comp.mask, count: bb2.count });
            prepList[hit].hint = classifyMask(prepList[hit].comp.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
          }
          take[si] = 1;
        });
        prepList = prepList.filter((_, i) => !take[i]);
      }
    }
    const allPrep = prepList;
    let ci = 0;
    allPrep.forEach((p) => {
      let chunks = [p.comp];
      if (p.hint.type === "tatami" && !p.hint.outlineLike) {
        chunks = splitLobes(p.comp, rs.mw, rs.mh, rs.unitPerPx);
      }
      chunks.forEach((comp) => {
        let work = comp;
        let hint = chunks.length === 1 ? p.hint : classifyMask(work.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
        if (hint.type === "empty") return;
        if (hint.type === "tatami" && !hint.outlineLike && hint.stats) {
          const ast = hint.stats;
          const aspect = Math.max(ast.bw, ast.bh) / Math.max(1, Math.min(ast.bw, ast.bh));
          if (aspect < 1.9 && (hint.fillFrac || 0) > 0.45 && (hint.areaMm2 || 0) >= 8 && (hint.areaMm2 || 0) <= 55) {
            const healed = morphClose(work.mask, rs.mw, rs.mh, 2);
            const cvx = convexifyPad(healed, rs.mw, rs.mh);
            work = Object.assign({}, work, { mask: cvx, count: countOn(cvx) });
            hint = classifyMask(work.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
          }
        }
        // Warm face satins (Tony orange/white): close thin stroke fragments into
        // a solid tatami pad when morphClose densifies them. Dark outlines stay satin.
        // Skip cool/purple layers (jersey paw pads).
        const _rgbF = parseHexRgb(hex);
        const _lumF = hexLum(hex);
        const _spanF = Math.max(_rgbF[0], _rgbF[1], _rgbF[2]) - Math.min(_rgbF[0], _rgbF[1], _rgbF[2]);
        const _warmF = _lumF >= 55 && (_spanF >= 40 && _rgbF[0] >= _rgbF[2] + 15 || _lumF >= 200);
        if (_warmF && hint.type === "satin" && (hint.outlineLike || (hint.fillFrac || 1) < 0.50)
            && (hint.areaMm2 || 0) >= 6 && (hint.areaMm2 || 0) <= 70) {
          const closeR = Math.max(1, Math.round(0.55 / mmPerPx));
          const closed = morphClose(work.mask, rs.mw, rs.mh, closeR);
          const n0 = countOn(work.mask), n1 = countOn(closed);
          if (n1 > n0 * 1.08 && n1 <= n0 * 2.8) {
            const h2 = classifyMask(closed, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
            if (h2.type !== "empty" && (h2.fillFrac || 0) >= 0.34 && (h2.widthMm || 0) >= 1.6) {
              work = Object.assign({}, work, { mask: closed, count: n1 });
              hint = h2;
              hint.outlineLike = false;
              if (hint.type === "satin" && (hint.widthMm || 0) > 2.6) hint.type = "tatami";
              if ((hint.fillFrac || 0) >= 0.40 && (hint.areaMm2 || 0) >= 10) hint.type = "tatami";
            }
          }
        }
        if (hint.type === "satin" && ((hint.fillFrac || 1) < 0.45 || hint.outlineLike)) {
          const maxMm = hint.stats ? Math.max(hint.stats.bw, hint.stats.bh) * mmPerPx : 0;
          const minMm = hint.stats ? Math.min(hint.stats.bw, hint.stats.bh) * mmPerPx : 0;
          // Keep pointed tips (bee stinger): long+skinny even when area is small.
          const pointed = maxMm >= 5.0 && minMm > 0 && maxMm / minMm >= 1.85;
          if ((hint.areaMm2 || 0) < 4.8 && maxMm < 12.0 && !pointed) return;
          // Tip protrusion → solid wedge (split body rail + tip fill).
          // Old asp/widthMm gate missed the bulbous stinger loop (asp≈2.17, w≈2.7).
          if (hint.outlineLike && pointed && (hint.areaMm2 || 0) < 55) {
            const split = tipWedgeFromOutline(work, hint, rs.mw, rs.mh, mmPerPx);
            if (split && split.length === 2) {
              split.forEach((piece) => {
                let ph = classifyMask(piece.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
                if (ph.type === "empty") return;
                if (piece._tipWedge) {
                  // Solid tip wedge: tatami fill reads as a dense point. Satin
                  // centerline on a short triangle only dropped ~30 stitches
                  // (TrueView = two weak dots). Contour rail was the old loop.
                  ph.outlineLike = false;
                  ph.type = "tatami";
                  piece._tipWedge = true;
                } else {
                  ph.outlineLike = true;
                  if (ph.type !== "run") ph.type = "satin";
                  // Mild fatten on the remaining body outline.
                  const targetMm = 0.95;
                  const growMm = (targetMm - (ph.widthMm || 0)) / 2;
                  if (growMm > 0.06 && (ph.areaMm2 || 0) >= 8.0) {
                    const dilPx = Math.max(1, Math.round(Math.min(0.36, growMm) / mmPerPx));
                    const fattened = dilate(piece.mask, rs.mw, rs.mh, dilPx);
                    piece = Object.assign({}, piece, { mask: fattened });
                    ph = classifyMask(piece.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
                    ph.outlineLike = true;
                  }
                }
                objects.push(makeObject(piece, ph, ph.type, L, li, ci, polys, paths, rs, mmPerPx, densityMm, satinMm, fabric, opts));
                ci++;
              });
              return;
            }
          }
          const targetMm = pointed ? 1.15 : 0.95;
          const growMm = (targetMm - (hint.widthMm || 0)) / 2;
          if (growMm > 0.06 && ((hint.areaMm2 || 0) >= 8.0 || pointed)) {
            const dilPx = Math.max(1, Math.round(Math.min(pointed ? 0.48 : 0.36, growMm) / mmPerPx));
            const fattened = dilate(work.mask, rs.mw, rs.mh, dilPx);
            work = Object.assign({}, work, { mask: fattened });
            hint = classifyMask(work.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
            hint.outlineLike = true;
          }
        }
        // Fill underlap: grow tatami so fills meet outline rails (Tony body
        // gaps). ~0.36 mm dilate + pull outside mask in tatami.js. Skip
        // stripe-like high-fill bands (bee).
        if (hint.type === "tatami" && !hint.outlineLike && (hint.areaMm2 || 0) >= 12) {
          const stU = hint.stats;
          const aspU = stU ? Math.max(stU.bw, stU.bh) / Math.max(1, Math.min(stU.bw, stU.bh)) : 1;
          const stripeLike = (hint.fillFrac || 0) > 0.70 && aspU > 1.55 && (hint.areaMm2 || 0) < 130;
          if (!stripeLike) {
            const underPx = Math.max(1, Math.round(0.36 / mmPerPx));
            const fat = dilate(work.mask, rs.mw, rs.mh, underPx);
            const n0 = countOn(work.mask), n1 = countOn(fat);
            if (n1 > n0 && n1 <= n0 * 1.22) {
              work = Object.assign({}, work, { mask: fat, count: n1 });
              hint = classifyMask(work.mask, rs.mw, rs.mh, rs.unitPerPx, { satinMm: satinMm });
            }
          }
        }
        if (hint.type === "empty") return;
        const bboxFrac = hint.stats ? (hint.stats.bw * hint.stats.bh) / (rs.mw * rs.mh) : 0;
        if (hexLum(hex) > 90 && hint.outlineLike && bboxFrac > 0.32 && (hint.fillFrac || 0) < 0.22 && (hint.areaMm2 || 0) < 140 && looksLikePaperHalo(work.mask, hex, rs, opts)) {
          return;
        }
        objects.push(makeObject(work, hint, hint.type, L, li, ci, polys, paths, rs, mmPerPx, densityMm, satinMm, fabric, opts));
        ci++;
      });
    });
  });
  if (!prepped) addInteriorWhite(objects, rs, mmPerPx, densityMm, satinMm, fabric, opts);
  objects.sort((a, b) => (b.areaMm2 || 0) - (a.areaMm2 || 0));
  const kept = capObjects(objects, opts.maxObjects || MAX_OBJECTS);
  const sequenced = sequenceObjects(kept);
  return {
    objects: sequenced,
    sourceWidthIn: wIn,
    sourceHeightIn: hIn,
    raster: { mw: rs.mw, mh: rs.mh, unitPerPx: rs.unitPerPx },
    fabric: fabric ? fabric.id : null,
  };
}

function objectsAtSize(pack, widthIn, heightIn) {
  const wIn = Number(widthIn) || pack.sourceWidthIn || 1;
  const hIn = Number(heightIn) || pack.sourceHeightIn || 1;
  const sx = wIn / (pack.sourceWidthIn || wIn);
  const sy = hIn / (pack.sourceHeightIn || hIn);
  return {
    objects: (pack.objects || []).map((o) => {
      const next = Object.assign({}, o, {
        polys: scalePolys(o.polys, sx, sy),
        paths: (o.paths || []).map((p) => ({
          d: scalePath(p.d, sx, sy, 0, 0),
          hole: p.hole,
          fillRule: p.fillRule,
        })),
        cx: (o.cx || 0) * sx,
        cy: (o.cy || 0) * sy,
        areaMm2: (o.areaMm2 || 0) * sx * sy,
        sourceWidthIn: wIn,
        sourceHeightIn: hIn,
      });
      return next;
    }),
    sourceWidthIn: wIn,
    sourceHeightIn: hIn,
    raster: pack.raster,
    fabric: pack.fabric,
  };
}

function scaledMaskFor(obj, mw, mh) {
  if (!obj.mask || !obj.maskW) return null;
  return scaleMask(obj.mask, obj.maskW, obj.maskH, mw, mh);
}

module.exports = {
  buildObjects,
  objectsAtSize,
  classifyMask,
  threadForLayer,
  sequenceObjects,
  scaledMaskFor,
  MAX_OBJECTS,
  UNIT_PER_IN,
};
