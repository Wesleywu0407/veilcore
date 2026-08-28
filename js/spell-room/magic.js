// ─── Spell Room — Gesture gate + rune recognition ─────────────────────────────
//
// This is the file that decides whether a wave of the hand becomes a spell.
// Everything here runs on normalized 0..1 points; nothing here knows about
// pixels, canvases or Three.js.
//
// The five functions marked TODO are the actual technique. The scaffolding
// around them is plumbing. Fill them in order — each one is testable on its
// own before the next matters.
//
// A note on what "good" means here. Detection is the easy half. The hard half
// is that a REJECTED gesture has to feel like the player's fault, not the
// camera's. If someone draws a clean shape and gets nothing, they stop trusting
// the room, and no amount of particle effects buys that trust back.

// `clamp` is unused until you write recognize() — that is where it belongs.
import { LM, dist, dist3, clamp } from "./vec.js";

// ─── Tuning ───────────────────────────────────────────────────────────────────
// One place for every magic number. If you find yourself typing a threshold
// somewhere else in this file, it belongs up here instead.

export const TUNE = {
  // Pinch gate, expressed as a fraction of hand size so it works whether the
  // hand is 30cm or 80cm from the lens.
  // The gate CALIBRATES ITSELF. Absolute ratios were a mistake: they depend on
  // the distance metric, the camera, and the shape of the player's hand, so a
  // number tuned once is wrong the moment any of those change. Switching the
  // metric from 2D to 3D compressed every ratio by roughly half — and the old
  // 0.65 release threshold silently became unreachable, so the gate could
  // close but never open again. Every cast overloaded, and nothing on screen
  // said why.
  //
  // These are FRACTIONS of the range actually observed this session, not
  // ratios. 0 = the tightest pinch seen, 1 = the widest opening seen.
  PINCH_ON: 0.35,          // below this fraction of the observed range → close
  PINCH_OFF: 0.55,         // above it → open. The gap is the dead zone.
  PINCH_HOLD_MS: 60,       // the gate must agree for this long before it flips
  // Ignore the range until the hand has actually moved this much, or startup
  // noise alone would look like a full open-and-close.
  PINCH_MIN_RANGE: 0.08,

  // Stroke sanity. Anything smaller than this is a twitch, not a rune.
  MIN_POINTS: 8,
  MIN_DIAGONAL: 0.08,      // bounding-box diagonal, normalized units
  MIN_PATH: 0.10,          // total path length
  MAX_STROKE_MS: 4000,

  // ── Charge ──
  // The shape says WHAT. How long you keep holding says HOW HARD.
  //
  // A rune has to end before charging can start, and releasing the pinch is
  // now "fire" — so the end of the drawing is detected by the hand going
  // STILL, not by letting go.
  // These two decide when a stroke is "finished". Corners are where a hand
  // naturally slows, so a trigger-happy pair locks a half-drawn shape at the
  // first vertex -- and because the lock only aborts when the partial stroke
  // matches nothing, the failure lands precisely on the strokes that were going
  // well. Both runes with corners are triangles now, which makes it worse, not
  // better. Slower and longer: you must really have stopped.
  STILL_SPEED: 0.22,       // normalized units per second — below this counts as stopped
  STILL_MS: 360,           // how long it must stay stopped before the shape locks
  CHARGE_FULL_MS: 1100,    // hold this long for full power
  // Overload is a design flourish, and 2.2s was tight enough that it fired
  // before the player had finished looking at their own charge. A punishment
  // that lands while you are still learning the mechanic is not tension, it is
  // just a wall. Tighten it later, once the spell is worth rushing.
  CHARGE_OVERLOAD_MS: 5000,
  CHARGE_MIN: 0.25,        // a quick flick still does something

  // How often the live preview re-scores the partial stroke. A full match costs
  // about 0.3ms, cheap enough to run every frame, but the readout is for human
  // eyes and 16Hz already looks continuous -- no reason to spend the rest.
  PREVIEW_MS: 60,

  // Recognition
  RESAMPLE_N: 64,
  // Two different jobs, two different numbers — do not conflate them.
  //
  // FLOOR keeps nonsense out. Its home is the measured gap between correct
  // strokes and scribbles. At +/-8% jitter a correct rune scores 0.47 at worst
  // and 0.64 at the 10th percentile; random scribbles top out at 0.49 and sit
  // at 0.00 median. 0.60 lands inside that gap. Raising it further does not
  // buy safety that is not already there, it just rejects people who drew
  // correctly — 0.72 threw away a third of them.
  SCORE_FLOOR: 0.60,
  // MARGIN is what stops two runes trading places when a drawing sits between
  // them. This is the one to raise if the wrong spell ever fires; raising the
  // floor for that would be treating the wrong symptom.
  SCORE_MARGIN: 0.05,
};

