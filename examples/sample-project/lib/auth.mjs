// Access token and session cookie (decisions D7 and D11 + recipe S0.3 in docs/forja/TECHNOLOGY.md).
//
// Rules that must not be relaxed:
//  - fail-closed: no token, an unreadable token file or a token shorter than 16 characters is an
//    error, never a default. There is no built-in token, no fallback token, no "dev" token;
//  - the token is compared in constant time over SHA-256 digests of both sides, so neither the
//    bytes nor the length of the expected token leak through timing (S0.3);
//  - a token is never printed, logged or put in an error message; this module has no console call;
//  - the token is only read from the `X-Greet-Token` header or the `greet` cookie. Never from the
//    query string, never from the body, never from the URL (D11);
//  - error messages are Portuguese, say what happened and the one next step (product profile).
//
// Built-ins only: node:crypto, node:fs.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Shortest token accepted (D7): stops "1234" from ever being the password of the local network. */
export const MIN_TOKEN_LENGTH = 16;

/** Name of the session cookie (D11). It carries no lifetime: see sessionCookie below. */
export const SESSION_COOKIE_NAME = 'greet';

const ENV_VAR = 'GREET_TOKEN';

/**
 * There is no usable token, so the server must not start and must not answer anything.
 * The message never contains the value that was read — only where a token is expected.
 */
export class MissingToken extends Error {
  constructor(message, tokenFile) {
    super(message);
    this.name = 'MissingToken';
    this.tokenFile = tokenFile ?? null;
  }
}

// The one next step, in two flavours: nothing there yet, or something there that is too short.
// Both name token.local.txt, the project root and the README, and never the value.
function fileHint(tokenFile) {
  const where = 'ficheiro token.local.txt na raiz do projeto';
  return tokenFile ? `${where} (${tokenFile})` : where;
}

function createStep(tokenFile) {
  return (
    `Passo seguinte: crie o ${fileHint(tokenFile)} com um token de pelo menos ` +
    `${MIN_TOKEN_LENGTH} caracteres, como explica o README, e arranque o servidor outra vez.`
  );
}

function fixStep(tokenFile) {
  return (
    `Passo seguinte: escreva um token de pelo menos ${MIN_TOKEN_LENGTH} caracteres no ` +
    `${fileHint(tokenFile)}, como explica o README, e arranque o servidor outra vez.`
  );
}

