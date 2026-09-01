import test from 'node:test';
import assert from 'node:assert/strict';

import { FINGERS, FINGER_CHAINS, CURL_RANGE, chordRatio, fingerCurls } from '../js/spell-room/fingers.js';

/**
 * A synthetic hand, shaped like a real one.
 *
 * Segments run 45/30/25 of the finger and the joints bend 90/100/70 degrees at
 * a full fist, which are the proportions of an actual hand. `closed` scales
 * those angles, so 0 is flat and 1 is a fist. A uniform bend per joint is NOT
 * good enough here: past about 200 degrees of total roll the fingertip swings
 * back out and the chord grows again, which would test the opposite of what the
 * measure is for.
 */
const SEGMENTS = [0.45, 0.30, 0.25];
const FIST_DEGREES = [90, 100, 70];

function hand(closed = 0, { scale = 0.09 } = {}) {
  const points = new Array(21).fill(null).map(() => ({ x: 0, y: 0, z: 0 }));
  points[0] = { x: 0, y: 0, z: 0 };
  FINGERS.forEach((name, f) => {
    const chain = FINGER_CHAINS[name];
    let x = 0.02 * f;
    let y = 0.05;
    let angle = 0;
    points[chain[0]] = { x, y, z: 0 };
    for (let i = 1; i < chain.length; i++) {
      angle += (FIST_DEGREES[i - 1] * closed * Math.PI) / 180;
      x += Math.sin(angle) * SEGMENTS[i - 1] * scale;
      y += Math.cos(angle) * SEGMENTS[i - 1] * scale;
      points[chain[i]] = { x, y, z: 0 };
    }
  });
  return points;
}

test('a straight finger has its chord equal to its arc', () => {
  const ratio = chordRatio(hand(0), FINGER_CHAINS.index);
  assert.ok(Math.abs(ratio - 1) < 1e-9, `expected 1, got ${ratio}`);
});

test('the ratio falls as the finger rolls up', () => {
  const straight = chordRatio(hand(0), FINGER_CHAINS.index);
  const half = chordRatio(hand(0.5), FINGER_CHAINS.index);
  const closed = chordRatio(hand(1), FINGER_CHAINS.index);
  assert.ok(straight > half && half > closed, `${straight} > ${half} > ${closed}`);
  // A real fist lands here; CURL_RANGE.finger.closed is set just above it.
  assert.ok(Math.abs(closed - 0.371) < 0.01, `expected about 0.371, got ${closed}`);
});

test('the ratio does not care how big the hand is on screen', () => {
  // The same pose, twice the size: a hand near the lens must not read as a fist.
  const near = chordRatio(hand(0.6, { scale: 0.18 }), FINGER_CHAINS.middle);
  const far = chordRatio(hand(0.6, { scale: 0.04 }), FINGER_CHAINS.middle);
  assert.ok(Math.abs(near - far) < 1e-9, `${near} vs ${far}`);
});

test('an open hand reads as no curl anywhere', () => {
  const curls = fingerCurls(hand(0));
  for (const name of FINGERS) {
    assert.equal(curls[name], 0, `${name} should be 0, got ${curls[name]}`);
  }
});

test('a closed hand reads as full curl on the fingers', () => {
  const curls = fingerCurls(hand(1));
  for (const name of ['index', 'middle', 'ring', 'pinky']) {
    assert.equal(curls[name], 1, `${name} should be 1, got ${curls[name]}`);
  }
});

test('curl rises monotonically as the hand closes', () => {
  let previous = -1;
  for (const bend of [0, 0.2, 0.4, 0.6, 0.8, 0.9, 1.0]) {
    const curl = fingerCurls(hand(bend)).index;
    assert.ok(curl >= previous, `curl went backwards at bend ${bend}`);
    previous = curl;
  }
  assert.equal(previous, 1);
});

test('curl is clamped to 0..1 at both ends', () => {
  const over = fingerCurls(hand(1.4));
  const under = fingerCurls(hand(-0.4));
  for (const name of FINGERS) {
    assert.ok(over[name] <= 1 && over[name] >= 0, `${name} out of range: ${over[name]}`);
    assert.ok(under[name] <= 1 && under[name] >= 0, `${name} out of range: ${under[name]}`);
  }
});

test('the thumb is scored on its own range, not the fingers\'', () => {
  // At one ratio the two ranges must disagree, or the thumb pair is decorative.
  assert.notEqual(CURL_RANGE.thumb.closed, CURL_RANGE.finger.closed);
  const points = hand(0);
  // Fold only the thumb.
  const bent = hand(0);
  const chain = FINGER_CHAINS.thumb;
  bent[chain[3]] = { x: bent[chain[0]].x, y: bent[chain[0]].y + 0.02, z: 0 };
  assert.ok(fingerCurls(bent).thumb > fingerCurls(points).thumb);
});

