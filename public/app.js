const main = document.getElementById("main");
let user = null;
let shop = null;
let view = "jobs";
let currentJob = null;

const $ = (s, r = document) => r.querySelector(s);

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function nav() {
  document.querySelectorAll(".linkish").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
    b.onclick = () => {
      view = b.dataset.view;
      currentJob = null;
      nav();
      render();
    };
  });
  const shopOnly = user && user.role === "shop";
  $("#navNew").style.display = shopOnly ? "block" : "none";
  $("#navClients").style.display = shopOnly ? "block" : "none";
}

async function boot() {
  const me = await api("/api/me");
  if (!me.user) {
    location.href = "/login.html";
    return;
  }
  user = me.user;
  const s = await api("/api/shop");
  shop = s.shop;
  $("#who").textContent = `${user.name} · ${user.role} · ${user.plan}`;
  if (shop) {
    $("#sideName").textContent = shop.name;
    if (shop.logo_path) $("#sideLogo").src = shop.logo_path;
  }
  $("#logout").onclick = async () => {
    await api("/api/logout", { method: "POST" });
    location.href = "/";
  };
  nav();
  render();
}

async function render() {
  if (currentJob) return renderJob(currentJob);
  if (view === "jobs") return renderJobs();
  if (view === "new") return renderNew();
  if (view === "clients") return renderClients();
  if (view === "settings") return renderSettings();
}

async function renderJobs() {
  const { jobs } = await api("/api/jobs");
  main.innerHTML = `
    <div class="row">
      <h1 style="margin:0;font-size:36px">Jobs</h1>
      ${user.role === "shop" ? `<button class="btn" id="goNew">New job</button>` : ""}
    </div>
    <p class="muted">${jobs.length} on the bench</p>
    <table>
      <thead><tr><th>Title</th><th>Method</th><th>Status</th><th>Total</th><th></th></tr></thead>
      <tbody>
        ${jobs.map((j) => `
          <tr>
            <td>${escapeHtml(j.title)}</td>
            <td>${j.method}</td>
            <td><span class="status">${j.status}</span></td>
            <td>${money(j.total)}</td>
            <td><button class="btn ghost small" data-open="${j.id}">Open</button></td>
          </tr>`).join("") || `<tr><td colspan="5" class="muted">No jobs yet.</td></tr>`}
      </tbody>
    </table>`;
  const go = $("#goNew");
  if (go) go.onclick = () => { view = "new"; nav(); render(); };
  main.querySelectorAll("[data-open]").forEach((b) => {
    b.onclick = () => { currentJob = b.dataset.open; render(); };
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function renderNew() {
  const { clients } = await api("/api/clients").catch(() => ({ clients: [] }));
  main.innerHTML = `
    <h1 style="font-size:36px;margin-top:0">New job</h1>
    <form class="form" id="jobForm">
      <label>Title</label>
      <input name="title" placeholder="Forge mark tees" required />
      <label>Method</label>
      <select name="method">
        <option value="dtf">DTF</option>
        <option value="uvdtf">UV DTF</option>
        <option value="laser">Laser engrave</option>
        <option value="sticker">Sticker / decal</option>
        <option value="hat">Hat</option>
        <option value="apparel">Apparel</option>
        <option value="patch">Patch</option>
      </select>
      <label>Client</label>
      <select name="client_id">
        <option value="">Unassigned</option>
        ${clients.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}
      </select>
      <label>Width (in)</label><input name="width_in" type="number" step="0.1" value="10" />
      <label>Height (in)</label><input name="height_in" type="number" step="0.1" value="10" />
      <label>Qty</label><input name="qty" type="number" value="1" />
      <label>Notes</label><textarea name="notes" rows="3"></textarea>
      <label>Artwork (PNG preferred for cut tracing)</label><input name="artwork" type="file" accept="image/*,.svg,.pdf" />
      <p class="notice" id="err"></p>
      <button class="btn" type="submit">Create job</button>
    </form>`;
  $("#jobForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/jobs", { method: "POST", body: new FormData(e.target) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      currentJob = data.job.id;
      view = "jobs";
      nav();
      render();
    } catch (err) {
      $("#err").textContent = err.message;
    }
  };
}

async function renderJob(id) {
  const { job, events } = await api(`/api/jobs/${id}`);
  const shopControls = user.role === "shop";
  const previewSrc = job.mockup_path || job.file_path;
  main.innerHTML = `
    <button class="btn ghost small" id="back">← Jobs</button>
    <div class="row" style="margin-top:16px">
      <h1 style="margin:0;font-size:34px">${escapeHtml(job.title)}</h1>
      <span class="status">${job.status}</span>
    </div>
    <p class="muted">${job.method} · ${job.width_in}×${job.height_in} in · qty ${job.qty} · ${money(job.unit_price)} ea · ${money(job.total)}</p>
    <div class="job-grid" style="margin-top:18px">
      <div class="preview">${previewSrc ? `<img src="${previewSrc}" alt="Mockup" />` : `<span class="muted">No artwork yet</span>`}</div>
      <div class="card">
        ${shopControls ? `
          <form id="priceForm" class="form">
            <label>Method</label>
            <select name="method">
              ${["dtf","uvdtf","laser","sticker","hat","apparel","patch"].map((m) =>
                `<option value="${m}" ${m===job.method?"selected":""}>${m}</option>`).join("")}
            </select>
            <label>W / H / Qty</label>
            <div class="row">
              <input name="width_in" type="number" step="0.1" value="${job.width_in}" />
              <input name="height_in" type="number" step="0.1" value="${job.height_in}" />
              <input name="qty" type="number" value="${job.qty}" />
            </div>
            <button class="btn teal small" type="submit">Recalculate</button>
          </form>
          <div class="cta-row" style="margin-top:14px">
            <button class="btn small" data-st="proof">Send proof</button>
            <button class="btn small ghost" data-st="production">To production</button>
            <button class="btn small ghost" data-st="done">Mark done</button>
          </div>
          <p class="muted" style="margin-top:12px">Proof link: <a href="/proof.html?t=${job.proof_token}" target="_blank">open branded proof</a></p>
          <h3 style="margin:16px 0 6px">True exports</h3>
          <div class="export-grid">
            <a href="/api/export/${job.id}/packet.json">Packet JSON</a>
            <a href="/api/export/${job.id}/cut-contour.svg">Cut contour SVG</a>
            <a href="/api/export/${job.id}/laser.svg">Laser SVG</a>
            <a href="/api/export/${job.id}/laser.plt">Laser PLT (HPGL)</a>
            <a href="/api/export/${job.id}/gang-sheet.svg">DTF/UV gang sheet</a>
            <a href="/api/export/${job.id}/sticker-cutline.svg">Sticker cutline</a>
          </div>
        ` : `
          <p>Review this proof mockup. Approve if the art, size, and placement are correct.</p>
          <button class="btn" data-st="approved">Approve job</button>
        `}
      </div>
    </div>
    <h3>Timeline</h3>
    <ul class="muted">${events.map((e) => `<li>${escapeHtml(e.message)} · ${new Date(e.created_at).toLocaleString()}</li>`).join("")}</ul>
  `;
  $("#back").onclick = () => { currentJob = null; view = "jobs"; nav(); render(); };
  const pf = $("#priceForm");
  if (pf) {
    pf.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(pf);
      await api(`/api/jobs/${job.id}/price`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(fd.entries())),
      });
      render();
    };
  }
  main.querySelectorAll("[data-st]").forEach((b) => {
    b.onclick = async () => {
      await api(`/api/jobs/${job.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: b.dataset.st }),
      });
      render();
    };
  });
}

async function renderClients() {
  const { clients } = await api("/api/clients");
  main.innerHTML = `
    <h1 style="font-size:36px;margin-top:0">Clients</h1>
    <form class="form" id="cf" style="margin-bottom:28px">
      <label>Name</label><input name="name" required />
      <label>Email</label><input name="email" type="email" required />
      <label>Temp password</label><input name="password" value="welcome123" />
      <button class="btn" type="submit">Add client login</button>
      <p class="notice" id="err"></p>
    </form>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Added</th></tr></thead>
      <tbody>
        ${clients.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.email)}</td><td>${new Date(c.created_at).toLocaleDateString()}</td></tr>`).join("")}
      </tbody>
    </table>`;
  $("#cf").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(e.target).entries())),
      });
      render();
    } catch (err) {
      $("#err").textContent = err.message;
    }
  };
}

