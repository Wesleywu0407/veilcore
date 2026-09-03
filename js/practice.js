// ─── Veilcore — practice range ───────────────────────────────────────────────
//
// A room with targets and no duel: no rival, no clock, no mana. It exists so the
// bow can be TUNED, which means every number archery.js measures is on the glass
// while you shoot. If the draw feels wrong, the panel says which constant is
// wrong.

import * as THREE from 'three';
import { buildEnvironment } from './arena/scene.js';
import { initTracker, getFrame, disposeTracker } from './spell-room/tracker.js';
import { createBowState, readBow, BOW } from './spell-room/archery.js';
import { createSignState, handSign } from './spell-room/hand-sign.js';
import { createBowAim } from './spell-room/aim.js';
import { createBowView } from './arena/bow-view.js';
import { loadGLB } from './arena/asset-library.js';

const GOLD = '#ffd98a';
const DIM = '#7f899f';

// ─── Aiming ──────────────────────────────────────────────────────────────────
//
// Facing a webcam, an archer's arrow points across the frame, not into it: the
// bow hand is off to one side and the string hand to the other, so following the
// arrow literally would fire at the wall. Aim is therefore RELATIVE. Wherever
// the bow hand sits at the moment the string is nocked becomes the centre of the
// screen, and moving it from there steers the reticle. That works from any
// stance, needs no calibration step, and lets a small movement cover the range.
// Drawing narrows the lens. It is what an archer does with their attention, and
// it earns its keep mechanically: the reticle's screen-space shake stays the
// same size while the world angle behind it shrinks, so a full draw is genuinely
// more accurate rather than only looking that way.
const FOV_SLACK = 55;
const FOV_FULL = 32;

// ─── Focus ───────────────────────────────────────────────────────────────────
//
// Holding still narrows the lens further, and narrowing the lens slows the
// crosshair by the same factor. Those two together are what being focused
// actually feels like: the world gets bigger and your hand gets quieter, and a
// target you have settled on stops squirming.
//
// The gain falls in step with the field of view, which is what makes the
// crosshair heavy: at 20 degrees a movement carries the reticle about a third
// as far across the glass as it did at 55.
//
// Be clear about what that costs, because it is not neutral. The world angle
// behind the crosshair shrinks TWICE over -- once because the lens narrowed and
// again because the gain fell -- so the same flick of the wrist that swept 8.8
// degrees downrange at 55 sweeps 1.1 at 20. A settled shot is roughly eight
// times finer than a hurried one. That is a deliberate reward for stillness and
// it sits behind a one-second hold, but it IS a large multiplier and it is the
// first thing to look at if focused shooting starts feeling like the only way
// to play.
//
// None of these four came off a real hand in front of a real camera, because
// there is no way to measure a flinch from here. They are the shape of the
// thing; the numbers want an eye on them. STILL_SPEED is the one to move first
// -- it decides whether ordinary tracking jitter reads as a steady hand.
// The ceiling, as a percentage of magnification on top of whatever the draw has
// already given. 40% means a fully settled hand sees the lens close from the
// draw's 32 degrees to about 23 -- noticeable, and nowhere near the 175% the
// first pass was helping itself to.
const FOCUS_MAX_ZOOM = 40;

