const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { priceJob } = require("./lib/price");
const { writeExports } = require("./lib/exports");
const { writeMockups } = require("./lib/mockup");
const { generateBadgePng } = require("./lib/demoart");
const { loadEnvFile, createCheckoutSession } = require("./lib/stripe");

const ROOT = __dirname;
loadEnvFile(ROOT);

const PUBLIC = path.join(ROOT, "public");
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const UPLOADS = path.join(DATA, "uploads");
const EXPORTS = path.join(DATA, "exports");
const DB_PATH = path.join(DATA, "store.json");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(EXPORTS, { recursive: true });

function uid() {
  return crypto.randomBytes(16).toString("hex");
}

function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 32).toString("hex");
  return salt + ":" + hash;
}

function checkPass(pw, stored) {
  const parts = String(stored).split(":");
  const next = crypto.scryptSync(pw, parts[0], 32).toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(parts[1], "hex"), Buffer.from(next, "hex"));
  } catch (e) {
    return false;
  }
}

function seedDemoArt() {
  const p = path.join(UPLOADS, "demo-badge.png");
  if (!fs.existsSync(p)) fs.writeFileSync(p, generateBadgePng());
  return "/uploads/demo-badge.png";
}

function load() {
  if (!fs.existsSync(DB_PATH)) {
    const now = new Date().toISOString();
    const shopId = uid();
    const db = {
      shops: [{ id: shopId, name: "Hearth & Horn Co.", logo_path: null, brand_color: "#d4783c", created_at: now }],
      users: [
        {
          id: uid(), email: "owner@anvil.local", name: "Shop Owner", password_hash: hashPass("anvil123"),
          role: "shop", shop_id: shopId, plan: "studio", plan_expires: null, created_at: now,
        },
        {
          id: uid(), email: "client@anvil.local", name: "Jordan Client", password_hash: hashPass("anvil123"),
          role: "client", shop_id: shopId, plan: "client", plan_expires: null, created_at: now,
        },
      ],
      sessions: [],
      jobs: [],
      events: [],
    };
    save(db);
    return db;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function save(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function ensureDemoJob(db) {
  const art = seedDemoArt();
  const shop = db.shops[0];
  const client = db.users.find((u) => u.email === "client@anvil.local");
  if (shop && shop.name === "Demo Shop") shop.name = "Hearth & Horn Co.";
  db.jobs.forEach((job) => {
    if (job.title === "Walnut badge") {
      job.title = "Forge mark tees";
      job.method = "apparel";
      job.width_in = 10;
      job.height_in = 10;
      job.status = "proof";
      job.client_id = client ? client.id : job.client_id;
      const pricing = priceJob(job);
      job.unit_price = pricing.unit_price;
      job.total = pricing.total;
      job.mockup_path = null;
    }
    if (!job.file_path) job.file_path = art;
    const m = writeMockups(job, UPLOADS, job.file_path);
    job.mockup_path = m.mockup_path;
    job.mockup_svg = m.mockup_svg;
  });
  if (!db.jobs.length && shop) {
    const now = new Date().toISOString();
    const pricing = priceJob({ method: "apparel", width_in: 10, height_in: 10, qty: 24 });
    const job = {
      id: uid(), shop_id: shop.id, client_id: client ? client.id : null,
      title: "Forge mark tees", method: "apparel", status: "proof",
      notes: "Chest print, black heather.", width_in: 10, height_in: 10, qty: 24,
      unit_price: pricing.unit_price, total: pricing.total, file_path: art,
      proof_token: uid(), created_at: now, updated_at: now,
    };
    const m = writeMockups(job, UPLOADS, job.file_path);
    job.mockup_path = m.mockup_path;
    job.mockup_svg = m.mockup_svg;
    db.jobs.push(job);
    db.events.push({ id: uid(), job_id: job.id, message: "Job created · proof mockup ready", created_at: now });
  }
  save(db);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".json": "application/json",
  ".plt": "application/vnd.hp-hpgl",
};

function send(res, code, body, headers) {
  headers = headers || {};
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  res.writeHead(code, Object.assign({ "Content-Length": payload.length }, headers));
  res.end(payload);
}

function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(function (p) {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req, db) {
  const token = parseCookies(req).anvil;
  if (!token) return null;
  const sess = db.sessions.find(function (s) { return s.token === token; });
  if (!sess) return null;
  return db.users.find(function (u) { return u.id === sess.user_id; }) || null;
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, shopId: u.shop_id, plan: u.plan, planExpires: u.plan_expires };
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on("data", function (c) { chunks.push(c); });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

function parseJsonBody(buf) {
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8"));
}

function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) return { fields: {}, file: null };
  const boundary = Buffer.from("--" + (m[1] || m[2]));
  const fields = {};
  let file = null;
  let start = buf.indexOf(boundary, 0);
  while (start !== -1) {
    const after = start + boundary.length + 2;
    const next = buf.indexOf(boundary, after);
    if (next === -1) break;
    const part = buf.slice(after, next - 2);
    const sep = part.indexOf(Buffer.from("\r\n\r\n"));
    if (sep === -1) { start = next; continue; }
    const header = part.slice(0, sep).toString("utf8");
    const body = part.slice(sep + 4);
    const nameMatch = /name="([^"]+)"/.exec(header);
    const fileMatch = /filename="([^"]*)"/.exec(header);
    if (fileMatch && fileMatch[1] && nameMatch) {
      const ext = path.extname(fileMatch[1]).slice(0, 8);
      const filename = Date.now() + "-" + uid() + ext;
      fs.writeFileSync(path.join(UPLOADS, filename), body);
      file = { field: nameMatch[1], path: "/uploads/" + filename, original: fileMatch[1] };
    } else if (nameMatch) {
      fields[nameMatch[1]] = body.toString("utf8");
    }
    start = next;
  }
  return { fields: fields, file: file };
}

