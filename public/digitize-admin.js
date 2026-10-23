(function () {
  var DS = window.DecoStudio;
  if (!DS || typeof DS.register !== "function") return;
  var $ = DS.qs;
  var escapeHtml = DS.escapeHtml;
  var api = DS.api;
  var loadPalettes = DS.loadPalettes;
  var entitled = DS.entitled;
  var paywallNote = DS.paywallNote;
  var digitizeView = null;
  var style = document.createElement("style");
  style.textContent = ".digitize-station { align-items: start; }";
  document.head.appendChild(style);

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
        <ul class="dig-stats" id="digStats"></ul>
        <ul class="dig-threads" id="digThreads"></ul>
        <div class="dig-warns" id="digWarns"></div>
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
          <option value="tee" selected>T-shirt / jersey</option>
          <option value="polo">Polo / pique</option>
          <option value="woven">Woven / poplin</option>
          <option value="twill">Twill / chino</option>
          <option value="fleece">Fleece / sweat</option>
          <option value="cap">Cap front</option>
        </select>
        <label class="remember" id="digBusyWrap" hidden><input id="digSimplify" type="checkbox" /> Simplify busy art</label>
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
        <div class="export-grid export-hero art-dl" id="digDl">
          <a href="/api/export/${job.id}/design.dst">Download DST</a>
          <a href="/api/export/${job.id}/design.exp">Download EXP</a>
          <a href="/api/export/${job.id}/design.pes">Download PES</a>
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
    return {
      widthIn: Number($("#digW").value),
      heightIn: Number($("#digH").value),
      density: Number($("#digD").value),
      satinSpacingMm: Number($("#digS").value),
      fabric: $("#digFabric") ? $("#digFabric").value : "tee",
      simplify: !!( $("#digSimplify") && $("#digSimplify").checked ),
    };
  }
  function paintDigitizeStats(data) {
    const sum = data.summary || {};
    const stitches = Number(data.stitchCount || sum.stitchCount || 0);
    const colours = (data.colorStops || []).length || sum.colours || 0;
    const changes = sum.colorChanges != null ? sum.colorChanges : Math.max(0, colours - 1);
    const trims = sum.trims != null ? sum.trims : 0;
    $("#digCount").textContent = stitches.toLocaleString() + " stitches";
    const stats = $("#digStats");
    if (stats) {
      stats.innerHTML =
        "<li>" + colours + " thread colour" + (colours === 1 ? "" : "s") + "</li>" +
        "<li>" + changes + " colour change" + (changes === 1 ? "" : "s") + "</li>" +
        "<li>" + trims + " trim" + (trims === 1 ? "" : "s") + "</li>";
    }
    const list = $("#digThreads");
    if (list) {
      list.innerHTML = (data.colorStops || []).map((s) => {
        const hex = escapeHtml(s.hex || "#888");
        const code = s.madeiraCode ? escapeHtml(String(s.madeiraCode)) + " " : "";
        const name = escapeHtml(s.name || "Thread");
        return "<li><span class='dig-swatch' style='background:" + hex + "'></span>" + code + name + "</li>";
      }).join("");
    }
    const warns = [];
    if (data.minRecommendedWidthIn) warns.push("Recommended width ≥ " + Number(data.minRecommendedWidthIn).toFixed(1) + " in");
    (data.textWarnings || []).forEach((w) => {
      const msg = w && (w.message || w.warning || w.text);
      if (msg) warns.push(msg);
      else if (w && w.type) warns.push(String(w.type).replace(/_/g, " "));
    });
    const busy = data.busyArt;
    const busyWrap = $("#digBusyWrap");
    if (busy && (busy.warning || busy.simplifyAvailable || busy.score != null)) {
      if (busy.warning) warns.push(busy.warning);
      else if (busy.score != null) warns.push("Busy art score " + busy.score);
      else warns.push("Busy artwork: may need manual digitizing.");
      if (busy.verdict && !(busy.warning && String(busy.warning).toLowerCase().indexOf(String(busy.verdict).toLowerCase()) >= 0)) warns.push("Verdict: " + String(busy.verdict).replace(/_/g, " "));
      if (busyWrap) busyWrap.hidden = !busy.simplifyAvailable;
    } else if (busyWrap) busyWrap.hidden = true;
    const box = $("#digWarns");
    if (box) box.innerHTML = warns.map((t) => "<p class='dig-warn'>" + escapeHtml(t) + "</p>").join("");
    const stop = (data.colorStops && data.colorStops[0]) || {};
    $("#digMeta").textContent = (data.engine || "wq") + (data.exporter ? " · " + data.exporter : "") + (stop.madeiraCode ? " · " + stop.madeiraCode + " " + stop.name : "");
  }
  async function restitch() {
    const s = readSize();
    $("#digWread").textContent = s.widthIn.toFixed(2);
    $("#digHread").textContent = s.heightIn.toFixed(2);
    $("#digDread").textContent = s.density.toFixed(2);
    $("#digSread").textContent = s.satinSpacingMm.toFixed(2);
    $("#digErr").textContent = "Digitizing…";
    const dl = $("#digDl");
    if (dl) dl.querySelectorAll("a").forEach((a) => { a.style.pointerEvents = "none"; a.style.opacity = "0.5"; });
    try {
      const data = await api("/api/jobs/" + job.id + "/digitize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ widthIn: s.widthIn, heightIn: s.heightIn, density: s.density, satinSpacingMm: s.satinSpacingMm, fabric: s.fabric, simplify: s.simplify, previewOnly: true }),
      });
      payload = data.preview;
      paintDigitizeStats(data);
      $("#digErr").textContent = data.usedFallback ? "Art was too thin — used a fill block. Vectorize first for a real logo." : "";
      if (payload && window.DigitizePreview) {
        const canvas = $("#digView");
        if (digitizeView && digitizeView.canvas === canvas) digitizeView.setPayload(payload);
        else {
          if (digitizeView && digitizeView.stop) digitizeView.stop();
          digitizeView = window.DigitizePreview.mount(canvas, payload);
        }
      }
      if (dl) dl.querySelectorAll("a").forEach((a) => { a.style.pointerEvents = ""; a.style.opacity = ""; });
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
  if ($("#digSimplify")) $("#digSimplify").onchange = restitch;
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

  DS.register({
    id: "digitize",
    label: "Digitize",
    railLabel: "Digitize",
    railIcon: '<path d="M4 12c3-6 5 6 8 0s5 6 8 0"/><path d="M4 18h16"/>',
    tab: ["digitize", "Digitize"],
    needsArt: true,
    method: {
      id: "embroidery",
      label: "Digitize",
      outcome: "DST + EXP stitches",
      icon: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    },
    exportHtml: function (job) {
      return '<div class="export-grid art-dl art-dl-stitch">' +
        '<a href="/api/export/' + job.id + '/design.dst">DST</a>' +
        '<a href="/api/export/' + job.id + '/design.exp">EXP</a>' +
        '<a href="/api/export/' + job.id + '/design.pes">PES</a>' +
        '</div><p class="muted">Stitch files (admin) · tune on the Digitize tab</p>';
    },
    produceHtml: function (job) {
      return '<a href="/api/export/' + job.id + '/design.dst">DST</a>' +
        '<a href="/api/export/' + job.id + '/design.exp">EXP</a>' +
        '<a href="/api/export/' + job.id + '/design.pes">PES</a>' +
        '<a href="/api/export/' + job.id + '/stitch-preview.svg">Stitch preview</a>';
    },
    open: function (el, job, shopControls) { return fillDigitize(el, job, shopControls); },
  });
  if (typeof DS.registerSuiteTool === "function") {
    DS.registerSuiteTool({
      id: "digitize",
      name: "Digitize",
      blurb: "Stitch preview and machine files. Shown only while this tool is enabled for an admin.",
      station: "digitize",
    });
  }
})();