// ── The dead zone, and why there has to be one ──
//
// A tracked landmark never stops moving. Measured against jitter of a few
// thousandths of a frame width -- which is what MediaPipe actually does to a
// motionless hand -- the smoothed speed of a hand held perfectly still comes out
// at 0.02 to 0.10 frame-widths a second, depending on the light. The first pass
// put the whole scale from 0 to 0.12 across exactly that range, so a still hand
// sat on the steepest part of the curve and every flicker of noise moved the
// lens. It wobbled by nearly two degrees, continuously.
//
// So STILL_FLOOR sits ABOVE the noise: anything under it is fully still, full
// stop, with no sensitivity at all. The scale to STILL_SPEED then covers real
// movement instead of the tracker's imagination. Same shape as every other
// threshold in this project -- an on value, an off value, and a band between
// them where nothing changes.
//
// Measured: this takes the wobble from +/-1.94 degrees to +/-0.12, and a hand
// drifting 0.6 widths a second still gives the focus up completely.
const STILL_FLOOR = 0.15;   // below this, held still -- it is only the tracker breathing
const STILL_SPEED = 0.50;   // and at this, unambiguously moving
// Speed is a derivative of a landmark that jitters, so it arrives full of noise
// that has nothing to do with how still a hand is being held. Low-passed before
// it is allowed to decide anything -- the same reason boxing.js compares span
// against a slow follower instead of differentiating it.
const SPEED_SMOOTH = 6;
// Earned slowly, and given up slowly too -- a fast release is its own kind of
// shake, because every twitch becomes a lurch outward and back. At 0.9 the lens
// is 59% closed one second after you settle, which is exactly when the hold
// clears and you are allowed to shoot, and it keeps creeping in for another
// couple of seconds after that. 0.5 was tried first and took six seconds to
// arrive, which is longer than anyone waits.
const FOCUS_RISE = 0.9;
const FOCUS_FALL = 1.5;
// How fast the lens follows what the draw and the focus between them ask for.
// The draw is computed from raw wrist positions and is noisy in its own right,
// so this smooths a shake that was there before focus existed.
const FOV_EASE = 5;

const glCanvas = document.querySelector('[data-range-gl]');
const overlay = document.querySelector('[data-range-overlay]');
const video = document.querySelector('[data-range-video]');
const errorLine = document.querySelector('[data-range-error]');
const menuPanel = document.querySelector('[data-range-menu]');
const menuResume = document.querySelector('[data-range-resume]');
const menuQuit = document.querySelector('[data-range-quit]');
const menuClose = document.querySelector('[data-range-menu-close]');
const ctx = overlay.getContext('2d');

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x05060c, 0.012);
scene.environment = buildEnvironment(renderer);
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 300);
camera.position.set(0, 3.1, 0);
camera.lookAt(0, 2.6, 40);

// Children of the camera only render when the camera is itself in the graph.
scene.add(camera);
const bowView = createBowView(camera);
bowView.setVisible(false);

// The limbs arrive late and the range is playable without them: string, arrow
// and reticle all work on their own, so a missing or slow model costs the look
// and not the session.
(async () => {
  try {
    const gltf = await loadGLB('assets/models/arena/bow.glb');
    bowView.attachLimbs(gltf.scene);
  } catch (error) {
    status = `bow model: ${error.message}`;
  }
})();

scene.add(new THREE.HemisphereLight(0x9fb4e8, 0x0b1020, 1.1));
const key = new THREE.DirectionalLight(0xffe6c0, 1.5);
key.position.set(-8, 16, -6);
scene.add(key);

// ─── The range ───────────────────────────────────────────────────────────────

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 140),
  new THREE.MeshStandardMaterial({ color: 0x131a2b, roughness: 0.92, metalness: 0.04 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.z = 50;
scene.add(floor);

// Distance is impossible to judge against an empty plane, and judging distance
// is the whole skill being practised.
const markerGeometry = new THREE.BoxGeometry(0.35, 0.9, 0.35);
const markerMaterial = new THREE.MeshStandardMaterial({ color: 0x263049, roughness: 0.8 });
for (let z = 10; z <= 70; z += 10) {
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(markerGeometry, markerMaterial);
    post.position.set(side * 7, 0.45, z);
    scene.add(post);
  }
}

const RING_COLOURS = [0xffd98a, 0xe8e4dc, 0x9b87ff];
function buildTarget({ z, x = 0, y = 2.6, radius = 1.5, sway = 0 }) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  RING_COLOURS.forEach((colour, i) => {
    const r = radius * (1 - i * 0.3);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.72, r, 48),
      new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
    );
    group.add(ring);
  });
  const face = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 40),
    new THREE.MeshStandardMaterial({ color: 0x0d1424, roughness: 0.85 }),
  );
  face.position.z = -0.02;
  group.add(face);
  scene.add(group);
  return { group, radius, home: x, sway, hitAt: -Infinity };
}

