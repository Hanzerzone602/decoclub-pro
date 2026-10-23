const main = document.getElementById("main");
let user = null, shop = null, view = "make", currentJob = null, station = "art", makeMethod = "apparel";
let cfg = { statuses: [], methods: [], blanks: [], billing: false, demo: false };
const $ = (s, r = document) => r.querySelector(s);
const STAT_LABEL = { new: "New", art_in: "Art in", mockup: "Mockup", priced: "Priced", proof_sent: "Proof sent", approved: "Approved", in_production: "In production", done: "Done" };
const METHODS = ["dtf","uvdtf","uv","vinyl","laser","sticker","screen","hat","apparel","patch","sublimation","rhinestone","sign"];
const METHOD_LABELS = {
  dtf: "DTF", uvdtf: "UV DTF", uv: "UV print", vinyl: "Vinyl", laser: "Laser",
  sticker: "Stickers", screen: "Spot color", hat: "Hats", apparel: "Apparel", patch: "Patches",
  sublimation: "Sublimation", rhinestone: "Rhinestone", sign: "Signs",
};
const METHOD_OUTCOMES = {
  dtf: "22in gang + SVG/EPS", uvdtf: "22in UV gang + SVG/EPS", uv: "SVG + EPS print",
  vinyl: "SVG + EPS cut", laser: "SVG + PLT", sticker: "Kiss-cut SVG + EPS",
  hat: "Cap mockup + SVG/EPS", apparel: "Garment mockup + SVG/EPS", patch: "Badge + SVG/EPS",
  sublimation: "Wrap + SVG/EPS", rhinestone: "SS map + CSV", sign: "Board SVG + EPS",
};
const METHOD_ICONS = {
  dtf: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M6 9h5v6H6zM13 9h5M13 13h4"/>',
  uvdtf: '<rect x="3" y="6" width="18" height="12" rx="1.5"/><path d="M8 4v2M12 3v3M16 4v2"/><circle cx="8" cy="12" r="1.4"/>',
  uv: '<rect x="4" y="8" width="16" height="11" rx="1"/><path d="M12 3v3M8.5 4.5l1.2 1.8M15.5 4.5l-1.2 1.8"/>',
  vinyl: '<ellipse cx="7" cy="12" rx="3.2" ry="6"/><path d="M7 6h11.5a2.5 2.5 0 0 1 0 12H7"/><circle cx="18.5" cy="12" r="2.2"/>',
  laser: '<path d="M12 4l7 4v8l-7 4-7-4V8z"/><path d="M5 8l7 4 7-4M12 12v8"/>',
  sticker: '<path d="M6 4h9l5 5v11H6z"/><path d="M15 4v5h5"/>',
  screen: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M8 10h8M8 14h5"/>',
  hat: '<path d="M4 14c2-6 4.5-8 8-8s6 2 8 8"/><path d="M3 15h18v2H3z"/><path d="M8 14v-2"/>',
  apparel: '<path d="M8 6l4-2 4 2 4 2-2.5 3H16v9H8V11H6.5L4 8z"/>',
  patch: '<path d="M12 3l7 3v6c0 4.2-2.8 7.5-7 9-4.2-1.5-7-4.8-7-9V6z"/>',
  sublimation: '<rect x="8" y="4" width="8" height="16" rx="3.5"/><path d="M8 9h8"/>',
  rhinestone: '<path d="M12 3l4 6-4 12L8 9z"/><path d="M8 9h8"/>',
  sign: '<rect x="4" y="5" width="16" height="10" rx="1"/><path d="M12 15v5M8 20h8"/>',
};
const BLANKS = ["tee","hoodie","hat","tumbler","plaque","sticker","sign","hoop"];
function studioExtras() {
  return (window.DecoStudio && window.DecoStudio.extras) || [];
}
let suiteTool = "";
const upscaleStarted = {};
function builtinSuiteTools() {
  return [
    { id: "vectorize", name: "Vectorize", blurb: "Convert raster logos & artwork into clean, gap-free SVG, EPS, PDF & DXF cut/print files." },
    { id: "bgremove", name: "Remove Background", blurb: "One-click clean background removal with transparent PNG & SVG download." },
    { id: "halftones", name: "Halftones", blurb: "20+ true print halftone styles with transparent ink marks for DTF & screen print." },
    { id: "upscale", name: "300 DPI Upscaler", blurb: "Upscale low-res 72 DPI client images to crisp, true 300 DPI print-size PNGs for DTF printing." },
    { id: "stones", name: "Rhinestones", blurb: "Rhinestone template & crystal layout generator." },
  ];
}
function extraSuiteTools() {
  const list = (window.DecoStudio && window.DecoStudio.suiteTools) || [];
  return list.filter((t) => t && t.id && !builtinSuiteTools().some((b) => b.id === t.id));
}
function suiteToolList() {
  return builtinSuiteTools().concat(extraSuiteTools());
}
function suiteToolById(id) {
  const key = String(id || "").toLowerCase() === "halftone" ? "halftones" : String(id || "").toLowerCase();
  return suiteToolList().find((t) => t.id === key) || null;
}
function syncSuiteChrome() {
  const tool = suiteToolById(suiteTool);
  document.body.classList.toggle("suite-focus", !!tool);
  if (tool) document.body.dataset.suite = tool.id;
  else delete document.body.dataset.suite;
  const label = document.getElementById("studioHeaderTool");
  if (label) label.textContent = tool ? tool.name : "Choose Your Tool";
}
function showAllTools() {
  suiteTool = "";
  currentJob = null;
  view = canFloor() ? "make" : "board";
  station = "art";
  htPanelWantOpen = false;
  document.body.classList.remove("ht-mode");
  history.replaceState({}, "", "/app");
  syncSuiteChrome();
  nav();
  render();
}
function launcherHtml() {
  const cards = suiteToolList().map((t) => `
    <a class="suite-card" href="/app?tool=${encodeURIComponent(t.id)}">
      <span class="suite-kicker">DecoClub</span>
      <strong>${escapeHtml(t.name)}</strong>
      <span>${escapeHtml(t.blurb)}</span>
      <span class="suite-go">Open</span>
    </a>`).join("");
  return `
    <section class="tool-launcher" id="toolLauncher">
      <p class="kicker">Studio</p>
      <h1 class="make-title">Choose Your Tool</h1>
      <p class="muted make-sub">Each card opens that tool. All Tools brings you back here.</p>
      <div class="suite-grid">${cards}</div>
    </section>`;
}
function applySuiteFocus(root) {
  syncSuiteChrome();
  if (!suiteTool || !root) return;
  root.querySelectorAll("[data-suite]").forEach((node) => {
    const tags = (node.getAttribute("data-suite") || "").split(/\s+/);
    node.hidden = tags.indexOf("shared") === -1 && tags.indexOf(suiteTool) === -1;
  });
}
function methodChoices() {
  if (cfg && Array.isArray(cfg.methods) && cfg.methods.length) return cfg.methods;
  return METHODS;
}
function methodMeta(id) {
  const extra = studioExtras().find((m) => m && m.method && m.method.id === id);
  return {
    label: (extra && extra.method.label) || METHOD_LABELS[id] || id,
    outcome: (extra && extra.method.outcome) || METHOD_OUTCOMES[id] || "",
    icon: (extra && extra.method.icon) || METHOD_ICONS[id] || "",
  };
}
function loadAdminScripts(list) {
  return (list || []).reduce((chain, src) => chain.then(() => new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("Could not load studio module"));
    document.body.appendChild(el);
  })), Promise.resolve());
}
const PLACES = [
  { id: "chest", label: "Center chest" },
  { id: "left_chest", label: "Left chest" },
  { id: "full", label: "Full front" },
  { id: "back", label: "Back (front photo for now)" },
  { id: "youth", label: "Youth chest" },
];

/** Map HTTP failures to shop-floor language (avoid bare "Server error" / raw codes). */
function shopHttpError(status, data, fallback) {
  const serverMsg = (data && data.error) ? String(data.error) : "";
  const hint = (data && data.hint) ? String(data.hint) : "";
  const usable = serverMsg && serverMsg !== "Server error" && serverMsg !== "Request failed";
  if (status === 413) {
    if (usable) return hint ? (serverMsg.replace(/\.\s*$/, "") + ". " + hint) : serverMsg;
    return "File too large for Vectorize. Export a smaller PNG and try again.";
  }
  if (status === 429) {
    return usable ? serverMsg : "Too many tries. Wait a minute and try again.";
  }
  if (status === 408 || status === 504) {
    return usable ? serverMsg : "That took too long. Try again with a smaller PNG.";
  }
  if (status === 401 || status === 403) {
    return usable ? serverMsg : "Sign in again to continue.";
  }
  if (usable) return serverMsg;
  if (status >= 500) return "Studio hiccup. Try again in a moment — if it keeps happening, use a smaller PNG.";
  return fallback || "Request failed";
}
async function api(url, opts = {}) {
  opts = Object.assign({ credentials: "include" }, opts);
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e && (e.name === "AbortError" || (opts.signal && opts.signal.aborted))) {
      const err = new Error("aborted");
      err.code = "ABORTED";
      throw err;
    }
    const err = new Error("Network stalled. Check your connection and try again.");
    err.code = "NETWORK";
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(shopHttpError(res.status, data, "Request failed"));
    err.status = res.status;
    if (res.status === 413) err.code = "PAYLOAD_TOO_LARGE";
    else if (res.status === 429) {
      err.code = "RATE_LIMIT";
      const ra = Number(res.headers.get("Retry-After") || res.headers.get("retry-after"));
      if (Number.isFinite(ra) && ra > 0) err.retryAfter = ra;
    }
    throw err;
  }
  return data;
}
function money(n) { return "$" + Number(n || 0).toFixed(2); }
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function showArtWorking(label) {
  const drop = document.getElementById("artDrop") || document.getElementById("makeDrop");
  const makeErr = document.getElementById("makeErr");
  if (makeErr && !document.getElementById("artDrop")) {
    makeErr.textContent = label || "Working";
  }
  if (!drop) return;
  let ov = document.getElementById("artWorking");
  if (!ov || ov.parentElement !== drop) {
    if (ov && ov.parentElement) ov.parentElement.removeChild(ov);
    ov = document.createElement("div");
    ov.id = "artWorking";
    ov.className = "art-working";
    ov.setAttribute("aria-live", "polite");
    ov.innerHTML = '<img src="/logo.png" alt="" /><span></span>';
    drop.appendChild(ov);
  }
  const span = ov.querySelector("span");
  if (span) span.textContent = label || "Working";
  ov.hidden = false;
}
/** Keep Halftones panel open across renderJob after Apply / while previewing. */
let htPanelWantOpen = false;
let htPreviewTimer = null;
let htPreviewSeq = 0;
let htPreviewAbort = null;

function hideArtWorking() {
  const ov = document.getElementById("artWorking");
  if (ov) ov.hidden = true;
  const makeErr = document.getElementById("makeErr");
  if (makeErr && makeErr.textContent && /^(Uploading|Preparing|Working)/.test(makeErr.textContent)) {
    makeErr.textContent = "";
  }
}

/** Press-floor run-risk from layer count / alignment. Shop language only — never engine ids. */
function runRiskForJob(job) {
  const layers = (job && job.vector && job.vector.layers) || [];
  const meta = (job && job.vector && job.vector.meta) || {};
  const n = layers.length;
  const mae = meta.mae_svg_vs_src != null ? Number(meta.mae_svg_vs_src) : (meta.mae_src != null ? Number(meta.mae_src) : null);
  let level = "review";
  let title = "Review";
  let line = "Vector ready — check colors against the blank before you press.";
  if (!job || !job.vector) {
    return { level: "hold", title: "Hold", line: "No vector yet. Drop art and Vectorize before you queue a press run." };
  }
  if (n > 0 && n <= 8) {
    level = "go"; title = "Green";
    line = n + " clean layers — standard DTF run. Confirm underbase if needed.";
  } else if (n > 12) {
    level = "hold"; title = "Hold";
    line = n + " layers is a lot for one hit — merge colors or split screens before you go.";
  } else if (n > 8) {
    level = "review"; title = "Review";
    line = n + " layers — check registration and whether fine detail will hold on press.";
  }
  if (mae != null && mae > 40 && level === "go") {
    level = "review"; title = "Review";
    line = "Alignment looks off vs the source — zoom edges before you print.";
  }
  return { level: level, title: title, line: line, layers: n };
}

/** Scrub engine/recipe tokens from timeline / status strings (covers old DB events). */
function sanitizeEventMessage(message) {
  let s = String(message == null ? "" : message);
  const countMatch = s.match(/(\d+)\s+(layers?|colors?|paths?|stitches)\b/i);
  const n = countMatch ? countMatch[1] : null;
  const unitRaw = countMatch ? countMatch[2].toLowerCase() : "";
  const unit = unitRaw.indexOf("color") === 0 ? "layers"
    : (unitRaw.indexOf("layer") === 0 ? "layers"
      : (unitRaw.indexOf("path") === 0 ? "paths"
        : (unitRaw.indexOf("stitch") === 0 ? "stitches" : unitRaw)));
  const countBit = n && unit ? (n + " " + unit) : "";
  const INTERNAL = /\b(?:invent-warp(?:-forced-bundled)?|invent\/[\w-]+|ecc-multiROI-TPS-bundled|ecc-multiROI-TPS|ecc-multiROI|TPS-bundled|\bTPS\b|bundled|vai-trace(?:\s+fallback)?|vtracer|VTracer|raster-corel|hallucinate(?:-after)?|invent-hallucinate|src-bezier(?:-fallback)?|lab-hier|bezier|Vectorizer\.AI|legacy(?:\s+fallback)?|fallback|path-transfer|corel-import|auto\s+path-transfer)\b/gi;
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
    if (!s || /^[·\s\/-]*$/.test(s)) return countBit ? ("Vectorized · " + countBit) : "Update";
    if (countBit && s.indexOf(n) === -1) s = s + " · " + countBit;
    return s;
  }
  return s;
}
function runRiskHtml(job) {
  const r = runRiskForJob(job);
  const cls = r.level === "go" ? "risk-go" : (r.level === "hold" ? "risk-hold" : "risk-review");
  return `<div class="run-risk ${cls}" id="runRisk" data-suite="vectorize"><strong>${escapeHtml(r.title)}</strong> · ${escapeHtml(r.line)}</div>`;
}
function canFloor() {
  return !!(user && (user.role === "shop" || (user.role === "admin" && user.shopId)));
}
function entitled() { return !!(user && user.entitled); }
function jobHasVector(job) {
  if (!job) return false;
  if (job.vector_svg || job.vector_preview || job.has_vector) return true;
  return !!(job.vector && job.vector.layers && job.vector.layers.length);
}
let artPreviewObjectUrl = null;
let artZoomGen = 0;
function paywallNote() {
  if (entitled()) return "";
  return '<p class="notice" id="paywall">Some exports need a member account. Trial and member logins unlock the full art studio.</p>';
}
function nav() {
  document.querySelectorAll(".linkish").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
    if (b.tagName === "A") return;
    b.onclick = () => { view = b.dataset.view; if (view !== "job") currentJob = null; nav(); render(); };
  });
  $("#navClients").style.display = "none";
  $("#navJob").style.display = currentJob ? "block" : "none";
  const office = $("#navOffice");
  if (office) office.style.display = user && user.role === "admin" ? "block" : "none";
}

function showVerifyBanner(u) {
  if (!u || u.role === "admin" || u.emailVerified || u.freeImageReason === "used") return;
  const bar = document.createElement("div");
  bar.className = "notice verify-banner";
  bar.innerHTML = u.emailSending
    ? 'Confirm your email to unlock your free first image. Check your inbox for our link. <button type="button" class="btn ghost small" id="resendVerify">Resend email</button>'
    : "Your free first image unlocks once your email is verified. Email confirmation isn't switched on yet, so contact support and we'll verify you by hand.";
  document.body.insertBefore(bar, document.body.firstChild.nextSibling);
  const b = bar.querySelector("#resendVerify");
  if (b) b.onclick = async () => {
    b.disabled = true;
    try { await api("/api/verify/resend", { method: "POST" }); b.textContent = "Sent, check your inbox"; }
    catch (e) { b.textContent = (e && e.message) || "Try again later"; setTimeout(() => { b.disabled = false; b.textContent = "Resend email"; }, 60000); }
  };
}

async function boot() {
  cfg = await api("/api/config");
  const me = await api("/api/me");
  if (!me.user) {
    const next = location.pathname + location.search;
    location.replace("/login.html?next=" + encodeURIComponent(next));
    return;
  }
  user = me.user;
  showVerifyBanner(user);
  const s = await api("/api/shop");
  shop = s.shop;
  cfg.billing = s.billing;
  const whoEl = $("#who");
  const logoutBtn = $("#logout");
  if (user && user.name) {
    let whoLine = [user.name, user.role, user.plan].filter(Boolean).join(" · ");
    if (!entitled() && user.plan !== "trial") whoLine += " · trial";
    if (user.halftoneIncluded) whoLine += " · HT∞";
    else if (user.halftoneCredits > 0) whoLine += " · HT×" + user.halftoneCredits;
    if (whoEl) whoEl.textContent = whoLine;
    if (logoutBtn) {
      logoutBtn.hidden = false;
      logoutBtn.style.display = "";
      logoutBtn.onclick = async () => { await api("/api/logout", { method: "POST" }); location.href = "/"; };
    }
  } else {
    if (whoEl) whoEl.textContent = "";
    if (logoutBtn) {
      logoutBtn.hidden = true;
      logoutBtn.onclick = null;
    }
  }
  if (shop) {
    $("#sideName").textContent = shop.name;
    if (shop.logo_path) $("#sideLogo").src = shop.logo_path;
  }
  if (user && cfg && Array.isArray(cfg.adminModules)) await loadAdminScripts(cfg.adminModules);
  const allToolsBtn = document.getElementById("allTools");
  if (allToolsBtn) allToolsBtn.onclick = () => showAllTools();
  const startMethod = consumeStartMethod();
  if (startMethod) makeMethod = startMethod;
  consumeStartTool();
  if (!canFloor()) view = "board";
  nav();
  render();
}

