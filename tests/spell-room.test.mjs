// ─── Spell Room — TODO harness ────────────────────────────────────────────────
//
//   node --test tests/spell-room.test.mjs
//
// Every test here maps to one TODO in js/spell-room/magic.js. They all fail
// right now. Fill the TODOs in order and watch them go green — you never need
// to open the camera to know whether the maths is right.
//
// The last two tests are the ones that matter. Anyone can make a recognizer
// that scores 1.0 on a perfect input; the job is scoring well on a shaky hand
// and refusing to guess when the drawing is genuinely ambiguous.

import test from "node:test";
import assert from "node:assert/strict";

import {
  resample, normalizeStroke, templateDistance, recognize, bestMatch, ringLoopAssist,
  isPinching, boundingBox, pathLength, RUNES, TUNE,
  updateCast, resetMagic, updateStroke, currentStroke, TIP_FILTER,
} from "../js/spell-room/magic.js";
import { LM, dist } from "../js/spell-room/vec.js";
import { makeSteady } from "../js/spell-room/one-euro.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Turn control points into a dense path, the way a real hand would trace it. */
function trace(controlPoints, per = 30) {
  const out = [];
  for (let i = 0; i < controlPoints.length - 1; i++) {
    const a = controlPoints[i], b = controlPoints[i + 1];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  out.push(controlPoints.at(-1));
  return out;
}

/** Deterministic pseudo-random so a failure is reproducible. */
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function jitter(points, amount, rand) {
  return points.map((p) => ({
    x: p.x + (rand() - 0.5) * 2 * amount,
    y: p.y + (rand() - 0.5) * 2 * amount,
  }));
}

/** A fake hand where only the thumb and index tips matter. */
function hand(thumbIndexGap) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5 }));
  lm[LM.WRIST] = { x: 0.5, y: 0.7 };
  lm[LM.MIDDLE_MCP] = { x: 0.5, y: 0.5 };     // handScale = 0.2
  lm[LM.THUMB_TIP] = { x: 0.5, y: 0.4 };
  lm[LM.INDEX_TIP] = { x: 0.5 + thumbIndexGap, y: 0.4 };
  return lm;
}
const HAND_SCALE = 0.2;

// ─── TODO #2 — resample ───────────────────────────────────────────────────────

test("resample returns exactly n points", () => {
  const line = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  assert.equal(resample(line, 64).length, 64);
  assert.equal(resample(trace(RUNES[0].points), 32).length, 32);
});

test("resample spaces points evenly along a straight line", () => {
  const out = resample([{ x: 0, y: 0 }, { x: 1, y: 0 }], 5);
  const xs = out.map((p) => Number(p.x.toFixed(4)));
  assert.deepEqual(xs, [0, 0.25, 0.5, 0.75, 1]);
});

test("resample is indifferent to how densely the stroke was sampled", () => {
  // Same shape, one traced slowly (dense) and one quickly (sparse).
  const dense = resample(trace(RUNES[0].points, 60), 32);
  const sparse = resample(trace(RUNES[0].points, 6), 32);
  for (let i = 0; i < 32; i++) {
    assert.ok(dist(dense[i], sparse[i]) < 0.02,
      `point ${i} drifted by ${dist(dense[i], sparse[i]).toFixed(4)}`);
  }
});

// ─── TODO #3 — normalizeStroke ────────────────────────────────────────────────

test("normalizeStroke removes position and size", () => {
  const base = resample(trace(RUNES[0].points), 32);
  const moved = base.map((p) => ({ x: p.x * 3 + 0.4, y: p.y * 3 - 0.2 }));

  const a = normalizeStroke(base);
  const b = normalizeStroke(moved);
  for (let i = 0; i < a.length; i++) {
    assert.ok(dist(a[i], b[i]) < 1e-6,
      `scaled + shifted copy diverged at ${i} by ${dist(a[i], b[i])}`);
  }
});

