"use strict";

const fs = require("fs");
const path = require("path");
const { encodePng, makeRgba, decodePng } = require("./png");

function methodFamily(method) {
  if (method === "hat") return "hat";
  if (method === "uvdtf") return "tumbler";
  if (method === "laser") return "plaque";
  if (method === "sticker") return "sticker";
  return "tee";
}

function sample(rgba, w, h, x, y) {
  if (x < 0 || y < 0 || x >= w || y >= h) return [0, 0, 0, 0];
  const i = (y * w + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

function blend(dst, i, r, g, b, a) {
  const da = dst[i + 3] / 255;
  const sa = a / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) return;
  dst[i] = Math.round((r * sa + dst[i] * da * (1 - sa)) / outA);
  dst[i + 1] = Math.round((g * sa + dst[i + 1] * da * (1 - sa)) / outA);
  dst[i + 2] = Math.round((b * sa + dst[i + 2] * da * (1 - sa)) / outA);
  dst[i + 3] = Math.round(outA * 255);
}

function noiseAt(x, y, seed) {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed) * 43758.5453;
  return n - Math.floor(n);
}

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const hit = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-6) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function ellipse(cx, cy, rx, ry, x, y) {
  const dx = (x - cx) / rx, dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function shade(base, n) {
  return [
    Math.max(0, Math.min(255, base[0] + n)),
    Math.max(0, Math.min(255, base[1] + n)),
    Math.max(0, Math.min(255, base[2] + n)),
  ];
}

function placeArt(dst, dw, dh, art, box) {
  if (!art) return;
  const { width: aw, height: ah, rgba } = art;
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const sx = Math.floor((x / box.w) * aw);
      const sy = Math.floor((y / box.h) * ah);
      const [r, g, b, a] = sample(rgba, aw, ah, sx, sy);
      if (a < 8) continue;
      const dx = box.x + x;
      const dy = box.y + y;
      if (dx < 0 || dy < 0 || dx >= dw || dy >= dh) continue;
      blend(dst, (dy * dw + dx) * 4, r, g, b, Math.round(a * (box.alpha == null ? 1 : box.alpha)));
    }
  }
}

