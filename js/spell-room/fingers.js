// ─── Spell Room — How closed each finger is ───────────────────────────────────
//
// Turns the 21 tracked hand landmarks into one number per finger: 0 straight,
// 1 closed. Plain maths on plain objects, so it is tested against synthetic
// hands rather than by holding a real one up to a camera.
//
// ── Why a chord-over-arc ratio and not an angle ──
//
// The obvious measure is the angle at each knuckle, but that needs the joint
// positions to be accurate in depth, and depth is the weakest number MediaPipe
// produces. Comparing the straight-line distance from knuckle to fingertip
// against the distance walked along the finger avoids depth almost entirely:
//
//     straight finger -> chord == arc          -> ratio 1
//     closed finger   -> tip comes back        -> ratio small
//
// It is also scale and rotation invariant for free, so a hand near the lens and
// a hand at arm's length read the same, and turning the wrist changes nothing.

import { dist3 } from "./vec.js";

/** MediaPipe hand landmarks, four to a finger, base to tip. */
export const FINGER_CHAINS = Object.freeze({
  thumb: Object.freeze([1, 2, 3, 4]),
  index: Object.freeze([5, 6, 7, 8]),
  middle: Object.freeze([9, 10, 11, 12]),
  ring: Object.freeze([13, 14, 15, 16]),
  pinky: Object.freeze([17, 18, 19, 20]),
});

export const FINGERS = Object.freeze(Object.keys(FINGER_CHAINS));

// The ends of the ratio, per finger.
//
// The straight end is not a guess: a finger held out has its chord equal to its
// arc, so the ratio is 1 by construction, and 0.97 is that with a little slack
// for landmark noise.
//
// The closed end IS a guess and is the one thing here worth measuring with a
// real hand -- make a fist, read the ratio, and put that number in. It is set
// where a curled finger's tip lands roughly back at its own knuckle. The thumb
// gets its own pair because it folds across the palm instead of rolling up, so
// its chord never collapses as far as a finger's does.
export const CURL_RANGE = Object.freeze({
  finger: Object.freeze({ straight: 0.97, closed: 0.45 }),
  thumb: Object.freeze({ straight: 0.98, closed: 0.72 }),
});

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * How far along the finger you have to walk to get from its knuckle to its tip,
 * against how far that is in a straight line.
 *
 * Returns 1 for a straight finger and falls toward 0 as it closes. Null when
 * the finger has no length to speak of, which is what a landmark dropout looks
 * like -- callers should hold their previous value rather than read that as a
 * fist.
 */
export function chordRatio(landmarks, chain) {
  if (!landmarks) return null;
  let arc = 0;
  for (let i = 0; i < chain.length - 1; i++) {
    const a = landmarks[chain[i]];
    const b = landmarks[chain[i + 1]];
    if (!a || !b) return null;
    arc += dist3(a, b);
  }
  if (!(arc > 1e-6)) return null;
  const chord = dist3(landmarks[chain[0]], landmarks[chain.at(-1)]);
  return chord / arc;
}

/**
 * One curl per finger: 0 straight, 1 closed.
 *
 * Mutates and returns `out` so this can run every frame without allocating.
 * Any finger the tracker could not resolve is left at whatever `out` already
 * held, for the same reason the tracker has a dropout grace window: a hand that
 * blinks for one frame has not made a fist.
 */
export function fingerCurls(landmarks, out = {}) {
  for (const name of FINGERS) {
    const ratio = chordRatio(landmarks, FINGER_CHAINS[name]);
    if (ratio === null) {
      out[name] = out[name] ?? 0;
      continue;
    }
    const range = name === "thumb" ? CURL_RANGE.thumb : CURL_RANGE.finger;
    out[name] = clamp01((range.straight - ratio) / (range.straight - range.closed));
  }
  return out;
}
