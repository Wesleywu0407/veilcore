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
  // Out to the drawing side, where the torso rule below does not reach, so this
  // still measures the forward limit on its own.
  const result = constrainRuneReach({ x: -0.9, y: 3.1, z: -2 }, shoulder, armSpan, {});
  assert.equal(result.z, shoulder.z + armSpan * RUNE_REACH.forward);
});

test('the right arm also keeps a finite outward reach', () => {
  const result = constrainRuneReach({ x: -3, y: 3.1, z: 0.7 }, shoulder, armSpan, {});
  assert.equal(result.x, shoulder.x - armSpan * RUNE_REACH.ownSide);
});

// ─── Out of the chest ─────────────────────────────────────────────────────────
//
// The forward limit alone lets a point on the centre line sit 0.18 of an arm in
// front of the shoulder, which is inside the ribs. These pin down the rule that
// keeps the wrist outside the body, and pin down that it does so by moving the
// hand along the line of sight and nowhere else.

const halfWidth = Math.abs(shoulder.x);

test('a hand on the centre line is pushed clear of the chest', () => {
  const result = constrainRuneReach({ x: 0, y: 3.1, z: 0.1 }, shoulder, armSpan, {});
  // Straight down the centre line the torso is at its deepest, so the clearance
  // is the full radius plus the margin.
  assert.equal(result.z, halfWidth + armSpan * RUNE_REACH.torsoClearance);
  assert.ok(result.z > shoulder.z + armSpan * RUNE_REACH.forward, 'and further than the forward limit alone');
});

test('the push is forward only — x and y are left where the stroke put them', () => {
  const target = { x: 0.1, y: 2.4, z: 0 };
  const result = constrainRuneReach(target, shoulder, armSpan, {});
  // Through the shoulder-relative round trip, so exact equality is not on offer.
  assert.ok(Math.abs(result.x - target.x) < 1e-12, 'the hand stays under the stroke on screen');
  assert.equal(result.y, target.y);
  assert.ok(result.z > target.z);
});

test('the chest is deepest at the centre and shallower toward the shoulder', () => {
  const middle = constrainRuneReach({ x: 0, y: 3.1, z: 0 }, shoulder, armSpan, {});
  const outboard = constrainRuneReach({ x: -0.2, y: 3.1, z: 0 }, shoulder, armSpan, {});
  assert.ok(middle.z > outboard.z, 'a circle, not a slab');
});

test('a hand out beside the body is not pushed forward at all', () => {
  const target = { x: -0.6, y: 3.1, z: 0.25 };
  const result = constrainRuneReach(target, shoulder, armSpan, {});
  assert.ok(Math.abs(result.x) > halfWidth, 'the fixture really is outside the torso');
  assert.equal(result.z, target.z);
});

test('a hand already well in front of the chest is untouched', () => {
  const target = { x: 0, y: 3.1, z: 0.95 };
  const result = constrainRuneReach(target, shoulder, armSpan, {});
  assert.equal(result.z, target.z);
});

test('a shoulder measured on the centre line disables the torso rule rather than dividing by it', () => {
  const centred = { x: 0, y: 2.92, z: 0 };
  const result = constrainRuneReach({ x: 0, y: 3.1, z: -2 }, centred, armSpan, {});
  assert.equal(result.z, armSpan * RUNE_REACH.forward);
  assert.ok(Number.isFinite(result.z));
});
