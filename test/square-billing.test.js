"use strict";
// Square Sandbox billing + credit ledger. No network: Square API is a local stub.
const assert = require("assert");
const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ADMIN_EMAIL = "sq-admin@decoclub.test";
const ADMIN_PASSWORD = "sq-admin-pass";
const KEY = "test-sig-key";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(port, method, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, opts.headers || {});
    const body = opts.body == null ? null : Buffer.from(opts.body);
    if (body) { headers["Content-Type"] = headers["Content-Type"] || "application/json"; headers["Content-Length"] = body.length; }
    const r = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const c = []; res.on("data", (d) => c.push(d));
      res.on("end", () => { const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, text: t, json: j }); });
    });
    r.on("error", reject); if (body) r.write(body); r.end();
  });
}
const cookieFrom = (res) => [].concat(res.headers["set-cookie"] || []).map((c) => String(c).split(";")[0]).join("; ");
const sign = (url, body) => crypto.createHmac("sha256", KEY).update(url + body).digest("base64");

function start(port, env) {
  const dir = (env && env.DATA_DIR) || fs.mkdtempSync(path.join(os.tmpdir(), "dcp-sq-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { DATA_DIR: dir, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "development",
      ADMIN_EMAIL, ADMIN_PASSWORD, FEATURE_MEMBERSHIP: "", FEATURE_DIGITIZE: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "",
      SQUARE_ENV: "", SQUARE_ACCESS_TOKEN: "", SQUARE_LOCATION_ID: "", SQUARE_WEBHOOK_SIGNATURE_KEY: "", SQUARE_WEBHOOK_URL: "", SQUARE_API_BASE: "" }, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  child.log = () => log.slice(-4000);
  child.dataDir = dir;
  return child;
}
async function waitHealth(port) {
  for (let i = 0; i < 100; i++) { try { const r = await req(port, "GET", "/health"); if (r.status === 200) return r; } catch (e) {} await sleep(50); }
  throw new Error("server did not start");
}
const stop = (c) => new Promise((r) => { c.on("exit", r); c.kill("SIGTERM"); setTimeout(() => { try { c.kill("SIGKILL"); } catch (e) {} }, 1500); });

function unitTests() {
  const sq = require("../lib/square");
  const url = "https://x.test/api/billing/square/webhook";
  const body = '{"a":1}';
  assert.ok(sq.verifySquareSignature(body, sign(url, body), KEY, url), "good sig");
  assert.ok(!sq.verifySquareSignature(body + " ", sign(url, body), KEY, url), "tampered body");
  assert.ok(!sq.verifySquareSignature(body, sign(url, body), "other", url), "wrong key");
  assert.ok(!sq.verifySquareSignature(body, "", KEY, url), "missing sig");

  const db = { users: [{ id: "u1", vector_credits: 0, halftone_credits: 0 }],
    square_orders: { O1: { order_id: "O1", user_id: "u1", product: "vector_pack10", service: "vectorize", credits: 10, amount: 2000, status: "pending", granted: 0, revoked: 0 } } };
  // Refund that arrives before its payment: retry_later, NOT marked seen, then processed after payment.
  const early = { event_id: "early1", type: "refund.updated", data: { object: { refund: { id: "RE0", payment_id: "P1", order_id: "O1", status: "COMPLETED", amount_money: { amount: 2000, currency: "USD" } } } } };
  assert.strictEqual(sq.applySquareEvent(db, early), "retry_later");
  assert.ok(!(db.square_events || []).includes("evt:early1") && !(db.square_events || []).includes("refund:RE0"), "early refund not marked seen");
  const pay = (eid, status, amt) => ({ event_id: eid, type: "payment.updated", data: { object: { payment: { id: "P1", order_id: "O1", status, amount_money: { amount: amt || 2000, currency: "USD" } } } } });
  assert.strictEqual(sq.applySquareEvent(db, pay("e0", "FAILED")), "not_completed");
  assert.strictEqual(sq.applySquareEvent(db, pay("e0b", "CANCELED")), "not_completed");
  assert.strictEqual(db.users[0].vector_credits, 0, "decline gives no credits");
  assert.strictEqual(sq.applySquareEvent(db, pay("e1", "COMPLETED", 1)), "amount_mismatch");
  assert.strictEqual(sq.applySquareEvent(db, pay("e2", "COMPLETED")), "granted");
  assert.strictEqual(db.users[0].vector_credits, 10);
  assert.strictEqual(sq.applySquareEvent(db, pay("e2", "COMPLETED")), "duplicate", "retried webhook");
  assert.strictEqual(sq.applySquareEvent(db, pay("e3", "COMPLETED")), "already_paid", "second event same order");
  assert.strictEqual(db.users[0].vector_credits, 10, "no double credit");
  // Persisted dedupe: a fresh copy of the store (as after restart) still rejects the replay.
  const reloaded = JSON.parse(JSON.stringify(db));
  assert.strictEqual(sq.applySquareEvent(reloaded, pay("e2", "COMPLETED")), "duplicate", "dedupe survives store reload");
  db.users[0].vector_credits = 7; // 3 used
  const ref = (eid, rid, status) => ({ event_id: eid, type: "refund.updated", data: { object: { refund: { id: rid, payment_id: "P1", order_id: "O1", status, amount_money: { amount: 2000, currency: "USD" } } } } });
  assert.strictEqual(sq.applySquareEvent(db, ref("r0", "R1", "PENDING")), "not_completed");
  assert.strictEqual(db.users[0].vector_credits, 7);
  assert.strictEqual(sq.applySquareEvent(db, ref("r1", "R1", "COMPLETED")), "refunded");
  assert.strictEqual(db.users[0].vector_credits, 0, "refund removes unused credits only");
  assert.strictEqual(sq.applySquareEvent(db, ref("r2", "R1", "COMPLETED")), "duplicate", "same refund twice");
  const led = db.credit_ledger.map((r) => r.source + ":" + r.delta);
  assert.deepStrictEqual(led, ["square:10", "square:-7"], "ledger rows " + led);
  console.log("ok square unit: signature, decline, idempotency, amount check, refund, ledger");
}

async function serverTests() {
  // Unconfigured: billing flag false, checkout + webhook 501.
  let port = 19600 + Math.floor(Math.random() * 300);
  let s = start(port, {});
  try {
    const h = await waitHealth(port);
    assert.strictEqual(h.json.billing, false, "health billing false when unset");
    const wh = await req(port, "POST", "/api/billing/square/webhook", { body: "{}" });
    assert.strictEqual(wh.status, 501);
  } catch (e) { console.error(s.log()); throw e; } finally { await stop(s); }

  // Configured against a local stub Square API.
  let orderSeq = 0;
  const stub = http.createServer((rq, rs) => {
    let b = ""; rq.on("data", (d) => { b += d; });
    rq.on("end", () => {
      assert.strictEqual(rq.url, "/v2/online-checkout/payment-links");
      assert.ok(/^Bearer sbx-token$/.test(rq.headers.authorization));
      const j = JSON.parse(b); assert.strictEqual(j.quick_pay.location_id, "LTEST"); assert.strictEqual(j.quick_pay.price_money.amount, 300);
      rs.writeHead(200, { "Content-Type": "application/json" });
      rs.end(JSON.stringify({ payment_link: { id: "PL1", url: "https://sandbox.square.link/u/x", order_id: "ORD" + (++orderSeq) } }));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  port += 1;
  const hookUrl = "https://example.test/api/billing/square/webhook";
  s = start(port, { SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "sbx-token", SQUARE_LOCATION_ID: "LTEST", SQUARE_WEBHOOK_SIGNATURE_KEY: KEY,
    SQUARE_WEBHOOK_URL: hookUrl, SQUARE_API_BASE: "http://127.0.0.1:" + stub.address().port });
  try {
    const h = await waitHealth(port);
    assert.strictEqual(h.json.billing, true);
    const su = await req(port, "POST", "/api/signup", { body: JSON.stringify({ name: "Sq Shop", email: "sq-shop@shop.test", password: "secret12", shopName: "Sq Shop", role: "shop" }) });
    assert.strictEqual(su.status, 200, su.text);
    const ck = cookieFrom(su); const uid = su.json.user.id;
    const co = await req(port, "POST", "/api/billing/checkout", { headers: { Cookie: ck }, body: JSON.stringify({ product: "vector_single" }) });
    assert.strictEqual(co.status, 200, co.text);
    assert.strictEqual(co.json.checkoutUrl, "https://sandbox.square.link/u/x");

    const login = await req(port, "POST", "/api/login", { body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
    const adm = cookieFrom(login);
    const bal = async () => (await req(port, "GET", "/api/admin/users", { headers: { Cookie: adm } })).json.users.find((u) => u.id === uid).vector_credits;
    assert.strictEqual(await bal(), 0, "no credit before webhook");

    const send = (obj, sig) => { const b = JSON.stringify(obj); return req(port, "POST", "/api/billing/square/webhook", { headers: { "x-square-hmacsha256-signature": sig || sign(hookUrl, b) }, body: b }); };
    const paid = { event_id: "EV1", type: "payment.updated", data: { object: { payment: { id: "PAY1", order_id: "ORD1", status: "COMPLETED", amount_money: { amount: 300, currency: "USD" } } } } };
    assert.strictEqual((await send(paid, "bad")).status, 401, "bad signature rejected");
    assert.strictEqual(await bal(), 0);
    const declined = { event_id: "EV0", type: "payment.updated", data: { object: { payment: { id: "PAY0", order_id: "ORD1", status: "FAILED", amount_money: { amount: 300, currency: "USD" } } } } };
    assert.strictEqual((await send(declined)).json.result, "not_completed");
    assert.strictEqual(await bal(), 0, "decline no credit");
    assert.strictEqual((await send(paid)).json.result, "granted");
    assert.strictEqual((await send(paid)).json.result, "duplicate");
    assert.strictEqual(await bal(), 1, "exactly one credit");

    // Admin add/remove with reason → ledger.
    let r = await req(port, "POST", "/api/admin/users/" + uid + "/vector-credits", { headers: { Cookie: adm }, body: JSON.stringify({ add: 5, reason: "QA test" }) });
    assert.strictEqual(r.status, 200, r.text);
    r = await req(port, "POST", "/api/admin/users/" + uid + "/halftone-credits", { headers: { Cookie: adm }, body: JSON.stringify({ add: 2, reason: "goodwill" }) });
    assert.strictEqual(r.status, 200);
    r = await req(port, "POST", "/api/admin/users/" + uid + "/vector-credits", { headers: { Cookie: adm }, body: JSON.stringify({ add: -2, reason: "oops" }) });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.user.vector_credits, 4);

    // Refund for an order whose payment has not landed yet: 409 (Square retries), not marked seen.
    const co2 = await req(port, "POST", "/api/billing/checkout", { headers: { Cookie: ck }, body: JSON.stringify({ product: "vector_single" }) });
    assert.strictEqual(co2.status, 200);
    // ORD2 is pending (its payment webhook has not arrived) — a refund for it must wait.
    const earlyRf = { event_id: "EVE", type: "refund.updated", data: { object: { refund: { id: "RFE", payment_id: "PAY2", order_id: "ORD2", status: "COMPLETED", amount_money: { amount: 300, currency: "USD" } } } } };
    let er = await send(earlyRf); assert.strictEqual(er.status, 409, er.text);
    er = await send(earlyRf); assert.strictEqual(er.status, 409, "retry still processed, not deduped");
    const b0 = await bal();
    const paid2 = { event_id: "EVP2", type: "payment.updated", data: { object: { payment: { id: "PAY2", order_id: "ORD2", status: "COMPLETED", amount_money: { amount: 300, currency: "USD" } } } } };
    assert.strictEqual((await send(paid2)).json.result, "granted");
    er = await send(earlyRf); assert.strictEqual(er.status, 200); assert.strictEqual(er.json.result, "refunded", "early refund processed once payment lands");
    assert.strictEqual(await bal(), b0, "net zero after pay+refund");

    const refund = { event_id: "EV2", type: "refund.updated", data: { object: { refund: { id: "RF1", payment_id: "PAY1", order_id: "ORD1", status: "COMPLETED", amount_money: { amount: 300, currency: "USD" } } } } };
    assert.strictEqual((await send(refund)).json.result, "refunded");
    assert.strictEqual(await bal(), 3);

    const hist = await req(port, "GET", "/api/admin/users/" + uid + "/credit-history", { headers: { Cookie: adm } });
    assert.strictEqual(hist.status, 200);
    const rows = hist.json.history.slice().reverse().map((x) => [x.service, x.delta, x.source, x.reason, !!x.admin_id, !!x.at].join("|"));
    assert.deepStrictEqual(rows, [
      "vectorize|1|square|Square purchase vector_single|false|true",
      "vectorize|5|admin|QA test|true|true",
      "halftones|2|admin|goodwill|true|true",
      "vectorize|-2|admin|oops|true|true",
      "vectorize|1|square|Square purchase vector_single|false|true",
      "vectorize|-1|square|Square refund vector_single|false|true",
      "vectorize|-1|square|Square refund vector_single|false|true",
    ], JSON.stringify(rows));

    // Validation: bad values / missing reason are 400 and change nothing.
    const before = await bal();
    const bads = [
      ["POST", "/vector-credits", { set: "abc", reason: "x" }],
      ["POST", "/vector-credits", { add: 1.5, reason: "x" }],
      ["POST", "/vector-credits", { add: "1e3", reason: "x" }],
      ["POST", "/vector-credits", { add: 10001, reason: "x" }],
      ["POST", "/vector-credits", { add: -10001, reason: "x" }],
      ["POST", "/vector-credits", { set: 100001, reason: "x" }],
      ["POST", "/vector-credits", { set: -1, reason: "x" }],
      ["POST", "/vector-credits", { add: -(before + 1), reason: "x" }],
      ["POST", "/vector-credits", { add: 1 }],
      ["POST", "/vector-credits", { add: 1, reason: "   " }],
      ["POST", "/halftone-credits", { add: 1 }],
      ["POST", "/halftone-credits", { credits: "abc", reason: "x" }],
      ["PATCH", "", { vector_credits: 5 }],
      ["PATCH", "", { vector_credits: "abc", reason: "x", name: "Changed" }],
    ];
    for (const [m, p, b] of bads) {
      const x = await req(port, m, "/api/admin/users/" + uid + p, { headers: { Cookie: adm }, body: JSON.stringify(b) });
      assert.strictEqual(x.status, 400, m + p + " " + JSON.stringify(b) + " -> " + x.status + " " + x.text);
    }
    assert.strictEqual(await bal(), before, "invalid requests changed nothing");
    const nm = (await req(port, "GET", "/api/admin/users", { headers: { Cookie: adm } })).json.users.find((u) => u.id === uid).name;
    assert.strictEqual(nm, "Sq Shop", "rejected PATCH did not partially apply");
    const okPatch = await req(port, "PATCH", "/api/admin/users/" + uid, { headers: { Cookie: adm }, body: JSON.stringify({ vector_credits: before, reason: "no-op check" }) });
    assert.strictEqual(okPatch.status, 200);

    // Non-admin 403 on every credit endpoint.
    for (const [m, p, b] of [["POST", "/vector-credits", { add: 99 }], ["POST", "/halftone-credits", { add: 99 }], ["GET", "/credit-history"], ["GET", "/vector-credits"], ["PATCH", "", { vector_credits: 99 }]]) {
      const x = await req(port, m, "/api/admin/users/" + uid + p, { headers: { Cookie: ck }, body: b ? JSON.stringify(b) : null });
      assert.strictEqual(x.status, 403, m + " " + p + " -> " + x.status);
    }
    assert.strictEqual(await bal(), 3, "non-admin changed nothing");
    // Dedupe persisted: restart the server on the same store and replay the paid event.
    const dir = s.dataDir; await stop(s);
    s = start(port, { DATA_DIR: dir, SQUARE_ENV: "sandbox", SQUARE_ACCESS_TOKEN: "sbx-token", SQUARE_LOCATION_ID: "LTEST", SQUARE_WEBHOOK_SIGNATURE_KEY: KEY,
      SQUARE_WEBHOOK_URL: hookUrl, SQUARE_API_BASE: "http://127.0.0.1:" + stub.address().port });
    await waitHealth(port);
    const login2 = await req(port, "POST", "/api/login", { body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
    const adm2 = cookieFrom(login2);
    assert.strictEqual((await send(paid)).json.result, "duplicate", "dedupe survives restart");
    assert.strictEqual((await req(port, "GET", "/api/admin/users", { headers: { Cookie: adm2 } })).json.users.find((u) => u.id === uid).vector_credits, 3);
    console.log("ok square server: health flag, checkout link, sig 401, decline, idempotent grant, admin ledger, refund, non-admin 403");
  } catch (e) { console.error(s.log()); throw e; } finally { await stop(s); stub.close(); }
}

(async () => { unitTests(); await serverTests(); })().catch((e) => { console.error(e); process.exit(1); });
