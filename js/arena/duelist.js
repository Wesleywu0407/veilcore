import * as THREE from 'three';
import { createArmIK } from './arm-ik.js';
import { constrainRuneReach } from './reach-limit.js';

const MASK = 0xf1eadb;

// Ground speed the run clip actually depicts, in world units per second, measured
// from the left foot's swing relative to the hips over one cycle. Most of Meshy's
// library sits near 2.8, which forced nearly 2x playback; action 16 RunFast is
// the outlier at 4.8 and is why this clip was chosen -- it also swings its arms
// 70% further and, unlike the basic running clip, does not sink its toes through
// the floor.
const RUN_CLIP_SPEED = 4.8;
// Past roughly double, the legs churn faster than they read as legs. Better to
// let a little slide back in than to blur them.
const MAX_RUN_TIMESCALE = 2;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const lerp = (a, b, t) => a + (b - a) * t;

// Radians per second of turn, as an exponential rate: about 90% of the way round
// in a fifth of a second. Fast enough that the duelist still feels keyboard
// responsive, slow enough to read as a body turning rather than a cut.
const TURN_RATE = 11;

// How fast the arm takes over and lets go.
const REACH_FADE = 14;
// How hard the hand chases the point it was given, as an exponential rate.
// High enough that the arm still feels attached to the stroke, low enough that
// landmark jitter and the camera easing into the casting shot do not both
// arrive at the shoulder unfiltered.
const REACH_TRACK = 18;

// ── The draw ─────────────────────────────────────────────────────────────────
//
// A drawn bow is a pose that has to track `draw` continuously, which is why it
// is solved rather than played. A baked clip could only be scrubbed by draw,
// and scrubbing a clip backwards through its own easing does not look like a
// bow coming back -- it looks like a video rewinding.
//
// Everything below is a fraction of the arm's own measured length, not a world
// distance, so it survives the model being regenerated at a different scale.
// Local axes here: +Z is forward (see face()), +Y up, and +X is the duelist's
// LEFT -- screen-right is -X, which is why `side` is negated for a right hand.
const DRAW_POSE = {
  // The bow arm is nearly straight. Not fully: at exactly upper+fore the IK's
  // bend axis is undefined and the elbow pops, and a real archer keeps a soft
  // elbow anyway. These three are held at 0.908 of armReach between them, which
  // is that deliberate softness -- move one and move another to pay for it.
  //
  // `bowRise` is set so the bow hand lands at the duelist's own eye height,
  // which is where an archer holds it and, since the duel sights down this arm
  // in first person, where the bow has to be to sit on the line you are looking
  // along. Measured off the rig: the shoulder is 285.58 and the eye 315.50, a
  // gap of 29.92 against an armReach of 104.041. At the old 0.06 the hand sat
  // 14.4 degrees below the eye, which put it in the bottom corner of the frame.
  // bowExtend is 0.8548 rather than 0.90 to pay for the lift; the hand comes
  // back toward the body by 0.048, which is nothing, and the elbow keeps its
  // bend.
  bowExtend: 0.8548,
  bowRise: 0.288,     // the bow hand rides at eye height
  bowSpread: 0.10,    // out toward the bow side

  // Where the string hand ends up at full draw: the classic anchor, at the jaw.
  // `anchorSide` is negative because the hand comes IN toward the face, not out
  // past the shoulder -- measured, the first guess put the wrist at x -0.509
  // against a shoulder at -0.274, which is an elbow-out chicken wing rather
  // than an anchor.
  anchorForward: 0.06,
  anchorRise: 0.21,
  anchorSide: -0.14,

  // At slack the hands are together at the bow, which is what nocking looks
  // like. The whole pose is a lerp between here and the anchor, so the body
  // reads the draw the player is actually holding.
  nockedForward: 0.66,

  fade: 12,           // how fast the pose takes the arms over and gives them back
};

