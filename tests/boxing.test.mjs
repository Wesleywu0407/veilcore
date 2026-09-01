import test from 'node:test';
import assert from 'node:assert/strict';

import { BOXING, knuckleTilt, readStance, createBoxingState } from '../js/spell-room/boxing.js';
import { createInputMode } from '../js/spell-room/input-mode.js';
import { LM } from '../js/spell-room/vec.js';

// A hand posed by hand. `tilt` is the knuckle line's angle off horizontal in
// degrees; `span` is the knuckle line's length as a fraction of the hand's own
// wrist-to-middle-knuckle length, which is what goes to zero when a fist is
// pointed straight down the lens.
function hand({ side = 'right', tilt = 0, span = 1, scale = 0.1 } = {}) {
  const landmarks = [];
  landmarks[LM.WRIST] = { x: 0.5, y: 0.5 };
  landmarks[LM.MIDDLE_MCP] = { x: 0.5, y: 0.5 - scale };
  const across = span * scale;
  const radians = (tilt * Math.PI) / 180;
  landmarks[LM.INDEX_MCP] = { x: 0.5, y: 0.5 };
  landmarks[LM.PINKY_MCP] = {
    x: 0.5 + across * Math.cos(radians),
    y: 0.5 + across * Math.sin(radians),
  };
  return { side, scale, landmarks, wrist: landmarks[LM.WRIST] };
}

// ─── The roll ────────────────────────────────────────────────────────────────

test('knuckleTilt reads a flat fist near zero and an upright one near ninety', () => {
  assert.ok(knuckleTilt(hand({ tilt: 0 }).landmarks) < 1);
  assert.ok(knuckleTilt(hand({ tilt: 90 }).landmarks) > 89);
  assert.ok(Math.abs(knuckleTilt(hand({ tilt: 45 }).landmarks) - 45) < 0.5);
});

test('knuckleTilt is unsigned, so both hands read the same roll alike', () => {
  assert.ok(Math.abs(knuckleTilt(hand({ tilt: 70 }).landmarks)
    - knuckleTilt(hand({ tilt: -70 }).landmarks)) < 1e-9);
});

test('a foreshortened fist has no opinion rather than a noisy one', () => {
  const collapsed = BOXING.MIN_KNUCKLE_SPAN / 2;
  assert.equal(knuckleTilt(hand({ span: collapsed }).landmarks), null);
  assert.equal(knuckleTilt(null), null);
  assert.equal(knuckleTilt([]), null);
});

test('readStance needs both wrists to agree', () => {
  const flat = [hand({ side: 'left', tilt: 5 }), hand({ side: 'right', tilt: 5 })];
  const upright = [hand({ side: 'left', tilt: 85 }), hand({ side: 'right', tilt: 85 })];
  assert.equal(readStance(flat), 'fist');
  assert.equal(readStance(upright), 'bow');
  assert.equal(readStance([flat[0], upright[1]]), null);
});

test('readStance says nothing inside the dead band', () => {
  const middle = (BOXING.FLAT + BOXING.UPRIGHT) / 2;
  assert.equal(readStance([hand({ side: 'left', tilt: middle }), hand({ side: 'right', tilt: middle })]), null);
  assert.equal(readStance(null), null);
  assert.equal(readStance([hand()]), null);
});

// ─── The mode it feeds ───────────────────────────────────────────────────────

const both = tilt => [hand({ side: 'left', tilt }), hand({ side: 'right', tilt })];

test('rolling the wrists moves between bow and fist, once each way', () => {
  const input = createInputMode();
  assert.equal(input.update(both(85)).mode, 'bow');
  assert.deepEqual(input.update(both(5)), { mode: 'fist', previous: 'bow', changed: true });
  assert.deepEqual(input.update(both(5)), { mode: 'fist', previous: 'fist', changed: false });
  assert.deepEqual(input.update(both(85)), { mode: 'bow', previous: 'fist', changed: true });
});

test('an unreadable frame holds the stance rather than flipping it', () => {
  const input = createInputMode();
  input.update(both(5));
  const dead = (BOXING.FLAT + BOXING.UPRIGHT) / 2;
  assert.equal(input.update(both(dead)).mode, 'fist');
  assert.equal(input.update([hand({ side: 'left', span: 0 }), hand({ side: 'right', span: 0 })]).mode, 'fist');
  assert.equal(input.update(both(5)).mode, 'fist');
});

