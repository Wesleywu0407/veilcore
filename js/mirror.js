// ─── Veilcore — Mirror ────────────────────────────────────────────────────────
//
// One duelist, your body, and nothing else. No runes, no bow, no rival, no
// clock, no quality governor fighting for the frame. The duel is where the
// tracking has to survive; this is where it gets made to look like you in the
// first place, because in the duel you cannot tell whether a wrist looks wrong
// because the tracking is wrong or because a spell moved the camera.
//
// It imports the same modules the duel does -- duelist.js, tracker.js,
// fingers.js -- so anything tuned here is tuned there. Nothing about the body
// is reimplemented, on purpose: a mirror that had its own copy of the arm would
// drift away from the duel and stop being evidence about it.
//
// ── One camera, for looking and for aiming ──
//
// The duel has two: a render camera that swings between chase, shoulder and
// eye, and a fixed `castCamera` that the hand is unprojected through. That
// split is what put the eye in front of the hand in first person -- the lens
// moved and the hand did not. Here there is exactly one camera and the hand is
// unprojected through it, so what you are looking through is always what you
// are being tracked into.

import * as THREE from 'three';
import { buildEnvironment } from './arena/scene.js';
import { createDuelist } from './arena/duelist.js';
import { initTracker, getFrame, disposeTracker, setBodyTracking, bodyTracking } from './spell-room/tracker.js';
import { fingerCurls, palmBasis, FINGERS } from './spell-room/fingers.js';
import { loadGLB } from './arena/asset-library.js';

const GOLD = '#ffd98a';
const BLUE = '#8ab4ff';
const DIM = '#7f899f';
const RED = '#ff9c82';

const DUELIST_URL = 'assets/models/arena/sealed-porcelain-duelist-fingers.glb';
const DUELIST_CLIPS = [
  'assets/models/arena/anim-idle.glb',
  'assets/models/arena/anim-cast.glb',
  'assets/models/arena/anim-hit.glb',
  'assets/models/arena/anim-run.glb',
];

// How far in front of the lens the hand is placed. The duel uses 1.47 against a
// camera parked behind the shoulder; here the camera is the eye itself, so this
// is a real arm's reach from a real eye and nothing cancels out.
const HAND_DEPTH = 0.62;
const EYE_AHEAD = 0.30;    // clears the porcelain helm, same as the duel
const ORBIT_DISTANCE = 3.6;
const ORBIT_HEIGHT = 2.4;

