import test from 'node:test';
import assert from 'node:assert/strict';

import { POSE, readPose, elbowHint, sideOfWrist, createSideLatch, createLatch, handsCrossed, sideOf,
  readHead, HEAD_LIMIT, headPitch, createHeadLevel,
  HEAD_PITCH_LIMIT, createArmSpan, handsRaised } from '../js/spell-room/pose.js';

/**
 * A body standing square to the camera, already un-mirrored: the player's right
 * side is at the larger x. MediaPipe's own LEFT_ indices are deliberately put
 * on the player's RIGHT here, which is what the mirror actually does and what
 * readPose has to see through.
 */
function body({ leftIndexX = 0.62, rightIndexX = 0.38, visibility = 0.9 } = {}) {
  const points = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility }));
  points[POSE.LEFT_SHOULDER] = { x: leftIndexX, y: 0.40, z: 0, visibility };
  points[POSE.LEFT_ELBOW] = { x: leftIndexX + 0.06, y: 0.55, z: 0, visibility };
  points[POSE.LEFT_WRIST] = { x: leftIndexX + 0.04, y: 0.70, z: 0, visibility };
  points[POSE.LEFT_HIP] = { x: leftIndexX - 0.02, y: 0.75, z: 0, visibility };
  points[POSE.RIGHT_SHOULDER] = { x: rightIndexX, y: 0.40, z: 0, visibility };
  points[POSE.RIGHT_ELBOW] = { x: rightIndexX - 0.06, y: 0.55, z: 0, visibility };
  points[POSE.RIGHT_WRIST] = { x: rightIndexX - 0.04, y: 0.70, z: 0, visibility };
  points[POSE.RIGHT_HIP] = { x: rightIndexX + 0.02, y: 0.75, z: 0, visibility };
  return points;
}

test('the arm at the larger x is the player right arm, whatever MediaPipe called it', () => {
  const pose = readPose(body());
  // LEFT_SHOULDER was placed at 0.62, so the model's "left" arm is the player's
  // right one. Getting this backwards is the bug AGENTS.md already paid for once.
  assert.equal(pose.right.shoulder.x, 0.62);
  assert.equal(pose.left.shoulder.x, 0.38);
});

test('the elbow and wrist follow their own shoulder, not their own x', () => {
  // A hand thrown right across the body: the wrist ends up on the far side.
  const points = body();
  points[POSE.RIGHT_WRIST] = { x: 0.9, y: 0.5, z: 0, visibility: 0.9 };
  const pose = readPose(points);
  // The crossed wrist stays on the arm it belongs to. Placing each joint from
  // its own x would have handed it to the other limb mid-stroke.
  assert.equal(pose.left.wrist.x, 0.9);
  assert.equal(pose.left.shoulder.x, 0.38);
});

test('a joint the model cannot see is dropped rather than guessed', () => {
  const points = body();
  points[POSE.LEFT_ELBOW] = { x: 0.7, y: 0.55, z: 0, visibility: 0.1 };
  const pose = readPose(points);
  assert.equal(pose.right.elbow, null);
  assert.ok(pose.right.shoulder, 'the rest of the arm survives');
});

test('no body at all reads as null, not as a body at the origin', () => {
  assert.equal(readPose(null), null);
  assert.equal(readPose([]), null);
  const points = body();
  points[POSE.LEFT_SHOULDER] = { x: 0.62, y: 0.4, z: 0, visibility: 0.1 };
  assert.equal(readPose(points), null, 'one shoulder alone cannot place a side');
});

test('the elbow hint points from the shoulder toward the elbow', () => {
  const pose = readPose(body());
  const hint = elbowHint(pose.right);
  assert.ok(hint.x > 0, 'the right elbow is out to the player right');
  assert.ok(hint.y > 0, 'and below the shoulder, y being down the image');
  assert.ok(Math.abs(hint.length - Math.hypot(hint.x, hint.y)) < 1e-12);
});