async function checkout(plan) {
  const data = await api("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan }),
  });
  user = data.user;
  $("#who").textContent = `${user.name} · ${user.role} · ${user.plan}`;
  const note = $("#billnote");
  if (note) note.textContent = data.message || "Plan recorded.";
  if (data.checkoutUrl) location.href = data.checkoutUrl;
}

async function renderSettings() {
  const billed = new URLSearchParams(location.search).get("billing");
  main.innerHTML = `
    <h1 style="font-size:36px;margin-top:0">Settings</h1>
    <p class="muted">Logged in as ${escapeHtml(user.email)} · plan <strong>${user.plan}</strong></p>
    ${billed === "ok" ? `<p class="muted">Checkout returned successfully.</p>` : ""}
    ${user.role === "shop" ? `
      <form class="form" id="sf" style="margin:24px 0">
        <label>Shop name / your brand on proofs</label>
        <input name="name" value="${escapeHtml(shop?.name || "")}" />
        <label>Brand color</label>
        <input name="brand_color" type="color" value="${shop?.brand_color || "#d4783c"}" />
        <label>Logo (replaces DecoClub Pro mark in the bench)</label>
        <input name="logo" type="file" accept="image/*,.svg" />
        <button class="btn" type="submit">Save brand</button>
      </form>
      <div class="cta-row">
        <button class="btn ghost" data-plan="trial">Checkout trial</button>
        <button class="btn ghost" data-plan="shop">Checkout Shop $79</button>
        <button class="btn" data-plan="studio">Checkout Studio $149</button>
      </div>
      <p class="muted" id="billnote">Stripe checkout session code is live. Billing connects when keys are set.</p>
    ` : `<p>Client accounts only see jobs assigned to them.</p>`}
  `;
  const sf = $("#sf");
  if (sf) {
    sf.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(sf);
      const shopRes = await fetch("/api/shop", { method: "POST", body: fd });
      shop = (await shopRes.json()).shop;
      if (shop?.logo_path) $("#sideLogo").src = shop.logo_path;
      $("#sideName").textContent = shop.name;
    };
  }
  main.querySelectorAll("[data-plan]").forEach((b) => {
    b.onclick = () => checkout(b.dataset.plan);
  });
}

boot().catch((err) => {
  main.innerHTML = `<p class="notice">${err.message}</p>`;
});