// ── The punch ────────────────────────────────────────────────────────────────
//
// Solved for the same reason the draw is: the arm has to track how far the
// player's own fist is pushed at the lens, continuously, and there is no punch
// clip on this rig to scrub even if there were one worth scrubbing. Both arms
// are held here whenever the fists are up -- the idle hand is holding a guard,
// which is a pose too, and leaving it on the animation would have one arm
// boxing while the other jogged.
//
// Same axes and same units as DRAW_POSE: fractions of the arm's own measured
// length, +Z forward, +X the duelist's LEFT.
const PUNCH_POSE = {
  // Guard. Fists in close, at 0.428 of the arm -- a folded elbow, not a held
  // one. Sat just under the eye line rather than on it so that the guard rests
  // at the bottom of the frame in first person and a punch travels UP onto the
  // sightline, which is what makes the throw read as a throw from inside the
  // player's own head.
  guardForward: 0.30,
  guardRise: 0.26,
  guardSpread: 0.16,

  // Extended. reachRise matches DRAW_POSE.bowRise exactly: eye height, for the
  // same reason the bow hand is there -- it is the only height that keeps the
  // fist in shot all the way out. reachSpread brings the hand in toward the
  // centre line the way a straight punch crosses, and reachForward is then
  // whatever leaves the three of them at 0.908 of the arm, the same deliberate
  // soft-elbow margin the draw is held at. Move one and move another to pay
  // for it, or the IK straightens the arm and the elbow pops.
  reachForward: 0.8602,
  reachRise: 0.288,
  reachSpread: 0.04,

  fade: 14,           // a shade quicker than the draw: fists come up, bows are raised
};

// Signed shortest angle from `from` to `to`, so a turn never takes the long way.
const shortAngle = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

// Bones an arm owns once IK is driving it. The clavicle is included: leaving it
// animated swings the whole arm from its root, which the solver then has to
// chase, and chasing it is what the shake was.
const ARM_BONES = {
  right: /^Right(Shoulder|Arm|ForeArm|Hand)$/,
  both: /^(Left|Right)(Shoulder|Arm|ForeArm|Hand)$/,
};

/**
 * The same clip with one side's arm tracks dropped, or both.
 *
 * Only ever strip an arm that something is about to drive. Stripping both for
 * a rune -- which only ever moves the right arm -- left the left arm with no
 * animation and no solver, so it fell back to the bind pose and the duelist
 * drew with one hand raised over its head.
 *
 * Cached on the clip so a duelist that respawns does not rebuild them.
 */
function withoutArms(clip, which) {
  clip.userData = clip.userData ?? {};
  clip.userData.masked = clip.userData.masked ?? {};
  if (clip.userData.masked[which]) return clip.userData.masked[which];
  const pattern = ARM_BONES[which];
  const tracks = clip.tracks.filter(track => !pattern.test(track.name.split('.')[0]));
  const masked = new THREE.AnimationClip(`${clip.name}__${which}`, clip.duration, tracks);
  clip.userData.masked[which] = masked;
  return masked;
}

/**
 * Lightweight art gate. The Meshy GLB will replace only this factory's
 * internals; movement, hit detection, team colour, and animation calls stay
 * behind the same object.
 */
/**
 * The light the duelist casts with. The concept art has no staff and no wand --
 * the magic forms at the fingertips -- so an empty hand tracing a rune is the
 * one thing the character must not look like. Additive and depth-write off so
 * it reads as light rather than as a plastic bead stuck to the glove.
 */
function buildCastSpark(colour) {
  const group = new THREE.Group();
  const glow = () => new THREE.MeshBasicMaterial({
    color: colour, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), glow());
  group.add(core);

  const sigils = new THREE.Group();
  const shard = new THREE.PlaneGeometry(0.055, 0.055);
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const sigil = new THREE.Mesh(shard, glow());
    sigil.position.set(Math.cos(angle) * 0.19, Math.sin(angle) * 0.19, 0);
    sigil.rotation.z = angle;
    sigils.add(sigil);
  }
  group.add(sigils);
  group.visible = false;
  return { group, core, sigils };
}