test('an elbow on top of its shoulder has no direction to report', () => {
  assert.equal(elbowHint({ shoulder: { x: 0.5, y: 0.5 }, elbow: { x: 0.5, y: 0.5 } }), null);
  assert.equal(elbowHint({ shoulder: { x: 0.5, y: 0.5 }, elbow: null }), null);
  assert.equal(elbowHint(null), null);
});

// ── Placing a lone hand ───────────────────────────────────────────────────────

const at = (x, y) => ({ x, y, z: 0 });
const bodyWrists = (leftX, rightX) => ({
  left: { wrist: at(leftX, 0.5) },
  right: { wrist: at(rightX, 0.5) },
});

test('a lone hand takes the side of the body wrist it is nearest', () => {
  // Un-mirrored, the player's right hand has the larger x.
  assert.equal(sideOfWrist(at(0.72, 0.5), bodyWrists(0.3, 0.7)), 'right');
  assert.equal(sideOfWrist(at(0.28, 0.5), bodyWrists(0.3, 0.7)), 'left');
});

test('raising the left hand alone does not come back as the right one', () => {
  // The bug this exists for: one hand in shot was always read as the right.
  assert.equal(sideOfWrist(at(0.31, 0.44), bodyWrists(0.3, 0.7)), 'left');
});

test('a hand carried across the body still belongs to its own arm', () => {
  // Right hand reaching left past the midline: x alone would call it the left.
  assert.equal(sideOfWrist(at(0.66, 0.5), bodyWrists(0.3, 0.7)), 'right');
});

test('no body means no guess, which is what null has always meant', () => {
  assert.equal(sideOfWrist(at(0.5, 0.5), null), null);
  assert.equal(sideOfWrist(at(0.5, 0.5), { left: { wrist: at(0.3, 0.5) } }), null);
  assert.equal(sideOfWrist(null, bodyWrists(0.3, 0.7)), null);
});

test('a dead heat is not an answer either', () => {
  assert.equal(sideOfWrist(at(0.5, 0.5), bodyWrists(0.3, 0.7)), null);
});

// ── Holding a side steady ─────────────────────────────────────────────────────

test('the latch has no opinion until the body gives it one', () => {
  const latch = createSideLatch();
  assert.equal(latch.side, null);
  assert.equal(latch.settle(null), null, 'a frame with no body is not an answer');
});

test('the first real answer sticks through the frames that have none', () => {
  const latch = createSideLatch();
  latch.settle('left');
  // The body model is sampled, so most frames say nothing at all.
  for (let i = 0; i < 20; i++) assert.equal(latch.settle(null), 'left');
});

test('a new answer replaces the held one', () => {
  const latch = createSideLatch();
  latch.settle('left');
  assert.equal(latch.settle('right'), 'right');
});

test('forgetting means the next hand up is asked afresh', () => {
  // Right hand down, left hand up: without this the left arm reads as right
  // until the body model catches up.
  const latch = createSideLatch();
  latch.settle('right');
  latch.forget();
  assert.equal(latch.side, null);
  assert.equal(latch.settle(null), null);
  assert.equal(latch.settle('left'), 'left');
});

// ── Crossed arms ──────────────────────────────────────────────────────────────

test('arms hanging normally are not crossed', () => {
  // Un-mirrored: the player's left has the smaller x.
  assert.equal(handsCrossed(at(0.32, 0.5), at(0.68, 0.5), bodyWrists(0.3, 0.7)), false);
});

test('folded arms are seen as crossed rather than swapping the sides', () => {
  // Each hand has travelled past the other, so x order now lies.
  assert.equal(handsCrossed(at(0.34, 0.5), at(0.66, 0.5), bodyWrists(0.7, 0.3)), true);
});

