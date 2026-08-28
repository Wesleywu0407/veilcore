// SKYVEIL Duel — Friday tuning lives in one place.

export const DUEL = Object.freeze({
  matchSeconds: 5 * 60,
  arenaRadius: 27,
  playerSpeed: 5.5,
  maxHp: 100,
  maxMana: 100,
  baseManaPerSecond: 3.2,
  controlledManaPerSecond: 7,
  wellRadius: 5.2,
  captureSeconds: 4,
  ringfallCost: 20,
  ringfallDamageMin: 12,
  ringfallDamageMax: 34,
  ringfallCooldown: 2.4,
  aegisCost: 24,
  aegisCooldown: 5.5,
  gravityCost: 30,
  gravityCooldown: 6.5,
  botSpeed: 4.0,
  botWindup: 0.72,
  botRecovery: 2.5,
  botDamage: 12,
  // What a rival attack costs it. Its attacks used to be free while yours cost
  // 20, which made its mana bar and its interest in the Well pure decoration --
  // it could out-trade you from anywhere on the map. Priced, the Well decides
  // its output the way it decides yours.
  botCastCost: 16,
});
