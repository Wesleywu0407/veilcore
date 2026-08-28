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
import { createBeam } from './spells/beam.js';
import { initTracker, getFrame, isReady, disposeTracker } from './spell-room/tracker.js';
import { isPinching, updateCast, currentStroke, resetMagic, RUNES, pinchDebug } from './spell-room/magic.js';

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

const playerPosition = new THREE.Vector3(0, 0, 14);
const opponentPosition = new THREE.Vector3(0, 0, -12);
const playerAvatar = createDuelist(scene, { colour: 0xffd98a, name: 'Lantern Duelist' });
const opponentAvatar = createDuelist(scene, { colour: 0x9b87ff, name: 'Veil Rival' });
playerAvatar.setPosition(playerPosition);
opponentAvatar.setPosition(opponentPosition);
let bot = createOpponentController(opponentPosition);

let match = createMatch();
const cooldowns = { ringfall: 0, aegis: 0, 'gravity-seal': 0 };
let selectedRuneId = 'ringfall';
let targetMode = 'rival';
let botCastCount = 0;

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
      core.pedestal.visible = false;

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

const FLASH_COLOUR = { cast: GOLD, fizzle: '#ff8b6b', overload: '#ff3d2e', blocked: '#6f7f9a', hit: '#b36cff' };

// ─── Combat ──────────────────────────────────────────────────────────────────

const _segment = new THREE.Vector3();
const _relative = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _targetCentre = new THREE.Vector3();

