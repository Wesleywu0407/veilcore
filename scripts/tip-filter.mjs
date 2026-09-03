// ─── What the wand tip's filter costs ────────────────────────────────────────
//
//   node scripts/tip-filter.mjs
//
// Run this before touching TIP_FILTER in js/spell-room/magic.js, the way you
// run `npm run runes` before reshaping a rune. It answers the only three
// questions that filter is trading between, and it answers them in the units
// the trade is actually felt in.
//
// ── Why a tool and not a judgement ──
//
// TIP_FILTER is the last thing to touch a rune before the recogniser sees it,
// and it is not a small effect: shipped at beta 0.015 it cost about a quarter
// of the score, and two of the three runes would not cast at all if you drew
// them in under a second. None of that was visible from the game, from the
// tests, or from the number itself. It took walking a rune through the real
// pipeline at a known speed.
//
// The three columns:
//
//   recognition   the score bestMatch() gives, per rune, at four draw speeds.
//                 ✗ means that rune would not cast at all; ~ means sometimes.
//   lag           how far behind the hand the drawn point runs, while moving.
//                 This is what "the cursor feels like it is on a string" is.
//   still         pixels of drift per frame on a hand being held perfectly
//                 still. This is the DEADBAND's job, not the lowpass's, and
//                 the table shows it: it does not move with beta at all.
//
// The shape of the answer, measured 2026-09-03: raising beta improves all
// three at once until about 12, because at low beta the error on the line is
// dominated by the lag distorting the shape rather than by noise. beta is the
// adaptive half -- it does nothing at all while the hand is slow -- so it costs
// nothing at the still end, which is what the deadband is there for.

import { RUNES, bestMatch, updateStroke, currentStroke, TUNE, TIP_FILTER }
  from '../js/spell-room/magic.js';
import { makeSteady } from '../js/spell-room/one-euro.js';

const NOISE = 0.002;   // the hand model's residual wobble on a still fingertip
// ── The half the first version of this tool missed ──
//
// A hand does not only carry the model's per-frame noise. It carries its own
// TREMOR: a real, low-frequency wander of a few hertz that the person is not
// choosing to make. White noise and tremor need completely different answers,
// and a probe that models only the first will happily recommend a filter that
// passes all of the second -- which is what happened, and what it felt like was
// "too fast".
//
// minCutoff 1.2 sits below the tremor band on purpose, so the shipped filter
// removed it. beta raises the cutoff with speed, so a large beta lets it back
// in exactly while the hand is drawing.
const TREMOR_HZ = 3.5;
const TREMOR = 0.004;   // about 8px on a 1920 window, peak
const SPAN = 0.30;     // a rune fills about a third of the picture
const HZ = 30;
const RUNS = 60;
const SPEEDS = [22, 33, 50, 80];       // frames, i.e. 0.7s to 2.7s to draw
const WIDE = 1920;                     // a window, for putting drift in pixels

const rng = seed => {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
};

/** Walk a rune's outline at a constant speed, one sample per frame. */
function walk(points, frames) {
  const seg = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const d = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    seg.push(d);
    total += d;
  }
  const out = [];
  for (let f = 0; f < frames; f++) {
    let want = (f / (frames - 1)) * total;
    let i = 0;
    while (i < seg.length - 1 && want > seg[i]) { want -= seg[i]; i++; }
    const t = seg[i] > 0 ? want / seg[i] : 0;
    out.push({
      x: points[i].x + (points[i + 1].x - points[i].x) * t,
      y: points[i].y + (points[i + 1].y - points[i].y) * t,
    });
  }
  return out;
}

const scaled = points =>
  points.map(p => ({ x: 0.5 + (p.x - 0.5) * SPAN, y: 0.5 + (p.y - 0.5) * SPAN }));

/** One drawn rune, all the way through the real gate and the real recogniser. */
function draw(rune, frames, cfg, rand) {
  const fx = makeSteady(cfg);
  const fy = makeSteady(cfg);
  let t = 0;
  updateStroke(false, { x: 0, y: 0 }, t);
  for (const p of walk(scaled(rune.points), frames)) {
    t += 1000 / HZ;
    const phase = 2 * Math.PI * TREMOR_HZ * (t / 1000);
    updateStroke(true, {
      x: fx.filter(p.x + (rand() - 0.5) * 2 * NOISE + Math.sin(phase) * TREMOR, t),
      y: fy.filter(p.y + (rand() - 0.5) * 2 * NOISE + Math.cos(phase * 0.8) * TREMOR, t),
    }, t);
  }
  const points = currentStroke().slice();
  updateStroke(false, { x: 0, y: 0 }, t + 40);
  const hit = bestMatch(points);
  return { score: hit ? hit.score : 0, cast: !!(hit && hit.rune.id === rune.id && hit.ready) };
}

