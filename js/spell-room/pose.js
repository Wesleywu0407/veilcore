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
  NOSE: 0,
  // The model's own left/right again, and again not to be believed. Read as an
  // unordered pair and sorted by x, the same way the arms are.
  EARS: [7, 8],
};

// Ratio to radians. A ratio of 0.5 is a head turned about halfway, and 1.55
// puts that near 45 degrees, which is where it feels right to a person.
export const HEAD_GAIN = 1.55;
// A neck stops. Past this the estimator is saturating anyway -- both ears stop
// being visible and the ratio stops meaning much -- so clamping here is honest
// rather than merely safe.
export const HEAD_LIMIT = 1.05;   // 60 degrees

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
export function createLatch() {
  let held = null;
  return {
    get value() { return held; },
    /** Take one frame's answer -- `null` meaning "the body did not say". */
    settle(asked) {
      if (asked !== null && asked !== undefined) held = asked;
      return held;
    },
    forget() { held = null; },
  };
}

/** A latch that will only ever hold a side. */
export function createSideLatch() {
  const latch = createLatch();
  return {
    get side() { return latch.value; },
    settle(asked) {
      return latch.settle(asked === 'left' || asked === 'right' ? asked : null);
    },
    forget() { latch.forget(); },
  };
}

// How much cheaper one pairing has to be than the other before it is believed,
// in frame widths. Below this the two hands are close enough together that the
// nearer body wrist means nothing, and a bare comparison would flip every frame.
const CROSS_MARGIN = 0.02;

/**
 * Whether two hands in shot are CROSSED -- the left one in the picture being
 * the player's right, and the other way about.
 *
 * Two hands are sided by x, and that is right almost always and cheap always.
 * It has one failure, and it is not a rare one in a mirror: fold your arms, or
 * reach across yourself, and the sides swap. The duel never noticed because
 * archery never crosses the arms -- but a body that is supposed to copy you
 * has to survive you doing an ordinary thing with your arms.
 *
 * Read as an assignment rather than two separate nearest-wrist questions: each
 * body wrist can only be one hand, so compare the two possible pairings by
 * total distance and take the cheaper. Asking each hand independently lets both
 * of them claim the same wrist, which is worse than x-sorting rather than
 * better.
 *
 * `low` and `high` are the two hands' wrists, sorted by x. Returns null when
 * there is no body to ask or the two pairings are too close to call, which
 * callers should read as "keep whatever x said".
 */
export function handsCrossed(low, high, pose) {
  const left = pose?.left?.wrist;
  const right = pose?.right?.wrist;
  if (!low || !high || !left || !right) return null;
  const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // Un-mirrored, the player's left has the smaller x -- so "not crossed" pairs
  // the low hand with the left wrist.
  const straight = gap(low, left) + gap(high, right);
  const crossed = gap(low, right) + gap(high, left);
  if (Math.abs(straight - crossed) < CROSS_MARGIN) return null;
  return crossed < straight;
}

/**
 * How wide the shoulders look, right now, in the picture.
 *
 * The picture has no scale of its own: the same arm is twice as many pixels
 * when you lean in. Everything measured off the body has to be divided by
 * something that scales the same way, and the shoulders are the sturdiest thing
 * there is -- always both in shot when readPose() returns at all, and they do
 * not move relative to each other whatever the arms are doing.
 */
export function shoulderSpan(pose) {
  const a = pose?.left?.shoulder;
  const b = pose?.right?.shoulder;
  if (!a || !b) return 0;
  const span = Math.hypot(a.x - b.x, a.y - b.y);
  // Too small to divide by: the player is far away, side on, or the model has
  // put both shoulders in the same place. Callers fall back to the box.
  return span > 0.04 ? span : 0;
}

/**
 * Which way the head is turned, in radians, positive toward the player's OWN
 * left. Null when there is no readable face.
 *
 * Yaw only. Pitch is available from the same three points and is not returned,
 * because it cannot be had honestly without calibration: a nose sits below the
 * ear line at rest by an amount that differs per face, so "looking level" is a
 * per-person constant and any fixed one is somebody else's face. Yaw has no
 * such offset -- a head facing the lens is symmetric, whoever it belongs to.
 *
 * ── Why a ratio of distances, not the nose's offset ──
 *
 * The obvious estimator divides the nose's offset by the ear span. It fails
 * exactly where it matters: as the head turns, the ears foreshorten, so the
 * thing being divided by shrinks at the same time as the numerator grows, and
 * the estimate runs away right when the turn gets interesting.
 *
 * The ratio of the two nose-to-ear distances has the scale cancel out of it
 * instead. It is bounded in -1..1 by construction, it saturates gracefully
 * rather than exploding, and it needs no idea of how far away anyone is.
 */
export function readHead(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length <= Math.max(...POSE.EARS)) return null;
  const nose = point(landmarks[POSE.NOSE]);
  const ears = POSE.EARS.map(i => point(landmarks[i])).filter(Boolean);
  if (!nose || ears.length !== 2) return null;

  // Sides by x, never by the model's label: after the flip the smaller x is the
  // player's own left. Same rule as the arms, for the same reason.
  const [leftEar, rightEar] = ears[0].x <= ears[1].x ? ears : [ears[1], ears[0]];
  const span = Math.hypot(rightEar.x - leftEar.x, rightEar.y - leftEar.y);
  if (!(span > 0.02)) return null;      // side on, or too far away to read

  // ── Saturate before the ratio folds back on itself ──
  //
  // The ratio only rises while the nose is BETWEEN the ears. Past a far enough
  // turn the nose projects outside that pair, both distances start growing
  // together, and the reading comes back DOWN -- so turning your head further
  // would turn the character's head back. In practice the far ear also stops
  // being visible around there and this returns null anyway, but a fold-back
  // that is only prevented by luck is not prevented.
  const axisX = rightEar.x - leftEar.x;
  const axisY = rightEar.y - leftEar.y;
  const along =
    ((nose.x - leftEar.x) * axisX + (nose.y - leftEar.y) * axisY) / (span * span);
  if (along <= 0) return HEAD_LIMIT;    // nose past the left ear: fully turned left
  if (along >= 1) return -HEAD_LIMIT;

  const toLeft = Math.hypot(nose.x - leftEar.x, nose.y - leftEar.y);
  const toRight = Math.hypot(nose.x - rightEar.x, nose.y - rightEar.y);
  const total = toLeft + toRight;
  if (!(total > 1e-4)) return null;

  // Nose nearer the left ear means the head has turned to the player's left.
  const turn = (toRight - toLeft) / total;
  return Math.max(-HEAD_LIMIT, Math.min(HEAD_LIMIT, turn * HEAD_GAIN));
}
