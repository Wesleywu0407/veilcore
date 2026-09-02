// ─── One Euro filter ─────────────────────────────────────────────────────────
//
// Casiez et al., CHI 2012. Lifted out of tracker.js because the bow needs it
// too: the reticle is steered by a wrist, and a raw wrist multiplied by an aim
// gain is a reticle that shakes.
//
// A moving average would trade jitter for lag, and lag is the worse of the two
// here — the point has to keep up with a fast movement. One Euro adapts instead:
// heavy smoothing while the hand is slow, where jitter is what you notice, and
// almost none while it is fast, where lag is what you notice.

export function makeOneEuro({ minCutoff, beta, dCutoff }) {
  let xPrev = null, dxPrev = 0, tPrev = 0;
  const alpha = (cutoff, dt) => {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  return {
    reset() { xPrev = null; dxPrev = 0; tPrev = 0; },
    filter(x, t) {
      if (xPrev === null) { xPrev = x; tPrev = t; return x; }
      const dt = Math.max((t - tPrev) / 1000, 1e-3);
      tPrev = t;
      const dx = (x - xPrev) / dt;
      const aD = alpha(dCutoff, dt);
      dxPrev = aD * dx + (1 - aD) * dxPrev;
      // The speed estimate is what makes the cutoff adaptive.
      const cutoff = minCutoff + beta * Math.abs(dxPrev);
      const a = alpha(cutoff, dt);
      xPrev = a * x + (1 - a) * xPrev;
      return xPrev;
    },
  };
}

/**
 * A soft deadband: below `epsilon` of movement, nothing moves at all.
 *
 * One Euro REDUCES jitter; it cannot remove it. At the 15Hz the tracker
 * manages, the constants that took a held-still wobble below a third of its
 * size also put three frames of lag on a real swing -- measured, in
 * one-euro.test.mjs. That is not a tuning problem, it is what a first-order
 * lowpass is: stillness and speed come out of the same knob.
 *
 * A deadband is the other knob. It does nothing whatsoever to a movement bigger
 * than the noise floor, and it takes a movement smaller than the noise floor to
 * exactly zero -- not "reduced", zero, which is the only thing that actually
 * looks like a hand being held still.
 *
 * Soft, not hard: the movement has epsilon SUBTRACTED rather than being ignored
 * until it crosses. A hard band sticks and then jumps by a whole epsilon the
 * moment it breaks, which reads worse than the jitter it replaced.
 */
export function makeDeadband(epsilon) {
  let held = null;
  return {
    reset() { held = null; },
    filter(x) {
      if (held === null) { held = x; return x; }
      const delta = x - held;
      const size = Math.abs(delta);
      if (size <= epsilon) return held;
      held += Math.sign(delta) * (size - epsilon);
      return held;
    },
  };
}

/** One Euro with a deadband behind it: the pair, since neither is enough. */
export function makeSteady({ minCutoff, beta, dCutoff, deadband }) {
  const euro = makeOneEuro({ minCutoff, beta, dCutoff });
  const band = makeDeadband(deadband);
  return {
    reset() { euro.reset(); band.reset(); },
    filter(x, t) { return band.filter(euro.filter(x, t)); },
  };
}
