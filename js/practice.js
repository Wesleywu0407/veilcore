// ─── Veilcore — practice range ───────────────────────────────────────────────
//
// A room with targets and no duel: no rival, no clock, no mana. It exists so the
// bow can be TUNED, which means every number archery.js measures is on the glass
// while you shoot. If the draw feels wrong, the panel says which constant is
// wrong.

import * as THREE from 'three';
import { buildEnvironment } from './arena/scene.js';
import { initTracker, getFrame, disposeTracker } from './spell-room/tracker.js';
import { createBowState, BOW } from './spell-room/archery.js';
import { createBowAim, AIM } from './spell-room/aim.js';
import { createBowView } from './arena/bow-view.js';
import { loadGLB } from './arena/asset-library.js';

const GOLD = '#ffd98a';
const BLUE = '#8ab4ff';
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

const glCanvas = document.querySelector('[data-range-gl]');
const overlay = document.querySelector('[data-range-overlay]');
const video = document.querySelector('[data-range-video]');
const startPanel = document.querySelector('[data-range-start]');
const startButton = document.querySelector('[data-range-enter]');
const errorLine = document.querySelector('[data-range-error]');
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

const bowState = createBowState();
const bowAim = createBowAim();
let running = false;
let tracking = false;
let status = 'idle';
const reticle = bowAim.reticle;
const lerp = (a, b, t) => a + (b - a) * t;
const shots = { fired: 0, hit: 0, lastPower: 0, lastMiss: null, lastRing: null };
let cvFrames = 0, cvAt = 0, cvHz = 0, lastFrameAt = 0;

const _ndc = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _ray = new THREE.Ray();
const _hit = new THREE.Vector3();
const _plane = new THREE.Plane();
const _normal = new THREE.Vector3(0, 0, -1);

