// ─── Rune separation meter ────────────────────────────────────────────────────
//
//   node scripts/rune-distance.mjs
//
// Prints how far apart every pair of runes in magic.js sits after resampling
// and normalizing. Use it every time you add or reshape a rune.
//
// Reading the table:
//
//   > 0.35   comfortable — a shaky hand will not cross the gap
//   0.15–0.35 workable, but expect the jitter test to drop a few percent
//   < 0.15   the same gesture under two names. In play they will swap at
//            random, which reads as the game being broken rather than as the
//            player having drawn badly.
//
// Note this tool deliberately runs on YOUR resample / normalizeStroke /
// templateDistance, not on a private copy. If those are still stubs it will
// say so and stop. That order is on purpose: you cannot judge whether two
// shapes are distinguishable until you have written the thing that
// distinguishes them.

import {
  RUNES, resample, normalizeStroke, templateDistance, TUNE,
} from "../js/spell-room/magic.js";

// Control points are corners; comparison needs a path.
function trace(controlPoints, per = 30) {
  const out = [];
  for (let i = 0; i < controlPoints.length - 1; i++) {
    const a = controlPoints[i], b = controlPoints[i + 1];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  out.push(controlPoints.at(-1));
  return out;
}

let prepared;
try {
  prepared = RUNES.map((rune) => ({
    rune,
    shape: normalizeStroke(resample(trace(rune.points), TUNE.RESAMPLE_N)),
  }));
  templateDistance(prepared[0].shape, prepared[0].shape);
} catch (err) {
  console.error(`\n  Cannot measure yet: ${err.message}`);
  console.error("  Fill in resample(), normalizeStroke() and templateDistance()");
  console.error("  in js/spell-room/magic.js first, then run this again.\n");
  process.exit(1);
}

if (prepared.length < 2) {
  console.log("\n  Only one rune defined — nothing to compare yet.\n");
  process.exit(0);
}

const label = (r) => `${r.id}`.padEnd(12);
const WARN = 0.15;
const OK = 0.35;

console.log("\n  Pairwise rune distance\n");
process.stdout.write("".padEnd(14));
for (const p of prepared) process.stdout.write(label(p.rune));
console.log();

let worst = { d: Infinity, a: null, b: null };

for (const a of prepared) {
  process.stdout.write(label(a.rune).padEnd(14));
  for (const b of prepared) {
    if (a === b) {
      process.stdout.write("—".padEnd(12));
      continue;
    }
    const d = templateDistance(a.shape, b.shape);
    if (d < worst.d) worst = { d, a: a.rune.id, b: b.rune.id };
    const mark = d < WARN ? " !!" : d < OK ? " ~" : "";
    process.stdout.write(`${d.toFixed(3)}${mark}`.padEnd(12));
  }
  console.log();
}

console.log();
if (worst.d < WARN) {
  console.log(`  ${worst.a} and ${worst.b} are ${worst.d.toFixed(3)} apart — too close.`);
  console.log("  Change one of the SHAPES. Do not lower TUNE.SCORE_FLOOR to");
  console.log("  compensate; that trades a false reject for a false accept,");
  console.log("  and a wrong spell costs you more than a missed one.\n");
  process.exit(1);
}
if (worst.d < OK) {
  console.log(`  Closest pair: ${worst.a} / ${worst.b} at ${worst.d.toFixed(3)}.`);
  console.log("  Workable. Run the jitter test and see what it actually costs:");
  console.log("      node --test tests/spell-room.test.mjs\n");
} else {
  console.log(`  Closest pair: ${worst.a} / ${worst.b} at ${worst.d.toFixed(3)}. Comfortable.\n`);
}
