"use strict";

const fs = require("fs");
const path = require("path");

const CATALOG_PATH = path.join(__dirname, "..", "data", "catalog.json");

const PLACES = {
  tee: [
    { id: "chest", x: 0.34, y: 0.30, w: 0.32, h: 0.28 },
    { id: "left_chest", x: 0.52, y: 0.28, w: 0.16, h: 0.14 },
    { id: "full", x: 0.28, y: 0.26, w: 0.44, h: 0.50 },
    { id: "back", x: 0.30, y: 0.24, w: 0.40, h: 0.46 },
  ],
  hoodie: [
    { id: "chest", x: 0.36, y: 0.36, w: 0.28, h: 0.24 },
    { id: "full", x: 0.30, y: 0.32, w: 0.40, h: 0.42 },
    { id: "left_chest", x: 0.54, y: 0.34, w: 0.14, h: 0.12 },
  ],
  hat: [
    { id: "front", x: 0.38, y: 0.30, w: 0.24, h: 0.16 },
    { id: "center", x: 0.38, y: 0.30, w: 0.24, h: 0.16 },
  ],
  tumbler: [
    { id: "wrap", x: 0.36, y: 0.32, w: 0.28, h: 0.38 },
    { id: "center", x: 0.38, y: 0.36, w: 0.24, h: 0.28 },
  ],
  plaque: [{ id: "center", x: 0.28, y: 0.36, w: 0.44, h: 0.22 }],
  sticker: [{ id: "center", x: 0.28, y: 0.28, w: 0.44, h: 0.44 }],
  sign: [{ id: "center", x: 0.22, y: 0.30, w: 0.56, h: 0.36 }],
  hoop: [{ id: "center", x: 0.34, y: 0.34, w: 0.32, h: 0.32 }],
};

const COLORS = [
  ["Black", "#1a1a1a"], ["White", "#f4f4f0"], ["Navy", "#1b2a4a"], ["Royal", "#2a4db3"],
  ["Red", "#b91c1c"], ["Athletic Heather", "#9aa0a6"], ["Dark Heather Grey", "#4b4f54"],
  ["Charcoal", "#3a3d40"], ["Forest Green", "#1f4a32"], ["Maroon", "#6b1c2a"],
  ["Gold", "#c9a227"], ["Orange", "#d45a12"], ["Purple", "#4b2d73"], ["Safety Green", "#b6e000"],
  ["Safety Orange", "#ff6a00"], ["Sand", "#cbb79a"], ["Light Blue", "#7eb6d4"], ["Cardinal", "#8b1e3f"],
  ["Kelly", "#2e8b57"], ["Pink", "#e89bb5"], ["Brown", "#5c3a21"], ["Lime", "#8fd14f"],
  ["Turquoise", "#2aa3a3"], ["Natural", "#e8dcc8"], ["Jet Black", "#0d0d0d"], ["Ash", "#d5d2cc"],
];

