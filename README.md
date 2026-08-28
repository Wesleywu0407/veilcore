# Veilcore

A five-minute duel you cast by drawing runes in the air. The webcam tracks your
hand; a pinch opens a stroke; the shape decides which spell, and how long you
hold decides how hard it lands.

Pure static — no build step, no server, no API. Open it and it runs.

## Running it

```bash
npm run dev          # any static server works; this one is python3's
```

Then open **http://localhost:5173/** and press ENTER THE DREAM.

`getUserMedia` needs a secure context, so `localhost` or `https` only. Opening
`index.html` from the filesystem will not get you a camera.

The hand tracker downloads MediaPipe from a CDN on first cast (~8 MB), so the
first run needs the network. Everything else is local.

## The two things that trip everyone up

**Calibration.** The pinch gate has no absolute threshold — it learns your hand
from the range it sees. Until it has seen you open wide and close tight a couple
of times, the bottom-right reads `OPEN + CLOSE TO CALIBRATE` and pinching does
nothing at all. Do that first.

**Casting is: pinch → draw → hold still → keep holding → release.** Going still
is what ends the stroke, not letting go. Letting go is what fires. The rune name
appears the instant the shape locks; the percentage next to it is your charge.

Add `?nocam` to skip the camera and cast from the keyboard instead.

## Practice range

`practice.html` — targets, no duel. Both hands up, close one hand's fingers on
the string, pull the hands apart, open them to loose.

It exists so the bow can be tuned. Every number `archery.js` measures is on the
glass while you shoot: draw in hand-spans and as a percentage, the peak reached,
the aim angle, how many hands are seen, and the tracking rate — that last one
matters because two-handed tracking costs roughly twice one hand, and if it
falls below about 20 Hz the draw will feel mushy for reasons that have nothing
to do with the numbers.

`DRAW_MIN` and `DRAW_FULL` in `js/spell-room/archery.js` are hand-spans between
the wrists. They are starting guesses. Stand where you actually play, watch
`spans` at slack and at full draw, and set them to what you see.

Aim is relative: wherever the bow hand sits when the string is nocked becomes
the centre of the screen. Facing a webcam, an archer's arrow points across the
frame rather than into it, so following the arrow literally would fire at the
wall.

## Where things live

| | |
|---|---|
| `index.html` | the page, and all of its CSS |
| `js/arena.js` | entry point: loop, camera, HUD, input, spell wiring |
| `js/arena/scene.js` | the arena geometry and its environment map |
| `js/arena/duelist.js` | one fighter: animation state machine, arm IK, cast spark |
| `js/arena/arm-ik.js` | analytic two-bone IK for the drawing arm |
| `js/arena/opponent.js` | the rival's behaviour |
| `js/arena/match.js` | objective, resources, win conditions |
| `js/arena/config.js` | **every tuning number, in one file** |
| `js/practice.js` | the practice range and its measurement panel |
| `js/spell-room/archery.js` | two-handed bow: draw length, aim, the shot |
| `js/spell-room/magic.js` | pinch gate, stroke recording, rune recognition |
| `js/spell-room/tracker.js` | webcam and MediaPipe |
| `js/spells/beam.js` | the beam effect |

Balance lives entirely in `js/arena/config.js`. Change numbers there, not at the
call sites.

## The character assets are not raw Meshy output

`assets/models/arena/*.glb` came out of Meshy's API and were repaired afterwards
by editing the GLBs directly. If you regenerate them, you have to redo this:

- **Auto-rig drops every PBR map except base colour.** The metallic-roughness
  and normal maps are re-injected into the character. The base colour survives
  remesh byte-identical, which is what proves the UVs were never re-packed.
- **`anim-hit` carried 2.5 units of root motion** on a 3.5-unit body, and
  `clampWhenFinished` left the duelist standing wherever it had slid to. The
  horizontal hip travel is pinned; the vertical dip is kept.
- **`anim-idle` turned the whole body through 97 degrees** — it is a
  "looking around" idle. Damped along the spine chain, rotation only, so the
  weight shift and the bob survive.
- **`anim-run` is action 16 (RunFast), not the rig's bundled run.** The bundled
  one sinks its toes through the floor and depicts a body moving at 2.8 units/s
  while the game moves at 5.5, which is what foot-sliding looks like.

The rig has **no finger bones** — `LeftHand`/`RightHand` are terminal. The arm
can trace a rune; the fingers cannot curl. Meshy cannot add them.

## Tests

```bash
npm run test         # 32 tests, no camera needed
npm run runes        # how far apart the rune shapes sit
```

The recogniser is tested against synthetic shaky-hand input, so you can tell
whether a change to the maths helped without picking up the camera. If you add
or reshape a rune, run `npm run runes` first: under 0.15 apart and two shapes
become the same gesture with two names.
