"use strict";

function vsub(a, b) { return { x: a.x - b.x, y: a.y - b.y }; }
function vadd(a, b) { return { x: a.x + b.x, y: a.y + b.y }; }
function vscale(a, s) { return { x: a.x * s, y: a.y * s }; }
function vdot(a, b) { return a.x * b.x + a.y * b.y; }
function vlen(a) { return Math.hypot(a.x, a.y); }
function vnorm(a) {
  const L = vlen(a) || 1;
  return { x: a.x / L, y: a.y / L };
}
function fmtLocal(n) {
  const x = Math.round(Number(n) * 10000) / 10000;
  if (Object.is(x, -0)) return "0";
  return String(x);
}
function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

function cleanRing(pts) {
  if (!pts || pts.length < 2) return pts || [];
  let ring = pts.slice();
  if (ring.length > 1) {
    const a = ring[0], b = ring[ring.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) < 0.6) ring = ring.slice(0, -1);
  }
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 0.2) out.push({ x: p.x, y: p.y });
  }
  return out;
}

function detectCorners(ring, cosThresh) {
  cosThresh = cosThresh == null ? 0.55 : cosThresh;
  const n = ring.length;
  const corners = [];
  if (n < 3) return corners;
  const flagged = new Uint8Array(n);
  // Multi-scale corner: look ±1 and ±2 (and ±3 on long rings)
  const spans = n >= 24 ? [1, 2, 3] : (n >= 12 ? [1, 2] : [1]);
  for (let i = 0; i < n; i++) {
    let hit = false;
    for (let s = 0; s < spans.length; s++) {
      const k = spans[s];
      const prev = ring[(i - k + n) % n];
      const cur = ring[i];
      const next = ring[(i + k) % n];
      const v1 = vnorm(vsub(cur, prev));
      const v2 = vnorm(vsub(next, cur));
      // Stricter for farther spans
      const thr = cosThresh - (k - 1) * 0.08;
      if (vdot(v1, v2) < thr) { hit = true; break; }
    }
    if (hit) flagged[i] = 1;
  }
  // Keep local sharpness maxima only (suppress neighbors)
  for (let i = 0; i < n; i++) {
    if (!flagged[i]) continue;
    const prev = ring[(i - 1 + n) % n];
    const cur = ring[i];
    const next = ring[(i + 1) % n];
    const sharp = 1 - vdot(vnorm(vsub(cur, prev)), vnorm(vsub(next, cur)));
    const sharpL = flagged[(i - 1 + n) % n]
      ? 1 - vdot(vnorm(vsub(ring[(i - 1 + n) % n], ring[(i - 2 + n) % n])), vnorm(vsub(cur, ring[(i - 1 + n) % n])))
      : -1;
    const sharpR = flagged[(i + 1) % n]
      ? 1 - vdot(vnorm(vsub(next, cur)), vnorm(vsub(ring[(i + 2) % n], next)))
      : -1;
    if (sharp >= sharpL && sharp >= sharpR) corners.push(i);
  }
  return corners;
}

/** Ensure path is split at corners before cubic fitting — never fit a cubic across a corner. */
function spliceAtCorners(ring, cornerIdx) {
  const n = ring.length;
  if (!cornerIdx || !cornerIdx.length) return [ring];
  const splits = cornerIdx.slice().sort(function (a, b) { return a - b; });
  const segs = [];
  for (let s = 0; s < splits.length; s++) {
    const i0 = splits[s];
    const i1 = splits[(s + 1) % splits.length];
    const seg = [];
    let i = i0;
    seg.push(ring[i]);
    do {
      i = (i + 1) % n;
      seg.push(ring[i]);
    } while (i !== i1);
    if (seg.length >= 2) segs.push({ pts: seg, i0: i0, i1: i1 });
  }
  return segs;
}

function tangentAtRing(ring, i, closed) {
  const n = ring.length;
  if (closed) return vnorm(vsub(ring[(i + 1) % n], ring[(i - 1 + n) % n]));
  if (i === 0) return vnorm(vsub(ring[1], ring[0]));
  if (i === n - 1) return vnorm(vsub(ring[n - 1], ring[n - 2]));
  return vnorm(vsub(ring[i + 1], ring[i - 1]));
}

