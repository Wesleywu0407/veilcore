// ─── Spell Room — Hand tracking ───────────────────────────────────────────────
//
// Owns the webcam and MediaPipe. Everything downstream reads one small object
// from getFrame() and never touches the camera itself.
//
// Two rules this file exists to enforce:
//
//   1. The CV loop and the render loop are SEPARATE. Detection runs at whatever
//      rate the model manages (~30Hz on a laptop); the game renders at 60. If
//      you call detectForVideo() inside requestAnimationFrame you have welded
//      your frame rate to the model, and the spell animation will stutter at
//      exactly the moment the player is watching hardest.
//
//   2. getFrame() never blocks and never throws. If the camera dies mid-session
//      it returns the last known frame with tracked:false, and the game keeps
//      running. A room that white-screens because a webcam unplugged is worse
//      than a room with no webcam.

import {
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

import { LM, dist } from "./vec.js";
import { readPose } from "./pose.js";
import { makeOneEuro } from "./one-euro.js";

export { LM, dist };

const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
// Lite, not full. The body is only ever asked which way an elbow is bent, and
// the heavier models buy accuracy in places -- finger-level wrist rotation,
// foot orientation -- that nothing here reads.
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// The body runs at half the hands' rate. An elbow travels a fraction of the
// distance a fingertip does, and the IK eases toward the hint anyway, so the
// second model does not need to be paid for on every detection. Raise it to 1
// if the arms feel laggy, lower the hands instead if the frame rate suffers --
// but measure before either, on the machine that has the camera.
const POSE_EVERY = 2;

let video = null;
let landmarker = null;
let poseLandmarker = null;
let running = false;
let lastVideoTime = -1;
let detections = 0;

// ─── Smoothing ────────────────────────────────────────────────────────────────
//
// MediaPipe's landmarks jitter by a few pixels every frame even when the hand
// is perfectly still. Drawn raw, a circle comes out visibly serrated — and the
// damage is not only cosmetic: that noise survives into resample() and pushes
// the stroke away from the template, so recognition suffers too.
//
// This is the One Euro filter (Casiez et al., CHI 2012). A plain moving average
// would trade jitter for lag, and lag is worse here — the point has to keep up
// with a fast flick. One Euro adapts instead: heavy smoothing while the hand is
// slow (where jitter is what you notice) and almost none while it is fast
// (where lag is what you notice).

const TIP_FILTER = {
  minCutoff: 1.2,   // lower = smoother when still
  beta: 0.015,      // higher = less lag when moving fast
  dCutoff: 1.0,
};


const tipX = makeOneEuro(TIP_FILTER);
const tipY = makeOneEuro(TIP_FILTER);

// ─── Dropout grace ────────────────────────────────────────────────────────────
//
// Opening the fingers to release changes the hand's silhouette sharply, and
// MediaPipe routinely drops a frame or two right at that moment. Reporting
// tracked:false there reads downstream as "the hand is gone" — which the cast
// state machine treats as a release, so a stroke can fire or fizzle mid-draw.
//
// Hold the last known pose briefly instead. 200ms is long enough to ride out a
// blink and short enough that a hand genuinely leaving the frame still ends the
// gesture promptly.
const TRACK_GRACE_MS = 200;

// The single object the rest of the room reads. Mutated in place on purpose:
// this is read every render frame and we are not allocating 60 objects a second.
const frame = {
  tracked: false,        // is a hand visible right now
  landmarks: null,       // raw 21 points, normalized 0..1, x already un-mirrored
  tip: { x: 0.5, y: 0.5 },   // index fingertip — the "wand tip", smoothed
  handScale: 0.1,        // wrist→middle-knuckle distance, for distance-invariant thresholds
  at: 0,                 // performance.now() of the last successful detection
  // True while `tracked` is being held open by the grace window rather than by
  // a fresh detection. Nothing needs it yet, but a consumer that wants to grey
  // out the cursor during a dropout can.
  stale: false,

  // Both hands, when both are up. `landmarks` and `tip` above still point at the
  // drawing hand, so everything that predates archery keeps working untouched.
  //
  // Sides are decided by x, not by MediaPipe's handedness label. The label is
  // computed on the raw image, which the webcam mirrors, so it calls a physical
  // right hand "Left"; the flip below un-mirrors the coordinates, after which
  // the right hand simply has the larger x. Archery never crosses the arms, so
  // position is the sturdier signal. The label is passed through as `reported`
  // for anyone who wants to compare.
  hands: [],

  // The body, when the pose model is loaded and can see one. Null otherwise --
  // including when the model failed to load at all, which is a supported state:
  // the duel played for months on hands alone and still has to.
  //
  // `left` and `right` are the PLAYER'S own sides, already un-mirrored, each
  // carrying { shoulder, elbow, wrist, hip } in the same normalized 0..1 space
  // as `tip`. Any joint the model could not actually see is null rather than a
  // guess; see pose.js.
  pose: null,
  poseAt: 0,
};

const EMPTY_HANDS = [];

// ─── Setup ────────────────────────────────────────────────────────────────────

/**
 * Reject if a step has not finished in time. Startup has three awaits — camera
 * permission, a WASM fetch, and a 7.8 MB model download — and any one of them
 * can hang without ever throwing. Without this the UI just sits on "waking the
 * camera" forever and you cannot tell which step died.
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

/**
 * Ask for the camera and load the model. Must be called from a user gesture
 * (a click or keypress) — browsers refuse getUserMedia otherwise, and the
 * failure is silent enough that you will blame your own code for twenty
 * minutes. `onStage` reports each step so a hang is attributable.
 */
export async function initTracker(videoEl, onStage = () => {}) {
  video = videoEl;
  tipX.reset();
  tipY.reset();

  onStage("asking for the camera");
  const stream = await withTimeout(
    navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: "user" },
      audio: false,
    }),
    20000, "camera permission",
  );
  video.srcObject = stream;

  // play() can stay pending forever if the element is hidden in a way the
  // browser treats as "will never render". Do not let it block startup — the
  // stream is already flowing, and detectForVideo() reads from the element
  // regardless.
  onStage("starting the video");
  await withTimeout(video.play(), 5000, "video.play()").catch((err) => {
    console.warn("[tracker] play() did not settle, continuing anyway:", err.message);
  });

  onStage("loading the model (7.8 MB)");
  const vision = await withTimeout(
    FilesetResolver.forVisionTasks(WASM_ROOT), 30000, "WASM download",
  );

  // GPU is faster but its init hangs on some Mac/Chrome combinations, and it
  // hangs rather than throwing. Try it with a short leash, then fall back.
  try {
    landmarker = await withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
      }),
      15000, "GPU model load",
    );
  } catch (err) {
    console.warn("[tracker] GPU delegate failed, falling back to CPU:", err.message);
    onStage("GPU refused — retrying on CPU");
    landmarker = await withTimeout(
      HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "VIDEO",
        numHands: 2,
      }),
      30000, "CPU model load",
    );
  }

  // The body is a bonus, not a requirement. If it will not load -- an old
  // browser, a blocked CDN, a machine that cannot afford a second model -- the
  // duel carries on with hands only and the arms fall back to a fixed elbow
  // hint, which is exactly what they did before this existed.
  onStage("loading the body model (5.5 MB)");
  try {
    poseLandmarker = await withTimeout(
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numPoses: 1,
      }),
      15000, "GPU pose model load",
    );
  } catch (err) {
    console.warn("[tracker] body model unavailable, hands only:", err.message);
    poseLandmarker = null;
  }

  onStage("ready");
  running = true;
  detectLoop();
  return true;
}