const glCanvas = document.querySelector('[data-mirror-gl]');
const overlay = document.querySelector('[data-mirror-overlay]');
const video = document.querySelector('[data-mirror-video]');
const startPanel = document.querySelector('[data-mirror-start]');
const startButton = document.querySelector('[data-mirror-enter]');
const errorLine = document.querySelector('[data-mirror-error]');
const ctx = overlay.getContext('2d');

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0c14);
scene.environment = buildEnvironment(renderer);
scene.add(new THREE.HemisphereLight(0x9dadd6, 0x101221, 1.6));
const key = new THREE.DirectionalLight(0xffe6c0, 1.9);
key.position.set(2.4, 5, 3.2);
scene.add(key);
const rim = new THREE.DirectionalLight(0x8ab4ff, 0.9);
rim.position.set(-3, 2, -2.6);
scene.add(rim);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(9, 48),
  new THREE.MeshStandardMaterial({ color: 0x1b2133, roughness: 0.95 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
const grid = new THREE.PolarGridHelper(9, 8, 6, 64, 0x2b3550, 0x1f2740);
grid.position.y = 0.01;
scene.add(grid);

const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 200);

const avatar = createDuelist(scene, { colour: 0xffd98a, name: 'Mirror', castShadow: false });
avatar.setPosition(new THREE.Vector3(0, 0, 0));

let modelReady = false;
(async () => {
  try {
    const [{ clone }, gltf, settled] = await Promise.all([
      import('three/addons/utils/SkeletonUtils.js'),
      loadGLB(DUELIST_URL),
      Promise.allSettled(DUELIST_CLIPS.map(clip => loadGLB(clip))),
    ]);
    const clips = gltf.animations.concat(
      settled.flatMap(r => (r.status === 'fulfilled' ? r.value.animations : [])),
    );
    avatar.replaceVisual(clone(gltf.scene), clips);
    modelReady = true;
  } catch (error) {
    status = `model: ${error.message}`;
  }
})();

// ─── Camera ───────────────────────────────────────────────────────────────────

let firstPerson = false;
let orbitYaw = Math.PI;      // start looking at the duelist's front
let orbitPitch = -0.05;
const _eye = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _look = new THREE.Vector3();

function updateCamera() {
  _forward.set(
    Math.sin(orbitYaw) * Math.cos(orbitPitch),
    Math.sin(orbitPitch),
    Math.cos(orbitYaw) * Math.cos(orbitPitch),
  ).normalize();

  if (firstPerson && modelReady) {
    avatar.eyeWorld(_eye);
    camera.position.copy(_eye).addScaledVector(_forward, EYE_AHEAD);
    _look.copy(camera.position).addScaledVector(_forward, 6);
  } else {
    camera.position.set(0, ORBIT_HEIGHT, 0).addScaledVector(_forward, -ORBIT_DISTANCE);
    _look.set(0, 1.7, 0);
  }
  camera.lookAt(_look);
  camera.updateMatrixWorld(true);
}

// ─── Tracking ─────────────────────────────────────────────────────────────────

let running = false;
let tracking = false;
let status = 'idle';
const curls = { left: {}, right: {} };
const readout = { left: null, right: null };

const _handTarget = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camBack = new THREE.Vector3();
const _along = { left: new THREE.Vector3(), right: new THREE.Vector3() };
const _across = { left: new THREE.Vector3(), right: new THREE.Vector3() };

/** Straight through the one camera, at a fixed depth. */
function handTarget(tip) {
  _handTarget.set(tip.x * 2 - 1, -(tip.y * 2 - 1), 0.5).unproject(camera);
  return _handTarget.sub(camera.position).normalize()
    .multiplyScalar(HAND_DEPTH).add(camera.position);
}

// Same mirror correction the duel makes, and for the same reason: tracker.js
// un-mirrors x for position, which flips the chirality of the cloud, and a palm
// frame is chirality-sensitive where a position is not.
const PALM_HANDEDNESS = -1;

function trackedDirection(v, out) {
  camera.matrixWorld.extractBasis(_camRight, _camUp, _camBack);
  return out.set(0, 0, 0)
    .addScaledVector(_camRight, v.x * PALM_HANDEDNESS)
    .addScaledVector(_camUp, -v.y)
    .addScaledVector(_camBack, -v.z)
    .normalize();
}

function driveBody(frame) {
  const hands = frame.hands ?? [];
  const drawing = hands.length === 2 ? hands[1] : hands[0] ?? null;

  avatar.reach(
    frame.tracked && drawing ? handTarget(drawing.tip ?? frame.tip) : null,
    0,
    false,
    frame.pose?.right ? elbowTarget(frame.pose.right) : null,
  );

  for (const side of ['left', 'right']) {
    const hand = hands.find(h => h.side === side)
      ?? (hands.length === 1 && hands[0].side === null && side === 'right' ? hands[0] : null);
    if (!hand) {
      avatar.fingers(side, null);
      avatar.palm(side, null, null);
      readout[side] = null;
      continue;
    }
    const curl = fingerCurls(hand.landmarks, curls[side]);
    avatar.fingers(side, curl);

    const basis = palmBasis(hand.landmarks);
    if (basis) {
      avatar.palm(
        side,
        trackedDirection(basis.along, _along[side]),
        trackedDirection(basis.across, _across[side]),
      );
    } else {
      avatar.palm(side, null, null);
    }
    readout[side] = { curl: { ...curl }, palm: Boolean(basis) };
  }
}

const _elbow = new THREE.Vector3();
function elbowTarget(arm) {
  if (!arm?.elbow) return null;
  _elbow.set(arm.elbow.x * 2 - 1, -(arm.elbow.y * 2 - 1), 0.5).unproject(camera);
  return _elbow.sub(camera.position).normalize()
    .multiplyScalar(HAND_DEPTH).add(camera.position);
}

// ─── Readout ──────────────────────────────────────────────────────────────────

function bar(x, y, width, value, colour) {
  ctx.fillStyle = '#1d2436';
  ctx.fillRect(x, y, width, 6);
  ctx.fillStyle = colour;
  ctx.fillRect(x, y, width * Math.max(0, Math.min(1, value)), 6);
}

function drawReadout(frame) {
  const w = innerWidth;
  const h = innerHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px "IBM Plex Mono", monospace';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = frame.tracked ? GOLD : DIM;
  ctx.fillText(frame.tracked ? `TRACKING · ${(frame.hands ?? []).length} HAND(S)` : 'NO HANDS', 24, 34);
  // Two rates, and the second is the one that decides whether this looks smooth.
  // The renderer can sit at 120 while the body steps, because the body only
  // moves when a detection lands.
  ctx.fillStyle = DIM;
  ctx.fillText(`${Math.round(rate.fps)} fps drawn`, 24, 52);
  ctx.fillStyle = rate.hz >= 24 ? GOLD : rate.hz >= 14 ? BLUE : RED;
  ctx.fillText(`${rate.hz.toFixed(1)} Hz tracked  <- smoothness lives here`, 24, 70);
  ctx.fillStyle = DIM;
  ctx.fillText(`B · body model ${bodyTracking() ? 'ON' : 'off'}`, 24, 88);
  ctx.fillText(firstPerson ? 'V · FIRST PERSON' : 'V · ORBIT — drag to turn', 24, 106);

  let y = 142;
  for (const side of ['right', 'left']) {
    ctx.fillStyle = readout[side] ? BLUE : DIM;
    ctx.fillText(`${side.toUpperCase()} HAND${readout[side] ? '' : ' — not seen'}`, 24, y);
    y += 16;
    if (readout[side]) {
      for (const finger of FINGERS) {
        const value = readout[side].curl[finger] ?? 0;
        ctx.fillStyle = DIM;
        ctx.fillText(finger.padEnd(7), 24, y + 6);
        bar(94, y, 120, value, value > 0.02 ? GOLD : '#3a4560');
        ctx.fillStyle = DIM;
        ctx.fillText(value.toFixed(2), 224, y + 6);
        y += 14;
      }
      ctx.fillStyle = readout[side].palm ? BLUE : RED;
      ctx.fillText(`palm ${readout[side].palm ? 'locked' : 'lost'}`, 24, y + 6);
      y += 24;
    } else {
      y += 12;
    }
  }

  if (status !== 'idle') {
    ctx.fillStyle = RED;
    ctx.fillText(status, 24, h - 28);
  }
}

// ─── Loop ─────────────────────────────────────────────────────────────────────

function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  overlay.width = w;
  overlay.height = h;
}
addEventListener('resize', resize);
resize();

