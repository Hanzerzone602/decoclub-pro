"use strict";

const fs = require("fs");
const path = require("path");
const { nearestMadeira } = require("./madeira");
const { buildObjects } = require("./stitch/objects");
const { restitch } = require("./stitch/restitch");
const { stitchPreviewSvg, previewPayload, renderTrueviewPng } = require("./stitch/preview");
const { writeDst, writeExp, exportPattern, UNIT_PER_IN } = require("./stitch/export");
const { vectorFromInput, hasRealPaths, layersFromSvg, hoopFromImage, ensurePng } = require("./stitch/fromImage");
const { fabricPreset, wqFabric, WQ_FABRIC_LIST } = require("./stitch/fabric");
const { digitizeWQ, isPrepped } = require("./stitch/wq");

const MACHINE_SPM = 750;      // average sewing speed for run-time estimate
const TRIM_SEC = 6, COLOR_SEC = 20;

function summarize(stitches, threads, widthIn, heightIn) {
  let st = 0, trims = 0, colors = 0, jumps = 0;
  (stitches || []).forEach((s) => {
    if (s.kind === "stitch") st++;
    else if (s.kind === "trim") trims++;
    else if (s.kind === "color") colors++;
    else if (s.kind === "jump") jumps++;
  });
  const runMinutes = st / MACHINE_SPM + (trims * TRIM_SEC + colors * COLOR_SEC) / 60;
  return {
    stitchCount: st, trims, colorChanges: colors, jumps, colours: (threads || []).length,
    runMinutes: Math.round(runMinutes * 10) / 10,
    widthIn: Math.round(widthIn * 100) / 100, heightIn: Math.round(heightIn * 100) / 100,
    widthMm: Math.round(widthIn * 254) / 10, heightMm: Math.round(heightIn * 254) / 10,
  };
}

function digitizeLayersWQ(vector, opts) {
  const widthIn = Number(opts.widthIn || vector.widthIn || vector.width_in) || 1;
  const heightIn = Number(opts.heightIn || vector.heightIn || vector.height_in) || 1;
  let layers = vector.layers || [];
  if ((!layers.length || !hasRealPaths(vector)) && vector.svg) {
    const parsed = layersFromSvg(vector.svg, widthIn, heightIn);
    if (parsed.layers && parsed.layers.length) vector = Object.assign({}, vector, parsed);
  }
  // swap requests are by colour index (layerIndex of colorStops)
  const r = digitizeWQ(vector, widthIn, heightIn, {
    fabric: opts.fabric, angleDeg: opts.angleDeg, madeiraCatalog: opts.madeiraCatalog || "rayon", density: opts.density, satinSpacingMm: opts.satinSpacingMm,
    maxColors: opts.maxColors || (isPrepped(vector) ? undefined : threadCapForSize(widthIn, heightIn)), keepBackground: opts.keepBackground, underlapMm: opts.underlapMm,
    maxSide: opts.maxSide,
  });
  (opts.threads || []).forEach((t) => {
    r.threads.forEach((th) => {
      if (Number(t.layerIndex) !== th.layerIndex) return;
      const made = t.code ? null : (t.hex ? nearestMadeira(t.hex, opts.madeiraCatalog || "rayon") : null);
      if (t.code) { th.code = String(t.code); if (t.hex) th.hex = t.hex; if (t.name) th.name = t.name; }
      else if (made) { th.code = made.code; th.hex = made.hex; th.name = made.name; th.brand = made.brand; }
    });
  });
  const pattern = {
    stitches: r.stitches, threads: r.threads, widthIn, heightIn, widthMm: widthIn * 25.4, heightMm: heightIn * 25.4,
    stitchCount: r.stitches.filter((s) => s.kind === "stitch").length, objects: r.objects,
  };
  pattern.colorStops = r.threads.map((t, i) => ({ hex: t.hex, name: t.name, index: t.layerIndex != null ? t.layerIndex : i, madeiraCode: t.code, madeiraBrand: t.brand, sourceHex: t.sourceHex || t.hex, type: t.type }));
  const name = String(opts.name || "DESIGN").slice(0, 16);
  let dst = Buffer.alloc(0), exp = Buffer.alloc(0), pes = Buffer.alloc(0), exporter = "preview";
  if (!opts.previewOnly) {
    const files = exportPattern(pattern, name, { pes: opts.pes !== false });
    dst = files.dst; exp = files.exp; pes = files.pes || Buffer.alloc(0); exporter = files.exporter;
  }
  const fab = wqFabric(opts.fabric);
  const summary = summarize(r.stitches, r.threads, widthIn, heightIn);
  summary.fabric = fab.id;
  summary.fabricLabel = fab.label;
  return {
    dst, exp, pes,
    previewSvg: stitchPreviewSvg(pattern.stitches, widthIn, heightIn, pattern.colorStops),
    preview: previewPayload(pattern),
    stitchCount: pattern.stitchCount,
    colorStops: pattern.colorStops,
    stitches: pattern.stitches,
    objects: r.objects,
    exporter, usedFallback: false, widthIn, heightIn,
    densityMm: fab.fillSpacingMm, satinMm: fab.satinSpacingMm,
    fabric: fab.id, source: vector.source || null, vectorLayers: (vector.layers || []).length,
    warnings: r.warnings, textWarnings: r.textWarnings || [], minRecommendedWidthIn: r.minRecommendedWidthIn == null ? null : r.minRecommendedWidthIn, summary, fabricsAvailable: WQ_FABRIC_LIST.map((f) => f.id), engine: "wq",
  };
}

