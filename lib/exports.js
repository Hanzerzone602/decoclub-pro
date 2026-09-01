"use strict";

const fs = require("fs");
const path = require("path");
const { contourFromPngBuffer, svgFromContour, boundsPath } = require("./contour");

const SHEET_W_IN = 22;
const GAP_IN = 0.125;
const OFFSET_MM = 1.5;

function loadArtworkBuffer(job, uploadsDir) {
  if (!job.file_path) return null;
  const abs = path.join(uploadsDir, path.basename(job.file_path));
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs);
}

function jobContour(job, uploadsDir, dilatePx) {
  const buf = loadArtworkBuffer(job, uploadsDir);
  const w = Number(job.width_in) || 1;
  const h = Number(job.height_in) || 1;
  if (buf) {
    try {
      return contourFromPngBuffer(buf, w, h, { dilatePx: dilatePx || 0, epsilon: 1.2 });
    } catch (e) {
      /* fall through for jpeg/svg */
    }
  }
  return { d: boundsPath(w, h), widthIn: w, heightIn: h, pointCount: 4, pixelWidth: 0, pixelHeight: 0 };
}

function cutContourSvg(job, uploadsDir) {
  const c = jobContour(job, uploadsDir, 0);
  return svgFromContour(c, {
    stroke: "#e106d7",
    fill: "none",
    strokeWidth: 0.015,
    inner: `<!-- DecoClub Pro cut contour · job ${job.id} · ${job.method} -->`,
  });
}

function laserSvg(job, uploadsDir) {
  const c = jobContour(job, uploadsDir, 0);
  const artNote = job.file_path ? `<image href="${job.file_path}" x="0" y="0" width="${c.widthIn}" height="${c.heightIn}" preserveAspectRatio="none" opacity="0.35"/>` : "";
  return svgFromContour(c, {
    stroke: "#111",
    fill: "none",
    strokeWidth: 0.02,
    inner: artNote + `<text x="0.08" y="0.22" font-size="0.18" font-family="sans-serif" fill="#444">LASER ${job.id.slice(0, 8)} · ${c.widthIn}×${c.heightIn}in</text>`,
  });
}

