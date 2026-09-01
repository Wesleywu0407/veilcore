// The rune hand is the duelist's RIGHT hand. In the model's local space +X is
// the duelist's left and +Z is forward, so an unrestricted +X target asks the
// right arm to cross the whole torso. The IK can satisfy that request only by
// rolling the shoulder through the chest or sending the elbow round the back.
//
// These limits are fractions of the rig's measured arm span. They describe a
// reachable writing envelope, not screen coordinates, so camera framing and a
// regenerated character scale cannot silently change the anatomy.
export const RUNE_REACH = Object.freeze({
  ownSide: 0.92,
  acrossBody: 0.42,
  forward: 0.18,

  // How far clear of the chest the wrist is held. The only number in this file
  // set by eye rather than measured off the rig: it has to cover the distance
  // from the torso surface to the middle of a wrist, which is a property of the
  // hand mesh and not of the skeleton. Look at it on screen before moving it.
  torsoClearance: 0.12,
});

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * Clamp a right-hand rune target in duelist-local space.
 *
 * Mutates and returns `out`, which may be the same object as `target`. Keeping
 * this plain-number maths separate from Three makes the anatomical rule cheap
 * to test without a camera, DOM, or loaded skeleton.
 */
export function constrainRuneReach(target, shoulder, armSpan, out = target) {
  if (!target || !shoulder || !Number.isFinite(armSpan) || armSpan <= 0) return out;

  const dx = clamp(
    target.x - shoulder.x,
    -armSpan * RUNE_REACH.ownSide,
    armSpan * RUNE_REACH.acrossBody,
  );
  const dz = Math.max(target.z - shoulder.z, armSpan * RUNE_REACH.forward);

  out.x = shoulder.x + dx;
  out.y = target.y;
  out.z = shoulder.z + dz;

  // ── Out of the chest ──
  //
  // The side limits above stop the arm crossing the body, and the forward limit
  // stops it solving behind the shoulder, but between them they still allow a
  // point on the centre line only 0.18 of an arm in front of it -- which is
  // inside the ribs. The IK then quite correctly puts a wrist there.
  //
  // So model the torso as a circle in the XZ plane about the body's own centre
  // line and hold the hand outside its front face. The radius is the shoulder's
  // own offset, which is measured off the rig at load rather than guessed here,
  // and adapts on its own if the character is ever regenerated at a different
  // build. It overstates the chest's DEPTH a little -- shoulders are wider than
  // a chest is deep -- and that error is in the safe direction.
  //
  // ── Forward only, never sideways ──
  //
  // The push is applied to z alone. That is not laziness: the hand target is
  // unprojected from the player's own fingertip so that the duelist's hand
  // appears under the stroke being drawn, and the camera looks very nearly
  // along +Z. Moving the hand forward slides it along the line of sight and
  // barely moves it on screen; moving it sideways would visibly tear it away
  // from the stroke, which is the correspondence the whole unprojection exists
  // to keep.
  const halfWidth = Math.abs(shoulder.x);
  if (halfWidth > 0 && Math.abs(out.x) < halfWidth) {
    const front = Math.sqrt(halfWidth * halfWidth - out.x * out.x);
    out.z = Math.max(out.z, front + armSpan * RUNE_REACH.torsoClearance);
  }

  // Deliberately unbounded in y. A torso ends at the shoulders, so a cylinder
  // that runs the whole height also pushes a hand held above the head forward
  // by a few centimetres it does not need -- but there is a head up there, which
  // is not somewhere a wrist should be either, and along the line of sight that
  // offset is not visible. A y band would buy nothing and add a seam at the
  // shoulder line for the hand to pop through.
  return out;
}