function consumeStartMethod() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("method") || "";
  const fromStore = sessionStorage.getItem("decoclub_start_method") || "";
  const choices = methodChoices();
  const method = choices.indexOf(fromUrl) !== -1 ? fromUrl : (choices.indexOf(fromStore) !== -1 ? fromStore : "");
  sessionStorage.removeItem("decoclub_start_method");
  if (method && (params.get("method") || params.get("station"))) {
    // keep tool= in URL until consumeStartTool runs; strip below if no tool
    if (!params.get("tool")) history.replaceState({}, "", "/app.html");
  }
  return method;
}

/** Deep-link ?tool= keeps the Studio on that tool and hides the other modes. */
function consumeStartTool() {
  const params = new URLSearchParams(location.search);
  const fromUrl = (params.get("tool") || "").toLowerCase();
  const fromStore = (sessionStorage.getItem("decoclub_start_tool") || "").toLowerCase();
  sessionStorage.removeItem("decoclub_start_tool");
  const picked = suiteToolById(fromUrl || fromStore);
  suiteTool = picked ? picked.id : "";
  if (suiteTool === "halftones") {
    htPanelWantOpen = true;
    station = "art";
  } else if (suiteTool) {
    htPanelWantOpen = false;
    station = picked.station || "art";
  }
  if (params.get("tool") || params.get("method") || params.get("station") || suiteTool) {
    history.replaceState({}, "", suiteTool ? ("/app?tool=" + encodeURIComponent(suiteTool)) : "/app");
  }
  syncSuiteChrome();
  return suiteTool;
}

function titleFromFile(file) {
  const n = (file && file.name) || "Art";
  const cut = n.replace(/\.[^.]+$/, "");
  return cut || n;
}
function loadImageEl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read that image on this PC"));
    img.src = url;
  });
}
async function rasterToPngFile(src, name) {
  let w = 0, h = 0, drawer = null, bmp = null, url = null;
  if (typeof src !== "string" && typeof createImageBitmap === "function") {
    try {
      bmp = await createImageBitmap(src);
      w = bmp.width;
      h = bmp.height;
      drawer = (ctx, dw, dh) => ctx.drawImage(bmp, 0, 0, dw, dh);
    } catch (e) { bmp = null; }
  }
  if (!drawer) {
    url = typeof src === "string" ? src : URL.createObjectURL(src);
    try {
      const img = await loadImageEl(url);
      w = img.naturalWidth || img.width;
      h = img.naturalHeight || img.height;
      drawer = (ctx, dw, dh) => ctx.drawImage(img, 0, 0, dw, dh);
    } finally {
      if (typeof src !== "string" && url) URL.revokeObjectURL(url);
    }
  }
  if (!w || !h || !drawer) throw new Error("Could not read that artwork");
  const max = 2400;
  let dw = w, dh = h;
  if (w > max || h > max) {
    const s = max / Math.max(w, h);
    dw = Math.round(w * s);
    dh = Math.round(h * s);
  }
  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  drawer(canvas.getContext("2d"), dw, dh);
  if (bmp && bmp.close) try { bmp.close(); } catch (e) {}
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Could not convert artwork")), "image/png");
  });
  const base = String(name || "art").replace(/\.[^.]+$/, "") + ".png";
  return new File([blob], base, { type: "image/png" });
}
function mustConvertToPng(file) {
  const n = (file && file.name) || "";
  const typ = (file && file.type) || "";
  return typ === "image/jpeg" || typ === "image/jpg" || typ === "image/webp" || typ === "image/bmp" ||
    /\.(jpe?g|webp|bmp)$/i.test(n);
}
/** XHR upload with progress + timeout (fetch has no upload progress). */
function uploadWithProgress(url, formData, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 120000;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { xhr.abort(); } catch (e) {}
      const err = new Error("Upload timed out. Check your connection and try again.");
      err.code = "UPLOAD_TIMEOUT";
      reject(err);
    }, timeoutMs);
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (ev) => {
      if (!onProgress || !ev.lengthComputable) {
        if (onProgress) onProgress(null);
        return;
      }
      const pct = Math.max(0, Math.min(100, Math.round((ev.loaded / ev.total) * 100)));
      onProgress(pct);
    };
    xhr.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = new Error("Network stalled. Check your connection and try again.");
      err.code = "NETWORK";
      reject(err);
    };
    xhr.onabort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = new Error("Upload timed out. Check your connection and try again.");
      err.code = "UPLOAD_TIMEOUT";
      reject(err);
    };
    xhr.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch (e) { data = {}; }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data: data });
    };
    xhr.send(formData);
  });
}
function showUploadRetry(errEl, message, onRetry) {
  if (!errEl) return;
  errEl.textContent = "";
  errEl.appendChild(document.createTextNode(message + " "));
  if (typeof onRetry === "function") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn ghost small";
    btn.textContent = "Retry";
    btn.onclick = () => { errEl.textContent = ""; onRetry(); };
    errEl.appendChild(btn);
  }
}

async function fileToPng(file) {
  if (!file) return file;
  const n = file.name || "";
  const typ = file.type || "";
  if (typ === "application/pdf" || /\.pdf$/i.test(n)) throw new Error("Export the PDF as PNG or JPG first");
  // Always normalize (incl. large Dirt-Devils-style PNGs) to max-2400 PNG before POST.
  try {
    return await rasterToPngFile(file, n || "art.png");
  } catch (err) {
    if (mustConvertToPng(file) || typ === "image/png" || /\.png$/i.test(n)) {
      throw new Error("Could not prepare that artwork as PNG. Export a PNG from your design app and drop that.");
    }
    return file;
  }
}
async function ensurePngArtwork(job) {
  const pth = job && job.file_path;
  if (!pth) throw new Error("Drop artwork first");
  if (/\.png$/i.test(pth)) return job;
  const file = await rasterToPngFile(pth, "art.png");
  const fd = new FormData();
  fd.append("artwork", file);
  fd.append("remove_bg", "0");
  showArtWorking("Uploading…");
  try {
    const res = await uploadWithProgress("/api/jobs/" + job.id + "/artwork", fd, {
      onProgress: (pct) => showArtWorking(pct == null ? "Uploading…" : ("Uploading " + pct + "%…")),
    });
    if (!res.ok) throw new Error(shopHttpError(res.status, res.data, "Could not convert artwork"));
    return res.data.job || job;
  } finally {
    hideArtWorking();
  }
}
async function startJobFromFile(file, method) {
  if (!file) throw new Error("Pick a file first.");
  const lastFile = file;
  const lastMethod = method;
  showArtWorking("Preparing art…");
  try {
    file = await fileToPng(file);
    const fd = new FormData();
    fd.append("title", titleFromFile(file));
    const methodForTool = suiteTool === "stones" ? "rhinestone" : (suiteTool === "upscale" || suiteTool === "halftones" || suiteTool === "bgremove" ? "dtf" : method);
    fd.append("method", methodChoices().indexOf(methodForTool) !== -1 ? methodForTool : "apparel");
    const upWidth = document.getElementById("upWidth");
    fd.append("width_in", suiteTool === "upscale" && upWidth && upWidth.value ? String(upWidth.value) : "10");
    fd.append("height_in", "10");
    fd.append("qty", "1");
    if (suiteTool) fd.append("suite_tool", suiteTool);
    let removeBg = "0";
    if (suiteTool === "bgremove") removeBg = "1";
    else if (suiteTool === "upscale") {
      const upBg = document.getElementById("upRemoveBg");
      removeBg = upBg && upBg.checked ? "1" : "0";
    } else {
      const rm = document.getElementById("rmbg");
      removeBg = rm && rm.checked ? "1" : "0";
    }
    fd.append("remove_bg", removeBg);
    fd.append("artwork", file);
    showArtWorking("Uploading…");
    const res = await uploadWithProgress("/api/jobs", fd, {
      onProgress: (pct) => showArtWorking(pct == null ? "Uploading…" : ("Uploading " + pct + "%…")),
    });
    if (!res.ok) throw new Error(shopHttpError(res.status, res.data, "Could not start"));
    hideArtWorking();
    openJob(res.data.job.id, "art");
  } catch (err) {
    hideArtWorking();
    const box = document.getElementById("makeErr") || document.getElementById("err");
    if (box && (err.code === "UPLOAD_TIMEOUT" || err.code === "NETWORK")) {
      showUploadRetry(box, err.message || "Upload failed.", () => startJobFromFile(lastFile, lastMethod));
      return;
    }
    throw err;
  }
}

function processTileInner(m) {
  const meta = methodMeta(m);
  return `<svg class="process-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${meta.icon}</svg><span class="process-name">${meta.label}</span><span class="process-out">${meta.outcome}</span><span class="process-go">Start job</span>`;
}
function processGridHtml(asButtons) {
  return `<div class="process-grid">${methodChoices().map((m) => (
    asButtons
      ? `<button type="button" class="process-tile" data-start-method="${m}">${processTileInner(m)}</button>`
      : `<a class="process-tile" href="/start.html?method=${m}">${processTileInner(m)}</a>`
  )).join("")}</div>`;
}

async function render() {
  syncSuiteChrome();
  if (view === "job" && currentJob) return renderJob(currentJob);
  if (view === "make") return renderMake();
  if (view === "intake") return renderIntake();
  if (view === "clients") return renderClients();
  if (view === "settings") return renderSettings();
  return renderBoard();
}

function toolDeskHtml(tool) {
  const vectorize = tool.id === "vectorize";
  const title = vectorize ? "Drop art. Vectorize. Recolor. Export." : tool.name;
  let extra = "";
  if (tool.id === "upscale") {
    extra = `
      <label class="suite-field">Target print width (inches)
        <input id="upWidth" type="number" min="1" max="16" step="0.25" value="12" />
      </label>
      <p class="muted">Default 12 in. 10 in is a common chest size. 16 in is the max so the 300 DPI file stays fast.</p>
      <label class="remember"><input id="upRemoveBg" type="checkbox" /> Remove background</label>
      <p class="mono" id="upscaleDims">72 DPI → 300 DPI</p>`;
  } else if (tool.id === "bgremove") {
    extra = `<p class="muted">Background removal runs as the file uploads. Then download a transparent PNG and an SVG.</p>`;
  } else if (tool.id === "halftones") {
    extra = `<p class="muted">Halftone controls open on the art. Other tool panels stay out of the way.</p>`;
  } else if (tool.id === "stones") {
    extra = `<p class="muted">Drop the artwork, then build the crystal layout.</p>`;
  } else if (vectorize) {
    extra = `<label class="remember"><input id="rmbg" type="checkbox" checked /> Background removal, one click</label>`;
  }
  return `
    <div class="make-home">
      <h1 class="make-title">${escapeHtml(title)}</h1>
      <p class="muted make-sub">${escapeHtml(tool.blurb || "")}</p>
      ${paywallNote()}
      <div class="make-drop" id="makeDrop" tabindex="0" role="button" aria-label="${escapeHtml(title)}">
        <div class="drop-hint">
          <strong>${escapeHtml(title)}</strong>
          <span>PNG, JPG, or WebP</span>
        </div>
        <input id="makeFile" type="file" accept="image/*,.svg,.pdf" hidden />
      </div>
      ${extra}
      ${vectorize && cfg.imagine ? `<div class="card" style="margin-top:18px">
        <div class="kicker">AI Generate</div>
        <p class="muted">Describe a graphic — we place it on this job.</p>
        <textarea id="imaginePrompt" rows="2" placeholder="A varsity mascot, clean print-ready graphic on transparent"></textarea>
        <button class="btn small" type="button" id="imagineGo">AI Generate</button>
      </div>` : ""}
      <p class="notice" id="makeErr"></p>
    </div>`;
}
async function renderMake() {
  if (!canFloor()) {
    view = "board";
    nav();
    return renderBoard();
  }
  if (methodChoices().indexOf(makeMethod) === -1) makeMethod = "apparel";
  const tool = suiteToolById(suiteTool);
  if (!tool) {
    main.innerHTML = launcherHtml();
    return;
  }
  main.innerHTML = toolDeskHtml(tool);
  const upWidth = $("#upWidth");
  if (upWidth) {
    const paint = () => {
      const dims = $("#upscaleDims");
      if (!dims) return;
      const inches = Math.min(16, Math.max(1, Number(upWidth.value) || 12));
      dims.textContent = "72 DPI → " + Math.round(inches * 300) + " px wide at 300 DPI (" + inches + " in)";
    };
    upWidth.oninput = paint;
    paint();
  }
  const drop = $("#makeDrop");
  const fileEl = $("#makeFile");
  async function take(file) {
    try {
      await startJobFromFile(file, makeMethod);
    } catch (err) {
      const box = $("#makeErr") || $("#err");
      if (box) box.textContent = err.message;
    }
  }
  drop.onclick = () => fileEl.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileEl.click(); } };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("dragover"); };
  drop.ondragleave = () => drop.classList.remove("dragover");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) take(f);
  };
  fileEl.onchange = () => { if (fileEl.files && fileEl.files[0]) take(fileEl.files[0]); };
  const go = $("#imagineGo");
  if (go) go.onclick = async () => {
    const prompt = ($("#imaginePrompt") && $("#imaginePrompt").value || "").trim();
    if (!prompt) { $("#makeErr").textContent = "Describe the graphic first."; return; }
    try {
      const data = await api("/api/imagine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: prompt, method: makeMethod }) });
      openJob(data.job.id, "art");
    } catch (err) { $("#makeErr").textContent = err.message; }
  };
}

