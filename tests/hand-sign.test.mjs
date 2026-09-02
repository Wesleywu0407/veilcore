import test from 'node:test';
import assert from 'node:assert/strict';

import { FINGER_CHAINS } from '../js/spell-room/fingers.js';
import {
  COUNTING, EXTENDED_OUT, EXTENDED_IN, SIGN_HOLD,
  createSignState, extendedFingers, handSign,
} from '../js/spell-room/hand-sign.js';

/**
 * A hand where each finger is bent by its own amount, so a sign can be posed
 * exactly. Same proportions as the finger tests: 45/30/25 segments bending
 * 90/100/70 degrees at a full fist.
 */
const SEGMENTS = [0.45, 0.30, 0.25];
const FIST_DEGREES = [90, 100, 70];

function poseHand(bends = {}) {
  const points = new Array(21).fill(null).map(() => ({ x: 0, y: 0, z: 0 }));
  points[0] = { x: 0, y: 0, z: 0 };
  Object.entries(FINGER_CHAINS).forEach(([name, chain], f) => {
    const closed = bends[name] ?? 0;
    let x = 0.02 * f;
    let y = 0.05;
    let angle = 0;
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

/** Everything curled except the named fingers. */
function showing(...open) {
  const bends = {};
  for (const name of COUNTING) bends[name] = open.includes(name) ? 0 : 1;
  bends.thumb = 1;
  return poseHand(bends);
}

function settle(hand, state, frames = SIGN_HOLD) {
  let sign = null;
  for (let i = 0; i < frames; i++) sign = handSign(hand, state);
  return sign;
}

test('a fist counts nothing', () => {
  assert.equal(settle(showing(), createSignState()), 0);
});

test('one finger out reads as one', () => {
  assert.equal(settle(showing('index'), createSignState()), 1);
});

test('two fingers out reads as two', () => {
  assert.equal(settle(showing('index', 'middle'), createSignState()), 2);
});

test('an open hand counts four, not five — the thumb does not vote', () => {
  // The thumb splays on its own while the others are still; letting it count
  // would turn every sign into two different signs.
  assert.equal(settle(showing('index', 'middle', 'ring', 'pinky'), createSignState()), 4);
  const state = createSignState();
  settle(showing('index', 'middle', 'ring', 'pinky'), state);
  assert.ok(!('thumb' in state.out), 'the thumb is never even asked');
});

test('a count is not believed until it has held', () => {
  const state = createSignState();
  // One frame of two fingers is not yet a two.
  assert.equal(handSign(showing('index', 'middle'), state), null);
  for (let i = 1; i < SIGN_HOLD; i++) handSign(showing('index', 'middle'), state);
  assert.equal(state.sign, 2, `expected 2 after ${SIGN_HOLD} frames`);
});

test('a single glitched frame does not change the sign', () => {
  const state = createSignState();
  settle(showing('index'), state);
  assert.equal(state.sign, 1);
  // One frame of nonsense in the middle of a steady hold.
  handSign(showing('index', 'middle', 'ring'), state);
  assert.equal(state.sign, 1, 'the settled sign survives one bad frame');
});

test('a real change does get through, once it holds', () => {
  const state = createSignState();
  settle(showing('index'), state);
  settle(showing('index', 'middle'), state);
  assert.equal(state.sign, 2);
});

test('a finger hovering on the threshold does not flicker the count', () => {
  // Straight enough to be out, then a hair less straight -- invisible on a
  // rendered hand, and it must not be a change of weapon.
  const state = createSignState();
  const bendFor = curl => {
    // Find a bend whose measured curl lands near the target.
    for (let b = 0; b <= 1; b += 0.005) {
      const probe = createSignState();
      extendedFingers(poseHand({ index: b }), probe);
      if (probe.curls.index >= curl) return b;
    }
    return 1;
  };
  const justOut = poseHand({ index: bendFor(EXTENDED_OUT + 0.02), middle: 1, ring: 1, pinky: 1 });
  const justIn = poseHand({ index: bendFor(EXTENDED_IN - 0.02), middle: 1, ring: 1, pinky: 1 });
  settle(justOut, state);
  const before = state.sign;
  for (let i = 0; i < 20; i++) settle(i % 2 ? justIn : justOut, state, 1);
  assert.equal(state.sign, before, 'wobbling inside the band changed the count');
});

test('a dropped hand holds the sign rather than reading as a fist', () => {
  const state = createSignState();
  settle(showing('index', 'middle'), state);
  for (let i = 0; i < 10; i++) handSign(null, state);
  assert.equal(state.sign, 2);
});

test('the hysteresis band is a band, not a point', () => {
  assert.ok(EXTENDED_IN > EXTENDED_OUT, 'without a gap there is nothing to debounce');
});
