// ─── SKYVEIL Duel — standalone entry point ───────────────────────────────────
//
// This page never boots the story world. It owns one arena, two duelists, one
// match state, and the shared webcam/rune pipeline.

import * as THREE from 'three';
import { buildArena, buildEnvironment } from './arena/scene.js';
import { DUEL } from './arena/config.js';
import { createDuelist } from './arena/duelist.js';
import { createOpponentController } from './arena/opponent.js';
import { createSpellSystem } from './arena/spell-system.js';
import { createPerformanceGovernor } from './arena/performance.js';
import { createMatch, updateMatch, damage, spendMana, disruptCore } from './arena/match.js';
import { createHalo } from './spells/halo.js';
import { initTracker, getFrame, isReady, disposeTracker } from './spell-room/tracker.js';
import { isPinching, updateCast, currentStroke, resetMagic, RUNES, pinchDebug, TUNE } from './spell-room/magic.js';
import { createBowState } from './spell-room/archery.js';
import { createBowAim } from './spell-room/aim.js';
import { createInputMode } from './spell-room/input-mode.js';
import { createBowView, DUEL_BOW_MOUNT } from './arena/bow-view.js';
import { raySphereDistance, rayVerticalCapsuleDistance } from './arena/shot.js';
import { checkRoomServer, createRoomClient, mirrorArenaPosition, normaliseRoomCode } from './arena/room-client.js';

const GOLD = '#ffd98a';
const VIOLET = '#9b87ff';
const NO_CAMERA = new URLSearchParams(location.search).has('nocam');
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const overlayCanvas = document.querySelector('[data-arena-overlay]');
const glCanvas = document.querySelector('[data-arena-gl]');
const video = document.querySelector('[data-arena-video]');
const coverVideo = document.querySelector('[data-arena-cover]');
const startPanel = document.querySelector('[data-arena-start]');
const startButton = document.querySelector('[data-arena-enter]');
const hostButton = document.querySelector('[data-arena-host]');
const joinForm = document.querySelector('[data-arena-join]');
const joinButton = joinForm?.querySelector('button');
const roomCodeInput = document.querySelector('[data-arena-room-code]');
const roomStatusLine = document.querySelector('[data-arena-room-status]');
const errorLine = document.querySelector('[data-arena-error]');
const statusLine = document.querySelector('[data-arena-status]');
const ctx = overlayCanvas.getContext('2d');

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.18;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const performanceGovernor = createPerformanceGovernor(renderer, glCanvas, quality => {
  setStatus(`quality adjusted: ${quality}`);
});

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 180);
scene.environment = buildEnvironment(renderer);
const arena = buildArena(scene);
const spells = createSpellSystem(scene);

spells.loadAegis('assets/models/arena/aegis-barrier.glb')
  .then(() => setStatus('Meshy Aegis loaded'))
  .catch(error => setStatus(`Aegis: ${error.message}`));

const playerPosition = new THREE.Vector3(0, 0, 14);
const opponentPosition = new THREE.Vector3(0, 0, -12);
const playerAvatar = createDuelist(scene, { colour: 0xffd98a, name: 'Lantern Duelist' });
const opponentAvatar = createDuelist(scene, { colour: 0x9b87ff, name: 'Veil Rival' });
const bowView = createBowView(playerAvatar.bowAnchor, DUEL_BOW_MOUNT);
bowView.setVisible(false);
playerAvatar.setPosition(playerPosition);
opponentAvatar.setPosition(opponentPosition);
let bot = createOpponentController(opponentPosition);

let match = createMatch();
const cooldowns = { ringfall: 0, aegis: 0, 'gravity-seal': 0, bow: 0 };
let selectedRuneId = 'ringfall';
let targetMode = 'rival';
let botCastCount = 0;
let onlineDuel = false;
let peerConnected = false;
let roomRole = null;
let remoteCharging = false;
let networkSentAt = 0;
let roomStatusRevision = 0;
const remoteTargetPosition = opponentPosition.clone();

// Meshy's rigger emits one clip per file, so the duelist's actions sit beside
// the character rather than inside it. The character GLB carries only the
// 0.3s bind-pose stub; without these four, `find(/idle/i)` in duelist.js
// misses and both idle and run collapse onto that stub.
const DUELIST_CLIPS = [
  'assets/models/arena/anim-idle.glb',
  'assets/models/arena/anim-run.glb',
  'assets/models/arena/anim-cast.glb',
  'assets/models/arena/anim-hit.glb',
];

// Both Cores are the same shrine, so it is fetched once and cloned. Plain
// Object3D.clone is right here where SkeletonUtils was needed for the duelist:
// this is static geometry with no skin to rewire.
const SHRINE_HEIGHT = 4.2;   // taller than the 3.5-unit duelist, so it reads as monument
const SHRINE_YAW = Math.PI;  // the niche faces -Z in the source mesh, so turn it around
const CRYSTAL_Y = 2.45;      // the niche mouth
const CRYSTAL_OUT = 1.2;     // clear of the stone, so the orbit rings do not clip it

async function loadArenaShell() {
  const url = 'assets/models/arena/arena-shell.glb';
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(url);
    arena.attachShell(gltf.scene);
    setStatus('Meshy cathedral loaded');
  } catch (error) {
    // There is intentionally no procedural arena fallback. A missing shell is
    // a visible asset error, not permission to quietly rebuild the old stage.
    setStatus(`arena asset missing: ${error.message}`);
  }
}

async function loadArenaProps() {
  const url = 'assets/models/arena/core-shrine.glb';
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) return;
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(url);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = SHRINE_HEIGHT / Math.max(size.y, 0.001);

    for (const side of ['player', 'opponent']) {
      const core = arena.cores[side];
      const shrine = gltf.scene.clone(true);
      shrine.scale.setScalar(scale);
      shrine.position.y = -box.min.y * scale;
      // Turn each shrine to look at the middle of the arena, where the duel is.
      shrine.rotation.y = Math.atan2(-core.position.x, -core.position.z) + SHRINE_YAW;
      shrine.traverse(object => {
        if (!object.isMesh) return;
        object.castShadow = true;
        object.receiveShadow = true;
      });
      core.group.add(shrine);

      // Float the Core clear of the stone rather than inside the niche: which
      // way the niche faces cannot be read off the mesh, and out here the
      // crystal and its rings read correctly even if the shrine has its back
      // turned.
      const toCentre = new THREE.Vector3(-core.position.x, 0, -core.position.z).normalize();
      core.crystal.position.set(toCentre.x * CRYSTAL_OUT, CRYSTAL_Y, toCentre.z * CRYSTAL_OUT);
      core.cage.position.copy(core.crystal.position);
      for (const ring of core.cage.children) ring.position.set(0, 0, 0);

      // Stone you can walk through is worse than no stone at all.
      arena.colliders.push({ x: core.position.x, z: core.position.z, radius: 1.0 });
    }
    setStatus('core shrines loaded');
  } catch (error) {
    setStatus(`shrine fallback: ${error.message}`);
  }
}

async function loadMeshyDuelists() {
  const url = 'assets/models/arena/sealed-porcelain-duelist.glb';
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) return;
    const [{ GLTFLoader }, { clone }] = await Promise.all([
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/utils/SkeletonUtils.js'),
    ]);
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(url);
    // These files are armature and curves only — no mesh, no textures — so they
    // cost kilobytes against the model's megabytes and are worth fetching in
    // parallel. One missing clip should cost that action alone, not the model,
    // hence allSettled rather than all.
    const settled = await Promise.allSettled(DUELIST_CLIPS.map(clip => loader.loadAsync(clip)));
    const clips = gltf.animations.concat(
      settled.flatMap(result => (result.status === 'fulfilled' ? result.value.animations : [])),
    );
    // Clips are immutable data in three.js; each avatar's mixer builds its own
    // bindings, so the two duelists can share one array.
    playerAvatar.replaceVisual(clone(gltf.scene), clips);
    opponentAvatar.replaceVisual(clone(gltf.scene), clips);
    setStatus(`Meshy duelist loaded — ${clips.length} clips`);
  } catch (error) {
    setStatus(`Meshy model fallback: ${error.message}`);
  }
}

async function loadBow() {
  const url = 'assets/models/arena/bow.glb';
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) return;
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(url);
    bowView.attachLimbs(gltf.scene);
  } catch (error) {
    setStatus(`bow model fallback: ${error.message}`);
  }
}
let lastCast = null;
let lastCastAt = -Infinity;
let flashUntil = -Infinity;
let flashKind = 'none';
let tracking = false;
let running = false;
let worldTime = 0;
let playerCharging = false;
let perfTime = 0;
let perfFrames = 0;
const bowState = createBowState();
const bowAim = createBowAim();
const inputMode = createInputMode();
let bowRead = null;
let bowMode = false;
let bowStringSide = 'right';

