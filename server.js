const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { priceJob, priceQuote } = require("./lib/price");
const { writeExports, intakePosterSvg } = require("./lib/exports");
const { writeMockups, BLANKS } = require("./lib/mockup");
const { generateBadgePng } = require("./lib/demoart");
const { processArtwork } = require("./lib/artops");
const {
  loadEnvFile, createCheckoutSession, billingConfigured,
  verifyStripeSignature, applyStripeEvent,
} = require("./lib/stripe");

const ROOT = __dirname;
loadEnvFile(ROOT);
const COOKIE = "decoclub";
const PUBLIC = path.join(ROOT, "public");
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const UPLOADS = path.join(DATA, "uploads");
const EXPORTS = path.join(DATA, "exports");
const DB_PATH = path.join(DATA, "store.json");
const IS_PROD = process.env.NODE_ENV === "production";
const STATUSES = ["new","art_in","mockup","priced","proof_sent","approved","in_production","done"];
const METHODS = ["dtf","uvdtf","uv","vinyl","laser","sticker","hat","apparel","patch","embroidery","sublimation","rhinestone","sign"];

function allowDemo() {
  if (IS_PROD) return false;
  if (process.env.ALLOW_DEMO === "0") return false;
  return true;
}

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(EXPORTS, { recursive: true });

function uid() { return crypto.randomBytes(16).toString("hex"); }
function proofToken() { return crypto.randomBytes(32).toString("hex"); }
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 32).toString("hex");
}
function checkPass(pw, stored) {
  const parts = String(stored).split(":");
  const next = crypto.scryptSync(pw, parts[0], 32).toString("hex");
  try { return crypto.timingSafeEqual(Buffer.from(parts[1], "hex"), Buffer.from(next, "hex")); }
  catch (e) { return false; }
}
function emptyStore() { return { shops: [], users: [], sessions: [], jobs: [], events: [] }; }
function seedDemoArt() {
  const pth = path.join(UPLOADS, "demo-badge.png");
  if (!fs.existsSync(pth)) fs.writeFileSync(pth, generateBadgePng());
  return "/uploads/demo-badge.png";
}
function save(db) {
  const tmp = DB_PATH + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}
