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
// ...and from `bodySide` in preference to x where the body model could tell,
// because x has one failure and this feature walks straight into it: a guard
// holds both hands close together in front of you, which is exactly where a
// little noise swaps their x order. Read by x alone, the duel would then take
// its MODE from the wrong hand -- your rune hand's finger count deciding what
// weapon you hold.
//
// Note what is still NOT consulted: the DRAWING hand's fingers. The bow is
// loosed by opening the string hand, and mode is decided before the bow's own
// state machine runs -- a gate that read that hand's closure would drop out of
// 'bow' on the release frame and reset the draw before the shot was reported.

import { createSignState, forgetSign, handSign } from './hand-sign.js';
import { handsRaised, sideOf } from './pose.js';

/**
 * What each count on the off hand asks for.
 *
 * ── Why zero is not in here ──
 *
 * It used to be: zero fingers meant the guard. But zero is what a hand does
 * when it is not doing anything -- an arm hanging at your side reads as a
 * closed hand, so resting put the duel into a guard, silently, and there was
 * no gesture the player could think of that would explain it.
 *
 * The guard is a POSTURE now: both hands up, which is what a guard actually
 * looks like and what nobody does by accident. See handsRaised(). Zero joins
 * three and four in meaning "nothing recognised", which holds the current mode
 * rather than dumping the player somewhere they did not ask for.
 */
export const SIGN_MODES = Object.freeze({ 1: 'magic', 2: 'bow' });

/** The mode both hands held up asks for. */
export const GUARD_MODE = 'fist';

/** The player's left hand -- by the body where it could say, by x otherwise. */
const offHandOf = hands =>
  hands.find(hand => sideOf(hand) === 'left') ?? hands[0];

export function createInputMode() {
  let mode = 'magic';
  let raised = false;
  const offHand = createSignState();

  return {
    get mode() { return mode; },
    /** The settled count on the off hand, or null before one has settled. */
    get sign() { return offHand.sign ?? null; },
    /**
     * True while the GUARD is what the raised hands bought.
     *
     * Not simply "both hands are up" any more. Both hands are up for every
     * cast now -- one holding the count, one drawing -- so a HUD reading this
     * as the posture announced a guard over the top of a rune being drawn.
     * The posture is a necessary half of the answer and no longer the whole
     * of it.
     */
    get guarding() { return raised && mode === GUARD_MODE; },
    reset() {
      mode = 'magic';
      raised = false;
      forgetSign(offHand);
    },
    update(hands, pose = null) {
      let next = mode;

      // ── No off hand means no count, and it has to SAY so ──
      //
      // The count used to simply not be re-read when the off hand was not
      // there, which left the last settled one standing. Put your off hand
      // down and the duel still believed you were holding up two: it printed
      // that on the HUD next to a rune you were drawing, and now that the rune
      // gate asks the same question, it would have answered for a hand that
      // was not in the picture.
      //
      // Read BEFORE the posture, and always, because the posture now has to
      // ask what the count is before it can claim the hands. See below.
      const offHandUp = (hands?.length ?? 0) >= 2 ? offHandOf(hands) : null;
      if (!offHandUp) forgetSign(offHand);
      const sign = offHandUp ? handSign(offHandUp.landmarks ?? null, offHand) : null;

      // ── The posture wins, unless the off hand is asking for something ──
      //
      // This used to be read first and win outright, on the reasoning that a
      // player with both hands up is not also trying to show you a number.
      // That reasoning died the day the rune hand needed permission: the way
      // you cast is now left hand up holding one, right hand up drawing --
      // BOTH HANDS UP, every time, by design. Every rune anybody tried to draw
      // was taken by the guard before the magic branch could run, and the trail
      // simply never appeared. The bow had the same hole and always had: you
      // hold a bow with both hands up too.
      //
      // So a guard is both hands up and NOTHING ASKED FOR -- which is what two
      // fists are, since a fist counts zero and zero is not a weapon. It is
      // still safe from the failure that took the count out of the guard in the
      // first place, an arm resting at your side reading as a closed hand,
      // because a resting arm is not raised.
      raised = handsRaised(hands, pose, raised);
      if (raised && !SIGN_MODES[sign]) {
        const transition = { mode: GUARD_MODE, previous: mode, changed: GUARD_MODE !== mode };
        mode = GUARD_MODE;
        return transition;
      }

      if (!hands?.length) {
        // Nothing in frame. Runes need only the one hand, so that is the state
        // it is safe to be caught in.
        next = 'magic';
      } else if (hands.length === 1) {
        // One hand is the drawing hand by definition -- there is no off hand to
        // ask, and a bow or a guard needs two anyway. Whether it is allowed to
        // DRAW is a separate question, asked of the count: see updateHand().
        next = 'magic';
      } else {
        const asked = SIGN_MODES[sign];
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
