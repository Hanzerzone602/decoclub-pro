"use strict";

const fs = require("fs");
const path = require("path");
const { encodePng, makeRgba, decodePng } = require("./png");

let jpegJs = null;
try { jpegJs = require("jpeg-js"); } catch (e) { jpegJs = null; }

const PUBLIC = path.join(__dirname, "..", "public");
const BLANKS_CATALOG = path.join(PUBLIC, "blanks", "catalog.json");
const BLANKS = ["tee", "hoodie", "hat", "tumbler", "plaque", "sticker", "sign", "hoop"];

let _blankCatalog = null;

function loadBlankCatalog() {
  if (_blankCatalog) return _blankCatalog;
  try {
    _blankCatalog = JSON.parse(fs.readFileSync(BLANKS_CATALOG, "utf8"));
  } catch (e) {
    _blankCatalog = { source: "", count: 0, items: [] };
  }
  return _blankCatalog;
}

function findBlank(id) {
  if (!id) return null;
  const items = loadBlankCatalog().items || [];
  return items.find(function (x) { return x.id === id; }) || null;
}

function searchBlanks(q) {
  const items = loadBlankCatalog().items || [];
  const s = String(q || "").trim().toLowerCase();
  if (!s) return items.slice();
  return items.filter(function (it) {
    const hay = [it.id, it.style, it.style_label, it.color, it.label, it.file]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.indexOf(s) !== -1;
  });
}

function blankPublicUrl(item) {
  if (!item) return null;
  if (item.file) return "/" + String(item.file).replace(/^\/+/, "");
  return null;
}

function methodFamily(method, blank) {
  if (blank && BLANKS.indexOf(blank) !== -1) return blank;
  if (method === "hat") return "hat";
  if (method === "uvdtf" || method === "uv" || method === "sublimation") return "tumbler";
  if (method === "laser") return "plaque";
  if (method === "sticker" || method === "vinyl" || method === "rhinestone") return "sticker";
  if (method === "embroidery" || method === "patch") return "hoop";
  if (method === "sign") return "sign";
  if (method === "apparel") return "tee";
  return "tee";
}

function hexRgb(hex) {
  const h = String(hex || "").replace("#", "");
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function sample(rgba, w, h, x, y) {
  if (x < 0 || y < 0 || x >= w || y >= h) return [0, 0, 0, 0];
  const i = (y * w + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

function blend(dst, i, r, g, b, a) {
  const da = dst[i + 3] / 255;
  const sa = a / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  dst[i] = Math.round((r * sa + dst[i] * da * (1 - sa)) / outA);
  dst[i + 1] = Math.round((g * sa + dst[i + 1] * da * (1 - sa)) / outA);
  dst[i + 2] = Math.round((b * sa + dst[i + 2] * da * (1 - sa)) / outA);
  dst[i + 3] = Math.round(outA * 255);
}

function noiseAt(x, y, seed) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453;
  return n - Math.floor(n);
}

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const hit = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-6) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function ellipse(cx, cy, rx, ry, x, y) {
  const dx = (x - cx) / rx, dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function shade(base, n) {
  return [
    Math.max(0, Math.min(255, base[0] + n)),
    Math.max(0, Math.min(255, base[1] + n)),
    Math.max(0, Math.min(255, base[2] + n)),
  ];
}

function placeArt(dst, dw, dh, art, box, kind) {
  if (!art) return;
  const { width: aw, height: ah, rgba } = art;
  const k = kind || box.kind || "tee";
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const nx = box.w <= 1 ? 0.5 : x / (box.w - 1);
      const ny = box.h <= 1 ? 0.5 : y / (box.h - 1);
      let u = nx, v = ny;
      if (k === "tumbler") {
        const theta = (nx - 0.5) * Math.PI * 0.62;
        const span = Math.sin(Math.PI * 0.31);
        u = (Math.sin(theta) / (span || 1) + 1) / 2;
        v = ny + (0.5 - ny) * 0.08 * Math.cos(theta);
      } else if (k === "hat") {
        const bulge = Math.sin(nx * Math.PI) * 0.18;
        v = ny * (1 - bulge * 0.55) + bulge * 0.12;
        u = 0.5 + (nx - 0.5) * (0.92 + ny * 0.16);
      } else if (k === "tee" || k === "hoodie" || k === "photo") {
        u = nx + Math.sin(ny * 3.2) * 0.018;
        v = ny + Math.sin(nx * Math.PI) * 0.02;
      } else if (k === "plaque" || k === "sign") {
        const scale = 0.88 + ny * 0.14;
        u = 0.5 + (nx - 0.5) / scale;
        v = ny;
      } else if (k === "hoop") {
        const dx = nx - 0.5, dy = ny - 0.5;
        if (dx * dx + dy * dy > 0.25) continue;
        u = nx; v = ny;
      }
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const sx = Math.min(aw - 1, Math.max(0, Math.floor(u * aw)));
      const sy = Math.min(ah - 1, Math.max(0, Math.floor(v * ah)));
      const [r, g, b, a] = sample(rgba, aw, ah, sx, sy);
      if (a < 8) continue;
      const dx = box.x + x;
      const dy = box.y + y;
      if (dx < 0 || dy < 0 || dx >= dw || dy >= dh) continue;
      let shadeMul = 1;
      if (k === "tumbler") shadeMul = 0.78 + Math.pow(Math.max(0, 1 - Math.abs(nx - 0.32) * 3.2), 6) * 0.45;
      else if (k === "tee" || k === "hoodie" || k === "photo") shadeMul = 0.92 + Math.sin(x / 22) * 0.04;
      const di = (dy * dw + dx) * 4;
      const wr = Math.round(r * shadeMul);
      const wg = Math.round(g * shadeMul);
      const wb = Math.round(b * shadeMul);
      blend(dst, di, wr, wg, wb, Math.round(a * (box.alpha == null ? 1 : box.alpha)));
    }
  }
}

