// ─── Drawing the face the tracker is reading ─────────────────────────────────
//
// One drawer, used by both panels. The mirror had this and the duel did not,
// which made "is it even seeing my face?" answerable on one page and not the
// other -- and the duel is the page where it mattered, because that is where
// the head tracking looked like it had never been wired in.
//
// It takes a `project` rather than a canvas rectangle so the two panels can
// keep their own very different coordinate systems: the mirror draws into a
// small canvas laid over the video, the duel into a rect of the main overlay.
// Everything else about the drawing is shared, so the two cannot drift apart
// the way every other duplicated piece in this project has.

/**
 * @param ctx      a 2D context
 * @param head     frame.head, or null
 * @param project  (landmark) => [x, y] in canvas pixels
 * @param colours  { live, cold } -- live once the pitch has been levelled
 * @param scale    dot radius; the aim line is eight times it
 */
export function drawFace(ctx, head, project, { live, cold }, scale = 2.5) {
  if (!head?.points) {
    ctx.fillStyle = cold;
    return false;
  }
  const { nose, leftEar, rightEar, eyes } = head.points;
  const colour = head.levelled ? live : cold;
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 1.5;

  // The ear line: the reference pitch is measured against.
  ctx.beginPath();
  ctx.moveTo(...project(leftEar));
  ctx.lineTo(...project(rightEar));
  ctx.stroke();

  // And the front of the face, which is what moves against it.
  for (const point of [nose, ...(eyes ?? [])]) {
    ctx.beginPath();
    ctx.arc(...project(point), scale, 0, Math.PI * 2);
    ctx.fill();
  }

  // Where the head is pointed, as a line off the nose -- so a turn reads as a
  // turn rather than as a number somewhere else on the screen.
  const [nx, ny] = project(nose);
  ctx.beginPath();
  ctx.moveTo(nx, ny);
  ctx.lineTo(nx + Math.sin(-head.yaw) * scale * 8, ny - Math.sin(head.pitch) * scale * 8);
  ctx.stroke();
  return true;
}
