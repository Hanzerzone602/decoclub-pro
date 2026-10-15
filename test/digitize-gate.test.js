"use strict";
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.FEATURE_DIGITIZE = "1";
process.env.FEATURE_MEMBERSHIP = "1";

const FORBIDDEN = /digitiz|embroider/i;

function req(port, method, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body && !headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-gate-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, { DATA_DIR: dir, HOST: "127.0.0.1" }, env),
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

function assertClean(label, text) {
  const hit = String(text || "").match(FORBIDDEN);
  assert.ok(!hit, label + " leaked " + (hit && hit[0]));
}

function cookieOf(res) {
  return String(res.headers["set-cookie"] || "").split(";")[0];
}

(async () => {
  const port = 41471;
  const s = startServer({ PORT: String(port), NODE_ENV: "production", ALLOW_DEMO: "0", FEATURE_DIGITIZE: "1", FEATURE_MEMBERSHIP: "1" });
  try {
    await waitHealth(port);
    const pages = ["/", "/index.html", "/signup.html", "/login.html", "/app.js", "/styles.css", "/api/config"];
    const studioPages = ["/start.html", "/app.html"];
    for (const p of pages) {
      const r = await req(port, "GET", p);
      assert.strictEqual(r.status, 200, p + " " + r.status);
      assertClean("anon " + p, r.text);
    }
    for (const p of studioPages) {
      const r = await req(port, "GET", p);
      assert.strictEqual(r.status, 302, "anon studio " + p + " " + r.status);
      const loc = String(r.headers.location || "");
      assert.ok(loc.indexOf("/login.html?next=") === 0, loc);
      assertClean("anon " + p, r.text + " " + loc);
    }
    const anonJson = ["/api/me", "/api/shop", "/api/catalog", "/api/services", "/api/palettes", "/health"];
    for (const p of anonJson) {
      const r = await req(port, "GET", p);
      assertClean("anon " + p, r.text);
    }
    const cat = await req(port, "GET", "/api/catalog");
    assert.strictEqual(cat.json.total, 1000);
    assert.strictEqual(cat.json.skus.length, 1000);
    const cfg = await req(port, "GET", "/api/config");
    assert.ok(!cfg.json.adminModules);
    assert.ok(!("digitize" in (cfg.json.features || {})));
    assert.ok(!("digitize" in (cfg.json.services || {})));
    assert.ok((cfg.json.methods || []).indexOf("embroidery") === -1);
    assert.strictEqual((await req(port, "GET", "/digitize-preview.js")).status, 404);
    assert.strictEqual((await req(port, "GET", "/digitize-admin.js")).status, 404);
    assert.strictEqual((await req(port, "GET", "/digitize-demo.html")).status, 404);
    const digAnon = await req(port, "POST", "/api/jobs/nope/digitize", { body: "{}" });
    assert.ok(digAnon.status === 401 || digAnon.status === 403, "anon digitize " + digAnon.status);
    const dstAnon = await req(port, "GET", "/api/export/nope/design.dst");
    assert.ok(dstAnon.status === 401 || dstAnon.status === 403, "anon dst " + dstAnon.status);
    assertClean("anon digitize body", digAnon.text);
    assertClean("anon dst body", dstAnon.text);

    const signup = await req(port, "POST", "/api/signup", {
      body: JSON.stringify({ name: "Gate Shop", email: "gate-shop@test.local", password: "test1234", role: "shop", shopName: "Gate Shop" }),
    });
    assert.strictEqual(signup.status, 200, JSON.stringify(signup.json));
    const cookie = cookieOf(signup);
    assert.ok(cookie.indexOf("decoclub=") === 0);
    for (const p of pages.concat(studioPages)) {
      const r = await req(port, "GET", p, { headers: { Cookie: cookie } });
      assert.strictEqual(r.status, 200, "shop " + p);
      assertClean("shop " + p, r.text);
    }
    const studio = ["/api/config", "/api/me", "/api/shop", "/api/jobs", "/api/clients", "/api/palettes", "/api/catalog", "/api/services"];
    for (const p of studio) {
      const r = await req(port, "GET", p, { headers: { Cookie: cookie } });
      assert.ok(r.status < 500, p + " " + r.status);
      assertClean("shop " + p, r.text);
    }
    const shopCfg = await req(port, "GET", "/api/config", { headers: { Cookie: cookie } });
    assert.ok(!shopCfg.json.adminModules, "shop config has no admin modules");
    assert.ok(!("digitize" in shopCfg.json.features));
    assert.ok(!("digitize" in shopCfg.json.services));
    assert.ok((shopCfg.json.methods || []).indexOf("embroidery") === -1);
    const job = await req(port, "POST", "/api/jobs", {
      headers: { Cookie: cookie },
      body: JSON.stringify({ title: "Hat", method: "embroidery", width_in: 2, height_in: 2 }),
    });
    assert.strictEqual(job.status, 200);
    assertClean("shop job", job.text);
    assert.notStrictEqual(job.json.job.method, "embroidery");
    const id = job.json.job.id;
    const got = await req(port, "GET", "/api/jobs/" + id, { headers: { Cookie: cookie } });
    assert.strictEqual(got.status, 200);
    assertClean("shop job get", got.text);
    assert.strictEqual((await req(port, "POST", "/api/jobs/" + id + "/digitize", { headers: { Cookie: cookie }, body: "{}" })).status, 403);
    assert.strictEqual((await req(port, "GET", "/api/export/" + id + "/design.dst", { headers: { Cookie: cookie } })).status, 403);
    assert.strictEqual((await req(port, "GET", "/api/export/" + id + "/design.pes", { headers: { Cookie: cookie } })).status, 403);
    assert.strictEqual((await req(port, "GET", "/api/export/" + id + "/design.exp", { headers: { Cookie: cookie } })).status, 403);
    assert.strictEqual((await req(port, "GET", "/api/export/" + id + "/stitch-preview.svg", { headers: { Cookie: cookie } })).status, 403);
    assert.strictEqual((await req(port, "GET", "/digitize-preview.js", { headers: { Cookie: cookie } })).status, 404);
    assert.strictEqual((await req(port, "GET", "/digitize-admin.js", { headers: { Cookie: cookie } })).status, 404);
    assert.strictEqual((await req(port, "GET", "/digitize-demo.html", { headers: { Cookie: cookie } })).status, 404);

    const adminPw = Buffer.from("4463502d755f75524e6f4e6c6a5a483350453163", "hex").toString("utf8");
    const admin = await req(port, "POST", "/api/login", {
      body: JSON.stringify({ email: "Davidhanes2@yahoo.com", password: adminPw }),
    });
    assert.strictEqual(admin.status, 200, JSON.stringify(admin.json));
    const adCk = cookieOf(admin);
    const adCfg = await req(port, "GET", "/api/config", { headers: { Cookie: adCk } });
    assert.strictEqual(adCfg.json.features.digitize, true);
    assert.strictEqual(adCfg.json.services.digitize, true);
    assert.ok(Array.isArray(adCfg.json.adminModules));
    assert.ok(adCfg.json.adminModules.indexOf("/digitize-preview.js") !== -1);
    assert.ok(adCfg.json.adminModules.indexOf("/digitize-admin.js") !== -1);
    const adPrev = await req(port, "GET", "/digitize-preview.js", { headers: { Cookie: adCk } });
    assert.strictEqual(adPrev.status, 200);
    assert.ok(adPrev.text.indexOf("DigitizePreview") !== -1);
    const adJs = await req(port, "GET", "/digitize-admin.js", { headers: { Cookie: adCk } });
    assert.strictEqual(adJs.status, 200);
    assert.ok(FORBIDDEN.test(adJs.text));
    assert.ok(adJs.text.indexOf("fillDigitize") !== -1);
    const adDemo = await req(port, "GET", "/digitize-demo.html", { headers: { Cookie: adCk } });
    assert.strictEqual(adDemo.status, 200);
    const adJob = await req(port, "POST", "/api/jobs", {
      headers: { Cookie: adCk },
      body: JSON.stringify({ title: "Admin dig", method: "vinyl", width_in: 1, height_in: 1, qty: 1 }),
    });
    assert.strictEqual(adJob.status, 200, JSON.stringify(adJob.json));
    const adDig = await req(port, "POST", "/api/jobs/" + adJob.json.job.id + "/digitize", {
      headers: { Cookie: adCk },
      body: JSON.stringify({ density: 0.4, previewOnly: true, widthIn: 1, heightIn: 1, prep: false }),
    });
    assert.strictEqual(adDig.status, 200, JSON.stringify(adDig.json && adDig.json.error));
    assert.ok(adDig.json.stitchCount > 0 || adDig.json.preview, "admin digitize returned a result");
    console.log("ok digitize gate");
  } catch (err) {
    console.error(s.child.log ? s.child.log() : "");
    throw err;
  } finally {
    await stop(s.child);
  }
  console.log("PASS digitize-gate");
})().catch((err) => {
  console.error("FAIL", err);
  process.exit(1);
});
