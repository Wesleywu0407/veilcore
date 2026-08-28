import test from 'node:test';
import assert from 'node:assert/strict';

import { DUEL } from '../js/arena/config.js';
import { createMatch, updateMatch, damage, spendMana, disruptCore } from '../js/arena/match.js';

test('a lone duelist captures the Veil Well but contested presence does not move it', () => {
  const state = createMatch();
  updateMatch(state, DUEL.captureSeconds / 2, { player: true, opponent: false });
  assert.equal(state.well.progress, 0.5);
  updateMatch(state, 1, { player: true, opponent: true });
  assert.equal(state.well.progress, 0.5);
  updateMatch(state, DUEL.captureSeconds / 2, { player: true, opponent: false });
  assert.equal(state.well.progress, 1);
  assert.equal(state.well.owner, 'player');
});

test('Well ownership increases only the owner mana regeneration', () => {
  const state = createMatch();
  state.player.mana = 0;
  state.opponent.mana = 0;
  state.well.progress = 1;
  state.well.owner = 'player';
  updateMatch(state, 1, {});
  assert.equal(state.player.mana, DUEL.baseManaPerSecond + DUEL.controlledManaPerSecond);
  assert.equal(state.opponent.mana, DUEL.baseManaPerSecond);
});

test('mana cannot be overspent and elimination finishes the match', () => {
  const state = createMatch();
  state.player.mana = 10;
  assert.equal(spendMana(state, 'player', 20), false);
  assert.equal(state.player.mana, 10);
  assert.equal(spendMana(state, 'player', 10), true);
  assert.equal(state.player.mana, 0);

  damage(state, 'opponent', DUEL.maxHp);
  assert.equal(state.phase, 'finished');
  assert.equal(state.winner, 'player');
  assert.equal(state.winReason, 'elimination');
});

test('timeout prefers HP, then control time, then a draw', () => {
  const health = createMatch({ seconds: 0.01 });
  health.player.hp = 80;
  health.opponent.hp = 60;
  updateMatch(health, 1, {});
  assert.equal(health.winner, 'player');
  assert.equal(health.winReason, 'health');

  const control = createMatch({ seconds: 0.01 });
  control.player.controlSeconds = 12;
  control.opponent.controlSeconds = 4;
  updateMatch(control, 1, {});
  assert.equal(control.winner, 'player');
  assert.equal(control.winReason, 'control');

  const draw = createMatch({ seconds: 0.01 });
  updateMatch(draw, 1, {});
  assert.equal(draw.winner, 'draw');
});

test('a disrupted Core pauses regeneration and spills bounded mana', () => {
  const state = createMatch();
  state.player.mana = 32;
  state.well.owner = 'player';
  assert.equal(disruptCore(state, 'player'), 20);
  assert.equal(state.player.mana, 12);
  updateMatch(state, 1, {});
  assert.equal(state.player.mana, 12, 'disabled Core must not regenerate');
  assert.ok(state.cores.player.disabledFor > 0);
  assert.equal(disruptCore(state, 'player'), 0, 'an already disabled Core cannot spill twice');
});
