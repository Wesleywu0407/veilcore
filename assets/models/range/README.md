# Range assets

Made for `practice.html`, and kept apart from `../arena/` because nothing in the
duel uses them.

## `target.glb` — the archery target face

Meshy text-to-3D, 2026-09-04, then shrunk. **1,524 triangles, one primitive, one
material, three 1024² JPEGs, 0.76 MB.** Inside the budget in PLAN.md.

Two things about it that are not obvious:

- **It came out at 6.42 MB.** Meshy returns 2048² maps whatever the object is,
  and this is a disc seen from eighteen to forty-eight metres. Put through
  `node scripts/glb-shrink.mjs <file> 1024`, which is in the repo precisely so
  that this step does not get skipped on the next one. The 6.42 MB original was
  not kept: it is the same geometry with bigger pictures on it, and re-running
  the shrink from the shipped file would only be lossy twice.
- **It took three prompts, not one.** The first was a dome, because "thin round
  face" does not stop Meshy inflating things. The second grew a plinth, because
  "standing upright on its edge" reads as a request for something to stand on.
  What worked was naming the geometry -- "like a very thin coin, twenty times as
  wide as it is thick" -- and saying the object "floats alone and touches
  nothing" rather than listing what not to add.

The rings are geometry, stepped into the front face, and the colour is painted
on the base map. Practice.js keeps its procedural rings as a fallback for the
frame where this has not loaded or has failed to.
