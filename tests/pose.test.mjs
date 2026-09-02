import test from 'node:test';
import assert from 'node:assert/strict';

import { POSE, readPose, elbowHint, sideOfWrist } from '../js/spell-room/pose.js';

/**
 * A body standing square to the camera, already un-mirrored: the player's right
 * side is at the larger x. MediaPipe's own LEFT_ indices are deliberately put
 * on the player's RIGHT here, which is what the mirror actually does and what
 * readPose has to see through.
 */
function body({ leftIndexX = 0.62, rightIndexX = 0.38, visibility = 0.9 } = {}) {
  const points = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility }));
  points[POSE.LEFT_SHOULDER] = { x: leftIndexX, y: 0.40, z: 0, visibility };
  points[POSE.LEFT_ELBOW] = { x: leftIndexX + 0.06, y: 0.55, z: 0, visibility };
  points[POSE.LEFT_WRIST] = { x: leftIndexX + 0.04, y: 0.70, z: 0, visibility };
  points[POSE.LEFT_HIP] = { x: leftIndexX - 0.02, y: 0.75, z: 0, visibility };
  points[POSE.RIGHT_SHOULDER] = { x: rightIndexX, y: 0.40, z: 0, visibility };
  points[POSE.RIGHT_ELBOW] = { x: rightIndexX - 0.06, y: 0.55, z: 0, visibility };
  points[POSE.RIGHT_WRIST] = { x: rightIndexX - 0.04, y: 0.70, z: 0, visibility };
  points[POSE.RIGHT_HIP] = { x: rightIndexX + 0.02, y: 0.75, z: 0, visibility };
  return points;
}

test('the arm at the larger x is the player right arm, whatever MediaPipe called it', () => {
  const pose = readPose(body());
  // LEFT_SHOULDER was placed at 0.62, so the model's "left" arm is the player's
  // right one. Getting this backwards is the bug AGENTS.md already paid for once.
  assert.equal(pose.right.shoulder.x, 0.62);
  assert.equal(pose.left.shoulder.x, 0.38);
});

test('the elbow and wrist follow their own shoulder, not their own x', () => {
  // A hand thrown right across the body: the wrist ends up on the far side.
  const points = body();
  points[POSE.RIGHT_WRIST] = { x: 0.9, y: 0.5, z: 0, visibility: 0.9 };
  const pose = readPose(points);
  // The crossed wrist stays on the arm it belongs to. Placing each joint from
  // its own x would have handed it to the other limb mid-stroke.
  assert.equal(pose.left.wrist.x, 0.9);
  assert.equal(pose.left.shoulder.x, 0.38);
});

test('a joint the model cannot see is dropped rather than guessed', () => {
  const points = body();
  points[POSE.LEFT_ELBOW] = { x: 0.7, y: 0.55, z: 0, visibility: 0.1 };
  const pose = readPose(points);
  assert.equal(pose.right.elbow, null);
  assert.ok(pose.right.shoulder, 'the rest of the arm survives');
});

test('no body at all reads as null, not as a body at the origin', () => {
  assert.equal(readPose(null), null);
  assert.equal(readPose([]), null);
  const points = body();
  points[POSE.LEFT_SHOULDER] = { x: 0.62, y: 0.4, z: 0, visibility: 0.1 };
  assert.equal(readPose(points), null, 'one shoulder alone cannot place a side');
});

test('the elbow hint points from the shoulder toward the elbow', () => {
  const pose = readPose(body());
  const hint = elbowHint(pose.right);
  assert.ok(hint.x > 0, 'the right elbow is out to the player right');
  assert.ok(hint.y > 0, 'and below the shoulder, y being down the image');
  assert.ok(Math.abs(hint.length - Math.hypot(hint.x, hint.y)) < 1e-12);
});

test('an elbow on top of its shoulder has no direction to report', () => {
  assert.equal(elbowHint({ shoulder: { x: 0.5, y: 0.5 }, elbow: { x: 0.5, y: 0.5 } }), null);
  assert.equal(elbowHint({ shoulder: { x: 0.5, y: 0.5 }, elbow: null }), null);
  assert.equal(elbowHint(null), null);
});

// ── Placing a lone hand ───────────────────────────────────────────────────────

const at = (x, y) => ({ x, y, z: 0 });
const bodyWrists = (leftX, rightX) => ({
  left: { wrist: at(leftX, 0.5) },
  right: { wrist: at(rightX, 0.5) },
});

test('a lone hand takes the side of the body wrist it is nearest', () => {
  // Un-mirrored, the player's right hand has the larger x.
  assert.equal(sideOfWrist(at(0.72, 0.5), bodyWrists(0.3, 0.7)), 'right');
  assert.equal(sideOfWrist(at(0.28, 0.5), bodyWrists(0.3, 0.7)), 'left');
});

test('raising the left hand alone does not come back as the right one', () => {
  // The bug this exists for: one hand in shot was always read as the right.
  assert.equal(sideOfWrist(at(0.31, 0.44), bodyWrists(0.3, 0.7)), 'left');
});

test('a hand carried across the body still belongs to its own arm', () => {
  // Right hand reaching left past the midline: x alone would call it the left.
  assert.equal(sideOfWrist(at(0.66, 0.5), bodyWrists(0.3, 0.7)), 'right');
});

test('no body means no guess, which is what null has always meant', () => {
  assert.equal(sideOfWrist(at(0.5, 0.5), null), null);
  assert.equal(sideOfWrist(at(0.5, 0.5), { left: { wrist: at(0.3, 0.5) } }), null);
  assert.equal(sideOfWrist(null, bodyWrists(0.3, 0.7)), null);
});

test('a dead heat is not an answer either', () => {
  assert.equal(sideOfWrist(at(0.5, 0.5), bodyWrists(0.3, 0.7)), null);
});
