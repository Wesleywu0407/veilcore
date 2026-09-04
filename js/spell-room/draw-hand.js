// ─── Drawing the hand the tracker is reading ─────────────────────────────────
//
// The skeleton, on the glass, over the picture it came from. It exists for one
// question -- "is it seeing my hand, and does it think my hand is where my hand
// is?" -- and that question cannot be answered from a rendered character,
// because a character that is posed wrongly and a character that is not being
// posed at all look the same from the outside.
//
// Takes a `project` rather than a rectangle, like draw-face.js, so a caller can
// keep its own coordinates: the mirror draws into a small canvas over the video,
// the duel into a rect of the main overlay, the range into a corner.
//
// NOTE: js/arena.js and js/mirror.js still each carry their own copy of this,
// grown apart -- the duel's has side labels, stale dimming and green fingertips;
// the mirror's has the smoothed anchor. They should come here. They have not
// yet only because they are the two pages being demonstrated this week and this
// module has not been watched on a real hand.

/** MediaPipe's 21 points, as bones. */
export const HAND_BONES = Object.freeze([
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [17, 0],
]);

/** The five tips, which are what every gesture in this game is read off. */
export const FINGERTIPS = Object.freeze([4, 8, 12, 16, 20]);

/**
 * @param ctx      a 2D context
 * @param hand     one entry of frame.hands, or null
 * @param project  (landmark) => [x, y] in canvas pixels
 * @param colours  { bone, tip } -- tip is the five fingertips, picked out
 *                 because a tip that has wandered off the finger is the
 *                 difference between a gesture that will not read and a hand
 *                 that looks fine
 * @param scale    dot radius
 * @returns whether anything was drawn
 */
export function drawHand(ctx, hand, project, { bone, tip }, scale = 2) {
  const marks = hand?.landmarks;
  if (!marks?.length) return false;

  ctx.beginPath();
  for (const [from, to] of HAND_BONES) {
    if (!marks[from] || !marks[to]) continue;
    ctx.moveTo(...project(marks[from]));
    ctx.lineTo(...project(marks[to]));
  }
  ctx.strokeStyle = bone;
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.fillStyle = bone;
  for (let i = 0; i < marks.length; i++) {
    if (FINGERTIPS.includes(i) || !marks[i]) continue;
    ctx.beginPath();
    ctx.arc(...project(marks[i]), scale * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = tip;
  for (const i of FINGERTIPS) {
    if (!marks[i]) continue;
    ctx.beginPath();
    ctx.arc(...project(marks[i]), scale, 0, Math.PI * 2);
    ctx.fill();
  }
  return true;
}
