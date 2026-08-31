import test from 'node:test';
import assert from 'node:assert/strict';

import { RUNE_REACH, constrainRuneReach } from '../js/arena/reach-limit.js';

const shoulder = { x: -0.27, y: 2.92, z: 0 };
const armSpan = 1.07;

test('a reachable point in front of the drawing shoulder is unchanged', () => {
  const target = { x: 0.05, y: 3.1, z: 0.7 };
  const result = constrainRuneReach(target, shoulder, armSpan, {});
  assert.ok(Math.abs(result.x - target.x) < 1e-12);
  assert.equal(result.y, target.y);
  assert.equal(result.z, target.z);
});

test('the right hand stops at the opposite side of the torso', () => {
  const result = constrainRuneReach({ x: 2, y: 3.1, z: 0.7 }, shoulder, armSpan, {});
  assert.equal(result.x, shoulder.x + armSpan * RUNE_REACH.acrossBody);
  assert.equal(result.y, 3.1);
});

test('the rune hand cannot be solved behind the shoulder', () => {
  const result = constrainRuneReach({ x: 0, y: 3.1, z: -2 }, shoulder, armSpan, {});
  assert.equal(result.z, shoulder.z + armSpan * RUNE_REACH.forward);
});

test('the right arm also keeps a finite outward reach', () => {
  const result = constrainRuneReach({ x: -3, y: 3.1, z: 0.7 }, shoulder, armSpan, {});
  assert.equal(result.x, shoulder.x - armSpan * RUNE_REACH.ownSide);
});
