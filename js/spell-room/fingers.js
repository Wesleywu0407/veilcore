// ─── Spell Room — What the hand is doing ──────────────────────────────────────
//
// Two readings off the same 21 landmarks: how closed each finger is, and which
// way the palm is facing. Plain maths on plain objects, so both are tested
// against synthetic hands rather than by holding a real one up to a camera.
//
// Everything here stays in MediaPipe's own space -- x right, y DOWN, z depth,
// all already un-mirrored by tracker.js. Getting from there to the world is the
// caller's job, because only the caller owns the camera.
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


// ─── Which way the palm is facing ─────────────────────────────────────────────
//
// The wrist's POSITION has always been tracked, and now so is each finger, but
// between them sat the thing that actually makes a hand look like yours: its
// rotation. A hand in the right place with the right fingers still reads as
// somebody else's if the palm is facing the wrong way.
//
// Three knuckles and the wrist are enough to pin it down, and they are the four
// landmarks that move least when the fingers curl -- so the palm does not swing
// about as you close your hand, which is exactly the coupling to avoid.

const PALM = Object.freeze({ WRIST: 0, INDEX_MCP: 5, MIDDLE_MCP: 9, PINKY_MCP: 17 });

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function norm(v) {
  const length = Math.hypot(v.x, v.y, v.z);
  return length > 1e-9 ? { x: v.x / length, y: v.y / length, z: v.z / length } : null;
}

/**
 * An orthonormal frame for the palm:
 *
 *   along   wrist toward the middle knuckle -- the way the fingers point
 *   across  pinky knuckle toward the index knuckle
 *   normal  out of the back of the hand
 *
 * Built with Gram-Schmidt from `along` and `across`, so the frame stays square
 * even though a real hand's knuckle line is never exactly perpendicular to it.
 * Returns null for a hand too flat or too small to give a direction, which is
 * what a bad frame of tracking looks like -- callers should hold their previous
 * frame rather than snapping the wrist to some default.
 */
export function palmBasis(landmarks) {
  if (!landmarks) return null;
  const wrist = landmarks[PALM.WRIST];
  const index = landmarks[PALM.INDEX_MCP];
  const middle = landmarks[PALM.MIDDLE_MCP];
  const pinky = landmarks[PALM.PINKY_MCP];
  if (!wrist || !index || !middle || !pinky) return null;

  const along = norm(sub(middle, wrist));
  const spread = norm(sub(index, pinky));
  if (!along || !spread) return null;

  const normal = norm(cross(along, spread));
  if (!normal) return null;                 // knuckles collinear with the wrist
  const across = norm(cross(normal, along));
  if (!across) return null;

  return { along, across, normal };
}
