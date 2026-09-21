import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = mkdtempSync(join(tmpdir(), 'forja-notify-test-'));
const original = { data: process.env.FORJA_DATA_DIR, topic: process.env.FORJA_NTFY_TOPIC, fetch: globalThis.fetch };
process.env.FORJA_DATA_DIR = root;
delete process.env.FORJA_NTFY_TOPIC;
const { topic, notify } = await import('../lib/notify.mjs');
after(() => {
  for (const [name, value] of [['FORJA_DATA_DIR', original.data], ['FORJA_NTFY_TOPIC', original.topic]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  globalThis.fetch = original.fetch;
  rmSync(root, { recursive: true, force: true });
});

test('notification destinations remain local, explicit and disabled when absent', async () => {
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return { ok: true, status: 200 }; };
  assert.equal(topic(), '');
  assert.deepEqual(await notify('synthetic status', { dedup: false }), { ok: false, skipped: 'not-configured' });
  assert.equal(request, undefined, 'an unconfigured clone makes no network request');
  writeFileSync(join(root, 'notify-config.json'), JSON.stringify({ topic: 'fixture-local' }));
  assert.equal(topic(), 'fixture-local');
  process.env.FORJA_NTFY_TOPIC = 'fixture-override';
  assert.equal(topic(), 'fixture-override');
  assert.equal((await notify('synthetic status', { dedup: false, click: 'https://example.invalid/?k=secret' })).ok, true);
  assert.ok(request.url.endsWith('/fixture-override'));
  assert.equal(request.options.headers.Click, 'https://example.invalid/');
  process.env.FORJA_NTFY_TOPIC = '';
  request = undefined;
  assert.equal((await notify('synthetic status', { dedup: false })).skipped, 'not-configured');
  assert.equal(request, undefined, 'an explicit empty override disables a local topic');
  delete process.env.FORJA_NTFY_TOPIC;
  writeFileSync(join(root, 'notify-config.json'), 'broken');
  assert.equal(topic(), '');
});