async function renderBoard() {
  const q = ($("#q") && $("#q").value) || "";
  const st = ($("#st") && $("#st").value) || "";
  const cid = ($("#cid") && $("#cid").value) || "";
  const qs = new URLSearchParams();
  if (q) qs.set("q", q); if (st) qs.set("status", st); if (cid) qs.set("client_id", cid);
  const [{ jobs }, clientsWrap] = await Promise.all([
    api("/api/jobs?" + qs.toString()),
    canFloor() ? api("/api/clients").catch(() => ({ clients: [] })) : { clients: [] },
  ]);
  const statuses = cfg.statuses.length ? cfg.statuses : Object.keys(STAT_LABEL);
  const emptyBoard = jobs.length === 0 && !q && !st && !cid;
  let boardJobs = "";
  if (!emptyBoard) {
    const kanban = statuses.map((s) => {
      const col = jobs.filter((j) => j.status === s);
      const cards = col.map((j) => `
          <div class="job-card" data-open="${j.id}">
            <b>${escapeHtml(j.title)}</b>
            <span>${j.method} · ${j.width_in}×${j.height_in} · qty ${j.qty}</span><br/>
            <span>${j.due_at ? "due " + escapeHtml(j.due_at) : "Open to vectorize"}</span>
          </div>`).join("");
      return `<div class="col"><h4>${STAT_LABEL[s]||s} · ${col.length}</h4>${cards}</div>`;
    }).join("");
    const rows = jobs.map((j) => `<tr>
          <td>${escapeHtml(j.title)}</td><td class="muted">${(j.client_id||"—").slice(0,8)}</td>
          <td>${j.method}</td><td><span class="status">${STAT_LABEL[j.status]||j.status}</span></td>
          <td>${escapeHtml(j.due_at||"—")}</td>
          <td><button class="btn ghost small" data-open="${j.id}">Open</button></td>
        </tr>`).join("");
    boardJobs = `
    <div class="toolbar">
      <input id="q" placeholder="Search title, method, notes" value="${escapeHtml(q)}" />
      <select id="st"><option value="">All statuses</option>${statuses.map((s) => `<option value="${s}" ${s===st?"selected":""}>${STAT_LABEL[s]||s}</option>`).join("")}</select>
      <select id="cid"><option value="">All clients</option>${clientsWrap.clients.map((c) => `<option value="${c.id}" ${c.id===cid?"selected":""}>${escapeHtml(c.name)}</option>`).join("")}</select>
      <span class="muted">${jobs.length} jobs</span>
    </div>
    <div class="kanban">${kanban}</div>
    <h3 style="margin-top:28px">List</h3>
    <table>
      <thead><tr><th>Title</th><th>Client</th><th>Method</th><th>Status</th><th>Due</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }
  main.innerHTML = `
    <div class="row">
      <h1 style="margin:0;font-size:32px">Designs</h1>
      ${canFloor() ? `<button class="btn ghost small" id="goNew">More details</button>` : ""}
    </div>
    ${emptyBoard && !canFloor() ? `<p class="muted">No jobs yet.</p>` : ""}
    ${boardJobs}`;

  const go = $("#goNew"); if (go) go.onclick = () => { view = "intake"; nav(); render(); };
  ["q","st","cid"].forEach((id) => { const el = $("#"+id); if (el) el.onchange = () => renderBoard(); if (el && id==="q") el.onkeydown = (e) => { if (e.key==="Enter") renderBoard(); }; });
  main.querySelectorAll("[data-open]").forEach((b) => { b.onclick = () => openJob(b.dataset.open); });
}

function openJob(id, st) {
  currentJob = id;
  view = "job";
  if (st) station = st;
  else if (!suiteTool) station = "art";
  else station = (suiteToolById(suiteTool) && suiteToolById(suiteTool).station) || "art";
  if (suiteTool === "halftones") htPanelWantOpen = true;
  nav();
  render();
}

async function renderIntake() {
  const { clients } = await api("/api/clients").catch(() => ({ clients: [] }));
  main.innerHTML = `
    <h1 style="font-size:28px;margin-top:0">Intake</h1>
    <p class="muted">Create the job, attach art, assign a client and due date. A proof link is minted immediately (unguessable token). Download a booth poster after save.</p>
    <form class="form" id="jobForm">
      <label>Title</label><input name="title" required placeholder="Club hats — Saturday market" />
      <label>Method</label>
      <select name="method">${methodChoices().map((m) => `<option value="${m}">${methodMeta(m).label}</option>`).join("")}</select>
      <label>Client</label>
      <select name="client_id"><option value="">Unassigned</option>${clients.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select>
      <label>Due date</label><input name="due_at" type="date" />
      <div class="row">
        <div style="flex:1"><label>Width (in)</label><input name="width_in" type="number" step="0.1" value="10" /></div>
        <div style="flex:1"><label>Height (in)</label><input name="height_in" type="number" step="0.1" value="10" /></div>
        <div style="flex:1"><label>Qty</label><input name="qty" type="number" value="1" /></div>
      </div>
      <label>Shop margin %</label><input name="margin_pct" type="number" step="0.1" value="${shop && shop.margin_pct != null ? shop.margin_pct : 20}" />
      <label>Notes</label><textarea name="notes" rows="2"></textarea>
      <label>Artwork</label><input name="artwork" type="file" accept="image/*,.svg,.pdf" />
      <label class="remember"><input name="remove_bg" type="checkbox" checked /> Background removal, one click</label>
      <p class="notice" id="err"></p>
      <button class="btn" type="submit">Create job</button>
    </form>`;
  $("#jobForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/jobs", { method: "POST", credentials: "include", body: new FormData(e.target) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      openJob(data.job.id);
    } catch (err) { $("#err").textContent = err.message; }
  };
}

async function renderJob(id) {
  const { job, events } = await api("/api/jobs/" + id);
  const shopControls = canFloor();
  const PRICE_STATION_ENABLED = false; // apparel quote UI off until David turns it back on
  const extras = studioExtras();
  const extraTabs = extras.filter((m) => m && m.tab).map((m) => m.tab);
  const tabs = [
    ["art","Art"], ...extraTabs, ["export","Export"],["mockup","Mockup"],
    ...(PRICE_STATION_ENABLED ? [["price","Price"]] : []),
    ["proof","Proof"],["overview","Overview"],["comments","Comments"]
  ];
  const known = tabs.map((t) => t[0]).concat(["produce"]);
  if (!PRICE_STATION_ENABLED && station === "price") station = "art";
  if (known.indexOf(station) === -1) station = "art";
  main.innerHTML = `
    <div class="studio-top">
      <button class="btn ghost small" id="back">← Board</button>
      <div class="tabs builder-tabs" role="tablist" aria-label="Service">${tabs.map(([k,l]) => `<button data-tab="${k}" class="${station===k?"on":""}">${l}</button>`).join("")}</div>
      <h1 class="studio-title">${escapeHtml(job.title)}</h1>
      <span class="status">${STAT_LABEL[job.status]||job.status}</span>
      <span class="muted studio-meta">${job.method} · ${job.width_in}×${job.height_in} in · qty ${job.qty}${job.due_at ? " · due " + escapeHtml(job.due_at) : ""}</span>
    </div>
    ${paywallNote()}
    <div id="station"></div>
    <h3>Timeline</h3>
    <ul class="muted">${(events||[]).map((e) => `<li>${escapeHtml(sanitizeEventMessage(e.message))} · ${new Date(e.created_at).toLocaleString()}</li>`).join("")}</ul>`;
  $("#back").onclick = () => { currentJob = null; view = "board"; nav(); render(); };
  main.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => { station = b.dataset.tab; renderJob(id); }; });
  const el = $("#station");
  const extra = extras.find((m) => m && m.id === station && typeof m.open === "function");
  if (extra) return extra.open(el, job, shopControls);
  if (station === "art") return fillArt(el, job, shopControls);
  if (station === "mockup") return fillMockup(el, job, shopControls);
  if (station === "price" && PRICE_STATION_ENABLED) return fillPrice(el, job, shopControls);
  if (station === "proof") return fillProof(el, job, shopControls);
  if (station === "produce" || station === "export") return fillProduce(el, job, shopControls);
  if (station === "comments") return fillComments(el, job);
  fillOverview(el, job, shopControls);
}

function fillOverview(el, job, shopControls) {
  el.innerHTML = `
    <div class="split">
      <div class="preview">${job.mockup_path ? `<img src="${job.mockup_path}" alt="Mockup" />` : `<span class="muted">No mockup yet</span>`}</div>
      <div class="card">
        <p>Art ${job.file_path ? "in" : "missing"} · blank ${escapeHtml(job.blank || "auto")} · ${escapeHtml(job.placement || "center")}</p>
        ${shopControls ? `
          <form id="meta" class="form">
            <label>Title</label><input name="title" value="${escapeHtml(job.title)}" />
            <label>Due</label><input name="due_at" type="date" value="${escapeHtml(job.due_at||"")}" />
            <label>Status</label>
            <select name="status">${Object.keys(STAT_LABEL).map((s) => `<option value="${s}" ${s===job.status?"selected":""}>${STAT_LABEL[s]}</option>`).join("")}</select>
            <label>Notes</label><textarea name="notes" rows="3">${escapeHtml(job.notes)}</textarea>
            <button class="btn small" type="submit">Save</button>
          </form>` : `<p>${escapeHtml(job.notes||"")}</p>
          ${job.status !== "approved" && job.status !== "done" && job.status !== "in_production" ? `<button class="btn" id="approve">Approve</button>` : `<p class="ok">Approved or already in production.</p>`}`}
      </div>
    </div>`;
  const meta = $("#meta");
  if (meta) meta.onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(meta).entries());
    await api("/api/jobs/" + job.id, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: fd.title, due_at: fd.due_at, notes: fd.notes }) });
    await api("/api/jobs/" + job.id + "/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: fd.status }) });
    renderJob(job.id);
  };
  const ap = $("#approve");
  if (ap) ap.onclick = async () => {
    await api("/api/jobs/" + job.id + "/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "approved" }) });
    renderJob(job.id);
  };
}

let palettesCache = null;
async function loadPalettes() {
  if (palettesCache) return palettesCache;
  try { palettesCache = await api("/api/palettes"); } catch (e) { palettesCache = { pantone: [], vinyl: [], thread: [], stone: [], process: [] }; }
  return palettesCache;
}
function palSelect(kind, palettes, currentHex) {
  const list = (palettes && palettes[kind]) || [];
  const opts = list.map((c) => `<option value="${escapeHtml(c.hex)}" ${String(c.hex).toLowerCase()===String(currentHex||"").toLowerCase()?"selected":""}>${escapeHtml(c.name)}</option>`).join("");
  return `<select data-pal="${kind}"><option value="">${kind}</option>${opts}</select>`;
}

async function fillArt(el, job, shopControls) {
  const pals = shopControls ? await loadPalettes() : { pantone: [], vinyl: [], thread: [], stone: [], madeiraRayon: [], madeiraPolyneon: [] };
  const pantones = pals.pantone || [];
  const layers = (job.vector && job.vector.layers) || [];
  const vzMeta = (job.vector && job.vector.meta) || {};
  const lastSet = vzMeta.settings || {};
  function loadVzPref(key, fallback) {
    try {
      const v = localStorage.getItem("dc_vz_" + key);
      return v != null && v !== "" ? v : fallback;
    } catch (e) { return fallback; }
  }
  function saveVzPref(key, val) {
    try { localStorage.setItem("dc_vz_" + key, String(val)); } catch (e) { /* ignore */ }
  }
  function toPct(val, legacyMap, fallback) {
    if (val == null || val === "") return fallback;
    if (typeof val === "number" && Number.isFinite(val)) return Math.max(0, Math.min(100, Math.round(val)));
    const s = String(val).toLowerCase();
    if (legacyMap[s] != null) return legacyMap[s];
    const n = Number(val);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
    return fallback;
  }
  const DETAIL_LEGACY = { low: 15, simple: 15, medium: 50, balanced: 50, high: 85, fine: 85 };
  const SMOOTH_LEGACY = { low: 15, medium: 50, high: 85 };
  const CORNER_LEGACY = { sharp: 10, balanced: 50, smooth: 90 };
  const initDetail = toPct(lastSet.detail != null ? lastSet.detail : loadVzPref("detail", "50"), DETAIL_LEGACY, 50);
  const initSmooth = toPct(lastSet.smoothing != null ? lastSet.smoothing : loadVzPref("smoothing", "50"), SMOOTH_LEGACY, 50);
  const initCorner = toPct(lastSet.cornerSmooth != null ? lastSet.cornerSmooth : loadVzPref("corner", "50"), CORNER_LEGACY, 50);
  const initColorMode = loadVzPref("colorMode", "rgb");
  const vectorSrc = job.vector_preview || (job.vector_svg ? ("/api/jobs/" + job.id + "/preview.png") : "");
  const rasterFirst = suiteTool === "upscale" || suiteTool === "bgremove" || suiteTool === "stones";
  const rasterPath = (suiteTool === "upscale" && job.upscale_png) ? job.upscale_png : (job.file_path || "");
  const hasArt = !!((!rasterFirst && vectorSrc) || rasterPath || job.file_path);
  let previewOutline = false;
  try { previewOutline = localStorage.getItem("dcPreviewMode") === "outline"; } catch (e) { /* ignore */ }
  const preview = (!rasterFirst && vectorSrc)
    ? `<img id="artZoomImg" class="art-svg-host" alt="Vector preview" draggable="false" />`
    : (rasterPath ? `<img id="artZoomImg" class="art-svg-host" src="${escapeHtml(rasterPath)}" alt="Art" draggable="false" />` : `<div class="drop-hint"><strong>Drop art here</strong><span>PNG, JPG, or WebP</span></div>`);
  function layerRgb(L) {
    if (L.rgb) return L.rgb;
    const h = String(L.hex || "#111111").replace("#", "");
    const full = h.length === 3 ? h[0]+h[0]+h[1]+h[1]+h[2]+h[2] : h;
    return {
      r: parseInt(full.slice(0, 2), 16) || 0,
      g: parseInt(full.slice(2, 4), 16) || 0,
      b: parseInt(full.slice(4, 6), 16) || 0,
    };
  }
  function layerCmyk(L) {
    if (L.cmyk) return L.cmyk;
    return { c: 0, m: 0, y: 0, k: 0 };
  }
  function layerLabel(L) {
    const rgb = layerRgb(L);
    const cmyk = layerCmyk(L);
    const rgbS = "R" + rgb.r + " G" + rgb.g + " B" + rgb.b;
    const cmykS = "C" + cmyk.c + " M" + cmyk.m + " Y" + cmyk.y + " K" + cmyk.k;
    return rgbS + " · " + cmykS + (L.pantone ? " · " + L.pantone : "");
  }
  const layerRows = layers.map((L, i) => {
    const rgb = layerRgb(L);
    const cmyk = layerCmyk(L);
    return `
    <div class="layer-row" data-layer="${i}">
      <svg class="layer-ico" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" fill="${escapeHtml(L.hex)}" stroke="#1a2330" stroke-width="1"/></svg>
      <div class="layer-meta">
        <span class="layer-name">${escapeHtml(layerLabel(L))}</span>
        <span class="layer-sub muted">${escapeHtml((L.hex || "").toUpperCase())}</span>
        <div class="layer-color-edit layer-edit-rgb">
          <label>R <input type="number" class="layer-rgb" data-ch="r" min="0" max="255" value="${rgb.r}" /></label>
          <label>G <input type="number" class="layer-rgb" data-ch="g" min="0" max="255" value="${rgb.g}" /></label>
          <label>B <input type="number" class="layer-rgb" data-ch="b" min="0" max="255" value="${rgb.b}" /></label>
        </div>
        <div class="layer-color-edit layer-edit-cmyk">
          <label>C <input type="number" class="layer-cmyk" data-ch="c" min="0" max="100" value="${cmyk.c}" /></label>
          <label>M <input type="number" class="layer-cmyk" data-ch="m" min="0" max="100" value="${cmyk.m}" /></label>
          <label>Y <input type="number" class="layer-cmyk" data-ch="y" min="0" max="100" value="${cmyk.y}" /></label>
          <label>K <input type="number" class="layer-cmyk" data-ch="k" min="0" max="100" value="${cmyk.k}" /></label>
        </div>
      </div>
      <input type="color" class="layer-pick" value="${escapeHtml((L.hex || "#111111").slice(0, 7))}" title="Pick print color" />
      ${pantones.length ? `<select class="layer-pal" data-layer="${i}" title="Optional spot color match">
        <option value="">Spot color (optional)</option>
        ${pantones.map((c) => `<option value="${escapeHtml(c.hex)}" data-name="${escapeHtml(c.name)}" ${String(L.pantone||"")===String(c.name)?"selected":""}>${escapeHtml(c.name)}</option>`).join("")}
      </select>` : ""}
    </div>`;
  }).join("") || `<p class="muted">Click Vectorize after you drop art.</p>`;

  function detailReadout(pct) {
    const colors = Math.round(3 + (Number(pct) / 100) * 21);
    return colors + " colors";
  }
  function smoothReadout(pct) {
    return Math.round(Number(pct)) + "% smooth";
  }
  function cornerReadout(pct) {
    return Math.round(Number(pct)) + "% soft";
  }
  function continuousSliderRow(id, label, tip, current, left, right, readout) {
    const v = Math.max(0, Math.min(100, Math.round(Number(current) || 0)));
    return `<div class="vz-control" id="${id}">
      <div class="vz-control-head">
        <span class="vz-control-label">${escapeHtml(label)}</span>
        <span class="vz-slider-val" id="${id}Val">${escapeHtml(readout(v))}</span>
      </div>
      <input type="range" class="vz-slider" id="${id}Slider" min="0" max="100" step="1" value="${v}" aria-label="${escapeHtml(label)}" title="${escapeHtml(tip)}" />
      <div class="vz-slider-ends muted"><span>${escapeHtml(left)}</span><span>${escapeHtml(right)}</span></div>
    </div>`;
  }

  const usedLine = lastSet.detail != null
    ? `<p class="muted vz-used" id="vzUsed" data-suite="vectorize">Last run · Detail ${escapeHtml(detailReadout(toPct(lastSet.detail, DETAIL_LEGACY, 50)))} · Smoothing ${escapeHtml(smoothReadout(toPct(lastSet.smoothing, SMOOTH_LEGACY, 50)))} · Corners ${escapeHtml(cornerReadout(toPct(lastSet.cornerSmooth, CORNER_LEGACY, 50)))}</p>`
    : `<p class="muted vz-used" id="vzUsed" data-suite="vectorize" hidden></p>`;

  const extras = studioExtras();
  const RAIL_ICO = {
    upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
    vectorize: '<path d="M4 17l4-10 4 6 3-4 5 8"/><path d="M4 19h16"/>',
    halftones: '<circle cx="6" cy="8" r="1.4"/><circle cx="12" cy="6" r="2"/><circle cx="18" cy="9" r="1.2"/><circle cx="8" cy="14" r="1.8"/><circle cx="14" cy="15" r="1.3"/><circle cx="19" cy="16" r="1.6"/>',
    colors: '<circle cx="12" cy="12" r="8"/><circle cx="9" cy="10" r="1.3"/><circle cx="14" cy="9" r="1.3"/><circle cx="15" cy="14" r="1.3"/>',
    clean: '<path d="M4 20l7-7"/><path d="M14 4l6 6-8 8-6-6z"/>',
    export: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  };
  extras.forEach((m) => { if (m && m.id && m.railIcon) RAIL_ICO[m.id] = m.railIcon; });
  const railBtn = (key, label, suite) => `<button type="button" class="rail-btn" data-rail="${key}" data-suite="${suite || "shared"}" title="${escapeHtml(label)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${RAIL_ICO[key]}</svg><span>${escapeHtml(label)}</span></button>`;
  const upMeta = job.upscale || null;
  const upLine = upMeta && upMeta.src_px && upMeta.out_px
    ? (upMeta.src_px[0] + " × " + upMeta.src_px[1] + " px · " + (upMeta.src_dpi || 72) + " DPI → " + upMeta.out_px[0] + " × " + upMeta.out_px[1] + " px · " + upMeta.width_in + " × " + upMeta.height_in + " in at 300 DPI · " + upMeta.seconds + "s")
    : "72 DPI → 300 DPI. Set the print width, then upscale.";
  const upWidthVal = (upMeta && upMeta.width_in) || 12;
  const exportPanel = `
        ${shopControls && (layers.length || jobHasVector(job)) ? `<div data-suite="vectorize halftones"><div class="export-grid export-hero art-dl">
          <a href="/api/export/${job.id}/art.svg">Download SVG</a>
          <a href="/api/export/${job.id}/art.eps">Download EPS</a>
          <a href="/api/export/${job.id}/art.pdf">Download PDF</a>
          <a href="/api/export/${job.id}/art.dxf">Download DXF</a>
        </div>
        <div class="export-grid art-dl">
          <a href="/api/export/${job.id}/art-300dpi.png" title="Transparent PNG, 300 DPI at print size">PNG 300 DPI</a>
          <a href="/api/export/${job.id}/art.tiff" title="Transparent TIFF, 300 DPI at print size">TIFF 300 DPI</a>
          <a href="/api/export/${job.id}/art-dtf.tiff" title="TIFF page 2 = white underbase, choked 0.35 px, none under semi-transparent pixels">DTF TIFF + white</a>
          <a href="/api/export/${job.id}/art-underbase.png" title="White underbase only, choked 0.35 px">White underbase</a>
        </div>
        <p class="muted">Vector: SVG / EPS / PDF / DXF (laser + cutter) · Raster: 300 DPI at true print size, transparent · DTF white choked in, none under soft edges</p></div>` : ""}
        ${shopControls && job.file_path && !vectorSrc ? `<div data-suite="vectorize bgremove"><div class="export-grid export-hero art-dl">
          <a href="/api/export/${job.id}/art.png" id="dlArtPng">Download PNG</a>
        </div>
        <p class="muted">Raster art · PNG</p></div>` : ""}
        ${shopControls ? `<div data-suite="upscale" class="export-grid export-hero art-dl" hidden>
          <a href="/api/export/${job.id}/art-upscaled-300dpi.png">Download 300 DPI PNG</a>
        </div>` : ""}
        ${shopControls ? `<div data-suite="bgremove" class="export-grid export-hero art-dl" hidden>
          <a href="/api/export/${job.id}/art-nobg.png">Download transparent PNG</a>
          <a href="/api/export/${job.id}/art-cutout.svg">Download SVG</a>
        </div>` : ""}
        ${shopControls ? `<div data-suite="stones" class="export-grid export-hero art-dl" hidden>
          <a href="/api/export/${job.id}/stones.svg">Stones SVG</a>
          <a href="/api/export/${job.id}/stones.csv">Stones CSV</a>
          <a href="/api/export/${job.id}/stones.plt">Stones PLT</a>
        </div>` : ""}
        ${extras.map((m) => {
          if (!shopControls || !m || typeof m.exportHtml !== "function") return "";
          if (m.needsArt && !(layers.length || jobHasVector(job))) return "";
          return m.exportHtml(job, { layers: layers });
        }).join("")}
        ${shopControls ? `<button type="button" class="btn ghost small studio-more-files" id="moreFilesBtn" data-suite="vectorize halftones">All production files →</button>` : ""}`;

  el.innerHTML = `
    <div class="studio art-simple${shopControls ? "" : " studio-view"}">
      ${shopControls ? `<nav class="studio-rail" aria-label="Studio tools">
        ${railBtn("upload", "Upload", "shared")}
        ${railBtn("vectorize", "Vectorize", "vectorize")}
        ${railBtn("halftones", "Halftones", "halftones")}
        ${layers.length ? railBtn("colors", "Colors", "vectorize") : ""}
        ${railBtn("clean", "Clean up", "bgremove")}
        ${extras.filter((m) => m && m.railLabel).map((m) => railBtn(m.id, m.railLabel, m.id)).join("")}
        ${railBtn("export", "Export", "shared")}
      </nav>` : ""}
      <aside class="studio-panel art-tools">
        ${shopControls ? `
        ${runRiskHtml(job)}
        <div class="art-actions" data-suite="vectorize halftones">
          <button class="btn primary" id="vectorizeBtn" type="button" data-suite="vectorize">Vectorize</button>
          <button class="btn primary" id="halftoneBtn" type="button" data-suite="halftones" title="Real vector half-tones for DTF / screen / print">Halftones</button>
          <button class="btn ghost" id="greyBtn" type="button" data-suite="vectorize">Hi-res greyscale</button>
          <button class="btn ghost" id="invertBtn" type="button" data-suite="vectorize">Invert black &amp; white</button>
        </div>
        <div class="ht-panel" id="htPanel" data-suite="halftones" hidden>
          <div class="ht-panel-head">
            <strong>Vector Halftones</strong>
            <span class="muted">Real SVG dots / lines · DTF &amp; screen</span>
            <span class="pill ht-status" id="htStatus" title="Halftones entitlement"></span>
          </div>
          <div class="ht-buy" id="htBuy" hidden>
            <button class="btn ghost small" type="button" id="htBuySingle" data-ht-product="halftone_single">Buy $3 / image</button>
            <button class="btn ghost small" type="button" id="htBuyPack" data-ht-product="halftone_pack10">Buy $20 for 10</button>
            <span class="muted" id="htBuyNote"></span>
          </div>
          <div class="ht-styles" id="htStyles" role="listbox" aria-label="Halftone styles"></div>
          <div class="ht-params">
            <label>LPI <input type="number" id="htLpi" min="8" max="120" step="1" value="45" title="Lines per inch" /></label>
            <label>Angle <input type="number" id="htAngle" min="0" max="90" step="1" value="45" title="Screen angle degrees" /></label>
            <label>Contrast <input type="number" id="htContrast" min="0.25" max="2.5" step="0.05" value="1" title="Dot gain / punch" /></label>
            <label class="ht-ko" title="Print knockout — transparent plate, ink marks only (true HT / DTF)"><input type="checkbox" id="htKnockout" checked /> Knockout (transparent)</label>
            <label class="ht-ink-toggle" title="Optional single-ink override for one-color shops"><input type="checkbox" id="htUseInk" /> Use one ink color</label>
            <label id="htInkRow" class="ht-ink-row" hidden>Ink override <input type="color" id="htColor" value="#000000" title="Ink override (optional)" /></label>
          </div>
          <p class="muted ht-color-hint" id="htColorHint">Art colors (DTF) — each mark keeps real artwork color; spot size follows tone.</p>
          <div class="ht-actions">
            <button class="btn primary" type="button" id="htApply">Apply halftone</button>
            <button class="btn ghost" type="button" id="htCancel">Close</button>
          </div>
          <p class="muted ht-hint" id="htHint">Live preview on the art · Apply commits real vector SVG.</p>
        </div>
        <div class="suite-pane" id="upscalePane" data-suite="upscale" hidden>
          <h2>300 DPI Upscaler</h2>
          <p class="muted">Low-res 72 DPI client art becomes a true 300 DPI print PNG. Edges stay sharp.</p>
          <p class="mono" id="upscaleDims">${escapeHtml(upLine)}</p>
          <label class="suite-field">Target print width (inches)
            <input id="upWidth" type="number" min="1" max="16" step="0.25" value="${escapeHtml(String(upWidthVal))}" />
          </label>
          <label class="remember"><input id="upRemoveBg" type="checkbox" ${upMeta && upMeta.remove_background ? "checked" : ""} /> Remove background</label>
          <div class="cta-row">
            <button class="btn primary" id="upscaleGo" type="button">Upscale to 300 DPI</button>
            <a class="btn" id="upscaleDl" href="/api/export/${job.id}/art-upscaled-300dpi.png">Download 300 DPI PNG</a>
          </div>
        </div>
        <div class="suite-pane" id="bgPane" data-suite="bgremove" hidden>
          <h2>Remove Background</h2>
          <p class="muted">One-click clean background removal. Download a transparent PNG and an SVG of the cutout.</p>
          <button class="btn primary" id="bgGo" type="button">Remove background</button>
          <div class="export-grid export-hero art-dl">
            <a href="/api/export/${job.id}/art-nobg.png">Download transparent PNG</a>
            <a href="/api/export/${job.id}/art-cutout.svg">Download SVG</a>
          </div>
        </div>
        <div class="suite-pane" id="stonesPane" data-suite="stones" hidden>
          <h2>Rhinestones</h2>
          <p class="muted">Build a crystal layout from the artwork. Download the template as SVG, CSV, and PLT.</p>
          <label class="suite-field">Stone size
            <select id="stoneSs">
              <option value="SS6">SS6</option>
              <option value="SS8">SS8</option>
              <option value="SS10" selected>SS10</option>
              <option value="SS12">SS12</option>
            </select>
          </label>
          <button class="btn primary" id="stonesGo" type="button">Build rhinestone template</button>
          <p class="mono" id="stonesCount">${job.stones && job.stones.count != null ? escapeHtml(String(job.stones.count) + " stones · " + (job.stones.ss || "")) : ""}</p>
        </div>
        <p class="muted vz-best" data-suite="vectorize">Best on clean logos and AI-generated art (smooth SVG/EPS for your design software). Soft photos and busy posters improve, but results vary.</p>
        <div class="vz-options" id="vzOptions" data-suite="vectorize">
          ${continuousSliderRow("detailRow", "Detail", "How many colors to keep — drag for live preview",
            initDetail, "Simple", "Fine art", detailReadout)}
          ${continuousSliderRow("smoothRow", "Smoothing", "Round out jagged edges from photos and screenshots",
            initSmooth, "Sharp", "Smooth", smoothReadout)}
          ${continuousSliderRow("cornerRow", "Corner smoothness", "Sharp corners for type and badges, soft for organic shapes",
            initCorner, "Sharp", "Soft", cornerReadout)}
          <p class="muted vz-live-hint" id="vzLiveHint">Drag sliders to update the preview live after Vectorize.</p>
          <p class="vz-updating-flag" id="vzUpdating" hidden>Updating…</p>
        </div>
        ${usedLine}` : ""}
        ${shopControls && layers.length ? `<div class="color-mode-row" id="colorModeRow" data-suite="vectorize">
          <span class="muted">Layer colors</span>
          <div class="vz-seg-row color-mode-seg">
            <button type="button" class="vz-seg${initColorMode==="rgb"?" on":""}" data-mode="rgb" title="Edit as screen RGB">RGB</button>
            <button type="button" class="vz-seg${initColorMode==="cmyk"?" on":""}" data-mode="cmyk" title="Edit as print CMYK">CMYK</button>
          </div>
        </div>` : ""}
        <div class="layer-list${shopControls ? " color-mode-" + initColorMode : ""}" id="layerList" data-suite="vectorize">${layerRows}</div>
        ${shopControls ? `
        <details class="art-more" id="artMore" data-suite="vectorize">
          <summary>More tools</summary>
          <label class="remember"><input id="rmbg" type="checkbox" checked /> Background removal, one click</label>
          <div class="row">
            <button class="btn small" type="button" id="replaceBtn">Replace art</button>
            <button class="btn small" type="button" id="rmbgBtn">Background removal, one click</button>
            <button class="btn ghost small" type="button" id="ko">Knockout white</button>
          </div>
          ${cfg.imagine ? `<div class="more-block">
            <label>AI Generate</label>
            <textarea id="imaginePrompt" rows="2" placeholder="Describe a new graphic"></textarea>
            <button class="btn small" type="button" id="imagineGo">AI Generate</button>
          </div>` : ""}
          <label>Notes</label>
          <textarea id="artn" rows="2">${escapeHtml(job.art_notes||"")}</textarea>
          <button class="btn small" id="saveArtN" type="button">Save notes</button>
        </details>
        <p class="notice" id="err"></p>` : ""}
      </aside>
      <section class="studio-center art-stage">
        <div class="canvas-toolbar">
          <span class="ct-name" title="Design name">${escapeHtml(job.title)}</span>
          <span class="ct-size mono" title="Print size">${escapeHtml(String(job.width_in))} × ${escapeHtml(String(job.height_in))} in</span>
          ${hasArt ? `<div class="zoom-bar">
            <button type="button" class="zoom-btn" id="zoomOut" title="Zoom out">−</button>
            <button type="button" class="zoom-btn" id="zoomFit" title="Fit">Fit</button>
            <button type="button" class="zoom-btn" id="zoomIn" title="Zoom in">+</button>
            <span class="zoom-readout" id="zoomRead">100%</span>
            <button type="button" class="zoom-btn" id="bgToggle" title="Switch preview background (light / dark) so every ink stands out">Light bg</button>
            ${vectorSrc ? `<button type="button" class="zoom-btn" id="outlineToggle" aria-pressed="${previewOutline ? "true" : "false"}" title="Outline preview — strokes only">Outline</button>` : ""}
          </div>` : ""}
          ${shopControls ? `<button type="button" class="btn small ct-export" id="ctExport" data-suite="vectorize halftones">Export</button>` : ""}
        </div>
        <div class="canvas-ruled">
          <div class="ruler ruler-x" aria-hidden="true"></div>
          <div class="ruler ruler-y" aria-hidden="true"></div>
          <div class="preview art-drop${hasArt ? " has-art" : ""}" id="artDrop" tabindex="0">
            <div class="art-zoom-inner" id="artZoomInner">${preview}</div>
            ${job.free_image ? `<div class="free-watermark" aria-hidden="true">DECOCLUB PRO · FREE PREVIEW · download is clean</div>` : ""}
            <div class="ht-preview-frame" id="htPreviewFrame" hidden aria-live="polite"></div>
          </div>
        </div>
        ${hasArt ? `<p class="muted canvas-hint">Scroll to zoom · drag to pan · pinch to zoom · drop new art to replace</p>` : ""}
        <input id="artFile" type="file" accept="image/*,.svg,.pdf" hidden />
      </section>
      <aside class="studio-right">
        <div class="studio-card price-card" data-suite="vectorize halftones">
          <div class="kicker">Pricing</div>
          <div class="price-line"><strong>$3</strong> <span class="muted">per image</span></div>
          <div class="price-line"><strong>$20</strong> <span class="muted">10-pack credits · never expire</span></div>
          <p class="muted">Re-tweak the same image free. $0 transaction fees.</p>
          ${user && (user.vectorCredits != null || user.halftoneCredits != null) ? `<p class="mono price-credits">Credits · Vectorize ${escapeHtml(String(user.vectorCredits != null ? user.vectorCredits : 0))} · Halftones ${escapeHtml(String(user.halftoneCredits != null ? user.halftoneCredits : 0))}</p>` : ""}
        </div>
        <div class="studio-card export-card" id="exportCard">
          <div class="kicker">Export</div>
          ${exportPanel}
          ${shopControls && !hasArt ? `<p class="muted">Drop art to unlock downloads.</p>` : ""}
          ${shopControls ? "" : `<p class="muted">Downloads are shop-only.</p>`}
        </div>
      </aside>
    </div>`;
  if (shopControls) {
    const railGo = {
      upload: () => $("#artFile").click(),
      vectorize: () => { const p = $("#htPanel"); if (p && !p.hidden) $("#htCancel").click(); const o = $("#vzOptions"); if (o) o.scrollIntoView({ block: "nearest", behavior: "smooth" }); const v = $("#vectorizeBtn"); if (v) v.focus(); },
      halftones: () => { const p = $("#htPanel"); if (p && p.hidden) $("#halftoneBtn").click(); if (p) p.scrollIntoView({ block: "nearest", behavior: "smooth" }); },
      colors: () => { const p = $("#htPanel"); if (p && !p.hidden) $("#htCancel").click(); const l = $("#layerList"); if (l) l.scrollIntoView({ block: "start", behavior: "smooth" }); },
      clean: () => { const m = $("#artMore"); if (m) { m.open = true; m.scrollIntoView({ block: "nearest", behavior: "smooth" }); } },
      export: () => { const c = $("#exportCard"); if (c) { c.classList.add("flash"); c.scrollIntoView({ block: "nearest", behavior: "smooth" }); setTimeout(() => c.classList.remove("flash"), 900); } },
    };
    el.querySelectorAll("[data-rail]").forEach((b) => { b.onclick = () => {
      el.querySelectorAll("[data-rail]").forEach((x) => x.classList.toggle("on", x === b));
      const go = railGo[b.dataset.rail];
      if (go) { go(); return; }
      const ex = extras.find((m) => m && m.id === b.dataset.rail);
      if (ex) { station = ex.id; renderJob(job.id); }
    }; });
    const ctx = $("#ctExport"); if (ctx) ctx.onclick = railGo.export;
    const mf = $("#moreFilesBtn"); if (mf) mf.onclick = () => { station = "export"; renderJob(job.id); };
  }
  if (!shopControls) { applySuiteFocus(el); return; }

  let vzDetail = initDetail;
  let vzSmooth = initSmooth;
  let vzCorner = initCorner;
  let colorMode = initColorMode === "cmyk" ? "cmyk" : "rgb";

  let vzLiveTimer = null;
  let vzLiveSeq = 0;
  let vzLiveAbort = null;
  function setVzUpdating(on) {
    const flag = $("#vzUpdating");
    const hint = $("#vzLiveHint");
    const row = $("#detailRow");
    if (flag) flag.hidden = !on;
    if (row) row.classList.toggle("vz-updating", !!on);
    if (hint) hint.textContent = on
      ? "Updating…"
      : "Drag sliders to update the preview live after Vectorize.";
  }
  function scheduleLiveVectorize(immediate) {
    if (!job.file_path) return;
    const errEl = $("#err");
    if (errEl) errEl.textContent = "";
    setVzUpdating(true);
    clearTimeout(vzLiveTimer);
    const go = async () => {
      vzLiveSeq += 1;
      const seq = vzLiveSeq;
      if (vzLiveAbort) { try { vzLiveAbort.abort(); } catch (e) {} }
      vzLiveAbort = typeof AbortController === "function" ? new AbortController() : null;
      try {
        await runVectorize(null, { live: true, signal: vzLiveAbort && vzLiveAbort.signal, seq: seq });
      } catch (err) {
        if (err && err.code === "ABORTED") return;
        if (seq !== vzLiveSeq) return;
        if (errEl) errEl.textContent = err.message;
      } finally {
        if (seq === vzLiveSeq) setVzUpdating(false);
      }
    };
    if (immediate) go();
    else vzLiveTimer = setTimeout(go, 400);
  }
  function bindContinuousSlider(rowId, prefKey, readout, setVal) {
    const slider = el.querySelector("#" + rowId + "Slider");
    const valEl = el.querySelector("#" + rowId + "Val");
    if (!slider) return;
    const apply = (n) => {
      const v = Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
      setVal(v);
      saveVzPref(prefKey, v);
      if (valEl) valEl.textContent = readout(v);
    };
    slider.oninput = () => { apply(slider.value); scheduleLiveVectorize(false); };
    slider.onchange = () => { apply(slider.value); scheduleLiveVectorize(true); };
    slider.addEventListener("pointerup", () => scheduleLiveVectorize(true));
  }
  bindContinuousSlider("detailRow", "detail", detailReadout, (v) => { vzDetail = v; });
  bindContinuousSlider("smoothRow", "smoothing", smoothReadout, (v) => { vzSmooth = v; });
  bindContinuousSlider("cornerRow", "corner", cornerReadout, (v) => { vzCorner = v; });

  function applyColorMode(mode) {
    colorMode = mode === "cmyk" ? "cmyk" : "rgb";
    saveVzPref("colorMode", colorMode);
    const list = el.querySelector(".layer-list");
    if (list) {
      list.classList.toggle("color-mode-rgb", colorMode === "rgb");
      list.classList.toggle("color-mode-cmyk", colorMode === "cmyk");
    }
    el.querySelectorAll("#colorModeRow .vz-seg").forEach((b) => {
      b.classList.toggle("on", b.getAttribute("data-mode") === colorMode);
    });
  }
  el.querySelectorAll("#colorModeRow .vz-seg").forEach((b) => {
    b.onclick = () => applyColorMode(b.getAttribute("data-mode"));
  });
  applyColorMode(colorMode);

  async function uploadArtwork(file) {
    if (!file) return;
    const lastFile = file;
    const errEl = $("#err");
    try {
      if (errEl) errEl.textContent = "";
      showArtWorking("Preparing art…");
      file = await fileToPng(file);
      const fd = new FormData();
      fd.append("artwork", file);
      let removeBg = "0";
      if (suiteTool === "bgremove") removeBg = "1";
      else if (suiteTool === "upscale") {
        const upBg = document.getElementById("upRemoveBg");
        removeBg = upBg && upBg.checked ? "1" : "0";
      } else {
        const rm = document.getElementById("rmbg");
        removeBg = rm && rm.checked ? "1" : "0";
      }
      fd.append("remove_bg", removeBg);
      showArtWorking("Uploading…");
      const res = await uploadWithProgress("/api/jobs/" + job.id + "/artwork", fd, {
        onProgress: (pct) => showArtWorking(pct == null ? "Uploading…" : ("Uploading " + pct + "%…")),
      });
      hideArtWorking();
      if (!res.ok) {
        if (errEl) errEl.textContent = shopHttpError(res.status, res.data, "Could not upload artwork");
        return;
      }
      renderJob(job.id);
    } catch (err) {
      hideArtWorking();
      if (errEl && (err.code === "UPLOAD_TIMEOUT" || err.code === "NETWORK")) {
        showUploadRetry(errEl, err.message || "Upload failed.", () => uploadArtwork(lastFile));
        return;
      }
      if (errEl) errEl.textContent = err.message || "Could not upload artwork";
    }
  }
  const artFile = $("#artFile");
  const drop = $("#artDrop");
  if (!artFile || !drop) return;
  artFile.onchange = () => { if (artFile.files && artFile.files[0]) uploadArtwork(artFile.files[0]); };
  const replaceBtn = $("#replaceBtn");
  if (replaceBtn) replaceBtn.onclick = () => artFile.click();
  if (!hasArt) {
    drop.onclick = () => artFile.click();
    drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); artFile.click(); } };
  }
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("dragover"); };
  drop.ondragleave = () => drop.classList.remove("dragover");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) uploadArtwork(f);
  };
  if (hasArt) bindArtZoom(drop, { jobId: job.id, vector: !!vectorSrc });
  $("#rmbgBtn").onclick = async () => {
    const btn = $("#rmbgBtn");
    const errEl = $("#err");
    try {
      if (btn) { btn.disabled = true; btn.textContent = "Removing…"; }
      await ensurePngArtwork(job);
      await api("/api/jobs/" + job.id + "/artops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ remove_background: true, knockout: "production" }) });
      if (errEl) errEl.textContent = "";
      renderJob(job.id);
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
      if (btn) { btn.disabled = false; btn.textContent = "Background removal, one click"; }
    }
  };
  $("#ko").onclick = async () => {
    try {
      await ensurePngArtwork(job);
      await api("/api/jobs/" + job.id + "/artops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ knockout: "white" }) });
      renderJob(job.id);
    } catch (err) { $("#err").textContent = err.message; }
  };
  const grey = $("#greyBtn");
  if (grey) grey.onclick = async () => {
    const errEl = $("#err");
    try {
      grey.disabled = true;
      grey.textContent = "Greyscale…";
      await ensurePngArtwork(job);
      await api("/api/jobs/" + job.id + "/artops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ greyscale: true, scale: 2 }) });
      if (errEl) errEl.textContent = "Greyscale applied";
      renderJob(job.id);
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
      grey.disabled = false;
      grey.textContent = "Hi-res greyscale";
    }
  };
  const invertBtn = $("#invertBtn");
  if (invertBtn) invertBtn.onclick = async () => {
    const errEl = $("#err");
    try {
      invertBtn.disabled = true;
      invertBtn.textContent = "Inverting…";
      const hasVec = jobHasVector(job);
      if (!hasVec) await ensurePngArtwork(job);
      const data = await api("/api/jobs/" + job.id + "/artops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invert: true }),
      });
      const mode = (data && data.mode) || (hasVec ? "vector" : "raster");
      if (errEl) errEl.textContent = mode === "vector" ? "Invert applied — use Download SVG when you want the file" : "Invert applied — use Download PNG when you want the file";
      renderJob(job.id);
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
      invertBtn.disabled = false;
      invertBtn.textContent = "Invert black & white";
    }
  };
  // --- Vector Halftones (real SVG paths / circles) --- ht-color-v6
  const HALFTONE_STYLES = [
    { id: "classic-round", name: "Classic Round", kind: "am-round", lpi: 45, angle: 45, contrast: 1 },
    { id: "elliptical", name: "Elliptical", kind: "am-ellipse", lpi: 45, angle: 45, contrast: 1 },
    { id: "line", name: "Line", kind: "line", lpi: 40, angle: 45, contrast: 1 },
    { id: "crosshatch", name: "Crosshatch", kind: "crosshatch", lpi: 35, angle: 45, contrast: 1 },
    { id: "diamond", name: "Diamond", kind: "am-diamond", lpi: 45, angle: 45, contrast: 1 },
    { id: "square", name: "Square", kind: "am-square", lpi: 45, angle: 45, contrast: 1 },
    { id: "stochastic", name: "Stochastic / FM", kind: "fm", lpi: 60, angle: 0, contrast: 1 },
    { id: "coarse-spot", name: "Coarse Spot", kind: "am-round", lpi: 22, angle: 45, contrast: 1.1 },
    { id: "fine-spot", name: "Fine Spot", kind: "am-round", lpi: 65, angle: 45, contrast: 0.95 },
    { id: "dual-tone", name: "Dual Tone", kind: "dual", lpi: 40, angle: 45, contrast: 1 },
    { id: "soft-fade", name: "Soft Fade", kind: "am-round", lpi: 45, angle: 45, contrast: 0.65 },
    { id: "hard-punch", name: "Hard Punch", kind: "am-round", lpi: 40, angle: 45, contrast: 1.55 },
    { id: "newspaper", name: "Newspaper", kind: "am-round", lpi: 28, angle: 45, contrast: 1.15 },
    { id: "comic-dot", name: "Comic Dot", kind: "am-round", lpi: 18, angle: 0, contrast: 1.25 },
    { id: "cmyk-cyan", name: "CMYK Cyan angle", kind: "am-round", lpi: 45, angle: 15, contrast: 1 },
    { id: "cmyk-magenta", name: "CMYK Magenta angle", kind: "am-round", lpi: 45, angle: 75, contrast: 1 },
    { id: "cmyk-yellow", name: "CMYK Yellow angle", kind: "am-round", lpi: 45, angle: 0, contrast: 1 },
    { id: "cmyk-black", name: "CMYK Black angle", kind: "am-round", lpi: 45, angle: 45, contrast: 1 },
    { id: "horizontal-line", name: "Horizontal Line", kind: "line", lpi: 40, angle: 0, contrast: 1 },
    { id: "vertical-line", name: "Vertical Line", kind: "line", lpi: 40, angle: 90, contrast: 1 },
    { id: "mesh", name: "Mesh / Wire", kind: "mesh", lpi: 30, angle: 0, contrast: 1 },
    { id: "triangle", name: "Triangle Spot", kind: "am-triangle", lpi: 40, angle: 30, contrast: 1 },
    { id: "hex-spot", name: "Hex Spot", kind: "am-hex", lpi: 38, angle: 30, contrast: 1 },
    { id: "grain", name: "Grain / Mezzotint", kind: "grain", lpi: 55, angle: 0, contrast: 1.1 },
  ];
  let htStyle = (job.halftone && job.halftone.style) || "classic-round";

  function htThumbSvg(s) {
    const kind = s.kind || "am-round";
    const ang = Number(s.angle) || 0;
    const coarse = (Number(s.lpi) || 45) <= 22;
    const pitch = coarse ? 10 : (kind === "fm" || kind === "grain" ? 4.5 : 7);
    const parts = [];
    const W = 56, H = 40;
    // tone ramp left→right (light → dark)
    function toneAt(x) { return Math.max(0.05, Math.min(0.95, x / W)); }
    if (kind === "line" || kind === "crosshatch" || kind === "mesh") {
      const angles = kind === "crosshatch" ? [ang, ang + 90] : kind === "mesh" ? [0, 90] : [ang];
      angles.forEach((a) => {
        const rad = (a * Math.PI) / 180;
        const nx = Math.cos(rad + Math.PI / 2);
        const ny = Math.sin(rad + Math.PI / 2);
        const dx = Math.cos(rad);
        const dy = Math.sin(rad);
        for (let i = -6; i < 14; i++) {
          const ox = W / 2 + nx * (i - 3.5) * (pitch * 0.7);
          const oy = H / 2 + ny * (i - 3.5) * (pitch * 0.7);
          const t = toneAt(ox);
          const sw = 0.55 + t * 2.6;
          parts.push('<path d="M ' + (ox - dx * 40).toFixed(1) + " " + (oy - dy * 40).toFixed(1) +
            " L " + (ox + dx * 40).toFixed(1) + " " + (oy + dy * 40).toFixed(1) +
            '" fill="none" stroke="#0a0a0a" stroke-width="' + sw.toFixed(2) + '"/>');
        }
      });
    } else if (kind === "fm" || kind === "grain") {
      for (let y = 3; y < H; y += pitch) {
        for (let x = 3; x < W; x += pitch) {
          const t = toneAt(x);
          const rnd = ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1;
          if (rnd > t) continue;
          const r = kind === "grain" ? (0.85 + t * 1.7 * rnd) : 1.35;
          parts.push('<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(2) + '" fill="#0a0a0a"/>');
        }
      }
    } else {
      // AM family — round / ellipse / diamond / square / triangle / hex / dual
      for (let y = pitch / 2; y < H; y += pitch) {
        for (let x = pitch / 2; x < W; x += pitch) {
          const t = toneAt(x);
          const r = (coarse ? 5.0 : 3.4) * Math.sqrt(t);
          if (r < 0.4) continue;
          if (kind === "am-ellipse") {
            parts.push('<ellipse cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" rx="' + (r * 0.75).toFixed(2) +
              '" ry="' + (r * 1.15).toFixed(2) + '" transform="rotate(' + ang + " " + x.toFixed(1) + " " + y.toFixed(1) + ')" fill="#0a0a0a"/>');
          } else if (kind === "am-diamond") {
            parts.push('<path d="M ' + x.toFixed(1) + " " + (y - r).toFixed(1) + " L " + (x + r).toFixed(1) + " " + y.toFixed(1) +
              " L " + x.toFixed(1) + " " + (y + r).toFixed(1) + " L " + (x - r).toFixed(1) + " " + y.toFixed(1) + ' Z" fill="#0a0a0a"/>');
          } else if (kind === "am-square") {
            const s = r * 0.85;
            parts.push('<rect x="' + (x - s).toFixed(1) + '" y="' + (y - s).toFixed(1) + '" width="' + (s * 2).toFixed(1) +
              '" height="' + (s * 2).toFixed(1) + '" transform="rotate(' + ang + " " + x.toFixed(1) + " " + y.toFixed(1) + ')" fill="#0a0a0a"/>');
          } else if (kind === "am-triangle") {
            const a0 = (ang * Math.PI) / 180;
            const pts = [];
            for (let i = 0; i < 3; i++) {
              const a = a0 + (i * 2 * Math.PI) / 3 - Math.PI / 2;
              pts.push((x + Math.cos(a) * r).toFixed(1) + "," + (y + Math.sin(a) * r).toFixed(1));
            }
            parts.push('<polygon points="' + pts.join(" ") + '" fill="#0a0a0a"/>');
          } else if (kind === "am-hex") {
            const a0 = (ang * Math.PI) / 180;
            const pts = [];
            for (let i = 0; i < 6; i++) {
              const a = a0 + (i * Math.PI) / 3;
              pts.push((x + Math.cos(a) * r).toFixed(1) + "," + (y + Math.sin(a) * r).toFixed(1));
            }
            parts.push('<polygon points="' + pts.join(" ") + '" fill="#0a0a0a"/>');
          } else if (kind === "dual") {
            parts.push('<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(2) + '" fill="#0a0a0a"/>');
            if (t > 0.45) {
              parts.push('<circle cx="' + (x + pitch * 0.28).toFixed(1) + '" cy="' + (y + pitch * 0.1).toFixed(1) +
                '" r="' + (r * 0.35).toFixed(2) + '" fill="#0a0a0a"/>');
            }
          } else {
            parts.push('<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(2) + '" fill="#0a0a0a"/>');
          }
        }
      }
    }
    // Transparent SVG — CSS .ht-thumb-wrap checkerboard provides contrast
    return '<svg class="ht-thumb" viewBox="0 0 ' + W + " " + H + '" width="56" height="40" aria-hidden="true">' +
      parts.join("") + "</svg>";
  }

  function htPayload() {
    const useInk = !!($("#htUseInk") && $("#htUseInk").checked);
    return {
      style: htStyle,
      lpi: Number($("#htLpi") && $("#htLpi").value) || undefined,
      angle: Number($("#htAngle") && $("#htAngle").value),
      contrast: Number($("#htContrast") && $("#htContrast").value) || 1,
      colorMode: useInk ? "ink" : "source",
      color: ($("#htColor") && $("#htColor").value) || "#000000",
      knockout: !!($("#htKnockout") && $("#htKnockout").checked),
    };
  }

  function clearHtPreview() {
    if (htPreviewTimer) {
      clearTimeout(htPreviewTimer);
      htPreviewTimer = null;
    }
    htPreviewSeq += 1;
    if (htPreviewAbort) {
      try { htPreviewAbort.abort(); } catch (e) { /* ignore */ }
      htPreviewAbort = null;
    }
    const frame = $("#htPreviewFrame");
    if (frame) {
      frame.hidden = true;
      frame.innerHTML = "";
      frame.classList.remove("is-loading");
    }
    const drop = $("#artDrop");
    if (drop) drop.classList.remove("ht-previewing");
  }

  function showHtPreviewSvg(svgText) {
    const frame = $("#htPreviewFrame");
    const drop = $("#artDrop");
    if (!frame || !drop) return;
    frame.innerHTML = svgText;
    const elSvg = frame.querySelector("svg");
    if (elSvg) {
      elSvg.removeAttribute("width");
      elSvg.removeAttribute("height");
      elSvg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      elSvg.style.width = "100%";
      elSvg.style.height = "auto";
      elSvg.style.maxHeight = "420px";
    }
    frame.hidden = false;
    frame.classList.remove("is-loading");
    drop.classList.add("ht-previewing", "has-art");
  }

  /** Unpaid previews are a watermarked PNG. Checkerboard stays on the frame. */
  function showHtPreviewPng(src) {
    const frame = $("#htPreviewFrame");
    const drop = $("#artDrop");
    if (!frame || !drop || !src) return;
    frame.innerHTML = "";
    const img = document.createElement("img");
    img.className = "ht-preview-png";
    img.alt = "Halftone preview";
    img.onload = () => { frame.classList.remove("is-loading"); };
    img.onerror = () => { frame.classList.remove("is-loading"); };
    img.src = src;
    frame.appendChild(img);
    frame.hidden = false;
    if (img.complete) frame.classList.remove("is-loading");
    drop.classList.add("ht-previewing", "has-art");
  }

  /** Instant checkerboard plate before the debounced API preview builds. */
  function showHtPreviewPlate() {
    const frame = $("#htPreviewFrame");
    const drop = $("#artDrop");
    const hint = $("#htHint");
    if (!job.file_path && !jobHasVector(job)) {
      if (hint) hint.textContent = "Drop art first, then preview styles.";
      return;
    }
    if (frame) {
      frame.hidden = false;
      frame.classList.add("is-loading");
    }
    if (drop) drop.classList.add("ht-previewing", "has-art");
  }

  function scheduleHtPreview() {
    if (!htPanelWantOpen) return;
    if (!$("#htPanel") || $("#htPanel").hidden) return;
    if (!job.file_path && !jobHasVector(job)) {
      const hint = $("#htHint");
      if (hint) hint.textContent = "Drop art first, then preview styles.";
      return;
    }
    if (htPreviewTimer) clearTimeout(htPreviewTimer);
    htPreviewTimer = setTimeout(runHtPreview, 350);
  }

  async function runHtPreview() {
    const hint = $("#htHint");
    const frame = $("#htPreviewFrame");
    const seq = ++htPreviewSeq;
    if (htPreviewAbort) {
      try { htPreviewAbort.abort(); } catch (e) { /* ignore */ }
    }
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    htPreviewAbort = ac;
    try {
      if (frame) {
        frame.hidden = false;
        frame.classList.add("is-loading");
      }
      const drop = $("#artDrop");
      if (drop) drop.classList.add("ht-previewing", "has-art");
      if (hint) hint.textContent = "Updating preview…";
      await ensurePngArtwork(job);
      if (seq !== htPreviewSeq) return;
      const postPreview = async (attempt) => {
        try {
          return await api("/api/jobs/" + job.id + "/halftone/preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(htPayload()),
            signal: ac ? ac.signal : undefined,
          });
        } catch (err) {
          if (err && err.code === "ABORTED") throw err;
          if (err && err.status === 429 && attempt < 1 && seq === htPreviewSeq) {
            const waitMs = Math.min(3000, Math.max(400, (Number(err.retryAfter) || 1) * 1000));
            await new Promise((r) => setTimeout(r, waitMs));
            if (seq !== htPreviewSeq || (ac && ac.signal.aborted)) {
              const aborted = new Error("aborted");
              aborted.code = "ABORTED";
              throw aborted;
            }
            return postPreview(attempt + 1);
          }
          throw err;
        }
      };
      const data = await postPreview(0);
      if (seq !== htPreviewSeq) return;
      if (data && data.png && !data.svg) showHtPreviewPng(data.png);
      else if (data && data.svg) showHtPreviewSvg(data.svg);
      else if (data && data.png) showHtPreviewPng(data.png);
      const meta = (data && data.meta) || {};
      if (hint) {
        hint.textContent = "Preview · " + (meta.styleName || htStyle) + " · " + (meta.elements || "?") +
          " marks · Apply to commit";
      }
    } catch (err) {
      if (seq !== htPreviewSeq) return;
      if (err && (err.code === "ABORTED" || err.name === "AbortError")) return;
      if (err && err.status === 429) {
        if (frame) frame.classList.remove("is-loading");
        return;
      }
      if (frame) frame.classList.remove("is-loading");
      if (hint) hint.textContent = (err && err.message) || "Preview failed — try Apply or re-drop art.";
    }
  }

  /** Hide Vectorize-only chrome while Halftones panel is open (whole Art station). */
  function setHtModeUi(open) {
    const on = !!open;
    ["vzOptions", "vzUsed", "vzLiveHint", "colorModeRow"].forEach((id) => {
      const n = $("#" + id);
      if (n) n.hidden = on;
    });
    const layerList = el.querySelector(".layer-list");
    if (layerList) layerList.hidden = on;
    const vzBtn = $("#vectorizeBtn");
    if (vzBtn) {
      vzBtn.classList.toggle("secondary", on);
      vzBtn.hidden = on;
    }
    const grey = $("#greyBtn");
    const inv = $("#invertBtn");
    if (grey) grey.hidden = on;
    if (inv) inv.hidden = on;
    // Keep Halftones primary; mute leftover art-actions noise
    const hintVz = el.querySelector(".vz-best");
    if (hintVz && /Best on clean logos/.test(hintVz.textContent || "")) {
      hintVz.hidden = on;
    }
    document.body.classList.toggle("ht-mode", on);
  }

  function syncHtInkRow() {
    const useInk = !!($("#htUseInk") && $("#htUseInk").checked);
    const row = $("#htInkRow");
    if (row) row.hidden = !useInk;
    const hint = $("#htColorHint");
    if (hint) {
      hint.textContent = useInk
        ? "One ink — all marks use the override color (screen / one-color)."
        : "Art colors (DTF) — each mark keeps real artwork color; spot size follows tone.";
    }
  }

  function renderHtStyles() {

    const box = $("#htStyles");
    if (!box) return;
    box.innerHTML = HALFTONE_STYLES.map((s) => {
      const on = s.id === htStyle ? " on" : "";
      return '<button type="button" class="ht-style' + on + '" data-ht="' + escapeHtml(s.id) +
        '" role="option" aria-selected="' + (s.id === htStyle ? "true" : "false") +
        '" title="' + escapeHtml(s.name) + '"><span class="ht-thumb-wrap">' + htThumbSvg(s) +
        '</span><span class="ht-style-name">' + escapeHtml(s.name) + "</span></button>";
    }).join("");
    box.querySelectorAll("[data-ht]").forEach((b) => {
      b.onclick = () => {
        htStyle = b.dataset.ht;
        const def = HALFTONE_STYLES.find((x) => x.id === htStyle);
        if (def) {
          const lpi = $("#htLpi"); if (lpi) lpi.value = def.lpi;
          const ang = $("#htAngle"); if (ang) ang.value = def.angle;
          const con = $("#htContrast"); if (con) con.value = def.contrast;
        }
        renderHtStyles();
        scheduleHtPreview();
      };
    });
  }

  const htBtn = $("#halftoneBtn");
  const htPanel = $("#htPanel");
  if (htBtn && htPanel) {
    function refreshHtStatus() {
      const chip = $("#htStatus");
      const buy = $("#htBuy");
      const note = $("#htBuyNote");
      const included = !!(user && user.halftoneIncluded);
      const credits = (user && user.halftoneCredits != null) ? Number(user.halftoneCredits) : 0;
      if (chip) {
        if (included) {
          chip.textContent = "Included with Studio";
          chip.className = "pill ht-status ok";
        } else if (credits > 0) {
          chip.textContent = credits + " credit" + (credits === 1 ? "" : "s") + " left";
          chip.className = "pill ht-status ok";
        } else {
          chip.textContent = "Buy: $3 / image · $20 for 10";
          chip.className = "pill ht-status warn";
        }
      }
      if (buy) buy.hidden = !!included;
      if (note) {
        note.textContent = cfg.billing
          ? (included ? "" : "Checkout grants credits after payment webhook.")
          : (included ? "" : "Billing off — ask admin to grant credits, or wait for checkout.");
      }
    }
    async function buyHalftoneProduct(product) {
      const note = $("#htBuyNote");
      const errEl = $("#err");
      try {
        if (!cfg.billing) {
          if (note) note.textContent = "Billing not configured — checkout returns 501. Admin can grant Halftone credits.";
          if (errEl) errEl.textContent = "Billing not configured for Halftone packs.";
          return;
        }
        const data = await api("/api/billing/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ product: product }),
        });
        if (data.checkoutUrl) location.href = data.checkoutUrl;
      } catch (err) {
        if (note) note.textContent = (err && err.message) || "Checkout failed";
        if (errEl) errEl.textContent = (err && err.message) || "Halftone checkout failed";
      }
    }
    refreshHtStatus();
    const buySingle = $("#htBuySingle");
    const buyPack = $("#htBuyPack");
    if (buySingle) buySingle.onclick = () => buyHalftoneProduct("halftone_single");
    if (buyPack) buyPack.onclick = () => buyHalftoneProduct("halftone_pack10");
    renderHtStyles();
    if (job.halftone) {
      const lpi = $("#htLpi"); if (lpi && job.halftone.lpi != null) lpi.value = job.halftone.lpi;
      const ang = $("#htAngle"); if (ang && job.halftone.angle != null) ang.value = job.halftone.angle;
      const con = $("#htContrast"); if (con && job.halftone.contrast != null) con.value = job.halftone.contrast;
      const useInkEl = $("#htUseInk");
      // Default DTF = source. Only check ink override when colorMode === "ink".
      if (useInkEl) useInkEl.checked = job.halftone.colorMode === "ink";
      const col = $("#htColor");
      if (col && job.halftone.color && String(job.halftone.color).indexOf("#") === 0) col.value = job.halftone.color;
      const ko = $("#htKnockout"); if (ko) ko.checked = job.halftone.knockout != null ? !!job.halftone.knockout : true;
      const hint = $("#htHint");
      if (hint) hint.textContent = "Last · " + (job.halftone.styleName || job.halftone.style) + " · " + (job.halftone.elements || "?") + " marks · tweak for live preview";
      // Job came in as HT → keep HT panel preferred
      if (job.vector && job.vector.source === "vector-halftone") htPanelWantOpen = true;
    }
    syncHtInkRow();
    function bindHtParamListeners() {
      ["htLpi", "htAngle", "htContrast", "htColor", "htKnockout", "htUseInk"].forEach((id) => {
        const node = $("#" + id);
        if (!node || node._htBound) return;
        node._htBound = true;
        const ev = (id === "htColor" || id === "htKnockout" || id === "htUseInk") ? "change" : "input";
        node.addEventListener(ev, () => {
          if (id === "htUseInk") syncHtInkRow();
          scheduleHtPreview();
        });
        if (id !== "htColor" && id !== "htKnockout" && id !== "htUseInk") {
          node.addEventListener("change", () => scheduleHtPreview());
        }
      });
    }
    bindHtParamListeners();

    htBtn.onclick = () => {
      htPanel.hidden = !htPanel.hidden;
      htPanelWantOpen = !htPanel.hidden;
      if (!htPanel.hidden) {
        setHtModeUi(true);
        renderHtStyles();
        showHtPreviewPlate();
        scheduleHtPreview();
      } else {
        setHtModeUi(false);
        clearHtPreview();
      }
    };
    const htCancel = $("#htCancel");
    if (htCancel) htCancel.onclick = () => {
      htPanel.hidden = true;
      htPanelWantOpen = false;
      setHtModeUi(false);
      clearHtPreview();
    };
    const htApply = $("#htApply");
    if (htApply) htApply.onclick = async () => {
      const errEl = $("#err");
      const hint = $("#htHint");
      try {
        htApply.disabled = true;
        htBtn.disabled = true;
        showArtWorking("Halftone…");
        if (hint) hint.textContent = "Building vector halftone…";
        await ensurePngArtwork(job);
        const data = await api("/api/jobs/" + job.id + "/halftone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(htPayload()),
        });
        if (data && data.user) user = data.user;
        else if (data && data.halftoneCredits != null) {
          user = Object.assign({}, user || {}, {
            halftoneCredits: data.halftoneCredits,
            halftoneIncluded: !!data.halftoneIncluded,
          });
        }
        refreshHtStatus();
        const meta = (data && data.meta) || {};
        const creditNote = data && data.creditConsumed ? (" · " + (data.halftoneCredits != null ? data.halftoneCredits : "?") + " credits left") : (data && data.halftoneIncluded ? " · Studio included" : "");
        if (errEl) errEl.textContent = "Halftone · " + (meta.styleName || htStyle) + " · " + (meta.elements || "") + " vector marks" + creditNote;
        htPanelWantOpen = true;
        if (hint) hint.textContent = "Applied · " + (meta.styleName || htStyle) + " · " + (meta.elements || "") + " marks" + creditNote + " — panel stays open to tweak";
        renderJob(job.id);
      } catch (err) {
        hideArtWorking();
        if (errEl) errEl.textContent = (err && err.message) || shopHttpError(err && err.status, null, "Halftone failed");
        if (hint) hint.textContent = "Live preview on the art · Apply commits real vector SVG.";
        htApply.disabled = false;
        htBtn.disabled = false;
      }
    };

    if (htPanelWantOpen) {
      htPanel.hidden = false;
      setHtModeUi(true);
      showHtPreviewPlate();
      scheduleHtPreview();
    } else {
      setHtModeUi(false);
    }
  }

  applySuiteFocus(el);
  async function runUpscale() {
    const btn = $("#upscaleGo");
    const errEl = $("#err");
    const width = Number(($("#upWidth") && $("#upWidth").value) || (job.upscale && job.upscale.width_in) || 12);
    const removeBg = !!($("#upRemoveBg") && $("#upRemoveBg").checked);
    try {
      if (btn) { btn.disabled = true; btn.textContent = "Upscaling…"; }
      showArtWorking("Upscaling to 300 DPI…");
      await api("/api/jobs/" + job.id + "/upscale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ width_in: width, remove_background: removeBg }),
      });
      hideArtWorking();
      renderJob(job.id);
    } catch (err) {
      hideArtWorking();
      if (errEl) errEl.textContent = err.message || "Could not upscale";
      if (btn) { btn.disabled = false; btn.textContent = "Upscale to 300 DPI"; }
    }
  }
  const upscaleGo = $("#upscaleGo");
  if (upscaleGo) upscaleGo.onclick = () => runUpscale();
  const upWidthJob = $("#upWidth");
  if (upWidthJob) upWidthJob.oninput = () => {
    const dims = $("#upscaleDims");
    const img = $("#artZoomImg");
    if (!dims) return;
    const inches = Math.min(16, Math.max(1, Number(upWidthJob.value) || 12));
    const sw = img && img.naturalWidth;
    const sh = img && img.naturalHeight;
    if (!sw || !sh) {
      dims.textContent = "72 DPI → " + Math.round(inches * 300) + " px wide at 300 DPI (" + inches + " in)";
      return;
    }
    let widthIn = inches;
    let heightIn = widthIn * (sh / sw);
    if (heightIn > 16) { heightIn = 16; widthIn = heightIn / (sh / sw); }
    dims.textContent = sw + " × " + sh + " px · 72 DPI → " + Math.round(widthIn * 300) + " × " + Math.round(heightIn * 300) + " px · " + widthIn.toFixed(2) + " × " + heightIn.toFixed(2) + " in at 300 DPI";
  };
  if (suiteTool === "upscale" && job.file_path && !job.upscale && !upscaleStarted[job.id]) {
    upscaleStarted[job.id] = true;
    runUpscale();
  }
  const bgGo = $("#bgGo");
  if (bgGo) bgGo.onclick = () => { const b = $("#rmbgBtn"); if (b) b.click(); };
  const stonesGo = $("#stonesGo");
  if (stonesGo) stonesGo.onclick = async () => {
    const errEl = $("#err");
    try {
      stonesGo.disabled = true;
      stonesGo.textContent = "Building…";
      const ss = ($("#stoneSs") && $("#stoneSs").value) || "SS10";
      const data = await api("/api/jobs/" + job.id + "/stones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ss: ss }),
      });
      const n = $("#stonesCount");
      if (n) n.textContent = (data.count != null ? data.count : "?") + " stones · " + (data.ss || ss);
      if (errEl) errEl.textContent = "";
      stonesGo.disabled = false;
      stonesGo.textContent = "Build rhinestone template";
    } catch (err) {
      if (errEl) errEl.textContent = err.message || "Could not build the template";
      stonesGo.disabled = false;
      stonesGo.textContent = "Build rhinestone template";
    }
  };

  const ig = $("#imagineGo");
  if (ig) ig.onclick = async () => {
    const prompt = ($("#imaginePrompt") && $("#imaginePrompt").value || "").trim();
    if (!prompt) { $("#err").textContent = "Describe the graphic first."; return; }
    try { await api("/api/jobs/" + job.id + "/imagine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: prompt }) }); renderJob(job.id); }
    catch (err) { $("#err").textContent = err.message; }
  };
  const saveN = $("#saveArtN");
  if (saveN) saveN.onclick = async () => {
    await api("/api/jobs/" + job.id, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ art_notes: $("#artn").value }) });
    renderJob(job.id);
  };
  async function runVectorize(engine, opts) {
    opts = opts || {};
    const errEl = $("#err");
    const hint = $("#vzLiveHint");
    if (errEl) errEl.textContent = "";
    const live = !!opts.live;
    if (!live) showArtWorking("Working");
    try {
    await ensurePngArtwork(job);
    const maxEdge = live ? 900 : 1100;
    const payload = {
      detail: vzDetail,
      smoothing: vzSmooth,
      cornerSmooth: vzCorner,
      maxEdge: maxEdge,
      fuse: "auto",
      live: live,
    };
    if (engine) payload.engine = engine;
    saveVzPref("detail", vzDetail);
    saveVzPref("smoothing", vzSmooth);
    saveVzPref("corner", vzCorner);
    const res = await api("/api/jobs/" + job.id + "/vectorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: opts.signal,
    });
    if (opts.seq != null && opts.seq !== vzLiveSeq) return;
    const meta = (res && res.meta) || (res && res.vector && res.vector.meta) || {};
    const used = meta.settings || { detail: vzDetail, smoothing: vzSmooth, cornerSmooth: vzCorner };
    const d = toPct(used.detail, DETAIL_LEGACY, vzDetail);
    const sm = toPct(used.smoothing, SMOOTH_LEGACY, vzSmooth);
    const c = toPct(used.cornerSmooth, CORNER_LEGACY, vzCorner);
    if (errEl) errEl.textContent = "";
    const usedEl = $("#vzUsed");
    if (usedEl) {
      usedEl.hidden = false;
      usedEl.textContent = "Last run · Detail " + detailReadout(d) + " · Smoothing " + smoothReadout(sm) + " · Corners " + cornerReadout(c);
    }
    if (hint && !live) hint.textContent = "Drag sliders to update the preview live.";
    renderJob(job.id);
    } finally {
      if (!live) hideArtWorking();
    }
  }

  const vz = $("#vectorizeBtn");
  if (vz) vz.onclick = async () => {
    try { await runVectorize(); }
    catch (err) {
      hideArtWorking();
      const e = $("#err");
      if (e) e.textContent = (err && err.message) || shopHttpError(err && err.status, null, "Vectorize failed");
    }
  };
  const pvz = $("#proVectorizeBtn");
  if (pvz) pvz.onclick = async () => {
    try { await runVectorize("vtracer"); }
    catch (err) {
      hideArtWorking();
      const e = $("#err");
      if (e) e.textContent = (err && err.message) || shopHttpError(err && err.status, null, "Vectorize failed");
    }
  };
  async function recolorLayer(layer, body) {
    await api("/api/jobs/" + job.id + "/recolor", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ layer: layer }, body)),
    });
    renderJob(job.id);
  }
  el.querySelectorAll(".layer-pick").forEach((inp) => {
    inp.onchange = async () => {
      const layer = Number(inp.closest(".layer-row").dataset.layer);
      try { await recolorLayer(layer, { hex: inp.value }); }
      catch (err) { $("#err").textContent = err.message; }
    };
  });
  el.querySelectorAll(".layer-pal").forEach((sel) => {
    sel.onchange = async () => {
      const hex = sel.value;
      if (!hex) return;
      const layer = Number(sel.dataset.layer);
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      const name = opt ? opt.getAttribute("data-name") || opt.textContent : "";
      try { await recolorLayer(layer, { hex: hex, name: name }); }
      catch (err) { $("#err").textContent = err.message; }
    };
  });
  function bindChannelCommit(sel, buildBody) {
    el.querySelectorAll(sel).forEach((inp) => {
      const commit = async () => {
        const row = inp.closest(".layer-row");
        if (!row) return;
        const layer = Number(row.dataset.layer);
        try { await recolorLayer(layer, buildBody(row)); }
        catch (err) { $("#err").textContent = err.message; }
      };
      inp.onchange = commit;
      inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } };
    });
  }
  bindChannelCommit(".layer-rgb", (row) => {
    const get = (ch) => Number((row.querySelector('.layer-rgb[data-ch="' + ch + '"]') || {}).value) || 0;
    return { rgb: { r: get("r"), g: get("g"), b: get("b") } };
  });
  bindChannelCommit(".layer-cmyk", (row) => {
    const get = (ch) => Number((row.querySelector('.layer-cmyk[data-ch="' + ch + '"]') || {}).value) || 0;
    return { cmyk: { c: get("c"), m: get("m"), y: get("y"), k: get("k") } };
  });
}

