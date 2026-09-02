// ─── Spell Room — Body landmarks ──────────────────────────────────────────────
//
// MediaPipe's pose model returns 33 points for the whole body. The duel needs
// six of them: two shoulders, two elbows, two wrists, plus the hips for a
// stance. Everything below is plain maths on plain objects so it can be tested
// without a camera, the same way the recogniser is.
//
// ── Sides come from x, never from the model's own label ──
//
// The webcam mirrors and tracker.js un-mirrors x once on the way in. MediaPipe
// assigns LEFT_/RIGHT_ before that flip, so its labels are the mirror of what
// the player's body is actually doing -- exactly the trap the hand code already
// documents. So this file decides sides the same way the hands do: after the
// flip, the larger x is the player's right.
//
// Only ONE decision is made from x -- which of the two arm chains is the right
// arm. The model is internally consistent about 11/13/15 being one arm and
// 12/14/16 the other, so the elbow and wrist follow their own shoulder rather
// than each being placed independently, and a hand crossing the body cannot
// swap half a limb to the wrong side.

/** MediaPipe pose landmark indices. The model returns 33; these are the useful ones. */
export const POSE = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
};

// MediaPipe reports how sure it is that a joint is actually in shot. An elbow
// behind the torso still gets coordinates, and they are a guess; feeding that
// guess to the IK as a bend hint is worse than falling back to the fixed pole,
// because it moves and the fixed pole does not.
export const MIN_VISIBILITY = 0.5;

function point(landmark) {
  if (!landmark) return null;
  if (!Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) return null;
  if (landmark.visibility !== undefined && landmark.visibility < MIN_VISIBILITY) return null;
  return { x: landmark.x, y: landmark.y, z: landmark.z ?? 0 };
}

function chain(landmarks, shoulder, elbow, wrist, hip) {
  return {
    shoulder: point(landmarks[shoulder]),
    elbow: point(landmarks[elbow]),
    wrist: point(landmarks[wrist]),
    hip: point(landmarks[hip]),
  };
}

/**
 * Split one frame of pose landmarks into the player's own left and right arms.
 *
 * `landmarks` must already be un-mirrored. Returns null when there is no usable
 * body, which callers should read as "keep doing whatever you did without a
 * body" rather than as an error.
 */
export function readPose(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length <= POSE.RIGHT_HIP) return null;

  const a = chain(landmarks, POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW, POSE.LEFT_WRIST, POSE.LEFT_HIP);
  const b = chain(landmarks, POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST, POSE.RIGHT_HIP);

  // Without both shoulders there is nothing to compare, and a side picked from
  // one shoulder would flip the moment the other came back into shot.
  if (!a.shoulder || !b.shoulder) return null;

  return a.shoulder.x <= b.shoulder.x ? { left: a, right: b } : { left: b, right: a };
}

/**
 * The direction the elbow sits in, measured from the shoulder.
 *
 * Handed to the arm IK as a bend hint rather than as a position: the model's
 * depth is the weakest number it produces, but which way the elbow is offset
 * from the shoulder is exactly what the solver needs to stop putting it through
 * the ribs. Returns null when the elbow is missing or sits on top of the
 * shoulder, where the direction is meaningless.
 */
export function elbowHint(arm) {
  if (!arm?.shoulder || !arm?.elbow) return null;
  const x = arm.elbow.x - arm.shoulder.x;
  const y = arm.elbow.y - arm.shoulder.y;
  const length = Math.hypot(x, y);
  if (!(length > 1e-4)) return null;
  return { x, y, length };
}

/**
 * Which of the player's hands a lone tracked hand is, decided by the BODY.
 *
 * Two hands in shot sort by x and that settles it. One hand cannot be placed
 * that way -- you can hold your right hand out on the left of the frame -- so
 * the tracker reported `side: null`, and every consumer read that as the right
 * one. In the duel that is true by construction: the rune hand IS the right
 * hand. In the mirror it meant raising your left arm moved the character's
 * right, every time.
 *
 * The body model does know. Its wrists have already been split into the
 * player's own sides by comparing SHOULDERS, which does not care where a hand
 * has wandered to, so matching the hand to the nearer of them is an answer
 * rather than a guess. Returns null when there is no body to ask, or when the
 * two are close enough together that the nearer one means nothing -- and null
 * still means "do not guess", exactly as it did before.
 *
 * Note this is not MediaPipe's handedness label, which is computed before the
 * un-mirroring and is wrong here on purpose. See AGENTS.md 4.
 */
export function sideOfWrist(wrist, pose) {
  const left = pose?.left?.wrist;
  const right = pose?.right?.wrist;
  if (!wrist || !left || !right) return null;
  const toLeft = Math.hypot(wrist.x - left.x, wrist.y - left.y);
  const toRight = Math.hypot(wrist.x - right.x, wrist.y - right.y);
  if (!(Math.abs(toLeft - toRight) > 1e-3)) return null;
  return toLeft < toRight ? 'left' : 'right';
}

/**
 * Holds a lone hand's side steady while the body decides.
 *
 * sideOfWrist() answers only when there is a body in that frame, and the body
 * model does not run on every frame -- it is sampled, and it drops a joint the
 * moment an arm crosses the torso. Read raw, that makes the side of a single
 * raised hand flicker: null, 'left', null, 'left'. A consumer that guesses on
 * the nulls swaps arms mid-gesture, and one that does not, stutters.
 *
 * So: the first real answer sticks, and nothing but a fresh answer replaces it.
 * `forget()` on a dropout, so putting one hand down and raising the other does
 * not inherit the first one's side.
 */
export function createSideLatch() {
  let side = null;
  return {
    get side() { return side; },
    /** Take one frame's answer -- `null` meaning "the body did not say". */
    settle(asked) {
      if (asked === 'left' || asked === 'right') side = asked;
      return side;
    },
    forget() { side = null; },
  };
}