function loadVectorize() {
  try { return require("./vectorize"); } catch (e) { return null; }
}

function rectangleVector(widthIn, heightIn, hex, name) {
  const vz = loadVectorize();
  if (vz && vz.rectangleLayers) return vz.rectangleLayers(widthIn, heightIn, hex, name);
  const w = Number(widthIn) || 1;
  const h = Number(heightIn) || 1;
  return {
    widthIn: w,
    heightIn: h,
    layers: [{
      hex: hex || "#111111",
      nameGuess: name || "Fill",
      paths: [{ d: "M 0 0 L " + w + " 0 L " + w + " " + h + " L 0 " + h + " Z", hole: false }],
    }],
  };
}

function isOpenPath(p) {
  if (!p || p.hole || typeof p.d !== "string") return false;
  return p.open === true || (!/[zZ]/.test(p.d) && p.open !== false);
}
// Thread-colour cap by finished size: ~7 threads at 4 in, fewer when smaller
// (3 at <=1 in, max 8). Smallest / nearest-colour regions fold into neighbours.
function threadCapForSize(widthIn, heightIn) {
  const L = Math.max(Number(widthIn) || 0, Number(heightIn) || 0);
  return Math.max(3, Math.min(8, Math.round(2.5 + 1.1 * L)));
}
// Drop needle moves shorter than minU (0.1 mm units) measured from the last
// kept needle point; jumps/trims/colour changes reset the reference.
function dropShortStitches(stitches, minU) {
  const out = [];
  let last = null;
  (stitches || []).forEach((s) => {
    const k = s.kind || s.cmd;
    if (k !== "stitch") { out.push(s); if (k === "jump") last = { x: s.x, y: s.y }; else if (k !== "trim") last = last; return; }
    if (last && Math.hypot(s.x - last.x, s.y - last.y) < minU) return;
    out.push(s); last = { x: s.x, y: s.y };
  });
  return out;
}
function digitizeLayers(vector, opts) {
  opts = Object.assign({}, opts || {});
  // prepped vectors carry their fabric (tee->jersey, polo->pique, towel->fleece)
  if (!opts.fabric && vector && vector.fabric) opts.fabric = vector.fabric;
  const engine = String(opts.engine || process.env.DIGITIZE_ENGINE || "wq").toLowerCase();
  if (engine !== "legacy") return digitizeLayersWQ(vector, opts);
  const widthIn = Number(opts.widthIn || vector.widthIn || vector.width_in) || 1;
  const heightIn = Number(opts.heightIn || vector.heightIn || vector.height_in) || 1;
  let layers = vector.layers || [];
  if ((!layers.length || !hasRealPaths(vector)) && vector.svg) {
    const parsed = layersFromSvg(vector.svg, widthIn, heightIn);
    if (parsed.layers && parsed.layers.length) {
      layers = parsed.layers;
      vector = Object.assign({}, vector, parsed);
    }
  }
  // open centreline paths (kind run / open:true / no closepath) are lines, never
  // fills: the legacy rasteriser would fill them solid, so leave them out here
  // (the default wq engine sews them as running/bean stitches).
  layers = layers.map((L) => Object.assign({}, L, { paths: (L.paths || []).filter((p) => !isOpenPath(p)) })).filter((L) => L.paths.length);
  const pack = buildObjects(layers, vector.widthIn || vector.width_in || widthIn, vector.heightIn || vector.height_in || heightIn, {
    density: opts.density,
    satinMm: opts.satinMm,
    satinSpacingMm: opts.satinSpacingMm,
    madeiraCatalog: opts.madeiraCatalog || "rayon",
    threads: opts.threads,
    typeOverrides: opts.typeOverrides,
    angleDeg: opts.angleDeg,
    fabric: opts.fabric,
    maxSide: opts.maxSide || 1400,
    sourceRgba: vector.sourceRgba || opts.sourceRgba,
    sourceW: vector.sourceW || opts.sourceW,
    sourceH: vector.sourceH || opts.sourceH,
    prepped: isPrepped(vector),
  });
  let pattern = restitch(pack, {
    widthIn: widthIn,
    heightIn: heightIn,
    densityMm: opts.density,
    satinMm: opts.satinSpacingMm,
    angleDeg: opts.angleDeg,
    maxSide: opts.maxSide || 1400,
    fabric: opts.fabric,
  });
  let usedFallback = false;
  const realArt = hasRealPaths({ layers: layers }) || (pack.objects && pack.objects.length > 0);
  if (pattern.stitchCount < 12 && layers.length && !realArt && opts.allowRectangleFallback !== false) {
    usedFallback = true;
    const fallback = rectangleVector(widthIn, heightIn, (layers[0] && layers[0].hex) || "#111111", "Fill");
    const pack2 = buildObjects(fallback.layers, widthIn, heightIn, {
      density: opts.density,
      satinMm: opts.satinMm,
      madeiraCatalog: opts.madeiraCatalog || "rayon",
      fabric: opts.fabric,
    });
    const again = restitch(pack2, { widthIn: widthIn, heightIn: heightIn, densityMm: opts.density });
    if (again.stitchCount > pattern.stitchCount) pattern = again;
  }
  if (usedFallback) {
    console.warn("[digitize] thin art produced <12 stitches; used rectangle fill fallback");
  } else if (pattern.stitchCount < 12 && realArt) {
    console.warn("[digitize] real art produced <12 stitches — NOT replacing with a rectangle");
  }
  // final pass: no needle move under 0.3 mm (merged into the next stitch)
  pattern = Object.assign({}, pattern, { stitches: dropShortStitches(pattern.stitches, 3) });
  pattern.stitchCount = pattern.stitches.filter((s) => (s.kind || s.cmd) === "stitch").length;
  const name = String(opts.name || "DESIGN").slice(0, 16);
  let dst = Buffer.alloc(0), exp = Buffer.alloc(0), pes = Buffer.alloc(0), exporter = "preview";
  if (!opts.previewOnly) {
    const files = exportPattern(pattern, name, { pes: !!opts.pes });
    dst = files.dst;
    exp = files.exp;
    pes = files.pes || Buffer.alloc(0);
    exporter = files.exporter;
  }
  const previewSvg = stitchPreviewSvg(pattern.stitches, widthIn, heightIn, pattern.colorStops);
  const preview = previewPayload(pattern);
  return {
    dst: dst,
    exp: exp,
    pes: pes,
    previewSvg: previewSvg,
    preview: preview,
    stitchCount: pattern.stitchCount,
    colorStops: pattern.colorStops,
    stitches: pattern.stitches,
    objects: pattern.objects,
    exporter: exporter,
    usedFallback: usedFallback,
    widthIn: widthIn,
    heightIn: heightIn,
    densityMm: pattern.densityMm,
    satinMm: pattern.satinMm,
    fabric: pattern.fabric || opts.fabric || null,
    source: vector.source || null,
    vectorLayers: layers.length,
  };
}

