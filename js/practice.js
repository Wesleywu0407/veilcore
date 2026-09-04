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
import { sideOf } from './spell-room/pose.js';
import { createSignState, handSign } from './spell-room/hand-sign.js';
import { createBowAim, createFocus, FOCUS } from './spell-room/aim.js';
import { createBowView } from './arena/bow-view.js';
import { drawHand } from './spell-room/draw-hand.js';
import { drawFace } from './spell-room/draw-face.js';
import { loadGLB } from './arena/asset-library.js';
import { struckScale } from './arena/struck.js';

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
// thing; the numbers want an eye on them. FOCUS.SPEED is the one to move first
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
// So FOCUS.FLOOR sits ABOVE the noise: anything under it is fully still, full
// stop, with no sensitivity at all. The scale to FOCUS.SPEED then covers real
// movement instead of the tracker's imagination. Same shape as every other
// threshold in this project -- an on value, an off value, and a band between
// them where nothing changes.
//
// Measured: this takes the wobble from +/-1.94 degrees to +/-0.12, and a hand
// drifting 0.6 widths a second still gives the focus up completely.
// The stillness numbers moved to FOCUS in aim.js with the maths that reads
// them, so the two cannot drift apart and so they can be tested without a
// camera. Nothing about them changed on the way.
const FOV_EASE = 5;

const glCanvas = document.querySelector('[data-range-gl]');
const overlay = document.querySelector('[data-range-overlay]');
const video = document.querySelector('[data-range-video]');
const scan = document.querySelector('[data-range-scan]');
const scanCtx = scan?.getContext('2d');
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

// ─── Lit like a hall, not like a crypt ───────────────────────────────────────
//
// The duel is the dark room. This is not the duel: it is where somebody works
// out what their hands are supposed to do, and a person learning needs to SEE.
// The range was lit at the duel's level and read as unfinished -- a black void
// with four grey smudges hanging in it, which tells a first-timer nothing about
// where they are or how far away anything is.
//
// Three lights and no more. The sky is the room's own bounce, warm rather than
// blue so the porcelain reads as porcelain; the key rakes across from above and
// behind so the posts and the floor throw length; and the fill sits BEHIND THE
// SHOOTER, which is the only light that reaches the faces of the targets --
// they point back at you, so nothing in front of them ever lights them.
scene.add(new THREE.HemisphereLight(0xdfe4f2, 0x2a3550, 1.5));

const key = new THREE.DirectionalLight(0xffe6c0, 1.9);
key.position.set(-8, 16, -6);
scene.add(key);

const fill = new THREE.DirectionalLight(0xcfd8ee, 0.85);
fill.position.set(2, 5, -14);          // over your shoulder, aimed downrange
scene.add(fill);

// ── Distance, made visible ──
//
// Judging distance is the skill this room exists to teach, and an unfogged
// range gives no cue for it at all: the far target is simply a smaller version
// of the near one. Fog is the cheapest depth cue there is -- no geometry, no
// draw call -- and it starts beyond the nearest target so nothing you are
// actually shooting at is dimmed by it.
//
// The background is the SAME colour as the fog, and that is the whole trick: an
// unset background is black, so the floor faded toward a fog colour and then
// stopped dead against a hard black edge -- a room that ends. Matching them
// turns that edge into a horizon, and the far target sits in air instead of in
// front of a wall of nothing. One line, no geometry.
const HAZE = 0x18203a;
scene.fog = new THREE.Fog(HAZE, 26, 150);
scene.background = new THREE.Color(HAZE);

// ─── The range ───────────────────────────────────────────────────────────────

// ─── The floor, as a range ───────────────────────────────────────────────────
//
// It was one flat colour, which is the single biggest reason this room looked
// like something nobody had finished. A range is not a floor; it is a floor
// with LANES and DISTANCES on it, and those are the two things the person
// standing on it needs to read.
//
// Painted into a canvas and used as a map, so all of this still costs the one
// draw call the plain plane cost. No geometry was added to draw a line.
const FLOOR_SPAN = { x: 60, z: 140, at: 50 };   // the plane, and where it sits

