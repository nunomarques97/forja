import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageAccumulator } from '../lib/usage-counts.mjs';
test('same message input is counted once; later output increases count only the delta', () => {
  const add = usageAccumulator();
  assert.deepEqual(
    add({ id: 'm1', usage: { input_tokens: 100, output_tokens: 2 } }),
    {
      newMessage: true,
      delta: {
        input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 2,
      },
    },
  );
  const again = add({
    id: 'm1',
    usage: { input_tokens: 100, output_tokens: 8 },
  });
  assert.equal(again.newMessage, false);
  assert.equal(again.delta.input_tokens, 0);
  assert.equal(again.delta.output_tokens, 6);
  assert.equal(
    add({ id: 'm2', usage: { input_tokens: 100 } }).delta.input_tokens,
    100,
  );
});
test('legacy rows without IDs remain independent; invalid counts never introduce text or negative values', () => {
  const add = usageAccumulator();
  assert.equal(add({ usage: { input_tokens: 3 } }).delta.input_tokens, 3);
  assert.equal(add({ usage: { input_tokens: 3 } }).delta.input_tokens, 3);
  assert.equal(
    add({ id: 'm', usage: { input_tokens: 'secret', output_tokens: -3 } }).delta
      .input_tokens,
    0,
  );
});