const FLASH_COLOUR = { cast: GOLD, fizzle: '#ff8b6b', overload: '#ff3d2e', blocked: '#6f7f9a', hit: '#b36cff' };

const roomClient = createRoomClient({
  onStatus: setRoomStatus,
  onPeer(connected, details) {
    peerConnected = connected;
    roomRole = details.role;
    if (connected) {
      setRoomStatus(`ROOM ${details.room} · FRIEND CONNECTED`);
      if (!running) void beginDuel();
    } else if (running && onlineDuel) {
      setStatus('friend disconnected · duel paused');
    }
  },
  onState: applyRemoteState,
  onEvent: applyRemoteEvent,
  onReset: () => resetRound({ broadcast: false }),
});

// ─── Combat ──────────────────────────────────────────────────────────────────

const _segment = new THREE.Vector3();
const _relative = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _targetCentre = new THREE.Vector3();

function sendRoomEvent(event) {
  if (onlineDuel) roomClient.sendEvent(event);
}

function disruptAndSpill(side, { broadcast = true } = {}) {
  const amount = disruptCore(match, side);
  if (amount <= 0) return false;
  arena.spillCore(side, amount);
  if (broadcast && side === 'opponent') sendRoomEvent({ kind: 'core' });
  setStatus(`${side === 'player' ? 'your' : 'rival'} Core disrupted · mana spilled`);
  return true;
}

function laneHits(from, to, targetPosition, radius) {
  _segment.subVectors(to, from);
  const lengthSq = Math.max(1e-6, _segment.lengthSq());
  _targetCentre.copy(targetPosition).setY(1.65);
  _relative.subVectors(_targetCentre, from);
  const k = THREE.MathUtils.clamp(_relative.dot(_segment) / lengthSq, 0, 1);
  _closest.copy(from).addScaledVector(_segment, k);
  return _closest.distanceTo(_targetCentre) <= radius + 0.75;
}

function hitPlayerRingfall(from, to, radius, amount) {
  let hit = false;
  if (laneHits(from, to, opponentPosition, radius)) {
    if (spells.absorb('opponent', performance.now())) {
      setStatus('rival Aegis absorbed Ringfall');
      sendRoomEvent({ kind: 'shield-broken' });
    } else {
      damage(match, 'opponent', amount);
      opponentAvatar.flash();
      sendRoomEvent({ kind: 'damage', amount, source: 'ringfall' });
    }
    hit = true;
  }
  if (laneHits(from, to, arena.cores.opponent.position, radius)) {
    disruptAndSpill('opponent');
    hit = true;
  }
  return hit && match.opponent.hp <= 0 ? 1 : 0;
}

function hitOpponentRingfall(from, to, radius, amount) {
  const hitsPlayer = laneHits(from, to, playerPosition, radius);
  if (laneHits(from, to, arena.cores.player.position, radius)) disruptAndSpill('player');
  if (!hitsPlayer) return 0;
  if (spells.absorb('player', performance.now())) {
    flashUntil = performance.now() + 320;
    flashKind = 'blocked';
    setStatus('Aegis absorbed the spell');
    return 0;
  }
  damage(match, 'player', amount);
  playerAvatar.flash();
  flashUntil = performance.now() + 320;
  flashKind = 'hit';
  return match.player.hp <= 0 ? 1 : 0;
}

// Ringfall's ring. One loaded model, two tinted instances -- the rival casts
// the same spell and it must not read as the player's.
const playerHalo = createHalo(scene, 0xffd98a);
const opponentHalo = createHalo(scene, 0x9b87ff);

(async () => {
  const url = 'assets/models/arena/ringfall-halo.glb';
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) return;
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new GLTFLoader().loadAsync(url);
    playerHalo.attach(gltf.scene.clone(true));
    opponentHalo.attach(gltf.scene.clone(true));
  } catch (error) {
    setStatus(`halo: ${error.message}`);
  }
})();

const _castOrigin = new THREE.Vector3();
const _castTarget = new THREE.Vector3();
const _castDirection = new THREE.Vector3();
const _ringfallEnd = new THREE.Vector3();
const _ringfallVisualOrigin = new THREE.Vector3();

function castRingfall(charge, now, { free = false } = {}) {
  if (match.phase !== 'playing' || cooldowns.ringfall > 0) {
    flashUntil = now + 180;
    flashKind = 'blocked';
    return false;
  }
  if (!free && !spendMana(match, 'player', DUEL.ringfallCost)) {
    flashUntil = now + 240;
    flashKind = 'blocked';
    setStatus('not enough mana');
    return false;
  }

  const power = clamp(charge, 0.25, 1);
  _castOrigin.copy(playerPosition).setY(1.65);
  _castTarget.copy(targetMode === 'core' ? arena.cores.opponent.position : opponentPosition).setY(1.55);
  _castDirection.subVectors(_castTarget, _castOrigin).normalize();
  const length = 42;
  const radius = lerp(1.1, 2.5, power);
  const amount = lerp(DUEL.ringfallDamageMin, DUEL.ringfallDamageMax, power);
  _ringfallEnd.copy(_castOrigin).addScaledVector(_castDirection, length);
  hitPlayerRingfall(_castOrigin, _ringfallEnd, radius, amount);
  const visualOrigin = playerAvatar.handWorld(_ringfallVisualOrigin) ?? _castOrigin;
  playerHalo.release(visualOrigin, _castDirection, power);
  sendRoomEvent({ kind: 'cast', spell: 'ringfall', power, target: targetMode });
  cooldowns.ringfall = DUEL.ringfallCooldown;
  lastCast = { name: 'Ringfall', charge: power };
  lastCastAt = now;
  flashUntil = now + 220 + power * 220;
  flashKind = 'cast';
  return true;
}

function castAegis(charge, now) {
  if (match.phase !== 'playing' || cooldowns.aegis > 0) {
    flashUntil = now + 180;
    flashKind = 'blocked';
    return false;
  }
  if (!spendMana(match, 'player', DUEL.aegisCost)) {
    setStatus('not enough mana');
    return false;
  }
  const power = clamp(charge, 0.25, 1);
  spells.castAegis('player', playerPosition, power, now);
  sendRoomEvent({ kind: 'cast', spell: 'aegis', power });
  cooldowns.aegis = DUEL.aegisCooldown;
  lastCast = { name: 'Aegis', charge: power };
  lastCastAt = now;
  flashUntil = now + 260;
  flashKind = 'cast';
  return true;
}

function castGravitySeal(charge, now) {
  if (match.phase !== 'playing' || cooldowns['gravity-seal'] > 0) {
    flashUntil = now + 180;
    flashKind = 'blocked';
    return false;
  }
  if (!spendMana(match, 'player', DUEL.gravityCost)) {
    setStatus('not enough mana');
    return false;
  }
  const power = clamp(charge, 0.25, 1);
  spells.castGravity('player', opponentPosition, power, now);
  sendRoomEvent({ kind: 'cast', spell: 'gravity-seal', power });
  cooldowns['gravity-seal'] = DUEL.gravityCooldown;
  lastCast = { name: 'Gravity Seal', charge: power };
  lastCastAt = now;
  flashUntil = now + 280;
  flashKind = 'cast';
  return true;
}

function castPlayerSpell(runeId, charge, now) {
  selectedRuneId = runeId;
  const cast = runeId === 'aegis' ? castAegis(charge, now)
    : runeId === 'gravity-seal' ? castGravitySeal(charge, now)
    : castRingfall(charge, now);
  // Only a cast that actually went out gets the animation. A rejected one --
  // cooling down, or short on mana -- already reads as the 'blocked' flash.
  if (cast) playerAvatar.cast();
  return cast;
}

function botCast(target) {
  if (match.phase !== 'playing') return;
  // The windup is gated on affording this, but a Core disruption can spill the
  // rival's mana mid-windup. Losing the shot is the right outcome there.
  if (!spendMana(match, 'opponent', DUEL.botCastCost)) return;
  opponentAvatar.cast();
  const origin = _castOrigin.copy(opponentPosition).setY(1.65);
  const destination = _castTarget.copy(target).setY(1.55);
  const direction = _castDirection.subVectors(destination, origin).normalize();
  opponentHalo.release(origin, direction, 0.7);
  _ringfallEnd.copy(origin).addScaledVector(direction, Math.max(10, origin.distanceTo(destination) + 2));
  hitOpponentRingfall(origin, _ringfallEnd, 1.25, DUEL.botDamage);
}

