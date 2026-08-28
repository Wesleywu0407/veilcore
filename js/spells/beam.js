// ─── Shared spell effect: the beam ────────────────────────────────────────────
//
// Used by both Sky Room and the Arena. It lives here rather than inside either
// of them because a spell that is copied into two hosts stops being one spell:
// the copies drift, the feel diverges, and a tuning pass in one place quietly
// leaves the other behind.
//
// Deliberately self-contained. It builds its own gradient texture instead of
// importing one from sky-room/textures.js — a shared module that reaches into
// one particular host is only half shared, and the next host inherits a
// dependency it has no reason to want. Ten lines of canvas is cheaper than
// that coupling.
//
// The host supplies damage. This module knows how to draw light travelling in
// a straight line and nothing at all about enemies, targets or scoring; those
// differ between hosts and are none of its business.

import * as THREE from 'three';

function radialSprite(inner, outer, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, inner);
  gradient.addColorStop(1, outer);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Three nested cylinders, not one. A single additive cylinder blows out to
// flat white and loses its silhouette; the layers are what let it read as
// light with a shape rather than as a bright rectangle.
const DEFAULT_LAYERS = [
  { radius: 0.16, colour: 0xffffff, opacity: 1.0 },
  { radius: 0.42, colour: 0xffd9a0, opacity: 0.6 },
  { radius: 0.9, colour: 0xff9a3c, opacity: 0.22 },
];

/**
 * @param {object} options
 * @param {THREE.Scene} options.scene
 * @param {(from: THREE.Vector3, to: THREE.Vector3, radius: number, damage: number) => number} [options.onHit]
 *   Called once, at the instant the beam fires, with the lane it covers. The
 *   host applies damage however it likes and returns how many targets it
 *   finished off. Damage lands ONCE rather than ticking as the beam extends:
 *   a target standing visibly inside a column of light must not be able to
 *   walk out of it unharmed.
 */
export function createBeam({ scene, onHit = () => 0, colours = null }) {
  const group = new THREE.Group();

  const palette = colours?.length === DEFAULT_LAYERS.length
    ? DEFAULT_LAYERS.map((layer, i) => ({ ...layer, colour: colours[i] }))
    : DEFAULT_LAYERS;
  const layers = palette.map(({ radius, colour, opacity }) => {
    // Unit length along +Z, origin at the near end, so the group can be aimed
    // with lookAt() and the beam simply scaled to reach.
    const geometry = new THREE.CylinderGeometry(radius, radius * 1.15, 1, 16, 1, true);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, 0.5);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: colour, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    mesh.userData.baseOpacity = opacity;
    group.add(mesh);
    return mesh;
  });

  const flare = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialSprite('rgba(255,255,255,1)', 'rgba(255,170,60,0)'),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  group.add(flare);

  group.visible = false;
  scene.add(group);

  let age = 0, life = 0, width = 1, reach = 1;
  const _end = new THREE.Vector3();

  return {
    /** @returns {number} whatever onHit reported — kills, by convention. */
    fire(origin, dir, { length, radius, damage, seconds = 0.75 }) {
      group.position.copy(origin);
      group.lookAt(_end.copy(origin).addScaledVector(dir, 1));
      age = 0;
      life = seconds;
      width = radius;
      reach = length;
      group.visible = true;

      _end.copy(origin).addScaledVector(dir, length);
      return onHit(origin, _end, radius, damage);
    },

    update(dt) {
      if (life <= 0) return;
      age += dt;
      const t = Math.min(1, age / life);
      // Punch out, hold, collapse. Fading linearly looks like someone turning
      // a dimmer down; a beam should arrive faster than it leaves.
      const extend = Math.min(1, t / 0.12);
      const fade = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      const flicker = 0.92 + Math.sin(age * 60) * 0.08;
      const girth = width * fade * flicker;
      for (const mesh of layers) {
        mesh.scale.set(girth, girth, reach * extend);
        mesh.material.opacity = mesh.userData.baseOpacity * fade;
      }
      flare.scale.setScalar(width * 3.2 * fade * flicker);
      if (t >= 1) { life = 0; group.visible = false; }
    },

    get firing() { return life > 0; },

    dispose() {
      for (const mesh of layers) { mesh.geometry.dispose(); mesh.material.dispose(); }
      flare.material.map?.dispose();
      flare.material.dispose();
      group.removeFromParent();
    },
  };
}
