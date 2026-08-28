// ─── SKYVEIL Duel — two-bone arm IK ──────────────────────────────────────────
//
// Bends shoulder -> elbow -> wrist so the wrist lands on a target, overriding
// whatever the animation put there. Analytic, not iterative: a two-bone chain
// has a closed-form solution (the law of cosines gives the elbow angle, one
// swing aims the whole chain), so this costs a handful of trig calls per frame
// and never "converges" badly the way a CCD/FABRIK loop can.
//
// The Meshy rig has no finger bones -- LeftHand/RightHand are terminal -- so
// this moves an arm through the air. It cannot curl fingers, and nothing here
// will change that.

import * as THREE from 'three';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const EPS = 1e-4;

export function createArmIK(root, { shoulder, elbow, wrist, pole }) {
  const bones = {
    shoulder: root.getObjectByName(shoulder),
    elbow: root.getObjectByName(elbow),
    wrist: root.getObjectByName(wrist),
  };
  if (!bones.shoulder || !bones.elbow || !bones.wrist) return null;

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), cb = new THREE.Vector3(), ac = new THREE.Vector3(), at = new THREE.Vector3();
  const axis = new THREE.Vector3(), fallback = new THREE.Vector3();
  const spin = new THREE.Quaternion(), parentWorld = new THREE.Quaternion(), boneWorld = new THREE.Quaternion();

  // Rotate a bone by a world-space axis/angle, expressed back in its parent's
  // frame. Bones live in local space, so a world rotation cannot be applied
  // directly without unwinding the parent.
  function rotateWorld(bone, axisWorld, angle) {
    if (!Number.isFinite(angle) || Math.abs(angle) < EPS) return;
    spin.setFromAxisAngle(axisWorld, angle);
    bone.getWorldQuaternion(boneWorld);
    bone.parent.getWorldQuaternion(parentWorld);
    bone.quaternion.copy(parentWorld.invert().multiply(spin.multiply(boneWorld)));
    bone.updateMatrixWorld(true);
  }

  return {
    bones,
    /**
     * @param target world-space point the wrist should reach
     * @param weight 0 leaves the animation alone, 1 fully commits to the target
     */
    solve(target, weight = 1) {
      if (weight <= 0) return;
      bones.shoulder.updateMatrixWorld(true);
      bones.shoulder.getWorldPosition(a);
      bones.elbow.getWorldPosition(b);
      bones.wrist.getWorldPosition(c);

      const upper = a.distanceTo(b);
      const fore = b.distanceTo(c);
      if (upper < EPS || fore < EPS) return;

      // Blending in world space keeps the elbow on a sane arc; blending the
      // final quaternions instead can swing it through the torso.
      at.copy(target).sub(c).multiplyScalar(weight).add(c);
      // Just short of full extension: at exactly upper+fore the bend axis is
      // undefined and the elbow pops.
      const reach = clamp(a.distanceTo(at), Math.abs(upper - fore) + EPS, upper + fore - EPS);

      ab.copy(b).sub(a).normalize();
      cb.copy(b).sub(c).normalize();
      ac.copy(c).sub(a).normalize();

      // The plane the arm currently bends in. Straight arms give a degenerate
      // cross product, so fall back to a pole hint and keep the elbow behind.
      axis.copy(ac).cross(ab);
      if (axis.lengthSq() < 1e-8) {
        fallback.copy(pole ?? new THREE.Vector3(0, 0, -1));
        bones.shoulder.localToWorld(fallback).sub(a);
        axis.copy(ac).cross(fallback);
        if (axis.lengthSq() < 1e-8) return;
      }
      axis.normalize();

      const angleNow = Math.acos(clamp(ac.dot(ab), -1, 1));
      const elbowNow = Math.acos(clamp(ab.clone().negate().dot(cb.clone().negate()), -1, 1));
      const angleWant = Math.acos(clamp((fore * fore - upper * upper - reach * reach) / (-2 * upper * reach), -1, 1));
      const elbowWant = Math.acos(clamp((reach * reach - upper * upper - fore * fore) / (-2 * upper * fore), -1, 1));

      rotateWorld(bones.shoulder, axis, angleWant - angleNow);
      rotateWorld(bones.elbow, axis, elbowWant - elbowNow);

      // Now the chain has the right shape; swing it onto the target.
      bones.shoulder.getWorldPosition(a);
      bones.wrist.getWorldPosition(c);
      ac.copy(c).sub(a).normalize();
      at.copy(target).sub(c).multiplyScalar(weight).add(c).sub(a).normalize();
      axis.copy(ac).cross(at);
      if (axis.lengthSq() < 1e-8) return;
      rotateWorld(bones.shoulder, axis.normalize(), Math.acos(clamp(ac.dot(at), -1, 1)));
    },
  };
}
