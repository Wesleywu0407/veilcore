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

import { LM, dist } from "./vec.js";
import { readPose, sideOfWrist, createSideLatch } from "./pose.js";
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

// ── Paying for the body model only when it can change anything ──
//
// detectLoop() has its own requestAnimationFrame chain, which decouples its
// RATE from the renderer's but not its COST: both run on the one main thread
// and share one frame budget, so every millisecond MediaPipe spends inferring
// is a millisecond the duel does not get to draw in. Running the body on every
// detection was enough to push the quality governor down to `low`.
//
// Thinning the cadence alone did not fix it. What does is noticing that the
// body is read for exactly one purpose -- which way an elbow is bent -- and
// that an elbow only matters while an arm is up. With no hand in frame there is
// no arm being solved, so the second model has nothing to contribute and is
// simply not run. Standing, walking and watching now cost what they always did.
let trackBody = true;
const POSE_EVERY = 3;

// ── The delegate, and why it is a knob ──
//
// Moving inference into a worker did not raise the frame rate. That is only
// possible if the main THREAD was never the constraint -- and MediaPipe's GPU
// delegate shares a GPU with the renderer, which no amount of threading
// separates. Flip this to "CPU" and compare: if the frame rate goes UP while
// inference itself gets slower, the two were fighting over the GPU and the
// thread was never the problem.
const HAND_DELEGATE = "GPU";

let video = null;
let handWorker = null;
let bodyWorker = null;
let bodyLoaded = false;
let running = false;
let lastVideoTime = -1;
let detections = 0;
// One frame in flight at a time.
//
// Without this the worker becomes a queue: the camera delivers faster than
// inference finishes, the backlog grows, and every landmark that arrives is
// describing a hand that moved on several frames ago. Latency you cannot see in
// a frame counter but can absolutely feel. Dropping frames while busy keeps the
// newest one always the one being worked on.
let busy = false;
// The body gets its own gate. Sharing one with the hands is what coupled them:
// a 120ms body frame would hold the hands' turn too, so the signal the game is
// actually played with was being paced by the optional one.
let bodyBusy = false;

// The side of a single raised hand, held between body samples. See pose.js.
const loneSide = createSideLatch();

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

// ── Why an arm follows the WRIST and not the fingertip ──
//
// `tip` is the index fingertip, and it is the right point for drawing a rune:
// it is the end of the wand. It is the wrong point to hang an arm off. The IK
// solves for the WRIST bone, so feeding it the fingertip asked it to put the
// wrist where the finger was -- the arm overreached by a hand's length -- and,
// worse, it made every finger a shoulder movement: curl your fingers and the
// whole arm swings. That is most of what "the arm keeps drifting" was.
//
// Smoothed, and per side, because `hands[].wrist` is raw. Only `frame.tip` was
// ever filtered, so both arms in the mirror were being driven by landmarks
// straight off the model, jitter and all, at 14-23Hz.
const anchorFilters = {
  left: { x: makeOneEuro(TIP_FILTER), y: makeOneEuro(TIP_FILTER) },
  right: { x: makeOneEuro(TIP_FILTER), y: makeOneEuro(TIP_FILTER) },
};

/** Attach a smoothed `anchor` to each hand, and forget the sides that left. */
function anchorHands(sides, now) {
  const seen = new Set();
  for (const hand of sides) {
    // A lone hand has no side; the consumers all read it as the right one.
    const key = hand.side ?? 'right';
    seen.add(key);
    const filter = anchorFilters[key];
    hand.anchor = {
      x: filter.x.filter(hand.wrist.x, now),
      y: filter.y.filter(hand.wrist.y, now),
    };
  }
  for (const key of ['left', 'right']) {
    if (seen.has(key)) continue;
    // A hand that comes back after a gap must not ease in from where it left.
    anchorFilters[key].x.reset();
    anchorFilters[key].y.reset();
  }
}

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

  // What the tracker still costs THIS thread, per frame, in milliseconds.
  // Everything else was moved to a worker; this is the decode that feeds it,
  // and it was assumed to be free rather than measured.
  decodeMs: 0,

  // How many detections have completed. The render loop runs far faster than
  // this, and it is THIS rate that decides whether a tracked arm looks smooth
  // or looks like it is stepping, so it is worth being able to read.
  detections: 0,
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

/** One worker, one model. See tracker-worker.js for why they are not shared. */
function spawnWorker(models) {
  // Classic, not a module worker -- see the top of tracker-worker.js. MediaPipe
  // needs importScripts, and a module worker is forbidden from having it.
  const spawned = new Worker(new URL("./tracker-worker.js", import.meta.url));
  spawned.postMessage({ type: "init", wasmRoot: WASM_ROOT, ...models });
  return spawned;
}

/**
 * Bring up the body model beside the hands, without anyone waiting for it.
 *
 * It is three times the cost of the hands and spikes past 120ms, so it gets its
 * own thread and its own gate; the hands never queue behind it. If it does not
 * load, the arms fall back to a fixed elbow hint, which is what they used
 * before the body existed.
 */
