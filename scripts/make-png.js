const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function createPng(width, height, getPixel) {
  const rawData = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;

  for (let y = 0; y < height; y++) {
    rawData[offset++] = 0; // Filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y, width, height);
      rawData[offset++] = r;
      rawData[offset++] = g;
      rawData[offset++] = b;
      rawData[offset++] = a;
    }
  }

  const compressed = zlib.deflateSync(rawData);

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);

    const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeInt32BE(crc32(typeAndData), 0);

    return Buffer.concat([len, typeAndData, crc]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 6; // RGBA color type
  ihdr[10] = 0; // Deflate
  ihdr[11] = 0; // Filter
  ihdr[12] = 0; // Interlace: None

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Simple CRC32 table
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return crc ^ -1;
}

// Draw stylized DKaimono-AM Icon
function renderPixel(x, y, w, h) {
  const nx = (x / w) * 2 - 1;
  const ny = (y / h) * 2 - 1;
  const dist = Math.sqrt(nx * nx + ny * ny);

  // Background squircle check
  const p = 4;
  const cornerDist = Math.pow(Math.abs(nx), p) + Math.pow(Math.abs(ny), p);
  if (cornerDist > 1.05) {
    return [0, 0, 0, 0]; // Transparent outside
  }

  // Border glow
  if (cornerDist > 0.95) {
    return [42, 41, 39, 255]; // Carbon border (#2A2927)
  }

  // Center lightning bolt check
  // Normalized 0 to 1
  const u = x / w;
  const v = y / h;

  // Bolt polygon rough hit test
  const inBolt = (
    (v >= 0.15 && v <= 0.52 && u >= 0.35 + (0.52 - v) * 0.4 && u <= 0.68 - (0.52 - v) * 0.1) ||
    (v >= 0.45 && v <= 0.85 && u >= 0.28 + (0.85 - v) * 0.25 && u <= 0.65 - (v - 0.45) * 0.4) ||
    (v >= 0.48 && v <= 0.54 && u >= 0.25 && u <= 0.72)
  );

  if (inBolt) {
    // Signal Vermilion Orange (#FF4F18)
    return [255, 79, 24, 255];
  }

  // Ambient center
  if (dist < 0.6) {
    return [26, 25, 24, 255]; // Deep carbon
  }

  return [20, 20, 19, 255]; // Base carbon (#141413)
}

const favicon32 = createPng(32, 32, renderPixel);
fs.writeFileSync(path.join(__dirname, '..', 'public', 'favicon.png'), favicon32);
fs.writeFileSync(path.join(__dirname, '..', 'public', 'favicon.ico'), favicon32); // Valid PNG in ico

const touch192 = createPng(192, 192, renderPixel);
fs.writeFileSync(path.join(__dirname, '..', 'public', 'apple-touch-icon.png'), touch192);

console.log('Generated favicon.png, favicon.ico, and apple-touch-icon.png successfully!');
