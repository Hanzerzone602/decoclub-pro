"use strict";

// Shared guard for vector preview.png and halftone preview rasters.
// rsvg-convert is CPU-heavy; at most two run at once, extras wait in a short
// FIFO, and a per-user token bucket refuses bursts before they reach the queue.

const PREVIEW_CONCURRENCY = 2;
const PREVIEW_QUEUE_MAX = 20;
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX_BYTES = 50 * 1024 * 1024;

// Burst 4/sec and 60/min. A request needs a token from both buckets.
const BURST_CAPACITY = 4;
const BURST_PER_MS = 4 / 1000;
const MINUTE_CAPACITY = 60;
const MINUTE_PER_MS = 60 / 60000;

// Preview halftones ignore larger client budgets. These match the engine's
// own preview defaults so a normal slider preview is unchanged.
const HT_PREVIEW_MAX_EDGE = 420;
const HT_PREVIEW_MAX_CELLS = 9000;

const buckets = new Map();
const cache = new Map();
let cacheBytes = 0;
let active = 0;
const waiters = [];

function limitError(retryAfter) {
  const err = new Error("Too many preview requests");
  err.status = 429;
  err.retryAfter = retryAfter;
  return err;
}

function busyError() {
  const err = new Error("Preview busy");
  err.status = 503;
  err.retryAfter = 2;
  return err;
}

function refill(tokens, at, now, capacity, perMs) {
  const elapsed = Math.max(0, now - at);
  return { tokens: Math.min(capacity, tokens + elapsed * perMs), at: now };
}

function takePreviewToken(actor, now) {
  now = now || Date.now();
  const key = actor || "ip:unknown";
  let b = buckets.get(key);
  if (!b) {
    b = { burst: BURST_CAPACITY, burstAt: now, minute: MINUTE_CAPACITY, minuteAt: now };
    buckets.set(key, b);
  }
  const burst = refill(b.burst, b.burstAt, now, BURST_CAPACITY, BURST_PER_MS);
  const minute = refill(b.minute, b.minuteAt, now, MINUTE_CAPACITY, MINUTE_PER_MS);
  b.burst = burst.tokens;
  b.burstAt = burst.at;
  b.minute = minute.tokens;
  b.minuteAt = minute.at;
  if (buckets.size > 4000) {
    for (const entry of buckets) {
      if (now - entry[1].burstAt > 120000 && now - entry[1].minuteAt > 120000) buckets.delete(entry[0]);
      if (buckets.size < 2000) break;
    }
  }
  if (b.burst < 1 || b.minute < 1) {
    const burstWait = b.burst >= 1 ? 0 : (1 - b.burst) / BURST_PER_MS;
    const minuteWait = b.minute >= 1 ? 0 : (1 - b.minute) / MINUTE_PER_MS;
    const retryAfter = Math.max(1, Math.ceil(Math.max(burstWait, minuteWait) / 1000));
    return { ok: false, retryAfter: retryAfter };
  }
  b.burst -= 1;
  b.minute -= 1;
  return { ok: true };
}

function cacheGet(key, now) {
  const hit = cache.get(key);
  if (!hit) return null;
  now = now || Date.now();
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    cacheBytes -= hit.bytes;
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.buf;
}

function cacheSet(key, buf) {
  if (!buf || !buf.length || buf.length > CACHE_MAX_BYTES) return;
  const now = Date.now();
  while (cache.size) {
    const oldestKey = cache.keys().next().value;
    const oldest = cache.get(oldestKey);
    if (now - oldest.at <= CACHE_TTL_MS) break;
    cache.delete(oldestKey);
    cacheBytes -= oldest.bytes;
  }
  const prev = cache.get(key);
  if (prev) {
    cache.delete(key);
    cacheBytes -= prev.bytes;
  }
  cache.set(key, { buf: buf, bytes: buf.length, at: now });
  cacheBytes += buf.length;
  while (cacheBytes > CACHE_MAX_BYTES && cache.size) {
    const oldestKey = cache.keys().next().value;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    cacheBytes -= oldest.bytes;
  }
}

function pump() {
  while (active < PREVIEW_CONCURRENCY && waiters.length) {
    const job = waiters.shift();
    active += 1;
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(function () {
        active -= 1;
        pump();
      });
  }
}

function enqueue(task) {
  if (waiters.length >= PREVIEW_QUEUE_MAX) return Promise.reject(busyError());
  return new Promise(function (resolve, reject) {
    waiters.push({ task: task, resolve: resolve, reject: reject });
    pump();
  });
}

/**
 * opts.actor — rate-limit key (already charged when opts.charged is set)
 * opts.key — cache key
 * opts.render — () => Promise<Buffer>
 * opts.charged — token was taken by the caller
 */
async function servePreview(opts) {
  opts = opts || {};
  if (!opts.charged) {
    const ticket = takePreviewToken(opts.actor);
    if (!ticket.ok) throw limitError(ticket.retryAfter);
  }
  const cached = cacheGet(opts.key);
  if (cached) return { png: cached, cache: "hit" };
  return enqueue(async function () {
    const again = cacheGet(opts.key);
    if (again) return { png: again, cache: "hit" };
    const png = await opts.render();
    if (!Buffer.isBuffer(png)) throw new Error("Preview render returned no PNG");
    cacheSet(opts.key, png);
    return { png: png, cache: "miss" };
  });
}

function previewCacheKey(parts) {
  parts = parts || {};
  return JSON.stringify([
    String(parts.jobId || ""),
    String(parts.mtime == null ? "" : parts.mtime),
    String(parts.mode || "fill"),
    parts.watermark ? 1 : 0,
    parts.params || null,
  ]);
}

function clampHalftonePreviewBudget(body) {
  body = body || {};
  let edge = Number(body.maxEdge);
  let cells = Number(body.maxCells);
  if (!Number.isFinite(edge) || edge <= 0) edge = HT_PREVIEW_MAX_EDGE;
  else edge = Math.min(edge, HT_PREVIEW_MAX_EDGE);
  if (!Number.isFinite(cells) || cells <= 0) cells = HT_PREVIEW_MAX_CELLS;
  else cells = Math.min(cells, HT_PREVIEW_MAX_CELLS);
  return { maxEdge: edge, maxCells: cells };
}

/** Full-view raster used for unpaid halftone previews. No client size control. */
function halftonePreviewRasterSpec(watermark) {
  return { x: 0, y: 0, w: 1, h: 1, mode: "fill", watermark: !!watermark };
}

module.exports = {
  PREVIEW_CONCURRENCY: PREVIEW_CONCURRENCY,
  PREVIEW_QUEUE_MAX: PREVIEW_QUEUE_MAX,
  CACHE_TTL_MS: CACHE_TTL_MS,
  CACHE_MAX_BYTES: CACHE_MAX_BYTES,
  HT_PREVIEW_MAX_EDGE: HT_PREVIEW_MAX_EDGE,
  HT_PREVIEW_MAX_CELLS: HT_PREVIEW_MAX_CELLS,
  takePreviewToken: takePreviewToken,
  servePreview: servePreview,
  previewCacheKey: previewCacheKey,
  clampHalftonePreviewBudget: clampHalftonePreviewBudget,
  halftonePreviewRasterSpec: halftonePreviewRasterSpec,
};
