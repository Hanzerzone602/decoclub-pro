"use strict";

const { UNIT_PER_IN } = require("./geom");

const JUMP_MM = 12;
const JUMP_U = JUMP_MM * 10;
const TIE_MM = 0.45;

function toUnits(pt, unitPerPx) {
  return { x: Math.round(pt.x * unitPerPx), y: Math.round(pt.y * unitPerPx) };
}

function tieStitches(origin, toward, unitPerPx) {
  const o = toUnits(origin, unitPerPx);
  const t = toUnits(toward, unitPerPx);
  let dx = t.x - o.x, dy = t.y - o.y;
  const len = Math.hypot(dx, dy) || 1;
  const tu = TIE_MM * 10;
  dx = (dx / len) * tu;
  dy = (dy / len) * tu;
  return [
    { kind: "stitch", x: Math.round(o.x + dx), y: Math.round(o.y + dy) },
    { kind: "stitch", x: o.x, y: o.y },
    { kind: "stitch", x: Math.round(o.x + dx * 0.5), y: Math.round(o.y + dy * 0.5) },
    { kind: "stitch", x: o.x, y: o.y },
  ];
}

function appendRun(out, pts, unitPerPx, lastRef) {
  if (!pts || !pts.length) return lastRef;
  let last = lastRef;
  pts.forEach((p, i) => {
    const u = toUnits(p, unitPerPx);
    const dist = last ? Math.hypot(u.x - last.x, u.y - last.y) : JUMP_U + 1;
    const kind = (!last || p.jump || i === 0 || dist > JUMP_U) ? "jump" : "stitch";
    const rec = { kind: kind, x: u.x, y: u.y };
    if (kind === "jump" && last) {
      out.push({ kind: "jump", x: u.x, y: u.y });
    } else {
      out.push(rec);
    }
    last = rec;
  });
  return last;
}

function assemblePattern(objectRuns, opts) {
  opts = opts || {};
  const out = [];
  const threads = [];
  let last = null;
  let lastThreadKey = null;
  objectRuns.forEach((run, ri) => {
    const th = run.thread || { hex: "#111111", name: "Thread", code: "", brand: "madeira-rayon" };
    const key = String(th.code || "") + "|" + String(th.hex || "");
    if (key !== lastThreadKey) {
      threads.push({
        hex: th.hex,
        code: th.code,
        name: th.name,
        brand: th.brand,
        layerIndex: run.layerIndex,
        type: run.type,
        sourceHex: th.sourceHex || th.hex,
      });
      if (out.length) {
        if (last) out.push({ kind: "trim", x: last.x, y: last.y });
        out.push({ kind: "color", x: last ? last.x : 0, y: last ? last.y : 0 });
      }
      lastThreadKey = key;
    } else if (out.length && last) {
      out.push({ kind: "trim", x: last.x, y: last.y });
    }
    const unitPerPx = run.unitPerPx;
    const pts = run.points || [];
    if (!pts.length) return;
    if (pts.length >= 2) {
      const ties = tieStitches(pts[0], pts[1], unitPerPx);
      last = appendRun(out, [pts[0]], unitPerPx, last);
      ties.forEach((t) => { out.push(t); last = t; });
    }
    last = appendRun(out, pts, unitPerPx, last);
    if (pts.length >= 2) {
      const ties = tieStitches(pts[pts.length - 1], pts[pts.length - 2], unitPerPx);
      ties.forEach((t) => { out.push(t); last = t; });
    }
    if (last) out.push({ kind: "trim", x: last.x, y: last.y });
  });
  const stitchCount = out.filter((s) => s.kind === "stitch").length;
  return {
    stitches: out,
    threads: threads,
    stitchCount: stitchCount,
    unitsPerIn: UNIT_PER_IN,
  };
}

function colorStopsFromThreads(threads) {
  return (threads || []).map((t, i) => ({
    hex: t.hex,
    name: t.name,
    index: t.layerIndex != null ? t.layerIndex : i,
    madeiraCode: t.code,
    madeiraBrand: t.brand,
    sourceHex: t.sourceHex || t.hex,
    type: t.type,
  }));
}

module.exports = {
  assemblePattern,
  colorStopsFromThreads,
  toUnits,
  JUMP_U,
  UNIT_PER_IN,
};