test("normalizeStroke keeps aspect ratio (does not squash)", () => {
  // A wide flat arc must not normalize into the same thing as a tall one.
  const wide = resample(trace([{ x: 0, y: 0.45 }, { x: 0.5, y: 0.4 }, { x: 1, y: 0.45 }]), 32);
  const tall = resample(trace([{ x: 0.45, y: 0 }, { x: 0.4, y: 0.5 }, { x: 0.45, y: 1 }]), 32);
  const box = boundingBox(normalizeStroke(wide));
  assert.ok(box.w > box.h * 2, "a wide shape should stay wide after normalizing");
  const tallBox = boundingBox(normalizeStroke(tall));
  assert.ok(tallBox.h > tallBox.w * 2, "a tall shape should stay tall after normalizing");
});

test("normalizeStroke survives a perfectly straight line (zero-height box)", () => {
  const flat = resample([{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], 16);
  const out = normalizeStroke(flat);
  assert.ok(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
    "divide-by-zero produced NaN — guard the zero-size box");
});

// ─── TODO #4 — templateDistance ───────────────────────────────────────────────

test("templateDistance is zero for identical strokes", () => {
  const a = normalizeStroke(resample(trace(RUNES[0].points), 32));
  assert.ok(templateDistance(a, a) < 1e-9);
});

test("every pair of runes is far enough apart to tell apart", { skip: RUNES.length < 2 && "only one rune defined so far" }, () => {
  // Grows with you: add a fourth rune and this checks it against all three.
  // 0.15 is where two shapes stop being distinguishable by a shaky hand and
  // start trading places at random in play.
  const shapes = RUNES.map((r) => ({
    id: r.id, shape: normalizeStroke(resample(trace(r.points), 32)),
  }));
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const d = templateDistance(shapes[i].shape, shapes[j].shape);
      assert.ok(d > 0.15,
        `${shapes[i].id} and ${shapes[j].id} are only ${d.toFixed(3)} apart. ` +
        `Change one of the shapes — not TUNE.SCORE_FLOOR.`);
    }
  }
});

// ─── TODO #5 — recognize ──────────────────────────────────────────────────────

test("recognize scores a perfect drawing near 1", () => {
  for (const rune of RUNES) {
    const hit = recognize(trace(rune.points));
    assert.ok(hit, `${rune.name} was not recognised at all`);
    assert.equal(hit.rune.id, rune.id);
    assert.ok(hit.score > 0.9, `${rune.name} only scored ${hit.score?.toFixed(3)}`);
  }
});

test("recognize refuses junk instead of guessing", () => {
  assert.equal(recognize([]), null, "empty stroke");
  assert.equal(recognize([{ x: 0.5, y: 0.5 }, { x: 0.501, y: 0.5 }]), null, "a twitch");
  const scribble = trace([
    { x: 0.5, y: 0.5 }, { x: 0.52, y: 0.48 }, { x: 0.49, y: 0.51 }, { x: 0.51, y: 0.49 },
  ]);
  assert.equal(recognize(scribble), null, "a tiny scribble must not cast anything");
});

test("recognize accepts a rune drawn in the opposite direction", () => {
  // Half your players are left-handed. A rune traced right-to-left is the
  // same rune — unless you deliberately used direction to separate two
  // shapes, in which case exclude that rune here and say why.
  for (const rune of RUNES) {
    const hit = recognize(trace([...rune.points].reverse()));
    assert.ok(hit, `${rune.name} was rejected when reversed — try both directions`);
    assert.equal(hit.rune.id, rune.id);
  }
});

test("recognize holds up against a shaky hand", () => {
  // The real bar. 8% jitter is a steady hand on a laptop webcam.
  const rand = rng(20260823);
  for (const rune of RUNES) {
    let ok = 0;
    const runs = 200;
    for (let i = 0; i < runs; i++) {
      const hit = recognize(trace(jitter(rune.points, 0.08, rand)));
      if (hit && hit.rune.id === rune.id) ok++;
    }
    const rate = ok / runs;
    assert.ok(rate >= 0.9,
      `${rune.name} only recognised ${(rate * 100).toFixed(0)}% of the time. ` +
      `Do not fix this by lowering TUNE.SCORE_FLOOR — change the template shape.`);
  }
});