function artBox(kind, placement, w, h, sku) {
  const p = placement || "center";
  if (sku && Array.isArray(sku.placements) && sku.placements.length) {
    const hit = sku.placements.find(function (x) { return x.id === p; }) || sku.placements[0];
    return {
      x: Math.round(w * hit.x), y: Math.round(h * hit.y),
      w: Math.round(w * hit.w), h: Math.round(h * hit.h),
      alpha: kind === "tumbler" ? 0.9 : 1,
      kind: kind,
    };
  }
  const boxes = {
    tee: {
      chest: { x: 0.34, y: 0.30, w: 0.32, h: 0.28 },
      left_chest: { x: 0.52, y: 0.28, w: 0.16, h: 0.14 },
      full: { x: 0.28, y: 0.26, w: 0.44, h: 0.50 },
      back: { x: 0.30, y: 0.24, w: 0.40, h: 0.46 },
    },
    hoodie: {
      chest: { x: 0.36, y: 0.36, w: 0.28, h: 0.24 },
      full: { x: 0.30, y: 0.32, w: 0.40, h: 0.42 },
      left_chest: { x: 0.54, y: 0.34, w: 0.14, h: 0.12 },
    },
    hat: { front: { x: 0.38, y: 0.30, w: 0.24, h: 0.16 }, center: { x: 0.38, y: 0.30, w: 0.24, h: 0.16 } },
    tumbler: { wrap: { x: 0.36, y: 0.32, w: 0.28, h: 0.38 }, center: { x: 0.38, y: 0.36, w: 0.24, h: 0.28 } },
    plaque: { center: { x: 0.28, y: 0.36, w: 0.44, h: 0.22 } },
    sticker: { center: { x: 0.28, y: 0.28, w: 0.44, h: 0.44 } },
    sign: { center: { x: 0.22, y: 0.30, w: 0.56, h: 0.36 } },
    hoop: { center: { x: 0.34, y: 0.34, w: 0.32, h: 0.32 } },
  };
  const set = boxes[kind] || boxes.tee;
  const b = set[p] || set.center || set.chest || Object.values(set)[0];
  return {
    x: Math.round(w * b.x), y: Math.round(h * b.y),
    w: Math.round(w * b.w), h: Math.round(h * b.h),
    alpha: kind === "tumbler" ? 0.9 : 1,
    kind: kind,
  };
}