function bindArtZoom(stage, opts) {
  opts = opts || {};
  const inner = $("#artZoomInner", stage) || $("#artZoomInner");
  const img = $("#artZoomImg", stage) || $("#artZoomImg");
  if (!inner || !stage) return;
  const vectorMode = !!(opts.vector && opts.jobId);
  const zoomGen = ++artZoomGen;
  // tile = normalized viewBox fraction currently in the bitmap. disp = its CSS box before transform.
  let svgAspect = 1;
  let tile = { x: 0, y: 0, w: 1, h: 1 };
  let disp = { x: 0, y: 0, w: 10, h: 10 };
  let s = 1, tx = 0, ty = 0;
  let mode = "fill";
  try { mode = localStorage.getItem("dcPreviewMode") === "outline" ? "outline" : "fill"; } catch (e) { /* ignore */ }
  let reqSeq = 0;
  let sharpTimer = 0;
  let aspectKnown = false;
  let previewAbort = null;
  if (stage._dcZoomAbort) stage._dcZoomAbort.abort();
  const zoomAbort = new AbortController();
  stage._dcZoomAbort = zoomAbort;
  if (stage._dcPreviewAbort) {
    try { stage._dcPreviewAbort.abort(); } catch (e) { /* ignore */ }
    stage._dcPreviewAbort = null;
  }
  const pointers = new Map();
  let pan = null;
  let pinch = null;
  const read = $("#zoomRead");

  function stageSize() {
    const r = stage.getBoundingClientRect();
    return {
      w: Math.max(32, r.width || stage.clientWidth || 320),
      h: Math.max(32, r.height || stage.clientHeight || 320),
    };
  }
  function fitBox(stW, stH, aspect) {
    const a = aspect > 0 ? aspect : 1;
    let w = stW;
    let h = stW / a;
    if (h > stH) { h = stH; w = stH * a; }
    return { x: (stW - w) / 2, y: (stH - h) / 2, w: w, h: h };
  }
  function trueZoom() {
    const st = stageSize();
    const box = fitBox(st.w, st.h, svgAspect || 1);
    if (!box.w || !tile.w) return 1;
    return ((disp.w / tile.w) * s) / box.w;
  }
  function apply() {
    inner.style.transform = "translate(" + tx + "px, " + ty + "px) scale(" + s + ")";
    if (img) {
      img.style.left = disp.x + "px";
      img.style.top = disp.y + "px";
      img.style.width = Math.max(1, disp.w) + "px";
      img.style.height = Math.max(1, disp.h) + "px";
    }
    if (read) {
      const pct = Math.round(trueZoom() * 100);
      read.textContent = (pct < 10 ? 10 : pct > 1600 ? 1600 : pct) + "%";
    }
  }
  function setPreviewSrc(url) {
    if (!img) return;
    const prev = artPreviewObjectUrl;
    artPreviewObjectUrl = url;
    img.src = url;
    if (prev && prev !== url) URL.revokeObjectURL(prev);
  }
  function scheduleSharp() {
    if (!vectorMode) return;
    clearTimeout(sharpTimer);
    sharpTimer = setTimeout(requestSharp, 150);
  }
  function zoomAt(next, cx, cy) {
    const cur = trueZoom() || 1;
    const target = Math.max(0.1, Math.min(16, next));
    const factor = target / cur;
    if (Math.abs(factor - 1) < 1e-4) {
      apply();
      scheduleSharp();
      return;
    }
    const old = s || 1;
    s = s * factor;
    if (cx != null) {
      tx = cx - (cx - tx) * (s / old);
      ty = cy - (cy - ty) * (s / old);
    }
    apply();
    scheduleSharp();
  }
  function stageToSvg(sx, sy) {
    const u = ((sx - tx) / (s || 1) - disp.x) / (disp.w || 1);
    const v = ((sy - ty) / (s || 1) - disp.y) / (disp.h || 1);
    return { x: tile.x + u * tile.w, y: tile.y + v * tile.h };
  }
  function visibleSvgRect() {
    const st = stageSize();
    const corners = [stageToSvg(0, 0), stageToSvg(st.w, 0), stageToSvg(0, st.h), stageToSvg(st.w, st.h)];
    let x0 = corners[0].x, y0 = corners[0].y, x1 = corners[0].x, y1 = corners[0].y;
    corners.forEach((c) => {
      if (c.x < x0) x0 = c.x;
      if (c.y < y0) y0 = c.y;
      if (c.x > x1) x1 = c.x;
      if (c.y > y1) y1 = c.y;
    });
    const ix0 = Math.max(0, Math.min(1, x0));
    const iy0 = Math.max(0, Math.min(1, y0));
    const ix1 = Math.max(0, Math.min(1, x1));
    const iy1 = Math.max(0, Math.min(1, y1));
    if (ix1 - ix0 < 1e-4 || iy1 - iy0 < 1e-4) return null;
    return { x: ix0, y: iy0, w: ix1 - ix0, h: iy1 - iy0 };
  }
  function screenRectOfSvg(rx, ry, rw, rh) {
    const u0 = (rx - tile.x) / (tile.w || 1);
    const v0 = (ry - tile.y) / (tile.h || 1);
    const u1 = (rx + rw - tile.x) / (tile.w || 1);
    const v1 = (ry + rh - tile.y) / (tile.h || 1);
    return {
      x: tx + s * (disp.x + u0 * disp.w),
      y: ty + s * (disp.y + v0 * disp.h),
      w: s * (u1 - u0) * disp.w,
      h: s * (v1 - v0) * disp.h,
    };
  }
  // Match server clampWindow so the bitmap we swap in is the region rsvg cropped.
  function clampWin(rect) {
    const MIN_WIN = 1 / 16;
    let x = rect.x, y = rect.y, w = rect.w, h = rect.h;
    w = Math.min(1, Math.max(MIN_WIN, w));
    h = Math.min(1, Math.max(MIN_WIN, h));
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + w > 1) x = Math.max(0, 1 - w);
    if (y + h > 1) y = Math.max(0, 1 - h);
    return { x: x, y: y, w: w, h: h };
  }
  function requestSharp() {
    if (!vectorMode || zoomGen !== artZoomGen) return;
    // First tile omits pw/ph so the PNG keeps the SVG aspect (rsvg stretches to pw×ph).
    const learn = !aspectKnown;
    let win;
    if (learn) win = { x: 0, y: 0, w: 1, h: 1 };
    else {
      const vis = visibleSvgRect();
      if (!vis) return;
      win = clampWin(vis);
    }
    const screen = screenRectOfSvg(win.x, win.y, win.w, win.h);
    if (!learn && (!(screen.w >= 2) || !(screen.h >= 2))) return;
    const seq = ++reqSeq;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const q = new URLSearchParams();
    q.set("x", win.x.toFixed(5));
    q.set("y", win.y.toFixed(5));
    q.set("w", win.w.toFixed(5));
    q.set("h", win.h.toFixed(5));
    q.set("zoom", String(Math.round((trueZoom() || 1) * 1000) / 1000));
    q.set("mode", mode === "outline" ? "outline" : "fill");
    if (!learn) {
      q.set("pw", String(Math.min(2048, Math.max(8, Math.round(screen.w * dpr)))));
      q.set("ph", String(Math.min(2048, Math.max(8, Math.round(screen.h * dpr)))));
    }
    const url = "/api/jobs/" + encodeURIComponent(opts.jobId) + "/preview.png?" + q.toString();
    if (previewAbort) {
      try { previewAbort.abort(); } catch (e) { /* ignore */ }
    }
    const ac = new AbortController();
    previewAbort = ac;
    stage._dcPreviewAbort = ac;
    const applyBlob = (blob) => {
      if (seq !== reqSeq || zoomGen !== artZoomGen) return;
      const obj = URL.createObjectURL(blob);
      const pre = new Image();
      pre.onload = () => {
        if (seq !== reqSeq || zoomGen !== artZoomGen) { URL.revokeObjectURL(obj); return; }
        if (learn && pre.naturalWidth && pre.naturalHeight) {
          svgAspect = pre.naturalWidth / pre.naturalHeight;
          aspectKnown = true;
          const st = stageSize();
          const box = fitBox(st.w, st.h, svgAspect);
          tile = { x: 0, y: 0, w: 1, h: 1 };
          disp = box;
          s = 1; tx = 0; ty = 0;
          setPreviewSrc(obj);
          apply();
          scheduleSharp();
          return;
        }
        const place = screenRectOfSvg(win.x, win.y, win.w, win.h);
        tile = { x: win.x, y: win.y, w: win.w, h: win.h };
        disp = { x: place.x, y: place.y, w: Math.max(1, place.w), h: Math.max(1, place.h) };
        s = 1; tx = 0; ty = 0;
        setPreviewSrc(obj);
        apply();
      };
      pre.onerror = () => { URL.revokeObjectURL(obj); };
      pre.src = obj;
    };
    const fetchSharp = (attempt) => {
      return fetch(url, { credentials: "include", signal: ac.signal }).then(async (res) => {
        if (seq !== reqSeq || zoomGen !== artZoomGen) return;
        if (res.status === 429 && attempt < 1) {
          try { if (res.body && res.body.cancel) res.body.cancel(); } catch (e) { /* ignore */ }
          const ra = Number(res.headers.get("retry-after"));
          const waitMs = Math.min(3000, Math.max(400, (Number.isFinite(ra) && ra > 0 ? ra : 1) * 1000));
          await new Promise((r) => setTimeout(r, waitMs));
          if (seq !== reqSeq || zoomGen !== artZoomGen || ac.signal.aborted) return;
          return fetchSharp(attempt + 1);
        }
        if (!res.ok) throw new Error("preview " + res.status);
        const blob = await res.blob();
        if (seq !== reqSeq || zoomGen !== artZoomGen) return;
        applyBlob(blob);
      });
    };
    fetchSharp(0).catch((err) => {
      if (err && err.name === "AbortError") return;
    });
  }
  function doFit() {
    const st = stageSize();
    const box = fitBox(st.w, st.h, svgAspect || 1);
    disp = {
      x: box.x + tile.x * box.w,
      y: box.y + tile.y * box.h,
      w: Math.max(1, tile.w * box.w),
      h: Math.max(1, tile.h * box.h),
    };
    s = 1; tx = 0; ty = 0;
    apply();
    if (vectorMode) requestSharp();
  }
  function layoutRaster() {
    if (!img || !img.naturalWidth) return;
    svgAspect = img.naturalWidth / img.naturalHeight;
    const st = stageSize();
    tile = { x: 0, y: 0, w: 1, h: 1 };
    disp = fitBox(st.w, st.h, svgAspect);
    s = 1; tx = 0; ty = 0;
    apply();
  }

  const zin = $("#zoomIn"), zout = $("#zoomOut"), zfit = $("#zoomFit");
  if (zin) zin.onclick = (e) => { e.stopPropagation(); const st = stageSize(); zoomAt(trueZoom() * 1.25, st.w / 2, st.h / 2); };
  if (zout) zout.onclick = (e) => { e.stopPropagation(); const st = stageSize(); zoomAt(trueZoom() / 1.25, st.w / 2, st.h / 2); };
  if (zfit) zfit.onclick = (e) => { e.stopPropagation(); doFit(); };
  const outlineBtn = $("#outlineToggle");
  if (outlineBtn) {
    outlineBtn.setAttribute("aria-pressed", mode === "outline" ? "true" : "false");
    outlineBtn.onclick = (e) => {
      e.stopPropagation();
      mode = mode === "outline" ? "fill" : "outline";
      try { localStorage.setItem("dcPreviewMode", mode); } catch (err) { /* ignore */ }
      outlineBtn.setAttribute("aria-pressed", mode === "outline" ? "true" : "false");
      if (vectorMode) requestSharp();
    };
  }
  const bgBtn = $("#bgToggle");
  if (bgBtn) {
    const applyBg = (dark) => {
      stage.classList.toggle("bg-dark", !!dark);
      if (img) img.classList.toggle("bg-dark", !!dark);
      bgBtn.textContent = dark ? "Light bg" : "Dark bg";
      try { localStorage.setItem("dcPreviewBg", dark ? "dark" : "light"); } catch (e) { /* ignore */ }
    };
    let dark = true;
    try { dark = localStorage.getItem("dcPreviewBg") !== "light"; } catch (e) { /* ignore */ }
    applyBg(dark);
    bgBtn.onclick = (e) => { e.stopPropagation(); applyBg(!stage.classList.contains("bg-dark")); };
  }

  stage.addEventListener("wheel", (e) => {
    if (e.target && e.target.closest && e.target.closest("a, button, input, textarea, select")) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    zoomAt(trueZoom() * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false, signal: zoomAbort.signal });
  stage.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest("a, button, input, textarea, select, label")) return;
    if (e.pointerType !== "mouse") e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      pan = { id: e.pointerId, ox: e.clientX, oy: e.clientY, tx: tx, ty: ty };
      pinch = null;
      stage.classList.add("panning");
    } else {
      pan = null;
      stage.classList.remove("panning");
      const pts = Array.from(pointers.values());
      const rect = stage.getBoundingClientRect();
      pinch = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        zoom: trueZoom() || 1,
        cx: (pts[0].x + pts[1].x) / 2 - rect.left,
        cy: (pts[0].y + pts[1].y) / 2 - rect.top,
      };
    }
  }, { signal: zoomAbort.signal });
  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size >= 2) {
      const pts = Array.from(pointers.values());
      const rect = stage.getBoundingClientRect();
      const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      if (!pinch) {
        pinch = { dist: dist, zoom: trueZoom() || 1, cx: cx, cy: cy };
        pan = null;
        return;
      }
      tx += cx - pinch.cx;
      ty += cy - pinch.cy;
      pinch.cx = cx;
      pinch.cy = cy;
      zoomAt(pinch.zoom * (dist / pinch.dist), cx, cy);
      return;
    }
    if (!pan || e.pointerId !== pan.id) return;
    tx = pan.tx + (e.clientX - pan.ox);
    ty = pan.ty + (e.clientY - pan.oy);
    apply();
    scheduleSharp();
  }, { signal: zoomAbort.signal });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pan && e.pointerId === pan.id) {
      pan = null;
      stage.classList.remove("panning");
    }
    if (pointers.size === 1) {
      const entry = Array.from(pointers.entries())[0];
      pan = { id: entry[0], ox: entry[1].x, oy: entry[1].y, tx: tx, ty: ty };
    }
    scheduleSharp();
  }
  stage.addEventListener("pointerup", endPointer, { signal: zoomAbort.signal });
  stage.addEventListener("pointercancel", endPointer, { signal: zoomAbort.signal });

  const st0 = stageSize();
  disp = fitBox(st0.w, st0.h, svgAspect);
  apply();
  if (vectorMode) requestSharp();
  else if (img && img.complete && img.naturalWidth) layoutRaster();
  else if (img) img.addEventListener("load", layoutRaster, { once: true, signal: zoomAbort.signal });
}

