"use strict";
// Square billing (Checkout API payment links). Credits are granted ONLY from a
// signature-verified webhook (payment COMPLETED), keyed to an order we created.
const crypto = require("crypto");
const { recordCredit } = require("./ledger");
const { PRODUCTS, isCreditProduct, serviceForProduct, creditFieldForService } = require("./stripe");

const API_VERSION = "2024-10-17";

function squareEnv() {
  const e = String(process.env.SQUARE_ENV || "").trim().toLowerCase();
  return e === "sandbox" || e === "production" ? e : "";
}

function billingConfigured() {
  return Boolean(squareEnv() && process.env.SQUARE_ACCESS_TOKEN && process.env.SQUARE_LOCATION_ID &&
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY && process.env.SQUARE_WEBHOOK_URL);
}

function apiBase() {
  // Test-only override: never honoured in production NODE_ENV or production Square.
  if (process.env.SQUARE_API_BASE && squareEnv() === "sandbox" && process.env.NODE_ENV !== "production") return process.env.SQUARE_API_BASE;
  return squareEnv() === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
}

function notConfigured() {
  const err = new Error("Billing not configured");
  err.status = 501;
  return err;
}

function orders(db) {
  if (!db.square_orders || typeof db.square_orders !== "object" || Array.isArray(db.square_orders)) db.square_orders = {};
  return db.square_orders;
}

function seenList(db) {
  if (!Array.isArray(db.square_events)) db.square_events = [];
  return db.square_events;
}

function seen(db, key) { return !!key && seenList(db).indexOf(String(key)) !== -1; }
function remember(db, key) {
  if (!key) return;
  const l = seenList(db);
  if (l.indexOf(String(key)) === -1) l.push(String(key));
  if (l.length > 2000) l.splice(0, l.length - 2000);
}

/** Square signature: base64(HMAC-SHA256(key, notificationUrl + rawBody)). */
function verifySquareSignature(raw, header, key, url) {
  if (!raw || !header || !key || !url) return false;
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  const expect = crypto.createHmac("sha256", key).update(Buffer.concat([Buffer.from(url), body])).digest();
  let got;
  try { got = Buffer.from(String(header), "base64"); } catch (e) { return false; }
  if (got.length !== expect.length) return false;
  return crypto.timingSafeEqual(got, expect);
}

/**
 * Create a Square payment link. `fetchImpl` is injectable for tests.
 * Records a pending order in db.square_orders keyed by Square order_id.
 */
async function createSquareCheckout(db, product, user, origin, opts, fetchImpl) {
  opts = opts || {};
  if (!billingConfigured()) throw notConfigured();
  if (!isCreditProduct(product)) { const e = new Error("Only image credits are sold"); e.status = 400; throw e; }
  const spec = PRODUCTS[product];
  const amount = Math.max(1, Math.floor(Number(opts.amountCents) || spec.amount));
  const ref = crypto.randomBytes(12).toString("hex");
  const body = {
    idempotency_key: ref,
    quick_pay: { name: spec.label, price_money: { amount: amount, currency: "USD" }, location_id: process.env.SQUARE_LOCATION_ID },
    checkout_options: { redirect_url: origin + "/app.html?billing=ok&product=" + product, ask_for_shipping_address: false },
    pre_populated_data: user.email ? { buyer_email: user.email } : undefined,
    payment_note: "DecoClub Pro " + product + " ref " + ref,
  };
  const f = fetchImpl || fetch;
  const res = await f(apiBase() + "/v2/online-checkout/payment-links", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.SQUARE_ACCESS_TOKEN, "Content-Type": "application/json", "Square-Version": API_VERSION },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  const link = data && data.payment_link;
  if (!res.ok || !link || !link.url || !link.order_id) {
    const msg = data && data.errors && data.errors[0] ? (data.errors[0].detail || data.errors[0].code) : "Square error";
    const e = new Error(msg); e.status = 502; throw e;
  }
  if (orders(db)[link.order_id]) { const e = new Error("Duplicate Square order id"); e.status = 502; throw e; }
  orders(db)[link.order_id] = {
    order_id: link.order_id, link_id: link.id || null, ref: ref, user_id: user.id, product: product,
    service: serviceForProduct(product), credits: spec.credits, amount: amount, status: "pending",
    granted: 0, revoked: 0, payment_id: null, created_at: new Date().toISOString(),
  };
  return { mode: "square", checkoutUrl: link.url, orderId: link.order_id, product: product, plan: null };
}

