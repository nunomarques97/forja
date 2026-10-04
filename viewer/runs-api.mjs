// Viewer request helpers and the retired phone run launcher.
//
// GET /projects and POST /runs used to list the registered projects with their
// legacy run and start or relaunch it from the phone. Core is the
// only workflow now (docs/LEGACY-REMOVAL.md), and a Core run is started or
// resumed in the terminal, so both routes answer 410 Gone with a JSON pointer
// and never read the registry, the body or start a process. Core runs are
// followed at /core (viewer/core-api.mjs), which keeps using crossSite and
// readBody from here.
//
// Auth (token in ?k= / cookie forja_k) and the Host allow-list are applied by
// viewer/server.mjs BEFORE this handler runs.

export const MAX_BODY = 4 * 1024;

const send = (res, status, obj) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(obj));
};

// A browser sends Origin on every POST, including a cross-site form post; the
// Host header was already checked against the allow-list by the server.
// No Origin at all is a non-browser client (curl, tests) and passes. `Origin:
// null` is refused by default (`/api/core/decision` can resume a Core run): it
// is what a sandboxed iframe, a data: document or a redirected cross-origin post sends, and no page
// of this viewer produces it once the visitor is in. The one caller that must
// accept it is `POST /login` (`allowNull`): the entry page sends
// `Referrer-Policy: no-referrer`, and by the Fetch spec a non-GET navigation
// under no-referrer carries `Origin: null` — refusing it there locks the
// Sponsor out with the right token in his hand, and a forged login proves
// nothing anyway (whoever posts the token already has it).
export function crossSite(req, { allowNull = false } = {}) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (origin === 'null') return !allowNull;
  try { return new URL(origin).host.toLowerCase() !== String(req.headers.host || '').toLowerCase(); } catch { return true; }
}

// The body arrives in chunks whose boundaries fall wherever TCP puts them —
// over the tunnel a body past ~1,4 KB always arrives split. Decoding each chunk
// on its own turns a character cut in half into two U+FFFD (the request would be
// read corrupted, with a 200 OK), so the chunks are kept as bytes and decoded
// once at the end; the cap is counted in bytes for the same reason.
export function readBody(req, res, onDone) {
  const chunks = []; let bytes = 0; let refused = false;
  req.on('data', d => {
    const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
    bytes += buf.length;
    if (refused) { if (bytes > 1024 * 1024) req.destroy(); return; } // answer 400 and drain; a body past 1 MB is dropped outright
    if (bytes > MAX_BODY) { refused = true; chunks.length = 0; send(res, 400, { error: 'Request body is too large.' }); return; }
    chunks.push(buf);
  });
  req.on('end', () => { if (!refused) onDone(Buffer.concat(chunks).toString('utf8')); });
  req.on('error', () => { refused = true; });
}

export const LAUNCHER_GONE = {
  error: 'The phone run launcher was removed: FORJA Core is the only workflow. Start a run in the terminal with forja start --goal "..." or continue one with forja core resume, then follow it at /core.',
  start: 'forja start --goal "..."',
  resume: 'forja core resume',
  monitor: '/core',
};

// Returns true when it took the request (and answered it), false otherwise.
// Any method gets the same 410: nothing here reads the body, the registry or
// starts a process.
export function handleRunsApi(req, res) {
  let pathname;
  try { pathname = new URL(req.url, 'http://forja.invalid').pathname; } catch { return false; }
  if (pathname !== '/projects' && pathname !== '/runs') return false;
  req.resume(); // drain an unread body so the connection stays usable
  send(res, 410, { ok: false, ...LAUNCHER_GONE });
  return true;
}
