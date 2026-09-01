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


function cutterMarksSvg(job, uploadsDir) {
  const w = Number(job.width_in) || 1;
  const h = Number(job.height_in) || 1;
  const m = 0.25;
  const W = w + m * 2;
  const H = h + m * 2;
  const c = jobContour(job, uploadsDir, 0);
  const path = c && c.d ? c.d : ("M 0 0 L " + w + " 0 L " + w + " " + h + " L 0 " + h + " Z");
  const ticks = [];
  const mark = (x1, y1, x2, y2) => ticks.push('<line x1="'+x1+'" y1="'+y1+'" x2="'+x2+'" y2="'+y2+'" stroke="#111" stroke-width="0.02"/>');
  mark(-m, 0, -0.04, 0); mark(-m, h, -0.04, h); mark(w+0.04, 0, w+m, 0); mark(w+0.04, h, w+m, h);
  mark(0, -m, 0, -0.04); mark(w, -m, w, -0.04); mark(0, h+0.04, 0, h+m); mark(w, h+0.04, w, h+m);
  return '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'in" height="'+H+'in" viewBox="'+(-m)+' '+(-m)+' '+W+' '+H+'">\n  <!-- DecoClub Pro cutter marks -->\n  <rect x="0" y="0" width="'+w+'" height="'+h+'" fill="none" stroke="#999" stroke-width="0.01" stroke-dasharray="0.08 0.06"/>\n  <path d="'+path+'" fill="none" stroke="#e106d7" stroke-width="0.015"/>\n  '+ticks.join("\n  ")+'\n</svg>';
}

function jobTicketSvg(job, shop) {
  const shopName = (shop && shop.name) || "DecoClub Pro shop";
  const lines = (job.line_items || []).map((it, i) =>
    '<text x="36" y="'+(260+i*22)+'" font-size="14" fill="#1a1a1a">'+(i+1)+'. '+(it.desc||it.method)+' · '+(it.method)+' · '+it.width_in+'x'+it.height_in+'in · qty '+it.qty+' · $'+Number(it.total||0).toFixed(2)+'</text>'
  ).join("\n  ");
  return '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="8.5in" height="11in" viewBox="0 0 612 792">\n  <rect width="612" height="792" fill="#f7f3ea"/>\n  <rect width="612" height="64" fill="#1a1612"/>\n  <text x="28" y="40" fill="#e8d5b0" font-size="22" font-family="sans-serif">DECOCLUB PRO  ·  JOB TICKET</text>\n  <text x="28" y="100" font-size="13" fill="#6a6158">'+shopName+'</text>\n  <text x="28" y="140" font-size="28" font-family="sans-serif" fill="#111">'+(job.title||"Untitled")+'</text>\n  <text x="28" y="168" font-size="14" fill="#333">'+String(job.id||"").slice(0,12)+'  ·  '+(job.method||"")+'  ·  status '+(job.status||"")+'</text>\n  <text x="28" y="196" font-size="14" fill="#333">'+(job.width_in||0)+' × '+(job.height_in||0)+' in  ·  qty '+(job.qty||1)+'  ·  due '+(job.due_at||"n/a")+'</text>\n  <text x="28" y="224" font-size="14" fill="#333">Total $'+Number(job.total||0).toFixed(2)+'  ·  margin '+(job.margin_pct||0)+'%</text>\n  '+lines+'\n  <text x="28" y="520" font-size="12" fill="#444">Notes: '+(job.notes||"")+'</text>\n  <text x="28" y="560" font-size="12" fill="#444">Art: '+(job.art_notes||"")+'</text>\n  <text x="28" y="620" font-size="12" fill="#444">Embroidery / rhinestone / UV: follow method notes on the job. Machine files in packet.</text>\n  <rect x="28" y="680" width="160" height="70" fill="none" stroke="#111"/>\n  <text x="36" y="710" font-size="11">PRESS / LASER</text>\n  <rect x="210" y="680" width="160" height="70" fill="none" stroke="#111"/>\n  <text x="218" y="710" font-size="11">QC</text>\n  <rect x="392" y="680" width="180" height="70" fill="none" stroke="#111"/>\n  <text x="400" y="710" font-size="11">PACK / DELIVER</text>\n</svg>';
}

