const main = document.getElementById("main");
const $ = (s, r = document) => r.querySelector(s);
let user = null, view = "overview";
let shopsCache = [];

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function moneyCents(n) { return "$" + (Number(n || 0) / 100).toFixed(2); }
function fmtDate(v) {
  if (!v) return "—";
  try { return new Date(v).toLocaleString(); } catch (e) { return String(v); }
}
function fmtDay(v) {
  if (!v) return "—";
  try { return new Date(v).toLocaleDateString(); } catch (e) { return String(v); }
}
function nav() {
  document.querySelectorAll(".linkish").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
    b.onclick = () => { view = b.dataset.view; nav(); render(); };
  });
}

async function boot() {
  const me = await api("/api/me");
  if (!me.user) { location.href = "/login.html"; return; }
  if (me.user.role !== "admin") { location.href = "/app.html"; return; }
  user = me.user;
  $("#who").textContent = user.name + " · admin";
  $("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); location.href = "/"; };
  nav();
  render();
}

async function render() {
  if (view === "shops") return renderShops();
  if (view === "settings") return renderSettings();
  if (view === "jobs") return renderJobs();
  if (view === "system") return renderSystem();
  if (view === "users") return renderUsers();
  return renderOverview();
}

async function loadShops() {
  const { shops } = await api("/api/admin/shops");
  shopsCache = shops || [];
  return shopsCache;
}

async function renderOverview() {
  const data = await api("/api/admin/overview");
  const c = data.counts || {};
  const sys = data.system || {};
  main.innerHTML = `
    <div class="row"><h1 style="margin:0;font-size:28px">Overview</h1>
      <span class="muted">v${escapeHtml(sys.version || "")}</span></div>
    <div class="admin-stats">
      <div class="admin-stat"><div class="n">${c.users || 0}</div><div class="l">Users</div></div>
      <div class="admin-stat"><div class="n">${c.shops || 0}</div><div class="l">Shops</div></div>
      <div class="admin-stat"><div class="n">${c.jobs || 0}</div><div class="l">Jobs</div></div>
      <div class="admin-stat"><div class="n">${c.disabled_users || 0}</div><div class="l">Disabled</div></div>
    </div>
    <div class="row" style="margin-top:8px">
      <span class="pill ${sys.billing_configured ? "ok" : "off"}">Stripe ${sys.billing_configured ? "configured" : "not configured"}</span>
      <span class="pill off">Imagine off</span>
      <span class="pill off">Vectorizer.AI off</span>
      <span class="pill ${sys.vai_trace ? "ok" : "warn"}">vai-trace ${sys.vai_trace ? "ready" : "missing"}</span>
    </div>
    <h2 style="font-size:18px;margin:28px 0 10px">Recent signups</h2>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Plan</th><th>Joined</th></tr></thead>
      <tbody>${(data.recent_signups || []).map((u) => `<tr>
        <td>${escapeHtml(u.name)}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(u.plan || "—")}</td>
        <td class="mono">${fmtDay(u.created_at)}</td>
      </tr>`).join("") || `<tr><td colspan="5" class="muted">No users yet</td></tr>`}</tbody>
    </table>
    <h2 style="font-size:18px;margin:28px 0 10px">Recent jobs</h2>
    <table>
      <thead><tr><th>Title</th><th>Owner</th><th>Type</th><th>Shop</th><th>Created</th></tr></thead>
      <tbody>${(data.recent_jobs || []).map((j) => `<tr>
        <td>${escapeHtml(j.title || j.id.slice(0, 8))}</td>
        <td>${escapeHtml(j.owner_email || "—")}</td>
        <td>${escapeHtml(j.method || "—")}</td>
        <td>${escapeHtml(j.shop_name || "—")}</td>
        <td class="mono">${fmtDay(j.created_at)}</td>
      </tr>`).join("") || `<tr><td colspan="5" class="muted">No jobs yet</td></tr>`}</tbody>
    </table>`;
}

