# Hand casting — draw a rune in the air, SKYVEIL fires the spell

Pinch thumb and index, draw a shape, release. If the shape matches a rune, the
matching weapon casts.

```
js/spell-room/vec.js        LM indices, dist, clamp                  done
js/spell-room/tracker.js    webcam + MediaPipe → one frame object    done
js/spell-room/magic.js      gate + recognizer                        ← your work
js/sky-room/hand-casting.js the bridge into SKYVEIL                  done
spell-room.html             standalone sandbox                       done
scripts/rune-distance.mjs   measures whether two runes are too alike
tests/spell-room.test.mjs   one test per TODO
```

## Where it plugs in

`hand-casting.js` implements **no magic of its own**. It recognises a shape and
then calls the same `game.setWeapon()` / `game.cast()` the mouse and the touch
buttons already call ([sky-room.js:2935](../js/sky-room.js)). Damage, VFX, audio
and multiplayer sync come along for free, and changing a spell never means
touching this code.

Two lines were added to `sky-room.js`: the import, and an `H` key next to the
existing `Digit1/2/3` weapon switch. Hand casting stays **off** until H is
pressed — a room that grabs the webcam on load is a room people close, and the
keypress doubles as the user gesture `getUserMedia` requires.

Weapons, from `sky-room.js:977`: `1` ember bolt · `2` scatter fan · `3` moonbow
(a drawn shot, so `hand-casting.js` routes it through `drawStart`/`releaseBow`
instead of a plain `cast()`).

## Two ways to run it

**Sandbox** — `spell-room.html`. Just the camera, the trail, and the readout.
Loads in a second and nothing else can be blamed when something misbehaves.
Work here.

```
python3 -m http.server 4173
# http://localhost:4173/spell-room.html
```

**In the game** — `http://localhost:4173/sky-room.html`, then press `H`.

Both run **before** the TODOs are filled in: the stubs are caught and reported
rather than crashing. Do that first. Pinch, hold still for ten seconds, and
watch the trail shatter into fragments — that is the flicker TODO #1 exists to
fix, and feeling it is worth more than reading about it.

## The five TODOs

```
node --test tests/spell-room.test.mjs     # 13 red
```

| # | Function | What it teaches |
|---|----------|-----------------|
| 2 | `resample` | Speed-independent sampling. Everything downstream is meaningless without it. |
| 3 | `normalizeStroke` | Position and size invariance — and why both axes scale by the *same* number. |
| 4 | `templateDistance` | Three lines. Named separately so #5 stays readable, and so you can swap it later. |
| 5 | `recognize` | Floors, margins, reversal, and the closed-loop rotation trap. |
| 1 | `isPinching` | Scale-invariant thresholds, hysteresis, debounce. |

`isPinching` is last on purpose: the naive version already draws well enough to
work with, so fix the maths first and come back to the feel.

## Choosing your own runes

One rune is defined (`bolt` → weapon 1) as a format example. Weapons 2 and 3 are
yours to design. Pick shapes, then **measure**:

```
node scripts/rune-distance.mjs
```

| distance | verdict |
|---|---|
| > 0.35 | comfortable — a shaky hand will not cross the gap |
| 0.15 – 0.35 | workable; the jitter test will tell you what it costs |
| < 0.15 | the same gesture under two names |

The tool runs on *your* `resample` / `normalizeStroke` / `templateDistance`, so
it only works once #2–#4 are done. That order is deliberate: you cannot judge
whether two shapes are distinguishable until you have written the thing that
distinguishes them.

One number worth having up front, because it is exactly the trap that bit the
hackathon build: an arc `⌒` and an inverted V `∧` sit **0.057** apart. To
point-by-point comparison they are the same shape, so a slightly rounded `∧`
casts the arc's spell at high confidence — the wrong spell, no fizzle, no
warning. Corner count separates shapes far better than curvature does.

## The one idea worth carrying out of here

Detection is the easy half. The hard half is that a **rejected** gesture has to
feel like the player's fault rather than the camera's.

The two failure modes are not symmetric:

- **False reject** — drew it right, nothing happened. Annoying, recoverable if
  it is rare and if the fizzle looks different from "no hand detected".
- **False accept** — drew Bolt, got Fan. Worse. It reads as the game being
  broken, and retrying does not repair the impression.

That asymmetry is why `recognize()` needs both a floor *and* a margin. The floor
stops nonsense. The margin stops two runes trading places when a drawing sits
between them — without it the same gesture casts different spells on different
attempts, which is the fastest way to lose someone's trust in a gesture
interface.

It is also why you never fix a low recognition rate by lowering
`TUNE.SCORE_FLOOR`. That trades a false reject for a false accept: the wrong
direction. Change the shape instead.
