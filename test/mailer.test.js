"use strict";
// Local fake SMTP server (plain, implicit-TLS skipped) to check the mailer protocol without any real service.
const assert = require("assert");
const net = require("net");
(async () => {
  delete process.env.SMTP_HOST;
  let mailer = require("../lib/mailer");
  assert.strictEqual(mailer.configured(), false);
  let threw = null;
  try { await mailer.sendMail({ to: "a@b.c", subject: "x", text: "y" }); } catch (e) { threw = e; }
  assert.strictEqual(threw && threw.code, "smtp_unconfigured");
  console.log("ok mailer inert without SMTP env");
  // STARTTLS is required on 587; a fake server that doesn't offer it must be refused (no plaintext AUTH).
  const srv = net.createServer((s) => {
    s.write("220 fake\r\n");
    s.on("data", (d) => { const l = String(d); if (/^EHLO/i.test(l)) s.write("250-fake\r\n250 AUTH LOGIN\r\n"); else if (/^QUIT/i.test(l)) s.end(); });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: String(srv.address().port), SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "DecoClub <u@x.test>" });
  assert.strictEqual(mailer.configured(), true);
  threw = null;
  try { await mailer.sendMail({ to: "a@b.c", subject: "x", text: "y" }); } catch (e) { threw = e; }
  assert.ok(threw && /STARTTLS/.test(threw.message), "must refuse plaintext auth: " + (threw && threw.message));
  srv.close();
  console.log("ok mailer refuses servers without STARTTLS");
  // Brevo path: local fake HTTPS-API stand-in (http) — no real key, no network.
  const http = require("http");
  let got = null;
  const api = http.createServer((q, s) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => { got = { key: q.headers["api-key"], body: JSON.parse(b) }; s.writeHead(201, { "content-type": "application/json" }); s.end('{"messageId":"<t@fake>"}'); }); });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  Object.assign(process.env, { BREVO_API_KEY: "test-key", BREVO_API_URL: "http://127.0.0.1:" + api.address().port + "/v3/smtp/email" });
  assert.strictEqual(mailer.provider(), "brevo");
  const res = await mailer.sendMail({ to: "a@b.c", subject: "Hi\nX", text: "body" });
  assert.strictEqual(res.messageId, "<t@fake>");
  assert.strictEqual(got.key, "test-key");
  assert.deepStrictEqual(got.body.sender, { name: "DecoClub Pro", email: "decoclubpro.noreply@gmail.com" });
  assert.strictEqual(got.body.to[0].email, "a@b.c");
  assert.strictEqual(got.body.subject, "Hi X");
  assert.strictEqual(got.body.replyTo, undefined);
  await mailer.sendMail({ to: "a@b.c", replyTo: "buyer@shop.test", subject: "Hi", text: "body" });
  assert.deepStrictEqual(got.body.replyTo, { email: "buyer@shop.test" });
  api.close();
  delete process.env.BREVO_API_KEY;
  assert.strictEqual(mailer.provider(), "smtp");
  console.log("ok mailer uses Brevo API when BREVO_API_KEY set, SMTP fallback otherwise");
  console.log("mailer tests passed");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
