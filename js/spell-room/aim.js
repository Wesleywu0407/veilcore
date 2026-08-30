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
  const reticle = { x: 0.5, y: 0.5 };

  function reset() {
    origin = null;
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
     */
    update(bowWrist, draw, now) {
      if (!bowWrist) {
        reset();
        return reticle;
      }
      if (!origin) {
        origin = { x: bowWrist.x, y: bowWrist.y };
        for (const filter of [quickX, quickY, steadyX, steadyY]) filter.reset();
      }

      const rawX = clamp01(0.5 + (bowWrist.x - origin.x) * gain);
      const rawY = clamp01(0.5 + (bowWrist.y - origin.y) * gain);
      const weight = clamp01(draw);
      reticle.x = lerp(quickX.filter(rawX, now), steadyX.filter(rawX, now), weight);
      reticle.y = lerp(quickY.filter(rawY, now), steadyY.filter(rawY, now), weight);
      return reticle;
    },
  };
}
