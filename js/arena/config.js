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
  // How long the shield stands, in seconds: the floor plus what a full charge
  // adds. It was 1.4 to 3.1 and hardcoded inside castAegis(), which is a
  // balance number living at the call site -- the one thing AGENTS.md 4 says
  // this file exists to prevent.
  //
  // Raised because 1.4 seconds is barely a shield: with a 5.5 second cooldown
  // you had to know the rival was already casting before you drew the rune, and
  // the rune takes about a second to draw. Now a flick buys long enough to draw
  // something else behind it, and a held cast covers a whole exchange.
  aegisSeconds: 2.2,
  aegisSecondsCharged: 2.6,
  gravityCost: 30,
  gravityCooldown: 6.5,
  // The Gravity Seal, all of it. These were spread across castGravity() and
  // update() in spell-system.js -- the seal's whole balance, including the one
  // number that decides what the spell DOES, living at three call sites. Moved
  // verbatim; not one of them is retuned here.
  //
  // Each pair is the floor plus what a full charge adds.
  gravitySeconds: 1.7,
  gravitySecondsCharged: 1.7,
  gravityRadius: 3.4,             // world units
  gravityRadiusCharged: 2.4,
  // Metres a second, outward from the ARENA centre, applied every frame the
  // victim is inside the ring. This and not gravitySlow is what decides whether
  // anyone is held: at 2.5/3.2 the shove was two to four times the slowed walk,
  // so it ejected them regardless.
  //
  // It was also INVERTED. Push grew faster with charge than the radius did, so a
  // full charge threw its victim clear in 1.03 seconds of a 3.4 second seal
  // while a flick held for 1.37 of 1.7 -- thirty mana bought less control, not
  // more. Simulated against the real update() arithmetic, standing still and
  // running for the edge:
  //
  //                    flick, of 1.7s      charged, of 3.4s
  //     2.5 / 3.2      1.37s   0.88s       1.03s   0.83s     inverted
  //     1.5 / 1.5      whole   1.18s       1.95s   1.33s
  //     1.2 / 0.8      whole   1.33s       2.92s   1.73s     <- here
  //     1.0 / 0.5      whole   1.43s       whole   2.03s     cannot stand out of it
  //
  // 1.2/0.8 holds a charged seal for most of its life if you stand there, and
  // still lets you run out in 1.73 -- while spending the whole of it running,
  // and therefore not casting. That is the price it should be charging.
  gravityPush: 1.2,
  gravityPushCharged: 0.8,
  // What is left of the victim's walking speed inside the ring. This is the
  // spell: the push is a nudge and the duration is a window, but this is what
  // makes standing in one a decision.
  //
  // Was 0.42, then 0.32, now 0.25 -- at playerSpeed 5.5 that is 1.38 a second,
  // a quarter of a walk.
  //
  // ── What this number does NOT decide ──
  //
  // Whether you get out. The seal also shoves its victim outward at gravityPush,
  // 2.5 a second at a flick and 5.7 at a full charge, and that is applied every
  // frame they are inside the radius. A flick pushes 4.25 metres over its 1.7
  // seconds against a radius of 3.4; a full charge pushes nineteen over 3.4
  // seconds against a radius of 5.8. The shove ejects you either way, and it is
  // two to four times faster than the slowed walk, so it wins.
  //
  // What the slow decides is how much you can STEER while being shoved -- which
  // way you leave, and whether you can turn and face the caster on the way out.
  // Lower it further and the victim is a passenger; that is a real change, but
  // it is not "harder to escape".
  gravitySlow: 0.25,
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
