"use strict";

const crypto = require("crypto");
const features = require("./features");

const PLANS = {
  trial: { amount: 0, label: "Trial · 7 days", mode: "subscription" },
  shop: { amount: 7900, label: "Shop · $79/mo", mode: "subscription" },
  studio: { amount: 14900, label: "Studio · $149/mo", mode: "subscription" },
};

const PRODUCTS = {
  trial: PLANS.trial,
  shop: PLANS.shop,
  studio: PLANS.studio,
  vector_single: { amount: 300, label: "Vectorize · 1 image", mode: "payment", credits: 1, service: "vectorize" },
  vector_pack10: { amount: 2000, label: "Vectorize · 10 images", mode: "payment", credits: 10, service: "vectorize" },
  halftone_single: { amount: 300, label: "Halftone · 1 image", mode: "payment", credits: 1, service: "halftones" },
  halftone_pack10: { amount: 2000, label: "Halftone · 10 images", mode: "payment", credits: 10, service: "halftones" },
};

function loadEnvFile(root) {
  const fs = require("fs");
  const path = require("path");
  const p = path.join(root, ".env");
  if (!fs.existsSync(p)) return;
  String(fs.readFileSync(p, "utf8")).split(/\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t[0] === "#") return;
    const i = t.indexOf("=");
    if (i < 0) return;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  });
}

function billingConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function isHalftoneProduct(product) {
  return product === "halftone_single" || product === "halftone_pack10";
}

function isCreditProduct(product) {
  return product === "vector_single" || product === "vector_pack10" || isHalftoneProduct(product);
}

function serviceForProduct(product) {
  const spec = PRODUCTS[product];
  if (!spec) return null;
  if (spec.service === "vectorize" || spec.service === "halftones") return spec.service;
  return null;
}

function creditFieldForService(service) {
  if (service === "vectorize") return "vector_credits";
  if (service === "halftones") return "halftone_credits";
  return null;
}

function checkoutQuantity(product, opts) {
  let q = Math.floor(Number(opts && opts.quantity));
  if (!Number.isFinite(q) || q < 1) q = 1;
  if (q > 50) q = 50;
  if (!isCreditProduct(product) || product === "vector_pack10" || product === "halftone_pack10") q = 1;
  return q;
}

function isKnownProduct(product) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, product);
}

function creditsForProduct(product) {
  const spec = PRODUCTS[product];
  return spec && spec.credits ? Number(spec.credits) : 0;
}

function priceIdForPlan(plan) {
  return priceIdForProduct(plan);
}

function priceIdForProduct(product) {
  return {
    trial: process.env.STRIPE_PRICE_TRIAL || "",
    shop: process.env.STRIPE_PRICE_SHOP || "",
    studio: process.env.STRIPE_PRICE_STUDIO || "",
    halftone_single: process.env.STRIPE_PRICE_HALFTONE_SINGLE || "",
    halftone_pack10: process.env.STRIPE_PRICE_HALFTONE_PACK10 || "",
  }[product] || "";
}

function planFromPriceId(priceId) {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_TRIAL) return "trial";
  if (priceId === process.env.STRIPE_PRICE_SHOP) return "shop";
  if (priceId === process.env.STRIPE_PRICE_STUDIO) return "studio";
  if (priceId === process.env.STRIPE_PRICE_HALFTONE_SINGLE) return "halftone_single";
  if (priceId === process.env.STRIPE_PRICE_HALFTONE_PACK10) return "halftone_pack10";
  return null;
}

function billingNotConfigured() {
  const err = new Error("Billing not configured");
  err.status = 501;
  return err;
}

async function createCheckoutSession(product, user, origin, opts) {
  opts = opts || {};
  const spec = PRODUCTS[product];
  if (!spec) {
    const err = new Error("Unknown plan");
    err.status = 400;
    throw err;
  }
  if (!process.env.STRIPE_SECRET_KEY) throw billingNotConfigured();
  const credit = isCreditProduct(product);
  const quantity = checkoutQuantity(product, opts);
  const params = new URLSearchParams();
  const mode = credit ? "payment" : (spec.mode || "subscription");
  params.set("mode", mode);
  params.set("success_url", credit ? (origin + "/app.html?billing=ok&product=" + product) : (origin + "/app.html?billing=ok"));
  params.set("cancel_url", origin + "/app.html?billing=cancel");
  params.set("client_reference_id", user.id);
  params.set("customer_email", user.email);
  params.set("metadata[product]", product);
  params.set("metadata[user_id]", user.id);
  if (credit) {
    const unit = opts.amountCents != null && opts.amountCents !== "" ? Math.round(Number(opts.amountCents)) : spec.amount;
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][unit_amount]", String(unit));
    params.set("line_items[0][price_data][product_data][name]", "DecoClub Pro — " + spec.label);
    params.set("line_items[0][quantity]", String(quantity));
    params.set("metadata[service]", spec.service || "");
    params.set("metadata[credits]", String((spec.credits || 0) * quantity));
  } else {
    const price = priceIdForProduct(product);
    if (!price) throw billingNotConfigured();
    params.set("line_items[0][price]", price);
    params.set("line_items[0][quantity]", "1");
    params.set("metadata[plan]", product);
    params.set("subscription_data[metadata][plan]", product);
    params.set("subscription_data[metadata][user_id]", user.id);
  }
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error && data.error.message ? data.error.message : "Stripe error");
  return { mode: "stripe", checkoutUrl: data.url, sessionId: data.id, plan: credit ? null : product, product: product };
}

