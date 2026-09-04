"use strict";

const https = require("https");
const { URL } = require("url");

function configured() {
  return Boolean(process.env.VECTORIZER_API_ID && process.env.VECTORIZER_API_SECRET);
}

function authHeader() {
  const id = process.env.VECTORIZER_API_ID || "";
  const secret = process.env.VECTORIZER_API_SECRET || "";
  return "Basic " + Buffer.from(id + ":" + secret).toString("base64");
}

function multipart(fields, fileField, fileBuf, fileName, mime) {
  const boundary = "----dcpvai" + Date.now().toString(16);
  const chunks = [];
  Object.keys(fields || {}).forEach(function (k) {
    if (fields[k] == null || fields[k] === "") return;
    chunks.push(Buffer.from(
      "--" + boundary + "\r\n" +
      "Content-Disposition: form-data; name=\"" + k + "\"\r\n\r\n" +
      String(fields[k]) + "\r\n"
    ));
  });
  if (fileBuf) {
    chunks.push(Buffer.from(
      "--" + boundary + "\r\n" +
      "Content-Disposition: form-data; name=\"" + fileField + "\"; filename=\"" + (fileName || "art.png") + "\"\r\n" +
      "Content-Type: " + (mime || "image/png") + "\r\n\r\n"
    ));
    chunks.push(Buffer.from(fileBuf));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from("--" + boundary + "--\r\n"));
  return { body: Buffer.concat(chunks), type: "multipart/form-data; boundary=" + boundary };
}

function request(method, urlPath, body, contentType, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const u = new URL("https://api.vectorizer.ai" + urlPath);
    const headers = {
      Authorization: authHeader(),
    };
    if (body) {
      headers["Content-Type"] = contentType;
      headers["Content-Length"] = body.length;
    }
    const req = https.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      method: method,
      headers: headers,
    }, function (res) {
      const chunks = [];
      res.on("data", function (c) { chunks.push(c); });
      res.on("end", function () {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buf: Buffer.concat(chunks),
        });
      });
    });
    req.setTimeout(timeoutMs || 180000, function () {
      req.destroy();
      reject(new Error("Vectorizer.AI timed out"));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function vectorizeImage(buf, opts) {
  opts = opts || {};
  if (!configured()) return Promise.reject(new Error("Vectorizer.AI is not configured"));
  const fields = {
    mode: opts.mode || "production",
    "output.file_format": opts.format || "svg",
    "policy.retention_days": String(opts.retentionDays == null ? 1 : opts.retentionDays),
    "output.svg.adobe_compatibility_mode": "true",
  };
  if (opts.maxColors != null && Number(opts.maxColors) > 0) {
    fields["processing.max_colors"] = String(Math.max(2, Math.min(256, Number(opts.maxColors))));
  }
  const mp = multipart(fields, "image", buf, opts.fileName || "art.png", opts.mime || "image/png");
  return request("POST", "/api/v1/vectorize", mp.body, mp.type, 180000).then(function (res) {
    if (res.status < 200 || res.status >= 300) {
      let msg = "Vectorizer.AI failed";
      try {
        const j = JSON.parse(res.buf.toString("utf8"));
        if (j && j.error && j.error.message) msg = j.error.message;
      } catch (e) {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return {
      buf: res.buf,
      imageToken: res.headers["x-image-token"] || res.headers["X-Image-Token"] || null,
      credits: res.headers["x-credits-charged"] || res.headers["X-Credits-Charged"] || null,
      format: fields["output.file_format"],
    };
  });
}

function downloadFormat(imageToken, format) {
  if (!configured()) return Promise.reject(new Error("Vectorizer.AI is not configured"));
  if (!imageToken) return Promise.reject(new Error("Missing image token"));
  const fields = {
    "image.token": imageToken,
    "output.file_format": format || "eps",
  };
  if (format === "svg") fields["output.svg.adobe_compatibility_mode"] = "true";
  const mp = multipart(fields);
  return request("POST", "/api/v1/download", mp.body, mp.type, 180000).then(function (res) {
    if (res.status < 200 || res.status >= 300) {
      let msg = "Vectorizer.AI download failed";
      try {
        const j = JSON.parse(res.buf.toString("utf8"));
        if (j && j.error && j.error.message) msg = j.error.message;
      } catch (e) {}
      throw new Error(msg);
    }
    return res.buf;
  });
}

module.exports = {
  configured: configured,
  vectorizeImage: vectorizeImage,
  downloadFormat: downloadFormat,
};
