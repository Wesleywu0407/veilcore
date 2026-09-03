// ─── Veilcore — bow measurement ───────────────────────────────────────────────
//
//   node --test tests/archery.test.mjs
//
// Every number the bow reports is checked here against synthetic hands, so the
// draw curve and the release rules can be tuned without a camera. If a change
// makes the bow feel wrong in practice mode, the fix belongs in BOW and should
// show up as a failure here first.

import test from "node:test";
import assert from "node:assert/strict";

import { BOW, readBow, pinchRatio, createBowState } from "../js/spell-room/archery.js";
import { LM } from "../js/spell-room/vec.js";

/**
 * A hand at (x, y). `span` is wrist→middle-knuckle, which stands in for how far
 * the player is from the lens. `pinch` IS the reported ratio: the thumb-index
 * gap is built as pinch × span, and the ratio divides that span straight back
 * out again.
 */
function hand({ x, y = 0.5, span = 0.1, pinch = 0.3 }) {
  const lm = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  lm[LM.WRIST] = { x, y, z: 0 };
  lm[LM.MIDDLE_MCP] = { x, y: y - span, z: 0 };
  lm[LM.THUMB_TIP] = { x, y, z: 0 };
  lm[LM.INDEX_TIP] = { x: x + pinch * span, y, z: 0 };
  return { landmarks: lm, wrist: lm[LM.WRIST], tip: lm[LM.INDEX_TIP], scale: span };
}

const CLOSED = 0.2;   // below BOW.PINCH_ON
const OPEN = 0.9;     // above BOW.PINCH_OFF

test("pinchRatio is the gap over the hand span, so it is scale free", () => {
  assert.ok(Math.abs(pinchRatio(hand({ x: 0.3, span: 0.05, pinch: 0.4 }).landmarks) - 0.4) < 1e-9);
  assert.ok(Math.abs(pinchRatio(hand({ x: 0.3, span: 0.20, pinch: 0.4 }).landmarks) - 0.4) < 1e-9);
});

test("one hand is not a bow", () => {
  assert.equal(readBow([hand({ x: 0.3 })]), null);
  assert.equal(readBow([]), null);
  assert.equal(readBow(null), null);
});

test("draw runs 0 at the slack point and 1 at full draw", () => {
  const span = 0.1;
  const at = (spans) => readBow([
    hand({ x: 0.2, span, pinch: CLOSED }),
    hand({ x: 0.2 + spans * span, span, pinch: OPEN }),
  ]).draw;
  // Tolerances, not equality: draw is a ratio of two differences, so whether it
  // lands exactly on 1 depends on which constants happen to divide evenly. It
  // did with the first guessed pair and stopped when they were replaced by
  // measured ones, which is a fact about floating point and not about the bow.
  const near = (a, b, why) => assert.ok(Math.abs(a - b) < 1e-9, `${why}: ${a} vs ${b}`);
  near(at(BOW.DRAW_MIN), 0, "slack point");
  near(at(BOW.DRAW_FULL), 1, "full draw");
  near(at((BOW.DRAW_MIN + BOW.DRAW_FULL) / 2), 0.5, "halfway");
  assert.equal(at(BOW.DRAW_MIN - 1), 0, "slack does not go negative");
  near(at(BOW.DRAW_FULL + 2), 1, "over-draw clamps");
});

test("the same pose reads the same draw near the lens and far from it", () => {
  const near = readBow([hand({ x: 0.1, span: 0.2, pinch: CLOSED }), hand({ x: 0.1 + 3 * 0.2, span: 0.2, pinch: OPEN })]);
  const far = readBow([hand({ x: 0.4, span: 0.05, pinch: CLOSED }), hand({ x: 0.4 + 3 * 0.05, span: 0.05, pinch: OPEN })]);
  assert.ok(Math.abs(near.draw - far.draw) < 1e-9, `${near.draw} vs ${far.draw}`);
  assert.ok(Math.abs(near.spans - far.spans) < 1e-9);
});

