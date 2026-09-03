import test from 'node:test';
import assert from 'node:assert/strict';

import { createBowAim } from '../js/spell-room/aim.js';
import { createFocus, FOCUS } from '../js/spell-room/aim.js';

test('the nock position becomes the centre of relative bow aim', () => {
  const aim = createBowAim();
  const reticle = aim.update({ x: 0.18, y: 0.72 }, 0, 1000);
  assert.deepEqual(reticle, { x: 0.5, y: 0.5 });
  assert.equal(aim.active, true);
});

test('moving the bow hand steers from the nock position and stays on screen', () => {
  const aim = createBowAim({ gain: 10 });
  aim.update({ x: 0.5, y: 0.5 }, 0, 1000);
  const moved = aim.update({ x: 0.9, y: 0.1 }, 0, 2000);
  assert.ok(moved.x > 0.85 && moved.x <= 1, `x ${moved.x}`);
  assert.ok(moved.y < 0.15 && moved.y >= 0, `y ${moved.y}`);
});

test('resetting aim makes the next bow position a fresh centre', () => {
  const aim = createBowAim();
  aim.update({ x: 0.2, y: 0.3 }, 1, 1000);
  aim.update({ x: 0.4, y: 0.6 }, 1, 1100);
  aim.reset();
  assert.equal(aim.active, false);
  assert.deepEqual(aim.update({ x: 0.8, y: 0.1 }, 1, 1200), { x: 0.5, y: 0.5 });
});

test('changing the gain does not slide the crosshair', () => {
  // A hand held perfectly still while the lens closes must keep its aim: the
  // reticle is an offset times a gain, so halving the gain without moving the
  // origin would drag the crosshair halfway back to the middle -- losing your
  // target by holding still, which is the opposite of what focusing is for.
  const settle = (aim, wrist, scale, from) => {
    let now = from;
    for (let i = 0; i < 300; i++) aim.update(wrist, 1, now += 33, scale);
    return now;
  };
  const aim = createBowAim();
  const wrist = { x: 0.40, y: 0.44 };
  aim.update({ x: 0.30, y: 0.50 }, 1, 1000);
  let now = settle(aim, wrist, 1, 1033);
  const before = { ...aim.reticle };
  assert.ok(Math.abs(before.x - 0.5) > 0.05, 'the test needs an off-centre aim to be meaningful');

  // Close the lens from 55 degrees to 20 without moving a muscle.
  for (let fov = 55; fov >= 20; fov -= 0.5) aim.update(wrist, 1, now += 33, fov / 55);
  settle(aim, wrist, 20 / 55, now);
  assert.ok(Math.abs(aim.reticle.x - before.x) < 1e-3, `x slid ${aim.reticle.x - before.x}`);
  assert.ok(Math.abs(aim.reticle.y - before.y) < 1e-3, `y slid ${aim.reticle.y - before.y}`);
});

test('a lower gain moves the crosshair less for the same hand movement', () => {
  const travel = (scale) => {
    const aim = createBowAim();
    let now = 1000;
    for (let i = 0; i < 200; i++) aim.update({ x: 0.30, y: 0.5 }, 1, now += 33, scale);
    for (let i = 0; i < 400; i++) aim.update({ x: 0.36, y: 0.5 }, 1, now += 33, scale);
    return aim.reticle.x - 0.5;
  };
  const wide = travel(1);
  const tight = travel(20 / 55);
  assert.ok(tight > 0 && wide > 0, 'both should steer the same way');
  // Proportional to the gain, within what the filters leave behind.
  assert.ok(Math.abs(tight / wide - 20 / 55) < 0.02, `ratio ${tight / wide}`);
});

// ─── Focus ───────────────────────────────────────────────────────────────────
//
// The range's reward for holding still, which until now lived in practice.js
// beside a camera and could not be run without one.

/** Feed a wrist moving at a constant speed for `seconds`, at 30Hz. */
function hold(focus, speed, seconds) {
  const dt = 1 / 30;
  let x = 0.5;
  for (let i = 0; i < Math.round(seconds * 30); i++) {
    x += speed * dt;
    focus.update({ x, y: 0.5 }, dt);
  }
  return focus.value;
}

test('a hand held still settles, and keeps settling', () => {
  // It approaches 1 rather than arriving: at RISE 0.9 a perfectly still hand is
  // at 0.94 after three seconds and still climbing. Worth writing down, because
  // the last few percent of the lens are only there for someone who really
  // stopped -- and because a test that demanded 1.0 would be testing arithmetic
  // that does not exist.
  const three = createFocus();
  assert.ok(hold(three, 0, 3) > 0.9, `three seconds only reached ${three.value.toFixed(2)}`);
  const six = createFocus();
  assert.ok(hold(six, 0, 6) > three.value, 'holding longer did not settle further');
});

test('a hand moving in earnest earns none', () => {
  const focus = createFocus();
  assert.ok(hold(focus, FOCUS.SPEED * 1.5, 3) < 0.05, `settled at ${focus.value.toFixed(2)}`);
});

test('a slow drift costs SOME focus, not all of it', () => {
  // The reason this is a ramp and not a gate: creeping onto a target must not
  // throw the lens open.
  const focus = createFocus();
  const drift = hold(focus, (FOCUS.FLOOR + FOCUS.SPEED) / 2, 3);
  assert.ok(drift > 0.2 && drift < 0.8, `a half-speed drift settled at ${drift.toFixed(2)}`);
});

test('focus is lost faster than it is won', () => {
  // FALL above RISE on purpose: settling is earned and a twitch should cost it.
  const rising = createFocus();
  hold(rising, 0, 0.5);
  const falling = createFocus();
  hold(falling, 0, 4);                       // fully settled
  const lost = 1 - hold(falling, FOCUS.SPEED * 2, 0.5);
  assert.ok(lost > rising.value,
    `gained ${rising.value.toFixed(2)} in half a second but only lost ${lost.toFixed(2)}`);
});

test('forgetting drops the speed estimate as well as the focus', () => {
  // Otherwise the next draw inherits the last one's hand speed and opens the
  // lens for a hand that is already still.
  const focus = createFocus();
  hold(focus, FOCUS.SPEED * 2, 2);
  assert.ok(focus.speed > 0);
  focus.forget();
  assert.equal(focus.value, 0);
  assert.equal(focus.speed, 0);
});

test('a jump between draws is not read as speed', () => {
  // forget() drops the last wrist too, so the first frame after picking the bow
  // back up cannot produce a huge raw speed out of a hand that teleported.
  const focus = createFocus();
  hold(focus, 0, 3);
  focus.forget();
  focus.update({ x: 0.9, y: 0.9 }, 1 / 30);   // somewhere else entirely
  assert.equal(focus.speed, 0, 'the first frame after forgetting invented a speed');
});
