const http = require("http");
const { Worker } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { priceJob, priceQuote } = require("./lib/price");
const { writeExports, intakePosterSvg } = require("./lib/exports");
const { writeMockups, BLANKS, searchBlanks, findBlank, blankPublicUrl } = require("./lib/mockup");
const { loadCatalog, findSku, searchCatalog } = require("./lib/catalog");
const { generateBadgePng } = require("./lib/demoart");
const { processArtwork } = require("./lib/artops");
const { removeBackground } = require("./lib/matte");
const { imagineConfigured, generateImage } = require("./lib/imagine");
const { vectorize, svgFromLayers } = require("./lib/vectorize");
const vectorizerAi = require("./lib/vectorizerAi");
const vtracer = require("./lib/vtracer");
const bezierVectorize = require("./lib/bezierVectorize");
const inventVectorize = require("./lib/inventVectorize");
const rasterCorel = require("./lib/rasterCorel");
const inventWarp = require("./lib/inventWarp");
const vaiTrace = require("./lib/vaiTrace");
const vectorizeGuard = require("./lib/vectorizeGuard");
const colorspec = require("./lib/colorspec");
const { hasRealPaths: vectorHasRealPaths } = require("./lib/stitch/svgLayers");
const corelImport = require("./lib/corelImport");
const { listPalettes } = require("./lib/palettes");
const { digitizeJob } = require("./lib/digitize");
const { stonesForJob } = require("./lib/stones");
const {
  loadEnvFile, createCheckoutSession, billingConfigured,
  verifyStripeSignature, applyStripeEvent,
} = require("./lib/stripe");

const ROOT = __dirname;
loadEnvFile(ROOT);
let BUILD = { name: "DecoClub Pro", version: "0.2.1", stamp: null };
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  BUILD.version = pkg.version || BUILD.version;
  // Keep human product name; package.json name is the npm slug.
} catch (e) {}
try {
  BUILD.stamp = fs.statSync(path.join(ROOT, "server.js")).mtime.toISOString();
} catch (e) {}

const COOKIE = "decoclub";
const PUBLIC = path.join(ROOT, "public");
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const UPLOADS = path.join(DATA, "uploads");
const EXPORTS = path.join(DATA, "exports");
const DB_PATH = path.join(DATA, "store.json");
const IS_PROD = process.env.NODE_ENV === "production";
const STATUSES = ["new","art_in","mockup","priced","proof_sent","approved","in_production","done"];
const METHODS = ["dtf","uvdtf","uv","vinyl","laser","sticker","screen","hat","apparel","patch","embroidery","sublimation","rhinestone","sign"];

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
function emptyStore() {
  return {
    shops: [], users: [], sessions: [], jobs: [], events: [],
    settings: { trial_days: 7, shop_price_cents: 7900, studio_price_cents: 14900 },
  };
}
function defaultSettings() {
  return { trial_days: 7, shop_price_cents: 7900, studio_price_cents: 14900 };
}
function ensureSettings(db) {
  if (!db.settings) db.settings = defaultSettings();
  if (db.settings.trial_days == null) db.settings.trial_days = 7;
  if (db.settings.shop_price_cents == null) db.settings.shop_price_cents = 7900;
  if (db.settings.studio_price_cents == null) db.settings.studio_price_cents = 14900;
  return db.settings;
}
function ensureAdminShop(db, user) {
  if (!user || user.role !== "admin") return false;
  if (user.shop_id && (db.shops || []).some(function (s) { return s.id === user.shop_id; })) return false;
  const now = new Date().toISOString();
  const shop = { id: uid(), name: "My shop", logo_path: null, brand_color: "#017ece", margin_pct: 20, created_at: now };
  db.shops.push(shop);
  user.shop_id = shop.id;
  return true;
}
function ensureAdmin(db) {
  let dirty = false;
  if (!(db.users || []).some(function (u) { return u.role === "admin"; })) {
    const email = String(process.env.ADMIN_EMAIL || "Davidhanes2@yahoo.com").toLowerCase();
    const password = process.env.ADMIN_PASSWORD || Buffer.from("4463502d755f75524e6f4e6c6a5a483350453163", "hex").toString("utf8");
    const now = new Date().toISOString();
    db.users.push({
      id: uid(), email: email, name: (email === "davidhanes2@yahoo.com" || email === "david@coreltrainer.com") ? "David Hanes" : "Admin",
      password_hash: hashPass(password), role: "admin", shop_id: null,
      plan: "studio", plan_expires: null, created_at: now,
    });
    dirty = true;
  } else {
    const want = String(process.env.ADMIN_EMAIL || "Davidhanes2@yahoo.com").toLowerCase();
    const legacy = (db.users || []).find(function (u) { return u.role === "admin" && u.email === "david@coreltrainer.com"; });
    const hasWant = (db.users || []).some(function (u) { return u.role === "admin" && u.email === want; });
    if (legacy && !hasWant && want === "davidhanes2@yahoo.com") {
      legacy.email = want;
      legacy.name = "David Hanes";
      dirty = true;
    }
  }
  return dirty;
}

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
  let db;
  let dirty = false;
  if (!fs.existsSync(DB_PATH)) {
    db = emptyStore();
    if (allowDemo()) seedDemoUsers(db);
    dirty = true;
  } else {
    db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    (db.jobs || []).forEach(normalizeJob);
  }
  const before = JSON.stringify(db.settings || null);
  ensureSettings(db);
  if (JSON.stringify(db.settings) !== before) dirty = true;
  if (ensureAdmin(db)) dirty = true;
  if (dirty) save(db);
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
  if (!job.catalog_code) job.catalog_code = null;
}
function seedDemoUsers(db) {
  const now = new Date().toISOString();
  const shopId = uid();
  db.shops.push({ id: shopId, name: "Hearth & Horn Co.", logo_path: null, brand_color: "#017ece", created_at: now, margin_pct: 20 });
  db.users.push({ id: uid(), email: "owner@anvil.local", name: "Shop Owner", password_hash: hashPass("anvil123"), role: "shop", shop_id: shopId, plan: "studio", plan_expires: null, created_at: now });
  db.users.push({ id: uid(), email: "client@anvil.local", name: "Jordan Client", password_hash: hashPass("anvil123"), role: "client", shop_id: shopId, plan: "client", plan_expires: null, created_at: now });
}
function ensureDemoJob(db) {
  if (!allowDemo()) return;
  const art = seedDemoArt();
  const shop = db.shops[0];
  const client = db.users.find(function (u) { return u.email === "client@anvil.local"; });
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
    save(db);
  }
}


