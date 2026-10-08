"use strict";
const fs = require("fs");
const path = require("path");

function loadJson(name) {
  const p = path.join(__dirname, "..", "data", "palettes", name);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const MADEIRA_RAYON = loadJson("madeira-rayon.json");
const MADEIRA_POLYNEON = loadJson("madeira-polyneon.json");

function hexLab(hex) {
  const h = String(hex || "").replace("#", "");
  const rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  const lin = rgb.map((v) => { v /= 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; });
  const X = (lin[0] * 0.4124 + lin[1] * 0.3576 + lin[2] * 0.1805) / 0.95047;
  const Y = lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
  const Z = (lin[0] * 0.0193 + lin[1] * 0.1192 + lin[2] * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

// CIEDE2000 colour difference. Plain RGB distance mis-picks dark colours
// (navy #172a4b -> 1162 Deep Windsor teal; dark brown -> 1131 Dark Grey).
function deltaE2000(l1, l2) {
  const [L1, a1, b1] = l1, [L2, a2, b2] = l2, rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cb, 7) / (Math.pow(Cb, 7) + Math.pow(25, 7))));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (b, a) => { if (!a && !b) return 0; const t = Math.atan2(b, a) / rad; return t < 0 ? t + 360 : t; };
  const h1 = hue(b1, a1p), h2 = hue(b2, a2p);
  const dL = L2 - L1, dC = C2p - C1p;
  let dh = 0; if (C1p * C2p) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(dh * rad / 2);
  const Lb = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hb = h1 + h2; if (C1p * C2p) { if (Math.abs(h1 - h2) > 180) hb += h1 + h2 < 360 ? 360 : -360; hb /= 2; }
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const SL = 1 + 0.015 * (Lb - 50) * (Lb - 50) / Math.sqrt(20 + (Lb - 50) * (Lb - 50)), SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -2 * Math.sqrt(Math.pow(Cbp, 7) / (Math.pow(Cbp, 7) + Math.pow(25, 7))) * Math.sin(60 * Math.exp(-Math.pow((hb - 275) / 25, 2)) * rad);
  return Math.sqrt(Math.pow(dL / SL, 2) + Math.pow(dC / SC, 2) + Math.pow(dH / SH, 2) + RT * (dC / SC) * (dH / SH));
}

const LAB_CACHE = new Map();
function nearestMadeira(hex, catalog) {
  const list = catalog === "polyneon" ? MADEIRA_POLYNEON : MADEIRA_RAYON;
  const h = String(hex || "").replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return list[0] || null;
  const t = hexLab(h);
  const scored = [];
  let bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const hh = String(c.hex || "").replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(hh)) continue;
    let l = LAB_CACHE.get(hh); if (!l) { l = hexLab(hh); LAB_CACHE.set(hh, l); }
    const d = deltaE2000(t, l);
    scored.push([d, c, l]);
    if (d < bestD) bestD = d;
  }
  if (!scored.length) return list[0] || null;
  // near-ties (within 0.5 dE00, below a just-noticeable step): prefer the thread
  // whose hue/chroma (a*, b*) matches best. Dark colours often can't match
  // lightness, and then the hue family decides how it reads (navy stays navy
  // rather than drifting to violet or teal).
  let best = null, bestAb = Infinity;
  for (const [d, c, l] of scored) {
    if (d > bestD + 0.5) continue;
    const ab = Math.hypot(l[1] - t[1], l[2] - t[2]);
    if (ab < bestAb) { bestAb = ab; best = c; }
  }
  return best;
}

module.exports = {
  MADEIRA_RAYON,
  MADEIRA_POLYNEON,
  nearestMadeira,
  deltaE2000,
};
