// ─── A target that has been hit ──────────────────────────────────────────────
//
// The whole life of a struck target as one function of one number, so it can be
// read in one place and walked by a test without a camera, a canvas or a clock.
// The range imports this; nothing in the duel does yet.
//
// ── Why it is not instant ──
//
// A target that vanishes ON the frame it is hit takes the moment of hitting it
// away with it: you see the arrow leave, then a hole where the thing was, and
// never the two together. So it swells first -- the flash it always had -- then
// falls away, stays away long enough for the range to be visibly one target
// down, and grows back.
//
// ── Why the phases are milliseconds and not frames ──
//
// The range runs at whatever the browser gives it and the tracker often holds it
// well below 60. A phase counted in frames would be twice as long on a slow
// machine, which is the machine already having the worse time.

export const STRUCK = Object.freeze({
  HOLD: 260,     // the flash, at full size, before it starts to leave
  FALL: 420,     // shrinking away
  GONE: 700,     // fully away, so the gap is noticed
  RISE: 380,     // and growing back
  SWELL: 0.12,   // how much bigger than life the flash gets
});

/**
 * How big a struck target is, `since` milliseconds after the arrow landed.
 *
 * 1 before it is ever hit, `1 + SWELL` at the instant of the hit, 0 while it is
 * away, and 1 again once it has finished coming back. A target that has never
 * been hit carries `since = Infinity`, which lands on the last branch.
 */
export function struckScale(since) {
  if (!(since >= 0)) return 1;
  if (since < STRUCK.HOLD) return 1 + STRUCK.SWELL * (1 - since / STRUCK.HOLD);
  const falling = since - STRUCK.HOLD;
  if (falling < STRUCK.FALL) return 1 - falling / STRUCK.FALL;
  const dark = falling - STRUCK.FALL;
  if (dark < STRUCK.GONE) return 0;
  const rising = dark - STRUCK.GONE;
  if (rising < STRUCK.RISE) return rising / STRUCK.RISE;
  return 1;
}

/** How long the whole thing takes, for anything that has to wait it out. */
export const STRUCK_TOTAL = STRUCK.HOLD + STRUCK.FALL + STRUCK.GONE + STRUCK.RISE;
