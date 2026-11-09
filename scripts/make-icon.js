'use strict';

/**
 * 生成应用图标 build/icon.ico（无第三方依赖）。
 * 做法：手写一个 256×256 的 RGBA PNG，再按 ICO 容器格式封装。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function buildPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const center = size / 2;
  const radius = size * 0.42;
  const triangle = (x, y) => {
    // 白色播放三角：左上 (0.34,0.30) 右上 (0.34,0.70) 右中 (0.72,0.5)
    const x1 = size * 0.34;
    const y1 = size * 0.3;
    const y2 = size * 0.7;
    const x3 = size * 0.72;
    const y3 = size * 0.5;
    const d1 = (x - x1) * (y2 - y1) - (x1 - x3) * (y1 - y3) >= 0;
    const d2 = (x - x1) * (y3 - y1) - (x1 - x3) * (y2 - y1) >= 0;
    return !(d1 && d2) && x >= x1 && y >= y1 && y <= y2;
  };
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = rowStart + 1 + x * 4;
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const alpha = dist <= radius ? 255 : dist <= radius + 1 ? Math.round((radius + 1 - dist) * 255) : 0;
      let r = 0;
      let g = 0;
      let b = 0;
      if (alpha > 0) {
        const t = (x + y) / (2 * size);
        r = Math.round(79 + (167 - 79) * t);
        g = Math.round(140 + (139 - 140) * t);
        b = Math.round(255 + (250 - 255) * t);
        if (triangle(x, y)) {
          r = 255;
          g = 255;
          b = 255;
        }
      }
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([header, entry, png]);
}

function main() {
  const size = 256;
  const png = buildPng(size);
  const ico = buildIco(png, size);
  const dir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(dir, { recursive: true });
  const pngPath = path.join(dir, 'icon.png');
  const icoPath = path.join(dir, 'icon.ico');
  fs.writeFileSync(pngPath, png);
  fs.writeFileSync(icoPath, ico);
  console.log(`已生成：${pngPath}（${png.length} 字节）`);
  console.log(`已生成：${icoPath}（${ico.length} 字节）`);
}

main();