// ─── Bow shot ────────────────────────────────────────────────────────────────
// The ray decides the hit at release; the mesh is feedback travelling along the
// same sightline. Keeping those jobs separate prevents a low render frame from
// changing whether a shot landed.
const arrowGeometry = new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6);
arrowGeometry.rotateX(Math.PI / 2);
const arrowMaterial = new THREE.MeshStandardMaterial({
  color: 0xf3ead7, emissive: 0xffd98a, emissiveIntensity: 0.5, roughness: 0.4,
});
const arrows = [];
const _bowNdc = new THREE.Vector3();
const _bowRayOrigin = new THREE.Vector3();
const _bowRayDirection = new THREE.Vector3();
const _bowVisualOrigin = new THREE.Vector3();
const _bowVisualDirection = new THREE.Vector3();
const _bowFar = new THREE.Vector3();
const _coreWorld = new THREE.Vector3();

function spawnArrow(origin, direction) {
  const mesh = new THREE.Mesh(arrowGeometry, arrowMaterial);
  mesh.position.copy(origin);
  mesh.lookAt(_bowFar.copy(origin).add(direction));
  scene.add(mesh);
  arrows.push({ mesh, direction: direction.clone(), life: 2.5 });
}

function updateArrows(dt) {
  for (let i = arrows.length - 1; i >= 0; i--) {
    const arrow = arrows[i];
    arrow.mesh.position.addScaledVector(arrow.direction, DUEL.arrowSpeed * dt);
    arrow.life -= dt;
    if (arrow.life > 0) continue;
    arrow.mesh.removeFromParent();
    arrows.splice(i, 1);
  }
}

function applyRemoteState(state) {
  if (!onlineDuel || !state) return;
  const [x, z] = mirrorArenaPosition(state.position);
  if (Number.isFinite(x) && Number.isFinite(z)) remoteTargetPosition.set(x, 0, z);
  if (Number.isFinite(state.hp)) match.opponent.hp = clamp(state.hp, 0, DUEL.maxHp);
  if (Number.isFinite(state.mana)) match.opponent.mana = clamp(state.mana, 0, DUEL.maxMana);
  if (Number.isFinite(state.coreDisabledFor)) {
    match.cores.opponent.disabledFor = Math.max(0, state.coreDisabledFor);
  }
  if (roomRole === 'guest' && Number.isFinite(state.timeLeft)) {
    match.timeLeft = Math.max(0, state.timeLeft);
  }
  remoteCharging = Boolean(state.charging);
}

function applyRemoteEvent(event) {
  if (!onlineDuel || !event) return;
  const now = performance.now();
  if (event.kind === 'damage') {
    damage(match, 'player', Number(event.amount) || 0);
    playerAvatar.flash();
    flashUntil = now + 320;
    flashKind = 'hit';
    setStatus(`${event.source === 'bow' ? 'arrow' : 'spell'} hit you`);
    return;
  }
  if (event.kind === 'core') {
    disruptAndSpill('player', { broadcast: false });
    return;
  }
  if (event.kind === 'shield-broken') {
    spells.absorb('player', now);
    setStatus('your Aegis absorbed the attack');
    return;
  }
  if (event.kind !== 'cast') return;

  const power = clamp(Number(event.power) || 0.3, 0.25, 1);
  opponentAvatar.cast();
  if (event.spell === 'aegis') {
    spells.castAegis('opponent', opponentPosition, power, now);
    return;
  }
  if (event.spell === 'gravity-seal') {
    spells.castGravity('opponent', playerPosition, power, now);
    return;
  }

  const origin = _castOrigin.copy(opponentPosition).setY(1.65);
  const destination = _castTarget
    .copy(event.target === 'core' ? arena.cores.player.position : playerPosition)
    .setY(1.55);
  const direction = _castDirection.subVectors(destination, origin).normalize();
  if (event.spell === 'bow') {
    spawnArrow(origin, direction);
  } else {
    opponentHalo.release(origin, direction, power);
  }
}

function updateRemoteOpponent(dt) {
  const distance = opponentPosition.distanceTo(remoteTargetPosition);
  opponentPosition.lerp(remoteTargetPosition, Math.min(1, dt * 14));
  resolveArenaCollision(opponentPosition);
  opponentAvatar.setPosition(opponentPosition);
  _opponentFacing.subVectors(playerPosition, opponentPosition).setY(0).normalize();
  opponentAvatar.face(_opponentFacing);
  opponentAvatar.update(dt, Math.min(DUEL.playerSpeed, distance / Math.max(dt, 0.001)), remoteCharging ? 0.35 : 0);
  return { telegraph: remoteCharging ? 0.35 : 0 };
}

function sendNetworkState(now) {
  if (!onlineDuel || !peerConnected || now - networkSentAt < 50) return;
  networkSentAt = now;
  roomClient.sendState({
    position: [playerPosition.x, playerPosition.z],
    hp: match.player.hp,
    mana: match.player.mana,
    coreDisabledFor: match.cores.player.disabledFor,
    timeLeft: roomRole === 'host' ? match.timeLeft : undefined,
    charging: playerCharging,
  });
}

function fireBow(power, now, reticle) {
  if (match.phase !== 'playing' || cooldowns.bow > 0) {
    flashUntil = now + 180;
    flashKind = 'blocked';
    setStatus('bow cooling down');
    return false;
  }
  if (!spendMana(match, 'player', DUEL.bowCost)) {
    flashUntil = now + 240;
    flashKind = 'blocked';
    setStatus('not enough mana');
    return false;
  }

  const draw = clamp(power, 0, 1);
  camera.updateMatrixWorld(true);
  _bowNdc.set(reticle.x * 2 - 1, -(reticle.y * 2 - 1), 0.5).unproject(camera);
  _bowRayOrigin.copy(camera.position);
  _bowRayDirection.copy(_bowNdc).sub(_bowRayOrigin).normalize();

  const bodyDistance = rayVerticalCapsuleDistance(
    _bowRayOrigin, _bowRayDirection,
    opponentPosition.x, opponentPosition.z,
    opponentAvatar.radius, opponentAvatar.height - opponentAvatar.radius,
    opponentAvatar.radius,
  );
  arena.cores.opponent.crystal.getWorldPosition(_coreWorld);
  const coreDistance = raySphereDistance(_bowRayOrigin, _bowRayDirection, _coreWorld, 1.05);
  const hitCore = coreDistance !== null && (bodyDistance === null || coreDistance < bodyDistance);
  const hitBody = bodyDistance !== null && !hitCore;

  playerAvatar.bowAnchor.getWorldPosition(_bowVisualOrigin);
  _bowFar.copy(_bowRayOrigin).addScaledVector(_bowRayDirection, 48);
  _bowVisualDirection.subVectors(_bowFar, _bowVisualOrigin).normalize();
  spawnArrow(_bowVisualOrigin, _bowVisualDirection);
  sendRoomEvent({ kind: 'cast', spell: 'bow', power: draw });

  if (hitCore) {
    disruptAndSpill('opponent');
    setStatus('arrow struck the rival Core');
  } else if (hitBody) {
    if (spells.absorb('opponent', now)) {
      setStatus('rival Aegis caught the arrow');
      sendRoomEvent({ kind: 'shield-broken' });
    } else {
      const amount = lerp(DUEL.bowDamageMin, DUEL.bowDamageMax, draw);
      damage(match, 'opponent', amount);
      opponentAvatar.flash();
      sendRoomEvent({ kind: 'damage', amount, source: 'bow' });
      setStatus('arrow hit');
    }
  } else {
    setStatus('arrow missed');
  }

  cooldowns.bow = DUEL.bowCooldown;
  lastCast = { name: 'Arrow', charge: draw };
  lastCastAt = now;
  if (hitBody || hitCore) {
    flashUntil = now + 180;
    flashKind = 'cast';
  }
  return true;
}

// ─── Third-person controller ─────────────────────────────────────────────────

const keys = new Set();
let orbitYaw = Math.PI;
let orbitPitch = -0.12;
let manualOrbitUntil = 0;
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _look = new THREE.Vector3();
const _cameraPosition = new THREE.Vector3();
const _opponentFacing = new THREE.Vector3();