function chordLengthParameterize(pts) {
  const u = new Float64Array(pts.length);
  u[0] = 0;
  for (let i = 1; i < pts.length; i++) {
    u[i] = u[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const total = u[u.length - 1] || 1;
  for (let i = 1; i < u.length; i++) u[i] /= total;
  return u;
}

function bezierBernstein(u) {
  const t = u, s = 1 - u;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
}

function generateBezier(pts, u, tHat1, tHat2) {
  const n = pts.length;
  const p0 = pts[0], p3 = pts[n - 1];
  let C00 = 0, C01 = 0, C11 = 0, X0 = 0, X1 = 0;
  for (let i = 0; i < n; i++) {
    const b = bezierBernstein(u[i]);
    const a0 = vscale(tHat1, b[1]);
    const a1 = vscale(tHat2, b[2]);
    C00 += vdot(a0, a0);
    C01 += vdot(a0, a1);
    C11 += vdot(a1, a1);
    const tmp = {
      x: pts[i].x - (b[0] + b[1]) * p0.x - (b[2] + b[3]) * p3.x,
      y: pts[i].y - (b[0] + b[1]) * p0.y - (b[2] + b[3]) * p3.y,
    };
    X0 += vdot(a0, tmp);
    X1 += vdot(a1, tmp);
  }
  const C10 = C01;
  let det = C00 * C11 - C01 * C10;
  let alpha1, alpha2;
  const segLen = Math.hypot(p3.x - p0.x, p3.y - p0.y);
  if (Math.abs(det) < 1e-12) {
    alpha1 = alpha2 = segLen / 3;
  } else {
    alpha1 = (C11 * X0 - C01 * X1) / det;
    alpha2 = (C00 * X1 - C10 * X0) / det;
  }
  const epsilon = 1e-6 * (segLen || 1);
  if (!(alpha1 >= epsilon) || !(alpha2 >= epsilon) || !Number.isFinite(alpha1) || !Number.isFinite(alpha2)) {
    alpha1 = alpha2 = (segLen || 1) / 3;
  }
  const maxA = (segLen || 1) * 2.5;
  alpha1 = Math.min(alpha1, maxA);
  alpha2 = Math.min(alpha2, maxA);
  return [
    p0,
    vadd(p0, vscale(tHat1, alpha1)),
    vadd(p3, vscale(tHat2, alpha2)),
    p3,
  ];
}

function bezierDeriv1(bez, t) {
  const s = 1 - t;
  const d0 = vsub(bez[1], bez[0]);
  const d1 = vsub(bez[2], bez[1]);
  const d2 = vsub(bez[3], bez[2]);
  return {
    x: 3 * s * s * d0.x + 6 * s * t * d1.x + 3 * t * t * d2.x,
    y: 3 * s * s * d0.y + 6 * s * t * d1.y + 3 * t * t * d2.y,
  };
}

function bezierDeriv2(bez, t) {
  const s = 1 - t;
  const d0 = vsub(vsub(bez[2], bez[1]), vsub(bez[1], bez[0]));
  const d1 = vsub(vsub(bez[3], bez[2]), vsub(bez[2], bez[1]));
  return { x: 6 * s * d0.x + 6 * t * d1.x, y: 6 * s * d0.y + 6 * t * d1.y };
}

function newtonRaphsonRoot(bez, p, u) {
  const q = cubicPoint(bez[0], bez[1], bez[2], bez[3], u);
  const d1 = bezierDeriv1(bez, u);
  const d2 = bezierDeriv2(bez, u);
  const num = (q.x - p.x) * d1.x + (q.y - p.y) * d1.y;
  const den = d1.x * d1.x + d1.y * d1.y + (q.x - p.x) * d2.x + (q.y - p.y) * d2.y;
  if (Math.abs(den) < 1e-12) return u;
  const nu = u - num / den;
  if (nu < 0 || nu > 1 || !Number.isFinite(nu)) return u;
  return nu;
}

function reparameterize(pts, u, bez) {
  const out = new Float64Array(u.length);
  for (let i = 0; i < pts.length; i++) out[i] = newtonRaphsonRoot(bez, pts[i], u[i]);
  return out;
}

function computeMaxError(pts, u, bez) {
  let maxD = 0, split = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const q = cubicPoint(bez[0], bez[1], bez[2], bez[3], u[i]);
    const d = (q.x - pts[i].x) * (q.x - pts[i].x) + (q.y - pts[i].y) * (q.y - pts[i].y);
    if (d > maxD) { maxD = d; split = i; }
  }
  return { maxDist: Math.sqrt(maxD), split: split };
}

function fitCubicSegment(pts, tHat1, tHat2, error, depth) {
  depth = depth || 0;
  if (pts.length < 2) return [];
  if (pts.length === 2 || depth > 12) {
    const dist = Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) / 3;
    return [[
      pts[0],
      vadd(pts[0], vscale(tHat1, dist)),
      vadd(pts[pts.length - 1], vscale(tHat2, dist)),
      pts[pts.length - 1],
    ]];
  }
  let u = chordLengthParameterize(pts);
  let bez = generateBezier(pts, u, tHat1, tHat2);
  let err = computeMaxError(pts, u, bez);
  if (err.maxDist < error) return [bez];
  if (err.maxDist < error * 4) {
    for (let i = 0; i < 4; i++) {
      u = reparameterize(pts, u, bez);
      bez = generateBezier(pts, u, tHat1, tHat2);
      err = computeMaxError(pts, u, bez);
      if (err.maxDist < error) return [bez];
    }
  }
  const split = Math.max(1, Math.min(pts.length - 2, err.split));
  const tCenter = tangentAtRing(pts, split, false);
  const left = pts.slice(0, split + 1);
  const right = pts.slice(split);
  const tHat2L = vscale(tCenter, -1);
  return fitCubicSegment(left, tHat1, tHat2L, error, depth + 1)
    .concat(fitCubicSegment(right, tCenter, tHat2, error, depth + 1));
}

