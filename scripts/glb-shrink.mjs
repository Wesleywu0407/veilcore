// ─── Bringing a Meshy GLB inside the texture budget ──────────────────────────
//
//   node scripts/glb-shrink.mjs assets/models/range/target.glb 1024
//
// Meshy hands back three 2048² maps whatever the object is. PLAN.md's asset
// spec asks for 512 or 1024 unless something is large and close, and `npm run
// assets` flags anything bigger -- so every asset that comes out of Meshy needs
// this doing to it, and doing it by hand once per asset is how it stops getting
// done.
//
// ── Why this is not a library ──
//
// A GLB is a 12-byte header and two chunks: the glTF JSON, then one binary blob
// that every buffer view points into. Resizing an embedded image means decoding
// nothing and re-laying the blob: pull each image's bytes out by its view,
// hand them to `sips` -- which is in macOS, not in node_modules -- and write the
// views back at their new offsets. That is a hundred lines and no dependency,
// against a toolchain this project has gone out of its way not to have.
//
// It rewrites IN PLACE only when told to; by default it writes `-small.glb`
// beside the original, because AGENTS.md 4 is emphatic that a repaired GLB is
// never to be overwritten casually and this cannot tell one from the other.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const [, , file, sizeArg, flag] = process.argv;
if (!file) {
  console.error('usage: node scripts/glb-shrink.mjs <file.glb> [maxSize=1024] [--in-place]');
  process.exit(2);
}
const maxSize = Number(sizeArg) || 1024;
const inPlace = flag === '--in-place';

const src = readFileSync(file);
if (src.readUInt32LE(0) !== 0x46546c67) { console.error(`${file} is not a GLB`); process.exit(1); }

// ── Split the container ──
let offset = 12;
let json = null, bin = null;
while (offset < src.length) {
  const length = src.readUInt32LE(offset);
  const type = src.readUInt32LE(offset + 4);
  const body = src.subarray(offset + 8, offset + 8 + length);
  if (type === JSON_CHUNK) json = JSON.parse(new TextDecoder().decode(body));
  else if (type === BIN_CHUNK) bin = body;
  offset += 8 + length + ((4 - (length % 4)) % 4);
}
if (!json || !bin) { console.error('GLB has no JSON or no BIN chunk'); process.exit(1); }

const images = json.images ?? [];
if (!images.length) { console.log(`${file}: no embedded images, nothing to do`); process.exit(0); }

const work = mkdtempSync(join(tmpdir(), 'glb-shrink-'));
const replaced = new Map();   // bufferView index -> new bytes

try {
  images.forEach((image, i) => {
    if (image.bufferView === undefined) return;
    const view = json.bufferViews[image.bufferView];
    const bytes = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const ext = image.mimeType === 'image/png' ? 'png' : 'jpg';
    const from = join(work, `image-${i}.${ext}`);
    const to = join(work, `image-${i}-small.jpg`);
    writeFileSync(from, bytes);

    // `sips -Z` fits the LONGER side, leaving anything already small alone.
    execFileSync('sips', ['-Z', String(maxSize), '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '82', from, '--out', to], { stdio: 'ignore' });
    const small = readFileSync(to);
    replaced.set(image.bufferView, small);
    image.mimeType = 'image/jpeg';
    console.log(`  image[${i}]  ${(bytes.length / 1048576).toFixed(2)} MB`
      + ` -> ${(small.length / 1048576).toFixed(2)} MB`);
  });

  // ── Re-lay the blob ──
  //
  // Offsets move, so every view is rewritten in order rather than patched. Four
  // byte alignment is required by the spec and glTF loaders do enforce it.
  const parts = [];
  let cursor = 0;
  for (const view of json.bufferViews) {
    const bytes = replaced.get(json.bufferViews.indexOf(view))
      ?? bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    view.byteOffset = cursor;
    view.byteLength = bytes.length;
    parts.push(bytes, Buffer.alloc(pad));
    cursor += bytes.length + pad;
  }
  const newBin = Buffer.concat(parts);
  json.buffers[0].byteLength = newBin.length;

  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + newBin.length, 8);

  const chunk = (length, type) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(length, 0);
    head.writeUInt32LE(type, 4);
    return head;
  };

  const out = Buffer.concat([
    header,
    chunk(jsonChunk.length, JSON_CHUNK), jsonChunk,
    chunk(newBin.length, BIN_CHUNK), newBin,
  ]);

  const target = inPlace ? file : file.replace(/\.glb$/, '-small.glb');
  writeFileSync(target, out);
  console.log(`${file}  ${(src.length / 1048576).toFixed(2)} MB`
    + ` -> ${target}  ${(out.length / 1048576).toFixed(2)} MB`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
