// ─── Spell Room — Inference, off the main thread ──────────────────────────────
//
// This worker owns MediaPipe and nothing else. It is handed one ImageBitmap at
// a time and posts back raw landmarks; it does no un-mirroring, no smoothing,
// no side-picking and no game logic. All of that stays in tracker.js, where it
// costs microseconds and where the rules about handedness already live.
//
// ── Why this exists ──
//
// detectLoop() used to run on the main thread's rAF chain. That decoupled its
// RATE from the renderer's but not its COST: one thread, one frame budget, so
// every millisecond of inference was a millisecond the duel could not draw in.
// A near-empty mirror scene -- one character and a floor -- rendered at 39-55
// fps, and the tracker itself stalled to 0 Hz for half a second at a time. Both
// numbers were the same contention seen from two ends.
//
// Nothing here is allowed to throw across the boundary: a failed frame posts an
// error and the main thread keeps its previous pose, exactly as it did when a
// dropped detection was swallowed in place.
//
// ── One model per instance ──
//
// tracker.js runs TWO of these, one holding the hand model and one the body.
// They were briefly in a single worker answering a single message, and the
// measurement said no: hands alone infer in a median 12ms, hands and body
// together in 38ms with spikes past 120ms. Sharing a thread meant every frame
// the body ran on, the hands waited behind it -- so the fast, load-bearing
// signal was being paced by the slow, optional one. Apart, the hands keep their
// own 12ms cadence and the body arrives whenever it can, which is all a bend
// hint that gets eased anyway ever needed.

// ── Why this is a CLASSIC worker that imports dynamically ──
//
// The obvious shape -- a module worker with a top-level import -- does not
// work, and fails late enough to look like something else. MediaPipe loads its
// WASM glue with importScripts(), and a module worker is forbidden from having
// that function at all:
//
//   Failed to execute 'importScripts' on 'WorkerGlobalScope':
//   Module scripts don't support importScripts().
//
// The package ships only .mjs and .cjs, so there is no classic bundle to
// importScripts either. What works is the inverse: a classic worker, which has
// importScripts natively for MediaPipe's own use, loading the ESM bundle
// through a dynamic import.
const BUNDLE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

let hand = null;
let pose = null;

/** Reject if a step has not finished in time, so a hang is attributable. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

function stage(text) {
  self.postMessage({ type: "stage", stage: text });
}

async function init({ wasmRoot, handModel, poseModel }) {
  const { FilesetResolver, HandLandmarker, PoseLandmarker } =
    await withTimeout(import(BUNDLE), 30000, "MediaPipe bundle");
  const vision = await withTimeout(
    FilesetResolver.forVisionTasks(wasmRoot), 30000, "WASM download",
  );

  if (handModel) {
    stage("loading the model (7.8 MB)");
    // GPU is faster but its init hangs on some Mac/Chrome combinations, and it
    // hangs rather than throwing. Try it with a short leash, then fall back.
    try {
      hand = await withTimeout(
        HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: handModel, delegate: "GPU" },
          runningMode: "VIDEO",
          numHands: 2,
        }),
        15000, "GPU model load",
      );
    } catch {
      stage("GPU refused — retrying on CPU");
      hand = await withTimeout(
        HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: handModel, delegate: "CPU" },
          runningMode: "VIDEO",
          numHands: 2,
        }),
        30000, "CPU model load",
      );
    }
  }

  if (poseModel) {
    stage("loading the body model (5.5 MB)");
    pose = await withTimeout(
      PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: poseModel, delegate: "GPU" },
        runningMode: "VIDEO",
        numPoses: 1,
      }),
      15000, "GPU pose model load",
    );
  }

  self.postMessage({ type: "ready", body: pose !== null });
}

/**
 * One frame in, one result out.
 *
 * The bitmap is closed here whatever happens. It is a transferred handle to
 * decoded pixels, and the main thread cannot free it once it has been sent --
 * leaking one per frame at 30Hz is how a tab ends up eating a gigabyte.
 */
function detect({ bitmap, timestamp }) {
  const result = { type: "result", timestamp };

  if (hand) {
    try {
      const hands = hand.detectForVideo(bitmap, timestamp);
      result.landmarks = hands.landmarks ?? [];
      result.handedness = (hands.handedness ?? []).map(h => h[0]?.categoryName ?? null);
    } catch (error) {
      result.error = error.message;
      result.landmarks = [];
    }
  }

  if (pose) {
    try {
      const body = pose.detectForVideo(bitmap, timestamp);
      result.pose = body.landmarks?.[0] ?? null;
    } catch {
      // The last body stands until a new one arrives.
      result.pose = null;
    }
  }

  bitmap.close();
  self.postMessage(result);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") await init(data);
    else if (data.type === "frame") detect(data);
    else if (data.type === "close") {
      hand?.close?.();
      pose?.close?.();
      hand = pose = null;
      self.close();
    }
  } catch (error) {
    // Never let a rejection escape: an unhandled one in a worker is silent, and
    // the main thread would sit waiting for a frame that is never coming.
    if (data.type === "frame") data.bitmap?.close?.();
    self.postMessage({ type: "failed", message: error.message });
  }
};