function userById(db, id) { return (db.users || []).find((u) => u.id === id) || null; }

/** Apply a verified Square webhook event. Returns a short result string. */
function applySquareEvent(db, event) {
  if (!event || !event.type || !event.data) return "ignored";
  const eid = event.event_id ? "evt:" + event.event_id : "";
  if (eid && seen(db, eid)) return "duplicate";
  const obj = event.data.object || {};
  let out = "ignored";
  if (event.type === "payment.updated" || event.type === "payment.created") {
    const p = obj.payment || {};
    const o = p.order_id ? orders(db)[p.order_id] : null;
    if (!o) out = "unknown_order";
    else if (p.status !== "COMPLETED") out = "not_completed";
    else if (o.status !== "pending") out = "already_paid";
    else if (!p.amount_money || Number(p.amount_money.amount) < o.amount || p.amount_money.currency !== "USD") out = "amount_mismatch";
    else {
      const user = userById(db, o.user_id);
      const field = creditFieldForService(o.service);
      if (!user || !field) out = "no_user";
      else {
        user[field] = Math.max(0, Math.floor(Number(user[field]) || 0)) + o.credits;
        recordCredit(db, { user_id: user.id, service: o.service, delta: o.credits, balance: user[field], source: "square", reason: "Square purchase " + o.product, ref: "order:" + o.order_id + " payment:" + (p.id || "") });
        o.status = "paid"; o.granted = o.credits; o.payment_id = p.id || null; o.paid_at = new Date().toISOString();
        out = "granted";
      }
    }
  } else if (event.type === "refund.updated" || event.type === "refund.created") {
    const r = obj.refund || {};
    const rid = r.id ? "refund:" + r.id : "";
    const all = orders(db);
    const o = (r.order_id && all[r.order_id]) || Object.values(all).find((x) => r.payment_id && x.payment_id === r.payment_id) || null;
    if (r.status !== "COMPLETED") out = "not_completed";
    else if (rid && seen(db, rid)) out = "duplicate";
    else if (!o || (o.status !== "paid" && o.status !== "refunded")) out = "retry_later"; // payment not processed yet
    else {
      const amt = Math.max(0, Number(r.amount_money && r.amount_money.amount) || 0);
      const want = Math.min(o.granted - o.revoked, Math.ceil((o.credits * amt) / o.amount));
      const user = userById(db, o.user_id);
      const field = creditFieldForService(o.service);
      let removed = 0;
      if (user && field && want > 0) {
        const bal = Math.max(0, Math.floor(Number(user[field]) || 0));
        removed = Math.min(bal, want); // only unused credits can be clawed back
        user[field] = bal - removed;
        if (removed) recordCredit(db, { user_id: user.id, service: o.service, delta: -removed, balance: user[field], source: "square", reason: "Square refund " + o.product, ref: "order:" + o.order_id + " refund:" + (r.id || "") });
      }
      o.revoked += want; // credits already spent are forfeited from future refunds too
      o.removed = (o.removed || 0) + removed;
      if (o.revoked >= o.granted) o.status = "refunded";
      remember(db, rid);
      out = "refunded";
    }
  }
  // Dedupe lives in db.square_events (persisted with the store). Only processed outcomes are marked seen.
  if (eid && out !== "unknown_order" && out !== "retry_later") remember(db, eid);
  return out;
}

module.exports = { billingConfigured, squareEnv, apiBase, verifySquareSignature, createSquareCheckout, applySquareEvent };
