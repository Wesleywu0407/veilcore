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
  EYES: [2, 5],
};

// Ratio to radians. A ratio of 0.5 is a head turned about halfway, and 1.55
// puts that near 45 degrees, which is where it feels right to a person.
export const HEAD_GAIN = 1.55;
// A neck stops. Past this the estimator is saturating anyway -- both ears stop
// being visible and the ratio stops meaning much -- so clamping here is honest
// rather than merely safe.
export const HEAD_LIMIT = 1.05;   // 60 degrees

// Pitch is a smaller range than yaw on a real neck, and a noisier reading, so
// it gets less of both. The gain is per unit of `lift` -- see readHead().
export const HEAD_PITCH_GAIN = 1.1;
export const HEAD_PITCH_LIMIT = 0.6;   // 34 degrees

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
 * Which way the head is pointed. `{ yaw, lift }`, or null with no readable face.
 *
 * `yaw` is finished: radians, positive toward the player's OWN left. A head
 * facing the lens is symmetric whoever it belongs to, so there is no per-person
 * constant in it.
 *
 * `lift` is NOT. It is the raw height of the nose above the ear line, in ear
 * spans, and it carries a per-face offset: everyone's nose sits below their own
 * ears at rest, by an amount that is theirs. Turning it into a pitch needs to
 * know where THIS face's level is -- see createHeadLevel(). Returning it raw,
 * rather than a pitch computed against somebody else's face, is the difference
 * between a number that can be calibrated and one that is quietly wrong.
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
  // ── Pitch is read off a short lever, so it is read off as many points as
  //    possible ──
  //
  // `lift` is a height divided by the ear span, and that span is about 0.06 of
  // the frame. Every pixel of noise on the points below therefore arrives
  // magnified roughly seventeen times -- which is why pitch stuttered where yaw
  // did not, on the very same landmarks. Yaw is a ratio of two distances and
  // has no such lever in it.
  //
  // The ear line is the steady half and stays as the reference. The moving half
  // is averaged over the nose AND both eyes where they are visible, since all
  // three rise and fall together when a head tips, and three noisy points
  // average to about 1.7x less noise than one.
  const eyes = POSE.EYES.map(i => point(landmarks[i])).filter(Boolean);
  const front = eyes.length === 2
    ? (nose.y + eyes[0].y + eyes[1].y) / 3
    : nose.y;
  const lift = ((leftEar.y + rightEar.y) / 2 - front) / span;

  const axisX = rightEar.x - leftEar.x;
  const axisY = rightEar.y - leftEar.y;
  const along =
    ((nose.x - leftEar.x) * axisX + (nose.y - leftEar.y) * axisY) / (span * span);
  const points = { nose, leftEar, rightEar, eyes };
  if (along <= 0) return { yaw: HEAD_LIMIT, lift, points };   // nose past the left ear
  if (along >= 1) return { yaw: -HEAD_LIMIT, lift, points };

  const toLeft = Math.hypot(nose.x - leftEar.x, nose.y - leftEar.y);
  const toRight = Math.hypot(nose.x - rightEar.x, nose.y - rightEar.y);
  const total = toLeft + toRight;
  if (!(total > 1e-4)) return null;

  // Nose nearer the left ear means the head has turned to the player's left.
  const turn = (toRight - toLeft) / total;
  return {
    yaw: Math.max(-HEAD_LIMIT, Math.min(HEAD_LIMIT, turn * HEAD_GAIN)),
    lift,
    points,
  };
}

/**
 * Where THIS face's "looking level" is.
 *
 * A nose sits below its own ear line at rest, and by how much is a fact about
 * one person's skull. Without knowing it there is no way to tell a head tilted
 * down from a head that simply has that face on it, so a fixed constant here
 * would mean everyone but one person is permanently looking somewhere they are
 * not. That is why pitch waited for this and yaw did not.
 *
 * Levels itself from a stretch of stillness rather than demanding a ritual, and
 * `set()` overrides whenever the player wants to redo it. Only samples taken
 * while the head is FACING FORWARD count: a lift measured mid-turn is a lift
 * measured on a foreshortened face, and would bake the turn into the rest.
 */
export function createHeadLevel({ window = 900, spread = 0.05, minSamples = 8 } = {}) {
  let rest = null;
  let seen = [];
  return {
    get rest() { return rest; },
    get ready() { return rest !== null; },
    /** Take this lift as level, now. */
    set(lift) {
      if (!Number.isFinite(lift)) return rest;
      rest = lift;
      seen = [];
      return rest;
    },
    forget() { rest = null; seen = []; },
    /** One frame. Returns the rest value once there is one, else null. */
    feed(yaw, lift, now) {
      if (rest !== null) return rest;
      if (!Number.isFinite(lift) || Math.abs(yaw) > 0.15) { seen = []; return null; }
      seen.push({ t: now, lift });
      seen = seen.filter(sample => now - sample.t <= window);
      if (seen.length < minSamples || now - seen[0].t < window * 0.6) return null;
      const lifts = seen.map(sample => sample.lift).sort((a, b) => a - b);
      // A spread this wide is a head that was moving, not one being held still.
      if (lifts[lifts.length - 1] - lifts[0] > spread) return null;
      rest = lifts[Math.floor(lifts.length / 2)];      // median, not mean
      return rest;
    },
  };
}