const targets = [
  buildTarget({ z: 18, x: -5, radius: 1.7 }),
  buildTarget({ z: 26, x: 0, radius: 1.4 }),
  buildTarget({ z: 34, x: 5.5, radius: 1.5, sway: 4 }),
  buildTarget({ z: 48, x: -3, radius: 1.2, sway: 6 }),
];

// ─── Arrows ──────────────────────────────────────────────────────────────────
//
// The hit is decided by a ray at the instant of the loose, so the accuracy
// readout is exact. The flying arrow is feedback, not physics — if it disagreed
// with the ray, the panel would be lying about which one you missed by.
const arrowGeometry = new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6);
arrowGeometry.rotateX(Math.PI / 2);
const arrowMaterial = new THREE.MeshStandardMaterial({
  color: 0xf3ead7, emissive: 0xffd98a, emissiveIntensity: 0.5, roughness: 0.4,
});
const arrows = [];
function spawnArrow(origin, direction, speed) {
  const mesh = new THREE.Mesh(arrowGeometry, arrowMaterial);
  mesh.position.copy(origin);
  mesh.lookAt(origin.clone().add(direction));
  scene.add(mesh);
  arrows.push({ mesh, direction: direction.clone(), speed, life: 3 });
}

// ─── State ───────────────────────────────────────────────────────────────────

// Any release is a shot here, whatever the wrists were doing.
//
// The duel keeps its MIN_LOOSE_DRAW floor -- there an accidental twitch costs
// an arrow and 20 mana, so it is worth refusing. On a range the opposite is
// true: the thing being practised IS the release, and a gesture that is read
// correctly but silently discarded looks identical to one that was not read at
// all. Every open hand puts an arrow in the air, and the power it carries says
// how far it was drawn.
// The string has to be HELD before letting go is a shot.
//
// Without it, shooting is open-and-close, which a hand can do faster than the
// tracker can be trusted to have meant it -- and a range where the arrow leaves
// on a flap teaches the flap, not the shot. A second is long enough that the
// pose has to be arrived at deliberately and short enough that it never becomes
// the thing you are waiting on.
const MIN_HOLD_MS = 1000;
const bowState = createBowState({ minLooseDraw: 0, minHoldMs: MIN_HOLD_MS });
const bowAim = createBowAim();
let running = false;
let tracking = false;
let status = 'idle';
const reticle = bowAim.reticle;
const lerp = (a, b, t) => a + (b - a) * t;
const shots = { fired: 0, hit: 0, lastPower: 0, lastMiss: null, lastRing: null };

// The lens the reticle was last PRESENTED under.
//
// Drawing narrows the camera and the reticle is stored in screen space, so the
// angle a given reticle position means depends entirely on which lens is in
// force when it is unprojected. On the release frame the state machine has
// already gone idle, so the FOV line above springs the camera back to slack
// BEFORE the shot is cast -- the arrow was leaving through a 55-degree lens
// having been aimed through a 32-degree one, which at full draw threw it 5.2
// degrees wide of its own crosshair. Worse, the hit test used the same wrong
// ray, so the range agreed with the arrow and disagreed with the player.
//
// Held here rather than recomputed from `power`: this is the lens that was
// actually on screen, which is the one the player aimed down.
let aimFov = FOV_SLACK;
let wantFov = FOV_SLACK;

// The tuning readout, off by default. This range is where DRAW_MIN, DRAW_FULL
// and the focus constants were chosen, and there is no way to choose them
// without seeing what the bow is measuring -- but eleven rows of diagnostics
// between a player and the targets is the wrong default once they are chosen.
let showPanel = false;
let cvFrames = 0, cvAt = 0, cvHz = 0, lastFrameAt = 0;

// 0 loose, 1 fully settled. Held across frames; only a nock starts it over.
let focus = 0;
let lastWrist = null;
let handSpeed = 0;

