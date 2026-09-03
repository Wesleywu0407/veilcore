// ─── Spell Room — Putting a tracked body onto a rigged one ───────────────────
//
// Everything that turns landmarks into a place for a duelist's hand. It lived
// in js/mirror.js while the mirror was the only thing doing it well, and the
// duel meanwhile kept an older, unrelated implementation that unprojected the
// fingertip through the casting camera. Every fix in this file -- the mirror
// world, the shoulder anchor, the learned arm, the reach clamp, the frozen
// ruler -- was therefore invisible in the duel, which is exactly what "the
// hand in the arena is just wrong" was.
//
// One implementation now, and both pages hold an instance of it. A body map is
// stateful on purpose: the learned arm length, the last good shoulder and the
// last good elbow all have to survive frames where the body model says nothing,
// and each page's player is a different body.

import * as THREE from 'three';
import { shoulderSpan, createArmSpan } from './pose.js';

// An arm, measured in shoulder widths, for before the learner has an answer.
//
// ── Measured, not derived ──
//
// This was 1.55, from anatomy: shoulders about 0.23 of a person's height, arm
// about 0.33. That is a true fact about people and the wrong number for here,
// because MediaPipe's shoulder landmarks sit inside the acromion, nearer the
// neck, so every ratio measured against them runs high -- correctly.
//
// The honest readings this rig has actually produced cluster at 1.72-1.85, so
// the default is the middle of that. It matters more than a default usually
// does: the learner only ever refines this, and refining needs an arm held out
// across the frame, which is a thing nobody can do on a train. Starting at the
// right number means the calibration gesture is optional rather than required.
//
// One person's proportions, so it is a sample and not a population -- but it is
// the right sample, being the person the thing is for.
export const ARM_IN_SPANS = 1.78;

// ...and only until the player's own has been seen. See createArmSpan().
// ...and only until the player's own has been seen. See createArmSpan().

// How far out the character goes when you are at full stretch. Not 1: see the
// note in handTarget().
const REACH_FULL = 0.93;

// How much of the leftover length to spend on depth. Not 1: a hand held at
// shoulder height in front of you is not at full stretch toward the lens.
const REACH_DEPTH = 0.85;

// ── The last shoulder each arm was measured against ──
//
// frame.pose goes null the instant the body model misses a sample -- the body
// leaves shot, an arm crosses the torso, a shoulder drops under the visibility
// floor -- and it is sampled at a third of the hands' rate to begin with.
//
// Falling back to reachBox() there is not a smaller version of the same answer,
// it is a DIFFERENT MAPPING: one measures from your shoulder, the other from
// the middle of the picture. Swapping between them mid-gesture moves the hand
// by however far your shoulder happens to be from centre, in one frame. That is
// the hand suddenly flying off -- not drift, a cut.
//
// A shoulder that is one sample old is a perfectly good shoulder. Hold it.
// ── The tracker hands out a MIRROR WORLD, and a mirror world has no chirality ──
//
// tracker.js flips x (`1 - x`) on every landmark, so a hand held out to the
// player's right arrives on the right of the picture. That is the selfie
// convention, and it is the right one for something you look AT. It is also a
// reflection: a reflected right hand is congruent to a LEFT hand, so every
// basis built from those landmarks comes out inside out. The -1 the duel
// carries in PALM_HANDEDNESS is what has been paying that bill.
//
// This is not a mirror in that sense. The character is the player seen from
// BEHIND -- raise your right hand and its right hand goes up -- so the map from
// the one body to the other is the identity, and the flip is pure damage. Undo
// it once, here at the door, and everything below reads a faithful room.
//
// Points un-flip as `1 - x`; directions would un-flip as `-x`. Only points are
// un-flipped, and palmBasis() derives its directions from those, so the file
// has one rule to keep straight instead of two.
/**
 * A direction in the raw picture, pointed the same way in the BODY's space.
 *
 * It used to go through the viewing camera, which was left over from before the
 * hand target moved into body space -- so the palm turned when you orbited and
 * the hand did not. Two halves of one gesture in two different frames.
 *
 * The mapping, from un-flipped camera space to the duelist's local axes:
 *
 *   raw +x  the camera's right -> the player's LEFT, so the body's,  local +X
 *   raw +y  down the picture   -> down the body,                     local -Y
 *   raw +z  away from the lens -> behind the player, so the body's,  local -Z
 *
 * Note the determinant: (+1)(-1)(-1) = +1. It is a ROTATION, which is the whole
 * point: a det -1 map turns palmBasis's right-handed triple into a left-handed
 * one, and the rotation pulled out of that is not a rotation of anything real.
 *
 * With the tracker's FLIPPED x, the signs that point the same physical way are
 * (-1)(-1)(-1) = -1. That is the reflection, and it is why the palm kept
 * arriving upside down: not one sign to hunt for, a whole flipped room.
 */

