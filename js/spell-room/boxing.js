// ─── Veilcore — reading a fist ───────────────────────────────────────────────
//
// Two jobs, both pure. Which way the wrists are rolled, which decides whether
// two raised hands mean a bow or a pair of fists; and whether a fist has just
// been thrown at the lens.
//
// Like archery.js this file never touches the camera, the DOM, or the world.
// It takes `frame.hands` and a timestamp and returns numbers, so the whole feel
// can be tuned against synthetic input before anyone stands up.

import { LM } from "./vec.js";

export const BOXING = {
  // ── The roll ──────────────────────────────────────────────────────────────
  //
  // Tilt of the knuckle line off horizontal, in degrees. Upright (the fist eye
  // pointing at the ceiling, the way a hand grips a bow riser) reads near 90;
  // flat (the fist eye pointing left or right, the way a straight punch lands)
  // reads near 0. The gap between the two is a dead band, not a single 45:
  // a wrist parked on the boundary would otherwise flip modes every frame.
  UPRIGHT: 55,
  FLAT: 35,
  // Below this fraction of the hand's own span, the knuckle line is too
  // foreshortened to have an angle worth trusting -- which is exactly what a
  // fist pointed straight down the lens looks like. Saying nothing there is
  // the whole point: a punch must never be able to change which mode you are
  // in halfway through being thrown.
  MIN_KNUCKLE_SPAN: 0.35,

  // ── The punch ─────────────────────────────────────────────────────────────
  //
  // A fist driven at the lens grows. The question is what "grew" is measured
  // against, and the answer is a slow follower of that same hand's span: the
  // signal is compared to a low-passed copy of itself, which is a band-pass,
  // and a band-pass is how you separate a punch from a walk without ever
  // differentiating a noisy signal. (`scale` arrives unfiltered -- tracker.js
  // only smooths the index tip -- so a derivative here would be amplifying
  // jitter into phantom punches.)
  //
  // BASELINE_RATE is the cutoff. Worked at a 0.5s time constant, with a punch
  // taken as the span reaching 1.5x over 150ms and a lean as 10% per second:
  //
  //   punch  baseline reaches 1.13 in 150ms  ->  1.50 / 1.13 = 1.33
  //   lean   baseline lags by rate * tau     ->  1 + 0.10 * 0.5 = 1.05
  //
  // ON at 1.20 sits between them with room on both sides. These came off that
  // model of a punch rather than off a real arm in front of a real camera, so
  // they are the first numbers to move once this is on screen -- and moving
  // them changes how fast you can punch, because with no cooldown and no mana
  // cost the gap between ON and OFF is the only thing rationing the attack.
  BASELINE_RATE: 2.0,
  PUNCH_ON: 1.20,
  PUNCH_OFF: 1.08,
  // Where the arm is drawn fully extended. Past ON on purpose: the blow lands
  // partway through the travel, the way a real one does, and the fist keeps
  // going afterwards instead of stopping dead on the hit.
  REACH_FULL: 1.45,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Tilt of the knuckle line off horizontal, 0..90 degrees, or null when the
 * hand is too foreshortened to say.
 *
 * Measured across the palm, INDEX_MCP to PINKY_MCP, because the knuckles are
 * the part of a closed fist the model places most reliably -- the fingertips
 * are curled under and the thumb moves independently of the wrist's roll.
 * Unsigned: which end is higher depends on which hand it is, and both hands
 * mean the same thing here.
 */
export function knuckleTilt(landmarks) {
  if (!landmarks) return null;
  const index = landmarks[LM.INDEX_MCP];
  const pinky = landmarks[LM.PINKY_MCP];
  const wrist = landmarks[LM.WRIST];
  const middle = landmarks[LM.MIDDLE_MCP];
  if (!index || !pinky || !wrist || !middle) return null;

  const span = Math.hypot(wrist.x - middle.x, wrist.y - middle.y);
  if (!(span > 1e-6)) return null;
  const dx = pinky.x - index.x;
  const dy = pinky.y - index.y;
  if (Math.hypot(dx, dy) / span < BOXING.MIN_KNUCKLE_SPAN) return null;

  return (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
}

// NOT wired up any more. The duel used to pick between the bow and the fists by
// reading the roll of both wrists; it now reads a number held up on the off
// hand instead (see input-mode.js, which explains why). Kept, and kept tested,
// because the measurement is sound and the wrist roll may yet be worth having
// as a second way in -- but nothing calls it today.
/**
 * What two raised hands are holding: 'bow', 'fist', or null for "no opinion".
 *
 * Null is the common case and it is deliberate. A hand too foreshortened to
 * read, a wrist sitting in the dead band, or the two hands disagreeing all
 * come back null, and the caller is expected to hold whichever mode it was
 * already in. Requiring both wrists to agree is what makes the switch a
 * deliberate act rather than something a single misread frame can do to you.
 */
export function readStance(hands) {
  if (!hands || hands.length !== 2) return null;
  let vote = null;
  for (const hand of hands) {
    const tilt = knuckleTilt(hand?.landmarks);
    if (tilt === null) return null;
    const says = tilt >= BOXING.UPRIGHT ? 'bow' : tilt <= BOXING.FLAT ? 'fist' : null;
    if (says === null) return null;
    if (vote === null) vote = says;
    else if (vote !== says) return null;
  }
  return vote;
}

// ─── The punch, as a state machine ───────────────────────────────────────────
//
//   guard → thrown → (back below OFF) → guard
//
// One of these per hand, kept apart so that left and right can overlap. That
// overlap is the point: with a shared gate, throwing a left while the right is
// still out would be swallowed, and alternating punches would be slower than
// hammering one hand. Here they interleave, which is what makes a combination
// feel like a combination.

const HAND = () => ({ present: false, baseline: 0, ratio: 1, extension: 0, thrown: false, punched: false });

export function createBoxingState() {
  const state = { left: HAND(), right: HAND() };
  let last = 0;

  function rest(hand) {
    hand.present = false;
    hand.baseline = 0;
    hand.ratio = 1;
    hand.extension = 0;
    hand.thrown = false;
    hand.punched = false;
  }

  return {
    reset() {
      rest(state.left);
      rest(state.right);
      last = 0;
    },
    get left() { return state.left; },
    get right() { return state.right; },

    /**
     * @param hands frame.hands
     * @param now   performance.now()
     * @returns the same object every call, mutated in place. Each side carries
     *          `extension` (0..1, how far to throw the arm on screen) and
     *          `punched` (true for exactly one frame, when the blow lands).
     */
    update(hands, now) {
      // dt from the caller's clock rather than a fixed step, and capped: a tab
      // that was in the background comes back with a gap big enough to snap the
      // baseline onto a punch in a single frame.
      const dt = last ? Math.min((now - last) / 1000, 0.08) : 0;
      last = now;

      for (const side of ['left', 'right']) {
        const hand = state[side];
        const seen = hands?.find(candidate => candidate?.side === side);
        const scale = seen?.scale;
        hand.punched = false;

        if (!Number.isFinite(scale) || scale <= 0) {
          rest(hand);
          continue;
        }
        if (!hand.present) {
          // First frame this hand is up: the baseline IS the hand, or the very
          // first sample would read as an enormous punch out of nothing.
          hand.present = true;
          hand.baseline = scale;
        }

        hand.ratio = scale / Math.max(hand.baseline, 1e-6);
        hand.extension = clamp((hand.ratio - 1) / (BOXING.REACH_FULL - 1), 0, 1);
        if (!hand.thrown && hand.ratio >= BOXING.PUNCH_ON) {
          hand.thrown = true;
          hand.punched = true;
        } else if (hand.thrown && hand.ratio <= BOXING.PUNCH_OFF) {
          hand.thrown = false;
        }

        // Last, so a punch is always judged against the baseline as it stood
        // before this frame's sample was folded in.
        hand.baseline += (scale - hand.baseline) * Math.min(1, dt * BOXING.BASELINE_RATE);
      }

      return state;
    },
  };
}
