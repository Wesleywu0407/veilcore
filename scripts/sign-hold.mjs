// ─── How eager the off hand's count is ───────────────────────────────────────
//
//   node scripts/sign-hold.mjs
//
// SIGN_HOLD is how many frames a finger count has to survive before the duel
// believes it. Too low and the duel changes weapon out from under you while
// your hand is still on its way to the shape you meant; too high and holding up
// a one feels like it is ignoring you.
//
// Both halves are measurable, so neither has to be argued:
//
//   false    of the transitions below, the share where the count settled on a
//            number NOBODY MEANT before reaching the one they did. This is
//            "it recognised too fast".
//   wait     frames from the hand arriving at its final shape to the duel
//            agreeing, at 30Hz and at the 20Hz the tracker often really runs.
//
// ── Why a hand in transit produces counts nobody made ──
//
// Fingers do not uncurl together. Opening a fist into a one, the index leads
// and the other three trail by a few frames each, so on the way through the
// hand genuinely IS a two and then a three for an instant. Nothing is wrong
// with the tracking when this happens; the shape really was there. SIGN_HOLD is
// the only thing standing between that and a weapon change.

import { FINGER_CHAINS } from '../js/spell-room/fingers.js';
import { COUNTING, SIGN_HOLD, createSignState, handSign } from '../js/spell-room/hand-sign.js';

const SEGMENTS = [0.45, 0.30, 0.25];
const FIST_DEGREES = [90, 100, 70];

/** The test suite's hand, posed by curl amount per finger. 0 straight, 1 shut. */
function poseHand(bends) {
  const points = new Array(21).fill(null).map(() => ({ x: 0, y: 0, z: 0 }));
  points[0] = { x: 0, y: 0, z: 0 };
  Object.entries(FINGER_CHAINS).forEach(([name, chain], f) => {
    const closed = bends[name] ?? 0;
    let x = 0.02 * f, y = 0.05, angle = 0;
    points[chain[0]] = { x, y, z: 0 };
    for (let i = 1; i < chain.length; i++) {
      angle += (FIST_DEGREES[i - 1] * closed * Math.PI) / 180;
      x += Math.sin(angle) * SEGMENTS[i - 1] * 0.09;
      y += Math.cos(angle) * SEGMENTS[i - 1] * 0.09;
      points[chain[i]] = { x, y, z: 0 };
    }
  });
  return points;
}

const rng = seed => {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
};

const bendsFor = count => {
  const b = { thumb: 1 };
  COUNTING.forEach((name, i) => { b[name] = i < count ? 0 : 1; });
  return b;
};

/**
 * One transition, frame by frame: fingers leave the old shape at staggered
 * times and take `travel` frames each, with curl noise throughout.
 */
function* transition(from, to, travel, stagger, settleFrames, rand, noise) {
  const a = bendsFor(from), b = bendsFor(to);
  const start = {};
  COUNTING.forEach((name, i) => { start[name] = i * stagger; });
  const total = travel + Math.max(...Object.values(start)) + settleFrames;
  for (let f = 0; f < total; f++) {
    const bends = { thumb: 1 };
    for (const name of COUNTING) {
      const t = Math.max(0, Math.min(1, (f - start[name]) / travel));
      // Noise on the curl itself, which is what a landmark wobble becomes.
      bends[name] = Math.max(0, Math.min(1, a[name] + (b[name] - a[name]) * t + (rand() - 0.5) * noise));
    }
    yield { bends, arrived: f >= travel + Math.max(...Object.values(start)) };
  }
}

const HOLDS = [2, 3, 4, 5, 6, 8, 10, 12];
// Every pair worth making: a fist, a one and a two are the shapes the duel
// reads, and you arrive at each of them from the other two.
const PAIRS = [[0, 1], [1, 0], [0, 2], [2, 0], [1, 2], [2, 1]];

// How much the curl reading wobbles frame to frame. The band the hysteresis
// leaves is 0.20 wide (EXTENDED_OUT 0.30 to EXTENDED_IN 0.50), so 0.04 is a
// clean read, 0.08 is a wobbly one and 0.12 is noise more than half the width
// of the band the hysteresis was built to cover.
const NOISES = [0.08];
// How many frames apart the fingers leave the old shape. This is the whole
// mechanism: fingers that moved together would never make a count nobody meant.
// 1 is a snapped change of shape, 3 is a relaxed one.
const STAGGERS = [1, 2, 3];

console.log(`\n  SIGN_HOLD is ${SIGN_HOLD} today. ${PAIRS.length * 40} transitions per cell.`);
console.log('  false = settled on a count nobody made, on the way to the one they did.');
console.log('  wait  = frames from the hand arriving to the duel agreeing, CLEAN runs only.\n');
process.stdout.write('  hold ');
for (const st of STAGGERS) process.stdout.write(`fingers ${st}f apart`.padStart(20));
console.log('        wait      30Hz      20Hz');
for (const hold of HOLDS) {
  process.stdout.write(`  ${String(hold).padStart(4)} `);
  let waitTotal = 0, waited = 0;
  for (const stagger of STAGGERS) {
    const noise = NOISES[0];
    let bad = 0, runs = 0;
    for (const [from, to] of PAIRS) {
      for (let seed = 0; seed < 40; seed++) {
        const rand = rng(1000 + seed * 7);
        const state = createSignState();
        for (let i = 0; i < 12; i++) handSign(poseHand(bendsFor(from)), state, hold);
        let spurious = false, arrivedAt = null, settledAt = null, f = 0;
        for (const step of transition(from, to, 5, stagger, 14, rand, noise)) {
          const sign = handSign(poseHand(step.bends), state, hold);
          if (step.arrived && arrivedAt === null) arrivedAt = f;
          if (arrivedAt === null && sign !== null && sign !== from) spurious = true;
          if (arrivedAt !== null && settledAt === null && sign === to) settledAt = f;
          f++;
        }
        runs++;
        if (spurious) bad++;
        // Only a clean run can say how long the honest wait is.
        else if (settledAt !== null && stagger === 2) { waitTotal += settledAt - arrivedAt; waited++; }
      }
    }
    process.stdout.write(`${((bad / runs) * 100).toFixed(1)}%`.padStart(20));
  }
  const wait = waited ? waitTotal / waited : NaN;
  const mark = hold === SIGN_HOLD ? '  <- today' : '';
  console.log(`${wait.toFixed(1).padStart(10)}f${(wait * 1000 / 30).toFixed(0).padStart(9)}ms`
    + `${(wait * 1000 / 20).toFixed(0).padStart(9)}ms${mark}`);
}
console.log();
