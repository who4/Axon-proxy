import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'lib/constants.js',
  'lib/site-bundles.js',
  'lib/storage.js',
  'lib/pac-builder.js',
  'lib/proxy-engine.js',
  'popup/popup.html',
  'popup/popup.css',
  'popup/popup.js',
  'options/options.html',
  'options/options.css',
  'options/options.js',
];

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear()) - 1980;
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((date.getSeconds() >> 1) & 0x1f);
  const dosDate =
    ((year & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

function createZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const raw = entry.data;
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const body = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const { dosTime, dosDate } = dosDateTime(entry.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuf, body);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + body.length;
  }

  const centralDir = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDir, eocd]);
}

function validateManifest(manifest) {
  const errors = [];
  if (manifest.manifest_version !== 3) {
    errors.push('manifest_version must be 3');
  }
  if (!manifest.name || manifest.name.length > 75) {
    errors.push(`name must be 1..75 characters (got ${manifest.name?.length || 0})`);
  }
  if (!manifest.description || manifest.description.length > 132) {
    errors.push(`description must be <= 132 characters for Chrome Web Store (got ${manifest.description?.length || 0})`);
  }
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) {
    errors.push(`invalid Chrome extension version: ${manifest.version}`);
  }
  for (const [sizeStr, relPath] of Object.entries(manifest.icons || {})) {
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) {
      errors.push(`missing icon: ${relPath}`);
      continue;
    }
    const png = fs.readFileSync(abs);
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    const expected = Number(sizeStr);
    if (w !== expected || h !== expected) {
      errors.push(`icon ${relPath} is ${w}x${h}, expected ${expected}x${expected}`);
    }
  }
  if (errors.length) {
    throw new Error(`Chrome Web Store manifest validation failed:\n- ${errors.join('\n- ')}`);
  }
}

function main() {
  const manifestPath = path.join(ROOT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);

  const entries = [];
  for (const rel of EXTENSION_FILES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing required extension file: ${rel}`);
    }
    const stat = fs.statSync(abs);
    entries.push({
      name: rel,
      data: fs.readFileSync(abs),
      mtime: stat.mtime,
    });
  }

  const distDir = path.join(ROOT, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const zipName = `axon-proxy-v${manifest.version}-chrome-web-store.zip`;
  const zipPath = path.join(distDir, zipName);
  const zipBuffer = createZip(entries);
  fs.writeFileSync(zipPath, zipBuffer);

  console.log(`Built ${path.relative(ROOT, zipPath)} (${zipBuffer.length} bytes, ${entries.length} files)`);
  console.log(`Manifest: ${manifest.name} v${manifest.version} (description: ${manifest.description.length}/132 chars)`);
}

main();