function renderBlank(kind, w, h, art) {
  const rgba = makeRgba(w, h, [18, 19, 22, 255]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const g = 16 + Math.floor(noiseAt(x, y, 3) * 10) + Math.floor((y / h) * 8);
      const i = (y * w + x) * 4;
      rgba[i] = g;
      rgba[i + 1] = g + 1;
      rgba[i + 2] = g + 3;
      rgba[i + 3] = 255;
    }
  }

  if (kind === "tee") {
    const poly = [
      [w * 0.34, h * 0.16], [w * 0.42, h * 0.22], [w * 0.58, h * 0.22], [w * 0.66, h * 0.16],
      [w * 0.92, h * 0.32], [w * 0.82, h * 0.40], [w * 0.74, h * 0.34], [w * 0.74, h * 0.88],
      [w * 0.26, h * 0.88], [w * 0.26, h * 0.34], [w * 0.18, h * 0.40], [w * 0.08, h * 0.32],
    ];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inPoly(x, y, poly)) continue;
        const fold = Math.sin(x / 18) * 6 + Math.sin(y / 40) * 8;
        const light = ((x - w * 0.5) / w) * -18 + ((y - h * 0.3) / h) * -12 + fold;
        const n = (noiseAt(x, y, 9) - 0.5) * 14 + light;
        const c = shade([52, 56, 62], n);
        const i = (y * w + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
      }
    }
    placeArt(rgba, w, h, art, { x: Math.round(w * 0.34), y: Math.round(h * 0.30), w: Math.round(w * 0.32), h: Math.round(h * 0.28) });
  } else if (kind === "hat") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const crown = ellipse(w * 0.5, h * 0.42, w * 0.28, h * 0.22, x, y) && y < h * 0.52;
        const bill = ellipse(w * 0.5, h * 0.58, w * 0.38, h * 0.08, x, y) && y > h * 0.50;
        if (!crown && !bill) continue;
        const n = (noiseAt(x, y, 2) - 0.5) * 16 + (bill ? -22 : 6) + ((x - w * 0.5) / w) * -10;
        const c = shade(bill ? [28, 30, 34] : [38, 72, 86], n);
        const i = (y * w + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
      }
    }
    placeArt(rgba, w, h, art, { x: Math.round(w * 0.38), y: Math.round(h * 0.30), w: Math.round(w * 0.24), h: Math.round(h * 0.16) });
  } else if (kind === "tumbler") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const body = x > w * 0.32 && x < w * 0.68 && y > h * 0.18 && y < h * 0.86;
        const top = ellipse(w * 0.5, h * 0.18, w * 0.18, h * 0.05, x, y);
        const bot = ellipse(w * 0.5, h * 0.86, w * 0.18, h * 0.05, x, y);
        if (!body && !top && !bot) continue;
        const nx = (x - w * 0.32) / (w * 0.36);
        const spec = Math.pow(Math.max(0, 1 - Math.abs(nx - 0.28) * 4), 8) * 90;
        const n = (noiseAt(x, y, 4) - 0.5) * 8 + spec + (top ? 20 : 0);
        const c = shade([186, 190, 196], n);
        const i = (y * w + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
      }
    }
    placeArt(rgba, w, h, art, { x: Math.round(w * 0.36), y: Math.round(h * 0.32), w: Math.round(w * 0.28), h: Math.round(h * 0.38), alpha: 0.92 });
  } else if (kind === "plaque") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x > w * 0.16 && x < w * 0.84 && y > h * 0.28 && y < h * 0.72;
        if (!px) continue;
        const grain = Math.sin(y / 7 + noiseAt(x, 0, 1) * 4) * 10;
        const n = (noiseAt(x * 0.4, y, 6) - 0.5) * 18 + grain;
        const c = shade([92, 54, 28], n);
        const i = (y * w + x) * 4;
        rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2];
      }
    }
    placeArt(rgba, w, h, art, { x: Math.round(w * 0.28), y: Math.round(h * 0.36), w: Math.round(w * 0.44), h: Math.round(h * 0.22) });
  } else if (kind === "sticker") {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sheet = x > w * 0.18 && x < w * 0.82 && y > h * 0.18 && y < h * 0.82;
        if (!sheet) continue;
        const grid = ((Math.floor(x / 18) + Math.floor(y / 18)) % 2) ? 236 : 228;
        const i = (y * w + x) * 4;
        rgba[i] = grid; rgba[i + 1] = grid - 2; rgba[i + 2] = grid - 6;
      }
    }
    placeArt(rgba, w, h, art, { x: Math.round(w * 0.28), y: Math.round(h * 0.28), w: Math.round(w * 0.44), h: Math.round(h * 0.44) });
  }

  for (let x = Math.round(w * 0.25); x < w * 0.75; x++) {
    for (let y = Math.round(h * 0.88); y < h * 0.93; y++) {
      const dx = (x - w * 0.5) / (w * 0.25);
      const a = Math.max(0, 1 - dx * dx) * 70;
      blend(rgba, (y * w + x) * 4, 0, 0, 0, a);
    }
  }
  return rgba;
}

function loadArt(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  try {
    return decodePng(buf);
  } catch (e) {
    return null;
  }
}

function generateMockupPng(job, artworkAbs) {
  const kind = methodFamily(job.method);
  const w = 720, h = 840;
  const art = loadArt(artworkAbs);
  const rgba = renderBlank(kind, w, h, art);
  return encodePng(w, h, rgba);
}

