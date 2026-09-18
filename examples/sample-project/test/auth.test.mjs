import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MIN_TOKEN_LENGTH,
  MissingToken,
  loadToken,
  parseCookies,
  sessionCookie,
  tokenFromRequest,
  tokenMatches,
} from '../lib/auth.mjs';

// Every token below is a made-up string written here in the test, never a real credential, and
// nothing in this file creates or reads token.local.txt in the project.
const TOKEN = 'token-ficticio-de-teste-1';
const OUTRO_TOKEN = 'outro-token-ficticio-2222';
const CURTO_15 = 'quinze-caracter'; // exactly 15 characters: one below the minimum

let root;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'auth-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A token file of its own for each test, so one test never sees another test's file. */
async function tokenFileWith(contents, name = 'token.local.txt') {
  const dir = await mkdtemp(path.join(root, 'case-'));
  const file = path.join(dir, name);
  await writeFile(file, contents, 'utf8');
  return file;
}

async function missingFilePath() {
  const dir = await mkdtemp(path.join(root, 'case-'));
  return path.join(dir, 'token.local.txt');
}

function thrown(fn) {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}

// --- loadToken -------------------------------------------------------------------------------

test('the fictitious tokens in this test are what the cases need them to be', () => {
  assert.equal(CURTO_15.length, 15);
  assert.equal(MIN_TOKEN_LENGTH, 16);
  assert.ok(TOKEN.length >= MIN_TOKEN_LENGTH);
  assert.notEqual(TOKEN, OUTRO_TOKEN);
  assert.equal(TOKEN.length, OUTRO_TOKEN.length); // same length: the "different token" case is not about length
});

test('loadToken takes GREET_TOKEN over the token file', async () => {
  const tokenFile = await tokenFileWith(`${OUTRO_TOKEN}\n`);
  assert.equal(loadToken({ env: { GREET_TOKEN: TOKEN }, tokenFile }), TOKEN);
  // and the file alone gives the file's token, so the case above really is precedence
  assert.equal(loadToken({ env: {}, tokenFile }), OUTRO_TOKEN);
});

test('loadToken trims the environment value and ignores one that is only whitespace', async () => {
  const tokenFile = await tokenFileWith(`${OUTRO_TOKEN}\n`);
  assert.equal(loadToken({ env: { GREET_TOKEN: `  ${TOKEN}\r\n` }, tokenFile }), TOKEN);
  assert.equal(loadToken({ env: { GREET_TOKEN: '   ' }, tokenFile }), OUTRO_TOKEN);
  assert.equal(loadToken({ env: { GREET_TOKEN: '' }, tokenFile }), OUTRO_TOKEN);
});

test('loadToken reads the first non-empty line, even with blank lines before it', async () => {
  const tokenFile = await tokenFileWith(`\r\n   \n${TOKEN}  \nlinha-a-ignorar\n`);
  assert.equal(loadToken({ env: {}, tokenFile }), TOKEN);
});

test('loadToken ignores a UTF-8 BOM at the start of the file', async () => {
  const tokenFile = await tokenFileWith(`\uFEFF${TOKEN}\r\n`);
  assert.equal(loadToken({ env: {}, tokenFile }), TOKEN);
});

test('loadToken defaults to process.env when no env is given', () => {
  const had = Object.hasOwn(process.env, 'GREET_TOKEN');
  const original = process.env.GREET_TOKEN;
  try {
    process.env.GREET_TOKEN = TOKEN;
    assert.equal(loadToken(), TOKEN);
  } finally {
    if (had) process.env.GREET_TOKEN = original;
    else delete process.env.GREET_TOKEN;
  }
});

test('loadToken throws MissingToken when there is no token at all', async () => {
  const tokenFile = await missingFilePath();
  const err = thrown(() => loadToken({ env: {}, tokenFile }));

  assert.ok(err instanceof MissingToken, `esperava MissingToken, veio ${err}`);
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'MissingToken');
  assert.equal(err.tokenFile, tokenFile);
  assert.match(err.message, /Passo seguinte/);
  assert.match(err.message, /token\.local\.txt/);
  assert.match(err.message, /README/);
  assert.match(err.message, /GREET_TOKEN/);
  assert.equal(await readFile(tokenFile, 'utf8').catch((e) => e.code), 'ENOENT'); // nothing created
});