let last = performance.now();

// Counted over a window, not taken as 1/dt. Instantaneous 1/dt reported 755 fps
// on a display that cannot show more than 120: two callbacks landing a
// millisecond apart is not a frame rate, it is a scheduling artefact, and
// averaging it hides exactly the stall that makes motion look stepped.
const rate = { frames: 0, detections: 0, since: performance.now(), fps: 0, hz: 0 };

function sampleRates(now, frame) {
  rate.frames++;
  const elapsed = now - rate.since;
  if (elapsed < 500) return;
  rate.fps = (rate.frames * 1000) / elapsed;
  rate.hz = ((frame.detections - rate.detections) * 1000) / elapsed;
  rate.detections = frame.detections;
  rate.frames = 0;
  rate.since = now;
}
function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  updateCamera();
  const frame = getFrame();
  sampleRates(now, frame);
  if (tracking) driveBody(frame);
  avatar.update(dt);
  // The camera reads the eye, which the update above just moved.
  updateCamera();

  renderer.render(scene, camera);
  drawReadout(frame);
}

addEventListener('keydown', event => {
  if (event.repeat) return;
  if (event.code === 'KeyV') firstPerson = !firstPerson;
  if (event.code === 'KeyB') setBodyTracking(!bodyTracking());
});
glCanvas.addEventListener('click', () => glCanvas.requestPointerLock());
addEventListener('mousemove', event => {
  if (document.pointerLockElement !== glCanvas) return;
  orbitYaw -= event.movementX * 0.0028;
  orbitPitch = Math.max(-0.7, Math.min(0.6, orbitPitch - event.movementY * 0.002));
});

startButton.addEventListener('click', async () => {
  startButton.disabled = true;
  errorLine.hidden = true;
  try {
    await initTracker(video, stage => { status = stage; });
    tracking = true;
    status = 'idle';
  } catch (error) {
    errorLine.textContent = `${error.message} — the mirror still runs, with nothing to copy.`;
    errorLine.hidden = false;
    status = 'no camera';
  }
  startPanel.hidden = true;
  running = true;
  last = performance.now();
  loop();
});

addEventListener('beforeunload', () => {
  running = false;
  disposeTracker();
  avatar.dispose();
});
