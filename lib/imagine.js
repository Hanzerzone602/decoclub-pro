"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");

const FALLBACK_MODEL = "grok-imagine-image-2.0";
const CACHE_MS = 60 * 60 * 1000;

var cachedId = null;
var cachedAt = 0;

function imagineConfigured() {
  return Boolean(process.env.XAI_API_KEY);
}

function versionParts(id) {
  const m = String(id || "").match(/^grok-imagine-image(?:-([0-9]+(?:\.[0-9]+)*))?/);
  if (!m) return null;
  if (!m[1]) return [0];
  return m[1].split(".").map(function (n) { return parseInt(n, 10) || 0; });
}

function cmpImagineId(a, b) {
  const va = versionParts(a) || [];
  const vb = versionParts(b) || [];
  const n = Math.max(va.length, vb.length);
  for (let i = 0; i < n; i++) {
    const x = va[i] || 0, y = vb[i] || 0;
    if (x !== y) return x - y;
  }
  return String(a).length - String(b).length;
}

function looksV2Plus(id) {
  const v = versionParts(id);
  return !!(v && v[0] >= 2);
}

function pickImagineModel(list) {
  let best = null;
  (list || []).forEach(function (item) {
    const id = typeof item === "string" ? item : (item && item.id);
    if (!id || !/^grok-imagine-image/.test(id)) return;
    if (!best || cmpImagineId(id, best) > 0) best = id;
  });
  return best;
}

function requestUrl(urlStr, opts, body, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === "http:" ? 80 : 443),
      path: u.pathname + u.search,
      method: (opts && opts.method) || "GET",
      headers: (opts && opts.headers) || {},
    }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) });
      });
    });
    req.setTimeout(timeoutMs || 60000, function () {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function xaiJson(method, urlPath, bodyObj, timeoutMs) {
  const body = bodyObj ? Buffer.from(JSON.stringify(bodyObj)) : null;
  const headers = { Authorization: "Bearer " + process.env.XAI_API_KEY };
  if (body) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = body.length;
  }
  return requestUrl("https://api.x.ai" + urlPath, { method: method, headers: headers }, body, timeoutMs).then(function (res) {
    let json = null;
    try { json = JSON.parse(res.buf.toString("utf8")); } catch (e) {}
    return { status: res.status, json: json, buf: res.buf, headers: res.headers };
  });
}

function downloadUrl(urlStr, hops, timeoutMs) {
  hops = hops || 0;
  return requestUrl(urlStr, { method: "GET", headers: {} }, null, timeoutMs).then(function (res) {
    if (res.status >= 300 && res.status < 400 && res.headers.location && hops < 5) {
      return downloadUrl(new URL(res.headers.location, urlStr).toString(), hops + 1, timeoutMs);
    }
    if (res.status >= 400) throw new Error("Image download failed");
    return res.buf;
  });
}

function bufferFromImageResponse(json) {
  const item = json && json.data && json.data[0];
  if (!item) return Promise.reject(new Error("No image in response"));
  if (item.b64_json) return Promise.resolve(Buffer.from(item.b64_json, "base64"));
  if (item.url) return downloadUrl(item.url, 0, 60000);
  return Promise.reject(new Error("No image in response"));
}

function listModels() {
  return xaiJson("GET", "/v1/models", null, 20000).then(function (res) {
    if (res.status >= 400 || !res.json) return [];
    return res.json.data || res.json.models || [];
  });
}

function resolveImagineModel() {
  if (cachedId && Date.now() - cachedAt < CACHE_MS) return Promise.resolve(cachedId);
  return listModels().then(function (list) {
    const picked = pickImagineModel(list);
    if (picked) {
      cachedId = picked;
      cachedAt = Date.now();
      return cachedId;
    }
    return cachedId || FALLBACK_MODEL;
  }).catch(function () {
    return cachedId || FALLBACK_MODEL;
  });
}

function generateImage(opts) {
  opts = opts || {};
  if (!imagineConfigured()) return Promise.reject(new Error("Grok Imagine is not configured"));
  return resolveImagineModel().then(function (model) {
    const payload = { model: model, prompt: String(opts.prompt || ""), response_format: "url" };
    if (looksV2Plus(model)) {
      payload.quality = "medium";
      payload.resolution = "2K";
    }
    const urlPath = opts.imageBuf ? "/v1/images/edits" : "/v1/images/generations";
    if (opts.imageBuf) {
      const mime = opts.mime || "image/png";
      payload.image = {
        url: "data:" + mime + ";base64," + Buffer.from(opts.imageBuf).toString("base64"),
        type: "image_url",
      };
    }
    function post(body) {
      return xaiJson("POST", urlPath, body, 60000);
    }
    return post(payload).then(function (res) {
      if (res.status >= 400 && (payload.quality || payload.resolution)) {
        delete payload.quality;
        delete payload.resolution;
        return post(payload);
      }
      return res;
    }).then(function (res) {
      if (res.status >= 400) {
        const errObj = res.json && res.json.error;
        const msg = (errObj && (errObj.message || errObj)) || "Imagine failed";
        throw new Error(typeof msg === "string" ? msg : "Imagine failed");
      }
      return bufferFromImageResponse(res.json);
    });
  });
}

module.exports = {
  imagineConfigured: imagineConfigured,
  resolveImagineModel: resolveImagineModel,
  generateImage: generateImage,
  pickImagineModel: pickImagineModel,
};
