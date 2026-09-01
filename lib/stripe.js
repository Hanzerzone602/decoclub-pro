"use strict";

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

async function createCheckoutSession(plan, user, origin) {
  const spec = PLANS[plan];
  if (!spec) throw new Error("Unknown plan");
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) {
    return {
      mode: "placeholder",
      message: "Billing connects when keys are set",
      checkoutUrl: null,
      plan,
    };
  }
  const priceEnv = {
    trial: process.env.STRIPE_PRICE_TRIAL,
    shop: process.env.STRIPE_PRICE_SHOP,
    studio: process.env.STRIPE_PRICE_STUDIO,
  }[plan];
  const params = new URLSearchParams();
  params.set("mode", plan === "trial" ? "setup" : "subscription");
  params.set("success_url", origin + "/app.html?billing=ok");
  params.set("cancel_url", origin + "/app.html?billing=cancel");
  params.set("client_reference_id", user.id);
  params.set("customer_email", user.email);
  if (priceEnv) {
    params.set("line_items[0][price]", priceEnv);
    params.set("line_items[0][quantity]", "1");
    params.set("mode", "subscription");
  } else if (plan !== "trial") {
    params.set("line_items[0][price_data][currency]", "usd");
    params.set("line_items[0][price_data][product_data][name]", "DecoClub Pro " + spec.label);
    params.set("line_items[0][price_data][recurring][interval]", "month");
    params.set("line_items[0][price_data][unit_amount]", String(spec.amount));
    params.set("line_items[0][quantity]", "1");
  }
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error && data.error.message ? data.error.message : "Stripe error");
  return { mode: "stripe", checkoutUrl: data.url, sessionId: data.id, plan };
}

module.exports = { PLANS, loadEnvFile, createCheckoutSession };