function generateMockupSvg(job, artworkRel) {
  const kind = methodFamily(job.method);
  const href = artworkRel || "";
  const art = href
    ? `<image href="${href}" x="0" y="0" width="100" height="70" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  let scene = "";
  if (kind === "hat") {
    scene = `
      <ellipse cx="400" cy="430" rx="210" ry="70" fill="#0a0b0d" opacity=".55"/>
      <ellipse cx="400" cy="360" rx="190" ry="40" fill="#1b1e24"/>
      <path d="M210 340c20-120 360-120 380 0-40 80-340 80-380 0z" fill="#2a5a68"/>
      <path d="M210 340c20-120 360-120 380 0v20c-40 70-340 70-380 0z" fill="#1e4450"/>
      <ellipse cx="400" cy="430" rx="240" ry="36" fill="#14161b"/>
      <g transform="translate(330 270) scale(1.4)">${art}</g>`;
  } else if (kind === "tumbler") {
    scene = `
      <ellipse cx="400" cy="760" rx="90" ry="24" fill="#000" opacity=".45"/>
      <rect x="310" y="170" width="180" height="560" rx="20" fill="#c5c9d0"/>
      <ellipse cx="400" cy="170" rx="90" ry="28" fill="#dfe3ea"/>
      <ellipse cx="400" cy="730" rx="90" ry="24" fill="#9aa0aa"/>
      <rect x="330" y="170" width="22" height="560" fill="#fff" opacity=".18"/>
      <g transform="translate(340 300)">${art}</g>`;
  } else if (kind === "plaque") {
    scene = `
      <rect x="140" y="250" width="520" height="300" rx="8" fill="#5a3418"/>
      <rect x="152" y="262" width="496" height="276" rx="4" fill="#7a4a22"/>
      <g transform="translate(250 330) scale(3 2.2)">${art.replace('width="100" height="70"', 'width="100" height="70"')}</g>`;
  } else if (kind === "sticker") {
    scene = `
      <rect x="160" y="180" width="480" height="500" fill="#e8e2d4"/>
      <g fill="none" stroke="#d4ccb8" stroke-width="1">
        ${Array.from({ length: 18 }, (_, i) => `<path d="M160 ${180 + i * 28}h480"/>`).join("")}
      </g>
      <g transform="translate(260 300) scale(2.8)">${art}</g>`;
  } else {
    scene = `
      <ellipse cx="400" cy="790" rx="220" ry="28" fill="#000" opacity=".4"/>
      <path d="M250 180l70 50h160l70-50 110 130-70 70v340H210V380l-70-70z" fill="#3a3f48"/>
      <path d="M270 210l55 40h150l55-40 80 100-50 55v320H240V365z" fill="#4a505a"/>
      <path d="M320 195c20 28 140 28 160 0" fill="none" stroke="#2a2e36" stroke-width="10"/>
      <g transform="translate(300 280) scale(2)">${art}</g>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 800 900" width="800" height="900">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#16181e"/>
      <stop offset="1" stop-color="#0c0d10"/>
    </linearGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" result="n"/>
      <feColorMatrix values="0 0 0 0 0.08  0 0 0 0 0.07  0 0 0 0 0.06  0 0 0 0.25 0"/>
    </filter>
  </defs>
  <rect width="800" height="900" fill="url(#bg)"/>
  <rect width="800" height="900" filter="url(#grain)" opacity=".35"/>
  ${scene}
</svg>`;
}

function writeMockups(job, uploadsDir, publicArtPath) {
  const absArt = publicArtPath && publicArtPath.indexOf("/uploads/") === 0
    ? path.join(uploadsDir, path.basename(publicArtPath))
    : null;
  const pngName = "mockup-" + job.id.slice(0, 12) + ".png";
  const svgName = "mockup-" + job.id.slice(0, 12) + ".svg";
  fs.writeFileSync(path.join(uploadsDir, pngName), generateMockupPng(job, absArt));
  fs.writeFileSync(path.join(uploadsDir, svgName), generateMockupSvg(job, publicArtPath || ""));
  return { mockup_path: "/uploads/" + pngName, mockup_svg: "/uploads/" + svgName };
}

module.exports = { methodFamily, generateMockupPng, generateMockupSvg, writeMockups };
