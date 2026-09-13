"use strict";

const { UNIT_PER_IN } = require("./geom");
const { encodePng } = require("../png");

const PREVIEW_CAP = 60000;

function stitchPreviewSvg(stitches, widthIn, heightIn, colorStops) {
  const w = Number(widthIn) || 1;
  const h = Number(heightIn) || 1;
  const groups = [];
  let d = "";
  let color = (colorStops && colorStops[0] && colorStops[0].hex) || "#017ece";
  let ci = 0;
  function flush() {
    if (!d) return;
    groups.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="0.018" stroke-linecap="round" stroke-linejoin="round"/>');
    d = "";
  }
  (stitches || []).forEach((s) => {
    if (s.kind === "color") {
      flush();
      ci++;
      color = (colorStops && colorStops[ci] && colorStops[ci].hex) || color;
      return;
    }
    if (s.kind === "trim" || s.kind === "end") return;
    const x = s.x / UNIT_PER_IN;
    const y = s.y / UNIT_PER_IN;
    if (s.kind === "jump" || !d) d += (d ? " M " : "M ") + x.toFixed(3) + " " + y.toFixed(3);
    else d += " L " + x.toFixed(3) + " " + y.toFixed(3);
  });
  flush();
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
    "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + w + "in\" height=\"" + h + "in\" viewBox=\"0 0 " + w + " " + h + "\">\n" +
    "  <rect width=\"" + w + "\" height=\"" + h + "\" fill=\"#d8c7a8\"/>\n  " +
    groups.join("\n  ") + "\n</svg>\n";
}

function previewPayload(pattern) {
  const stitches = pattern.stitches || [];
  const threads = pattern.threads || [];
  let colorIndex = 0;
  const packed = [];
  let skipped = 0;
  const stride = stitches.length > PREVIEW_CAP ? Math.ceil(stitches.length / PREVIEW_CAP) : 1;
  stitches.forEach((s, i) => {
    if (s.kind === "color") { colorIndex++; return; }
    if (s.kind === "end") return;
    if (stride > 1 && s.kind === "stitch" && i % stride !== 0) { skipped++; return; }
    packed.push({
      x: s.x,
      y: s.y,
      cmd: s.kind === "jump" ? "jump" : (s.kind === "trim" ? "trim" : "stitch"),
      colorIndex: colorIndex,
    });
  });
  return {
    widthMm: pattern.widthMm || (pattern.widthIn || 1) * 25.4,
    heightMm: pattern.heightMm || (pattern.heightIn || 1) * 25.4,
    widthIn: pattern.widthIn,
    heightIn: pattern.heightIn,
    stitchCount: pattern.stitchCount,
    lod: stride > 1,
    threads: threads.map((t) => ({ hex: t.hex, code: t.code, name: t.name, brand: t.brand })),
    stitches: packed,
    objects: pattern.objects || [],
  };
}

function hexRgb(hex) {
  const h = String(hex || "#1e4482").replace("#", "");
  if (h.length !== 6) return [30, 68, 130];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function stampDisk(rgba, w, h, cx, cy, r, rgb, a) {
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
  const aa = a == null ? 1 : a;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > r) continue;
      const cov = Math.min(1, (r - d) * 1.4) * aa;
      const i = (y * w + x) * 4;
      rgba[i] = Math.round(rgba[i] * (1 - cov) + rgb[0] * cov);
      rgba[i + 1] = Math.round(rgba[i + 1] * (1 - cov) + rgb[1] * cov);
      rgba[i + 2] = Math.round(rgba[i + 2] * (1 - cov) + rgb[2] * cov);
    }
  }
}

function drawSeg(rgba, w, h, x0, y0, x1, y1, rgb, radius) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 0.2) {
    stampDisk(rgba, w, h, x1, y1, radius, rgb, 1);
    return;
  }
  const tx = dx / len, ty = dy / len;
  const nx = -ty, ny = tx;
  const n = Math.max(1, Math.ceil(len * 1.25));
  const lum = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const lx = -0.42, ly = -0.72, lz = 0.56;
  const along = tx * lx + ty * ly;
  const aniso = Math.pow(Math.max(0, 1 - Math.abs(along)), 3.2);
  const R = Math.max(1.2, radius);
  const across = Math.max(2, Math.ceil(R * 2.2));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + dx * t, y = y0 + dy * t;
    for (let k = -across; k <= across; k++) {
      const u = k / (R * 1.15);
      if (u * u >= 1.02) continue;
      const z = Math.sqrt(Math.max(0, 1 - u * u));
      const px = x + nx * k * 0.92;
      const py = y + ny * k * 0.92;
      const ndl = Math.max(0, u * (nx * lx + ny * ly) + z * lz);
      const ridge = Math.pow(z, 5) * (0.55 + aniso * 0.7);
      const shade = 0.16 + 0.84 * ndl;
      const spec = ridge * (lum > 200 ? 0.55 : 0.85);
      const cr = Math.min(255, rgb[0] * shade + (255 - rgb[0] * 0.15) * spec);
      const cg = Math.min(255, rgb[1] * shade + (250 - rgb[1] * 0.15) * spec * 0.92);
      const cb = Math.min(255, rgb[2] * shade + (235 - rgb[2] * 0.12) * spec * 0.78);
      const cov = Math.min(1, (1 - Math.abs(u)) * 1.7) * 0.96;
      const xi = Math.round(px), yi = Math.round(py);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) continue;
      const idx = (yi * w + xi) * 4;
      rgba[idx] = Math.round(rgba[idx] * (1 - cov) + cr * cov);
      rgba[idx + 1] = Math.round(rgba[idx + 1] * (1 - cov) + cg * cov);
      rgba[idx + 2] = Math.round(rgba[idx + 2] * (1 - cov) + cb * cov);
    }
  }
}

