"use strict";

/* Approximate sRGB hex for common Pantone Matching System (coated) colors.
   Values are industry-common approximations for nearest-match UI — not official Pantone LAB. */
const PANTONE = [
  ["Black C", "#2d2926"],
  ["White", "#ffffff"],
  ["Cool Gray 1 C", "#d9d9d6"],
  ["Cool Gray 3 C", "#c8c9c7"],
  ["Cool Gray 5 C", "#b1b3b3"],
  ["Cool Gray 7 C", "#97999b"],
  ["Cool Gray 9 C", "#75787b"],
  ["Cool Gray 11 C", "#53565a"],
  ["Warm Gray 1 C", "#d7d2cb"],
  ["Warm Gray 3 C", "#bfb8af"],
  ["Warm Gray 5 C", "#aca39a"],
  ["Warm Gray 7 C", "#968c83"],
  ["Warm Gray 9 C", "#83786f"],
  ["Warm Gray 11 C", "#6e6259"],
  ["Process Black C", "#000000"],
  ["Yellow C", "#fedd00"],
  ["Yellow 012 C", "#ffd700"],
  ["Orange 021 C", "#fe5000"],
  ["Warm Red C", "#f9423a"],
  ["Red 032 C", "#ef3340"],
  ["Rubine Red C", "#ce0058"],
  ["Rhodamine Red C", "#e10098"],
  ["Purple C", "#bb29bb"],
  ["Violet C", "#440099"],
  ["Blue 072 C", "#10069f"],
  ["Reflex Blue C", "#001489"],
  ["Process Blue C", "#0085ca"],
  ["Green C", "#00ab84"],
  ["Black 2 C", "#3a332c"],
  ["Black 3 C", "#2f2a26"],
  ["Black 4 C", "#31261d"],
  ["Black 5 C", "#3e2b2e"],
  ["Black 6 C", "#101820"],
  ["Black 7 C", "#3d3935"],
  ["100 C", "#f6eb61"],
  ["102 C", "#fce300"],
  ["107 C", "#fbe122"],
  ["109 C", "#ffd100"],
  ["116 C", "#ffcd00"],
  ["123 C", "#ffc72c"],
  ["1235 C", "#ffb81c"],
  ["130 C", "#f2a900"],
  ["137 C", "#ffa300"],
  ["1375 C", "#ff9e1b"],
  ["144 C", "#ed8b00"],
  ["145 C", "#cf7f00"],
  ["1505 C", "#ff6900"],
  ["151 C", "#ff8200"],
  ["158 C", "#e87722"],
  ["165 C", "#ff671f"],
  ["1655 C", "#fc4c02"],
  ["1665 C", "#dc4405"],
  ["172 C", "#fa4616"],
  ["1788 C", "#ee2737"],
  ["1795 C", "#d22630"],
  ["1797 C", "#cb333b"],
  ["185 C", "#e4002b"],
  ["186 C", "#c8102e"],
  ["187 C", "#a6192e"],
  ["188 C", "#76232f"],
  ["193 C", "#bf0d3e"],
  ["199 C", "#d50032"],
  ["200 C", "#ba0c2f"],
  ["201 C", "#9d2235"],
  ["202 C", "#862633"],
  ["208 C", "#8a1b61"],
  ["213 C", "#e31c79"],
  ["219 C", "#da1884"],
  ["226 C", "#d0006f"],
  ["232 C", "#e45dbf"],
  ["2395 C", "#c6007e"],
  ["240 C", "#c137a1"],
  ["253 C", "#ad1aac"],
  ["2593 C", "#84329b"],
  ["2597 C", "#4b306a"],
  ["2602 C", "#772583"],
  ["2607 C", "#500778"],
  ["2665 C", "#7d55c7"],
  ["2685 C", "#2e1a47"],
  ["2736 C", "#1e22aa"],
  ["2748 C", "#001a72"],
  ["280 C", "#012169"],
  ["281 C", "#00205b"],
  ["285 C", "#0072ce"],
  ["286 C", "#0033a0"],
  ["287 C", "#003087"],
  ["289 C", "#0c2340"],
  ["2925 C", "#009cde"],
  ["2935 C", "#0057b8"],
  ["294 C", "#002d62"],
  ["299 C", "#00a3e0"],
  ["2995 C", "#00a9e0"],
  ["300 C", "#005eb8"],
  ["301 C", "#004b87"],
  ["306 C", "#00b5e2"],
  ["3125 C", "#00c1d5"],
  ["319 C", "#2dccd3"],
  ["320 C", "#0096a1"],
  ["326 C", "#00b2a9"],
  ["3272 C", "#00a499"],
  ["3288 C", "#008578"],
  ["334 C", "#009775"],
  ["3405 C", "#00b140"],
  ["347 C", "#009a44"],
  ["348 C", "#00843d"],
  ["349 C", "#046a38"],
  ["354 C", "#00b74f"],
  ["355 C", "#009639"],
  ["356 C", "#007a33"],
  ["361 C", "#43b02a"],
  ["368 C", "#7ac142"],
  ["375 C", "#97d700"],
  ["376 C", "#84bd00"],
  ["382 C", "#c4d600"],
  ["390 C", "#b5bd00"],
  ["3975 C", "#b4a91f"],
  ["423 C", "#898d8d"],
  ["424 C", "#707372"],
  ["425 C", "#54585a"],
  ["426 C", "#25282a"],
  ["447 C", "#373a36"],
  ["4625 C", "#4f2c1d"],
  ["4635 C", "#946037"],
  ["4645 C", "#ad7c59"],
  ["4655 C", "#bf9474"],
  ["4665 C", "#cda788"],
  ["468 C", "#ddcba4"],
  ["4695 C", "#5b3427"],
  ["476 C", "#4e3629"],
  ["490 C", "#5c2f2d"],
  ["4975 C", "#3f2021"],
  ["505 C", "#702f3b"],
  ["5115 C", "#512a44"],
  ["5185 C", "#4a3041"],
  ["532 C", "#1c252b"],
  ["5395 C", "#00263a"],
  ["5463 C", "#072b31"],
  ["5535 C", "#18332f"],
  ["5605 C", "#1f3227"],
  ["5743 C", "#3e4827"],
  ["5815 C", "#555025"],
  ["7401 C", "#f5e1a4"],
  ["7406 C", "#f1b434"],
  ["7408 C", "#f6be00"],
  ["7412 C", "#d18e2f"],
  ["7417 C", "#e35205"],
  ["7421 C", "#651d32"],
  ["7477 C", "#244c5a"],
  ["7482 C", "#009f4d"],
  ["7499 C", "#f1e6b2"],
  ["7540 C", "#4b4f54"],
  ["7621 C", "#ab2328"],
  ["871 C", "#89734c"],
  ["877 C", "#8a8d8f"],
];

