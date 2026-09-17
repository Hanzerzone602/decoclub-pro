const main = document.getElementById("main");
let user = null, shop = null, view = "make", currentJob = null, station = "art", makeMethod = "apparel";
let cfg = { statuses: [], methods: [], blanks: [], billing: false, demo: false };
const $ = (s, r = document) => r.querySelector(s);
const STAT_LABEL = { new: "New", art_in: "Art in", mockup: "Mockup", priced: "Priced", proof_sent: "Proof sent", approved: "Approved", in_production: "In production", done: "Done" };
const METHODS = ["dtf","uvdtf","uv","vinyl","laser","sticker","screen","hat","apparel","patch","embroidery","sublimation","rhinestone","sign"];
const METHOD_LABELS = {
  dtf: "DTF", uvdtf: "UV DTF", uv: "UV print", vinyl: "Vinyl", laser: "Laser",
  sticker: "Stickers", screen: "Screen", hat: "Hats", apparel: "Apparel", patch: "Patches",
  embroidery: "Digitize", sublimation: "Sublimation", rhinestone: "Rhinestone", sign: "Signs",
};
const METHOD_OUTCOMES = {
  dtf: "22in gang + SVG/EPS", uvdtf: "22in UV gang + SVG/EPS", uv: "SVG + EPS print",
  vinyl: "SVG + EPS cut", laser: "SVG + PLT", sticker: "Kiss-cut SVG + EPS",
  hat: "Cap mockup + SVG/EPS", apparel: "Garment mockup + SVG/EPS", patch: "Badge + DST/EXP",
  embroidery: "DST + EXP stitches", sublimation: "Wrap + SVG/EPS", rhinestone: "SS map + CSV", sign: "Board SVG + EPS",
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
  embroidery: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  sublimation: '<rect x="8" y="4" width="8" height="16" rx="3.5"/><path d="M8 9h8"/>',
  rhinestone: '<path d="M12 3l4 6-4 12L8 9z"/><path d="M8 9h8"/>',
  sign: '<rect x="4" y="5" width="16" height="10" rx="1"/><path d="M12 15v5M8 20h8"/>',
};
const BLANKS = ["tee","hoodie","hat","tumbler","plaque","sticker","sign","hoop"];
const PLACES = ["chest","left_chest","full","back","front","wrap","center"];

async function api(url, opts = {}) {
  opts = Object.assign({ credentials: "include" }, opts);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function money(n) { return "$" + Number(n || 0).toFixed(2); }
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

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
  return `<div class="run-risk ${cls}" id="runRisk"><strong>${escapeHtml(r.title)}</strong> · ${escapeHtml(r.line)}</div>`;
}
function canFloor() {
  return !!(user && (user.role === "shop" || (user.role === "admin" && user.shopId)));
}
function entitled() { return !!(user && user.entitled); }
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