/** Chest region on real flat-front blanks: ~38% width, centered, y~22%, h~32%. */
function photoArtBox(w, h, job) {
  const scalePct = Number(job && job.placement_scale != null ? job.placement_scale : 100);
  const scale = Math.max(0.25, Math.min(2.5, (isFinite(scalePct) ? scalePct : 100) / 100));
  const offX = Number(job && job.placement_offset_x != null ? job.placement_offset_x : 0) || 0;
  const offY = Number(job && job.placement_offset_y != null ? job.placement_offset_y : 0) || 0;
  const baseW = w * 0.38;
  const baseH = h * 0.32;
  const boxW = Math.round(baseW * scale);
  const boxH = Math.round(baseH * scale);
  const cx = w * 0.5 + (offX / 100) * w;
  const cy = h * 0.22 + baseH * 0.5 + (offY / 100) * h;
  return {
    x: Math.round(cx - boxW / 2),
    y: Math.round(cy - boxH / 2),
    w: boxW,
    h: boxH,
    alpha: 1,
    kind: "photo",
  };
}

function renderBlank(kind, w, h, art, garment, placement, sku) {
  const rgba = makeRgba(w, h, [18, 19, 22, 255]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const g = 16 + Math.floor(noiseAt(x, y, 3) * 10) + Math.floor((y / h) * 8);
      const i = (y * w + x) * 4;
      rgba[i] = g; rgba[i + 1] = g + 1; rgba[i + 2] = g + 3; rgba[i + 3] = 255;
    }
  }
  const base = hexRgb(garment) || (kind === "hat" ? [38, 72, 86] : kind === "plaque" ? [92, 54, 28] : [52, 56, 62]);
  const box = artBox(kind, placement, w, h, sku);

  if (kind === "tee" || kind === "hoodie") {
    const poly = kind === "hoodie"
      ? [[w*0.32,h*0.12],[w*0.42,h*0.20],[w*0.58,h*0.20],[w*0.68,h*0.12],[w*0.94,h*0.30],[w*0.82,h*0.40],[w*0.76,h*0.34],[w*0.76,h*0.90],[w*0.24,h*0.90],[w*0.24,h*0.34],[w*0.18,h*0.40],[w*0.06,h*0.30]]
      : [[w*0.34,h*0.16],[w*0.42,h*0.22],[w*0.58,h*0.22],[w*0.66,h*0.16],[w*0.92,h*0.32],[w*0.82,h*0.40],[w*0.74,h*0.34],[w*0.74,h*0.88],[w*0.26,h*0.88],[w*0.26,h*0.34],[w*0.18,h*0.40],[w*0.08,h*0.32]];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inPoly(x, y, poly)) continue;
        const fold = Math.sin(x / 18) * 6 + Math.sin(y / 40) * 8;
        const light = ((x - w * 0.5) / w) * -18 + ((y - h * 0.3) / h) * -12 + fold;
        const n = (noiseAt(x, y, 9) - 0.5) * 14 + light;
        const c = shade(base, n);
        const i = (y * w + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
      }
    }
    if (kind === "hoodie") {
      for (let y = Math.round(h*0.12); y < h*0.28; y++) {
        for (let x = Math.round(w*0.40); x < w*0.60; x++) {
          if (ellipse(w*0.5, h*0.20, w*0.11, h*0.08, x, y)) {
            const c = shade(base, -18);
            const i = (y * w + x) * 4;
            rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
          }
        }
      }
    }
    placeArt(rgba, w, h, art, box, kind);
  } else if (kind === "hat") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const crown = ellipse(w * 0.5, h * 0.42, w * 0.28, h * 0.22, x, y) && y < h * 0.52;
        const bill = ellipse(w * 0.5, h * 0.58, w * 0.38, h * 0.08, x, y) && y > h * 0.50;
        if (!crown && !bill) continue;
        const n = (noiseAt(x, y, 2) - 0.5) * 16 + (bill ? -22 : 6) + ((x - w * 0.5) / w) * -10;
        const c = shade(bill ? shade(base, -24) : base, n);
        const i = (y * w + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
      }
    }
    placeArt(rgba, w, h, art, box, kind);
  } else if (kind === "tumbler") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const body = x > w * 0.32 && x < w * 0.68 && y > h * 0.18 && y < h * 0.86;
        const top = ellipse(w * 0.5, h * 0.18, w * 0.18, h * 0.05, x, y);
        const bot = ellipse(w * 0.5, h * 0.86, w * 0.18, h * 0.05, x, y);
        if (!body && !top && !bot) continue;
        const nx = (x - w * 0.32) / (w * 0.36);
        const spec = Math.pow(Math.max(0, 1 - Math.abs(nx - 0.28) * 4), 8) * 90;
        const n = (noiseAt(x, y, 4) - 0.5) * 8 + spec + (top ? 20 : 0);
        const c = shade(base[0] > 200 ? [186, 190, 196] : base, n);
        const i = (y * w + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
      }
    }
    placeArt(rgba, w, h, art, box, kind);
  } else if (kind === "plaque") {
    const acrylic = base[0] + base[1] + base[2] > 520 || (base[2] > base[0] + 20);
    const metal = base[0] > 140 && Math.abs(base[0] - base[1]) < 18 && Math.abs(base[1] - base[2]) < 22;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x > w * 0.16 && x < w * 0.84 && y > h * 0.28 && y < h * 0.72;
        if (!px) continue;
        const edge = Math.min(x - w * 0.16, w * 0.84 - x, y - h * 0.28, h * 0.72 - y);
        let n;
        if (metal) n = Math.pow(Math.max(0, 1 - Math.abs((x / w) - 0.38) * 5), 10) * 70 + (noiseAt(x, y, 2) - 0.5) * 8;
        else if (acrylic) n = 18 + Math.pow(Math.max(0, 1 - Math.abs((x / w) - 0.62) * 6), 12) * 80 + (edge < 4 ? 24 : 0);
        else n = Math.sin(y / 7 + noiseAt(x, 0, 1) * 4) * 10 + (noiseAt(x * 0.4, y, 6) - 0.5) * 18;
        const c = shade(base, n);
        const i = (y * w + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
      }
    }
    placeArt(rgba, w, h, art, box, kind);
  } else if (kind === "sign") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const board = x > w * 0.12 && x < w * 0.88 && y > h * 0.22 && y < h * 0.78;
        if (!board) continue;
        const n = (noiseAt(x, y, 5) - 0.5) * 10;
        const c = shade(base, n);
        const i = (y * w + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
      }
    }
    placeArt(rgba, w, h, art, box, kind);
  } else if (kind === "hoop") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const outer = ellipse(w * 0.5, h * 0.48, w * 0.32, h * 0.32, x, y);
        const inner = ellipse(w * 0.5, h * 0.48, w * 0.26, h * 0.26, x, y);
        const i = (y * w + x) * 4;
        if (outer && !inner) {
          const c = shade([160, 118, 62], (noiseAt(x, y, 1) - 0.5) * 20);
          rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
        } else if (inner) {
          const c = shade(base[0] > 40 ? base : [240, 236, 228], (noiseAt(x, y, 8) - 0.5) * 8);
          rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
        }
      }
    }
    placeArt(rgba, w, h, art, box, kind);
  } else {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sheet = x > w * 0.18 && x < w * 0.82 && y > h * 0.18 && y < h * 0.82;
        if (!sheet) continue;
        const grid = ((Math.floor(x / 18) + Math.floor(y / 18)) % 2) ? 236 : 228;
        const i = (y * w + x) * 4;
        rgba[i] = grid; rgba[i + 1] = grid - 2; rgba[i + 2] = grid - 6;
      }
    }
    placeArt(rgba, w, h, art, box, kind);
  }

  for (let x = Math.round(w * 0.25); x < w * 0.75; x++) {
    for (let y = Math.round(h * 0.88); y < h * 0.93; y++) {
      const dx = (x - w * 0.5) / (w * 0.25);
      const a = Math.max(0, 1 - dx * dx) * 70;
      blend(rgba, (y * w + x) * 4, 0, 0, 0, a);
    }
  }
  return rgba;
}