async function grant(id, months) {
  await api("/api/admin/users/" + id + "/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ complimentary_months: months, plan: "shop" }),
  });
  render();
}
async function revokePlan(id) {
  if (!confirm("Revoke plan for this user?")) return;
  await api("/api/admin/users/" + id + "/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revoke: true, plan: "client" }),
  });
  render();
}
async function patchUser(id, body) {
  await api("/api/admin/users/" + id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  render();
}
async function deleteUser(id, email) {
  if (!confirm("Delete user " + email + "? Their jobs will be removed.")) return;
  await api("/api/admin/users/" + id, { method: "DELETE" });
  render();
}
async function resetPassword(id, email) {
  if (!confirm("Reset password for " + email + "? They will be signed out.")) return;
  const data = await api("/api/admin/users/" + id + "/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  prompt("Temporary password (copy now — shown once):", data.temporary_password);
}

async function renderUsers() {
  await loadShops();
  const q = ($("#userq") && $("#userq").value) || "";
  const { users } = await api("/api/admin/users" + (q ? ("?q=" + encodeURIComponent(q)) : ""));
  main.innerHTML = `
    <div class="row"><h1 style="margin:0;font-size:28px">Users</h1><span class="muted">${users.length} shown</span></div>
    <div class="admin-toolbar">
      <input id="userq" type="search" class="field" placeholder="Search name, email, shop…" value="${escapeHtml(q)}" />
      <button class="btn ghost small" id="userSearch">Search</button>
    </div>
    <p class="muted">Grant / revoke plans, set role, assign shop, reset temp password, disable, or delete non-admins. Password hashes are never shown.</p>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Shop</th><th>Plan</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${users.map((u) => `<tr>
        <td>${escapeHtml(u.name)}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(u.shop_name || "—")}</td>
        <td>${escapeHtml(u.plan || "—")}</td>
        <td class="mono">${u.plan_expires ? fmtDay(u.plan_expires) : "—"}</td>
        <td>${u.disabled ? '<span class="pill warn">disabled</span>' : '<span class="pill ok">active</span>'}</td>
        <td class="actions">
          ${u.role === "admin" ? "" : `
            <button class="btn ghost small" data-grant="${u.id}" data-m="1">+1 mo</button>
            <button class="btn ghost small" data-grant="${u.id}" data-m="3">+3 mo</button>
            <button class="btn ghost small" data-grant="${u.id}" data-m="12">+12 mo</button>
            <button class="btn ghost small" data-revoke="${u.id}">Revoke</button>
            <button class="btn ghost small" data-role="${u.id}" data-next="${u.role === "shop" ? "client" : "shop"}">→ ${u.role === "shop" ? "client" : "shop"}</button>
            <button class="btn ghost small" data-shop="${u.id}">Shop…</button>
            <button class="btn ghost small" data-pw="${u.id}" data-email="${escapeHtml(u.email)}">Temp pw</button>
            <button class="btn ghost small" data-disable="${u.id}" data-on="${u.disabled ? "0" : "1"}">${u.disabled ? "Enable" : "Disable"}</button>
            <button class="btn ghost small" data-del="${u.id}" data-email="${escapeHtml(u.email)}">Delete</button>`}
        </td>
      </tr>`).join("")}</tbody>
    </table>`;
  $("#userSearch").onclick = () => renderUsers();
  $("#userq").onkeydown = (e) => { if (e.key === "Enter") renderUsers(); };
  main.querySelectorAll("[data-grant]").forEach((b) => { b.onclick = () => grant(b.dataset.grant, Number(b.dataset.m)); });
  main.querySelectorAll("[data-revoke]").forEach((b) => { b.onclick = () => revokePlan(b.dataset.revoke); });
  main.querySelectorAll("[data-role]").forEach((b) => {
    b.onclick = () => patchUser(b.dataset.role, { role: b.dataset.next });
  });
  main.querySelectorAll("[data-shop]").forEach((b) => {
    b.onclick = () => {
      const names = shopsCache.map((s) => s.name + " [" + s.id.slice(0, 6) + "]").join("\n");
      const pick = prompt("Assign shop id (blank to clear):\n" + names);
      if (pick === null) return;
      patchUser(b.dataset.shop, { shop_id: pick.trim() || null });
    };
  });
  main.querySelectorAll("[data-pw]").forEach((b) => {
    b.onclick = () => resetPassword(b.dataset.pw, b.dataset.email);
  });
  main.querySelectorAll("[data-disable]").forEach((b) => {
    b.onclick = () => patchUser(b.dataset.disable, { disabled: b.dataset.on === "1" });
  });
  main.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = () => deleteUser(b.dataset.del, b.dataset.email);
  });
}

