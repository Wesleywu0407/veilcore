// ─── SKYVEIL Duel — suspended dream temple ───────────────────────────────────

import * as THREE from 'three';
import { DUEL } from './config.js';

export const ARENA_RADIUS = DUEL.arenaRadius;

const PLAYER_GOLD = 0xffd98a;
const OPPONENT_VIOLET = 0x9b87ff;
const ARENA_SHELL_RADIUS = 29;

/**
 * A tiny scene, prefiltered into an environment map.
 *
 * The duelist ships metallic and roughness maps, but a PBR material can only
 * show them by reflecting something, and this arena had nothing to reflect: no
 * environment meant black leather rendered as flat black paint no matter how
 * good the texture was. This is not a lighting rig -- the real lights still do
 * the lighting. It is the thing the wet leather, the pauldrons and the porcelain
 * helm have to look at.
 *
 * Built rather than loaded so it costs no download, and coloured off the duel's
 * own two sides: gold low on one flank, violet low on the other, cold sky above.
 */
export function buildEnvironment(renderer) {
  const room = new THREE.Scene();
  const panel = (colour, intensity, position, scale) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide }),
    );
    mesh.material.color.multiplyScalar(intensity);
    mesh.position.set(...position);
    mesh.scale.set(...scale);
    mesh.lookAt(0, position[1] * 0.2, 0);
    room.add(mesh);
  };

  // The shell. Not black: a floor and walls that return nothing make every
  // curved surface read as a silhouette with two hot spots and no body.
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(24, 14, 24),
    new THREE.MeshBasicMaterial({ color: 0x0b0f1a, side: THREE.BackSide }),
  );
  room.add(shell);

  panel(0xc9d8ff, 1.5, [0, 6.6, 0], [16, 16, 1]);      // cold sky, the spot rigs
  panel(0xffd98a, 2.2, [-8, 1.4, 2], [7, 5, 1]);        // player gold
  panel(0x9b87ff, 2.0, [8, 1.4, -2], [7, 5, 1]);        // rival violet
  panel(0x2a3350, 0.9, [0, -4.5, 0], [18, 18, 1]);      // dim bounce off the floor

  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(room, 0.06).texture;
  pmrem.dispose();
  room.traverse(object => {
    object.geometry?.dispose?.();
    object.material?.dispose?.();
  });
  return texture;
}