/** How much of the lens the stillness of the bow hand has earned. */
function updateFocus(wrist, dt) {
  if (!wrist || dt <= 0) return focus;
  if (lastWrist) {
    const raw = Math.hypot(wrist.x - lastWrist.x, wrist.y - lastWrist.y) / dt;
    handSpeed += (raw - handSpeed) * Math.min(1, dt * SPEED_SMOOTH);
  }
  lastWrist = { x: wrist.x, y: wrist.y };
  // Proportional rather than a gate, so a slow drift costs some focus instead
  // of all of it, and creeping onto a target does not throw the lens open.
  const target = 1 - clamp01((handSpeed - STILL_FLOOR) / (STILL_SPEED - STILL_FLOOR));
  const rate = target > focus ? FOCUS_RISE : FOCUS_FALL;
  focus += (target - focus) * Math.min(1, dt * rate);
  return focus;
}

const _ndc = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _ray = new THREE.Ray();
const _hit = new THREE.Vector3();
const _plane = new THREE.Plane();
const _normal = new THREE.Vector3(0, 0, -1);

function loose(power) {
  // Unproject through the lens the crosshair was drawn under, not whatever the
  // camera happens to hold now. Restored immediately: the loop's own FOV line
  // runs next and owns the camera from here.
  const wasFov = camera.fov;
  camera.fov = aimFov;
  camera.updateProjectionMatrix();
  _ndc.set(reticle.x * 2 - 1, -(reticle.y * 2 - 1), 0.5).unproject(camera);
  camera.fov = wasFov;
  camera.updateProjectionMatrix();
  _dir.copy(_ndc).sub(camera.position).normalize();
  _origin.copy(camera.position).addScaledVector(_dir, 1.2);
  _ray.set(camera.position, _dir);

  let best = null;
  for (const target of targets) {
    // Each target is a disc facing the shooter; intersect its plane, then check
    // how far from the centre the arrow crossed it.
    _plane.setFromNormalAndCoplanarPoint(_normal, target.group.position);
    if (!_ray.intersectPlane(_plane, _hit)) continue;
    const miss = Math.hypot(_hit.x - target.group.position.x, _hit.y - target.group.position.y);
    if (!best || miss < best.miss) best = { target, miss };
  }

  shots.fired += 1;
  shots.lastPower = power;
  if (best && best.miss <= best.target.radius) {
    shots.hit += 1;
    shots.lastMiss = best.miss;
    // Which ring: the three bands drawn in buildTarget.
    const frac = best.miss / best.target.radius;
    shots.lastRing = frac < 0.4 ? 'inner' : frac < 0.7 ? 'middle' : 'outer';
    best.target.hitAt = performance.now();
    status = `hit · ${shots.lastRing}`;
  } else {
    shots.lastMiss = best ? best.miss : null;
    shots.lastRing = null;
    status = 'miss';
  }
  spawnArrow(_origin, _dir, 60 + power * 90);
}

// ─── Loop ────────────────────────────────────────────────────────────────────