addEventListener('keydown', event => {
  keys.add(event.code);
  if (event.repeat) return;
  if (event.code === 'KeyH') void toggleTracking();
  if (event.code === 'Digit1') selectedRuneId = 'ringfall';
  if (event.code === 'Digit2') selectedRuneId = 'aegis';
  if (event.code === 'Digit3') selectedRuneId = 'gravity-seal';
  if (event.code === 'Tab') {
    event.preventDefault();
    targetMode = targetMode === 'rival' ? 'core' : 'rival';
    setStatus(`target: ${targetMode}`);
  }
  if (event.code === 'KeyJ') castPlayerSpell(selectedRuneId, 0.3, performance.now());
  if (event.code === 'KeyK') castPlayerSpell(selectedRuneId, 1, performance.now());
  if (event.code === 'KeyR' && match.phase === 'finished') resetRound();
  if (event.code === 'KeyN') {
    if (simCharge === null) { simCharge = TUNE.CHARGE_MIN; setStatus('charging — N to loose'); }
    else releaseSimulatedCharge(performance.now());
  }
  // Camera-free QA for the body pose. Live tracking owns the same pose whenever
  // it is on, so these keys only have an effect under ?nocam or after H turns the
  // webcam off.
  if (event.code === 'KeyB') {
    debugBow = !debugBow;
    setStatus(debugBow ? `bow up · draw ${debugDraw.toFixed(1)} · ${debugSide}` : 'bow down');
  }
  if (debugBow && (event.code === 'Comma' || event.code === 'Period')) {
    debugDraw = clamp(debugDraw + (event.code === 'Period' ? DRAW_STEP : -DRAW_STEP), 0, 1);
    setStatus(`draw ${debugDraw.toFixed(1)} · ${debugSide}`);
  }
  if (event.code === 'KeyM' && debugBow) {
    debugSide = debugSide === 'right' ? 'left' : 'right';
    setStatus(`draw ${debugDraw.toFixed(1)} · ${debugSide}`);
  }
});
addEventListener('keyup', event => keys.delete(event.code));

glCanvas.addEventListener('click', () => glCanvas.requestPointerLock());
addEventListener('mousemove', event => {
  if (document.pointerLockElement !== glCanvas) return;
  orbitYaw -= event.movementX * 0.0024;
  orbitPitch = clamp(orbitPitch - event.movementY * 0.0018, -0.38, 0.32);
  manualOrbitUntil = performance.now() + 1400;
});

function shortAngle(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

// ─── Draw pose, camera-free QA ────────────────────────────────────────────────
//
//   B        bow up / bow down
//   , .      step the draw down and up
//   M        mirror it — the stance follows whichever hand closed on the string,
//            so the left-handed version has to be looked at too
//
// Stepped rather than held, because a pose is judged by parking it at a value
// and looking, not by watching it flash past. The real driver is continuous.
const DRAW_STEP = 0.1;
let debugBow = false;
let debugDraw = 0;
let debugSide = 'right';

function updateDebugBow() {
  if (tracking) return;
  bowMode = debugBow;
  bowStringSide = debugSide;
  bowRead = debugBow
    ? { phase: 'nocked', draw: debugDraw, peak: debugDraw, spans: 0, stringSide: debugSide }
    : null;
  playerAvatar.drawBow(debugBow ? debugDraw : null, debugSide);
  bowView.setNocked(debugBow);
  bowView.setDraw(debugBow ? debugDraw : 0);
  bowView.setVisible(debugBow && playerAvatar.drawing);
}

function movePlayer(dt, now) {
  if (match.phase !== 'playing') return 0;
  // Auto-aim is suspended while a rune is being drawn. The rival strafes across
  // sixteen units, so tracking it swings the body and the camera through about
  // 34 degrees, back and forth, for as long as you stand still -- which from the
  // close casting shot reads as the duelist's head lolling side to side. It is
  // also the wrong thing to do to someone mid-stroke: the canvas should not turn
  // under the hand that is drawing on it.
  if (now > manualOrbitUntil && !playerAvatar.reaching) {
    const lockYaw = Math.atan2(opponentPosition.x - playerPosition.x, opponentPosition.z - playerPosition.z);
    orbitYaw += shortAngle(orbitYaw, lockYaw) * Math.min(1, dt * 2.2);
  }

  _forward.set(Math.sin(orbitYaw), 0, Math.cos(orbitYaw));
  // Screen-right is forward x up. The negated form points screen-LEFT, which
  // swapped A and D.
  _right.set(-_forward.z, 0, _forward.x);
  _move.set(0, 0, 0);
  if (keys.has('KeyW')) _move.add(_forward);
  if (keys.has('KeyS')) _move.sub(_forward);
  if (keys.has('KeyA')) _move.sub(_right);
  if (keys.has('KeyD')) _move.add(_right);
  if (_move.lengthSq() === 0) {
    // Hold whatever facing the stroke started on; re-aiming here is the other
    // half of the same sway.
    if (!playerAvatar.reaching) {
      _look.subVectors(opponentPosition, playerPosition).setY(0).normalize();
      playerAvatar.face(_look);
    }
    return 0;
  }

  _move.normalize();
  playerPosition.addScaledVector(_move, DUEL.playerSpeed * dt);
  resolveArenaCollision(playerPosition);
  playerAvatar.face(_move);
  return DUEL.playerSpeed;
}

function resolveArenaCollision(position) {
  for (const collider of arena.colliders) {
    const dx = position.x - collider.x;
    const dz = position.z - collider.z;
    const distance = Math.hypot(dx, dz);
    const minimum = collider.radius + 0.65;
    if (distance >= minimum || distance < 1e-5) continue;
    position.x = collider.x + (dx / distance) * minimum;
    position.z = collider.z + (dz / distance) * minimum;
  }
  const distance = Math.hypot(position.x, position.z);
  const maximum = arena.radius - 1.4;
  if (distance > maximum) {
    position.x *= maximum / distance;
    position.z *= maximum / distance;
  }
}

// 0 is the ordinary chase camera, 1 is the casting view: close over the
// duelist's drawing shoulder.
//
// True first person was tried and does not work on this rig. The eye sits at
// head height, 0.45 from the shoulder, while the whole arm spans only 1.07 --
// so the upper arm starts essentially at the lens. Measured, the forearm covered
// more than a full screen width and the elbow fell behind the near plane on half
// the drawing area. Widening the lens does not help; the elbow is still behind
// the camera. Minecraft gets away with it by drawing a separate hand model in
// its own pass, which one skinned mesh cannot do.
//
// These numbers come from a sweep of camera placements scored on three things:
// the elbow must stay in front of the lens, the hand must stay on screen across
// the whole drawing area, and the forearm must stay under half a screen wide.
let castFraming = 0;
let bowFraming = 0;
const CAST_BACK = 1.00;    // behind the shoulder
const CAST_UP = 3.46;      // above the duelist's feet
const CAST_SIDE = 0.5;     // toward the drawing shoulder
const CAST_LOOK_Y = 2.61;
const CAST_LOOK_FWD = 0.72;
const DUEL_FOV = 58;
const CAST_FOV = 62;
const BOW_BACK = 5.0;
const BOW_UP = 3.15;
const BOW_SIDE = 1.1;
const BOW_LOOK_Y = 2.05;
const BOW_LOOK_FWD = 6.5;
const BOW_FOV = 58;
const _flat = new THREE.Vector3();
const _chasePos = new THREE.Vector3();
const _chaseLook = new THREE.Vector3();
const _castPos = new THREE.Vector3();
const _castLook = new THREE.Vector3();
const _bowPos = new THREE.Vector3();
const _bowLook = new THREE.Vector3();
// Where the casting view WILL be, available even while the render camera is
// still swinging into it. The hand target is unprojected through this rather
// than through the live camera: at the start of a cast the live camera is still
// out at chase distance, and unprojecting through it threw the target metres
// behind the duelist for the first few frames, so the arm flailed backwards.
const castCamera = new THREE.PerspectiveCamera(CAST_FOV, 1, 0.1, 180);

function updateCamera(dt) {
  const wantCast = playerAvatar.reaching && !bowMode ? 1 : 0;
  const wantBow = bowMode ? 1 : 0;
  castFraming += (wantCast - castFraming) * Math.min(1, dt * 9);
  bowFraming += (wantBow - bowFraming) * Math.min(1, dt * 7);

  // A slightly wider lens while casting, to keep the whole drawing arc in frame
  // from this much closer camera.
  const fov = lerp(lerp(DUEL_FOV, CAST_FOV, castFraming), BOW_FOV, bowFraming);
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  _forward.set(Math.sin(orbitYaw), Math.sin(orbitPitch), Math.cos(orbitYaw)).normalize();
  // Horizontal only. The casting view must not inherit the chase camera's pitch,
  // or looking up while duelling would tilt the shoulder shot with it.
  _flat.set(Math.sin(orbitYaw), 0, Math.cos(orbitYaw));

  _chasePos.copy(playerPosition).addScaledVector(_forward, -7.8);
  _chasePos.y += 4.1;
  _chaseLook.copy(playerPosition).setY(1.45).addScaledVector(_forward, 3.2);

  _right.set(-_flat.z, 0, _flat.x);
  _castPos.copy(playerPosition)
    .addScaledVector(_flat, -CAST_BACK)
    .addScaledVector(_right, CAST_SIDE);
  _castPos.y += CAST_UP;
  _castLook.copy(playerPosition).addScaledVector(_flat, CAST_LOOK_FWD);
  _castLook.y += CAST_LOOK_Y;

  // A close third-person view, never first person: the rig's elbow and forearm
  // need to stay in front of the lens. Mirror with the actual string hand so a
  // left-handed stance gets the same composition. Look from the bow side;
  // from the string shoulder the forearm sits directly
  // between the lens and the face, which hid both the grip and the arrow.
  const shoulderSide = bowStringSide === 'right' ? -1 : 1;
  _bowPos.copy(playerPosition)
    .addScaledVector(_flat, -BOW_BACK)
    .addScaledVector(_right, BOW_SIDE * shoulderSide);
  _bowPos.y += BOW_UP;
  _bowLook.copy(playerPosition).addScaledVector(_flat, BOW_LOOK_FWD);
  _bowLook.y += BOW_LOOK_Y;

  castCamera.aspect = camera.aspect;
  castCamera.position.copy(_castPos);
  castCamera.lookAt(_castLook);
  castCamera.updateProjectionMatrix();
  castCamera.updateMatrixWorld(true);

  _cameraPosition.lerpVectors(_chasePos, _castPos, castFraming).lerp(_bowPos, bowFraming);
  _look.lerpVectors(_chaseLook, _castLook, castFraming).lerp(_bowLook, bowFraming);
  // Snappier the further into the casting view we are; the duelling chase camera
  // wants the lazy follow, the swap onto the shoulder does not.
  camera.position.lerp(_cameraPosition, lerp(0.18, 0.55, Math.max(castFraming, bowFraming)));
  camera.lookAt(_look);
}

// ─── Webcam ──────────────────────────────────────────────────────────────────

function setSelfieVisible(visible) {
  video?.classList.toggle('selfie-live', Boolean(visible));
}

function reportTrackerStage(stage) {
  setStatus(stage);
  // The stream is already attached by the time this stage arrives. Showing it
  // while the model downloads gives the player immediate proof that permission
  // worked, instead of leaving a blank corner for another thirty seconds.
  if (stage !== 'asking for the camera') setSelfieVisible(true);
}

async function toggleTracking() {
  if (tracking) {
    tracking = false;
    resetMagic();
    inputMode.reset();
    bowState.reset();
    bowAim.reset();
    bowRead = null;
    bowMode = false;
    playerAvatar.drawBow(null);
    bowView.setVisible(false);
    disposeTracker();
    setSelfieVisible(false);
    setStatus('webcam off');
    return;
  }
  try {
    await initTracker(video, reportTrackerStage);
    tracking = true;
    setStatus('hand casting ready');
  } catch (error) {
    setSelfieVisible(false);
    setStatus(`camera: ${error.message}`);
  }
}

async function beginDuel() {
  if (running) return;
  coverVideo?.pause();
  startPanel.hidden = true;
  running = true;
  last = performance.now();
  resize();
  requestAnimationFrame(loop);
  if (NO_CAMERA) {
    setSelfieVisible(false);
    setStatus('keyboard casting ready · webcam skipped for QA');
    return;
  }
  try {
    await initTracker(video, reportTrackerStage);
    tracking = true;
  } catch (error) {
    setSelfieVisible(false);
    if (errorLine) {
      errorLine.hidden = false;
      errorLine.textContent = error.message;
    }
    setStatus('keyboard casting ready · H retries camera');
  }
}

startButton?.addEventListener('click', () => {
  roomClient.close();
  onlineDuel = false;
  peerConnected = false;
  roomRole = null;
  void beginDuel();
});

hostButton?.addEventListener('click', async () => {
  setRoomControlsBusy(true);
  setRoomStatus('OPENING A ROOM…');
  try {
    onlineDuel = true;
    const joined = await roomClient.connect({ mode: 'create' });
    setRoomStatus(`ROOM ${joined.room} · SHARE THIS CODE · WAITING FOR FRIEND`);
  } catch (error) {
    onlineDuel = false;
    setRoomStatus(roomConnectionMessage(error.message));
  } finally {
    setRoomControlsBusy(false);
  }
});

joinForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const code = normaliseRoomCode(roomCodeInput?.value);
  if (roomCodeInput) roomCodeInput.value = code;
  setRoomControlsBusy(true);
  try {
    onlineDuel = true;
    setRoomStatus(`JOINING ROOM ${code}…`);
    await roomClient.connect({ mode: 'join', room: code });
  } catch (error) {
    onlineDuel = false;
    setRoomStatus(roomConnectionMessage(error.message));
  } finally {
    setRoomControlsBusy(false);
  }
});

