import test from 'node:test';
import assert from 'node:assert/strict';

import { createInputMode, SIGN_MODES } from '../js/spell-room/input-mode.js';
import { FINGER_CHAINS } from '../js/spell-room/fingers.js';
import { COUNTING, SIGN_HOLD } from '../js/spell-room/hand-sign.js';

const SEGMENTS = [0.45, 0.30, 0.25];
const FIST_DEGREES = [90, 100, 70];

function poseHand(bends) {
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

/** A left hand holding up `count` fingers, beside a right hand doing anything. */
function pair(count) {
  const bends = { thumb: 1 };
  COUNTING.forEach((name, i) => { bends[name] = i < count ? 0 : 1; });
  return [
    { side: 'left', landmarks: poseHand(bends) },
    { side: 'right', landmarks: poseHand({}) },
  ];
}

function hold(input, hands, frames = SIGN_HOLD) {
  let last;
  for (let i = 0; i < frames; i++) last = input.update(hands);
  return last;
}

test('one finger on the off hand frees the rune hand', () => {
  const input = createInputMode();
  assert.equal(hold(input, pair(1)).mode, 'magic');
});

test('two fingers take up the bow', () => {
  const input = createInputMode();
  assert.equal(hold(input, pair(2)).mode, 'bow');
});

test('a closed off hand is a guard', () => {
  const input = createInputMode();
  hold(input, pair(2));
  assert.equal(hold(input, pair(0)).mode, 'fist');
});

test('changing the sign changes the mode, and reports it once', () => {
  const input = createInputMode();
  hold(input, pair(1));
  const changing = hold(input, pair(2));
  assert.deepEqual(changing, { mode: 'bow', previous: 'magic', changed: true });
  const steady = input.update(pair(2));
  assert.deepEqual(steady, { mode: 'bow', previous: 'bow', changed: false });
});

test('an unrecognised count holds the mode instead of dumping it', () => {
  const input = createInputMode();
  hold(input, pair(2));
  // Three fingers means nothing; the bow must stay up.
  assert.equal(hold(input, pair(3), SIGN_HOLD * 3).mode, 'bow');
});

test('one hand alone is the drawing hand', () => {
  const input = createInputMode();
  hold(input, pair(2));
  assert.equal(input.update([{ side: null, landmarks: poseHand({}) }]).mode, 'magic');
});

test('no hands at all falls back to runes rather than holding a weapon', () => {
  const input = createInputMode();
  hold(input, pair(2));
  assert.equal(input.update([]).mode, 'magic');
  assert.equal(input.update(null).mode, 'magic');
});

test('the sign is readable, so a HUD can show what the hand is asking for', () => {
  const input = createInputMode();
  assert.equal(input.sign, null);
  hold(input, pair(2));
  assert.equal(input.sign, 2);
});

test('reset forgets the sign as well as the mode', () => {
  const input = createInputMode();
  hold(input, pair(2));
  input.reset();
  assert.equal(input.mode, 'magic');
  assert.equal(input.sign, null);
});

test('every mode the signs can ask for is one the duel knows', () => {
  for (const mode of Object.values(SIGN_MODES)) {
    assert.ok(['magic', 'bow', 'fist'].includes(mode), `unknown mode ${mode}`);
  }
});
