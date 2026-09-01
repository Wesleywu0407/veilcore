# Finger bones for the sealed porcelain duelist

`assets/models/arena/sealed-porcelain-duelist.glb` ships with a 24-bone skeleton
whose `LeftHand` and `RightHand` are terminal. The hands are **sculpted** — 1,154
vertices each, more than the head — but all of it moves as one rigid lump, so the
character cannot make a fist or open a palm.

Meshy's rigging API cannot fix this. Run against this exact mesh it returned the
same 24-bone template with no fingers, decimated the mesh from 24,904 triangles
to 170, and dropped two of the three PBR maps. These scripts do it locally
instead, and change nothing but the hands.

Output: `assets/models/arena/sealed-porcelain-duelist-fingers.glb` — 54 bones,
same geometry, same textures, same animations. The original is never modified;
AGENTS.md §4 records how much hand repair went into it.

## Running it

Needs Blender (5.1 was used); no addon, no Python packages.

```bash
B=/Applications/Blender.app/Contents/MacOS/Blender
SRC=assets/models/arena/sealed-porcelain-duelist.glb
cd scripts/rig-fingers

$B --background --factory-startup --python 1-add-bones.py    -- $SRC step1.blend step1.json
$B --background --factory-startup --python 2-bind-weights.py -- step1.blend $SRC step2.blend step2.json
$B --background --factory-startup --python 4-export.py       -- step2.blend ../../assets/models/arena/sealed-porcelain-duelist-fingers.glb
```

Then check it, in this order — each of these caught a real bug:

```bash
$B --background --factory-startup --python validate-bone-placement.py -- step1.blend $SRC validate.json
$B --background --factory-startup --python 3-pose-test.py              -- step2.blend poses
node ../glb-info.mjs ../../assets/models/arena/sealed-porcelain-duelist-fingers.glb
```

## What the scripts have to work around

**The mesh is a split-vertex soup.** 25,285 vertices for 24,904 triangles, where
a welded mesh would have roughly half that. Every hard edge and UV seam is
duplicated, so the mesh's own edges do not connect what visually looks connected
— connected-component search over the raw edges returns 89 fragments for one
hand. Everything welds by rounded position first.

**The four fingers are one surface.** They only separate into their own shells in
the top ~20% of the hand; below that they are a fused paddle. Only the thumb is a
genuinely separate shell. So the four fingers are split by position across the
knuckles, not by connectivity.

**Nothing is measured from a hand template.** Digit clusters, axes, lengths and
joint positions all come out of the mesh, so a regenerated character at a
different scale still works. The clustering validates itself: the four finger
lengths come out at 81 / 100 / 99 / 79 percent of the middle finger, which is the
real index/middle/ring/pinky profile, and the thumb lands on the far side of the
knuckle line next to the index on both hands.

## The curl limit — read this before animating

Because the fingers share one surface, the webbing between them stretches when
they close. The pose test sweeps the curl and the mesh holds up to **about 0.55**
of a full fist (roughly 45°/37°/30° at the three joints). Past ~0.7 the webbing
creases and tears.

So a closed hand reads fine; a hard knuckled fist does not. Drive the curl to
0.55, not 1.0.

## Known limits

- The thumb is 45–50% of the middle finger, where a real thumb is about 60%. The
  search walks its root back into the palm until it exits the mesh, so this is
  where the geometry actually ends, not a guess that can be tuned up.
- The 30 new bones carry no animation channels, so the four existing clips leave
  the fingers at their bind pose. That is deliberate: the fingers are meant to be
  driven from the tracked hand, not from a clip.