function decodeJpegToRgba(buf) {
  if (!jpegJs) throw new Error("jpeg-js not installed");
  const decoded = jpegJs.decode(buf, { useTArray: true, formatAsRGBA: true });
  const rgba = Buffer.from(decoded.data);
  // jpeg-js sometimes leaves odd alpha — force opaque so placeArt does not skip pixels
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { width: decoded.width, height: decoded.height, rgba: rgba };
}

function loadArt(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") {
    try { return decodePng(buf); } catch (e) { return null; }
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    try { return decodeJpegToRgba(buf); } catch (e) { return null; }
  }
  // SVG / other: caller should rasterize first
  try { return decodePng(buf); } catch (e) { return null; }
}




function knockoutNearWhite(art, threshold) {
  if (!art || !art.rgba) return art;
  const t = threshold == null ? 248 : threshold;
  const rgba = Buffer.from(art.rgba);
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] >= t && rgba[i + 1] >= t && rgba[i + 2] >= t) rgba[i + 3] = 0;
  }
  return { width: art.width, height: art.height, rgba: rgba };
}

function prepareArtForPhoto(art) {
  if (!art) return null;
  return knockoutNearWhite(art, 248);
}

function loadBlankImage(relOrAbs) {
  if (!relOrAbs) return null;
  let abs = relOrAbs;
  if (relOrAbs.indexOf("/") === 0 && relOrAbs.indexOf("/blanks/") === 0) {
    abs = path.join(PUBLIC, relOrAbs.replace(/^\//, ""));
  } else if (relOrAbs.indexOf("blanks/") === 0) {
    abs = path.join(PUBLIC, relOrAbs);
  } else if (!path.isAbsolute(relOrAbs)) {
    abs = path.join(PUBLIC, relOrAbs);
  }
  abs = path.normalize(abs);
  if (abs.indexOf(path.normalize(PUBLIC + path.sep + "blanks")) !== 0) return null;
  if (!fs.existsSync(abs)) return null;
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  if (ext === ".png") {
    try { return decodePng(buf); } catch (e) { return null; }
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    try { return decodeJpegToRgba(buf); } catch (e) { return null; }
  }
  return null;
}

function resolveBlankForJob(job) {
  if (!job) return null;
  if (job.blank_id) {
    const hit = findBlank(job.blank_id);
    if (hit) return hit;
  }
  if (job.blank_file) {
    return {
      id: job.blank_id || null,
      label: job.blank_label || job.blank_file,
      file: String(job.blank_file).replace(/^\//, ""),
      source: "ssactivewear",
    };
  }
  return null;
}


function regionMeanLuma(rgba, w, h, box) {
  let sum = 0, n = 0;
  const x0 = Math.max(0, box.x|0), y0 = Math.max(0, box.y|0);
  const x1 = Math.min(w, x0 + (box.w|0)), y1 = Math.min(h, y0 + (box.h|0));
  for (let y = y0; y < y1; y += 3) {
    for (let x = x0; x < x1; x += 3) {
      const i = (y * w + x) * 4;
      sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
      n++;
    }
  }
  return n ? sum / n : 128;
}

function artMeanLuma(art) {
  if (!art || !art.rgba) return 128;
  let sum = 0, n = 0;
  const rgba = art.rgba;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 16) continue;
    sum += 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    n++;
  }
  return n ? sum / n : 128;
}

function fillSoftRect(dst, dw, dh, box, rgb, alpha) {
  const pad = Math.round(Math.min(box.w, box.h) * 0.06);
  const x0 = box.x - pad, y0 = box.y - pad, x1 = box.x + box.w + pad, y1 = box.y + box.h + pad;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x < 0 || y < 0 || x >= dw || y >= dh) continue;
      const i = (y * dw + x) * 4;
      blend(dst, i, rgb[0], rgb[1], rgb[2], alpha);
    }
  }
}

