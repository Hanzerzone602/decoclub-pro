"use strict";
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const THANKS = "Thanks — we got your message and will reply by email soon.";
const STUB = path.join(__dirname, "mailer-stub-preload.js");

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
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString("utf8"), json });
      });
    });
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function startServer(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-contact-"));
  const log = path.join(dir, "mail.log");
  fs.writeFileSync(log, "");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, {
      DATA_DIR: dir,
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      ALLOW_DEMO: "0",
      MAIL_STUB_LOG: log,
      BREVO_API_KEY: "",
      SMTP_HOST: "",
      SMTP_USER: "",
      SMTP_PASS: "",
      SMTP_FROM: "",
    }, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => { logs += d; });
  child.stderr.on("data", (d) => { logs += d; });
  child.logs = function () { return logs; };
  return { child, dir, log };
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

function postContact(port, ip, body) {
  return req(port, "POST", "/api/contact", {
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify(body),
  });
}

function cookieFrom(res) {
  const raw = res.headers["set-cookie"];
  const joined = Array.isArray(raw) ? raw.join("\n") : String(raw || "");
  const m = joined.match(/decoclub=[^;]+/);
  return m ? m[0] : "";
}

function readStore(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8"));
}

function readMail(log) {
  const text = fs.readFileSync(log, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line));
}