function methodNotes(job) {
  const m = job.method;
  if (m === "embroidery") return "Hoop art, run stitch estimate from size. Export contour as placement guide. No DST without a stitch engine.";
  if (m === "rhinestone") return "Hotfix pattern from cut contour. Weed extra stone positions. No vendor stone library attached.";
  if (m === "uv" || m === "uvdtf") return "Print UV/UV-DTF, gang if qty > 1, laminate if required. Contour for kiss-cut.";
  if (m === "sublimation") return "Mirror art, 400F press typical. Tumbler wrap mockup is placement only.";
  if (m === "vinyl") return "Cut contour, weeding box, transfer tape. Watch mirrored heat-transfer.";
  if (m === "sign") return "Contour + cutter marks. Substrate notes in job.";
  if (m === "laser") return "SVG path + HPGL PLT. Power/speed not invented — set on the machine.";
  if (m === "dtf") return "22in gang sheet, 0.125in gap. Powder and cure per film.";
  return "Follow packet files for this method.";
}

function intakePosterSvg(job, origin, shop) {
  const url = origin + "/proof.html?t=" + job.proof_token;
  const shopName = (shop && shop.name) || "DecoClub Pro";
  return '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="8.5in" height="11in" viewBox="0 0 612 792">\n  <rect width="612" height="792" fill="#12110e"/>\n  <rect x="36" y="36" width="540" height="720" fill="none" stroke="#c9b896" stroke-width="2"/>\n  <text x="306" y="90" text-anchor="middle" fill="#c9b896" font-size="14" letter-spacing="4">DECOCLUB PRO  ·  BOOTH INTAKE</text>\n  <text x="306" y="160" text-anchor="middle" fill="#f3ece2" font-size="28" font-family="sans-serif">'+shopName+'</text>\n  <text x="306" y="210" text-anchor="middle" fill="#e8d5b0" font-size="20">'+(job.title||"Job")+'</text>\n  <rect x="86" y="250" width="440" height="220" fill="#1c1a16" stroke="#3a342c"/>\n  <text x="306" y="300" text-anchor="middle" fill="#9c9488" font-size="13">Open this proof on a phone</text>\n  <foreignObject x="100" y="320" width="412" height="120"><div xmlns="http://www.w3.org/1999/xhtml" style="color:#f3ece2;font:16px sans-serif;word-break:break-all;text-align:center">'+url+'</div></foreignObject>\n  <text x="306" y="540" text-anchor="middle" fill="#c9b896" font-size="14">Client proof + approve  ·  unguessable token</text>\n  <text x="306" y="620" text-anchor="middle" fill="#9c9488" font-size="13">Show this sheet at the booth. Staff intake art, mockup, price, then send this same link.</text>\n</svg>';
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
    cutter_marks_svg: "cutter-marks.svg",
    job_ticket_svg: "job-ticket.svg",
    method_notes_txt: "method-notes.txt",
  };
  const contents = {
    "cut-contour.svg": cutContourSvg(job, uploadsDir),
    "laser.svg": laserSvg(job, uploadsDir),
    "laser.plt": laserPlt(job, uploadsDir),
    "gang-sheet.svg": gangSheetSvg(job),
    "sticker-cutline.svg": stickerCutlineSvg(job, uploadsDir),
    "cutter-marks.svg": cutterMarksSvg(job, uploadsDir),
    "job-ticket.svg": jobTicketSvg(job, job._shop || null),
    "method-notes.txt": methodNotes(job),
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
  cutterMarksSvg,
  jobTicketSvg,
  methodNotes,
  intakePosterSvg,
};