// ─── Rune templates ───────────────────────────────────────────────────────────
// Control points in a 0..1 box, drawn in the order a hand would draw them.
// `weapon` is the SKYVEIL weapon index this rune fires — see sky-room.js:977.
//
// These three shapes were picked by measuring, not by taste. Pairwise template
// distance after resample + normalize:
//
//              Z       V       arc
//      Z       —     0.591   0.621
//      V     0.591     —     0.393
//      arc   0.621   0.393     —
//
// All comfortably apart. An inverted-V (∧) was the obvious fourth and it is
// NOT here on purpose: it sits 0.057 from the arc, which is the same shape as
// far as point-by-point comparison is concerned. Add it and a slightly rounded
// ∧ starts casting the arc's spell at high confidence — a wrong spell, with no
// fizzle to warn the player. Measure before you add a fourth.
//
// `closed: true` means the stroke returns to where it started. Closed shapes
// need special handling in recognize() — see the TODO there.

export const RUNES = [
  {
    id: "ringfall",
    name: "Ringfall",
    weapon: 5,
    // A ring. `closed: true` is not decoration — it is what tells recognize()
    // to try every cyclic rotation of the stroke. A circle has no corner to
    // start from, so without it only a player who happened to begin at the top
    // would ever be recognised, and nobody could guess that was the rule.
    closed: true,
    points: [
      { x: 0.5, y: 0.06 }, { x: 0.668, y: 0.093 }, { x: 0.811, y: 0.189 },
      { x: 0.907, y: 0.332 }, { x: 0.94, y: 0.5 }, { x: 0.907, y: 0.668 },
      { x: 0.811, y: 0.811 }, { x: 0.668, y: 0.907 }, { x: 0.5, y: 0.94 },
      { x: 0.332, y: 0.907 }, { x: 0.189, y: 0.811 }, { x: 0.093, y: 0.668 },
      { x: 0.06, y: 0.5 }, { x: 0.093, y: 0.332 }, { x: 0.189, y: 0.189 },
      { x: 0.332, y: 0.093 }, { x: 0.5, y: 0.06 },
    ],
  },
  {
    id: "aegis",
    name: "Aegis",
    weapon: 2,
    closed: true,
    points: [
      { x: 0.5, y: 0.06 },
      { x: 0.93, y: 0.88 },
      { x: 0.07, y: 0.88 },
      { x: 0.5, y: 0.06 },
    ],
  },
  {
    id: "gravity-seal",
    name: "Gravity Seal",
    weapon: 3,
    // Aegis is the same triangle the other way up, so these two live closer
    // together than any other pair here. Check scripts/rune-distance.mjs before
    // nudging either of them.
    closed: true,
    points: [
      { x: 0.07, y: 0.12 },
      { x: 0.93, y: 0.12 },
      { x: 0.5, y: 0.94 },
      { x: 0.07, y: 0.12 },
    ],
  },
];

// ─── 1. The gate ──────────────────────────────────────────────────────────────

let pinchState = false;
let pendingSince = 0;
// Last computed ratio, for the on-screen readout. Diagnosing a gate you cannot
// see is guesswork; one number on the glass turns it into tuning.
let lastPinchRatio = 0;
// Observed extremes this session. They drift back toward the current value so
// one freak reading cannot poison the range forever.
let seenLow = Infinity;
let seenHigh = -Infinity;

function absoluteThresholds() {
  const range = seenHigh - seenLow;
  if (!Number.isFinite(range) || range < TUNE.PINCH_MIN_RANGE) {
    // Not enough movement yet to know this hand's range. Fall back to a split
    // of whatever has been seen, which at worst behaves like a single mid
    // threshold — jittery, but never stuck open or stuck closed.
    const mid = Number.isFinite(lastPinchRatio) ? lastPinchRatio : 0.2;
    return { on: mid * 0.8, off: mid * 1.25 };
  }
  return {
    on: seenLow + range * TUNE.PINCH_ON,
    off: seenLow + range * TUNE.PINCH_OFF,
  };
}

