// ─── Veilcore — the bow you hold ─────────────────────────────────────────────
//
// The limbs are a Meshy model; the string and the arrow are built here. That
// split follows the problem: the limbs never change, and the string does nothing
// but change, so a baked string can only ever be right at one draw length.
//
// Parented to the camera — the practice range has no body to hold it.
//
// ── Orientation, because guessing it got it wrong once ──
//
// In the model's own space the limbs run along X, the arc bulges toward +Y, and
// the string sits at Y = -0.21. So the archer stands on -Y and the arrow leaves
// toward +Y. What we need instead is limbs vertical and the arrow leaving the
// lens, which is:
//
//     model +X  ->  world +Y     limbs stand up
//     model +Y  ->  world -Z     the shot goes away from the camera
//
// That is Ry(-90) * Rz(+90), checked by applying it to the basis vectors rather
// than reasoned about in Euler angles, where the order would have hidden the
// mistake again. The first attempt applied only the Rz half, which laid the bow
// flat and pointed the arrow sideways across the screen.

import * as THREE from 'three';

const BOW_LENGTH = 1.55;       // world units, roughly a real recurve
const MODEL_LIMB_AXIS = 1.902; // measured span of bow.glb along its long axis
const NOCK_TRAVEL = 0.42;      // how far the string comes back at full draw
const ARROW_LENGTH = 0.9;

// Where the bow sits in front of the lens, and how it is canted. An archer does
// not hold a bow dead vertical, and dead vertical also reads as a prop taped to
// the screen.
const REST = { x: -0.30, y: -0.24, z: -0.62 };
const CANT = { y: 0.14, z: 0.16 };

export function createBowView(camera) {
  const rig = new THREE.Group();
  rig.position.set(REST.x, REST.y, REST.z);
  rig.rotation.set(0, CANT.y, CANT.z);
  camera.add(rig);

  // Three points: upper nock, the fingers, lower nock. Rebuilt every frame,
  // which is trivial for three vertices and is the entire reason it is not baked.
  const stringGeometry = new THREE.BufferGeometry();
  stringGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  const string = new THREE.Line(
    stringGeometry,
    new THREE.LineBasicMaterial({ color: 0xf3ead7, transparent: true, opacity: 0.9 }),
  );
  string.frustumCulled = false;   // it is rebuilt in place; its bounds lie
  rig.add(string);

  // The arrow lies along -Z, the way it will fly.
  const arrow = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.011, 0.011, ARROW_LENGTH, 6),
    new THREE.MeshStandardMaterial({ color: 0xe8e0cc, roughness: 0.6 }),
  );
  shaft.rotation.x = Math.PI / 2;             // cylinders stand along Y by default
  arrow.add(shaft);
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.026, 0.085, 6),
    new THREE.MeshStandardMaterial({ color: 0xffd98a, emissive: 0xffd98a, emissiveIntensity: 0.4, roughness: 0.35 }),
  );
  head.rotation.x = -Math.PI / 2;             // +Y tip swung round to -Z
  head.position.z = -ARROW_LENGTH / 2 - 0.042;
  arrow.add(head);
  rig.add(arrow);

  let limbs = null;
  let halfSpan = BOW_LENGTH / 2 * 0.94;
  let stringZ = 0;
  const positions = stringGeometry.getAttribute('position');

  function layout(draw) {
    const back = stringZ + NOCK_TRAVEL * draw;   // +Z is toward the archer
    positions.setXYZ(0, 0, halfSpan, stringZ);
    positions.setXYZ(1, 0, 0, back);
    positions.setXYZ(2, 0, -halfSpan, stringZ);
    positions.needsUpdate = true;
    arrow.position.set(0, 0, back - ARROW_LENGTH / 2);
  }
  layout(0);

  return {
    rig,
    get ready() { return limbs !== null; },

    /** Hand it the loaded bow.glb scene. The string and arrow work without it. */
    attachLimbs(model) {
      const scale = BOW_LENGTH / MODEL_LIMB_AXIS;
      model.scale.setScalar(scale);
      model.quaternion
        .setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
      model.position.set(0, 0, 0);
      rig.add(model);
      limbs = model;

      // Find where the limbs actually end and anchor the string there. Deriving
      // it from a recorded model dimension instead put the string plane 0.056
      // short of the tips, leaving it floating in front of them -- and it would
      // have gone quietly wrong again the first time the model was regenerated.
      const tip = { y: 0, z: 0 };
      const v = new THREE.Vector3();
      model.updateMatrixWorld(true);
      model.traverse((object) => {
        const position = object.isMesh && object.geometry?.getAttribute('position');
        if (!position) return;
        for (let i = 0; i < position.count; i++) {
          v.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
          if (Math.abs(v.y) > Math.abs(tip.y)) { tip.y = v.y; tip.z = v.z; }
        }
      });
      halfSpan = Math.abs(tip.y) * 0.97;
      stringZ = tip.z;
      layout(0);
    },

    setDraw(draw) { layout(draw); },
    setVisible(visible) { rig.visible = visible; },
    setNocked(nocked) { arrow.visible = nocked; string.material.opacity = nocked ? 0.95 : 0.5; },
  };
}