test('loadToken throws MissingToken when no token file is given either', () => {
  const err = thrown(() => loadToken({ env: {} }));
  assert.ok(err instanceof MissingToken, `esperava MissingToken, veio ${err}`);
  assert.equal(err.tokenFile, null);
  assert.match(err.message, /token\.local\.txt/);
  assert.match(err.message, /Passo seguinte/);
});

test('loadToken throws MissingToken for a file with no token in it', async () => {
  const tokenFile = await tokenFileWith('\r\n   \n\t\n');
  const err = thrown(() => loadToken({ env: {}, tokenFile }));
  assert.ok(err instanceof MissingToken, `esperava MissingToken, veio ${err}`);
  assert.match(err.message, /vazio/);
  assert.match(err.message, /Passo seguinte/);
});

test('a 15-character token in the file is refused and the message never shows it', async () => {
  const tokenFile = await tokenFileWith(`${CURTO_15}\n`);
  const err = thrown(() => loadToken({ env: {}, tokenFile }));

  assert.ok(err instanceof MissingToken, `esperava MissingToken, veio ${err}`);
  assert.equal(err.message.includes(CURTO_15), false, 'a mensagem não pode conter o token lido');
  assert.match(err.message, /pelo menos 16 caracteres/);
  assert.match(err.message, /Passo seguinte/);
  assert.match(err.message, /token\.local\.txt/);
  assert.match(err.message, /README/);
});

test('a 15-character token in GREET_TOKEN is refused and the message never shows it', async () => {
  const tokenFile = await missingFilePath();
  const err = thrown(() => loadToken({ env: { GREET_TOKEN: CURTO_15 }, tokenFile }));

  assert.ok(err instanceof MissingToken, `esperava MissingToken, veio ${err}`);
  assert.equal(err.message.includes(CURTO_15), false, 'a mensagem não pode conter o token lido');
  assert.match(err.message, /GREET_TOKEN/);
  assert.match(err.message, /pelo menos 16 caracteres/);
  assert.match(err.message, /token\.local\.txt/);
});

test('a token of exactly 16 characters is accepted', async () => {
  const dezesseis = `${CURTO_15}x`;
  assert.equal(dezesseis.length, 16);
  const tokenFile = await tokenFileWith(dezesseis);
  assert.equal(loadToken({ env: {}, tokenFile }), dezesseis);
});

test('loadToken throws MissingToken when the token file cannot be read', async () => {
  const dir = await mkdtemp(path.join(root, 'case-'));
  // a folder where a file is expected: readFileSync fails with EISDIR (or EPERM on Windows)
  const err = thrown(() => loadToken({ env: {}, tokenFile: dir }));
  assert.ok(err instanceof MissingToken, `esperava MissingToken, veio ${err}`);
  assert.match(err.message, /não pôde ser lido/);
  assert.match(err.message, /Passo seguinte/);
});

// --- tokenMatches ----------------------------------------------------------------------------

test('tokenMatches is true only for the same token', () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(`${TOKEN}`, TOKEN), true);
  assert.equal(tokenMatches(OUTRO_TOKEN, TOKEN), false); // different, same length
  assert.equal(tokenMatches(TOKEN.toUpperCase(), TOKEN), false); // case matters
});

test('tokenMatches is false, and does not throw, for tokens of different lengths', () => {
  // timingSafeEqual itself throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on different sizes (S0.3):
  // hashing both sides first is what makes these cases a plain false.
  assert.equal(tokenMatches('x', TOKEN), false);
  assert.equal(tokenMatches(`${TOKEN}-mais-umas-letras`, TOKEN), false);
  assert.equal(tokenMatches(TOKEN.slice(0, -1), TOKEN), false);
  assert.equal(tokenMatches(TOKEN, `${TOKEN}x`), false);
});

