import test from 'node:test';
import assert from 'node:assert/strict';

import { createInputMode } from '../js/spell-room/input-mode.js';

test('two hands enter bow mode and one hand returns to magic once', () => {
  const input = createInputMode();
  assert.deepEqual(input.update([{}]), { mode: 'magic', previous: 'magic', changed: false });
  assert.deepEqual(input.update([{}, {}]), { mode: 'bow', previous: 'magic', changed: true });
  assert.deepEqual(input.update([{}, {}]), { mode: 'bow', previous: 'bow', changed: false });
  assert.deepEqual(input.update([{}]), { mode: 'magic', previous: 'bow', changed: true });
});