export function createDuelist(scene, { colour = 0xffd98a, name = 'Duelist' } = {}) {
  const root = new THREE.Group();
  root.name = name;

  const cloth = new THREE.MeshStandardMaterial({ color: 0x111522, roughness: 0.72, metalness: 0.16 });
  const armour = new THREE.MeshStandardMaterial({ color: 0x242b3b, roughness: 0.5, metalness: 0.58 });
  const porcelain = new THREE.MeshStandardMaterial({ color: MASK, roughness: 0.68, metalness: 0.02 });
  const team = new THREE.MeshStandardMaterial({
    color: colour, emissive: colour, emissiveIntensity: 1.45,
    roughness: 0.35, metalness: 0.35,
  });

  const hips = new THREE.Group();
  hips.position.y = 1.75;
  root.add(hips);

  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.65, 1.45, 10), cloth);
  torso.position.y = 0.55;
  hips.add(torso);

  const chest = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), team);
  chest.position.set(0, 0.64, 0.51);
  hips.add(chest);

  const coat = new THREE.Mesh(new THREE.CylinderGeometry(0.64, 0.9, 1.22, 8, 1, true), cloth);
  coat.position.y = -0.45;
  hips.add(coat);

  const shoulderGeometry = new THREE.SphereGeometry(0.32, 10, 7, 0, Math.PI * 2, 0, Math.PI / 2);
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Mesh(shoulderGeometry, armour);
    shoulder.position.set(side * 0.68, 0.97, 0);
    shoulder.rotation.z = side * -0.28;
    hips.add(shoulder);
  }

  const limbGeometry = new THREE.CapsuleGeometry(0.14, 0.92, 4, 8);
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(limbGeometry, cloth);
    arm.position.set(side * 0.68, 0.25, 0);
    arm.rotation.z = side * -0.08;
    hips.add(arm);

    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.18, 1.25, 4, 8), cloth);
    leg.position.set(side * 0.28, -1.55, 0);
    hips.add(leg);
  }

  // The sealed porcelain helm is intentionally a complete shell, not a face
  // pasted onto a placeholder head. This preserves the decision made during
  // Meshy review and gives the proxy the same read from behind.
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 12), porcelain);
  helm.scale.set(0.82, 1.08, 0.72);
  helm.position.set(0, 1.7, 0);
  hips.add(helm);

  const eyeGeometry = new THREE.BoxGeometry(0.16, 0.035, 0.025);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeometry, team);
    eye.position.set(side * 0.12, 1.73, 0.275);
    eye.rotation.z = side * -0.12;
    hips.add(eye);
  }

  root.traverse(object => {
    if (!object.isMesh) return;
    object.castShadow = true;
    object.receiveShadow = true;
  });
  scene.add(root);

  let stride = 0;
  let hit = 0;
  let targetYaw = 0;
  let armIK = null;        // the right arm — the rune hand, and the bow's string hand
  let leftIK = null;       // the left arm, only ever used by the draw
  let castSpark = null;
  let chargeGlow = 0;
  let castSparkEnabled = true;
  const _sparkPos = new THREE.Vector3();
  const _reachLocal = new THREE.Vector3();
  const _bowHand = new THREE.Vector3();
  const _stringHand = new THREE.Vector3();
  const _nock = new THREE.Vector3();
  const _fist = new THREE.Vector3();
  // A stable body-space parent for the bow mesh. Following the solved wrist
  // position without inheriting the terminal hand bone's twist keeps the limbs
  // vertical and the arrow aligned with the duelist's forward axis.
  const bowAnchor = new THREE.Group();
  bowAnchor.name = `${name} bow anchor`;
  bowAnchor.rotation.y = Math.PI; // bow-view's arrow is local -Z; the duelist faces +Z
  root.add(bowAnchor);
  let armReach = 0;          // arm length, measured from the rig
  let shoulderLocal = null;  // right shoulder position in root space
  let leftShoulderLocal = null;
  // The draw, or null when the bow is down. Held as a whole pose rather than a
  // number so the side can change: archery.js picks the string hand from which
  // hand the player actually closed, and the body should copy that rather than
  // insist on a right-handed stance.
  let drawPose = null;
  let drawWeight = 0;
  const lastDraw = { draw: 0, stringSide: 'right' };
  // The fists, or null when they are down. Both extensions travel together in
  // one object for the same reason the draw does: they are one stance, and the
  // guard arm's pose is only meaningful beside the arm that is throwing.
  let punchPose = null;
  let punchWeight = 0;
  const lastPunch = { left: 0, right: 0 };
  let reachTarget = null;    // world Vector3, or null to let the animation have the arm back
  let reachWeight = 0;
  const lastReach = new THREE.Vector3();   // kept so the fade-out has somewhere to go
  let imported = null;
  let headBone = null;
  let eyeLocal = null;   // the head's REST position in root space, measured at load
  let mixer = null;
  let actions = null;
  let activeAction = null;
  // Cast and Hit own the body until they finish. While one is running, update()
  // stops arbitrating between idle and run — otherwise the locomotion switch
  // would cut the reaction off on the very next frame.
  let oneShot = null;

  function play(action) {
    if (!action || action === activeAction) return;
    action.reset().fadeIn(0.18).play();
    activeAction?.fadeOut(0.18);
    activeAction = action;
  }

  // Unlike play(), this restarts an action that is already active: casting
  // twice in a row has to replay rather than be swallowed as a no-op.
  function playOnce(action) {
    if (!action) return;
    if (activeAction && activeAction !== action) activeAction.fadeOut(0.12);
    action.reset().fadeIn(0.12).play();
    activeAction = action;
    oneShot = action;
  }

  return {
    root,
    bowAnchor,
    radius: 0.75,
    height: 3.45,
    setPosition(position) { root.position.copy(position); },
    face(direction) {
      // Record the intent only. Assigning rotation.y here teleported the duelist
      // through every turn: the caller faces the rival while standing still and
      // the movement direction while moving, so each press and release of a
      // direction key snapped the body through ninety degrees or more.
      if (Math.hypot(direction.x, direction.z) > 1e-4) targetYaw = Math.atan2(direction.x, direction.z);
    },
    /**
     * Hold the hand at a WORLD point, or null to give the arm back to the
     * animation. It takes a world point rather than screen coordinates on
     * purpose: only the caller owns the camera, and mapping the stroke onto a
     * body-relative square here put the hand somewhere with no visible relation
     * to the line the player was drawing. The caller unprojects; this just
     * reaches.
     */
    reach(point, charge = 0, showCastSpark = true) {
      chargeGlow = clamp(charge, 0, 1);
      castSparkEnabled = showCastSpark;
      // A single non-finite frame used to be harmless, because the target was
      // overwritten wholesale every frame. It is not harmless now that update()
      // EASES toward it: one NaN would be lerped into `lastReach` and stay
      // there for good, the solve would write NaN rotations into the skeleton,
      // and a skinned mesh with NaN in its bone matrices takes the whole frame
      // down with it. Tracking does hand out the occasional bad point, so this
      // is a real path and not a theoretical one.
      if (point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) {
        // A screen point is not automatically a place a shoulder can reach.
        // Keep the right hand in front of the chest and stop it at the far side
        // of the sternum; otherwise the analytic IK quite correctly solves an
        // impossible request by wrapping the elbow through the body.
        let limitedPoint = point;
        if (shoulderLocal && armReach > 0) {
          root.updateMatrixWorld(true);
          _reachLocal.copy(point);
          root.worldToLocal(_reachLocal);
          constrainRuneReach(_reachLocal, shoulderLocal, armReach, _reachLocal);
          root.localToWorld(_reachLocal);
          limitedPoint = _reachLocal;
        }
        reachTarget = reachTarget ?? new THREE.Vector3();
        reachTarget.copy(limitedPoint);
        // The first frame snaps, so the arm does not fly in from wherever it
        // was left last time.
        if (reachWeight <= 0.01) lastReach.copy(limitedPoint);
      } else if (!point) {
        reachTarget = null;
      }
      // A bad point while already reaching keeps the previous target: holding
      // still for a frame reads as tracking, dropping the arm reads as a bug.
    },
    get reaching() { return reachWeight > 0.01; },
    /**
     * World position of the casting hand, or null before the rig has loaded.
     * Handed out because the spell effects have to form AT the hand, and a
     * second guess made from the body's position drifts away from the arm the
     * moment IK moves it.
     */
    handWorld(out) {
      if (!armIK) return null;
      root.updateMatrixWorld(true);
      armIK.bones.wrist.getWorldPosition(out);
      return out;
    },
    /**
     * World position of the bow hand, for a camera that has to frame it.
     *
     * bowAnchor is the honest answer, but only once the draw solve has run --
     * it starts life at the root's own origin, so a camera asking too early
     * would magnify the duelist's feet. Until then, hand back the shoulder,
     * which is a point measured off the rig rather than a guess at one, and is
     * within an arm's length of where the bow is about to be.
     */
    bowHandWorld(out) {
      root.updateMatrixWorld(true);
      if (drawWeight > 0.01) return bowAnchor.getWorldPosition(out);
      if (shoulderLocal) return root.localToWorld(out.copy(shoulderLocal));
      return out.copy(root.position).setY(root.position.y + 2.4);
    },
    /**
     * The eye, for a camera that wants to look out of this duelist's head.
     *
     * Deliberately NOT the live Head bone. Head is animated in all three clips,
     * so reading it every frame feeds the idle sway and the run bob straight
     * into the lens -- and in first person that does not read as head movement,
     * it reads as the BOW drifting, because the bow is rigid in this body's own
     * space and the camera is the only thing moving. What is used instead is
     * where the head sits at rest, measured off the rig once at load, which
     * gives the same eye in the same place with none of the animation.
     */
    eyeWorld(out) {
      root.updateMatrixWorld(true);
      if (eyeLocal) return root.localToWorld(out.copy(eyeLocal));
      return out.copy(root.position).setY(root.position.y + 3.15);
    },
    /**
     * The bow arm's elbow -- the middle beat of a camera move that travels down
     * the arm. Which physical arm that is follows the stance, the same way the
     * draw solve picks it.
     */
    bowElbowWorld(out) {
      const chain = lastDraw.stringSide === 'right' ? leftIK : armIK;
      if (!chain) return null;
      root.updateMatrixWorld(true);
      return chain.bones.elbow.getWorldPosition(out);
    },
    /**
     * Hold a bow at `draw` (0 slack, 1 full), with the string on `stringSide`.
     * Pass null to put it away and give the arms back to the animation.
     *
     * Deliberately not a world point like reach(): the draw is a POSE, and the
     * two wrists are not independent -- the string hand's whole meaning is
     * where it sits relative to the bow hand. Handing the caller two targets
     * would let them drift into positions no archer can hold.
     */
    drawBow(draw, stringSide = 'right') {
      if (draw === null || draw === undefined) {
        drawPose = null;
        return;
      }
      lastDraw.draw = clamp(draw, 0, 1);
      lastDraw.stringSide = stringSide === 'left' ? 'left' : 'right';
      drawPose = lastDraw;
    },
    get drawing() { return drawWeight > 0.01; },
    /**
     * Hold both fists, each at its own extension (0 guard, 1 thrown), or pass
     * null to drop them and give the arms back to the animation.
     *
     * Takes both sides at once rather than one call per hand because the two
     * arms are a single stance: a caller that could set them independently
     * could also leave one of them stale, and a duelist holding a guard it was
     * told about two seconds ago is worse than one holding no guard at all.
     */
    punch(extensions) {
      if (!extensions) {
        punchPose = null;
        return;
      }
      lastPunch.left = clamp(Number.isFinite(extensions.left) ? extensions.left : 0, 0, 1);
      lastPunch.right = clamp(Number.isFinite(extensions.right) ? extensions.right : 0, 0, 1);
      punchPose = lastPunch;
    },
    get punching() { return punchWeight > 0.01; },
    flash() {
      hit = 1;
      // A stagger outranks whatever the body was doing, a cast included.
      playOnce(actions?.hit);
    },
    cast() {
      // ...but a spell never cuts a stagger short, or trading blows would let
      // the duelist animate straight out of being hit.
      if (oneShot && oneShot === actions?.hit) return;
      playOnce(actions?.cast);
    },
    replaceVisual(model, clips = []) {
      if (imported) imported.removeFromParent();
      imported = model;
      imported.name = `${name} Meshy model`;
      imported.traverse(object => {
        if (!object.isMesh) return;
        object.castShadow = true;
        object.receiveShadow = true;
        if (object.material) object.material = object.material.clone();
      });
      // Box3.setFromObject() reaches SkinnedMesh.computeBoundingBox(), which
      // evaluates the skin through the bones' matrixWorld -- and caches the
      // result. On a clone that has never been through a render pass those
      // matrices are still identity, so the box comes out at 0.509 instead of
      // 1.700 and the duelist is scaled 3.3x too tall. Update the hierarchy
      // first; the cached box is then computed from a real pose.
      imported.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(imported);
      const size = box.getSize(new THREE.Vector3());
      const targetHeight = 3.5;
      imported.scale.setScalar(targetHeight / Math.max(size.y, 0.001));
      box.setFromObject(imported);
      const centre = box.getCenter(new THREE.Vector3());
      imported.position.set(-centre.x, -box.min.y, -centre.z);
      hips.visible = false;
      root.add(imported);

      // The pole is where the elbow is told to live, in the character's own
      // space: down, and behind. Without it the bend plane comes from whatever
      // the animation happened to be doing, so a running duelist draws with an
      // elbow that orbits its own wrist.
      headBone = imported.getObjectByName('Head');
      if (headBone) {
        root.updateMatrixWorld(true);
        eyeLocal = root.worldToLocal(headBone.getWorldPosition(new THREE.Vector3()));
      }
      armIK = createArmIK(imported, {
        shoulder: 'RightArm', elbow: 'RightForeArm', wrist: 'RightHand',
        pole: new THREE.Vector3(-0.35, -1, -0.45).normalize(),
      });
      // The bow needs both arms: one holds it out, the other pulls the string.
      // The rune hand only ever needed the right, which is why armIK stayed
      // singular for so long -- it is kept as the right chain so nothing that
      // reaches has to change.
      leftIK = createArmIK(imported, {
        shoulder: 'LeftArm', elbow: 'LeftForeArm', wrist: 'LeftHand',
        pole: new THREE.Vector3(0.35, -1, -0.45).normalize(),
      });
      if (armIK) {
        root.updateMatrixWorld(true);
        const shoulder = new THREE.Vector3();
        const elbow = new THREE.Vector3();
        const wrist = new THREE.Vector3();
        armIK.bones.shoulder.getWorldPosition(shoulder);
        armIK.bones.elbow.getWorldPosition(elbow);
        armIK.bones.wrist.getWorldPosition(wrist);
        armReach = shoulder.distanceTo(elbow) + elbow.distanceTo(wrist);
        shoulderLocal = root.worldToLocal(shoulder.clone());
        castSpark = buildCastSpark(colour);
        root.add(castSpark.group);
      }
      if (leftIK) {
        root.updateMatrixWorld(true);
        const shoulder = new THREE.Vector3();
        leftIK.bones.shoulder.getWorldPosition(shoulder);
        leftShoulderLocal = root.worldToLocal(shoulder.clone());
      }

      const accent = new THREE.Mesh(
        new THREE.TorusGeometry(0.17, 0.025, 6, 24),
        team,
      );
      accent.position.set(0, 2.45, 0.34);
      root.add(accent);

      if (clips.length) {
        mixer = new THREE.AnimationMixer(imported);
        const find = pattern => clips.find(clip => pattern.test(clip.name));
        const idle = find(/idle/i) ?? clips[0];
        const run = find(/run|walk/i) ?? idle;
        actions = { idle: mixer.clipAction(idle), run: mixer.clipAction(run) };
        // Armless copies of the locomotion clips, for use while the hands are
        // busy. IK wins the final pose either way, but it can only correct what
        // the clip left -- and a clip that rewrites the arm every frame gives
        // it a different starting pose sixty times a second. Legs and spine
        // still animate, so the duelist runs; the arms simply stop being
        // argued over.
        // One pair per thing that can take the arms: a rune uses the right arm
        // only, a bow uses both.
        actions.idleRight = mixer.clipAction(withoutArms(idle, 'right'));
        actions.runRight = mixer.clipAction(withoutArms(run, 'right'));
        actions.idleBoth = mixer.clipAction(withoutArms(idle, 'both'));
        actions.runBoth = mixer.clipAction(withoutArms(run, 'both'));
        // A missing clip is survivable: the action stays undefined and
        // cast()/flash() degrade to the emissive flash on their own.
        for (const [key, clip] of [['cast', find(/cast/i)], ['hit', find(/hit/i)]]) {
          if (!clip) continue;
          const action = mixer.clipAction(clip);
          action.setLoop(THREE.LoopOnce, 1);
          // Hold the last frame rather than snapping back to the bind pose, so
          // the fade into idle starts from where the animation actually ended.
          action.clampWhenFinished = true;
          actions[key] = action;
        }
        oneShot = null;
        mixer.addEventListener('finished', event => {
          if (event.action === oneShot) oneShot = null;
        });
        play(actions.idle);
      }
    },
    update(dt, speed = 0, telegraph = 0) {
      // Turn toward the intent instead of snapping to it. Framerate-independent
      // exponential approach, taking the short way round so a turn across the
      // -pi/pi seam does not spin the long way.
      root.rotation.y += shortAngle(root.rotation.y, targetYaw) * Math.min(1, dt * TURN_RATE);
      stride += dt * (2.5 + speed * 0.75);
      hit = Math.max(0, hit - dt * 4.5);
      hips.position.y = 1.75 + Math.sin(stride) * Math.min(0.045, speed * 0.007);
      team.emissiveIntensity = 1.45 + hit * 4 + telegraph * 3.5;
      root.scale.set(1 + hit * 0.05, 1 - hit * 0.04, 1 + hit * 0.05);
      if (mixer) {
        // Hands busy -> the armless pair, so the clip stops fighting the solver.
        // A one-shot (cast, hit) still outranks both: those are whole-body
        // reactions and cutting their arms off would leave the duelist flinching
        // with one shoulder.
        if (!oneShot) {
          const moving = speed > 0.5;
          // Which mask, if any. Driven off the blend weights rather than off
          // the raw targets: the gate can flicker for a frame, and swapping
          // clips on a flicker restarts a crossfade every frame, which is its
          // own kind of broken.
          const masked = drawWeight > 0.01 || punchWeight > 0.01 ? 'both' : reachWeight > 0.01 ? 'right' : null;
          play(masked === 'both' ? (moving ? actions.runBoth : actions.idleBoth)
            : masked === 'right' ? (moving ? actions.runRight : actions.idleRight)
            : (moving ? actions.run : actions.idle));
        }
        // The run cycle depicts a body moving at RUN_CLIP_SPEED. Play it at a
        // fixed rate while the duelist travels at some other speed and the feet
        // skate -- at DUEL.playerSpeed of 8.5 that is a 3x mismatch, which is
        // what makes the run read as broken. Driving timeScale off the measured
        // speed plants the feet at any tuning, and every Meshy run clip tested
        // sat at the same ~2.9, so this holds if the clip is ever swapped.
        const runRate = clamp(speed / RUN_CLIP_SPEED, 0.4, MAX_RUN_TIMESCALE);
        for (const key of ['run', 'runRight', 'runBoth']) {
          if (actions[key]) actions[key].timeScale = runRate;
        }
        mixer.update(dt);
      }
      // After the mixer, never before: the clip writes the arm's bones every
      // frame, so IK applied first would simply be overwritten.
      drawWeight += ((drawPose ? 1 : 0) - drawWeight) * Math.min(1, dt * DRAW_POSE.fade);
      if (armIK && leftIK && shoulderLocal && leftShoulderLocal && drawWeight > 0.01) {
        root.updateMatrixWorld(true);
        // Which physical arm does which job. `side` is +1 toward the duelist's
        // left, because local +X is its left (see face()).
        const stringOnRight = lastDraw.stringSide === 'right';
        const stringIK = stringOnRight ? armIK : leftIK;
        const bowIK = stringOnRight ? leftIK : armIK;
        const stringShoulder = stringOnRight ? shoulderLocal : leftShoulderLocal;
        const bowShoulder = stringOnRight ? leftShoulderLocal : shoulderLocal;
        const stringSign = stringOnRight ? -1 : 1;
        const bowSign = -stringSign;

        // The bow arm holds still; only the string hand travels. That is what
        // a draw is, and animating both would read as a shrug.
        _bowHand.set(
          bowShoulder.x + bowSign * armReach * DRAW_POSE.bowSpread,
          bowShoulder.y + armReach * DRAW_POSE.bowRise,
          bowShoulder.z + armReach * DRAW_POSE.bowExtend,
        );

        // Slack: the string hand is up at the bow, which is what nocking looks
        // like. Full draw: back at the anchor beside the jaw.
        _nock.set(
          _bowHand.x,
          _bowHand.y,
          bowShoulder.z + armReach * DRAW_POSE.nockedForward,
        );
        _stringHand.set(
          stringShoulder.x + stringSign * armReach * DRAW_POSE.anchorSide,
          stringShoulder.y + armReach * DRAW_POSE.anchorRise,
          stringShoulder.z + armReach * DRAW_POSE.anchorForward,
        );
        _stringHand.lerpVectors(_nock, _stringHand, lastDraw.draw);

        bowAnchor.position.copy(_bowHand);

        // Solved, then re-read: the second solve needs the first arm's bones to
        // have been written through to matrixWorld, or it aims at a stale pose.
        bowIK.solve(root.localToWorld(_bowHand), drawWeight);
        root.updateMatrixWorld(true);
        stringIK.solve(root.localToWorld(_stringHand), drawWeight);
      }

      punchWeight += ((punchPose ? 1 : 0) - punchWeight) * Math.min(1, dt * PUNCH_POSE.fade);
      if (armIK && leftIK && shoulderLocal && leftShoulderLocal && punchWeight > 0.01) {
        root.updateMatrixWorld(true);
        for (const side of ['right', 'left']) {
          const chain = side === 'right' ? armIK : leftIK;
          const shoulder = side === 'right' ? shoulderLocal : leftShoulderLocal;
          // +1 is out toward the duelist's own left, so the right arm spreads
          // the other way. Same convention as the draw's stringSign.
          const sign = side === 'right' ? -1 : 1;
          const thrown = side === 'right' ? lastPunch.right : lastPunch.left;
          _fist.set(
            shoulder.x + sign * armReach * lerp(PUNCH_POSE.guardSpread, PUNCH_POSE.reachSpread, thrown),
            shoulder.y + armReach * lerp(PUNCH_POSE.guardRise, PUNCH_POSE.reachRise, thrown),
            shoulder.z + armReach * lerp(PUNCH_POSE.guardForward, PUNCH_POSE.reachForward, thrown),
          );
          chain.solve(root.localToWorld(_fist), punchWeight);
          // Re-read between arms: the second solve walks the skeleton and needs
          // the first one written through to matrixWorld, or it aims off a
          // stale pose. Same reason the draw does it.
          root.updateMatrixWorld(true);
        }
      }

      if (armIK) {
        // The bow owns the right arm while it is up, so the rune reach has to
        // let go of it -- otherwise a stale reach target fights the anchor and
        // the arm sits between the two, drawing nothing and holding nothing.
        const reachWanted = reachTarget && drawWeight <= 0.01 && punchWeight <= 0.01 ? 1 : 0;
        reachWeight += (reachWanted - reachWeight) * Math.min(1, dt * REACH_FADE);
        if (reachTarget) {
          lastReach.lerp(reachTarget, Math.min(1, dt * REACH_TRACK));
          // Belt and braces: if anything upstream still manages to poison the
          // ease, recover to the target rather than carrying NaN forward.
          if (!Number.isFinite(lastReach.x) || !Number.isFinite(lastReach.y) || !Number.isFinite(lastReach.z)) {
            lastReach.copy(reachTarget);
          }
        }
        if (reachWeight > 0.01) {
          root.updateMatrixWorld(true);
          armIK.solve(lastReach, reachWeight);
        }
        if (castSpark) {
          castSpark.group.visible = castSparkEnabled && reachWeight > 0.01;
          if (castSpark.group.visible) {
            // Positioned from the wrist's world transform each frame rather than
            // parented to the bone: the Armature carries a 0.01 scale, so a child
            // of the bone inherits it and every size here would be in whatever
            // units that rig happened to export in.
            root.updateMatrixWorld(true);
            armIK.bones.wrist.getWorldPosition(_sparkPos);
            castSpark.group.position.copy(root.worldToLocal(_sparkPos));
            castSpark.group.scale.setScalar((0.4 + chargeGlow * 1.3) * reachWeight);
            castSpark.sigils.rotation.z += dt * (1.1 + chargeGlow * 5);
            castSpark.core.material.opacity = (0.5 + chargeGlow * 0.5) * reachWeight;
            for (const sigil of castSpark.sigils.children) {
              sigil.material.opacity = (0.25 + chargeGlow * 0.75) * reachWeight;
            }
          }
        }
      }
    },
    dispose() {
      root.traverse(object => {
        object.geometry?.dispose?.();
      });
      for (const material of [cloth, armour, porcelain, team]) material.dispose();
      root.removeFromParent();
    },
  };
}
