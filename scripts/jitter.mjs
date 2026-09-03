// ─── Which point is actually shaking ─────────────────────────────────────────
//
//   node scripts/jitter.mjs veilcore-tracking-1234567890.json
//
// Record 8 seconds with R in the mirror while doing the thing that looks wrong,
// then run this. It compares the three points the duel reads off one hand, on
// the SAME frames, so "the line jumps but the arm does not" becomes a number
// instead of an impression.
//
// ── Why the three cannot be argued about from a screenshot ──
//
//   wrist    what the ARM follows, raw off the model
//   anchor   the same wrist after ANCHOR_FILTER -- what actually poses the arm
//   tip      the index fingertip after TIP_FILTER -- what draws the rune
//
// They are different points with different filters, and the fingertip has a
// third problem neither of the others has: it MOVES WHEN YOU CURL THE FINGER.
// Drawing means pinching, so every adjustment of the pinch is a real movement
// of the drawing point that no filter can tell from a movement you meant.
//
// If tip jitter is far above anchor jitter on your own hand, that is the reason,
// and the fix is not another filter constant -- it is to draw from a point that
// a pinch does not move.

import { readFileSync } from 'node:fs';

const WIDE = 1920;

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/jitter.mjs <veilcore-tracking-*.json>');
  process.exit(2);
}
const recording = JSON.parse(readFileSync(path, 'utf8'));
const frames = recording.frames ?? [];
if (!frames.length) {
  console.error(`${path} has no frames in it`);
  process.exit(1);
}

/**
 * Jitter is what is LEFT after the movement you meant.
 *
 * The second difference does it: a straight glide has none, a constant velocity
 * has none, and only the frame-to-frame wobble survives. Averaging raw step
 * size instead would score a fast deliberate sweep as the shakiest thing in the
 * recording, which is backwards.
 */
function jitter(points) {
  let sum = 0, worst = 0, n = 0;
  for (let i = 2; i < points.length; i++) {
    const a = points[i - 2], b = points[i - 1], c = points[i];
    if (!a || !b || !c) continue;
    const dx = (c.x - 2 * b.x + a.x) * WIDE;
    const dy = (c.y - 2 * b.y + a.y) * WIDE;
    const d = Math.hypot(dx, dy);
    sum += d; worst = Math.max(worst, d); n++;
  }
  return n ? { mean: sum / n, worst, n } : null;
}

/** Straight-line speed, so a row can say whether the hand was moving at all. */
function speed(points) {
  let sum = 0, n = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (!a || !b) continue;
    sum += Math.hypot(b.x - a.x, b.y - a.y) * WIDE; n++;
  }
  return n ? sum / n : 0;
}

const sides = ['left', 'right'];
console.log(`\n  ${path}`);
console.log(`  ${frames.length} frames, ${(frames.at(-1).t / 1000).toFixed(1)}s`
  + `, median ${(frames.map(f => f.hz).sort((a, b) => a - b)[frames.length >> 1] ?? 0).toFixed(1)}Hz\n`);

for (const side of sides) {
  const pick = key => frames
    .map(f => (f.hands ?? []).find(h => (h.bodySide ?? h.side) === side)?.[key] ?? null)
    .filter(Boolean);

  const wrist = pick('wrist'), anchor = pick('anchor'), tip = pick('tip');
  if (tip.length < 10) { console.log(`  ${side}: not enough of this hand in the recording\n`); continue; }

  console.log(`  ${side} hand — seen on ${tip.length} frames`);
  console.log('    point                    jitter px/frame   worst    mean speed');
  for (const [name, pts, note] of [
    ['wrist  (raw)', wrist, 'what the arm follows, unfiltered'],
    ['anchor (filtered)', anchor, 'what actually poses the arm'],
    ['tip    (filtered)', tip, 'what draws the rune'],
  ]) {
    const j = jitter(pts);
    if (!j) continue;
    console.log(`    ${name.padEnd(22)}${j.mean.toFixed(2).padStart(10)}${j.worst.toFixed(2).padStart(10)}`
      + `${speed(pts).toFixed(2).padStart(12)}   ${note}`);
  }

  const jt = jitter(tip), ja = jitter(anchor);
  if (jt && ja && ja.mean > 0) {
    const ratio = jt.mean / ja.mean;
    console.log(`\n    the fingertip shakes ${ratio.toFixed(1)}x as much as the point the arm uses.`);
    if (ratio > 2) {
      console.log('    That is the gap. It is not a filter constant -- the fingertip moves');
      console.log('    when the finger curls, and drawing means pinching.');
    } else {
      console.log('    Close enough that the drawing point is not the explanation;');
      console.log('    look at what is drawn FROM it rather than at the point itself.');
    }
  }
  console.log();
}