async function renderShops() {
  const shops = await loadShops();
  main.innerHTML = `
    <div class="row"><h1 style="margin:0;font-size:28px">Shops</h1></div>
    <form class="form" id="sf" style="max-width:480px;margin:16px 0 24px">
      <label>New shop name</label>
      <input name="name" required placeholder="Hearth & Horn Co." />
      <label>Brand color</label>
      <input name="brand_color" type="text" value="#017ece" />
      <label>Default margin %</label>
      <input name="margin_pct" type="number" value="20" />
      <button class="btn small" type="submit">Create shop</button>
      <p class="notice" id="err"></p>
    </form>
    <table>
      <thead><tr><th>Name</th><th>Users</th><th>Jobs</th><th>Brand</th><th>Margin</th><th>Created</th><th>Actions</th></tr></thead>
      <tbody>${shops.map((s) => `<tr>
        <td>${escapeHtml(s.name)}</td>
        <td>${s.users || 0}</td>
        <td>${s.jobs || 0}</td>
        <td class="mono">${escapeHtml(s.brand_color || "—")}</td>
        <td>${s.margin_pct != null ? s.margin_pct : "—"}%</td>
        <td class="mono">${fmtDay(s.created_at)}</td>
        <td class="actions">
          <button class="btn ghost small" data-rename="${s.id}" data-name="${escapeHtml(s.name)}">Rename</button>
          <button class="btn ghost small" data-edit="${s.id}" data-color="${escapeHtml(s.brand_color || "#017ece")}" data-margin="${s.margin_pct != null ? s.margin_pct : 20}">Edit</button>
          <button class="btn ghost small" data-delshop="${s.id}" data-name="${escapeHtml(s.name)}">Delete</button>
        </td>
      </tr>`).join("") || `<tr><td colspan="7" class="muted">No shops yet</td></tr>`}</tbody>
    </table>`;
  $("#sf").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const fd = Object.fromEntries(new FormData(e.target).entries());
      await api("/api/admin/shops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fd.name,
          brand_color: fd.brand_color,
          margin_pct: Number(fd.margin_pct),
        }),
      });
      renderShops();
    } catch (err) { $("#err").textContent = err.message; }
  };
  main.querySelectorAll("[data-rename]").forEach((b) => {
    b.onclick = async () => {
      const name = prompt("New shop name", b.dataset.name);
      if (!name) return;
      await api("/api/admin/shops/" + b.dataset.rename, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      renderShops();
    };
  });
  main.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = async () => {
      const brand_color = prompt("Brand color", b.dataset.color);
      if (brand_color === null) return;
      const margin = prompt("Margin %", b.dataset.margin);
      if (margin === null) return;
      await api("/api/admin/shops/" + b.dataset.edit, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brand_color, margin_pct: Number(margin) }),
      });
      renderShops();
    };
  });
  main.querySelectorAll("[data-delshop]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete shop " + b.dataset.name + "? Only empty shops can be deleted.")) return;
      try {
        await api("/api/admin/shops/" + b.dataset.delshop, { method: "DELETE" });
        renderShops();
      } catch (err) { alert(err.message); }
    };
  });
}

async function renderJobs() {
  const q = ($("#jobq") && $("#jobq").value) || "";
  const { jobs } = await api("/api/admin/jobs?limit=100" + (q ? ("&q=" + encodeURIComponent(q)) : ""));
  main.innerHTML = `
    <div class="row"><h1 style="margin:0;font-size:28px">Jobs</h1><span class="muted">${jobs.length} recent</span></div>
    <div class="admin-toolbar">
      <input id="jobq" type="search" class="field" placeholder="Search title, owner, shop, id…" value="${escapeHtml(q)}" />
      <button class="btn ghost small" id="jobSearch">Search</button>
    </div>
    <table>
      <thead><tr><th>Id</th><th>Title</th><th>Owner</th><th>Type</th><th>Shop</th><th>Created</th><th>Files</th><th></th></tr></thead>
      <tbody>${jobs.map((j) => `<tr>
        <td class="mono">${escapeHtml(j.id.slice(0, 8))}</td>
        <td>${escapeHtml(j.title || "—")}</td>
        <td>${escapeHtml(j.owner_email || "—")}</td>
        <td>${escapeHtml(j.method || "—")}</td>
        <td>${escapeHtml(j.shop_name || "—")}</td>
        <td class="mono">${fmtDay(j.created_at)}</td>
        <td>
          ${j.file_path ? `<a href="${escapeHtml(j.file_path)}" target="_blank" rel="noopener">art</a>` : "—"}
          ${j.vector_svg ? ` · <a href="${escapeHtml(j.vector_svg)}" target="_blank" rel="noopener">svg</a>` : ""}
        </td>
        <td><button class="btn ghost small" data-deljob="${j.id}">Delete</button></td>
      </tr>`).join("") || `<tr><td colspan="8" class="muted">No jobs</td></tr>`}</tbody>
    </table>`;
  $("#jobSearch").onclick = () => renderJobs();
  $("#jobq").onkeydown = (e) => { if (e.key === "Enter") renderJobs(); };
  main.querySelectorAll("[data-deljob]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete job " + b.dataset.deljob.slice(0, 8) + "?")) return;
      await api("/api/admin/jobs/" + b.dataset.deljob, { method: "DELETE" });
      renderJobs();
    };
  });
}