function verifyStripeSignature(raw, header, secret) {
  const parts = String(header || "").split(",");
  let t = "";
  let v1 = "";
  parts.forEach((p) => {
    const s = p.trim();
    if (s.indexOf("t=") === 0) t = s.slice(2);
    if (s.indexOf("v1=") === 0) v1 = s.slice(3);
  });
  if (!t || !v1 || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(t + "." + (Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw))).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function findUser(db, session) {
  const meta = session.metadata || {};
  const id = meta.user_id || session.client_reference_id;
  if (!id) return null;
  return db.users.find((u) => u.id === id) || null;
}

function setPlan(user, plan) {
  if (!user || ["trial", "shop", "studio"].indexOf(plan) === -1) return false;
  user.plan = plan;
  user.plan_expires = plan === "trial" ? new Date(Date.now() + 7 * 864e5).toISOString() : null;
  return true;
}

function grantHalftoneCredits(user, n) {
  if (!user) return false;
  const add = Math.max(0, Math.floor(Number(n) || 0));
  if (!add) return false;
  user.halftone_credits = Math.max(0, Math.floor(Number(user.halftone_credits) || 0)) + add;
  return true;
}

function grantVectorCredits(user, n) {
  if (!user) return false;
  const add = Math.max(0, Math.floor(Number(n) || 0));
  if (!add) return false;
  user.vector_credits = Math.max(0, Math.floor(Number(user.vector_credits) || 0)) + add;
  return true;
}

function grantServiceCredits(user, service, n) {
  if (service === "vectorize") return grantVectorCredits(user, n);
  if (service === "halftones") return grantHalftoneCredits(user, n);
  return false;
}

function creditsFromMetadata(meta, product) {
  if (meta && meta.credits != null && meta.credits !== "") {
    const n = Number(meta.credits);
    if (Number.isInteger(n) && n > 0 && n <= 500) return n;
  }
  return creditsForProduct(product);
}

function creditPaymentOk(obj) {
  const status = obj ? obj.payment_status : undefined;
  if (status == null || status === "") return true;
  return status === "paid" || status === "no_payment_required";
}

function stripeEvents(db) {
  if (!db.stripe_events || !Array.isArray(db.stripe_events)) db.stripe_events = [];
  return db.stripe_events;
}

function stripeEventSeen(db, key) {
  if (!key) return false;
  return stripeEvents(db).indexOf(String(key)) !== -1;
}

function rememberStripeEvent(db, key) {
  if (!key) return;
  const id = String(key);
  const list = stripeEvents(db);
  if (list.indexOf(id) !== -1) return;
  list.push(id);
  if (list.length > 500) list.splice(0, list.length - 500);
}

function resolveCheckoutProduct(obj) {
  const meta = (obj && obj.metadata) || {};
  if (meta.product && isKnownProduct(meta.product)) return meta.product;
  if (meta.plan && isKnownProduct(meta.plan)) return meta.plan;
  const priceId = meta.price_id;
  let fromPrice = planFromPriceId(priceId);
  if (fromPrice) return fromPrice;
  if (obj.display_items && obj.display_items[0] && obj.display_items[0].price) {
    fromPrice = planFromPriceId(obj.display_items[0].price.id);
    if (fromPrice) return fromPrice;
  }
  if (obj.line_items && obj.line_items.data && obj.line_items.data[0] && obj.line_items.data[0].price) {
    fromPrice = planFromPriceId(obj.line_items.data[0].price.id);
    if (fromPrice) return fromPrice;
  }
  return null;
}

function applyStripeEvent(db, event) {
  if (!event || !event.type || !event.data) return false;
  const obj = event.data.object || {};
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const user = findUser(db, obj);
    if (user && obj.customer) user.stripe_customer_id = obj.customer;
    const product = resolveCheckoutProduct(obj);
    if (isCreditProduct(product)) {
      // Unpaid checkout.session.completed waits for async_payment_succeeded.
      if (!creditPaymentOk(obj)) return false;
      const key = obj.id ? String(obj.id) : "";
      if (key && stripeEventSeen(db, key)) return false;
      const meta = obj.metadata || {};
      const service = serviceForProduct(product) || ((meta.service === "vectorize" || meta.service === "halftones") ? meta.service : null);
      const granted = grantServiceCredits(user, service, creditsFromMetadata(meta, product));
      if (granted && key) rememberStripeEvent(db, key);
      return granted;
    }
    if (!features.membershipEnabled()) return false;
    const key = obj.id ? String(obj.id) : "";
    if (key && stripeEventSeen(db, key)) return false;
    const ok = setPlan(user, product);
    if (ok && key) rememberStripeEvent(db, key);
    return ok;
  }
  if (event.type === "payment_intent.succeeded") {
    const meta = obj.metadata || {};
    const product = meta.product || null;
    // Checkout always emits checkout.session.completed. Granting here would double-charge credits.
    if (isCreditProduct(product)) return false;
    return false;
  }
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
    if (!features.membershipEnabled()) return false;
    const meta = obj.metadata || {};
    let user = meta.user_id ? db.users.find((u) => u.id === meta.user_id) : null;
    if (!user && obj.customer) user = db.users.find((u) => u.stripe_customer_id === obj.customer) || null;
    const item = obj.items && obj.items.data && obj.items.data[0];
    const plan = meta.plan || planFromPriceId(item && item.price && item.price.id);
    return setPlan(user, plan);
  }
  return false;
}

module.exports = {
  PLANS,
  PRODUCTS,
  loadEnvFile,
  billingConfigured,
  priceIdForPlan,
  priceIdForProduct,
  isHalftoneProduct,
  isCreditProduct,
  serviceForProduct,
  creditFieldForService,
  isKnownProduct,
  creditsForProduct,
  grantHalftoneCredits,
  grantVectorCredits,
  grantServiceCredits,
  createCheckoutSession,
  verifyStripeSignature,
  applyStripeEvent,
};
