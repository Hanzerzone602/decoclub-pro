"use strict";
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { encodePng, makeRgba } = require("../lib/png");
const { applyStripeEvent, createCheckoutSession } = require("../lib/stripe");

const ADMIN_EMAIL = "ppi-admin@decoclub.test";
const ADMIN_PASSWORD = "ppi-admin-pass";

function tinyPng() {
  const w = 48;
  const h = 48;
  const rgba = makeRgba(w, h, [255, 255, 255, 255]);
  for (let y = 12; y < 36; y++) {
    for (let x = 12; x < 36; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 10;
      rgba[i + 1] = 10;
      rgba[i + 2] = 10;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(w, h, rgba);
}

function multipart(fields, file) {
  const boundary = "----dcpPPI" + Date.now();
  const chunks = [];
  Object.keys(fields).forEach((k) => {
    chunks.push(Buffer.from(
      "--" + boundary + "\r\n" +
      'Content-Disposition: form-data; name="' + k + '"\r\n\r\n' +
      String(fields[k]) + "\r\n"
    ));
  });
  if (file) {
    chunks.push(Buffer.from(
      "--" + boundary + "\r\n" +
      'Content-Disposition: form-data; name="file"; filename="' + file.name + '"\r\n' +
      "Content-Type: image/png\r\n\r\n"
    ));
    chunks.push(file.buf);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from("--" + boundary + "--\r\n"));
  return { body: Buffer.concat(chunks), contentType: "multipart/form-data; boundary=" + boundary };
}

function req(port, method, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body && !headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
    const body = opts.body == null ? null : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body));
    if (body) headers["Content-Length"] = body.length;
    const r = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString("utf8"), json, buf });
      });
    });
    r.setTimeout(180000, () => {
      r.destroy(new Error("timeout " + method + " " + urlPath));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

function cookieFrom(res) {
  const set = res.headers["set-cookie"];
  if (!set) return "";
  return (Array.isArray(set) ? set : [set]).map((c) => String(c).split(";")[0]).join("; ");
}

async function waitHealth(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await req(port, "GET", "/health");
      if (r.status === 200) return r;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-ppi-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, {
      DATA_DIR: dir,
      HOST: "127.0.0.1",
      ALLOW_DEMO: "1",
      NODE_ENV: "development",
      ADMIN_EMAIL: ADMIN_EMAIL,
      ADMIN_PASSWORD: ADMIN_PASSWORD,
      FEATURE_MEMBERSHIP: "",
      FEATURE_DIGITIZE: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
    }, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; if (log.length > 8000) log = log.slice(-8000); });
  child.stderr.on("data", (d) => { log += d; if (log.length > 8000) log = log.slice(-8000); });
  child.log = function () { return log; };
  return { child, dir };
}

function stop(child) {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, 1500);
  });
}

async function uploadJob(port, cookie, title) {
  const form = multipart(
    { title: title, method: "dtf", width_in: "4", height_in: "4", qty: "1" },
    { name: "dot.png", buf: tinyPng() }
  );
  const res = await req(port, "POST", "/api/jobs", {
    headers: { Cookie: cookie, "Content-Type": form.contentType },
    body: form.body,
  });
  assert.strictEqual(res.status, 200, "job create " + JSON.stringify(res.json));
  assert.ok(res.json.job.file_path, "job needs artwork");
  return res.json.job;
}