export function pinchDebug() {
  const t = absoluteThresholds();
  return {
    ratio: lastPinchRatio, on: t.on, off: t.off, closed: pinchState,
    low: seenLow, high: seenHigh,
    calibrated: seenHigh - seenLow >= TUNE.PINCH_MIN_RANGE,
  };
}

export function resetPinchCalibration() {
  seenLow = Infinity;
  seenHigh = -Infinity;
}

/**
 * TODO(you) #1 — pinch detection.
 *
 * Return true while the thumb and index finger are pinched together.
 *
 * The naive version is one line:
 *     dist(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]) < 0.05
 * ...and it is wrong twice over.
 *
 * (a) SCALE. That 0.05 is in screen space. Step back from the camera and your
 *     whole hand shrinks, so the threshold silently becomes "fist". Divide the
 *     thumb-index distance by `handScale` (wrist → middle knuckle, already
 *     computed for you in tracker.js) and compare the RATIO against
 *     TUNE.PINCH_ON. Now it means the same thing at any distance.
 *
 * (b) FLICKER. The landmark jitters a few pixels every frame. A single
 *     threshold will flip on/off several times a second while you hold still,
 *     and each flip starts or ends a stroke. Two defences, use both:
 *       - Hysteresis: once pinching, require the ratio to climb past
 *         TUNE.PINCH_OFF (higher than PINCH_ON) before you release. The gap
 *         between the two numbers is the dead zone the noise lives in.
 *       - Debounce: a change only counts once it has held for
 *         TUNE.PINCH_HOLD_MS. `pendingSince` is there for you to use.
 *
 * How to know it works: hold a pinch dead still for ten seconds and log every
 * transition. You want zero. Then pinch and release ten times deliberately —
 * you want exactly ten.
 *
 * @param {Array<{x:number,y:number}>} landmarks - 21 points, or null
 * @param {number} handScale - wrist→knuckle distance in the same units
 * @param {number} now - performance.now()
 * @returns {boolean}
 */
export function isPinching(landmarks, handScale, now) {
  if (!landmarks) {
    pinchState = false;
    return false;
  }

  // Ratio, not raw distance. The gap between two fingertips shrinks with the
  // whole hand as you step back from the lens, so a fixed threshold silently
  // becomes "make a fist" at arm's length. Dividing by hand size makes the
  // number mean the same thing wherever you stand.
  // 3D on both sides. The 2D version drifted as the wrist turned: the palm
  // foreshortens much harder than the thumb-index gap does, so the ratio moved
  // even when the fingers had not, and the same threshold meant different
  // things at different hand angles.
  const gap = dist3(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]);
  const span = dist3(landmarks[LM.WRIST], landmarks[LM.MIDDLE_MCP]);
  const ratio = gap / Math.max(span, 1e-6);
  lastPinchRatio = ratio;
  void handScale;

  // Widen the observed range, then let it creep back in. The creep matters:
  // without it one bad frame at an extreme would stretch the range for the
  // rest of the session and every threshold with it.
  seenLow = Math.min(Number.isFinite(seenLow) ? seenLow : ratio, ratio);
  seenHigh = Math.max(Number.isFinite(seenHigh) ? seenHigh : ratio, ratio);
  const observed = seenHigh - seenLow;
  if (observed > TUNE.PINCH_MIN_RANGE) {
    seenLow += observed * 0.0006;
    seenHigh -= observed * 0.0006;
  }

  // Hysteresis: it takes less to STAY pinched than it took to start. The band
  // between the two thresholds is a dead zone, and the landmark noise lives
  // inside it instead of straddling a single line.
  const { on, off } = absoluteThresholds();
  const wants = pinchState ? ratio < off : ratio < on;

  if (wants === pinchState) {
    pendingSince = 0;          // agreement — nothing pending
    return pinchState;
  }

  // Debounce: a disagreement has to persist before it counts. Hysteresis alone
  // still flips on a single loud frame; this makes the gate wait for the noise
  // to prove it meant it.
  if (!pendingSince) pendingSince = now;
  if (now - pendingSince >= TUNE.PINCH_HOLD_MS) {
    pinchState = wants;
    pendingSince = 0;
  }
  return pinchState;
}