function disruptAndSpill(side) {
  const amount = disruptCore(match, side);
  if (amount <= 0) return false;
  arena.spillCore(side, amount);
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

const playerBeam = createBeam({
  scene,
  onHit(from, to, radius, amount) {
    let hit = false;
    if (laneHits(from, to, opponentPosition, radius)) {
      if (spells.absorb('opponent', performance.now())) {
        setStatus('rival Aegis absorbed Ringfall');
      } else {
        damage(match, 'opponent', amount);
        opponentAvatar.flash();
      }
      hit = true;
    }
    if (laneHits(from, to, arena.cores.opponent.position, radius)) {
      disruptAndSpill('opponent');
      hit = true;
    }
    return hit && match.opponent.hp <= 0 ? 1 : 0;
  },
});

const opponentBeam = createBeam({
  scene,
  colours: [0xffffff, 0xc7baff, 0x755cff],
  onHit(from, to, radius, amount) {
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
  },
});

const _castOrigin = new THREE.Vector3();
const _castTarget = new THREE.Vector3();
const _castDirection = new THREE.Vector3();

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
  playerBeam.fire(_castOrigin, _castDirection, {
    length: 42,
    radius: lerp(1.1, 2.5, power),
    damage: lerp(DUEL.ringfallDamageMin, DUEL.ringfallDamageMax, power),
    seconds: 0.5 + power * 0.38,
  });
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
  opponentBeam.fire(origin, direction, {
    length: Math.max(10, origin.distanceTo(destination) + 2),
    radius: 1.25,
    damage: DUEL.botDamage,
    seconds: 0.65,
  });
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
const CAST_BACK = 1.00;    // behind the shoulder
const CAST_UP = 3.46;      // above the duelist's feet
const CAST_SIDE = 0.5;     // toward the drawing shoulder
const CAST_LOOK_Y = 2.61;
const CAST_LOOK_FWD = 0.72;
const DUEL_FOV = 58;
const CAST_FOV = 62;
const _flat = new THREE.Vector3();
const _chasePos = new THREE.Vector3();
const _chaseLook = new THREE.Vector3();
const _castPos = new THREE.Vector3();
const _castLook = new THREE.Vector3();
// Where the casting view WILL be, available even while the render camera is
// still swinging into it. The hand target is unprojected through this rather
// than through the live camera: at the start of a cast the live camera is still
// out at chase distance, and unprojecting through it threw the target metres
// behind the duelist for the first few frames, so the arm flailed backwards.
const castCamera = new THREE.PerspectiveCamera(CAST_FOV, 1, 0.1, 180);

function updateCamera(dt) {
  const want = playerAvatar.reaching ? 1 : 0;
  castFraming += (want - castFraming) * Math.min(1, dt * 9);

  // A slightly wider lens while casting, to keep the whole drawing arc in frame
  // from this much closer camera.
  const fov = lerp(DUEL_FOV, CAST_FOV, castFraming);
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

  castCamera.aspect = camera.aspect;
  castCamera.position.copy(_castPos);
  castCamera.lookAt(_castLook);
  castCamera.updateProjectionMatrix();
  castCamera.updateMatrixWorld(true);

  _cameraPosition.lerpVectors(_chasePos, _castPos, castFraming);
  _look.lerpVectors(_chaseLook, _castLook, castFraming);
  // Snappier the further into the casting view we are; the duelling chase camera
  // wants the lazy follow, the swap onto the shoulder does not.
  camera.position.lerp(_cameraPosition, lerp(0.18, 0.55, castFraming));
  camera.lookAt(_look);
}

// ─── Webcam ──────────────────────────────────────────────────────────────────

async function toggleTracking() {
  if (tracking) {
    tracking = false;
    resetMagic();
    disposeTracker();
    setStatus('webcam off');
    return;
  }
  try {
    await initTracker(video, stage => setStatus(stage));
    tracking = true;
    setStatus('hand casting ready');
  } catch (error) {
    setStatus(`camera: ${error.message}`);
  }
}

startButton?.addEventListener('click', async () => {
  coverVideo?.pause();
  startPanel.hidden = true;
  running = true;
  resize();
  requestAnimationFrame(loop);
  if (NO_CAMERA) {
    setStatus('keyboard casting ready · webcam skipped for QA');
    return;
  }
  try {
    await initTracker(video, stage => setStatus(stage));
    tracking = true;
  } catch (error) {
    if (errorLine) {
      errorLine.hidden = false;
      errorLine.textContent = error.message;
    }
    setStatus('keyboard casting ready · H retries camera');
  }
});

function updateHand(now) {
  if (!tracking) {
    playerCharging = false;
    return;
  }
  const frame = getFrame();
  const gate = isPinching(frame.tracked ? frame.landmarks : null, frame.handScale, now);
  const cast = updateCast(gate && frame.tracked, frame.tip, now);
  playerAvatar.reach(gate && frame.tracked ? handTarget(frame.tip) : null, cast.charge);
  playerCharging = cast.phase === 'charging';
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

// ─── Loop ─────────────────────────────────────────────────────────────────────

let last = performance.now();
function loop(now) {
  if (!running) return;
  const dt = Math.min((now - last) / 1000, 0.08);
  last = now;
  worldTime += dt;
  ctx.clearRect(0, 0, innerWidth, innerHeight);

  const playerSpeed = movePlayer(dt, now);
  playerAvatar.setPosition(playerPosition);
  playerAvatar.update(dt, playerSpeed);

  const spellState = spells.update(dt, now, { player: playerPosition, opponent: opponentPosition });
  const botState = bot.update(dt, playerPosition, {
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

  const playerInWell = Math.hypot(playerPosition.x, playerPosition.z) <= DUEL.wellRadius;
  const opponentInWell = Math.hypot(opponentPosition.x, opponentPosition.z) <= DUEL.wellRadius;
  updateMatch(match, dt, { player: playerInWell, opponent: opponentInWell });
  match.player.mana = clamp(match.player.mana + arena.collectMana(playerPosition), 0, DUEL.maxMana);
  match.opponent.mana = clamp(match.opponent.mana + arena.collectMana(opponentPosition), 0, DUEL.maxMana);
  arena.update(worldTime, match);

  for (const id of Object.keys(cooldowns)) cooldowns[id] = Math.max(0, cooldowns[id] - dt);
  playerBeam.update(dt);
  opponentBeam.update(dt);
  updateCamera(dt);
  updateHand(now);

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
  requestAnimationFrame(loop);
}

function resetRound() {
  match = createMatch();
  playerPosition.set(0, 0, 14);
  opponentPosition.set(0, 0, -12);
  bot = createOpponentController(opponentPosition);
  botCastCount = 0;
  arena.clearSpills();
  for (const id of Object.keys(cooldowns)) cooldowns[id] = 0;
  resetMagic();
  setStatus('new duel');
}

// ─── Overlay ──────────────────────────────────────────────────────────────────

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
      ctx.fillText(cast.overloading ? 'RELEASE NOW' : `${Math.round(cast.charge * 100)}% · RELEASE TO CAST`, x, y - 32);
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
  ctx.fillText('VEIL RIVAL', width - 24, 30);
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
  const cooldown = cooldowns[selectedRuneId] > 0 ? ` · cooldown ${cooldowns[selectedRuneId].toFixed(1)}` : '';
  ctx.fillText(`WASD · 1/2/3 ${selected} · TAB ${targetMode} · J/K cast${cooldown}`, 24, height - 24);
  if (lastCast && now - lastCastAt < 1800) {
    ctx.fillStyle = GOLD;
    ctx.fillText(`${lastCast.name} ${Math.round(lastCast.charge * 100)}%`, 24, height - 44);
  }
  drawRuneLegend(height);

  if (tracking) {
    const debug = pinchDebug();
    ctx.textAlign = 'right';
    ctx.fillStyle = debug.calibrated ? '#66738d' : '#b8894a';
    ctx.fillText(debug.calibrated ? (debug.closed ? 'PINCH CLOSED' : 'PINCH OPEN') : 'OPEN + CLOSE TO CALIBRATE', width - 24, height - 24);
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
addEventListener('beforeunload', () => {
  running = false;
  coverVideo?.pause();
  disposeTracker();
  playerBeam.dispose();
  opponentBeam.dispose();
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
void loadMeshyDuelists();
void loadArenaProps();