let last = performance.now();
function loop(now) {
  if (!running) return;
  if (menuOpen) {
    // Keep the chain alive and the last frame on the glass; simulate nothing.
    // The 2D overlay is only cleared at the top of a real step, so the score
    // and the crosshair stay put underneath.
    last = now;
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
    return;
  }
  const dt = Math.min((now - last) / 1000, 0.08);
  last = now;
  ctx.clearRect(0, 0, innerWidth, innerHeight);

  for (const target of targets) {
    if (target.sway) target.group.position.x = target.home + Math.sin(now / 1400) * target.sway;
    const since = now - target.hitAt;
    const flash = since < 420 ? 1 - since / 420 : 0;
    target.group.scale.setScalar(1 + flash * 0.12);
  }

  for (let i = arrows.length - 1; i >= 0; i--) {
    const arrow = arrows[i];
    arrow.mesh.position.addScaledVector(arrow.direction, arrow.speed * dt);
    arrow.life -= dt;
    if (arrow.life <= 0) { scene.remove(arrow.mesh); arrows.splice(i, 1); }
  }

  const frame = getFrame();
  let bow = null;
  let bowSign = null;
  let armed = false;
  if (tracking) {
    if (frame.at !== lastFrameAt) { lastFrameAt = frame.at; cvFrames += 1; }
    if (now - cvAt >= 500) { cvHz = cvFrames / ((now - cvAt) / 1000); cvFrames = 0; cvAt = now; }

    // Read first, then decide. Handing the state machine an empty frame while
    // the bow is down resets it, so nothing can be half-nocked from before.
    bowSign = readBowSign(frame.hands);
    armed = bowSign?.sign === SIGN_BOW;
    bow = bowState.update(armed ? frame.hands : null, now);

    const nocked = bow.phase === 'nocked';
    if (nocked && bow.bowWrist) {
      // The draw sets the lens, then stillness closes it further. Computed
      // before the aim, because the gain the aim runs at comes out of it.
      updateFocus(bow.bowWrist, dt);
      wantFov = lerp(FOV_SLACK, FOV_FULL, bow.draw) / (1 + (FOCUS_MAX_ZOOM / 100) * focus);
      // Whichever hand archery.js chose stays authoritative all the way through
      // the shared aiming controller; the host never guesses handedness again.
      bowAim.update(bow.bowWrist, bow.draw, now, aimFov / FOV_SLACK);
    } else {
      focus = 0;
      handSpeed = 0;
      lastWrist = null;
      wantFov = FOV_SLACK;
    }

    // One eased value drives both the camera and the shot, so the ray can never
    // be cast through a lens the crosshair was not drawn under.
    aimFov += (wantFov - aimFov) * Math.min(1, dt * FOV_EASE);

    // ── The shot is cast before anything it reads is let go of ──
    //
    // The state machine has already gone idle by the time the event arrives, so
    // a "not nocked any more, put the aim away" branch placed above this fires
    // BEFORE the arrow does. `reticle` is a live reference into the aim
    // controller and reset() writes 0.5, 0.5 straight into it, so every shot
    // used to leave down the camera's own axis no matter where the crosshair
    // had been -- and the FOV it was drawn under went the same way.
    if (bow.event?.type === 'loosed') loose(bow.event.power);

    // ── ...and the aim survives the shot ──
    //
    // Loosing does NOT re-centre. The crosshair sits where it was left, so a
    // second arrow at the same target is aimed by not moving, which is what
    // aiming is. Re-centring on every release meant the range could only ever
    // be shot one arrow at a time, from the middle outward.
    //
    // Only putting the bow down lets it go -- the two fingers dropping, or the
    // hand leaving frame, both of which land here as `armed` going false. That
    // is also the one moment a stale origin would be wrong, because the hand it
    // was measured from is gone.
    if (!armed) bowAim.reset();

    bowView.setVisible(armed);
    bowView.setNocked(nocked);
    bowView.setDraw(nocked ? bow.draw : 0);

    if (Math.abs(camera.fov - aimFov) > 0.01) {
      camera.fov = aimFov;
      camera.updateProjectionMatrix();
    }
  }

  drawPanel(frame, bow, bowSign, armed);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ─── Taking up the bow ───────────────────────────────────────────────────────
//
// Two hands in frame is not a request for a bow. It is what a person looks like
// when they are standing in front of a webcam, and the range used to hand them
// one for it -- so the bow was permanently up and the only way to not be
// holding it was to put a hand behind your back.
//
// It is asked for now, the same way the duel asks: the BOW hand holds up two
// fingers. The string hand does what it always did -- close on the string, pull,
// open to loose -- and its fingers are deliberately never part of this gate,
// because opening that hand is the shot. See input-mode.js, which learned that
// the expensive way.
//
// Which hand is which is not decided here. archery.js already picks the string
// hand as whichever one is closed, and that answer is taken as given rather
// than guessed at a second time.
const SIGN_BOW = 2;
const signs = { left: createSignState(), right: createSignState() };

/**
 * The hand holding the bow, and the count it is showing, or null without two
 * hands to look at.
 *
 * Read every frame whether or not the bow is up: a sign needs SIGN_HOLD frames
 * to settle, and a state left un-updated while the bow is down would answer
 * with whatever it last saw the moment it was consulted again.
 */
function readBowSign(hands) {
  if (hands?.length !== 2) return null;
  const read = readBow(hands);
  const side = read?.bow?.side;
  if (!side || !signs[side]) return null;
  return { side, sign: handSign(read.bow.landmarks, signs[side]) };
}

// ─── Panel ───────────────────────────────────────────────────────────────────

function line(text, x, y, colour = DIM, size = 11) {
  ctx.font = `500 ${size}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}

function drawPanel(frame, bow, bowSign, armed) {
  const w = innerWidth, h = innerHeight;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.letterSpacing = '0.08em';

  drawScore();
  if (showPanel) drawReadout(frame, bow, bowSign, armed);

  // ── The crosshair, and the wait around it ──
  if (tracking && bow?.phase === 'nocked') {
    const x = reticle.x * w, y = reticle.y * h;
    const radius = 14 + bow.draw * 16;
    const ready = bow.held >= MIN_HOLD_MS;
    // Amber until the string has been held long enough for letting go to be a
    // shot, gold from then on. The colour and the ring say the same thing twice
    // on purpose: this is the one piece of state that decides whether opening
    // your hand does anything, and getting it wrong looks exactly like the
    // tracker having lost you.
    ctx.strokeStyle = ready ? GOLD : '#b8894a';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 22, y); ctx.lineTo(x - 8, y);
    ctx.moveTo(x + 8, y); ctx.lineTo(x + 22, y);
    ctx.moveTo(x, y - 22); ctx.lineTo(x, y - 8);
    ctx.moveTo(x, y + 8); ctx.lineTo(x, y + 22);
    ctx.stroke();

    // One full turn, taking exactly MIN_HOLD_MS, closing at the moment the
    // release becomes a shot. Starts at twelve o'clock because a ring that
    // closes anywhere else is read as a gauge rather than a countdown.
    const swept = Math.min(1, bow.held / MIN_HOLD_MS);
    ctx.beginPath();
    ctx.arc(x, y, radius + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * swept);
    ctx.strokeStyle = ready ? GOLD : 'rgba(255,217,138,.8)';
    ctx.lineWidth = ready ? 3 : 2;
    ctx.stroke();
  }

  ctx.textAlign = 'right';
  line(status, w - 26, h - 26, GOLD, 12);
  ctx.textAlign = 'left';
  line('ESC  menu      R  reset      P  readout      H  retry camera', 26, h - 26, '#5d6b86', 11);
  ctx.restore();
}

// ─── The scoreboard ──────────────────────────────────────────────────────────
//
// Two numerals, set in the display face the rest of the game uses, because they
// are the only thing on this screen a person is keeping. Everything measured
// lives behind P; this is the score.
const SCORE = { x: 18, y: 18, w: 210, h: 122 };

function drawScore() {
  const { x, y, w, h } = SCORE;
  ctx.save();
  ctx.fillStyle = 'rgba(6,9,17,.82)';
  ctx.fillRect(x, y, w, h);
  // Half-pixel inset so a 1px stroke lands on the pixel rather than across two.
  ctx.strokeStyle = 'rgba(255,217,138,.20)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  ctx.textAlign = 'center';
  const columns = [['FIRED', shots.fired, '#c3cde2'], ['HIT', shots.hit, GOLD]];
  columns.forEach(([label, value, colour], i) => {
    const cx = x + w * (i === 0 ? 0.27 : 0.73);
    ctx.letterSpacing = '0.24em';
    ctx.font = "500 9px 'IBM Plex Mono', monospace";
    ctx.fillStyle = '#66708a';
    // The label carries the letter-spacing, so it has to be nudged back by half
    // of the trailing gap to stay centred over its numeral.
    ctx.fillText(label, cx + 1, y + 30);
    ctx.letterSpacing = '0em';
    ctx.font = "300 38px 'Cormorant Garamond', serif";
    ctx.fillStyle = colour;
    ctx.fillText(String(value), cx, y + 70);
  });

  ctx.strokeStyle = 'rgba(255,255,255,.07)';
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y + 20); ctx.lineTo(x + w / 2, y + 76);
  ctx.stroke();

  const rate = shots.fired ? shots.hit / shots.fired : 0;
  ctx.letterSpacing = '0.2em';
  ctx.font = "500 9px 'IBM Plex Mono', monospace";
  ctx.textAlign = 'left';
  ctx.fillStyle = '#66708a';
  ctx.fillText('ACCURACY', x + 16, y + 96);
  ctx.textAlign = 'right';
  ctx.letterSpacing = '0em';
  ctx.fillStyle = shots.fired ? GOLD : '#66708a';
  ctx.fillText(shots.fired ? `${(rate * 100).toFixed(0)}%` : '—', x + w - 16, y + 96);

  // Well clear of the row above: at a 7px gap the percent's descenders sat on
  // the bar and the two read as one smudged object.
  ctx.fillStyle = 'rgba(255,255,255,.07)';
  ctx.fillRect(x + 16, y + 108, w - 32, 3);
  ctx.fillStyle = GOLD;
  ctx.fillRect(x + 16, y + 108, (w - 32) * rate, 3);
  ctx.restore();
}

// ─── The tuning readout, behind P ────────────────────────────────────────────
//
// Every number the bow measures, which is what this range is for: DRAW_MIN and
// DRAW_FULL were read off these rows, and the focus constants have never been
// looked at against a real hand at all.
function drawReadout(frame, bow, bowSign, armed) {
  const top = SCORE.y + SCORE.h + 12;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.letterSpacing = '0.08em';
  ctx.fillStyle = 'rgba(6,9,17,.72)';
  ctx.fillRect(18, top, 268, 246);
  line('BOW READOUT', 34, top + 24, '#8ab4ff', 11);

  const hands = frame.hands?.length ?? 0;
  // Both halves of the gate on one row, because either can be what is wrong:
  // how many hands, and the count the bow hand is showing.
  const shown = bowSign?.sign;
  line(`hands ${hands}         ${bowSign ? `bow ${bowSign.side} · ${shown ?? '—'} up` : '—'}`,
    34, top + 48, armed ? GOLD : '#b8894a');
  if (bow && armed) {
    const ready = bow.held >= MIN_HOLD_MS;
    line(`phase           ${bow.phase}`, 34, top + 66, bow.phase === 'nocked' ? GOLD : DIM);
    line(`spans           ${bow.spans.toFixed(2)}`, 34, top + 84);
    line(`draw            ${(bow.draw * 100).toFixed(0)}%`, 34, top + 102, GOLD);
    line(`peak            ${(bow.peak * 100).toFixed(0)}%`, 34, top + 120);
    line(`focus           ${(focus * 100).toFixed(0)}%  of ${FOCUS_MAX_ZOOM}%   lens ${aimFov.toFixed(1)}°`,
      34, top + 138, focus > 0.6 ? GOLD : DIM);
    line(`hold            ${(bow.held / 1000).toFixed(2)}s / ${(MIN_HOLD_MS / 1000).toFixed(2)}s`
      + (bow.phase === 'nocked' ? (ready ? '  ready' : '  wait') : ''),
      34, top + 156, bow.phase !== 'nocked' ? DIM : ready ? GOLD : '#b8894a');

    // Two bars: the draw, and the hold filling under it.
    const bx = 34, bw = 232;
    for (const [dy, fill, colour] of [[168, bow.draw, GOLD],
                                      [176, Math.min(1, bow.held / MIN_HOLD_MS), ready ? GOLD : '#b8894a']]) {
      ctx.fillStyle = 'rgba(255,255,255,.08)';
      ctx.fillRect(bx, top + dy, bw, 5);
      ctx.fillStyle = colour;
      ctx.fillRect(bx, top + dy, bw * fill, 5);
    }
  } else {
    line(hands === 2 ? `show ${SIGN_BOW} fingers on the bow hand` : 'both hands in frame', 34, top + 66, '#b8894a');
    line(hands === 2 ? 'and close the other on the string' : 'to take up the bow', 34, top + 84, '#b8894a');
  }
  line(`fov ${camera.fov.toFixed(1)}°   still ${STILL_FLOOR}..${STILL_SPEED}`, 34, top + 194, '#5d6b86', 10);
  line(`DRAW_MIN ${BOW.DRAW_MIN}   DRAW_FULL ${BOW.DRAW_FULL}   max zoom ${FOCUS_MAX_ZOOM}%`, 34, top + 208, '#5d6b86', 10);
  line(`min hold ${(MIN_HOLD_MS / 1000).toFixed(2)}s   tracking ${cvHz.toFixed(0)} Hz`,
    34, top + 222, cvHz > 20 ? '#5d6b86' : '#b8894a', 10);
  ctx.restore();
}

// ─── Boot ────────────────────────────────────────────────────────────────────

function resize() {
  const dpr = Math.min(devicePixelRatio, 1.25);
  renderer.setSize(innerWidth, innerHeight, false);
  glCanvas.width = Math.floor(innerWidth * dpr);
  glCanvas.height = Math.floor(innerHeight * dpr);
  renderer.setViewport(0, 0, innerWidth, innerHeight);
  overlay.width = innerWidth;
  overlay.height = innerHeight;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ─── The pause panel ─────────────────────────────────────────────────────────
//
// Escape used to navigate straight back to the gate. One keypress, no
// confirmation, and Escape is the key a browser has trained everyone to hit
// when they want out of something smaller than the whole page -- a pointer
// lock, a full-screen video. Leaving should take a deliberate click.
//
// So Escape opens this, and Escape again closes it. Pressing it twice returns
// you to shooting, not to the menu.
let menuOpen = false;

function openMenu() {
  if (!running || menuOpen) return;
  menuOpen = true;
  if (menuPanel) menuPanel.hidden = false;
  menuResume?.focus();
}

function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  if (menuPanel) menuPanel.hidden = true;
  // Or the first frame back carries the whole time the panel was open.
  last = performance.now();
}

menuResume?.addEventListener('click', closeMenu);
menuClose?.addEventListener('click', closeMenu);
menuQuit?.addEventListener('click', () => { location.href = 'index.html'; });
// The backdrop only -- never a click that started inside the box.
menuPanel?.addEventListener('click', (event) => { if (event.target === menuPanel) closeMenu(); });

addEventListener('keydown', (event) => {
  if (event.code === 'Escape') {
    if (menuOpen) closeMenu();
    else openMenu();
    return;
  }
  if (event.code === 'KeyR') { shots.fired = 0; shots.hit = 0; shots.lastMiss = null; status = 'counters reset'; }
  if (event.code === 'KeyP') { showPanel = !showPanel; status = showPanel ? 'readout on' : 'readout off'; }
  // A restart, not a toggle -- initTracker tears the old session down itself.
  if (event.code === 'KeyH') void startTracking();
});

let starting = false;

async function startTracking() {
  // Held here as well as in tracker.js, so that leaning on H reports what is
  // happening instead of falling down the error path. The tracker's own guard
  // stays as the backstop for anything that gets past this one.
  if (starting) {
    status = 'still starting — give it a moment';
    return;
  }
  starting = true;
  try {
    // No frames are read while the tracker is being torn down and rebuilt.
    status = tracking ? 'restarting the camera' : 'waking the camera';
    tracking = false;
    await initTracker(video, (stage) => { status = stage; });
    tracking = true;
    status = 'ready — both hands up';
  } catch (error) {
    tracking = false;
    status = `camera: ${error.message}`;
    if (errorLine) { errorLine.hidden = false; errorLine.textContent = error.message; }
  } finally {
    starting = false;
  }
}

// ── Straight in ──
//
// There is no cover page to press through any more. The range starts rendering
// on load and asks for the camera immediately.
//
// The cover was doing one thing besides carrying a paragraph: providing the
// USER GESTURE that getUserMedia is happiest being called from. Losing it is a
// real cost and it lands on the first visit only -- an origin that has already
// been granted the camera is granted it again without a prompt or a gesture.
// If a browser does refuse, the failure is not silent: the corner turns red
// with the reason, and H retries from a keypress, which IS a gesture.
running = true;
resize();
requestAnimationFrame(loop);
void startTracking();

addEventListener('beforeunload', () => disposeTracker());
