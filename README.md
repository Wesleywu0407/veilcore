# Veilcore

A five-minute duel you cast by drawing runes in the air. The webcam tracks your
hand; a pinch opens a stroke; the shape decides which spell, and how long you
hold decides how hard it lands.

The front end is still plain static files with no build step or framework. A
small dependency-free Node server now serves those files and owns two-player
room codes plus WebSocket relay; solo play still works without a remote player.

> **Status: playable, still being tuned.** The duel and the practice range both
> work end to end. Runes use one hand; raising both hands switches the duel to
> the bow. See [Where it stands](#where-it-stands).

## Opening it

There is no build step or install step. Start the duel server and open a page.

```bash
cd veilcore
npm run dev
```

| | |
|---|---|
| **http://localhost:5174/** | the duel — press **BEGIN DUEL** |
| **http://localhost:5174/practice.html** | the practice range — press **OPEN THE RANGE** |

`npm run dev` starts the dependency-free static/WebSocket server on every local
interface. It prints both the loopback and LAN addresses. A generic static
server can still run solo mode, but room buttons require this server.

If you use the **Live Server** extension in VS Code or Cursor, right-click
`index.html` → *Open with Live Server*, and the ports become **5500** (solo
only):

```
http://127.0.0.1:5500/index.html
http://127.0.0.1:5500/practice.html
```

**Do not open the files by double-clicking them.** `getUserMedia` only works in
a secure context, which means `localhost`, `127.0.0.1`, or `https`. From a
`file://` URL the page loads and the camera never arrives, with no error that
says so.

First run needs the network: the hand tracker pulls MediaPipe from a CDN (~8 MB)
the first time you cast. Everything after that is local. Nothing you do is sent
anywhere — the video never leaves the browser. In a room, only position, health,
mana and combat events cross the WebSocket.

### Playing a friend

The easiest camera-safe route is one command:

```bash
npm run share
```

`npm run share` starts the game and room server, waits until it is healthy, then
prints a temporary trusted Pinggy HTTPS address and verifies that it reaches
Veilcore before marking it ready. Keep that terminal open. Both
players open the same address. One presses **CREATE ROOM** and sends the
four-character code; the other enters it and presses **JOIN ROOM**. The duel
begins when the second player arrives. The tunnel URL is public but unlisted
and disappears as soon as the command stops. The free link lasts up to 60
minutes; running the command again creates a new address.

Do not use a VS Code Live Server address (`127.0.0.1:5500`) for rooms. It serves
the static page but has no WebSocket server, so it is deliberately solo-only.

For a LAN-only HTTPS session, create a local certificate instead:

```bash
npm run cert
npm run dev:https
```

Both devices must install and trust `.cert/veilcore-ca.crt`, then open the HTTPS
LAN address printed by the server. Trust is necessary: a plain `http://192.168…`
page can load the game, but browsers will refuse its webcam.

### If the camera never starts

The bottom-right corner tells you which step it is on. `OPEN + CLOSE TO
CALIBRATE` means the camera is fine and the pinch gate is still learning your
hand — see below. Anything else is a real failure, and the message names the
step. Press **H** on either page to retry the camera without reloading.

## The two things that trip everyone up

**Calibration.** The pinch gate has no absolute threshold — it learns your hand
from the range it sees. Until it has seen you open wide and close tight a couple
of times, the bottom-right reads `OPEN + CLOSE TO CALIBRATE` and pinching does
nothing at all. Do that first.

**Casting is: pinch → draw → hold still → keep holding → release.** Going still
is what ends the stroke, not letting go. Letting go is what fires. The rune name
appears the instant the shape locks; the percentage next to it is your charge.

### The runes

Three, defined in `js/spell-room/magic.js`:

| rune | shape | mana | what it does |
|---|---|---|---|
| **Ringfall** | a circle ○ | 20 | the attack. Damage scales with charge, 12 → 34 |
| **Aegis** | a triangle, point up △ | 24 | a guard that absorbs the next spell |
| **Gravity Seal** | a triangle, point down ▽ | 30 | disables the rival's core |

All three are closed shapes, which is why the recogniser tries every cyclic
rotation of your stroke — a circle has no corner to start from, so without that
only a player who happened to begin at the top would ever be recognised.

The pair to watch is **Ringfall and Aegis**, at 0.175 — a circle against an
upright triangle. Aegis and Gravity Seal look like the risky pair, being the
same triangle inverted, but they are the furthest apart of the three (0.467):
reversal and rotation cannot turn a point-up triangle into a point-down one.
The circle is the promiscuous shape, because a rotationally symmetric stroke
aligns against nearly anything. Run `npm run runes` before reshaping any of
them, and see [docs/spell-room.md](docs/spell-room.md) for why.

### Keyboard

Movement and camera are always on the keyboard and mouse; the hands are only
for casting. Add `?nocam` to the URL to skip the camera entirely and cast from
the keyboard too.

| key | |
|---|---|
| **W A S D** | move |
| *mouse* | look — click the canvas first to lock the pointer |
| **1 2 3** | pick Ringfall / Aegis / Gravity Seal |
| **J** | cast the selected rune, weakly (0.3 charge) |
| **K** | cast it at full charge |
| **Tab** | switch target between the rival and its core |
| **V** | hold first person, to look down your own arm |
| **H** | turn hand tracking on or off, without reloading |
| **R** | next round, once the match has finished |

The camera normally decides for itself: it sits behind you, swings over your
shoulder while you draw a rune, and goes to your own eye whenever the bow or the
fists come up. **V** holds it at the eye regardless — which is the only way to
watch your own hand while casting one-handed, and it works with no webcam at all.

Raise **one hand** to cast runes. Raise **both hands** for one of the two
two-handed stances, and roll your wrists to say which:

- **Knuckles upright** — the fist eye pointing at the ceiling, the way a hand
  grips a bow riser — takes up the **bow**. Close one hand on the string, pull
  the wrists apart, aim by moving the bow hand, then open the string hand to
  loose.
- **Knuckles flat** — the fist eye pointing left or right, the way a straight
  punch lands — puts up your **fists**. Drive a fist at the lens to throw it.
  Punching costs no mana and waits on no cooldown; what it needs instead is to
  be within 2.2 of the rival and roughly facing them.

The roll is read off the line across the knuckles, and both wrists have to agree
before the stance changes, so a single misread hand cannot switch it under you.
Finger closure is deliberately not part of that test — opening the string hand
is how an arrow is loosed, and a stance that watched the fingers would drop the
bow on the release frame. Lowering either hand returns to rune casting and
clears whichever two-handed state was running; entering either stance likewise
clears a partial rune, so the gesture pipelines cannot fire each other by
accident. The mirrored self view in the lower-right shows the tracked hand
skeleton and the live mode.

## The duel

Five minutes, 100 HP, 100 mana. Mana trickles back at 3.2/s anywhere — and at
7/s if you hold the Well at the centre of the arena, which takes four seconds to
capture. That gap is the whole game: the Well is the only way to afford to keep
attacking, so both of you have to keep leaving cover to stand in the open.

In **SOLO DUEL** the rival is a bot, and it pays for its own attacks out of the
same mana pool you do. In a room the bot is disabled: position, charging,
Ringfall, Aegis, Gravity Seal, arrows, damage, Core disruption and round resets
come from the other player instead.

The bow is aimed rather than auto-directed. Its reticle starts wherever the bow
hand was when the string was nocked, then follows that wrist relative to the
starting point. An arrow can strike the rival or its Core; Aegis absorbs it the
same way it absorbs Ringfall. Its first balance pass uses Ringfall's mana,
cooldown, and damage envelope so aim is the only new variable being judged.

Every number above lives in `js/arena/config.js`.

## Practice range

`practice.html` — targets, no rival, no clock. Both hands up, close one hand's
fingers on the string, pull the hands apart, open them to loose. The string hand
is whichever hand's fingers are closed, so left-handed archers need no setting.

Draw length is the wrist-to-wrist distance measured in hand-spans, which is why
the bow is two-handed at all: a span-relative measurement has no depth term in
it, and depth is the thing a single webcam is worst at.

The range exists so the bow can be tuned. Every number `archery.js` measures is
on the glass while you shoot: draw in hand-spans and as a percentage, the peak
reached, the aim angle, how many hands are seen, and the tracking rate — that
last one matters because two-handed tracking costs roughly twice one hand, and
if it falls below about 20 Hz the draw will feel mushy for reasons that have
nothing to do with the numbers.

`DRAW_MIN` 2.3 and `DRAW_FULL` 5.0 in `js/spell-room/archery.js` are hand-spans
between the wrists, set from a real measurement — 2.1 spans slack, 5.3 at full
draw — with margin left at both ends. Stand where you actually play and watch
`spans` before changing them. If the draw feels like it maxes out too early, or
mushy in the middle, that is the linear curve *between* the two bounds rather
than the bounds themselves; add easing instead of moving them.

Aim is relative: wherever the bow hand sits when the string is nocked becomes
the centre of the screen. Facing a webcam, an archer's arrow points across the
frame rather than into it, so following the arrow literally would fire at the
wall.

## Where it stands

Done:

- The duel — runes, canvas HUD, objective, bot, win conditions.
- Two-player rooms — dependency-free WebSocket relay, mirrored arena position,
  combat events, health/mana snapshots, disconnect pause and shared reset.
- Two-handed bow measurement (`js/spell-room/archery.js`) — pure functions, no
  camera or DOM, 11 tests.
- The bow in the duel — two-hand mode switching, relative aim, mirrored IK draw
  poses, arrow/Core hit testing, mana, cooldown, damage, and close third-person
  framing.
- The practice range, and the bow on screen (`js/arena/bow-view.js`): the Meshy
  mesh with its baked string cut out, plus a procedural string and arrow.
- Meshy arena effects — a textured Gravity Seal plus low-poly Veil Core, hand
  focus and mana-shard GLBs. They share page-level loader/cache code and keep
  their gameplay timing in the modules that own each effect.

Open:

- **The practice-range placement still wants a human eye** — `BOW_LENGTH`,
  `PRACTICE_BOW_MOUNT`, `NOCK_TRAVEL`, and `ARROW_LENGTH` in
  `js/arena/bow-view.js`. The duel has its own body-space mount and its right-
  and left-handed framing have both been checked on the real rig.

## Where things live

| | |
|---|---|
| `index.html` | the page, and all of its CSS |
| `js/arena.js` | entry point: loop, camera, HUD, input, spell wiring |
| `js/arena/scene.js` | the arena shell, Core and mana-drop mounts, and environment map |
| `js/arena/asset-library.js` | one cached GLB loader shared by arena systems |
| `js/arena/duelist.js` | one fighter: animation state machine, arm IK, Meshy hand focus |
| `js/arena/arm-ik.js` | analytic two-bone IK for the drawing arm |
| `js/arena/bow-view.js` | the bow on screen: mesh placement, string, arrow |
| `js/arena/opponent.js` | the rival's behaviour |
| `js/arena/match.js` | objective, resources, win conditions |
| `js/arena/config.js` | **every tuning number, in one file** |
| `js/practice.js` | the practice range and its measurement panel |
| `js/spell-room/archery.js` | two-handed bow: draw length, aim, the shot |
| `js/spell-room/boxing.js` | fists: the wrist roll that picks the stance, and the punch |
| `js/spell-room/magic.js` | pinch gate, stroke recording, rune recognition |
| `js/spell-room/tracker.js` | webcam and MediaPipe |
| `js/spell-room/fingers.js` | how closed each finger is, from the landmarks |
| `js/spell-room/one-euro.js` | the smoothing filter on the tracked points |

Balance lives entirely in `js/arena/config.js`. Change numbers there, not at the
call sites.

One thing that reads as a bug and is not: the webcam mirrors, and `tracker.js`
un-mirrors `x` once on the way in. MediaPipe's handedness label is computed
*before* that, so it calls a physical right hand "Left" — which is why sides are
derived from `x` position instead of from the label. Leave it alone.

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

The rig as Meshy delivered it has **no finger bones** — `LeftHand`/`RightHand`
are terminal, so the arm can trace a rune but the hand is one rigid lump. Meshy
will not add them: run against this exact mesh, its rigging API returned the
same 24-bone template, decimated the mesh from 24,904 triangles to 170, and
dropped two of the three PBR maps.

`sealed-porcelain-duelist-fingers.glb` is that same model with 30 finger bones
added locally in Blender — same geometry, same textures, same 24 animated bone
names, so all four clips still bind. The duel loads this one;
`sealed-porcelain-duelist.glb` is kept beside it untouched. See
`scripts/rig-fingers/` for the pipeline and, importantly, for the curl ceiling:
the four fingers share one surface, so a hand may close to about 0.55 of a fist
before the webbing between them tears.

The small effects under `assets/models/arena/vfx/` are deliberately separate
from the repaired character pipeline. They are Smart Topology GLBs with one
primitive each: the Core is 2,078 triangles, the hand focus 1,170, and the mana
shard 661. Gravity Seal is 2,472 triangles and carries one 1024px base-colour
texture; the other three are textureless and receive the two team colours in
the game. None of these effects casts a shadow.

## Tests

```bash
npm run test         # 110 tests, no camera needed
npm run runes        # how far apart the rune shapes sit
npm run assets       # triangles, textures, download size and VRAM per GLB
```

The recogniser is tested against synthetic shaky-hand input, so you can tell
whether a change to the maths helped without picking up the camera. If you add
or reshape a rune, run `npm run runes` first: under 0.15 apart and two shapes
become the same gesture with two names.

Never fix a low recognition rate by lowering `TUNE.SCORE_FLOOR`. That trades a
false reject for a false accept — drawing Ringfall and getting Aegis reads as
the game being broken, where nothing happening at all reads as your own bad
handwriting. Change the shape instead.

## Contributing

Working rules for AI assistants — Claude Code, Codex, Copilot, and the rest —
are in [AGENTS.md](AGENTS.md), and they are worth a read for humans too: they
list the traps above in the order they tend to bite.

## Licence

[MIT](LICENSE) © 2026 Wesley Wu.

The code is MIT. The 3D models under `assets/models/` were generated with
[Meshy](https://www.meshy.ai/) and then hand-repaired; if you plan to reuse them
outside this project, check Meshy's asset terms for your own account tier rather
than assuming the MIT grant carries them.