roomCodeInput?.addEventListener('input', () => {
  roomCodeInput.value = normaliseRoomCode(roomCodeInput.value);
});

function updateHand(now) {
  if (!tracking) {
    playerCharging = false;
    updateDebugBow();
    return;
  }
  const frame = getFrame();
  const mode = inputMode.update(frame.hands);

  if (mode.mode === 'bow') {
    if (mode.changed) {
      resetMagic();
      playerAvatar.reach(null);
      bowAim.reset();
    }
    bowMode = true;
    bowRead = bowState.update(frame.hands, now);
    playerCharging = bowRead.phase === 'nocked' && bowRead.draw > 0.2;
    bowStringSide = bowRead.stringSide ?? bowStringSide;
    playerAvatar.drawBow(bowRead.draw, bowStringSide);
    bowView.setVisible(playerAvatar.drawing);
    bowView.setNocked(bowRead.phase === 'nocked');
    bowView.setDraw(bowRead.phase === 'nocked' ? bowRead.draw : 0);

    if (bowRead.phase === 'nocked' && bowRead.bowWrist) {
      bowAim.update(bowRead.bowWrist, bowRead.draw, now);
    }
    if (bowRead.event?.type === 'loosed') {
      fireBow(bowRead.event.power, now, bowAim.reticle);
      bowAim.reset();
    } else if (bowRead.phase !== 'nocked') {
      bowAim.reset();
    }
    drawBowLayer(frame, bowRead);
    return;
  }

  if (mode.changed || bowMode) {
    bowState.reset();
    bowAim.reset();
    bowRead = null;
    bowMode = false;
    playerAvatar.drawBow(null);
    bowView.setVisible(false);
    resetMagic();
  }
  const gate = isPinching(frame.tracked ? frame.landmarks : null, frame.handScale, now);
  const cast = updateCast(gate && frame.tracked, frame.tip, now);
  const ringfallCharging = cast.phase === 'charging' && cast.rune?.id === 'ringfall';
  playerAvatar.reach(gate && frame.tracked ? handTarget(frame.tip) : null, cast.charge, !ringfallCharging);
  playerCharging = cast.phase === 'charging';
  // The ring forms at the hand while the charge is held, and only then goes.
  // Ringfall only: Aegis and Gravity Seal are not this shape and borrowing the
  // halo for them would make the charge stop telling you which rune you drew.
  updateHaloCharge(ringfallCharging, cast.charge);
  if (cast.event?.type === 'fired') castPlayerSpell(cast.event.rune.id, cast.event.charge, now);
  else if (cast.event?.type === 'overloaded') {
    flashUntil = now + 520;
    flashKind = 'overload';
  } else if (cast.event?.type === 'fizzled') {
    flashUntil = now + 240;
    flashKind = 'fizzle';
  }
  drawHandLayer(frame, gate, cast);
}

// Hold Ringfall's ring at the casting hand while the charge builds. The hand
// comes from the rig rather than from the body's position: IK is what moved it,
// so anything else drifts away from the arm the player can see.
const _handWorld = new THREE.Vector3();
const _haloForward = new THREE.Vector3();

// Simulated charge for keyboard QA. Without a camera there is no hold phase at
// all -- J and K fire instantly -- so the one part of Ringfall worth looking at
// is the one part `?nocam` could not reach. N starts the hold, N again looses
// it, exactly as pinch-and-release does.
let simCharge = null;