/**
 * The markings, in the page's own colours.
 *
 * Drawn in METRES and converted at the edge, so every number below is the
 * number you would measure on the ground -- the lane is at seven metres because
 * the distance posts are at seven metres, not because seven looked right in
 * pixels.
 */
function rangeFloorTexture() {
  const canvas = document.createElement('canvas');
  // Long axis gets the resolution: the eye runs down this floor, not across it.
  canvas.width = 512;
  canvas.height = 1024;
  const g = canvas.getContext('2d');

  const near = -20;                                   // the plane's near edge, in metres
  const u = metres => ((metres + FLOOR_SPAN.x / 2) / FLOOR_SPAN.x) * canvas.width;
  const v = metres => ((metres - near) / FLOOR_SPAN.z) * canvas.height;

  g.fillStyle = '#1b2236';
  g.fillRect(0, 0, canvas.width, canvas.height);

  // A wash down the middle, so the lane you shoot along is lighter than the
  // ground either side of it and the eye is led downrange rather than around.
  const lane = g.createLinearGradient(u(-9), 0, u(9), 0);
  lane.addColorStop(0, 'rgba(244,237,223,0)');
  lane.addColorStop(0.5, 'rgba(244,237,223,0.07)');
  lane.addColorStop(1, 'rgba(244,237,223,0)');
  g.fillStyle = lane;
  g.fillRect(u(-9), 0, u(9) - u(-9), canvas.height);

  // The two lane edges, at the distance posts.
  g.strokeStyle = 'rgba(244,237,223,0.30)';
  g.lineWidth = 3;
  for (const x of [-7, 7]) {
    g.beginPath();
    g.moveTo(u(x), v(0));
    g.lineTo(u(x), v(80));
    g.stroke();
  }

  // A bar every ten metres. This is the ruler: without it the far target is
  // just a smaller near one and there is no way to learn what far looks like.
  g.strokeStyle = 'rgba(244,237,223,0.16)';
  g.lineWidth = 2;
  for (let z = 10; z <= 70; z += 10) {
    g.beginPath();
    g.moveTo(u(-7), v(z));
    g.lineTo(u(7), v(z));
    g.stroke();
  }

  // And a brighter one under each target, in gold, so the ruler is marked where
  // it matters. Read from `targets` would be circular -- they are built after
  // this -- so the distances are named once here and once there, and a mismatch
  // shows up as a bar that has nothing standing on it.
  g.strokeStyle = 'rgba(255,217,138,0.42)';
  g.lineWidth = 4;
  for (const z of [18, 26, 34, 48]) {
    g.beginPath();
    g.moveTo(u(-8.5), v(z));
    g.lineTo(u(8.5), v(z));
    g.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
}

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(FLOOR_SPAN.x, FLOOR_SPAN.z),
  new THREE.MeshStandardMaterial({
    map: rangeFloorTexture(), roughness: 0.92, metalness: 0.04,
  }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.z = FLOOR_SPAN.at;
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
/**
 * A target face.
 *
 * The rings below are PROCEDURAL and stay -- not as the finished look, but as
 * what is on screen for the second before target.glb arrives and for the whole
 * session if it never does. A range with invisible targets is not a degraded
 * range, it is a broken one, and a 0.76 MB fetch is enough time to notice.
 *
 * Nothing here decides a hit. The scoring ray is cast against the target's
 * PLANE and its `radius`, so the mesh is free to be whatever it is without the
 * readout and the arrow disagreeing. See loose().
 */
function buildTarget({ z, x = 0, y = 2.6, radius = 1.5, sway = 0 }) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  // The painted face. A group of its own so the plate can sit behind it.
  const fallback = new THREE.Group();
  group.add(fallback);
  RING_COLOURS.forEach((colour, i) => {
    const r = radius * (1 - i * 0.3);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r * 0.72, r, 48),
      new THREE.MeshBasicMaterial({ color: colour, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
    );
    fallback.add(ring);
  });
  // ── DoubleSide, like the rings, and not by taste ──
  //
  // A CircleGeometry faces +z and the shooter is on the -z side, so at the
  // default FrontSide this backing was being back-face culled -- it has never
  // once been drawn. That is also why the rings were never hidden by it, and
  // why moving things along z to get in front of it did nothing at all: there
  // was nothing there to be in front of.
  const face = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 40),
    new THREE.MeshStandardMaterial({ color: 0x0d1424, roughness: 0.85, side: THREE.DoubleSide }),
  );
  // Behind the rings. The shooter is on the -z side -- which this file was wrong
  // about until the backing was made DoubleSide and promptly hid everything.
  face.position.z = 0.02;
  fallback.add(face);

  // ── The bullseye, and why it is the brightest thing here ──
  //
  // The rings above are annuli and the backing behind them is dark, so the
  // middle of every target was a dark hole -- the one place on the object you
  // are actually aiming at, and the only place with nothing in it. In a room lit
  // like this one, dark in the middle does not read as a mark, it reads as an
  // absence.
  //
  // --gold, from index.html, which is what every emphasis in this game is
  // already made of. Basic rather than standard: it must not get dimmer as the
  // range does.
  const bullseye = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 0.2, 28),
    new THREE.MeshBasicMaterial({ color: 0xffd98a, side: THREE.DoubleSide }),
  );
  bullseye.position.z = -0.03;
  fallback.add(bullseye);
  scene.add(group);
  return { group, fallback, radius, home: x, sway, hitAt: -Infinity };
}

