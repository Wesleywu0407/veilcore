import test from 'node:test';
import assert from 'node:assert/strict';

import { makeOneEuro, makeDeadband, makeSteady } from '../js/spell-room/one-euro.js';

// The tunings the tracker actually uses, tested as themselves.
const TIP = { minCutoff: 1.2, beta: 0.015, dCutoff: 1.0 };                     // rune cursor
const ANCHOR = { minCutoff: 1.5, beta: 6.0, dCutoff: 1.0, deadband: 0.005 };  // an arm
const POSE = { minCutoff: 1.0, beta: 3.0, dCutoff: 1.0, deadband: 0.008 };    // a shoulder

const HZ = 15;                 // what the tracker manages in practice
const STEP = 1000 / HZ;
const FRAME_AT_WALKING_PACE = 1.2 / HZ;   // how far a real movement covers per frame

/** A deterministic wobble, so these numbers are the same every run. */
const noise = i => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return (x - Math.floor(x)) - 0.5;
};

/** Peak-to-peak of a held-still signal, in and out. */
function shake(make, config, amplitude, frames = 200) {
  const filter = make(config);
  let lo = Infinity, hi = -Infinity, rawLo = Infinity, rawHi = -Infinity;
  for (let i = 0; i < frames; i++) {
    const raw = 0.5 + noise(i) * amplitude;
    const out = filter.filter(raw, i * STEP);
    if (i < 40) continue;                                    // let it settle
    lo = Math.min(lo, out); hi = Math.max(hi, out);
    rawLo = Math.min(rawLo, raw); rawHi = Math.max(rawHi, raw);
  }
  return { raw: rawHi - rawLo, filtered: hi - lo };
}

/** Worst distance behind a steady sweep, in frames of that sweep. */
function lagInFrames(make, config, speed = 1.2, frames = 140) {
  const filter = make(config);
  let worst = 0;
  for (let i = 0; i < frames; i++) {
    const t = i * STEP;
    const raw = 0.1 + (speed * t) / 1000;
    const out = filter.filter(raw, t);
    if (i > 40) worst = Math.max(worst, Math.abs(raw - out));
  }
  return worst / (speed / HZ);
}

// Half a pixel on a 1080-tall screen, as a fraction of the frame. Below this
// nothing is on screen to see; the assertions are written in it so they say
// what they mean rather than quoting a bare decimal.
const HALF_A_PIXEL = 0.5 / 1080;

test('a held-still hand stops moving', () => {
  // One Euro alone left about half the wobble on a hand that was not moving --
  // see the test below. The deadband takes what is left under a pixel.
  const { filtered } = shake(makeSteady, ANCHOR, 0.008);
  assert.ok(filtered < HALF_A_PIXEL, `still shaking by ${filtered.toFixed(6)}`);
});

test('the lowpass alone could not do that', () => {
  // The measurement that sent this to a deadband in the first place.
  const { raw, filtered } = shake(makeOneEuro, TIP, 0.008);
  assert.ok(filtered > raw * 0.2,
    'if a bare lowpass were enough here, the deadband would be dead weight');
});

test('holding an arm still costs it nothing when it moves', () => {
  // The trade the whole thing is balanced against, and the reason beta is 6 and
  // not the 0.015 next door: at 0.02 this measured 2.28 frames behind.
  const behind = lagInFrames(makeSteady, ANCHOR);
  assert.ok(behind < 0.5, `${behind.toFixed(2)} frames behind a real swing`);
});

test('a shoulder is held still through a bigger wobble than a hand', () => {
  // It has to be: the hand target is now an offset FROM the shoulder, so noise
  // here moves the hand even when the hand is perfectly still.
  assert.ok(shake(makeSteady, POSE, 0.012).filtered < HALF_A_PIXEL);
});

test('a shoulder is allowed to lag, and a hand is not', () => {
  // These pull opposite ways on purpose. The shoulder is the thing the hand is
  // measured against, so it should be the slower and duller of the two -- a
  // shoulder that chased every sample would drag the hand around with it.
  // Measured at 1.3 frames, which is under a tenth of a second at 15Hz: a real
  // lean still arrives, and nothing in the picture is waiting on it.
  const shoulder = lagInFrames(makeSteady, POSE, 0.3);
  const hand = lagInFrames(makeSteady, ANCHOR);
  assert.ok(shoulder > hand, 'the anchor should be the steadier of the two');
  assert.ok(shoulder < 2, `${shoulder.toFixed(2)} frames is too slow even for a shoulder`);
});

test('a movement past the band is not swallowed, only shortened by it', () => {
  // A hard band would sit still and then jump the whole band at once.
  const band = makeDeadband(0.01);
  band.filter(0);
  assert.equal(band.filter(0.006), 0, 'inside the band, nothing moves');
  assert.ok(Math.abs(band.filter(0.05) - 0.04) < 1e-9, 'outside it, moves less the band');
  assert.ok(Math.abs(band.filter(0.05) - 0.04) < 1e-9, 'and then holds, not creeps');
});

test('the band is symmetric, so a held hand does not creep one way', () => {
  const up = makeDeadband(0.01); up.filter(0.5);
  const down = makeDeadband(0.01); down.filter(0.5);
  assert.ok(Math.abs((up.filter(0.56) - 0.5) + (down.filter(0.44) - 0.5)) < 1e-9);
});

// ── The band has to get out of the way ───────────────────────────────────────

/** How much of a slow, steady movement survives the filter. */
function follows(config, speed, frames = 160) {
  const filter = makeSteady(config);
  let first = null, last = null;
  for (let i = 0; i < frames; i++) {
    const t = i * STEP;
    const out = filter.filter(0.3 + (speed * t) / 1000, t);
    if (i === 40) first = out;
    last = out;
  }
  const asked = (speed * (frames - 41) * STEP) / 1000;
  return (last - first) / asked;      // 1.0 is perfect following
}

test('a slow deliberate movement is not eaten by the band', () => {
  // This is the "sticky" complaint. A fixed band throws away every step
  // smaller than itself, and a slow movement is made entirely of those -- so
  // the hand sits still, breaks free, sits still again.
  const kept = follows(ANCHOR, 0.08);        // a hand drifting across in ~12s
  assert.ok(kept > 0.9, `only ${(kept * 100).toFixed(0)}% of a slow move survived`);
});

test('and a normal movement is untouched', () => {
  assert.ok(follows(ANCHOR, 1.2) > 0.95);
});

test('while a held-still hand is still dead still', () => {
  // The trade this is all balanced against: opening the band on movement must
  // not reopen it on noise, or the shake comes straight back.
  assert.ok(shake(makeSteady, ANCHOR, 0.008).filtered < HALF_A_PIXEL);
});

test('the band is what does it, not the lowpass', () => {
  // Same signal, no band: the wobble comes back. Proof the band is load bearing
  // rather than decoration on top of a filter that was already enough.
  const noBand = { ...ANCHOR, deadband: 0 };
  assert.ok(shake(makeSteady, noBand, 0.008).filtered > HALF_A_PIXEL * 4);
});
