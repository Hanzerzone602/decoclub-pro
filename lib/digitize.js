"use strict";

const fs = require("fs");
const path = require("path");
const { nearestMadeira } = require("./madeira");
const { buildObjects } = require("./stitch/objects");
const { restitch } = require("./stitch/restitch");
const { stitchPreviewSvg, previewPayload, renderTrueviewPng } = require("./stitch/preview");
const { writeDst, writeExp, exportPattern, UNIT_PER_IN } = require("./stitch/export");
const { vectorFromInput, hasRealPaths, layersFromSvg, hoopFromImage, ensurePng } = require("./stitch/fromImage");
const { fabricPreset } = require("./stitch/fabric");

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

function digitizeLayers(vector, opts) {
  opts = opts || {};
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
  let vec = vectorFromJob(job, buf, uploadsDir);
  if (!vec || !vec.layers || !vec.layers.length) {
    vec = rectangleVector(w, h, "#111111", "Fill");
  }
  const name = String(job.title || job.id || "DESIGN").replace(/[^\w\- ]+/g, "").slice(0, 16) || "DESIGN";
  return digitizeLayers(vec, {
    name: name,
    widthIn: w,
    heightIn: h,
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
};
