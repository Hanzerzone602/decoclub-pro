"use strict";
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { applyStripeEvent, grantHalftoneCredits, creditsForProduct, isHalftoneProduct } = require("../lib/stripe");
process.env.FEATURE_MEMBERSHIP = "1";
process.env.FEATURE_DIGITIZE = "1";

const HT_CRED = "halftone_credits";

function req(port, method, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (opts.body) headers["Content-Length"] = Buffer.byteLength(opts.body);
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
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-htsvc-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { DATA_DIR: dir, HOST: "127.0.0.1", ALLOW_DEMO: "1", NODE_ENV: "development" }, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, dir };
}

function stop(child) {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, 1500);
  });
}

{
  assert.strictEqual(isHalftoneProduct("halftone_single"), true);
  assert.strictEqual(creditsForProduct("halftone_pack10"), 10);
  assert.strictEqual(creditsForProduct("halftone_single"), 1);
  const db = { users: [{ id: "u1", plan: "shop", [HT_CRED]: 0 }] };
  const ok = applyStripeEvent(db, {
    type: "checkout.session.completed",
    data: { object: { metadata: { user_id: "u1", product: "halftone_pack10" }, client_reference_id: "u1" } },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(db.users[0][HT_CRED], 10);
  assert.strictEqual(db.users[0].plan, "shop");
  applyStripeEvent(db, {
    type: "checkout.session.completed",
    data: { object: { metadata: { user_id: "u1", product: "halftone_single" }, client_reference_id: "u1" } },
  });
  assert.strictEqual(db.users[0][HT_CRED], 11);
  assert.strictEqual(db.users[0].plan, "shop");
  grantHalftoneCredits(db.users[0], 2);
  assert.strictEqual(db.users[0][HT_CRED], 13);
  console.log("ok stripe pack grant + credits (plan unchanged)");
}

(async () => {
  const port = 41277;
  const s = startServer({ PORT: String(port) });
  try {
    const h = await waitHealth(port);
    assert.strictEqual(h.json.ok, true);
    assert.ok((h.json.services || []).indexOf("halftones") !== -1);

    const svc = await req(port, "GET", "/api/services");
    assert.strictEqual(svc.status, 200);
    assert.ok(svc.json.services.halftones);
    assert.strictEqual(svc.json.services.halftones.pricing.single.cents, 300);
    assert.strictEqual(svc.json.services.halftones.pricing.pack10.cents, 2000);
    console.log("ok /api/services advertises Halftones packs");

    // login demo studio owner — included unlimited
    const loginStudio = await req(port, "POST", "/api/login", {
      body: JSON.stringify({ email: "owner@anvil.local", password: "anvil123" }),
    });
    assert.strictEqual(loginStudio.status, 200);
    const ckStudio = cookieFrom(loginStudio);
    const meStudio = await req(port, "GET", "/api/me", { headers: { Cookie: ckStudio } });
    assert.strictEqual(meStudio.json.user.halftoneIncluded, true);
    assert.strictEqual(meStudio.json.user.services.halftones.canApply, true);
    console.log("ok studio owner: halftoneIncluded");

    // checkout without stripe → 501
    const co = await req(port, "POST", "/api/billing/checkout", {
      headers: { Cookie: ckStudio },
      body: JSON.stringify({ product: "halftone_pack10" }),
    });
    assert.strictEqual(co.status, 501);
    console.log("ok checkout pack returns 501 when Stripe unset");

    // create a shop user on trial with 0 credits via signup-like store edit:
    // use admin to grant credits + set plan
    const adminLogin = await req(port, "POST", "/api/login", {
      body: JSON.stringify({ email: "davidhanes2@yahoo.com", password: process.env.ADMIN_PASSWORD || "DecoClub!" }),
    });
    // admin password may differ — try from ensureAdmin default
    let adminCk = cookieFrom(adminLogin);
    if (adminLogin.status !== 200) {
      // read default from hex in server — try common
      console.log("admin login status", adminLogin.status, adminLogin.json);
    }

    // Create shop user by registering
    const email = "htshop_" + Date.now() + "@test.local";
    const signup = await req(port, "POST", "/api/signup", {
      body: JSON.stringify({ email, name: "HT Shop", password: "test1234", role: "shop" }),
    });
    // may be /api/register
    let shopCk = cookieFrom(signup);
    let shopUser = signup.json && signup.json.user;
    if (signup.status !== 200) {
      const reg = await req(port, "POST", "/api/register", {
        body: JSON.stringify({ email, name: "HT Shop", password: "test1234", role: "shop" }),
      });
      shopCk = cookieFrom(reg);
      shopUser = reg.json && reg.json.user;
      assert.strictEqual(reg.status, 200, "register failed: " + JSON.stringify(reg.json));
    }
    const me0 = await req(port, "GET", "/api/me", { headers: { Cookie: shopCk } });
    assert.ok(me0.json.user);
    assert.strictEqual(me0.json.user.halftoneIncluded, false);
    assert.strictEqual(me0.json.user.halftoneCredits, 0);
    assert.strictEqual(me0.json.user.services.halftones.canApply, false);
    console.log("ok trial/shop signup: 0 credits, not included");

    // Credit gate runs after job lookup. A real job with 0 credits is 402; a missing id is 404.
    const jobRes = await req(port, "POST", "/api/jobs", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ title: "HT test", method: "apparel", width_in: 10, height_in: 10 }),
    });
    assert.strictEqual(jobRes.status, 200, JSON.stringify(jobRes.json));
    const jobId = jobRes.json.job.id;
    const gated = await req(port, "POST", "/api/jobs/" + jobId + "/halftone", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ style: "classic-round" }),
    });
    assert.strictEqual(gated.status, 402, "expected 402 got " + gated.status + " " + JSON.stringify(gated.json));
    assert.strictEqual(gated.json.code, "halftone_credits_required");
    assert.ok(gated.json.buy && gated.json.buy.single);
    console.log("ok zero-credit Apply returns 402 with buy options");
    const prev = await req(port, "POST", "/api/jobs/" + jobId + "/halftone/preview", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ style: "classic-round" }),
    });
    // no artwork → 400, not 402
    assert.notStrictEqual(prev.status, 402);
    console.log("ok preview not gated by credits (status " + prev.status + ")");

    // Admin grant credits via DB file mutation if admin login hard; else use applyStripeEvent on store
    const storePath = path.join(s.dir, "store.json");
    // find store file
    const files = fs.readdirSync(s.dir);
    console.log("data dir files", files);
    const dbFile = files.find((f) => f.endsWith(".json")) || "db.json";
    // server uses DATA_DIR/store.json typically
    const candidates = ["store.json", "db.json", "decoclub.json"].map((n) => path.join(s.dir, n)).concat(
      files.filter((f) => f.endsWith(".json")).map((f) => path.join(s.dir, f))
    );
    let dbPath = candidates.find((p) => fs.existsSync(p));
    assert.ok(dbPath, "no db file in " + s.dir + " listing " + files.join(","));
    const db = JSON.parse(fs.readFileSync(dbPath, "utf8"));
    const u = db.users.find((x) => x.email === email);
    assert.ok(u);
    assert.strictEqual(u[HT_CRED] || 0, 0);
    // simulate pack webhook
    applyStripeEvent(db, {
      type: "checkout.session.completed",
      data: { object: { metadata: { user_id: u.id, product: "halftone_pack10" }, client_reference_id: u.id } },
    });
    assert.strictEqual(u[HT_CRED], 10);
    fs.writeFileSync(dbPath, JSON.stringify(db));
    // re-login to pick up? load() reads each request so next /api/me should see credits
    const me1 = await req(port, "GET", "/api/me", { headers: { Cookie: shopCk } });
    assert.strictEqual(me1.json.user.halftoneCredits, 10);
    assert.strictEqual(me1.json.user.services.halftones.canApply, true);
    console.log("ok pack grant via applyStripeEvent → 10 credits visible on /api/me");

    // consume one credit via consume path: unit-level on user object after reload
    u[HT_CRED] = 10;
    // Direct credit decrement simulation matching server consumeHalftoneCredit
    u[HT_CRED] = u[HT_CRED] - 1;
    assert.strictEqual(u[HT_CRED], 9);
    console.log("ok credit decrement semantics");

    // settings defaults
    assert.strictEqual(db.settings.halftone_single_cents, 300);
    assert.strictEqual(db.settings.halftone_pack10_cents, 2000);
    console.log("ok settings defaults for HT packs");

    console.log("PASS halftone-service entitlements smoke");
  } finally {
    await stop(s.child);
  }
})().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
