"use strict";
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { applyStripeEvent, billingConfigured } = require("../lib/stripe");
function req(port, method, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers: opts.headers || {} }, (res) => {
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

async function waitHealth(port) {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await req(port, "GET", "/health");
      if (r.status === 200) return r;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { DATA_DIR: dir, HOST: "127.0.0.1" }, env),
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
  const db = { users: [{ id: "u1", plan: "trial" }] };
  applyStripeEvent(db, { type: "checkout.session.completed", data: { object: { metadata: { user_id: "u1", plan: "shop" }, client_reference_id: "u1" } } });
  assert.strictEqual(db.users[0].plan, "shop");
  console.log("ok stripe webhook applies plan");
}

(async () => {
  const port = 41236;
  const s = startServer({ PORT: String(port), NODE_ENV: "production", ALLOW_DEMO: "0" });
  try {
    const h = await waitHealth(port);
    assert.strictEqual(h.json.ok, true);
    assert.strictEqual(h.json.name, "DecoClub Pro");
    const loginPage = await req(port, "GET", "/login.html");
    assert.strictEqual(loginPage.status, 200);
    assert.ok(loginPage.text.indexOf("DecoClub Pro") !== -1);
    assert.ok(loginPage.text.indexOf("owner@anvil.local") === -1);
    assert.ok(loginPage.text.indexOf("/admin.html") === -1);
    assert.ok(loginPage.text.indexOf("/app.html") !== -1);
    const appPage = await req(port, "GET", "/app.html");
    assert.strictEqual(appPage.status, 200);
    assert.ok(appPage.text.indexOf("data-view=\"make\"") !== -1);
    assert.ok(appPage.text.indexOf("Office") !== -1);
    const appJs = await req(port, "GET", "/app.js");
    assert.ok(appJs.text.indexOf("Drop your art here") !== -1);
    assert.ok(appJs.text.indexOf("or tap to pick a file") !== -1);
    const cfg = await req(port, "GET", "/api/config");
    assert.strictEqual(cfg.json.demo, false);
    const store = JSON.parse(fs.readFileSync(path.join(s.dir, "store.json"), "utf8"));
    assert.strictEqual(store.users.length, 1);
    assert.strictEqual(store.users[0].role, "admin");
    assert.ok(store.users[0].shop_id);
    assert.strictEqual(store.shops.length, 1);
    assert.strictEqual(store.shops[0].name, "My shop");
    assert.ok(store.users[0].password_hash.indexOf(":") > 0);
    assert.strictEqual(store.settings.trial_days, 7);
    assert.strictEqual(store.settings.shop_price_cents, 7900);
    const cat = await req(port, "GET", "/api/catalog");
    assert.strictEqual(cat.status, 200);
    assert.strictEqual(cat.json.total, 1000);
    assert.strictEqual(cat.json.skus.length, 1000);
    const denied = await req(port, "GET", "/api/admin/users");
    assert.strictEqual(denied.status, 403);
    const signup = await req(port, "POST", "/api/signup", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ada", email: "ada@shop.test", password: "secret1", shopName: "Ada Press", role: "shop" }),
    });
    assert.strictEqual(signup.status, 200);
    const setCookie = String(signup.headers["set-cookie"] || "");
    assert.ok(setCookie.indexOf("decoclub=") === 0);
    assert.ok(setCookie.indexOf("HttpOnly") !== -1);
    assert.ok(setCookie.indexOf("SameSite=Lax") !== -1);
    const cookie = setCookie.split(";")[0];
    const bill = await req(port, "POST", "/api/billing/checkout", {
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ plan: "shop" }),
    });
    assert.strictEqual(bill.status, 501);
    assert.strictEqual(bill.json.error, "Billing not configured");
    const after = JSON.parse(fs.readFileSync(path.join(s.dir, "store.json"), "utf8"));
    assert.strictEqual(after.users.find((u) => u.email === "ada@shop.test").plan, "trial");
    const job = await req(port, "POST", "/api/jobs", {
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ title: "Hats", method: "hat", width_in: 3, height_in: 2, qty: 12 }),
    });
    assert.strictEqual(job.status, 200);
    assert.ok(job.json.job.proof_token.length >= 64);
    assert.ok(job.json.job.proof_url.indexOf("/proof.html?t=") !== -1);
    const pack = await req(port, "GET", "/api/export/" + job.json.job.id + "/cut-contour.svg", { headers: { Cookie: cookie } });
    assert.strictEqual(pack.status, 200);
    assert.ok(pack.text.indexOf("<svg") !== -1);
    console.log("ok production health login signup cookie billing 501 proof token exports");
  } finally {
    await stop(s.child);
  }

  const port2 = 41237;
  const s2 = startServer({ PORT: String(port2), NODE_ENV: "development", ALLOW_DEMO: "1" });
  try {
    await waitHealth(port2);
    const cfg = await req(port2, "GET", "/api/config");
    assert.strictEqual(cfg.json.demo, true);
    const login = await req(port2, "POST", "/api/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@anvil.local", password: "anvil123" }),
    });
    assert.strictEqual(login.status, 200);
    console.log("ok demo seed login");
    const shopCookie = String(login.headers["set-cookie"] || "").split(";")[0];
    const shopAdmin = await req(port2, "GET", "/api/admin/settings", { headers: { Cookie: shopCookie } });
    assert.strictEqual(shopAdmin.status, 403);
    const jobMk = await req(port2, "POST", "/api/jobs", {
      headers: { "Content-Type": "application/json", Cookie: shopCookie },
      body: JSON.stringify({ title: "PC54 black", method: "apparel", catalog_code: "PC54-BLACK", placement: "chest" }),
    });
    assert.strictEqual(jobMk.status, 200);
    assert.strictEqual(jobMk.json.job.catalog_code, "PC54-BLACK");
    assert.strictEqual(jobMk.json.job.blank, "tee");
    const mk = await req(port2, "POST", "/api/jobs/" + jobMk.json.job.id + "/mockup", {
      headers: { "Content-Type": "application/json", Cookie: shopCookie },
      body: JSON.stringify({ catalog_code: "C112-NAVY", placement: "front" }),
    });
    assert.strictEqual(mk.status, 200);
    assert.strictEqual(mk.json.job.catalog_code, "C112-NAVY");
    assert.strictEqual(mk.json.job.blank, "hat");
    const png = await req(port2, "GET", mk.json.job.mockup_path);
    assert.strictEqual(png.status, 200);
    assert.ok(png.buf[0] === 0x89 && png.buf[1] === 0x50);
  } finally {
    await stop(s2.child);
  }

  const port3 = 41238;
  const s3 = startServer({ PORT: String(port3), NODE_ENV: "production", ALLOW_DEMO: "0" });
  try {
    await waitHealth(port3);
    const adminPw = Buffer.from("4463502d755f75524e6f4e6c6a5a483350453163", "hex").toString("utf8");
    const adminLogin = await req(port3, "POST", "/api/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "david@coreltrainer.com", password: adminPw }),
    });
    assert.strictEqual(adminLogin.status, 200);
    assert.strictEqual(adminLogin.json.user.role, "admin");
    assert.strictEqual(adminLogin.json.user.name, "David Hanes");
    assert.ok(adminLogin.json.user.shopId);
    const cookie = String(adminLogin.headers["set-cookie"] || "").split(";")[0];
    const adminJob = await req(port3, "POST", "/api/jobs", {
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ title: "Admin drop", method: "apparel", width_in: 10, height_in: 10, qty: 1 }),
    });
    assert.strictEqual(adminJob.status, 200);
    assert.strictEqual(adminJob.json.job.method, "apparel");
    const adminJobs = await req(port3, "GET", "/api/jobs", { headers: { Cookie: cookie } });
    assert.strictEqual(adminJobs.status, 200);
    assert.ok(adminJobs.json.jobs.some(function (j) { return j.title === "Admin drop"; }));
    const settings = await req(port3, "GET", "/api/admin/settings", { headers: { Cookie: cookie } });
    assert.strictEqual(settings.status, 200);
    assert.strictEqual(settings.json.settings.shop_price_cents, 7900);
    const saved = await req(port3, "POST", "/api/admin/settings", {
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ trial_days: 3, shop_price_cents: 9900, studio_price_cents: 19900 }),
    });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.json.settings.trial_days, 3);
    const shop = await req(port3, "POST", "/api/admin/shops", {
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "Grant Shop" }),
    });
    assert.strictEqual(shop.status, 200);
    const signup = await req(port3, "POST", "/api/signup", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bea", email: "bea@shop.test", password: "secret1", shopName: "Bea Press" }),
    });
    assert.strictEqual(signup.status, 200);
    const exp = new Date(signup.json.user.planExpires).getTime() - Date.now();
    assert.ok(exp > 2 * 864e5 && exp < 4 * 864e5, "trial uses settings.trial_days");
    const users = await req(port3, "GET", "/api/admin/users", { headers: { Cookie: cookie } });
    const bea = users.json.users.find((u) => u.email === "bea@shop.test");
    const granted = await req(port3, "POST", "/api/admin/users/" + bea.id + "/plan", {
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ plan: "shop", complimentary_months: 3 }),
    });
    assert.strictEqual(granted.status, 200);
    assert.strictEqual(granted.json.user.plan, "shop");
    const months = (new Date(granted.json.user.plan_expires).getTime() - Date.now()) / (30 * 864e5);
    assert.ok(months > 2.5 && months < 4, "complimentary months applied");
    const page = await req(port3, "GET", "/admin.html");
    assert.strictEqual(page.status, 200);
    assert.ok(page.text.indexOf("admin.js") !== -1);
    assert.ok(page.text.indexOf("Make something") !== -1);
    assert.ok(page.text.indexOf("/app.html") !== -1);
    const envPort = 41239;
    const s4 = startServer({ PORT: String(envPort), NODE_ENV: "production", ALLOW_DEMO: "0", ADMIN_EMAIL: "ops@decoclub.test" });
    try {
      await waitHealth(envPort);
      const envLogin = await req(envPort, "POST", "/api/login", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ops@decoclub.test", password: adminPw }),
      });
      assert.strictEqual(envLogin.status, 200);
      assert.strictEqual(envLogin.json.user.role, "admin");
    } finally {
      await stop(s4.child);
    }
    console.log("ok admin seed settings shops grant");
  } finally {
    await stop(s3.child);
  }

  const portLegacy = 41240;
  const dirLegacy = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-legacy-"));
  const adminPwLegacy = Buffer.from("4463502d755f75524e6f4e6c6a5a483350453163", "hex").toString("utf8");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = salt + ":" + crypto.scryptSync(adminPwLegacy, salt, 32).toString("hex");
  fs.writeFileSync(path.join(dirLegacy, "store.json"), JSON.stringify({
    shops: [], users: [{
      id: "admin-legacy", email: "david@coreltrainer.com", name: "David Hanes",
      password_hash: hash, role: "admin", shop_id: null, plan: "studio", plan_expires: null,
      created_at: new Date().toISOString(),
    }], sessions: [], jobs: [], events: [],
    settings: { trial_days: 7, shop_price_cents: 7900, studio_price_cents: 14900 },
  }, null, 2));
  const childLegacy = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { DATA_DIR: dirLegacy, HOST: "127.0.0.1", PORT: String(portLegacy), NODE_ENV: "production", ALLOW_DEMO: "0" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitHealth(portLegacy);
    const attached = JSON.parse(fs.readFileSync(path.join(dirLegacy, "store.json"), "utf8"));
    assert.ok(attached.users[0].shop_id, "existing admin without shop_id gets a shop on load");
    assert.strictEqual(attached.shops[0].name, "My shop");
    const lg = await req(portLegacy, "POST", "/api/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "david@coreltrainer.com", password: adminPwLegacy }),
    });
    assert.strictEqual(lg.status, 200);
    const ck = String(lg.headers["set-cookie"] || "").split(";")[0];
    const job = await req(portLegacy, "POST", "/api/jobs", {
      headers: { "Content-Type": "application/json", Cookie: ck },
      body: JSON.stringify({ title: "From drop", method: "dtf", width_in: 10, height_in: 10, qty: 1 }),
    });
    assert.strictEqual(job.status, 200);
    console.log("ok legacy admin shop attach + floor job");
  } finally {
    await stop(childLegacy);
  }

  console.log("server tests passed");
})().catch((err) => { console.error(err); process.exit(1); });
