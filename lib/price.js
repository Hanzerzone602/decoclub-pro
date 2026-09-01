"use strict";

const RATES = {
  dtf: 1.15,
  uvdtf: 1.35,
  laser: 0.85,
  sticker: 0.55,
  hat: 2.4,
  apparel: 1.6,
  patch: 1.9,
  vinyl: 0.45,
  embroidery: 2.1,
  sublimation: 1.05,
  rhinestone: 1.8,
  uv: 1.35,
  sign: 0.95,
};


function priceJob(job) {
  const width = Number(job.width_in);
  const height = Number(job.height_in);
  const area = Math.max(1, (Number.isFinite(width) ? width : 0) * (Number.isFinite(height) ? height : 0));
  const rate = RATES[job.method] || 1;
  const unit = Math.round((2.5 + area * rate) * 100) / 100;
  const q = Math.max(1, Number(job.qty) || 1);
  let total = unit * q;
  if (q >= 25) total *= 0.82;
  else if (q >= 10) total *= 0.9;
  return { unit_price: unit, total: Math.round(total * 100) / 100 };
}

function priceQuote(job) {
  const rawItems = Array.isArray(job.line_items) && job.line_items.length
    ? job.line_items
    : [{
        desc: job.title || job.method || "Deco",
        method: job.method || "dtf",
        width_in: job.width_in,
        height_in: job.height_in,
        qty: job.qty,
      }];
  const line_items = rawItems.map((it, idx) => {
    const p = priceJob(it);
    return {
      id: it.id || String(idx + 1),
      desc: it.desc || it.method || "Line",
      method: it.method || job.method || "dtf",
      width_in: Number(it.width_in) || Number(job.width_in) || 10,
      height_in: Number(it.height_in) || Number(job.height_in) || 10,
      qty: Math.max(1, Number(it.qty) || 1),
      unit_price: p.unit_price,
      total: p.total,
    };
  });
  const subtotal = Math.round(line_items.reduce((s, it) => s + it.total, 0) * 100) / 100;
  const margin_pct = Number(job.margin_pct);
  const margin = Number.isFinite(margin_pct) ? margin_pct : 0;
  const margin_amount = Math.round(subtotal * (margin / 100) * 100) / 100;
  const total = Math.round((subtotal + margin_amount) * 100) / 100;
  const qty = line_items.reduce((s, it) => s + it.qty, 0) || 1;
  return {
    line_items,
    subtotal,
    margin_pct: margin,
    margin_amount,
    total,
    unit_price: Math.round((total / qty) * 100) / 100,
  };
}

module.exports = { RATES, priceJob, priceQuote };
