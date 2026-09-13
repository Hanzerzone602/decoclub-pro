"use strict";

const { rasterSize, rasterizePolys, rasterizeLayer, copyMask, knockoutMask, dilate, erode } = require("./geom");
const { contourRun } = require("./run");
const { satinColumns } = require("./satin");
const { tatamiWithUnderlay } = require("./tatami");
const { assemblePattern, colorStopsFromThreads } = require("./pattern");
const { objectsAtSize, scaledMaskFor } = require("./objects");

const DEFAULT_MAX_SIDE = 1400;

function objectMask(obj, widthIn, heightIn, rs) {
  const part = scaledMaskFor(obj, rs.mw, rs.mh);
  if (part) return part;
  if (obj.paths && obj.paths.length) {
    return rasterizeLayer({ paths: obj.paths }, widthIn, heightIn, rs.mw, rs.mh);
  }
  return rasterizePolys(obj.polys, widthIn, heightIn, rs.mw, rs.mh);
}

function stitchObject(obj, widthIn, heightIn, opts) {
  opts = opts || {};
  const rs = rasterSize(widthIn, heightIn, opts.maxSide || DEFAULT_MAX_SIDE);
  let mask = opts.mask || objectMask(obj, widthIn, heightIn, rs);
  const p = obj.params || {};
  const densityMm = opts.densityMm != null ? opts.densityMm : p.densityMm;
  const satinMm = p.satinSpacingMm;
  let points = [];
  if (obj.type === "run") {
    points = contourRun(mask, rs.mw, rs.mh, rs.unitPerPx, { stitchMm: p.stitchMm || 2.4 });
  } else if (obj.type === "satin") {
    const sat = satinColumns(mask, rs.mw, rs.mh, rs.unitPerPx, {
      spacingMm: opts.satinMm != null ? opts.satinMm : (satinMm || 0.4),
      pullMm: p.pullMm,
      underlay: p.underlay,
      outlineLike: !!p.outlineLike,
    });
    points = (sat.underlay || []).concat(sat.stitches || []);
  } else {
    const fill = tatamiWithUnderlay(mask, rs.mw, rs.mh, rs.unitPerPx, {
      pitchMm: densityMm || 0.4,
      staggerMm: 3,
      stitchMm: p.stitchMm || 3.2,
      angleDeg: opts.angleDeg != null ? opts.angleDeg : p.angleDeg,
      pullMm: p.pullMm,
      underlay: p.underlay,
    });
    points = (fill.underlay || []).concat(fill.stitches || []);
  }
  return {
    type: obj.type,
    layerIndex: obj.layerIndex,
    thread: obj.thread,
    unitPerPx: rs.unitPerPx,
    points: points,
    raster: rs,
  };
}

function maybeReverse(pts, lastPt) {
  if (!lastPt || !pts || pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const d0 = Math.hypot(a.x - lastPt.x, a.y - lastPt.y);
  const d1 = Math.hypot(b.x - lastPt.x, b.y - lastPt.y);
  return d1 + 0.4 < d0 ? pts.slice().reverse() : pts;
}

function restitch(pack, sizeOpts) {
  sizeOpts = sizeOpts || {};
  const widthIn = Number(sizeOpts.widthIn) || pack.sourceWidthIn || 1;
  const heightIn = Number(sizeOpts.heightIn) || pack.sourceHeightIn || 1;
  const densityMm = sizeOpts.densityMm != null ? Number(sizeOpts.densityMm) : undefined;
  const satinMm = sizeOpts.satinMm != null ? Number(sizeOpts.satinMm) : undefined;
  const sized = objectsAtSize(pack, widthIn, heightIn);
  const rs = rasterSize(widthIn, heightIn, sizeOpts.maxSide || DEFAULT_MAX_SIDE);
  const layerCache = new Map();
  const masks = sized.objects.map((o) => {
    const part = scaledMaskFor(o, rs.mw, rs.mh);
    if (part) return part;
    if (o.paths && o.paths.length) {
      const key = String(o.layerIndex) + "@" + rs.mw + "x" + rs.mh;
      if (!layerCache.has(key)) {
        layerCache.set(key, rasterizeLayer({ paths: o.paths }, widthIn, heightIn, rs.mw, rs.mh));
      }
      return copyMask(layerCache.get(key));
    }
    return objectMask(o, widthIn, heightIn, rs);
  });
  let lastPt = null;
  const runs = sized.objects.map((o, i) => {
    const params = Object.assign({}, o.params);
    if (densityMm != null) params.densityMm = densityMm;
    if (satinMm != null) params.satinSpacingMm = satinMm;
    const mask = copyMask(masks[i]);
    const keyOf = (obj) => String((obj.thread && obj.thread.code) || "") + "|" + String((obj.thread && obj.thread.hex) || "");
    const myKey = keyOf(o);
    // Knock out later DIFFERENT-color objects (top colors). Same-thread
    // neighbors are adjacent islands, not overlays.
    for (let j = i + 1; j < masks.length; j++) {
      if (keyOf(sized.objects[j]) === myKey) continue;
      knockoutMask(mask, masks[j], rs.mw, rs.mh);
    }
    if (o.type === "satin" && o.params && o.params.outlineLike) {
      const bandPx = Math.max(2, Math.round(1.5 / (rs.unitPerPx * 0.1)));
      for (let j = 0; j < i; j++) {
        if (sized.objects[j].type !== "tatami") continue;
        if (keyOf(sized.objects[j]) === myKey) continue;
        const core = erode(masks[j], rs.mw, rs.mh, bandPx);
        knockoutMask(mask, core, rs.mw, rs.mh);
      }
    }
    const trapped = dilate(mask, rs.mw, rs.mh, 1);
    for (let j = i + 1; j < masks.length; j++) {
      if (keyOf(sized.objects[j]) === myKey) continue;
      knockoutMask(trapped, masks[j], rs.mw, rs.mh);
    }
    const run = stitchObject(Object.assign({}, o, { params: params }), widthIn, heightIn, {
      densityMm: densityMm != null ? densityMm : params.densityMm,
      satinMm: satinMm != null ? satinMm : params.satinSpacingMm,
      angleDeg: sizeOpts.angleDeg,
      maxSide: sizeOpts.maxSide,
      mask: trapped,
    });
    if (run.points && run.points.length) {
      run.points = maybeReverse(run.points, lastPt);
      lastPt = run.points[run.points.length - 1];
    }
    return run;
  }).filter((r) => r.points && r.points.length);
  const pattern = assemblePattern(runs, sizeOpts);
  pattern.widthIn = widthIn;
  pattern.heightIn = heightIn;
  pattern.widthMm = widthIn * 25.4;
  pattern.heightMm = heightIn * 25.4;
  pattern.colorStops = colorStopsFromThreads(pattern.threads);
  pattern.objects = sized.objects.map((o) => ({
    id: o.id,
    layerIndex: o.layerIndex,
    type: o.type,
    thread: o.thread,
    widthMm: o.widthMm,
    areaMm2: o.areaMm2,
  }));
  pattern.densityMm = densityMm != null ? densityMm : (sized.objects[0] && sized.objects[0].params.densityMm);
  pattern.satinMm = satinMm != null ? satinMm : (sized.objects[0] && sized.objects[0].params.satinSpacingMm);
  pattern.fabric = sized.fabric || sizeOpts.fabric || null;
  return pattern;
}

module.exports = { restitch, stitchObject };
