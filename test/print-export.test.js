"use strict";
// DXF / PDF / TIFF / 300-DPI PNG exports + DTF underbase rules.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const py = process.env.INVENT_WARP_PYTHON || "python3";
const script = path.join(__dirname, "..", "lib", "print_export.py");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plx-test-"));
const svg = path.join(dir, "a.svg");
fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><path fill="#d02020" d="M10 10 H190 V90 H10 Z M50 30 C60 20 80 20 90 30 L90 70 Z"/><circle cx="150" cy="50" r="20" fill="#2030c0" fill-opacity="0.5"/></svg>');
function run(fmt, extra) {
  const out = path.join(dir, "o." + fmt);
  execFileSync(py, [script, fmt, svg, out, "--width-in", "2"].concat(extra || []));
  return fs.readFileSync(out);
}
const dxf = run("dxf").toString("ascii");
assert(dxf.indexOf("POLYLINE") > 0 && dxf.trim().endsWith("EOF"), "dxf has polylines");
const pdf = run("pdf");
assert(pdf.slice(0, 5).toString() === "%PDF-", "pdf header");
assert(!/\/Subtype\s*\/Image/.test(pdf.toString("latin1")), "pdf is vector (no raster images)");
const png = run("png");
assert(png.readUInt32BE(16) === 600 && png.readUInt32BE(20) === 300, "png 300 dpi pixel size");
const tif = run("tiff", ["--underbase"]);
assert(tif.length > 1000 && (tif.slice(0, 2).toString() === "II" || tif.slice(0, 2).toString() === "MM"), "tiff");
// underbase: nothing under semi-transparent pixels
const chk = execFileSync(py, ["-c", "import sys,numpy as n;from PIL import Image as I;im=I.open(sys.argv[1]);a=n.asarray(im.getchannel('A'));d=im.info['dpi'];im.seek(1);u=n.asarray(im);print(int(((a<255)&(u>0)).sum()),round(d[0]),int((u==255).sum()<(a==255).sum()))", path.join(dir, "o.tiff")]).toString().trim().split(" ");
assert.strictEqual(chk[0], "0", "no white under semi-transparent pixels");
assert.strictEqual(chk[1], "300", "tiff dpi 300");
assert.strictEqual(chk[2], "1", "underbase choked inside solid ink");
console.log("print-export tests passed");