/** Pixels of drift per frame with the hand held still. The deadband's column. */
function stillness(cfg) {
  const f = makeSteady(cfg);
  const rand = rng(99);
  let last = null, moved = 0, n = 0;
  for (let i = 1; i <= 150; i++) {
    const out = f.filter(0.5 + (rand() - 0.5) * 2 * NOISE, i * (1000 / HZ));
    if (last !== null) { moved += Math.abs(out - last); n++; }
    last = out;
  }
  return (moved / n) * WIDE;
}

/**
 * How much of the hand's own tremor reaches the screen, in pixels.
 *
 * Fed a hand holding a slow, steady sweep with a tremor riding on it, this is
 * the amplitude of the tremor left in the output. It is the column that says
 * whether a rune feels like it is being drawn or scribbled.
 */
function tremorThrough(cfg) {
  const f = makeSteady(cfg);
  const rand = rng(31337);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 90; i++) {
    const t = (i + 1) * (1000 / HZ);
    // A slow deliberate drift, so the filter is in its "moving" regime, plus
    // the tremor that is not intended.
    const intent = 0.5 + (i / 90) * 0.10;
    const phase = 2 * Math.PI * TREMOR_HZ * (t / 1000);
    const out = f.filter(intent + Math.sin(phase) * TREMOR + (rand() - 0.5) * 2 * NOISE, t);
    if (i > 25) { const d = out - (0.5 + (i / 90) * 0.10); lo = Math.min(lo, d); hi = Math.max(hi, d); }
  }
  return ((hi - lo) / 2) * WIDE;
}

/** How far behind a sweeping hand the output runs, in frames. */
function lag(cfg) {
  const f = makeSteady(cfg);
  const rand = rng(4242);
  const truth = i => 0.5 + Math.sin((i / HZ) * Math.PI * 1.2) * 0.15;
  const out = [], clean = [];
  for (let i = 0; i < 60; i++) {
    clean.push(truth(i));
    out.push(f.filter(truth(i) + (rand() - 0.5) * 2 * NOISE, (i + 1) * (1000 / HZ)));
  }
  let best = 0, bestErr = Infinity;
  for (let shift = 0; shift <= 60; shift++) {
    const d = shift / 10;
    let err = 0, n = 0;
    for (let i = 10; i < 53; i++) {
      const at = i - d;
      const lo = Math.floor(at);
      const want = clean[lo] + (clean[lo + 1] - clean[lo]) * (at - lo);
      err += (out[i] - want) ** 2;
      n++;
    }
    err /= n;
    if (err < bestErr) { bestErr = err; best = d; }
  }
  return best;
}

const candidates = [
  ['SHIPPED', { ...TIP_FILTER }],
  ['beta 0.015 (was)', { ...TIP_FILTER, beta: 0.015 }],
  ['beta 1', { ...TIP_FILTER, beta: 1 }],
  ['beta 3', { ...TIP_FILTER, beta: 3 }],
  ['beta 6', { ...TIP_FILTER, beta: 6 }],
  ['beta 12', { ...TIP_FILTER, beta: 12 }],
  ['beta 24', { ...TIP_FILTER, beta: 24 }],
  ['no deadband', { ...TIP_FILTER, deadband: 0 }],
  ['no filter at all', { minCutoff: 1e6, beta: 0, dCutoff: 1e6, deadband: 0 }],
];

console.log(`\n  ${RUNS} draws per rune per speed. Score floor ${TUNE.SCORE_FLOOR}.`);
console.log('  recognition is ' + RUNES.map(r => r.name.toLowerCase().split(' ')[0]).join(' / ')
  + ';  ✗ never cast, ~ sometimes\n');
process.stdout.write('  ' + 'filter'.padEnd(19));
for (const f of SPEEDS) process.stdout.write(`${(f / HZ).toFixed(2)}s draw`.padStart(22));
console.log('      lag      still    tremor');
for (const [name, cfg] of candidates) {
  process.stdout.write('  ' + name.padEnd(19));
  for (const frames of SPEEDS) {
    const rand = rng(20260903);
    const cell = RUNES.map(rune => {
      let sum = 0, cast = 0;
      for (let i = 0; i < RUNS; i++) {
        const d = draw(rune, frames, cfg, rand);
        sum += d.score;
        if (d.cast) cast++;
      }
      return `${(sum / RUNS).toFixed(2)}${cast === RUNS ? '' : cast === 0 ? '✗' : '~'}`;
    }).join('/');
    process.stdout.write(cell.padStart(22));
  }
  console.log(`${lag(cfg).toFixed(2)}f`.padStart(9) + `${stillness(cfg).toFixed(2)}px`.padStart(11)
    + `${tremorThrough(cfg).toFixed(2)}px`.padStart(10));
}
console.log();
