const http = require("http");
const { Worker } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { priceJob, priceQuote } = require("./lib/price");
const mailer = require("./lib/mailer");
const DISPOSABLE = new Set(fs.readFileSync(path.join(__dirname, "lib", "disposable-domains.txt"), "utf8").split(/\r?\n/).map(function (l) { return l.trim().toLowerCase(); }).filter(function (l) { return l && l[0] !== "#"; }));
function isDisposableEmail(email) {
  const dom = String(email).split("@").pop().toLowerCase();
  const parts = dom.split(".");
  for (let i = 0; i < parts.length - 1; i++) if (DISPOSABLE.has(parts.slice(i).join("."))) return true;
  return false;
}
function passwordProblem(pw) {
  pw = String(pw || "");
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must be 8+ characters with at least one letter and one number";
  return null;
}
const { writeExports, intakePosterSvg, stripPaperUnderlaySvg } = require("./lib/exports");
const { parsePreviewQuery, renderPreviewPng, loadSvgText } = require("./lib/previewRender");
const {
  servePreview,
  takePreviewToken,
  previewCacheKey,
  clampHalftonePreviewBudget,
  halftonePreviewRasterSpec,
} = require("./lib/previewGate");
const { writeMockups, BLANKS, searchBlanks, findBlank, blankPublicUrl } = require("./lib/mockup");
const { loadCatalog, findSku, searchCatalog } = require("./lib/catalog");
const { generateBadgePng } = require("./lib/demoart");
const { processArtwork } = require("./lib/artops");
const vectorHalftone = require("./lib/vectorHalftone");
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
const { digitizeJobCached, getDigitizeCache, ensureStitchFiles, pickPrepPython } = require("./lib/digitize");
const { stonesForJob } = require("./lib/stones");
const features = require("./lib/features");
const {
  loadEnvFile,
  isCreditProduct, isKnownProduct, grantHalftoneCredits, grantVectorCredits,
} = require("./lib/stripe");
const { recordCredit, historyFor } = require("./lib/ledger");
const { billingConfigured, verifySquareSignature, createSquareCheckout, applySquareEvent } = require("./lib/square");

const ROOT = __dirname;
loadEnvFile(ROOT);
if (!process.env.DIGITIZE_PYTHON) {
  try { process.env.DIGITIZE_PYTHON = pickPrepPython(); } catch (e) {}
}
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
    shops: [], users: [], sessions: [], jobs: [], events: [], contact_messages: [],
    settings: { trial_days: 7, shop_price_cents: 7900, studio_price_cents: 14900, halftone_single_cents: 300, halftone_pack10_cents: 2000, vector_single_cents: 300, vector_pack10_cents: 2000 },
  };
}
function defaultSettings() {
  return { trial_days: 7, shop_price_cents: 7900, studio_price_cents: 14900, halftone_single_cents: 300, halftone_pack10_cents: 2000, vector_single_cents: 300, vector_pack10_cents: 2000 };
}
function ensureSettings(db) {
  if (!db.settings) db.settings = defaultSettings();
  if (db.settings.trial_days == null) db.settings.trial_days = 7;
  if (db.settings.shop_price_cents == null) db.settings.shop_price_cents = 7900;
  if (db.settings.studio_price_cents == null) db.settings.studio_price_cents = 14900;
  if (db.settings.halftone_single_cents == null) db.settings.halftone_single_cents = 300;
  if (db.settings.halftone_pack10_cents == null) db.settings.halftone_pack10_cents = 2000;
  if (db.settings.vector_single_cents == null) db.settings.vector_single_cents = 300;
  if (db.settings.vector_pack10_cents == null) db.settings.vector_pack10_cents = 2000;
  return db.settings;
}
function ensureUserHalftoneCredits(db) {
  let dirty = false;
  (db.users || []).forEach(function (u) {
    if (u && u.halftone_credits == null) { u.halftone_credits = 0; dirty = true; }
    if (u && u.vector_credits == null) { u.vector_credits = 0; dirty = true; }
  });
  return dirty;
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
      plan: "studio", plan_expires: null, halftone_credits: 0, vector_credits: 0, created_at: now,
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


function canRunFloor(user) {
  return !!(user && (user.role === "shop" || (user.role === "admin" && user.shop_id)));
}

function isComped(user) { return !!(user && user.role === "admin"); }

function isPaidMember(user) {
  if (!user) return false;
  if (user.plan !== "shop" && user.plan !== "studio") return false;
  if (!user.plan_expires) return true;
  return Date.parse(user.plan_expires) > Date.now();
}

function isActiveTrial(user) {
  if (!user || user.plan !== "trial") return false;
  if (!user.plan_expires) return true;
  return Date.parse(user.plan_expires) > Date.now();
}

function canProduce(user) {
  if (!features.membershipEnabled()) return !!(user && (user.role === "admin" || user.role === "shop"));
  return isComped(user) || isPaidMember(user) || isActiveTrial(user);
}

function canProducePackets(user) {
  if (!features.membershipEnabled()) return isComped(user);
  return isComped(user) || isPaidMember(user);
}

function isStudioMember(user) {
  if (!user) return false;
  if (user.plan !== "studio") return false;
  if (!user.plan_expires) return true;
  return Date.parse(user.plan_expires) > Date.now();
}

/** Halftones Apply included for admin, and for active Studio membership when that flag is on. */
function halftoneIncluded(user) {
  if (isComped(user)) return true;
  if (features.membershipEnabled() && isStudioMember(user)) return true;
  return false;
}

/** Vectorize included for admin, and for anyone who canProduce when membership is on. */
function vectorIncluded(user) {
  if (isComped(user)) return true;
  if (features.membershipEnabled() && canProduce(user)) return true;
  return false;
}

function halftoneCreditBalance(user) {
  return Math.max(0, Math.floor(Number(user && user.halftone_credits) || 0));
}

function vectorCreditBalance(user) {
  return Math.max(0, Math.floor(Number(user && user.vector_credits) || 0));
}

/** One free image per account (Vectorize OR Halftones, one total). Admin never uses it.
 * Needs a verified email, and is refused if this device or IP already claimed a free image. */
const REQ_CTX = new WeakMap(); // user object -> { db, device, ipHash } for the current request
function hashId(v) { return crypto.createHash("sha256").update("dcp-free1:" + String(v)).digest("hex"); }
function freeImageStatus(user) {
  if (!user || isComped(user)) return { available: false, reason: "admin" };
  if (user.free_image_used) return { available: false, reason: "used" };
  if (!user.email_verified) return { available: false, reason: "unverified" };
  const ctx = REQ_CTX.get(user);
  if (ctx && ctx.db) {
    const hit = (ctx.db.free_claims || []).find(function (c) {
      return c.user_id !== user.id && ((ctx.device && c.device === ctx.device) || (ctx.ipHash && c.ip === ctx.ipHash));
    });
    if (hit) return { available: false, reason: "device" };
  }
  return { available: true, reason: null };
}
function freeImageAvailable(user) { return freeImageStatus(user).available; }
function recordFreeClaim(user, service) {
  user.free_image_used = true;
  user.free_image_service = service;
  user.free_image_at = new Date().toISOString();
  const ctx = REQ_CTX.get(user);
  if (ctx && ctx.db) {
    if (!ctx.db.free_claims) ctx.db.free_claims = [];
    ctx.db.free_claims.push({ user_id: user.id, device: ctx.device || null, ip: ctx.ipHash || null, at: user.free_image_at, service: service });
    recordCredit(ctx.db, { user_id: user.id, service: service, delta: 0, source: "free", reason: "Free image used" });
  }
}

function canApplyHalftone(user) {
  return !!(user && (halftoneIncluded(user) || halftoneCreditBalance(user) > 0 || freeImageAvailable(user)));
}

function dollarsLabel(cents) {
  const n = Math.round(Number(cents) || 0);
  if (n % 100 === 0) return "$" + (n / 100);
  return "$" + (n / 100).toFixed(2);
}

function buyOptions(service, settings) {
  const st = settings || {};
  const vector = service === "vectorize";
  const singleCents = vector
    ? (st.vector_single_cents != null ? st.vector_single_cents : 300)
    : (st.halftone_single_cents != null ? st.halftone_single_cents : 300);
  const packCents = vector
    ? (st.vector_pack10_cents != null ? st.vector_pack10_cents : 2000)
    : (st.halftone_pack10_cents != null ? st.halftone_pack10_cents : 2000);
  return {
    single: {
      product: vector ? "vector_single" : "halftone_single",
      cents: singleCents,
      credits: 1,
      label: dollarsLabel(singleCents) + " · 1 image",
    },
    pack10: {
      product: vector ? "vector_pack10" : "halftone_pack10",
      cents: packCents,
      credits: 10,
      label: dollarsLabel(packCents) + " · 10 images",
    },
  };
}

function halftoneBuyOptions(settings) {
  return buyOptions("halftones", settings);
}

function isMembershipProduct(product) {
  return product === "trial" || product === "shop" || product === "studio";
}

function productAmountCents(product, settings) {
  const st = settings || {};
  if (product === "vector_single") return st.vector_single_cents != null ? st.vector_single_cents : 300;
  if (product === "vector_pack10") return st.vector_pack10_cents != null ? st.vector_pack10_cents : 2000;
  if (product === "halftone_single") return st.halftone_single_cents != null ? st.halftone_single_cents : 300;
  if (product === "halftone_pack10") return st.halftone_pack10_cents != null ? st.halftone_pack10_cents : 2000;
  return null;
}

const VECTOR_CREDIT_MSG = "Vectorize needs 1 credit per image — $3 for 1 or $20 for 10.";
const HALFTONE_CREDIT_MSG = "Halftones Apply needs 1 credit per image — $3 for 1 or $20 for 10. Preview stays free.";

function canUseService(user, job, service) {
  if (!user) return false;
  if (service === "vectorize" && vectorIncluded(user)) return true;
  if (service === "halftones" && halftoneIncluded(user)) return true;
  if (job && job.unlocks && job.unlocks[service]) return true;
  const bal = service === "vectorize" ? vectorCreditBalance(user) : halftoneCreditBalance(user);
  return bal >= 1 || freeImageAvailable(user);
}

function consumeServiceCredit(user, job, service) {
  const included = service === "vectorize" ? vectorIncluded(user) : halftoneIncluded(user);
  if (included) return { ok: true, consumed: false, included: true };
  if (!job.unlocks || typeof job.unlocks !== "object") job.unlocks = {};
  if (job.unlocks[service]) return { ok: true, consumed: false, unlocked: true };
  const bal = service === "vectorize" ? vectorCreditBalance(user) : halftoneCreditBalance(user);
  if (bal < 1 && freeImageAvailable(user)) {
    recordFreeClaim(user, service);
    user.images_processed = (Number(user.images_processed) || 0) + 1;
    job.unlocks[service] = true;
    job.free_image = true;
    return { ok: true, consumed: false, free: true, remaining: bal };
  }
  if (bal < 1) return { ok: false };
  user.images_processed = (Number(user.images_processed) || 0) + 1;
  if (service === "vectorize") user.vector_credits = bal - 1;
  else user.halftone_credits = bal - 1;
  job.unlocks[service] = true;
  return { ok: true, consumed: true, remaining: bal - 1 };
}

function requireServiceCredit(user, job, service, res, settings) {
  if (canUseService(user, job, service)) return true;
  const vector = service === "vectorize";
  json(res, 402, {
    error: vector ? VECTOR_CREDIT_MSG : HALFTONE_CREDIT_MSG,
    code: vector ? "vector_credits_required" : "halftone_credits_required",
    service: service,
    freeImage: freeImageStatus(user),
    buy: buyOptions(service, settings),
    vectorCredits: vectorCreditBalance(user),
    halftoneCredits: halftoneCreditBalance(user),
  });
  return false;
}

function requireHalftoneApply(user, res, settings) {
  if (canApplyHalftone(user)) return true;
  json(res, 402, {
    error: HALFTONE_CREDIT_MSG,
    code: "halftone_credits_required",
    service: "halftones",
    buy: halftoneBuyOptions(settings),
    vectorCredits: vectorCreditBalance(user),
    halftoneCredits: halftoneCreditBalance(user),
    halftoneIncluded: false,
  });
  return false;
}

/** Decrement one credit when Apply succeeds and the user is not included. Kept for older call sites. */
function consumeHalftoneCredit(user) {
  if (halftoneIncluded(user)) return { ok: true, consumed: false, included: true, remaining: halftoneCreditBalance(user) };
  const bal = halftoneCreditBalance(user);
  if (bal < 1 && freeImageAvailable(user)) {
    recordFreeClaim(user, "halftones");
    user.images_processed = (Number(user.images_processed) || 0) + 1;
    return { ok: true, consumed: false, free: true, included: false, remaining: 0 };
  }
  if (bal < 1) return { ok: false, consumed: false, included: false, remaining: 0 };
  user.halftone_credits = bal - 1;
  return { ok: true, consumed: true, included: false, remaining: user.halftone_credits };
}

// Digitize is admin-only: visible/usable only when FEATURE_DIGITIZE is on AND
// the requesting user is an admin (same check as the admin backend). Everyone
// else sees exactly the flag-off site.
function digitizeFor(u) {
  return features.digitizeEnabled() && !!(u && u.role === "admin");
}

function digitizeOptsFromJob(job) {
  const s = job.digitizeSettings || {};
  return {
    widthIn: Number(s.widthIn || job.width_in) || 1,
    heightIn: Number(s.heightIn || job.height_in) || 1,
    fabric: s.fabric || "tee",
    density: s.density,
    satinSpacingMm: s.satinSpacingMm,
    simplify: !!s.simplify,
    prep: true,
    previewOnly: true,
    pes: true,
    engine: "wq",
  };
}

async function stitchFileForJob(job, name) {
  const opts = digitizeOptsFromJob(job);
  let dig = getDigitizeCache(job, opts);
  if (!dig) dig = await digitizeJobCached(job, UPLOADS, opts);
  if (name === "stitch-preview.svg") {
    return dig.previewSvg || "";
  }
  ensureStitchFiles(dig, String(job.title || job.id || "DESIGN").replace(/[^\w\- ]+/g, "").slice(0, 16) || "DESIGN");
  if (name === "design.dst") return dig.dst;
  if (name === "design.exp") return dig.exp;
  if (name === "design.pes") return dig.pes;
  return null;
}
function flagsFor(u) {
  const f = Object.assign({}, features.flags());
  if (digitizeFor(u)) { f.digitize = true; return f; }
  delete f.digitize;
  return f;
}

function methodsFor(user) {
  if (digitizeFor(user)) return METHODS;
  return METHODS.filter(function (m) { return m !== "embroidery"; });
}

function forbidDigitize(user, res) {
  if (digitizeFor(user)) return false;
  if (!user) { json(res, 401, { error: "Sign in required" }); return true; }
  json(res, 403, { error: "Forbidden" });
  return true;
}

function isStitchExportName(name) {
  const n = String(name || "").toLowerCase();
  if (n === "stitch-preview.svg") return true;
  return n.indexOf("dst") !== -1 || n.indexOf("exp") !== -1 || n.indexOf("pes") !== -1;
}

function rewriteEmbroideryMethod(value) {
  if (typeof value === "string") return value === "embroidery" ? "apparel" : value;
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(rewriteEmbroideryMethod);
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value).forEach(function (k) { out[k] = rewriteEmbroideryMethod(value[k]); });
    return out;
  }
  return value;
}