function renderPhotoBlank(blankImg, art, job) {
  const w = blankImg.width;
  const h = blankImg.height;
  const rgba = Buffer.from(blankImg.rgba);
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] === 0) rgba[i] = 255;
  }
  const box = photoArtBox(w, h, job);
  if (art) {
    const blankL = regionMeanLuma(rgba, w, h, box);
    const artL = artMeanLuma(art);
    if (blankL < 70 && artL < 90) {
      fillSoftRect(rgba, w, h, box, [245, 245, 245], 210);
    }
  }
  placeArt(rgba, w, h, art, box, "photo");
  return { width: w, height: h, rgba: rgba };
}

function generateMockupPng(job, artworkAbs, sku) {
  let art = loadArt(artworkAbs);
  const blankMeta = resolveBlankForJob(job);
  if (blankMeta && blankMeta.file) {
    const blankImg = loadBlankImage(blankMeta.file);
    if (blankImg) {
      art = prepareArtForPhoto(art);
      const out = renderPhotoBlank(blankImg, art, job);
      // Visible failure: if no art loaded, stamp a warning so QA does not look like a silent bare shirt
      if (!art) {
        const { width: w, height: h, rgba } = out;
        const msg = "ART MISSING";
        // red bar across chest box
        const box = photoArtBox(w, h, job);
        for (let y = box.y; y < box.y + Math.min(28, box.h); y++) {
          for (let x = box.x; x < box.x + box.w; x++) {
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const i = (y * w + x) * 4;
            rgba[i] = 200; rgba[i + 1] = 40; rgba[i + 2] = 40; rgba[i + 3] = 230;
          }
        }
        job._mockup_art_missing = true;
      } else {
        job._mockup_art_missing = false;
      }
      return encodePng(out.width, out.height, out.rgba);
    }
  }
  const kind = (sku && sku.kind) || methodFamily(job.method, job.blank);
  const w = 720, h = 840;
  const color = job.garment_color || (sku && sku.hex);
  const rgba = renderBlank(kind, w, h, art, color, job.placement, sku);
  return encodePng(w, h, rgba);
}

