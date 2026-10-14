"use strict";
// Unpaid halftone previews stay watermarked PNGs, preview budgets are clamped,
// and raster previews are rate-limited without blocking the event loop.
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { decodePng, encodePng, makeRgba } = require("../lib/png");
const { renderPreviewPng } = require("../lib/previewRender");
const { HT_PREVIEW_MAX_EDGE, HT_PREVIEW_MAX_CELLS, halftonePreviewRasterSpec } = require("../lib/previewGate");

const ADMIN_EMAIL = "preview-sec-admin@decoclub.test";
const ADMIN_PASSWORD = "preview-sec-pass";
const SIMPLE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="15" y="15" width="70" height="70" fill="#cc0000"/>
</svg>
`;

function slowSvg() {
  const n = 500;
  let body = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><filter id="b"><feGaussianBlur stdDeviation="8"/></filter>';
  for (let i = 0; i < n; i++) {
    body += '<circle cx="' + ((i * 17) % 760) + '" cy="' + ((i * 29) % 760) + '" r="18" fill="#333" filter="url(#b)"/>';
  }
  return body + "</svg>";
}

function platePng() {
  const w = 480;
  const h = 320;
  const rgba = makeRgba(w, h, [255, 255, 255, 255]);
  for (let y = 40; y < 280; y++) {
    for (let x = 60; x < 420; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 12;
      rgba[i + 1] = 12;
      rgba[i + 2] = 12;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(w, h, rgba);
}

function tinyPng() {
  const rgba = makeRgba(32, 32, [255, 255, 255, 255]);
  for (let y = 8; y < 24; y++) {
    for (let x = 8; x < 24; x++) {
      const i = (y * 32 + x) * 4;
      rgba[i] = 10;
      rgba[i + 1] = 10;
      rgba[i + 2] = 10;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(32, 32, rgba);
}

function multipart(fields, file) {
  const boundary = "----dcpSec" + Date.now();
  const chunks = [];
  Object.keys(fields).forEach((k) => {
    chunks.push(Buffer.from(
      "--" + boundary + "\r\n" +
      'Content-Disposition: form-data; name="' + k + '"\r\n\r\n' +
      String(fields[k]) + "\r\n"
    ));
  });
  if (file) {
    chunks.push(Buffer.from(
      "--" + boundary + "\r\n" +
      'Content-Disposition: form-data; name="file"; filename="' + file.name + '"\r\n' +
      "Content-Type: image/png\r\n\r\n"
    ));
    chunks.push(file.buf);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from("--" + boundary + "--\r\n"));
  return { body: Buffer.concat(chunks), contentType: "multipart/form-data; boundary=" + boundary };
}

function req(port, method, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, opts.headers || {});
    const body = opts.body == null ? null : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body));
    if (body && !headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
    if (body) headers["Content-Length"] = body.length;
    const r = http.request({ hostname: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString("utf8"), json, buf });
      });
    });
    r.setTimeout(60000, () => r.destroy(new Error("timeout " + method + " " + urlPath)));
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

function cookieFrom(res) {
  const set = res.headers["set-cookie"];
  if (!set) return "";
  return (Array.isArray(set) ? set : [set]).map((c) => String(c).split(";")[0]).join("; ");
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitHealth(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await req(port, "GET", "/health");
      if (r.status === 200) return r;
    } catch (e) {}
    await sleep(50);
  }
  throw new Error("server did not start");
}

function startServer(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-psec-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, {
      DATA_DIR: dir,
      HOST: "127.0.0.1",
      PORT: String(port),
      ALLOW_DEMO: "0",
      NODE_ENV: "development",
      ADMIN_EMAIL: ADMIN_EMAIL,
      ADMIN_PASSWORD: ADMIN_PASSWORD,
      FEATURE_MEMBERSHIP: "",
      FEATURE_DIGITIZE: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; if (log.length > 12000) log = log.slice(-12000); });
  child.stderr.on("data", (d) => { log += d; if (log.length > 12000) log = log.slice(-12000); });
  child.log = function () { return log; };
  return { child, dir };
}

function stop(child) {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch (e) {} }, 1500);
  });
}

function editStore(dir, mutate) {
  const storePath = path.join(dir, "store.json");
  const db = JSON.parse(fs.readFileSync(storePath, "utf8"));
  mutate(db);
  fs.writeFileSync(storePath, JSON.stringify(db));
}

async function signup(port, email, shopName) {
  const res = await req(port, "POST", "/api/signup", {
    body: JSON.stringify({ name: shopName, email: email, password: "secret12", shopName: shopName, role: "shop" }),
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.json));
  return { cookie: cookieFrom(res), id: res.json.user.id };
}

async function uploadJob(port, cookie, title, png) {
  const form = multipart(
    { title: title, method: "dtf", width_in: "4", height_in: "3", qty: "1" },
    { name: "plate.png", buf: png }
  );
  const res = await req(port, "POST", "/api/jobs", {
    headers: { Cookie: cookie, "Content-Type": form.contentType },
    body: form.body,
  });
  assert.strictEqual(res.status, 200, "job create " + JSON.stringify(res.json && res.json.error));
  assert.ok(res.json.job.file_path);
  return res.json.job;
}

function htBody(extra) {
  return Object.assign({
    style: "classic-round",
    lpi: 30,
    angle: 15,
    contrast: 1,
    colorMode: "ink",
    color: "#111111",
    knockout: true,
    maxEdge: HT_PREVIEW_MAX_EDGE,
    maxCells: HT_PREVIEW_MAX_CELLS,
  }, extra || {});
}

function pngFromDataUrl(url) {
  const prefix = "data:image/png;base64,";
  assert.ok(String(url || "").indexOf(prefix) === 0, "png data url");
  const buf = Buffer.from(String(url).slice(prefix.length), "base64");
  assert.strictEqual(buf[0], 0x89);
  assert.strictEqual(buf[1], 0x50);
  return buf;
}

function diffCount(a, b) {
  const da = decodePng(a);
  const db = decodePng(b);
  assert.strictEqual(da.width, db.width);
  assert.strictEqual(da.height, db.height);
  let n = 0;
  for (let i = 0; i < da.rgba.length; i += 4) {
    if (Math.abs(da.rgba[i] - db.rgba[i]) > 8 || Math.abs(da.rgba[i + 1] - db.rgba[i + 1]) > 8 ||
        Math.abs(da.rgba[i + 2] - db.rgba[i + 2]) > 8 || Math.abs(da.rgba[i + 3] - db.rgba[i + 3]) > 8) n++;
  }
  return n;
}

function markCount(svg) {
  const m = String(svg || "").match(/<(?:circle|ellipse|path|polygon|rect|line)\b/gi);
  return m ? m.length : 0;
}

function longPixel(meta) {
  const px = meta && meta.pixel;
  assert.ok(Array.isArray(px) && px.length === 2, "meta.pixel");
  return Math.max(px[0], px[1]);
}

(async () => {
  const port = 41361;
  const s = startServer(port);
  try {
    await waitHealth(port);
    const appJs = await req(port, "GET", "/app.js");
    assert.strictEqual(appJs.status, 200);
    assert.ok(appJs.text.indexOf("showHtPreviewPng") !== -1, "unpaid halftone preview paints a PNG");
    assert.ok(appJs.text.indexOf("ht-preview-png") !== -1);
    assert.ok(appJs.text.indexOf("new AbortController()") !== -1, "preview fetches can be aborted");
    assert.ok(appJs.text.indexOf("setTimeout(requestSharp, 150)") !== -1, "vector preview debounce stays 150ms");
    assert.ok(appJs.text.indexOf("res.status === 429") !== -1, "429 backs off");
    const css = await req(port, "GET", "/styles.css");
    assert.ok(css.text.indexOf("ht-preview-png") !== -1);
    assert.ok(css.text.indexOf("linear-gradient(45deg, #cfd6e0 25%") !== -1, "checkerboard stays");

    const shop = await signup(port, "ada-sec@shop.test", "Ada Sec");
    const job = await uploadJob(port, shop.cookie, "Halftone plate", platePng());
    const cap = htBody();
    const huge = htBody({ maxEdge: 50000, maxCells: 500000 });

    const unpaidCap = await req(port, "POST", "/api/jobs/" + job.id + "/halftone/preview", {
      headers: { Cookie: shop.cookie },
      body: JSON.stringify(cap),
    });
    assert.strictEqual(unpaidCap.status, 200, JSON.stringify(unpaidCap.json && unpaidCap.json.error));
    assert.ok(!unpaidCap.json.svg, "unpaid preview must not include svg");
    assert.ok(unpaidCap.text.indexOf("<svg") === -1, "unpaid body leaks svg markup");
    assert.ok(unpaidCap.text.indexOf("data-halftone") === -1);
    const unpaidPng = pngFromDataUrl(unpaidCap.json.png);
    assert.ok(unpaidCap.json.meta && unpaidCap.json.meta.elements > 0, "preview meta");
    assert.ok(longPixel(unpaidCap.json.meta) <= HT_PREVIEW_MAX_EDGE, "cap edge " + longPixel(unpaidCap.json.meta));

    const unpaidHuge = await req(port, "POST", "/api/jobs/" + job.id + "/halftone/preview", {
      headers: { Cookie: shop.cookie },
      body: JSON.stringify(huge),
    });
    assert.strictEqual(unpaidHuge.status, 200, JSON.stringify(unpaidHuge.json && unpaidHuge.json.error));
    assert.ok(!unpaidHuge.json.svg);
    assert.strictEqual(unpaidHuge.json.meta.elements, unpaidCap.json.meta.elements, "huge maxEdge/maxCells must not add marks");
    assert.strictEqual(longPixel(unpaidHuge.json.meta), longPixel(unpaidCap.json.meta));
    assert.ok(longPixel(unpaidHuge.json.meta) <= HT_PREVIEW_MAX_EDGE);
    const hugePng = pngFromDataUrl(unpaidHuge.json.png);
    assert.ok(hugePng.length <= unpaidPng.length + 64, "huge preview png is not larger");

    await sleep(1100);
    editStore(s.dir, (db) => {
      const row = db.jobs.find((j) => j.id === job.id);
      row.free_image = false;
      row.unlocks = { vectorize: false, halftones: true };
    });
    const paidCap = await req(port, "POST", "/api/jobs/" + job.id + "/halftone/preview", {
      headers: { Cookie: shop.cookie },
      body: JSON.stringify(cap),
    });
    assert.strictEqual(paidCap.status, 200, JSON.stringify(paidCap.json && paidCap.json.error));
    assert.ok(paidCap.json.svg && paidCap.json.svg.indexOf("<svg") !== -1, "paid preview still returns svg");
    assert.ok(!paidCap.json.png, "paid preview is the svg, not a png stand-in");
    const paidHuge = await req(port, "POST", "/api/jobs/" + job.id + "/halftone/preview", {
      headers: { Cookie: shop.cookie },
      body: JSON.stringify(huge),
    });
    assert.strictEqual(paidHuge.status, 200, JSON.stringify(paidHuge.json && paidHuge.json.error));
    assert.strictEqual(paidHuge.json.meta.elements, paidCap.json.meta.elements);
    assert.strictEqual(markCount(paidHuge.json.svg), markCount(paidCap.json.svg));
    assert.ok(paidHuge.json.svg.length <= paidCap.json.svg.length, "huge svg is not longer than the cap");
    assert.strictEqual(longPixel(paidHuge.json.meta), longPixel(paidCap.json.meta));

    const watermarked = await renderPreviewPng(paidCap.json.svg, halftonePreviewRasterSpec(true));
    const clean = await renderPreviewPng(paidCap.json.svg, halftonePreviewRasterSpec(false));
    const wmDiff = diffCount(unpaidPng, watermarked);
    const cleanDiff = diffCount(unpaidPng, clean);
    assert.ok(wmDiff < 8, "unpaid png is the watermarked raster, diff " + wmDiff);
    assert.ok(cleanDiff > 80, "watermark is visible against the clean raster, diff " + cleanDiff);

    await sleep(1100);
    editStore(s.dir, (db) => {
      const row = db.jobs.find((j) => j.id === job.id);
      row.free_image = true;
      row.unlocks = { vectorize: false, halftones: true };
    });
    const freePrev = await req(port, "POST", "/api/jobs/" + job.id + "/halftone/preview", {
      headers: { Cookie: shop.cookie },
      body: JSON.stringify(cap),
    });
    assert.strictEqual(freePrev.status, 200, JSON.stringify(freePrev.json && freePrev.json.error));
    assert.ok(!freePrev.json.svg, "free_image preview stays a png");
    assert.ok(freePrev.json.png);
    const freePng = pngFromDataUrl(freePrev.json.png);
    assert.ok(diffCount(freePng, clean) > 80, "free_image preview is watermarked");

    const adminLogin = await req(port, "POST", "/api/login", {
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    assert.strictEqual(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const adminCk = cookieFrom(adminLogin);
    const adminJob = await uploadJob(port, adminCk, "Admin plate", tinyPng());
    const adminPrev = await req(port, "POST", "/api/jobs/" + adminJob.id + "/halftone/preview", {
      headers: { Cookie: adminCk },
      body: JSON.stringify(htBody({ maxEdge: 9000, maxCells: 80000 })),
    });
    assert.strictEqual(adminPrev.status, 200, JSON.stringify(adminPrev.json && adminPrev.json.error));
    assert.ok(adminPrev.json.svg && adminPrev.json.svg.indexOf("<svg") !== -1, "admin preview still returns svg");
    assert.ok(longPixel(adminPrev.json.meta) <= HT_PREVIEW_MAX_EDGE);

    const ver = await req(port, "PATCH", "/api/admin/users/" + shop.id, {
      headers: { Cookie: adminCk },
      body: JSON.stringify({ email_verified: true }),
    });
    assert.strictEqual(ver.status, 200, JSON.stringify(ver.json));
    const tiny = await uploadJob(port, shop.cookie, "Apply plate", tinyPng());
    const applied = await req(port, "POST", "/api/jobs/" + tiny.id + "/halftone", {
      headers: { Cookie: shop.cookie },
      body: JSON.stringify(htBody({ maxEdge: 200, maxCells: 2000 })),
    });
    assert.strictEqual(applied.status, 200, JSON.stringify(applied.json && applied.json.error));
    assert.strictEqual(applied.json.job.free_image, true);
    const appliedBody = JSON.stringify(applied.json);
    assert.ok(!applied.json.job.vector_svg, "free apply JSON hides the svg url");
    assert.ok(!applied.json.job.vector || !applied.json.job.vector.svg, "free apply JSON hides inline svg");
    assert.ok(!applied.json.job.halftone || !applied.json.job.halftone.svg);
    assert.ok(appliedBody.indexOf("-halftone.svg") === -1);
    assert.ok(appliedBody.indexOf("<svg") === -1);

    let svgName = "";
    editStore(s.dir, (db) => {
      const row = db.jobs.find((j) => j.id === tiny.id);
      svgName = path.basename(String(row.vector_svg || ""));
      assert.ok(/-halftone\.svg$/i.test(svgName), "saved file is a halftone svg");
    });
    const rawShop = await req(port, "GET", "/uploads/" + svgName, { headers: { Cookie: shop.cookie } });
    assert.strictEqual(rawShop.status, 403, "unpaid /uploads blocks halftone svg");
    const rawAnon = await req(port, "GET", "/uploads/" + svgName);
    assert.strictEqual(rawAnon.status, 401);
    const rawAdmin = await req(port, "GET", "/uploads/" + svgName, { headers: { Cookie: adminCk } });
    assert.strictEqual(rawAdmin.status, 200, "admin can fetch the file");
    assert.ok(rawAdmin.text.indexOf("<svg") !== -1);
    const exp = await req(port, "GET", "/api/export/" + tiny.id + "/art.svg", { headers: { Cookie: shop.cookie } });
    assert.strictEqual(exp.status, 200, "free-credit download still serves the svg");
    assert.ok(exp.text.indexOf("<svg") !== -1);
    assert.ok(exp.text.indexOf("DECOCLUB PRO") === -1);

    const burstUser = await signup(port, "bea-sec@shop.test", "Bea Sec");
    const burstJob = await uploadJob(port, burstUser.cookie, "Burst", tinyPng());
    const burstName = "1700000000101-sec-vector.svg";
    fs.writeFileSync(path.join(s.dir, "uploads", burstName), SIMPLE_SVG);
    editStore(s.dir, (db) => {
      const row = db.jobs.find((j) => j.id === burstJob.id);
      row.vector_svg = "/uploads/" + burstName;
      row.free_image = false;
      row.unlocks = { vectorize: true, halftones: false };
    });
    const burstUrl = "/api/jobs/" + burstJob.id + "/preview.png?x=0&y=0&w=1&h=1&pw=48&ph=48&mode=fill";
    const burst = await Promise.all(Array.from({ length: 8 }, () => req(port, "GET", burstUrl, { headers: { Cookie: burstUser.cookie } })));
    const limited = burst.filter((r) => r.status === 429);
    const passed = burst.filter((r) => r.status === 200);
    assert.ok(limited.length >= 1, "rapid burst gets 429, got " + burst.map((r) => r.status).join(","));
    assert.ok(passed.length >= 1 && passed.length <= 4, "burst allows at most 4, got " + passed.length);
    limited.forEach((r) => {
      const ra = Number(r.headers["retry-after"]);
      assert.ok(Number.isFinite(ra) && ra >= 1, "Retry-After");
      assert.ok(r.json && r.json.error, "429 json");
    });

    const cacheUser = await signup(port, "cy-sec@shop.test", "Cy Sec");
    const cacheJob = await uploadJob(port, cacheUser.cookie, "Cache", tinyPng());
    const cacheName = "1700000000102-sec-vector.svg";
    fs.writeFileSync(path.join(s.dir, "uploads", cacheName), SIMPLE_SVG);
    editStore(s.dir, (db) => {
      const row = db.jobs.find((j) => j.id === cacheJob.id);
      row.vector_svg = "/uploads/" + cacheName;
      row.free_image = false;
      row.unlocks = { vectorize: true, halftones: false };
    });
    const cacheUrl = "/api/jobs/" + cacheJob.id + "/preview.png?x=0&y=0&w=1&h=1&pw=96&ph=96&mode=fill";
    const first = await req(port, "GET", cacheUrl, { headers: { Cookie: cacheUser.cookie } });
    assert.strictEqual(first.status, 200, first.text.slice(0, 180));
    assert.strictEqual(first.headers["x-preview-cache"], "miss");
    const t0 = Date.now();
    const second = await req(port, "GET", cacheUrl, { headers: { Cookie: cacheUser.cookie } });
    const hitMs = Date.now() - t0;
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.headers["x-preview-cache"], "hit");
    assert.ok(first.buf.equals(second.buf), "cache hit bytes match");
    assert.ok(hitMs < 100, "cache hit was not fast: " + hitMs + "ms");

    await sleep(1100);
    const slowName = "1700000000103-sec-slow.svg";
    fs.writeFileSync(path.join(s.dir, "uploads", slowName), slowSvg());
    editStore(s.dir, (db) => {
      const row = db.jobs.find((j) => j.id === cacheJob.id);
      row.vector_svg = "/uploads/" + slowName;
    });
    let finished = 0;
    const slow1 = "/api/jobs/" + cacheJob.id + "/preview.png?x=0&y=0&w=1&h=1&pw=480&ph=480&mode=fill";
    const slow2 = "/api/jobs/" + cacheJob.id + "/preview.png?x=0&y=0&w=1&h=1&pw=460&ph=460&mode=fill";
    const pending1 = req(port, "GET", slow1, { headers: { Cookie: cacheUser.cookie } }).then((r) => { finished += 1; return r; });
    const pending2 = req(port, "GET", slow2, { headers: { Cookie: cacheUser.cookie } }).then((r) => { finished += 1; return r; });
    await sleep(80);
    const h0 = Date.now();
    const health = await req(port, "GET", "/health");
    const healthMs = Date.now() - h0;
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.json.ok, true);
    assert.ok(healthMs < 400, "health blocked for " + healthMs + "ms");
    assert.strictEqual(finished, 0, "renders finished before health; overlap was not tested");
    const rendered = await Promise.all([pending1, pending2]);
    assert.ok(rendered.every((r) => r.status === 200), rendered.map((r) => r.status + " " + r.text.slice(0, 120)).join(" | "));

    console.log("ok halftone preview guard, clamp, rate limit, cache, health");
  } catch (err) {
    console.error(s.child.log());
    throw err;
  } finally {
    await stop(s.child);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
