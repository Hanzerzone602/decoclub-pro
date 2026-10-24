"use strict";
// Exports (svg/eps/pdf/dxf/tiff/png/underbase/packet) need a paid or free-image unlock; admin exempt.
const { encodePng, decodePng, makeRgba } = require("../lib/png");
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

function markedPng(size, rgb) {
  const rgba = makeRgba(size, size, [255, 255, 255, 255]);
  const x0 = Math.max(1, Math.floor(size * 0.25));
  const x1 = Math.min(size - 1, Math.floor(size * 0.75));
  for (let y = x0; y < x1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * size + x) * 4;
      rgba[i] = rgb[0];
      rgba[i + 1] = rgb[1];
      rgba[i + 2] = rgb[2];
      rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
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

async function replaceArtwork(port, cookie, jobId, png) {
  const form = multipart({}, { name: "next.png", buf: png });
  const res = await req(port, "POST", "/api/jobs/" + jobId + "/artwork", {
    headers: { Cookie: cookie, "Content-Type": form.contentType },
    body: form.body,
  });
  assert.strictEqual(res.status, 200, "artwork replace " + (res.text || "").slice(0, 300));
  assert.ok(res.json.job.file_path);
  return res.json.job;
}

function transparentPixels(pngBuf) {
  const img = decodePng(pngBuf);
  let clear = 0;
  for (let i = 3; i < img.rgba.length; i += 4) if (img.rgba[i] < 16) clear++;
  return { img, clear };
}

function jobRow(dir, id) {
  const db = JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf8"));
  return db.jobs.find((j) => j.id === id);
}

function storedNobgPath(dir, job) {
  const parts = String(job && job.nobg_png || "").replace(/\\/g, "/").split("/").filter(Boolean);
  assert.deepStrictEqual(parts.slice(0, 2), ["uploads", job.id], "nobg left the job directory: " + (job && job.nobg_png));
  assert.strictEqual(parts.length, 3, "nobg path " + (job && job.nobg_png));
  assert.ok(/-nobg\.png$/i.test(parts[2]), "nobg filename " + parts[2]);
  return path.join(dir, parts[0], parts[1], parts[2]);
}


const FORMATS = ["art.svg", "art.eps", "art.pdf", "art.dxf", "art.tiff", "art-dtf.tiff", "art-300dpi.png", "art-underbase.png", "art.png", "art-upscaled-300dpi.png", "art-nobg.png", "art-cutout.svg", "cut-contour.svg", "packet.json"];
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
    const up = await req(port, "GET", "/api/export/" + aj.id + "/art-upscaled-300dpi.png?width_in=2", { headers: { Cookie: adminCk } });
    assert.strictEqual(up.status, 200, "admin upscale " + up.text.slice(0, 200));
    let phys = null;
    for (let o = 8; o + 12 <= up.buf.length;) {
      const len = up.buf.readUInt32BE(o);
      const typ = up.buf.toString("ascii", o + 4, o + 8);
      if (typ === "pHYs") phys = [up.buf.readUInt32BE(o + 8), up.buf.readUInt32BE(o + 12), up.buf[o + 16]];
      o += 12 + len;
      if (typ === "IEND") break;
    }
    assert.deepStrictEqual(phys, [11811, 11811, 1]);
    const nobg = await req(port, "GET", "/api/export/" + aj.id + "/art-nobg.png", { headers: { Cookie: adminCk } });
    assert.strictEqual(nobg.status, 200, "admin nobg " + nobg.text.slice(0, 200));
    const cutImg = decodePng(nobg.buf);
    let clear = 0;
    for (let i = 3; i < cutImg.rgba.length; i += 4) if (cutImg.rgba[i] < 16) clear++;
    assert.ok(clear > 0, "background removal left the sheet opaque");
    const raw = fs.readFileSync(path.join(s.dir, "uploads", path.basename(aj.file_path)));
    assert.ok(!nobg.buf.equals(raw), "art-nobg.png matched the original upload");
    const cut = await req(port, "GET", "/api/export/" + aj.id + "/art-cutout.svg", { headers: { Cookie: adminCk } });
    assert.strictEqual(cut.status, 200, "admin cutout " + cut.text.slice(0, 160));
    assert.ok(cut.text.indexOf("<svg") !== -1 && cut.text.indexOf("base64") !== -1);

    // Replacing artwork on the same job must not keep serving the previous cutout.
    const swap = await uploadJob(port, adminCk, "Nobg cache", markedPng(32, [10, 10, 10]));
    const nobgA = await req(port, "GET", "/api/export/" + swap.id + "/art-nobg.png", { headers: { Cookie: adminCk } });
    assert.strictEqual(nobgA.status, 200, "nobg A " + nobgA.text.slice(0, 200));
    const cutA = transparentPixels(nobgA.buf);
    assert.ok(cutA.clear > 0, "nobg A left the sheet opaque");
    const rowA = jobRow(s.dir, swap.id);
    const fileA = storedNobgPath(s.dir, rowA);
    assert.ok(fs.existsSync(fileA), "nobg A was not written");
    assert.ok(fs.readFileSync(fileA).equals(nobgA.buf), "cached nobg bytes drifted");
    const againA = await req(port, "GET", "/api/export/" + swap.id + "/art-nobg.png", { headers: { Cookie: adminCk } });
    assert.ok(nobgA.buf.equals(againA.buf), "unchanged source should keep the cached nobg");
    const rowA2 = jobRow(s.dir, swap.id);
    assert.strictEqual(rowA2.nobg_png, rowA.nobg_png, "unchanged source rewrote the nobg file");
    const ajFile = storedNobgPath(s.dir, jobRow(s.dir, aj.id));
    const jobDir = path.dirname(fileA);
    const staleCut = path.join(jobDir, "art-cutout.svg");
    const staleExtra = path.join(jobDir, "extra-nobg.png");
    const keepNote = path.join(jobDir, "keep-art.png");
    fs.writeFileSync(staleCut, "<svg>old</svg>");
    fs.writeFileSync(staleExtra, Buffer.from("old-nobg"));
    fs.writeFileSync(keepNote, Buffer.from("keep"));
    const decoy = path.join(s.dir, "uploads", "stranger-nobg.png");
    const decoyCut = path.join(s.dir, "uploads", "art-cutout.svg");
    fs.writeFileSync(decoy, Buffer.from("other"));
    fs.writeFileSync(decoyCut, "<svg>other</svg>");
    const outside = path.join(s.dir, "art-nobg.png");
    fs.writeFileSync(outside, Buffer.from("outside"));
    const srcA = path.join(s.dir, "uploads", path.basename(swap.file_path));
    const replaced = await replaceArtwork(port, adminCk, swap.id, markedPng(48, [210, 30, 30]));
    assert.notStrictEqual(path.basename(replaced.file_path), path.basename(swap.file_path));
    assert.ok(!fs.existsSync(fileA), "old nobg file still in the job directory");
    assert.ok(!fs.existsSync(staleCut), "old cutout svg still in the job directory");
    assert.ok(!fs.existsSync(staleExtra), "other derived nobg file still in the job directory");
    assert.ok(fs.existsSync(keepNote), "non-derived file in the job directory was deleted");
    assert.ok(fs.existsSync(ajFile), "another job's nobg was deleted");
    assert.ok(fs.existsSync(decoy), "unrelated nobg in uploads was deleted");
    assert.ok(fs.existsSync(decoyCut), "unrelated cutout in uploads was deleted");
    assert.ok(fs.existsSync(outside), "file outside uploads was deleted");
    assert.ok(fs.existsSync(srcA), "source art was deleted");
    const nobgB = await req(port, "GET", "/api/export/" + swap.id + "/art-nobg.png", { headers: { Cookie: adminCk } });
    assert.strictEqual(nobgB.status, 200, "nobg B " + nobgB.text.slice(0, 200));
    assert.ok(!nobgA.buf.equals(nobgB.buf), "replaced art still served the previous nobg");
    const rawB = fs.readFileSync(path.join(s.dir, "uploads", path.basename(replaced.file_path)));
    assert.ok(!nobgB.buf.equals(rawB), "nobg B matched the replacement upload");
    const cutBimg = transparentPixels(nobgB.buf);
    assert.ok(cutBimg.clear > 0, "nobg B left the sheet opaque");
    assert.notStrictEqual(cutBimg.img.width, cutA.img.width, "nobg pixel size did not follow the new source");
    const cutB = await req(port, "GET", "/api/export/" + swap.id + "/art-cutout.svg", { headers: { Cookie: adminCk } });
    assert.strictEqual(cutB.status, 200, "cutout B " + cutB.text.slice(0, 160));
    assert.ok(cutB.text.indexOf('width="' + cutBimg.img.width + '"') !== -1, "cutout svg kept the previous width");
    assert.ok(cutB.text.indexOf(nobgB.buf.toString("base64")) !== -1, "cutout svg did not embed the new nobg");
    assert.ok(cutB.text.indexOf(nobgA.buf.toString("base64")) === -1, "cutout svg still embedded the previous nobg");
    const fileB = storedNobgPath(s.dir, jobRow(s.dir, swap.id));
    assert.ok(fs.existsSync(fileB), "new nobg file missing");
    assert.notStrictEqual(fileB, fileA, "replaced art reused the previous nobg file");
    assert.ok(!fs.existsSync(fileA), "old nobg file came back");
    assert.ok(fs.readFileSync(fileB).equals(nobgB.buf), "new nobg file does not match the download");
    const derivedLeft = fs.readdirSync(jobDir).filter((n) => /nobg|cutout/i.test(n)).sort();
    assert.deepStrictEqual(derivedLeft, [path.basename(fileB)], "stale derived no-bg files remained: " + derivedLeft.join(","));
    const rawStored = await req(port, "GET", jobRow(s.dir, swap.id).nobg_png, { headers: { Cookie: adminCk } });
    assert.strictEqual(rawStored.status, 200, "stored nobg " + rawStored.status);
    assert.ok(rawStored.buf.equals(nobgB.buf), "stored nobg bytes drifted");
    const anonStored = await req(port, "GET", jobRow(s.dir, swap.id).nobg_png);
    assert.strictEqual(anonStored.status, 401, "stored nobg was public");
    assert.ok(fs.existsSync(keepNote), "non-derived file was deleted after the new nobg");
    assert.ok(fs.existsSync(ajFile), "another job's nobg was deleted after the new nobg");
    assert.ok(fs.existsSync(decoy) && fs.existsSync(decoyCut), "unrelated uploads were deleted after the new nobg");
    assert.ok(fs.existsSync(outside), "file outside uploads was deleted after the new nobg");
    assert.ok(fs.existsSync(srcA), "source art was deleted after the new nobg");

    // Halftone art: a vectorize unlock is not enough; needs the halftones unlock.
    const ht = await uploadJob(port, shop.cookie, "HT gate", tinyPng());
    plantVector(s.dir, ht.id, "103", { source: "vector-halftone" });
    editStore(s.dir, (db) => { db.jobs.find((j) => j.id === ht.id).unlocks = { vectorize: true }; });
    for (const f of ["art.svg", "art.pdf", "art-underbase.png", "art-upscaled-300dpi.png", "art-nobg.png", "art-cutout.svg"]) {
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