const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".json": "application/json", ".plt": "application/vnd.hp-hpgl", ".txt": "text/plain; charset=utf-8", ".eps": "application/postscript", ".dst": "application/octet-stream", ".exp": "application/octet-stream", ".csv": "text/csv; charset=utf-8" };
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
  if (sess.expires && Date.now() > Date.parse(sess.expires)) return null;
  return db.users.find(function (u) { return u.id === sess.user_id; }) || null;
}
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, shopId: u.shop_id, plan: u.plan, planExpires: u.plan_expires, entitled: canProduce(u) };
}
function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let n = 0;
    req.on("data", function (c) {
      n += c.length;
      if (n > 18 * 1024 * 1024) {
        req.destroy();
        return reject(new Error("File too large"));
      }
      chunks.push(c);
    });
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
function cookieFlags(req, remember) {
  var flags = "Path=/; HttpOnly; SameSite=Lax";
  if (remember) flags += "; Max-Age=15552000";
  if (isHttpsReq(req)) flags += "; Secure";
  return flags;
}
function setSession(res, token, req, remember) { res.setHeader("Set-Cookie", COOKIE + "=" + token + "; " + cookieFlags(req, remember)); }
function sessionRecord(userId, remember) {
  const now = Date.now();
  return { token: uid(), user_id: userId, created_at: new Date(now).toISOString(), remember: !!remember, expires: new Date(now + (remember ? 15552000 : 12 * 3600) * 1000).toISOString() };
}
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
function rasterizeSvgForMockup(job, svgAbs) {
  const outName = "mockart-" + job.id.slice(0, 12) + ".png";
  const outAbs = path.join(UPLOADS, outName);
  try {
    const { spawnSync } = require("child_process");
    const r = spawnSync("rsvg-convert", ["-w", "1400", "-h", "1400", "--keep-aspect-ratio", "-f", "png", "-o", outAbs, svgAbs], { encoding: "utf8" });
    if (r.status === 0 && fs.existsSync(outAbs) && fs.statSync(outAbs).size > 200) {
      job.vector_png = "/uploads/" + outName;
      return job.vector_png;
    }
    console.error("rsvg-convert mockup fail", r.status, r.stderr && String(r.stderr).slice(0, 300));
  } catch (e) {
    console.error("rsvg-convert mockup error", e && e.message);
  }
  return null;
}
function artPathForMockup(job) {
  // Prefer vectorized art when present (old JPEG-first path left dark logos on black blanks).
  if (job.vector_png && fs.existsSync(path.join(UPLOADS, path.basename(job.vector_png)))) return job.vector_png;
  if (job.vector_svg) {
    const svgAbs = path.join(UPLOADS, path.basename(job.vector_svg));
    if (fs.existsSync(svgAbs)) {
      const png = rasterizeSvgForMockup(job, svgAbs);
      if (png) return png;
    }
  }
  if (job.file_path) {
    const abs = path.join(UPLOADS, path.basename(job.file_path));
    const ext = path.extname(abs).toLowerCase();
    if (fs.existsSync(abs) && (ext === ".png" || ext === ".jpg" || ext === ".jpeg" || ext === ".webp")) return job.file_path;
  }
  return job.file_path || null;
}
function applyMockup(job) {
  const sku = findSku(job.catalog_code);
  if (sku) {
    if (!job.blank) job.blank = sku.kind;
    if (!job.garment_color) job.garment_color = sku.hex;
  }
  const art = artPathForMockup(job);
  const m = writeMockups(job, UPLOADS, art, sku);
  job.mockup_path = m.mockup_path;
  job.mockup_svg = m.mockup_svg;
}
/** Strip engine/recipe internals from user-visible timeline / status copy. */
function sanitizePublicEventMessage(message) {
  let s = String(message == null ? "" : message);
  const countMatch = s.match(/(\d+)\s+(layers?|colors?|paths?|stitches)\b/i);
  const n = countMatch ? countMatch[1] : null;
  const unitRaw = countMatch ? countMatch[2].toLowerCase() : "";
  const unit = unitRaw.indexOf("color") === 0 ? "layers"
    : (unitRaw.indexOf("layer") === 0 ? "layers"
      : (unitRaw.indexOf("path") === 0 ? "paths"
        : (unitRaw.indexOf("stitch") === 0 ? "stitches" : unitRaw)));
  const countBit = n && unit ? (n + " " + unit) : "";

  const INTERNAL = /\b(?:invent-warp(?:-forced-bundled)?|invent\/[\w-]+|ecc-multiROI-TPS-bundled|ecc-multiROI-TPS|ecc-multiROI|TPS-bundled|\bTPS\b|bundled|vai-trace(?:\s+fallback)?|vtracer|VTracer|raster-corel|hallucinate(?:-after)?|invent-hallucinate|src-bezier(?:-fallback)?|lab-hier|bezier|Vectorizer\.AI|legacy(?:\s+fallback)?|fallback|path-transfer|corel-import|auto\s+path-transfer|invent-transfer|invent-trace|invent-hybrid|local-trace|local-js)\b/gi;

  if (/^Pro Vectorize/i.test(s) || /Vectorizer\.AI/i.test(s)) {
    return countBit ? ("Pro Vectorize · " + countBit) : "Pro Vectorize";
  }
  if (/^Vectorized/i.test(s) || (/vectoriz/i.test(s) && INTERNAL.test(s))) {
    INTERNAL.lastIndex = 0;
    return countBit ? ("Vectorized · " + countBit) : "Vectorized";
  }
  INTERNAL.lastIndex = 0;
  if (/Corel import/i.test(s)) {
    return countBit ? ("Art imported · " + countBit) : "Art imported";
  }
  if (INTERNAL.test(s) || /invent-warp|ecc-multiROI|vai-trace|vtracer|lab-hier|hallucinate|src-bezier/i.test(s)) {
    INTERNAL.lastIndex = 0;
    s = s.replace(INTERNAL, "");
    s = s.replace(/\s*·\s*·+/g, " · ").replace(/\s{2,}/g, " ").replace(/\s*·\s*$/g, "").replace(/^\s*·\s*/, "").trim();
    if (!s || /^[·\s\/-]*$/.test(s)) {
      return countBit ? ("Vectorized · " + countBit) : "Update";
    }
    if (countBit && s.indexOf(n) === -1) s = s + " · " + countBit;
    return s;
  }
  return s;
}

function presentEvents(events) {
  return (events || []).map(function (e) {
    return Object.assign({}, e, { message: sanitizePublicEventMessage(e.message) });
  });
}