function updateSimulatedCharge(dt, now) {
  if (simCharge === null) return;
  simCharge = clamp(simCharge + dt / (TUNE.CHARGE_FULL_MS / 1000), TUNE.CHARGE_MIN, 1);
  // Park the camera-free QA hand clear of the head, so N actually exposes the
  // held model it exists to inspect. Live tracking still uses the real tip.
  playerAvatar.reach(handTarget({ x: 0.68, y: 0.42 }), simCharge, false);
  updateHaloCharge(true, simCharge);
  void now;
}

function releaseSimulatedCharge(now) {
  if (simCharge === null) return;
  const power = simCharge;
  simCharge = null;
  playerAvatar.reach(null);
  castPlayerSpell('ringfall', power, now);
}

function updateHaloCharge(charging, charge) {
  if (!charging) return;
  const hand = playerAvatar.handWorld(_handWorld);
  if (!hand) return;
  _haloForward
    .subVectors(targetMode === 'core' ? arena.cores.opponent.position : opponentPosition, hand)
    .setY(0)
    .normalize();
  playerHalo.hold(hand, charge, _haloForward, camera.position);
}

// ─── Loop ─────────────────────────────────────────────────────────────────────

let last = performance.now();

// ─── Failing loudly ──────────────────────────────────────────────────────────
//
// An exception thrown inside a requestAnimationFrame callback stops the chain
// dead: the last frame stays on the glass and the game looks frozen with
// nothing at all to say for itself. That is indistinguishable from a hung GPU,
// and it is not something anyone can diagnose while standing two metres from
// the laptop with both hands in the air -- which is the only way this game is
// played. A one-character name collision cost an evening on exactly this.
//
// So the frame is wrapped and the failure is put where the player can read it.
let fatalError = null;

function reportFatal(error, where) {
  if (fatalError) return;
  fatalError = error;
  running = false;
  console.error(`[veilcore] ${where}`, error);
  const text = `${where} — ${error?.message ?? error}`;
  setStatus(text);
  if (errorLine) {
    errorLine.hidden = false;
    errorLine.textContent = `${text}. Reload to restart; the console has the stack.`;
  }
}

// Anything thrown outside the loop -- the tracker's own callback, a late asset
// load -- would otherwise reach only the console.
addEventListener('error', event => reportFatal(event.error ?? event.message, 'uncaught'));
addEventListener('unhandledrejection', event => reportFatal(event.reason, 'unhandled rejection'));

function loop(now) {
  if (!running) return;
  try {
    step(now);
  } catch (error) {
    reportFatal(error, 'frame');
    return;
  }
  requestAnimationFrame(loop);
}

function step(now) {
  const dt = Math.min((now - last) / 1000, 0.08);
  last = now;
  worldTime += dt;
  ctx.clearRect(0, 0, innerWidth, innerHeight);

  const playerSpeed = movePlayer(dt, now);
  playerAvatar.setPosition(playerPosition);
  updateHand(now);
  updateSimulatedCharge(dt, now);
  playerAvatar.update(dt, playerSpeed);

  const spellState = spells.update(dt, now, { player: playerPosition, opponent: opponentPosition });
  let botState;
  if (onlineDuel) {
    botState = updateRemoteOpponent(dt);
  } else {
    botState = bot.update(dt, playerPosition, {
      wellOwner: match.well.owner,
      hp: match.opponent.hp,
      mana: match.opponent.mana,
      playerCharging,
    }, spellState.opponentSpeed);
    resolveArenaCollision(opponentPosition);
    opponentAvatar.setPosition(opponentPosition);
    opponentAvatar.face(botState.facing);
    opponentAvatar.update(dt, botState.speed, botState.telegraph);
    if (botState.shield && spendMana(match, 'opponent', DUEL.aegisCost)) {
      spells.castAegis('opponent', opponentPosition, 0.65, now);
    }
    if (botState.cast) {
      botCastCount += 1;
      botCast(botCastCount % 4 === 0 ? arena.cores.player.position : botState.cast.target);
    }
  }

  const playerInWell = Math.hypot(playerPosition.x, playerPosition.z) <= DUEL.wellRadius;
  const opponentInWell = Math.hypot(opponentPosition.x, opponentPosition.z) <= DUEL.wellRadius;
  if (!onlineDuel || peerConnected) {
    updateMatch(match, dt, { player: playerInWell, opponent: opponentInWell });
  }
  match.player.mana = clamp(match.player.mana + arena.collectMana(playerPosition), 0, DUEL.maxMana);
  if (!onlineDuel) {
    match.opponent.mana = clamp(match.opponent.mana + arena.collectMana(opponentPosition), 0, DUEL.maxMana);
  }
  arena.update(worldTime, match);

  for (const id of Object.keys(cooldowns)) cooldowns[id] = Math.max(0, cooldowns[id] - dt);
  playerHalo.update(dt);
  opponentHalo.update(dt);
  updateArrows(dt);
  updateCamera(dt);
  sendNetworkState(now);

  renderer.render(scene, camera);
  performanceGovernor.update(dt);
  perfTime += dt;
  perfFrames += 1;
  if (perfTime >= 0.5) {
    glCanvas.dataset.fps = Math.round(perfFrames / perfTime).toString();
    glCanvas.dataset.calls = renderer.info.render.calls.toString();
    glCanvas.dataset.triangles = renderer.info.render.triangles.toString();
    perfTime = 0;
    perfFrames = 0;
  }
  drawHud(now, botState);
  drawSelfie(getFrame());
}

function resetRound({ broadcast = true } = {}) {
  match = createMatch();
  playerPosition.set(0, 0, 14);
  opponentPosition.set(0, 0, -12);
  remoteTargetPosition.copy(opponentPosition);
  bot = createOpponentController(opponentPosition);
  botCastCount = 0;
  arena.clearSpills();
  for (const id of Object.keys(cooldowns)) cooldowns[id] = 0;
  resetMagic();
  if (broadcast && onlineDuel) roomClient.sendReset();
  setStatus('new duel');
}

// ─── Overlay ──────────────────────────────────────────────────────────────────

const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [17, 0],
];

function drawSelfie(frame) {
  if (!tracking || !video?.classList.contains('selfie-live')) return;
  const rect = video.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;

  const hands = frame.hands ?? [];
  const mode = hands.length === 2 ? 'BOW' : hands.length === 1 ? 'RUNES' : 'SHOW HANDS';
  const x = point => rect.left + point.x * rect.width;
  const y = point => rect.top + point.y * rect.height;

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.left, rect.top, rect.width, rect.height);
  ctx.clip();

  for (const hand of hands) {
    const landmarks = hand.landmarks;
    if (!landmarks?.length) continue;
    const colour = hand.side === 'right' ? GOLD : hand.side === 'left' ? '#8cc9ff' : '#d9e2f2';

    ctx.beginPath();
    for (const [from, to] of HAND_CONNECTIONS) {
      ctx.moveTo(x(landmarks[from]), y(landmarks[from]));
      ctx.lineTo(x(landmarks[to]), y(landmarks[to]));
    }
    ctx.strokeStyle = colour;
    ctx.globalAlpha = frame.stale ? 0.34 : 0.82;
    ctx.lineWidth = 1.35;
    ctx.stroke();

    ctx.fillStyle = colour;
    for (const point of landmarks) {
      ctx.beginPath();
      ctx.arc(x(point), y(point), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    if (hand.side) {
      ctx.globalAlpha = 1;
      ctx.font = "700 9px 'IBM Plex Mono', monospace";
      ctx.textAlign = 'center';
      ctx.fillText(hand.side[0].toUpperCase(), x(hand.wrist), y(hand.wrist) + 14);
    }
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(5,6,12,.72)';
  ctx.fillRect(rect.left, rect.top, rect.width, 24);
  ctx.font = "500 8px 'IBM Plex Mono', monospace";
  ctx.textAlign = 'left';
  ctx.fillStyle = hands.length ? GOLD : '#8d9ab4';
  ctx.fillText(`MIRROR · ${hands.length} HAND${hands.length === 1 ? '' : 'S'} · ${mode}`, rect.left + 8, rect.top + 15);
  ctx.restore();
}

// Where the duelist's hand has to be in the world for it to appear exactly under
// the stroke the player is watching. Unprojecting the fingertip is the only way
// the two line up: the earlier version mapped the stroke onto a small square in
// front of the chest, and the hand ended up somewhere with no visible relation
// to the line being drawn. HAND_DEPTH is a little under the arm's own span, so
// the elbow keeps a bend instead of locking straight.
const HAND_DEPTH = 1.47;
const _handTarget = new THREE.Vector3();

function handTarget(tip) {
  _handTarget.set(tip.x * 2 - 1, -(tip.y * 2 - 1), 0.5).unproject(castCamera);
  return _handTarget.sub(castCamera.position).normalize()
    .multiplyScalar(HAND_DEPTH).add(castCamera.position);
}

function drawBowLayer(frame, bow) {
  const width = innerWidth;
  const height = innerHeight;

  // The two tracked wrists stay visible as a quiet diagnostic. If the draw
  // jumps, this immediately distinguishes a tracking dropout from bow maths.
  if (frame.hands?.length === 2) {
    const [a, b] = frame.hands;
    ctx.beginPath();
    ctx.moveTo(a.wrist.x * width, a.wrist.y * height);
    ctx.lineTo(b.wrist.x * width, b.wrist.y * height);
    ctx.strokeStyle = 'rgba(255,230,184,.28)';
    ctx.lineWidth = 1.25;
    ctx.stroke();
    for (const hand of frame.hands) {
      ctx.beginPath();
      ctx.arc(hand.wrist.x * width, hand.wrist.y * height, 5, 0, Math.PI * 2);
      ctx.fillStyle = hand.side === bow.stringSide ? GOLD : '#8ab4ff';
      ctx.fill();
    }
  }

  if (bow.phase !== 'nocked') return;
  const reticle = bowAim.reticle;
  const x = reticle.x * width;
  const y = reticle.y * height;
  const radius = 13 + bow.draw * 15;
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, radius + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * bow.draw);
  ctx.strokeStyle = 'rgba(255,217,138,.45)';
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 23, y); ctx.lineTo(x - 8, y);
  ctx.moveTo(x + 8, y); ctx.lineTo(x + 23, y);
  ctx.moveTo(x, y - 23); ctx.lineTo(x, y - 8);
  ctx.moveTo(x, y + 8); ctx.lineTo(x, y + 23);
  ctx.strokeStyle = GOLD;
  ctx.stroke();
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = "500 10px 'IBM Plex Mono', monospace";
  ctx.fillStyle = GOLD;
  ctx.fillText(`${Math.round(bow.draw * 100)}%`, x, y + radius + 19);
  ctx.restore();
}