function startBody(onStage) {
  const spawned = spawnWorker({ poseModel: POSE_MODEL_URL });
  spawned.onmessage = ({ data }) => {
    // Every one of these has to move the stage on. The body posts "loading the
    // body model" and, before this, posted nothing else a reader could see --
    // so the line sat there in red for the rest of the session whether the load
    // had succeeded, failed, or was still going. It read as a hang, and it hid
    // the one fact that mattered: whether there was ever going to be an elbow.
    if (data.type === "stage") onStage(data.stage);
    else if (data.type === "ready") { bodyWorker = spawned; bodyLoaded = true; onStage("ready"); }
    else if (data.type === "result") { bodyBusy = false; applyPose(data.pose ?? null); }
    else if (data.type === "failed") {
      bodyLoaded = false; bodyWorker = null;
      onStage("no body model — elbows on the fixed hint");
    }
  };
  spawned.onerror = () => {
    bodyLoaded = false; bodyWorker = null;
    onStage("no body model — elbows on the fixed hint");
  };
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

  // Everything from here happens in a worker. See tracker-worker.js for why:
  // the short version is that inference and rendering were sharing one thread,
  // so a near-empty scene rendered at 39-55 fps and the tracker stalled to 0 Hz.
  onStage("starting the tracker");
  handWorker = spawnWorker({ handModel: MODEL_URL, delegate: HAND_DELEGATE });

  const started = new Promise((resolve, reject) => {
    handWorker.onmessage = ({ data }) => {
      if (data.type === "stage") onStage(data.stage);
      else if (data.type === "ready") resolve();
      else if (data.type === "failed") reject(new Error(data.message));
    };
    // A worker that cannot even parse must not leave startup hanging.
    handWorker.onerror = event => reject(new Error(event.message || "worker failed to start"));
  });
  await withTimeout(started, 45000, "tracker worker");

  handWorker.onmessage = ({ data }) => {
    if (data.type !== "result") return;
    busy = false;
    applyResult(data);
    detections++;
    frame.detections = detections;
  };

  // The body loads in a thread of its own and does NOT hold up startup. Losing
  // it costs the elbow hint and nothing else, so the duel should be playable
  // the moment the hands are ready.
  startBody(onStage);

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

  // Two gates. `currentTime` because the camera delivers fewer frames than the
  // display refreshes and there is nothing new to look at otherwise; `busy`
  // because the worker takes one frame at a time and a queue is just latency.
  if (video.currentTime !== lastVideoTime && !busy) {
    lastVideoTime = video.currentTime;
    busy = true;
    const timestamp = performance.now();
    const wantBody = trackBody && bodyLoaded && !bodyBusy && frame.tracked
      && detections % POSE_EVERY === 0;

    // createImageBitmap is the one piece of per-frame work still on this
    // thread. It decodes rather than infers -- a fraction of a millisecond
    // against MediaPipe's fifteen -- and the handle transfers to the worker
    // with no copy.
    const decodeStart = performance.now();
    createImageBitmap(video).then(bitmap => {
      frame.decodeMs = frame.decodeMs * 0.8 + (performance.now() - decodeStart) * 0.2;
      if (!running) { bitmap.close(); return; }
      handWorker.postMessage({ type: "frame", bitmap, timestamp }, [bitmap]);
      // The body gets its own copy on its own cadence. A transferred bitmap
      // belongs to whoever received it, so this is a second decode rather than
      // a second send -- cheap next to the inference it feeds.
      if (wantBody) {
        bodyBusy = true;
        createImageBitmap(video)
          .then(copy => {
            if (!running || !bodyWorker) { copy.close(); return; }
            bodyWorker.postMessage({ type: "frame", bitmap: copy, timestamp }, [copy]);
          })
          .catch(() => { bodyBusy = false; });
      }
    }).catch(() => {
      // A frame the browser would not decode is not worth stopping for, but
      // the gate has to be released or nothing is ever sent again.
      busy = false;
    });
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
      reported: result.handedness?.[i] ?? null,
    }))
    .sort((a, b) => a.wrist.x - b.wrist.x);
  if (sides.length === 2) {
    sides[0].side = 'left';
    sides[1].side = 'right';
    loneSide.forget();
  } else if (sides.length === 1) {
    // One hand cannot be placed by x -- but the body can place it. The latch
    // keeps that answer while the body model is between samples, so the side
    // does not flicker back to null every frame the pose is missing.
    sides[0].side = loneSide.settle(sideOfWrist(sides[0].wrist, frame.pose));
  }
  anchorHands(sides, performance.now());
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
      // The next hand up is a new question. Without this, putting the right
      // hand down and raising the left moves the right arm until the body
      // catches up.
      loneSide.forget();
      // The body is only read while an arm is up, so let it go with the hand.
      // Holding it would leave the elbow bent the way it was when the hand left.
      frame.pose = null;
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
function applyPose(body) {
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
  return running && handWorker !== null;
}

/** Whether the body model loaded. False means the arms are on the fixed hint. */
export function isBodyTracked() {
  return bodyLoaded;
}

/**
 * Turn the body model on and off while running.
 *
 * It is the one part of the pipeline whose cost can be felt but whose benefit
 * cannot easily be seen, so being able to A/B it in place -- rather than by
 * editing a constant and reloading -- is the only way to settle whether it is
 * worth what it takes.
 */
export function setBodyTracking(enabled) {
  trackBody = Boolean(enabled);
  if (!trackBody) frame.pose = null;
  return trackBody;
}

export function bodyTracking() {
  return trackBody && bodyLoaded;
}

export function disposeTracker() {
  running = false;
  busy = false;
  for (const w of [handWorker, bodyWorker]) {
    w?.postMessage({ type: "close" });
    w?.terminate();
  }
  handWorker = bodyWorker = null;
  bodyBusy = false;
  bodyLoaded = false;
  frame.pose = null;
  const stream = video?.srcObject;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (video) video.srcObject = null;
}

