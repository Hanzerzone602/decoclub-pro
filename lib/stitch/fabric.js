"use strict";

/**
 * Apparel fabric presets — pull compensation + underlay, not Wilcom's tables.
 * Density is held in mm; pull shifts penetrations along the stitch axis.
 */
const FABRICS = {
  knit: {
    id: "knit",
    label: "Knit / jersey",
    pullSatinMm: 0.26,
    pullFillMm: 0.22,
    underlaySatin: ["edge-run", "zigzag"],
    underlayFill: ["edge-run", "zigzag"],
    densityScale: 1.0,
  },
  jersey: {
    id: "jersey",
    label: "T-shirt jersey",
    pullSatinMm: 0.24,
    pullFillMm: 0.20,
    underlaySatin: ["edge-run", "zigzag"],
    underlayFill: ["edge-run", "zigzag"],
    densityScale: 1.0,
  },
  woven: {
    id: "woven",
    label: "Woven / poplin",
    pullSatinMm: 0.12,
    pullFillMm: 0.10,
    underlaySatin: ["edge-run"],
    underlayFill: ["edge-run"],
    densityScale: 0.95,
  },
  twill: {
    id: "twill",
    label: "Twill / chino",
    pullSatinMm: 0.18,
    pullFillMm: 0.15,
    underlaySatin: ["edge-run", "zigzag"],
    underlayFill: ["edge-run", "zigzag"],
    densityScale: 1.0,
  },
  pique: {
    id: "pique",
    label: "Pique / polo",
    pullSatinMm: 0.30,
    pullFillMm: 0.26,
    underlaySatin: ["edge-run", "zigzag"],
    underlayFill: ["edge-run", "zigzag"],
    densityScale: 1.05,
  },
  fleece: {
    id: "fleece",
    label: "Fleece / sweat",
    pullSatinMm: 0.38,
    pullFillMm: 0.32,
    underlaySatin: ["edge-run", "zigzag"],
    underlayFill: ["edge-run", "zigzag"],
    densityScale: 1.12,
  },
  cap: {
    id: "cap",
    label: "Cap front",
    pullSatinMm: 0.22,
    pullFillMm: 0.18,
    underlaySatin: ["edge-run", "zigzag"],
    underlayFill: ["edge-run", "zigzag"],
    densityScale: 1.08,
  },
};

function fabricPreset(id) {
  if (!id) return null;
  const key = String(id).toLowerCase().replace(/[^a-z]/g, "");
  return FABRICS[key] || null;
}

function applyFabric(params, type, fabric) {
  const p = Object.assign({}, params);
  if (!fabric) return p;
  if (type === "satin") {
    p.pullMm = fabric.pullSatinMm;
    p.underlay = fabric.underlaySatin.slice();
  } else if (type === "tatami") {
    p.pullMm = fabric.pullFillMm;
    p.underlay = fabric.underlayFill.slice();
    if (fabric.densityScale && p.densityMm) p.densityMm = p.densityMm / fabric.densityScale;
  } else {
    p.pullMm = (fabric.pullFillMm || 0.15) * 0.5;
  }
  p.fabric = fabric.id;
  return p;
}

module.exports = { FABRICS, fabricPreset, applyFabric };