test('one hand still draws runes whatever the wrists are doing', () => {
  const input = createInputMode();
  input.update(both(5));
  assert.deepEqual(input.update([hand({ tilt: 5 })]), { mode: 'magic', previous: 'fist', changed: true });
});

// ─── The punch ───────────────────────────────────────────────────────────────

// Feed one hand a run of spans and collect the frames it called a punch.
function drive(state, spans, { side = 'right', step = 1000 / 30 } = {}) {
  const landed = [];
  let now = 1000;
  for (const scale of spans) {
    now += step;
    const fists = state.update([hand({ side, scale })], now);
    if (fists[side].punched) landed.push(fists[side].ratio);
  }
  return landed;
}

const steady = (value, frames) => Array.from({ length: frames }, () => value);
// A fist driven out over `frames` and pulled back over as many again.
const jab = (peak, frames = 5) => [
  ...Array.from({ length: frames }, (_, i) => 0.1 * (1 + (peak - 1) * ((i + 1) / frames))),
  ...Array.from({ length: frames }, (_, i) => 0.1 * (peak - (peak - 1) * ((i + 1) / frames))),
];

test('a fist driven at the lens lands exactly one punch', () => {
  const state = createBoxingState();
  const landed = drive(state, [...steady(0.1, 20), ...jab(1.5)]);
  assert.equal(landed.length, 1);
  assert.ok(landed[0] >= BOXING.PUNCH_ON);
});

test('holding a fist out does not keep punching', () => {
  const state = createBoxingState();
  const landed = drive(state, [...steady(0.1, 20), ...steady(0.16, 40)]);
  assert.equal(landed.length, 1);
});

test('two jabs land twice, because the hand came back between them', () => {
  const state = createBoxingState();
  const landed = drive(state, [...steady(0.1, 20), ...jab(1.5), ...jab(1.5)]);
  assert.equal(landed.length, 2);
});

test('walking toward the camera is not a punch', () => {
  const state = createBoxingState();
  // Ten percent a second for four seconds -- further than anyone leans, and
  // slow enough that the baseline stays under it the whole way.
  const creep = [];
  for (let frame = 0; frame < 120; frame++) creep.push(0.1 * (1 + 0.1 * (frame / 30)));
  assert.deepEqual(drive(state, [...steady(0.1, 20), ...creep]), []);
});

test('a hand appearing does not read as a punch out of nothing', () => {
  const state = createBoxingState();
  assert.deepEqual(drive(state, [0.3, 0.3, 0.3]), []);
});

test('the arm travels with the fist and is out before the blow lands', () => {
  const state = createBoxingState();
  state.update([hand({ side: 'right', scale: 0.1 })], 1000);
  assert.equal(state.right.extension, 0);
  const at = ratio => {
    const fists = state.update([hand({ side: 'right', scale: 0.1 * ratio })], 1000);
    return fists.right.extension;
  };
  assert.ok(at(BOXING.PUNCH_ON) > 0 && at(BOXING.PUNCH_ON) < 1);
  assert.ok(at(BOXING.REACH_FULL) > 0.999);
  assert.equal(at(BOXING.REACH_FULL + 1), 1);
});

test('the two hands punch independently', () => {
  const state = createBoxingState();
  let now = 1000;
  const feed = (left, right) => {
    now += 1000 / 30;
    return state.update([
      hand({ side: 'left', scale: 0.1 * left }),
      hand({ side: 'right', scale: 0.1 * right }),
    ], now);
  };
  for (let i = 0; i < 20; i++) feed(1, 1);
  // The right stays out while the left is thrown: with a shared gate the left
  // would be swallowed, which is what would make a combination slower than
  // hammering one hand.
  assert.equal(feed(1, 1.5).right.punched, true);
  const both = feed(1.5, 1.5);
  assert.equal(both.left.punched, true);
  assert.equal(both.right.punched, false);
});

test('a hand leaving the frame drops its state', () => {
  const state = createBoxingState();
  drive(state, steady(0.1, 20));
  assert.equal(state.right.present, true);
  state.update([], 2000);
  assert.equal(state.right.present, false);
  assert.equal(state.right.extension, 0);
});
