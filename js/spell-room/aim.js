// ─── Veilcore — relative bow aiming ──────────────────────────────────────────
//
// Facing a webcam, the physical arrow points across the image rather than into
// it. The useful aiming signal is therefore the bow hand moving relative to
// where it was when the string was nocked. This module owns that small piece of
// state and its smoothing; it knows nothing about cameras, rays, or the DOM.

import { makeOneEuro } from './one-euro.js';

export const AIM = Object.freeze({
  gain: 2.6,
  quick: Object.freeze({ minCutoff: 0.9, beta: 0.05, dCutoff: 1.0 }),
  steady: Object.freeze({ minCutoff: 0.18, beta: 0.05, dCutoff: 1.0 }),
});

const clamp01 = value => Math.min(1, Math.max(0, value));
const lerp = (a, b, t) => a + (b - a) * t;

export function createBowAim({ gain = AIM.gain } = {}) {
  const quickX = makeOneEuro(AIM.quick);
  const quickY = makeOneEuro(AIM.quick);
  const steadyX = makeOneEuro(AIM.steady);
  const steadyY = makeOneEuro(AIM.steady);
  let origin = null;
  // The gain currently in force. Held because it can change mid-draw, and the
  // origin has to be re-anchored when it does.
  let live = gain;
  const reticle = { x: 0.5, y: 0.5 };

  function reset() {
    origin = null;
    live = gain;
    reticle.x = 0.5;
    reticle.y = 0.5;
    for (const filter of [quickX, quickY, steadyX, steadyY]) filter.reset();
  }

  return {
    reset,
    get active() { return origin !== null; },
    get reticle() { return reticle; },

    /**
     * Update from the bow wrist while nocked. The first wrist position becomes
     * screen centre; later movement steers the returned normalized reticle.
     * Pass null when the string is no longer nocked.
     *
     * `scale` multiplies the gain for this frame, so a host that narrows its
     * lens can slow the crosshair to match: at half the field of view and half
     * the gain, a given hand movement covers the same WORLD angle it did
     * before, and the crosshair simply moves less across a bigger picture.
     * Default 1 leaves the behaviour exactly as it was.
     */
    update(bowWrist, draw, now, scale = 1) {
      if (!bowWrist) {
        reset();
        return reticle;
      }
      if (!origin) {
        origin = { x: bowWrist.x, y: bowWrist.y };
        live = gain * scale;
        for (const filter of [quickX, quickY, steadyX, steadyY]) filter.reset();
      }

      // ── Changing the gain must not move the crosshair ──
      //
      // The reticle is an offset from `origin` multiplied by the gain, so
      // halving the gain would halve the offset and slide the aim back toward
      // the middle -- the player would lose their target by holding still,
      // which is the opposite of what narrowing the lens is for. Moving the
      // origin by the reciprocal keeps the product, and therefore the
      // crosshair, exactly where it was.
      const wanted = gain * scale;
      if (wanted > 1e-6 && wanted !== live) {
        origin.x = bowWrist.x - (bowWrist.x - origin.x) * (live / wanted);
        origin.y = bowWrist.y - (bowWrist.y - origin.y) * (live / wanted);
        live = wanted;
      }

      const rawX = clamp01(0.5 + (bowWrist.x - origin.x) * live);
      const rawY = clamp01(0.5 + (bowWrist.y - origin.y) * live);
      const weight = clamp01(draw);
      reticle.x = lerp(quickX.filter(rawX, now), steadyX.filter(rawX, now), weight);
      reticle.y = lerp(quickY.filter(rawY, now), steadyY.filter(rawY, now), weight);
      return reticle;
    },
  };
}

// ─── Focus: what holding still buys ──────────────────────────────────────────
//
// Lived in practice.js as four module-level variables and a function that
// mutated three of them. Pure and stateful is a fine thing to be, but it has to
// be an OBJECT to be either -- as loose variables in a page that owns a camera
// it could not be tested, and the range is the one room whose whole job is to
// be judged by numbers.
//
// Nothing here changed on the way across. Same maths, same constants, same
// order of operations; only the state moved inside.
export const FOCUS = Object.freeze({
  // Below FLOOR the hand is held still -- that much is only the tracker
  // breathing. At SPEED it is unambiguously moving. Between them the answer is
  // proportional rather than a gate, so a slow drift costs SOME focus instead
  // of all of it, and creeping onto a target does not throw the lens open.
  FLOOR: 0.15,
  SPEED: 0.50,
  // How fast the speed estimate itself follows. Fast enough to notice a flinch,
  // slow enough that one bad landmark is not one.
  SMOOTH: 6,
  // Focus is quicker to lose than to gain, deliberately: settling is a thing
  // you earn and a twitch should cost it.
  RISE: 0.9,
  FALL: 1.5,
});

/**
 * How settled the hand is, 0 to 1. Feed the bow wrist every frame it is nocked
 * and forget() the moment it is not.
 */
export function createFocus(tune = FOCUS) {
  let focus = 0;
  let speed = 0;
  let last = null;
  return {
    get value() { return focus; },
    /** The smoothed hand speed, for a readout that has to show its working. */
    get speed() { return speed; },
    forget() { focus = 0; speed = 0; last = null; },
    update(wrist, dt) {
      if (!wrist || dt <= 0) return focus;
      if (last) {
        const raw = Math.hypot(wrist.x - last.x, wrist.y - last.y) / dt;
        speed += (raw - speed) * Math.min(1, dt * tune.SMOOTH);
      }
      last = { x: wrist.x, y: wrist.y };
      const target = 1 - clamp01((speed - tune.FLOOR) / (tune.SPEED - tune.FLOOR));
      const rate = target > focus ? tune.RISE : tune.FALL;
      focus += (target - focus) * Math.min(1, dt * rate);
      return focus;
    },
  };
}