async function boot() {
  cfg = await api("/api/config");
  const me = await api("/api/me");
  if (!me.user) {
    const m = new URLSearchParams(location.search).get("method") || sessionStorage.getItem("decoclub_start_method") || "";
    if (METHODS.indexOf(m) !== -1) {
      sessionStorage.setItem("decoclub_start_method", m);
      location.href = "/login.html?method=" + encodeURIComponent(m);
    } else {
      location.href = "/login.html";
    }
    return;
  }
  user = me.user;
  const s = await api("/api/shop");
  shop = s.shop;
  cfg.billing = s.billing;
  $("#who").textContent = user.name + " · " + user.role + " · " + user.plan + (entitled() ? "" : " · trial");
  if (shop) {
    $("#sideName").textContent = shop.name;
    if (shop.logo_path) $("#sideLogo").src = shop.logo_path;
  }
  $("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); location.href = "/"; };
  const startMethod = consumeStartMethod();
  if (startMethod) makeMethod = startMethod;
  if (!canFloor()) view = "board";
  nav();
  render();
}

function consumeStartMethod() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("method") || "";
  const fromStore = sessionStorage.getItem("decoclub_start_method") || "";
  const method = METHODS.indexOf(fromUrl) !== -1 ? fromUrl : (METHODS.indexOf(fromStore) !== -1 ? fromStore : "");
  sessionStorage.removeItem("decoclub_start_method");
  if (method && (params.get("method") || params.get("station"))) {
    history.replaceState({}, "", "/app.html");
  }
  return method;
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
async function fileToPng(file) {
  if (!file) return file;
  const n = file.name || "";
  const typ = file.type || "";
  if (typ === "image/png" || /\.png$/i.test(n)) return file;
  if (typ === "application/pdf" || /\.pdf$/i.test(n)) throw new Error("Export the PDF as PNG or JPG first");
  try {
    return await rasterToPngFile(file, n);
  } catch (err) {
    if (mustConvertToPng(file)) {
      throw new Error("Could not convert that JPEG/WebP/BMP to PNG. Export a PNG from your design app and drop that.");
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
  const res = await fetch("/api/jobs/" + job.id + "/artwork", { method: "POST", credentials: "include", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not convert artwork");
  return data.job || job;
}
async function startJobFromFile(file, method) {
  if (!file) throw new Error("Pick a file first.");
  file = await fileToPng(file);
  const fd = new FormData();
  fd.append("title", titleFromFile(file));
  fd.append("method", METHODS.indexOf(method) !== -1 ? method : "apparel");
  fd.append("width_in", "10");
  fd.append("height_in", "10");
  fd.append("qty", "1");
  const rm = document.getElementById("rmbg");
  fd.append("remove_bg", !rm || rm.checked ? "1" : "0");
  fd.append("artwork", file);
  const res = await fetch("/api/jobs", { method: "POST", credentials: "include", body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Could not start");
  openJob(data.job.id, "art");
}

function processTileInner(m) {
  const ico = METHOD_ICONS[m] || "";
  return `<svg class="process-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${ico}</svg><span class="process-name">${METHOD_LABELS[m]}</span><span class="process-out">${METHOD_OUTCOMES[m] || ""}</span><span class="process-go">Start job</span>`;
}
function processGridHtml(asButtons) {
  return `<div class="process-grid">${METHODS.map((m) => (
    asButtons
      ? `<button type="button" class="process-tile" data-start-method="${m}">${processTileInner(m)}</button>`
      : `<a class="process-tile" href="/start.html?method=${m}">${processTileInner(m)}</a>`
  )).join("")}</div>`;
}

async function render() {
  if (view === "job" && currentJob) return renderJob(currentJob);
  if (view === "make") return renderMake();
  if (view === "intake") return renderIntake();
  if (view === "clients") return renderClients();
  if (view === "settings") return renderSettings();
  return renderBoard();
}

async function renderMake() {
  if (!canFloor()) {
    view = "board";
    nav();
    return renderBoard();
  }
  // Quiet default method — no process-chip picker on Make
  if (METHODS.indexOf(makeMethod) === -1) makeMethod = "apparel";
  main.innerHTML = `
    <div class="make-home">
      <h1 class="make-title">Drop art. Vectorize. Recolor. Export.</h1>
      <p class="muted make-sub">Vectorize-first studio — clean SVG/EPS for Corel and Illustrator.</p>
      ${paywallNote()}
      <div class="make-drop" id="makeDrop" tabindex="0" role="button" aria-label="Drop art. Vectorize. Recolor. Export. or tap to pick a file">
        <div class="drop-hint">
          <strong>Drop art. Vectorize. Recolor. Export.</strong>
          <span>or tap to pick a file</span>
        </div>
        <input id="makeFile" type="file" accept="image/*,.svg,.pdf" hidden />
      </div>
      <label class="remember"><input id="rmbg" type="checkbox" checked /> Remove background · production</label>
      ${cfg.imagine ? `<div class="card" style="margin-top:18px">
        <div class="kicker">AI Generate</div>
        <p class="muted">Describe a graphic — we place it on this job.</p>
        <textarea id="imaginePrompt" rows="2" placeholder="A varsity mascot, clean print-ready graphic on transparent"></textarea>
        <button class="btn small" type="button" id="imagineGo">AI Generate</button>
      </div>` : ""}
      <p class="notice" id="makeErr"></p>
    </div>`;
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

function openJob(id, st) { currentJob = id; view = "job"; station = st || "art"; nav(); render(); }

async function renderIntake() {
  const { clients } = await api("/api/clients").catch(() => ({ clients: [] }));
  main.innerHTML = `
    <h1 style="font-size:28px;margin-top:0">Intake</h1>
    <p class="muted">Create the job, attach art, assign a client and due date. A proof link is minted immediately (unguessable token). Download a booth poster after save.</p>
    <form class="form" id="jobForm">
      <label>Title</label><input name="title" required placeholder="Club hats — Saturday market" />
      <label>Method</label>
      <select name="method">${METHODS.map((m) => `<option value="${m}">${m}</option>`).join("")}</select>
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
      <label class="remember"><input name="remove_bg" type="checkbox" checked /> Remove background · production</label>
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
  const tabs = [
    ["art","Art"],["digitize","Digitize"],["export","Export"],["mockup","Mockup"],
    ...(PRICE_STATION_ENABLED ? [["price","Price"]] : []),
    ["proof","Proof"],["overview","Overview"],["comments","Comments"]
  ];
  if (!PRICE_STATION_ENABLED && station === "price") station = "art";
  main.innerHTML = `
    <button class="btn ghost small" id="back">← Board</button>
    <div class="row" style="margin-top:12px">
      <h1 style="margin:0;font-size:26px">${escapeHtml(job.title)}</h1>
      <span class="status">${STAT_LABEL[job.status]||job.status}</span>
    </div>
    <p class="muted">${job.method} · ${job.width_in}×${job.height_in} in · qty ${job.qty}${job.due_at ? " · due " + escapeHtml(job.due_at) : ""}</p>
    ${paywallNote()}
    <div class="tabs">${tabs.map(([k,l]) => `<button data-tab="${k}" class="${station===k?"on":""}">${l}</button>`).join("")}</div>
    <div id="station"></div>
    <h3>Timeline</h3>
    <ul class="muted">${(events||[]).map((e) => `<li>${escapeHtml(sanitizeEventMessage(e.message))} · ${new Date(e.created_at).toLocaleString()}</li>`).join("")}</ul>`;
  $("#back").onclick = () => { currentJob = null; view = "board"; nav(); render(); };
  main.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => { station = b.dataset.tab; renderJob(id); }; });
  const el = $("#station");
  if (station === "art") return fillArt(el, job, shopControls);
  if (station === "digitize") return fillDigitize(el, job, shopControls);
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
  const hasArt = !!(job.vector_svg || job.file_path);
  const preview = job.vector_svg
    ? `<div id="artZoomSvg" class="art-svg-host" data-src="${escapeHtml(job.vector_svg)}"></div>`
    : (job.file_path ? `<img id="artZoomImg" src="${job.file_path}" alt="Art" draggable="false" />` : `<div class="drop-hint"><strong>Drop art here</strong><span>PNG, JPG, or WebP</span></div>`);
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
      ${pantones.length ? `<select class="layer-pal" data-layer="${i}" title="Optional Pantone match">
        <option value="">Pantone (optional)</option>
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
    ? `<p class="muted vz-used" id="vzUsed">Last run · Detail ${escapeHtml(detailReadout(toPct(lastSet.detail, DETAIL_LEGACY, 50)))} · Smoothing ${escapeHtml(smoothReadout(toPct(lastSet.smoothing, SMOOTH_LEGACY, 50)))} · Corners ${escapeHtml(cornerReadout(toPct(lastSet.cornerSmooth, CORNER_LEGACY, 50)))}</p>`
    : `<p class="muted vz-used" id="vzUsed" hidden></p>`;

  el.innerHTML = `
    <div class="split art-simple">
      <div class="art-stage">
        <div class="preview art-drop${hasArt ? " has-art" : ""}" id="artDrop" tabindex="0">
          <div class="art-zoom-inner" id="artZoomInner">${preview}</div>
        </div>
        ${hasArt ? `<div class="zoom-bar">
          <button type="button" class="zoom-btn" id="zoomOut" title="Zoom out">−</button>
          <button type="button" class="zoom-btn" id="zoomFit" title="Fit">Fit</button>
          <button type="button" class="zoom-btn" id="zoomIn" title="Zoom in">+</button>
          <span class="zoom-readout" id="zoomRead">100%</span>
          <span class="muted">Scroll to zoom · drag to pan</span>
        </div>` : ""}
        <input id="artFile" type="file" accept="image/*,.svg,.pdf" hidden />
      </div>
      <div class="art-tools">
        ${shopControls ? `
        ${runRiskHtml(job)}
        <div class="art-actions">
          <button class="btn primary" id="vectorizeBtn" type="button">Vectorize</button>
          <button class="btn ghost" id="greyBtn" type="button">Hi-res greyscale</button>
          <button class="btn ghost" id="invertBtn" type="button">Invert black &amp; white</button>
        </div>
        <p class="muted">Turn your mark into smooth production paths — SVG and EPS ready for Corel and Illustrator.</p>
        <div class="vz-options" id="vzOptions">
          ${continuousSliderRow("detailRow", "Detail", "How many colors to keep — drag for live preview",
            initDetail, "Simple", "Fine art", detailReadout)}
          ${continuousSliderRow("smoothRow", "Smoothing", "Round out jagged edges from photos and screenshots",
            initSmooth, "Sharp", "Smooth", smoothReadout)}
          ${continuousSliderRow("cornerRow", "Corner smoothness", "Sharp corners for type and badges, soft for organic shapes",
            initCorner, "Sharp", "Soft", cornerReadout)}
          <p class="muted vz-live-hint" id="vzLiveHint">Drag sliders to update the preview live after Vectorize.</p>
        </div>
        ${usedLine}` : ""}
        ${shopControls && layers.length ? `<div class="color-mode-row" id="colorModeRow">
          <span class="muted">Layer colors</span>
          <div class="vz-seg-row color-mode-seg">
            <button type="button" class="vz-seg${initColorMode==="rgb"?" on":""}" data-mode="rgb" title="Edit as screen RGB">RGB</button>
            <button type="button" class="vz-seg${initColorMode==="cmyk"?" on":""}" data-mode="cmyk" title="Edit as print CMYK">CMYK</button>
          </div>
        </div>` : ""}
        <div class="layer-list${shopControls ? " color-mode-" + initColorMode : ""}">${layerRows}</div>
        ${shopControls && (layers.length || job.vector_svg) ? `<div class="export-grid export-hero art-dl">
          <a href="/api/export/${job.id}/art.svg">Download SVG</a>
          <a href="/api/export/${job.id}/art.eps">Download EPS</a>
        </div>
        <p class="muted">Production SVG / EPS · real curves</p>` : ""}
        ${shopControls && job.file_path && !job.vector_svg ? `<div class="export-grid export-hero art-dl">
          <a href="/api/export/${job.id}/art.png" id="dlArtPng">Download PNG</a>
        </div>
        <p class="muted">Raster art · PNG</p>` : ""}
        ${shopControls ? `
        <details class="art-more">
          <summary>More tools</summary>
          <label class="remember"><input id="rmbg" type="checkbox" checked /> Remove background on replace</label>
          <div class="row">
            <button class="btn small" type="button" id="replaceBtn">Replace art</button>
            <button class="btn small" type="button" id="rmbgBtn">Remove background</button>
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
      </div>
    </div>`;
  if (!shopControls) return;

  let vzDetail = initDetail;
  let vzSmooth = initSmooth;
  let vzCorner = initCorner;
  let colorMode = initColorMode === "cmyk" ? "cmyk" : "rgb";

  let vzLiveTimer = null;
  let vzLiveBusy = false;
  let vzLiveQueued = false;
  function scheduleLiveVectorize() {
    if (!job.file_path) return;
    const errEl = $("#err");
    const hint = $("#vzLiveHint");
    if (hint) hint.textContent = "Updating preview…";
    if (errEl && !vzLiveBusy) errEl.textContent = "Updating preview…";
    clearTimeout(vzLiveTimer);
    vzLiveTimer = setTimeout(async () => {
      if (vzLiveBusy) { vzLiveQueued = true; return; }
      vzLiveBusy = true;
      try {
        await runVectorize(null, { live: true });
      } catch (err) {
        if (errEl) errEl.textContent = err.message;
        if (hint) hint.textContent = "Drag sliders to update the preview live after Vectorize.";
      } finally {
        vzLiveBusy = false;
        if (vzLiveQueued) {
          vzLiveQueued = false;
          scheduleLiveVectorize();
        }
      }
    }, 450);
  }
  function bindContinuousSlider(rowId, prefKey, readout, setVal) {
    const slider = el.querySelector("#" + rowId + "Slider");
    const valEl = el.querySelector("#" + rowId + "Val");
    if (!slider) return;
    const apply = (n, live) => {
      const v = Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
      setVal(v);
      saveVzPref(prefKey, v);
      if (valEl) valEl.textContent = readout(v);
      if (live) scheduleLiveVectorize();
    };
    slider.oninput = () => apply(slider.value, true);
    slider.onchange = () => apply(slider.value, true);
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
    try {
      file = await fileToPng(file);
      const fd = new FormData();
      fd.append("artwork", file);
      const rm = document.getElementById("rmbg");
      fd.append("remove_bg", !rm || rm.checked ? "1" : "0");
      const res = await fetch("/api/jobs/" + job.id + "/artwork", { method: "POST", credentials: "include", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { $("#err").textContent = data.error || "Could not upload artwork"; return; }
      renderJob(job.id);
    } catch (err) {
      $("#err").textContent = err.message;
    }
  }
  const artFile = $("#artFile");
  const drop = $("#artDrop");
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
  if (hasArt) {
    const host = $("#artZoomSvg");
    if (host && host.dataset.src) {
      fetch(host.dataset.src, { credentials: "include" }).then((r) => r.text()).then((svg) => {
        host.innerHTML = svg;
        const elSvg = host.querySelector("svg");
        if (elSvg) {
          elSvg.removeAttribute("width");
          elSvg.removeAttribute("height");
          elSvg.setAttribute("preserveAspectRatio", "xMidYMid meet");
          elSvg.style.width = "100%";
          elSvg.style.height = "auto";
        }
        bindArtZoom(drop);
      }).catch(() => {
        host.outerHTML = '<img id="artZoomImg" src="' + host.dataset.src + '" alt="Vector" draggable="false" />';
        bindArtZoom(drop);
      });
    } else {
      bindArtZoom(drop);
    }
  }
  $("#rmbgBtn").onclick = async () => {
    try {
      await ensurePngArtwork(job);
      await api("/api/jobs/" + job.id + "/artops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ remove_background: true, knockout: "production" }) });
      renderJob(job.id);
    } catch (err) { $("#err").textContent = err.message; }
  };
  $("#ko").onclick = async () => {
    try { await api("/api/jobs/" + job.id + "/artops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ knockout: "white" }) }); renderJob(job.id); }
    catch (err) { $("#err").textContent = err.message; }
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
      const hasVec = !!(job.vector_svg || (job.vector && job.vector.layers && job.vector.layers.length));
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
    if (errEl) errEl.textContent = opts.live ? "Updating preview…" : "Vectorizing…";
    await ensurePngArtwork(job);
    const maxEdge = opts.live ? 900 : 1100;
    const payload = {
      detail: vzDetail,
      smoothing: vzSmooth,
      cornerSmooth: vzCorner,
      maxEdge: maxEdge,
      fuse: "auto",
      live: !!opts.live,
    };
    if (engine) payload.engine = engine;
    saveVzPref("detail", vzDetail);
    saveVzPref("smoothing", vzSmooth);
    saveVzPref("corner", vzCorner);
    const res = await api("/api/jobs/" + job.id + "/vectorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const meta = (res && res.meta) || (res && res.vector && res.vector.meta) || {};
    const used = meta.settings || { detail: vzDetail, smoothing: vzSmooth, cornerSmooth: vzCorner };
    const d = toPct(used.detail, DETAIL_LEGACY, vzDetail);
    const sm = toPct(used.smoothing, SMOOTH_LEGACY, vzSmooth);
    const c = toPct(used.cornerSmooth, CORNER_LEGACY, vzCorner);
    if (errEl) {
      errEl.textContent = (opts.live ? "Live · " : "Used · ") + "Detail " + d + " · Smoothing " + sm + " · Corners " + c;
    }
    const usedEl = $("#vzUsed");
    if (usedEl) {
      usedEl.hidden = false;
      usedEl.textContent = "Last run · Detail " + detailReadout(d) + " · Smoothing " + smoothReadout(sm) + " · Corners " + cornerReadout(c);
    }
    if (hint) hint.textContent = "Drag sliders to update the preview live.";
    renderJob(job.id);
  }

  const vz = $("#vectorizeBtn");
  if (vz) vz.onclick = async () => {
    try { await runVectorize(); }
    catch (err) { $("#err").textContent = err.message; }
  };
  const pvz = $("#proVectorizeBtn");
  if (pvz) pvz.onclick = async () => {
    try { await runVectorize("vtracer"); }
    catch (err) { $("#err").textContent = err.message; }
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

function bindArtZoom(stage) {
  const inner = $("#artZoomInner", stage) || $("#artZoomInner");
  if (!inner) return;
  let scale = 1, x = 0, y = 0, drag = null;
  function apply() {
    inner.style.transform = "translate(" + x + "px, " + y + "px) scale(" + scale + ")";
    const r = $("#zoomRead");
    if (r) r.textContent = Math.round(scale * 100) + "%";
  }
  function zoomTo(next, cx, cy) {
    const old = scale;
    scale = Math.max(0.25, Math.min(8, next));
    if (cx != null) {
      x = cx - ((cx - x) * (scale / old));
      y = cy - ((cy - y) * (scale / old));
    }
    apply();
  }
  const zin = $("#zoomIn"), zout = $("#zoomOut"), zfit = $("#zoomFit");
  if (zin) zin.onclick = (e) => { e.stopPropagation(); zoomTo(scale * 1.25); };
  if (zout) zout.onclick = (e) => { e.stopPropagation(); zoomTo(scale / 1.25); };
  if (zfit) zfit.onclick = (e) => { e.stopPropagation(); scale = 1; x = 0; y = 0; apply(); };
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    zoomTo(scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX - x, y: e.clientY - y };
    stage.classList.add("panning");
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    x = e.clientX - drag.x;
    y = e.clientY - drag.y;
    apply();
  });
  stage.addEventListener("pointerup", () => { drag = null; stage.classList.remove("panning"); });
  apply();
}

function fillMockup(el, job, shopControls) {
  el.innerHTML = `
    <div class="split">
      <div class="preview">${job.mockup_path ? `<img src="${job.mockup_path}" alt="Mockup" />` : `<span class="muted">Generate a blank</span>`}</div>
      <div>
        ${shopControls ? `
          <form id="mk" class="form">
            <label>Search catalog (style code)</label>
            <input id="skuq" type="search" placeholder="PC54, 18000, C112, DC-LASER…" value="${escapeHtml(job.catalog_code || "")}" autocomplete="off" />
            <div id="skulist" class="sku-list muted">Type a SanMar-style code or DecoClub hardgood.</div>
            <input type="hidden" name="catalog_code" id="skucode" value="${escapeHtml(job.catalog_code || "")}" />
            <p id="skupicked" class="muted">${job.catalog_code ? "Selected " + escapeHtml(job.catalog_code) : "No SKU selected"}</p>
            <label>Blank</label>
            <select name="blank">${BLANKS.map((b) => `<option value="${b}" ${b===(job.blank||"")?"selected":""}>${b}</option>`).join("")}</select>
            <label>Garment / substrate color</label>
            <input name="garment_color" type="color" value="${job.garment_color || "#2c3138"}" />
            <label>Placement</label>
            <select name="placement" id="placeSel">${PLACES.map((p) => `<option value="${p}" ${p===job.placement?"selected":""}>${p}</option>`).join("")}</select>
            <button class="btn" type="submit">Generate mockup</button>
          </form>` : `<p class="muted">Placement mockup for review.${job.catalog_code ? " · " + escapeHtml(job.catalog_code) : ""}</p>`}
      </div>
    </div>`;
  const mk = $("#mk");
  if (!mk) return;
  const qEl = $("#skuq");
  const list = $("#skulist");
  let timer = null;
  async function runSearch() {
    const q = qEl.value.trim();
    if (q.length < 2) { list.textContent = "Type at least 2 characters."; return; }
    const data = await api("/api/catalog?q=" + encodeURIComponent(q));
    const rows = (data.skus || []).slice(0, 24);
    if (!rows.length) { list.textContent = "No SKUs match."; return; }
    list.innerHTML = rows.map((s) => `<button type="button" class="sku-hit" data-code="${escapeHtml(s.code)}" data-kind="${escapeHtml(s.kind)}" data-hex="${escapeHtml(s.hex)}" data-place="${escapeHtml((s.placements[0] && s.placements[0].id) || "center")}">
      <strong>${escapeHtml(s.code)}</strong> <span>${escapeHtml(s.name)}</span>
    </button>`).join("");
    list.querySelectorAll(".sku-hit").forEach((b) => {
      b.onclick = () => {
        $("#skucode").value = b.dataset.code;
        $("#skupicked").textContent = "Selected " + b.dataset.code;
        mk.blank.value = b.dataset.kind;
        mk.garment_color.value = b.dataset.hex;
        if (b.dataset.place) mk.placement.value = b.dataset.place;
      };
    });
  }
  qEl.oninput = () => { clearTimeout(timer); timer = setTimeout(runSearch, 180); };
  if ((job.catalog_code || "").length >= 2) runSearch().catch(() => {});
  mk.onsubmit = async (e) => {
    e.preventDefault();
    await api("/api/jobs/" + job.id + "/mockup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(mk).entries())) });
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
      <select name="method">${METHODS.map((m) => `<option value="${m}" ${m===job.method?"selected":""}>${m}</option>`).join("")}</select>
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
    <select name="l${i}method">${METHODS.map((m) => `<option value="${m}" ${m===it.method?"selected":""}>${m}</option>`).join("")}</select>
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

let digitizeView = null;
async function fillDigitize(el, job, shopControls) {
  if (!shopControls) { el.innerHTML = "<p class='muted'>Digitize is shop-only.</p>"; return; }
  if (!entitled()) {
    el.innerHTML = paywallNote() + "<p class='muted'>DST / EXP packets need Shop or Studio. Vectorize stays on trial.</p>";
    return;
  }
  const pals = await loadPalettes();
  const madeira = pals.madeiraRayon || pals.thread || [];
  const w0 = Number(job.width_in) || 1;
  const h0 = Number(job.height_in) || 1;
  el.innerHTML = `
    <div class="split digitize-station">
      <div class="dig-stage">
        <canvas id="digView" class="dig-canvas"></canvas>
        <p class="muted">Drag to orbit · scroll to zoom · fabric + thread tubes (not Wilcom TrueView)</p>
      </div>
      <div class="dig-tools">
        <p class="stat" id="digCount">${job.stitchCount != null ? Number(job.stitchCount).toLocaleString() + " stitches" : "— stitches"}</p>
        <p class="muted" id="digMeta">${escapeHtml((job.digitizeExporter || "") + (job.colorStops && job.colorStops[0] ? " · " + job.colorStops[0].madeiraCode + " " + job.colorStops[0].name : ""))}</p>
        <label>Width (in) <span id="digWread">${w0}</span></label>
        <input id="digW" type="range" min="0.4" max="6" step="0.05" value="${w0}" />
        <label>Height (in) <span id="digHread">${h0}</span></label>
        <input id="digH" type="range" min="0.4" max="6" step="0.05" value="${h0}" />
        <label class="remember"><input id="digLock" type="checkbox" checked /> Lock aspect</label>
        <label>Density (mm) <span id="digDread">0.40</span></label>
        <input id="digD" type="range" min="0.22" max="0.70" step="0.02" value="0.40" />
        <label>Satin spacing (mm) <span id="digSread">0.40</span></label>
        <input id="digS" type="range" min="0.25" max="0.80" step="0.05" value="0.40" />
        <label>Fabric</label>
        <select id="digFabric">
          <option value="knit" selected>Knit / jersey</option>
          <option value="woven">Woven / poplin</option>
          <option value="twill">Twill / chino</option>
          <option value="pique">Pique / polo</option>
          <option value="fleece">Fleece / sweat</option>
          <option value="cap">Cap front</option>
        </select>
        <label>Stitch player <span id="digPread">100%</span></label>
        <input id="digPlayer" type="range" min="0" max="100" step="1" value="100" />
        <div class="cta-row">
          <button type="button" class="btn ghost small" id="digPlay">Play</button>
          <button type="button" class="btn ghost small" id="digPause">Pause</button>
        </div>
        <label>Madeira Rayon</label>
        <input id="digFilter" class="field" placeholder="Search code or name" />
        <select id="digThread" size="8" class="dig-thread"></select>
        <p class="muted">On-screen match, not a certified spool. Size/density restitches. Thread swap recolors only.</p>
        <div class="export-grid export-hero art-dl">
          <a href="/api/export/${job.id}/design.dst">Download DST</a>
          <a href="/api/export/${job.id}/design.exp">Download EXP</a>
          <a href="/api/export/${job.id}/stitch-preview.svg">2D preview SVG</a>
        </div>
        <p class="notice" id="digErr"></p>
      </div>
    </div>`;
  const threadSel = $("#digThread");
  function fillThreadOpts(q) {
    const qq = String(q || "").toLowerCase();
    const list = madeira.filter((c) => !qq || String(c.code).indexOf(qq) !== -1 || String(c.name).toLowerCase().indexOf(qq) !== -1);
    threadSel.innerHTML = list.slice(0, 80).map((c) =>
      `<option value="${escapeHtml(c.hex)}" data-code="${escapeHtml(c.code || "")}" data-name="${escapeHtml(c.name || "")}">${escapeHtml((c.code ? c.code + " · " : "") + c.name)}</option>`
    ).join("");
  }
  fillThreadOpts("");
  $("#digFilter").oninput = () => fillThreadOpts($("#digFilter").value);
  const aspect = w0 / (h0 || 1);
  let payload = null;
  let timer = 0;
  function readSize() {
    return { widthIn: Number($("#digW").value), heightIn: Number($("#digH").value), density: Number($("#digD").value), satinSpacingMm: Number($("#digS").value), fabric: $("#digFabric") ? $("#digFabric").value : "knit" };
  }
  async function restitch() {
    const s = readSize();
    $("#digWread").textContent = s.widthIn.toFixed(2);
    $("#digHread").textContent = s.heightIn.toFixed(2);
    $("#digDread").textContent = s.density.toFixed(2);
    $("#digSread").textContent = s.satinSpacingMm.toFixed(2);
    $("#digErr").textContent = "Restitching…";
    try {
      const data = await api("/api/jobs/" + job.id + "/digitize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ widthIn: s.widthIn, heightIn: s.heightIn, density: s.density, satinSpacingMm: s.satinSpacingMm, fabric: s.fabric, previewOnly: true }),
      });
      payload = data.preview;
      $("#digCount").textContent = Number(data.stitchCount).toLocaleString() + " stitches";
      const stop = (data.colorStops && data.colorStops[0]) || {};
      $("#digMeta").textContent = (data.objects || []).map((o) => o.type).join(" + ") + " · " + (data.exporter || "") + (stop.madeiraCode ? " · " + stop.madeiraCode + " " + stop.name : "");
      $("#digErr").textContent = data.usedFallback ? "Art was too thin — used a fill block. Vectorize first for a real logo." : "";
      if (payload && window.DigitizePreview) {
        const canvas = $("#digView");
        if (digitizeView && digitizeView.canvas === canvas) digitizeView.setPayload(payload);
        else {
          if (digitizeView && digitizeView.stop) digitizeView.stop();
          digitizeView = window.DigitizePreview.mount(canvas, payload);
        }
      }
    } catch (err) {
      $("#digErr").textContent = err.message;
    }
  }
  function debounce() { clearTimeout(timer); timer = setTimeout(restitch, 250); }
  $("#digW").oninput = () => {
    if ($("#digLock").checked) $("#digH").value = (Number($("#digW").value) / aspect).toFixed(2);
    debounce();
  };
  $("#digH").oninput = () => {
    if ($("#digLock").checked) $("#digW").value = (Number($("#digH").value) * aspect).toFixed(2);
    debounce();
  };
  $("#digD").oninput = debounce;
  $("#digS").oninput = debounce;
  if ($("#digFabric")) $("#digFabric").onchange = restitch;
  if ($("#digPlayer")) $("#digPlayer").oninput = () => {
    const t = Number($("#digPlayer").value) / 100;
    $("#digPread").textContent = Math.round(t * 100) + "%";
    if (digitizeView && digitizeView.setPlayhead) digitizeView.setPlayhead(t);
  };
  if ($("#digPlay")) $("#digPlay").onclick = () => { if (digitizeView && digitizeView.play) digitizeView.play(0.16); };
  if ($("#digPause")) $("#digPause").onclick = () => { if (digitizeView && digitizeView.pause) digitizeView.pause(); };
  threadSel.onchange = async () => {
    const opt = threadSel.selectedOptions[0];
    if (!opt || !payload) return;
    const hex = opt.value, code = opt.dataset.code, name = opt.dataset.name;
    payload.threads = (payload.threads || []).map((t, i) => i === 0 ? Object.assign({}, t, { hex: hex, code: code, name: name }) : t);
    if (digitizeView) digitizeView.recolor(payload.threads);
    try {
      await api("/api/jobs/" + job.id + "/digitize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recolorOnly: true, threads: [{ layerIndex: 0, hex: hex, code: code, name: name }] }),
      });
    } catch (err) { $("#digErr").textContent = err.message; }
  };
  await restitch();
}

function fillProduce(el, job, shopControls) {
  if (!shopControls) { el.innerHTML = "<p class='muted'>Export files are shop-only.</p>"; return; }
  if (!entitled()) { el.innerHTML = paywallNote() + "<p class='muted'>Some art exports stay locked until a member account is active. Admin stays open.</p>"; return; }
  const stitch = job.stitchCount != null ? job.stitchCount : (job.vector ? "run Export" : "—");
  const stones = job.stones && job.stones.count != null ? job.stones.count : "—";
  el.innerHTML = `
    <p class="muted">Process files from this art. SVG + EPS for Corel. DST + EXP stitches. Rhinestone SS map + CSV. 3D stitch preview lives on the Digitize tab.</p>
    <p class="mono">Stitches ${escapeHtml(String(stitch))} · Stones ${escapeHtml(String(stones))}${job.digitizeExporter ? " · " + escapeHtml(job.digitizeExporter) : ""}</p>
    <div class="export-grid export-hero">
      <a href="/api/export/${job.id}/art.svg">SVG</a>
      <a href="/api/export/${job.id}/art.eps">EPS</a>
      <a href="/api/export/${job.id}/design.dst">DST</a>
      <a href="/api/export/${job.id}/design.exp">EXP</a>
      <a href="/api/export/${job.id}/stones.svg">Stones SVG</a>
      <a href="/api/export/${job.id}/stones.csv">Stones CSV</a>
      <a href="/api/export/${job.id}/stones.plt">Stones PLT</a>
      <a href="/api/export/${job.id}/stitch-preview.svg">Stitch preview</a>
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

async function checkout(plan) {
  try {
    const data = await api("/api/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan }) });
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
    ${billed === "ok" ? `<p class="ok">Stripe returned success. Plan updates when the webhook lands.</p>` : ""}
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
      <p class="muted" id="billnote">${cfg.billing ? "Stripe is configured. Checkout does not mark the shop paid until the webhook." : "Billing not configured — STRIPE_SECRET_KEY is unset. Checkout returns 501. We will not fake a paid plan. Admin still runs the floor for free."}</p>
      <div class="cta-row">
        <button class="btn ghost" data-plan="trial">Trial</button>
        <button class="btn ghost" data-plan="shop">Shop $79</button>
        <button class="btn" data-plan="studio">Studio $149</button>
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

boot().catch((err) => { main.innerHTML = `<p class="notice">${escapeHtml(err.message)}</p>`; });