const STYLES = [
  { code: "PC54", name: "Port & Company Essential Tee", kind: "tee", methods: ["dtf", "apparel", "vinyl"] },
  { code: "PC61", name: "Port & Company Core Cotton Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "PC54LS", name: "Port & Company Long Sleeve Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "PC55", name: "Port & Company 50/50 Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "PC61LS", name: "Port & Company Core Cotton Long Sleeve", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "2000", name: "Gildan Ultra Cotton Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "2000L", name: "Gildan Ultra Cotton Ladies Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "5000", name: "Gildan Heavy Cotton Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "64000", name: "Gildan Softstyle Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "8000", name: "Gildan DryBlend Crewneck", kind: "hoodie", methods: ["dtf", "apparel"] },
  { code: "18000", name: "Gildan Heavy Blend Hoodie", kind: "hoodie", methods: ["dtf", "apparel"] },
  { code: "18500", name: "Gildan Heavy Blend Crew", kind: "hoodie", methods: ["dtf", "apparel"] },
  { code: "18600", name: "Gildan Heavy Blend Sweatpants", kind: "hoodie", methods: ["dtf", "apparel"] },
  { code: "PC78H", name: "Port & Company Core Fleece Hoodie", kind: "hoodie", methods: ["dtf", "apparel"] },
  { code: "PC90H", name: "Port & Company Essential Fleece Hoodie", kind: "hoodie", methods: ["dtf", "apparel"] },
  { code: "PC78", name: "Port & Company Core Fleece Crew", kind: "hoodie", methods: ["dtf", "apparel"] },
  { code: "ST850", name: "Sport-Tek Pullover Hooded Sweatshirt", kind: "hoodie", methods: ["dtf", "apparel"] },
  { code: "C112", name: "Port Authority Snapback Trucker Cap", kind: "hat", methods: ["hat", "embroidery", "patch"] },
  { code: "C851", name: "Port Authority Flexfit Cap", kind: "hat", methods: ["hat", "embroidery"] },
  { code: "C808", name: "Port Authority Sandwich Bill Cap", kind: "hat", methods: ["hat", "embroidery"] },
  { code: "C914", name: "Port Authority Performance Cap", kind: "hat", methods: ["hat", "embroidery"] },
  { code: "STC19", name: "Sport-Tek Dry Zone Nylon Cap", kind: "hat", methods: ["hat", "embroidery"] },
  { code: "K500", name: "Port Authority Silk Touch Polo", kind: "tee", methods: ["embroidery", "apparel"] },
  { code: "K500LS", name: "Port Authority Silk Touch Long Sleeve Polo", kind: "tee", methods: ["embroidery", "apparel"] },
  { code: "ST650", name: "Sport-Tek PosiCharge Polo", kind: "tee", methods: ["embroidery", "dtf"] },
  { code: "J317", name: "Port Authority Core Soft Shell Jacket", kind: "hoodie", methods: ["embroidery", "apparel"] },
  { code: "J330", name: "Port Authority Core Soft Shell Vest", kind: "hoodie", methods: ["embroidery"] },
  { code: "TLJ920", name: "Port Authority Torrent Waterproof Jacket", kind: "hoodie", methods: ["embroidery"] },
  { code: "DT6000", name: "District Very Important Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "DT104", name: "District Perfect Blend Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "PC450", name: "Port & Company Fan Favorite Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "PC099", name: "Port & Company Beach Wash Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "NL6210", name: "Next Level Premium CVC Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "3001", name: "Bella+Canvas Unisex Jersey Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "3413", name: "Bella+Canvas Triblend Tee", kind: "tee", methods: ["dtf", "apparel"] },
  { code: "PC61Y", name: "Port & Company Youth Core Cotton Tee", kind: "tee", methods: ["dtf", "apparel"] },
];

function sku(code, name, kind, color, hex, methods) {
  return {
    code: code,
    name: name,
    kind: kind,
    color: color,
    hex: hex,
    placements: (PLACES[kind] || PLACES.tee).map(function (p) { return { id: p.id, x: p.x, y: p.y, w: p.w, h: p.h }; }),
    methods: methods.slice(),
  };
}

function buildCatalog() {
  const out = [];
  const seen = {};
  function add(item) {
    if (seen[item.code] || out.length >= 1000) return;
    seen[item.code] = true;
    out.push(item);
  }

  STYLES.forEach(function (st) {
    COLORS.forEach(function (c) {
      if (out.length >= 700) return;
      const slug = c[0].replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
      add(sku(st.code + "-" + slug, st.name + " — " + c[0], st.kind, c[0], c[1], st.methods));
    });
  });

  const plaqueFinishes = [
    ["Walnut", "#5c3a21"], ["Cherry", "#7a2e1f"], ["Maple", "#c4a574"], ["Oak", "#b08958"],
    ["Black Acrylic", "#141414"], ["Clear Acrylic", "#d7e4ee"], ["White Acrylic", "#f2f2f0"],
    ["Brushed Aluminum", "#b8bec6"], ["Black Anodized", "#1c1c1e"], ["Gold Plate", "#c9a227"],
  ];
  const plaqueSizes = ["4x6", "5x7", "6x8", "8x10", "11x14"];
  plaqueSizes.forEach(function (sz) {
    plaqueFinishes.forEach(function (f) {
      const slug = f[0].replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
      add(sku("DC-LASER-PLAQUE-" + sz.toUpperCase() + "-" + slug, "DecoClub laser plaque " + sz + " — " + f[0], "plaque", f[0], f[1], ["laser"]));
    });
  });

  const tumblerSizes = ["15", "20", "30", "SKINNY20"];
  tumblerSizes.forEach(function (sz) {
    COLORS.forEach(function (c) {
      const slug = c[0].replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
      add(sku("DC-TUMBLER-" + sz + "-" + slug, "DecoClub tumbler " + sz + "oz — " + c[0], "tumbler", c[0], c[1], ["uvdtf", "sublimation", "uv"]));
    });
  });

  ["Gloss", "Matte", "Holo", "Clear", "WhiteVinyl", "Transparent"].forEach(function (fin, i) {
    ["3x3", "4x4", "sheet8x10", "kisscut"].forEach(function (sz) {
      const hex = ["#f4f4f0", "#e8e4dc", "#d0c4e8", "#d7eef4", "#f7f7f7", "#cfd8dc"][i];
      add(sku("DC-STICKER-" + sz.toUpperCase() + "-" + fin.toUpperCase(), "DecoClub sticker " + sz + " — " + fin, "sticker", fin, hex, ["sticker", "vinyl"]));
    });
  });

  ["ACM", "Corrugated", "Acrylic", "PVC", "Dibond"].forEach(function (mat) {
    COLORS.slice(0, 12).forEach(function (c) {
      const slug = c[0].replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
      add(sku("DC-SIGN-" + mat.toUpperCase() + "-" + slug, "DecoClub " + mat + " sign — " + c[0], "sign", c[0], c[1], ["sign", "uv", "vinyl"]));
    });
  });

  ["4IN", "5IN", "6IN"].forEach(function (sz) {
    COLORS.slice(0, 16).forEach(function (c) {
      const slug = c[0].replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
      add(sku("DC-HOOP-" + sz + "-" + slug, "DecoClub embroidery hoop " + sz + " — " + c[0], "hoop", c[0], c[1], ["embroidery", "patch"]));
    });
  });

  let n = 1;
  while (out.length < 1000) {
    const c = COLORS[(n - 1) % COLORS.length];
    const slug = c[0].replace(/[^A-Za-z0-9]+/g, "").toUpperCase();
    add(sku("DC-LASER-TAG-" + String(n).padStart(3, "0") + "-" + slug, "DecoClub laser tag " + n + " — " + c[0], "plaque", c[0], c[1], ["laser"]));
    n += 1;
    if (n > 500) break;
  }
  return out.slice(0, 1000);
}

function writeCatalog() {
  const items = buildCatalog();
  fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(items));
  return items;
}

let cache = null;
function loadCatalog() {
  if (cache) return cache;
  if (!fs.existsSync(CATALOG_PATH)) cache = writeCatalog();
  else {
    cache = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
    if (!Array.isArray(cache) || cache.length !== 1000) cache = writeCatalog();
  }
  return cache;
}

function findSku(code) {
  if (!code) return null;
  const c = String(code).toUpperCase();
  return loadCatalog().find(function (s) { return s.code.toUpperCase() === c; }) || null;
}

function searchCatalog(q) {
  const items = loadCatalog();
  if (!q) return items;
  const n = String(q).toLowerCase();
  return items.filter(function (s) {
    return (s.code + " " + s.name + " " + s.color + " " + s.kind).toLowerCase().indexOf(n) !== -1;
  });
}

module.exports = { CATALOG_PATH, loadCatalog, findSku, searchCatalog, writeCatalog, PLACES };
