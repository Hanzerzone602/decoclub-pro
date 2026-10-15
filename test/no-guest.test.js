"use strict";
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

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
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString("utf8"), json });
      });
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-noguest-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, {
      DATA_DIR: dir,
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOW_DEMO: "0",
      FEATURE_MEMBERSHIP: "",
      FEATURE_DIGITIZE: "",
    }, env),
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

function cookieOf(res) {
  return String(res.headers["set-cookie"] || "").split(";")[0];
}

function assertNoGuest(label, text) {
  assert.ok(!/guest/i.test(text), label + " contains guest");
  assert.ok(!/try without an account/i.test(text), label + " offers an account-free trial");
  assert.ok(!/anonymous trial/i.test(text), label + " offers an anonymous trial");
  assert.ok(!/continue as guest/i.test(text), label + " offers continue as guest");
}

(async () => {
  const port = 41947;
  const s = startServer({ PORT: String(port) });
  try {
    await waitHealth(port);

    const publicPages = [
      "/",
      "/index.html",
      "/login.html",
      "/login",
      "/signup.html",
      "/signup",
      "/contact",
      "/contact.html",
      "/proof.html",
      "/intake.html",
      "/styles.css",
      "/home.css",
      "/app.js",
      "/logo.png",
      "/api/config",
    ];
    const bodies = {};
    for (const p of publicPages) {
      const r = await req(port, "GET", p);
      assert.strictEqual(r.status, 200, "public " + p + " " + r.status);
      bodies[p] = r.text;
    }
    assert.ok(bodies["/"].indexOf('id="pricing"') !== -1, "pricing stays on the public homepage");
    assert.ok(bodies["/"].indexOf('href="/signup.html">Try a free preview</a>') !== -1);
    assert.ok(bodies["/"].indexOf('href="/signup.html">Start vectorizing</a>') !== -1);
    assert.ok(bodies["/api/config"].indexOf("DecoClub Pro") !== -1);
    assert.strictEqual(JSON.parse(bodies["/api/config"]).demo, false);

    const contact = await req(port, "POST", "/api/contact", {
      body: JSON.stringify({ name: "Ada Shop", email: "ada@example.com", subject: "Pricing", message: "Question about the first image." }),
    });
    assert.strictEqual(contact.status, 200, contact.text);

    const verify = await req(port, "GET", "/api/verify");
    assert.notStrictEqual(verify.status, 401, "email verify stays public");
    assert.strictEqual(verify.status, 302);
    assert.ok(String(verify.headers.location || "").indexOf("/login.html?verify=expired") !== -1);

    const stayPublic = ["/privacy", "/privacy.html", "/terms", "/terms.html", "/legal", "/forgot.html", "/reset.html", "/reset-password.html"];
    for (const p of stayPublic) {
      const r = await req(port, "GET", p);
      assert.notStrictEqual(r.status, 401, p);
      if (r.status === 302) {
        assert.ok(String(r.headers.location || "").indexOf("/login.html") !== 0, p + " redirected to login");
      }
    }

    const studioAnon = [
      ["/app.html", "/app.html"],
      ["/app", "/app"],
      ["/start.html", "/start.html"],
      ["/start", "/start"],
      ["/start.html?method=apparel&tool=halftones", "/start.html?method=apparel&tool=halftones"],
    ];
    for (const pair of studioAnon) {
      const r = await req(port, "GET", pair[0]);
      assert.strictEqual(r.status, 302, pair[0]);
      assert.strictEqual(r.headers.location, "/login.html?next=" + encodeURIComponent(pair[1]), r.headers.location);
    }

    const toolCalls = [
      ["POST", "/api/jobs", JSON.stringify({ title: "Nope", method: "apparel" })],
      ["POST", "/api/jobs/x/artwork", ""],
      ["POST", "/api/jobs/x/vectorize", JSON.stringify({ colors: 2 })],
      ["POST", "/api/jobs/x/halftone", JSON.stringify({ style: "classic-round" })],
      ["POST", "/api/jobs/x/halftone/preview", JSON.stringify({ style: "classic-round" })],
      ["POST", "/api/jobs/x/artops", JSON.stringify({ remove_background: true })],
      ["POST", "/api/jobs/x/corel-import", "{}"],
      ["POST", "/api/jobs/x/recolor", JSON.stringify({ layer: 0, hex: "#000000" })],
      ["GET", "/api/export/x/art.svg", null],
      ["GET", "/api/export/x", null],
      ["GET", "/api/halftone/styles", null],
      ["POST", "/api/guest", "{}"],
      ["POST", "/api/trial", "{}"],
      ["POST", "/api/anonymous", "{}"],
    ];
    for (const call of toolCalls) {
      const r = await req(port, call[0], call[1], call[2] == null ? {} : { body: call[2] });
      assert.strictEqual(r.status, 401, call[0] + " " + call[1] + " " + r.status + " " + r.text);
    }

    const customerText = [
      ["/", bodies["/"]],
      ["/index.html", bodies["/index.html"]],
      ["/login.html", bodies["/login.html"]],
      ["/signup.html", bodies["/signup.html"]],
      ["/contact.html", bodies["/contact.html"]],
      ["/proof.html", bodies["/proof.html"]],
      ["/intake.html", bodies["/intake.html"]],
      ["/app.js", bodies["/app.js"]],
      ["/styles.css", bodies["/styles.css"]],
      ["/home.css", bodies["/home.css"]],
    ];
    customerText.forEach(function (row) { assertNoGuest(row[0], row[1]); });

    const signup = await req(port, "POST", "/api/signup", {
      body: JSON.stringify({ name: "No Guest", email: "noguest@test.local", password: "test1234", shopName: "NG Studio" }),
    });
    assert.strictEqual(signup.status, 200, signup.text);
    const cookie = cookieOf(signup);
    assert.ok(cookie.indexOf("decoclub=") === 0);

    const meLocked = await req(port, "GET", "/api/me", { headers: { Cookie: cookie } });
    assert.strictEqual(meLocked.status, 200);
    assert.strictEqual(meLocked.json.user.freeImageAvailable, false);
    assert.strictEqual(meLocked.json.user.freeImageReason, "unverified");

    const app = await req(port, "GET", "/app.html", { headers: { Cookie: cookie } });
    assert.strictEqual(app.status, 200);
    assert.ok(app.text.indexOf("data-view=\"make\"") !== -1);
    assertNoGuest("/app.html", app.text);
    const start = await req(port, "GET", "/start.html?method=apparel&tool=halftones", { headers: { Cookie: cookie } });
    assert.strictEqual(start.status, 200);
    assertNoGuest("/start.html", start.text);

    const job = await req(port, "POST", "/api/jobs", {
      headers: { Cookie: cookie },
      body: JSON.stringify({ title: "Signed in", method: "apparel", width_in: 4, height_in: 4 }),
    });
    assert.strictEqual(job.status, 200, job.text);
    const id = job.json.job.id;

    const vectorize = await req(port, "POST", "/api/jobs/" + id + "/vectorize", {
      headers: { Cookie: cookie },
      body: JSON.stringify({ colors: 2 }),
    });
    assert.strictEqual(vectorize.status, 400, vectorize.text);
    const preview = await req(port, "POST", "/api/jobs/" + id + "/halftone/preview", {
      headers: { Cookie: cookie },
      body: JSON.stringify({ style: "classic-round" }),
    });
    assert.strictEqual(preview.status, 400, preview.text);
    const halftone = await req(port, "POST", "/api/jobs/" + id + "/halftone", {
      headers: { Cookie: cookie },
      body: JSON.stringify({ style: "classic-round" }),
    });
    assert.strictEqual(halftone.status, 402, halftone.text);
    const artops = await req(port, "POST", "/api/jobs/" + id + "/artops", {
      headers: { Cookie: cookie },
      body: JSON.stringify({ remove_background: true }),
    });
    assert.strictEqual(artops.status, 400, artops.text);
    const missingExport = await req(port, "GET", "/api/export/missing/art.svg", { headers: { Cookie: cookie } });
    assert.strictEqual(missingExport.status, 404);
    const styles = await req(port, "GET", "/api/halftone/styles", { headers: { Cookie: cookie } });
    assert.strictEqual(styles.status, 200);
    assert.ok(Array.isArray(styles.json.styles) && styles.json.styles.length > 0);

    const adminPw = Buffer.from("4463502d755f75524e6f4e6c6a5a483350453163", "hex").toString("utf8");
    const admin = await req(port, "POST", "/api/login", {
      body: JSON.stringify({ email: "Davidhanes2@yahoo.com", password: adminPw }),
    });
    assert.strictEqual(admin.status, 200, admin.text);
    const adminCookie = cookieOf(admin);
    const verified = await req(port, "PATCH", "/api/admin/users/" + meLocked.json.user.id, {
      headers: { Cookie: adminCookie },
      body: JSON.stringify({ email_verified: true }),
    });
    assert.strictEqual(verified.status, 200, verified.text);
    const meFree = await req(port, "GET", "/api/me", { headers: { Cookie: cookie } });
    assert.strictEqual(meFree.json.user.emailVerified, true);
    assert.strictEqual(meFree.json.user.freeImageAvailable, true, JSON.stringify(meFree.json.user));

    const adminApp = await req(port, "GET", "/app.html", { headers: { Cookie: adminCookie } });
    assert.strictEqual(adminApp.status, 200);
    const adminJob = await req(port, "POST", "/api/jobs", {
      headers: { Cookie: adminCookie },
      body: JSON.stringify({ title: "Admin still", method: "apparel", width_in: 3, height_in: 3 }),
    });
    assert.strictEqual(adminJob.status, 200, adminJob.text);

    console.log("ok no guest: public pages open, studio tools require an account");
  } finally {
    await stop(s.child);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
