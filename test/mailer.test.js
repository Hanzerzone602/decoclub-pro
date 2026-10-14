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
  console.log("mailer tests passed");
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