function drawHandLayer(frame, gate, cast) {
  if (!frame.tracked) return;
  const points = currentStroke();
  if (points.length > 1) {
    const swell = 1 + (cast.phase === 'charging' ? cast.charge : 0) * 1.4;
    // Detection runs at ~30Hz, so a circle arrives as roughly forty points. Join
    // them with lineTo and the player is looking at a forty-sided polygon, where
    // every sample's jitter reads as a corner. Threading a quadratic through the
    // midpoints costs nothing and removes the faceting. This is presentation
    // only -- currentStroke() still hands recognize() the raw points, so nothing
    // here can move a recognition score.
    const px = i => points[i].x * innerWidth;
    const py = i => points[i].y * innerHeight;
    for (const pass of [{ width: 18, alpha: 0.12 }, { width: 8, alpha: 0.32 }, { width: 2.4, alpha: 1 }]) {
      ctx.beginPath();
      ctx.moveTo(px(0), py(0));
      for (let i = 1; i < points.length - 1; i++) {
        ctx.quadraticCurveTo(px(i), py(i), (px(i) + px(i + 1)) / 2, (py(i) + py(i + 1)) / 2);
      }
      ctx.lineTo(px(points.length - 1), py(points.length - 1));
      ctx.lineWidth = pass.width * swell;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = pass.alpha;
      ctx.strokeStyle = cast.overloading ? '#ff6a4d' : gate ? '#ffe6b8' : '#8a7f6a';
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  const x = frame.tip.x * innerWidth;
  const y = frame.tip.y * innerHeight;

  // Live verdict while the stroke is still being drawn. Recognition only ever
  // spoke at the end, so a stroke going wrong looked exactly like a stroke that
  // was never seen -- and the player had no way to tell which, let alone to
  // correct it mid-draw. The bar is the score against SCORE_FLOOR, so "nearly
  // there" is visible as nearly there.
  if (cast.preview) {
    const ready = cast.preview.ready;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = "500 12px 'IBM Plex Mono', monospace";
    ctx.letterSpacing = '0.14em';
    ctx.fillStyle = ready ? GOLD : '#6f7d96';
    ctx.fillText(`${cast.preview.rune.name.toUpperCase()}  ${Math.round(cast.preview.score * 100)}%`, x, y - 44);
    const width = 96;
    ctx.fillStyle = 'rgba(7,9,16,.6)';
    ctx.fillRect(x - width / 2, y - 36, width, 3);
    ctx.fillStyle = ready ? GOLD : '#4d5a72';
    ctx.fillRect(x - width / 2, y - 36, width * clamp(cast.preview.score, 0, 1), 3);
    // Where the score has to reach before the shape will lock.
    ctx.fillStyle = '#8d9ab4';
    ctx.fillRect(x - width / 2 + width * 0.6, y - 39, 1, 9);
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(x, y, (gate ? 8 : 5) + cast.charge * 5, 0, Math.PI * 2);
  ctx.fillStyle = gate ? '#fff6e2' : '#c3cbd8';
  ctx.fill();
  if (cast.phase === 'charging') {
    ctx.beginPath();
    ctx.arc(x, y, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cast.charge);
    ctx.lineWidth = 3;
    ctx.strokeStyle = cast.overloading ? '#ff6a4d' : GOLD;
    ctx.stroke();

    // updateCast() has been handing the locked rune over all along and nothing
    // drew it, so the shape locking in was invisible: the player had to release
    // and read the bottom-left log to learn what they had cast. Naming it here
    // is also the only signal that the stroke was accepted at all, which is
    // exactly what you need to decide whether to keep holding or let go.
    if (cast.rune) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = "500 13px 'IBM Plex Mono', monospace";
      ctx.letterSpacing = '0.14em';
      ctx.fillStyle = cast.overloading ? '#ff6a4d' : GOLD;
      ctx.fillText(cast.rune.name.toUpperCase(), x, y - 48);
      ctx.font = "500 10px 'IBM Plex Mono', monospace";
      ctx.fillStyle = cast.overloading ? '#ff6a4d' : '#9aa6bd';
      ctx.fillText(cast.overloading
        ? 'RELEASE NOW'
        : cast.assisted
          ? 'LOOP LOCKED · RELEASE TO CAST'
          : `${Math.round(cast.charge * 100)}% · RELEASE TO CAST`, x, y - 32);
      ctx.restore();
    }
  }
}

// The rune vocabulary is the one thing a player cannot discover by trying. An
// unrecognised stroke looks identical to a stroke the game never saw, so without
// the shapes on the glass "draw a rune" is a guessing game. Recognition is scale
// and position invariant, so these are a vocabulary, not a target to trace over.
function drawRuneLegend(height) {
  const size = 40;
  const top = height - 122;
  RUNES.forEach((rune, index) => {
    const left = 24 + index * 78;
    const active = rune.id === selectedRuneId;
    ctx.beginPath();
    rune.points.forEach((point, i) => {
      const x = left + point.x * size;
      const y = top + point.y * size;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = active ? GOLD : 'rgba(127,137,159,.45)';
    ctx.lineWidth = active ? 2 : 1.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = "500 9px 'IBM Plex Mono', monospace";
    ctx.fillStyle = active ? GOLD : '#5d6b86';
    ctx.fillText(`${index + 1} ${rune.name.split(' ')[0].toUpperCase()}`, left, top + size + 14);
  });
}

function drawBar(x, y, width, value, colour, align = 'left') {
  const left = align === 'right' ? x - width : x;
  ctx.fillStyle = 'rgba(7,9,16,.72)';
  ctx.fillRect(left, y, width, 8);
  const filled = width * clamp(value, 0, 1);
  ctx.fillStyle = colour;
  ctx.fillRect(align === 'right' ? x - filled : left, y, filled, 8);
}

const _project = new THREE.Vector3();
function drawHud(now, botState) {
  const width = innerWidth;
  const height = innerHeight;
  if (now < flashUntil) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, (flashUntil - now) / 360) * 0.18;
    ctx.fillStyle = FLASH_COLOUR[flashKind] ?? '#ff8b6b';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  ctx.save();
  ctx.font = "600 11px 'IBM Plex Mono', monospace";
  ctx.letterSpacing = '0.12em';
  ctx.fillStyle = GOLD;
  ctx.fillText('LANTERN', 24, 30);
  drawBar(24, 40, Math.min(280, width * 0.27), match.player.hp / DUEL.maxHp, GOLD);
  drawBar(24, 54, Math.min(210, width * 0.2), match.player.mana / DUEL.maxMana, '#8cc9ff');

  ctx.textAlign = 'right';
  ctx.fillStyle = VIOLET;
  ctx.fillText(onlineDuel ? 'VEIL FRIEND' : 'VEIL RIVAL', width - 24, 30);
  drawBar(width - 24, 40, Math.min(280, width * 0.27), match.opponent.hp / DUEL.maxHp, VIOLET, 'right');
  drawBar(width - 24, 54, Math.min(210, width * 0.2), match.opponent.mana / DUEL.maxMana, '#7f72d8', 'right');

  const totalSeconds = Math.ceil(match.timeLeft);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  ctx.textAlign = 'center';
  ctx.font = "500 20px 'IBM Plex Mono', monospace";
  ctx.fillStyle = '#e8e4dc';
  ctx.fillText(`${minutes}:${seconds}`, width / 2, 34);

  const owner = match.well.owner === 'player' ? 'YOUR CORE CHARGING'
    : match.well.owner === 'opponent' ? 'RIVAL CORE CHARGING' : 'VEIL WELL UNBOUND';
  ctx.font = "500 10px 'IBM Plex Mono', monospace";
  ctx.fillStyle = match.well.owner === 'player' ? GOLD : match.well.owner === 'opponent' ? VIOLET : '#7f899f';
  ctx.fillText(owner, width / 2, 52);
  drawBar(width / 2 - 80, 60, 160, (match.well.progress + 1) / 2, ctx.fillStyle);

  _project.copy(opponentPosition).setY(3.9).project(camera);
  if (_project.z < 1) {
    const x = (_project.x * 0.5 + 0.5) * width;
    const y = (-_project.y * 0.5 + 0.5) * height;
    ctx.beginPath();
    ctx.arc(x, y, 7 + botState.telegraph * 10, 0, Math.PI * 2);
    ctx.strokeStyle = botState.telegraph > 0 ? '#d4caff' : 'rgba(205,198,235,.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // The rival raises Aegis the moment you start charging, and it swallows the
    // whole hit. Unsaid, that reads as "my spells do nothing". Said, with the
    // seconds left on it, it becomes the thing it was meant to be: hold the
    // charge until the shield lapses, then release.
    const shieldLeft = spells.shieldRemaining('opponent', now);
    if (shieldLeft > 0) {
      ctx.beginPath();
      ctx.arc(x, y, 20, 0, Math.PI * 2);
      ctx.strokeStyle = '#d4caff';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = "500 10px 'IBM Plex Mono', monospace";
      ctx.fillStyle = '#d4caff';
      ctx.fillText(`AEGIS ${shieldLeft.toFixed(1)}s`, x, y - 28);
      ctx.restore();
    }
  }

  ctx.textAlign = 'left';
  ctx.font = "500 11px 'IBM Plex Mono', monospace";
  ctx.fillStyle = '#7f899f';
  const selected = RUNES.find(rune => rune.id === selectedRuneId)?.name ?? 'Ringfall';
  const activeCooldown = bowMode ? cooldowns.bow : cooldowns[selectedRuneId];
  const cooldown = activeCooldown > 0 ? ` · cooldown ${activeCooldown.toFixed(1)}` : '';
  ctx.fillText(bowMode
    ? `WASD · BOW ${bowStringSide.toUpperCase()} STRING · RELEASE TO SHOOT${cooldown}`
    : `WASD · 1/2/3 ${selected} · TAB ${targetMode} · J/K cast${cooldown}`,
  24, height - 24);
  if (lastCast && now - lastCastAt < 1800) {
    ctx.fillStyle = GOLD;
    ctx.fillText(`${lastCast.name} ${Math.round(lastCast.charge * 100)}%`, 24, height - 44);
  }
  if (!bowMode) drawRuneLegend(height);

  if (tracking) {
    ctx.textAlign = 'right';
    if (bowMode) {
      ctx.fillStyle = bowRead?.phase === 'nocked' ? GOLD : '#8ab4ff';
      ctx.fillText(bowRead?.phase === 'nocked'
        ? `BOW ${Math.round((bowRead.draw ?? 0) * 100)}% · ${bowRead.spans.toFixed(2)} SPANS`
        : 'CLOSE ONE HAND TO NOCK', width - 24, height - 24);
    } else {
      const debug = pinchDebug();
      ctx.fillStyle = debug.calibrated ? '#66738d' : '#b8894a';
      ctx.fillText(debug.calibrated ? (debug.closed ? 'PINCH CLOSED' : 'PINCH OPEN') : 'OPEN + CLOSE TO CALIBRATE', width - 24, height - 24);
    }
  }

  if (match.phase === 'finished') {
    ctx.fillStyle = 'rgba(3,4,9,.72)';
    ctx.fillRect(0, 0, width, height);
    ctx.textAlign = 'center';
    ctx.font = "400 54px 'Cormorant Garamond', serif";
    ctx.fillStyle = match.winner === 'player' ? GOLD : match.winner === 'opponent' ? VIOLET : '#e8e4dc';
    ctx.fillText(match.winner === 'player' ? 'VICTORY' : match.winner === 'opponent' ? 'DEFEAT' : 'DRAW', width / 2, height / 2 - 10);
    ctx.font = "500 12px 'IBM Plex Mono', monospace";
    ctx.fillStyle = '#9aa6bd';
    ctx.fillText(`${match.winReason.toUpperCase()} · PRESS R TO DUEL AGAIN`, width / 2, height / 2 + 28);
  }
  ctx.restore();
}

function setStatus(text) {
  if (statusLine) statusLine.textContent = text;
}

function setRoomStatus(text) {
  roomStatusRevision++;
  if (roomStatusLine) roomStatusLine.textContent = text;
}

function setRoomControlsBusy(busy) {
  if (hostButton) hostButton.disabled = busy;
  if (joinButton) joinButton.disabled = busy;
  if (roomCodeInput) roomCodeInput.disabled = busy;
}

function roomConnectionMessage(message) {
  if (/unavailable|timed out|closed the connection/i.test(message)) {
    return location.port === '5500'
      ? 'LIVE SERVER IS SOLO ONLY · OPEN THE HTTPS SHARE LINK'
      : 'DUEL SERVER OFFLINE · HOST MUST RUN npm run share AGAIN';
  }
  return message.toUpperCase();
}

async function refreshRoomServerStatus() {
  const revision = roomStatusRevision;
  const ready = await checkRoomServer();
  if (revision !== roomStatusRevision) return;
  setRoomStatus(ready
    ? 'ONLINE DUEL READY · CREATE OR JOIN A ROOM'
    : roomConnectionMessage('duel server unavailable'));
}

function resize() {
  const dpr = Math.min(devicePixelRatio, 1.5);
  const cap = performanceGovernor.tier === 2 ? 1.25 : performanceGovernor.tier === 1 ? 1 : 0.85;
  renderer.setPixelRatio(Math.min(devicePixelRatio, cap));
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  overlayCanvas.width = innerWidth * dpr;
  overlayCanvas.height = innerHeight * dpr;
  overlayCanvas.style.width = `${innerWidth}px`;
  overlayCanvas.style.height = `${innerHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

addEventListener('resize', resize);
void refreshRoomServerStatus();
addEventListener('beforeunload', () => {
  running = false;
  coverVideo?.pause();
  setSelfieVisible(false);
  disposeTracker();
  roomClient.close();
  for (const arrow of arrows) arrow.mesh.removeFromParent();
  arrowGeometry.dispose();
  arrowMaterial.dispose();
  playerHalo.dispose();
  opponentHalo.dispose();
  spells.dispose();
  playerAvatar.dispose();
  opponentAvatar.dispose();
});

if (typeof window !== 'undefined') {
  window.__arena = () => ({
    player: playerPosition.toArray().map(value => +value.toFixed(2)),
    opponent: opponentPosition.toArray().map(value => +value.toFixed(2)),
    hp: [match.player.hp, match.opponent.hp],
    mana: [Math.round(match.player.mana), Math.round(match.opponent.mana)],
    well: { ...match.well },
    phase: match.phase,
    renderer: {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    },
  });
}

const runeList = document.querySelector('[data-arena-runes]');
if (runeList) runeList.textContent = RUNES.map(rune => rune.name).join(' · ');
setStatus(isReady() ? 'ready' : 'keyboard ready');
resize();
void loadArenaShell();
void loadMeshyDuelists();
void loadArenaProps();
void loadBow();