// ─── 2. Stroke capture ────────────────────────────────────────────────────────
// This part is done. It records while the gate is open and hands you the raw
// path when the gate closes.

let stroke = [];
let strokeStart = 0;
let wasGated = false;

/**
 * Feed one frame. Returns a finished stroke (array of points) on the frame the
 * gate closes, otherwise null.
 */
export function updateStroke(gateOpen, tip, now) {
  if (gateOpen && !wasGated) {
    stroke = [];
    strokeStart = now;
  }

  if (gateOpen) {
    // Skip points that have not moved — duplicates distort resampling badly.
    const last = stroke[stroke.length - 1];
    if (!last || dist(last, tip) > 0.004) stroke.push({ x: tip.x, y: tip.y });
    if (now - strokeStart > TUNE.MAX_STROKE_MS) {
      wasGated = false;
      const timedOut = stroke;
      stroke = [];
      return timedOut;
    }
  }

  const finished = !gateOpen && wasGated ? stroke : null;
  wasGated = gateOpen;
  if (finished) stroke = [];
  return finished;
}

/** Live stroke, for drawing the trail while the player is still moving. */
export function currentStroke() {
  return stroke;
}

// ─── 3. Geometry ──────────────────────────────────────────────────────────────

export function boundingBox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/**
 * TODO(you) #2 — resample to exactly `n` evenly spaced points.
 *
 * This is the heart of the $1 recognizer and everything else depends on it.
 * A hand drawing slowly produces a dense clump of points; the same shape drawn
 * fast produces a sparse one. Comparing those point-by-point is meaningless.
 * After resampling, point i of any stroke means "i/n of the way along the
 * path", regardless of speed.
 *
 * Algorithm:
 *   step = pathLength(points) / (n - 1)
 *   Walk the path segment by segment, accumulating distance. Each time the
 *   accumulator would cross `step`, interpolate a new point at exactly that
 *   spot, emit it, reset the accumulator, and CONTINUE FROM THE NEW POINT
 *   (not from the segment end — that is the bug everyone writes first, and it
 *   makes long segments swallow points they should have produced).
 *   Push the final original point at the end so you land on exactly n.
 *
 * How to know it works: feed it a straight line from (0,0) to (1,0) with n=5.
 * You must get x = 0, 0.25, 0.5, 0.75, 1. Nothing else is close enough.
 *
 * @returns {Array<{x:number,y:number}>} exactly n points
 */
export function resample(points, n) {
  if (!points.length) return [];
  const total = pathLength(points);
  if (total <= 0) return Array.from({ length: n }, () => ({ ...points[0] }));

  const step = total / (n - 1);
  const out = [{ x: points[0].x, y: points[0].y }];
  let prev = points[0];
  // Distance walked since the last emitted point, CARRIED ACROSS SEGMENTS.
  // Dropping this is the bug that makes the result depend on how finely the
  // input was sampled: segments shorter than `step` contribute nothing, so a
  // densely traced stroke loses almost all of its length and every point
  // bunches up at the end.
  let acc = 0;

  for (let i = 1; i < points.length; i++) {
    const curr = points[i];
    let d = dist(prev, curr);
    // `while`, not `if`: one long segment can owe several points. And after
    // emitting one, `prev` becomes the NEW point — measuring the remainder
    // from the segment's end instead swallows points on long segments.
    while (acc + d >= step && out.length < n) {
      const t = (step - acc) / d;
      const q = { x: prev.x + t * (curr.x - prev.x), y: prev.y + t * (curr.y - prev.y) };
      out.push(q);
      prev = q;
      d = dist(prev, curr);
      acc = 0;
    }
    acc += d;
    prev = curr;
  }

  const last = points[points.length - 1];
  while (out.length < n) out.push({ x: last.x, y: last.y });
  return out.slice(0, n);
}

/**
 * TODO(you) #3 — move to origin and scale to a unit box.
 *
 * Two people draw the same rune in different corners of the frame, at different
 * sizes. Both must score the same. Translate so the bounding-box centre sits at
 * (0,0), then divide by the LARGER of width/height — not by each axis
 * separately, or you squash a tall shield into a wide one and it starts
 * matching the wrong template.
 *
 * Guard against a zero-size box (a perfectly straight vertical line has w = 0).
 *
 * How to know it works: normalize a template, then normalize the same template
 * scaled 3x and shifted by (0.4, 0.2). The two results must be identical to
 * about six decimal places.
 */
