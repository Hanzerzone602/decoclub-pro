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

/**
 * WQ engine fabric presets (reviewer checklist): fabric sets underlay weight,
 * density and pull compensation. Knits/pique/fleece/towel are one underlay
 * step heavier than wovens; towel adds a knockdown base.
 */
const WQ_FABRICS = {
  tee:    { id: "tee",    label: "T-shirt (jersey knit)", pullSatinMm: 0.35, pullFillMm: 0.22, fillSpacingMm: 0.42, satinSpacingMm: 0.40, fillStitchMm: 3.6, underlayStep: 1, knockdown: false },
  polo:   { id: "polo",   label: "Polo (pique knit)",     pullSatinMm: 0.38, pullFillMm: 0.25, fillSpacingMm: 0.42, satinSpacingMm: 0.40, fillStitchMm: 3.6, underlayStep: 1, knockdown: false },
  fleece: { id: "fleece", label: "Fleece / sweatshirt",   pullSatinMm: 0.40, pullFillMm: 0.28, fillSpacingMm: 0.40, satinSpacingMm: 0.40, fillStitchMm: 3.6, underlayStep: 1, knockdown: false },
  towel:  { id: "towel",  label: "Towel / terry",         pullSatinMm: 0.40, pullFillMm: 0.28, fillSpacingMm: 0.40, satinSpacingMm: 0.40, fillStitchMm: 3.6, underlayStep: 1, knockdown: true },
  cap:    { id: "cap",    label: "Cap (structured twill)", pullSatinMm: 0.25, pullFillMm: 0.20, fillSpacingMm: 0.42, satinSpacingMm: 0.40, fillStitchMm: 3.5, underlayStep: 0, knockdown: false },
  woven:  { id: "woven",  label: "Woven / twill / denim", pullSatinMm: 0.20, pullFillMm: 0.18, fillSpacingMm: 0.45, satinSpacingMm: 0.40, fillStitchMm: 3.8, underlayStep: 0, knockdown: false },
};
const WQ_ALIASES = { jersey: "tee", knit: "tee", tshirt: "tee", shirt: "tee", pique: "polo", sweat: "fleece", sweatshirt: "fleece", hoodie: "fleece", terry: "towel", twill: "woven", poplin: "woven", denim: "woven", canvas: "woven" };
function wqFabric(id) {
  const key = String(id || "tee").toLowerCase().replace(/[^a-z]/g, "");
  return WQ_FABRICS[key] || WQ_FABRICS[WQ_ALIASES[key]] || WQ_FABRICS.tee;
}
const WQ_FABRIC_LIST = Object.keys(WQ_FABRICS).map((k) => ({ id: k, label: WQ_FABRICS[k].label }));

module.exports = { FABRICS, fabricPreset, applyFabric, WQ_FABRICS, WQ_FABRIC_LIST, wqFabric };