// First non-empty line of the token file, trimmed. Returns '' when the file has no token at all.
// A leading UTF-8 BOM is dropped: on Windows the Notepad "Save as UTF-8" of token.local.txt adds
// one, and it would silently become part of the token and never match.
// Missing file -> null (there is simply no file); any other read failure -> MissingToken, because
// a token that cannot be read is the same as no token (fail-closed).
function readTokenFile(tokenFile) {
  let raw;
  try {
    raw = readFileSync(tokenFile, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new MissingToken(
      `Não há token de acesso: a variável ${ENV_VAR} não está definida e o ficheiro do token ` +
        `não pôde ser lido (${err?.code ?? err}). ${createStep(tokenFile)}`,
      tokenFile,
    );
  }
  for (const line of raw.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return '';
}

/**
 * The token this server accepts: the GREET_TOKEN environment variable when it is set to something,
 * otherwise the first non-empty line of the token file (D7). Whitespace around the value is
 * ignored; an environment variable set to only whitespace counts as not set.
 * @param {{ env?: Record<string, string | undefined>, tokenFile?: string }} [options]
 * @returns {string} the token, always at least MIN_TOKEN_LENGTH characters long
 * @throws {MissingToken} when there is no token, it cannot be read, or it is too short
 */
export function loadToken({ env = process.env, tokenFile } = {}) {
  const fromEnv = typeof env?.[ENV_VAR] === 'string' ? env[ENV_VAR].trim() : '';
  if (fromEnv !== '') {
    if (fromEnv.length < MIN_TOKEN_LENGTH) {
      throw new MissingToken(
        `O token de acesso na variável ${ENV_VAR} é demasiado curto: precisa de pelo menos ` +
          `${MIN_TOKEN_LENGTH} caracteres. ${fixStep(tokenFile)}`,
        tokenFile,
      );
    }
    return fromEnv;
  }

  if (typeof tokenFile !== 'string' || tokenFile.trim() === '') {
    throw new MissingToken(
      `Não há token de acesso: a variável ${ENV_VAR} não está definida e não foi indicado ` +
        `nenhum ficheiro de token. ${createStep(undefined)}`,
      undefined,
    );
  }

  const fromFile = readTokenFile(tokenFile);
  if (fromFile === null || fromFile === '') {
    const porque =
      fromFile === null ? 'o ficheiro do token não existe' : 'o ficheiro do token está vazio';
    throw new MissingToken(
      `Não há token de acesso: a variável ${ENV_VAR} não está definida e ${porque}. ` +
        createStep(tokenFile),
      tokenFile,
    );
  }
  if (fromFile.length < MIN_TOKEN_LENGTH) {
    throw new MissingToken(
      `O token de acesso no ficheiro do token é demasiado curto: precisa de pelo menos ` +
        `${MIN_TOKEN_LENGTH} caracteres. ${fixStep(tokenFile)}`,
      tokenFile,
    );
  }
  return fromFile;
}

// S0.3: hash both sides before comparing. timingSafeEqual throws
// ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on buffers of different sizes, and the length of the
// expected token is itself a leak; a SHA-256 digest is always 32 bytes, which fixes both.
const digest = (value) => createHash('sha256').update(value, 'utf8').digest();

/**
 * True when the received token is the expected one, compared in constant time.
 * Anything that is not a non-empty string on either side is false, without throwing.
 * @param {unknown} received
 * @param {unknown} expected
 * @returns {boolean}
 */
export function tokenMatches(received, expected) {
  if (typeof received !== 'string' || received === '') return false;
  if (typeof expected !== 'string' || expected === '') return false;
  return timingSafeEqual(digest(received), digest(expected));
}

/**
 * The cookies of a request, by name. There is no cookie parser in Node (S0.3), so this is the
 * whole of it: split the header on the separator, split each pair on its first '=', and decode
 * the value tolerantly (a badly encoded value is kept as it arrived instead of throwing).
 * The first cookie with a given name wins, which is the one the browser sends for the most
 * specific path. A cookie named `__proto__` is dropped so a request can never reach the prototype.
 * @param {unknown} header value of the `Cookie` header, if any
 * @returns {Record<string, string>} empty object when there is no header
 */
export function parseCookies(header) {
  const cookies = {};
  if (typeof header !== 'string' || header.trim() === '') return cookies;

  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue; // no '=' at all, or an empty name: not a cookie
    const name = pair.slice(0, eq).trim();
    if (name === '' || name === '__proto__') continue;
    if (Object.hasOwn(cookies, name)) continue;
    const raw = pair.slice(eq + 1).trim();
    let value;
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw; // e.g. a stray '%' — keep the bytes, do not blow up a request over a cookie
    }
    cookies[name] = value;
  }
  return cookies;
}

/**
 * The token that came with a request and where it came from: the `X-Greet-Token` header (the API,
 * as the goal asks) or, when that is absent, the session cookie (the browser, D11).
 * Nothing else is a source of token: not the query string, not the body, not any other header.
 * @param {{ headers?: Record<string, unknown> }} req
 * @returns {{ token: string, source: 'header' | 'cookie' } | { token: null, source: null }}
 */
export function tokenFromRequest(req) {
  const headers = req?.headers ?? {};

  const fromHeader = headers['x-greet-token']; // Node lower-cases every header name
  if (typeof fromHeader === 'string' && fromHeader.trim() !== '') {
    return { token: fromHeader.trim(), source: 'header' };
  }

  const fromCookie = parseCookies(headers.cookie)[SESSION_COOKIE_NAME];
  if (typeof fromCookie === 'string' && fromCookie.trim() !== '') {
    return { token: fromCookie.trim(), source: 'cookie' };
  }

  return { token: null, source: null };
}

/**
 * Value for a `Set-Cookie` header that remembers the token in the browser (D11).
 *
 * A **session cookie**: no `Max-Age` and no `Expires`, on purpose (D19). The «entrar» screen
 * promises «Fica guardada neste browser até o fechar» (`docs/design/DESIGN.md` §4 point 4), so the
 * password has to die when the browser closes — on a shared office machine, whoever closes the
 * browser thinking they logged out must really be out. Do not add a lifetime here without changing
 * that sentence first.
 *
 * No `Secure` attribute, also on purpose: this server speaks plain HTTP on the local network (D8),
 * and a `Secure` cookie would be dropped by the browser, so nobody could ever log in. It is written
 * down here instead of being hidden: the day this is served over HTTPS, add `Secure`.
 * @param {string} token
 * @returns {string}
 */
export function sessionCookie(token) {
  if (typeof token !== 'string' || token === '') {
    throw new TypeError('sessionCookie precisa do token como texto não vazio.');
  }
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
}