// ─── Detection loop ───────────────────────────────────────────────────────────

/**
 * Runs on its own rAF chain, independent of the game loop. It writes into
 * `frame` and nothing else. Deliberately does no game logic — the moment
 * detection starts deciding things, the two loops are coupled again.
 */
function detectLoop() {
  if (!running) return;

  // detectForVideo() throws if handed the same timestamp twice, and the camera
  // often delivers fewer frames than the display refreshes.
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    try {
      applyResult(landmarker.detectForVideo(video, now));
    } catch {
      // A dropped frame is not an error worth stopping for.
    }
    // Separately try/caught: a body that fails must not cost us the hands,
    // which are what the whole game is actually played with.
    if (poseLandmarker && detections % POSE_EVERY === 0) {
      try {
        applyPose(poseLandmarker.detectForVideo(video, now));
      } catch {
        // Same again. The last body stands until a new one arrives.
      }
    }
    detections++;
  }

  requestAnimationFrame(detectLoop);
}

function applyResult(result) {
  const all = result.landmarks ?? [];
  // Un-mirror once, here, so no consumer downstream has to think about it.
  const flippedAll = all.map((hand) => hand.map((p) => ({ x: 1 - p.x, y: p.y, z: p.z })));
  const sides = flippedAll
    .map((lm, i) => ({
      landmarks: lm,
      wrist: lm[LM.WRIST],
      tip: lm[LM.INDEX_TIP],
      scale: dist(lm[LM.WRIST], lm[LM.MIDDLE_MCP]),
      reported: result.handedness?.[i]?.[0]?.categoryName ?? null,
    }))
    .sort((a, b) => a.wrist.x - b.wrist.x);
  if (sides.length === 2) {
    sides[0].side = 'left';
    sides[1].side = 'right';
  } else if (sides.length === 1) {
    sides[0].side = null;   // one hand alone cannot be placed; do not guess
  }
  frame.hands = sides.length ? sides : EMPTY_HANDS;

  // The drawing hand stays whatever it has always been: the only hand when
  // there is one, and the right hand once there are two.
  const primary = sides.length === 2 ? sides[1] : sides[0];
  const hand = primary?.landmarks;
  if (!hand) {
    const lostFor = performance.now() - frame.at;
    if (lostFor > TRACK_GRACE_MS) {
      frame.tracked = false;
      frame.stale = false;
      frame.hands = EMPTY_HANDS;
      tipX.reset();
      tipY.reset();
    } else {
      frame.stale = true;   // still inside the grace window — hold the last pose
    }
    return;
  }

  const flipped = hand;   // already un-mirrored above
  const now = performance.now();
  const rawTip = flipped[LM.INDEX_TIP];

  frame.landmarks = flipped;
  // Only the drawing point is smoothed. The pinch gate reads raw landmarks on
  // purpose: filtering the thumb-index gap would add lag to the one signal that
  // has to feel instant, and the gate has its own hysteresis for noise.
  frame.tip = { x: tipX.filter(rawTip.x, now), y: tipY.filter(rawTip.y, now) };
  frame.handScale = dist(flipped[LM.WRIST], flipped[LM.MIDDLE_MCP]);
  frame.tracked = true;
  frame.stale = false;
  frame.at = now;
}

/**
 * Un-mirror the body the same way the hands are un-mirrored, then hand it to
 * pose.js to be split into sides. Nothing downstream should ever see a raw
 * MediaPipe LEFT_/RIGHT_ index.
 */
function applyPose(result) {
  const body = result?.landmarks?.[0];
  if (!body) {
    frame.pose = null;
    return;
  }
  frame.pose = readPose(body.map((p) => ({
    x: 1 - p.x, y: p.y, z: p.z, visibility: p.visibility,
  })));
  if (frame.pose) frame.poseAt = performance.now();
}

// ─── Read API ─────────────────────────────────────────────────────────────────

/** Latest frame. Never null, never throws. Do not mutate the object you get. */
export function getFrame() {
  return frame;
}

export function isReady() {
  return running && landmarker !== null;
}

/** Whether the body model loaded. False means the arms are on the fixed hint. */
export function isBodyTracked() {
  return poseLandmarker !== null;
}

export function disposeTracker() {
  running = false;
  landmarker?.close?.();
  landmarker = null;
  poseLandmarker?.close?.();
  poseLandmarker = null;
  frame.pose = null;
  const stream = video?.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (video) video.srcObject = null;
}