test("a rune survives its own smoothing, and slower survives better", () => {
  // The jitter tests above perturb a rune's CONTROL POINTS and trace the
  // result. That is a shaky SHAPE, and no filter ever sees it. The game's tip
  // is filtered per frame before the recogniser ever gets it, so this walks the
  // rune at 30Hz with noise on every sample, runs it through the real
  // TIP_FILTER and the real stroke gate, and asks the real question.
  //
  // It exists because the filter turned out to cost about a quarter of the
  // score, which nothing here could have caught: TIP_FILTER used to live in
  // tracker.js, which needs a camera and cannot be imported.
  const rand = rng(20260903);
  const walkedAt = (rune, frames) => {
    const span = 0.30;                       // a rune fills about a third of the view
    const pts = rune.points.map(p => ({ x: 0.5 + (p.x - 0.5) * span, y: 0.5 + (p.y - 0.5) * span }));
    const path = trace(pts, Math.ceil(frames / (pts.length - 1)));
    const fx = makeSteady(TIP_FILTER), fy = makeSteady(TIP_FILTER);
    let t = 0;
    updateStroke(false, { x: 0, y: 0 }, t);
    for (const p of path) {
      t += 1000 / 30;
      const nx = p.x + (rand() - 0.5) * 2 * 0.002;
      const ny = p.y + (rand() - 0.5) * 2 * 0.002;
      updateStroke(true, { x: fx.filter(nx, t), y: fy.filter(ny, t) }, t);
    }
    const drawn = currentStroke().slice();
    updateStroke(false, { x: 0, y: 0 }, t + 40);
    return bestMatch(drawn);
  };

  for (const rune of RUNES) {
    // Drawn at an unhurried pace, every rune casts through its own filter.
    const slow = walkedAt(rune, 80);
    assert.ok(slow && slow.rune.id === rune.id && slow.ready,
      `${rune.name} does not survive TIP_FILTER even drawn slowly` +
      ` (${slow ? slow.score.toFixed(3) : 'no match'}). The filter's lag rounds` +
      ` the corners off; do not answer this by lowering TUNE.SCORE_FLOOR.`);

    // ── And so does a FLICK, which is the one this is really guarding ──
    //
    // Three quarters of a second, which is how fast a rune gets drawn when
    // something is coming at you. At the beta this filter shipped with -- 0.015,
    // where the adaptive half did nothing at all -- two of the three runes did
    // not cast at this speed and nothing in this repo could see it. If this
    // fails, run `npm run tip`: the answer is in the beta column, not in the
    // score floor and not in the rune's shape.
    const flick = walkedAt(rune, 22);
    assert.ok(flick && flick.rune.id === rune.id && flick.ready,
      `${rune.name} drawn in 0.73s scored ${flick ? flick.score.toFixed(3) : 'nothing'}` +
      ` and would not cast. TIP_FILTER's lag is eating the corners.`);

    // The lag is what costs it, so drawing faster must still score less.
    assert.ok(flick.score < slow.score,
      `${rune.name} scored no worse drawn nearly four times as fast — either` +
      ` TIP_FILTER is doing nothing, or the walk is not actually faster`);
  }
});

test("the tip deadband holds a still hand still, which the lowpass cannot", () => {
  // The whole reason TIP_FILTER carries a deadband. A hand held still still has
  // the model's wobble on it, and without the deadband that wobble reaches the
  // screen as a cursor that will not sit down.
  // Its own generator, so the numbers are reproducible without reaching into
  // Math.random -- every other test in this process shares that one.
  let seed = 0;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * 2 * 0.002;
  };

  const still = filter => {
    let last = null, moved = 0;
    for (let i = 1; i <= 120; i++) {
      const out = filter.filter(0.5 + noise(), i * (1000 / 30));
      if (last !== null) moved += Math.abs(out - last);
      last = out;
    }
    return moved / 119;
  };

  seed = 0;
  const withBand = still(makeSteady(TIP_FILTER));
  seed = 0;
  const without = still(makeSteady({ ...TIP_FILTER, deadband: 0 }));

  assert.ok(withBand < without / 10,
    `the deadband barely helped: ${withBand.toExponential(2)} vs ${without.toExponential(2)}`);
  // Under a tenth of a pixel per frame on a 1920 window.
  assert.ok(withBand * 1920 < 0.1,
    `a still cursor still drifts ${(withBand * 1920).toFixed(2)}px a frame`);
});

