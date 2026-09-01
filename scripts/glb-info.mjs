// ─── GLB cost meter ───────────────────────────────────────────────────────────
//
//   node scripts/glb-info.mjs                    # every GLB under assets/models
//   node scripts/glb-info.mjs path/to/one.glb    # just these
//
// Prints what each model actually costs before you wire it into the game:
// triangles, draw calls, texture dimensions, download size and an estimate of
// the video memory each texture occupies. Run it on every Meshy download, and
// again on anything you re-export, so a resize or a stray 2048 map cannot creep
// in unnoticed.
//
// Reading the numbers:
//
//   triangles   The budget for a real-time effect is 1,000–3,000. Characters
//               and architecture are allowed to be heavier; effects are not.
//   primitives  One primitive is one draw call. An effect that arrives as six
//               primitives is six draw calls every frame it is on screen.
//   VRAM        w × h × 4 bytes for RGBA8, × 4/3 for the mip chain. This is an
//               upper bound: the browser may pick a cheaper internal format,
//               and models loaded through js/arena/asset-library.js share their
//               textures, so a map used by both duelists is uploaded once.
//   download    What the player waits for. PNG colour maps are the usual
//               culprit — the same image as JPEG is typically 4–6x smaller for
//               no change in VRAM at all.
//
// The exit code is 1 if anything under a vfx/ directory blows the effect budget,
// because those are the assets that have to stay cheap. Everything else is
// reported and left to your judgement.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_DIR = join(ROOT, "assets/models");

const EFFECT_MAX_TRIANGLES = 3000;
const EFFECT_MAX_PRIMITIVES = 1;
const LARGE_TEXTURE = 2048;

/** Repo-relative where that reads better, and left alone where it does not. */
function label(file) {
  const rel = relative(ROOT, file);
  return rel.startsWith("..") || isAbsolute(rel) ? file : rel;
}

/** Walk a directory for .glb files, newest layout or not. */
function findGLBs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findGLBs(full));
    else if (extname(entry.name).toLowerCase() === ".glb") out.push(full);
  }
  return out.sort();
}

/**
 * Read the JSON and BIN chunks out of a binary glTF. The header is 12 bytes and
 * each chunk carries its own 8-byte length/type, so walk them rather than
 * assuming the JSON starts at a fixed offset.
 */
function readGLB(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB (bad magic)");
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString("utf8").replace(/\0+$/, ""));
    else if (type === 0x004e4942) bin = body;
    offset += 8 + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error("no JSON chunk");
  return { json, bin };
}

/**
 * Pixel dimensions straight from the file header. Decoding the image would mean
 * a dependency, and this project does not have any.
 */
function imageSize(bytes) {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20), kind: "PNG" };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const marker = bytes[i + 1];
      // SOF0..SOF15 carry the size; C4/C8/CC are tables, not frame headers.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: bytes.readUInt16BE(i + 7), h: bytes.readUInt16BE(i + 5), kind: "JPEG" };
      }
      i += 2 + bytes.readUInt16BE(i + 2);
    }
  }
  if (bytes.length > 30 && bytes.subarray(0, 4).toString("latin1") === "RIFF") {
    return { w: 0, h: 0, kind: "WebP" };
  }
  return { w: 0, h: 0, kind: "unknown" };
}

function mb(bytes) {
  return `${(bytes / 1048576).toFixed(2)} MB`;
}

