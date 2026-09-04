# Range assets

Made for `practice.html`, and kept apart from `../arena/` because nothing in the
duel uses them.

## `target.glb` — the archery target face

Meshy text-to-3D, 2026-09-04. **832 triangles, one primitive, one material,
three 1024² JPEGs, 0.56 MB.** Inside the budget in PLAN.md.

Colours are the page's own, read out of `:root` in `index.html` rather than
remembered: `--violet` #9b87ff is a pale LAVENDER, not the deep aubergine a
first attempt produced, `--paper` #f4eddf is a warm bone white, and `--gold`
#ffd98a is the accent every emphasis in the UI is already made of. The season is
called The Porcelain Trials and the duelist is sealed porcelain, so porcelain is
the material the whole game is speaking.

### What it took, so the next one does not take it again

**Five prompts.** Each failed in a way worth writing down:

1. *"A thin round face"* → a **dome**. "Thin" does not stop Meshy inflating.
2. *"Standing upright on its edge"* → grew a **plinth**. Anything that implies
   support gets support. Say the object "floats alone and touches nothing".
3. Rings asked for as geometry → **stepped trenches**, which in the range's low
   light became shadow, and a bullseye painted deep violet became a black hole.
   It read as a doughnut and it shipped for about ten minutes.
4. *"Completely smooth, no relief"* → **still carved the rings**. The word
   "target" carries ring geometry with it and no amount of NO gets it out.
5. **What worked: ask for a blank plate.** A "plain blank circular porcelain
   plate, completely smooth and featureless" has nothing to carve, and then the
   REFINE step paints every ring on. Geometry from the preview, decoration from
   the texture -- that split is the whole trick.

**The bullseye must be the brightest thing on the object**, stated in capitals
in the texture prompt. In a dark room anything dark in the middle is a hole, not
a mark to aim at.

**`texture_prompt` is capped at 800 characters.** The API rejects a longer one
with a message you only see if you print the raw response.

**It came out at 5.97 MB.** Meshy returns 2048² maps whatever the object is.
`node scripts/glb-shrink.mjs <file> 1024` brings it to 0.56 MB; only the shrunk
file is kept, since re-running the shrink on it would be lossy twice.

Practice.js keeps its procedural rings as a fallback for the frame before this
has loaded, and for good if it never does.
