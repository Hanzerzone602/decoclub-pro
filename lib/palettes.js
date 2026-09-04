"use strict";

const { listPantone } = require("./colorspec");

function C(id, name, hex) {
  return { id: id, name: name, hex: hex };
}

const VINYL = [
  C("vinyl-black", "Midnight Black", "#121212"),
  C("vinyl-white", "Studio White", "#f6f6f4"),
  C("vinyl-navy", "Harbor Navy", "#102a56"),
  C("vinyl-royal", "Robot Blue", "#017ece"),
  C("vinyl-sky", "Press Sky", "#5aa8e8"),
  C("vinyl-orange", "Heat Orange", "#eb7925"),
  C("vinyl-red", "Banner Red", "#c4281c"),
  C("vinyl-maroon", "Maroon Peak", "#6e1b2a"),
  C("vinyl-gold", "Athletic Gold", "#e2b007"),
  C("vinyl-yellow", "Sun Yellow", "#f5d442"),
  C("vinyl-lime", "Field Lime", "#8fbf3f"),
  C("vinyl-kelly", "Kelly Green", "#1f8a3b"),
  C("vinyl-forest", "Forest Cover", "#163d28"),
  C("vinyl-teal", "Teal Current", "#1a7a7a"),
  C("vinyl-purple", "Regal Purple", "#5b2d8e"),
  C("vinyl-violet", "Violet Arc", "#7a4bb5"),
  C("vinyl-pink", "Hot Pink", "#e23a8a"),
  C("vinyl-blush", "Blush Tape", "#f0a3c0"),
  C("vinyl-silver", "Silver Foil", "#c5c9ce"),
  C("vinyl-grey", "Shop Grey", "#6d737a"),
  C("vinyl-charcoal", "Charcoal", "#3a3f45"),
  C("vinyl-brown", "Saddle Brown", "#6b3b1f"),
  C("vinyl-cream", "Cream Stock", "#efe6d2"),
  C("vinyl-clear", "Clear Carrier", "#e8eef4"),
];

const THREAD = [
  C("th-navy", "Navy", "#0d2a5b"),
  C("th-royal", "Royal", "#1a4ea3"),
  C("th-robot", "Robot Blue", "#017ece"),
  C("th-sky", "Sky", "#6eb4e6"),
  C("th-teal", "Teal", "#157a86"),
  C("th-black", "Black", "#111111"),
  C("th-charcoal", "Charcoal", "#3c4148"),
  C("th-grey", "Light Grey", "#b4b8be"),
  C("th-white", "White", "#f4f4f2"),
  C("th-red", "Fire Red", "#c81d1d"),
  C("th-cardinal", "Cardinal", "#8e1b2a"),
  C("th-maroon", "Maroon", "#64182a"),
  C("th-orange", "Heat Orange", "#eb7925"),
  C("th-gold", "Athletic Gold", "#d9a400"),
  C("th-yellow", "Maize", "#efd24a"),
  C("th-lime", "Neon Lime", "#b6ee3a"),
  C("th-kelly", "Kelly", "#1e8f3c"),
  C("th-forest", "Forest", "#1a4a2c"),
  C("th-olive", "Olive", "#6b7a32"),
  C("th-brown", "Brown", "#5c3a22"),
  C("th-tan", "Tan", "#c9a27a"),
  C("th-pink", "Pink", "#e85a9b"),
  C("th-hotpink", "Hot Pink", "#ff3d8e"),
  C("th-purple", "Purple", "#5c2d91"),
  C("th-lavender", "Lavender", "#a78bcb"),
  C("th-turquoise", "Turquoise", "#2eb7c0"),
  C("th-neon-orange", "Neon Orange", "#ff6a13"),
  C("th-neon-yellow", "Neon Yellow", "#e8ff3a"),
  C("th-neon-green", "Neon Green", "#39e36a"),
  C("th-metallic-gold", "Metallic Gold", "#c6a03a"),
  C("th-metallic-silver", "Metallic Silver", "#b8bec6"),
  C("th-cream", "Cream", "#efe4c8"),
];

const STONE = [
  C("st-crystal", "Crystal", "#eef4f8"),
  C("st-ab-crystal", "AB Crystal", "#d9f0ff"),
  C("st-jet", "Jet", "#1a1a1c"),
  C("st-hyacinth", "Hyacinth", "#e36b1e"),
  C("st-sapphire", "Sapphire", "#1c4ea8"),
  C("st-light-sapphire", "Light Sapphire", "#5e8fd6"),
  C("st-emerald", "Emerald", "#1d7a45"),
  C("st-peridot", "Peridot", "#8fbf3a"),
  C("st-rose", "Rose", "#e05a86"),
  C("st-light-rose", "Light Rose", "#f0a0b8"),
  C("st-siam", "Siam", "#a31b28"),
  C("st-ruby", "Ruby", "#c2183a"),
  C("st-amethyst", "Amethyst", "#6b3a9b"),
  C("st-topaz", "Topaz", "#d9a21b"),
  C("st-citrine", "Citrine", "#efc94a"),
  C("st-aquamarine", "Aquamarine", "#6fd0d4"),
  C("st-montana", "Montana", "#1b2f5c"),
  C("st-jonquil", "Jonquil", "#f3d56a"),
  C("st-olivine", "Olivine", "#6a8f3a"),
  C("st-black-diamond", "Black Diamond", "#4a4e55"),
];

const PROCESS = [
  C("pr-cyan", "Process Cyan", "#00adee"),
  C("pr-magenta", "Process Magenta", "#ec008c"),
  C("pr-yellow", "Process Yellow", "#fff200"),
  C("pr-black", "Process Black", "#1a1a1a"),
  C("pr-red", "Process Red", "#ed1c24"),
  C("pr-green", "Process Green", "#00a651"),
  C("pr-blue", "Process Blue", "#0054a6"),
  C("pr-orange", "Process Orange", "#f26522"),
  C("pr-white", "Process White", "#ffffff"),
  C("pr-grey", "Process Grey", "#808285"),
];

const PALETTES = {
  vinyl: VINYL,
  thread: THREAD,
  stone: STONE,
  process: PROCESS,
};

function parseHex(hex) {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function nearestNamed(hex, palette) {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  let list = palette;
  if (typeof palette === "string") list = PALETTES[palette];
  if (!Array.isArray(list) || !list.length) {
    list = VINYL.concat(THREAD);
  }
  let best = list[0], bestD = Infinity;
  for (let i = 0; i < list.length; i++) {
    const c = parseHex(list[i].hex);
    if (!c) continue;
    const d = (c[0] - rgb[0]) * (c[0] - rgb[0]) + (c[1] - rgb[1]) * (c[1] - rgb[1]) + (c[2] - rgb[2]) * (c[2] - rgb[2]);
    if (d < bestD) { bestD = d; best = list[i]; }
  }
  return best;
}

function listPalettes() {
  return {
    pantone: listPantone(),
    vinyl: VINYL.map((c) => Object.assign({}, c)),
    thread: THREAD.map((c) => Object.assign({}, c)),
    stone: STONE.map((c) => Object.assign({}, c)),
    process: PROCESS.map((c) => Object.assign({}, c)),
  };
}

function hexRgb(hex) {
  return parseHex(hex);
}

module.exports = {
  VINYL,
  THREAD,
  STONE,
  PROCESS,
  nearestNamed,
  listPalettes,
  hexRgb,
};
