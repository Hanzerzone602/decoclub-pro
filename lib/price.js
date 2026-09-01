"use strict";

const RATES = {
  dtf: 1.15,
  uvdtf: 1.35,
  laser: 0.85,
  sticker: 0.55,
  hat: 2.4,
  apparel: 1.6,
  patch: 1.9,
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

module.exports = { RATES, priceJob };
