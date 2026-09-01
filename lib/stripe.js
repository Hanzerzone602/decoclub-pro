"use strict";

const crypto = require("crypto");

const PLANS = {
  trial: { amount: 0, label: "Trial · 7 days" },
  shop: { amount: 7900, label: "Shop · $79/mo" },
  studio: { amount: 14900, label: "Studio · $149/mo" },
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

function priceIdForPlan(plan) {
  return {
    trial: process.env.STRIPE_PRICE_TRIAL || "",
    shop: process.env.STRIPE_PRICE_SHOP || "",
    studio: process.env.STRIPE_PRICE_STUDIO || "",
  }[plan] || "";
}

function planFromPriceId(priceId) {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_TRIAL) return "trial";
  if (priceId === process.env.STRIPE_PRICE_SHOP) return "shop";
  if (priceId === process.env.STRIPE_PRICE_STUDIO) return "studio";
  return null;
}

function billingNotConfigured() {
  const err = new Error("Billing not configured");
  err.status = 501;
  return err;
}

async function createCheckoutSession(plan, user, origin) {
  const spec = PLANS[plan];
  if (!spec) {
    const err = new Error("Unknown plan");
    err.status = 400;
    throw err;
  }
  if (!process.env.STRIPE_SECRET_KEY) throw billingNotConfigured();
  const price = priceIdForPlan(plan);
  if (!price) throw billingNotConfigured();
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("success_url", origin + "/app.html?billing=ok");
  params.set("cancel_url", origin + "/app.html?billing=cancel");
  params.set("client_reference_id", user.id);
  params.set("customer_email", user.email);
  params.set("line_items[0][price]", price);
  params.set("line_items[0][quantity]", "1");
  params.set("metadata[plan]", plan);
  params.set("metadata[user_id]", user.id);
  params.set("subscription_data[metadata][plan]", plan);
  params.set("subscription_data[metadata][user_id]", user.id);
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
  return { mode: "stripe", checkoutUrl: data.url, sessionId: data.id, plan };
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

function applyStripeEvent(db, event) {
  if (!event || !event.type || !event.data) return false;
  const obj = event.data.object || {};
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const user = findUser(db, obj);
    const priceId = obj.metadata && obj.metadata.price_id;
    let plan = (obj.metadata && obj.metadata.plan) || planFromPriceId(priceId);
    if (!plan && obj.display_items && obj.display_items[0] && obj.display_items[0].price) {
      plan = planFromPriceId(obj.display_items[0].price.id);
    }
    if (user && obj.customer) user.stripe_customer_id = obj.customer;
    return setPlan(user, plan);
  }
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
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
  loadEnvFile,
  billingConfigured,
  priceIdForPlan,
  createCheckoutSession,
  verifyStripeSignature,
  applyStripeEvent,
};