test("aim points from the string toward the bow", () => {
  // string on the left with fingers closed, bow arm out to the right
  const r = readBow([hand({ x: 0.2, y: 0.5, pinch: CLOSED }), hand({ x: 0.6, y: 0.5, pinch: OPEN })]);
  assert.ok(r.aim.x > 0.99, `aim.x ${r.aim.x}`);
  assert.ok(Math.abs(r.aim.y) < 1e-9);
  assert.ok(Math.abs(r.angle) < 1e-9, `angle ${r.angle}`);

  // bow arm raised: screen y grows downward, so a positive angle is upward
  const up = readBow([hand({ x: 0.2, y: 0.5, pinch: CLOSED }), hand({ x: 0.2, y: 0.1, pinch: OPEN })]);
  assert.ok(Math.abs(up.angle - 90) < 1e-9, `angle ${up.angle}`);
});

test("the closed hand is the string, whichever side it is on", () => {
  const left = readBow([hand({ x: 0.2, pinch: CLOSED }), hand({ x: 0.6, pinch: OPEN })]);
  assert.equal(left.string.wrist.x, 0.2);
  assert.equal(left.stringSide, 'left');
  const right = readBow([hand({ x: 0.2, pinch: OPEN }), hand({ x: 0.6, pinch: CLOSED })]);
  assert.equal(right.string.wrist.x, 0.6, "a left-handed archer needs no setting");
  assert.equal(right.stringSide, 'right');
});

// ─── The shot ────────────────────────────────────────────────────────────────

const span = 0.1;
const pose = (spans, pinch) => [
  hand({ x: 0.2, span, pinch }),
  hand({ x: 0.2 + spans * span, span, pinch: OPEN }),
];

test("closing on the string nocks, opening it looses", () => {
  const bow = createBowState();
  let t = 1000;
  assert.equal(bow.update(pose(2.0, OPEN), t).phase, "idle");
  assert.equal(bow.update(pose(2.0, CLOSED), t += 16).phase, "nocked");
  const drawn = bow.update(pose(BOW.DRAW_FULL, CLOSED), t += 16);
  assert.ok(drawn.draw > 0.99, `draw ${drawn.draw}`);
  assert.equal(drawn.event, null, "still holding");

  bow.update(pose(BOW.DRAW_FULL, OPEN), t += 16);            // opening starts
  const shot = bow.update(pose(BOW.DRAW_FULL, OPEN), t += BOW.RELEASE_HOLD_MS);
  assert.ok(shot.event, "should have loosed");
  assert.equal(shot.event.type, "loosed");
  assert.ok(shot.event.power > 0.99, `power ${shot.event.power}`);
  assert.equal(shot.phase, "idle", "back to empty hands after the shot");
});

test("a twitch is not a shot, unless the floor is lowered", () => {
  // Slack: the wrists never leave DRAW_MIN, so the draw stays at zero.
  const slack = () => {
    const bow = createBowState();
    let t = 1000;
    bow.update(pose(BOW.DRAW_MIN, CLOSED), t += 16);
    bow.update(pose(BOW.DRAW_MIN, OPEN), t += 16);
    return bow.update(pose(BOW.DRAW_MIN, OPEN), t += BOW.RELEASE_HOLD_MS);
  };
  assert.equal(slack().event, null, "the duel refuses a shot that was never drawn");

  const bow = createBowState({ minLooseDraw: 0 });
  let t = 1000;
  bow.update(pose(BOW.DRAW_MIN, CLOSED), t += 16);
  bow.update(pose(BOW.DRAW_MIN, OPEN), t += 16);
  const shot = bow.update(pose(BOW.DRAW_MIN, OPEN), t += BOW.RELEASE_HOLD_MS);
  assert.ok(shot.event, "the range fires whatever the hands were doing");
  assert.equal(shot.event.type, "loosed");
  assert.equal(shot.event.power, 0, "and reports the draw it actually had");
});

