const main = document.getElementById("main");
const $ = (s, r = document) => r.querySelector(s);
let user = null, view = "users";

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}
function escapeHtml(s) { return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function moneyCents(n) { return "$" + (Number(n || 0) / 100).toFixed(2); }
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
  return renderUsers();
}

async function grant(id, months) {
  await api("/api/admin/users/" + id + "/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ complimentary_months: months, plan: "shop" }),
  });
  render();
}

async function renderUsers() {
  const { users } = await api("/api/admin/users");
  main.innerHTML = `
    <div class="row"><h1 style="margin:0;font-size:28px">Users</h1><span class="muted">${users.length} accounts</span></div>
    <p class="muted">Grant complimentary shop months. Plan expiry is stored on the user — checkout still requires Stripe when billing is configured.</p>
    <table>
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Shop</th><th>Plan</th><th>Expires</th><th>Grant</th></tr></thead>
      <tbody>${users.map((u) => `<tr>
        <td>${escapeHtml(u.name)}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.role)}</td>
        <td>${escapeHtml(u.shop_name || "—")}</td>
        <td>${escapeHtml(u.plan || "—")}</td>
        <td class="mono">${u.plan_expires ? new Date(u.plan_expires).toLocaleDateString() : "—"}</td>
        <td>
          ${u.role === "admin" ? "" : `
            <button class="btn ghost small" data-grant="${u.id}" data-m="1">1 mo</button>
            <button class="btn ghost small" data-grant="${u.id}" data-m="3">3 mo</button>
            <button class="btn ghost small" data-grant="${u.id}" data-m="12">12 mo</button>`}
        </td>
      </tr>`).join("")}</tbody>
    </table>`;
  main.querySelectorAll("[data-grant]").forEach((b) => {
    b.onclick = () => grant(b.dataset.grant, Number(b.dataset.m));
  });
}

async function renderShops() {
  const { shops } = await api("/api/admin/shops");
  main.innerHTML = `
    <div class="row"><h1 style="margin:0;font-size:28px">Shops</h1></div>
    <form class="form" id="sf" style="max-width:420px;margin:16px 0 24px">
      <label>New shop name</label>
      <input name="name" required placeholder="Hearth & Horn Co." />
      <button class="btn small" type="submit">Create shop</button>
      <p class="notice" id="err"></p>
    </form>
    <table>
      <thead><tr><th>Name</th><th>Users</th><th>Jobs</th><th>Created</th></tr></thead>
      <tbody>${shops.map((s) => `<tr>
        <td>${escapeHtml(s.name)}</td>
        <td>${s.users || 0}</td>
        <td>${s.jobs || 0}</td>
        <td class="mono">${s.created_at ? new Date(s.created_at).toLocaleDateString() : "—"}</td>
      </tr>`).join("") || `<tr><td colspan="4" class="muted">No shops yet</td></tr>`}</tbody>
    </table>`;
  $("#sf").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/shops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: new FormData(e.target).get("name") }),
      });
      renderShops();
    } catch (err) { $("#err").textContent = err.message; }
  };
}

async function renderSettings() {
  const { settings } = await api("/api/admin/settings");
  main.innerHTML = `
    <h1 style="font-size:28px;margin-top:0">Membership pricing</h1>
    <p class="muted">Trial length applies to new shop signups. Prices are display/admin figures in cents (Shop default $79, Studio $149).</p>
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

boot().catch((err) => { main.innerHTML = `<p class="notice">${escapeHtml(err.message)}</p>`; });