/**
 * Where the elbow wants to be, as a point the solver reads a DIRECTION from.
 *
 * Not the elbow's own place in the picture, and not through reachBox() -- see
 * elbowHint() for why both of those put the elbow in front of the wrist. What
 * goes across is the OFFSET from the tracked shoulder, which is the one thing
 * the body model is genuinely good at: it drops depth constantly, but which way
 * an elbow leans is exactly what it can see.
 */
// The last bend each arm was given, held for the same reason the shoulder
// anchor is -- and it is the more urgent of the two.
//
// The elbow is the least visible joint on the chain: MediaPipe drops it
// whenever an arm passes in front of the torso, which is most of casting. When
// the hint goes, the IK falls back to the constructor's fixed pole, and that
// pole points DOWN AND BACK -- correct when it was written, with hands held
// near the chest, and wrong now that the depth model puts them up to 0.85 of an
// arm out in front. An elbow hinted behind a hand that is far forward is a
// wrenched arm, and it appears and disappears with the pose.
//
// An elbow one sample old is a perfectly good elbow.
const lastBend = { left: null, right: null };


/**
 * One player's body map. Stateful: see the note at the top of the file.
 *
 * `avatar` is the duelist this drives. Nothing here reads the scene camera,
 * which is the point -- a body measured against its own shoulders means the
 * same thing from behind, from inside the head, and from anywhere the duel
 * happens to swing its lens.
 */
export function createBodyMap(avatar) {
  const armSpan = { left: createArmSpan(), right: createArmSpan() };
  const lastAnchor = { left: null, right: null };
  const lastBend = { left: null, right: null };
  const _handTarget = new THREE.Vector3();
  const _elbow = new THREE.Vector3();
  const _origin = new THREE.Vector3();
  const _raw = [];

  function unflip(landmarks) {
    for (let i = 0; i < landmarks.length; i++) {
      const p = landmarks[i];
      const q = (_raw[i] ??= { x: 0, y: 0, z: 0 });
      q.x = 1 - p.x; q.y = p.y; q.z = p.z;
    }
    _raw.length = landmarks.length;
    return _raw;
  }

  function handTarget(side, at, pose) {
    const shoulder = pose?.[side]?.shoulder;
    const shoulders = shoulderSpan(pose);
    const rig = armSpan[side];
    const learned = shoulders ? rig.feed(pose[side], shoulders) : 0;
    const widths = rig.settled ? learned : Math.max(learned, ARM_IN_SPANS);
    const scale = shoulders * widths;
    if (shoulder && scale) lastAnchor[side] = { x: shoulder.x, y: shoulder.y, scale };
    const held = lastAnchor[side];
    if (!held) return avatar.reachBox(side, 1 - at.x, at.y, _handTarget);

    let dx = (held.x - at.x) / held.scale;
    let dy = -(at.y - held.y) / held.scale;
    const flat = Math.hypot(dx, dy);
    if (flat > 1) { dx /= flat; dy /= flat; }
    const settled = Math.min(1, flat);
    const dz = Math.sqrt(1 - settled * settled) * REACH_DEPTH;
    return avatar.reachOffset(
      side, dx * REACH_FULL, dy * REACH_FULL, dz * REACH_FULL, _handTarget);
  }

  function elbowTarget(side, arm) {
    if (arm?.elbow && arm?.shoulder) {
      lastBend[side] = {
        dx: arm.shoulder.x - arm.elbow.x,
        dy: arm.elbow.y - arm.shoulder.y,
      };
    }
    const held = lastBend[side];
    return held ? avatar.elbowHint(side, held.dx, held.dy, _elbow) : null;
  }

  function direction(v, out) {
    out.set(v.x, -v.y, -v.z).normalize();
    return avatar.root.localToWorld(out).sub(avatar.root.getWorldPosition(_origin));
  }

  return {
    unflip,
    handTarget,
    elbowTarget,
    direction,
    /** The right arm's learned length, for a readout. */
    get arm() { return armSpan.right; },
    /** A held shoulder is only good while it is still YOUR shoulder. */
    forget() {
      lastAnchor.left = lastAnchor.right = null;
      lastBend.left = lastBend.right = null;
    },
  };
}

/** The point an arm follows. Falls back to the tip if a hand predates anchors. */
export const anchorOf = hand => hand.anchor ?? hand.tip;