function inspect(file) {
  const buffer = readFileSync(file);
  const { json, bin } = readGLB(buffer);

  let triangles = 0;
  let primitives = 0;
  let compressed = false;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      primitives++;
      if (primitive.extensions?.KHR_draco_mesh_compression) { compressed = true; continue; }
      const vertices = json.accessors?.[primitive.attributes?.POSITION]?.count ?? 0;
      const count = primitive.indices === undefined
        ? vertices
        : json.accessors?.[primitive.indices]?.count ?? 0;
      // Mode 4 is TRIANGLES; strips and fans give count - 2.
      const mode = primitive.mode ?? 4;
      triangles += mode === 4 ? Math.floor(count / 3) : Math.max(0, count - 2);
    }
  }

  const images = [];
  let textureBytes = 0;
  let vramBytes = 0;
  for (const image of json.images ?? []) {
    if (image.bufferView === undefined) {
      images.push({ w: 0, h: 0, kind: "external", bytes: 0, uri: image.uri });
      continue;
    }
    const view = json.bufferViews[image.bufferView];
    const start = view.byteOffset ?? 0;
    const bytes = bin.subarray(start, start + view.byteLength);
    const { w, h, kind } = imageSize(bytes);
    const vram = w * h * 4 * (4 / 3);
    textureBytes += view.byteLength;
    vramBytes += vram;
    images.push({ w, h, kind, bytes: view.byteLength, vram });
  }

  return {
    file,
    size: buffer.length,
    triangles,
    primitives,
    compressed,
    images,
    textureBytes,
    vramBytes,
    meshes: json.meshes?.length ?? 0,
    materials: json.materials?.length ?? 0,
    animations: json.animations?.length ?? 0,
    joints: json.skins?.[0]?.joints?.length ?? 0,
    extensions: json.extensionsUsed ?? [],
  };
}

const args = process.argv.slice(2);
let files;
try {
  files = args.length
    ? args.map(path => (statSync(path).isDirectory() ? findGLBs(path) : [path])).flat()
    : findGLBs(DEFAULT_DIR);
} catch (error) {
  console.error(`\n  ${error.message}\n`);
  process.exit(1);
}

if (!files.length) {
  console.log("\n  No .glb files found.\n");
  process.exit(0);
}

console.log("\n  GLB cost\n");

let totalSize = 0;
let totalVram = 0;
const overBudget = [];

for (const file of files) {
  let info;
  try {
    info = inspect(file);
  } catch (error) {
    console.log(`  ${label(file)}`);
    console.log(`    unreadable: ${error.message}\n`);
    continue;
  }

  totalSize += info.size;
  totalVram += info.vramBytes;

  const isEffect = /[\\/]vfx[\\/]/.test(file);
  const breaks = isEffect && (info.triangles > EFFECT_MAX_TRIANGLES || info.primitives > EFFECT_MAX_PRIMITIVES);
  if (breaks) overBudget.push(info);

  console.log(`  ${label(file)}${isEffect ? "   [effect]" : ""}`);
  const shape = [`${mb(info.size)}`];
  if (info.meshes) {
    shape.push(
      `${info.triangles.toLocaleString()} triangles`,
      `${info.primitives} primitive${info.primitives === 1 ? "" : "s"}`,
      `${info.materials} material${info.materials === 1 ? "" : "s"}`,
    );
  }
  if (info.animations) shape.push(`${info.animations} animation${info.animations === 1 ? "" : "s"}`);
  if (info.joints) shape.push(`${info.joints} joints`);
  if (info.compressed) shape.push("Draco compressed — triangle count is partial");
  console.log(`    ${shape.join("  ·  ")}`);

  for (const [index, image] of info.images.entries()) {
    if (image.kind === "external") {
      console.log(`    image[${index}] external file: ${image.uri}`);
      continue;
    }
    const flag = image.w >= LARGE_TEXTURE ? "  <- 2048, only for large close-up objects" : "";
    console.log(`    image[${index}] ${image.w}x${image.h} ${image.kind}  ${mb(image.bytes)} in file, ~${mb(image.vram)} VRAM${flag}`);
  }
  if (!info.images.length) {
    console.log(info.meshes
      ? "    no textures — coloured in the game"
      : "    armature and curves only — no mesh, no textures");
  }

  if (info.extensions.length) console.log(`    extensions: ${info.extensions.join(", ")}`);
  if (breaks) {
    console.log(`    OVER BUDGET for an effect: ${EFFECT_MAX_TRIANGLES} triangles and ${EFFECT_MAX_PRIMITIVES} primitive max`);
  }
  console.log();
}

console.log(`  ${files.length} files  ·  ${mb(totalSize)} to download  ·  ~${mb(totalVram)} of texture memory\n`);

if (overBudget.length) {
  for (const info of overBudget) {
    console.log(`  ${label(info.file)} is too expensive to be an effect.`);
  }
  console.log("  Re-topologise it or ask Meshy for a lower-poly preview. Do not");
  console.log("  raise the budget to fit the asset; the budget is what keeps the");
  console.log("  duel at 60fps with two characters already on screen.\n");
  process.exit(1);
}
