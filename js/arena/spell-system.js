import * as THREE from 'three';

const GOLD = 0xffd98a;
const VIOLET = 0x9b87ff;

function energyMaterial(colour, opacity) {
  return new THREE.MeshBasicMaterial({
    color: colour,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

/** Lightweight arena-only defence and control effects. */
export function createSpellSystem(scene) {
  const shields = {
    player: makeShield(scene, GOLD),
    opponent: makeShield(scene, VIOLET),
  };
  const seal = makeSeal(scene);
  const state = {
    player: { shieldUntil: 0 },
    opponent: { shieldUntil: 0 },
    seal: { source: null, until: 0, strength: 0, radius: 0 },
  };
  const outward = new THREE.Vector3();

  function castAegis(side, position, power, now) {
    const duration = 1400 + power * 1700;
    state[side].shieldUntil = now + duration;
    shields[side].group.position.copy(position).setY(1.65);
    shields[side].group.visible = true;
    return duration;
  }

  function absorb(side, now) {
    if (state[side].shieldUntil <= now) return false;
    state[side].shieldUntil = 0;
    shields[side].group.visible = false;
    return true;
  }

  function castGravity(source, target, power, now) {
    const radius = 3.4 + power * 2.4;
    state.seal = {
      source,
      until: now + 1700 + power * 1700,
      strength: 2.5 + power * 3.2,
      radius,
    };
    seal.group.position.copy(target).setY(0.09);
    seal.group.scale.setScalar(radius / 4.8);
    seal.group.visible = true;
  }

  function update(dt, now, positions) {
    const result = { playerSpeed: 1, opponentSpeed: 1 };
    for (const side of ['player', 'opponent']) {
      const active = state[side].shieldUntil > now;
      const visual = shields[side];
      visual.group.visible = active;
      if (!active) continue;
      visual.group.position.copy(positions[side]).setY(1.65);
      const pulse = 1 + Math.sin(now * 0.009) * 0.035;
      visual.group.scale.setScalar(pulse);
      visual.ring.rotation.z += dt * (side === 'player' ? 0.8 : -0.8);
    }

    if (state.seal.until > now) {
      seal.group.visible = true;
      seal.rings.rotation.z += dt * 1.5;
      seal.material.opacity = 0.24 + Math.sin(now * 0.012) * 0.08;
      const victim = state.seal.source === 'player' ? 'opponent' : 'player';
      const victimPosition = positions[victim];
      const dx = victimPosition.x - seal.group.position.x;
      const dz = victimPosition.z - seal.group.position.z;
      if (Math.hypot(dx, dz) <= state.seal.radius) {
        result[`${victim}Speed`] = 0.42;
        outward.copy(victimPosition).setY(0);
        if (outward.lengthSq() < 0.01) outward.set(0, 0, victim === 'player' ? 1 : -1);
        outward.normalize();
        victimPosition.addScaledVector(outward, state.seal.strength * dt);
      }
    } else {
      seal.group.visible = false;
    }
    return result;
  }

  return {
    castAegis,
    castGravity,
    absorb,
    update,
    isShielded: (side, now) => state[side].shieldUntil > now,
    /** Seconds of shield left, so the HUD can tell the player how long to wait. */
    shieldRemaining: (side, now) => Math.max(0, (state[side].shieldUntil - now) / 1000),
    dispose() {
      for (const shield of Object.values(shields)) {
        shield.group.traverse(object => {
          object.geometry?.dispose();
          object.material?.dispose();
        });
        shield.group.removeFromParent();
      }
      seal.group.traverse(object => {
        object.geometry?.dispose();
        object.material?.dispose();
      });
      seal.group.removeFromParent();
    },
  };
}

function makeShield(scene, colour) {
  const group = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(1.75, 24, 14),
    energyMaterial(colour, 0.14),
  );
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.78, 0.035, 6, 48),
    energyMaterial(colour, 0.78),
  );
  ring.rotation.x = Math.PI / 2;
  group.add(shell, ring);
  group.visible = false;
  scene.add(group);
  return { group, ring };
}

function makeSeal(scene) {
  const group = new THREE.Group();
  const material = energyMaterial(VIOLET, 0.28);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(4.8, 48), material);
  disc.rotation.x = -Math.PI / 2;
  group.add(disc);
  const rings = new THREE.Group();
  for (const radius of [1.6, 3.1, 4.55]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.055, radius + 0.055, 64), energyMaterial(VIOLET, 0.82));
    ring.rotation.x = -Math.PI / 2;
    rings.add(ring);
  }
  group.add(rings);
  group.visible = false;
  scene.add(group);
  return { group, rings, material };
}