test('a dropped hand holds the previous curl rather than reading as a fist', () => {
  const out = fingerCurls(hand(0.8));
  const held = { ...out };
  fingerCurls(null, out);
  for (const name of FINGERS) assert.equal(out[name], held[name]);
});

test('a finger with a missing landmark keeps its previous value', () => {
  const out = fingerCurls(hand(0.8));
  const before = out.ring;
  const broken = hand(0.8);
  broken[FINGER_CHAINS.ring[2]] = null;
  fingerCurls(broken, out);
  assert.equal(out.ring, before);
  assert.ok(out.index > 0, 'the other fingers still update');
});

test('a hand collapsed to a point does not divide by zero', () => {
  const flat = new Array(21).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0 }));
  const out = fingerCurls(flat, {});
  for (const name of FINGERS) assert.ok(Number.isFinite(out[name]));
});

// ─── The palm's own frame ─────────────────────────────────────────────────────

import { palmBasis } from '../js/spell-room/fingers.js';

const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = v => Math.hypot(v.x, v.y, v.z);

/** A flat hand, fingers along +y, knuckles along +x, so the palm faces -z. */
function flatHand() {
  const p = new Array(21).fill(null).map(() => ({ x: 0, y: 0, z: 0 }));
  p[0] = { x: 0, y: 0, z: 0 };        // wrist
  p[5] = { x: 0.03, y: 0.08, z: 0 };  // index knuckle
  p[9] = { x: 0.00, y: 0.09, z: 0 };  // middle knuckle
  p[17] = { x: -0.03, y: 0.07, z: 0 }; // pinky knuckle
  return p;
}

test('the palm frame is orthonormal', () => {
  const b = palmBasis(flatHand());
  for (const v of [b.along, b.across, b.normal]) {
    assert.ok(Math.abs(len(v) - 1) < 1e-9, `not unit length: ${len(v)}`);
  }
  assert.ok(Math.abs(dot(b.along, b.across)) < 1e-9);
  assert.ok(Math.abs(dot(b.along, b.normal)) < 1e-9);
  assert.ok(Math.abs(dot(b.across, b.normal)) < 1e-9);
});

test('along points from the wrist toward the knuckles', () => {
  const b = palmBasis(flatHand());
  assert.ok(b.along.y > 0.9, `expected mostly +y, got ${JSON.stringify(b.along)}`);
});

test('across runs pinky to index', () => {
  const b = palmBasis(flatHand());
  assert.ok(b.across.x > 0.9, `expected mostly +x, got ${JSON.stringify(b.across)}`);
});

test('turning the hand over flips the palm normal', () => {
  const up = palmBasis(flatHand());
  const over = flatHand();
  // Mirror the knuckle line: the same hand, rolled 180 degrees.
  over[5].x = -over[5].x;
  over[17].x = -over[17].x;
  const flipped = palmBasis(over);
  assert.ok(dot(up.normal, flipped.normal) < -0.9,
    `normals should oppose, got ${dot(up.normal, flipped.normal)}`);
});

test('rolling the wrist rotates the frame without moving along', () => {
  const flat = palmBasis(flatHand());
  const rolled = flatHand();
  // Swing the knuckle line out of the xy plane: a wrist roll.
  rolled[5] = { x: 0.02, y: 0.08, z: -0.02 };
  rolled[17] = { x: -0.02, y: 0.07, z: 0.02 };
  const b = palmBasis(rolled);
  assert.ok(dot(flat.along, b.along) > 0.99, 'the fingers still point the same way');
  assert.ok(dot(flat.normal, b.normal) < 0.95, 'but the palm has turned');
});

test('the palm frame does not swing about when the fingers close', () => {
  // The four landmarks it uses are the wrist and three knuckles, none of which
  // a curl moves much. If this ever fails, closing your hand will also spin it.
  const open = palmBasis(hand(0));
  const shut = palmBasis(hand(1));
  assert.ok(dot(open.normal, shut.normal) > 0.999, `normal drifted: ${dot(open.normal, shut.normal)}`);
  assert.ok(dot(open.along, shut.along) > 0.999, `along drifted: ${dot(open.along, shut.along)}`);
});

test('a hand with no usable spread reports nothing rather than a wrong frame', () => {
  assert.equal(palmBasis(null), null);
  const collapsed = flatHand();
  collapsed[5] = { x: 0, y: 0.08, z: 0 };
  collapsed[17] = { x: 0, y: 0.08, z: 0 };   // knuckles on top of each other
  assert.equal(palmBasis(collapsed), null);
  const missing = flatHand();
  missing[9] = null;
  assert.equal(palmBasis(missing), null);
});
