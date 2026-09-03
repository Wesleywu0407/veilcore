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
import {
  initTracker, getFrame, disposeTracker, setBodyTracking, bodyTracking,
  levelHead, setHeadLevel,
} from './spell-room/tracker.js';

let trackerOn = true;
import { fingerCurls, palmBasis, FINGERS } from './spell-room/fingers.js';
import { createBodyMap, anchorOf, ARM_IN_SPANS } from './spell-room/body-map.js';
import { drawFace } from './spell-room/draw-face.js';
import { loadGLB } from './arena/asset-library.js';

const GOLD = '#ffd98a';
const BLUE = '#8ab4ff';
const DIM = '#7f899f';
const RED = '#ff9c82';

const DUELIST_URL = 'assets/models/arena/sealed-porcelain-duelist-fingers.glb';

// ── No clips, on purpose ──
//
// The duel loads four, and its idle shifts the weight, swings the free arm and
// turns the torso the whole time. In the duel that reads as a body that is
// alive. In a mirror it is the opposite of the point: nearly everything moving
// on screen is then something the player is NOT doing, and there is no way to
// tell a tracking fault from the animation underneath it.
//
// With no clips duelist.js never builds a mixer, so the body holds its bind
// pose and the only things that move are the ones being tracked. The arm IK,
// the finger chains and the palm rig are all built before the clip block, so
// none of them are lost by leaving it empty.
const DUELIST_CLIPS = [];

// How far in front of the lens the hand is placed. The duel uses 1.47 against a
// camera parked behind the shoulder; here the camera is the eye itself, so this
// is a real arm's reach from a real eye and nothing cancels out.
// Where a tracked hand goes is duelist.js's business now -- see reachBox().
// It was briefly done here, off the viewing camera, which meant the hand sat in
// the air between you and the reflection and swung round every time the orbit
// moved. Then it was done here off the body, which fixed that but sized the box
// from the character's HEIGHT: the far corners came out at twice the arm's
// length, so most of the picture mapped somewhere the hand could not go and
// only the middle of the frame still moved anything.
const EYE_AHEAD = 0.30;    // clears the porcelain helm, same as the duel

// ── A lens wide enough to hold both hands ──
//
// The orbit's 52 degrees is a portrait lens, and in first person it framed a
// single palm and nothing else. Hands live at most REACH_BOX.across (0.62 of an
// arm) out from each shoulder and REACH_BOX.forward ahead, so the half-angle to
// the far one is atan(across / forward). At 52 degrees vertical that angle is
// outside the frustum however close the eye sits -- there is no distance at
// which both hands are in shot, which is why moving the eye never helped.
//
// 75 is the ordinary first-person figure, and it is chosen against the box, not
// by eye: it opens the horizontal half-angle past 50 degrees, and the reach box
// was widened to 0.50 forward at the same time to bring the far hand inside it.
const ORBIT_FOV = 52;
const FIRST_PERSON_FOV = 75;
// The duel runs this same formulation with the same height, look and lens, and
// only a longer distance (5.5) -- close enough is a matter of what else has to
// be in shot, and there the other duelist does. See _chasePos in js/arena.js.
const ORBIT_DISTANCE = 3.6;
const ORBIT_HEIGHT = 2.4;

const glCanvas = document.querySelector('[data-mirror-gl]');
const overlay = document.querySelector('[data-mirror-overlay]');
const video = document.querySelector('[data-mirror-video]');
const scan = document.querySelector('[data-mirror-scan]');
const scanCtx = scan.getContext('2d');
const startPanel = document.querySelector('[data-mirror-start]');
const startButton = document.querySelector('[data-mirror-enter]');
const errorLine = document.querySelector('[data-mirror-error]');
const ctx = overlay.getContext('2d');

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
// ── The fill-rate test ──
//
// Tracking turned out not to be the constraint: with it off entirely the frame
// rate does not move. So the next question is whether the renderer is limited
// by how many PIXELS it fills, and that has a signature -- fill-rate cost
// scales with resolution, a throttled machine does not. Halve this and if the
// frame rate roughly doubles it is fill rate; if it barely moves the limit is
// elsewhere and no amount of resolution work will help.
const PIXEL_STEPS = [1.5, 1.0, 0.75, 0.5];
let pixelStep = 0;
renderer.setPixelRatio(Math.min(devicePixelRatio, PIXEL_STEPS[pixelStep]));
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

