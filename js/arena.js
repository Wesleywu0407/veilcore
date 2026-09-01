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
import { createBoxingState } from './spell-room/boxing.js';
import { createBowAim } from './spell-room/aim.js';
import { createInputMode } from './spell-room/input-mode.js';
import { createBowView, DUEL_BOW_MOUNT } from './arena/bow-view.js';
import { loadGLB } from './arena/asset-library.js';
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
const playerAvatar = createDuelist(scene, { colour: 0xffd98a, name: 'Lantern Duelist', castShadow: true });
const opponentAvatar = createDuelist(scene, { colour: 0x9b87ff, name: 'Veil Rival', castShadow: false });
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
    const gltf = await loadGLB(url);
    arena.attachShell(gltf.scene.clone(true));
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
    const gltf = await loadGLB(url);
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
    const [{ clone }, gltf, settled] = await Promise.all([
      import('three/addons/utils/SkeletonUtils.js'),
      loadGLB(url),
      Promise.allSettled(DUELIST_CLIPS.map(clip => loadGLB(clip))),
    ]);
    // These files are armature and curves only — no mesh, no textures — so they
    // cost kilobytes against the model's megabytes and are worth fetching in
    // parallel. One missing clip should cost that action alone, not the model,
    // hence allSettled rather than all.
    const clips = gltf.animations.concat(
      settled.flatMap(result => (result.status === 'fulfilled' ? result.value.animations : [])),
    );
    // Clips are immutable data in three.js; each avatar's mixer builds its own
    // bindings, so the two duelists can share one array.
    playerAvatar.replaceVisual(clone(gltf.scene), clips);
    opponentAvatar.replaceVisual(clone(gltf.scene), clips);
    setStatus(`Meshy duelist loaded — ${clips.length} clips`);
  } catch (error) {
    playerAvatar.useFallback();
    opponentAvatar.useFallback();
    setStatus(`Meshy model fallback: ${error.message}`);
  }
}

async function loadBow() {
  const url = 'assets/models/arena/bow.glb';
  try {
    const gltf = await loadGLB(url);
    bowView.attachLimbs(gltf.scene);
  } catch (error) {
    setStatus(`bow model fallback: ${error.message}`);
  }
}

