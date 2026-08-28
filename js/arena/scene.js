// ─── SKYVEIL Duel — suspended dream temple ───────────────────────────────────

import * as THREE from 'three';
import { DUEL } from './config.js';

export const ARENA_RADIUS = DUEL.arenaRadius;

const PLAYER_GOLD = 0xffd98a;
const OPPONENT_VIOLET = 0x9b87ff;
const STONE = 0x202434;

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
  const floorMaterial = new THREE.MeshStandardMaterial({
    color: 0x202638, roughness: 0.9, metalness: 0.08,
  });
  const trimMaterial = new THREE.MeshStandardMaterial({
    color: STONE, roughness: 0.8, metalness: 0.1,
  });

  const foundation = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA_RADIUS, ARENA_RADIUS - 2.2, 2.4, 64),
    floorMaterial,
  );
  foundation.position.y = -1.25;
  foundation.receiveShadow = true;
  scene.add(foundation);

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(ARENA_RADIUS - 0.35, 96),
    floorMaterial,
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.015;
  floor.receiveShadow = true;
  scene.add(floor);

  for (const radius of [6, 13, 21, 26]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius - 0.055, radius + 0.055, 128),
      new THREE.MeshBasicMaterial({ color: 0x52607f, transparent: true, opacity: radius === 6 ? 0.42 : 0.2 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.045;
    scene.add(ring);
  }

  const well = buildWell(scene);
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

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  buildAcademyRing(scene, trimMaterial, colliders, matrix, quaternion, scale);

  const rockGeometry = new THREE.TetrahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(rockGeometry, trimMaterial, 36);
  for (let i = 0; i < 36; i++) {
    const angle = i * 2.39996;
    const radius = 32 + (i % 9) * 4.2;
    const position = new THREE.Vector3(
      Math.sin(angle) * radius,
      -5 - (i % 7) * 1.8,
      Math.cos(angle) * radius,
    );
    quaternion.setFromEuler(new THREE.Euler(angle * 0.3, angle, angle * 0.17));
    const size = 0.8 + (i % 5) * 0.5;
    scale.set(size, size * 2.4, size);
    matrix.compose(position, quaternion, scale);
    rocks.setMatrixAt(i, matrix);
  }
  scene.add(rocks);

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
      const ownerColour = match.well.owner === 'player'
        ? PLAYER_GOLD
        : match.well.owner === 'opponent' ? OPPONENT_VIOLET : 0x7a87a7;
      well.material.color.setHex(ownerColour);
      well.material.opacity = 0.35 + Math.abs(match.well.progress) * 0.45;
      well.rings.rotation.z = t * 0.12;
      well.rings.scale.setScalar(1 + Math.sin(t * 2) * 0.018);
      well.particles.rotation.y = t * 0.09;
      well.beam.material.opacity = 0.025 + Math.abs(match.well.progress) * 0.055;
      well.beam.material.color.setHex(ownerColour);
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

function buildWell(scene) {
  const group = new THREE.Group();
  group.position.y = 0.07;
  const material = new THREE.MeshBasicMaterial({
    color: 0x7a87a7, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(DUEL.wellRadius, 72), material);
  disc.rotation.x = -Math.PI / 2;
  group.add(disc);

  const rings = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const rune = new THREE.Mesh(
      new THREE.RingGeometry(1.5 + i * 1.35, 1.54 + i * 1.35, 64),
      material,
    );
    rune.rotation.x = -Math.PI / 2;
    rune.rotation.z = i * 0.7;
    rings.add(rune);
  }
  group.add(rings);

  const beamMaterial = new THREE.MeshBasicMaterial({
    color: 0x8996bd, transparent: true, opacity: 0.025,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(DUEL.wellRadius * 0.2, DUEL.wellRadius * 0.72, 10, 32, 1, true),
    beamMaterial,
  );
  beam.position.y = 5;
  group.add(beam);

  const particlePositions = new Float32Array(54 * 3);
  for (let i = 0; i < 54; i++) {
    const angle = i * 2.39996;
    const radius = 0.7 + (i % 9) * 0.43;
    particlePositions[i * 3] = Math.sin(angle) * radius;
    particlePositions[i * 3 + 1] = 0.2 + (i % 13) * 0.67;
    particlePositions[i * 3 + 2] = Math.cos(angle) * radius;
  }
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
  const particles = new THREE.Points(
    particleGeometry,
    new THREE.PointsMaterial({ color: 0xa9b8e4, size: 0.095, transparent: true, opacity: 0.72 }),
  );
  group.add(particles);
  scene.add(group);
  return { group, rings, material, beam, particles, radius: DUEL.wellRadius };
}

function buildCore(scene, position, colour) {
  const group = new THREE.Group();
  group.position.copy(position);
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(1.35, 1.7, 0.8, 10),
    new THREE.MeshStandardMaterial({ color: STONE, roughness: 0.75 }),
  );
  pedestal.position.y = 0.4;
  group.add(pedestal);
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
  // pedestal is handed back so a Meshy shrine can take its place at runtime
  // without this file having to know whether one exists.
  return { group, pedestal, crystal, cage, position: group.position };
}

function buildAcademyRing(scene, material, colliders, matrix, quaternion, scale) {
  const arches = 8;
  const radius = 23.7;
  const columnGeometry = new THREE.CylinderGeometry(0.5, 0.66, 6.8, 7);
  const columns = new THREE.InstancedMesh(columnGeometry, material, arches * 2);
  const beamGeometry = new THREE.BoxGeometry(0.62, 4.05, 0.78);
  const beams = new THREE.InstancedMesh(beamGeometry, material, arches * 2);
  const capitalGeometry = new THREE.DodecahedronGeometry(0.68, 0);
  const capitals = new THREE.InstancedMesh(capitalGeometry, material, arches * 2);
  const position = new THREE.Vector3();
  const euler = new THREE.Euler();
  let index = 0;

  for (let i = 0; i < arches; i++) {
    const angle = (i / arches) * Math.PI * 2;
    for (const side of [-1, 1]) {
      const offset = side * 2.75;
      const x = Math.sin(angle) * radius + Math.cos(angle) * offset;
      const z = Math.cos(angle) * radius - Math.sin(angle) * offset;
      quaternion.setFromEuler(euler.set(0, angle, 0));
      scale.set(1, 1, 1);
      matrix.compose(position.set(x, 3.4, z), quaternion, scale);
      columns.setMatrixAt(index, matrix);
      matrix.compose(position.set(x, 6.9, z), quaternion, scale);
      capitals.setMatrixAt(index, matrix);

      const midOffset = side * 1.38;
      const bx = Math.sin(angle) * radius + Math.cos(angle) * midOffset;
      const bz = Math.cos(angle) * radius - Math.sin(angle) * midOffset;
      quaternion.setFromEuler(euler.set(0, angle, side * 0.735, 'YXZ'));
      matrix.compose(position.set(bx, 8.45, bz), quaternion, scale);
      beams.setMatrixAt(index, matrix);
      colliders.push({ x, z, radius: 0.9 });
      index++;
    }
  }
  for (const object of [columns, beams, capitals]) {
    object.castShadow = true;
    object.receiveShadow = true;
    scene.add(object);
  }

  const bannerMaterial = new THREE.MeshStandardMaterial({
    color: 0x171323, roughness: 0.95, side: THREE.DoubleSide,
    transparent: true, opacity: 0.88,
  });
  const banners = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.5, 5.4), bannerMaterial, arches);
  for (let i = 0; i < arches; i++) {
    const angle = ((i + 0.5) / arches) * Math.PI * 2;
    quaternion.setFromEuler(euler.set(0, angle, 0));
    scale.set(i % 3 === 0 ? 0.72 : 1, 0.78 + (i % 2) * 0.15, 1);
    matrix.compose(position.set(Math.sin(angle) * 25.2, 5.4, Math.cos(angle) * 25.2), quaternion, scale);
    banners.setMatrixAt(i, matrix);
  }
  scene.add(banners);

  const inlayMaterial = new THREE.MeshBasicMaterial({ color: 0x546386, transparent: true, opacity: 0.19 });
  const inlays = new THREE.InstancedMesh(new THREE.BoxGeometry(0.045, 0.025, 7.2), inlayMaterial, 24);
  for (let i = 0; i < 24; i++) {
    const angle = (i / 24) * Math.PI * 2;
    quaternion.setFromEuler(euler.set(0, angle, 0));
    scale.set(1, 1, 1);
    matrix.compose(position.set(Math.sin(angle) * 10, 0.055, Math.cos(angle) * 10), quaternion, scale);
    inlays.setMatrixAt(i, matrix);
  }
  scene.add(inlays);

  const oculus = new THREE.Group();
  oculus.position.set(0, 12, -48);
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(6.8, 7.05, 64),
    new THREE.MeshBasicMaterial({ color: 0x7868b4, transparent: true, opacity: 0.34, side: THREE.DoubleSide }),
  );
  const voidDisc = new THREE.Mesh(
    new THREE.CircleGeometry(6.75, 64),
    new THREE.MeshBasicMaterial({ color: 0x090711, transparent: true, opacity: 0.92 }),
  );
  voidDisc.position.z = 0.02;
  oculus.add(halo, voidDisc);
  scene.add(oculus);
}
