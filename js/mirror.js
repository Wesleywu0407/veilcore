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
import { shoulderSpan } from './spell-room/pose.js';
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

const _handTarget = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _camBack = new THREE.Vector3();
const _along = { left: new THREE.Vector3(), right: new THREE.Vector3() };
const _across = { left: new THREE.Vector3(), right: new THREE.Vector3() };

// An arm, measured in shoulder widths. Roughly 1.5 on a person; it is only ever
// used to turn a distance in the picture into a fraction of THIS arm, so it can
// be a constant rather than something else to track.
const ARM_IN_SPANS = 1.55;

/**
 * Where the hand goes: an offset from the player's own shoulder, in arm
 * lengths, rather than a place in the picture.
 *
 * `at` is the hand's smoothed WRIST, not its fingertip: the IK solves for the
 * wrist bone, and hanging the arm off a fingertip both overreached it by a
 * hand's length and turned every finger curl into a shoulder movement.
 *
 * The depth is what is left over. The picture gives two components of a
 * direction and cannot give the third, so take it as the rest of a unit vector:
 * a hand near your shoulder in the picture is one reaching TOWARD the lens, and
 * an arm stretched straight out to the side has no forward in it at all. A
 * fixed forward push -- what the box did -- is wrong at both ends, and at the
 * far end it pushed the target past armReach and clamped.
 *
 * Falls back to the box when there is no body: still absolute, still drifts,
 * but an arm that drifts beats an arm that does not move.
 */
// ── The last shoulder each arm was measured against ──
//
// frame.pose goes null the instant the body model misses a sample -- the body
// leaves shot, an arm crosses the torso, a shoulder drops under the visibility
// floor -- and it is sampled at a third of the hands' rate to begin with.
//
// Falling back to reachBox() there is not a smaller version of the same answer,
// it is a DIFFERENT MAPPING: one measures from your shoulder, the other from
// the middle of the picture. Swapping between them mid-gesture moves the hand
// by however far your shoulder happens to be from centre, in one frame. That is
// the hand suddenly flying off -- not drift, a cut.
//
// A shoulder that is one sample old is a perfectly good shoulder. Hold it.
const lastAnchor = { left: null, right: null };

function handTarget(side, at, pose) {
  const shoulder = pose?.[side]?.shoulder;
  const scale = shoulderSpan(pose) * ARM_IN_SPANS;
  if (shoulder && scale) lastAnchor[side] = { x: shoulder.x, y: shoulder.y, scale };
  const held = lastAnchor[side];
  // Only the very first frames, before any body has ever been seen, take the
  // box -- and from there it is one-way, so there is nothing to jump between.
  if (!held) return avatar.reachBox(side, 1 - at.x, at.y, _handTarget);

  // Raw picture offset, shoulder to hand. Both x's un-flip, and the two `1 -`
  // cancel into the subtraction the other way round.
  const dx = (held.x - at.x) / held.scale;
  const dy = -(at.y - held.y) / held.scale;
  const flat = Math.hypot(dx, dy);
  const dz = flat >= 1 ? 0 : Math.sqrt(1 - flat * flat) * REACH_DEPTH;
  return avatar.reachOffset(side, dx, dy, dz, _handTarget);
}

// How much of the leftover length to spend on depth. Not 1: a hand held at
// shoulder height in front of you is not at full stretch toward the lens.
const REACH_DEPTH = 0.85;

/** The point an arm follows. Falls back to the tip if a hand predates anchors. */
const anchorOf = hand => hand.anchor ?? hand.tip;

// A scratch for turning a body-space direction into a world one.
const _origin = new THREE.Vector3();

// ── The tracker hands out a MIRROR WORLD, and a mirror world has no chirality ──
//
// tracker.js flips x (`1 - x`) on every landmark, so a hand held out to the
// player's right arrives on the right of the picture. That is the selfie
// convention, and it is the right one for something you look AT. It is also a
// reflection: a reflected right hand is congruent to a LEFT hand, so every
// basis built from those landmarks comes out inside out. The -1 the duel
// carries in PALM_HANDEDNESS is what has been paying that bill.
//
// This is not a mirror in that sense. The character is the player seen from
// BEHIND -- raise your right hand and its right hand goes up -- so the map from
// the one body to the other is the identity, and the flip is pure damage. Undo
// it once, here at the door, and everything below reads a faithful room.
//
// Points un-flip as `1 - x`; directions would un-flip as `-x`. Only points are
// un-flipped, and palmBasis() derives its directions from those, so the file
// has one rule to keep straight instead of two.
const _raw = [];
function unflip(landmarks) {
  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    const q = (_raw[i] ??= { x: 0, y: 0, z: 0 });
    q.x = 1 - p.x; q.y = p.y; q.z = p.z;
  }
  _raw.length = landmarks.length;
  return _raw;
}

