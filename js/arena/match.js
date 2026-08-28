import { DUEL } from './config.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function combatant() {
  return {
    hp: DUEL.maxHp,
    mana: 55,
    controlSeconds: 0,
  };
}

export function createMatch({ seconds = DUEL.matchSeconds } = {}) {
  return {
    phase: 'playing',
    timeLeft: seconds,
    winner: null,
    winReason: null,
    well: { progress: 0, owner: null },
    cores: {
      player: { disabledFor: 0 },
      opponent: { disabledFor: 0 },
    },
    player: combatant(),
    opponent: combatant(),
  };
}

/**
 * Advance objective and resources. Presence is deliberately supplied by the
 * host: match rules do not need to know whether positions came from a bot,
 * local input, or a LAN snapshot.
 */
export function updateMatch(state, dt, presence = {}) {
  if (state.phase !== 'playing' || dt <= 0) return state;

  state.timeLeft = Math.max(0, state.timeLeft - dt);
  const playerOnly = presence.player && !presence.opponent;
  const opponentOnly = presence.opponent && !presence.player;
  const captureRate = dt / DUEL.captureSeconds;

  if (playerOnly) state.well.progress = clamp(state.well.progress + captureRate, -1, 1);
  else if (opponentOnly) state.well.progress = clamp(state.well.progress - captureRate, -1, 1);

  if (state.well.progress >= 1) state.well.owner = 'player';
  else if (state.well.progress <= -1) state.well.owner = 'opponent';
  else if (Math.abs(state.well.progress) < 0.08) state.well.owner = null;

  for (const side of ['player', 'opponent']) {
    state.cores[side].disabledFor = Math.max(0, state.cores[side].disabledFor - dt);
    const controlled = state.well.owner === side;
    const disabled = state.cores[side].disabledFor > 0;
    const regen = disabled ? 0 : DUEL.baseManaPerSecond + (controlled ? DUEL.controlledManaPerSecond : 0);
    state[side].mana = clamp(state[side].mana + regen * dt, 0, DUEL.maxMana);
    if (controlled) state[side].controlSeconds += dt;
  }

  if (state.player.hp <= 0) finish(state, 'opponent', 'elimination');
  else if (state.opponent.hp <= 0) finish(state, 'player', 'elimination');
  else if (state.timeLeft <= 0) finishTimeout(state);
  return state;
}

export function damage(state, side, amount) {
  if (state.phase !== 'playing' || !state[side]) return false;
  state[side].hp = clamp(state[side].hp - Math.max(0, amount), 0, DUEL.maxHp);
  if (state[side].hp <= 0) {
    finish(state, side === 'player' ? 'opponent' : 'player', 'elimination');
  }
  return true;
}

export function spendMana(state, side, amount) {
  if (state.phase !== 'playing' || !state[side] || state[side].mana < amount) return false;
  state[side].mana -= amount;
  return true;
}

export function disruptCore(state, side, seconds = 7) {
  if (state.phase !== 'playing' || !state.cores?.[side]) return 0;
  if (state.cores[side].disabledFor > 0) return 0;
  state.cores[side].disabledFor = seconds;
  const spilled = Math.min(20, state[side].mana);
  state[side].mana -= spilled;
  return spilled;
}

function finishTimeout(state) {
  if (state.player.hp !== state.opponent.hp) {
    finish(state, state.player.hp > state.opponent.hp ? 'player' : 'opponent', 'health');
    return;
  }
  if (state.player.controlSeconds !== state.opponent.controlSeconds) {
    finish(state,
      state.player.controlSeconds > state.opponent.controlSeconds ? 'player' : 'opponent',
      'control');
    return;
  }
  finish(state, 'draw', 'draw');
}

function finish(state, winner, reason) {
  state.phase = 'finished';
  state.winner = winner;
  state.winReason = reason;
}
