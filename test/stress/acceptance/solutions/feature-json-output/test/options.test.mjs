import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.mjs';
import { summaryData } from '../src/status.mjs';

test('options in any order; unknown ones are refused', () => {
  assert.deepEqual(parseArgs(['jobs.json', '--failed', '--json']), { json: true, failed: true, file: 'jobs.json' });
  assert.throws(() => parseArgs(['--nope', 'jobs.json']), /unknown option/);
  assert.throws(() => parseArgs(['--json']), /missing/);
  assert.deepEqual(summaryData([{ ok: true, durationMs: 2 }, { ok: false, durationMs: 3 }]), { jobs: 2, failed: 1, totalMs: 5 });
});
