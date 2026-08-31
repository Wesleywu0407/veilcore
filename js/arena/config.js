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
  // The bow is an aimed alternative to Ringfall, so its first balance pass uses
  // the same economy and damage envelope. Only aim, rather than a free discount,
  // is allowed to distinguish it until the duel has been played by hand.
  bowCost: 20,
  bowCooldown: 2.4,
  bowDamageMin: 12,
  bowDamageMax: 34,
  arrowSpeed: 105,
  // Deliberately forgiving while gesture input is being tuned: the telegraph is
  // long enough to see during a stroke, a miss does not erase a quarter of a
  // test run, and the rival cannot immediately repeat the shot.
  botSpeed: 3.0,
  botWindup: 1.4,
  botRecovery: 4.5,
  botDamage: 6,
  botShieldInitialDelay: 8,
  botShieldCooldown: 20,
  botShieldHp: 35,
  botShieldRecovery: 1.2,
  // What a rival attack costs it. Its attacks used to be free while yours cost
  // 20, which made its mana bar and its interest in the Well pure decoration --
  // it could out-trade you from anywhere on the map. Priced, the Well decides
  // its output the way it decides yours.
  botCastCost: 16,
});
