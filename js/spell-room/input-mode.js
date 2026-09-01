// The webcam has three consumers that must never run together. One visible hand
// draws runes; two visible hands hold either a bow or a pair of fists, and
// which of those it is comes from the roll of the wrists. Keeping the
// transition explicit lets the host clear the state machine it is leaving
// exactly once.
//
// Note what is NOT consulted: whether the fingers are closed. The bow is loosed
// by opening the string hand, and mode is decided before the bow's own state
// machine runs -- so a gate that read finger closure would drop out of 'bow' on
// the release frame and reset the draw before the shot could ever be reported.

import { readStance } from './boxing.js';

export function createInputMode() {
  let mode = 'magic';
  return {
    get mode() { return mode; },
    reset() { mode = 'magic'; },
    update(hands) {
      let next = 'magic';
      if (hands?.length === 2) {
        // readStance is silent unless both wrists clearly agree, which is most
        // frames near the boundary. Silence holds whichever two-handed mode was
        // already running; two hands with no landmarks at all fall back to the
        // bow, because that is what two hands have always meant here.
        next = readStance(hands) ?? (mode === 'fist' ? 'fist' : 'bow');
      }
      const transition = { mode: next, previous: mode, changed: next !== mode };
      mode = next;
      return transition;
    },
  };
}