function scrubHidden(value) {
  if (typeof value === "string") {
    if (!/digitiz|embroider/i.test(value)) return value;
    return value.replace(/digitiz\w*/ig, "").replace(/embroider\w*/ig, "").replace(/\s{2,}/g, " ").trim();
  }
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(scrubHidden).filter(function (v) { return v !== ""; });
  if (value && typeof value === "object") {
    const out = {};
    Object.keys(value).forEach(function (k) {
      if (/digitiz|embroider/i.test(k)) return;
      out[k] = scrubHidden(value[k]);
    });
    return out;
  }
  return value;
}

function scrubCustomer(value) {
  return scrubHidden(rewriteEmbroideryMethod(value));
}

function serviceEntitlements(u) {
  const out = {
    vectorize: {
      included: vectorIncluded(u),
      credits: vectorCreditBalance(u),
      canBuy: true,
    },
    halftones: {
      included: halftoneIncluded(u),
      credits: halftoneCreditBalance(u),
      canPreview: true,
      canApply: canApplyHalftone(u),
    },
  };
  if (digitizeFor(u)) out.digitize = { entitled: canProduce(u) };
  return out;
}

function serviceCatalog(settings, user) {
  const mem = features.membershipEnabled();
  const vectorize = {
    name: "Vectorize",
    description: "Clean logos and AI-generated images → SVG/EPS",
    pricing: buyOptions("vectorize", settings),
    unit: "image",
    credits_expire: false,
  };
  const halftones = {
    name: "Halftones",
    description: "Real vector half-tones for DTF / screen / print",
    pricing: buyOptions("halftones", settings),
    unit: "image",
    credits_expire: false,
    preview: "free",
  };
  if (mem) {
    vectorize.included_with = ["trial", "shop", "studio", "admin"];
    halftones.included_with = ["studio", "admin"];
    halftones.apply = "studio_unlimited_or_credit";
  }
  if (!digitizeFor(user)) return { vectorize: vectorize, halftones: halftones };
  const digitize = {
    name: "Digitize",
    description: "Stitch preview · draft DST/EXP",
  };
  if (mem) digitize.included_with = ["trial", "shop", "studio", "admin"];
  return { vectorize: vectorize, digitize: digitize, halftones: halftones };
}

function enabledServiceNames(user) {
  const list = ["vectorize", "halftones"];
  if (digitizeFor(user)) list.splice(1, 0, "digitize");
  return list;
}

/** Studio tool calls need a signed-in account. Logged-out callers get 401; signed-in checks stay as they are. */
function studioToolApi(method, pth) {
  if (method === "POST" && pth === "/api/jobs") return true;
  if (method === "POST" && /^\/api\/jobs\/[^/]+\/artwork$/.test(pth)) return true;
  if (method === "POST" && /^\/api\/jobs\/[^/]+\/artops$/.test(pth)) return true;
  if (method === "POST" && /^\/api\/jobs\/[^/]+\/vectorize$/.test(pth)) return true;
  if (method === "POST" && /^\/api\/jobs\/[^/]+\/corel-import$/.test(pth)) return true;
  if (method === "POST" && /^\/api\/jobs\/[^/]+\/recolor$/.test(pth)) return true;
  if (method === "POST" && /^\/api\/jobs\/[^/]+\/halftone$/.test(pth)) return true;
  if (method === "POST" && /^\/api\/jobs\/[^/]+\/halftone\/preview$/.test(pth)) return true;
  if (method === "GET" && pth === "/api/halftone/styles") return true;
  if (method === "GET" && /^\/api\/export\/[^/]+(?:\/[^/]+)?$/.test(pth)) return true;
  if (/^\/api\/(?:guest|trial|anonymous)(?:\/|$)/.test(pth)) return true;
  return false;
}

function requireProduce(user, res) {
  if (canProduce(user)) return true;
  if (!features.membershipEnabled()) {
    json(res, 402, { error: "Sign in with a shop account to use the studio." });
    return false;
  }
  json(res, 402, { error: "Membership or active trial required. Start free for 7 days, or use Shop / Studio." });
  return false;
}

function requirePaidProduce(user, res) {
  if (canProducePackets(user)) return true;
  if (!features.membershipEnabled()) {
    json(res, 402, { error: "This export is not available right now." });
    return false;
  }
  if (isActiveTrial(user)) {
    json(res, 402, { error: "Stitch packets (DST/EXP) and stone maps need a Shop or Studio plan. Vectorize and SVG/EPS stay free on trial." });
    return false;
  }
  json(res, 402, { error: "Membership required to finish production. Admin is complimentary. Shop and Studio plans unlock proofs and packets." });
  return false;
}

function truthy(v) { return v === true || v === 1 || v === "1" || v === "true" || v === "on"; }

function applyUploadMatte(publicPath, fields) {
  if (!publicPath || !truthy(fields && (fields.remove_bg || fields.remove_background))) return publicPath;
  const abs = path.join(UPLOADS, path.basename(publicPath));
  if (!fs.existsSync(abs)) return publicPath;
  const buf = fs.readFileSync(abs);
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return publicPath;
  try {
    // Professional background removal: try AI rembg, fall back to flood (never silent no-op).
    const out = removeBackground(buf, { mode: "ai" });
    const name = Date.now() + "-" + uid() + ".png";
    fs.writeFileSync(path.join(UPLOADS, name), out);
    return "/uploads/" + name;
  } catch (e) { return publicPath; }
}

function saveImaginePng(buf) {
  const name = Date.now() + "-" + uid() + ".png";
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return "/uploads/" + name;
}

function applyCorelImportResult(job, result) {
  const svgName = Date.now() + "-" + uid() + "-corel.svg";
  fs.writeFileSync(path.join(UPLOADS, svgName), stripPaperUnderlaySvg(result.svg));
  job.vector_svg = "/uploads/" + svgName;
  delete job.vector_eps;
  job.vector = result.vec;
  return result;
}

function runCorelImportOnJob(job, buf, body) {
  body = body || {};
  const sizeIn = Number(body.sizeIn) || Number(job.width_in) || 10;
  const opts = {
    sizeIn: sizeIn,
    pad: body.pad != null ? Number(body.pad) : 40,
    paperUnderlay: body.paperUnderlay === true,
  };
  if (body.bbox && body.bbox.minx != null) opts.bbox = body.bbox;
  const result = corelImport.transfer(buf, opts);
  // Keep job plate size square when Corel-import remaps to square studio art
  job.width_in = sizeIn;
  job.height_in = sizeIn;
  applyCorelImportResult(job, result);
  return result;
}

function tryAutoCorelImport(job, filePath, originalName) {
  if (!job || !filePath) return false;
  const abs = path.join(UPLOADS, path.basename(filePath));
  if (!fs.existsSync(abs)) return false;
  const buf = fs.readFileSync(abs);
  if (!corelImport.looksLikeSvg(buf)) return false;
  const text = buf.toString("utf8");
  const nameHint = String(originalName || filePath || "").toLowerCase();
  if (!corelImport.isCorelSvg(text) && !/\.svg$/i.test(nameHint)) return false;
  if (!corelImport.isCorelSvg(text)) return false;
  runCorelImportOnJob(job, buf, {});
  return true;
}

function applyVectorResult(job, vec, svg) {
  if (!job || !vec) return;
  job.vector = vec;
  // Ensure engine lands on job.vector.meta for store + QA (vai-trace / invent / etc.).
  if (job.vector.meta && job.vector.meta.engine) {
    /* already set by tracer */
  } else if (job.vector.source) {
    job.vector.meta = Object.assign({}, job.vector.meta || {}, { engine: String(job.vector.source) });
  }
  if (job._pendingVzSettings) {
    job.vector.meta = Object.assign({}, job.vector.meta || {}, { settings: job._pendingVzSettings });
  }
  const name = Date.now() + "-" + uid() + "-vector.svg";
  fs.writeFileSync(path.join(UPLOADS, name), stripPaperUnderlaySvg(svg));
  job.vector_svg = "/uploads/" + name;
  delete job.vector_eps;
}

function stampVzSettings(job, body) {
  if (!job || !body || !body._vzSettings) return;
  job._pendingVzSettings = body._vzSettings;
  if (job.vector) {
    job.vector.meta = Object.assign({}, job.vector.meta || {}, { settings: body._vzSettings });
  }
}

function applyVtracerResult(job, result) {
  const svgName = Date.now() + "-" + uid() + "-vtracer.svg";
  fs.writeFileSync(path.join(UPLOADS, svgName), stripPaperUnderlaySvg(result.svg));
  job.vector_svg = "/uploads/" + svgName;
  if (result.eps && result.eps.length) {
    const epsName = Date.now() + "-" + uid() + "-vtracer.eps";
    fs.writeFileSync(path.join(UPLOADS, epsName), result.eps);
    job.vector_eps = "/uploads/" + epsName;
  } else {
    delete job.vector_eps;
  }
  job.vector = result.vec;
  if (job._pendingVzSettings && job.vector) {
    job.vector.meta = Object.assign({}, job.vector.meta || {}, { settings: job._pendingVzSettings });
  }
}

function runVtracerVectorize(job, buf, body) {
  if (!vtracer.available()) {
    const err = new Error("VTracer binary missing on host");
    err.code = "NO_VTRACER";
    throw err;
  }
  const norm = body && body._vzSettings ? body : normalizeVectorizeBody(body || {});
  const result = vtracer.vectorizeBuffer(buf, {
    widthIn: job.width_in,
    heightIn: job.height_in,
    colors: norm.colors,
    cornerThreshold: norm.cornerThreshold,
    filterSpeckle: norm.filterSpeckle,
    segmentLength: norm.segmentLength,
    timeoutMs: 120000,
  });
  applyVtracerResult(job, result);
  if (job.vector) {
    job.vector.meta = Object.assign({}, job.vector.meta || {}, {
      settings: norm._vzSettings,
      engine: (job.vector.meta && job.vector.meta.engine) || "vtracer",
    });
    if (!job.vector.source) job.vector.source = "vtracer";
  }
  return result;
}

