// The webcam has two consumers that must never run together. One visible hand
// draws runes; two visible hands hold the bow. Keeping the transition explicit
// lets the host clear the state machine it is leaving exactly once.

export function createInputMode() {
  let mode = 'magic';
  return {
    get mode() { return mode; },
    reset() { mode = 'magic'; },
    update(hands) {
      const next = hands?.length === 2 ? 'bow' : 'magic';
      const transition = { mode: next, previous: mode, changed: next !== mode };
      mode = next;
      return transition;
    },
  };
}