function paintFabric(rgba, w, h, ox, oy, fw, fh, iso) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inHoop = x >= ox && x < ox + fw && y >= oy && y < oy + fh;
      if (!inHoop) {
        rgba[i] = 18; rgba[i + 1] = 22; rgba[i + 2] = 30; rgba[i + 3] = 255;
        continue;
      }
      const u = (x - ox) / fw, v = (y - oy) / fh;
      const twill = ((Math.floor(u * 118 + v * 36) + Math.floor(v * 118)) % 5) === 0 ? 1 : 0;
      const knit = Math.sin(u * 70) * Math.sin(v * 90) * 4;
      const light = 1 - Math.hypot(u - 0.38, v - 0.28) * 0.18;
      const shade = (186 + knit - twill * 7 + ((x * 3 + y) % 2)) * light;
      rgba[i] = shade;
      rgba[i + 1] = shade - 16;
      rgba[i + 2] = shade - 38;
      rgba[i + 3] = 255;
    }
  }
  // hoop ring
  const cx = ox + fw / 2, cy = oy + fh / 2;
  const rx = fw / 2 + 10, ry = fh / 2 + 10;
  for (let a = 0; a < 360; a++) {
    const rad = a * Math.PI / 180;
    stampDisk(rgba, w, h, cx + Math.cos(rad) * rx, cy + Math.sin(rad) * ry, 2.2, [42, 48, 58], 0.9);
  }
}

function renderTrueviewPng(patternOrPreview, opts) {
  opts = opts || {};
  const src = patternOrPreview && patternOrPreview.widthMm
    ? patternOrPreview
    : previewPayload(patternOrPreview || { stitches: [], threads: [], widthIn: 1, heightIn: 1, stitchCount: 0 });
  const widthMm = src.widthMm || 25.4;
  const heightMm = src.heightMm || 25.4;
  const px = opts.size || 900;
  const pad = 36;
  const iso = !!opts.iso;
  const playT = opts.playT == null ? 1 : Math.max(0, Math.min(1, Number(opts.playT)));
  const scale = Math.min((px - pad * 2) / widthMm, (px - pad * 2) / heightMm);
  const fw = widthMm * scale, fh = heightMm * scale;
  const W = px, H = Math.max(px, Math.round(fh + pad * 2 + (iso ? 40 : 0)));
  const ox = (W - fw) / 2, oy = (H - fh) / 2;
  const rgba = Buffer.alloc(W * H * 4);
  paintFabric(rgba, W, H, ox, oy, fw, fh, iso);
  const threads = src.threads || [{ hex: "#1e4482" }];
  const stitches = src.stitches || [];
  const until = Math.max(1, Math.floor(stitches.length * playT));
  let last = null, colorIndex = 0;
  const radius = Math.max(1.55, scale * 0.38);
  function mapPt(xmm, ymm) {
    let x = ox + xmm * scale;
    let y = oy + ymm * scale;
    if (iso) {
      x = x + (y - oy) * 0.16;
      y = oy + (y - oy) * 0.78 - (x - ox) * 0.04;
    }
    return { x: x, y: y };
  }
  for (let i = 0; i < until; i++) {
    const s = stitches[i];
    if (!s) continue;
    const cmd = s.cmd || s.kind;
    if (cmd === "color") { colorIndex = s.colorIndex != null ? s.colorIndex : colorIndex + 1; last = null; continue; }
    const p = mapPt(s.x * 0.1, s.y * 0.1);
    if (cmd === "jump" || cmd === "trim") { last = p; continue; }
    if (last) {
      const th = threads[s.colorIndex != null ? s.colorIndex : colorIndex] || threads[0];
      drawSeg(rgba, W, H, last.x, last.y, p.x, p.y, hexRgb(th && th.hex), radius);
    }
    last = p;
  }
  if (playT < 0.999 && last) {
    stampDisk(rgba, W, H, last.x, last.y, 4.5, [240, 240, 240], 0.95);
    stampDisk(rgba, W, H, last.x, last.y, 2.0, [180, 40, 40], 1);
  }
  return encodePng(W, H, rgba);
}

module.exports = { stitchPreviewSvg, previewPayload, PREVIEW_CAP, renderTrueviewPng };