test("recognize never returns the wrong spell under jitter", () => {
  // Failing to cast is a bad moment. Casting the wrong thing loses the duel.
  // Folded into one test with a hit-count floor, because "never wrong" passes
  // for free while recognize() still returns null — and a test that cannot
  // fail is worse than no test.
  const rand = rng(7);
  for (const rune of RUNES) {
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      const hit = recognize(trace(jitter(rune.points, 0.08, rand)));
      if (!hit) continue;
      hits++;
      assert.equal(hit.rune.id, rune.id,
        `drawing ${rune.name} produced ${hit.rune.name} — raise TUNE.SCORE_MARGIN`);
    }
    assert.ok(hits > 0, `${rune.name} never matched anything — recognize() is still a stub`);
  }
});

test("Ringfall assist accepts a closed oval but refuses both triangles and an open arc", () => {
  const oval = Array.from({ length: 41 }, (_, i) => {
    const angle = (i / 40) * Math.PI * 2;
    return { x: 0.5 + Math.cos(angle) * 0.24, y: 0.5 + Math.sin(angle) * 0.16 };
  });
  const openArc = oval.slice(0, 31);

  assert.equal(ringLoopAssist(oval)?.ready, true, "a complete hand-drawn oval should receive loop assistance");
  assert.equal(ringLoopAssist(openArc)?.ready, false, "three quarters of a circle is not closed");
  assert.equal(ringLoopAssist(trace(RUNES[1].points))?.ready, false, "Aegis must not become Ringfall");
  assert.equal(ringLoopAssist(trace(RUNES[2].points))?.ready, false, "Gravity Seal must not become Ringfall");
});

// ─── TODO #1 — isPinching ─────────────────────────────────────────────────────

test("isPinching is scale invariant", () => {
  // Same gesture, hand twice as far from the camera → every distance halves.
  //
  // Each reading has to SETTLE before it is compared. The gate debounces, so a
  // single call reports the state before the change, not after — comparing two
  // single calls would measure the debounce, not the scaling.
  let t = 1000;
  const settle = (lm, scale, frames = 12) => {
    isPinching(null, scale, t);            // reset, so the two runs are independent
    let out = false;
    for (let i = 0; i < frames; i++) { out = isPinching(lm, scale, t); t += 16; }
    return out;
  };

  const near = hand(0.05);
  const far = near.map((p) => ({ x: p.x * 0.5 + 0.25, y: p.y * 0.5 + 0.25 }));

  assert.equal(settle(near, HAND_SCALE), settle(far, HAND_SCALE * 0.5),
    "the same pinch read differently at a different distance — divide by handScale");

  // And the reverse: an open hand must stay open at both distances.
  const openNear = hand(0.20);
  const openFar = openNear.map((p) => ({ x: p.x * 0.5 + 0.25, y: p.y * 0.5 + 0.25 }));
  assert.equal(settle(openNear, HAND_SCALE), false);
  assert.equal(settle(openFar, HAND_SCALE * 0.5), false);
});

test("isPinching does not flicker while held still", () => {
  // A held hand with landmark noise. Without hysteresis the gate flips several
  // times a second, and every flip starts or ends a stroke.
  //
  // The hand is held at a whole sweep of gaps rather than one, because a single
  // fixed gap only lands on the threshold of ONE implementation — sweep, and
  // whatever threshold you end up using, some centre will sit right on it.
  const rand = rng(99);
  let worst = 0;
  let worstGap = 0;

  for (let gap = 0.01; gap <= 0.22; gap += 0.005) {
    let transitions = 0;
    let prev = null;
    for (let i = 0; i < 200; i++) {
      const noisy = gap + (rand() - 0.5) * 0.012;
      const state = isPinching(hand(noisy), HAND_SCALE, 1000 + i * 16);
      if (prev !== null && state !== prev) transitions++;
      prev = state;
    }
    if (transitions > worst) { worst = transitions; worstGap = gap; }
  }

  assert.ok(worst <= 2,
    `held still at a ${worstGap.toFixed(3)} gap, the gate flipped ${worst} times. ` +
    `Add hysteresis (PINCH_ON vs PINCH_OFF) and the PINCH_HOLD_MS debounce.`);
});

