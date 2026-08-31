// ─── Ringfall's halo ─────────────────────────────────────────────────────────
//
// The ring the spell is named after, and the thing the player watches while
// they hold a charge.
//
// It has two lives. First it FORMS at the casting hand and spins there,
// widening and brightening as the charge builds -- that is the whole point of
// it, because charging is the only part of this game where the player is
// standing still with their hand up and nothing to look at. Then, on release,
// it leaves along the beam.
//
// Purely visual: no damage, no hit test. The beam underneath already owns both,
// and a spell whose damage lives in two places is a spell nobody can retune
// safely.
//
// The model arrives late and the spell works without it: the beam fires either
// way, and a missing or slow asset costs the flourish, not the cast.

import * as THREE from 'three';

// ── Charging, at the hand ──
// Fallback when no viewer is supplied. The duel passes its camera and presents
// the ring slightly toward it instead; pushing downrange from a third-person
// hand puts the ring behind the glove and the character's head.
const HAND_AHEAD = 0.52;
const HAND_TOWARD_VIEWER = 0.46;
const CHARGE_SIZE_MIN = 0.42;   // the instant it forms
const CHARGE_SIZE_FULL = 0.88;  // at full charge
// Turns per second, idle to full. It accelerating is what makes a held charge
// feel like it is going somewhere; a constant spin reads as an idle prop.
const SPIN_IDLE = 0.9;
const SPIN_FULL = 5.2;
const GLOW_MIN = 0.025;
const GLOW_FULL = 0.16;
// How fast it appears and lets go. Fast in, so it answers the pinch; slower
// out, so a fizzle does not look like a bug.
const FORM_IN = 14;
const FORM_OUT = 7;

// ── Released, downrange ──
const LAUNCH_AHEAD = 1.4;
const SPEED = 46;
const FLY_SPIN = 9;
const FLY_SECONDS = 0.85;
// It grows as it goes. A ring that keeps its size just shrinks with distance
// and reads as dropped rather than thrown.
const FLY_GROWTH = 1.9;

/**
 * @param {THREE.Scene} scene
 * @param {number} colour tint, so the rival's Ringfall is not the player's
 */
export function createHalo(scene, colour = 0xffd98a) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  let model = null;
  const materials = [];
  let holder = null;

  let phase = 'idle';          // idle | charging | flying
  let present = 0;             // 0..1, how much of it is here
  let charge = 0;
  let spin = 0;
  let age = 0;
  let flySize = 1;
  const direction = new THREE.Vector3(0, 0, 1);
  const _look = new THREE.Vector3();
  const _towardViewer = new THREE.Vector3();

  /** Hand it the loaded ringfall-halo.glb scene. */
  function attach(source) {
    model = source;
    // Normalised to a unit diameter here so every size constant above is the
    // ring's width in world units, not a multiple of whatever Meshy exported.
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    model.position.sub(box.getCenter(new THREE.Vector3()));
    holder = new THREE.Group();
    holder.add(model);
    holder.scale.setScalar(1 / Math.max(size.x, size.y, 1e-6));
    model.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      // Cloned so tinting the player's ring does not tint the rival's: the two
      // share one loaded source.
      object.material = object.material.clone();
      // A tint, not a lamp. An early pass drove this to 0.55 and the ring came
      // out as a white polygon -- the porcelain, the gold and the violet gems
      // are the entire reason for using the model rather than a disc, and
      // emissive light is exactly what erases them. The environment does the
      // lighting; this only says whose spell it is, and how charged.
      object.material.emissive = new THREE.Color(colour);
      object.material.transparent = true;
      // The source is a thin XY plane. On release its front points downrange,
      // away from the player's camera, so FrontSide culling would erase the
      // face the player needs to read.
      object.material.side = THREE.DoubleSide;
      object.castShadow = false;
      materials.push(object.material);
    });
    group.add(holder);
  }

  function paint() {
    for (const material of materials) {
      material.opacity = present;
      material.emissiveIntensity = (GLOW_MIN + (GLOW_FULL - GLOW_MIN) * charge) * present;
    }
  }

  return {
    attach,
    get ready() { return model !== null; },

    /**
     * Hold the forming ring at `hand`, at `amount` of charge. Called every
     * frame the player is charging; stop calling it and it withdraws.
     */
    hold(hand, amount, forward, viewer = null) {
      if (!model || !hand) return;
      phase = 'charging';
      charge = Math.min(1, Math.max(0, amount));
      group.position.copy(hand);
      if (forward) {
        direction.copy(forward).normalize();
        // Charging is a readability pose: present the porcelain face to the
        // camera. Release turns it downrange, where DoubleSide keeps its back
        // visible as it flies away.
        if (viewer) {
          _towardViewer.subVectors(viewer, group.position).normalize();
          group.position.addScaledVector(_towardViewer, HAND_TOWARD_VIEWER);
          group.lookAt(viewer);
        } else {
          group.position.addScaledVector(direction, HAND_AHEAD);
          group.lookAt(_look.copy(group.position).add(direction));
        }
      }
      group.visible = true;
    },

    /** Let a held ring go along `dir`. Without a hold first this still works. */
    release(origin, dir, power = 1) {
      if (!model) return;
      direction.copy(dir).normalize();
      group.position.copy(origin).addScaledVector(direction, LAUNCH_AHEAD);
      group.lookAt(_look.copy(group.position).add(direction));
      charge = Math.min(1, Math.max(0, power));
      flySize = CHARGE_SIZE_MIN + (CHARGE_SIZE_FULL - CHARGE_SIZE_MIN) * charge;
      phase = 'flying';
      age = 0;
      present = 1;
      group.visible = true;
    },

    /** Stop charging without firing — a fizzle, or an overload. */
    dismiss() {
      if (phase === 'charging') phase = 'idle';
    },

    dispose() {
      for (const material of materials) material.dispose();
      group.removeFromParent();
    },

    update(dt) {
      if (!model) return;

      if (phase === 'flying') {
        age += dt;
        const t = Math.min(1, age / FLY_SECONDS);
        group.position.addScaledVector(direction, SPEED * dt);
        spin += FLY_SPIN * dt;
        group.scale.setScalar(flySize * (1 + FLY_GROWTH * t));
        // Held solid through the first third so the ring is legible before it
        // starts to leave.
        present = t < 0.33 ? 1 : 1 - (t - 0.33) / 0.67;
        if (t >= 1) { phase = 'idle'; present = 0; }
      } else {
        // Charging holds it here; anything else lets it withdraw. The caller
        // stops calling hold() rather than saying "stop", so idling out is the
        // default and a dropped frame cannot strand the ring on screen.
        const wanted = phase === 'charging' ? 1 : 0;
        present += (wanted - present) * Math.min(1, dt * (wanted ? FORM_IN : FORM_OUT));
        spin += (SPIN_IDLE + (SPIN_FULL - SPIN_IDLE) * charge) * dt;
        group.scale.setScalar(
          (CHARGE_SIZE_MIN + (CHARGE_SIZE_FULL - CHARGE_SIZE_MIN) * charge) * (0.6 + present * 0.4),
        );
        // Charging is re-asserted every frame by hold(); dropping back to idle
        // here is what makes "stop calling it" mean "put it away".
        if (phase === 'charging') phase = 'settling';
        if (present < 0.01) { present = 0; group.visible = false; }
      }

      if (holder) holder.rotation.z = spin;
      paint();
    },
  };
}
