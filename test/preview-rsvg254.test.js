"use strict";
// preview.png must render on rsvg-convert 2.54 (Railway bookworm), which reads "-" as a file name.
// A shim on PATH rejects a "-" argument the way 2.54 does; paid, unpaid and halftone previews must stay 200.
const { encodePng, makeRgba } = require("../lib/png");
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ADMIN_EMAIL = "export-gate-admin@decoclub.test";
const ADMIN_PASSWORD = "preview-sec-pass";
const SIMPLE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="15" y="15" width="70" height="70" fill="#cc0000"/>
</svg>
`;
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


const FORMATS = ["art.svg", "art.eps", "art.pdf", "art.dxf", "art.tiff", "art-dtf.tiff", "art-300dpi.png", "art-underbase.png", "art.png", "cut-contour.svg", "packet.json"];
const EPS = "%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 100 100\nnewpath 15 15 moveto 85 15 lineto 85 85 lineto 15 85 lineto closepath fill\n%%EOF\n";

function plantVector(dir, jobId, tag, extra) {
  const svgName = "1700000000" + tag + "-gate-vector.svg";
  const epsName = "1700000000" + tag + "-gate-vector.eps";
  fs.writeFileSync(path.join(dir, "uploads", svgName), SIMPLE_SVG);
  fs.writeFileSync(path.join(dir, "uploads", epsName), EPS);
  editStore(dir, (db) => {
    const row = db.jobs.find((j) => j.id === jobId);
    row.vector_svg = "/uploads/" + svgName;
    row.vector_eps = "/uploads/" + epsName;
    row.vector = Object.assign({ widthIn: 4, heightIn: 3, layers: [{ color: "#cc0000", paths: [] }], source: "vai-trace" }, extra || {});
    row.unlocks = {};
    row.free_image = false;
  });
}

const { renderPreviewPng } = require("../lib/previewRender");
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-rsvg254-"));
const REAL = require("child_process").execSync("command -v rsvg-convert", { shell: "/bin/sh" }).toString().trim();
fs.writeFileSync(path.join(shimDir, "rsvg-convert"),
  '#!/bin/sh\nfor a in "$@"; do if [ "$a" = "-" ]; then echo \'Error reading file "-"\' >&2; exit 1; fi; done\nexec "' + REAL + '" "$@"\n');
fs.chmodSync(path.join(shimDir, "rsvg-convert"), 0o755);
process.env.PATH = shimDir + ":" + process.env.PATH;

(async function main() {
  for (const wm of [false, true]) {
    for (const mode of ["fill", "outline"]) {
      const png = await renderPreviewPng(SIMPLE_SVG, { mode: mode, watermark: wm });
      assert.ok(png.slice(1, 4).toString() === "PNG", "png " + mode + " wm=" + wm);
    }
  }
  const port = 19500 + Math.floor(Math.random() * 400);
  const s = startServer(port);
  try {
    await waitHealth(port);
    const shop = await signup(port, "pv254@shop.test", "Pv 254");
    const job = await uploadJob(port, shop.cookie, "Pv paid", tinyPng());
    editStore(s.dir, (db) => { db.users.find((u) => u.id === shop.id).vector_credits = 1; });
    const vz = await req(port, "POST", "/api/jobs/" + job.id + "/vectorize", { headers: { Cookie: shop.cookie }, body: "{}" });
    assert.strictEqual(vz.status, 200, "paid vectorize " + vz.text.slice(0, 200));
    const paid = await req(port, "GET", "/api/jobs/" + job.id + "/preview.png", { headers: { Cookie: shop.cookie } });
    assert.strictEqual(paid.status, 200, "paid preview " + paid.text.slice(0, 200));
    assert.strictEqual(paid.headers["content-type"], "image/png");

    const un = await uploadJob(port, shop.cookie, "Pv unpaid", tinyPng());
    const n1 = "1700000000201-pv-vector.svg";
    fs.writeFileSync(path.join(s.dir, "uploads", n1), SIMPLE_SVG);
    editStore(s.dir, (db) => { const r = db.jobs.find((j) => j.id === un.id); r.vector_svg = "/uploads/" + n1; r.unlocks = {}; });
    const wm = await req(port, "GET", "/api/jobs/" + un.id + "/preview.png", { headers: { Cookie: shop.cookie } });
    assert.strictEqual(wm.status, 200, "unpaid watermarked preview " + wm.text.slice(0, 200));
    assert.ok(wm.buf.length > paid.buf.length / 4, "watermark preview has content");

    const ht = await uploadJob(port, shop.cookie, "Pv ht", tinyPng());
    const n2 = "1700000000202-pv-halftone.svg";
    fs.writeFileSync(path.join(s.dir, "uploads", n2), SIMPLE_SVG);
    editStore(s.dir, (db) => {
      const r = db.jobs.find((j) => j.id === ht.id);
      r.vector_svg = "/uploads/" + n2;
      r.vector = { widthIn: 4, heightIn: 3, layers: [{ color: "#111111", paths: [] }], source: "vector-halftone" };
      r.unlocks = { halftones: true };
    });
    for (const q of ["", "?mode=outline"]) {
      const r = await req(port, "GET", "/api/jobs/" + ht.id + "/preview.png" + q, { headers: { Cookie: shop.cookie } });
      assert.strictEqual(r.status, 200, "halftone preview " + q + " " + r.text.slice(0, 200));
    }
    console.log("preview-rsvg254: ok");
  } catch (e) {
    console.error(s.child.log());
    throw e;
  } finally {
    await stop(s.child);
  }
})().catch((e) => { console.error(e); process.exit(1); });
