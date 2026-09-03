// ─── What the arm actually measured ──────────────────────────────────────────
//
//   node scripts/arm-span.mjs veilcore-tracking-1234567890.json
//
// Answers one question: is the `arm N.NN LOCKED` on the panel your arm, or the
// top of the tracker's noise?
//
// ── Why the number needs a tool at all ──
//
// createArmSpan() keeps the three LONGEST ratios it has ever seen and takes the
// smallest of those three, and `widths` only ever moves up. That is deliberate
// -- an arm that is still learning is a ruler that moves under the hand, and a
// one percent wobble in the ruler slides a hand at full reach by one percent of
// an arm with the player standing perfectly still. Freezing it is worth a lot.
//
// But an estimator that seeks a maximum sits wherever the noise reaches, not
// where the arm is. Three bad frames early in a session and it locks high for
// the rest of it, and every hand position measured against it -- the rune's
// size included -- is out by the same fraction. From the panel you cannot tell
// 1.91 "long arms" from 1.91 "three stretched elbows at second four".
//
// From a recording you can, because the whole distribution is in it. Record 8
// seconds with R in the mirror, hold your arm out and move it around as you
// would while playing, and run this on the file it saves.
//
// Reading it:
//
//   settled ≈ median      the arm was measured cleanly; the number is yours
//   settled ≫ median      the lock is riding the noise ceiling, and everything
//                         measured off the arm is that fraction too big
//   many over the cap     the pose model is stretching the chain outright
//
// For scale: fed a synthetic arm of exactly 1.80 widths with a millimetre of
// jitter on the elbow and wrist, this settles on 1.803. Fed the SAME 1.80 arm
// with a centimetre of jitter -- ordinary for a pose model at a normal distance
// -- it settles on 1.901 against a median of 1.807. So a panel reading around
// 1.90 is what a perfectly normal arm looks like through a noisy chain, and it
// is not evidence of a long one.

import { readFileSync } from 'node:fs';
import { createArmSpan, shoulderSpan } from '../js/spell-room/pose.js';

const ARM_SPAN_SANE = 1.95;          // the cap inside createArmSpan()
const HEALTHY = [1.75, 1.85];        // what a real arm has measured, in widths

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/arm-span.mjs <veilcore-tracking-*.json>');
  process.exit(2);
}

const recording = JSON.parse(readFileSync(path, 'utf8'));
const frames = recording.frames ?? [];
if (!frames.length) {
  console.error(`${path} has no frames in it`);
  process.exit(1);
}

const chain = arm => {
  if (!arm?.shoulder || !arm?.elbow || !arm?.wrist) return 0;
  const upper = Math.hypot(arm.elbow.x - arm.shoulder.x, arm.elbow.y - arm.shoulder.y);
  const fore = Math.hypot(arm.wrist.x - arm.elbow.x, arm.wrist.y - arm.elbow.y);
  return upper + fore;
};

const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (at - low);
};

console.log(`\n${path} — ${frames.length} frames, ${(frames.at(-1).t / 1000).toFixed(1)}s\n`);

for (const side of ['left', 'right']) {
  const ratios = [];
  let overCap = 0;
  const span = createArmSpan();
  let settledAt = null;

  for (const frame of frames) {
    const arm = frame.pose?.[side];
    const shoulders = shoulderSpan(frame.pose);
    if (!arm || !(shoulders > 0)) continue;
    const length = chain(arm);
    if (!(length > 0)) continue;
    const ratio = length / shoulders;
    if (ratio > ARM_SPAN_SANE) { overCap++; continue; }
    ratios.push(ratio);
    // The real learner, on the real frames, in order.
    span.feed(arm, shoulders);
    if (span.settled && settledAt === null) settledAt = frame.t;
  }

  if (!ratios.length) {
    console.log(`${side.padEnd(6)} no readable arm in this recording`);
    continue;
  }

  ratios.sort((a, b) => a - b);
  const median = quantile(ratios, 0.5);
  const settled = span.widths;
  const bias = median > 0 ? (settled / median - 1) * 100 : 0;
  const healthy = settled >= HEALTHY[0] && settled <= HEALTHY[1];

  console.log(`${side} arm — ${ratios.length} readings, ${overCap} rejected over ${ARM_SPAN_SANE}`);
  console.log(`  p10 ${quantile(ratios, 0.1).toFixed(3)}   median ${median.toFixed(3)}`
    + `   p90 ${quantile(ratios, 0.9).toFixed(3)}   max ${ratios.at(-1).toFixed(3)}`);
  console.log(`  the learner settles on ${settled.toFixed(3)}`
    + (settledAt === null ? ' (never froze in this recording)' : ` at ${(settledAt / 1000).toFixed(1)}s`)
    + `, ${bias >= 0 ? '+' : ''}${bias.toFixed(1)}% off the median`);
  console.log(`  ${healthy
    ? 'inside the band a real arm has measured'
    : `OUTSIDE the ${HEALTHY[0]}–${HEALTHY[1]} band a real arm has measured`}`);
  if (bias > 4) {
    console.log('  the lock is riding the top of the noise, not the middle of it:');
    console.log('  everything measured against this arm is about that much too big.');
  }
  console.log();
}
