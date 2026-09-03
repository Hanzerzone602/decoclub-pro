const main = document.getElementById("main");
let user = null, shop = null, view = "make", currentJob = null, station = "art", makeMethod = "apparel";
let cfg = { statuses: [], methods: [], blanks: [], billing: false, demo: false };
const $ = (s, r = document) => r.querySelector(s);
const STAT_LABEL = { new: "New", art_in: "Art in", mockup: "Mockup", priced: "Priced", proof_sent: "Proof sent", approved: "Approved", in_production: "In production", done: "Done" };
const METHODS = ["dtf","uvdtf","uv","vinyl","laser","sticker","hat","apparel","patch","embroidery","sublimation","rhinestone","sign"];
const METHOD_LABELS = {
  dtf: "DTF", uvdtf: "UV DTF", uv: "UV print", vinyl: "Vinyl", laser: "Laser",
  sticker: "Stickers", hat: "Hats", apparel: "Apparel", patch: "Patches",
  embroidery: "Embroidery", sublimation: "Sublimation", rhinestone: "Rhinestone", sign: "Signs",
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
function canFloor() {
  return !!(user && (user.role === "shop" || (user.role === "admin" && user.shopId)));
}
function entitled() { return !!(user && user.entitled); }
function paywallNote() {
  if (entitled()) return "";
  return '<p class="notice" id="paywall">Proofs and packets need Shop or Studio. Only admin runs the full floor for free.</p>';
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
async function startJobFromFile(file, method) {
  if (!file) throw new Error("Pick a file first.");
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
  const chips = METHODS.map((m) => `<button type="button" class="process-chip${m===makeMethod?" on":""}" data-chip="${m}">${METHOD_LABELS[m]}</button>`).join("");
  main.innerHTML = `
    <div class="make-home">
      <h1 class="make-title">Drop art. Vectorize. Recolor. Export.</h1>
      <p class="muted make-sub">Studio first — layers, palettes, stitches, stones.</p>
      ${paywallNote()}
      <div class="make-drop" id="makeDrop" tabindex="0" role="button" aria-label="Drop art. Vectorize. Recolor. Export. or tap to pick a file">
        <div class="drop-hint">
          <strong>Drop art. Vectorize. Recolor. Export.</strong>
          <span>or tap to pick a file</span>
        </div>
        <input id="makeFile" type="file" accept="image/*,.svg,.pdf" hidden />
      </div>
      <label class="remember"><input id="rmbg" type="checkbox" checked /> Remove background · production</label>
      <div class="process-chips" id="makeChips">${chips}</div>
      <div class="card" style="margin-top:18px">
        <div class="kicker">Grok Imagine</div>
        <p class="muted">Newest image model. Typed art for this process.</p>
        <textarea id="imaginePrompt" rows="2" placeholder="A varsity mascot, clean print-ready graphic on transparent"></textarea>
        <button class="btn small" type="button" id="imagineGo">Generate</button>
        <p class="muted" id="imagineHint"></p>
      </div>
      <p class="notice" id="makeErr"></p>
    </div>`;
  main.querySelectorAll("[data-chip]").forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      makeMethod = b.dataset.chip;
      main.querySelectorAll("[data-chip]").forEach((x) => x.classList.toggle("on", x.dataset.chip === makeMethod));
    };
  });
  const drop = $("#makeDrop");
  const fileEl = $("#makeFile");
  async function take(file) {
    try {
      await startJobFromFile(file, makeMethod);
    } catch (err) {
      $("#makeErr").textContent = err.message;
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
  const hint = $("#imagineHint");
  if (!cfg.imagine && hint) hint.textContent = "Imagine is warming up on the server.";
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
            <span>${money(j.total)}${j.due_at ? " · due " + escapeHtml(j.due_at) : ""}</span>
          </div>`).join("");
      return `<div class="col"><h4>${STAT_LABEL[s]||s} · ${col.length}</h4>${cards}</div>`;
    }).join("");
    const rows = jobs.map((j) => `<tr>
          <td>${escapeHtml(j.title)}</td><td class="muted">${(j.client_id||"—").slice(0,8)}</td>
          <td>${j.method}</td><td><span class="status">${STAT_LABEL[j.status]||j.status}</span></td>
          <td>${escapeHtml(j.due_at||"—")}</td><td class="mono">${money(j.total)}</td>
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
      <thead><tr><th>Title</th><th>Client</th><th>Method</th><th>Status</th><th>Due</th><th>Total</th><th></th></tr></thead>
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
  const tabs = [
    ["art","Art"],["export","Export"],["mockup","Mockup"],["price","Price"],
    ["proof","Proof"],["overview","Overview"],["comments","Comments"]
  ];
  main.innerHTML = `
    <button class="btn ghost small" id="back">← Board</button>
    <div class="row" style="margin-top:12px">
      <h1 style="margin:0;font-size:26px">${escapeHtml(job.title)}</h1>
      <span class="status">${STAT_LABEL[job.status]||job.status}</span>
    </div>
    <p class="muted">${job.method} · ${job.width_in}×${job.height_in} in · qty ${job.qty} · ${money(job.total)}${job.due_at ? " · due " + escapeHtml(job.due_at) : ""}</p>
    ${paywallNote()}
    <div class="tabs">${tabs.map(([k,l]) => `<button data-tab="${k}" class="${station===k?"on":""}">${l}</button>`).join("")}</div>
    <div id="station"></div>
    <h3>Timeline</h3>
    <ul class="muted">${(events||[]).map((e) => `<li>${escapeHtml(e.message)} · ${new Date(e.created_at).toLocaleString()}</li>`).join("")}</ul>`;
  $("#back").onclick = () => { currentJob = null; view = "board"; nav(); render(); };
  main.querySelectorAll("[data-tab]").forEach((b) => { b.onclick = () => { station = b.dataset.tab; renderJob(id); }; });
  const el = $("#station");
  if (station === "art") return fillArt(el, job, shopControls);
  if (station === "mockup") return fillMockup(el, job, shopControls);
  if (station === "price") return fillPrice(el, job, shopControls);
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
  try { palettesCache = await api("/api/palettes"); } catch (e) { palettesCache = { vinyl: [], thread: [], stone: [], process: [] }; }
  return palettesCache;
}
function palSelect(kind, palettes, currentHex) {
  const list = (palettes && palettes[kind]) || [];
  const opts = list.map((c) => `<option value="${escapeHtml(c.hex)}" ${String(c.hex).toLowerCase()===String(currentHex||"").toLowerCase()?"selected":""}>${escapeHtml(c.name)}</option>`).join("");
  return `<select data-pal="${kind}"><option value="">${kind}</option>${opts}</select>`;
}

async function fillArt(el, job, shopControls) {
  const pals = shopControls ? await loadPalettes() : { vinyl: [], thread: [], stone: [] };
  const layers = (job.vector && job.vector.layers) || [];
  const preview = job.vector_svg
    ? `<img src="${job.vector_svg}" alt="Vector" />`
    : (job.file_path ? `<img src="${job.file_path}" alt="Art" />` : `<div class="drop-hint"><span class="kicker">Studio drop</span><strong>Drop art here</strong><span>PNG, SVG, or PDF — click to browse</span></div>`);
  const layerRows = layers.map((L, i) => `
    <div class="layer-row" data-layer="${i}">
      <span class="layer-chip" style="background:${escapeHtml(L.hex)}"></span>
      <span class="layer-name">${escapeHtml(L.nameGuess || ("Layer " + (i+1)))}</span>
      ${palSelect("vinyl", pals, L.hex)}
      ${palSelect("thread", pals, L.hex)}
      ${palSelect("stone", pals, L.hex)}
    </div>`).join("") || `<p class="muted">No vector layers yet. Vectorize a PNG.</p>`;
  el.innerHTML = `
    <div class="split">
      <div class="preview art-drop" id="artDrop" tabindex="0" role="button" aria-label="Drop art or click to upload">
        ${preview}
      </div>
      <div>
        <p class="muted">Vector layers, named palettes, knockout, Imagine. Recolor applies immediately.</p>
        ${shopControls ? `<button class="btn" id="vectorizeBtn" type="button">Vectorize</button>` : ""}
        <div class="layer-list">${layerRows}</div>
        <label>Art notes</label>
        <textarea id="artn" rows="3">${escapeHtml(job.art_notes||"")}</textarea>
        ${shopControls ? `
          <form id="up" style="margin:12px 0">
            <input name="artwork" id="artFile" type="file" accept="image/*,.svg,.pdf" />
            <label class="remember"><input name="remove_bg" id="rmbg" type="checkbox" checked /> Remove background · production</label>
            <button class="btn small" type="submit">Replace artwork</button>
          </form>
          <div class="row">
            <button class="btn small" id="rmbgBtn">Remove background</button>
            <button class="btn ghost small" id="ko">Knockout white</button>
          </div>
          <div class="card" style="margin:12px 0">
            <div class="kicker">Grok Imagine</div>
            <textarea id="imaginePrompt" rows="2" placeholder="Edit this art or describe a new graphic"></textarea>
            <button class="btn small" type="button" id="imagineGo">Imagine</button>
          </div>
          <form id="swap" class="form">
            <label>Color swap from → to</label>
            <div class="row"><input name="from" placeholder="#000000" /><input name="to" type="color" value="#c9b896" /><button class="btn small" type="submit">Swap</button></div>
          </form>
          <button class="btn small" id="saveArtN">Save notes</button>
          <p class="notice" id="err"></p>` : ""}
      </div>
    </div>`;
  if (!shopControls) return;
  async function uploadArtwork(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append("artwork", file);
    const rm = document.getElementById("rmbg");
    fd.append("remove_bg", !rm || rm.checked ? "1" : "0");
    const res = await fetch("/api/jobs/" + job.id + "/artwork", { method: "POST", credentials: "include", body: fd });
    const data = await res.json();
    if (!res.ok) { $("#err").textContent = data.error; return; }
    renderJob(job.id);
  }
  const artFile = $("#artFile");
  const drop = $("#artDrop");
  artFile.onchange = () => { if (artFile.files && artFile.files[0]) uploadArtwork(artFile.files[0]); };
  drop.onclick = () => artFile.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); artFile.click(); } };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("dragover"); };
  drop.ondragleave = () => drop.classList.remove("dragover");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("dragover");
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) uploadArtwork(f);
  };
  $("#up").onsubmit = async (e) => {
    e.preventDefault();
    const file = artFile.files && artFile.files[0];
    if (file) return uploadArtwork(file);
    const res = await fetch("/api/jobs/" + job.id + "/artwork", { method: "POST", credentials: "include", body: new FormData(e.target) });
    const data = await res.json();
    if (!res.ok) { $("#err").textContent = data.error; return; }
    renderJob(job.id);
  };
  $("#rmbgBtn").onclick = async () => {
    try { await api("/api/jobs/" + job.id + "/artops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ remove_background: true, knockout: "production" }) }); renderJob(job.id); }
    catch (err) { $("#err").textContent = err.message; }
  };
  $("#ko").onclick = async () => {
    try { await api("/api/jobs/" + job.id + "/artops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ knockout: "white" }) }); renderJob(job.id); }
    catch (err) { $("#err").textContent = err.message; }
  };
  const ig = $("#imagineGo");
  if (ig) ig.onclick = async () => {
    const prompt = ($("#imaginePrompt") && $("#imaginePrompt").value || "").trim();
    if (!prompt) { $("#err").textContent = "Describe the graphic first."; return; }
    try { await api("/api/jobs/" + job.id + "/imagine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: prompt }) }); renderJob(job.id); }
    catch (err) { $("#err").textContent = err.message; }
  };
  $("#swap").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try { await api("/api/jobs/" + job.id + "/artops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ color_swap: { from: fd.get("from"), to: fd.get("to") } }) }); renderJob(job.id); }
    catch (err) { $("#err").textContent = err.message; }
  };
  $("#saveArtN").onclick = async () => {
    await api("/api/jobs/" + job.id, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ art_notes: $("#artn").value }) });
    renderJob(job.id);
  };
  const vz = $("#vectorizeBtn");
  if (vz) vz.onclick = async () => {
    try { await api("/api/jobs/" + job.id + "/vectorize", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }); renderJob(job.id); }
    catch (err) { $("#err").textContent = err.message; }
  };
  el.querySelectorAll(".layer-row select").forEach((sel) => {
    sel.onchange = async () => {
      const hex = sel.value;
      if (!hex) return;
      const layer = Number(sel.closest(".layer-row").dataset.layer);
      const pal = sel.dataset.pal;
      const opt = sel.selectedOptions && sel.selectedOptions[0];
      const name = opt ? opt.textContent : "";
      try {
        await api("/api/jobs/" + job.id + "/recolor", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layer: layer, hex: hex, name: name, palette: pal }) });
        renderJob(job.id);
      } catch (err) { $("#err").textContent = err.message; }
    };
  });
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

function fillProduce(el, job, shopControls) {
  if (!shopControls) { el.innerHTML = "<p class='muted'>Export files are shop-only.</p>"; return; }
  if (!entitled()) { el.innerHTML = paywallNote() + "<p class='muted'>Packets stay locked until Shop or Studio is active. Admin is complimentary.</p>"; return; }
  const stitch = job.stitchCount != null ? job.stitchCount : (job.vector ? "run Export" : "—");
  const stones = job.stones && job.stones.count != null ? job.stones.count : "—";
  el.innerHTML = `
    <p class="muted">Process files from this art. SVG + EPS for Corel. DST + EXP stitches. Rhinestone SS map + CSV.</p>
    <p class="mono">Stitches ${escapeHtml(String(stitch))} · Stones ${escapeHtml(String(stones))}</p>
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
