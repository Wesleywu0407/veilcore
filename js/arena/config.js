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
  // Fists. The only attack in the duel that costs nothing and waits for
  // nothing, which makes it what you have left when the Well is lost and the
  // mana is gone. What rations it instead is the gesture: BOXING.PUNCH_ON and
  // PUNCH_OFF decide how fast a real arm can re-arm, so those two are balance
  // numbers as much as detection ones.
  //
  // 4 a punch works out near 10 damage a second at a sustainable two and a half
  // punches, against roughly 14 for a bow with the Well held and 5 for one
  // without. Deliberately short of the fed bow: walking into someone's face
  // should be the answer to being dry, not the answer to everything.
  punchDamage: 4,
  // Measured off the rig rather than guessed: armReach is 1.07 and both bodies
  // carry a 0.75 radius, so knuckles meet a chest at about 1.8 between the two
  // centres, and 2.2 allows the lean that throwing a punch puts into a body.
  punchRange: 2.2,
  // Half-angle, degrees. An opponent at that range fills only 18.8 degrees, so
  // this lets you be a good 26 degrees off centre and still connect while
  // keeping the punch to things you can actually see.
  punchCone: 45,
  // Closest two duelists may stand. Nothing enforced this before -- the arena
  // colliders are pillars, not people -- and it never showed while the whole
  // duel was fought at range. At punching distance it does: without it you walk
  // through the rival and end up looking out of the inside of their chest, at
  // which point "the direction to the opponent" stops having an answer.
  duelistClearance: 1.5,
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