test('tokenMatches is false for nothing at all, without throwing', () => {
  assert.equal(tokenMatches(null, TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
  assert.equal(tokenMatches('', TOKEN), false);
  assert.equal(tokenMatches('   ', TOKEN), false); // whitespace is not the token
  assert.equal(tokenMatches(123, TOKEN), false);
  assert.equal(tokenMatches({}, TOKEN), false);
  assert.equal(tokenMatches([TOKEN], TOKEN), false);
});

test('tokenMatches is false when there is no expected token (fail-closed)', () => {
  assert.equal(tokenMatches(TOKEN, null), false);
  assert.equal(tokenMatches(TOKEN, undefined), false);
  assert.equal(tokenMatches(TOKEN, ''), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches(null, null), false);
});

// --- parseCookies ----------------------------------------------------------------------------

test('parseCookies returns an empty object when there is no cookie header', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(null), {});
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies('   '), {});
  assert.deepEqual(parseCookies(['greet=x']), {}); // not a string
});

test('parseCookies reads one cookie', () => {
  assert.deepEqual(parseCookies(`greet=${TOKEN}`), { greet: TOKEN });
});

test('parseCookies reads two cookies', () => {
  assert.deepEqual(parseCookies(`greet=${TOKEN}; tema=escuro`), { greet: TOKEN, tema: 'escuro' });
  // without the space after the semicolon, and with extra spaces around the pairs
  assert.deepEqual(parseCookies(`greet=${TOKEN};tema=escuro`), { greet: TOKEN, tema: 'escuro' });
  assert.deepEqual(parseCookies(`  greet=${TOKEN} ;  tema=escuro  `), {
    greet: TOKEN,
    tema: 'escuro',
  });
});

test('parseCookies splits each pair on its first equals sign only', () => {
  assert.deepEqual(parseCookies('greet=a=b=c'), { greet: 'a=b=c' });
});

test('parseCookies decodes the value and tolerates a broken encoding', () => {
  assert.deepEqual(parseCookies('nome=Ana%20Sofia'), { nome: 'Ana Sofia' });
  assert.deepEqual(parseCookies('nome=Ana%C3%A9'), { nome: 'Anaé' });
  assert.deepEqual(parseCookies('nome=100%'), { nome: '100%' }); // would throw URIError if decoded
  assert.deepEqual(parseCookies('nome=%E0%A4%A'), { nome: '%E0%A4%A' });
});

test('parseCookies ignores pairs that are not cookies and keeps the first of a repeated name', () => {
  assert.deepEqual(parseCookies('semigual'), {});
  assert.deepEqual(parseCookies('=sem-nome'), {});
  assert.deepEqual(parseCookies(`greet=${TOKEN}; ; semigual; greet=${OUTRO_TOKEN}`), {
    greet: TOKEN,
  });
});

test('a cookie named __proto__ cannot touch the prototype', () => {
  const cookies = parseCookies('__proto__=poluido; greet=abc');
  assert.deepEqual(cookies, { greet: 'abc' });
  assert.equal(Object.getPrototypeOf(cookies), Object.prototype);
  assert.equal({}.poluido, undefined);
});

// --- tokenFromRequest ------------------------------------------------------------------------

test('tokenFromRequest prefers the X-Greet-Token header', () => {
  const req = {
    url: `/criar?token=${OUTRO_TOKEN}`,
    headers: { 'x-greet-token': TOKEN, cookie: `greet=${OUTRO_TOKEN}` },
  };
  assert.deepEqual(tokenFromRequest(req), { token: TOKEN, source: 'header' });
});

test('tokenFromRequest falls back to the greet cookie', () => {
  const req = { url: '/', headers: { cookie: `tema=escuro; greet=${TOKEN}` } };
  assert.deepEqual(tokenFromRequest(req), { token: TOKEN, source: 'cookie' });
});

test('tokenFromRequest falls back to the cookie when the header is empty', () => {
  const req = { headers: { 'x-greet-token': '   ', cookie: `greet=${TOKEN}` } };
  assert.deepEqual(tokenFromRequest(req), { token: TOKEN, source: 'cookie' });
});

test('tokenFromRequest never reads the token from the URL or from the body', () => {
  assert.deepEqual(tokenFromRequest({ url: `/?token=${TOKEN}`, headers: {} }), {
    token: null,
    source: null,
  });
  assert.deepEqual(
    tokenFromRequest({ url: `/criar?GREET_TOKEN=${TOKEN}&x=1`, headers: {}, body: { token: TOKEN } }),
    { token: null, source: null },
  );
  // and not from a look-alike header or a look-alike cookie either
  assert.deepEqual(tokenFromRequest({ headers: { authorization: `Bearer ${TOKEN}` } }), {
    token: null,
    source: null,
  });
  assert.deepEqual(tokenFromRequest({ headers: { cookie: `greeting=${TOKEN}` } }), {
    token: null,
    source: null,
  });
});

