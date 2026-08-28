// ─── Veilcore — drawing a bow with two hands ─────────────────────────────────
//
// The reason this is two-handed is not realism, it is measurement. A real draw
// pulls toward your own face, straight along the camera axis, which is the one
// direction a webcam estimates worst. Two hands turn the same gesture into a
// distance BETWEEN two points on the image plane — pure 2D, no depth term
// anywhere in this file — and hand the aim direction over for free as the line
// between them.
//
// Nothing here touches the camera, the DOM, or the clock beyond what it is
// given. It takes `frame.hands` and a timestamp and returns numbers, so the
// whole feel can be tuned against synthetic input before anyone stands up.

import { LM } from "./vec.js";

export const BOW = {
  // Distance between the wrists, measured in hand-spans so it means the same
  // thing whether you stand close to the lens or far from it. Below MIN the
  // string is slack; at FULL it is at anchor.
  //
  // Measured on a real draw, 2026-08-28: slack sat at 2.1 spans and full draw
  // reached 5.3. Neither bound is set to those numbers exactly. MIN sits above
  // the measured slack so that resting hands read a true zero instead of
  // flickering around one, and FULL sits below the measured maximum so that
  // 100% is somewhere you can reliably get to rather than the one pose you can
  // just barely reach on a good rep.
  DRAW_MIN: 2.3,
  DRAW_FULL: 5.0,

  // Thumb-to-index gap over hand span. Same formula the rune gate uses, but
  // stateless and per-hand, because the bow needs the string hand judged
  // independently of whichever hand the rune gate happens to be watching.
  PINCH_ON: 0.42,    // below this, fingers are closed on the string
  PINCH_OFF: 0.62,   // above this, released. The gap between them is the dead zone.

  // A hand can flicker for a frame at the edge of the model's confidence.
  // Loosing an arrow on that would be indistinguishable from a misfire.
  RELEASE_HOLD_MS: 40,
  // Drawn shorter than this and it is a twitch, not a shot.
  MIN_LOOSE_DRAW: 0.12,
};

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Thumb-to-index gap over hand span: scale-free, stateless, per hand. */
export function pinchRatio(landmarks) {
  if (!landmarks) return Infinity;
  const gap = dist3(landmarks[LM.THUMB_TIP], landmarks[LM.INDEX_TIP]);
  const span = dist3(landmarks[LM.WRIST], landmarks[LM.MIDDLE_MCP]);
  return gap / Math.max(span, 1e-6);
}

/**
 * Geometry only — no state, no history. Given both hands, say how far the bow
 * is drawn and where it points.
 *
 * The string hand is whichever hand has its fingers closed, not a fixed side:
 * that way a left-handed archer is handled without a setting, and without this
 * file having to know which way round the player stands.
 */
export function readBow(hands) {
  if (!hands || hands.length < 2) return null;
  const [a, b] = hands;
  const aClosed = pinchRatio(a.landmarks) < BOW.PINCH_ON;
  const bClosed = pinchRatio(b.landmarks) < BOW.PINCH_ON;
  // Both closed, or neither: fall back to the stance the game is built around --
  // left hand forward on the bow, right hand back on the string. Hands arrive
  // sorted by x with the mirror already undone, so the right hand is the second
  // one. Reporting a draw from an ambiguous grip beats refusing to report at
  // all, because the practice readout has to keep showing numbers while you are
  // still finding the pose.
  const string = aClosed && !bClosed ? a : bClosed && !aClosed ? b : b;
  const bow = string === a ? b : a;

  const span = Math.max((a.scale + b.scale) / 2, 1e-6);
  const dx = bow.wrist.x - string.wrist.x;
  const dy = bow.wrist.y - string.wrist.y;
  const gap = Math.hypot(dx, dy);
  const spans = gap / span;
  const draw = clamp((spans - BOW.DRAW_MIN) / (BOW.DRAW_FULL - BOW.DRAW_MIN), 0, 1);

  return {
    bow, string,
    spans,                                   // raw, for the tuning readout
    draw,                                    // 0..1, what the game should use
    // Unit vector from the string toward the bow: the way the arrow points.
    aim: gap > 1e-6 ? { x: dx / gap, y: dy / gap } : { x: 1, y: 0 },
    angle: (Math.atan2(-dy, dx) * 180) / Math.PI,
    stringClosed: pinchRatio(string.landmarks) < BOW.PINCH_ON,
    stringOpen: pinchRatio(string.landmarks) > BOW.PINCH_OFF,
  };
}

// ─── The shot, as a state machine ────────────────────────────────────────────
//
//   idle → nocked → (loosed | slackened)
//
// Fingers closing on the string nocks it; pulling apart draws it; opening the
// fingers looses. Letting the draw collapse back to nothing without opening
// puts the arrow away quietly rather than firing it at your own feet.

const PHASE = { IDLE: "idle", NOCKED: "nocked" };

export function createBowState() {
  let phase = PHASE.IDLE;
  let openSince = 0;
  let peak = 0;

  return {
    get phase() { return phase; },
    reset() { phase = PHASE.IDLE; openSince = 0; peak = 0; },

    /**
     * @param hands frame.hands
     * @param now   performance.now()
     * @returns {{phase, draw, spans, aim, angle, peak, event}}
     *          event is null, or { type: 'loosed', power, aim } once.
     */
    update(hands, now) {
      const read = readBow(hands);
      if (!read) {
        phase = PHASE.IDLE;
        openSince = 0;
        peak = 0;
        return { phase, draw: 0, spans: 0, aim: null, angle: 0, peak: 0, event: null };
      }

      let event = null;
      if (phase === PHASE.IDLE) {
        if (read.stringClosed) { phase = PHASE.NOCKED; peak = 0; openSince = 0; }
      } else {
        peak = Math.max(peak, read.draw);
        if (read.stringOpen) {
          // Require the opening to persist. A single frame of the model losing
          // the thumb would otherwise read as a loose.
          if (!openSince) openSince = now;
          else if (now - openSince >= BOW.RELEASE_HOLD_MS) {
            if (peak >= BOW.MIN_LOOSE_DRAW) {
              event = { type: "loosed", power: peak, aim: read.aim, angle: read.angle };
            }
            phase = PHASE.IDLE;
            openSince = 0;
            peak = 0;
          }
        } else {
          openSince = 0;
        }
      }

      return {
        phase, draw: read.draw, spans: read.spans,
        aim: read.aim, angle: read.angle, peak, event,
        // Handed out so consumers point the reticle with the same hand this
        // file picked. Deciding it twice is how the panel ends up disagreeing
        // with the shot.
        bowWrist: read.bow.wrist, stringWrist: read.string.wrist,
      };
    },
  };
}
