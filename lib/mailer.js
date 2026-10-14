"use strict";
// Zero-dependency mail sender: Brevo HTTPS API when BREVO_API_KEY is set, else SMTP fallback.
// SMTP inert until SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM are set.
// SMTP_PORT 465 = implicit TLS; 587/25 = STARTTLS (required when offered). No paid service needed:
// works with an existing mailbox + app password (Gmail, Yahoo, Outlook) or a free-tier SMTP relay.
const net = require("net");
const tls = require("tls");

function config() {
  const e = process.env;
  if (!e.SMTP_HOST || !e.SMTP_USER || !e.SMTP_PASS || !e.SMTP_FROM) return null;
  return { host: e.SMTP_HOST, port: Number(e.SMTP_PORT) || 587, user: e.SMTP_USER, pass: e.SMTP_PASS, from: e.SMTP_FROM };
}
function configured() { return !!(brevoConfig() || config()); }

function addrOf(from) { const m = String(from).match(/<([^>]+)>/); return m ? m[1] : String(from).trim(); }
function clean(s) { return String(s).replace(/[\r\n]+/g, " "); }

// Brevo HTTPS API (Railway Hobby blocks SMTP ports). Preferred whenever BREVO_API_KEY is set.
function brevoConfig() {
  const e = process.env;
  if (!e.BREVO_API_KEY) return null;
  return {
    key: e.BREVO_API_KEY,
    url: e.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email",
    name: e.MAIL_FROM_NAME || "DecoClub Pro",
    email: e.MAIL_FROM_EMAIL || "decoclubpro.noreply@gmail.com",
  };
}
function provider() { return brevoConfig() ? "brevo" : config() ? "smtp" : null; }

async function sendBrevo(b, msg) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, 20000);
  try {
    const payload = {
      sender: { name: b.name, email: b.email },
      to: [{ email: clean(msg.to) }],
      subject: clean(msg.subject),
      textContent: String(msg.text),
    };
    if (msg.replyTo) payload.replyTo = { email: clean(msg.replyTo) };
    const r = await fetch(b.url, {
      method: "POST",
      headers: { "api-key": b.key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    const body = await r.text();
    if (r.status !== 201 && r.status !== 200) throw Object.assign(new Error("Brevo " + r.status + ": " + body.slice(0, 200)), { code: "brevo_error", status: r.status });
    let j = {}; try { j = JSON.parse(body); } catch (e) {}
    return { provider: "brevo", messageId: j.messageId || null };
  } finally { clearTimeout(timer); }
}

function sendMail(msg) {
  const b = brevoConfig();
  if (b) return sendBrevo(b, msg);
  const c = config();
  if (!c) return Promise.reject(Object.assign(new Error("SMTP not configured"), { code: "smtp_unconfigured" }));
  return new Promise(function (resolve, reject) {
    let sock = c.port === 465 ? tls.connect({ host: c.host, port: c.port, servername: c.host }) : net.connect({ host: c.host, port: c.port });
    let buf = "";
    let waiter = null;
    let done = false;
    const timer = setTimeout(function () { fail(new Error("SMTP timeout")); }, 20000);
    function fail(err) { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch (e) {} reject(err); }
    function onData(d) {
      buf += d.toString("utf8");
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const text = lines.slice(0, i + 1).join("\n");
          buf = lines.slice(i + 1).join("\r\n");
          const w = waiter; waiter = null;
          if (w) w(Number(text.slice(text.lastIndexOf("\n") + 1, text.lastIndexOf("\n") + 4)), text);
          return;
        }
      }
    }
    function bind(s) { s.on("data", onData); s.on("error", fail); }
    function read() { return new Promise(function (r) { waiter = function (code, text) { r({ code: code, text: text }); }; }); }
    async function cmd(line, ok) {
      sock.write(line + "\r\n");
      const r = await read();
      if (ok.indexOf(r.code) === -1) throw new Error("SMTP " + r.code + " after " + line.split(" ")[0]);
      return r;
    }
    bind(sock);
    (async function () {
      let r = await read();
      if (r.code !== 220) throw new Error("SMTP greeting " + r.code);
      r = await cmd("EHLO decoclubpro.com", [250]);
      if (c.port !== 465) {
        if (!/STARTTLS/i.test(r.text)) throw new Error("SMTP server does not offer STARTTLS");
        await cmd("STARTTLS", [220]);
        sock.removeAllListeners("data");
        sock = tls.connect({ socket: sock, servername: c.host });
        bind(sock);
        await new Promise(function (ok) { sock.once("secureConnect", ok); });
        await cmd("EHLO decoclubpro.com", [250]);
      }
      await cmd("AUTH LOGIN", [334]);
      await cmd(Buffer.from(c.user).toString("base64"), [334]);
      await cmd(Buffer.from(c.pass).toString("base64"), [235]);
      await cmd("MAIL FROM:<" + addrOf(c.from) + ">", [250]);
      await cmd("RCPT TO:<" + clean(msg.to) + ">", [250, 251]);
      await cmd("DATA", [354]);
      const body = String(msg.text).replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
      const data = [
        "From: " + clean(c.from), "To: " + clean(msg.to),
      ].concat(msg.replyTo ? ["Reply-To: " + clean(msg.replyTo)] : []).concat([
        "Subject: " + clean(msg.subject),
        "Date: " + new Date().toUTCString(), "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body, ".",
      ]).join("\r\n");
      await cmd(data, [250]);
      try { sock.write("QUIT\r\n"); } catch (e) {}
      done = true; clearTimeout(timer); sock.end(); resolve(true);
    })().catch(fail);
  });
}

module.exports = { configured, provider, sendMail };