test("the string can be required to have been held", () => {
  const HOLD = 1000;
  const draw = (bow, ms) => {
    let t = 1000;
    bow.update(pose(BOW.DRAW_FULL, CLOSED), t += 16);          // nock
    bow.update(pose(BOW.DRAW_FULL, CLOSED), t += ms);          // hold this long
    bow.update(pose(BOW.DRAW_FULL, OPEN), t += 16);            // open
    return bow.update(pose(BOW.DRAW_FULL, OPEN), t += BOW.RELEASE_HOLD_MS);
  };

  // Let go early and the arrow is put away, exactly as collapsing the draw does.
  const early = draw(createBowState({ minHoldMs: HOLD }), 200);
  assert.equal(early.event, null, "released before the hold was up");
  assert.equal(early.phase, "idle", "and the arrow is put away, not kept");

  const late = draw(createBowState({ minHoldMs: HOLD }), HOLD + 50);
  assert.ok(late.event, "held long enough");
  assert.equal(late.event.type, "loosed");

  // The duel asks for no hold, so the same early release still fires there.
  assert.ok(draw(createBowState(), 200).event, "default is no hold at all");
});

test("the hold is reported while it runs", () => {
  const bow = createBowState({ minHoldMs: 1000 });
  let t = 1000;
  assert.equal(bow.update(pose(2.0, OPEN), t).held, 0, "nothing held before a nock");
  bow.update(pose(BOW.DRAW_FULL, CLOSED), t += 16);
  assert.equal(bow.update(pose(BOW.DRAW_FULL, CLOSED), t += 400).held, 400);
  assert.equal(bow.update(pose(BOW.DRAW_FULL, CLOSED), t += 400).held, 800);
});

test("a single dropped frame is not a loose", () => {
  const bow = createBowState();
  let t = 1000;
  bow.update(pose(2.0, CLOSED), t += 16);
  bow.update(pose(BOW.DRAW_FULL, CLOSED), t += 16);
  const blip = bow.update(pose(BOW.DRAW_FULL, OPEN), t += 16);   // one frame open
  assert.equal(blip.event, null, "must wait out RELEASE_HOLD_MS");
  const back = bow.update(pose(BOW.DRAW_FULL, CLOSED), t += 16);
  assert.equal(back.phase, "nocked", "and re-closing cancels it");
});

test("power is the deepest draw reached, not the draw at the instant of release", () => {
  // Fingers open as the string springs forward, so the draw is already
  // collapsing by the time the release is confirmed. Reading it then would
  // punish every shot.
  const bow = createBowState();
  let t = 1000;
  bow.update(pose(2.0, CLOSED), t += 16);
  bow.update(pose(BOW.DRAW_FULL, CLOSED), t += 16);
  bow.update(pose(BOW.DRAW_FULL, OPEN), t += 16);
  const shot = bow.update(pose(BOW.DRAW_MIN, OPEN), t += BOW.RELEASE_HOLD_MS);
  assert.ok(shot.event, "should still loose");
  assert.ok(shot.event.power > 0.99, `power collapsed to ${shot.event.power}`);
});

test("a twitch does not fire", () => {
  const bow = createBowState();
  let t = 1000;
  bow.update(pose(BOW.DRAW_MIN, CLOSED), t += 16);
  bow.update(pose(BOW.DRAW_MIN, OPEN), t += 16);
  const shot = bow.update(pose(BOW.DRAW_MIN, OPEN), t += BOW.RELEASE_HOLD_MS);
  assert.equal(shot.event, null, "no draw, no arrow");
});

test("losing a hand puts the bow away without firing", () => {
  const bow = createBowState();
  let t = 1000;
  bow.update(pose(2.0, CLOSED), t += 16);
  bow.update(pose(BOW.DRAW_FULL, CLOSED), t += 16);
  const dropped = bow.update([hand({ x: 0.2 })], t += 16);
  assert.equal(dropped.event, null, "a hand leaving frame must not loose");
  assert.equal(dropped.phase, "idle");
});