function digitizeImage(bufOrPath, opts) {
  opts = opts || {};
  let buf = bufOrPath;
  if (typeof bufOrPath === "string") buf = fs.readFileSync(bufOrPath);
  if (!Buffer.isBuffer(buf)) throw new Error("digitizeImage needs a file path or buffer");
  let w = Number(opts.widthIn) || 0;
  let h = Number(opts.heightIn) || 0;
  if (!w || !h) {
    const hoop = hoopFromImage(buf, opts.longIn || 3);
    w = w || hoop.widthIn;
    h = h || hoop.heightIn;
  }
  const vec = vectorFromInput(buf, w, h, opts);
  const srcW = Number(vec.widthIn) || w;
  const srcH = Number(vec.heightIn) || h;
  const long = Math.max(w, h);
  const vLong = Math.max(srcW, srcH) || long;
  const uni = long / vLong;
  return digitizeLayers(vec, Object.assign({}, opts, {
    widthIn: srcW * uni,
    heightIn: srcH * uni,
  }));
}

function loadArtwork(job, uploadsDir) {
  if (!job || !job.file_path || !uploadsDir) return null;
  const abs = path.join(uploadsDir, path.basename(job.file_path));
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

function vectorFromJob(job, buf, uploadsDir) {
  if (job && job.vector && hasRealPaths(job.vector)) return job.vector;
  const w = Number(job && job.width_in) || 3;
  const h = Number(job && job.height_in) || w;
  if (job && job.vector && job.vector.svg) {
    const parsed = layersFromSvg(job.vector.svg, w, h);
    if (parsed.layers.length) return parsed;
  }
  if (job && job.vector_svg) {
    try {
      let svg = job.vector_svg;
      if (typeof svg === "string" && svg.indexOf("<svg") !== -1) {
        const parsed = layersFromSvg(svg, w, h);
        if (parsed.layers.length) return parsed;
      } else if (uploadsDir) {
        const abs = path.join(uploadsDir, path.basename(String(svg)));
        if (fs.existsSync(abs)) {
          const text = fs.readFileSync(abs, "utf8");
          const parsed = layersFromSvg(text, w, h);
          if (parsed.layers.length) return parsed;
        }
      }
    } catch (e) { /* fall through */ }
  }
  const vz = loadVectorize();
  if (vz && vz.jobVectorOrTrace) {
    const vec = vz.jobVectorOrTrace(job, buf);
    if (vec && hasRealPaths(vec)) return vec;
  }
  if (buf) {
    try {
      return vectorFromInput(buf, w, h, {});
    } catch (e) { /* raster-only */ }
  }
  return null;
}

// digitize_prep (lib/digitize_prep.py): raster -> embroidery-ready layers
// (colour cap, underlap, run/satin/fill kinds, text warnings) for the wq
// engine. Opt-in per call (the Digitize route); exports keep the job vector.
const PREP_SCRIPT = path.join(__dirname, "digitize_prep.py");
const PREP_FABRIC = { tee: "tee", jersey: "tee", knit: "tee", tshirt: "tee", shirt: "tee", polo: "polo", pique: "polo", cap: "cap", hat: "cap", towel: "towel", terry: "towel", fleece: "towel", sweat: "towel", sweatshirt: "towel", hoodie: "towel", woven: "woven", twill: "woven", denim: "woven", poplin: "woven", canvas: "woven" };
function prepPythons() {
  return [process.env.DIGITIZE_PYTHON, process.env.INVENT_WARP_PYTHON, "/venv/bin/python3", "python3"].filter(Boolean);
}
function prepVectorFromFile(imgPath, widthIn, fabric) {
  if (!imgPath || !fs.existsSync(imgPath) || !fs.existsSync(PREP_SCRIPT)) return null;
  const { spawnSync } = require("child_process");
  const os = require("os");
  const fab = PREP_FABRIC[String(fabric || "tee").toLowerCase().replace(/[^a-z]/g, "")] || "tee";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-prep-"));
  const out = path.join(tmp, "prep.json");
  try {
    for (const py of prepPythons()) {
      const r = spawnSync(py, [PREP_SCRIPT, "-q", "-i", imgPath, "--width-in", String(widthIn), "--fabric", fab, "--late-colors", "all", "-o", out], {
        encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      });
      if (r.status === 0 && fs.existsSync(out)) {
        const v = JSON.parse(fs.readFileSync(out, "utf8"));
        if (!v || !Array.isArray(v.layers) || !v.layers.length) return null;
        if (Array.isArray(v.sourceRgba)) v.sourceRgba = Buffer.from(v.sourceRgba);
        v.prepVersion = v.prepVersion || "digitize_prep";
        return v;
      }
      if (r.error && r.error.code === "ENOENT") continue;
      if (r.status != null) break; // the script ran and failed: don't retry with another python
    }
  } catch (e) { /* fall back to the job vector */ } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
  return null;
}

function digitizeJob(job, uploadsDir, opts) {
  opts = opts || {};
  if (opts.recolorOnly) {
    const stops = recolorStops(job.colorStops || [], opts.threads || []);
    return {
      colorStops: stops,
      stitchCount: job.stitchCount || 0,
      recolored: true,
      dst: Buffer.alloc(0),
      exp: Buffer.alloc(0),
      previewSvg: "",
      preview: null,
      objects: job.digitizeObjects || [],
      exporter: job.digitizeExporter || "none",
    };
  }
  const buf = loadArtwork(job, uploadsDir);
  const w = Number(opts.widthIn || job.width_in) || 1;
  const h = Number(opts.heightIn || job.height_in) || 1;
  const engine = String(opts.engine || process.env.DIGITIZE_ENGINE || "wq").toLowerCase();
  let vec = null, dw = w, dh = h;
  if (opts.prep === true && engine !== "legacy" && buf && job.file_path) {
    vec = prepVectorFromFile(path.join(uploadsDir, path.basename(job.file_path)), w, opts.fabric);
    if (vec) { dw = Number(vec.widthIn) || w; dh = Number(vec.heightIn) || h; }
  }
  if (!vec) vec = vectorFromJob(job, buf, uploadsDir);
  if (!vec || !vec.layers || !vec.layers.length) {
    vec = rectangleVector(w, h, "#111111", "Fill");
  }
  const name = String(job.title || job.id || "DESIGN").replace(/[^\w\- ]+/g, "").slice(0, 16) || "DESIGN";
  return digitizeLayers(vec, {
    name: name,
    widthIn: dw,
    heightIn: dh,
    satinMm: opts.satinMm,
    satinSpacingMm: opts.satinSpacingMm,
    density: opts.density,
    threads: opts.threads,
    typeOverrides: opts.typeOverrides,
    previewOnly: opts.previewOnly,
    madeiraCatalog: opts.madeiraCatalog,
    angleDeg: opts.angleDeg,
    fabric: opts.fabric,
    pes: opts.pes,
    engine: opts.engine,
    maxColors: opts.maxColors,
  });
}

function recolorStops(colorStops, swaps) {
  return (colorStops || []).map((s, i) => {
    const hit = (swaps || []).find((t) => Number(t.layerIndex) === (s.index != null ? s.index : i) || Number(t.index) === i);
    if (!hit) return s;
    if (hit.code || hit.hex) {
      const made = hit.code ? null : nearestMadeira(hit.hex, "rayon");
      return Object.assign({}, s, {
        hex: hit.hex || (made && made.hex) || s.hex,
        name: hit.name || (made && made.name) || s.name,
        madeiraCode: hit.code || (made && made.code) || s.madeiraCode,
        madeiraBrand: hit.brand || (made && made.brand) || s.madeiraBrand,
      });
    }
    return s;
  });
}

module.exports = {
  digitizeJob,
  digitizeLayers,
  digitizeImage,
  writeDst,
  writeExp,
  UNIT_PER_IN,
  buildObjects,
  restitch,
  recolorStops,
  nearestMadeira,
  fabricPreset,
  renderTrueviewPng,
  summarize,
  WQ_FABRIC_LIST,
  prepVectorFromFile,
};
