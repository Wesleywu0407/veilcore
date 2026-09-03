import test from 'node:test';
import assert from 'node:assert/strict';

import { createInputMode, SIGN_MODES, GUARD_MODE } from '../js/spell-room/input-mode.js';
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

// Shoulders at 0.4, a fifth of the frame apart. Wrists ABOVE that is a smaller
// y, because y grows down the picture.
const SHOULDERS = {
  left: { shoulder: { x: 0.4, y: 0.4 } },
  right: { shoulder: { x: 0.6, y: 0.4 } },
};
/** The same pair of hands, with wrists placed at a height. */
function at(hands, y) {
  return hands.map(hand => ({ ...hand, wrist: { x: hand.side === 'left' ? 0.4 : 0.6, y } }));
}

test('a hand resting at your side is no longer a guard', () => {
  // It was, and that was the problem: zero fingers is what a hand does when it
  // is doing nothing, so putting your arm down armed a guard you never asked
  // for and could not connect to anything you had done.
  const input = createInputMode();
  hold(input, pair(2));
  assert.equal(hold(input, pair(0)).mode, 'bow', 'an empty hand holds the mode');
});

test('both hands raised is the guard', () => {
  const input = createInputMode();
  hold(input, pair(1));
  assert.equal(input.update(at(pair(1), 0.15), SHOULDERS).mode, 'fist');
  assert.ok(input.guarding);
});

test('the posture beats the number, whatever the number is', () => {
  // A player holding both hands up is not also showing you a two.
  const input = createInputMode();
  hold(input, pair(2));
  assert.equal(input.update(at(pair(2), 0.15), SHOULDERS).mode, 'fist');
});

test('one hand up is not a guard', () => {
  const input = createInputMode();
  const half = at(pair(1), 0.15);
  half[1].wrist.y = 0.7;                       // the other hand stays down
  assert.equal(input.update(half, SHOULDERS).mode, 'magic');
});

test('hands hovering at the shoulder line do not flicker the weapon', () => {
  // The most expensive thing a wobble can do here is change weapon, so the
  // threshold to raise and the threshold to drop are deliberately different.
  const input = createInputMode();
  input.update(at(pair(1), 0.15), SHOULDERS);        // clearly up
  assert.ok(input.guarding);
  input.update(at(pair(1), 0.375), SHOULDERS);       // sagging, inside the band
  assert.ok(input.guarding, 'it should not let go this easily');
  input.update(at(pair(1), 0.45), SHOULDERS);        // properly down
  assert.ok(!input.guarding);
});

test('no body means no posture, and the signs still work', () => {
  const input = createInputMode();
  assert.equal(hold(input, at(pair(2), 0.15)).mode, 'bow', 'without a pose to ask');
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
  assert.ok(['magic', 'bow', 'fist'].includes(GUARD_MODE));
});

test('the off hand keeps being read while the guard is up', () => {
  // Otherwise the sign freezes for as long as you guard, and dropping your
  // hands arms whatever you were showing before you raised them -- a weapon
  // appearing at the exact moment you stopped guarding.
  const input = createInputMode();
  hold(input, pair(2));                                  // bow
  assert.equal(input.sign, 2);

  // Guard, while the off hand quietly changes to a one underneath.
  for (let i = 0; i < SIGN_HOLD + 2; i++) {
    input.update(at(pair(1), 0.15), SHOULDERS);
  }
  assert.equal(input.mode, 'fist', 'still guarding');
  assert.equal(input.sign, 1, 'but the hand has been read all along');

  // Hands down: the mode that comes back is the one being shown NOW.
  assert.equal(input.update(pair(1)).mode, 'magic');
});

test('crossed hands take the mode from the right hand, not the leftmost one', () => {
  // A guard holds both hands close together in front of you, which is exactly
  // where a little noise swaps their x order. Sided by x alone the duel would
  // read its MODE off the rune hand -- your drawing fingers picking the weapon.
  const input = createInputMode();
  const [left, right] = pair(2);               // the LEFT hand is showing two
  // x has them the wrong way round; the body model knows better.
  const crossed = [
    { ...right, side: 'left', bodySide: 'right' },
    { ...left, side: 'right', bodySide: 'left' },
  ];
  assert.equal(hold(input, crossed).mode, 'bow', 'the two was on the off hand');
});

test('and falls back to x when the body could not say', () => {
  const input = createInputMode();
  assert.equal(hold(input, pair(2)).mode, 'bow', 'no bodySide on these at all');
});