(async () => {
  const prevKey = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const db = { users: [{ id: "u1", plan: "shop", vector_credits: 0, halftone_credits: 1 }] };
  const paid = {
    id: "evt_vec",
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_vec_pack",
      payment_status: "paid",
      metadata: { product: "vector_pack10", user_id: "u1", credits: "10", service: "vectorize" },
      client_reference_id: "u1",
    } },
  };
  assert.strictEqual(applyStripeEvent(db, paid), true);
  assert.strictEqual(db.users[0].vector_credits, 10);
  assert.strictEqual(db.users[0].halftone_credits, 1);
  assert.strictEqual(db.users[0].plan, "shop");
  assert.strictEqual(applyStripeEvent(db, paid), false);
  assert.strictEqual(db.users[0].vector_credits, 10);
  assert.strictEqual(applyStripeEvent(db, {
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_ht_qty",
      payment_status: "paid",
      metadata: { product: "halftone_single", user_id: "u1", credits: "3", service: "halftones" },
      client_reference_id: "u1",
    } },
  }), true);
  assert.strictEqual(db.users[0].halftone_credits, 4);
  assert.strictEqual(db.users[0].vector_credits, 10);
  assert.strictEqual(db.users[0].plan, "shop");
  assert.strictEqual(applyStripeEvent(db, {
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_unpaid",
      payment_status: "unpaid",
      metadata: { product: "vector_single", user_id: "u1", credits: "1" },
      client_reference_id: "u1",
    } },
  }), false);
  assert.strictEqual(db.users[0].vector_credits, 10);
  assert.strictEqual(applyStripeEvent(db, {
    type: "payment_intent.succeeded",
    data: { object: { id: "pi_vec", metadata: { product: "vector_pack10", user_id: "u1", credits: "10" } } },
  }), false);
  assert.strictEqual(db.users[0].vector_credits, 10);
  let threw = null;
  try {
    await createCheckoutSession("vector_single", { id: "u1", email: "a@b.c" }, "http://127.0.0.1:9", {});
  } catch (err) {
    threw = err;
  }
  assert.ok(threw && threw.status === 501, "createCheckoutSession should 501 without a secret");
  if (prevKey) process.env.STRIPE_SECRET_KEY = prevKey;
  console.log("ok stripe credit grants, idempotency, unpaid, checkout 501");

  const port = 41351;
  const s = startServer({ PORT: String(port) });
  try {
    const h = await waitHealth(port);
    assert.strictEqual(h.json.ok, true);
    assert.strictEqual(h.json.pricing, "ppi");
    assert.ok((h.json.services || []).indexOf("digitize") === -1);
    assert.ok((h.json.services || []).indexOf("vectorize") !== -1);
    assert.ok((h.json.services || []).indexOf("halftones") !== -1);

    const cfg = await req(port, "GET", "/api/config");
    assert.strictEqual(cfg.status, 200);
    assert.strictEqual(cfg.json.features.membership, false);
    assert.strictEqual(cfg.json.features.digitize, false);
    assert.strictEqual(cfg.json.services.digitize, false);
    assert.strictEqual(cfg.json.services.vectorize, true);
    assert.strictEqual(cfg.json.services.halftones, true);
    assert.strictEqual(cfg.json.pricing.vectorize.single.cents, 300);
    assert.strictEqual(cfg.json.pricing.vectorize.single.credits, 1);
    assert.strictEqual(cfg.json.pricing.vectorize.pack10.cents, 2000);
    assert.strictEqual(cfg.json.pricing.vectorize.pack10.credits, 10);
    assert.strictEqual(cfg.json.pricing.halftones.single.cents, 300);
    assert.strictEqual(cfg.json.pricing.halftones.pack10.cents, 2000);
    assert.strictEqual(cfg.json.pricing.halftones.pack10.credits, 10);
    assert.strictEqual(cfg.json.halftonePricing.single.cents, 300);
    console.log("ok config + health hide digitize");

    const signup = await req(port, "POST", "/api/signup", {
      body: JSON.stringify({ name: "PPI Shop", email: "ppi-shop@test.local", password: "test1234", role: "shop" }),
    });
    assert.strictEqual(signup.status, 200, JSON.stringify(signup.json));
    const shopCk = cookieFrom(signup);
    const me = await req(port, "GET", "/api/me", { headers: { Cookie: shopCk } });
    assert.strictEqual(me.json.user.vectorCredits, 0);
    assert.strictEqual(me.json.user.halftoneCredits, 0);
    assert.strictEqual(me.json.user.plan, null);
    assert.strictEqual(me.json.user.planExpires, null);
    const shopId = me.json.user.id;
    console.log("ok signup credits 0 plan null");

    const job = await uploadJob(port, shopCk, "PPI one");
    const denied = await req(port, "POST", "/api/jobs/" + job.id + "/vectorize", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ colors: 2, maxEdge: 96 }),
    });
    assert.strictEqual(denied.status, 402, JSON.stringify(denied.json));
    assert.strictEqual(denied.json.code, "vector_credits_required");
    assert.strictEqual(denied.json.buy.single.cents, 300);
    console.log("ok vectorize 402 without credits");

    const adminLogin = await req(port, "POST", "/api/login", {
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    assert.strictEqual(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const adminCk = cookieFrom(adminLogin);
    const grantV = await req(port, "POST", "/api/admin/users/" + shopId + "/vector-credits", {
      headers: { Cookie: adminCk },
      body: JSON.stringify({ add: 1 }),
    });
    assert.strictEqual(grantV.status, 200, JSON.stringify(grantV.json));
    assert.strictEqual(grantV.json.user.vector_credits, 1);

    const first = await req(port, "POST", "/api/jobs/" + job.id + "/vectorize", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ colors: 2, maxEdge: 96 }),
    });
    assert.strictEqual(first.status, 200, JSON.stringify(first.json && first.json.error ? first.json : { status: first.status }));
    assert.strictEqual(first.json.vectorCredits, 0);
    assert.strictEqual(first.json.creditConsumed, true);
    assert.strictEqual(first.json.job.unlocks.vectorize, true);
    const again = await req(port, "POST", "/api/jobs/" + job.id + "/vectorize", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ colors: 2, maxEdge: 96 }),
    });
    assert.strictEqual(again.status, 200, JSON.stringify(again.json && again.json.error ? again.json : { status: again.status }));
    assert.strictEqual(again.json.vectorCredits, 0);
    assert.strictEqual(again.json.creditConsumed, false);
    const job2 = await uploadJob(port, shopCk, "PPI two");
    const denied2 = await req(port, "POST", "/api/jobs/" + job2.id + "/vectorize", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ colors: 2, maxEdge: 96 }),
    });
    assert.strictEqual(denied2.status, 402);
    assert.strictEqual(denied2.json.code, "vector_credits_required");
    console.log("ok vectorize consumes once per job");

    const prev = await req(port, "POST", "/api/jobs/" + job.id + "/halftone/preview", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ style: "classic-round", maxEdge: 64, maxCells: 400 }),
    });
    assert.strictEqual(prev.status, 200, JSON.stringify(prev.json));
    const apply0 = await req(port, "POST", "/api/jobs/" + job.id + "/halftone", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ style: "classic-round", maxEdge: 64, maxCells: 400 }),
    });
    assert.strictEqual(apply0.status, 402, JSON.stringify(apply0.json));
    assert.strictEqual(apply0.json.code, "halftone_credits_required");
    const grantH = await req(port, "POST", "/api/admin/users/" + shopId + "/halftone-credits", {
      headers: { Cookie: adminCk },
      body: JSON.stringify({ add: 1 }),
    });
    assert.strictEqual(grantH.status, 200, JSON.stringify(grantH.json));
    const apply1 = await req(port, "POST", "/api/jobs/" + job.id + "/halftone", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ style: "classic-round", maxEdge: 64, maxCells: 400 }),
    });
    assert.strictEqual(apply1.status, 200, JSON.stringify(apply1.json && apply1.json.error ? apply1.json : { status: apply1.status }));
    assert.strictEqual(apply1.json.creditConsumed, true);
    assert.strictEqual(apply1.json.halftoneCredits, 0);
    const apply2 = await req(port, "POST", "/api/jobs/" + job.id + "/halftone", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ style: "line", maxEdge: 64, maxCells: 400 }),
    });
    assert.strictEqual(apply2.status, 200, JSON.stringify(apply2.json && apply2.json.error ? apply2.json : { status: apply2.status }));
    assert.strictEqual(apply2.json.creditConsumed, false);
    assert.strictEqual(apply2.json.halftoneCredits, 0);
    console.log("ok halftone preview free, apply unlocks the job");

    const co1 = await req(port, "POST", "/api/billing/checkout", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ product: "vector_single" }),
    });
    assert.strictEqual(co1.status, 501);
    assert.strictEqual(co1.json.error, "Billing not configured");
    const co2 = await req(port, "POST", "/api/billing/checkout", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ product: "halftone_pack10" }),
    });
    assert.strictEqual(co2.status, 501);
    const mem1 = await req(port, "POST", "/api/billing/checkout", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ plan: "studio" }),
    });
    assert.strictEqual(mem1.status, 404);
    assert.ok(String(mem1.json.error).indexOf("Memberships are not offered") !== -1);
    const mem2 = await req(port, "POST", "/api/billing/checkout", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ product: "studio" }),
    });
    assert.strictEqual(mem2.status, 404);
    console.log("ok checkout credits 501, membership 404");

    const dig = await req(port, "POST", "/api/jobs/" + job.id + "/digitize", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ density: 0.4 }),
    });
    assert.strictEqual(dig.status, 404);
    const demo = await req(port, "GET", "/digitize-demo.html");
    assert.strictEqual(demo.status, 404);
    const previewJs = await req(port, "GET", "/digitize-preview.js");
    assert.strictEqual(previewJs.status, 200);
    console.log("ok digitize hidden, preview script still served");
  } catch (err) {
    console.error(s.child.log ? s.child.log() : "");
    throw err;
  } finally {
    await stop(s.child);
  }

  const port2 = 41352;
  const s2 = startServer({ PORT: String(port2), FEATURE_MEMBERSHIP: "1", FEATURE_DIGITIZE: "1" });
  try {
    await waitHealth(port2);
    // FEATURE_DIGITIZE=1 is admin-only: anonymous + normal users see the flag-off site
    const cfg2 = await req(port2, "GET", "/api/config");
    assert.strictEqual(cfg2.json.features.membership, true);
    assert.strictEqual(cfg2.json.features.digitize, false);
    assert.strictEqual(cfg2.json.services.digitize, false);
    assert.ok(/no-store/.test(cfg2.headers["cache-control"] || ""), "config not cacheable");
    const h2 = await req(port2, "GET", "/health");
    assert.ok((h2.json.services || []).indexOf("digitize") === -1);
    assert.strictEqual((await req(port2, "GET", "/digitize-demo.html")).status, 404);
    assert.ok(!(await req(port2, "GET", "/api/services")).json.services.digitize);
    const su = await req(port2, "POST", "/api/signup", { body: JSON.stringify({ name: "Bo", email: "bo@shop.test", password: "secret12" }) });
    const boCk = cookieFrom(su);
    const boCfg = await req(port2, "GET", "/api/config", { headers: { Cookie: boCk } });
    assert.strictEqual(boCfg.json.features.digitize, false);
    assert.strictEqual(boCfg.json.services.digitize, false);
    assert.ok(!(await req(port2, "GET", "/api/services", { headers: { Cookie: boCk } })).json.services.digitize);
    assert.ok(!((await req(port2, "GET", "/api/me", { headers: { Cookie: boCk } })).json.user.services || {}).digitize);
    assert.strictEqual((await req(port2, "GET", "/digitize-demo.html", { headers: { Cookie: boCk } })).status, 404);
    const boJob = await req(port2, "POST", "/api/jobs", { headers: { Cookie: boCk }, body: JSON.stringify({ title: "B", method: "embroidery", width_in: 2, height_in: 2 }) });
    assert.strictEqual(boJob.status, 200);
    assert.strictEqual((await req(port2, "POST", "/api/jobs/" + boJob.json.job.id + "/digitize", { headers: { Cookie: boCk }, body: "{}" })).status, 404);
    assert.strictEqual((await req(port2, "GET", "/api/export/" + boJob.json.job.id + "/design.dst", { headers: { Cookie: boCk } })).status, 404);
    // admin sees Digitize
    const ad = await req(port2, "POST", "/api/login", { body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
    assert.strictEqual(ad.status, 200, JSON.stringify(ad.json));
    const adCk = cookieFrom(ad);
    const adCfg = await req(port2, "GET", "/api/config", { headers: { Cookie: adCk } });
    assert.strictEqual(adCfg.json.features.digitize, true);
    assert.strictEqual(adCfg.json.services.digitize, true);
    assert.ok(/no-store/.test(adCfg.headers["cache-control"] || "") && /Cookie/.test(adCfg.headers["vary"] || ""));
    assert.ok((await req(port2, "GET", "/api/services", { headers: { Cookie: adCk } })).json.services.digitize);
    assert.ok((await req(port2, "GET", "/api/me", { headers: { Cookie: adCk } })).json.user.services.digitize);
    const adDemo = await req(port2, "GET", "/digitize-demo.html", { headers: { Cookie: adCk } });
    assert.strictEqual(adDemo.status, 200);
    assert.ok(/no-store/.test(adDemo.headers["cache-control"] || ""));
    console.log("ok FEATURE_DIGITIZE=1 is admin-only (anon/shop see flag-off site)");
  } finally {
    await stop(s2.child);
  }

  console.log("PASS pay-per-image");
})().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
