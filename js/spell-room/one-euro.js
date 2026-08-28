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
