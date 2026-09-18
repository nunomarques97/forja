// The HTTP application: four routes over node:http (decision S0.1 in docs/forja/TECHNOLOGY.md).
// `createApp` returns a server that is NOT listening — the caller decides host and port (D8).
//
// Rules that must not be relaxed:
//  - fail-closed: every route except `GET /entrar` and `POST /entrar` needs a valid token, taken
//    only from the `X-Greet-Token` header or the session cookie (`tokenFromRequest`). The query
//    string is never a source of token (D11), so `?token=…` authenticates nobody;
//  - the token is compared in constant time (`tokenMatches`) and a failed attempt never says
//    whether a token was sent, whether one exists or how close it was (D11);
//  - every POST that can be triggered by a browser session checks the request's origin against the
//    `Host` header (D11): always on `POST /entrar`, and on `POST /saudacoes` whenever the request
//    authenticated itself with the cookie. A request with the header carries a token a cross-site
//    form cannot set, so it does not need the check;
//  - the request body is read with `for await` and abandoned above 4096 bytes (D9, S0.1) — nothing
//    above the limit is ever kept in memory;
//  - nothing is ever written to a log: no headers, no cookies, no body, no token, no stack trace.
//    This module has no `console` call on purpose (D11 + product profile), and no response ever
//    echoes the token — the only place it appears is the `Set-Cookie` of a successful login;
//  - every response carries `charset=utf-8`, or the accented Portuguese arrives broken;
//  - the data file is never touched by this module: it only asks the store, and an unreadable file
//    becomes a Portuguese 500 page that names the file and the next step (D9, D13).
//
// Built-ins only: node:http, node:crypto, and the project's own modules.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { sessionCookie, tokenFromRequest, tokenMatches } from './auth.mjs';
import { greet } from './greet.mjs';
import { escapeHtml } from './html.mjs';
import { errorPage, historyPage, loginPage } from './pages.mjs';
import { createStore, DataFileWriteFailed, UnreadableDataFile } from './store.mjs';

/** Largest request body accepted, in bytes (D9 / S0.1). Above this the request is abandoned. */
export const MAX_BODY_BYTES = 4096;

/** Longest name accepted, in characters — the same limit as the form's `maxlength` (D9). */
export const MAX_NAME_LENGTH = 80;

const HISTORY_PATH = '/historico';
const LOGIN_PATH = '/entrar';

const FORM_TYPE = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';

// Portuguese, one sentence, always with the next step, never the words the team does not use
// (docs/design/DESIGN.md §7 forbids «token», «cookie» and friends in anything a person reads).
const MSG = {
  forbidden:
    'O pedido não veio da página desta aplicação. Abra outra vez a página de entrada e tente de novo.',
  unauthorized: 'Não tem acesso: a palavra-passe está em falta ou não está certa.',
  badName: `Escreva um nome com 1 a ${MAX_NAME_LENGTH} caracteres.`,
  badFormLogin: 'Envie a palavra-passe pelo formulário da página de entrada.',
  badFormGreeting: 'Envie o nome pelo formulário da página das saudações.',
  tooLarge: `O que enviou é demasiado grande. Envie um nome com ${MAX_NAME_LENGTH} caracteres ou menos. Nada foi gravado.`,
  notFound: 'O endereço que abriu não faz parte desta aplicação. Volte às saudações e tente outra vez.',
  unexpected:
    'Nada se perdeu. Tente outra vez dentro de momentos e, se voltar a acontecer, peça a quem ' +
    'arrancou o servidor para o verificar.',
};

// ---------------------------------------------------------------------------------------------
// Responses. Every one of them sets charset=utf-8.

function sendHtml(res, status, body, extraHeaders) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders });
  res.end(body);
}

function sendJson(res, status, value, extraHeaders) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(value));
}

// 303 is the redirect that turns a POST into a GET, so a refresh never re-posts the form.
// `location` is always one of this module's own constants, never anything from the request.
function sendRedirect(res, location, extraHeaders) {
  const href = escapeHtml(location);
  const body =
    '<!DOCTYPE html>\n<html lang="pt">\n<head>\n  <meta charset="utf-8">\n' +
    '  <title>Saudações</title>\n</head>\n<body>\n' +
    `  <p><a href="${href}">Continuar para as saudações</a></p>\n</body>\n</html>\n`;
  res.writeHead(303, {
    Location: location,
    'Content-Type': 'text/html; charset=utf-8',
    ...extraHeaders,
  });
  res.end(body);
}

// The API (a request that announced itself as JSON) gets `{ erro }`; the browser gets a page.
function wantsJson(req) {
  return requestType(req) === JSON_TYPE;
}