export function normalizeStroke(points) {
  if (!points.length) return [];
  const frame = boundingBox(points);
  // ONE scale for both axes. Dividing each axis by its own extent would
  // stretch a wide arc and a tall arc into the same shape, and they would
  // start matching each other's templates.
  const scale = Math.max(frame.w, frame.h, 1e-6);
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  return points.map((p) => ({ x: (p.x - cx) / scale, y: (p.y - cy) / scale }));
}

/**
 * TODO(you) #4 — mean point-to-point distance between two normalized strokes.
 *
 * Both arrays are the same length (you resampled them). Sum dist(a[i], b[i])
 * and divide by the count. Lower is more similar.
 *
 * That is the whole function. It is three lines. It is here as its own TODO
 * because naming it makes the next one readable, and because you will want to
 * swap it for something smarter later (golden-section angle search, or
 * weighting the start of the stroke more heavily) without touching recognize().
 */
export function templateDistance(a, b) {
  const count = Math.min(a.length, b.length);
  if (!count) return Infinity;
  let total = 0;
  for (let i = 0; i < count; i++) total += dist(a[i], b[i]);
  return total / count;
}

// ─── 4. Recognition ───────────────────────────────────────────────────────────

// Templates get resampled + normalized once, lazily, then cached. Doing this
// per cast is pure waste — and it is waste that lands on the exact frame the
// player is waiting for feedback.
let preparedRunes = null;

function prepareRunes() {
  if (preparedRunes) return preparedRunes;
  preparedRunes = RUNES.map((rune) => ({
    ...rune,
    normalized: normalizeStroke(resample(densify(rune.points), TUNE.RESAMPLE_N)),
  }));
  return preparedRunes;
}