/** A calibrated pitch, in radians, positive looking UP. */
export function headPitch(lift, rest) {
  if (rest === null || rest === undefined || !Number.isFinite(lift)) return 0;
  const pitch = (lift - rest) * HEAD_PITCH_GAIN;
  return Math.max(-HEAD_PITCH_LIMIT, Math.min(HEAD_PITCH_LIMIT, pitch));
}

// A wild frame must not become the arm's length for the rest of the session,
// so a reading is only believed if it is plausible against the shoulders, and
// the remembered maximum leaks back down slowly if it was ever overshot.
// ── The upper bound has to be anatomy, not a guess ──
//
// This was 2.6, which is not a bound at all: a real arm is about 0.35 of a
// person's height and their shoulders about 0.25, so the ratio sits near 1.4
// and does not credibly pass 1.8. Everything between 1.8 and 2.6 was a bad
// frame being believed.
//
// And bad frames are common in exactly the case that broke: with one hand up,
// the OTHER arm is down and often half occluded, and MediaPipe will hand back
// a chain that takes its shoulder from one arm and its wrist from the other.
// That reads about two shoulder widths -- comfortably inside 2.6, so it was
// accepted, and since the learner keeps the MAXIMUM it then poisoned the scale
// for the rest of the session. Measured on screen: 2.07, 2.05, 2.04, 1.97.
//
// A scale that is too large divides every offset down, so the character's hand
// stays hard against its own shoulder -- which from inside its head is the far
// edge of the frame, an arm's length too close to the lens. Hence "with one
// hand I can barely see it, with two it is fine": two hands in front of you are
// the pose the body model reads most reliably.
const ARM_SPAN_SANE = 1.85;     // shoulder widths -- past this it is a bad frame
const ARM_SPAN_DECAY = 0.995;   // about twenty seconds to halve, at the body rate

/**
 * The player's own arm length, in the picture, learned from the picture.
 *
 * The alternative is a constant -- an arm is about 1.55 shoulder widths -- and
 * a constant is somebody else's body. Too small and every offset divides up too
 * large, saturates, and the arm reads as fully extended no matter what the
 * player does; too large and they can never reach anything.
 *
 * Take the MAXIMUM seen rather than the average. Any single reading is the arm
 * as the lens sees it, which is the true length only when the arm happens to
 * lie across the frame; every other pose foreshortens it and reads SHORT. There
 * is no reading that is too long for an honest reason, so the longest one is
 * the closest to the truth.
 *
 * ── In SHOULDER WIDTHS, never in picture units ──
 *
 * This stored an absolute length at first, and that quietly undid the whole
 * point of it. A picture has no fixed scale: lean toward the lens and every
 * distance in the frame grows together. A length learned at one distance is
 * therefore wrong at every other one -- too small once you sit back, so the
 * offsets divide up too large and the arm overshoots; too large once you lean
 * in, so it barely moves. Which is exactly "sometimes it is fine and sometimes
 * it is not", with the trigger being the player shifting in their chair.
 *
 * The symptom that gave it away: the panel reported 1.89 shoulder widths while
 * the plausible bound was 1.85. It could print a number its own guard forbids
 * because the guard divided by the CURRENT shoulders and the stored value did
 * not -- so the two were not in the same units at all.
 *
 * A ratio to the shoulders has the distance cancel out of it, which is the
 * property that was wanted in the first place.
 */
export function createArmSpan() {
  let widths = 0;
  return {
    /** The arm's length in SHOULDER WIDTHS, or 0 before one has been seen. */
    get widths() { return widths; },
    /** Feed one arm chain and the shoulder span it is measured against. */
    feed(arm, shoulders) {
      if (!arm?.shoulder || !arm?.elbow || !arm?.wrist || !(shoulders > 0)) return widths;
      const upper = Math.hypot(arm.elbow.x - arm.shoulder.x, arm.elbow.y - arm.shoulder.y);
      const fore = Math.hypot(arm.wrist.x - arm.elbow.x, arm.wrist.y - arm.elbow.y);
      const ratio = (upper + fore) / shoulders;
      if (!(ratio > 0) || ratio > ARM_SPAN_SANE) return widths;
      widths = Math.max(widths * ARM_SPAN_DECAY, ratio);
      return widths;
    },
    reset() { widths = 0; },
  };
}