function sendError(req, res, status, { message, page, extraHeaders } = {}) {
  if (wantsJson(req)) {
    sendJson(res, status, { erro: message }, extraHeaders);
    return;
  }
  sendHtml(res, status, page ?? errorPage({ status, message }), extraHeaders);
}

// ---------------------------------------------------------------------------------------------
// Request helpers.

function requestType(req) {
  const raw = req.headers['content-type'];
  return typeof raw === 'string' ? raw.split(';', 1)[0].trim().toLowerCase() : '';
}

/**
 * True when the request says it came from this very server: `Origin` (or, when absent, `Referer`)
 * has the same host as the `Host` header. Fail-closed — a missing, unparseable or non-http origin
 * is a no. This is the whole cross-site defence for cookie-authenticated POSTs (D11); the cookie
 * is already `SameSite=Strict`, this check is what catches the browsers that ignore it.
 */
function sameOrigin(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  if (host === '') return false;

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const candidate =
    typeof origin === 'string' && origin.trim() !== ''
      ? origin.trim()
      : typeof referer === 'string'
        ? referer.trim()
        : '';
  if (candidate === '') return false;

  let parsed;
  try {
    parsed = new URL(candidate); // 'null' (sandboxed frame) and garbage both throw -> false
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.host.toLowerCase() === host; // `host` includes the port, which has to match too
}

/**
 * Whether the request carries the expected token, and where it came from. Nothing here says which
 * of "no token" and "wrong token" happened to anyone but this module.
 */
function authenticate(req, expected) {
  const { token, source } = tokenFromRequest(req);
  if (token === null) return { ok: false, source: null };
  return { ok: tokenMatches(token, expected), source };
}

/**
 * The body as text, or `null` when it was too big — in which case the 413 has already been sent.
 *
 * `destroyOnReturn: false` is load-bearing: leaving a plain `for await (… of req)` early destroys
 * the socket, and a person sending a large body gets a browser network error instead of the
 * Portuguese page (measured here: a 2 MB body answered with ECONNRESET every time, and with the
 * iterator it answered 413 every time). So: stop reading, answer, and only then let the rest of the
 * bytes run to the void with `resume()` — they are counted, never kept.
 */
async function readBody(req, res) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;

  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      break;
    }
    chunks.push(chunk);
  }

  if (!tooLarge) return Buffer.concat(chunks).toString('utf8');

  // `Connection: close`: the request was never finished reading, so this connection is over.
  sendError(req, res, 413, {
    message: MSG.tooLarge, // for the API; the page uses the words DESIGN.md §5 fixed for 413
    page: errorPage({ status: 413 }),
    extraHeaders: { Connection: 'close' },
  });
  req.resume();
  return null;
}

// ---------------------------------------------------------------------------------------------
// Routes.

function unauthorized(req, res) {
  sendError(req, res, 401, {
    message: MSG.unauthorized,
    page: errorPage({ status: 401, linkToLogin: true }),
  });
}

// DESIGN.md §5 has no row for 403, so the page keeps the generic heading — but never without a way
// out: the link goes to /entrar, the one route that opens for anybody.
function forbidden(req, res) {
  sendError(req, res, 403, {
    message: MSG.forbidden,
    page: errorPage({ status: 403, message: MSG.forbidden, linkToLogin: true }),
  });
}

function notFound(req, res) {
  sendError(req, res, 404, { message: MSG.notFound });
}

async function postLogin(req, res, { token }) {
  // Always checked here: this is the route that hands out the session cookie.
  if (!sameOrigin(req)) return forbidden(req, res);

  const body = await readBody(req, res);
  if (body === null) return;
  if (requestType(req) !== FORM_TYPE) {
    return sendError(req, res, 400, { message: MSG.badFormLogin });
  }

  const received = (new URLSearchParams(body).get('token') ?? '').trim();
  if (!tokenMatches(received, token)) {
    // Same page, same words, same timing shape for "nothing sent" and "wrong" (D11).
    return sendHtml(res, 401, loginPage({ error: true }));
  }

  // The cookie carries the server's own token, never the bytes that arrived.
  sendRedirect(res, HISTORY_PATH, { 'Set-Cookie': sessionCookie(token) });
}

async function getHistory(req, res, { token, store }) {
  if (!authenticate(req, token).ok) return unauthorized(req, res);
  const records = await store.load(); // unreadable file -> UnreadableDataFile -> 500, file untouched
  sendHtml(res, 200, historyPage({ records, total: records.length }));
}