/**
 * A direction in the raw picture, pointed the same way in the BODY's space.
 *
 * It used to go through the viewing camera, which was left over from before the
 * hand target moved into body space -- so the palm turned when you orbited and
 * the hand did not. Two halves of one gesture in two different frames.
 *
 * The mapping, from un-flipped camera space to the duelist's local axes:
 *
 *   raw +x  the camera's right -> the player's LEFT, so the body's,  local +X
 *   raw +y  down the picture   -> down the body,                     local -Y
 *   raw +z  away from the lens -> behind the player, so the body's,  local -Z
 *
 * Note the determinant: (+1)(-1)(-1) = +1. It is a ROTATION, which is the whole
 * point: a det -1 map turns palmBasis's right-handed triple into a left-handed
 * one, and the rotation pulled out of that is not a rotation of anything real.
 *
 * With the tracker's FLIPPED x, the signs that point the same physical way are
 * (-1)(-1)(-1) = -1. That is the reflection, and it is why the palm kept
 * arriving upside down: not one sign to hunt for, a whole flipped room.
 */
function trackedDirection(v, out) {
  out.set(v.x, -v.y, -v.z).normalize();
  return avatar.root.localToWorld(out).sub(avatar.root.getWorldPosition(_origin));
}

function driveBody(frame) {
  const hands = frame.hands ?? [];
  // A held shoulder is only good while it is still YOUR shoulder. Once the
  // hands are gone the body may be somewhere else entirely by the time they
  // come back, so the hold ends with them rather than outliving them.
  if (!frame.tracked) { lastAnchor.left = lastAnchor.right = null; }
  // A lone hand arrives with its real side on it: the body model places it, and
  // a latch holds that answer between body samples. See sideOfWrist().
  //
  // Guess ONLY when there is no body model to ask at all. It used to guess on
  // every null, which is why raising your left arm moved the character's right
  // -- null was the only answer a lone hand ever got. With a body loaded the
  // side lands within a sample or two, and holding both arms still for those
  // two frames is far better than moving the wrong one and snapping across.
  // `bodySide` when the body could tell, `side` (sorted by x) when it could
  // not. Crossing your arms swaps the x order and nothing else, so a mirror
  // that only reads `side` hands each arm to the other one the moment you fold
  // them -- an ordinary thing to do, and it looked like the handedness bug
  // coming back.
  const sideOf = hand => hand.bodySide ?? hand.side;
  const mayGuess = !bodyTracking();
  const unplaced = hands.length === 1 && sideOf(hands[0]) === null;
  if (unplaced && !mayGuess) {
    // The body has not named this hand yet. Do nothing at all -- not even pass
    // null to reach(), which RELEASES an arm rather than holding it, dropping
    // it to rest for the ~150ms the body model takes to answer and then hauling
    // it back up. Returning leaves every target exactly where it was, which is
    // what "not yet" ought to look like.
    placement = 'one hand — waiting for the body to place it';
    // The head is not waiting on anything: it reads the face, not the hands.
    avatar.look(frame.tracked ? frame.head?.yaw : null, frame.head?.pitch ?? 0);
    return;
  }
  const lone = unplaced ? hands[0] : null;
  const right = hands.find(h => sideOf(h) === 'right') ?? lone;
  const left = hands.find(h => sideOf(h) === 'left') ?? null;
  placement = hands.length === 0 ? null
    : hands.length === 2
      ? (hands[0].bodySide
        ? `both hands — body says ${hands[0].bodySide === 'right' ? 'CROSSED' : 'not crossed'}`
        : 'both hands — sides by x, no body answer')
    : unplaced ? 'one hand — guessing right, no body model'
    : `one hand — body says ${sideOf(hands[0])}`;

  // Both arms, because a mirror with one live arm and one hanging is not a
  // mirror. The duel drives only the right; there the left is always holding
  // something.
  // Same side throughout: reach() drives the duelist's RIGHT arm, and the
  // player's RIGHT hand is what feeds it.
  avatar.reach(
    frame.tracked && right ? handTarget('right', anchorOf(right), frame.pose) : null,
    0,
    false,
    frame.pose?.right ? elbowTarget('right', frame.pose.right) : null,
  );
  avatar.reachLeft(
    frame.tracked && left ? handTarget('left', anchorOf(left), frame.pose) : null,
    frame.pose?.left ? elbowTarget('left', frame.pose.left) : null,
  );

  // The head turns with you. Null hands it back and it eases home, which is
  // what should happen when the face leaves shot rather than the head staying
  // craned wherever the last readable frame left it.
  avatar.look(frame.tracked ? frame.head?.yaw : null, frame.head?.pitch ?? 0);

  for (const side of ['left', 'right']) {
    // The same two the arms were driven from, not a second lookup with its own
    // copy of the rules: fingers on one hand and the arm on the other is a bug
    // this file has room for exactly once.
    const hand = side === 'right' ? right : left;
    if (!hand) {
      avatar.fingers(side, null);
      avatar.palm(side, null, null);
      readout[side] = null;
      continue;
    }
    const raw = unflip(hand.landmarks);
    const curl = fingerCurls(raw, curls[side]);
    avatar.fingers(side, curl);

    const basis = palmBasis(raw);
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
/**
 * Where the elbow wants to be, as a point the solver reads a DIRECTION from.
 *
 * Not the elbow's own place in the picture, and not through reachBox() -- see
 * elbowHint() for why both of those put the elbow in front of the wrist. What
 * goes across is the OFFSET from the tracked shoulder, which is the one thing
 * the body model is genuinely good at: it drops depth constantly, but which way
 * an elbow leans is exactly what it can see.
 */
function elbowTarget(side, arm) {
  if (!arm?.elbow || !arm?.shoulder) return null;
  // The offset from the tracked shoulder, in raw picture coordinates: both x's
  // un-flip, and the two `1 -` cancel into a subtraction the other way round.
  return avatar.elbowHint(
    side,
    arm.shoulder.x - arm.elbow.x,
    arm.elbow.y - arm.shoulder.y,
    _elbow,
  );
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
    const learned = armSpan.right.value;
    const shoulders = shoulderSpan(frame.pose);
    ctx.fillText(
      learned && shoulders
        ? `arm — ${(learned / shoulders).toFixed(2)} shoulder widths, learned`
        : `arm — ${ARM_IN_SPANS} shoulder widths, assumed`,
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

  // ── The face, drawn, because otherwise there is no way to know ──
  //
  // The hands have had a skeleton on this panel from the start and the face has
  // had nothing, so "is it even seeing my face?" was unanswerable from the
  // screen -- which is exactly the question to be able to answer before judging
  // anything the head does.
  const head = frame.head;
  if (head?.points) {
    const { nose, leftEar, rightEar, eyes } = head.points;
    scanCtx.strokeStyle = head.levelled ? GOLD : RED;
    scanCtx.lineWidth = 1.5;
    // The ear line: the reference pitch is measured against.
    scanCtx.beginPath();
    scanCtx.moveTo(...at(leftEar));
    scanCtx.lineTo(...at(rightEar));
    scanCtx.stroke();
    // And the front of the face, which is what moves against it.
    scanCtx.fillStyle = head.levelled ? GOLD : RED;
    for (const p of [nose, ...(eyes ?? [])]) {
      scanCtx.beginPath();
      scanCtx.arc(...at(p), 2.5, 0, Math.PI * 2);
      scanCtx.fill();
    }
    // Where the head is pointed, as a line off the nose -- so a turn is visible
    // as a turn rather than as a number somewhere else on the screen.
    const [nx, ny] = at(nose);
    scanCtx.beginPath();
    scanCtx.moveTo(nx, ny);
    scanCtx.lineTo(nx + Math.sin(-head.yaw) * 26, ny - Math.sin(head.pitch) * 26);
    scanCtx.stroke();
  } else if (showCamera) {
    scanCtx.fillStyle = RED;
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
