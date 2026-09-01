"use strict";
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
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
    const cfg = await req(port, "GET", "/api/config");
    assert.strictEqual(cfg.json.demo, false);
    const store = JSON.parse(fs.readFileSync(path.join(s.dir, "store.json"), "utf8"));
    assert.strictEqual(store.users.length, 0);
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
    assert.strictEqual(after.users[0].plan, "trial");
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
  } finally {
    await stop(s2.child);
  }
  console.log("server tests passed");
})().catch((err) => { console.error(err); process.exit(1); });