test('tokenFromRequest returns nothing for a request without headers', () => {
  assert.deepEqual(tokenFromRequest({}), { token: null, source: null });
  assert.deepEqual(tokenFromRequest({ headers: {} }), { token: null, source: null });
  assert.deepEqual(tokenFromRequest(undefined), { token: null, source: null });
});

test('the token read from a request is the one tokenMatches accepts', () => {
  const { token } = tokenFromRequest({ headers: { 'x-greet-token': ` ${TOKEN} ` } });
  assert.equal(tokenMatches(token, TOKEN), true);
});

// --- sessionCookie ---------------------------------------------------------------------------

test('sessionCookie has the attributes D11 asks for, no Secure and no lifetime', () => {
  const value = sessionCookie(TOKEN);

  assert.equal(value, `greet=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`);
  assert.ok(value.includes('HttpOnly'));
  assert.ok(value.includes('SameSite=Strict'));
  assert.ok(value.includes('Path=/'));
  // session cookie (D19): no lifetime at all, so the browser drops it when it closes, which is what
  // the «entrar» screen promises («Fica guardada neste browser até o fechar», DESIGN.md §4 point 4).
  assert.doesNotMatch(value, /Max-Age|Expires/i);
  // no Secure on purpose: this is plain HTTP on the local network (D8), and a Secure cookie would
  // be dropped by the browser, so nobody could log in.
  assert.doesNotMatch(value, /;\s*Secure/i);
});

test('sessionCookie url-encodes the value and parseCookies reads it back', () => {
  const esquisito = 'token+com/caracteres=esquisitos e acentuação';
  const value = sessionCookie(esquisito);

  assert.ok(value.startsWith('greet=token%2Bcom%2Fcaracteres%3Desquisitos'));
  assert.equal(value.includes(' e acentuação'), false, 'o valor tem de ir codificado');
  const pair = value.split('; ')[0];
  assert.deepEqual(parseCookies(pair), { greet: esquisito });
});

test('sessionCookie refuses to write a cookie without a token', () => {
  for (const bad of [undefined, null, '', 0, {}]) {
    const err = thrown(() => sessionCookie(bad));
    assert.ok(err instanceof TypeError, `esperava TypeError para ${JSON.stringify(bad)}`);
  }
  const err = thrown(() => sessionCookie(''));
  assert.equal(err.message.includes('greet='), false);
});

// --- the module's own rules ------------------------------------------------------------------

test('lib/auth.mjs imports only node: built-ins, has no console call and no hard-coded token', async () => {
  const source = await readFile(new URL('../lib/auth.mjs', import.meta.url), 'utf8');

  const imports = [...source.matchAll(/^import .*from '([^']+)';$/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['node:crypto', 'node:fs']);
  assert.equal(/\bfrom '(?!node:)/.test(source), false, 'nenhum import fora de node:');
  assert.equal(/console\s*\./.test(source), false, 'nenhuma chamada a console');
  assert.equal(/process\.stdout|process\.stderr/.test(source), false);
  // no default token, and nothing that could stand in for one
  assert.equal(/GREET_TOKEN\s*(\|\||\?\?)\s*['"`]/.test(source), false);
  assert.equal(/token\s*(\|\||\?\?)\s*['"`][^'"`]/.test(source), false);
});

test('the token comparison is timingSafeEqual over a SHA-256 digest of both sides (S0.3)', async () => {
  // Constant time cannot be observed from a unit test — a plain `===` returns the same booleans as
  // the real thing — so the binding recipe is asserted over the source instead.
  const source = await readFile(new URL('../lib/auth.mjs', import.meta.url), 'utf8');

  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /timingSafeEqual\(digest\(received\), digest\(expected\)\)/);
  assert.equal(
    /received\s*[=!]==\s*expected|expected\s*[=!]==\s*received/.test(source),
    false,
    'o token recebido nunca é comparado com === ou !==',
  );
  assert.equal(
    /(received|expected)\.(localeCompare|startsWith|endsWith|includes|indexOf)\(/.test(source),
    false,
    'o token nunca é comparado byte a byte fora do timingSafeEqual',
  );
});
