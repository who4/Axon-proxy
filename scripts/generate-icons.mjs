import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ICONS_DIR = path.resolve(__dirname, '..', 'icons');

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter None
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// 7x7 pixel-matrix Axon "A" / signal wave pattern
// 0 = dim obsidian matrix cell, 1 = bright matrix green, 2 = luminous mint peak
const MATRIX = [
  [0, 0, 1, 2, 1, 0, 0],
  [0, 1, 2, 0, 2, 1, 0],
  [1, 2, 0, 0, 0, 2, 1],
  [1, 1, 2, 2, 2, 1, 1],
  [1, 0, 1, 2, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1],
  [0, 0, 0, 0, 0, 0, 0]
];

function blendPixel(buf, idx, r, g, b, a) {
  const alpha = a / 255;
  const inv = 1 - alpha;
  buf[idx] = Math.round(r * alpha + buf[idx] * inv);
  buf[idx + 1] = Math.round(g * alpha + buf[idx + 1] * inv);
  buf[idx + 2] = Math.round(b * alpha + buf[idx + 2] * inv);
  buf[idx + 3] = Math.min(255, Math.round(a + buf[idx + 3] * inv));
}

function insideRoundedRect(x, y, rx, ry, rw, rh, radius) {
  if (x < rx || x >= rx + rw || y < ry || y >= ry + rh) return false;
  const cx = x < rx + radius ? rx + radius : x > rx + rw - radius ? rx + rw - radius : x;
  const cy = y < ry + radius ? ry + radius : y > ry + rh - radius ? ry + rh - radius : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const bgRadius = size * 0.22;
  const pad = size * 0.14;
  const gridArea = size - pad * 2;
  const cols = 7;
  const rows = 6;
  const cellPitch = gridArea / cols;
  const gap = Math.max(1, Math.round(cellPitch * 0.18));
  const cellSize = Math.max(1, cellPitch - gap);
  const gridOffsetY = pad + (gridArea - rows * cellPitch) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = (y * size + x) * 4;
      if (!insideRoundedRect(x + 0.5, y + 0.5, 0, 0, size, size, bgRadius)) {
        continue;
      }

      // Matte obsidian base (#0D0E11) with subtle top sheen
      const t = y / size;
      const baseR = Math.round(18 - t * 6);
      const baseG = Math.round(19 - t * 6);
      const baseB = Math.round(23 - t * 7);
      rgba[idx] = baseR;
      rgba[idx + 1] = baseG;
      rgba[idx + 2] = baseB;
      rgba[idx + 3] = 255;

      // Subtle inner border ring
      const borderWidth = Math.max(1, size * 0.025);
      if (!insideRoundedRect(
        x + 0.5,
        y + 0.5,
        borderWidth,
        borderWidth,
        size - borderWidth * 2,
        size - borderWidth * 2,
        Math.max(1, bgRadius - borderWidth)
      )) {
        blendPixel(rgba, idx, 255, 255, 255, 22);
      }

      // Soft radial emerald glow behind active pixels
      const gx = (x - size * 0.5) / (size * 0.45);
      const gy = (y - size * 0.46) / (size * 0.45);
      const distSq = gx * gx + gy * gy;
      if (distSq < 1) {
        const glow = Math.pow(1 - distSq, 2) * 42;
        blendPixel(rgba, idx, 36, 216, 88, glow);
      }
    }
  }

  // Draw pixel-matrix tiles
  const cellRadius = Math.max(0.5, cellSize * 0.22);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const val = MATRIX[r][c];
      const cx = pad + c * cellPitch + gap / 2;
      const cy = gridOffsetY + r * cellPitch + gap / 2;

      const x0 = Math.max(0, Math.floor(cx));
      const x1 = Math.min(size - 1, Math.ceil(cx + cellSize));
      const y0 = Math.max(0, Math.floor(cy));
      const y1 = Math.min(size - 1, Math.ceil(cy + cellSize));

      for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
          if (!insideRoundedRect(x + 0.5, y + 0.5, cx, cy, cellSize, cellSize, cellRadius)) {
            continue;
          }
          const idx = (y * size + x) * 4;
          if (val === 0) {
            blendPixel(rgba, idx, 34, 38, 46, 150);
          } else if (val === 1) {
            blendPixel(rgba, idx, 34, 211, 88, 255);
          } else {
            blendPixel(rgba, idx, 102, 245, 146, 255);
          }
        }
      }
    }
  }

  return encodePng(size, size, rgba);
}

async function main() {
  await fs.mkdir(ICONS_DIR, { recursive: true });
  for (const size of [16, 32, 48, 128]) {
    const png = renderIcon(size);
    await fs.writeFile(path.join(ICONS_DIR, `icon${size}.png`), png);
    console.log(`Generated icons/icon${size}.png (${png.length} bytes)`);
  }
}

main();