const camera = new THREE.PerspectiveCamera(ORBIT_FOV, 1, 0.05, 200);

const avatar = createDuelist(scene, { colour: 0xffd98a, name: 'Mirror', castShadow: false });
avatar.setPosition(new THREE.Vector3(0, 0, 0));

let modelReady = false;
(async () => {
  try {
    const [{ clone }, gltf] = await Promise.all([
      import('three/addons/utils/SkeletonUtils.js'),
      loadGLB(DUELIST_URL),
    ]);
    // Not gltf.animations either: the model carries its own clip, and handing
    // that over would put the body right back on an animation.
    avatar.replaceVisual(clone(gltf.scene), []);
    modelReady = true;
  } catch (error) {
    status = `model: ${error.message}`;
  }
})();

// ─── Camera ───────────────────────────────────────────────────────────────────

// First person on the way in. The mirror's whole claim is that the body is
// yours, and that reads at once from behind your own eyes and takes a moment to
// read from across the room. V still swaps, and orbit is still where you go to
// check what the tracking is actually doing to the rest of the body.
let firstPerson = true;
// Start BEHIND the character, over its shoulder, because that is the view the
// tracking is true in: standing behind someone, their right hand is on your
// right. Facing them it is on your left, and a body that copies you same-side
// then reads as reversed no matter how correct the bones underneath it are.
let orbitYaw = 0;
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

  const fov = firstPerson ? FIRST_PERSON_FOV : ORBIT_FOV;
  if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }

  // In first person the lens is the eye, so it turns with the head. `looking`
  // is the EASED angle the body actually settled on, not the raw target -- read
  // the target and the view would arrive somewhere the head has not got to yet.
  // Drag still works, and adds on top: the head aims, the mouse re-centres.
  if (firstPerson && modelReady) {
    const pitch = orbitPitch + avatar.lookingUp;
    _forward.set(
      Math.sin(orbitYaw + avatar.looking) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(orbitYaw + avatar.looking) * Math.cos(pitch),
    ).normalize();
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

// The one implementation of "where does this hand go", shared with the duel.
const body = createBodyMap(avatar);

let running = false;
let tracking = false;
let status = 'idle';
const curls = { left: {}, right: {} };
const readout = { left: null, right: null };

// How the sides were decided this frame, in words. Every round of this bug --
// the arm on the wrong side, the elbow that never arrived, the body model that
// never loaded -- cost a screenshot and a guess, because the panel showed WHAT
// the tracking did and never WHY. This is the why.
let placement = null;

const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camBack = new THREE.Vector3();
const _along = { left: new THREE.Vector3(), right: new THREE.Vector3() };
const _across = { left: new THREE.Vector3(), right: new THREE.Vector3() };

// The whole tracked body, in one call, from the module the duel uses too.
// This used to be a hundred lines here; keeping a second copy in step with the
// duel's was never going to work, and did not.
function driveBody(frame) {
  const seen = body.drive(frame);
  placement = seen.placement;
  readout.left = seen.readout.left;
  readout.right = seen.readout.right;
}


// ─── Readout ──────────────────────────────────────────────────────────────────

function bar(x, y, width, value, colour) {
  ctx.fillStyle = '#1d2436';
  ctx.fillRect(x, y, width, 6);
  ctx.fillStyle = colour;
  ctx.fillRect(x, y, width * Math.max(0, Math.min(1, value)), 6);
}

// ── The readout is text, and text does not need sixty frames a second ──
//
// It was redrawn every frame: clearRect over the whole window, then fillText,
// then the browser composites that full-window 2D canvas over the WebGL one.
// That cost is fixed -- it does not fall when the WebGL pixel ratio drops, it
// does not care whether the tracker is running, and it does not change when the
// machine is plugged in. Which is exactly the shape of the frame rate that was
// left over once all three of those were ruled out.
//
// Six times a second is faster than anyone reads a number.
const READOUT_HZ = 6;
let readoutAt = 0;
let readoutOn = true;

function maybeDrawReadout(frame, now) {
  if (!readoutOn) return;
  if (now - readoutAt < 1000 / READOUT_HZ) return;
  readoutAt = now;
  drawReadout(frame);
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
  // What the tracker still costs this thread. Inference is in a worker now, so
  // if this is small AND the frame rate is still low, the tracker is not what
  // is holding it -- and the next suspect is the GPU the two of them share.
  ctx.fillStyle = frame.decodeMs > 4 ? RED : DIM;
  ctx.fillText(`${frame.decodeMs.toFixed(2)} ms decode on this thread`, 24, 88);
  ctx.fillStyle = DIM;
  ctx.fillText(`B · body model ${bodyTracking() ? 'ON' : 'off'}   T · tracking ${trackerOn ? 'ON' : 'off'}`, 24, 106);
  ctx.fillText(firstPerson ? 'V · FIRST PERSON' : 'V · ORBIT — drag to turn', 24, 124);
  if (recording) {
    const left = RECORD_SECONDS - (performance.now() - recording.started) / 1000;
    ctx.fillStyle = RED;
    ctx.fillText(`R · RECORDING — ${Math.max(0, left).toFixed(1)}s, ${recording.frames.length} frames`, 260, 124);
    ctx.fillStyle = DIM;
  } else {
    ctx.fillText('R · record 8s of landmarks   C · camera', 260, 124);
  }
  {
    // What scale the arm is being mapped through, so a wrong one is visible on
    // screen rather than felt as "the arm goes too far" with no cause attached.
    // Already in shoulder widths -- no dividing here. Dividing a stored length
    // by the live shoulders is what let this print 1.89 against a 1.85 bound.
    const rig = body.arm;
    const inForce = rig.settled ? rig.widths : Math.max(rig.widths, ARM_IN_SPANS);
    ctx.fillText(
      rig.settled
        ? `arm — ${inForce.toFixed(2)} shoulder widths, LOCKED`
        : `arm — ${inForce.toFixed(2)} shoulder widths, default`
          + (rig.widths > ARM_IN_SPANS ? ' + seen' : ''),
      440, 160);
  }
  const deg = r => (r * 180 / Math.PI).toFixed(0);
  if (!frame.head) {
    ctx.fillText('head — no face in shot', 24, 142);
  } else if (!frame.head.levelled) {
    ctx.fillStyle = RED;
    ctx.fillText(`head — turn ${deg(frame.head.yaw)}°  ·  L · look level to set pitch`, 24, 142);
    ctx.fillStyle = DIM;
  } else {
    ctx.fillText(`head — turn ${deg(frame.head.yaw)}°  lift ${deg(frame.head.pitch)}°  ·  L · re-level`, 24, 142);
  }
  if (placement) {
    ctx.fillStyle = /waiting|guessing/.test(placement) ? RED : DIM;
    ctx.fillText(placement, 24, 178);
    ctx.fillStyle = DIM;
  }

  // What is actually being drawn, so the frame rate has something to be read
  // against rather than being a bare number.
  const info = renderer.info.render;
  const px = renderer.domElement.width * renderer.domElement.height;
  ctx.fillText(
    `P · ${renderer.getPixelRatio().toFixed(2)}x — ${(px / 1e6).toFixed(2)} Mpx · `
    + `${info.calls} draws · ${(info.triangles / 1000).toFixed(1)}k tris`,
    24, 160);

  let y = 194;
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
  recordFrame(frame, now);
  drawScan(frame);
  maybeDrawReadout(frame, now);
}

// ─── Recording what the tracker actually said ─────────────────────────────────
//
// Every round of this has been: a screenshot, a guess, a fix, another
// screenshot. A screenshot shows the RESULT and never the numbers behind it,
// and "the hand suddenly flew off" is a thing that happens in three frames --
// which is exactly the window a screenshot cannot hold.
//
// A video of the player would not help either: the landmarks are what the maths
// runs on, and getting from video back to landmarks means running MediaPipe
// again somewhere it cannot run.
//
// So record the landmarks. R starts it, it stops on its own, and it saves a
// file that can be replayed through the same arithmetic offline -- where a jump
// is a number that changed by too much between two frames, and is findable in
// seconds rather than in another round of screenshots.
const RECORD_SECONDS = 8;
let recording = null;

function startRecording() {
  recording = { started: performance.now(), frames: [] };
}

const trim = p => (p ? { x: +p.x.toFixed(5), y: +p.y.toFixed(5) } : null);

function recordFrame(frame, now) {
  if (!recording) return;
  if (now - recording.started > RECORD_SECONDS * 1000) {
    saveRecording();
    return;
  }
  const arm = side => {
    const a = frame.pose?.[side];
    return a ? { shoulder: trim(a.shoulder), elbow: trim(a.elbow), wrist: trim(a.wrist) } : null;
  };
  recording.frames.push({
    t: Math.round(now - recording.started),
    tracked: frame.tracked,
    stale: frame.stale,
    hz: +rate.hz.toFixed(1),
    hands: (frame.hands ?? []).map(h => ({
      side: h.side, bodySide: h.bodySide ?? null,
      wrist: trim(h.wrist), anchor: trim(h.anchor), tip: trim(h.tip),
    })),
    pose: frame.pose ? { left: arm('left'), right: arm('right') } : null,
    head: frame.head
      ? { yaw: +frame.head.yaw.toFixed(4), pitch: +frame.head.pitch.toFixed(4),
          lift: +frame.head.lift.toFixed(4), levelled: frame.head.levelled }
      : null,
    placement,
  });
}

function saveRecording() {
  const blob = new Blob([JSON.stringify(recording, null, 1)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `veilcore-tracking-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  recording = null;
}

// ─── The camera, shown ────────────────────────────────────────────────────────
//
// The video element was a 1x1 transparent pixel: enough to feed the tracker,
// useless to the person being tracked. Every question this session -- is the
// hand lost, or mapped wrong? is that my left, or does it think so? -- needed
// to see what the lens saw, and the only way to get it was a screenshot of the
// character and a guess about the cause.
//
// The landmarks are drawn over it in the lens's own coordinates, so a point
// that is wrong is wrong where you can see it. Both are mirrored in CSS,
// because a preview of yourself that is not mirrored is unusable.
let showCamera = true;

const HAND_LINKS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],
  [10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];

function drawScan(frame) {
  // The video is TUCKED, never hidden: see the note on .is-tucked. The canvas
  // over it has no such constraint and can go away properly.
  video.classList.toggle('is-tucked', !showCamera);
  scan.hidden = !showCamera;
  if (!showCamera || !video.videoWidth) return;
  const w = video.clientWidth || 260;
  const h = Math.round(w * video.videoHeight / video.videoWidth);
  if (scan.width !== w || scan.height !== h) { scan.width = w; scan.height = h; }
  scan.style.height = `${h}px`;
  scanCtx.clearRect(0, 0, w, h);

  // The tracker un-mirrors x on the way in; the preview is mirrored back by
  // CSS. So these go on flipped, which lands them over the real thing.
  const at = p => [(1 - p.x) * w, p.y * h];

  for (const hand of frame.hands ?? []) {
    const marks = hand.landmarks;
    if (!marks) continue;
    scanCtx.strokeStyle = hand.side === 'left' ? '#8cc9ff' : GOLD;
    scanCtx.lineWidth = 1.5;
    scanCtx.beginPath();
    for (const [a, b] of HAND_LINKS) {
      if (!marks[a] || !marks[b]) continue;
      scanCtx.moveTo(...at(marks[a]));
      scanCtx.lineTo(...at(marks[b]));
    }
    scanCtx.stroke();
    if (hand.anchor) {
      scanCtx.fillStyle = '#fff';
      scanCtx.beginPath();
      scanCtx.arc(...at(hand.anchor), 3.5, 0, Math.PI * 2);
      scanCtx.fill();
    }
  }

  // The face the tracker is reading. Shared with the duel's panel, so the two
  // cannot answer "is it seeing my face" differently. See draw-face.js.
  if (!drawFace(scanCtx, frame.head, at, { live: GOLD, cold: RED }) && showCamera) {
    scanCtx.font = '10px "IBM Plex Mono", monospace';
    scanCtx.fillText('no face', 6, 14);
  }

  const pose = frame.pose;
  if (pose) {
    scanCtx.strokeStyle = '#6f7fa8';
    scanCtx.lineWidth = 2;
    for (const side of ['left', 'right']) {
      const arm = pose[side];
      if (!arm?.shoulder) continue;
      scanCtx.beginPath();
      scanCtx.moveTo(...at(arm.shoulder));
      if (arm.elbow) scanCtx.lineTo(...at(arm.elbow));
      if (arm.wrist) scanCtx.lineTo(...at(arm.wrist));
      scanCtx.stroke();
      scanCtx.fillStyle = '#9fb2dd';
      scanCtx.beginPath();
      scanCtx.arc(...at(arm.shoulder), 3, 0, Math.PI * 2);
      scanCtx.fill();
    }
  }

  if (frame.head) {
    scanCtx.fillStyle = frame.head.levelled ? GOLD : RED;
    scanCtx.font = '10px "IBM Plex Mono", monospace';
    scanCtx.save();
    scanCtx.scale(-1, 1);        // undo the CSS mirror, or the text reads backwards
    scanCtx.fillText(`${(frame.head.yaw * 180 / Math.PI).toFixed(0)}°`, -w + 6, 14);
    scanCtx.restore();
  }
}

// Where this face's level lives between sessions, so it is asked for once.
// Versioned, because a stored level only means anything against the `lift` that
// produced it. lift used to be the nose alone and is now the nose averaged with
// both eyes, so every level saved before that is a number about a different
// measurement -- and a stale calibration is worse than none, since it is wrong
// silently and the fix (press L) is not obvious to anyone who does not know it
// went stale. Bump this whenever readHead's lift changes.
const LEVEL_KEY = 'veilcore.headLevel.v2';
try {
  const stored = Number(localStorage.getItem(LEVEL_KEY));
  if (Number.isFinite(stored) && stored !== 0) setHeadLevel(stored);
} catch { /* private window, or storage refused: level again this session */ }

addEventListener('keydown', event => {
  if (event.repeat) return;
  if (event.code === 'KeyV') firstPerson = !firstPerson;
  if (event.code === 'KeyR' && !recording) startRecording();
  if (event.code === 'KeyC') showCamera = !showCamera;
  if (event.code === 'KeyL') {
    const rest = levelHead();
    if (rest !== null) {
      try { localStorage.setItem(LEVEL_KEY, String(rest)); } catch { /* not fatal */ }
    }
  }
  if (event.code === 'KeyB') setBodyTracking(!bodyTracking());
  // The comparison that was never actually made: what does this scene render at
  // with NO tracking at all? Everything so far has assumed the tracker was what
  // held it down, and that assumption has never been tested on its own.
  // The A/B for the paragraph above: with the overlay gone entirely, does the
  // frame rate move? If it does not, the compositing was never the cost either.
  if (event.code === 'KeyO') {
    readoutOn = !readoutOn;
    if (!readoutOn) ctx.clearRect(0, 0, overlay.width, overlay.height);
  }
  if (event.code === 'KeyP') {
    pixelStep = (pixelStep + 1) % PIXEL_STEPS.length;
    renderer.setPixelRatio(Math.min(devicePixelRatio, PIXEL_STEPS[pixelStep]));
    resize();
  }
  if (event.code === 'KeyT') {
    trackerOn = !trackerOn;
    if (!trackerOn) disposeTracker();
  }
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
