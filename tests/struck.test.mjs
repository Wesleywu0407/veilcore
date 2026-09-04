import test from 'node:test';
import assert from 'node:assert/strict';

import { struckScale, STRUCK, STRUCK_TOTAL } from '../js/arena/struck.js';

// The failure this guards against is not a wrong easing curve, it is a target
// that never comes back -- which on a range is indistinguishable from the range
// being broken, and only shows up after somebody has already hit something.

test('a target nobody has hit is full size', () => {
  assert.equal(struckScale(Infinity), 1);
  assert.equal(struckScale(STRUCK_TOTAL + 5000), 1);
});

test('the hit itself is the biggest the target ever is', () => {
  assert.equal(struckScale(0), 1 + STRUCK.SWELL);
  // And it is the maximum, not merely large -- a curve that peaked later would
  // put the flash after the arrow instead of on it.
  for (let t = 0; t <= STRUCK_TOTAL; t += 5) {
    assert.ok(struckScale(t) <= 1 + STRUCK.SWELL + 1e-9, `bigger than the flash at ${t}ms`);
  }
});

test('it goes all the way away, and stays away long enough to notice', () => {
  const gone = [];
  for (let t = 0; t <= STRUCK_TOTAL; t += 5) if (struckScale(t) === 0) gone.push(t);
  assert.ok(gone.length > 0, 'the target never actually disappeared');
  const span = gone.at(-1) - gone[0];
  assert.ok(span >= STRUCK.GONE - 10,
    `only away for ${span}ms of the ${STRUCK.GONE}ms it should be`);
});

test('and it comes back', () => {
  // The one that matters. An off-by-one in the phase arithmetic leaves a range
  // that loses a target every time you hit one.
  assert.equal(struckScale(STRUCK_TOTAL), 1);
  assert.ok(struckScale(STRUCK_TOTAL - 1) < 1, 'it was already back before it finished rising');
});

test('the size never jumps', () => {
  // Each phase has to hand over at the value the next one starts at, or the
  // target pops. Walking it at 1ms and asking that no step is visible catches
  // every boundary at once.
  let previous = struckScale(0);
  for (let t = 1; t <= STRUCK_TOTAL + 100; t++) {
    const now = struckScale(t);
    assert.ok(Math.abs(now - previous) < 0.02,
      `jumped from ${previous.toFixed(3)} to ${now.toFixed(3)} at ${t}ms`);
    previous = now;
  }
});

test('it is never negative, and never silently huge', () => {
  for (let t = -50; t <= STRUCK_TOTAL + 500; t += 3) {
    const scale = struckScale(t);
    assert.ok(scale >= 0 && scale <= 1 + STRUCK.SWELL + 1e-9, `${scale} at ${t}ms`);
  }
});