/** Control points are corners; resampling needs a path. Fill in the edges. */
function densify(controlPoints, per = 24) {
  const out = [];
  for (let i = 0; i < controlPoints.length - 1; i++) {
    const a = controlPoints[i], b = controlPoints[i + 1];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  out.push(controlPoints[controlPoints.length - 1]);
  return out;
}

/**
 * TODO(you) #5 — the capstone. Turn a raw stroke into a spell, or into nothing.
 *
 * Returns { rune, score } or null. Never returns a wrong spell in preference to
 * returning null: a spell the player did not ask for is worse than no spell.
 *
 * Steps:
 *   1. Reject junk early. Fewer than TUNE.MIN_POINTS, or a bounding-box
 *      diagonal under TUNE.MIN_DIAGONAL, or pathLength under TUNE.MIN_PATH →
 *      return null. This is what stops a twitch of the wrist from casting.
 *   2. resample + normalizeStroke the candidate.
 *   3. Score against every prepared rune:
 *        score = clamp(1 - templateDistance(candidate, rune.normalized) / 0.38)
 *      That 0.38 is the "how wrong is too wrong" constant. Tune it last, and
 *      tune it by drawing badly on purpose, not by drawing well.
 *   4. Also try the candidate REVERSED. A shield drawn right-to-left is still
 *      a shield, and half your players are left-handed.
 *   5. Take the best. Require score >= TUNE.SCORE_FLOOR AND
 *      (best - runnerUp) >= TUNE.SCORE_MARGIN. The margin is what stops two
 *      similar runes from trading places at random — without it, the same
 *      drawing casts different spells on different attempts, which reads as
 *      the room being broken.
 *
 * THE CLOSED-LOOP TRAP. When you add a closed rune (a star, a circle, a
 * triangle), point-by-point comparison assumes both strokes START AT THE SAME
 * PLACE. A five-point star has five equally natural starting corners, so four
 * out of five correct drawings will score near zero and be rejected — and the
 * player has no way to guess that the top point was the special one. The fix:
 * for any rune with `closed: true`, score every cyclic rotation of the
 * candidate and keep the best. Reversal handles direction; rotation handles
 * the starting corner. You need both.
 *
 * How to know it works: take a template, draw it as the candidate, and confirm
 * score ≈ 1. Then add ±8% random jitter to every control point, run it 200
 * times, and count. Under 90% recognition means the shape is too close to
 * another one — change the shape, do not lower the threshold.
 */
const DISTANCE_TOLERANCE = 0.38;

/**
 * Every orientation of a stroke that should still count as the same rune.
 *
 * Reversal is always allowed: a rune traced right-to-left is the same rune,
 * and roughly half of all players are left-handed.
 *
 * Rotation is only for closed shapes, and it is what stops the trap that bit
 * the hackathon build: a five-pointed star has five equally natural starting
 * corners, but point-by-point comparison assumes both strokes begin in the
 * same place. Without this, four out of five correct drawings score near zero
 * and the player has no way to guess which corner was special.
 */
function* orientationsOf(points, closed) {
  yield points;
  yield [...points].reverse();
  if (!closed) return;
  for (let shift = 1; shift < points.length; shift++) {
    const rotated = points.slice(shift).concat(points.slice(0, shift));
    yield rotated;
    yield [...rotated].reverse();
  }
}

function scoreAgainst(candidate, rune) {
  let closest = Infinity;
  for (const variant of orientationsOf(candidate, rune.closed)) {
    const d = templateDistance(variant, rune.normalized);
    if (d < closest) closest = d;
  }
  return clamp(1 - closest / DISTANCE_TOLERANCE);
}

/**
 * Measurement without policy: the closest rune and how close it is, whatever
 * the floor and margin would say about it. recognize() is this plus the two
 * rules; the live preview is this raw, because "Ringfall, 45%, not yet" is the
 * one thing a player mid-stroke actually needs and the answer recognize()
 * throws away.
 */
export function bestMatch(rawPoints) {
  const points = rawPoints ?? [];

  // Reject junk before doing any work. This is what stops a twitch of the
  // wrist from casting, and it is cheap enough to run first.
  if (points.length < TUNE.MIN_POINTS) return null;
  const frame = boundingBox(points);
  if (Math.hypot(frame.w, frame.h) < TUNE.MIN_DIAGONAL) return null;
  if (pathLength(points) < TUNE.MIN_PATH) return null;

  const candidate = normalizeStroke(resample(points, TUNE.RESAMPLE_N));
  const runes = prepareRunes();

  let best = null;
  let bestScore = -Infinity;
  let runnerUp = -Infinity;
  for (const rune of runes) {
    const score = scoreAgainst(candidate, rune);
    if (score > bestScore) {
      runnerUp = bestScore;
      bestScore = score;
      best = rune;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }
  if (!best) return null;

  // The margin is what stops two similar runes trading places at random when a
  // drawing sits between them. Meaningless with one rune defined.
  const clear = runes.length < 2 || bestScore - runnerUp >= TUNE.SCORE_MARGIN;
  return { rune: best, score: bestScore, runnerUp, ready: bestScore >= TUNE.SCORE_FLOOR && clear };
}

export function recognize(rawPoints) {
  const match = bestMatch(rawPoints);
  return match && match.ready ? { rune: match.rune, score: match.score } : null;
}

// ─── 5. Charged casting ───────────────────────────────────────────────────────
//
// The state machine that makes this different from a lookup table.
//
//   idle → drawing → charging → (fire | overload)
//
// The shape decides WHICH spell. How long you keep pinching after the shape is
// finished decides HOW HARD. Releasing fires.
//
// The interesting consequence is that a heavy hit costs you time standing
// still with your hand up — the risk lives in the player's body, not in a
// cooldown number. And holding too long overloads: the spell goes off in your
// hand for nothing. That is the ceiling that stops "always charge to full"
// from being the only answer.

const CAST = {
  IDLE: "idle",
  DRAWING: "drawing",
  CHARGING: "charging",
  // Overloaded, and the pinch is still held. Nothing happens until they let
  // go. Without this the next frame quietly starts a fresh stroke and the
  // overload costs the player nothing they can perceive — a punishment nobody
  // notices is not a punishment, it is a bug that feels like bad luck.
  SPENT: "spent",
};

let phase = CAST.IDLE;
let lockedRune = null;
let chargeStart = 0;
let stillSince = 0;
let lastTip = null;
let preview = null;
let previewAt = 0;
let lastTipAt = 0;

/** How far along the charge is, 0..1. Clamped — overload is handled separately. */
function chargeAt(now) {
  if (phase !== CAST.CHARGING) return 0;
  const held = now - chargeStart;
  return clamp(TUNE.CHARGE_MIN + (held / TUNE.CHARGE_FULL_MS) * (1 - TUNE.CHARGE_MIN));
}

/**
 * Feed one frame. Returns the cast state, and an `event` on the single frame
 * something actually happens.
 *
 * @returns {{
 *   phase: string, rune: object|null, charge: number, overloading: boolean,
 *   event: null | { type: 'fired'|'fizzled'|'overloaded', rune?: object, charge?: number }
 * }}
 */
export function updateCast(gateOpen, tip, now) {
  let event = null;

  // ── Released: fire what is held, or fizzle what never formed ──
  if (!gateOpen) {
    if (phase === CAST.CHARGING) {
      event = { type: "fired", rune: lockedRune, charge: chargeAt(now) };
    } else if (phase === CAST.DRAWING) {
      // Let go before the shape settled. Still try — a confident quick flick
      // should cast, just at minimum power. Punishing speed here would make
      // the whole system feel sluggish.
      const hit = recognize(currentStroke());
      event = hit
        ? { type: "fired", rune: hit.rune, charge: TUNE.CHARGE_MIN }
        : { type: "fizzled" };
    }
    updateStroke(false, tip, now);
    resetCast();
    return { phase, preview: null, rune: null, charge: 0, overloading: false, event };
  }

  // ── Held ──
  if (phase === CAST.SPENT) {
    lastTip = { x: tip.x, y: tip.y };
    lastTipAt = now;
    return { phase, preview: null, rune: null, charge: 0, overloading: false, event: null };
  }

  if (phase === CAST.IDLE) {
    phase = CAST.DRAWING;
    stillSince = 0;
    lastTip = null;
  }

  if (phase === CAST.DRAWING) {
    updateStroke(true, tip, now);

    if (now - previewAt >= TUNE.PREVIEW_MS) {
      previewAt = now;
      preview = bestMatch(currentStroke());
    }

    // Speed in normalized units per second, so STILL_SPEED means the same
    // thing whatever the frame rate happens to be.
    const dt = lastTipAt ? (now - lastTipAt) / 1000 : 0;
    const speed = lastTip && dt > 0 ? dist(lastTip, tip) / dt : Infinity;
    if (speed > TUNE.STILL_SPEED) stillSince = 0;
    else if (!stillSince) stillSince = now;

    if (stillSince && now - stillSince >= TUNE.STILL_MS) {
      const hit = recognize(currentStroke());
      if (hit) {
        lockedRune = hit.rune;
        phase = CAST.CHARGING;
        chargeStart = now;
      }
      // No match yet? Say nothing and keep recording. The player may simply be
      // pausing mid-rune, and yanking the stroke away from them there would be
      // the most infuriating possible failure.
    }
  } else if (phase === CAST.CHARGING && now - chargeStart > TUNE.CHARGE_OVERLOAD_MS) {
    event = { type: "overloaded", rune: lockedRune };
    updateStroke(false, tip, now);
    resetCast();
    phase = CAST.SPENT;      // stays spent until the pinch is released
  }

  lastTip = { x: tip.x, y: tip.y };
  lastTipAt = now;

  const held = phase === CAST.CHARGING ? now - chargeStart : 0;
  return {
    phase,
    // Only meaningful while drawing: once a rune is locked the charge ring and
    // the rune name say everything, and a second number would just argue.
    preview: phase === CAST.DRAWING ? preview : null,
    rune: lockedRune,
    charge: chargeAt(now),
    // Past full but not yet overloaded: the window where the player should be
    // getting nervous. The room draws this differently on purpose.
    overloading: phase === CAST.CHARGING && held > TUNE.CHARGE_FULL_MS,
    event,
  };
}

function resetCast() {
  phase = CAST.IDLE;
  lockedRune = null;
  chargeStart = 0;
  stillSince = 0;
  lastTip = null;
  lastTipAt = 0;
  // Without this the last stroke's verdict flashes up the instant the next one
  // starts, before a single new point has been scored.
  preview = null;
  previewAt = 0;
}

// ─── Reset ────────────────────────────────────────────────────────────────────

export function resetMagic() {
  resetCast();
  stroke = [];
  wasGated = false;
  pinchState = false;
  pendingSince = 0;
}