function presentVzMeta(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const m = Object.assign({}, meta);
  if (m.settings) m.settings = Object.assign({}, m.settings);
  delete m.recipe;
  delete m.engine;
  delete m.winner;
  delete m.pipeline;
  return m;
}
function presentVector(vec) {
  if (!vec || typeof vec !== "object") return vec;
  const copy = Object.assign({}, vec);
  if (copy.meta) copy.meta = presentVzMeta(copy.meta);
  if (copy.source && /invent|warp|vtracer|vai-trace|bezier|raster-corel|hallucinate/i.test(String(copy.source))) {
    copy.source = "vectorize";
  }
  return copy;
}
function presentJob(job, req) {
  const copy = Object.assign({}, job);
  copy.proof_url = originOf(req) + "/proof.html?t=" + job.proof_token;
  copy.intake_url = originOf(req) + "/intake.html?t=" + job.proof_token;
  // Keep settings for shop knobs; never leak recipe/engine ids in API payloads clients render.
  if (copy.vector) copy.vector = presentVector(copy.vector);
  return copy;
}
function event(db, job, message) {
  const now = new Date().toISOString();
  db.events.push({ id: uid(), job_id: job.id, message: sanitizePublicEventMessage(message), created_at: now });
  job.updated_at = now;
}
function canSeeJob(user, job) {
  if (!user || !job) return false;
  if (canRunFloor(user)) return job.shop_id === user.shop_id;
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
    return json(res, 200, { demo: allowDemo(), billing: billingConfigured(), imagine: imagineConfigured(), imagineModel: "latest", vectorizerAi: vectorizerAi.configured(), vtracer: vtracer.available(), vaiTrace: vaiTrace.available(), inventVectorize: true, inventWinner: null, rasterCorel: true, inventWarp: inventWarp.available(), inventWarpReason: inventWarp.available() ? null : (inventWarp.unavailableReason && inventWarp.unavailableReason()), corelImport: true, name: "DecoClub Pro", statuses: STATUSES, methods: METHODS, blanks: BLANKS, seed: allowDemo() ? { owner: "owner@anvil.local", client: "client@anvil.local", password: "anvil123" } : null });
  }
  if (pth === "/api/quote" && (method === "POST" || method === "GET")) {
    const body = method === "GET" ? { method: url.searchParams.get("method"), width_in: url.searchParams.get("width_in"), height_in: url.searchParams.get("height_in"), qty: url.searchParams.get("qty"), margin_pct: url.searchParams.get("margin_pct") } : parseJsonBody(await readBody(req));
    return json(res, 200, { quote: priceQuote(body) });
  }
  if (pth === "/api/me" && method === "GET") {
    if (user) {
      const token = parseCookies(req)[COOKIE];
      const sess = (db.sessions || []).find(function (s) { return s.token === token; });
      if (sess && sess.remember) {
        sess.expires = new Date(Date.now() + 15552000 * 1000).toISOString();
        save(db);
        setSession(res, sess.token, req, true);
      }
    }
    return json(res, 200, { user: publicUser(user) });
  }
  if (pth === "/api/catalog" && method === "GET") {
    const q = url.searchParams.get("q");
    const skus = searchCatalog(q);
    return json(res, 200, { skus: skus, total: loadCatalog().length });
  }
  if (pth === "/api/blanks" && method === "GET") {
    const q = url.searchParams.get("q");
    const hits = searchBlanks(q);
    const items = hits.map(function (it) {
      return {
        id: it.id,
        style: it.style,
        style_label: it.style_label,
        color: it.color,
        label: it.label,
        source: it.source || "ssactivewear",
        view: it.view || "flat_front",
        file: it.file,
        url: blankPublicUrl(it),
        cdn: it.cdn || null,
      };
    });
    return json(res, 200, { items: items, total: items.length, source: "S&S Activewear" });
  }

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
      db.shops.push({ id: shop_id, name: body.shopName || (body.name + "'s Shop"), logo_path: null, brand_color: "#017ece", margin_pct: 20, created_at: now });
    }
    const trialDays = Number((db.settings && db.settings.trial_days) || 7);
    const u = { id: uid(), email: email, name: body.name, password_hash: hashPass(body.password), role: role, shop_id: shop_id, plan: role === "shop" ? "trial" : "client", plan_expires: role === "shop" ? new Date(Date.now() + trialDays * 864e5).toISOString() : null, created_at: now };
    db.users.push(u);
    const remember = body.remember_me == null ? true : truthy(body.remember_me);
    const sess = sessionRecord(u.id, remember);
    db.sessions.push(sess);
    save(db); setSession(res, sess.token, req, remember);
    return json(res, 200, { user: publicUser(u) });
  }
  if (pth === "/api/login" && method === "POST") {
    const body = parseJsonBody(await readBody(req));
    const u = db.users.find(function (x) { return x.email === String(body.email || "").toLowerCase(); });
    if (!u || !checkPass(body.password || "", u.password_hash)) return json(res, 401, { error: "Invalid email or password" });
    if (u.disabled) return json(res, 403, { error: "Account disabled" });
    if (ensureAdminShop(db, u)) save(db);
    const remember = truthy(body.remember_me);
    const sess = sessionRecord(u.id, remember);
    db.sessions.push(sess);
    save(db); setSession(res, sess.token, req, remember);
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
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
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
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
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
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    const clients = db.users.filter(function (u) { return u.shop_id === user.shop_id && u.role === "client"; }).map(function (u) {
      return { id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at, jobs: db.jobs.filter(function (j) { return j.client_id === u.id; }).length };
    });
    return json(res, 200, { clients: clients });
  }
  if (pth === "/api/clients" && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
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
    let jobs = canRunFloor(user) ? db.jobs.filter(function (j) { return j.shop_id === user.shop_id; }) : db.jobs.filter(function (j) { return j.client_id === user.id; });
    const q = (url.searchParams.get("q") || "").toLowerCase();
    const st = url.searchParams.get("status");
    const cid = url.searchParams.get("client_id");
    if (q) jobs = jobs.filter(function (j) { return (j.title + " " + j.method + " " + (j.notes || "")).toLowerCase().indexOf(q) !== -1; });
    if (st) jobs = jobs.filter(function (j) { return mapLegacyStatus(j.status) === st; });
    if (cid) jobs = jobs.filter(function (j) { return j.client_id === cid; });
    jobs.sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
    return json(res, 200, { jobs: jobs.map(function (j) { return presentJob(j, req); }) });
  }
  if (pth === "/api/imagine" && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    if (!requireProduce(user, res)) return;
    if (!imagineConfigured()) return json(res, 501, { error: "AI Generate is not configured" });
    const body = parseJsonBody(await readBody(req));
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return json(res, 400, { error: "Prompt required" });
    const methodName = METHODS.indexOf(body.method) !== -1 ? body.method : "apparel";
    try {
      const buf = await generateImage({ prompt: prompt });
      const shop = db.shops.find(function (s) { return s.id === user.shop_id; });
      const now = new Date().toISOString();
      const job = {
        id: uid(), shop_id: user.shop_id, client_id: null, title: prompt.slice(0, 48) || "AI Generate",
        method: methodName, status: "art_in",
        notes: "", art_notes: "AI Generate · " + prompt,
        width_in: 10, height_in: 10, qty: 1,
        due_at: null, file_path: saveImaginePng(buf),
        proof_token: proofToken(), blank: null, garment_color: "#2c3138",
        placement: "chest", catalog_code: null,
        margin_pct: (shop && shop.margin_pct) || 0,
        line_items: [], comments: [], created_at: now, updated_at: now,
      };
      applyQuote(job); applyMockup(job);
      if (job.file_path) job.status = "mockup";
      db.jobs.push(job); event(db, job, "AI Generate"); save(db);
      return json(res, 200, { job: presentJob(job, req) });
    } catch (err) {
      return json(res, 502, { error: IS_PROD ? "AI Generate failed" : err.message });
    }
  }
  if (pth === "/api/jobs" && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
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
      placement: f.placement || "chest", catalog_code: f.catalog_code || null,
      margin_pct: f.margin_pct != null ? Number(f.margin_pct) : (shop && shop.margin_pct) || 0,
      line_items: [], comments: [], created_at: now, updated_at: now,
    };
    if (parsed.file) job.file_path = applyUploadMatte(job.file_path, f);
    if (job.file_path) job.status = "art_in";
    applyQuote(job); applyMockup(job);
    if (job.file_path) job.status = "mockup";
    db.jobs.push(job); event(db, job, "Intake created"); save(db);
    if (job.file_path) {
      const orig = parsed.file && parsed.file.original;
      if (tryAutoCorelImport(job, job.file_path, orig)) {
        event(db, job, "Art imported");
        save(db);
      } else {
        scheduleVectorize(job.id);
      }
    }
    return json(res, 200, { job: presentJob(job, req) });
  }

  const jobGet = pth.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobGet && method === "GET") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    const job = db.jobs.find(function (j) { return j.id === jobGet[1]; });
    if (!job || !canSeeJob(user, job)) return json(res, 404, { error: "Job not found" });
    return json(res, 200, { job: presentJob(job, req), events: presentEvents(db.events.filter(function (e) { return e.job_id === job.id; })) });
  }
  if (jobGet && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === jobGet[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    ["title","notes","art_notes","method","due_at","client_id","blank","garment_color","placement","catalog_code","blank_id","blank_label","blank_file","placement_scale","placement_offset_x","placement_offset_y"].forEach(function (k) {
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
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === art[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const parsed = parseMultipart(await readBody(req), req.headers["content-type"]);
    if (!parsed.file) return json(res, 400, { error: "Artwork file required" });
    job.file_path = applyUploadMatte(parsed.file.path, parsed.fields);
    if (STATUSES.indexOf(job.status) < STATUSES.indexOf("art_in")) job.status = "art_in";
    applyMockup(job);
    event(db, job, "Artwork replaced"); save(db);
    const origArt = parsed.file && parsed.file.original;
    if (tryAutoCorelImport(job, job.file_path, origArt)) {
      event(db, job, "Art imported");
      save(db);
    } else {
      scheduleVectorize(job.id);
    }
    return json(res, 200, { job: presentJob(job, req) });
  }
  const ops = pth.match(/^\/api\/jobs\/([^/]+)\/artops$/);
  if (ops && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === ops[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    // Vector invert: keep geometry, flip fill/stroke + layer hex/rgb/cmyk
    if (body.invert && jobHasUsableVector(job)) {
      try {
        invertJobVector(job);
        applyMockup(job);
        event(db, job, "Invert black & white · vector"); save(db);
        return json(res, 200, {
          job: presentJob(job, req),
          mode: "vector",
          applied: "invert",
          download: "svg",
        });
      } catch (err) {
        return json(res, 400, { error: IS_PROD ? "Could not invert vector" : err.message });
      }
    }
    if (!job.file_path) return json(res, 400, { error: "PNG artwork required for knockout / color swap" });
    const abs = path.join(UPLOADS, path.basename(job.file_path));
    if (!fs.existsSync(abs)) return json(res, 404, { error: "Artwork missing" });
    let srcBuf = fs.readFileSync(abs);
    if (srcBuf[0] !== 0x89 || srcBuf[1] !== 0x50) {
      try {
        srcBuf = vaiTrace.decodeRasterToPng(srcBuf);
        const converted = Date.now() + "-" + uid() + ".png";
        fs.writeFileSync(path.join(UPLOADS, converted), srcBuf);
        job.file_path = "/uploads/" + converted;
      } catch (convErr) {
        return json(res, 400, { error: "Could not convert JPEG/WebP to PNG — export a PNG and drop that" });
      }
    }
    try {
      const out = processArtwork(srcBuf, body);
      const name = Date.now() + "-" + uid() + ".png";
      fs.writeFileSync(path.join(UPLOADS, name), out);
      job.file_path = "/uploads/" + name;
      // Greyscale / invert replace the raster preview — drop stale vector so UI shows the PNG
      const skipRevector = !!(body.greyscale || body.invert);
      if (skipRevector) clearJobVector(job);
      applyMockup(job);
      const label = body.greyscale ? "Hi-res greyscale" : (body.invert ? "Invert black & white · raster" : "Artwork processed");
      event(db, job, label); save(db);
      if (!skipRevector) scheduleVectorize(job.id);
      return json(res, 200, {
        job: presentJob(job, req),
        mode: "raster",
        applied: body.greyscale ? "greyscale" : (body.invert ? "invert" : "artops"),
        download: body.invert ? "png" : null,
      });
    } catch (err) { return json(res, 400, { error: IS_PROD ? "Could not process artwork" : err.message }); }
  }
  const imgJob = pth.match(/^\/api\/jobs\/([^/]+)\/imagine$/);
  if (imgJob && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    if (!requireProduce(user, res)) return;
    if (!imagineConfigured()) return json(res, 501, { error: "AI Generate is not configured" });
    const job = db.jobs.find(function (j) { return j.id === imgJob[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    const prompt = String(body.prompt || "").trim();
    if (!prompt) return json(res, 400, { error: "Prompt required" });
    let imageBuf = null;
    let mime = "image/png";
    if (job.file_path) {
      const abs = path.join(UPLOADS, path.basename(job.file_path));
      if (fs.existsSync(abs)) {
        imageBuf = fs.readFileSync(abs);
        const ext = path.extname(abs).toLowerCase();
        if (ext === ".jpg" || ext === ".jpeg") mime = "image/jpeg";
        else if (ext === ".webp") mime = "image/webp";
      }
    }
    try {
      const buf = await generateImage({ prompt: prompt, imageBuf: imageBuf, mime: mime });
      job.file_path = saveImaginePng(buf);
      if (STATUSES.indexOf(job.status) < STATUSES.indexOf("art_in")) job.status = "art_in";
      applyMockup(job);
      event(db, job, "AI Generate"); save(db);
      return json(res, 200, { job: presentJob(job, req) });
    } catch (err) {
      return json(res, 502, { error: IS_PROD ? "AI Generate failed" : err.message });
    }
  }
  const mk = pth.match(/^\/api\/jobs\/([^/]+)\/mockup$/);
  if (mk && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === mk[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    if (body.blank) job.blank = body.blank;
    if (body.garment_color) job.garment_color = body.garment_color;
    if (body.placement) job.placement = body.placement;
    if (body.placement_scale != null && body.placement_scale !== "") job.placement_scale = Number(body.placement_scale);
    if (body.placement_offset_x != null && body.placement_offset_x !== "") job.placement_offset_x = Number(body.placement_offset_x);
    if (body.placement_offset_y != null && body.placement_offset_y !== "") job.placement_offset_y = Number(body.placement_offset_y);
    if (body.blank_id) {
      job.blank_id = String(body.blank_id);
      const blank = findBlank(job.blank_id);
      if (blank) {
        job.blank_label = blank.label || blank.id;
        job.blank_file = blank.file;
        job.blank = "tee";
        if (!body.garment_color && blank.color) {
          // keep explicit color picker if sent; otherwise leave garment_color alone
        }
      }
    } else if (body.blank_id === "" || body.blank_id === null) {
      job.blank_id = null;
      job.blank_label = null;
      job.blank_file = null;
    }
    if (body.blank_label) job.blank_label = String(body.blank_label);
    if (body.blank_file) job.blank_file = String(body.blank_file).replace(/^\/+/, "");
    if (body.catalog_code) {
      job.catalog_code = body.catalog_code;
      const sku = findSku(body.catalog_code);
      if (sku) {
        if (!job.blank_id) job.blank = sku.kind;
        if (!body.garment_color) job.garment_color = sku.hex;
        if (!body.placement && sku.placements && sku.placements[0]) job.placement = sku.placements[0].id;
      }
    }
    applyMockup(job);
    if (STATUSES.indexOf(job.status) < STATUSES.indexOf("mockup")) job.status = "mockup";
    event(db, job, job.blank_id
      ? ("Applied to blank · " + (job.blank_label || job.blank_id) + (job._mockup_art_missing ? " · art missing (upload/vector not loaded)" : ""))
      : "Mockup regenerated"); save(db);
    return json(res, 200, { job: presentJob(job, req) });
  }
  const pr = pth.match(/^\/api\/jobs\/([^/]+)\/price$/);
  if (pr && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
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
    if (canRunFloor(user)) {
      if (job.shop_id !== user.shop_id) return json(res, 403, { error: "Forbidden" });
      if (["proof_sent", "approved", "in_production", "done"].indexOf(next) !== -1 && !requireProduce(user, res)) return;
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

  if (pth === "/api/palettes" && method === "GET") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    return json(res, 200, listPalettes());
  }

  /* Explicit CorelDRAW path-transfer import (not default PNG Vectorize).
     POST /api/jobs/:id/corel-import  OR  POST .../vectorize { engine: "corel-import" } */
  const corelImp = pth.match(/^\/api\/jobs\/([^/]+)\/corel-import$/);
  if (corelImp && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    if (!requireProduce(user, res)) return;
    const job = db.jobs.find(function (j) { return j.id === corelImp[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    if (!job.file_path) return json(res, 400, { error: "Upload a CorelDRAW SVG first" });
    const abs = path.join(UPLOADS, path.basename(job.file_path));
    if (!fs.existsSync(abs)) return json(res, 404, { error: "Artwork missing" });
    const buf = fs.readFileSync(abs);
    if (!corelImport.looksLikeSvg(buf)) return json(res, 400, { error: "Artwork is not SVG — export SVG from CorelDRAW" });
    try {
      const result = runCorelImportOnJob(job, buf, body);
      if (body.apply_mockup !== false) applyMockup(job);
      event(db, job, "Art imported · " + (result.meta.paths || 0) + " paths");
      save(db);
      return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector), meta: presentVzMeta(result.meta) });
    } catch (err) {
      return json(res, 400, { error: IS_PROD ? "Could not import Corel SVG" : err.message });
    }
  }

  const vecPath = pth.match(/^\/api\/jobs\/([^/]+)\/vectorize$/);
  if (vecPath && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    if (!requireProduce(user, res)) return;
    const job = db.jobs.find(function (j) { return j.id === vecPath[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = normalizeVectorizeBody(parseJsonBody(await readBody(req)));
    stampVzSettings(job, body);
    if (!job.file_path) return json(res, 400, { error: "Artwork required to vectorize" });
    const abs = path.join(UPLOADS, path.basename(job.file_path));
    if (!fs.existsSync(abs)) return json(res, 404, { error: "Artwork missing" });
    let buf = fs.readFileSync(abs);
    const wantCorel = body.engine === "corel-import" || body.engine === "corel";
    const isSvg = corelImport.looksLikeSvg(buf);
    const svgText = isSvg ? buf.toString("utf8") : "";
    const isCorelSvg = isSvg && corelImport.isCorelSvg(svgText);
    /* Explicit Corel path-transfer — NOT the default PNG Vectorize button */
    if (wantCorel || isCorelSvg) {
      if (!isSvg) return json(res, 400, { error: "corel-import needs a CorelDRAW SVG upload" });
      try {
        const result = runCorelImportOnJob(job, buf, body);
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Art imported · " + (job.vector.layers || []).length + " layers");
        save(db);
        return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector), meta: presentVzMeta(result.meta) });
      } catch (err) {
        return json(res, 400, { error: IS_PROD ? "Could not import Corel SVG" : err.message });
      }
    }
    if (isSvg) return json(res, 400, { error: "SVG is not CorelDRAW — use engine corel-import only for Corel exports, or upload PNG to Vectorize" });
    if (buf[0] !== 0x89 || buf[1] !== 0x50) {
      try {
        buf = vaiTrace.decodeRasterToPng(buf);
      } catch (err) {
        return json(res, 400, { error: "Need PNG, JPG, or WebP artwork" });
      }
    }
    if (buf[0] !== 0x89 || buf[1] !== 0x50) return json(res, 400, { error: "Need PNG, JPG, or WebP artwork" });
    /* Keep full-res for invent-warp twin match; downscale only the buffer fed to heavy tracers. */
    const srcBuf = buf;
    let sizeMeta = { sizeGuard: { downscaled: false } };
    try {
      const guarded = vectorizeGuard.downscaleIfNeeded(buf);
      buf = guarded.buf;
      sizeMeta = guarded.meta || sizeMeta;
    } catch (guardErr) {
      const info = vectorizeGuard.inspect(srcBuf);
      return json(res, 413, vectorizeGuard.rejectPayload(info));
    }
    const wantApi = body.engine === "vectorizer.ai";
    const wantVtracer = body.engine === "vtracer";
    const wantVai = body.engine === "vai-trace" || body.engine === "vai" || body.engine === "local-trace";
    const wantLegacy = body.engine === "legacy" || body.engine === "local-js";
    const wantHallucinate = body.engine === "raster-corel" || body.engine === "hallucinate" || body.engine === "invent-hallucinate" || body.engine === "invent-warp";
    const wantInvent = body.engine === "invent" || body.engine === "invent-transfer" || body.engine === "invent-trace" || body.engine === "invent-hybrid";
    try {
      if (wantHallucinate) {
        const packed = rasterCorel.vectorizeToSvg(srcBuf, job.width_in, job.height_in, Object.assign({}, body, {
          fuse: body.fuse || "hallucinate",
          sizeIn: job.width_in,
        }));
        const svg = typeof packed === "string" ? packed : packed.svg;
        const vec = packed.vec || { widthIn: job.width_in, heightIn: job.height_in, layers: [], source: "raster-corel" };
        applyVectorResult(job, vec, svg);
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
        save(db);
        return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector), meta: presentVzMeta(packed.meta || (vec && vec.meta)) });
      }
      if (wantInvent) {
        const inventMode =
          body.engine === "invent-transfer" ? "transfer" :
          body.engine === "invent-trace" ? "trace" :
          body.engine === "invent-hybrid" ? "hybrid" :
          (body.inventMode || body.mode || "auto");
        const packed = inventVectorize.vectorizeToSvg(srcBuf, job.width_in, job.height_in, Object.assign({}, body, {
          mode: inventMode,
          sizeIn: job.width_in,
          corelSvg: body.corelSvg,
        }));
        const svg = typeof packed === "string" ? packed : packed.svg;
        const vec = packed.vec || { widthIn: job.width_in, heightIn: job.height_in, layers: [], source: "invent" };
        applyVectorResult(job, vec, svg);
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
        save(db);
        return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector), meta: presentVzMeta(packed.meta || (vec && vec.meta)) });
      }
      if (wantApi) {
        if (!vectorizerAi.configured()) {
          return json(res, 501, { error: "Vectorizer.AI keys not configured" });
        }
        await runProVectorize(job, buf, Object.assign({}, body, { engine: "vectorizer.ai", api: true }));
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Pro Vectorize · " + (job.vector.layers || []).length + " layers"); save(db);
        return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector) });
      }
      if (wantVai) {
        if (!vaiTrace.available()) return json(res, 501, { error: vaiTrace.unavailableReason() || "vai-trace unavailable" });
        const result = await runVaiTraceSafe(buf, job, body, sizeMeta);
        applyVectorResult(job, result.vec, result.svg);
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
        save(db);
        return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector), meta: presentVzMeta(result.meta) });
      }
      if (wantVtracer) {
        if (!vtracer.available()) return json(res, 501, { error: "VTracer binary missing" });
        runVtracerVectorize(job, buf, body);
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers"); save(db);
        return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector) });
      }
      if (wantLegacy) {
        const opts = {
          colors: body.colors,
          maxEdge: Math.min(Number(body.maxEdge) || 720, 800),
          epsilon: body.epsilon,
          fitError: body.fitError,
          cornerCos: body.cornerCos,
        };
        const msg = await vectorizeInWorker(buf, job.width_in, job.height_in, opts, 90000);
        applyVectorResult(job, msg.vec, msg.svg);
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Vectorized · " + msg.vec.layers.length + " layers"); save(db);
        return json(res, 200, { job: presentJob(job, req), vector: presentVector(msg.vec) });
      }
      /* Default PNG Vectorize:
       *  1) soft frontal tiger twin → invent-warp bundled (fast, Corel-class for that mark)
       *  2) everything else → vai-trace (Lab hier + cubics); VTracer only if vai-trace missing
       *  Never run heavy bezier on the request thread — that 502s Railway.
       */
      const opts = {
        colors: body.colors == null ? 8 : body.colors,
        maxEdge: Math.min(Number(body.maxEdge) || 720, 900),
        epsilon: body.epsilon,
        fitError: body.fitError,
        cornerCos: body.cornerCos,
        overlapPx: body.overlapPx,
        fuse: body.fuse || "auto",
        priorSvg: body.priorSvg,
        priorPng: body.priorPng,
        structuralPrior: body.structuralPrior,
      };
      try {
        let twin = false;
        try {
          const priorPng = rasterCorel.resolvePriorPng(opts);
          if (priorPng && fs.existsSync(priorPng) && typeof rasterCorel.srcMatchesPrior === "function") {
            twin = rasterCorel.srcMatchesPrior(srcBuf, fs.readFileSync(priorPng));
          }
        } catch (matchErr) {
          twin = false;
        }
        // Live slider preview must stay on the sellable tracer — invent-warp ignores Detail/Smoothing knobs.
        const skipTwin = body.live === true || body.skipTwin === true;
        if (twin && !skipTwin) {
          const packed = rasterCorel.vectorizeToSvg(srcBuf, job.width_in, job.height_in, Object.assign({}, opts, { fuse: "auto" }));
          applyVectorResult(job, packed.vec, packed.svg);
          if (body.apply_mockup) applyMockup(job);
          event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
          save(db);
          return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector), meta: presentVzMeta(packed.meta || (packed.vec && packed.vec.meta)) });
        }
        // Non-twin: vai-trace first (general Lab+cubic). VTracer if missing. Bezier only in worker last.
        // Large art is downscaled (sizeMeta) and run via worker / async spawn so the event loop cannot wedge.
        if (vaiTrace.available()) {
          const result = await runVaiTraceSafe(buf, job, Object.assign({}, body, { colors: opts.colors, mode: "auto" }), sizeMeta);
          applyVectorResult(job, result.vec, result.svg);
          if (body.apply_mockup) applyMockup(job);
          event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
          save(db);
          return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector), meta: presentVzMeta(result.meta) });
        }
        if (vtracer.available()) {
          runVtracerVectorize(job, buf, body);
          if (body.apply_mockup) applyMockup(job);
          event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
          save(db);
          return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector) });
        }
        const wopts = {
          colors: opts.colors,
          maxEdge: Math.min(opts.maxEdge, 640),
          epsilon: body.epsilon,
          fitError: body.fitError,
          cornerCos: body.cornerCos,
          overlapPx: body.overlapPx,
        };
        const msg = await vectorizeInWorker(buf, job.width_in, job.height_in, wopts, 120000);
        applyVectorResult(job, msg.vec, msg.svg);
        if (job.vector && job.vector.meta) {
          job.vector.meta.recipe = "src-bezier-fallback";
          job.vector.meta.engine = "raster-corel";
          job.vector.source = "raster-corel";
        }
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
        save(db);
        return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector), meta: presentVzMeta(job.vector && job.vector.meta) });
      } catch (bezErr) {
        if (vaiTrace.available()) {
          try {
            const result = await runVaiTraceSafe(buf, job, Object.assign({}, body, { mode: "auto" }), sizeMeta);
            applyVectorResult(job, result.vec, result.svg);
            if (body.apply_mockup) applyMockup(job);
            event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
            save(db);
            return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector), meta: presentVzMeta(result.meta) });
          } catch (vaiErr) { /* fall through */ }
        }
        if (vtracer.available()) {
          runVtracerVectorize(job, buf, body);
          if (body.apply_mockup) applyMockup(job);
          event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers"); save(db);
          return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector) });
        }
        throw bezErr;
      }
    } catch (err) {
      return json(res, 400, { error: IS_PROD ? "Could not vectorize" : err.message });
    }
  }
  const recPath = pth.match(/^\/api\/jobs\/([^/]+)\/recolor$/);
  if (recPath && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    if (!requireProduce(user, res)) return;
    const job = db.jobs.find(function (j) { return j.id === recPath[1] && j.shop_id === user.shop_id; });
    if (!job || !job.vector || !job.vector.layers) return json(res, 400, { error: "Vectorize first" });
    const body = parseJsonBody(await readBody(req));
    const idx = Number(body.layer);
    if (!job.vector.layers[idx]) return json(res, 400, { error: "Unknown layer" });
    const prevHex = job.vector.layers[idx].hex;
    if (body.cmyk && (body.cmyk.c != null || body.cmyk.C != null)) {
      const c = body.cmyk.c != null ? body.cmyk.c : body.cmyk.C;
      const m = body.cmyk.m != null ? body.cmyk.m : body.cmyk.M;
      const y = body.cmyk.y != null ? body.cmyk.y : body.cmyk.Y;
      const k = body.cmyk.k != null ? body.cmyk.k : body.cmyk.K;
      body.hex = colorspec.cmykToHex(c, m, y, k);
    } else if (body.rgb && (body.rgb.r != null || body.rgb.R != null)) {
      const r = body.rgb.r != null ? body.rgb.r : body.rgb.R;
      const g = body.rgb.g != null ? body.rgb.g : body.rgb.G;
      const b = body.rgb.b != null ? body.rgb.b : body.rgb.B;
      body.hex = colorspec.rgbToHex(r, g, b);
    }
    if (body.hex) job.vector.layers[idx].hex = String(body.hex);
    if (body.hex) {
      const ann = colorspec.annotateLayer({ hex: job.vector.layers[idx].hex, paths: job.vector.layers[idx].paths || [] });
      job.vector.layers[idx] = Object.assign(job.vector.layers[idx], ann);
    }
    if (body.name) job.vector.layers[idx].nameGuess = String(body.name);
    job.vector.layers[idx].palette = body.palette || job.vector.layers[idx].palette;
    // Hex-replace SVG text whenever vector_svg is on disk (vai-trace / invent-warp store empty paths[]).
    if (job.vector_svg && body.hex && prevHex) {
      const abs = path.join(UPLOADS, path.basename(job.vector_svg));
      if (fs.existsSync(abs)) {
        let svg = fs.readFileSync(abs, "utf8");
        const from = String(prevHex);
        const to = String(body.hex);
        const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        svg = svg.replace(new RegExp(esc, "gi"), to);
        const name = Date.now() + "-" + uid() + "-vector.svg";
        fs.writeFileSync(path.join(UPLOADS, name), svg);
        job.vector_svg = "/uploads/" + name;
        delete job.vector_eps;
      } else {
        rewriteVectorSvg(job);
      }
    } else {
      rewriteVectorSvg(job);
    }
    event(db, job, "Recolor layer " + idx); save(db);
    return json(res, 200, { job: presentJob(job, req), vector: presentVector(job.vector) });
  }
  const stnPath = pth.match(/^\/api\/jobs\/([^/]+)\/stones$/);
  if (stnPath && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    if (!requirePaidProduce(user, res)) return;
    const job = db.jobs.find(function (j) { return j.id === stnPath[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    const pack = stonesForJob(job, UPLOADS, { ss: body.ss || "SS10" });
    job.stones = { count: pack.count, ss: pack.ss };
    job.stone_ss = pack.ss;
    event(db, job, "Stones · " + pack.count + " " + pack.ss); save(db);
    return json(res, 200, { job: presentJob(job, req), count: pack.count, ss: pack.ss, stones: pack.stones });
  }
  const digPath = pth.match(/^\/api\/jobs\/([^/]+)\/digitize$/);
  if (digPath && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    if (!requirePaidProduce(user, res)) return;
    const job = db.jobs.find(function (j) { return j.id === digPath[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    if (body.widthIn != null || body.width_in != null) job.width_in = Number(body.widthIn || body.width_in);
    if (body.heightIn != null || body.height_in != null) job.height_in = Number(body.heightIn || body.height_in);
    const dig = digitizeJob(job, UPLOADS, {
      satinMm: body.satinMm,
      satinSpacingMm: body.satinSpacingMm,
      density: body.density,
      widthIn: job.width_in,
      heightIn: job.height_in,
      threads: body.threads,
      typeOverrides: body.typeOverrides,
      previewOnly: !!body.previewOnly,
      recolorOnly: !!body.recolorOnly,
      angleDeg: body.angleDeg,
      madeiraCatalog: body.madeiraCatalog,
      fabric: body.fabric,
    });
    job.stitchCount = dig.stitchCount;
    job.colorStops = dig.colorStops;
    if (dig.objects) job.digitizeObjects = dig.objects;
    if (dig.exporter) job.digitizeExporter = dig.exporter;
    event(db, job, dig.recolored ? ("Thread swap · " + (dig.colorStops[0] && dig.colorStops[0].madeiraCode || "Madeira")) : ("Digitized · " + dig.stitchCount + " stitches"));
    save(db);
    return json(res, 200, {
      job: presentJob(job, req),
      stitchCount: dig.stitchCount,
      colorStops: dig.colorStops,
      preview: dig.preview,
      objects: dig.objects,
      exporter: dig.exporter,
      usedFallback: !!dig.usedFallback,
      fabric: dig.fabric || body.fabric || null,
    });
  }

  const poster = pth.match(/^\/api\/export\/([^/]+)\/intake-poster.svg$/);
  if (poster && method === "GET") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    if (!requireProduce(user, res)) return;
    const job = db.jobs.find(function (j) { return j.id === poster[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const shop = db.shops.find(function (s) { return s.id === user.shop_id; });
    return download(res, "decoclub-intake-" + job.id.slice(0, 8) + ".svg", intakePosterSvg(job, originOf(req), shop), "image/svg+xml");
  }
  const expFile = pth.match(/^\/api\/export\/([^/]+)\/([^/]+)$/);
  if (expFile && method === "GET") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    const exportName = String(expFile[2] || "").toLowerCase();
    const packetExport = /\.(dst|exp)$/.test(exportName) || exportName.indexOf("dst") !== -1 || exportName.indexOf("exp") !== -1 || exportName.indexOf("stones") !== -1 || exportName.indexOf("packet") !== -1;
    if (packetExport) {
      if (!requirePaidProduce(user, res)) return;
    } else {
      if (!requireProduce(user, res)) return;
    }
    const job = db.jobs.find(function (j) { return j.id === expFile[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    job._shop = db.shops.find(function (s) { return s.id === user.shop_id; });
    if (expFile[2] === "art.svg" && job.vector_svg) {
      const abs = path.join(UPLOADS, path.basename(job.vector_svg));
      if (fs.existsSync(abs)) {
        return download(res, "decoclub-" + job.id.slice(0, 8) + "-art.svg", fs.readFileSync(abs), "image/svg+xml");
      }
    }
    if (expFile[2] === "art.png" && job.file_path) {
      const abs = path.join(UPLOADS, path.basename(job.file_path));
      if (fs.existsSync(abs)) {
        return download(res, "decoclub-" + job.id.slice(0, 8) + "-art.png", fs.readFileSync(abs), "image/png");
      }
    }
    if (expFile[2] === "art.eps" && job.vector_eps) {
      const abs = path.join(UPLOADS, path.basename(job.vector_eps));
      if (fs.existsSync(abs)) {
        return download(res, "decoclub-" + job.id.slice(0, 8) + "-art.eps", fs.readFileSync(abs), "application/postscript");
      }
    }
    const pack = writeExports(job, UPLOADS, path.join(EXPORTS, job.id));
    const name = expFile[2];
    const short = job.id.slice(0, 8);
    if (name === "packet.json") return download(res, "decoclub-" + short + "-packet.json", JSON.stringify(pack.packet, null, 2), "application/json");
    if (pack.contents[name]) return download(res, "decoclub-" + short + "-" + name, pack.contents[name], MIME[path.extname(name)] || "application/octet-stream");
    return json(res, 404, { error: "Unknown export" });
  }
  const exp = pth.match(/^\/api\/export\/([^/]+)$/);
  if (exp && method === "GET") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    if (!requireProduce(user, res)) return;
    const job = db.jobs.find(function (j) { return j.id === exp[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    job._shop = db.shops.find(function (s) { return s.id === user.shop_id; });
    const pack = writeExports(job, UPLOADS, path.join(EXPORTS, job.id));
    res.setHeader("Content-Disposition", 'attachment; filename="decoclub-' + job.id.slice(0, 8) + '-packet.json"');
    return json(res, 200, pack.packet);
  }

  function publicAdminUser(u) {
    const shop = db.shops.find(function (s) { return s.id === u.shop_id; });
    return {
      id: u.id, email: u.email, name: u.name, role: u.role, shop_id: u.shop_id,
      shop_name: shop ? shop.name : null, plan: u.plan, plan_expires: u.plan_expires,
      disabled: !!u.disabled, created_at: u.created_at,
      jobs: (db.jobs || []).filter(function (j) { return j.owner_id === u.id || j.client_id === u.id; }).length,
    };
  }
  function adminJobRow(j) {
    const owner = db.users.find(function (u) { return u.id === j.owner_id || u.id === j.client_id; });
    const shop = db.shops.find(function (s) { return s.id === j.shop_id; });
    return {
      id: j.id,
      title: j.title || "",
      method: j.method || "",
      status: j.status || "",
      shop_id: j.shop_id || null,
      shop_name: shop ? shop.name : null,
      owner_id: owner ? owner.id : (j.owner_id || j.client_id || null),
      owner_email: owner ? owner.email : null,
      owner_name: owner ? owner.name : null,
      created_at: j.created_at,
      updated_at: j.updated_at,
      file_path: j.file_path || null,
      vector_svg: j.vector_svg || null,
      has_artwork: !!(j.file_path),
      has_vector: !!(j.vector_svg || (j.vector && j.vector.layers && j.vector.layers.length)),
    };
  }

  if (pth === "/api/admin/overview" && method === "GET") {
    if (!requireAdmin(user, res)) return;
    const users = db.users || [];
    const shops = db.shops || [];
    const jobs = db.jobs || [];
    const recentUsers = users.slice().sort(function (a, b) {
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    }).slice(0, 8).map(publicAdminUser);
    const recentJobs = jobs.slice().sort(function (a, b) {
      return String(b.created_at || b.updated_at || "").localeCompare(String(a.created_at || a.updated_at || ""));
    }).slice(0, 8).map(adminJobRow);
    return json(res, 200, {
      counts: {
        users: users.length,
        shops: shops.length,
        jobs: jobs.length,
        disabled_users: users.filter(function (u) { return u.disabled; }).length,
      },
      recent_signups: recentUsers,
      recent_jobs: recentJobs,
      system: {
        version: BUILD.version,
        stamp: BUILD.stamp,
        billing_configured: billingConfigured(),
        stripe_configured: billingConfigured(),
        imagine: false,
        vectorizer_ai: false,
        vai_trace: vaiTrace.available(),
      },
    });
  }

  if (pth === "/api/admin/system" && method === "GET") {
    if (!requireAdmin(user, res)) return;
    const settings = ensureSettings(db);
    return json(res, 200, {
      health: { ok: true },
      version: BUILD.version,
      name: BUILD.name,
      stamp: BUILD.stamp,
      node: process.version,
      feature_flags: {
        trial_days: settings.trial_days,
        shop_price_cents: settings.shop_price_cents,
        studio_price_cents: settings.studio_price_cents,
      },
      billing_configured: billingConfigured(),
      stripe_configured: billingConfigured(),
      imagine: false,
      vectorizer_ai: false,
      vai_trace: vaiTrace.available(),
      vtracer: vtracer.available(),
    });
  }

  if (pth === "/api/admin/shops" && method === "GET") {
    if (!requireAdmin(user, res)) return;
    const shops = db.shops.map(function (s) {
      return Object.assign({}, s, {
        users: db.users.filter(function (u) { return u.shop_id === s.id; }).length,
        jobs: db.jobs.filter(function (j) { return j.shop_id === s.id; }).length,
      });
    });
    return json(res, 200, { shops: shops });
  }
  if (pth === "/api/admin/shops" && method === "POST") {
    if (!requireAdmin(user, res)) return;
    const body = parseJsonBody(await readBody(req));
    if (!body.name) return json(res, 400, { error: "Shop name required" });
    const now = new Date().toISOString();
    const shop = {
      id: uid(), name: body.name, logo_path: null,
      brand_color: body.brand_color || "#017ece", margin_pct: body.margin_pct != null ? Number(body.margin_pct) : 20,
      created_at: now,
    };
    db.shops.push(shop); save(db);
    return json(res, 200, { shop: shop });
  }
  const shopPath = pth.match(/^\/api\/admin\/shops\/([^/]+)$/);
  if (shopPath && method === "PATCH") {
    if (!requireAdmin(user, res)) return;
    const shop = db.shops.find(function (s) { return s.id === shopPath[1]; });
    if (!shop) return json(res, 404, { error: "Shop not found" });
    const body = parseJsonBody(await readBody(req));
    if (body.name) shop.name = String(body.name).trim();
    if (body.brand_color) shop.brand_color = String(body.brand_color);
    if (body.margin_pct != null) shop.margin_pct = Number(body.margin_pct) || 0;
    save(db);
    return json(res, 200, { shop: shop });
  }
  if (shopPath && method === "DELETE") {
    if (!requireAdmin(user, res)) return;
    const id = shopPath[1];
    const shop = db.shops.find(function (s) { return s.id === id; });
    if (!shop) return json(res, 404, { error: "Shop not found" });
    const userCount = db.users.filter(function (u) { return u.shop_id === id; }).length;
    const jobCount = db.jobs.filter(function (j) { return j.shop_id === id; }).length;
    if (userCount > 0 || jobCount > 0) {
      return json(res, 400, {
        error: "Shop still has " + userCount + " user(s) and " + jobCount + " job(s). Reassign or delete them first.",
      });
    }
    db.shops = db.shops.filter(function (s) { return s.id !== id; });
    save(db);
    return json(res, 200, { ok: true, deleted: id });
  }

  if (pth === "/api/admin/users" && method === "GET") {
    if (!requireAdmin(user, res)) return;
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    let users = db.users.map(publicAdminUser);
    if (q) {
      users = users.filter(function (u) {
        return (u.email + " " + u.name + " " + (u.shop_name || "") + " " + (u.role || "")).toLowerCase().indexOf(q) !== -1;
      });
    }
    return json(res, 200, { users: users });
  }
  const delUser = pth.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (delUser && method === "DELETE") {
    if (!requireAdmin(user, res)) return;
    const id = delUser[1];
    const u = db.users.find(function (x) { return x.id === id; });
    if (!u) return json(res, 404, { error: "User not found" });
    if (u.role === "admin") return json(res, 400, { error: "Cannot delete admin" });
    if (u.id === user.id) return json(res, 400, { error: "Cannot delete yourself" });
    db.users = db.users.filter(function (x) { return x.id !== id; });
    db.sessions = (db.sessions || []).filter(function (s) { return s.user_id !== id; });
    db.jobs = (db.jobs || []).filter(function (j) { return j.owner_id !== id && j.client_id !== id; });
    save(db);
    return json(res, 200, { ok: true, deleted: id, email: u.email });
  }
  if (delUser && method === "PATCH") {
    if (!requireAdmin(user, res)) return;
    const u = db.users.find(function (x) { return x.id === delUser[1]; });
    if (!u) return json(res, 404, { error: "User not found" });
    const body = parseJsonBody(await readBody(req));
    if (body.role === "shop" || body.role === "client") {
      if (u.role === "admin") return json(res, 400, { error: "Cannot change admin role" });
      u.role = body.role;
      if (body.role === "client" && (u.plan === "shop" || u.plan === "studio" || u.plan === "trial")) {
        u.plan = "client";
      }
    }
    if (body.shop_id !== undefined) {
      if (body.shop_id === null || body.shop_id === "") {
        u.shop_id = null;
      } else {
        const shop = db.shops.find(function (s) { return s.id === body.shop_id; });
        if (!shop) return json(res, 400, { error: "Shop not found" });
        u.shop_id = shop.id;
      }
    }
    if (body.disabled !== undefined) {
      if (u.role === "admin") return json(res, 400, { error: "Cannot disable admin" });
      if (u.id === user.id) return json(res, 400, { error: "Cannot disable yourself" });
      u.disabled = !!body.disabled;
      if (u.disabled) {
        db.sessions = (db.sessions || []).filter(function (s) { return s.user_id !== u.id; });
      }
    }
    if (body.name) u.name = String(body.name).trim();
    save(db);
    return json(res, 200, { user: publicAdminUser(u) });
  }
  const planPath = pth.match(/^\/api\/admin\/users\/([^/]+)\/plan$/);
  if (planPath && method === "POST") {
    if (!requireAdmin(user, res)) return;
    const u = db.users.find(function (x) { return x.id === planPath[1]; });
    if (!u) return json(res, 404, { error: "User not found" });
    const body = parseJsonBody(await readBody(req));
    if (body.revoke) {
      u.plan = body.plan || "client";
      u.plan_expires = null;
      save(db);
      return json(res, 200, { user: publicAdminUser(u) });
    }
    if (body.plan) u.plan = body.plan;
    if (body.plan_expires) u.plan_expires = body.plan_expires;
    if (body.plan_expires === null) u.plan_expires = null;
    const months = Number(body.complimentary_months) || 0;
    if (months > 0) {
      const now = new Date();
      const cur = u.plan_expires ? new Date(u.plan_expires) : now;
      const base = cur > now ? cur : now;
      base.setMonth(base.getMonth() + months);
      u.plan_expires = base.toISOString();
      if (!body.plan && (u.plan === "trial" || u.plan === "client" || !u.plan)) u.plan = "shop";
    }
    save(db);
    return json(res, 200, { user: publicAdminUser(u) });
  }
  const passPath = pth.match(/^\/api\/admin\/users\/([^/]+)\/password$/);
  if (passPath && method === "POST") {
    if (!requireAdmin(user, res)) return;
    const u = db.users.find(function (x) { return x.id === passPath[1]; });
    if (!u) return json(res, 404, { error: "User not found" });
    if (u.role === "admin" && u.id !== user.id) {
      return json(res, 400, { error: "Cannot reset another admin password" });
    }
    const body = parseJsonBody(await readBody(req));
    let temp = body.password ? String(body.password) : "";
    if (!temp) {
      temp = crypto.randomBytes(4).toString("hex") + "A1!";
    }
    if (temp.length < 6) return json(res, 400, { error: "Password must be 6+ characters" });
    u.password_hash = hashPass(temp);
    db.sessions = (db.sessions || []).filter(function (s) { return s.user_id !== u.id; });
    save(db);
    // Return temp password once; never store plaintext.
    return json(res, 200, { ok: true, user_id: u.id, email: u.email, temporary_password: temp });
  }

  if (pth === "/api/admin/jobs" && method === "GET") {
    if (!requireAdmin(user, res)) return;
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
    let jobs = (db.jobs || []).slice().sort(function (a, b) {
      return String(b.created_at || b.updated_at || "").localeCompare(String(a.created_at || a.updated_at || ""));
    });
    if (q) {
      jobs = jobs.filter(function (j) {
        const row = adminJobRow(j);
        return (row.title + " " + row.method + " " + (row.owner_email || "") + " " + (row.shop_name || "") + " " + row.id)
          .toLowerCase().indexOf(q) !== -1;
      });
    }
    return json(res, 200, { jobs: jobs.slice(0, limit).map(adminJobRow) });
  }
  const delJob = pth.match(/^\/api\/admin\/jobs\/([^/]+)$/);
  if (delJob && method === "DELETE") {
    if (!requireAdmin(user, res)) return;
    const id = delJob[1];
    const job = db.jobs.find(function (j) { return j.id === id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    db.jobs = db.jobs.filter(function (j) { return j.id !== id; });
    db.events = (db.events || []).filter(function (e) { return e.job_id !== id; });
    save(db);
    return json(res, 200, { ok: true, deleted: id });
  }

  if (pth === "/api/admin/settings" && method === "GET") {
    if (!requireAdmin(user, res)) return;
    return json(res, 200, {
      settings: ensureSettings(db),
      billing_configured: billingConfigured(),
      imagine: false,
      vectorizer_ai: false,
    });
  }
  if (pth === "/api/admin/settings" && method === "POST") {
    if (!requireAdmin(user, res)) return;
    const body = parseJsonBody(await readBody(req));
    const st = ensureSettings(db);
    if (body.trial_days != null) st.trial_days = Math.max(0, Number(body.trial_days) || 0);
    if (body.shop_price_cents != null) st.shop_price_cents = Math.max(0, Math.round(Number(body.shop_price_cents)));
    if (body.studio_price_cents != null) st.studio_price_cents = Math.max(0, Math.round(Number(body.studio_price_cents)));
    db.settings = st; save(db);
    return json(res, 200, { settings: st, billing_configured: billingConfigured() });
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
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        name: BUILD.name,
        version: BUILD.version,
        stamp: BUILD.stamp,
        billing: billingConfigured(),
        imagine: false,
        vectorizerAi: false,
        vaiTrace: vaiTrace.available(),
      });
    }
    if (url.pathname.indexOf("/api/") === 0) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    console.error(err);
    json(res, 500, { error: clientError(err) });
  }
});

loadCatalog();
const bootDb = load();
if (allowDemo()) ensureDemoJob(bootDb);

const PORT = process.env.PORT || 3847;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, function () {
  console.log("DecoClub Pro running at http://" + HOST + ":" + PORT);
});
