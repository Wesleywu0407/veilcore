import * as THREE from 'three';
import { loadGLB } from './asset-library.js';
import { DUEL } from './config.js';

const GOLD = 0xffd98a;
const VIOLET = 0x9b87ff;

/** Lightweight arena-only defence and control effects. */
export function createSpellSystem(scene) {
  const shields = {
    player: makeShield(scene, 'player'),
    opponent: makeShield(scene, 'opponent'),
  };
  const seal = makeSeal(scene);
  const state = {
    player: { shieldUntil: 0 },
    opponent: { shieldUntil: 0 },
    seal: { source: null, until: 0, strength: 0, radius: 0 },
  };
  const outward = new THREE.Vector3();

  function castAegis(side, position, power, now) {
    const duration = (DUEL.aegisSeconds + power * DUEL.aegisSecondsCharged) * 1000;
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
    }

    if (state.seal.until > now) {
      seal.group.visible = true;
      seal.mount.rotation.z += dt * 0.75;
      for (const material of seal.materials) {
        material.opacity = 0.82 + Math.sin(now * 0.012) * 0.08;
        material.emissiveIntensity = 0.18 + Math.sin(now * 0.01) * 0.08;
      }
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
    async loadAegis(url) {
      const gltf = await loadGLB(url);
      gltf.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = box.getSize(new THREE.Vector3());
      const centre = box.getCenter(new THREE.Vector3());
      const scale = 3.65 / Math.max(size.y, 0.001);

      for (const [side, shield] of Object.entries(shields)) {
        const model = gltf.scene.clone(true);
        model.name = `${side} Meshy Aegis`;
        model.scale.setScalar(scale);
        model.position.set(-centre.x * scale, -centre.y * scale, -centre.z * scale);
        model.traverse(object => {
          if (!object.isMesh) return;
          object.castShadow = false;
          object.receiveShadow = false;
          if (object.material) {
            object.material = object.material.clone();
            object.material.side = THREE.DoubleSide;
            const teamColour = new THREE.Color(side === 'player' ? GOLD : VIOLET);
            if ('color' in object.material) {
              // Preserve the baked porcelain and gold, but make the rival read
              // purple at combat distance instead of looking like your shield.
              object.material.color.lerp(teamColour, side === 'player' ? 0.12 : 0.38);
            }
            if ('emissive' in object.material) {
              object.material.emissive.copy(teamColour);
              object.material.emissiveIntensity = side === 'player' ? 0.18 : 0.32;
            }
          }
        });
        shield.mount.clear();
        shield.mount.add(model);
      }
    },
    async loadGravity(url) {
      const gltf = await loadGLB(url);
      const model = gltf.scene.clone(true);
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const scale = 9.6 / Math.max(size.x, size.y, 0.001);
      model.name = 'Meshy Gravity Seal';
      model.scale.setScalar(scale);
      model.position.set(-centre.x * scale, -centre.y * scale, -centre.z * scale);
      seal.materials.length = 0;
      model.traverse(object => {
        if (!object.isMesh) return;
        object.castShadow = false;
        object.receiveShadow = false;
        object.material = object.material.clone();
        object.material.color.set(VIOLET);
        object.material.emissive.set(0x39245f);
        object.material.emissiveIntensity = 0.2;
        object.material.transparent = true;
        object.material.opacity = 0.88;
        object.material.side = THREE.DoubleSide;
        seal.materials.push(object.material);
      });
      seal.mount.clear();
      seal.mount.add(model);
    },
    /**
     * Only reached when the Meshy seal fails to load. A Gravity Seal you cannot
     * see still slows the rival, so unlike the cathedral this effect must not
     * fail silently -- one flat ring is enough to say where the field is.
     */
    useSealFallback() {
      if (seal.materials.length) return;
      // Flat, not additive: the arena floor is a pale lavender under the
      // cathedral's fill light, and additive violet on top of it disappears.
      const material = new THREE.MeshBasicMaterial({
        color: VIOLET,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        toneMapped: false,
        side: THREE.DoubleSide,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.6, 4.8, 64), material);
      ring.name = 'Gravity Seal fallback';
      seal.materials.push(material);
      seal.mount.clear();
      seal.mount.add(ring);
    },
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

function makeShield(scene, side) {
  const group = new THREE.Group();
  const mount = new THREE.Group();
  // Keep the baked shield in front of its owner rather than intersecting the
  // body. The arena always begins with the player on +Z and the rival on -Z.
  mount.position.z = side === 'player' ? -0.58 : 0.58;
  group.add(mount);
  group.visible = false;
  scene.add(group);
  return { group, mount };
}

function makeSeal(scene) {
  const group = new THREE.Group();
  const mount = new THREE.Group();
  mount.rotation.x = -Math.PI / 2;
  group.add(mount);
  group.visible = false;
  scene.add(group);
  return { group, mount, materials: [] };
}
