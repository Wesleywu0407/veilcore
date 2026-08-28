// ─── Arena — training targets ─────────────────────────────────────────────────
//
// Stage one of the opponent plan: things that take damage, show a number, fall
// over, and come back. No movement and no retaliation yet — those are stages
// two and three, and they slot in behind the same interface.
//
// The interface is deliberately the smallest thing a fighter can be: a
// position, a radius, and a hit() that reports what happened. When the AI
// opponent arrives it implements the same three and everything that shoots at
// targets today will shoot at it without changing.

import * as THREE from 'three';

const MAX_HP = 30;
const RESPAWN_SECONDS = 3;

const LAYOUT = [
  { x: -8, z: -22 }, { x: 0, z: -28 }, { x: 8, z: -22 },
  { x: -18, z: -12 }, { x: 18, z: -12 },
];

export function createTargets(scene) {
  const list = LAYOUT.map(({ x, z }) => {
    const group = new THREE.Group();
    group.position.set(x, 0, z);

    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.62, 1.5, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x7f8aa6, roughness: 0.85 }),
    );
    body.position.y = 1.45;
    body.castShadow = true;
    group.add(body);

    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.18, 0.7, 8),
      new THREE.MeshStandardMaterial({ color: 0x3a4055, roughness: 0.9 }),
    );
    post.position.y = 0.35;
    group.add(post);

    scene.add(group);
    return {
      group, body,
      pos: group.position,
      radius: 0.9,
      hp: MAX_HP,
      down: false,
      downFor: 0,
      flash: 0,
    };
  });

  /** Damage numbers, in world space, drawn by the host onto its 2D overlay. */
  const numbers = [];

  return {
    list,

    /**
     * @returns {number} how many targets this hit finished off — the same
     *   contract Sky Room's wisps.breach() reports, so a spell written for one
     *   host behaves identically in the other.
     */
    hitLane(from, to, radius, damage) {
      const seg = new THREE.Vector3().subVectors(to, from);
      const lengthSq = Math.max(1e-6, seg.lengthSq());
      const rel = new THREE.Vector3();
      const closest = new THREE.Vector3();
      let kills = 0;

      for (const t of list) {
        if (t.down) continue;
        rel.subVectors(t.pos, from);
        const k = THREE.MathUtils.clamp(rel.dot(seg) / lengthSq, 0, 1);
        closest.copy(from).addScaledVector(seg, k);
        // Compare against the body's middle, not the feet: a beam at chest
        // height would otherwise miss everything it visibly passes through.
        closest.y -= 1.45;
        if (t.pos.distanceTo(closest) > radius + t.radius) continue;

        t.hp -= damage;
        t.flash = 1;
        numbers.push({
          value: Math.round(damage),
          at: t.pos.clone().setY(2.8),
          age: 0,
          fatal: t.hp <= 0,
        });
        if (t.hp <= 0) { t.down = true; t.downFor = 0; kills++; }
      }
      return kills;
    },

    update(dt) {
      for (const t of list) {
        t.flash = Math.max(0, t.flash - dt * 3.2);
        t.body.material.color.setHex(t.flash > 0.05 ? 0xffd9a0 : 0x7f8aa6);

        if (t.down) {
          t.downFor += dt;
          // Topple, wait, spring back. A target that blinks out and reappears
          // gives no feedback that the hit was lethal.
          t.group.rotation.x = Math.min(Math.PI / 2, t.group.rotation.x + dt * 5);
          if (t.downFor >= RESPAWN_SECONDS) {
            t.down = false;
            t.hp = MAX_HP;
            t.group.rotation.x = 0;
          }
        }
      }
      for (let i = numbers.length - 1; i >= 0; i--) {
        numbers[i].age += dt;
        if (numbers[i].age > 1.1) numbers.splice(i, 1);
      }
    },

    /** Floating damage numbers for the host to project and draw. */
    get damageNumbers() { return numbers; },
  };
}