test('the pairing is solved together, not one hand at a time', () => {
  // Both hands are nearest the SAME body wrist. Asked independently they would
  // both claim it; asked as a pairing, the cheaper total wins and they split.
  const pose = bodyWrists(0.30, 0.34);
  const answer = handsCrossed(at(0.31, 0.5), at(0.80, 0.5), pose);
  assert.equal(answer, false, 'the far hand still has to take the far wrist');
});

test('two hands too close together is not an answer', () => {
  assert.equal(handsCrossed(at(0.5, 0.5), at(0.5, 0.5), bodyWrists(0.3, 0.7)), null);
});

test('no body means keep whatever x said', () => {
  assert.equal(handsCrossed(at(0.3, 0.5), at(0.7, 0.5), null), null);
  assert.equal(handsCrossed(null, at(0.7, 0.5), bodyWrists(0.3, 0.7)), null);
});

test('the generic latch holds anything that is not null', () => {
  const latch = createLatch();
  assert.equal(latch.value, null);
  assert.equal(latch.settle(false), false, 'false is an answer, not an absence');
  assert.equal(latch.settle(null), false, 'and it survives the frames with none');
  latch.forget();
  assert.equal(latch.value, null);
});

// ── Which way the head is turned ──────────────────────────────────────────────

/** A face, in the un-mirrored space readHead() is given. `turn` in -1..1 slides
 *  the nose between the ears; the ears foreshorten as it does, exactly as a
 *  real head's do, so the estimator is tested against the thing that breaks the
 *  obvious one. */
const yawOf = lm => { const read = readHead(lm); return read === null ? null : read.yaw; };