async function renderSettings() {
  const data = await api("/api/admin/settings");
  const settings = data.settings;
  main.innerHTML = `
    <h1 style="font-size:28px;margin-top:0">Membership pricing</h1>
    <p class="muted">Trial length applies to new shop signups. Prices are display/admin figures in cents (Shop default $79, Studio $149). Stripe checkout only works when billing env is configured — we do not invent fake Stripe.</p>
    <p><span class="pill ${data.billing_configured ? "ok" : "off"}">Stripe ${data.billing_configured ? "configured" : "not configured"}</span>
       <span class="pill off">Imagine off</span>
       <span class="pill off">Vectorizer.AI off</span></p>
    <form class="form" id="pf" style="max-width:420px">
      <label>Trial days</label>
      <input name="trial_days" type="number" min="0" value="${settings.trial_days}" />
      <label>Shop price (cents)</label>
      <input name="shop_price_cents" type="number" min="0" value="${settings.shop_price_cents}" />
      <label>Studio price (cents)</label>
      <input name="studio_price_cents" type="number" min="0" value="${settings.studio_price_cents}" />
      <p class="muted">Shop ${moneyCents(settings.shop_price_cents)} · Studio ${moneyCents(settings.studio_price_cents)}</p>
      <button class="btn" type="submit">Save settings</button>
      <p class="ok" id="ok"></p>
    </form>`;
  $("#pf").onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target).entries());
    await api("/api/admin/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trial_days: Number(fd.trial_days),
        shop_price_cents: Number(fd.shop_price_cents),
        studio_price_cents: Number(fd.studio_price_cents),
      }),
    });
    $("#ok").textContent = "Saved.";
  };
}

async function renderSystem() {
  const data = await api("/api/admin/system");
  main.innerHTML = `
    <h1 style="font-size:28px;margin-top:0">System</h1>
    <div class="admin-stats">
      <div class="admin-stat"><div class="n" style="font-size:18px">${escapeHtml(data.version)}</div><div class="l">Version</div></div>
      <div class="admin-stat"><div class="n" style="font-size:14px">${escapeHtml(data.stamp || "—")}</div><div class="l">Build stamp (UTC file mtime)</div></div>
      <div class="admin-stat"><div class="n" style="font-size:16px">${escapeHtml(data.node || "")}</div><div class="l">Node</div></div>
    </div>
    <h2 style="font-size:18px">Health & flags</h2>
    <table>
      <tbody>
        <tr><td>Health</td><td><span class="pill ok">ok</span></td></tr>
        <tr><td>Stripe / billing configured</td><td><span class="pill ${data.billing_configured ? "ok" : "off"}">${data.billing_configured ? "yes" : "no"}</span> <span class="muted">(boolean only — no secrets)</span></td></tr>
        <tr><td>Imagine / AI</td><td><span class="pill off">false</span></td></tr>
        <tr><td>Vectorizer.AI</td><td><span class="pill off">false</span></td></tr>
        <tr><td>vai-trace</td><td><span class="pill ${data.vai_trace ? "ok" : "warn"}">${data.vai_trace ? "available" : "unavailable"}</span></td></tr>
        <tr><td>VTracer</td><td><span class="pill ${data.vtracer ? "ok" : "off"}">${data.vtracer ? "available" : "unavailable"}</span></td></tr>
        <tr><td>Trial days</td><td class="mono">${data.feature_flags && data.feature_flags.trial_days}</td></tr>
        <tr><td>Shop / Studio cents</td><td class="mono">${data.feature_flags && data.feature_flags.shop_price_cents} / ${data.feature_flags && data.feature_flags.studio_price_cents}</td></tr>
      </tbody>
    </table>`;
}

boot().catch((err) => { main.innerHTML = `<p class="notice">${escapeHtml(err.message)}</p>`; });
