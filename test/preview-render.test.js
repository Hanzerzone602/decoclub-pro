"use strict";
// Sharp vector preview: PNG tiles, outline vs fill, unpaid watermark, raw SVG blocked.
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { decodePng } = require("../lib/png");

const ADMIN_EMAIL = "preview-admin@decoclub.test";
const ADMIN_PASSWORD = "preview-admin-pass";
const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect data-name="paper-underlay" x="0" y="0" width="100" height="100" fill="#ffffff"/>
  <rect x="20" y="20" width="60" height="60" fill="#cc0000"/>
  <circle cx="50" cy="50" r="8" style="fill:#003399;stroke:none"/>
</svg>
`;

function req(port, method, urlPath, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, opts.headers || {});
    const body = opts.body == null ? null : Buffer.from(opts.body);
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
    r.setTimeout(30000, () => r.destroy(new Error("timeout " + method + " " + urlPath)));
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

async function waitHealth(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await req(port, "GET", "/health");
      if (r.status === 200) return r;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not start");
}

function startServer(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-preview-"));
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
  child.stdout.on("data", (d) => { log += d; if (log.length > 8000) log = log.slice(-8000); });
  child.stderr.on("data", (d) => { log += d; if (log.length > 8000) log = log.slice(-8000); });
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

function countWhere(buf, pred) {
  const d = decodePng(buf);
  let n = 0;
  for (let i = 0; i < d.rgba.length; i += 4) {
    if (pred(d.rgba[i], d.rgba[i + 1], d.rgba[i + 2], d.rgba[i + 3])) n++;
  }
  return { n: n, width: d.width, height: d.height, pixels: d.width * d.height };
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

const isRed = (r, g, b, a) => a > 30 && r > 150 && r > b + 40;
// Outline stroke is #00a0ff. The fixture's navy fill (#003399) must not count.
const isBlue = (r, g, b, a) => a > 40 && r < 90 && g > 80 && b > 160;
const isOpaque = (r, g, b, a) => a > 20;

(async () => {
  const port = 41321;
  const s = startServer(port);
  try {
    await waitHealth(port);
    const appJs = await req(port, "GET", "/app.js");
    assert.strictEqual(appJs.status, 200);
    assert.ok(appJs.text.indexOf("preview.png") !== -1, "client calls the preview endpoint");
    assert.ok(appJs.text.indexOf("outlineToggle") !== -1, "outline toggle is in the studio");
    assert.ok(appJs.text.indexOf("dcPreviewMode") !== -1);
    assert.ok(appJs.text.indexOf("artZoomSvg") === -1, "inline svg host is gone");
    const css = await req(port, "GET", "/styles.css");
    assert.ok(css.text.indexOf("touch-action:none") !== -1, "pinch/pan not stolen by the browser");

    const signup = await req(port, "POST", "/api/signup", {
      body: JSON.stringify({ name: "Ada", email: "ada-preview@shop.test", password: "secret12", shopName: "Ada Press", role: "shop" }),
    });
    assert.strictEqual(signup.status, 200, JSON.stringify(signup.json));
    const shopCk = cookieFrom(signup);
    const jobRes = await req(port, "POST", "/api/jobs", {
      headers: { Cookie: shopCk },
      body: JSON.stringify({ title: "Preview plate", method: "dtf", width_in: 4, height_in: 4, qty: 1 }),
    });
    assert.strictEqual(jobRes.status, 200, JSON.stringify(jobRes.json));
    const jobId = jobRes.json.job.id;

    const other = await req(port, "POST", "/api/signup", {
      body: JSON.stringify({ name: "Bea", email: "bea-preview@shop.test", password: "secret12", shopName: "Bea Press", role: "shop" }),
    });
    assert.strictEqual(other.status, 200);
    const otherCk = cookieFrom(other);

    const adminLogin = await req(port, "POST", "/api/login", {
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    assert.strictEqual(adminLogin.status, 200, JSON.stringify(adminLogin.json));
    const adminCk = cookieFrom(adminLogin);

    const freeName = "1700000000001-previewfree-vector.svg";
    const paidName = "1700000000002-previewpaid-vector.svg";
    const orphanName = "1700000000003-orphan-vector.svg";
    const uploads = path.join(s.dir, "uploads");
    fs.writeFileSync(path.join(uploads, freeName), SVG);
    fs.writeFileSync(path.join(uploads, paidName), SVG);
    fs.writeFileSync(path.join(uploads, orphanName), SVG);
    fs.writeFileSync(path.join(uploads, "customer-logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\" fill=\"#111\"/></svg>");

    const storePath = path.join(s.dir, "store.json");
    const db = JSON.parse(fs.readFileSync(storePath, "utf8"));
    const job = db.jobs.find((j) => j.id === jobId);
    assert.ok(job, "job persisted");
    job.vector_svg = "/uploads/" + freeName;
    job.free_image = true;
    job.unlocks = { vectorize: true, halftones: false };
    job.vector = {
      widthIn: 4,
      heightIn: 4,
      layers: [{ hex: "#cc0000", name: "red" }],
      svg: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 10 10\"><rect width=\"10\" height=\"10\" fill=\"#00ff00\"/></svg>",
    };
    job.halftone = { style: "classic-round", svg: "/uploads/" + freeName };
    const paidId = crypto.randomBytes(16).toString("hex");
    const paid = Object.assign({}, job, {
      id: paidId,
      title: "Paid plate",
      proof_token: crypto.randomBytes(32).toString("hex"),
      vector_svg: "/uploads/" + paidName,
      free_image: false,
      unlocks: { vectorize: true, halftones: false },
      vector: Object.assign({}, job.vector),
      halftone: { style: "classic-round", svg: "/uploads/" + paidName },
    });
    db.jobs.push(paid);
    fs.writeFileSync(storePath, JSON.stringify(db));

    const q = "x=0&y=0&w=1&h=1&zoom=1&pw=80&ph=80";
    const anon = await req(port, "GET", "/api/jobs/" + jobId + "/preview.png?" + q);
    assert.strictEqual(anon.status, 401, "anonymous preview");
    const foreign = await req(port, "GET", "/api/jobs/" + jobId + "/preview.png?" + q, { headers: { Cookie: otherCk } });
    assert.strictEqual(foreign.status, 403, "other shop preview");
    const adminForeign = await req(port, "GET", "/api/jobs/" + paidId + "/preview.png?" + q, { headers: { Cookie: adminCk } });
    assert.strictEqual(adminForeign.status, 403, "preview keeps job ownership");
    const badMode = await req(port, "GET", "/api/jobs/" + paidId + "/preview.png?" + q + "&mode=nope", { headers: { Cookie: shopCk } });
    assert.strictEqual(badMode.status, 400, "bad mode");
    const badZoom = await req(port, "GET", "/api/jobs/" + paidId + "/preview.png?zoom=0&pw=32&ph=32", { headers: { Cookie: shopCk } });
    assert.strictEqual(badZoom.status, 400, "bad zoom");
    const badW = await req(port, "GET", "/api/jobs/" + paidId + "/preview.png?x=0&y=0&w=-1&h=1", { headers: { Cookie: shopCk } });
    assert.strictEqual(badW.status, 400, "bad window");

    const fill = await req(port, "GET", "/api/jobs/" + paidId + "/preview.png?" + q + "&mode=fill", { headers: { Cookie: shopCk } });
    assert.strictEqual(fill.status, 200, "paid fill " + fill.text.slice(0, 180));
    assert.ok(String(fill.headers["content-type"] || "").indexOf("image/png") !== -1);
    assert.ok(String(fill.headers["cache-control"] || "").indexOf("private") !== -1);
    assert.strictEqual(fill.buf[0], 0x89);
    assert.strictEqual(fill.buf[1], 0x50);
    const fillRed = countWhere(fill.buf, isRed);
    const fillBlue = countWhere(fill.buf, isBlue);
    assert.ok(fillRed.n > 500, "fill paints the red square, got " + fillRed.n);
    assert.ok(fillBlue.n < 30, "fill is not an outline, blue " + fillBlue.n);

    const outline = await req(port, "GET", "/api/jobs/" + paidId + "/preview.png?" + q + "&mode=outline", { headers: { Cookie: shopCk } });
    assert.strictEqual(outline.status, 200);
    assert.ok(String(outline.headers["content-type"] || "").indexOf("image/png") !== -1);
    const outRed = countWhere(outline.buf, isRed);
    const outBlue = countWhere(outline.buf, isBlue);
    assert.ok(Buffer.compare(fill.buf, outline.buf) !== 0, "outline bytes differ from fill");
    assert.ok(outBlue.n > 40, "outline strokes are blue, got " + outBlue.n);
    assert.ok(outRed.n < fillRed.n / 5, "outline drops the red fill");
    assert.ok(outBlue.n < outBlue.pixels * 0.25, "outline stroke stays thin, blue " + outBlue.n);

    const corner = await req(port, "GET", "/api/jobs/" + paidId + "/preview.png?x=0&y=0&w=0.15&h=0.15&pw=40&ph=40&mode=fill", { headers: { Cookie: shopCk } });
    assert.strictEqual(corner.status, 200);
    const cornerOp = countWhere(corner.buf, isOpaque);
    assert.ok(cornerOp.n < 8, "paper underlay stripped and corner crop is empty, opaque " + cornerOp.n);

    const unpaid = await req(port, "GET", "/api/jobs/" + jobId + "/preview.png?" + q + "&mode=fill", { headers: { Cookie: shopCk } });
    assert.strictEqual(unpaid.status, 200);
    const wmDiff = diffCount(fill.buf, unpaid.buf);
    assert.ok(wmDiff > 80, "unpaid watermark differs from entitled preview, diff " + wmDiff);

    const capped = await req(port, "GET", "/api/jobs/" + paidId + "/preview.png?x=0&y=0&w=1&h=1&pw=4000&ph=4000&mode=fill", { headers: { Cookie: shopCk } });
    assert.strictEqual(capped.status, 200);
    const cappedPx = decodePng(capped.buf);
    assert.ok(cappedPx.width <= 2048 && cappedPx.height <= 2048, "output capped at 2048");
    assert.strictEqual(cappedPx.width, 2048);

    const freeJson = await req(port, "GET", "/api/jobs/" + jobId, { headers: { Cookie: shopCk } });
    assert.strictEqual(freeJson.status, 200);
    const freeBody = JSON.stringify(freeJson.json);
    assert.strictEqual(freeJson.json.job.free_image, true);
    assert.ok(freeJson.json.job.vector_preview.indexOf("/preview.png") !== -1);
    assert.ok(freeJson.json.job.has_vector);
    assert.ok(!freeJson.json.job.vector_svg, "unpaid job JSON hides the svg url");
    assert.ok(freeBody.indexOf(freeName) === -1, "svg filename not in unpaid job JSON");
    assert.ok(freeBody.indexOf("<svg") === -1, "inline svg markup not in unpaid job JSON");

    const paidJson = await req(port, "GET", "/api/jobs/" + paidId, { headers: { Cookie: shopCk } });
    assert.ok(paidJson.json.job.vector_svg.indexOf(paidName) !== -1, "paid job keeps the svg url");

    const rawAnon = await req(port, "GET", "/uploads/" + freeName);
    assert.strictEqual(rawAnon.status, 401, "anonymous raw svg");
    const rawShop = await req(port, "GET", "/uploads/" + freeName, { headers: { Cookie: shopCk } });
    assert.strictEqual(rawShop.status, 403, "unpaid raw svg blocked");
    const rawAdmin = await req(port, "GET", "/uploads/" + freeName, { headers: { Cookie: adminCk } });
    assert.strictEqual(rawAdmin.status, 200, "admin can fetch the svg");
    assert.ok(rawAdmin.text.indexOf("<svg") !== -1);
    const rawPaid = await req(port, "GET", "/uploads/" + paidName, { headers: { Cookie: shopCk } });
    assert.strictEqual(rawPaid.status, 200, "paid owner can fetch the svg");
    const rawOrphan = await req(port, "GET", "/uploads/" + orphanName);
    assert.strictEqual(rawOrphan.status, 401, "orphan generated svg stays private");
    const rawLogo = await req(port, "GET", "/uploads/customer-logo.svg");
    assert.strictEqual(rawLogo.status, 200, "non-vector upload svg still serves");

    const exp = await req(port, "GET", "/api/export/" + jobId + "/art.svg", { headers: { Cookie: shopCk } });
    assert.strictEqual(exp.status, 200, "free-image download rules unchanged");
    assert.ok(exp.text.indexOf("#cc0000") !== -1);
    assert.ok(exp.text.indexOf("DECOCLUB PRO") === -1, "download is not the watermarked preview");
    assert.ok(exp.text.indexOf("paper-underlay") === -1);

    console.log("ok preview png, outline, watermark, svg guard");
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