function face(turn = 0, lift = 0) {
  // Every landmark defaults to the middle of the frame, which is nowhere near a
  // face -- so anything readHead() consults has to be placed here deliberately.
  // The eyes were not, once, and they dragged the pitch reference to 0.5 while
  // reporting themselves perfectly visible. A fixture that leaves a consulted
  // point at its filler value is not testing the thing it looks like it tests.
  const lm = new Array(33).fill(null).map(() => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
  const half = 0.06 * Math.cos(turn * Math.PI / 3);      // ears close up as it turns
  const at = (x, y) => ({ x, y, z: 0, visibility: 0.9 });
  // `lift` raises the whole front of the face together, the way tipping a head
  // back does -- nose and both eyes, not the nose on its own.
  lm[POSE.NOSE] = at(0.5 - turn * 0.055, 0.42 - lift);
  lm[POSE.EYES[0]] = at(0.5 - turn * 0.05 - 0.022, 0.40 - lift);
  lm[POSE.EYES[1]] = at(0.5 - turn * 0.05 + 0.022, 0.40 - lift);
  lm[POSE.EARS[0]] = at(0.5 - half, 0.40);
  lm[POSE.EARS[1]] = at(0.5 + half, 0.40);
  return lm;
}

test('a head facing the lens is not turned', () => {
  assert.ok(Math.abs(yawOf(face(0))) < 1e-9);
});

test('turning to your own left reads positive, and right negative', () => {
  // After the un-mirroring the player's left is the smaller x, so the nose
  // moving that way is a turn to their own left.
  assert.ok(yawOf(face(0.6)) > 0.2, 'left should be positive');
  assert.ok(yawOf(face(-0.6)) < -0.2, 'right should be negative');
});

test('the reading grows with the turn instead of running away', () => {
  // The failure of the obvious estimator: divide by the ear span and the answer
  // explodes just as the head gets interesting, because the span is shrinking.
  const steps = [0.2, 0.4, 0.6, 0.8].map(t => yawOf(face(t)));
  for (let i = 1; i < steps.length; i++) {
    assert.ok(steps[i] > steps[i - 1], `not monotonic at step ${i}`);
  }
  assert.ok(steps.at(-1) <= HEAD_LIMIT + 1e-9, 'and it stays inside the neck');
});

test('turning further never turns the head back', () => {
  // Measured: past the point where the nose projects outside the ear pair, the
  // raw ratio comes back DOWN -- 0.96 at four fifths of a turn, 0.72 at a full
  // one. Saturating is the difference between "as far as it goes" and "the head
  // snaps the other way when you commit to the turn".
  let worst = 0;
  let previous = null;
  for (let t = 0.05; t <= 2; t += 0.05) {
    const reading = yawOf(face(t));
    // null is "cannot read this face", not "read a smaller number" -- past far
    // enough the ears land on top of each other and there is nothing to say.
    if (reading === null) { previous = null; continue; }
    if (previous !== null) {
      assert.ok(reading >= previous - 1e-9,
        `turning to ${t.toFixed(2)} read ${reading.toFixed(4)}, below ${previous.toFixed(4)}`);
    }
    previous = reading;
    worst = Math.max(worst, reading);
  }
  assert.ok(Math.abs(worst - HEAD_LIMIT) < 1e-9, 'and it ends pinned at the limit');
});

test('a turn and its mirror are the same size', () => {
  assert.ok(Math.abs(yawOf(face(0.5)) + yawOf(face(-0.5))) < 1e-9);
});

test('no readable face is null, not zero', () => {
  // Zero would mean "facing you", which is a claim. Null is the absence of one.
  assert.equal(yawOf(null), null);
  assert.equal(yawOf([]), null);
  const noEars = face(0); noEars[POSE.EARS[0]] = { x: 0, y: 0, visibility: 0.1 };
  assert.equal(yawOf(noEars), null);
  const sideOn = face(0);
  sideOn[POSE.EARS[0]] = { x: 0.5, y: 0.4, visibility: 0.9 };
  sideOn[POSE.EARS[1]] = { x: 0.505, y: 0.4, visibility: 0.9 };
  assert.equal(yawOf(sideOn), null, 'ears on top of each other says nothing');
});

// ── Levelling a pitch against the face it belongs to ──────────────────────────

/** The same face, raised or lowered: the nose moves relative to the ear line. */
/**
 * A face whose whole FRONT sits `lift` ear-spans above the ear line.
 *
 * It moves the eyes with the nose, because readHead() averages all three: they
 * are one rigid front, and a fixture that tips the nose alone is describing a
 * face that cannot exist. Setting only the nose here quietly halved every
 * number this file asserts on.
 */
function facing(turn, lift) {
  const lm = face(turn);
  const span = Math.abs(lm[POSE.EARS[1]].x - lm[POSE.EARS[0]].x);
  const earMid = (lm[POSE.EARS[0]].y + lm[POSE.EARS[1]].y) / 2;
  const front = earMid - lift * span;
  const drop = front - lm[POSE.NOSE].y;   // move the eyes by the same amount
  lm[POSE.NOSE].y = front;
  for (const i of POSE.EYES) lm[i].y += drop;
  return lm;
}

test('lift is raw, and two different faces at rest give different numbers', () => {
  // The whole reason pitch waited for calibration. Neither of these is looking
  // anywhere -- they just have different noses.
  const shallow = readHead(facing(0, -0.30)).lift;
  const deep = readHead(facing(0, -0.55)).lift;
  assert.ok(Math.abs(shallow - deep) > 0.2, 'a fixed constant would libel one of them');
});

test('an unlevelled pitch is zero, not a guess', () => {
  assert.equal(headPitch(readHead(facing(0, -0.4)).lift, null), 0);
});

test('once levelled, the same face reads level', () => {
  const rest = readHead(facing(0, -0.4)).lift;
  assert.ok(Math.abs(headPitch(rest, rest)) < 1e-9);
});

test('raising the nose past its own level reads as looking up', () => {
  const rest = readHead(facing(0, -0.4)).lift;
  assert.ok(headPitch(readHead(facing(0, -0.15)).lift, rest) > 0.1, 'up is positive');
  assert.ok(headPitch(readHead(facing(0, -0.65)).lift, rest) < -0.1, 'down is negative');
});

test('pitch is clamped to something a neck can do', () => {
  const rest = readHead(facing(0, -0.4)).lift;
  assert.ok(Math.abs(headPitch(readHead(facing(0, 3)).lift, rest)) <= HEAD_PITCH_LIMIT);
  assert.ok(Math.abs(headPitch(readHead(facing(0, -3)).lift, rest)) <= HEAD_PITCH_LIMIT);
});

test('levelling waits for stillness rather than trusting one frame', () => {
  const level = createHeadLevel();
  assert.equal(level.feed(0, -0.4, 0), null, 'one frame is not a level');
  assert.equal(level.ready, false);
  let now = 0;
  for (let i = 0; i < 12; i++) { now += 90; level.feed(0, -0.4 + (i % 2) * 0.001, now); }
  assert.equal(level.ready, true);
  assert.ok(Math.abs(level.rest + 0.4) < 0.01);
});

test('a head that is moving never levels', () => {
  const level = createHeadLevel();
  let now = 0;
  for (let i = 0; i < 40; i++) { now += 90; level.feed(0, -0.4 + i * 0.02, now); }
  assert.equal(level.ready, false, 'a sweep is not a rest position');
});

test('a level is never taken while the head is turned', () => {
  // A lift read mid-turn is read on a foreshortened face; baking that in would
  // put the turn permanently into "level".
  const level = createHeadLevel();
  let now = 0;
  for (let i = 0; i < 40; i++) { now += 90; level.feed(0.9, -0.4, now); }
  assert.equal(level.ready, false);
});

test('the player can always overrule it', () => {
  const level = createHeadLevel();
  level.set(-0.31);
  assert.equal(level.rest, -0.31);
  level.forget();
  assert.equal(level.ready, false);
});

// ── Learning the player's own arm ─────────────────────────────────────────────

const arm = (upper, fore) => ({
  shoulder: { x: 0.5, y: 0.4 },
  elbow: { x: 0.5, y: 0.4 + upper },
  wrist: { x: 0.5, y: 0.4 + upper + fore },
});

test('it knows nothing until it has seen an arm', () => {
  assert.equal(createArmSpan().widths, 0, 'zero means "use the assumed constant"');
});

test('the longest arm seen is the one believed', () => {
  // Every pose but one foreshortens, so every reading but one is too SHORT.
  // There is no honest way to read too long, which is why max beats average.
  const span = createArmSpan();
  span.feed(arm(0.10, 0.09), 0.16);          // arm angled toward the lens
  span.feed(arm(0.06, 0.05), 0.16);          // pointing at the camera
  // Three times across the frame -- one is no longer enough to set the scale.
  for (let i = 0; i < 3; i++) span.feed(arm(0.15, 0.13), 0.16);
  // 0.28 / 0.16 = 1.75 widths, exactly: the long end is kept, not averaged.
  assert.ok(Math.abs(span.widths - 1.75) < 1e-9, `held ${span.widths.toFixed(3)}`);
  assert.ok(span.widths > 1.2, 'and nowhere near the foreshortened readings');
});

test('a wild frame cannot become the arm for the rest of the session', () => {
  const span = createArmSpan();
  span.feed(arm(0.15, 0.13), 0.16);
  const good = span.widths;
  span.feed(arm(2.0, 2.0), 0.16);            // a lost wrist somewhere off-frame
  assert.equal(span.widths, good, 'implausible against the shoulders, so ignored');
});

test('a chain built from two different arms is rejected, not learned', () => {
  // The frame that actually broke it. With one hand up the other arm is down
  // and half hidden, and the body model hands back a chain whose shoulder and
  // wrist belong to opposite arms. It measures about two shoulder widths --
  // which the old 2.6 bound happily accepted, and the learner keeps the MAX,
  // so one such frame set the scale for the whole session.
  const span = createArmSpan();
  span.feed(arm(0.15, 0.13), 0.16);          // 1.75 widths: a real arm
  const honest = span.widths;
  span.feed(arm(0.18, 0.155), 0.16);         // 2.09 widths: a crossed chain
  assert.ok(span.widths <= honest, `a bad chain raised the scale to ${span.widths}`);
});

test('the bound is anatomy, and stated as such', () => {
  // An arm is about 0.35 of a person and their shoulders about 0.25, so the
  // ratio lives near 1.4 and does not credibly reach 1.9.
  const span = createArmSpan();
  span.feed(arm(0.17, 0.145), 0.16);         // 1.97 widths
  assert.equal(span.widths, 0, 'past the plausible band, so nothing is learned');
});

test('the ruler stops moving once it has settled', () => {
  // The drift this exists to kill. Every wobble in this number slides the hand,
  // because the hand's place is an offset DIVIDED by it -- so a live scale is a
  // drift no amount of smoothing on the input can reach.
  const span = createArmSpan();
  for (let i = 0; i < 200; i++) span.feed(arm(0.15, 0.13), 0.16);
  assert.ok(span.settled, 'it should have settled by now');
  const locked = span.widths;
  // Even a plausible longer reading cannot move it afterwards.
  span.feed(arm(0.15, 0.145), 0.16);
  assert.equal(span.widths, locked, 'a settled arm does not get longer');
});

test('but it keeps learning while the arm is still growing', () => {
  // Settling early would freeze a foreshortened reading and shrink every
  // movement for the rest of the session.
  const span = createArmSpan();
  for (let i = 0; i < 30; i++) span.feed(arm(0.08, 0.07), 0.16);   // arm toward the lens
  assert.ok(!span.settled, 'thirty frames of one pose is not a whole arm');
  for (let i = 0; i < 3; i++) span.feed(arm(0.15, 0.13), 0.16);    // finally across the frame
  assert.ok(Math.abs(span.widths - 1.75) < 0.01, `took ${span.widths.toFixed(3)}`);
});

test('half an arm chain teaches it nothing', () => {
  const span = createArmSpan();
  span.feed({ shoulder: { x: 0.5, y: 0.4 }, elbow: null, wrist: null }, 0.16);
  assert.equal(span.widths, 0);
  assert.equal(span.feed(arm(0.15, 0.13), 0), 0, 'nor does a body with no width');
});

test('the same arm at a different distance is the same arm', () => {
  // The bug this unit change exists for. Lean toward the lens and every
  // distance in the frame grows together; a learner that stored a raw length
  // would read this as a DIFFERENT arm and rescale the whole mapping, which is
  // why it was fine one moment and wrong the next.
  const near = createArmSpan();
  const far = createArmSpan();
  near.feed(arm(0.30, 0.26), 0.32);          // sitting close: everything doubled
  far.feed(arm(0.15, 0.13), 0.16);           // sitting back
  assert.ok(Math.abs(near.widths - far.widths) < 1e-9,
    `${near.widths.toFixed(3)} close vs ${far.widths.toFixed(3)} far`);
});

test('and moving mid-session does not rescale what was already learned', () => {
  const span = createArmSpan();
  for (let i = 0; i < 5; i++) span.feed(arm(0.15, 0.13), 0.16);
  const seated = span.widths;
  for (let i = 0; i < 5; i++) span.feed(arm(0.30, 0.26), 0.32);   // leans in
  assert.ok(Math.abs(span.widths - seated) < 1e-9, 'the ratio is the same ratio');
});

test('one generous frame cannot set the scale, and three can', () => {
  // The risk the freeze introduced. A plain maximum takes the single longest
  // reading ever seen -- by definition the frame the model got most wrong in
  // the generous direction -- and freezing then makes that frame permanent.
  // Observed locking at 1.91 where the honest readings were 1.73-1.85.
  const span = createArmSpan();
  for (let i = 0; i < 20; i++) span.feed(arm(0.15, 0.13), 0.16);   // 1.75, honest
  const honest = span.widths;
  span.feed(arm(0.16, 0.14), 0.16);                                // 1.88, one bad frame
  assert.equal(span.widths, honest, 'a single outlier must not lift it');
  span.feed(arm(0.16, 0.14), 0.16);
  assert.equal(span.widths, honest, 'nor two');
  span.feed(arm(0.16, 0.14), 0.16);
  assert.ok(span.widths > honest, 'but three consistent readings are an arm');
});

// ── Both hands up ─────────────────────────────────────────────────────────────

const shouldersAt = (y = 0.4, span = 0.2) => ({
  left: { shoulder: { x: 0.5 - span / 2, y } },
  right: { shoulder: { x: 0.5 + span / 2, y } },
});
const wrists = (...ys) => ys.map(y => ({ wrist: { x: 0.5, y } }));

test('both wrists above the shoulder line is a guard', () => {
  assert.equal(handsRaised(wrists(0.15, 0.15), shouldersAt()), true);
});

test('one hand up is not', () => {
  assert.equal(handsRaised(wrists(0.15, 0.7), shouldersAt()), false);
});

test('hands at your sides are not, which is the whole point', () => {
  // The failure this replaced: an arm resting at your side closes the hand, and
  // a closed off hand used to arm the guard.
  assert.equal(handsRaised(wrists(0.75, 0.75), shouldersAt()), false);
});

test('it takes more to raise than to hold, so a sag is not a weapon change', () => {
  const pose = shouldersAt();
  const sagging = wrists(0.375, 0.375);        // inside the band
  assert.equal(handsRaised(sagging, pose, false), false, 'not enough to raise');
  assert.equal(handsRaised(sagging, pose, true), true, 'but enough to hold');
});

test('it means the same thing near the lens and far from it', () => {
  // Everything grows together when the player leans in, so a margin in pixels
  // would be a different posture at every distance. This one is in shoulder
  // widths, the same lesson as the arm scale.
  const far = handsRaised(wrists(0.30, 0.30), shouldersAt(0.4, 0.2));
  const near = handsRaised(wrists(0.20, 0.20), shouldersAt(0.4, 0.4));
  assert.equal(far, near, 'the same pose at two distances should agree');
});

test('no body, or one hand, is never a guard', () => {
  assert.equal(handsRaised(wrists(0.1, 0.1), null), false);
  assert.equal(handsRaised(wrists(0.1), shouldersAt()), false);
  assert.equal(handsRaised([], shouldersAt()), false);
  assert.equal(handsRaised(wrists(0.1, 0.1), { left: { shoulder: { x: 0.4, y: 0.4 } } }), false);
});

test('throwing a punch does not drop you out of the stance', () => {
  // The action the stance exists FOR. A punch sends one hand out and often
  // down; the other stays up. Requiring both on the way out would end boxing
  // mid-swing and arm whatever the off hand's fingers were showing.
  const pose = shouldersAt();
  const jabbing = wrists(0.15, 0.55);          // one guarding, one committed low
  assert.equal(handsRaised(jabbing, pose, true), true, 'still boxing');
});

test('but it still takes both hands up to start', () => {
  assert.equal(handsRaised(wrists(0.15, 0.55), shouldersAt(), false), false);
});

test('and both hands down to stop', () => {
  const pose = shouldersAt();
  assert.equal(handsRaised(wrists(0.7, 0.7), pose, true), false);
});

test('sideOf takes the body over x, and x when there is no body', () => {
  assert.equal(sideOf({ side: 'left', bodySide: 'right' }), 'right');
  assert.equal(sideOf({ side: 'left', bodySide: null }), 'left');
  assert.equal(sideOf({ side: 'right' }), 'right');
  // A hand nothing could place, and no hand at all, are both "no answer" --
  // callers hold what they had rather than guessing a side.
  assert.equal(sideOf({ side: null, bodySide: null }), null);
  assert.equal(sideOf(null), null);
});