export function buildArena(scene) {
  scene.background = new THREE.Color(0x05060c);
  scene.fog = new THREE.FogExp2(0x05060c, 0.018);

  const colliders = [];
  const shellRoot = new THREE.Group();
  shellRoot.name = 'Meshy arena shell';
  scene.add(shellRoot);

  // Well capture remains a gameplay rule at the origin. Its old disc, rings,
  // beam and particles were part of the procedural arena and are deliberately
  // gone; the Meshy floor now carries the visible centre marker.
  const well = { radius: DUEL.wellRadius };
  const cores = {
    player: buildCore(scene, new THREE.Vector3(8, 0, 18), PLAYER_GOLD),
    opponent: buildCore(scene, new THREE.Vector3(-8, 0, -18), OPPONENT_VIOLET),
  };
  const spills = [];
  const spillGeometry = new THREE.OctahedronGeometry(0.22, 0);
  const spillMaterials = {
    player: new THREE.MeshBasicMaterial({ color: PLAYER_GOLD }),
    opponent: new THREE.MeshBasicMaterial({ color: OPPONENT_VIOLET }),
  };
  let lastTime = 0;

  buildAcademyColliders(colliders);

  scene.add(new THREE.HemisphereLight(0x9dadd6, 0x101221, 1.9));
  const moon = new THREE.DirectionalLight(0xd7ddff, 2.6);
  moon.position.set(-14, 28, 16);
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024, 1024);
  moon.shadow.camera.left = -32;
  moon.shadow.camera.right = 32;
  moon.shadow.camera.top = 32;
  moon.shadow.camera.bottom = -32;
  scene.add(moon);

  const playerGlow = new THREE.PointLight(PLAYER_GOLD, 5, 12, 2);
  playerGlow.position.set(8, 2.3, 18);
  scene.add(playerGlow);
  const opponentGlow = new THREE.PointLight(OPPONENT_VIOLET, 5, 12, 2);
  opponentGlow.position.set(-8, 2.3, -18);
  scene.add(opponentGlow);

  return {
    colliders,
    radius: ARENA_RADIUS,
    well,
    cores,
    attachShell(model) {
      shellRoot.clear();
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const horizontalRadius = Math.max(size.x, size.z) * 0.5;
      const scale = ARENA_SHELL_RADIUS / Math.max(horizontalRadius, 0.001);

      // The bottom of a Meshy environment is the underside of its foundation,
      // not the surface characters stand on. The remesher leaves a centre
      // vertex in the broad arena floor, so find the vertex nearest the model's
      // horizontal centre and use its height as the real ground plane.
      const sample = new THREE.Vector3();
      let floorRadiusSq = Infinity;
      let floorY = box.min.y;
      model.traverse(object => {
        const positions = object.geometry?.attributes?.position;
        if (!positions) return;
        for (let i = 0; i < positions.count; i++) {
          sample.fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld);
          const dx = sample.x - centre.x;
          const dz = sample.z - centre.z;
          const radiusSq = dx * dx + dz * dz;
          if (radiusSq >= floorRadiusSq) continue;
          floorRadiusSq = radiusSq;
          floorY = sample.y;
        }
      });

      // Meshy exports centred at its own origin. Put the stone floor exactly on
      // gameplay y=0 and centre the single environment asset on the duel.
      model.scale.setScalar(scale);
      model.position.set(-centre.x * scale, -floorY * scale, -centre.z * scale);
      model.traverse(object => {
        if (!object.isMesh) return;
        // The arena is one 15k-face draw call. Receiving the existing moon
        // shadow is cheap; making the whole cathedral cast into a shadow map is
        // not, and its baked dark texture already supplies the deep occlusion.
        object.castShadow = false;
        object.receiveShadow = true;
      });
      shellRoot.add(model);
    },
    spillCore(side, amount) {
      if (amount <= 0) return;
      const origin = cores[side].position;
      const count = 4;
      for (let i = 0; i < count; i++) {
        const angle = i * Math.PI * 0.5 + (side === 'player' ? 0.35 : -0.35);
        const mesh = new THREE.Mesh(spillGeometry, spillMaterials[side]);
        mesh.position.set(origin.x + Math.sin(angle) * 2.1, 0.65, origin.z + Math.cos(angle) * 2.1);
        scene.add(mesh);
        spills.push({ mesh, value: amount / count, born: lastTime, phase: i * 1.7 });
      }
    },
    collectMana(position) {
      let total = 0;
      for (let i = spills.length - 1; i >= 0; i--) {
        const pickup = spills[i];
        const dx = pickup.mesh.position.x - position.x;
        const dz = pickup.mesh.position.z - position.z;
        if (Math.hypot(dx, dz) > 1.45) continue;
        total += pickup.value;
        pickup.mesh.removeFromParent();
        spills.splice(i, 1);
      }
      return total;
    },
    clearSpills() {
      for (const pickup of spills) pickup.mesh.removeFromParent();
      spills.length = 0;
    },
    update(t, match) {
      lastTime = t;
      cores.player.crystal.rotation.y = t * 0.55;
      cores.opponent.crystal.rotation.y = -t * 0.55;
      cores.player.cage.rotation.y = t * 0.24;
      cores.opponent.cage.rotation.y = -t * 0.24;
      for (const side of ['player', 'opponent']) {
        const disabled = match.cores[side].disabledFor > 0;
        cores[side].crystal.material.emissiveIntensity = disabled ? 0.08 : 2.2;
        cores[side].crystal.material.opacity = disabled ? 0.28 : 0.92;
      }
      for (let i = spills.length - 1; i >= 0; i--) {
        const pickup = spills[i];
        pickup.mesh.position.y = 0.72 + Math.sin(t * 3 + pickup.phase) * 0.2;
        pickup.mesh.rotation.y += 0.035;
        if (t - pickup.born <= 12) continue;
        pickup.mesh.removeFromParent();
        spills.splice(i, 1);
      }
    },
  };
}

function buildCore(scene, position, colour) {
  const group = new THREE.Group();
  group.position.copy(position);
  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.82, 0),
    new THREE.MeshStandardMaterial({
      color: colour, emissive: colour, emissiveIntensity: 2.2,
      transparent: true, opacity: 0.92, roughness: 0.18,
    }),
  );
  crystal.position.y = 1.8;
  group.add(crystal);
  const cage = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const orbit = new THREE.Mesh(
      new THREE.TorusGeometry(1.12, 0.025, 5, 36),
      new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.55 }),
    );
    orbit.rotation.set(i * 0.9, i * 0.7, i * 1.1);
    orbit.position.y = 1.8;
    cage.add(orbit);
  }
  group.add(cage);
  scene.add(group);
  return { group, crystal, cage, position: group.position };
}

function buildAcademyColliders(colliders) {
  const arches = 8;
  const radius = 23.7;
  for (let i = 0; i < arches; i++) {
    const angle = (i / arches) * Math.PI * 2;
    for (const side of [-1, 1]) {
      const offset = side * 2.75;
      const x = Math.sin(angle) * radius + Math.cos(angle) * offset;
      const z = Math.cos(angle) * radius - Math.sin(angle) * offset;
      colliders.push({ x, z, radius: 0.9 });
    }
  }
}
