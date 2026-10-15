"use strict";
// Apply halftone pitch is exactly 1/LPI in inches. Preview may coarsen but must say so.
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { encodePng, makeRgba } = require("../lib/png");
const ht = require("../lib/vectorHalftone");

const ART_W = 480;
const ART_H = 640;

function gradientPng() {
  const rgba = makeRgba(ART_W, ART_H, [255, 255, 255, 255]);
  for (let y = 0; y < ART_H; y++) {
    for (let x = 0; x < ART_W; x++) {
      const i = (y * ART_W + x) * 4;
      const v = Math.round(255 * (x / (ART_W - 1)));
      rgba[i] = v;
      rgba[i + 1] = v;
      rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return encodePng(ART_W, ART_H, rgba);
}

function tinyPng() {
  const rgba = makeRgba(24, 24, [20, 20, 20, 255]);
  return encodePng(24, 24, rgba);
}

function svgGeom(svg) {
  const wm = /width="([0-9.]+)in"/.exec(svg);
  const hm = /height="([0-9.]+)in"/.exec(svg);
  const vb = /viewBox="0 0 ([0-9.]+) ([0-9.]+)"/.exec(svg);
  assert.ok(wm && hm && vb, "svg width/height/viewBox");
  return {
    widthIn: parseFloat(wm[1]),
    heightIn: parseFloat(hm[1]),
    vbW: parseFloat(vb[1]),
    vbH: parseFloat(vb[2]),
  };
}

function circleCenters(svg) {
  const out = [];
  const re = /<circle\b[^>]*\bcx="([-0-9.]+)"[^>]*\bcy="([-0-9.]+)"/g;
  let m;
  while ((m = re.exec(svg))) out.push([parseFloat(m[1]), parseFloat(m[2])]);
  return out;
}

function dominantGap(diffs) {
  assert.ok(diffs.length > 30, "not enough neighbour gaps, got " + diffs.length);
  diffs.sort(function (a, b) { return a - b; });
  const lo = diffs[Math.floor(diffs.length * 0.08)];
  const mid = diffs[Math.floor(diffs.length * 0.5)];
  if (mid > lo * 1.35) return lo;
  return mid;
}

// Axis-aligned screen: nearest neighbour is the adjacent circle on the same row or column.
function nearestPitchPx(points) {
  const rows = new Map();
  const cols = new Map();
  for (let i = 0; i < points.length; i++) {
    const xk = points[i][0].toFixed(3);
    const yk = points[i][1].toFixed(3);
    let row = rows.get(yk);
    if (!row) { row = []; rows.set(yk, row); }
    row.push(points[i][0]);
    let col = cols.get(xk);
    if (!col) { col = []; cols.set(xk, col); }
    col.push(points[i][1]);
  }
  function gaps(groups) {
    const diffs = [];
    for (const arr of groups.values()) {
      if (arr.length < 4) continue;
      arr.sort(function (a, b) { return a - b; });
      for (let i = 1; i < arr.length; i++) {
        const d = arr[i] - arr[i - 1];
        if (d > 0.02) diffs.push(d);
      }
    }
    return dominantGap(diffs);
  }
  return { x: gaps(rows), y: gaps(cols) };
}

function assertAspect(geom) {
  const artAspect = ART_W / ART_H;
  const svgAspect = geom.widthIn / geom.heightIn;
  const rel = Math.abs(svgAspect - artAspect) / artAspect;
  assert.ok(rel < 0.01, "svg aspect " + svgAspect + " vs art " + artAspect);
  const xScale = geom.widthIn / geom.vbW;
  const yScale = geom.heightIn / geom.vbH;
  const scaleRel = Math.abs(xScale - yScale) / xScale;
  assert.ok(scaleRel < 0.01, "non-uniform scale " + xScale + " vs " + yScale);
}

function assertPitch(packed, lpi) {
  assert.strictEqual(packed.meta.lpi, lpi);
  assert.strictEqual(packed.meta.effectiveLpi, lpi);
  const geom = svgGeom(packed.svg);
  assert.strictEqual(geom.vbW, ART_W);
  assert.strictEqual(geom.vbH, ART_H);
  assertAspect(geom);
  const pts = circleCenters(packed.svg).filter(function (p) {
    return p[0] > geom.vbW * 0.05 && p[0] < geom.vbW * 0.55 && p[1] > geom.vbH * 0.05 && p[1] < geom.vbH * 0.95;
  });
  assert.ok(pts.length > 80, "expected circles, got " + pts.length);
  const pitch = nearestPitchPx(pts);
  const xIn = pitch.x * (geom.widthIn / geom.vbW);
  const yIn = pitch.y * (geom.heightIn / geom.vbH);
  const expect = 1 / lpi;
  const xErr = Math.abs(xIn - expect) / expect;
  const yErr = Math.abs(yIn - expect) / expect;
  assert.ok(xErr < 0.02, "x spacing " + xIn + " vs 1/" + lpi + " (" + expect + ")");
  assert.ok(yErr < 0.02, "y spacing " + yIn + " vs 1/" + lpi + " (" + expect + ")");
  return geom;
}

const png = gradientPng();

{
  const packed = ht.halftoneToSvg(png, {
    style: "classic-round",
    lpi: 25,
    angle: 0,
    widthIn: 10,
    preview: false,
    maxEdge: 200,
    maxCells: 52000,
  });
  const geom = assertPitch(packed, 25);
  assert.ok(Math.abs(geom.widthIn - 10) < 0.02, "width stays 10in when only width is set, got " + geom.widthIn);
  assert.ok(Math.max(packed.meta.pixel[0], packed.meta.pixel[1]) <= 200, "sampling edge capped");
  console.log("ok 25 LPI exact pitch at 10in width", geom.widthIn + "x" + geom.heightIn + "in");
}

{
  const packed = ht.halftoneToSvg(png, {
    style: "classic-round",
    lpi: 45,
    angle: 0,
    widthIn: 10,
    preview: false,
    maxEdge: 4000,
    maxCells: 52000,
  });
  const geom = assertPitch(packed, 45);
  assert.ok(Math.abs(geom.widthIn - 10) < 0.02, "width stays 10in, got " + geom.widthIn);
  console.log("ok 45 LPI exact pitch at 10in width", geom.widthIn + "x" + geom.heightIn + "in");
}

{
  // 10×10 job box, portrait art: fit inside, 7.5in wide × 10in tall.
  const packed = ht.halftoneToSvg(png, {
    style: "classic-round",
    lpi: 25,
    angle: 0,
    widthIn: 10,
    heightIn: 10,
    preview: false,
    maxCells: 52000,
  });
  const geom = assertPitch(packed, 25);
  assert.ok(Math.abs(geom.widthIn - 7.5) < 0.02, "fitted width " + geom.widthIn);
  assert.ok(Math.abs(geom.heightIn - 10) < 0.02, "fitted height " + geom.heightIn);
  console.log("ok 10x10 box fits portrait art to 7.5x10");
}

{
  let err = null;
  try {
    ht.halftoneToSvg(png, {
      style: "classic-round",
      lpi: 120,
      angle: 0,
      widthIn: 40,
      heightIn: 40,
      preview: false,
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "oversized apply must throw");
  assert.strictEqual(err.status, 413);
  assert.ok(/need \d+ dots \(limit 600000\)/.test(err.message), err.message);
  assert.ok(/Lower the LPI or print size/.test(err.message), err.message);
  console.log("ok oversized apply throws 413:", err.message);
}

{
  const prev = ht.halftoneToSvg(png, {
    style: "classic-round",
    lpi: 45,
    angle: 0,
    widthIn: 10,
    heightIn: 10,
    preview: true,
    maxEdge: 420,
    maxCells: 9000,
  });
  assert.strictEqual(prev.meta.lpi, 45);
  assert.ok(Number.isFinite(prev.meta.effectiveLpi), "preview effectiveLpi");
  assert.ok(prev.meta.effectiveLpi < 45, "preview coarsens and must not claim 45 LPI, got " + prev.meta.effectiveLpi);
  const geom = svgGeom(prev.svg);
  assert.strictEqual(geom.vbW, ART_W);
  assert.strictEqual(geom.vbH, ART_H);
  assertAspect(geom);
  const pts = circleCenters(prev.svg).filter(function (p) {
    return p[0] > 10 && p[0] < ART_W * 0.7 && p[1] > 10 && p[1] < ART_H - 10;
  });
  const pitch = nearestPitchPx(pts);
  const xIn = pitch.x * (geom.widthIn / geom.vbW);
  const expect = 1 / prev.meta.effectiveLpi;
  const xErr = Math.abs(xIn - expect) / expect;
  assert.ok(xErr < 0.02, "preview spacing " + xIn + " vs 1/effectiveLpi " + expect);
  console.log("ok preview reports effective LPI", prev.meta.effectiveLpi);
}

function multipart(fields, file) {
  const boundary = "----dcpLpi" + Date.now();
  const chunks = [];
  Object.keys(fields).forEach(function (k) {
    chunks.push(Buffer.from(
      "--" + boundary + "\r\n" +
      'Content-Disposition: form-data; name="' + k + '"\r\n\r\n' +
      String(fields[k]) + "\r\n"
    ));
  });
  chunks.push(Buffer.from(
    "--" + boundary + "\r\n" +
    'Content-Disposition: form-data; name="file"; filename="' + file.name + '"\r\n' +
    "Content-Type: image/png\r\n\r\n"
  ));
  chunks.push(file.buf);
  chunks.push(Buffer.from("\r\n--" + boundary + "--\r\n"));
  return { body: Buffer.concat(chunks), contentType: "multipart/form-data; boundary=" + boundary };
}

function req(port, method, urlPath, opts) {
  opts = opts || {};
  return new Promise(function (resolve, reject) {
    const headers = Object.assign({}, opts.headers || {});
    const body = opts.body == null ? null : (Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body));
    if (body && !headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
    if (body) headers["Content-Length"] = body.length;
    const r = http.request({ hostname: "127.0.0.1", port: port, path: urlPath, method: method, headers: headers }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString("utf8"), json: json });
      });
    });
    r.setTimeout(60000, function () { r.destroy(new Error("timeout " + method + " " + urlPath)); });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

function cookieFrom(res) {
  const set = res.headers["set-cookie"];
  if (!set) return "";
  return (Array.isArray(set) ? set : [set]).map(function (c) { return String(c).split(";")[0]; }).join("; ");
}

(async function () {
  const port = 41873;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcp-lpi-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: Object.assign({}, process.env, {
      DATA_DIR: dir,
      HOST: "127.0.0.1",
      PORT: String(port),
      ALLOW_DEMO: "0",
      NODE_ENV: "production",
      ADMIN_EMAIL: "lpi-admin@decoclub.test",
      ADMIN_PASSWORD: "lpi-admin-pass",
      FEATURE_MEMBERSHIP: "",
      FEATURE_DIGITIZE: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      BREVO_API_KEY: "",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", function (d) { log += d; if (log.length > 8000) log = log.slice(-8000); });
  child.stderr.on("data", function (d) { log += d; if (log.length > 8000) log = log.slice(-8000); });
  function stop() {
    return new Promise(function (resolve) {
      child.on("exit", function () { resolve(); });
      child.kill("SIGTERM");
      setTimeout(function () { try { child.kill("SIGKILL"); } catch (e) {} }, 1500);
    });
  }
  try {
    let health = null;
    for (let i = 0; i < 80; i++) {
      try {
        const r = await req(port, "GET", "/health");
        if (r.status === 200) { health = r; break; }
      } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 50); });
    }
    if (!health) throw new Error("server did not start\n" + log);
    const login = await req(port, "POST", "/api/login", {
      body: JSON.stringify({ email: "lpi-admin@decoclub.test", password: "lpi-admin-pass" }),
    });
    assert.strictEqual(login.status, 200, "admin login " + JSON.stringify(login.json));
    const cookie = cookieFrom(login);
    const form = multipart(
      { title: "LPI budget", method: "dtf", width_in: "24", height_in: "24", qty: "1" },
      { name: "plate.png", buf: tinyPng() }
    );
    const job = await req(port, "POST", "/api/jobs", {
      headers: { Cookie: cookie, "Content-Type": form.contentType },
      body: form.body,
    });
    assert.strictEqual(job.status, 200, "job " + JSON.stringify(job.json));
    const over = await req(port, "POST", "/api/jobs/" + job.json.job.id + "/halftone", {
      headers: { Cookie: cookie },
      body: JSON.stringify({ style: "classic-round", lpi: 100, angle: 0 }),
    });
    assert.strictEqual(over.status, 413, "expected 413, got " + over.status + " " + over.text.slice(0, 400));
    assert.ok(over.json && typeof over.json.error === "string", "413 body is JSON");
    assert.ok(/need \d+ dots \(limit 600000\)/.test(over.json.error), over.json.error);
    assert.ok(/Lower the LPI or print size/.test(over.json.error), over.json.error);
    assert.ok(over.text.indexOf("Server error") === -1, over.text.slice(0, 300));
    console.log("ok server Apply returns 413 JSON:", over.json.error);
    console.log("PASS halftone-lpi");
  } catch (err) {
    console.error(log);
    throw err;
  } finally {
    await stop();
  }
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
