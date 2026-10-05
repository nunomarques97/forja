// Hidden acceptance check: never copied into the scenario project.
// Negative cases: a response produced for one credential is never served to
// another credential or to an anonymous client. Public responses stay cached.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertOwnSuite, load } from './_helpers.mjs';

const { createApp } = await load('src/app.mjs');

const accountApp = () => {
  const calls = { me: 0, news: 0 };
  const app = createApp()
    .route('GET', '/me', ctx => {
      calls.me++;
      const user = ctx.headers.authorization?.replace(/^Bearer /, '') ?? /session=(\w+)/.exec(ctx.headers.cookie ?? '')?.[1];
      return user ? { body: { user, card: `card-of-${user}` }, cache: true } : { status: 401, body: { error: 'login required' } };
    })
    .route('GET', '/news', () => {
      calls.news++;
      return { body: { headline: 'public' }, cache: true };
    });
  return { app, calls };
};

test('a response for one Authorization is not served to another or to anonymous clients', async () => {
  const { app } = accountApp();
  const alice = await app.handle({ url: '/me', headers: { Authorization: 'Bearer alice' } });
  assert.equal(alice.body.user, 'alice');
  const bob = await app.handle({ url: '/me', headers: { authorization: 'Bearer bob' } });
  assert.equal(bob.body.user, 'bob');
  const anonymous = await app.handle({ url: '/me' });
  assert.equal(anonymous.status, 401);
  assert.doesNotMatch(JSON.stringify(anonymous), /alice|bob/);
});

test('a response for one session cookie is not served to another session', async () => {
  const { app } = accountApp();
  assert.equal((await app.handle({ url: '/me', headers: { Cookie: 'session=carol' } })).body.user, 'carol');
  assert.equal((await app.handle({ url: '/me', headers: { cookie: 'session=dave' } })).body.user, 'dave');
  assert.equal((await app.handle({ url: '/me' })).status, 401);
});

test('an anonymous response is not served to a logged-in client', async () => {
  const { app } = accountApp();
  assert.equal((await app.handle({ url: '/me' })).status, 401);
  assert.equal((await app.handle({ url: '/me', headers: { Authorization: 'Bearer erin' } })).body.user, 'erin');
});

test('public responses for anonymous clients are still cached', async () => {
  const { app, calls } = accountApp();
  for (let i = 0; i < 3; i++) assert.equal((await app.handle({ url: '/news' })).body.headline, 'public');
  assert.equal(calls.news, 1);
});

test("the project's own tests pass", () => assertOwnSuite(assert, 13));