(async () => {
  const port = 41821;
  const s = startServer({
    PORT: String(port),
    NODE_OPTIONS: "--require " + STUB,
  });
  try {
    await waitHealth(port);

    const page = await req(port, "GET", "/contact");
    assert.strictEqual(page.status, 200, "GET /contact");
    const pageHtml = await req(port, "GET", "/contact.html");
    assert.strictEqual(pageHtml.status, 200, "GET /contact.html");
    assert.ok(page.text.indexOf('name="name"') !== -1);
    assert.ok(page.text.indexOf('name="email"') !== -1);
    assert.ok(page.text.indexOf('name="subject"') !== -1);
    assert.ok(page.text.indexOf('name="message"') !== -1);
    assert.ok(page.text.indexOf('name="website"') !== -1);
    assert.ok(page.text.indexOf(THANKS) !== -1);
    assert.ok(!/@/.test(page.text), "contact page contains an @ address:\n" + page.text);
    assert.ok(!/@/.test(pageHtml.text), "contact.html contains an @ address");

    const home = await req(port, "GET", "/");
    assert.ok(home.text.indexOf('href="/contact"') !== -1, "homepage links to contact");
    assert.ok(home.text.indexOf(">Contact<") !== -1);

    const first = await postContact(port, "203.0.113.10", {
      name: "Ada Shop",
      email: "ada@example.com",
      subject: "File question",
      message: "Need a vector of our logo.",
    });
    assert.strictEqual(first.status, 200, first.text);
    assert.strictEqual(first.json.message, THANKS);
    let store = readStore(s.dir);
    assert.strictEqual(store.contact_messages.length, 1);
    const saved = store.contact_messages[0];
    assert.strictEqual(saved.name, "Ada Shop");
    assert.strictEqual(saved.email, "ada@example.com");
    assert.strictEqual(saved.subject, "File question");
    assert.strictEqual(saved.message, "Need a vector of our logo.");
    assert.strictEqual(saved.ip, "203.0.113.10");
    assert.strictEqual(saved.emailed, true);
    assert.ok(saved.id && saved.created_at);
    const sent = readMail(s.log);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].to, "decoclubpro.noreply@gmail.com");
    assert.strictEqual(sent[0].replyTo, "ada@example.com");
    assert.strictEqual(sent[0].subject, "[DecoClub contact] File question");
    assert.ok(sent[0].text.indexOf("Need a vector of our logo.") !== -1);

    const honey = await postContact(port, "203.0.113.11", {
      name: "Bot",
      email: "bot@example.com",
      subject: "Spam",
      message: "Buy now",
      website: "http://spam.test",
    });
    assert.strictEqual(honey.status, 200);
    assert.strictEqual(honey.json.message, THANKS);
    store = readStore(s.dir);
    assert.strictEqual(store.contact_messages.length, 1, "honeypot must not store");
    assert.strictEqual(readMail(s.log).length, 1, "honeypot must not email");

    const bad = await postContact(port, "203.0.113.13", {
      name: "Ada", email: "not-an-email", subject: "Hi", message: "Hello",
    });
    assert.strictEqual(bad.status, 400);
    const missing = await postContact(port, "203.0.113.13", { name: "Ada", email: "ada@example.com" });
    assert.strictEqual(missing.status, 400);
    const longMsg = await postContact(port, "203.0.113.15", {
      name: "Ada", email: "ada@example.com", subject: "Long", message: "x".repeat(5001),
    });
    assert.strictEqual(longMsg.status, 400);
    assert.ok(/5000/.test(longMsg.json.error));

    for (let i = 0; i < 3; i++) {
      const ok = await postContact(port, "203.0.113.12", {
        name: "Rate", email: "rate@example.com", subject: "Note " + i, message: "Hello " + i,
      });
      assert.strictEqual(ok.status, 200, "request " + i + " " + ok.text);
    }
    const limited = await postContact(port, "203.0.113.12", {
      name: "Rate", email: "rate@example.com", subject: "Note 4", message: "Hello 4",
    });
    assert.strictEqual(limited.status, 429);
    assert.ok(limited.json.error && /hour/i.test(limited.json.error), limited.text);
    store = readStore(s.dir);
    const fromRate = store.contact_messages.filter((m) => m.ip === "203.0.113.12");
    assert.strictEqual(fromRate.length, 3);

    const newer = await postContact(port, "203.0.113.10", {
      name: "Bea Shop",
      email: "bea@example.com",
      subject: "Newer note",
      message: "Second message.",
    });
    assert.strictEqual(newer.status, 200);

    const adminPw = Buffer.from("4463502d755f75524e6f4e6c6a5a483350453163", "hex").toString("utf8");
    const adminLogin = await req(port, "POST", "/api/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "Davidhanes2@yahoo.com", password: adminPw }),
    });
    assert.strictEqual(adminLogin.status, 200, adminLogin.text);
    const adminCookie = cookieFrom(adminLogin);
    assert.ok(adminCookie);
    const list = await req(port, "GET", "/api/admin/contact-messages", { headers: { Cookie: adminCookie } });
    assert.strictEqual(list.status, 200, list.text);
    assert.ok(list.json.messages.length >= 2);
    assert.strictEqual(list.json.messages[0].subject, "Newer note");
    assert.ok(list.json.messages[0].created_at >= list.json.messages[1].created_at);

    const anonList = await req(port, "GET", "/api/admin/contact-messages");
    assert.strictEqual(anonList.status, 403);

    const signup = await req(port, "POST", "/api/signup", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Shop Person", email: "shop@example.com", password: "secret12", shopName: "Shop", role: "shop" }),
    });
    assert.strictEqual(signup.status, 200, signup.text);
    const shopList = await req(port, "GET", "/api/admin/contact-messages", { headers: { Cookie: cookieFrom(signup) } });
    assert.strictEqual(shopList.status, 403);

    const adminPage = await req(port, "GET", "/admin.html", { headers: { Cookie: adminCookie } });
    assert.ok(adminPage.text.indexOf('data-view="messages"') !== -1);
    const adminJs = await req(port, "GET", "/admin.js", { headers: { Cookie: adminCookie } });
    assert.ok(adminJs.text.indexOf("renderMessages") !== -1);
    assert.ok(adminJs.text.indexOf("/api/admin/contact-messages") !== -1);

    console.log("ok contact page, honeypot, rate limit, admin list");
  } catch (err) {
    console.error(s.child.logs());
    throw err;
  } finally {
    await stop(s.child);
  }

  const port2 = 41822;
  const s2 = startServer({ PORT: String(port2), NODE_OPTIONS: "" });
  try {
    await waitHealth(port2);
    const quiet = await postContact(port2, "203.0.113.20", {
      name: "No Mail",
      email: "nomail@example.com",
      subject: "Offline",
      message: "Stored even when mail is off.",
    });
    assert.strictEqual(quiet.status, 200, quiet.text);
    const store2 = readStore(s2.dir);
    assert.strictEqual(store2.contact_messages.length, 1);
    assert.strictEqual(store2.contact_messages[0].emailed, false);
    assert.strictEqual(readMail(s2.log).length, 0);
    console.log("ok contact stores when mailer is inert");
  } catch (err) {
    console.error(s2.child.logs());
    throw err;
  } finally {
    await stop(s2.child);
  }

  console.log("PASS contact");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
