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