function vectorizeInWorker(buf, widthIn, heightIn, opts, timeoutMs, engine) {
  return new Promise(function (resolve, reject) {
    const worker = new Worker(path.resolve(__dirname, "lib", "vectorize-worker.js"), {
      workerData: {
        bufB64: Buffer.from(buf).toString("base64"),
        widthIn: widthIn,
        heightIn: heightIn,
        opts: opts || {},
        engine: engine || "bezier",
      },
    });
    let done = false;
    const timer = setTimeout(function () {
      if (done) return;
      done = true;
      try { worker.terminate(); } catch (e) {}
      reject(new Error("Vectorize timed out"));
    }, timeoutMs || 90000);
    worker.on("message", function (msg) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch (e) {}
      if (msg && msg.ok) resolve(msg);
      else reject(new Error((msg && msg.error) || "Vectorize failed"));
    });
    worker.on("error", function (err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function normalizeVectorizeBody(body) {
  body = body || {};
  const DETAIL = {
    low: 4, simple: 4,
    medium: 8, balanced: 8,
    high: 12, fine: 12,
  };
  const SMOOTH = {
    low: { epsilon: 0.55, filterSpeckle: 2, segmentLength: 3.2 },
    medium: { epsilon: 0.95, filterSpeckle: 4, segmentLength: 4 },
    high: { epsilon: 1.4, filterSpeckle: 8, segmentLength: 5.5 },
  };
  const CORNER = {
    sharp: { fitError: 0.55, cornerCos: -0.55, cornerThreshold: 40 },
    balanced: { fitError: 1.1, cornerCos: -0.28, cornerThreshold: 60 },
    smooth: { fitError: 1.85, cornerCos: 0.15, cornerThreshold: 90 },
  };
  function clamp(n, lo, hi, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.max(lo, Math.min(hi, v));
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function isPctLike(v) {
    if (v == null || v === "") return false;
    const s = String(v).toLowerCase();
    if (DETAIL[s] || SMOOTH[s] || CORNER[s]) return false;
    return Number.isFinite(Number(v));
  }
  function pctFromColors(c) {
    return Math.round(clamp(((Number(c) - 3) / 21) * 100, 0, 100, 50));
  }

  let detailPct = null;
  const detailRaw = body.detail != null ? body.detail : body.detailLevel;
  if (isPctLike(detailRaw)) {
    detailPct = clamp(detailRaw, 0, 100, 50);
  } else {
    let detailKey = String(detailRaw || "").toLowerCase();
    if (!detailKey && body.colors != null) {
      const c = Number(body.colors);
      detailKey = c <= 5 ? "low" : (c >= 11 ? "high" : "medium");
    }
    if (!DETAIL[detailKey]) detailKey = "medium";
    detailPct = detailKey === "simple" || detailKey === "low" ? 15
      : (detailKey === "fine" || detailKey === "high" ? 85 : 50);
  }

  let colors;
  if (body.colors != null && Number.isFinite(Number(body.colors))) {
    colors = clamp(body.colors, 2, 24, 8);
    if (!isPctLike(detailRaw)) detailPct = pctFromColors(colors);
  } else {
    colors = clamp(Math.round(lerp(3, 24, detailPct / 100)), 2, 24, 8);
  }

  let smoothPct = null;
  const smoothRaw = body.smoothing != null ? body.smoothing : body.smooth;
  if (isPctLike(smoothRaw)) {
    smoothPct = clamp(smoothRaw, 0, 100, 50);
  } else {
    let smoothKey = String(smoothRaw || "").toLowerCase();
    if (!SMOOTH[smoothKey]) smoothKey = "medium";
    smoothPct = smoothKey === "low" ? 15 : (smoothKey === "high" ? 85 : 50);
  }
  const smoothT = smoothPct / 100;
  const smoothDefaults = {
    epsilon: lerp(0.4, 1.6, smoothT),
    filterSpeckle: Math.round(lerp(2, 10, smoothT)),
    segmentLength: lerp(3.0, 6.0, smoothT),
  };

  let cornerPct = null;
  const cornerRaw = body.cornerSmooth != null ? body.cornerSmooth : (body.corners != null ? body.corners : body.corner);
  if (isPctLike(cornerRaw)) {
    cornerPct = clamp(cornerRaw, 0, 100, 50);
  } else {
    let cornerKey = String(cornerRaw || "").toLowerCase();
    if (!CORNER[cornerKey]) cornerKey = "balanced";
    cornerPct = cornerKey === "sharp" ? 10 : (cornerKey === "smooth" ? 90 : 50);
  }
  const cornerT = cornerPct / 100;
  const cornerDefaults = {
    fitError: lerp(0.4, 2.0, cornerT),
    cornerCos: lerp(-0.55, 0.15, cornerT),
    cornerThreshold: Math.round(lerp(40, 90, cornerT)),
  };

  const epsilon = clamp(body.epsilon != null ? body.epsilon : smoothDefaults.epsilon, 0.2, 3, smoothDefaults.epsilon);
  const fitError = clamp(body.fitError != null ? body.fitError : cornerDefaults.fitError, 0.2, 4, cornerDefaults.fitError);
  const cornerCos = clamp(body.cornerCos != null ? body.cornerCos : cornerDefaults.cornerCos, -1, 1, cornerDefaults.cornerCos);
  const cornerThreshold = clamp(body.cornerThreshold != null ? body.cornerThreshold : cornerDefaults.cornerThreshold, 20, 120, cornerDefaults.cornerThreshold);
  const filterSpeckle = clamp(body.filterSpeckle != null ? body.filterSpeckle : smoothDefaults.filterSpeckle, 0, 16, smoothDefaults.filterSpeckle);
  const segmentLength = clamp(body.segmentLength != null ? body.segmentLength : smoothDefaults.segmentLength, 1, 12, smoothDefaults.segmentLength);

  const settings = {
    detail: Math.round(detailPct),
    smoothing: Math.round(smoothPct),
    cornerSmooth: Math.round(cornerPct),
    colors: colors,
    epsilon: epsilon,
    fitError: fitError,
    cornerCos: cornerCos,
  };

  return Object.assign({}, body, {
    colors: colors,
    epsilon: epsilon,
    fitError: fitError,
    cornerCos: cornerCos,
    cornerThreshold: cornerThreshold,
    filterSpeckle: filterSpeckle,
    segmentLength: segmentLength,
    detail: settings.detail,
    smoothing: settings.smoothing,
    cornerSmooth: settings.cornerSmooth,
    live: body.live === true || body.live === "true" || body.live === 1,
    _vzSettings: settings,
  });
}

function attachVzSettings(resultOrJob, body) {
  const settings = body && body._vzSettings;
  if (!settings) return;
  if (resultOrJob && resultOrJob.meta) {
    resultOrJob.meta = Object.assign({}, resultOrJob.meta, { settings: settings });
  }
  if (resultOrJob && resultOrJob.vec) {
    resultOrJob.vec.meta = Object.assign({}, resultOrJob.vec.meta || {}, { settings: settings });
  }
  if (resultOrJob && resultOrJob.vector) {
    resultOrJob.vector.meta = Object.assign({}, resultOrJob.vector.meta || {}, { settings: settings });
  }
}

/** vai-trace without blocking the event loop. Large jobs prefer worker; else async spawn. */
async function runVaiTraceSafe(buf, job, body, sizeMeta) {
  const timeoutMs = 180000;
  const norm = body && body._vzSettings ? body : normalizeVectorizeBody(body || {});
  const opts = attachTraceCache({
    colors: norm.colors,
    mode: (norm && norm.mode) || "auto",
    timeoutMs: timeoutMs,
    epsilon: norm.epsilon,
    fitError: norm.fitError,
    cornerCos: norm.cornerCos,
  }, job, norm);
  const info = vectorizeGuard.inspect(buf);
  const useWorker = !!(sizeMeta && sizeMeta.sizeGuard && sizeMeta.sizeGuard.downscaled) || info.needsDownscale || info.bytes > 6 * 1024 * 1024;
  let result;
  if (useWorker) {
    const msg = await vectorizeInWorker(buf, job.width_in, job.height_in, opts, timeoutMs + 5000, "vai-trace");
    result = { svg: msg.svg, vec: msg.vec, meta: msg.meta || (msg.vec && msg.vec.meta) || {} };
  } else {
    result = await vaiTrace.vectorizeBufferAsync(buf, {
      widthIn: job.width_in,
      heightIn: job.height_in,
      colors: opts.colors,
      mode: opts.mode,
      timeoutMs: timeoutMs,
      epsilon: opts.epsilon,
      fitError: opts.fitError,
      cornerCos: opts.cornerCos,
      cacheDir: opts.cacheDir,
      fromCache: opts.fromCache,
    });
  }
  if (sizeMeta && sizeMeta.sizeGuard) {
    result.meta = Object.assign({}, result.meta || {}, { sizeGuard: sizeMeta.sizeGuard });
    if (result.vec) {
      result.vec.meta = Object.assign({}, result.vec.meta || {}, { sizeGuard: sizeMeta.sizeGuard });
    }
  }
  attachVzSettings(result, norm);
  return result;
}

// Trace cache is keyed on the busy engine file too, so a new engine never serves old results.
const TRACE_ENGINE_VER = (function () {
  try { return require("crypto").createHash("md5").update(fs.readFileSync(path.join(__dirname, "lib", "vai-trace", "engine_r3.py"))).digest("hex").slice(0, 8); }
  catch (e) { return "noengine"; }
})() + (process.env.VECTORIZE_R2 === "1" ? (function () {
  // Round-2 route on: key the cache on the r2 file too, so r2 and r11 results never mix.
  try { return "-r2" + require("crypto").createHash("md5").update(fs.readFileSync(path.join(__dirname, "lib", "vai-trace", "vt1_cut_r2.py"))).digest("hex").slice(0, 8); }
  catch (e) { return "-r2none"; }
})() : "");
function traceCacheDir(job) {
  return path.join(DATA, "trace-cache", String(job && job.id || "none") + "-" + TRACE_ENGINE_VER);
}
function clearTraceCache(job) {
  if (!job || !job.id) return;
  try { fs.rmSync(traceCacheDir(job), { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
function attachTraceCache(opts, job, body) {
  const dir = traceCacheDir(job);
  const live = !!(body && (body.live === true || body.live === "true" || body.live === 1));
  const ready = fs.existsSync(path.join(dir, "manifest.json"));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  if (live && ready) opts.fromCache = dir;
  else opts.cacheDir = dir;
  return opts;
}

/* Trace cache is regenerable; keep it from filling the data volume (ENOSPC 2026-10-12). */
const TRACE_CACHE_MAX_AGE_MS = 6 * 3600 * 1000;
const TRACE_CACHE_MAX_BYTES = 150 * 1024 * 1024;
function dirBytes(d) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) n += dirBytes(f);
      else { try { n += fs.statSync(f).size; } catch (x) { /* ignore */ } }
    }
  } catch (x) { /* ignore */ }
  return n;
}
function pruneTraceCache() {
  const root = path.join(DATA, "trace-cache");
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }).filter(function (e) { return e.isDirectory(); }); } catch (e) { return; }
  const now = Date.now();
  const dirs = ents.map(function (e) {
    const d = path.join(root, e.name);
    let m = 0; try { m = fs.statSync(d).mtimeMs; } catch (x) { /* ignore */ }
    return { d: d, m: m, b: dirBytes(d) };
  }).sort(function (a, b) { return b.m - a.m; });
  let total = 0, removed = 0;
  for (const x of dirs) {
    if (now - x.m > TRACE_CACHE_MAX_AGE_MS || total + x.b > TRACE_CACHE_MAX_BYTES) {
      try { fs.rmSync(x.d, { recursive: true, force: true }); removed++; } catch (e) { /* ignore */ }
    } else total += x.b;
  }
  if (removed) console.log("trace-cache pruned", removed, "dirs; kept", Math.round(total / 1048576), "MB");
}
/* Crashed saves leave store.json.tmp.* behind (24MB each); remove at boot. */
try {
  fs.readdirSync(DATA).filter(function (n) { return /^store\.json\.tmp\./.test(n); }).forEach(function (n) {
    try { fs.unlinkSync(path.join(DATA, n)); console.log("removed stale", n); } catch (x) { /* ignore */ }
  });
} catch (e) { /* ignore */ }
try {
  const top = fs.readdirSync(DATA, { withFileTypes: true }).map(function (e) {
    const f = path.join(DATA, e.name);
    let b = 0; try { b = e.isDirectory() ? dirBytes(f) : fs.statSync(f).size; } catch (x) { /* ignore */ }
    return e.name + "=" + Math.round(b / 1048576) + "MB";
  });
  console.log("data-dir usage", DATA, top.join(" "));
  ["uploads", "exports"].forEach(function (n) {
    const d = path.join(DATA, n);
    try { console.log("data-dir", n, "entries", fs.readdirSync(d).length); } catch (x) { /* ignore */ }
  });
} catch (e) { console.error("data-dir usage failed", e.message); }
/* Uploads older than 14 days are deleted (David 2026-10-12); volume is 500 MB. */
const UPLOAD_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
function pruneOldUploads() {
  let ents; try { ents = fs.readdirSync(UPLOADS, { withFileTypes: true }); } catch (e) { return; }
  const now = Date.now(); let n = 0, freed = 0;
  for (const e of ents) {
    const f = path.join(UPLOADS, e.name);
    try {
      const st = fs.statSync(f);
      if (now - st.mtimeMs <= UPLOAD_MAX_AGE_MS) continue;
      const b = e.isDirectory() ? dirBytes(f) : st.size;
      fs.rmSync(f, { recursive: true, force: true }); n++; freed += b;
    } catch (x) { /* ignore */ }
  }
  console.log("uploads pruned", n, "older than 14d; freed", Math.round(freed / 1048576), "MB");
}
try { pruneOldUploads(); } catch (e) { console.error("upload prune failed", e.message); }
setInterval(function () { try { pruneOldUploads(); } catch (e) { /* ignore */ } }, 6 * 3600 * 1000).unref();
try { pruneTraceCache(); } catch (e) { console.error("trace-cache prune failed", e); }
setInterval(function () { try { pruneTraceCache(); } catch (e) { /* ignore */ } }, 15 * 60 * 1000).unref();

function scheduleVectorize(jobId) {
  /* Upload stays snappy: do NOT auto-vectorize. User clicks Vectorize. */
  return;
}

function clearJobVector(job) {
  if (!job) return;
  delete job.vector;
  delete job.vector_svg;
  delete job.vector_eps;
}

function jobHasUsableVector(job) {
  if (!job) return false;
  if (job.vector_svg) return true;
  return !!(job.vector && Array.isArray(job.vector.layers) && job.vector.layers.length);
}

function invertHexColor(hex) {
  const rgb = colorspec.parseHex(hex);
  if (!rgb) return hex;
  return colorspec.rgbToHex(255 - rgb[0], 255 - rgb[1], 255 - rgb[2]);
}

function invertPaintColorToken(color) {
  const c = String(color || "").trim();
  if (/^#([0-9a-fA-F]{6})$/.test(c)) return invertHexColor(c);
  if (/^#([0-9a-fA-F]{3})$/.test(c)) {
    const h = c.slice(1);
    return invertHexColor("#" + h[0] + h[0] + h[1] + h[1] + h[2] + h[2]);
  }
  const rgb = c.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgb) return "rgb(" + (255 - Number(rgb[1])) + "," + (255 - Number(rgb[2])) + "," + (255 - Number(rgb[3])) + ")";
  return c;
}

function invertSvgMarkup(svg) {
  return String(svg || "").replace(
    /((?:fill|stroke|stop-color|flood-color|lighting-color|color)\s*[:=]\s*["']?)(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})|rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\))/gi,
    function (m, prefix, color) {
      return prefix + invertPaintColorToken(color);
    }
  );
}

function invertJobVector(job) {
  if (!job) return;
  if (job.vector_svg) {
    const abs = path.join(UPLOADS, path.basename(job.vector_svg));
    if (fs.existsSync(abs)) {
      const svg = stripPaperUnderlaySvg(invertSvgMarkup(fs.readFileSync(abs, "utf8")));
      const name = Date.now() + "-" + uid() + "-vector.svg";
      fs.writeFileSync(path.join(UPLOADS, name), svg);
      job.vector_svg = "/uploads/" + name;
      delete job.vector_eps;
    }
  }
  if (job.vector && Array.isArray(job.vector.layers)) {
    job.vector.layers = job.vector.layers.map(function (L) {
      return colorspec.annotateLayer(Object.assign({}, L, { hex: invertHexColor(L.hex || "#000000") }));
    });
    if (!job.vector_svg && vectorHasRealPaths(job.vector)) {
      rewriteVectorSvg(job);
    }
  }
}

function rewriteVectorSvg(job) {
  if (!job || !job.vector || !job.vector.layers) return;
  // Prefer keeping on-disk vector_svg when layers lack real path `d` (vai-trace / invent-warp).
  // Never rebuild via svgFromLayers([]) ΓÇö that emits empty d="" and nukes geometry.
  if (job.vector_svg && !vectorHasRealPaths(job.vector)) {
    const abs = path.join(UPLOADS, path.basename(job.vector_svg));
    if (fs.existsSync(abs)) {
      const svg = stripPaperUnderlaySvg(fs.readFileSync(abs, "utf8"));
      const name = Date.now() + "-" + uid() + "-vector.svg";
      fs.writeFileSync(path.join(UPLOADS, name), svg);
      job.vector_svg = "/uploads/" + name;
      return;
    }
  }
  if (vectorHasRealPaths(job.vector)) {
    const svg = stripPaperUnderlaySvg(svgFromLayers(job.vector.layers, job.vector.widthIn || job.width_in, job.vector.heightIn || job.height_in));
    const name = Date.now() + "-" + uid() + "-vector.svg";
    fs.writeFileSync(path.join(UPLOADS, name), svg);
    job.vector_svg = "/uploads/" + name;
    delete job.vector_eps;
    return;
  }
  // File missing and no path data ΓÇö last resort (may be empty)
  const svg = stripPaperUnderlaySvg(svgFromLayers(job.vector.layers, job.vector.widthIn || job.width_in, job.vector.heightIn || job.height_in));
  const name = Date.now() + "-" + uid() + "-vector.svg";
  fs.writeFileSync(path.join(UPLOADS, name), svg);
  job.vector_svg = "/uploads/" + name;
  delete job.vector_eps;
}

/** Admin credit change (add | set | credits) with a ledger row. Negative add removes. */
function adminSetCredits(db, admin, u, service, field, body) {
  const before = Math.max(0, Math.floor(Number(u[field]) || 0));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return { error: "Reason is required" };
  const isInt = function (v) { return (typeof v === "number" || (typeof v === "string" && /^-?\d+$/.test(v.trim()))) && Number.isInteger(Number(v)); };
  let after;
  if (body.add != null) {
    if (!isInt(body.add)) return { error: "add must be an integer" };
    const n = Number(body.add);
    if (n < -10000 || n > 10000) return { error: "add must be between -10000 and 10000" };
    if (before + n < 0) return { error: "Cannot remove more than the current balance (" + before + ")" };
    after = before + n;
  } else if (body.set != null || body.credits != null) {
    const v = body.set != null ? body.set : body.credits;
    if (!isInt(v)) return { error: "set must be an integer" };
    after = Number(v);
    if (after < 0 || after > 100000) return { error: "set must be between 0 and 100000" };
  } else return { error: "Pass add, set, or credits" };
  return { apply: function () {
    u[field] = after;
    return after === before ? null : recordCredit(db, { user_id: u.id, service: service, delta: after - before, balance: after, source: "admin", admin_id: admin.id, reason: reason });
  } };
}
function requireAdmin(user, res) {
  if (!user || user.role !== "admin") {
    json(res, 403, { error: "Admin required" });
    return false;
  }
  return true;
}

function seedDemoArt() {
  const pth = path.join(UPLOADS, "demo-badge.png");
  if (!fs.existsSync(pth)) fs.writeFileSync(pth, generateBadgePng());
  return "/uploads/demo-badge.png";
}
/** Drop expired session rows (cheap; store stays small). */
function pruneExpiredSessions(db) {
  if (!db || !Array.isArray(db.sessions)) return 0;
  const now = Date.now();
  const before = db.sessions.length;
  db.sessions = db.sessions.filter(function (s) {
    if (!s || !s.expires) return true;
    const t = Date.parse(s.expires);
    return !(t && now > t);
  });
  return before - db.sessions.length;
}
function save(db) {
  pruneExpiredSessions(db);
  const tmp = DB_PATH + ".tmp." + process.pid + "." + Date.now();
  // Compact JSON (no pretty indent) — smaller/faster writes; parse-compatible with prior stores.
  try {
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (x) { /* ignore */ }
    throw e;
  }
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
  if (ensureUserHalftoneCredits(db)) dirty = true;
  if (ensureAdmin(db)) dirty = true;
  if (ensureContactMessages(db)) dirty = true;
  if (pruneExpiredSessions(db)) dirty = true;
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
  db.users.push({ id: uid(), email: "owner@anvil.local", name: "Shop Owner", password_hash: hashPass("anvil123"), role: "shop", shop_id: shopId, plan: "studio", plan_expires: null, halftone_credits: 0, vector_credits: 0, created_at: now });
  db.users.push({ id: uid(), email: "client@anvil.local", name: "Jordan Client", password_hash: hashPass("anvil123"), role: "client", shop_id: shopId, plan: "client", plan_expires: null, halftone_credits: 0, vector_credits: 0, created_at: now });
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


const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf", ".dxf": "application/dxf", ".tiff": "image/tiff", ".json": "application/json", ".plt": "application/vnd.hp-hpgl", ".txt": "text/plain; charset=utf-8", ".eps": "application/postscript", ".dst": "application/octet-stream", ".exp": "application/octet-stream", ".pes": "application/octet-stream", ".csv": "text/csv; charset=utf-8" };
function send(res, code, body, headers) {
  headers = headers || {};
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  res.writeHead(code, Object.assign({ "Content-Length": payload.length }, headers));
  res.end(payload);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" }); }
// per-user responses (config/services/me): never cached or shared between users
function jsonPrivate(res, code, obj) { send(res, code, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "Vary": "Cookie" }); }
const SAFE_CLIENT_MSGS = [
  "File too large",
  "Artwork required",
  "Drop artwork first",
  "Sign in required",
  "Shop login required",
  "Invalid email or password",
  "Account disabled",
  "Too many sign-in tries. Wait a few minutes.",
  "Could not vectorize",
  "Vectorize timed out",
  "Upload timed out",
  "Network stalled",
  "Membership or active trial required. Start free for 7 days, or use Shop / Studio.",
  "Stitch packets (DST/EXP) and stone maps need a Shop or Studio plan. Vectorize and SVG/EPS stay free on trial.",
  "Membership required to finish production. Admin is complimentary. Shop and Studio plans unlock proofs and packets.",
  "Sign in with a shop account to use the studio.",
  "This export is not available right now.",
  "Vectorize needs 1 credit per image — $3 for 1 or $20 for 10.",
  "Halftones Apply needs 1 credit per image — $3 for 1 or $20 for 10. Preview stays free.",
  "Memberships are not offered. Buy image credits instead.",
];
function clientError(err) {
  const msg = (err && err.message) ? String(err.message) : "";
  if (!IS_PROD) return msg || "Server error";
  if (!msg) return "Server error";
  const lower = msg.toLowerCase();
  for (let i = 0; i < SAFE_CLIENT_MSGS.length; i++) {
    if (msg === SAFE_CLIENT_MSGS[i] || lower.indexOf(SAFE_CLIENT_MSGS[i].toLowerCase()) !== -1) return SAFE_CLIENT_MSGS[i];
  }
  if (lower.indexOf("timeout") !== -1 || lower.indexOf("timed out") !== -1) return "That took too long. Try again with a smaller PNG.";
  if (lower.indexOf("too large") !== -1 || lower.indexOf("file too large") !== -1) return "File too large. Export a smaller PNG (max ~18MB) and try again.";
  if (lower.indexOf("artwork") !== -1 && lower.indexOf("required") !== -1) return "Artwork required";
  return "Server error";
}
function clientFacingError(err, fallback) {
  const safe = clientError(err);
  if (safe && safe !== "Server error") return safe;
  return fallback || safe;
}

/** Simple in-memory login brute-force guard (per IP). */
const loginFailByIp = Object.create(null);
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAIL_MAX = 8;
function clientIp(req) {
  // Behind Railway's edge the proxy APPENDS the real client address, so the rightmost
  // X-Forwarded-For entry is the one we can trust; leftmost entries are client-supplied.
  // TRUST_PROXY=0 ignores the header (direct exposure). Default: trust one hop.
  if (process.env.TRUST_PROXY !== "0") {
    const list = String((req.headers && req.headers["x-forwarded-for"]) || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    if (list.length) return list[list.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}
function loginFailRecord(ip) {
  const now = Date.now();
  let rec = loginFailByIp[ip];
  if (!rec || now - rec.start > LOGIN_FAIL_WINDOW_MS) {
    rec = { start: now, count: 0 };
    loginFailByIp[ip] = rec;
  }
  rec.count += 1;
  return rec;
}
function loginFailClear(ip) {
  delete loginFailByIp[ip];
}
function ensureContactMessages(db) {
  if (!db || Array.isArray(db.contact_messages)) return false;
  db.contact_messages = [];
  return true;
}
const contactHitByIp = Object.create(null);
const CONTACT_WINDOW_MS = 60 * 60 * 1000;
const CONTACT_MAX = 3;
const CONTACT_THANKS = "Thanks — we got your message and will reply by email soon.";
function contactRateLimited(ip) {
  const now = Date.now();
  let rec = contactHitByIp[ip];
  if (!rec || now - rec.start > CONTACT_WINDOW_MS) {
    rec = { start: now, count: 0 };
    contactHitByIp[ip] = rec;
  }
  if (rec.count >= CONTACT_MAX) return true;
  rec.count += 1;
  return false;
}
function validContactEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}
function loginFailBlocked(ip) {
  const rec = loginFailByIp[ip];
  if (!rec) return false;
  if (Date.now() - rec.start > LOGIN_FAIL_WINDOW_MS) {
    delete loginFailByIp[ip];
    return false;
  }
  return rec.count >= LOGIN_FAIL_MAX;
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
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const sess = db.sessions.find(function (s) { return s.token === token; });
  if (!sess) return null;
  if (sess.expires && Date.now() > Date.parse(sess.expires)) return null;
  return db.users.find(function (u) { return u.id === sess.user_id; }) || null;
}
function publicUser(u) {
  if (!u) return null;
  const mem = features.membershipEnabled();
  return {
    id: u.id, email: u.email, name: u.name, role: u.role, shopId: u.shop_id,
    plan: mem ? u.plan : null,
    planExpires: mem ? u.plan_expires : null,
    entitled: canProduce(u),
    halftoneCredits: halftoneCreditBalance(u),
    halftoneIncluded: halftoneIncluded(u),
    vectorCredits: vectorCreditBalance(u),
    vectorIncluded: vectorIncluded(u),
    freeImageAvailable: freeImageAvailable(u),
    freeImageReason: freeImageStatus(u).reason,
    emailVerified: !!u.email_verified,
    emailSending: mailer.configured(),
    services: serviceEntitlements(u),
  };
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
function appendCookie(res, c) {
  const prev = res.getHeader("Set-Cookie");
  const list = prev == null ? [] : (Array.isArray(prev) ? prev : [String(prev)]);
  // Session cookie first, so simple clients that read the first Set-Cookie still get it.
  if (c.indexOf(COOKIE + "=") === 0) list.unshift(c); else list.push(c);
  res.setHeader("Set-Cookie", list);
}
function setSession(res, token, req, remember) { appendCookie(res, COOKIE + "=" + token + "; " + cookieFlags(req, remember)); }
const DEVICE_COOKIE = "dcdev";
function ensureDevice(req, res) {
  let d = parseCookies(req)[DEVICE_COOKIE];
  if (!d || !/^[a-f0-9]{32}$/.test(d)) {
    d = uid();
    appendCookie(res, DEVICE_COOKIE + "=" + d + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=63072000" + (isHttpsReq(req) ? "; Secure" : ""));
  }
  return d;
}
function sessionRecord(userId, remember) {
  const now = Date.now();
  return { token: uid(), user_id: userId, created_at: new Date(now).toISOString(), remember: !!remember, expires: new Date(now + (remember ? 15552000 : 12 * 3600) * 1000).toISOString() };
}
function clearSession(res, req) { appendCookie(res, COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + (isHttpsReq(req) ? "; Secure" : "")); }
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

function presentEvents(events, user) {
  return (events || []).map(function (e) {
    let message = sanitizePublicEventMessage(e.message);
    if (!digitizeFor(user)) message = scrubHidden(message);
    return Object.assign({}, e, { message: message });
  });
}

function presentVzMeta(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const m = Object.assign({}, meta);
  if (m.settings) m.settings = Object.assign({}, m.settings);
  // Keep engine so live QA can prove vai-trace vs silent vtracer fallback.
  // Still hide recipe/pipeline internals from client-facing payloads.
  delete m.recipe;
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
function jobHasVectorArt(job) {
  return !!(job && (job.vector_svg || (job.vector && job.vector.layers && job.vector.layers.length)));
}
/** Clean vector file (no preview watermark, raw SVG URL allowed).
 * Admin is always entitled. free_image jobs are previews even if unlocks.vectorize is set.
 * Paid credit unlocks and included memberships count as entitled. */
/** Any file from /api/export/<job>/... (svg, eps, pdf, dxf, tiff, 300dpi png, underbase, packet, cut files).
 * Downloadable only when the job was paid for (credit consumed or verified free image claimed on
 * this job), the user has an included plan, or the user is admin. Halftone art needs a halftones unlock. */
function isHalftoneArt(job) {
  return !!(job && job.vector && job.vector.source === "vector-halftone");
}
function exportEntitled(user, job) {
  if (user && user.role === "admin") return true;
  if (!user || !job) return false;
  const unlocks = job.unlocks || {};
  if (isHalftoneArt(job)) return halftoneIncluded(user) || !!unlocks.halftones;
  return vectorIncluded(user) || halftoneIncluded(user) || !!(unlocks.vectorize || unlocks.halftones);
}
function requireExportEntitled(user, job, res, settings) {
  if (exportEntitled(user, job)) return true;
  const service = isHalftoneArt(job) ? "halftones" : "vectorize";
  const vector = service === "vectorize";
  json(res, 402, {
    error: vector ? VECTOR_CREDIT_MSG : HALFTONE_CREDIT_MSG,
    code: vector ? "vector_credits_required" : "halftone_credits_required",
    service: service,
    freeImage: freeImageStatus(user),
    buy: buyOptions(service, settings),
    vectorCredits: vectorCreditBalance(user),
    halftoneCredits: halftoneCreditBalance(user),
  });
  return false;
}
function previewArtEntitled(user, job) {
  if (user && user.role === "admin") return true;
  if (!user || !job) return false;
  if (job.free_image) return false;
  if (vectorIncluded(user) || halftoneIncluded(user)) return true;
  const unlocks = job.unlocks || {};
  return !!(unlocks.vectorize || unlocks.halftones);
}
/** Clean halftone SVG (preview response or saved file). Admin is exempt.
 * free_image jobs stay watermarked previews even when unlocks.halftones is set,
 * same rule as vector preview. A vectorize unlock does not entitle halftones. */
function previewHalftoneEntitled(user, job) {
  if (user && user.role === "admin") return true;
  if (!user || !job) return false;
  if (job.free_image) return false;
  if (halftoneIncluded(user)) return true;
  const unlocks = job.unlocks || {};
  return !!unlocks.halftones;
}
function previewActorKey(user, req) {
  if (user && user.id) return "u:" + user.id;
  return "ip:" + clientIp(req);
}
function sendPreviewLimited(res, retryAfter) {
  const secs = Math.max(1, Math.ceil(Number(retryAfter) || 1));
  return send(res, 429, JSON.stringify({ error: "Too many preview requests" }), {
    "Content-Type": "application/json; charset=utf-8",
    "Retry-After": String(secs),
    "Cache-Control": "private, no-store",
  });
}
function sendPreviewFailure(res, err) {
  if (err && err.status === 429) return sendPreviewLimited(res, err.retryAfter);
  if (err && err.status === 503) {
    return send(res, 503, JSON.stringify({ error: "Preview busy" }), {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": "2",
      "Cache-Control": "private, no-store",
    });
  }
  console.error("preview render", err && err.message);
  return json(res, 500, { error: "Preview render failed" });
}
function clientVector(job, req) {
  const v = presentVector(job && job.vector);
  if (!v) return v;
  if (!previewArtEntitled(req && req._dcUser, job)) {
    const c = Object.assign({}, v);
    delete c.svg;
    return c;
  }
  return v;
}
/** Create a 24h verification token and email the link (fire-and-forget). Returns true if a send was attempted. */
function issueVerification(u, req) {
  if (!mailer.configured()) return false;
  const token = crypto.randomBytes(32).toString("hex");
  u.verify_token_hash = hashId("v:" + token);
  u.verify_expires = new Date(Date.now() + 864e5).toISOString();
  u.verify_sends = (u.verify_sends || []).filter(function (t) { return Date.now() - Date.parse(t) < 864e5; }).concat([new Date().toISOString()]);
  const link = (process.env.PUBLIC_URL || originOf(req)) + "/api/verify?t=" + token;
  mailer.sendMail({
    to: u.email,
    subject: "Confirm your DecoClub Pro email",
    text: "Hi " + (u.name || "") + ",\n\nConfirm your email to unlock your free first image on DecoClub Pro:\n\n" + link + "\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.\n\nDecoClub Pro",
  }).catch(function (err) { console.error("verify email failed:", err.message); });
  return true;
}
function presentJob(job, req) {
  const copy = Object.assign({}, job);
  copy.proof_url = originOf(req) + "/proof.html?t=" + job.proof_token;
  copy.intake_url = originOf(req) + "/intake.html?t=" + job.proof_token;
  const unlocks = job.unlocks || {};
  copy.unlocks = { vectorize: !!unlocks.vectorize, halftones: !!unlocks.halftones };
  // Free-image jobs get an on-screen watermark in the studio; downloads stay clean.
  copy.free_image = !!job.free_image;
  // Keep settings + engine (QA); strip recipe/pipeline via presentVzMeta.
  if (copy.vector) copy.vector = presentVector(copy.vector);
  const showSvg = previewArtEntitled(req && req._dcUser, job);
  copy.has_vector = jobHasVectorArt(job);
  if (job.vector_svg) copy.vector_preview = "/api/jobs/" + job.id + "/preview.png";
  // Unpaid / free-image jobs must not carry a fetchable SVG (or the inline markup).
  if (!showSvg) {
    delete copy.vector_svg;
    delete copy.vector_eps;
    if (copy.vector && typeof copy.vector === "object") {
      copy.vector = Object.assign({}, copy.vector);
      delete copy.vector.svg;
    }
    if (copy.halftone && typeof copy.halftone === "object") {
      copy.halftone = Object.assign({}, copy.halftone);
      delete copy.halftone.svg;
    }
  }
  if (!digitizeFor(currentUser(req, load()))) return scrubCustomer(copy);
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
// DXF / PDF / TIFF / 300-DPI PNG (+ DTF white underbase) from the production SVG.
function printExport(svgAbs, fmt, o) {
  const { execFile } = require("child_process");
  const os = require("os");
  const svgText = stripPaperUnderlaySvg(fs.readFileSync(svgAbs, "utf8"));
  const tmpIn = path.join(os.tmpdir(), "plx-" + uid() + ".svg");
  const tmpOut = tmpIn.replace(/\.svg$/, "." + fmt);
  fs.writeFileSync(tmpIn, svgText);
  const py = process.env.INVENT_WARP_PYTHON && fs.existsSync(process.env.INVENT_WARP_PYTHON) ? process.env.INVENT_WARP_PYTHON : "python3";
  const args = [path.join(__dirname, "lib", "print_export.py"), fmt, tmpIn, tmpOut, "--width-in", String(Number(o.widthIn) || 10), "--dpi", "300"];
  if (Number(o.heightIn)) args.push("--height-in", String(Number(o.heightIn)));
  if (o.underbase) args.push("--underbase", "--choke", "2");
  return new Promise(function (resolve, reject) {
    execFile(py, args, { timeout: 120000, maxBuffer: 1 << 20 }, function (err, _so, se) {
      try {
        if (err) return reject(new Error(String(se || err.message)));
        resolve(fs.readFileSync(tmpOut));
      } finally {
        try { fs.unlinkSync(tmpIn); } catch (e) {}
        try { fs.unlinkSync(tmpOut); } catch (e) {}
      }
    });
  });
}
function download(res, filename, body, type) {
  send(res, 200, body, { "Content-Type": type, "Content-Disposition": 'attachment; filename="' + filename + '"' });
}


async function handleApi(req, res, url) {
  const db = load();
  const user = currentUser(req, db);
  req._dcUser = user || null;
  const method = req.method;
  const pth = url.pathname;
  // Device cookie is issued on GETs (app boot calls /api/me and /api/config) so it exists before any free claim.
  const deviceId = method === "GET" ? ensureDevice(req, res) : (parseCookies(req)[DEVICE_COOKIE] || null);
  if (user) REQ_CTX.set(user, { db: db, device: deviceId ? hashId("d:" + deviceId) : null, ipHash: hashId("ip:" + clientIp(req)) });

  if (/digitiz|embroider/i.test(pth)) {
    if (forbidDigitize(user, res)) return;
  }

  if (!user && studioToolApi(method, pth)) {
    return json(res, 401, { error: "Sign in required" });
  }

  if (pth === "/api/config" && method === "GET") {
    const st = ensureSettings(db);
    const services = { vectorize: true, halftones: true };
    if (digitizeFor(user)) services.digitize = true;
    const body = { demo: allowDemo(), billing: billingConfigured(), imagine: imagineConfigured(), imagineModel: "latest", vectorizerAi: vectorizerAi.configured(), vtracer: vtracer.available(), vaiTrace: vaiTrace.available(), inventVectorize: true, inventWinner: null, rasterCorel: true, inventWarp: inventWarp.available(), inventWarpReason: inventWarp.available() ? null : (inventWarp.unavailableReason && inventWarp.unavailableReason()), corelImport: true, name: "DecoClub Pro", statuses: STATUSES, methods: methodsFor(user), blanks: BLANKS, seed: allowDemo() ? { owner: "owner@anvil.local", client: "client@anvil.local", password: "anvil123" } : null, services: services, features: flagsFor(user), pricing: { vectorize: buyOptions("vectorize", st), halftones: buyOptions("halftones", st) }, halftonePricing: halftoneBuyOptions(st) };
    if (digitizeFor(user)) body.adminModules = ["/digitize-preview.js", "/digitize-admin.js"];
    return jsonPrivate(res, 200, body);
  }
  if (pth === "/api/contact" && method === "POST") {
    let body = {};
    try { body = parseJsonBody(await readBody(req)); }
    catch (e) { return json(res, 400, { error: "Could not read that message." }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
    if (String(body.website || "").trim()) return json(res, 200, { ok: true, message: CONTACT_THANKS });
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const subject = String(body.subject || "").trim();
    const message = String(body.message || "").trim();
    if (!name || !email || !subject || !message) return json(res, 400, { error: "Name, email, subject, and message are required." });
    if (name.length > 200) return json(res, 400, { error: "Name must be 200 characters or fewer." });
    if (subject.length > 200) return json(res, 400, { error: "Subject must be 200 characters or fewer." });
    if (!validContactEmail(email)) return json(res, 400, { error: "Enter a valid email address." });
    if (message.length > 5000) return json(res, 400, { error: "Message must be 5000 characters or fewer." });
    const ip = clientIp(req);
    if (contactRateLimited(ip)) return json(res, 429, { error: "Too many messages from this network. Please try again in about an hour." });
    ensureContactMessages(db);
    let emailed = false;
    if (mailer.configured()) {
      try {
        await mailer.sendMail({
          to: "decoclubpro.noreply@gmail.com",
          replyTo: email,
          subject: "[DecoClub contact] " + subject,
          text: "Name: " + name + "\nEmail: " + email + "\n\n" + message,
        });
        emailed = true;
      } catch (err) {
        console.error("contact email failed:", err && err.message);
      }
    }
    db.contact_messages.push({
      id: uid(),
      name: name,
      email: email,
      subject: subject,
      message: message,
      ip: ip,
      created_at: new Date().toISOString(),
      emailed: emailed,
    });
    save(db);
    return json(res, 200, { ok: true, message: CONTACT_THANKS });
  }
  if (pth === "/api/services" && method === "GET") {
    const st = ensureSettings(db);
    return jsonPrivate(res, 200, {
      billing_configured: billingConfigured(),
      services: serviceCatalog(st, user),
    });
  }
  if (pth === "/api/quote" && (method === "POST" || method === "GET")) {
    const body = method === "GET" ? { method: url.searchParams.get("method"), width_in: url.searchParams.get("width_in"), height_in: url.searchParams.get("height_in"), qty: url.searchParams.get("qty"), margin_pct: url.searchParams.get("margin_pct") } : parseJsonBody(await readBody(req));
    const quote = priceQuote(body);
    return json(res, 200, { quote: digitizeFor(user) ? quote : scrubCustomer(quote) });
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
    return jsonPrivate(res, 200, { user: publicUser(user) });
  }
  if (pth === "/api/catalog" && method === "GET") {
    const q = url.searchParams.get("q");
    let skus = searchCatalog(q);
    if (!digitizeFor(user)) skus = skus.map(scrubCustomer);
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
    const pwErr = passwordProblem(body.password);
    if (pwErr) return json(res, 400, { error: pwErr });
    const email = String(body.email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: "Enter a valid email" });
    if (isDisposableEmail(email)) return json(res, 400, { error: "Please use a permanent email address (disposable inboxes aren't accepted)", code: "disposable_email" });
    if (db.users.some(function (u) { return u.email === email; })) return json(res, 409, { error: "Email already registered" });
    const now = new Date().toISOString();
    const role = body.role === "client" ? "client" : "shop";
    let shop_id = null;
    if (role === "shop") {
      shop_id = uid();
      db.shops.push({ id: shop_id, name: body.shopName || (body.name + "'s Shop"), logo_path: null, brand_color: "#017ece", margin_pct: 20, created_at: now });
    }
    const trialDays = Number((db.settings && db.settings.trial_days) || 7);
    const u = { id: uid(), email: email, name: body.name, password_hash: hashPass(body.password), role: role, shop_id: shop_id, plan: role === "shop" ? "trial" : "client", plan_expires: role === "shop" ? new Date(Date.now() + trialDays * 864e5).toISOString() : null, halftone_credits: 0, vector_credits: 0, created_at: now };
    u.email_verified = false;
    db.users.push(u);
    const verifySent = issueVerification(u, req);
    const remember = body.remember_me == null ? true : truthy(body.remember_me);
    const sess = sessionRecord(u.id, remember);
    db.sessions.push(sess);
    save(db); setSession(res, sess.token, req, remember);
    return json(res, 200, { user: publicUser(u), verification: { sent: verifySent, emailSending: mailer.configured() } });
  }
  if (pth === "/api/verify" && method === "GET") {
    const t = String(url.searchParams.get("t") || "");
    const th = t ? hashId("v:" + t) : "";
    const u = th && db.users.find(function (x) { return x.verify_token_hash === th; });
    if (!u || !u.verify_expires || Date.now() > Date.parse(u.verify_expires)) {
      res.writeHead(302, { Location: "/login.html?verify=expired" }); return res.end();
    }
    u.email_verified = true; u.email_verified_at = new Date().toISOString();
    u.verify_token_hash = null; u.verify_expires = null;
    save(db);
    res.writeHead(302, { Location: "/app.html?verified=1" }); return res.end();
  }
  if (pth === "/api/verify/resend" && method === "POST") {
    if (!user) return json(res, 401, { error: "Log in first" });
    if (user.email_verified) return json(res, 200, { ok: true, already: true });
    if (!mailer.configured()) return json(res, 503, { error: "Email sending isn't set up yet. Contact support to verify your account.", code: "email_unconfigured" });
    const now = Date.now();
    const log = (user.verify_sends || []).filter(function (t) { return now - Date.parse(t) < 864e5; });
    if (log.length && now - Date.parse(log[log.length - 1]) < 60000) return json(res, 429, { error: "Wait a minute before resending." });
    if (log.length >= 5) return json(res, 429, { error: "Too many verification emails today. Try again tomorrow." });
    const ok = issueVerification(user, req);
    save(db);
    return json(res, ok ? 200 : 502, ok ? { ok: true } : { error: "Could not send email" });
  }
  if (pth === "/api/login" && method === "POST") {
    const ip = clientIp(req);
    if (loginFailBlocked(ip)) {
      return json(res, 429, { error: "Too many sign-in tries. Wait a few minutes." });
    }
    const body = parseJsonBody(await readBody(req));
    const u = db.users.find(function (x) { return x.email === String(body.email || "").toLowerCase(); });
    if (!u || !checkPass(body.password || "", u.password_hash)) {
      loginFailRecord(ip);
      return json(res, 401, { error: "Invalid email or password" });
    }
    if (u.disabled) return json(res, 403, { error: "Account disabled" });
    loginFailClear(ip);
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
    const body = parseJsonBody(await readBody(req));
    const product = body.product || body.plan || "shop";
    if ((isMembershipProduct(product) || (body.plan && !isCreditProduct(body.product))) && !features.membershipEnabled()) {
      return json(res, 404, { error: "Memberships are not offered. Buy image credits instead." });
    }
    if (!billingConfigured()) return json(res, 501, { error: "Billing not configured" });
    if (pth === "/api/plan") return json(res, 400, { error: "Use checkout. Credits are added after the Square webhook." });
    if (!isKnownProduct(product)) return json(res, 400, { error: "Unknown plan or product" });
    if (!isCreditProduct(product)) return json(res, 400, { error: "Only image credits can be bought right now." });
    try {
      const st = ensureSettings(db);
      const opts = {};
      if (isCreditProduct(product)) {
        opts.amountCents = productAmountCents(product, st);
        opts.quantity = body.quantity;
      }
      const session = await createSquareCheckout(db, product, user, originOf(req), opts);
      save(db);
      return json(res, 200, { user: publicUser(user), checkoutUrl: session.checkoutUrl, mode: session.mode, product: session.product, plan: null, message: "Redirecting to Square Checkout" });
    } catch (err) {
      const code = err.status || 502;
      return json(res, code, { error: code === 501 ? "Billing not configured" : (IS_PROD ? "Billing error" : err.message) });
    }
  }
  if (pth === "/api/billing/square/webhook" && method === "POST") {
    const raw = await readBody(req);
    if (!billingConfigured()) return json(res, 501, { error: "Billing not configured" });
    if (!verifySquareSignature(raw, req.headers["x-square-hmacsha256-signature"], process.env.SQUARE_WEBHOOK_SIGNATURE_KEY, process.env.SQUARE_WEBHOOK_URL)) return json(res, 401, { error: "Invalid signature" });
    let result;
    try { result = applySquareEvent(db, JSON.parse(raw.toString("utf8"))); save(db); }
    catch (e) { return json(res, 400, { error: "Invalid payload" }); }
    // Not processed yet (e.g. refund before its payment): non-2xx so Square retries; event is not marked seen.
    if (result === "retry_later") return json(res, 409, { received: false, result: result });
    return json(res, 200, { received: true, result: result });
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
    const c = { id: uid(), email: email, name: body.name, password_hash: hashPass(body.password || "welcome123"), role: "client", shop_id: user.shop_id, plan: "client", plan_expires: null, halftone_credits: 0, vector_credits: 0, created_at: new Date().toISOString() };
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

  // Sharp vector preview. x,y,w,h are normalized fractions of the SVG viewBox
  // (0..1, top-left origin), not raw user units. See lib/previewRender.js.
  const previewPng = pth.match(/^\/api\/jobs\/([^/]+)\/preview\.png$/);
  if (previewPng && method === "GET") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    const job = db.jobs.find(function (j) { return j.id === previewPng[1]; });
    if (!job) return json(res, 404, { error: "Job not found" });
    if (!canSeeJob(user, job)) return json(res, 403, { error: "Forbidden" });
    if (!job.vector_svg) return json(res, 404, { error: "Vector art not found" });
    const abs = path.join(UPLOADS, path.basename(String(job.vector_svg)));
    if (!fs.existsSync(abs)) return json(res, 404, { error: "Vector art not found" });
    const q = parsePreviewQuery(url.searchParams);
    if (!q.ok) return json(res, 400, { error: q.error || "Bad preview query" });
    const st = fs.statSync(abs);
    const watermark = !previewArtEntitled(user, job);
    const spec = {
      x: q.x,
      y: q.y,
      w: q.w,
      h: q.h,
      pw: q.pw,
      ph: q.ph,
      mode: q.mode,
      watermark: watermark,
    };
    try {
      const out = await servePreview({
        actor: previewActorKey(user, req),
        key: previewCacheKey({
          jobId: job.id,
          mtime: st.mtimeMs + ":" + st.size,
          mode: q.mode,
          watermark: watermark,
          params: { x: q.x, y: q.y, w: q.w, h: q.h, pw: q.pw, ph: q.ph, zoom: q.zoom },
        }),
        render: function () { return renderPreviewPng(loadSvgText(abs), spec); },
      });
      return send(res, 200, out.png, {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=30",
        "Vary": "Cookie",
        "X-Preview-Cache": out.cache,
      });
    } catch (err) {
      return sendPreviewFailure(res, err);
    }
  }

  const jobGet = pth.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobGet && method === "GET") {
    if (!user) return json(res, 401, { error: "Sign in required" });
    const job = db.jobs.find(function (j) { return j.id === jobGet[1]; });
    if (!job || !canSeeJob(user, job)) return json(res, 404, { error: "Job not found" });
    return json(res, 200, { job: presentJob(job, req), events: presentEvents(db.events.filter(function (e) { return e.job_id === job.id; }), user) });
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
    clearTraceCache(job);
    job.file_path = applyUploadMatte(parsed.file.path, parsed.fields);
    job.unlocks = {};
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
      clearTraceCache(job);
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
  const htStyles = pth === "/api/halftone/styles" && method === "GET";
  if (htStyles) {
    return json(res, 200, { styles: vectorHalftone.listStyles() });
  }
  const htPreview = pth.match(/^\/api\/jobs\/([^/]+)\/halftone\/preview$/);
  if (htPreview && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === htPreview[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    if (!job.file_path) return json(res, 400, { error: "Artwork required for halftone" });
    const body = parseJsonBody(await readBody(req));
    const styleId = String(body.style || "classic-round");
    if (!vectorHalftone.resolveStyle(styleId)) {
      return json(res, 400, { error: "Unknown halftone style. Use GET /api/halftone/styles." });
    }
    const abs = path.join(UPLOADS, path.basename(job.file_path));
    if (!fs.existsSync(abs)) return json(res, 404, { error: "Artwork missing" });
    let srcBuf = fs.readFileSync(abs);
    if (srcBuf[0] !== 0x89 || srcBuf[1] !== 0x50) {
      try {
        srcBuf = vaiTrace.decodeRasterToPng(srcBuf);
      } catch (convErr) {
        return json(res, 400, { error: "Could not convert art to PNG for halftone — export a PNG and drop that" });
      }
    }
    const budget = clampHalftonePreviewBudget(body);
    const htOpts = {
      style: styleId,
      lpi: body.lpi,
      angle: body.angle,
      contrast: body.contrast,
      colorMode: body.colorMode || body.color_mode || "source",
      color: body.color || "#000000",
      knockout: body.knockout != null || body.knockoutWhite != null
        ? !!(body.knockout || body.knockoutWhite)
        : true,
      paperUnderlay: !!(body.paperUnderlay || body.whitePlate),
      widthIn: job.width_in || 10,
      heightIn: job.height_in || job.width_in || 10,
      preview: true,
      // Transparent SVG + CSS checker — match Apply (no baked white plate).
      previewPlate: false,
      // Ignore client values above the preview cap. Apply keeps its own budget.
      maxEdge: budget.maxEdge,
      maxCells: budget.maxCells,
    };
    const actor = previewActorKey(user, req);
    const ticket = takePreviewToken(actor);
    if (!ticket.ok) return sendPreviewLimited(res, ticket.retryAfter);
    try {
      const packed = vectorHalftone.halftoneToSvg(srcBuf, htOpts);
      const entitled = previewHalftoneEntitled(user, job);
      if (entitled) return json(res, 200, { svg: packed.svg, meta: packed.meta });
      const st = fs.statSync(abs);
      const out = await servePreview({
        actor: actor,
        charged: true,
        key: previewCacheKey({
          jobId: job.id,
          mtime: st.mtimeMs + ":" + st.size,
          mode: "halftone",
          watermark: true,
          params: {
            style: htOpts.style,
            lpi: Number.isFinite(Number(htOpts.lpi)) ? Number(htOpts.lpi) : null,
            angle: Number.isFinite(Number(htOpts.angle)) ? Number(htOpts.angle) : null,
            contrast: Number.isFinite(Number(htOpts.contrast)) ? Number(htOpts.contrast) : null,
            colorMode: htOpts.colorMode,
            color: htOpts.color,
            knockout: htOpts.knockout,
            paperUnderlay: htOpts.paperUnderlay,
            widthIn: htOpts.widthIn,
            heightIn: htOpts.heightIn,
            maxEdge: budget.maxEdge,
            maxCells: budget.maxCells,
          },
        }),
        render: function () { return renderPreviewPng(packed.svg, halftonePreviewRasterSpec(true)); },
      });
      return json(res, 200, {
        png: "data:image/png;base64," + out.png.toString("base64"),
        meta: packed.meta,
      });
    } catch (err) {
      if (err && (err.status === 429 || err.status === 503)) return sendPreviewFailure(res, err);
      return json(res, 400, { error: clientFacingError(err, "Could not preview halftone") });
    }
  }
  const htJob = pth.match(/^\/api\/jobs\/([^/]+)\/halftone$/);
  if (htJob && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === htJob[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    if (!requireServiceCredit(user, job, "halftones", res, ensureSettings(db))) return;
    if (!job.file_path) return json(res, 400, { error: "Artwork required for halftone" });
    const body = parseJsonBody(await readBody(req));
    const styleId = String(body.style || "classic-round");
    if (!vectorHalftone.resolveStyle(styleId)) {
      return json(res, 400, { error: "Unknown halftone style. Use GET /api/halftone/styles." });
    }
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
        return json(res, 400, { error: "Could not convert art to PNG for halftone — export a PNG and drop that" });
      }
    }
    try {
      const packed = vectorHalftone.halftoneToSvg(srcBuf, {
        style: styleId,
        lpi: body.lpi,
        angle: body.angle,
        contrast: body.contrast,
        colorMode: body.colorMode || body.color_mode || "source",
        color: body.color || "#000000",
        knockout: body.knockout != null || body.knockoutWhite != null
          ? !!(body.knockout || body.knockoutWhite)
          : true,
        paperUnderlay: !!(body.paperUnderlay || body.whitePlate),
        widthIn: job.width_in || 10,
        heightIn: job.height_in || job.width_in || 10,
        maxEdge: Math.min(Number(body.maxEdge) || 4000, 4000),
      });
      const svgName = Date.now() + "-" + uid() + "-halftone.svg";
      fs.writeFileSync(path.join(UPLOADS, svgName), packed.svg);
      job.vector_svg = "/uploads/" + svgName;
      delete job.vector_eps;
      job.vector = {
        widthIn: packed.widthIn,
        heightIn: packed.heightIn,
        layers: packed.layers,
        source: "vector-halftone",
        svg: packed.svg,
        meta: packed.meta,
      };
      job.halftone = {
        style: packed.meta.style,
        styleName: packed.meta.styleName,
        lpi: packed.meta.lpi,
        angle: packed.meta.angle,
        contrast: packed.meta.contrast,
        colorMode: packed.meta.colorMode,
        color: packed.meta.color,
        knockout: packed.meta.knockout,
        elements: packed.meta.elements,
        svg: job.vector_svg,
      };
      if (STATUSES.indexOf(job.status) < STATUSES.indexOf("art_in")) job.status = "art_in";
      applyMockup(job);
      const creditUse = consumeServiceCredit(user, job, "halftones");
      if (!creditUse.ok) {
        return json(res, 402, {
          error: HALFTONE_CREDIT_MSG,
          code: "halftone_credits_required",
          service: "halftones",
          buy: buyOptions("halftones", ensureSettings(db)),
          vectorCredits: vectorCreditBalance(user),
          halftoneCredits: halftoneCreditBalance(user),
        });
      }
      var htNote = "";
      if (creditUse.free) htNote = " · free first image";
      else if (creditUse.consumed) htNote = " · −1 halftone credit (" + creditUse.remaining + " left)";
      else if (creditUse.unlocked) htNote = " · image already unlocked";
      else if (creditUse.included && features.membershipEnabled() && !isComped(user)) htNote = " · Studio included";
      else if (creditUse.included) htNote = " · admin";
      event(db, job, "Halftone · " + packed.meta.styleName + " · " + packed.meta.elements + " marks" + htNote);
      save(db);
      const presented = presentJob(job, req);
      return json(res, 200, {
        job: presented,
        halftone: presented.halftone || null,
        meta: packed.meta,
        user: publicUser(user),
        halftoneCredits: halftoneCreditBalance(user),
        halftoneIncluded: halftoneIncluded(user),
        creditConsumed: !!creditUse.consumed,
      });
    } catch (err) {
      if (err && err.status === 413) {
        return json(res, 413, {
          error: String(err.message || "That size and LPI would need too many dots. Lower the LPI or print size."),
        });
      }
      return json(res, 400, { error: clientFacingError(err, "Could not build halftone") });
    }
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
    if (!job.file_path) return json(res, 400, { error: "Upload an SVG from your design software first" });
    const abs = path.join(UPLOADS, path.basename(job.file_path));
    if (!fs.existsSync(abs)) return json(res, 404, { error: "Artwork missing" });
    const buf = fs.readFileSync(abs);
    if (!corelImport.looksLikeSvg(buf)) return json(res, 400, { error: "Artwork is not SVG — export SVG from your design software" });
    try {
      const result = runCorelImportOnJob(job, buf, body);
      if (body.apply_mockup !== false) applyMockup(job);
      event(db, job, "Art imported · " + (result.meta.paths || 0) + " paths");
      save(db);
      return json(res, 200, { job: presentJob(job, req), vector: clientVector(job, req), meta: presentVzMeta(result.meta) });
    } catch (err) {
      return json(res, 400, { error: IS_PROD ? "Could not import that SVG" : err.message });
    }
  }

  const vecPath = pth.match(/^\/api\/jobs\/([^/]+)\/vectorize$/);
  if (vecPath && method === "POST") {
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    const job = db.jobs.find(function (j) { return j.id === vecPath[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    function finishVectorize(meta) {
      const creditUse = consumeServiceCredit(user, job, "vectorize");
      if (!creditUse.ok) {
        json(res, 402, {
          error: VECTOR_CREDIT_MSG,
          code: "vector_credits_required",
          service: "vectorize",
          buy: buyOptions("vectorize", ensureSettings(db)),
          vectorCredits: vectorCreditBalance(user),
          halftoneCredits: halftoneCreditBalance(user),
        });
        return;
      }
      save(db);
      const payload = {
        job: presentJob(job, req),
        vector: clientVector(job, req),
        vectorCredits: vectorCreditBalance(user),
        creditConsumed: !!creditUse.consumed,
        user: publicUser(user),
      };
      if (meta) payload.meta = presentVzMeta(meta);
      return json(res, 200, payload);
    }
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
    /* Explicit Corel path-transfer — NOT the default PNG Vectorize button. Import stays free. */
    if (wantCorel || isCorelSvg) {
      if (!requireProduce(user, res)) return;
      if (!isSvg) return json(res, 400, { error: "This import needs an SVG from your design software" });
      try {
        const result = runCorelImportOnJob(job, buf, body);
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Art imported · " + (job.vector.layers || []).length + " layers");
        save(db);
        return json(res, 200, { job: presentJob(job, req), vector: clientVector(job, req), meta: presentVzMeta(result.meta) });
      } catch (err) {
        return json(res, 400, { error: IS_PROD ? "Could not import that SVG" : err.message });
      }
    }
    if (isSvg) return json(res, 400, { error: "That SVG is not a supported design-software export. Upload a PNG to Vectorize." });
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
    if (!requireServiceCredit(user, job, "vectorize", res, ensureSettings(db))) return;
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
        return finishVectorize(packed.meta || (vec && vec.meta));
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
        return finishVectorize(packed.meta || (vec && vec.meta));
      }
      if (wantApi) {
        if (!vectorizerAi.configured()) {
          return json(res, 501, { error: "Pro vector service is not configured" });
        }
        await runProVectorize(job, buf, Object.assign({}, body, { engine: "vectorizer.ai", api: true }));
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Pro Vectorize · " + (job.vector.layers || []).length + " layers");
        return finishVectorize();
      }
      if (wantVai) {
        if (!vaiTrace.available()) return json(res, 501, { error: vaiTrace.unavailableReason() || "vai-trace unavailable" });
        const result = await runVaiTraceSafe(buf, job, body, sizeMeta);
        applyVectorResult(job, result.vec, result.svg);
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
        return finishVectorize(result.meta);
      }
      if (wantVtracer) {
        if (!vtracer.available()) return json(res, 501, { error: "VTracer binary missing" });
        runVtracerVectorize(job, buf, body);
        if (body.apply_mockup) applyMockup(job);
        event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
        return finishVectorize();
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
        event(db, job, "Vectorized · " + msg.vec.layers.length + " layers");
        return finishVectorize(msg.vec && msg.vec.meta);
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
          return finishVectorize(packed.meta || (packed.vec && packed.vec.meta));
        }
        // Non-twin: vai-trace first (general Lab+cubic). VTracer if missing. Bezier only in worker last.
        // Large art is downscaled (sizeMeta) and run via worker / async spawn so the event loop cannot wedge.
        if (vaiTrace.available()) {
          const result = await runVaiTraceSafe(buf, job, Object.assign({}, body, { colors: opts.colors, mode: "auto" }), sizeMeta);
          applyVectorResult(job, result.vec, result.svg);
          if (body.apply_mockup) applyMockup(job);
          event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
          return finishVectorize(result.meta);
        }
        if (vtracer.available()) {
          runVtracerVectorize(job, buf, body);
          if (body.apply_mockup) applyMockup(job);
          event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
          return finishVectorize();
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
        return finishVectorize(job.vector && job.vector.meta);
      } catch (bezErr) {
        if (vaiTrace.available()) {
          try {
            const result = await runVaiTraceSafe(buf, job, Object.assign({}, body, { mode: "auto" }), sizeMeta);
            applyVectorResult(job, result.vec, result.svg);
            if (body.apply_mockup) applyMockup(job);
            event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
            return finishVectorize(result.meta);
          } catch (vaiErr) { /* fall through */ }
        }
        if (vtracer.available()) {
          runVtracerVectorize(job, buf, body);
          if (body.apply_mockup) applyMockup(job);
          event(db, job, "Vectorized · " + (job.vector.layers || []).length + " layers");
          return finishVectorize();
        }
        throw bezErr;
      }
    } catch (err) {
      return json(res, 400, { error: clientFacingError(err, "Could not vectorize") });
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
        svg = stripPaperUnderlaySvg(svg.replace(new RegExp(esc, "gi"), to));
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
    return json(res, 200, { job: presentJob(job, req), vector: clientVector(job, req) });
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
    if (forbidDigitize(user, res)) return;
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    if (!requirePaidProduce(user, res)) return;
    const job = db.jobs.find(function (j) { return j.id === digPath[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    const body = parseJsonBody(await readBody(req));
    if (body.widthIn != null || body.width_in != null) job.width_in = Number(body.widthIn || body.width_in);
    if (body.heightIn != null || body.height_in != null) job.height_in = Number(body.heightIn || body.height_in);
    const digOpts = {
      satinMm: body.satinMm,
      satinSpacingMm: body.satinSpacingMm,
      density: body.density,
      widthIn: job.width_in,
      heightIn: job.height_in,
      threads: body.threads,
      typeOverrides: body.typeOverrides,
      previewOnly: body.includeFiles ? false : (body.previewOnly !== false),
      recolorOnly: !!body.recolorOnly,
      angleDeg: body.angleDeg,
      madeiraCatalog: body.madeiraCatalog,
      fabric: body.fabric,
      engine: body.engine,
      prep: body.prep !== false,
      simplify: !!body.simplify,
      pes: true,
    };
    job.digitizeSettings = {
      widthIn: job.width_in,
      heightIn: job.height_in,
      fabric: body.fabric || (job.digitizeSettings && job.digitizeSettings.fabric) || "tee",
      density: body.density,
      satinSpacingMm: body.satinSpacingMm,
      simplify: !!body.simplify,
    };
    let dig;
    try {
      dig = await digitizeJobCached(job, UPLOADS, digOpts);
    } catch (err) {
      return json(res, 500, { error: String(err && err.message || err) });
    }
    job.stitchCount = dig.stitchCount;
    job.colorStops = dig.colorStops;
    if (dig.objects) job.digitizeObjects = dig.objects;
    if (dig.exporter) job.digitizeExporter = dig.exporter;
    if (dig.summary) job.digitizeSummary = dig.summary;
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
      engine: dig.engine || "wq",
      summary: dig.summary || null,
      warnings: dig.warnings || [],
      textWarnings: dig.textWarnings || [],
      minRecommendedWidthIn: dig.minRecommendedWidthIn == null ? null : dig.minRecommendedWidthIn,
      busyArt: dig.busyArt || null,
      files: body.includeFiles ? { dst: dig.dst && dig.dst.length ? dig.dst.toString("base64") : null, exp: dig.exp && dig.exp.length ? dig.exp.toString("base64") : null, pes: dig.pes && dig.pes.length ? dig.pes.toString("base64") : null } : undefined,
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
    const exportName = String(expFile[2] || "").toLowerCase();
    if (isStitchExportName(exportName) && forbidDigitize(user, res)) return;
    if (!canRunFloor(user)) return json(res, 403, { error: "Shop login required" });
    const stitchPacket = isStitchExportName(exportName);
    const packetExport = /\.(dst|exp|pes)$/.test(exportName) || stitchPacket || exportName.indexOf("stones") !== -1 || exportName.indexOf("packet") !== -1;
    if (packetExport) {
      if (!requirePaidProduce(user, res)) return;
    } else {
      if (!requireProduce(user, res)) return;
    }
    const job = db.jobs.find(function (j) { return j.id === expFile[1] && j.shop_id === user.shop_id; });
    if (!job) return json(res, 404, { error: "Job not found" });
    if (!requireExportEntitled(user, job, res, ensureSettings(db))) return;
    job._shop = db.shops.find(function (s) { return s.id === user.shop_id; });
    if (expFile[2] === "art.svg" && job.vector_svg) {
      const abs = path.join(UPLOADS, path.basename(job.vector_svg));
      if (fs.existsSync(abs)) {
        const svgOut = stripPaperUnderlaySvg(fs.readFileSync(abs, "utf8"));
        return download(res, "decoclub-" + job.id.slice(0, 8) + "-art.svg", svgOut, "image/svg+xml");
      }
    }
    if (expFile[2] === "art.png" && job.file_path) {
      const abs = path.join(UPLOADS, path.basename(job.file_path));
      if (fs.existsSync(abs)) {
        return download(res, "decoclub-" + job.id.slice(0, 8) + "-art.png", fs.readFileSync(abs), "image/png");
      }
    }
    const printFmt = { "art.dxf": ["dxf", "application/dxf"], "art.pdf": ["pdf", "application/pdf"], "art.tiff": ["tiff", "image/tiff"], "art-dtf.tiff": ["tiff", "image/tiff", true], "art-300dpi.png": ["png", "image/png"], "art-underbase.png": ["underbase", "image/png"] }[expFile[2]];
    if (printFmt && job.vector_svg) {
      const abs = path.join(UPLOADS, path.basename(job.vector_svg));
      if (!fs.existsSync(abs)) return json(res, 404, { error: "Vector art not found" });
      try {
        const out = await printExport(abs, printFmt[0], { widthIn: job.width_in, heightIn: job.height_in, underbase: !!printFmt[2] });
        return download(res, "decoclub-" + job.id.slice(0, 8) + "-" + expFile[2], out, printFmt[1]);
      } catch (err) {
        return json(res, 500, { error: "Print export failed: " + String(err && err.message || err).slice(0, 300) });
      }
    }
    if (expFile[2] === "art.eps" && job.vector_eps) {
      const abs = path.join(UPLOADS, path.basename(job.vector_eps));
      if (fs.existsSync(abs)) {
        return download(res, "decoclub-" + job.id.slice(0, 8) + "-art.eps", fs.readFileSync(abs), "application/postscript");
      }
    }
    const name = expFile[2];
    const short = job.id.slice(0, 8);
    if (name === "design.dst" || name === "design.exp" || name === "design.pes" || name === "stitch-preview.svg") {
      try {
        const file = await stitchFileForJob(job, name);
        if (file) return download(res, "decoclub-" + short + "-" + name, file, MIME[path.extname(name)] || "application/octet-stream");
      } catch (err) {
        return json(res, 500, { error: String(err && err.message || err) });
      }
    }
    const exportJob = digitizeFor(user) ? job : Object.assign({}, job, { _hideMachineFiles: true });
    const pack = writeExports(exportJob, UPLOADS, path.join(EXPORTS, job.id));
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
    if (!requireExportEntitled(user, job, res, ensureSettings(db))) return;
    job._shop = db.shops.find(function (s) { return s.id === user.shop_id; });
    const exportJob = digitizeFor(user) ? job : Object.assign({}, job, { _hideMachineFiles: true });
    const pack = writeExports(exportJob, UPLOADS, path.join(EXPORTS, job.id));
    res.setHeader("Content-Disposition", 'attachment; filename="decoclub-' + job.id.slice(0, 8) + '-packet.json"');
    return json(res, 200, pack.packet);
  }

  function publicAdminUser(u) {
    const shop = db.shops.find(function (s) { return s.id === u.shop_id; });
    return {
      id: u.id, email: u.email, name: u.name, role: u.role, shop_id: u.shop_id,
      shop_name: shop ? shop.name : null, plan: u.plan, plan_expires: u.plan_expires,
      halftone_credits: halftoneCreditBalance(u),
      halftone_included: halftoneIncluded(u),
      vector_credits: vectorCreditBalance(u),
      vector_included: vectorIncluded(u),
      disabled: !!u.disabled, created_at: u.created_at,
      free_image_used: !!u.free_image_used, free_image_service: u.free_image_service || null, free_image_at: u.free_image_at || null,
      images_processed: Number(u.images_processed) || 0,
      email_verified: !!u.email_verified,
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
        halftone_single_cents: settings.halftone_single_cents,
        halftone_pack10_cents: settings.halftone_pack10_cents,
        vector_single_cents: settings.vector_single_cents,
        vector_pack10_cents: settings.vector_pack10_cents,
        services: enabledServiceNames(user),
      },
      billing_configured: billingConfigured(),
      stripe_configured: billingConfigured(),
      imagine: false,
      vectorizer_ai: false,
      vai_trace: vaiTrace.available(),
      vtracer: vtracer.available(),
      data_dir_env: !!process.env.DATA_DIR,
      email_sending: mailer.configured(),
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
  if (delUser && (method === "PATCH" || method === "POST")) {
    if (!requireAdmin(user, res)) return;
    const u = db.users.find(function (x) { return x.id === delUser[1]; });
    if (!u) return json(res, 404, { error: "User not found" });
    const body = parseJsonBody(await readBody(req));
    // Validate credit changes before mutating anything.
    const creditOps = [];
    if (body.halftone_credits != null) creditOps.push(adminSetCredits(db, user, u, "halftones", "halftone_credits", { set: body.halftone_credits, reason: body.reason }));
    if (body.vector_credits != null) creditOps.push(adminSetCredits(db, user, u, "vectorize", "vector_credits", { set: body.vector_credits, reason: body.reason }));
    const badCredit = creditOps.find(function (c) { return c.error; });
    if (badCredit) return json(res, 400, { error: badCredit.error });
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
    if (body.email_verified !== undefined) {
      u.email_verified = !!body.email_verified;
      if (u.email_verified) { u.email_verified_at = new Date().toISOString(); u.verify_token_hash = null; u.verify_expires = null; }
    }
    if (body.name) u.name = String(body.name).trim();
    for (const c of creditOps) c.apply();
    save(db);
    return json(res, 200, { user: publicAdminUser(u) });
  }
  const htCreditPath = pth.match(/^\/api\/admin\/users\/([^/]+)\/halftone-credits$/);
  if (htCreditPath && method === "POST") {
    if (!requireAdmin(user, res)) return;
    const u = db.users.find(function (x) { return x.id === htCreditPath[1]; });
    if (!u) return json(res, 404, { error: "User not found" });
    const body = parseJsonBody(await readBody(req));
    const r = adminSetCredits(db, user, u, "halftones", "halftone_credits", body);
    if (r.error) return json(res, 400, { error: r.error });
    const entry = r.apply();
    save(db);
    return json(res, 200, { user: publicAdminUser(u), entry: entry });
  }
  if (htCreditPath && method === "GET") {
    if (!requireAdmin(user, res)) return;
    return json(res, 200, { history: historyFor(db, htCreditPath[1]).filter(function (r) { return r.service === "halftones"; }) });
  }
  const vecCreditPath = pth.match(/^\/api\/admin\/users\/([^/]+)\/vector-credits$/);
  if (vecCreditPath && method === "POST") {
    if (!requireAdmin(user, res)) return;
    const u = db.users.find(function (x) { return x.id === vecCreditPath[1]; });
    if (!u) return json(res, 404, { error: "User not found" });
    const body = parseJsonBody(await readBody(req));
    const r = adminSetCredits(db, user, u, "vectorize", "vector_credits", body);
    if (r.error) return json(res, 400, { error: r.error });
    const entry = r.apply();
    save(db);
    return json(res, 200, { user: publicAdminUser(u), entry: entry });
  }
  if (vecCreditPath && method === "GET") {
    if (!requireAdmin(user, res)) return;
    return json(res, 200, { history: historyFor(db, vecCreditPath[1]).filter(function (r) { return r.service === "vectorize"; }) });
  }
  const ledgerPath = pth.match(/^\/api\/admin\/users\/([^/]+)\/credit-history$/);
  if (ledgerPath && method === "GET") {
    if (!requireAdmin(user, res)) return;
    return json(res, 200, { history: historyFor(db, ledgerPath[1]) });
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
    clearTraceCache(job);
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
      features: features.flags(),
    });
  }
  if (pth === "/api/admin/settings" && method === "POST") {
    if (!requireAdmin(user, res)) return;
    const body = parseJsonBody(await readBody(req));
    const st = ensureSettings(db);
    if (body.trial_days != null) st.trial_days = Math.max(0, Number(body.trial_days) || 0);
    if (body.shop_price_cents != null) st.shop_price_cents = Math.max(0, Math.round(Number(body.shop_price_cents)));
    if (body.studio_price_cents != null) st.studio_price_cents = Math.max(0, Math.round(Number(body.studio_price_cents)));
    if (body.halftone_single_cents != null) st.halftone_single_cents = Math.max(0, Math.round(Number(body.halftone_single_cents)));
    if (body.halftone_pack10_cents != null) st.halftone_pack10_cents = Math.max(0, Math.round(Number(body.halftone_pack10_cents)));
    if (body.vector_single_cents != null) st.vector_single_cents = Math.max(0, Math.round(Number(body.vector_single_cents)));
    if (body.vector_pack10_cents != null) st.vector_pack10_cents = Math.max(0, Math.round(Number(body.vector_pack10_cents)));
    db.settings = st; save(db);
    return json(res, 200, { settings: st, billing_configured: billingConfigured() });
  }

  if (pth === "/api/admin/contact-messages" && method === "GET") {
    if (!requireAdmin(user, res)) return;
    ensureContactMessages(db);
    const messages = db.contact_messages.slice().sort(function (a, b) {
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
    return json(res, 200, { messages: messages });
  }

  return json(res, 404, { error: "Not found" });
}

/** Block raw production SVGs for viewers who have not paid. Admins are exempt.
 * Returns 0 to allow, otherwise an HTTP status. */
function guardVectorUpload(req, base) {
  if (path.extname(base).toLowerCase() !== ".svg") return 0;
  const generated = /-(?:vector|halftone|corel|vtracer)\.svg$/i.test(base);
  const db = load();
  const viewer = currentUser(req, db);
  let job = null;
  const jobs = db.jobs || [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    if (j && j.vector_svg && path.basename(String(j.vector_svg)) === base) { job = j; break; }
  }
  if (!job && !generated) return 0;
  if (viewer && viewer.role === "admin") return 0;
  if (!viewer) return 401;
  if (!job || !canSeeJob(viewer, job) || !previewArtEntitled(viewer, job)) return 403;
  return 0;
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  // Trailing slash → bare path so /admin/ and /login/ match aliases like /admin and /login.
  if (rel.length > 1 && rel.charAt(rel.length - 1) === "/") rel = rel.slice(0, -1);
  const requested = (rel === "" ? "/" : rel) + (url.search || "");
  if (rel === "/" || rel === "") rel = "/index.html";
  const viewer = currentUser(req, load());
  const digitizeAsset = rel === "/digitize-demo.html" || rel === "/digitize-preview.js" || rel === "/digitize-admin.js";
  if (digitizeAsset && !digitizeFor(viewer)) return send(res, 404, "Not found");
  const ALIAS = { "/login": "/login.html", "/app": "/app.html", "/admin": "/admin.html", "/signup": "/signup.html", "/start": "/start.html", "/contact": "/contact.html" };
  if (ALIAS[rel]) rel = ALIAS[rel];
  // Studio shell and tool entry require an account. Public pages stay on disk.
  if ((rel === "/app.html" || rel === "/start.html") && !viewer) {
    return send(res, 302, "", {
      Location: "/login.html?next=" + encodeURIComponent(requested),
      "Cache-Control": "private, no-store",
      Vary: "Cookie",
    });
  }
  if (rel.indexOf("/uploads/") === 0) {
    const file = path.join(UPLOADS, path.basename(rel));
    if (!fs.existsSync(file)) return send(res, 404, "Not found");
    const blocked = guardVectorUpload(req, path.basename(file));
    if (blocked) {
      return send(res, blocked, blocked === 401 ? "Sign in required" : "Forbidden", {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "private, no-store",
      });
    }
    const ext = path.extname(file).toLowerCase();
    return send(res, 200, fs.readFileSync(file), { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "private, no-store" });
  }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file.indexOf(PUBLIC) !== 0) return send(res, 403, "Forbidden");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "Not found");
  const ext = path.extname(file).toLowerCase();
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
  if (digitizeAsset || rel === "/app.html" || rel === "/start.html") {
    headers["Cache-Control"] = "private, no-store";
    headers["Vary"] = "Cookie";
  } else if (ext === ".html" || ext === ".js" || ext === ".css") {
    headers["Cache-Control"] = "no-cache";
  } else if (rel === "/brand.jpg" || rel === "/logo.png" || rel === "/logo.svg" || ext === ".jpg" || ext === ".jpeg" || ext === ".png" || ext === ".webp" || ext === ".gif" || ext === ".svg") {
    headers["Cache-Control"] = "public, max-age=86400";
  }
  send(res, 200, fs.readFileSync(file), headers);
}

// Digitize runtime check (python libs for digitize_prep + pyembroidery, potrace),
// probed once in the background after start; reported on /health.
let DIGITIZE_DEPS = null;
// Vectorize r11 runtime check: busy-art engine needs potrace + rsvg-convert. Logged at start, on /health.
let TRACE_DEPS = null;
function probeTraceDeps() {
  const cp = require("child_process");
  cp.execFile("potrace", ["--version"], { timeout: 10000 }, function (pe) {
    cp.execFile("rsvg-convert", ["--version"], { timeout: 10000 }, function (re) {
      TRACE_DEPS = { potrace: !pe, rsvgConvert: !re };
      console.log("[trace-deps] potrace=" + TRACE_DEPS.potrace + " rsvg-convert=" + TRACE_DEPS.rsvgConvert);
    });
  });
}

function probeDigitizeDeps() {
  const cp = require("child_process");
  const py = process.env.DIGITIZE_PYTHON || pickPrepPython();
  const code = "import importlib, json\nr = {}\nfor m in ['numpy', 'scipy', 'cv2', 'skimage', 'PIL', 'pyembroidery']:\n    try:\n        importlib.import_module(m); r[m] = True\n    except Exception:\n        r[m] = False\nprint(json.dumps(r))";
  cp.execFile(py, ["-c", code], { timeout: 90000 }, function (err, out) {
    let mods = {};
    try { mods = JSON.parse(String(out || "").trim().split("\n").pop()); } catch (e) { mods = {}; }
    const need = ["numpy", "scipy", "cv2", "skimage", "PIL", "pyembroidery"];
    cp.execFile("potrace", ["--version"], { timeout: 10000 }, function (perr) {
      DIGITIZE_DEPS = {
        python: !err && need.every(function (m) { return mods[m] === true; }),
        pyembroidery: mods.pyembroidery === true,
        opencv: mods.cv2 === true,
        numpy: mods.numpy === true, scipy: mods.scipy === true, skimage: mods.skimage === true, pillow: mods.PIL === true,
        potrace: !perr,
        prep: fs.existsSync(path.join(__dirname, "lib", "digitize_prep.py")),
      };
    });
  });
}

const server = http.createServer(async function (req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      const healthUser = currentUser(req, load());
      const health = {
        ok: true,
        name: BUILD.name,
        version: BUILD.version,
        stamp: BUILD.stamp,
        billing: billingConfigured(),
        imagine: false,
        vectorizerAi: false,
        vaiTrace: vaiTrace.available(),
        services: enabledServiceNames(healthUser),
        pricing: "ppi",
        traceDeps: TRACE_DEPS,
        traceEngine: TRACE_ENGINE_VER,
      };
      if (digitizeFor(healthUser)) health.digitizeDeps = DIGITIZE_DEPS;
      return json(res, 200, health);
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
  probeTraceDeps();
  setTimeout(probeDigitizeDeps, 5000).unref();
});