function loose(power) {
  _ndc.set(reticle.x * 2 - 1, -(reticle.y * 2 - 1), 0.5).unproject(camera);
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
  if (tracking) {
    if (frame.at !== lastFrameAt) { lastFrameAt = frame.at; cvFrames += 1; }
    if (now - cvAt >= 500) { cvHz = cvFrames / ((now - cvAt) / 1000); cvFrames = 0; cvAt = now; }

    bow = bowState.update(frame.hands, now);

    if (bow.phase === 'nocked' && bow.bowWrist) {
      // Whichever hand archery.js chose stays authoritative all the way through
      // the shared aiming controller; the host never guesses handedness again.
      bowAim.update(bow.bowWrist, bow.draw, now);
    } else {
      bowAim.reset();
    }

    bowView.setVisible(frame.hands?.length === 2);
    bowView.setNocked(bow.phase === 'nocked');
    bowView.setDraw(bow.phase === 'nocked' ? bow.draw : 0);

    const fov = lerp(FOV_SLACK, FOV_FULL, bow.phase === 'nocked' ? bow.draw : 0);
    if (Math.abs(camera.fov - fov) > 0.05) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    if (bow.event?.type === 'loosed') loose(bow.event.power);
  }

  drawPanel(frame, bow);
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// ─── Panel ───────────────────────────────────────────────────────────────────

function line(text, x, y, colour = DIM, size = 11) {
  ctx.font = `500 ${size}px 'IBM Plex Mono', monospace`;
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}

function drawPanel(frame, bow) {
  const w = innerWidth, h = innerHeight;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.letterSpacing = '0.08em';

  ctx.fillStyle = 'rgba(6,9,17,.72)';
  ctx.fillRect(18, 18, 268, 228);
  line('BOW READOUT', 34, 42, BLUE, 11);

  const hands = frame.hands?.length ?? 0;
  line(`hands           ${hands}`, 34, 66, hands === 2 ? GOLD : '#b8894a');
  if (bow && hands === 2) {
    line(`phase           ${bow.phase}`, 34, 84, bow.phase === 'nocked' ? GOLD : DIM);
    line(`spans           ${bow.spans.toFixed(2)}`, 34, 102);
    line(`draw            ${(bow.draw * 100).toFixed(0)}%`, 34, 120, GOLD);
    line(`peak            ${(bow.peak * 100).toFixed(0)}%`, 34, 138);
    line(`angle           ${bow.angle.toFixed(0)}°`, 34, 156);
    // A draw bar, with the tuning window marked on it.
    const bx = 34, by = 168, bw = 232;
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    ctx.fillRect(bx, by, bw, 5);
    ctx.fillStyle = GOLD;
    ctx.fillRect(bx, by, bw * bow.draw, 5);
  } else {
    line('both hands in frame', 34, 84, '#b8894a');
    line('to read a draw', 34, 102, '#b8894a');
  }
  line(`fov ${camera.fov.toFixed(0)}°   gain ${AIM.gain}`, 34, 192, '#5d6b86', 10);
  line(`DRAW_MIN ${BOW.DRAW_MIN}   DRAW_FULL ${BOW.DRAW_FULL}`, 34, 206, '#5d6b86', 10);
  line(`tracking ${cvHz.toFixed(0)} Hz`, 34, 222, cvHz > 20 ? '#5d6b86' : '#b8894a', 10);

  ctx.fillStyle = 'rgba(6,9,17,.72)';
  ctx.fillRect(18, 258, 268, 104);
  line('SHOTS', 34, 282, BLUE, 11);
  const pct = shots.fired ? ((shots.hit / shots.fired) * 100).toFixed(0) : '—';
  line(`fired           ${shots.fired}`, 34, 306);
  line(`hit             ${shots.hit}  (${pct}%)`, 34, 324, GOLD);
  line(`last power      ${(shots.lastPower * 100).toFixed(0)}%`, 34, 342);
  line(`last miss       ${shots.lastMiss === null ? '—' : shots.lastMiss.toFixed(2) + ' m'}`, 34, 360);

  // Reticle
  if (tracking && bow?.phase === 'nocked') {
    const x = reticle.x * w, y = reticle.y * h;
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 14 + bow.draw * 16, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 22, y); ctx.lineTo(x - 8, y);
    ctx.moveTo(x + 8, y); ctx.lineTo(x + 22, y);
    ctx.moveTo(x, y - 22); ctx.lineTo(x, y - 8);
    ctx.moveTo(x, y + 8); ctx.lineTo(x, y + 22);
    ctx.stroke();
  }

  // Both hands, drawn where they are, with the string line between them
  if (frame.hands?.length) {
    for (const hand of frame.hands) {
      ctx.beginPath();
      ctx.arc(hand.wrist.x * w, hand.wrist.y * h, 7, 0, Math.PI * 2);
      ctx.fillStyle = hand === frame.hands[0] ? BLUE : GOLD;
      ctx.fill();
    }
    if (frame.hands.length === 2) {
      const [a, b] = frame.hands;
      ctx.beginPath();
      ctx.moveTo(a.wrist.x * w, a.wrist.y * h);
      ctx.lineTo(b.wrist.x * w, b.wrist.y * h);
      ctx.strokeStyle = 'rgba(255,230,184,.45)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  ctx.textAlign = 'right';
  line(status, w - 26, h - 26, GOLD, 12);
  ctx.textAlign = 'left';
  line('R  reset counters      H  retry camera', 26, h - 26, '#5d6b86', 11);
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

addEventListener('keydown', (event) => {
  if (event.code === 'KeyR') { shots.fired = 0; shots.hit = 0; shots.lastMiss = null; status = 'counters reset'; }
  if (event.code === 'KeyH') void startTracking();
});

async function startTracking() {
  try {
    status = 'waking the camera';
    await initTracker(video, (stage) => { status = stage; });
    tracking = true;
    status = 'ready — both hands up';
  } catch (error) {
    tracking = false;
    status = `camera: ${error.message}`;
    if (errorLine) { errorLine.hidden = false; errorLine.textContent = error.message; }
  }
}

startButton?.addEventListener('click', async () => {
  startPanel.hidden = true;
  running = true;
  resize();
  requestAnimationFrame(loop);
  await startTracking();
});

addEventListener('beforeunload', () => disposeTracker());