test("isPinching still responds to a real open and close", () => {
  let t = 1000;
  const step = (gap, frames = 12) => {
    let out = false;
    for (let i = 0; i < frames; i++) { out = isPinching(hand(gap), HAND_SCALE, t); t += 16; }
    return out;
  };
  assert.equal(step(0.20), false, "an open hand must not read as a pinch");
  assert.equal(step(0.02), true, "a firm pinch must register");
  assert.equal(step(0.20), false, "opening the hand must release");
});

// ─── Sanity on the parts that were already written ────────────────────────────

test("pathLength and boundingBox agree with hand maths", () => {
  const square = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
  ];
  assert.equal(pathLength(square), 3);
  const box = boundingBox(square);
  assert.deepEqual([box.x, box.y, box.w, box.h], [0, 0, 1, 1]);
});

// ─── Charged casting ──────────────────────────────────────────────────────────
//
// The state machine, driven frame by frame with no camera. Each helper walks
// simulated time forward the way the real loop would.

function caster() {
  let t = 1000;
  resetMagic();
  // Where the hand actually is. hold() must stay HERE — parking it at a fixed
  // coordinate teleports the fingertip across the frame, and that jump gets
  // recorded into the stroke and wrecks the shape. A closed rune finishes at
  // the top of the ring, an open one at its far end; no single position is
  // correct for both.
  let at = { x: 0.5, y: 0.5 };
  const step = (gate, tip, ms = 16) => { t += ms; at = { ...tip }; return updateCast(gate, tip, t); };
  return {
    /** Trace a rune at drawing speed — fast enough to never look "still". */
    draw(controlPoints) {
      const path = trace(controlPoints, 12);
      let last = null;
      for (const p of path) last = step(true, p, 16);
      return last;
    },
    /**
     * Hold the hand still at wherever it stopped, for `ms`.
     *
     * Events fire on a single frame, so returning only the last one would miss
     * anything that happened partway through. Keep the first event seen.
     */
    hold(ms) {
      const tip = { ...at };
      let last = null;
      let seen = null;
      for (let i = 0; i < Math.ceil(ms / 16); i++) {
        last = step(true, tip, 16);
        if (last.event && !seen) seen = last.event;
      }
      return { ...last, event: seen ?? last.event };
    },
    release() { return step(false, { ...at }); },
  };
}

test("a rune locks once the hand goes still, without letting go", () => {
  const c = caster();
  const mid = c.draw(RUNES[1].points);
  assert.equal(mid.phase, "drawing", "still moving — must not lock yet");

  const locked = c.hold(TUNE.STILL_MS + 60);
  assert.equal(locked.phase, "charging", "hand stopped but the rune never locked");
  assert.equal(locked.rune.id, RUNES[1].id);
});

test("a closed Ringfall loop locks immediately before a release tail can spoil it", () => {
  const c = caster();
  const locked = c.draw(RUNES[0].points);
  assert.equal(locked.phase, "charging");
  assert.equal(locked.rune.id, "ringfall");
  assert.equal(locked.assisted, true);
});

test("charge grows with how long you hold, and starts above zero", () => {
  const c = caster();
  c.draw(RUNES[0].points);
  const early = c.hold(TUNE.STILL_MS + 60).charge;
  assert.ok(early >= TUNE.CHARGE_MIN, `a fresh lock should start at CHARGE_MIN, got ${early}`);

  const later = c.hold(TUNE.CHARGE_FULL_MS * 0.6).charge;
  assert.ok(later > early, "holding longer must charge further");
  assert.ok(later <= 1, "charge must never exceed 1");
});

test("releasing fires the locked rune at the charge you held", () => {
  const c = caster();
  c.draw(RUNES[0].points);
  c.hold(TUNE.STILL_MS + 60);
  c.hold(TUNE.CHARGE_FULL_MS);
  const out = c.release();
  assert.equal(out.event?.type, "fired");
  assert.equal(out.event.rune.id, RUNES[0].id);
  assert.ok(out.event.charge > 0.9, `a full hold should fire near 1, got ${out.event.charge}`);
});

