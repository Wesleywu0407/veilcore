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
  return out;
}