function fillMockup(el, job, shopControls) {
  const scaleVal = job.placement_scale != null ? job.placement_scale : 100;
  const ox = job.placement_offset_x != null ? job.placement_offset_x : 0;
  const oy = job.placement_offset_y != null ? job.placement_offset_y : 0;
  el.innerHTML = `
    <div class="split">
      <div class="preview">${job.mockup_path ? `<img src="${job.mockup_path}" alt="Mockup" />` : `<span class="muted">Select an S&amp;S blank, then Apply to blank</span>`}</div>
      <div>
        ${shopControls ? `
          <form id="mk" class="form">
            <p class="muted">Real garment photos from S&amp;S Activewear (flat front). SanMar CDN is gated — these are honest blanks.</p>
            <label>Search blanks (style / color)</label>
            <input id="blankq" type="search" placeholder="18000, Gildan, Navy, White…" value="" autocomplete="off" />
            <div id="blanklist" class="blank-grid muted">Type to search S&amp;S blanks.</div>
            <input type="hidden" name="blank_id" id="blankid" value="${escapeHtml(job.blank_id || "")}" />
            <input type="hidden" name="blank_label" id="blanklabel" value="${escapeHtml(job.blank_label || "")}" />
            <input type="hidden" name="blank_file" id="blankfile" value="${escapeHtml(job.blank_file || "")}" />
            <p id="blankpicked" class="muted">${job.blank_id ? "Selected " + escapeHtml(job.blank_label || job.blank_id) : "No blank selected"}</p>
            <div id="blankthumb" class="blank-selected">${job.blank_file ? `<img src="/${escapeHtml(String(job.blank_file).replace(/^\/+/, ""))}" alt="" />` : ""}</div>
            <label>Art scale %</label>
            <input name="placement_scale" type="number" min="25" max="250" step="5" value="${scaleVal}" />
            <div class="row">
              <div style="flex:1"><label>Offset X %</label><input name="placement_offset_x" type="number" min="-40" max="40" step="1" value="${ox}" /></div>
              <div style="flex:1"><label>Offset Y %</label><input name="placement_offset_y" type="number" min="-40" max="40" step="1" value="${oy}" /></div>
            </div>
            <label>Legacy procedural blank (hardgoods / no photo)</label>
            <select name="blank">${BLANKS.map((b) => `<option value="${b}" ${b===(job.blank||"")?"selected":""}>${b}</option>`).join("")}</select>
            <label>Garment / substrate color (procedural only)</label>
            <input name="garment_color" type="color" value="${job.garment_color || "#2c3138"}" />
            <label>Placement tag</label>
            <select name="placement" id="placeSel">${PLACES.map((p) => `<option value="${p.id}" ${(job.placement||"chest")===p.id?"selected":""}>${p.label}</option>`).join("")}</select>
            <button class="btn" type="submit">Apply to blank</button>
          </form>` : `<p class="muted">Placement mockup for review.${job.blank_label ? " · " + escapeHtml(job.blank_label) : (job.catalog_code ? " · " + escapeHtml(job.catalog_code) : "")}</p>`}
      </div>
    </div>`;
  const mk = $("#mk");
  if (!mk) return;
  const qEl = $("#blankq");
  const list = $("#blanklist");
  let timer = null;
  function pickBlank(it) {
    $("#blankid").value = it.id || "";
    $("#blanklabel").value = it.label || it.id || "";
    $("#blankfile").value = (it.file || "").replace(/^\/+/, "");
    $("#blankpicked").textContent = "Selected " + (it.label || it.id);
    const thumb = $("#blankthumb");
    const url = it.url || ("/" + String(it.file || "").replace(/^\/+/, ""));
    thumb.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="" />` : "";
    mk.blank.value = "tee";
  }
  async function runSearch() {
    const q = qEl.value.trim();
    const data = await api("/api/blanks?q=" + encodeURIComponent(q));
    const rows = (data.items || []).slice(0, 36);
    if (!rows.length) { list.textContent = "No blanks match."; return; }
    list.classList.remove("muted");
    list.innerHTML = rows.map((s) => `<button type="button" class="blank-hit" data-id="${escapeHtml(s.id)}" title="${escapeHtml(s.label || s.id)}">
      <img src="${escapeHtml(s.url || ("/" + s.file))}" alt="" loading="lazy" />
      <span>${escapeHtml(s.label || s.id)}</span>
    </button>`).join("");
    list.querySelectorAll(".blank-hit").forEach((b) => {
      b.onclick = () => {
        const hit = rows.find((r) => r.id === b.dataset.id);
        if (hit) pickBlank(hit);
      };
    });
  }
  qEl.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { runSearch().catch(() => {}); }, 180); };
  runSearch().catch(() => {});
  mk.onsubmit = async (e) => {
    e.preventDefault();
    if (!$("#blankid").value) {
      $("#blankpicked").textContent = "Pick an S&S blank first (or clear and use procedural hardgood).";
      // still allow procedural if they want hardgoods — only block when apparel intent without blank? Allow submit for procedural.
    }
    const payload = Object.fromEntries(new FormData(mk).entries());
    await api("/api/jobs/" + job.id + "/mockup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    renderJob(job.id);
  };
}

async function liveQuote(job, form) {
  const fd = Object.fromEntries(new FormData(form).entries());
  const lines = [...form.querySelectorAll("[data-line]")].map((row) => ({
    desc: row.querySelector("[name$=desc]").value,
    method: row.querySelector("[name$=method]").value,
    width_in: row.querySelector("[name$=width_in]").value,
    height_in: row.querySelector("[name$=height_in]").value,
    qty: row.querySelector("[name$=qty]").value,
  }));
  const data = await api("/api/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line_items: lines.length ? lines : undefined, method: fd.method, width_in: fd.width_in, height_in: fd.height_in, qty: fd.qty, margin_pct: fd.margin_pct }) });
  $("#live").textContent = "Live: subtotal " + money(data.quote.subtotal) + " + margin " + money(data.quote.margin_amount) + " = " + money(data.quote.total);
}

function fillPrice(el, job, shopControls) {
  const items = (job.line_items && job.line_items.length) ? job.line_items : [{ desc: job.title, method: job.method, width_in: job.width_in, height_in: job.height_in, qty: job.qty }];
  el.innerHTML = `
    <p class="muted">Area rate by method, volume breaks at 10 and 25. Margin is shop markup on subtotal — not a fake invoice from a processor.</p>
    ${shopControls ? `<form id="pf" class="form">
      <label>Primary method</label>
      <select name="method">${methodChoices().map((m) => `<option value="${m}" ${m===job.method?"selected":""}>${methodMeta(m).label}</option>`).join("")}</select>
      <div class="row">
        <div style="flex:1"><label>W</label><input name="width_in" type="number" step="0.1" value="${job.width_in}" /></div>
        <div style="flex:1"><label>H</label><input name="height_in" type="number" step="0.1" value="${job.height_in}" /></div>
        <div style="flex:1"><label>Qty</label><input name="qty" type="number" value="${job.qty}" /></div>
        <div style="flex:1"><label>Margin %</label><input name="margin_pct" type="number" step="0.1" value="${job.margin_pct||0}" /></div>
      </div>
      <h3>Line items</h3>
      <div id="lines">${items.map((it, i) => lineRow(it, i)).join("")}</div>
      <button type="button" class="btn ghost small" id="addLine">Add line</button>
      <p id="live" class="mono">${money(job.subtotal||job.total)} subtotal · margin ${job.margin_pct||0}% · <strong>${money(job.total)}</strong></p>
      <button class="btn" type="submit">Save price</button>
    </form>` : `<p class="mono">Subtotal ${money(job.subtotal||job.total)} · you pay ${money(job.total)}</p>`}`;
  const pf = $("#pf"); if (!pf) return;
  const refresh = () => liveQuote(job, pf).catch(() => {});
  pf.addEventListener("input", refresh);
  $("#addLine").onclick = () => { $("#lines").insertAdjacentHTML("beforeend", lineRow({ desc: "", method: job.method, width_in: job.width_in, height_in: job.height_in, qty: 1 }, Date.now())); };
  pf.onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(pf).entries());
    const line_items = [...pf.querySelectorAll("[data-line]")].map((row) => ({
      desc: row.querySelector("[name$=desc]").value,
      method: row.querySelector("[name$=method]").value,
      width_in: row.querySelector("[name$=width_in]").value,
      height_in: row.querySelector("[name$=height_in]").value,
      qty: row.querySelector("[name$=qty]").value,
    }));
    await api("/api/jobs/" + job.id + "/price", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method: fd.method, width_in: fd.width_in, height_in: fd.height_in, qty: fd.qty, margin_pct: fd.margin_pct, line_items }) });
    renderJob(job.id);
  };
}
function lineRow(it, i) {
  return `<div class="line" data-line>
    <input name="l${i}desc" placeholder="Desc" value="${escapeHtml(it.desc||"")}" />
    <select name="l${i}method">${methodChoices().map((m) => `<option value="${m}" ${m===it.method?"selected":""}>${methodMeta(m).label}</option>`).join("")}</select>
    <input name="l${i}width_in" type="number" step="0.1" value="${it.width_in||10}" />
    <input name="l${i}height_in" type="number" step="0.1" value="${it.height_in||10}" />
    <input name="l${i}qty" type="number" value="${it.qty||1}" />
    <span class="mono muted">${it.total != null ? money(it.total) : ""}</span>
    <button type="button" class="btn ghost small" onclick="this.parentNode.remove()">×</button>
  </div>`;
}

function fillProof(el, job, shopControls) {
  el.innerHTML = `
    <p>Proof URL (token is 64 hex chars):</p>
    <p><input id="plink" class="field" readonly value="${escapeHtml(job.proof_url)}" /></p>
    <div class="cta-row">
      <button class="btn small" id="copy">Copy link</button>
      <a class="btn ghost small" href="${job.proof_url}" target="_blank">Open proof</a>
      ${shopControls && entitled() ? `<a class="btn ghost small" href="/api/export/${job.id}/intake-poster.svg">Booth poster SVG</a>
      <button class="btn small" id="send">Mark proof sent</button>` : (shopControls ? `<span class="muted">Membership required to send proofs.</span>` : "")}
    </div>
    <p class="muted" style="margin-top:12px">Status: ${STAT_LABEL[job.status]||job.status}. Client comments appear below after they write on the proof page.</p>
    <ul>${(job.comments||[]).map((c) => `<li><strong>${escapeHtml(c.author)}</strong> — ${escapeHtml(c.body)}</li>`).join("") || "<li class='muted'>No comments yet</li>"}</ul>`;
  $("#copy").onclick = async () => { await navigator.clipboard.writeText(job.proof_url); $("#copy").textContent = "Copied"; };
  const send = $("#send");
  if (send) send.onclick = async () => {
    await api("/api/jobs/" + job.id + "/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "proof_sent" }) });
    renderJob(job.id);
  };
}

function fillProduce(el, job, shopControls) {
  if (!shopControls) { el.innerHTML = "<p class='muted'>Export files are shop-only.</p>"; return; }
  if (!entitled()) { el.innerHTML = paywallNote() + "<p class='muted'>Some art exports stay locked until a member account is active. Admin stays open.</p>"; return; }
  const stones = job.stones && job.stones.count != null ? job.stones.count : "—";
  const extraFiles = studioExtras().map((m) => (m && typeof m.produceHtml === "function") ? m.produceHtml(job) : "").join("");
  el.innerHTML = `
    <p class="muted">Process files from this art. SVG + EPS for your design software. Rhinestone SS map + CSV.</p>
    <p class="mono">Stones ${escapeHtml(String(stones))}</p>
    <div class="export-grid export-hero">
      <a href="/api/export/${job.id}/art.svg">SVG</a>
      <a href="/api/export/${job.id}/art.eps">EPS</a>
      <a href="/api/export/${job.id}/art.pdf">PDF</a>
      <a href="/api/export/${job.id}/art.dxf">DXF</a>
      <a href="/api/export/${job.id}/art.tiff">TIFF 300</a>
      <a href="/api/export/${job.id}/art-dtf.tiff">DTF TIFF + white</a>
      ${extraFiles}
      <a href="/api/export/${job.id}/stones.svg">Stones SVG</a>
      <a href="/api/export/${job.id}/stones.csv">Stones CSV</a>
      <a href="/api/export/${job.id}/stones.plt">Stones PLT</a>
    </div>
    <div class="export-grid">
      <a href="/api/export/${job.id}/cut-contour.svg">Cut contour SVG</a>
      <a href="/api/export/${job.id}/laser.svg">Laser SVG</a>
      <a href="/api/export/${job.id}/laser.plt">Laser PLT</a>
      <a href="/api/export/${job.id}/gang-sheet.svg">DTF / UV gang 22in</a>
      <a href="/api/export/${job.id}/sticker-cutline.svg">Sticker cutline</a>
      <a href="/api/export/${job.id}/cutter-marks.svg">Cutter marks</a>
      <a href="/api/export/${job.id}/job-ticket.svg">Job ticket</a>
      <a href="/api/export/${job.id}/packet.json">Packet JSON</a>
      <a href="/api/export/${job.id}/method-notes.txt">Method notes</a>
    </div>
    <div class="cta-row" style="margin-top:14px">
      <button class="btn" data-st="in_production">Start production</button>
      <button class="btn ghost" data-st="done">Mark delivered</button>
    </div>`;
  el.querySelectorAll("[data-st]").forEach((b) => {
    b.onclick = async () => {
      await api("/api/jobs/" + job.id + "/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: b.dataset.st }) });
      renderJob(job.id);
    };
  });
}

function fillComments(el, job) {
  el.innerHTML = `
    <ul>${(job.comments||[]).map((c) => `<li><strong>${escapeHtml(c.author)}</strong> (${c.role}) · ${escapeHtml(c.body)}</li>`).join("")}</ul>
    <form id="cf" class="form"><label>Note</label><textarea name="body" rows="2" required></textarea><button class="btn small" type="submit">Add</button></form>`;
  $("#cf").onsubmit = async (e) => {
    e.preventDefault();
    await api("/api/jobs/" + job.id + "/comments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: new FormData(e.target).get("body") }) });
    renderJob(job.id);
  };
}

async function renderClients() {
  const { clients } = await api("/api/clients");
  main.innerHTML = `
    <h1 style="font-size:28px;margin-top:0">Clients</h1>
    <form class="form" id="cf" style="margin-bottom:22px">
      <label>Name</label><input name="name" required />
      <label>Email</label><input name="email" type="email" required />
      <label>Temp password</label><input name="password" value="welcome123" />
      <button class="btn" type="submit">Add client login</button>
      <p class="notice" id="err"></p>
    </form>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Jobs</th><th></th></tr></thead>
      <tbody>${clients.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.email)}</td><td>${c.jobs||0}</td>
        <td><button class="btn ghost small" data-cid="${c.id}">Open jobs</button></td></tr>`).join("")}</tbody>
    </table>`;
  $("#cf").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/clients", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())) });
      render();
    } catch (err) { $("#err").textContent = err.message; }
  };
  main.querySelectorAll("[data-cid]").forEach((b) => {
    b.onclick = () => { view = "board"; nav(); renderBoard().then(() => { const sel = $("#cid"); if (sel) { sel.value = b.dataset.cid; renderBoard(); } }); };
  });
}

