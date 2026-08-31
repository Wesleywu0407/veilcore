import * as THREE from 'three';
import { DUEL } from './config.js';

const _desired = new THREE.Vector3();
const _facing = new THREE.Vector3();

/** A readable Friday bot: contest first, then telegraph a locked shot. */
export function createOpponentController(position) {
  let phase = 'seek';
  let clock = 0;
  let strafe = 1;
  let shieldCooldown = DUEL.botShieldInitialDelay;
  const lockedTarget = new THREE.Vector3();

  return {
    update(dt, playerPosition, context = {}, movementScale = 1) {
      clock -= dt;
      shieldCooldown -= dt;
      let cast = null;
      let shield = false;
      const wellOwner = context.wellOwner ?? null;
      const hp = context.hp ?? DUEL.maxHp;
      const mana = context.mana ?? DUEL.maxMana;

      if (phase === 'windup') {
        if (clock <= 0) {
          phase = 'recover';
          clock = DUEL.botRecovery;
          cast = { target: lockedTarget.clone() };
        }
      } else {
        if (phase === 'recover' && clock <= 0) phase = 'seek';

        const distanceFromWell = Math.hypot(position.x, position.z);
        const playerDistance = position.distanceTo(playerPosition);
        // Dry means it cannot threaten anything until it refills, and the Well
        // is the only place that happens quickly -- so it heads there even when
        // it nominally owns it, because strafing had let it drift off the disc.
        const starved = mana < DUEL.botCastCost;
        if (hp <= 38 && playerDistance < 10) {
          _desired.subVectors(position, playerPosition).setY(0).normalize();
        } else if ((starved || wellOwner !== 'opponent') && distanceFromWell > DUEL.wellRadius * 0.6) {
          _desired.set(-position.x, 0, -position.z).normalize();
        } else {
          _desired.set(strafe, 0, 0);
          if (Math.abs(position.x) > 8) strafe *= -1;
        }
        if (phase !== 'windup') position.addScaledVector(_desired, DUEL.botSpeed * movementScale * dt);

        if (phase === 'seek' && shieldCooldown <= 0 && mana >= DUEL.aegisCost && (hp <= DUEL.botShieldHp || context.playerCharging)) {
          shield = true;
          // This is intentionally a generous testing rival: the long delay
          // leaves several full draw-charge-release cycles between shields.
          shieldCooldown = DUEL.botShieldCooldown;
          phase = 'recover';
          clock = DUEL.botShieldRecovery;
        } else if (phase === 'seek' && clock <= 0 && playerDistance < 34 && mana >= DUEL.botCastCost) {
          phase = 'windup';
          clock = DUEL.botWindup;
          lockedTarget.copy(playerPosition);
        }
      }

      _facing.subVectors(playerPosition, position).setY(0).normalize();
      return {
        cast,
        shield,
        facing: _facing,
        speed: phase === 'windup' ? 0 : DUEL.botSpeed * movementScale,
        telegraph: phase === 'windup' ? 1 - clock / DUEL.botWindup : 0,
      };
    },
    get phase() { return phase; },
  };
}
