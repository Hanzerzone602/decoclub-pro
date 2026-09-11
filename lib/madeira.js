"use strict";
const fs = require("fs");
const path = require("path");

function loadJson(name) {
  const p = path.join(__dirname, "..", "data", "palettes", name);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const MADEIRA_RAYON = loadJson("madeira-rayon.json");
const MADEIRA_POLYNEON = loadJson("madeira-polyneon.json");

function nearestMadeira(hex, catalog) {
  const list = catalog === "polyneon" ? MADEIRA_POLYNEON : MADEIRA_RAYON;
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6) return list[0] || null;
  const rgb = [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  let best = list[0], bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const hh = String(c.hex || "").replace("#", "");
    if (hh.length !== 6) continue;
    const cr = parseInt(hh.slice(0,2),16), cg = parseInt(hh.slice(2,4),16), cb = parseInt(hh.slice(4,6),16);
    const d = (cr-rgb[0])**2 + (cg-rgb[1])**2 + (cb-rgb[2])**2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

module.exports = {
  MADEIRA_RAYON,
  MADEIRA_POLYNEON,
  nearestMadeira,
};