async function checkout(planOrProduct) {
  try {
    const isPack = planOrProduct === "halftone_single" || planOrProduct === "halftone_pack10";
    const body = isPack ? { product: planOrProduct } : { plan: planOrProduct };
    const data = await api("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (data.checkoutUrl) location.href = data.checkoutUrl;
  } catch (err) {
    const note = $("#billnote");
    if (note) note.textContent = err.message;
  }
}

async function renderSettings() {
  const billed = new URLSearchParams(location.search).get("billing");
  main.innerHTML = `
    <h1 style="font-size:28px;margin-top:0">Shop settings</h1>
    <p class="muted">${escapeHtml(user.email)} · plan <strong>${user.plan}</strong>${user.planExpires ? " · trial until " + user.planExpires : ""}</p>
    ${billed === "ok" ? `<p class="ok">Square returned success. Credits appear once Square confirms the payment.</p>` : ""}
    ${canFloor() ? `
      <form class="form" id="sf">
        <label>Shop name (proofs, tickets, booth poster)</label>
        <input name="name" value="${escapeHtml(shop?.name || "")}" />
        <label>Brand color</label>
        <input name="brand_color" type="color" value="${shop?.brand_color || "#017ece"}" />
        <label>Default margin %</label>
        <input name="margin_pct" type="number" step="0.1" value="${shop?.margin_pct != null ? shop.margin_pct : 20}" />
        <label>Logo</label>
        <input name="logo" type="file" accept="image/*,.svg" />
        <button class="btn" type="submit">Save brand</button>
      </form>
      <h3>Billing</h3>
      ${paywallNote()}
      <p class="muted" id="billnote">${cfg.billing ? "Square is configured. Credits are added only after Square confirms payment." : "Billing not configured — Square env is unset. Checkout returns 501. Admin can still grant credits."}</p>
      <div class="cta-row">
        <button class="btn ghost" data-plan="trial">Trial</button>
        <button class="btn ghost" data-plan="shop">Shop $79</button>
        <button class="btn" data-plan="studio">Studio $149</button>
      </div>
      <h3>Halftones (standalone)</h3>
      <p class="muted">Studio includes unlimited Halftones. Others: $3 / image or $20 for 10 credits. Preview stays free.</p>
      <p class="muted">Credits: <strong>${user.halftoneIncluded ? "Included with Studio" : ((user.halftoneCredits != null ? user.halftoneCredits : 0) + " left")}</strong></p>
      <div class="cta-row">
        <button class="btn ghost" data-plan="halftone_single">Buy $3 / image</button>
        <button class="btn ghost" data-plan="halftone_pack10">Buy $20 for 10</button>
      </div>` : `<p>Client accounts only see assigned jobs and proofs.</p>`}`;
  const sf = $("#sf");
  if (sf) sf.onsubmit = async (e) => {
    e.preventDefault();
    const shopRes = await fetch("/api/shop", { method: "POST", credentials: "include", body: new FormData(sf) });
    shop = (await shopRes.json()).shop;
    if (shop?.logo_path) $("#sideLogo").src = shop.logo_path;
    $("#sideName").textContent = shop.name;
  };
  main.querySelectorAll("[data-plan]").forEach((b) => { b.onclick = () => checkout(b.dataset.plan); });
}

window.DecoStudio = {
  qs: $,
  api: api,
  renderJob: renderJob,
  escapeHtml: escapeHtml,
  loadPalettes: loadPalettes,
  entitled: entitled,
  paywallNote: paywallNote,
  getStation: () => station,
  setStation: (next) => { station = next; },
  extras: [],
  suiteTools: [],
  register: function (mod) { if (mod && mod.id) this.extras.push(mod); },
  registerSuiteTool: function (tool) { if (tool && tool.id) this.suiteTools.push(tool); },
};

boot().catch((err) => { main.innerHTML = `<p class="notice">${escapeHtml(err.message)}</p>`; });