function fitCubicPath(pts, scaleX, scaleY, opts) {
  opts = opts || {};
  const error = opts.error == null ? 0.75 : opts.error;
  const cornerCos = opts.cornerCos == null ? 0.5 : opts.cornerCos;
  const fmt = opts.fmt || fmtLocal;
  let ring = cleanRing(pts);
  if (ring.length < 2) return "";
  if (ring.length < 4) {
    let d = "M " + fmt(ring[0].x * scaleX) + " " + fmt(ring[0].y * scaleY);
    for (let i = 1; i < ring.length; i++) d += " L " + fmt(ring[i].x * scaleX) + " " + fmt(ring[i].y * scaleY);
    return d + " Z";
  }

  const corners = detectCorners(ring, cornerCos);
  let segments;
  if (corners.length) {
    segments = spliceAtCorners(ring, corners);
  } else {
    // organic / circular: prefer 4 G1 segments for stable smooth closed fit
    const nSeg = ring.length >= 16 ? 4 : 2;
    const fake = [];
    for (let k = 0; k < nSeg; k++) fake.push(Math.floor((k * ring.length) / nSeg));
    segments = spliceAtCorners(ring, fake);
  }

  const cubics = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s].pts;
    if (seg.length < 2) continue;
    const i0 = segments[s].i0;
    const i1 = segments[s].i1;
    const sharpStart = corners.indexOf(i0) >= 0;
    const sharpEnd = corners.indexOf(i1) >= 0;
    let t1, t2;
    // Corner splice: outgoing/incoming tangents follow the edge, not the ring average —
    // so cubics never cross a corner with G1 continuity.
    if (sharpStart) t1 = vnorm(vsub(seg[1], seg[0]));
    else t1 = tangentAtRing(ring, i0, true);
    if (sharpEnd) t2 = vnorm(vsub(seg[seg.length - 2], seg[seg.length - 1]));
    else t2 = vscale(tangentAtRing(ring, i1, true), -1);

    const fitted = fitCubicSegment(seg, t1, t2, error, 0);
    for (let k = 0; k < fitted.length; k++) cubics.push(fitted[k]);
  }

  if (!cubics.length) {
    let d = "M " + fmt(ring[0].x * scaleX) + " " + fmt(ring[0].y * scaleY);
    for (let i = 1; i < ring.length; i++) d += " L " + fmt(ring[i].x * scaleX) + " " + fmt(ring[i].y * scaleY);
    return d + " Z";
  }

  let d = "M " + fmt(cubics[0][0].x * scaleX) + " " + fmt(cubics[0][0].y * scaleY);
  for (let k = 0; k < cubics.length; k++) {
    const b = cubics[k];
    d += " C " + fmt(b[1].x * scaleX) + " " + fmt(b[1].y * scaleY) +
      " " + fmt(b[2].x * scaleX) + " " + fmt(b[2].y * scaleY) +
      " " + fmt(b[3].x * scaleX) + " " + fmt(b[3].y * scaleY);
  }
  return d + " Z";
}

module.exports = {
  fitCubicPath,
  detectCorners,
  spliceAtCorners,
  cleanRing,
};