async function postGreeting(req, res, { token, store }) {
  const auth = authenticate(req, token);
  if (!auth.ok) return unauthorized(req, res);
  // A cookie travels with any cross-site form; the header does not, so only the cookie needs this.
  if (auth.source === 'cookie' && !sameOrigin(req)) return forbidden(req, res);

  const body = await readBody(req, res);
  if (body === null) return;

  const type = requestType(req);
  let nome;
  if (type === FORM_TYPE) {
    nome = new URLSearchParams(body).get('nome');
  } else if (type === JSON_TYPE) {
    try {
      nome = JSON.parse(body)?.nome;
    } catch {
      return sendJson(res, 400, { erro: MSG.badName });
    }
  } else {
    return sendError(req, res, 400, { message: MSG.badFormGreeting });
  }

  // `.length` and not the code points, so it is exactly the limit the form's `maxlength` enforces.
  const clean = typeof nome === 'string' ? nome.trim() : '';
  if (clean === '' || clean.length > MAX_NAME_LENGTH) {
    if (type === JSON_TYPE) return sendJson(res, 400, { erro: MSG.badName });
    const records = await store.load();
    return sendHtml(res, 400, historyPage({ records, total: records.length, error: true }));
  }

  // Exactly the four fields of D10: no address, no browser, nothing about who sent it.
  const record = {
    id: randomUUID(),
    nome: clean,
    saudacao: greet(clean),
    criado_em: new Date().toISOString(),
  };
  await store.append(record); // serialised and atomic inside the store (D9)

  if (type === JSON_TYPE) return sendJson(res, 201, record);
  sendRedirect(res, HISTORY_PATH);
}

async function route(req, res, ctx) {
  // 'http://x' is a throwaway base: only the path matters, and it never reaches the file system.
  const { pathname } = new URL(req.url ?? '/', 'http://x');

  switch (`${req.method} ${pathname}`) {
    case 'GET /':
      return sendRedirect(res, HISTORY_PATH);
    case `GET ${LOGIN_PATH}`:
      return sendHtml(res, 200, loginPage());
    case `POST ${LOGIN_PATH}`:
      return await postLogin(req, res, ctx);
    case `GET ${HISTORY_PATH}`:
      return await getHistory(req, res, ctx);
    case 'POST /saudacoes':
      return await postGreeting(req, res, ctx);
    default:
      // Also what a wrong method on a known path gets: it tells a stranger nothing about what exists.
      return notFound(req, res);
  }
}

// The only place an exception can land. Nothing is logged (see the header): the page itself carries
// what a person needs, and the one internal path shown is the data file on a 500 (DESIGN.md §5).
function fail(req, res, err) {
  if (res.headersSent) {
    res.end();
    return;
  }

  if (err instanceof UnreadableDataFile) {
    return sendError(req, res, 500, {
      message:
        'Nenhuma saudação se perdeu: o ficheiro ficou exatamente como estava. Peça a quem arrancou ' +
        `o servidor para verificar o ficheiro ${err.path} e arrancar outra vez.`,
    });
  }

  if (err instanceof DataFileWriteFailed) {
    // The heading of DESIGN.md §5's 500 row says "não foi possível ler as saudações guardadas",
    // and this is a write that did not happen — so this one keeps the generic heading instead of
    // telling the person something untrue. HTTP status is still 500.
    const message =
      'A saudação não chegou a ser gravada e nada do que já estava guardado se perdeu. Peça a ' +
      `quem arrancou o servidor para fechar os programas que possam ter o ficheiro ${err.path} ` +
      'aberto e tente outra vez.';
    return sendError(req, res, 500, { message, page: errorPage({ message }) });
  }

  sendError(req, res, 500, { message: MSG.unexpected, page: errorPage({ message: MSG.unexpected }) });
}

/**
 * The application as an `http.Server` that is not listening yet — the caller calls `listen`.
 * @param {{ token: string, dataFile: string }} options the token every protected route requires
 *   (never a default, never read from here) and the JSON file the greetings live in.
 * @returns {import('node:http').Server}
 */
export function createApp({ token, dataFile } = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TypeError('createApp precisa do token de acesso.');
  }
  if (typeof dataFile !== 'string' || dataFile.trim() === '') {
    throw new TypeError('createApp precisa do caminho do ficheiro de dados.');
  }

  const ctx = { token, store: createStore(dataFile) };

  // S0.1: the timeouts Node already applies (headersTimeout, requestTimeout, maxHeaderSize) are
  // left exactly as they are.
  return http.createServer((req, res) => {
    route(req, res, ctx).catch((err) => fail(req, res, err));
  });
}