function parseHex(hex) {
  let h = String(hex || "").replace("#", "").trim();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r, g, b) {
  function c(n) {
    const s = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return s.length === 1 ? "0" + s : s;
  }
  return "#" + c(r) + c(g) + c(b);
}

function rgbToCmyk(r, g, b) {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const k = 1 - Math.max(rr, gg, bb);
  if (k >= 0.999) return { c: 0, m: 0, y: 0, k: 100 };
  const c = (1 - rr - k) / (1 - k);
  const m = (1 - gg - k) / (1 - k);
  const y = (1 - bb - k) / (1 - k);
  return {
    c: Math.round(c * 100),
    m: Math.round(m * 100),
    y: Math.round(y * 100),
    k: Math.round(k * 100),
  };
}

function formatCmyk(cmyk) {
  return "C" + cmyk.c + " M" + cmyk.m + " Y" + cmyk.y + " K" + cmyk.k;
}

function formatRgb(rgb) {
  return "R" + rgb[0] + " G" + rgb[1] + " B" + rgb[2];
}

function nearestPantone(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  let best = null, bestD = Infinity;
  for (let i = 0; i < PANTONE.length; i++) {
    const c = parseHex(PANTONE[i][1]);
    if (!c) continue;
    const d = (c[0] - rgb[0]) * (c[0] - rgb[0]) + (c[1] - rgb[1]) * (c[1] - rgb[1]) + (c[2] - rgb[2]) * (c[2] - rgb[2]);
    if (d < bestD) { bestD = d; best = { name: "PMS " + PANTONE[i][0], hex: PANTONE[i][1], dist: d }; }
  }
  return best;
}

function describeColor(hex) {
  const rgb = parseHex(hex) || [17, 17, 17];
  const cmyk = rgbToCmyk(rgb[0], rgb[1], rgb[2]);
  const pantone = nearestPantone(hex);
  const h = rgbToHex(rgb[0], rgb[1], rgb[2]);
  return {
    hex: h,
    rgb: { r: rgb[0], g: rgb[1], b: rgb[2] },
    cmyk: cmyk,
    pantone: pantone ? pantone.name : null,
    pantoneHex: pantone ? pantone.hex : null,
    nameGuess: formatRgb(rgb) + " · " + formatCmyk(cmyk) + (pantone ? " · " + pantone.name : ""),
    labelRgb: formatRgb(rgb),
    labelCmyk: formatCmyk(cmyk),
    labelPantone: pantone ? pantone.name : "—",
  };
}

function annotateLayer(layer) {
  const d = describeColor(layer && layer.hex);
  return Object.assign({}, layer, {
    hex: d.hex,
    nameGuess: d.nameGuess,
    rgb: d.rgb,
    cmyk: d.cmyk,
    pantone: d.pantone,
  });
}

function annotateLayers(layers) {
  return (layers || []).map(annotateLayer);
}

function listPantone() {
  return PANTONE.map(function (row) {
    return { id: "pms-" + row[0].toLowerCase().replace(/\s+/g, "-"), name: "PMS " + row[0], hex: row[1] };
  });
}

module.exports = {
  parseHex: parseHex,
  rgbToHex: rgbToHex,
  rgbToCmyk: rgbToCmyk,
  formatCmyk: formatCmyk,
  formatRgb: formatRgb,
  nearestPantone: nearestPantone,
  describeColor: describeColor,
  annotateLayer: annotateLayer,
  annotateLayers: annotateLayers,
  listPantone: listPantone,
  PANTONE: PANTONE,
};
