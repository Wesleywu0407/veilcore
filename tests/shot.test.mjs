import test from 'node:test';
import assert from 'node:assert/strict';

import { raySphereDistance, rayVerticalCapsuleDistance } from '../js/arena/shot.js';

const origin = { x: 0, y: 1.5, z: 5 };
const forward = { x: 0, y: 0, z: -1 };

test('raySphereDistance returns the first hit in front and refuses a miss', () => {
  assert.equal(raySphereDistance(origin, forward, { x: 0, y: 1.5, z: 0 }, 1), 4);
  assert.equal(raySphereDistance(origin, forward, { x: 3, y: 1.5, z: 0 }, 1), null);
});

test('a vertical capsule catches torso and cap hits but not empty space', () => {
  assert.equal(rayVerticalCapsuleDistance(origin, forward, 0, 0, 0.8, 2.7, 0.75), 4.25);
  const downward = { x: 0, y: -Math.SQRT1_2, z: -Math.SQRT1_2 };
  assert.ok(rayVerticalCapsuleDistance({ x: 0, y: 4, z: 2 }, downward, 0, 0, 0.8, 2.7, 0.75) !== null);
  assert.equal(rayVerticalCapsuleDistance(origin, forward, 3, 0, 0.8, 2.7, 0.75), null);
});
