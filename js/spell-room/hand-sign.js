// ─── Spell Room — Reading a hand sign ─────────────────────────────────────────
//
// Counts how many fingers are held out, so the off hand can say which mode the
// duel is in: one finger for runes, two for the bow. It is built on the same
// curl measure the fingers themselves are driven by, so a finger the character
// is visibly straightening is a finger this counts.
//
// ── Why counting needs hysteresis and pointing does not ──
//
// A curl of 0.34 versus 0.36 is invisible on a rendered hand -- the finger is
// very slightly straighter, and that is all. Put a threshold at 0.35 and the
// same two frames become "one finger" and "two fingers", and the duel changes
// weapon. Every quantity that gets rounded down to a decision needs a gap
// between the two directions it can cross, and something that has to see the
// new value hold before it believes it.
//
// That is what makes this file worth existing rather than a `curl < 0.35` at
// the call site.

import { FINGERS, fingerCurls } from './fingers.js';

// A finger has to fall below OUT to start counting and rise above IN to stop.
// The gap is the hysteresis: inside it, whatever was last decided stands.
export const EXTENDED_OUT = 0.30;
export const EXTENDED_IN = 0.50;

// How many frames a different count has to survive before it is believed.
//
// ── Four was not slower than a person changing their mind ──
//
// That was the reasoning, and it was wrong about what a person changing their
// mind looks like. Fingers do not uncurl together: opening a fist into a two,
// the index leads and the other three trail by a few frames each, so the hand
// genuinely IS a one for an instant on the way. Nothing is misread when that
// happens -- the shape really was there -- and at four frames the duel settled
// on it and changed weapon before the hand had finished arriving.
//
// Measured with `npm run sign`, against how far apart the fingers leave the old
// shape, which is the whole mechanism:
//
//   hold   1f apart   2f apart   3f apart   wait after the hand arrives
//      4     66.7%      100%       100%     --
//      6      0.0%      66.7%      100%     0 frames
//      8      0.0%      16.7%      66.7%    1.2f,  40ms at 30Hz
//     10      0.0%       0.0%      33.3%    2.8f,  94ms at 30Hz
//     12      0.0%       0.0%       0.0%    4.8f, 161ms at 30Hz
//
// Ten, because a wrong weapon costs more than a tenth of a second does, and
// this file's own opening argument is that the expensive thing a wobble can do
// here is change weapon. If it ever feels sluggish, the table says where to go
// and the answer is not to widen EXTENDED_OUT/IN -- that band is about noise on
// a still finger, and this is about a finger that is genuinely moving.
export const SIGN_HOLD = 10;

/** The counting fingers. The thumb is left out: it tucks and splays on its own
 * while the others are still, and every count it joins becomes two counts. */
export const COUNTING = Object.freeze(FINGERS.filter(name => name !== 'thumb'));

/**
 * Which fingers are held out, with hysteresis against the previous answer.
 *
 * `state` is carried between calls and mutated in place; pass the same object
 * every frame. A missing hand leaves it exactly as it was, for the same reason
 * the curls do: one dropped frame is not a change of mind.
 */
export function extendedFingers(landmarks, state) {
  if (!state.curls) state.curls = {};
  if (!state.out) state.out = {};
  if (!landmarks) return state.out;

  fingerCurls(landmarks, state.curls);
  for (const name of COUNTING) {
    const curl = state.curls[name];
    if (curl <= EXTENDED_OUT) state.out[name] = true;
    else if (curl >= EXTENDED_IN) state.out[name] = false;
    // Between the two, the previous answer stands.
  }
  return state.out;
}

/**
 * How many fingers are held out, once the count has settled.
 *
 * Returns null until a count has survived SIGN_HOLD frames, so a caller can
 * tell "not sure yet" from "sure it is zero" -- which matters, because zero
 * fingers is a fist and a fist means something.
 *
 * `hold` is the constant, and is a parameter only so a probe can sweep it --
 * `npm run sign` prints the false-trigger rate and the wait against it. Nothing
 * in the game passes it.
 */
export function handSign(landmarks, state, hold = SIGN_HOLD) {
  const out = extendedFingers(landmarks, state);
  let count = 0;
  for (const name of COUNTING) if (out[name]) count++;

  if (count === state.pending) {
    state.held = (state.held ?? 0) + 1;
  } else {
    state.pending = count;
    state.held = 1;
  }
  if (state.held >= hold) state.sign = count;
  return state.sign ?? null;
}

/** A fresh, empty state for one hand. */
export function createSignState() {
  return { curls: {}, out: {}, pending: null, held: 0, sign: null };
}

/**
 * Forget the count. For when the hand that was making it is GONE, which is a
 * different thing from a hand that dropped out for a frame -- extendedFingers()
 * holds through the second on purpose, and this is the first.
 *
 * Without it the last settled count outlives the hand: put your off hand down
 * and the duel still believes you are holding up two, which it will happily
 * print on the HUD and gate a cast on. The curls are left alone; they are
 * rebuilt from the next hand that arrives.
 */
export function forgetSign(state) {
  state.pending = null;
  state.held = 0;
  state.sign = null;
}
