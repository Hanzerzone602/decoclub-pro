"use strict";

const zlib = require("zlib");

function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}


function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) {
    throw new Error("Not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette = null;
  const idats = [];
  while (offset + 12 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.slice(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + len;
  }
  if (!width || !height) throw new Error("Invalid PNG header");
  if (bitDepth !== 8) throw new Error("Only 8-bit PNG is supported");
  if (interlace) throw new Error("Interlaced PNG is not supported");
  const compressed = Buffer.concat(idats);
  const inflated = zlib.inflateSync(compressed);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error("Unsupported PNG color type");
  const stride = width * channels;
  const raw = Buffer.alloc(stride * height);
  let si = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const ft = inflated[si++];
    const out = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const v = inflated[si++];
      const a = x >= channels ? out[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let n = v;
      if (ft === 1) n = (v + a) & 255;
      else if (ft === 2) n = (v + b) & 255;
      else if (ft === 3) n = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) n = (v + paeth(a, b, c)) & 255;
      out[x] = n;
    }
    out.copy(raw, y * stride);
    prev = out;
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r = 0, g = 0, b = 0, a = 255;
    if (colorType === 0) {
      r = g = b = raw[i];
    } else if (colorType === 2) {
      r = raw[i * 3];
      g = raw[i * 3 + 1];
      b = raw[i * 3 + 2];
    } else if (colorType === 4) {
      r = g = b = raw[i * 2];
      a = raw[i * 2 + 1];
    } else if (colorType === 6) {
      r = raw[i * 4];
      g = raw[i * 4 + 1];
      b = raw[i * 4 + 2];
      a = raw[i * 4 + 3];
    } else if (colorType === 3) {
      const idx = raw[i];
      r = palette[idx * 3];
      g = palette[idx * 3 + 1];
      b = palette[idx * 3 + 2];
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return { width, height, rgba };
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const compressed = zlib.deflateSync(raw);
  function chunk(type, data) {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
}

function makeRgba(width, height, fill) {
  const rgba = Buffer.alloc(width * height * 4);
  const r = fill[0], g = fill[1], b = fill[2], a = fill[3] == null ? 255 : fill[3];
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return rgba;
}

module.exports = { decodePng, encodePng, makeRgba };
