"use strict";
// Exports (svg/eps/pdf/dxf/tiff/png/underbase/packet) need a paid or free-image unlock; admin exempt.
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

(async function main() {
  const port = 19000 + Math.floor(Math.random() * 500);
  const s = startServer(port);
  try {
    await waitHealth(port);
    const shop = await signup(port, "gate-unpaid@shop.test", "Gate Unpaid");
    const job = await uploadJob(port, shop.cookie, "Gate plate", tinyPng());

    // Vectorize itself is 402 for an unverified, unpaid account: capture its message.
    const vz = await req(port, "POST", "/api/jobs/" + job.id + "/vectorize", { headers: { Cookie: shop.cookie }, body: "{}" });
    assert.strictEqual(vz.status, 402, "vectorize unpaid 402: " + vz.text.slice(0, 200));
    const vzMsg = vz.json.error;

    // Upload alone (even with an auto-trace on the job) must not make any export downloadable.
    for (const f of FORMATS) {
      const r = await req(port, "GET", "/api/export/" + job.id + "/" + f, { headers: { Cookie: shop.cookie } });
      assert.strictEqual(r.status, 402, "upload-only " + f + " -> " + r.status);
    }
    plantVector(s.dir, job.id, "101");
    for (const f of FORMATS) {
      const r = await req(port, "GET", "/api/export/" + job.id + "/" + f, { headers: { Cookie: shop.cookie } });
      assert.strictEqual(r.status, 402, "unpaid " + f + " -> " + r.status);
      if (f === "packet.json") continue; // already behind the paid-packet gate
      assert.strictEqual(r.json.error, vzMsg, "same message as vectorize for " + f);
      assert.strictEqual(r.json.code, "vector_credits_required");
    }
    const pk = await req(port, "GET", "/api/export/" + job.id, { headers: { Cookie: shop.cookie } });
    assert.strictEqual(pk.status, 402, "unpaid packet");

    // Pay: one credit, run Vectorize, exports open.
    editStore(s.dir, (db) => { db.users.find((u) => u.id === shop.id).vector_credits = 1; });
    const paid = await req(port, "POST", "/api/jobs/" + job.id + "/vectorize", { headers: { Cookie: shop.cookie }, body: "{}" });
    assert.strictEqual(paid.status, 200, "paid vectorize: " + paid.text.slice(0, 300));
    for (const f of ["art.svg", "art.pdf", "art-300dpi.png", "art-underbase.png"]) {
      const r = await req(port, "GET", "/api/export/" + job.id + "/" + f, { headers: { Cookie: shop.cookie } });
      assert.strictEqual(r.status, 200, "paid " + f + " -> " + r.status + " " + r.text.slice(0, 200));
    }

    // Admin is always entitled.
    const login = await req(port, "POST", "/api/login", { body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }) });
    const adminCk = cookieFrom(login);
    const aj = await uploadJob(port, adminCk, "Admin gate", tinyPng());
    plantVector(s.dir, aj.id, "102");
    for (const f of ["art.svg", "art.eps", "art.pdf", "art.dxf", "art-underbase.png"]) {
      const r = await req(port, "GET", "/api/export/" + aj.id + "/" + f, { headers: { Cookie: adminCk } });
      assert.strictEqual(r.status, 200, "admin " + f + " -> " + r.status + " " + r.text.slice(0, 200));
    }

    // Halftone art: a vectorize unlock is not enough; needs the halftones unlock.
    const ht = await uploadJob(port, shop.cookie, "HT gate", tinyPng());
    plantVector(s.dir, ht.id, "103", { source: "vector-halftone" });
    editStore(s.dir, (db) => { db.jobs.find((j) => j.id === ht.id).unlocks = { vectorize: true }; });
    for (const f of ["art.svg", "art.pdf", "art-underbase.png"]) {
      const r = await req(port, "GET", "/api/export/" + ht.id + "/" + f, { headers: { Cookie: shop.cookie } });
      assert.strictEqual(r.status, 402, "halftone unpaid " + f);
      assert.strictEqual(r.json.code, "halftone_credits_required");
    }
    editStore(s.dir, (db) => { db.jobs.find((j) => j.id === ht.id).unlocks = { halftones: true }; });
    const htOk = await req(port, "GET", "/api/export/" + ht.id + "/art.svg", { headers: { Cookie: shop.cookie } });
    assert.strictEqual(htOk.status, 200, "halftone paid svg");

    console.log("export-gate: ok");
  } catch (e) {
    console.error(s.child.log());
    throw e;
  } finally {
    await stop(s.child);
  }
})().catch((e) => { console.error(e); process.exit(1); });