function generateMockupSvg(job, artworkRel) {
  const blankMeta = resolveBlankForJob(job);
  const href = artworkRel || "";
  if (blankMeta && blankMeta.file) {
    const blankHref = blankPublicUrl(blankMeta);
    const label = (blankMeta.label || blankMeta.id || "blank") + " · S&S blank";
    const scalePct = Number(job.placement_scale != null ? job.placement_scale : 100) || 100;
    const scale = Math.max(0.25, Math.min(2.5, scalePct / 100));
    const offX = Number(job.placement_offset_x != null ? job.placement_offset_x : 0) || 0;
    const offY = Number(job.placement_offset_y != null ? job.placement_offset_y : 0) || 0;
    const bw = 380 * scale;
    const bh = 400 * scale;
    const ax = 500 + (offX / 100) * 1000 - bw / 2;
    const ay = 220 + 200 + (offY / 100) * 1250 - bh / 2;
    const art = href
      ? `<image href="${href}" x="${ax}" y="${ay - 200}" width="${bw}" height="${bh}" preserveAspectRatio="xMidYMid meet"/>`
      : "";
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1250" width="1000" height="1250">
  <rect width="1000" height="1250" fill="#12141a"/>
  <text x="24" y="36" fill="#c9b896" font-size="16" font-family="sans-serif">DecoClub · ${label}</text>
  <image href="${blankHref}" x="0" y="0" width="1000" height="1250" preserveAspectRatio="xMidYMid meet"/>
  ${art}
</svg>`;
  }
  const kind = methodFamily(job.method, job.blank);
  const art = href ? `<image href="${href}" x="0" y="0" width="100" height="70" preserveAspectRatio="xMidYMid meet"/>` : "";
  const label = (job.blank || kind) + " · " + (job.placement || "center") + " · " + (job.garment_color || "default");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 900" width="800" height="900">
  <rect width="800" height="900" fill="#12141a"/>
  <text x="24" y="36" fill="#c9b896" font-size="16" font-family="sans-serif">DecoClub Pro mockup · ${label}</text>
  <g transform="translate(250 280) scale(3)">${art}</g>
</svg>`;
}

function writeMockups(job, uploadsDir, publicArtPath, sku) {
  const absArt = publicArtPath && publicArtPath.indexOf("/uploads/") === 0
    ? path.join(uploadsDir, path.basename(publicArtPath))
    : null;
  const pngName = "mockup-" + job.id.slice(0, 12) + ".png";
  const svgName = "mockup-" + job.id.slice(0, 12) + ".svg";
  fs.writeFileSync(path.join(uploadsDir, pngName), generateMockupPng(job, absArt, sku));
  fs.writeFileSync(path.join(uploadsDir, svgName), generateMockupSvg(job, publicArtPath || ""));
  return { mockup_path: "/uploads/" + pngName, mockup_svg: "/uploads/" + svgName };
}

module.exports = {
  methodFamily, generateMockupPng, generateMockupSvg, writeMockups,
  BLANKS, artBox, photoArtBox, findBlank, searchBlanks, loadBlankCatalog,
  blankPublicUrl, resolveBlankForJob, loadBlankImage,
};