function load() {
  if (!fs.existsSync(DB_PATH)) {
    const db = emptyStore();
    if (allowDemo()) seedDemoUsers(db);
    save(db);
    return db;
  }
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  (db.jobs || []).forEach(normalizeJob);
  return db;
}
function mapLegacyStatus(s) {
  return ({ intake: "new", proof: "proof_sent", production: "in_production" })[s] || s;
}
function normalizeJob(job) {
  job.status = mapLegacyStatus(job.status || "new");
  if (!job.proof_token || String(job.proof_token).length < 32) job.proof_token = proofToken();
  if (!Array.isArray(job.line_items)) job.line_items = [];
  if (!Array.isArray(job.comments)) job.comments = [];
  if (job.margin_pct == null) job.margin_pct = 0;
  if (!job.blank) job.blank = null;
  if (!job.placement) job.placement = "center";
}
function seedDemoUsers(db) {
  const now = new Date().toISOString();
  const shopId = uid();
  db.shops.push({ id: shopId, name: "Hearth & Horn Co.", logo_path: null, brand_color: "#c9b896", created_at: now, margin_pct: 20 });
  db.users.push({ id: uid(), email: "owner@anvil.local", name: "Shop Owner", password_hash: hashPass("anvil123"), role: "shop", shop_id: shopId, plan: "studio", plan_expires: null, created_at: now });
  db.users.push({ id: uid(), email: "client@anvil.local", name: "Jordan Client", password_hash: hashPass("anvil123"), role: "client", shop_id: shopId, plan: "client", plan_expires: null, created_at: now });
}
function ensureDemoJob(db) {
  if (!allowDemo()) return;
  const art = seedDemoArt();
  const shop = db.shops[0];
  const client = db.users.find((u) => u.email === "client@anvil.local");
  if (!db.jobs.length && shop) {
    const now = new Date().toISOString();
    const job = {
      id: uid(), shop_id: shop.id, client_id: client ? client.id : null,
      title: "Forge mark tees", method: "apparel", status: "proof_sent",
      notes: "Chest print, black heather.", art_notes: "One-color badge, knock white if needed.",
      width_in: 10, height_in: 10, qty: 24, due_at: now.slice(0, 10),
      file_path: art, proof_token: proofToken(), blank: "tee", garment_color: "#2c3138",
      placement: "chest", margin_pct: 20, line_items: [], comments: [], created_at: now, updated_at: now,
    };
    applyQuote(job);
    applyMockup(job);
    db.jobs.push(job);
    db.events.push({ id: uid(), job_id: job.id, message: "Job created · proof mockup ready", created_at: now });
    save(db);
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".json": "application/json", ".plt": "application/vnd.hp-hpgl", ".txt": "text/plain; charset=utf-8" };
function send(res, code, body, headers) {
  headers = headers || {};
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  res.writeHead(code, Object.assign({ "Content-Length": payload.length }, headers));
  res.end(payload);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" }); }
function clientError(err) { return IS_PROD ? "Server error" : (err && err.message) || "Server error"; }
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(function (p) {
    const i = p.indexOf("=");
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function currentUser(req, db) {
  const token = parseCookies(req)[COOKIE];
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
function parseJsonBody(buf) { if (!buf.length) return {}; return JSON.parse(buf.toString("utf8")); }
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) return { fields: {}, file: null };
  const boundary = Buffer.from("--" + (m[1] || m[2]));
  const fields = {}; let file = null;
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
    } else if (nameMatch) fields[nameMatch[1]] = body.toString("utf8");
    start = next;
  }
  return { fields: fields, file: file };
}
function isHttpsReq(req) {
  if (String(process.env.PUBLIC_URL || "").indexOf("https://") === 0) return true;
  return String((req && req.headers && req.headers["x-forwarded-proto"]) || "").split(",")[0].trim() === "https";
}
function cookieFlags(req) {
  return "Path=/; HttpOnly; SameSite=Lax; Max-Age=" + (30 * 86400) + (isHttpsReq(req) ? "; Secure" : "");
}
function setSession(res, token, req) { res.setHeader("Set-Cookie", COOKIE + "=" + token + "; " + cookieFlags(req)); }
function clearSession(res, req) { res.setHeader("Set-Cookie", COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (isHttpsReq(req) ? "; Secure" : "")); }
function originOf(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:" + (process.env.PORT || 3847);
  return proto + "://" + String(host).split(",")[0].trim();
}
function applyQuote(job) {
  const q = priceQuote(job);
  job.line_items = q.line_items;
  job.subtotal = q.subtotal;
  job.margin_pct = q.margin_pct;
  job.margin_amount = q.margin_amount;
  job.unit_price = q.unit_price;
  job.total = q.total;
  return q;
}
function applyMockup(job) {
  const m = writeMockups(job, UPLOADS, job.file_path);
  job.mockup_path = m.mockup_path;
  job.mockup_svg = m.mockup_svg;
}
function presentJob(job, req) {
  const copy = Object.assign({}, job);
  copy.proof_url = originOf(req) + "/proof.html?t=" + job.proof_token;
  copy.intake_url = originOf(req) + "/intake.html?t=" + job.proof_token;
  return copy;
}
function event(db, job, message) {
  const now = new Date().toISOString();
  db.events.push({ id: uid(), job_id: job.id, message: message, created_at: now });
  job.updated_at = now;
}
function canSeeJob(user, job) {
  if (!user || !job) return false;
  if (user.role === "shop") return job.shop_id === user.shop_id;
  return job.client_id === user.id;
}
function download(res, filename, body, type) {
  send(res, 200, body, { "Content-Type": type, "Content-Disposition": 'attachment; filename="' + filename + '"' });
}


async function handleApi(req, res, url) {
  const db = load();
  const user = currentUser(req, db);
  const method = req.method;
  const pth = url.pathname;

  if (pth === "/api/config" && method === "GET") {
    return json(res, 200, { demo: allowDemo(), billing: billingConfigured(), name: "DecoClub Pro", statuses: STATUSES, methods: METHODS, blanks: BLANKS, seed: allowDemo() ? { owner: "owner@anvil.local", client: "client@anvil.local", password: "anvil123" } : null });
  }
  if (pth === "/api/quote" && (method === "POST" || method === "GET")) {
    const body = method === "GET" ? { method: url.searchParams.get("method"), width_in: url.searchParams.get("width_in"), height_in: url.searchParams.get("height_in"), qty: url.searchParams.get("qty"), margin_pct: url.searchParams.get("margin_pct") } : parseJsonBody(await readBody(req));
    return json(res, 200, { quote: priceQuote(body) });
  }
  if (pth === "/api/me" && method === "GET") return json(res, 200, { user: publicUser(user) });

  if (pth === "/api/signup" && method === "POST") {
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
      db.shops.push({ id: shop_id, name: body.shopName || (body.name + "'s Shop"), logo_path: null, brand_color: "#c9b896", margin_pct: 20, created_at: now });
    }
    const u = { id: uid(), email: email, name: body.name, password_hash: hashPass(body.password), role: role, shop_id: shop_id, plan: role === "shop" ? "trial" : "client", plan_expires: role === "shop" ? new Date(Date.now() + 7 * 864e5).toISOString() : null, created_at: now };
    db.users.push(u);
    const token = uid();
    db.sessions.push({ token: token, user_id: u.id, created_at: now });
    save(db); setSession(res, token, req);
    return json(res, 200, { user: publicUser(u) });
  }
  if (pth === "/api/login" && method === "POST") {
    const body = parseJsonBody(await readBody(req));
    const u = db.users.find(function (x) { return x.email === String(body.email || "").toLowerCase(); });
    if (!u || !checkPass(body.password || "", u.password_hash)) return json(res, 401, { error: "Invalid email or password" });
    const token = uid();
    db.sessions.push({ token: token, user_id: u.id, created_at: new Date().toISOString() });
    save(db); setSession(res, token, req);
    return json(res, 200, { user: publicUser(u) });
  }
  if (pth === "/api/logout" && method === "POST") {
    const token = parseCookies(req)[COOKIE];
    db.sessions = db.sessions.filter(function (s) { return s.token !== token; });
    save(db); clearSession(res, req);
    return json(res, 200, { ok: true });
  }
  if (pth === "/api/shop" && method === "GET") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    return json(res, 200, { shop: db.shops.find(function (s) { return s.id === user.shop_id; }) || null, billing: billingConfigured() });
  }
  if (pth === "/api/shop" && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const parsed = String(req.headers["content-type"] || "").indexOf("multipart") !== -1 ? parseMultipart(await readBody(req), req.headers["content-type"]) : { fields: parseJsonBody(await readBody(req)), file: null };
    const shop = db.shops.find(function (s) { return s.id === user.shop_id; });
    if (parsed.fields.name) shop.name = parsed.fields.name;
    if (parsed.fields.brand_color) shop.brand_color = parsed.fields.brand_color;
    if (parsed.fields.margin_pct != null) shop.margin_pct = Number(parsed.fields.margin_pct) || 0;
    if (parsed.file) shop.logo_path = parsed.file.path;
    save(db);
    return json(res, 200, { shop: shop });
  }
  if ((pth === "/api/plan" || pth === "/api/billing/checkout") && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    if (!billingConfigured()) return json(res, 501, { error: "Billing not configured" });
    if (pth === "/api/plan") return json(res, 400, { error: "Use checkout. Plan updates after Stripe webhook." });
    const body = parseJsonBody(await readBody(req));
    const plan = body.plan || "shop";
    if (["trial", "shop", "studio"].indexOf(plan) === -1) return json(res, 400, { error: "Unknown plan" });
    try {
      const session = await createCheckoutSession(plan, user, originOf(req));
      return json(res, 200, { user: publicUser(user), checkoutUrl: session.checkoutUrl, mode: session.mode, message: "Redirecting to Stripe Checkout" });
    } catch (err) {
      const code = err.status || 502;
      return json(res, code, { error: code === 501 ? "Billing not configured" : (IS_PROD ? "Billing error" : err.message) });
    }
  }
  if (pth === "/api/billing/webhook" && method === "POST") {
    const raw = await readBody(req);
    if (!billingConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) return json(res, 501, { error: "Billing not configured" });
    if (!verifyStripeSignature(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)) return json(res, 400, { error: "Invalid signature" });
    try { applyStripeEvent(db, JSON.parse(raw.toString("utf8"))); save(db); }
    catch (e) { return json(res, 400, { error: "Invalid payload" }); }
    return json(res, 200, { received: true });
  }
  if (pth === "/api/clients" && method === "GET") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const clients = db.users.filter(function (u) { return u.shop_id === user.shop_id && u.role === "client"; }).map(function (u) {
      return { id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at, jobs: db.jobs.filter(function (j) { return j.client_id === u.id; }).length };
    });
    return json(res, 200, { clients: clients });
  }
  if (pth === "/api/clients" && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const body = parseJsonBody(await readBody(req));
    if (!body.email || !body.name) return json(res, 400, { error: "Name and email required" });
    const email = String(body.email).toLowerCase();
    if (db.users.some(function (u) { return u.email === email; })) return json(res, 409, { error: "Email already registered" });
    const c = { id: uid(), email: email, name: body.name, password_hash: hashPass(body.password || "welcome123"), role: "client", shop_id: user.shop_id, plan: "client", plan_expires: null, created_at: new Date().toISOString() };
    db.users.push(c); save(db);
    return json(res, 200, { client: { id: c.id, email: c.email, name: c.name, role: c.role, created_at: c.created_at } });
  }
  if (pth === "/api/jobs" && method === "GET") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    let jobs = user.role === "shop" ? db.jobs.filter(function (j) { return j.shop_id === user.shop_id; }) : db.jobs.filter(function (j) { return j.client_id === user.id; });
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const st = url.searchParams.get("status");
    const cid = url.searchParams.get("client_id");
    if (q) jobs = jobs.filter(function (j) { return (j.title + " " + j.method + " " + (j.notes || "")).toLowerCase().indexOf(q) !== -1; });
    if (st) jobs = jobs.filter(function (j) { return mapLegacyStatus(j.status) === st; });
    if (cid) jobs = jobs.filter(function (j) { return j.client_id === cid; });
    jobs.sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
    return json(res, 200, { jobs: jobs.map(function (j) { return presentJob(j, req); }) });
  }
  if (pth === "/api/jobs" && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const raw = await readBody(req);
    const parsed = String(req.headers["content-type"] || "").indexOf("multipart") !== -1 ? parseMultipart(raw, req.headers["content-type"]) : { fields: parseJsonBody(raw), file: null };
    const f = parsed.fields;
    const shop = db.shops.find(function (s) { return s.id === user.shop_id; });
    const now = new Date().toISOString();
    const job = {
      id: uid(), shop_id: user.shop_id, client_id: f.client_id || null, title: f.title || "Untitled job",
      method: METHODS.indexOf(f.method) !== -1 ? f.method : "dtf", status: "new",
      notes: f.notes || "", art_notes: f.art_notes || "",
      width_in: Number(f.width_in) || 10, height_in: Number(f.height_in) || 10, qty: Number(f.qty) || 1,
      due_at: f.due_at || null, file_path: parsed.file ? parsed.file.path : (allowDemo() ? seedDemoArt() : null),
      proof_token: proofToken(), blank: f.blank || null, garment_color: f.garment_color || "#2c3138",
      placement: f.placement || "chest", margin_pct: f.margin_pct != null ? Number(f.margin_pct) : (shop && shop.margin_pct) || 0,
      line_items: [], comments: [], created_at: now, updated_at: now,
    };
    if (job.file_path) job.status = "art_in";
    applyQuote(job); applyMockup(job);
    if (job.file_path) job.status = "mockup";
    db.jobs.push(job); event(db, job, "Intake created"); save(db);
    return json(res, 200, { job: presentJob(job, req) });
  }

  const jobGet = pth.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobGet && method === "GET") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    const job = db.jobs.find(function (j) { return j.id === jobGet[1]; });
    if (!job || !canSeeJob(user, job)) return json(res, 404, { error: "Job not found" });
    return json(res, 200, { job: presentJob(job, req), events: db.events.filter(function (e) { return e.job_id === job.id; }) });
  }
  if (jobGet && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === jobGet[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    ["title","notes","art_notes","method","due_at","client_id","blank","garment_color","placement"].forEach(function (k) {
      if (body[k] != null) job[k] = body[k];
    });
    if (body.width_in != null) job.width_in = Number(body.width_in);
    if (body.height_in != null) job.height_in = Number(body.height_in);
    if (body.qty != null) job.qty = Number(body.qty);
    if (body.margin_pct != null) job.margin_pct = Number(body.margin_pct);
    if (body.line_items) job.line_items = body.line_items;
    applyQuote(job);
    event(db, job, "Job details saved"); save(db);
    return json(res, 200, { job: presentJob(job, req) });
  }

  const art = pth.match(/^\/api\/jobs\/([^/]+)\/artwork$/);
  if (art && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === art[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const parsed = parseMultipart(await readBody(req), req.headers["content-type"]);
    if (!parsed.file) return json(res, 400, { error: "Artwork file required" });
    job.file_path = parsed.file.path;
    if (STATUSES.indexOf(job.status) < STATUSES.indexOf("art_in")) job.status = "art_in";
    applyMockup(job); event(db, job, "Artwork replaced"); save(db);
    return json(res, 200, { job: presentJob(job, req) });
  }
  const ops = pth.match(/^\/api\/jobs\/([^/]+)\/artops$/);
  if (ops && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === ops[1] && j.shop_id === user.shop_id; });
    if (!job || !job.file_path) return json(res, 400, { error: "PNG artwork required for knockout / color swap" });
    const abs = path.join(UPLOADS, path.basename(job.file_path));
    if (!fs.existsSync(abs)) return json(res, 404, { error: "Artwork missing" });
    const body = parseJsonBody(await readBody(req));
    try {
      const out = processArtwork(fs.readFileSync(abs), body);
      const name = Date.now() + "-" + uid() + ".png";
      fs.writeFileSync(path.join(UPLOADS, name), out);
      job.file_path = "/uploads/" + name;
      applyMockup(job); event(db, job, "Artwork processed"); save(db);
      return json(res, 200, { job: presentJob(job, req) });
    } catch (err) { return json(res, 400, { error: IS_PROD ? "Could not process artwork" : err.message }); }
  }
  const mk = pth.match(/^\/api\/jobs\/([^/]+)\/mockup$/);
  if (mk && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === mk[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    if (body.blank) job.blank = body.blank;
    if (body.garment_color) job.garment_color = body.garment_color;
    if (body.placement) job.placement = body.placement;
    applyMockup(job);
    if (STATUSES.indexOf(job.status) < STATUSES.indexOf("mockup")) job.status = "mockup";
    event(db, job, "Mockup regenerated"); save(db);
    return json(res, 200, { job: presentJob(job, req) });
  }
  const pr = pth.match(/^\/api\/jobs\/([^/]+)\/price$/);
  if (pr && method === "POST") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === pr[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    if (body.method) job.method = body.method;
    if (body.width_in != null) job.width_in = Number(body.width_in);
    if (body.height_in != null) job.height_in = Number(body.height_in);
    if (body.qty != null) job.qty = Number(body.qty);
    if (body.margin_pct != null) job.margin_pct = Number(body.margin_pct);
    if (body.line_items) job.line_items = body.line_items;
    const q = applyQuote(job);
    if (STATUSES.indexOf(job.status) < STATUSES.indexOf("priced")) job.status = "priced";
    event(db, job, "Priced · $" + job.total.toFixed(2)); save(db);
    return json(res, 200, { job: presentJob(job, req), quote: q });
  }
  const stt = pth.match(/^\/api\/jobs\/([^/]+)\/status$/);
  if (stt && method === "POST") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    const job = db.jobs.find(function (j) { return j.id === stt[1]; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    const next = mapLegacyStatus(body.status);
    if (user.role === "shop") {
      if (job.shop_id !== user.shop_id) return json(res, 403, { error: "Forbidden" });
    } else if (job.client_id !== user.id || next !== "approved") {
      return json(res, 403, { error: "Clients can only approve" });
    }
    job.status = next;
    event(db, job, "Status → " + job.status); save(db);
    return json(res, 200, { job: presentJob(job, req) });
  }
  const cm = pth.match(/^\/api\/jobs\/([^/]+)\/comments$/);
  if (cm && method === "POST") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    const job = db.jobs.find(function (j) { return j.id === cm[1]; });
    if (!job || !canSeeJob(user, job)) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    if (!body.body) return json(res, 400, { error: "Comment required" });
    job.comments = job.comments || [];
    job.comments.push({ id: uid(), author: user.name, role: user.role, body: String(body.body), created_at: new Date().toISOString() });
    event(db, job, "Comment from " + user.name); save(db);
    return json(res, 200, { job: presentJob(job, req) });
  }

  const proof = pth.match(/^\/api\/proof\/([^/]+)$/);
  if (proof && method === "GET") {
    if (!proof[1] || proof[1].length < 32) return json(res, 404, { error: "Proof not found" });
    const job = db.jobs.find(function (j) { return j.proof_token === proof[1]; });
    if (!job) return json(res, 404, { error: "Proof not found" });
    const shop = db.shops.find(function (s) { return s.id === job.shop_id; });
    if (!job.mockup_path) { applyMockup(job); save(db); }
    return json(res, 200, { job: presentJob(job, req), shop: { name: shop.name, logo_path: shop.logo_path, brand_color: shop.brand_color } });
  }
  const proofOk = pth.match(/^\/api\/proof\/([^/]+)\/approve$/);
  if (proofOk && method === "POST") {
    if (!proofOk[1] || proofOk[1].length < 32) return json(res, 404, { error: "Proof not found" });
    const job = db.jobs.find(function (j) { return j.proof_token === proofOk[1]; });
    if (!job) return json(res, 404, { error: "Proof not found" });
    job.status = "approved"; event(db, job, "Client approved proof via link"); save(db);
    return json(res, 200, { ok: true });
  }
  const proofC = pth.match(/^\/api\/proof\/([^/]+)\/comments$/);
  if (proofC && method === "POST") {
    if (!proofC[1] || proofC[1].length < 32) return json(res, 404, { error: "Proof not found" });
    const job = db.jobs.find(function (j) { return j.proof_token === proofC[1]; });
    if (!job) return json(res, 404, { error: "Proof not found" });
    const body = parseJsonBody(await readBody(req));
    if (!body.body) return json(res, 400, { error: "Comment required" });
    job.comments = job.comments || [];
    job.comments.push({ id: uid(), author: body.name || "Client", role: "client", body: String(body.body), created_at: new Date().toISOString() });
    event(db, job, "Proof comment"); save(db);
    return json(res, 200, { job: presentJob(job, req) });
  }

  const poster = pth.match(/^\/api\/export\/([^/]+)\/intake-poster.svg$/);
  if (poster && method === "GET") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === poster[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const shop = db.shops.find(function (s) { return s.id === user.shop_id; });
    return download(res, "decoclub-intake-" + job.id.slice(0, 8) + ".svg", intakePosterSvg(job, originOf(req), shop), "image/svg+xml");
  }
  const expFile = pth.match(/^\/api\/export\/([^/]+)\/([^/]+)$/);
  if (expFile && method === "GET") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === expFile[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    job._shop = db.shops.find(function (s) { return s.id === user.shop_id; });
    const pack = writeExports(job, UPLOADS, path.join(EXPORTS, job.id));
    const name = expFile[2];
    const short = job.id.slice(0, 8);
    if (name === "packet.json") return download(res, "decoclub-" + short + "-packet.json", JSON.stringify(pack.packet, null, 2), "application/json");
    if (pack.contents[name]) return download(res, "decoclub-" + short + "-" + name, pack.contents[name], MIME[path.extname(name)] || "application/octet-stream");
    return json(res, 404, { error: "Unknown export" });
  }
  const exp = pth.match(/^\/api\/export\/([^/]+)$/);
  if (exp && method === "GET") {
    if (!user || user.role !== "shop") return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === exp[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    job._shop = db.shops.find(function (s) { return s.id === user.shop_id; });
    const pack = writeExports(job, UPLOADS, path.join(EXPORTS, job.id));
    res.setHeader("Content-Disposition", 'attachment; filename="decoclub-' + job.id.slice(0, 8) + '-packet.json"');
    return json(res, 200, pack.packet);
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
  send(res, 200, fs.readFileSync(file), { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
}

const server = http.createServer(async function (req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") return json(res, 200, { ok: true, name: "DecoClub Pro" });
    if (url.pathname.indexOf("/api/") === 0) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: clientError(err) });
  }
});

if (allowDemo()) ensureDemoJob(load());
else if (!fs.existsSync(DB_PATH)) save(emptyStore());

const PORT = process.env.PORT || 3847;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, function () {
  console.log("DecoClub Pro running at http://" + HOST + ":" + PORT);
});
