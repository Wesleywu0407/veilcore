import test from 'node:test';
import assert from 'node:assert/strict';

import { createBowAim } from '../js/spell-room/aim.js';

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