function cookieFlags() {
  const secure = String(process.env.PUBLIC_URL || "").indexOf("https://") === 0;
  return "Path=/; HttpOnly; SameSite=Lax; Max-Age=" + (30 * 86400) + (secure ? "; Secure" : "");
}

function setSession(res, token) {
  res.setHeader("Set-Cookie", "anvil=" + token + "; " + cookieFlags());
}

function clearSession(res) {
  res.setHeader("Set-Cookie", "anvil=; Path=/; HttpOnly; Max-Age=0");
}

function originOf(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:" + (process.env.PORT || 3847);
  return proto + "://" + host;
}

function applyMockup(job) {
  const m = writeMockups(job, UPLOADS, job.file_path);
  job.mockup_path = m.mockup_path;
  job.mockup_svg = m.mockup_svg;
}

function exportJob(job) {
  const dir = path.join(EXPORTS, job.id);
  return writeExports(job, UPLOADS, dir);
}

function download(res, filename, body, type) {
  send(res, 200, body, {
    "Content-Type": type,
    "Content-Disposition": "attachment; filename=\"" + filename + "\"",
  });
}

async function handleApi(req, res, url) {
  const db = load();
  const user = currentUser(req, db);
  const method = req.method;
  const p = url.pathname;

  if (p === "/api/me" && method === "GET") return json(res, 200, { user: publicUser(user) });

  if (p === "/api/signup" && method === "POST") {
    const body = parseJsonBody(await readBody(req));
    if (!body.email || !body.password || !body.name) return json(res, 400, { error: "Name, email, password required" });
    if (String(body.password).length < 6) return json(res, 400, { error: "Password must be 6+ characters" });
    const email = String(body.email).toLowerCase();
    if (db.users.some(function (u) { return u.email === email; })) return json(res, 409, { error: "Email already registered" });
    const now = new Date().toISOString();
    const role = body.role === "client" ? "client" : "shop";
    let shop_id = null;
    if (role === "shop") {
      shop_id = uid();
      db.shops.push({ id: shop_id, name: body.shopName || (body.name + "'s Shop"), logo_path: null, brand_color: "#d4783c", created_at: now });
    }
    const u = {
      id: uid(), email: email, name: body.name, password_hash: hashPass(body.password),
      role: role, shop_id: shop_id, plan: role === "shop" ? "trial" : "client",
      plan_expires: role === "shop" ? new Date(Date.now() + 7 * 864e5).toISOString() : null, created_at: now
    };
    db.users.push(u);
    const token = uid();
    db.sessions.push({ token: token, user_id: u.id, created_at: now });
    save(db);
    setSession(res, token);
    return json(res, 200, { user: publicUser(u) });
  }

  if (p === "/api/login" && method === "POST") {
    const body = parseJsonBody(await readBody(req));
    const u = db.users.find(function (x) { return x.email === String(body.email || "").toLowerCase(); });
    if (!u || !checkPass(body.password || "", u.password_hash)) return json(res, 401, { error: "Invalid email or password" });
    const token = uid();
    db.sessions.push({ token: token, user_id: u.id, created_at: new Date().toISOString() });
    save(db);
    setSession(res, token);
    return json(res, 200, { user: publicUser(u) });
  }

  if (p === "/api/logout" && method === "POST") {
    const token = parseCookies(req).anvil;
    db.sessions = db.sessions.filter(function (s) { return s.token !== token; });
    save(db);
    clearSession(res);
    return json(res, 200, { ok: true });
  }

  if (p === "/api/shop" && method === "GET") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    return json(res, 200, { shop: db.shops.find(function (s) { return s.id === user.shop_id; }) || null });
  }

  if (p === "/api/shop" && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const parsed = parseMultipart(await readBody(req), req.headers["content-type"]);
    const shop = db.shops.find(function (s) { return s.id === user.shop_id; });
    if (parsed.fields.name) shop.name = parsed.fields.name;
    if (parsed.fields.brand_color) shop.brand_color = parsed.fields.brand_color;
    if (parsed.file) shop.logo_path = parsed.file.path;
    save(db);
    return json(res, 200, { shop: shop });
  }

  if (p === "/api/plan" && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const body = parseJsonBody(await readBody(req));
    if (["trial", "shop", "studio"].indexOf(body.plan) === -1) return json(res, 400, { error: "Unknown plan" });
    user.plan = body.plan;
    user.plan_expires = body.plan === "trial" ? new Date(Date.now() + 7 * 864e5).toISOString() : null;
    save(db);
    return json(res, 200, {
      user: publicUser(user),
      billing: process.env.STRIPE_SECRET_KEY ? "stripe" : "placeholder",
      message: process.env.STRIPE_SECRET_KEY ? "Plan recorded." : "Billing connects when keys are set",
    });
  }

  if (p === "/api/billing/checkout" && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const body = parseJsonBody(await readBody(req));
    const plan = body.plan || "shop";
    if (["trial", "shop", "studio"].indexOf(plan) === -1) return json(res, 400, { error: "Unknown plan" });
    user.plan = plan;
    user.plan_expires = plan === "trial" ? new Date(Date.now() + 7 * 864e5).toISOString() : null;
    save(db);
    try {
      const session = await createCheckoutSession(plan, user, originOf(req));
      return json(res, 200, {
        user: publicUser(user),
        checkoutUrl: session.checkoutUrl,
        mode: session.mode,
        message: session.message || "Checkout session created",
      });
    } catch (err) {
      return json(res, 200, {
        user: publicUser(user),
        checkoutUrl: null,
        mode: "placeholder",
        message: "Billing connects when keys are set",
        error: err.message,
      });
    }
  }

  if (p === "/api/clients" && method === "GET") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const clients = db.users.filter(function (u) { return u.shop_id === user.shop_id && u.role === "client"; }).map(function (u) {
      return { id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at };
    });
    return json(res, 200, { clients: clients });
  }

  if (p === "/api/clients" && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const body = parseJsonBody(await readBody(req));
    if (!body.email || !body.name) return json(res, 400, { error: "Name and email required" });
    const email = String(body.email).toLowerCase();
    if (db.users.some(function (u) { return u.email === email; })) return json(res, 409, { error: "Email already registered" });
    const c = {
      id: uid(), email: email, name: body.name, password_hash: hashPass(body.password || "welcome123"),
      role: "client", shop_id: user.shop_id, plan: "client", plan_expires: null, created_at: new Date().toISOString()
    };
    db.users.push(c);
    save(db);
    return json(res, 200, { client: { id: c.id, email: c.email, name: c.name, role: c.role, created_at: c.created_at } });
  }

  if (p === "/api/jobs" && method === "GET") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    const jobs = (user.role === "shop" ? db.jobs.filter(function (j) { return j.shop_id === user.shop_id; }) : db.jobs.filter(function (j) { return j.client_id === user.id; }));
    jobs.sort(function (a, b) { return b.updated_at.localeCompare(a.updated_at); });
    return json(res, 200, { jobs: jobs });
  }

  if (p === "/api/jobs" && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const raw = await readBody(req);
    const parsed = String(req.headers["content-type"] || "").indexOf("multipart") !== -1 ? parseMultipart(raw, req.headers["content-type"]) : { fields: parseJsonBody(raw), file: null };
    const f = parsed.fields;
    const pricing = priceJob({ method: f.method || "dtf", width_in: f.width_in, height_in: f.height_in, qty: f.qty });
    const now = new Date().toISOString();
    const job = {
      id: uid(), shop_id: user.shop_id, client_id: f.client_id || null, title: f.title || "Untitled job",
      method: f.method || "dtf", status: "intake", notes: f.notes || "",
      width_in: Number(f.width_in) || 10, height_in: Number(f.height_in) || 10, qty: Number(f.qty) || 1,
      unit_price: pricing.unit_price, total: pricing.total, file_path: parsed.file ? parsed.file.path : seedDemoArt(),
      proof_token: uid(), created_at: now, updated_at: now
    };
    applyMockup(job);
    db.jobs.push(job);
    db.events.push({ id: uid(), job_id: job.id, message: "Job created from intake", created_at: now });
    save(db);
    return json(res, 200, { job: job });
  }

  const jobGet = p.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobGet && method === "GET") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    const job = db.jobs.find(function (j) { return j.id === jobGet[1]; });
    if (!job) return json(res, 404, { error: "Job not found" });
    if (user.role === "shop" && job.shop_id !== user.shop_id) return json(res, 403, { error: "Forbidden" });
    if (user.role === "client" && job.client_id !== user.id) return json(res, 403, { error: "Forbidden" });
    return json(res, 200, { job: job, events: db.events.filter(function (e) { return e.job_id === job.id; }) });
  }

  const jobPrice = p.match(/^\/api\/jobs\/([^/]+)\/price$/);
  if (jobPrice && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === jobPrice[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    job.method = body.method || job.method;
    job.width_in = Number(body.width_in != null ? body.width_in : job.width_in);
    job.height_in = Number(body.height_in != null ? body.height_in : job.height_in);
    job.qty = Number(body.qty != null ? body.qty : job.qty);
    const pricing = priceJob(job);
    job.unit_price = pricing.unit_price;
    job.total = pricing.total;
    job.updated_at = new Date().toISOString();
    applyMockup(job);
    db.events.push({ id: uid(), job_id: job.id, message: "Pricing updated · $" + job.total.toFixed(2), created_at: job.updated_at });
    save(db);
    return json(res, 200, { job: job });
  }

  const jobStatus = p.match(/^\/api\/jobs\/([^/]+)\/status$/);
  if (jobStatus && method === "POST") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    const job = db.jobs.find(function (j) { return j.id === jobStatus[1]; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    if (user.role === "shop") {
      if (job.shop_id !== user.shop_id) return json(res, 403, { error: "Forbidden" });
    } else if (job.client_id !== user.id || body.status !== "approved") {
      return json(res, 403, { error: "Clients can only approve" });
    }
    job.status = body.status;
    job.updated_at = new Date().toISOString();
    db.events.push({ id: uid(), job_id: job.id, message: "Status → " + job.status, created_at: job.updated_at });
    save(db);
    return json(res, 200, { job: job });
  }

  const proof = p.match(/^\/api\/proof\/([^/]+)$/);
  if (proof && method === "GET") {
    const job = db.jobs.find(function (j) { return j.proof_token === proof[1]; });
    if (!job) return json(res, 404, { error: "Proof not found" });
    const shop = db.shops.find(function (s) { return s.id === job.shop_id; });
    if (!job.mockup_path) {
      applyMockup(job);
      save(db);
    }
    return json(res, 200, { job: job, shop: { name: shop.name, logo_path: shop.logo_path, brand_color: shop.brand_color } });
  }

  const proofOk = p.match(/^\/api\/proof\/([^/]+)\/approve$/);
  if (proofOk && method === "POST") {
    const job = db.jobs.find(function (j) { return j.proof_token === proofOk[1]; });
    if (!job) return json(res, 404, { error: "Proof not found" });
    job.status = "approved";
    job.updated_at = new Date().toISOString();
    db.events.push({ id: uid(), job_id: job.id, message: "Client approved proof via link", created_at: job.updated_at });
    save(db);
    return json(res, 200, { ok: true });
  }

  const expFile = p.match(/^\/api\/export\/([^/]+)\/([^/]+)$/);
  if (expFile && method === "GET") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === expFile[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const { contents, packet } = exportJob(job);
    const name = expFile[2];
    const short = job.id.slice(0, 8);
    if (name === "packet.json") return download(res, "decoclub-" + short + "-packet.json", JSON.stringify(packet, null, 2), "application/json");
    if (contents[name]) {
      const ext = path.extname(name);
      return download(res, "decoclub-" + short + "-" + name, contents[name], MIME[ext] || "application/octet-stream");
    }
    return json(res, 404, { error: "Unknown export" });
  }

  const exp = p.match(/^\/api\/export\/([^/]+)$/);
  if (exp && method === "GET") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === exp[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const { packet } = exportJob(job);
    res.setHeader("Content-Disposition", "attachment; filename=\"decoclub-" + job.id.slice(0, 8) + "-packet.json\"");
    return json(res, 200, packet);
  }

  return json(res, 404, { error: "Not found" });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  if (rel.indexOf("/uploads/") === 0) {
    const file = path.join(UPLOADS, path.basename(rel));
    if (!fs.existsSync(file)) return send(res, 404, "Not found");
    const ext = path.extname(file).toLowerCase();
    return send(res, 200, fs.readFileSync(file), { "Content-Type": MIME[ext] || "application/octet-stream" });
  }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file.indexOf(PUBLIC) !== 0) return send(res, 403, "Forbidden");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "Not found");
  const ext = path.extname(file).toLowerCase();
  send(res, 200, fs.readFileSync(file), { "Content-Type": MIME[ext] || "application/octet-stream" });
}

const server = http.createServer(async function (req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.indexOf("/api/") === 0) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    json(res, 500, { error: err.message || "Server error" });
  }
});

ensureDemoJob(load());

const PORT = process.env.PORT || 3847;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, function () {
  console.log("DecoClub Pro running at http://" + HOST + ":" + PORT);
});