async function loadArenaEffects() {
  const [gravity, core, focus, shard] = await Promise.allSettled([
    spells.loadGravity('assets/models/arena/vfx/gravity-seal.glb'),
    loadGLB('assets/models/arena/vfx/veil-core.glb'),
    loadGLB('assets/models/arena/vfx/hand-focus.glb'),
    loadGLB('assets/models/arena/vfx/mana-shard.glb'),
  ]);
  if (gravity.status === 'rejected') spells.useSealFallback();
  if (core.status === 'fulfilled') arena.attachCoreVisual(core.value.scene);
  if (focus.status === 'fulfilled') {
    playerAvatar.attachCastFocus(focus.value.scene.clone(true));
    opponentAvatar.attachCastFocus(focus.value.scene.clone(true));
  }
  if (shard.status === 'fulfilled') arena.attachSpillVisual(shard.value.scene);

  const failures = [gravity, core, focus, shard].filter(result => result.status === 'rejected');
  if (failures.length) setStatus(`effect assets: ${failures.length} missing`);
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
const boxing = createBoxingState();
let fistMode = false;
// Whether the rival is close enough to hit right now. Kept as state because the
// HUD reads it every frame and the punch only asks at the moment it lands.
let punchInRange = false;

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
    const gltf = await loadGLB(url);
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
    setStatus(`${event.source === 'bow' ? 'arrow' : event.source === 'punch' ? 'a fist' : 'spell'} hit you`);
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

// ─── The punch ───────────────────────────────────────────────────────────────
//
// No mana, no cooldown, no projectile: a punch is a distance test and a cone
// test, resolved on the frame the fist crosses the threshold. Everything that
// makes it feel like anything -- the arm travelling, the guard, the lens -- is
// elsewhere; this is only the question of whether it landed.

const _punchFacing = new THREE.Vector3();
const _punchToward = new THREE.Vector3();

/** True if the rival is inside punching distance of where the player stands. */
function opponentInPunchRange() {
  return _punchToward.subVectors(opponentPosition, playerPosition).setY(0).length() <= DUEL.punchRange;
}

function throwPunch(side, now) {
  if (match.phase !== 'playing') return false;

  _punchToward.subVectors(opponentPosition, playerPosition).setY(0);
  const range = _punchToward.length();
  // Deliberately not a silent no-op out of range. The swing costs nothing, so
  // letting it happen and miss is what teaches the distance -- and refusing to
  // animate it would read as the tracking having dropped your hand.
  if (range > DUEL.punchRange || range < 1e-4) {
    setStatus('too far to punch');
    return false;
  }

  // Facing rather than aim. In this stance the body is locked to the lens
  // heading, so the cone is simply "roughly at what you are looking at".
  _punchFacing.set(Math.sin(orbitYaw), 0, Math.cos(orbitYaw));
  _punchToward.divideScalar(range);
  if (_punchFacing.dot(_punchToward) < Math.cos((DUEL.punchCone * Math.PI) / 180)) {
    setStatus('the punch went wide');
    return false;
  }

  // The Aegis does not stop this, and that is the point of closing the distance.
  // It is a barrier against things thrown from across the arena; a fist at 2.2
  // is already inside it. Letting it absorb a punch would also hand the player
  // a free way to strip a 24-mana shield with one jab, which is the opposite of
  // what a shield should be worth.
  damage(match, 'opponent', DUEL.punchDamage);
  opponentAvatar.flash();
  // Against a person rather than the bot, the local decrement is only a guess:
  // applyRemoteState overwrites match.opponent.hp from whatever the peer says
  // about itself, so a hit that is not sent is erased within 50ms. Every other
  // attack tells the victim; so does this one.
  sendRoomEvent({ kind: 'damage', amount: DUEL.punchDamage, source: 'punch' });
  lastCast = { name: `${side === 'left' ? 'Left' : 'Right'} Straight`, charge: null };
  lastCastAt = now;
  flashUntil = now + 120;
  flashKind = 'cast';
  setStatus('punch landed');
  return true;
}

// Nothing kept two duelists apart before this: the arena's colliders are
// pillars, and at spell range the pair never met. Punching distance is 2.2, so
// without a push they simply interpenetrate and the first-person lens ends up
// inside the rival's chest. Split the overlap evenly and re-run each body
// against the arena, so a shove can never push either of them through a pillar
// or over the rim.
const _apart = new THREE.Vector3();

function separateDuelists() {
  _apart.subVectors(playerPosition, opponentPosition).setY(0);
  const gap = _apart.length();
  if (gap >= DUEL.duelistClearance) return;
  // Exactly coincident has no direction to push along. Any fixed one will do;
  // the next frame has a real one.
  if (gap < 1e-4) _apart.set(1, 0, 0);
  else _apart.divideScalar(gap);
  const push = (DUEL.duelistClearance - gap) / 2;
  playerPosition.addScaledVector(_apart, push);
  opponentPosition.addScaledVector(_apart, -push);
  resolveArenaCollision(playerPosition);
  resolveArenaCollision(opponentPosition);
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
  fistMode = false;
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
  // While either two-handed stance is up the body faces where the LENS is aimed,
  // and nothing else.
  //
  // Everywhere else the duelist turns to face what it is doing -- the rival when
  // standing, the direction of travel when walking. In first person both of
  // those are wrong, and wrong in a way that is invisible from any other camera:
  // the bow is rigid in the body's space, so every degree the body turns away
  // from the lens slides the bow across the frame. Strafing was the worst of it,
  // turning the body ninety degrees to face the walk while the view stayed on
  // the rival, which threw the bow clean out of shot. Facing _forward keeps the
  // body and the lens on the same heading, which is also what an archer does:
  // you turn to your target and strafe without turning.
  if (_move.lengthSq() === 0) {
    // Hold whatever facing the stroke started on; re-aiming here is the other
    // half of the same sway.
    if (bowMode || fistMode) playerAvatar.face(_forward);
    else if (!playerAvatar.reaching) {
      _look.subVectors(opponentPosition, playerPosition).setY(0).normalize();
      playerAvatar.face(_look);
    }
    return 0;
  }

  _move.normalize();
  playerPosition.addScaledVector(_move, DUEL.playerSpeed * dt);
  resolveArenaCollision(playerPosition);
  playerAvatar.face(bowMode || fistMode ? _forward : _move);
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
// Drawing a bow goes to FIRST PERSON, and it gets there as a move rather than a
// swap: the lens leaves the chase camera, travels in to the duelist's own eye,
// and while it travels the look slides down the body -- torso, then the bow
// arm's elbow, then the bow itself -- before settling downrange and closing in.
//
// This works on this rig where the earlier attempt did not, and the difference
// is which arm you are looking at. Measured off the skeleton at full draw, from
// the Head bone: the bow hand sits 1.06 ahead of the eye and 26 degrees off
// axis, comfortably photographable; the string hand sits 0.16 away at 73
// degrees off axis, which is to say against your own cheek and outside any
// sane frame. The sweep that rejected first person was measuring the string
// arm. The bow arm was never the problem, and the bow arm is the only one this
// shot contains -- which is why you see a left hand and no right one.
const EYE_AHEAD = 0.30;    // in front of the face, so the helm falls behind the lens
const BOW_EYE_FOV = 45;    // where the closing-in settles
// Fists ride the same journey to the same eye and stop at a wider lens. 45 is
// the angle that just fits a bow into frame; nothing has to fit into a punch,
// and closing to 2.2 of someone through a 45-degree lens is looking down a
// straw. Only the lens changes between the two, so rolling the wrists mid-duel
// widens the view instead of flying the camera out and back in.
const FIST_EYE_FOV = 65;
// The beats of the move, as fractions of the travel. They overlap on purpose:
// each blend starts before the last has finished, so the look flows down the
// arm instead of stopping at each joint.
const BEAT_ELBOW = [0.25, 0.62];
const BEAT_BOW = [0.55, 0.86];
const BEAT_DOWNRANGE = [0.78, 1.0];
const BEAT_ZOOM = [0.60, 1.0];
// Slow enough to read as a journey rather than a transition, quick enough that
// you are not waiting on it to shoot. At 2.7 the move arrives in a little over
// a second, with the last beat -- the lift off the bow and the closing in --
// taking up the final third of that.
const BOW_MOVE_RATE = 2.7;
const stage = (t, [a, b]) => clamp((t - a) / (b - a), 0, 1);
const smooth = t => t * t * (3 - 2 * t);
const _bowElbow = new THREE.Vector3();
const _bowEye = new THREE.Vector3();
const _downrange = new THREE.Vector3();
// Where the first-person lens settles. Held across frames rather than picked
// each one so that bow and fists ease into each other's framing.
let eyeFov = BOW_EYE_FOV;
const _bowHand = new THREE.Vector3();
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
  const eyeMode = bowMode || fistMode;
  const wantCast = playerAvatar.reaching && !eyeMode ? 1 : 0;
  const wantBow = eyeMode ? 1 : 0;
  castFraming += (wantCast - castFraming) * Math.min(1, dt * 9);
  bowFraming += (wantBow - bowFraming) * Math.min(1, dt * BOW_MOVE_RATE);
  // Eased at the same rate as the move itself, so a wrist roll reads as one
  // gesture rather than as the lens snapping while the body stays put.
  eyeFov += ((fistMode ? FIST_EYE_FOV : BOW_EYE_FOV) - eyeFov) * Math.min(1, dt * BOW_MOVE_RATE);

  // The three things the move looks at on its way in. With the fists up there
  // is no drawn bow, so bowHandWorld hands back the shoulder instead -- which
  // keeps the journey body, arm, forward, and the last beat lifts off it
  // anyway.
  playerAvatar.bowHandWorld(_bowHand);
  if (!playerAvatar.bowElbowWorld(_bowElbow)) _bowElbow.copy(_bowHand);
  playerAvatar.eyeWorld(_bowEye);

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

  // The eye, nudged forward of the face. At the Head bone itself the helm
  // surrounds the lens and you look at the inside of your own mask; 0.30 ahead
  // puts it behind the near plane, where back-face culling disposes of it.
  _bowPos.copy(_bowEye).addScaledVector(_flat, EYE_AHEAD);

  // Body, then arm, then bow, then downrange. The last beat matters as much as
  // the others: a camera that settles pointing AT your own bow hand is a camera
  // you cannot aim, so the move ends by lifting off the bow and looking out
  // over it -- which is what leaves the bow sitting low and to the left, held
  // in the left hand, exactly where an archer's own bow sits.
  _bowLook.copy(_chaseLook)
    .lerp(_bowElbow, stage(bowFraming, BEAT_ELBOW))
    .lerp(_bowHand, stage(bowFraming, BEAT_BOW))
    .lerp(_downrange.copy(_bowPos).addScaledVector(_flat, 12), stage(bowFraming, BEAT_DOWNRANGE));

  // A slightly wider lens while casting, to keep the whole drawing arc in frame
  // from this much closer camera.
  const fov = lerp(lerp(DUEL_FOV, CAST_FOV, castFraming), eyeFov, stage(bowFraming, BEAT_ZOOM));
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }

  castCamera.aspect = camera.aspect;
  castCamera.position.copy(_castPos);
  castCamera.lookAt(_castLook);
  castCamera.updateProjectionMatrix();
  castCamera.updateMatrixWorld(true);

  const moved = smooth(bowFraming);
  _cameraPosition.lerpVectors(_chasePos, _castPos, castFraming).lerp(_bowPos, moved);
  _look.lerpVectors(_chaseLook, _castLook, castFraming).lerp(_bowLook, moved);
  // Snappier the further into the casting view we are; the duelling chase camera
  // wants the lazy follow, the swap onto the shoulder does not.
  //
  // The bow view wants NO follow at all by the time it arrives. A lens that
  // chases its own target is always a little behind the body, and in first
  // person that lag is not felt as camera softness -- it is seen as the bow
  // sliding around, since the bow is nailed to the body and the lens is the only
  // thing adrift. Blending the smoothing out to 1 locks them together.
  camera.position.lerp(_cameraPosition, lerp(lerp(0.18, 0.55, castFraming), 1, moved));
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
    boxing.reset();
    fistMode = false;
    punchInRange = false;
    playerAvatar.punch(null);
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

  if (mode.mode === 'fist') {
    if (mode.changed) {
      resetMagic();
      playerAvatar.reach(null);
      bowState.reset();
      bowAim.reset();
      bowRead = null;
      playerAvatar.drawBow(null);
      bowView.setVisible(false);
      // Fresh baselines. Carrying the ones from before the wrists rolled would
      // measure this stance against how the hands sat in the last one.
      boxing.reset();
    }
    bowMode = false;
    fistMode = true;
    const fists = boxing.update(frame.hands, now);
    playerAvatar.punch({ left: fists.left.extension, right: fists.right.extension });
    punchInRange = opponentInPunchRange();
    // A raised guard is not a telegraph. Leaving this on would have the rival
    // shield itself for as long as the fists are up, which is the whole match.
    playerCharging = false;
    if (fists.left.punched) throwPunch('left', now);
    if (fists.right.punched) throwPunch('right', now);
    drawFistLayer(frame, fists);
    return;
  }

  if (mode.mode === 'bow') {
    if (mode.changed) {
      resetMagic();
      playerAvatar.reach(null);
      bowAim.reset();
      fistMode = false;
      playerAvatar.punch(null);
      boxing.reset();
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

  if (mode.changed || bowMode || fistMode) {
    bowState.reset();
    bowAim.reset();
    bowRead = null;
    bowMode = false;
    playerAvatar.drawBow(null);
    bowView.setVisible(false);
    boxing.reset();
    fistMode = false;
    punchInRange = false;
    playerAvatar.punch(null);
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

// ── Whose error is it ────────────────────────────────────────────────────────
//
// Not every error on this page belongs to this page. A browser extension that
// injects a script into the document throws into the same window, and the two
// handlers below used to catch that, stop the loop, and put someone else's
// crash on the glass as though the duel had died. The one that actually
// happened was a pair of crypto wallet extensions arguing over which of them
// gets to define window.ethereum -- nothing to do with a duel, and it ended
// the match.
//
// So attribution decides whether an error is FATAL. Everything is still
// reported, because an error nobody hears about is how the evening got lost in
// the first place; a foreign one just goes to the console and the game keeps
// running.
const OWN_ORIGIN = location.origin && location.origin !== 'null' ? location.origin : null;

// Opened straight off the filesystem there is no origin to compare against, so
// nothing can be attributed and the old behaviour -- everything is fatal -- is
// the safer of the two failure modes.
const isOurScript = filename =>
  !OWN_ORIGIN || (typeof filename === 'string' && filename.startsWith(OWN_ORIGIN));

// A rejection carries no filename, only whatever stack its reason happens to
// have. An unattributable one is far more often an extension's than ours, and
// stopping the duel on a stranger's promise is worse than carrying on with a
// line in the console -- so silence here means "not ours".
const isOurRejection = reason =>
  !OWN_ORIGIN || (typeof reason?.stack === 'string' && reason.stack.includes(OWN_ORIGIN));

// Extensions can be chatty, and one that throws every frame would bury the
// console it is being written to. One line per distinct message is enough to
// tell you it is happening.
const foreignSeen = new Set();

function reportForeign(error, where) {
  const message = String(error?.message ?? error);
  if (foreignSeen.has(message)) return;
  foreignSeen.add(message);
  console.warn(`[veilcore] ${where} from outside this page — ignored, the duel is still running:`, error);
}

// Anything thrown outside the loop -- the tracker's own callback, a late asset
// load -- would otherwise reach only the console.
addEventListener('error', event => {
  const error = event.error ?? event.message;
  if (isOurScript(event.filename)) reportFatal(error, 'uncaught');
  else reportForeign(error, 'uncaught error');
});
addEventListener('unhandledrejection', event => {
  if (isOurRejection(event.reason)) reportFatal(event.reason, 'unhandled rejection');
  else reportForeign(event.reason, 'unhandled rejection');
});

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

  // After both have moved, before either is drawn, and outside the branch:
  // walking into a real opponent is exactly as wrong as walking into the bot.
  // Doing it here rather than inside each body's own collision pass is what
  // makes the push symmetric.
  //
  // Online, only half of it sticks. The rival's position is eased toward what
  // the network last said, so shoving it locally is undone within a few frames
  // -- but shoving YOURSELF out persists, and the peer is running this same
  // line against you, so the pair still comes apart.
  separateDuelists();
  playerAvatar.setPosition(playerPosition);
  opponentAvatar.setPosition(opponentPosition);

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
  boxing.reset();
  punchInRange = false;
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
  // Two hands no longer mean one thing, so this reads the live mode rather than
  // counting hands and assuming.
  const mode = hands.length === 2 ? (fistMode ? 'FIST' : 'BOW')
    : hands.length === 1 ? 'RUNES' : 'SHOW HANDS';
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

// The fists, on the glass. Deliberately quiet: unlike the bow there is nothing
// to aim, so this is a readout rather than a sight -- how far each hand has
// been pushed, and whether the rival is close enough for it to matter.
function drawFistLayer(frame, fists) {
  const width = innerWidth;
  const height = innerHeight;
  if (frame.hands?.length !== 2) return;

  for (const hand of frame.hands) {
    const state = hand.side === 'left' ? fists.left : fists.right;
    if (!state?.present) continue;
    const x = hand.wrist.x * width;
    const y = hand.wrist.y * height;
    // Grows with the throw, filled once the blow has actually gone out.
    const radius = 8 + state.extension * 20;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = state.thrown ? GOLD : 'rgba(138,180,255,.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    if (state.thrown) {
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,217,138,.18)';
      ctx.fill();
    }
  }

  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = "500 10px 'IBM Plex Mono', monospace";
  ctx.fillStyle = punchInRange ? GOLD : 'rgba(138,180,255,.6)';
  ctx.fillText(punchInRange ? 'IN RANGE' : 'CLOSE IN', width / 2, height * 0.62);
  ctx.restore();
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
  // The fists have no cooldown and no cost, so the row that usually carries
  // those carries the one thing left that changes: whether you are close enough.
  // At a 65-degree lens, 2.2 is genuinely hard to judge by eye.
  if (fistMode) ctx.fillStyle = punchInRange ? GOLD : '#7f899f';
  ctx.fillText(fistMode
    ? `WASD · FISTS UP · ${punchInRange ? 'IN RANGE — PUNCH' : 'CLOSE IN TO PUNCH'}`
    : bowMode
      ? `WASD · BOW ${bowStringSide.toUpperCase()} STRING · RELEASE TO SHOOT${cooldown}`
      : `WASD · 1/2/3 ${selected} · TAB ${targetMode} · J/K cast${cooldown}`,
  24, height - 24);
  ctx.fillStyle = '#7f899f';
  if (lastCast && now - lastCastAt < 1800) {
    ctx.fillStyle = GOLD;
    ctx.fillText(Number.isFinite(lastCast.charge)
      ? `${lastCast.name} ${Math.round(lastCast.charge * 100)}%`
      : lastCast.name, 24, height - 44);
  }
  if (!bowMode && !fistMode) drawRuneLegend(height);

  if (tracking) {
    ctx.textAlign = 'right';
    if (fistMode) {
      // Both ratios, raw. If a punch stops registering this says immediately
      // whether the hand is not reaching the threshold or the baseline has
      // crept up under it.
      const left = boxing.left.ratio;
      const right = boxing.right.ratio;
      ctx.fillStyle = boxing.left.thrown || boxing.right.thrown ? GOLD : '#8ab4ff';
      ctx.fillText(`FISTS · L ${left.toFixed(2)} · R ${right.toFixed(2)}`, width - 24, height - 24);
    } else if (bowMode) {
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
  arena.dispose();
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
void loadArenaEffects();