function pathToHpgl(d, widthIn, heightIn) {
  const unit = 1016;
  const cmds = ["IN;", "SP1;"];
  const nums = [];
  const re = /([MLZmlz])|(-?\d+\.?\d*)/g;
  let m;
  let mode = "M";
  const pts = [];
  let cur = { x: 0, y: 0 };
  const tokens = d.match(/[MLZmlz]|-?\d+\.?\d*/g) || [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/[MLZmlz]/.test(t)) {
      mode = t.toUpperCase();
      if (mode === "Z" && pts.length) {
        pts.push({ x: pts[0].x, y: pts[0].y, pen: false });
      }
      continue;
    }
    const x = Number(t);
    const y = Number(tokens[++i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    cur = { x, y };
    pts.push({ x, y, pen: mode === "L" });
  }
  let down = false;
  pts.forEach((p, idx) => {
    const X = Math.round(p.x * unit);
    const Y = Math.round((heightIn - p.y) * unit);
    if (idx === 0 || !p.pen) {
      cmds.push("PU" + X + "," + Y + ";");
      down = false;
    } else {
      if (!down) cmds.push("PD;");
      cmds.push("PD" + X + "," + Y + ";");
      down = true;
    }
  });
  cmds.push("PU;");
  cmds.push("SP0;");
  return cmds.join("\n") + "\n";
}

function laserPlt(job, uploadsDir) {
  const c = jobContour(job, uploadsDir, 0);
  return pathToHpgl(c.d, c.widthIn, c.heightIn);
}

function gangLayout(job) {
  const artW = Math.max(0.25, Number(job.width_in) || 1);
  const artH = Math.max(0.25, Number(job.height_in) || 1);
  const qty = Math.max(1, Number(job.qty) || 1);
  const cols = Math.max(1, Math.floor((SHEET_W_IN + GAP_IN) / (artW + GAP_IN)));
  const rows = Math.ceil(qty / cols);
  const header = 0.45;
  const sheetH = header + GAP_IN + rows * artH + (rows - 1) * GAP_IN + GAP_IN;
  return { artW, artH, qty, cols, rows, header, sheetH, sheetW: SHEET_W_IN, gap: GAP_IN };
}

function gangSheetSvg(job) {
  const L = gangLayout(job);
  const cells = [];
  for (let i = 0; i < L.qty; i++) {
    const r = Math.floor(i / L.cols);
    const c = i % L.cols;
    const x = GAP_IN + c * (L.artW + GAP_IN);
    const y = L.header + GAP_IN + r * (L.artH + GAP_IN);
    const img = job.file_path
      ? `<image href="${job.file_path}" x="${x}" y="${y}" width="${L.artW}" height="${L.artH}" preserveAspectRatio="xMidYMid meet"/>`
      : `<rect x="${x}" y="${y}" width="${L.artW}" height="${L.artH}" fill="#222" stroke="#888" stroke-width="0.02"/>`;
    cells.push(`${img}<rect x="${x}" y="${y}" width="${L.artW}" height="${L.artH}" fill="none" stroke="#c56a2e" stroke-width="0.015"/><text x="${x + 0.04}" y="${y + L.artH - 0.06}" font-size="0.12" fill="#d4783c" font-family="sans-serif">${i + 1}</text>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${L.sheetW}in" height="${L.sheetH}in" viewBox="0 0 ${L.sheetW} ${L.sheetH}">
  <rect width="${L.sheetW}" height="${L.sheetH}" fill="#0e1014"/>
  <text x="0.2" y="0.32" font-size="0.22" fill="#f0c090" font-family="sans-serif">DecoClub Pro gang · job ${job.id.slice(0, 10)} · qty ${L.qty} · ${job.method} · 22in sheet · 0.125in gap</text>
  ${cells.join("\n  ")}
</svg>`;
}

function stickerCutlineSvg(job, uploadsDir) {
  const offsetIn = OFFSET_MM / 25.4;
  const w = Number(job.width_in) || 1;
  const h = Number(job.height_in) || 1;
  const buf = loadArtworkBuffer(job, uploadsDir);
  let c = null;
  if (buf) {
    try {
      const img = require("./png").decodePng(buf);
      const dilatePx = Math.max(1, Math.round((offsetIn / w) * img.width));
      c = contourFromPngBuffer(buf, w, h, { dilatePx, epsilon: 1.1 });
    } catch (e) {
      c = null;
    }
  }
  const pad = offsetIn;
  const ow = w + pad * 2;
  const oh = h + pad * 2;
  const art = job.file_path
    ? '<image href="' + job.file_path + '" x="0" y="0" width="' + w + '" height="' + h + '" preserveAspectRatio="xMidYMid meet"/>'
    : "";
  const cut = c && c.d ? c.d : ("M 0 0 L " + w + " 0 L " + w + " " + h + " L 0 " + h + " Z");
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + ow + 'in" height="' + oh + 'in" viewBox="' + (-pad) + " " + (-pad) + " " + ow + " " + oh + '">\n' +
    "  <!-- sticker cutline offset " + OFFSET_MM + "mm outside traced art -->\n" +
    "  " + art + "\n" +
    '  <path d="' + cut + '" fill="none" stroke="#e106d7" stroke-width="0.02"/>\n' +
    "</svg>";
}

function packetJson(job, files) {
  return {
    product: "DecoClub Pro",
    exportedAt: new Date().toISOString(),
    job: {
      id: job.id,
      title: job.title,
      method: job.method,
      size_in: { width: Number(job.width_in), height: Number(job.height_in) },
      qty: Number(job.qty),
      unit_price: Number(job.unit_price),
      total: Number(job.total),
      status: job.status,
      artwork: job.file_path || null,
    },
    assets: files,
    notes: job.notes || "",
  };
}

function writeExports(job, uploadsDir, exportDir) {
  fs.mkdirSync(exportDir, { recursive: true });
  const files = {
    packet_json: "packet.json",
    cut_contour_svg: "cut-contour.svg",
    laser_svg: "laser.svg",
    laser_plt: "laser.plt",
    gang_sheet_svg: "gang-sheet.svg",
    sticker_cutline_svg: "sticker-cutline.svg",
  };
  const contents = {
    "cut-contour.svg": cutContourSvg(job, uploadsDir),
    "laser.svg": laserSvg(job, uploadsDir),
    "laser.plt": laserPlt(job, uploadsDir),
    "gang-sheet.svg": gangSheetSvg(job),
    "sticker-cutline.svg": stickerCutlineSvg(job, uploadsDir),
  };
  Object.keys(contents).forEach((name) => {
    fs.writeFileSync(path.join(exportDir, name), contents[name]);
  });
  const packet = packetJson(job, files);
  fs.writeFileSync(path.join(exportDir, "packet.json"), JSON.stringify(packet, null, 2));
  return { files, packet, contents };
}

module.exports = {
  SHEET_W_IN,
  GAP_IN,
  cutContourSvg,
  laserSvg,
  laserPlt,
  gangSheetSvg,
  gangLayout,
  stickerCutlineSvg,
  packetJson,
  writeExports,
  jobContour,
};
