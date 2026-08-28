// ─── Spell Room — Shared vocabulary ───────────────────────────────────────────
//
// Deliberately dependency-free. Both tracker.js (which pulls in MediaPipe) and
// magic.js (which must stay testable in plain node) import from here, so the
// recognition code never inherits a webcam dependency it does not need.
//
// If you ever find yourself unable to unit-test magic.js, check whether
// something crept into this file that should not be here.

/** MediaPipe hand landmark indices. The model returns 21; these are the useful ones. */
export const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_MCP: 5,     // knuckle — a stable scale reference
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_TIP: 16,
  PINKY_TIP: 20,
};

export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Distance including MediaPipe's z.
 *
 * The 2D distance between two landmarks shrinks as the hand rotates away from
 * the camera, and it does not shrink at the same rate for every pair — a palm
 * seen edge-on foreshortens hard while the thumb-index gap barely changes. Any
 * ratio built from 2D lengths therefore drifts as the wrist turns, which makes
 * a fixed threshold mean different things at different angles.
 *
 * z is in roughly the same units as x, relative to the wrist, so including it
 * gives a length that stays put when the hand rotates.
 */
export function dist3(a, b) {
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.hypot(a.x - b.x, a.y - b.y, dz);
}

export function clamp(v, min = 0, max = 1) {
  return v < min ? min : v > max ? max : v;
}
