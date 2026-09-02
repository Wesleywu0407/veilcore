// The webcam has three consumers that must never run together, and the off hand
// says which one is running by holding up a number:
//
//   fist (0 fingers)  -- a guard, which is what two raised fists already are
//   one finger        -- the rune hand is free to draw
//   two fingers       -- the bow
//
// ── Why a count and not the roll of the wrists ──
//
// This used to read the wrists: knuckles upright meant the bow, knuckles inward
// meant fists. It was silent whenever the two wrists disagreed, which near the
// boundary is most frames, and silence meant "hold whatever was running" -- so
// the mode you got depended on the mode you were already in, and there was no
// way to see, from your own hand, which one that was. A held-up number is a
// thing the player can look at and be sure of.
//
// Sides come from x position, never from MediaPipe's handedness label; the
// webcam mirrors and the label is computed before the flip. See AGENTS.md 4.
//
// Note what is still NOT consulted: the DRAWING hand's fingers. The bow is
// loosed by opening the string hand, and mode is decided before the bow's own
// state machine runs -- a gate that read that hand's closure would drop out of
// 'bow' on the release frame and reset the draw before the shot was reported.

import { createSignState, handSign } from './hand-sign.js';

/** What each count on the off hand asks for. */
export const SIGN_MODES = Object.freeze({ 0: 'fist', 1: 'magic', 2: 'bow' });

export function createInputMode() {
  let mode = 'magic';
  const offHand = createSignState();

  return {
    get mode() { return mode; },
    /** The settled count on the off hand, or null before one has settled. */
    get sign() { return offHand.sign ?? null; },
    reset() {
      mode = 'magic';
      offHand.pending = null;
      offHand.held = 0;
      offHand.sign = null;
    },
    update(hands) {
      let next = mode;

      if (!hands?.length) {
        // Nothing in frame. Runes need only the one hand, so that is the state
        // it is safe to be caught in.
        next = 'magic';
      } else if (hands.length === 1) {
        // One hand is the drawing hand by definition -- there is no off hand to
        // ask, and a bow or a guard needs two anyway.
        next = 'magic';
      } else {
        const left = hands.find(hand => hand.side === 'left') ?? hands[0];
        const asked = SIGN_MODES[handSign(left?.landmarks ?? null, offHand)];
        // An unrecognised count -- three fingers, or a hand mid-change -- holds
        // whatever is running rather than dumping the player somewhere they did
        // not ask for.
        if (asked) next = asked;
      }

      const transition = { mode: next, previous: mode, changed: next !== mode };
      mode = next;
      return transition;
    },
  };
}