// ─── The plate, from Meshy ───────────────────────────────────────────────────
//
// The DISC is the model; the rings are still drawn in code, and that split is
// deliberate rather than a compromise.
//
// Meshy was asked for the rings three different ways and painted them three
// different ways: stepped trenches that went black in this light, pale bands
// with no contrast at all, and finally a red dartboard that is not a colour this
// game owns. It is a diffusion model painting into a UV -- it is very good at
// glaze, chipping and a faceted rim, and it will not hold four exact concentric
// circles in four exact hex values, because that is not what it does.
//
// Four exact concentric circles in four exact hex values is what CODE does, and
// the code for them was already here. So: the plate underneath is the model, for
// the material and the silhouette. The rings on top are RingGeometry, in the
// page's own --paper, --violet and --gold. Nothing is left to chance in the part
// you have to aim at, and nothing is drawn by hand in the part that just has to
// look like porcelain.
const PLATE_MODEL = 'assets/models/range/plate.glb';

loadGLB(PLATE_MODEL).then(gltf => {
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const across = Math.max(size.x, size.y) || 1;
  const centre = new THREE.Vector3();
  box.getCenter(centre);

  // Untextured, so it is coloured here -- warm bone white, the page's --paper.
  const porcelain = new THREE.MeshStandardMaterial({
    color: 0xf4eddf, roughness: 0.62, metalness: 0.02,
  });

  for (const target of targets) {
    const plate = gltf.scene.clone(true);
    // Slightly WIDER than the painted face, so it reads as a plate the rings
    // are painted on rather than as a disc hiding behind them.
    const scale = (target.radius * 2.16) / across;
    plate.scale.setScalar(scale);
    plate.position.copy(centre).multiplyScalar(-scale);
    // ── Clear of the rings, by the plate's OWN thickness ──
    //
    // Pushed by a number picked by eye it straddled them and hid them from both
    // sides: scaled up, this disc is 0.21 deep, and 0.06 of clearance is inside
    // it. So the offset is measured off the model -- half its depth, plus enough
    // to keep the painted face off its surface.
    plate.position.z += (size.z * scale) / 2 + 0.05;
    plate.traverse(node => {
      if (!node.isMesh) return;
      node.material = porcelain;
      node.castShadow = false;
      node.receiveShadow = false;
    });
    target.group.add(plate);
  }
}).catch(() => {
  // The rings are the target either way; only the plate behind them is missing.
  status = 'plate model failed — rings only';
});

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
// A struck target swells, falls away and comes back: see struck.js, which owns
// the whole curve and is tested against it.
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
// The camera preview. On by default: the first question anybody has at a range
// is whether it can see them, and the readout cannot answer it -- a panel that
// says "show 2 fingers on the bow hand" looks identical whether the hand is
// unseen or seen and reading three.
let showCamera = true;
let cvFrames = 0, cvAt = 0, cvHz = 0, lastFrameAt = 0;