test("a quick flick still casts, at minimum power", () => {
  // Letting go before the shape settles must not swallow the cast — punishing
  // speed here would make the whole system feel sluggish. Use a triangle:
  // Ringfall now locks as soon as its loop closes and legitimately begins
  // charging before release.
  const c = caster();
  c.draw(RUNES[1].points);
  const out = c.release();
  assert.equal(out.event?.type, "fired");
  assert.equal(out.event.charge, TUNE.CHARGE_MIN);
});

test("holding too long overloads instead of charging forever", () => {
  // This is the ceiling that stops "always charge to full" from being the only
  // answer anyone ever needs.
  const c = caster();
  c.draw(RUNES[0].points);
  c.hold(TUNE.STILL_MS + 60);
  const out = c.hold(TUNE.CHARGE_OVERLOAD_MS + 200);
  assert.equal(out.event?.type, "overloaded");
  assert.equal(out.phase, "spent",
    "after an overload the pinch is still held — it must stay dead until released, " +
    "or the overload silently rolls into a new stroke and costs the player nothing");

  // And it really is dead: more holding does not start another rune.
  assert.equal(c.hold(600).phase, "spent");
  // Letting go clears it.
  c.release();
  assert.equal(c.hold(50).phase, "drawing");
});

test("pausing mid-rune does not steal the stroke", () => {
  // A player who stops halfway through a Z has not finished drawing. Locking
  // a wrong shape there would be the most infuriating possible failure.
  const c = caster();
  const half = c.draw(RUNES[0].points.slice(0, 2));   // just the top bar
  assert.equal(half.phase, "drawing");
  const paused = c.hold(TUNE.STILL_MS + 100);
  assert.equal(paused.phase, "drawing", "a partial rune must not lock");
});

// ─── Live preview ─────────────────────────────────────────────────────────────

test("bestMatch reports a near miss that recognize() would throw away", () => {
  // The whole point of splitting the two: a stroke below the floor still has a
  // closest rune and a distance, and that is what a player mid-draw needs.
  // Three quarters of a ring is not a Ringfall yet.
  const partial = trace(RUNES[0].points.slice(0, 13));
  const strict = recognize(partial);
  const loose = bestMatch(partial);
  assert.ok(loose, "a real partial stroke must still measure");
  assert.equal(loose.ready, strict !== null, "ready must agree with recognize()");
  assert.ok(loose.score > 0 && loose.score <= 1, `score out of range: ${loose.score}`);
});

test("bestMatch agrees with recognize on a complete rune", () => {
  for (const rune of RUNES) {
    const stroke = trace(rune.points);
    const strict = recognize(stroke);
    const loose = bestMatch(stroke);
    assert.ok(loose.ready, `${rune.id} should be ready`);
    assert.equal(loose.rune.id, strict.rune.id);
    assert.equal(loose.score, strict.score);
  }
});

test("bestMatch still refuses junk outright", () => {
  assert.equal(bestMatch([]), null);
  assert.equal(bestMatch([{ x: 0.5, y: 0.5 }]), null, "one point is not a stroke");
  // A twitch: enough points, no extent.
  const twitch = Array.from({ length: 20 }, (_, i) => ({ x: 0.5 + i * 1e-4, y: 0.5 }));
  assert.equal(bestMatch(twitch), null);
});

test("the preview rises as a rune is drawn, and clears between strokes", () => {
  resetMagic();
  let now = 1000;
  const scores = [];
  const N = 40;
  let final = null;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    now += 1000 / 30;
    const state = updateCast(true, { x: 0.5 + Math.cos(a) * 0.22, y: 0.5 + Math.sin(a) * 0.22 }, now);
    final = state;
    if (state.preview) scores.push(state.preview.score);
  }
  assert.ok(scores.length > 4, "the preview should report throughout the stroke");
  assert.ok(scores.at(-1) > scores[0], "a finished ring must score better than a first arc");
  assert.equal(final.phase, "charging", "closing the ring should lock it without a still hold");
  assert.equal(final.assisted, true);

  // A fresh stroke must not open showing the last one's verdict.
  resetMagic();
  const fresh = updateCast(true, { x: 0.5, y: 0.5 }, now + 1000);
  assert.equal(fresh.preview, null);
});
