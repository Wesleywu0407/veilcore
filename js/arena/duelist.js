import * as THREE from 'three';
import { createArmIK } from './arm-ik.js';

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

// Radians per second of turn, as an exponential rate: about 90% of the way round
// in a fifth of a second. Fast enough that the duelist still feels keyboard
// responsive, slow enough to read as a body turning rather than a cut.
const TURN_RATE = 11;

// How fast the arm takes over and lets go.
const REACH_FADE = 14;

// Signed shortest angle from `from` to `to`, so a turn never takes the long way.
const shortAngle = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

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
  let armIK = null;
  let castSpark = null;
  let chargeGlow = 0;
  const _sparkPos = new THREE.Vector3();
  let armReach = 0;          // arm length, measured from the rig
  let shoulderLocal = null;  // shoulder position in root space
  let reachTarget = null;    // world Vector3, or null to let the animation have the arm back
  let reachWeight = 0;
  const lastReach = new THREE.Vector3();   // kept so the fade-out has somewhere to go
  let imported = null;
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
    reach(point, charge = 0) {
      chargeGlow = clamp(charge, 0, 1);
      if (point) {
        reachTarget = reachTarget ?? new THREE.Vector3();
        reachTarget.copy(point);
        lastReach.copy(point);
      } else {
        reachTarget = null;
      }
    },
    get reaching() { return reachWeight > 0.01; },
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

      armIK = createArmIK(imported, { shoulder: 'RightArm', elbow: 'RightForeArm', wrist: 'RightHand' });
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
        if (!oneShot) play(speed > 0.5 ? actions.run : actions.idle);
        // The run cycle depicts a body moving at RUN_CLIP_SPEED. Play it at a
        // fixed rate while the duelist travels at some other speed and the feet
        // skate -- at DUEL.playerSpeed of 8.5 that is a 3x mismatch, which is
        // what makes the run read as broken. Driving timeScale off the measured
        // speed plants the feet at any tuning, and every Meshy run clip tested
        // sat at the same ~2.9, so this holds if the clip is ever swapped.
        if (actions.run) {
          actions.run.timeScale = clamp(speed / RUN_CLIP_SPEED, 0.4, MAX_RUN_TIMESCALE);
        }
        mixer.update(dt);
      }
      // After the mixer, never before: the clip writes the arm's bones every
      // frame, so IK applied first would simply be overwritten.
      if (armIK) {
        reachWeight += ((reachTarget ? 1 : 0) - reachWeight) * Math.min(1, dt * REACH_FADE);
        if (reachWeight > 0.01) {
          root.updateMatrixWorld(true);
          armIK.solve(lastReach, reachWeight);
        }
        if (castSpark) {
          castSpark.group.visible = reachWeight > 0.01;
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