// 0 loose, 1 fully settled. Held across frames; only a nock starts it over.
const focus = createFocus();

/** How much of the lens the stillness of the bow hand has earned. */
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

  // ── The NEAREST one it actually crosses, not the best-centred one ──
  //
  // This took the smallest miss across every target, which is not what an arrow
  // does: line up the far target behind the near one and a shot that passed
  // clean through the near disc scored on the far one. Depth first, and a miss
  // is only compared against another miss when neither was hit.
  let best = null;
  for (const target of targets) {
    // Away, so there is nothing there to hit. Without this the ray still finds
    // the plane of a target that is not on screen, and the score counts an arrow
    // through an empty space as an inner ring.
    if (!target.group.visible) continue;
    // Each target is a disc facing the shooter; intersect its plane, then check
    // how far from the centre the arrow crossed it.
    _plane.setFromNormalAndCoplanarPoint(_normal, target.group.position);
    if (!_ray.intersectPlane(_plane, _hit)) continue;
    const miss = Math.hypot(_hit.x - target.group.position.x, _hit.y - target.group.position.y);
    const depth = _hit.distanceTo(camera.position);
    const hit = miss <= target.radius;
    if (!best) { best = { target, miss, depth, hit }; continue; }
    // A disc the arrow goes through stops it. Between two it went through, the
    // near one; between two it missed, the one it came closest to, which is all
    // the readout can honestly say.
    if (hit && !best.hit) best = { target, miss, depth, hit };
    else if (hit === best.hit && (hit ? depth < best.depth : miss < best.miss)) {
      best = { target, miss, depth, hit };
    }
  }

  shots.fired += 1;
  shots.lastPower = power;
  if (best?.hit) {
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

// ─── Failing loudly ──────────────────────────────────────────────────────────
//
// An exception thrown inside a requestAnimationFrame callback stops the chain
// dead. Everything drawn on a canvas freezes on the frame it died in, and the
// `<video>` behind the preview keeps playing because it is a DOM element and
// not a canvas -- so the range looks ALIVE and simply stops responding, with
// nothing anywhere saying why.
//
// The duel has had this guard for a while and says the same thing beside it.
// The range did not, and the difference cost an afternoon: a fault that only
// happens with a working camera is invisible to anyone whose camera is blocked,
// and the only report available was "it stopped".
let fatalError = null;

function reportFatal(error, where) {
  if (fatalError) return;
  fatalError = error;
  running = false;
  console.error(`[veilcore range] ${where}`, error);
  status = `${where} — ${error?.message ?? error}`;
  if (errorLine) {
    errorLine.hidden = false;
    errorLine.textContent = `${status}. Reload to restart; the console has the stack.`;
  }
  // Whatever else died, say so ON the glass. The overlay is the only surface
  // left that is certainly still working.
  try {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.letterSpacing = '0.12em';
    ctx.font = "500 13px 'IBM Plex Mono', monospace";
    ctx.fillStyle = '#ff9c82';
    ctx.fillText(status, innerWidth / 2, innerHeight / 2);
    ctx.fillText('reload to restart — the console has the stack',
      innerWidth / 2, innerHeight / 2 + 22);
    ctx.restore();
  } catch { /* the canvas is gone too; the console still has it */ }
}

let last = performance.now();
function loop(now) {
  if (!running) return;
  try {
    step(now);
  } catch (error) {
    reportFatal(error, 'the range stopped');
    return;
  }
  requestAnimationFrame(loop);
}

function step(now) {
  // ── The overlay has to still be the size of the window ──
  //
  // `resize` is an event, and an event is a promise that something will be
  // announced. A display being switched, a DPR change, a machine waking from
  // sleep -- these can leave the canvas a different size from the window, and a
  // canvas whose width is stale or zero draws NOTHING AND THROWS NOTHING. The
  // scoreboard, the instruction and the key legend simply stop being there,
  // which reads as "you broke it" and cannot be told apart from a crash.
  //
  // Two integer comparisons a frame, against a whole class of silent
  // disappearance. The 3D and the camera preview keep working throughout, which
  // is what makes it so convincing and so hard to report.
  // The canvas can drift out of step with the window without a `resize` ever
  // arriving -- a display switched, a DPR change, a wake from sleep. Two integer
  // comparisons a frame, and resize() itself refuses to act on a zero.
  if (overlay.width !== innerWidth || overlay.height !== innerHeight) resize();

  if (menuOpen) {
    // Keep the chain alive and the last frame on the glass; simulate nothing.
    // The 2D overlay is only cleared at the top of a real step, so the score
    // and the crosshair stay put underneath.
    last = now;
    renderer.render(scene, camera);
    return;
  }
  const dt = Math.min((now - last) / 1000, 0.08);
  last = now;
  ctx.clearRect(0, 0, innerWidth, innerHeight);

  for (const target of targets) {
    if (target.sway) target.group.position.x = target.home + Math.sin(now / 1400) * target.sway;
    target.group.scale.setScalar(struckScale(now - target.hitAt));
    // Scale alone would leave a target that is hit while already gone showing
    // nothing at all; visibility is what keeps the scoring ray honest about it.
    target.group.visible = target.group.scale.x > 0.001;
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
      focus.update(bow.bowWrist, dt);
      wantFov = lerp(FOV_SLACK, FOV_FULL, bow.draw) / (1 + (FOCUS_MAX_ZOOM / 100) * focus.value);
      // Whichever hand archery.js chose stays authoritative all the way through
      // the shared aiming controller; the host never guesses handedness again.
      bowAim.update(bow.bowWrist, bow.draw, now, aimFov / FOV_SLACK);
    } else {
      focus.forget();
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

  drawPreview(frame, bow);
  drawPanel(frame, bow, bowSign, armed);
  renderer.render(scene, camera);
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
  // NOTE: the count is deliberately NOT forgotten here, and that is a live bug,
  // not a decision. A settled two outlives the hand that made it, so the frame a
  // second hand comes back into view can arm the bow without anyone having asked
  // -- the same fault input-mode.js was carrying, which forgetSign() exists to
  // fix. It is left alone only because clearing it changes WHEN the bow comes
  // up, and that was already demonstrated to somebody. Two lines when it can
  // change: forgetSign(signs.left) and forgetSign(signs.right).
  if (hands?.length !== 2) return null;
  const read = readBow(hands);
  // By the body where it could say. archery.js keeps `side` sorted by x on
  // purpose and that is right for the DRAW -- but these two states are indexed
  // by it, so one frame of the x order flipping would hand each hand the other
  // one's count.
  const side = read?.bow ? sideOf(read.bow) : null;
  if (!side || !signs[side]) return null;
  return { side, sign: handSign(read.bow.landmarks, signs[side]) };
}

// ─── The preview ─────────────────────────────────────────────────────────────
//
// What the lens sees, with what the tracker made of it drawn on top. The two
// have to be in the same picture: a skeleton alone cannot tell you the model has
// locked onto the lamp behind you, and a picture alone cannot tell you the
// skeleton is a hand's width off.
//
// The bow hand is coloured differently from the string hand, and the colour is
// archery.js's OWN answer rather than a second guess -- so if the range has the
// two the wrong way round, this is where you see it, and you see it before you
// have wasted ten arrows wondering why the draw will not read.
/**
 * A word on the preview, the right way round.
 *
 * The canvas is flipped by CSS so the landmarks land over a mirrored picture,
 * and everything drawn into it inherits that -- including text, which comes out
 * backwards and unreadable. It was, for a while: "no camera — H to retry"
 * rendered as "yrter ot H — aremac on" and nobody could have read it.
 *
 * Pre-flipping cancels the CSS one, and `x` still means "from the left of the
 * box as you see it".
 */
function label(text, x, y, colour, w) {
  scanCtx.save();
  scanCtx.translate(w, 0);
  scanCtx.scale(-1, 1);
  scanCtx.font = "500 10px 'IBM Plex Mono', monospace";
  scanCtx.fillStyle = colour;
  scanCtx.fillText(text, x, y);
  scanCtx.restore();
}

const BOW_HAND = '#ffd98a';
const STRING_HAND = '#8cc9ff';
const LOST = '#ff6b6b';

function drawPreview(frame, bow) {
  if (!scan || !scanCtx) return;
  video.classList.toggle('is-tucked', !showCamera);
  scan.hidden = !showCamera;
  if (!showCamera) return;

  // ── The empty case is the one this exists for ──
  //
  // Returning early on "no stream yet" put the one message that matters --
  // there is no camera -- behind the very condition it describes. A blank box
  // in the corner is exactly as uninformative as the 1x1 pixel it replaced.
  const w = video.clientWidth || 232;
  const live = video.videoWidth > 0;
  const h = live ? Math.round(w * video.videoHeight / video.videoWidth) : Math.round(w * 0.75);
  if (scan.width !== w || scan.height !== h) { scan.width = w; scan.height = h; }
  scan.style.height = `${h}px`;
  scanCtx.clearRect(0, 0, w, h);
  if (!live) {
    label(tracking ? 'waiting for a frame' : 'no camera — H to retry', 6, 14, LOST, w);
    return;
  }

  // The tracker un-mirrors x on the way in and the preview is mirrored back by
  // CSS, so these go on flipped, which lands them over the real thing.
  const at = p => [(1 - p.x) * w, p.y * h];

  const hands = frame.hands ?? [];
  for (const hand of hands) {
    // Which hand archery.js decided is holding the bow. Compared by the WRIST
    // it handed out rather than by side: `bowWrist` is the very object off that
    // hand, and taking its answer is the point -- deciding handedness a second
    // time here is how a panel ends up disagreeing with the shot. Only
    // meaningful with a pair; with one hand there is nothing to be the other.
    const isBow = Boolean(bow && hands.length === 2 && hand.wrist === bow.bowWrist);
    const colour = hands.length === 2 ? (isBow ? BOW_HAND : STRING_HAND) : '#d9e2f2';
    drawHand(scanCtx, hand, at, { bone: colour, tip: '#57e08a' }, 2);
  }
  drawFace(scanCtx, frame.head, at, { live: BOW_HAND, cold: LOST }, 2);

  // ── And it must say when it sees nothing ──
  //
  // A blank preview is ambiguous in the one way that matters: a camera that
  // failed and a camera watching an empty room look the same. Naming it is the
  // difference between "move into frame" and "something is broken".
  if (!hands.length) {
    label(tracking ? 'no hands' : 'camera off — H', 6, 14, LOST, w);
  } else if (hands.length === 1) {
    label('one hand — the bow needs two', 6, 14, '#b8894a', w);
  } else {
    label('bow', 6, 14, BOW_HAND, w);
    label('string', 34, 14, STRING_HAND, w);
  }
}

// ─── One line, in the middle, saying what to do next ─────────────────────────
//
// Everything this room knows how to teach was already written down -- in the
// card in the corner, in prose, in a serif, at eleven pixels. That is a fine
// place for it right up until the moment somebody stands two metres back with
// both hands in the air, which is the only position from which this room is
// used. You cannot read a paragraph while aiming, and you should not have to:
// there is exactly one thing to do at any moment and the range knows which.
//
// So the card explains, and this INSTRUCTS -- one step at a time, in the middle
// of the screen, big enough to read from where you are standing. It goes quiet
// the moment the bow is drawn and ready, because at that point the crosshair is
// the only thing worth looking at and a caption over it is noise.
const STEPS = Object.freeze({
  camera:  'PRESS H TO START THE CAMERA',
  hands:   'BOTH HANDS IN FRAME',
  sign:    'TWO FINGERS ON YOUR BOW HAND',
  nock:    'CLOSE YOUR OTHER HAND ON THE STRING',
  draw:    'PULL YOUR HANDS APART',
  hold:    'HOLD IT STILL',
  loose:   'OPEN YOUR STRING HAND TO LOOSE',
});

/** Which one of them is true right now. Null once there is nothing to say. */
function currentStep(frame, bow, armed) {
  if (!tracking) return STEPS.camera;
  const hands = frame.hands?.length ?? 0;
  if (hands < 2) return STEPS.hands;
  if (!armed) return STEPS.sign;
  if (bow?.phase !== 'nocked') return STEPS.nock;
  // Draw first, then the hold: pulling apart while being told to hold still is
  // two instructions at once, and the draw is the one that is not finished.
  if (bow.draw < 0.45) return STEPS.draw;
  if (bow.held < MIN_HOLD_MS) return STEPS.hold;
  return STEPS.loose;
}

function drawStep(frame, bow, armed) {
  const step = currentStep(frame, bow, armed);
  if (!step) return;
  // Low and centred: out of the way of the targets, above the key legend, and
  // on the line your eye already travels down when you look at your own hands.
  const ready = step === STEPS.loose;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.letterSpacing = '0.22em';
  ctx.font = `${ready ? 700 : 500} 15px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = ready ? GOLD : '#93a1bd';
  ctx.fillText(step, innerWidth / 2, innerHeight - 74);
  ctx.restore();
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
  drawStep(frame, bow, armed);
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
  line('ESC  menu      R  reset      P  readout      C  camera      H  retry camera',
    26, h - 26, '#5d6b86', 11);
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
    line(`focus           ${(focus.value * 100).toFixed(0)}%  of ${FOCUS_MAX_ZOOM}%   lens ${aimFov.toFixed(1)}°`,
      34, top + 138, focus.value > 0.6 ? GOLD : DIM);
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
  line(`fov ${camera.fov.toFixed(1)}°   still ${FOCUS.FLOOR}..${FOCUS.SPEED}`, 34, top + 194, '#5d6b86', 10);
  line(`DRAW_MIN ${BOW.DRAW_MIN}   DRAW_FULL ${BOW.DRAW_FULL}   max zoom ${FOCUS_MAX_ZOOM}%`, 34, top + 208, '#5d6b86', 10);
  line(`min hold ${(MIN_HOLD_MS / 1000).toFixed(2)}s   tracking ${cvHz.toFixed(0)} Hz`,
    34, top + 222, cvHz > 20 ? '#5d6b86' : '#b8894a', 10);
  ctx.restore();
}

// ─── Boot ────────────────────────────────────────────────────────────────────

function resize() {
  // ── Never size to nothing ──
  //
  // A hidden tab, a minimised window and a machine waking from sleep all report
  // innerWidth 0 for a while. Sized from that, the overlay canvas becomes 0x0 --
  // and a 0x0 canvas draws NOTHING AND THROWS NOTHING. The scoreboard, the
  // instruction line and the key legend just stop being there.
  //
  // Then nothing puts them back, because coming out of that state does not
  // always fire a `resize`. The 3D keeps rendering and the camera preview keeps
  // updating, since neither uses this canvas, so the page looks perfectly alive
  // with half its interface gone -- which is indistinguishable from having been
  // broken by whatever changed last.
  //
  // Keeping the last good size costs one comparison and removes the whole
  // class. Reproduced here at zero width with the 3D still running.
  if (!(innerWidth > 0 && innerHeight > 0)) return;

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
  if (event.code === 'KeyC') { showCamera = !showCamera; status = showCamera ? 'camera on' : 'camera off'; }
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
