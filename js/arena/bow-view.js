// ─── Veilcore — the bow you hold ─────────────────────────────────────────────
//
// The bow body is a Meshy model; the string and the arrow are built here. That
// split is not laziness, it is the shape of the problem: the limbs never change,
// and the string and arrow do nothing BUT change. Generated geometry is static,
// so a baked string can only ever be drawn at one draw length — which is why the
// one Meshy insisted on adding was cut out of the model.
//
// Parented to the camera, so it is a viewmodel rather than a thing in the world.
// The practice range has no body to hold it.

import * as THREE from 'three';

const BOW_LENGTH = 1.6;      // world units, roughly a real recurve
const REST = { x: -0.46, y: -0.30, z: -0.95 };   // where it sits in front of the lens
const NOCK_TRAVEL = 0.40;    // how far the string comes back at full draw
const ARROW_LENGTH = 0.85;

export function createBowView(camera) {
  const rig = new THREE.Group();
  rig.position.set(REST.x, REST.y, REST.z);
  // Held canted, the way an archer actually holds one — dead vertical reads as
  // a prop stuck to the screen.
  rig.rotation.set(0, 0.35, 0.20);
  camera.add(rig);

  // ── string ──
  // Three points: upper nock, the fingers, lower nock. Rebuilt every frame,
  // which is cheap for three vertices and is the whole reason it is not baked.
  const stringGeometry = new THREE.BufferGeometry();
  stringGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
  const string = new THREE.Line(
    stringGeometry,
    new THREE.LineBasicMaterial({ color: 0xf3ead7, transparent: true, opacity: 0.85 }),
  );
  string.frustumCulled = false;
  rig.add(string);

  // ── arrow ──
  const arrow = new THREE.Group();
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, ARROW_LENGTH, 6),
    new THREE.MeshStandardMaterial({ color: 0xe8e0cc, roughness: 0.6 }),
  );
  shaft.rotation.z = Math.PI / 2;          // lie along X, the bow's own axis
  arrow.add(shaft);
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.028, 0.09, 6),
    new THREE.MeshStandardMaterial({ color: 0xffd98a, emissive: 0xffd98a, emissiveIntensity: 0.35, roughness: 0.35 }),
  );
  head.rotation.z = -Math.PI / 2;
  head.position.x = ARROW_LENGTH / 2 + 0.045;
  arrow.add(head);
  rig.add(arrow);

  let limbs = null;
  let tipA = new THREE.Vector3(0, 0.8, 0);
  let tipB = new THREE.Vector3(0, -0.8, 0);

  const positions = stringGeometry.getAttribute('position');
  const _nock = new THREE.Vector3();

  function layout(draw) {
    // The nock rides back along the bow's own -X, which after the rig rotation
    // is "toward the archer".
    _nock.set(-NOCK_TRAVEL * draw, 0, 0);
    positions.setXYZ(0, tipA.x, tipA.y, tipA.z);
    positions.setXYZ(1, _nock.x, _nock.y, _nock.z);
    positions.setXYZ(2, tipB.x, tipB.y, tipB.z);
    positions.needsUpdate = true;
    arrow.position.set(_nock.x + ARROW_LENGTH / 2, 0, 0);
  }
  layout(0);

  return {
    rig,
    get ready() { return limbs !== null; },

    /** Give it the loaded bow.glb scene. Until then the string and arrow stand alone. */
    attachLimbs(model) {
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      // The model lies along its longest axis; stand it up so the limbs run
      // vertically and the nock travels sideways, away from the archer.
      const longest = Math.max(size.x, size.y, size.z);
      model.scale.setScalar(BOW_LENGTH / Math.max(longest, 1e-6));
      model.rotation.z = Math.PI / 2;
      model.position.set(0, 0, 0);
      rig.add(model);
      limbs = model;
      tipA.set(0, BOW_LENGTH / 2 * 0.94, 0);
      tipB.set(0, -BOW_LENGTH / 2 * 0.94, 0);
      layout(0);
    },

    setDraw(draw) { layout(draw); },
    setVisible(visible) { rig.visible = visible; },
    setNocked(nocked) { arrow.visible = nocked; string.material.opacity = nocked ? 0.95 : 0.55; },
  };
}
