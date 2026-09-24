#!/usr/bin/env node
// Forja viewer server v2 (docs/ARCHITECTURE.md §9, §11, §12). Node core only.
//
// - Tails data/events.jsonl (and rotated data/events.*.jsonl at startup), runs
//   every line through viewer/lib/state.mjs, and streams STATE snapshots to the
//   browser over SSE — never the raw file (the raw log is data/events.jsonl
//   itself; the viewer has no raw view). The same lines feed viewer/lib/feed.mjs,
//   the key-events feed served as JSON on GET /feed (the landing tab).
// - Token auth on every route except /health: a visit with ?k=<token> sets an
//   HttpOnly cookie, and so does the entry page (`POST /login`) that `/` and
//   `/m` serve to a visitor without one — the phone link no longer carries the
//   token (§10), so the Sponsor pastes it once per tunnel URL. Wrong token:
//   same page, no detail, 1 s of delay, 5 tries a minute. Every other route
//   without the cookie is 401. The token lives in data/viewer-token.txt.
// - Host allow-list (loopback + hostnames from data/tunnel.json) against DNS
//   rebinding, kept from v1.
// - Watchdog: every 30 s, notifies (ntfy) only what needs the Sponsor's
//   response — a dead instance, a dead main session, "needs Sponsor" and a
//   pending permission — once per episode, persisted in data/watchdog.json
//   so a restart does not re-notify. A main session that is merely
//   unresponsive, or a run waiting on quota, is not (both can still recover
//   on their own).
// - Answers from the phone: POST /answers writes data/answers/<project>.jsonl
//   and emits a Forja `answer.pending` event; the lead picks it up with
//   `forja answers`. The server never writes outside <forja>/data.
//
// Run: node viewer/server.mjs   (or: node bin/forja.mjs serve)
// Env: PORT (4317), HOST (127.0.0.1), FORJA_DATA_DIR, EVENTS_FILE, FORJA_ALLOWED_HOSTS
//      (comma list), FORJA_NO_WATCHDOG=1 (tests).

import { createServer } from 'node:http';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unwatchFile, watchFile, writeFileSync, appendFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createState, applyLine, snapshot, STATES, THRESHOLDS } from './lib/state.mjs';
import { createFeed, feedApply, feedSnapshot } from './lib/feed.mjs';
import { handleRunsApi, crossSite } from './runs-api.mjs';
import { coreDrivenProjects, coreSnapshot, handleCoreDecision } from './core-api.mjs';
import { notify, sanitizeClick } from '../lib/notify.mjs';
// A outra metade da supervisão mútua (docs/ARCHITECTURE.md §12): a guarda vigia
// o viewer, e o viewer vigia a guarda. Regras, constantes e predicados de vida
// vivem uma vez só, em lib/supervise.mjs.
import { appendPeerLog, guardPaths, guardProcessAliveAsync, readUpWatchState, runPeerCheckOnce, upWatchPaths, writeUpWatchState } from '../lib/supervise.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

// Notifications leave the machine (ntfy) and are logged: status only. A permission
// message describes the tool input (commands, URLs, queries), so only the tool name
// is sent, and only when it has the shape of a tool name.
const permissionTool = perm => (perm && typeof perm.tool === 'string' && /^[\w.:-]{1,64}$/.test(perm.tool) ? ` (${perm.tool})` : '');

// Pure: the notifications a snapshot warrants right now (docs/ARCHITECTURE.md §10).
// The timer in startServer fires each key once (data/watchdog.json remembers).
// `coreProjects`: project keys (state.mjs projectKey) with a running or blocked Core run.
// Their legacy crew is not driving the work, so a silent subagent from an old
// interactive session there is not something the Sponsor can relaunch.
export function watchdogPlan(snap, now = Date.now(), thresholds = THRESHOLDS, { coreProjects = new Set() } = {}) {
  const out = [];
  for (const run of snap.runs || []) {
    if (run.synthetic) continue;
    if (!(now - run.lastEventAt < thresholds.WATCHDOG_IGNORE_AFTER_MS)) continue; // runs silent for half a day are history
    const main = run.roster[0];
    const add = (key, message, priority = 'high') => out.push({ key, message, priority });
    // A pending permission is one episode with one notification (the mainperm rule
    // below, after PERMISSION_NOTIFY_MS); its detail would carry the tool input.
    const mainPermission = run.main && run.main.permission;
    if (main.state === STATES.SPONSOR && !mainPermission) add(`${run.id}|sponsor|${main.since}`, `Forja precisa de ti (${run.project}): ${main.detail || 'a sessão principal parou'}`);
    // SEM_RESPOSTA (ainda pode recuperar sozinha) e ESPERA_QUOTA (retoma sozinho) não avisam o
    // telemóvel — nada espera pelo Sponsor ainda. MORTO continua a avisar: nada a relança sozinha.
    if (main.state === STATES.MORTO) add(`${run.id}|main-dead|${main.since}`, `Forja: sessão principal em ${run.project} parece morta (${main.detail})`, 'urgent');
    // Under the runner a dead subagent is handled by the per-session watchdog (the session is
    // killed and the task redone): only the runner/main session dying is worth a notification.
    const underRunner = !!(run.forja && run.forja.runner && !run.forja.runner.exited && ['running', 'blocked'].includes(run.forja.status));
    // A subagent only counts as dead while whatever launched it can still act on it: not after its
    // session ended or its legacy run closed, not when the main session is already reported dead
    // (one alert per session), and not for old legacy sessions of a project that Core now drives.
    const legacyLive = ['running', 'blocked'].includes(run.forja && run.forja.status);
    const parentGone = !!run.endedAt || ['finished', 'failed'].includes(run.forja && run.forja.status) || [STATES.MORTO, STATES.TERMINADO, STATES.FALHOU].includes(main.state);
    const coreDriven = !legacyLive && coreProjects.has(run.projectKey);
    const deadMatters = !underRunner && !parentGone && !coreDriven;
    for (const c of run.roster.slice(1)) for (const i of c.instances || []) {
      if (i.state === STATES.MORTO && deadMatters) add(`${run.id}|dead|${i.key}`, `Forja: ${c.name} em ${run.project} morto — ${i.task || i.type} sem sinal há mais de 30 min`, 'urgent');
      if (i.state === STATES.BLOQUEADO && i.permission && now - i.permission.since > thresholds.PERMISSION_NOTIFY_MS) add(`${run.id}|perm|${i.key}|${i.permission.since}`, `Forja precisa de ti (${run.project}): ${c.name} à espera de permissão${permissionTool(i.permission)}`);
    }
    if (main.state === STATES.SPONSOR && mainPermission && now - mainPermission.since > thresholds.PERMISSION_NOTIFY_MS) add(`${run.id}|mainperm|${mainPermission.since}`, `Forja precisa de ti (${run.project}): permissão pendente${permissionTool(mainPermission)}`);
  }
  return out;
}

export function startServer(opts = {}) {
  const dataDir = opts.dataDir || process.env.FORJA_DATA_DIR || join(repoRoot, 'data');
  const eventsPath = opts.eventsPath || process.env.EVENTS_FILE || join(dataDir, 'events.jsonl');
  const port = Number(opts.port ?? process.env.PORT ?? 4317);
  const host = opts.host || process.env.HOST || '127.0.0.1';
  const POLL_MS = 500;
  const PUSH_DEBOUNCE_MS = 250;
  const HEARTBEAT_MS = 15000;
  const WATCHDOG_MS = 30000;
  const watchdogEnabled = !(opts.noWatchdog || process.env.FORJA_NO_WATCHDOG === '1');
  mkdirSync(dataDir, { recursive: true });

  // ---------- token ----------
  const tokenPath = join(dataDir, 'viewer-token.txt');
  function loadToken() {
    try { const t = readFileSync(tokenPath, 'utf8').trim(); if (/^[a-f0-9]{32,}$/.test(t)) return t; } catch {}
    const t = randomBytes(24).toString('hex');
    writeFileSync(tokenPath, t + '\n');
    return t;
  }
  let token = loadToken();
  // Hash both sides first: timingSafeEqual needs equal byte lengths, and a
  // multibyte candidate must never be able to throw before auth.
  const digest = s => createHash('sha256').update(String(s), 'utf8').digest();
  const tokenOk = s => typeof s === 'string' && s.length > 0 && timingSafeEqual(digest(s), digest(token));

  // ---------- state ----------
  const state = createState();
  const feed = createFeed();
  let feedCache = null;
  let feedDirty = true;
  let lineNo = 0;
  let offset = 0;
  let lastSnapshot = null;
  let dirty = false;

  function ingest(text) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      lineNo += 1;
      try { applyLine(state, line, lineNo); } catch (err) { state.badLines += 1; console.error(`line ${lineNo}: reducer threw: ${err && err.message}`); }
      try { feedApply(feed, JSON.parse(line)); } catch {}
    }
    dirty = true; feedDirty = true;
  }
  function loadHistory() {
    const rotated = existsSync(dataDir) ? readdirSync(dataDir).filter(f => /^events\..+\.jsonl$/.test(f)).sort() : [];
    for (const f of rotated) { try { ingest(readFileSync(join(dataDir, f), 'utf8')); } catch {} }
    try { const txt = readFileSync(eventsPath, 'utf8'); ingest(txt); offset = Buffer.byteLength(txt); } catch { offset = 0; }
  }
  function fileSize() { try { return statSync(eventsPath).size; } catch { return 0; } }
  let pendingPartial = Buffer.alloc(0);
  function pump() {
    const size = fileSize();
    if (size < offset) {
      // Rotated (renamed) or truncated: drain the newest rotated file from the old offset, then restart.
      try {
        const rotated = readdirSync(dataDir).filter(f => /^events\..+\.jsonl$/.test(f)).sort();
        const last = rotated.at(-1);
        if (last) { const buf = readFileSync(join(dataDir, last)); if (buf.length > offset) ingest(Buffer.concat([pendingPartial, buf.subarray(offset)]).toString('utf8')); }
      } catch {}
      offset = 0; pendingPartial = Buffer.alloc(0);
    }
    if (size === offset) return;
    let fd; let buf;
    try { fd = openSync(eventsPath, 'r'); buf = Buffer.alloc(size - offset); const n = readSync(fd, buf, 0, buf.length, offset); buf = buf.subarray(0, n); }
    catch { return; } finally { if (fd !== undefined) closeSync(fd); }
    const all = Buffer.concat([pendingPartial, buf]);
    const lastNl = all.lastIndexOf(0x0a);
    if (lastNl === -1) { pendingPartial = all; offset = size; return; }
    ingest(all.subarray(0, lastNl).toString('utf8'));
    pendingPartial = all.subarray(lastNl + 1);
    offset = size;
  }
  // The feed's project list is data/projects.json (the projects Forja prepared);
  // "what comes next" reads each live project's docs/forja/TASKS.json. Rebuilt at
  // most every 3 s: the pending states depend on the clock as well as on lines.
  function readJson(path, fallback) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
  function currentFeed() {
    if (feedCache && !feedDirty && Date.now() - feedCache.generatedAt < 3000) return feedCache;
    const projects = (readJson(join(dataDir, 'projects.json'), {}).projects || []).filter(p => p && typeof p.name === 'string');
    const tasksOf = p => {
      if (typeof p.path !== 'string') return [];
      const t = readJson(join(p.path, 'docs', 'forja', 'TASKS.json'), []);
      return Array.isArray(t) ? t : Array.isArray(t.tasks) ? t.tasks : [];
    };
    feedCache = feedSnapshot(feed, Date.now(), { projects, tasksOf });
    feedDirty = false;
    return feedCache;
  }
  function currentSnapshot(force = false) {
    if (dirty || force || !lastSnapshot || Date.now() - lastSnapshot.generatedAt > 5000) { lastSnapshot = snapshot(state, Date.now()); dirty = false; }
    return lastSnapshot;
  }

  // ---------- SSE ----------
  const clients = new Set();
  let pushTimer = null;
  function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => { pushTimer = null; const snap = currentSnapshot(true); const data = JSON.stringify(snap); for (const c of clients) c.write(`event: state\ndata: ${data}\n\n`); }, PUSH_DEBOUNCE_MS);
  }
  watchFile(eventsPath, { interval: POLL_MS }, () => { pump(); if (dirty) schedulePush(); });
  const hb = setInterval(() => { for (const c of clients) c.write(`event: ping\ndata: ${Date.now()}\n\n`); }, HEARTBEAT_MS);
  hb.unref();

  // ---------- watchdog ----------
  const wdPath = join(dataDir, 'watchdog.json');
  let wd = { notified: {} };
  try { wd = JSON.parse(readFileSync(wdPath, 'utf8')); } catch {}
  function saveWd() { try { writeFileSync(wdPath, JSON.stringify(wd)); } catch {} }
  async function watchdog() {
    const click = mobileUrl();
    for (const n of watchdogPlan(currentSnapshot(true), Date.now(), THRESHOLDS, { coreProjects: coreDrivenProjects(dataDir) })) {
      if (wd.notified[n.key]) continue;
      wd.notified[n.key] = Date.now(); saveWd();
      await notify(n.message, { click, priority: n.priority, tags: ['eyes'] });
    }
  }
  const wdTimer = watchdogEnabled ? setInterval(() => { pump(); watchdog().catch(() => {}); }, WATCHDOG_MS) : null;
  if (wdTimer) wdTimer.unref();

  // ---------- vigia da guarda (supervisão mútua, §12) ----------
  // Nada a ver com o watchdog acima, e de propósito: aquele lê o redutor,
  // notifica sobre sessões e lembra-se em data/watchdog.json — este só olha para
  // um processo (a guarda), pode RELANÇÁ-LO, e tem estado só seu em
  // data/up-watch/. Mesma cadência (30 s), função diferente, ficheiros
  // diferentes, e a palavra "watchdog" não entra em nenhuma chave desta parte.
  //
  // `startServer` NÃO o arranca: quem o arranca é o `forja up`, e só depois de o
  // viewer estar mesmo a ouvir e de o up.pid estar escrito. Um `up` que sai
  // porque a porta está ocupada, ou um `forja serve` à mão, não vigiam nada —
  // senão dois viewers vigiavam a mesma guarda, e um `serve` que ninguém
  // considera "o viewer" gastaria tentativas em nome de quem não é.
  const peerWatchEnabled = watchdogEnabled && !(opts.noPeerWatch || process.env.FORJA_NO_PEER_WATCH === '1');
  const peerWatch = { on: false, timer: null, stopped: false };
  function startPeerWatch({
    forjaRoot = repoRoot,
    spawn = null,
    notify: notifyFn = notify,
    now = Date.now,
    everyMs = WATCHDOG_MS,
    // Ler a vida da guarda é a única parte cara desta volta (perguntar ao
    // sistema pela linha de comandos de um pid). É ASSÍNCRONA de propósito: a
    // versão síncrona custa ~370 ms de event loop parado por volta, neste mesmo
    // processo que serve o SSE e o telemóvel pelo túnel — é o problema que o
    // par `ownerAliveAsync`/`ownerAliveCached` (lib/projects.mjs) já existia
    // para não ter. A guarda, do lado dela, continua síncrona: é um processo
    // dedicado e não serve nada a ninguém.
    alive = () => guardProcessAliveAsync(dataDir),
    // O instante em que ESTE viewer começou a vigiar: a graça de 2 min conta-se
    // sempre daqui, nunca de um dead_since do disco que lhe seja anterior. É o
    // que impede um viewer acabado de relançar pela guarda de relançar a guarda
    // de volta no primeiro segundo de vida.
    selfStartedAt = Date.now(),
  } = {}) {
    if (!peerWatchEnabled || peerWatch.on) return { enabled: false, stop() {} };
    peerWatch.on = true; peerWatch.stopped = false;
    const paths = upWatchPaths(dataDir);
    const stopPath = guardPaths(dataDir).stop;
    let lastNote = null;
    // Não reentrante, e isto é uma garantia, não uma otimização. O estado só
    // chega ao disco NO FIM da volta, e uma volta que relança pode demorar mais
    // do que o intervalo (a leitura da linha de comandos até 15 s + o
    // intermediário do spawn até 20 s + o ntfy até 10 s). Duas voltas
    // sobrepostas leriam o MESMO estado pré-relançamento e decidiriam as duas
    // relançar: dois processos arrancados na mesma janela com uma só tentativa
    // registada — exatamente as duas garantias (15 min entre tentativas, teto
    // de 3) que esta funcionalidade existe para dar. A guarda não tem este
    // problema porque o `guardLoop` já espera pela volta (`await tick(...)`).
    let busy = false;
    async function peerCheck(t = now()) {
      if (busy) return { entry: null, act: null, note: 'volta anterior ainda a correr — salto esta', skipped: true };
      busy = true;
      try {
        // `data/guard/guard.stop` presente (forja guard stop, forja autostart
        // remove) ganha a tudo: a guarda não é relançada e o contador fica a zero.
        const stopRequested = (() => { try { return existsSync(stopPath); } catch { return false; } })();
        const isAlive = Boolean(await alive());
        // Lido DEPOIS do await: entre o início da volta e aqui pode ter passado
        // uma escrita nossa (nunca passa, com a trava acima) ou de uma pessoa.
        const state = readUpWatchState(paths.state);
        const r = await runPeerCheckOnce({
          peer: 'guard', dataDir, forjaRoot, entry: state.guard, now: t, selfStartedAt,
          alive: isAlive, stopRequested, notify: notifyFn, ...(spawn ? { spawn } : {}),
        });
        state.guard = r.entry;
        try { writeUpWatchState(paths.state, state); } catch {}
        // Uma linha por ação (e por mudança de estado), nunca uma por volta: 30 s
        // de tique calado não têm nada para dizer.
        if (r.act !== null || r.note !== lastNote) { appendPeerLog(paths.log, `vigia: ${r.note}`); lastNote = r.note; }
        return r;
      } finally { busy = false; }
    }
    // Corrente de setTimeout em vez de setInterval: a volta seguinte é marcada
    // quando a anterior acaba (incluindo a escrita do estado), por isso o
    // intervalo é entre voltas e nunca se acumulam.
    const schedule = () => {
      if (peerWatch.stopped) return;
      peerWatch.timer = setTimeout(() => { peerCheck().catch(() => {}).finally(schedule); }, everyMs);
      peerWatch.timer.unref();
    };
    schedule();
    return {
      enabled: true,
      peerCheck,
      get busy() { return busy; },
      stop() { peerWatch.stopped = true; peerWatch.on = false; if (peerWatch.timer) clearTimeout(peerWatch.timer); peerWatch.timer = null; },
    };
  }

  // ---------- helpers ----------
  // The Click of every watchdog notification. Sanitised even though `forja up`
  // no longer writes a token into tunnel.json: a file left by an older `up` must
  // not put the token on a public ntfy topic.
  function mobileUrl() { try { const t = JSON.parse(readFileSync(join(dataDir, 'tunnel.json'), 'utf8')); return sanitizeClick(t.mobileUrl); } catch { return undefined; } }
  function allowedHosts(actualPort) {
    const set = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
    if (host !== '127.0.0.1' && host !== 'localhost') set.add(`${host}:${actualPort}`);
    for (const h of String(process.env.FORJA_ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)) set.add(h);
    try { const t = JSON.parse(readFileSync(join(dataDir, 'tunnel.json'), 'utf8')); for (const h of t.hostnames || []) set.add(h); if (t.url) set.add(new URL(t.url).host); } catch {}
    return set;
  }
  const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
  const parseCookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(s => s.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, safeDecode(v.join('='))]));
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
  function sendFile(res, path, status = 200) {
    try { const body = readFileSync(path); res.writeHead(status, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(body); }
    catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); }
  }
  const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(JSON.stringify(obj)); };
  const denied = res => { res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>Forja</title><body style="font-family:system-ui;background:#1a1512;color:#e8dfd3;display:grid;place-items:center;height:100vh;margin:0"><p>Access denied. Open the viewer home page and paste your token.</p>'); };

  // ---------- entry page (T-SEC-1) ----------
  // The ntfy link no longer carries the token (docs/ARCHITECTURE.md §10), so the
  // explicit Core and compatibility entry pages answer an unauthenticated GET with a
  // form instead of a dead end: the Sponsor pastes the token once per tunnel URL
  // and the cookie keeps him in. Every other route still answers 401.
  // The page is inline (no /assets: those need the cookie), has no script, and
  // echoes nothing from the request — `next` is a whitelisted page path and the
  // error is one of two fixed strings, so there is no place to inject HTML.
  // A wrong token costs the same second and the same slot in the brake whether
  // it arrives in the form or in `?k=`.
  // The brake counts failures per client address, which behind the tunnel is one
  // address for the whole internet (cloudflared connects from loopback): it is a
  // global "5 wrong tokens a minute, then a minute of 429", not a per-visitor
  // one. That is why the right token is checked before the block is consulted —
  // someone guessing must never be able to keep the Sponsor out (documented in
  // docs/ARCHITECTURE.md §11).
  const LOGIN_MAX = 5;             // failed attempts per minute, per client address
  const LOGIN_WINDOW_MS = 60_000;
  const LOGIN_DELAY_MS = 1000;     // a wrong token always costs a second
  const LOGIN_BODY_MAX = 1024;     // bytes; the form has two short fields
  const loginFails = new Map();
  const clientKey = req => String(req.socket && req.socket.remoteAddress || '?');
  function loginBlocked(req, now = Date.now()) {
    const hits = (loginFails.get(clientKey(req)) || []).filter(t => now - t < LOGIN_WINDOW_MS);
    return hits.length >= LOGIN_MAX;
  }
  function noteLoginFail(req, now = Date.now()) {
    const key = clientKey(req);
    const hits = (loginFails.get(key) || []).filter(t => now - t < LOGIN_WINDOW_MS);
    hits.push(now);
    loginFails.set(key, hits);
    if (loginFails.size > 64) for (const [k2, v] of loginFails) if (!v.some(t => now - t < LOGIN_WINDOW_MS)) loginFails.delete(k2);
  }
  // Which page an unauthenticated GET may answer with the form (and where the
  // form sends the visitor back to). Anything else → 401.
  function entryTarget(pathname) {
    if (pathname === '/') return '/';
    if (pathname === '/core') return '/core';
    if (pathname === '/legacy' || pathname === '/legacy/m') return pathname;
    if (pathname === '/m' || pathname === '/m/') return '/m';
    return null;
  }
  const LOGIN_ERRORS = {
    wrong: 'Incorrect token. Make sure you copied the whole line.',
    throttled: 'Too many attempts. Wait a minute and try again.',
  };
  function loginPage(next, error) {
    const err = error ? `<p class="err" role="alert">${LOGIN_ERRORS[error]}</p>` : '';
    const onde = next === '/m' ? 'on this phone' : 'in this browser'; // `/` is the PC page
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<meta name="robots" content="noindex"><title>Forja — sign in</title><style>`
      // Token names and values are viewer/assets/viewer.css's (docs/design/DESIGN.md);
      // the page is a light ticket, so it uses the ticket family, including the
      // darkened wood (`--wood` gives 1,9:1 on the ticket) and the ticket's dark
      // red for the error (the `--alarm` of the palette gives 2,2:1 there).
      + `:root{--bg:#0E0C0B;--ticket:#F1E7D8;--ticket-ink:#1B1512;--ticket-dim:#5A4E44;`
      + `--ticket-wood:#6B4A1F;--ticket-line:#B9AA98;--ticket-label:#8A1E12;--patina:#63C9A9}`
      + `*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ticket);font:400 16px/1.45 system-ui,sans-serif;`
      + `display:grid;place-items:center;min-height:100vh;padding:24px}`
      + `main{width:100%;max-width:420px;background:var(--ticket);color:var(--ticket-ink);border-radius:12px;border-top:4px solid var(--ticket-wood);padding:24px}`
      + `.label{font:600 12px/1 system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:var(--ticket-wood);margin:0 0 8px}`
      + `h1{margin:0 0 8px;font:600 28px/1.15 system-ui,sans-serif}`
      + `p{margin:0 0 16px}.hint{color:var(--ticket-dim)}`
      + `label{display:block;font-weight:600;margin-bottom:8px}`
      + `input{width:100%;min-height:48px;padding:12px;font:400 16px/1.2 ui-monospace,Consolas,monospace;`
      + `color:var(--ticket-ink);background:#fff;border:1px solid var(--ticket-line);border-radius:8px}`
      + `button{width:100%;min-height:48px;margin-top:16px;font:600 16px/1 system-ui,sans-serif;`
      + `color:var(--ticket);background:var(--ticket-ink);border:1px solid var(--ticket-ink);border-radius:8px;cursor:pointer}`
      // Focus per DESIGN.md: 2 px --patina. On this light ticket the patina alone
      // would be 1,6:1, so it rides on a 2 px dark ring that fills the offset —
      // the indicator is above 3:1 against the ticket at every point.
      + `:focus-visible{outline:2px solid var(--patina);outline-offset:2px;box-shadow:0 0 0 2px var(--ticket-ink)}`
      + `.err{color:var(--ticket-label);font-weight:600}`
      + `</style></head><body><main><p class="label">Forja</p><h1>Sign in</h1>`
      + `<p class="hint">Paste the token from data\\viewer-token.txt on the host computer. Access is remembered ${onde} for this address.</p>`
      + err
      + `<form method="post" action="/login"><input type="hidden" name="next" value="${next}">`
      + `<label for="k">Token</label>`
      + `<input id="k" name="k" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" required>`
      + `<button type="submit">Sign in</button></form></main></body></html>`;
  }
  function sendLogin(res, next, error = null, status = 200) {
    const body = loginPage(next, error);
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      ...(status === 429 ? { 'Retry-After': '60' } : {}),
    });
    res.end(body);
  }
  // Read at answer time, never captured: `forja token rotate` swaps `token`.
  // `Secure` as soon as the visit is not plain loopback: over the tunnel the
  // browser speaks https to Cloudflare and cloudflared forwards
  // `X-Forwarded-Proto: https`, so the cookie must never be allowed to travel
  // in clear; on `http://127.0.0.1` the flag would make the cookie unusable and
  // is left off. 30 days instead of a year: a phone that is lost or lent stops
  // being a door into the PC after a month, and the token is one paste away.
  const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
  function secureCookie(req) {
    if (String(req.headers['x-forwarded-proto'] || '').toLowerCase().split(',')[0].trim() === 'https') return true;
    const h = String(req.headers.host || '').toLowerCase();
    const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
    return !LOOPBACK.has(name);
  }
  const authCookie = req => `forja_k=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE_S}${secureCookie(req) ? '; Secure' : ''}`;
  // One failed attempt, whatever its shape — the form or a wrong `?k=` in the
  // address. The block is consulted first (an attempt made while blocked does
  // not extend the block), then the failure is recorded and the answer costs a
  // second. `next` is the entry page to answer with; anything else gets the
  // plain 401, which says as little as it did before.
  function refuseToken(req, res, next) {
    const page = (error, status) => (next ? sendLogin(res, next, error, status) : denied(res));
    if (loginBlocked(req)) { page('throttled', 429); return; }
    noteLoginFail(req);
    // The delay is the whole point of the wrong branch: no detail in the answer,
    // and a second of cost per guess on top of the 5/minute cap.
    setTimeout(() => { try { page('wrong', 200); } catch {} }, LOGIN_DELAY_MS).unref();
  }
  function handleLogin(req, res) {
    // `Origin: null` is accepted here and only here: this page sends
    // `Referrer-Policy: no-referrer`, and a browser posting a form from such a
    // page sends exactly that (Fetch spec) — refusing it would lock out the
    // Sponsor holding the right token. A forged cross-site login wins nothing:
    // whoever can post the token already has the token. Another site's Origin
    // is still refused, and `/runs` still refuses `null`.
    if (crossSite(req, { allowNull: true })) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('pedido de outra origem'); return; }
    const chunks = []; let bytes = 0; let tooBig = false;
    req.on('data', d => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      bytes += buf.length;
      if (tooBig) { if (bytes > 64 * 1024) req.destroy(); return; }
      if (bytes > LOGIN_BODY_MAX) { tooBig = true; chunks.length = 0; res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('pedido demasiado grande'); return; }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (tooBig) return;
      let form;
      try { form = new URLSearchParams(Buffer.concat(chunks).toString('utf8')); } catch { form = new URLSearchParams(); }
      const next = entryTarget(String(form.get('next') || '/')) || '/';
      const candidate = String(form.get('k') || '').trim();
      // The token is checked BEFORE the block: only failures count, so a right
      // token always gets in, even in a minute someone else spent guessing.
      if (tokenOk(candidate)) { res.writeHead(302, { 'Set-Cookie': authCookie(req), 'Cache-Control': 'no-store', Location: next }); res.end(); return; }
      refuseToken(req, res, next);
    });
  }

  // ---------- run API ----------
  const runsCtx = { dataDir, forjaRoot: repoRoot, spawnRunner: opts.spawnRunner };

  // ---------- server ----------
  const server = createServer((req, res) => {
    try { handle(req, res); }
    catch (err) { console.error(`request error: ${err && err.message}`); try { if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request'); } catch {} }
  });
  function handle(req, res) {
    const actualPort = server.address().port;
    if (!allowedHosts(actualPort).has(String(req.headers.host || '').toLowerCase())) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden host'); return; }
    let url;
    try { url = new URL(req.url, `http://${req.headers.host}`); } catch { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad request'); return; }
    if (url.pathname === '/health') { json(res, 200, { ok: true }); return; }
    // auth. `?k=<token>` still works for whoever pastes it (the ntfy link does
    // not carry it any more); a wrong one falls through to the entry page on the
    // two HTML pages and to 401 everywhere else.
    if (req.method === 'POST' && url.pathname === '/login') { handleLogin(req, res); return; }
    const k = url.searchParams.get('k');
    if (k !== null && tokenOk(k)) {
      url.searchParams.delete('k');
      const target = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : '');
      res.writeHead(302, { 'Set-Cookie': authCookie(req), Location: target || '/' });
      res.end(); return;
    }
    if (!tokenOk(parseCookies(req).forja_k)) {
      const entry = req.method === 'GET' ? entryTarget(url.pathname) : null;
      // A wrong `?k=` is a guess like any other: same counter, same second of
      // delay as the form (otherwise the address bar is the way around the
      // brake). Whoever already has the cookie never reaches this line, so a
      // stale link with an old token does not throw him out.
      if (k !== null) { refuseToken(req, res, entry); return; }
      if (entry) { sendLogin(res, entry, null); return; }
      denied(res); return;
    }

    // Run API (viewer/runs-api.mjs): /projects and /runs, authenticated above.
    if (handleRunsApi(req, res, runsCtx)) return;
    if (handleCoreDecision(req, res, runsCtx)) return;

    if (req.method === 'GET' && url.pathname === '/api/core') {
      const snapshot = coreSnapshot(dataDir);
      return json(res, snapshot.ok ? 200 : 500, snapshot);
    }
    if (req.method === 'GET' && ['/', '/core', '/m', '/m/'].includes(url.pathname)) return sendFile(res, join(here, 'core.html'));
    if (req.method === 'GET' && url.pathname === '/legacy') return sendFile(res, join(here, 'index.html'));
    if (req.method === 'GET' && url.pathname === '/legacy/m') return sendFile(res, join(here, 'mobile.html'));
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      const rel = url.pathname.slice('/assets/'.length);
      if (rel.includes('..') || rel.includes('\\')) { res.writeHead(400); res.end(); return; }
      return sendFile(res, join(here, 'assets', rel));
    }
    if (req.method === 'GET' && url.pathname === '/state') { pump(); return json(res, 200, currentSnapshot()); }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      pump();
      res.write(`event: state\ndata: ${JSON.stringify(currentSnapshot(true))}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/feed') { pump(); return json(res, 200, currentFeed()); }
    if (req.method === 'POST' && url.pathname === '/answers') {
      // Bytes in, decoded once at the end: a chunk boundary inside a multibyte
      // character would otherwise turn an accented answer into U+FFFD, and the
      // cap has to be counted in bytes for the same reason.
      const chunks = []; let bytes = 0; let tooBig = false;
      req.on('data', d => {
        const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
        bytes += buf.length;
        // Answer 413 and drain (so the client can read the status) instead of
        // resetting the connection; a body past 1 MB is dropped outright.
        if (tooBig) { if (bytes > 1024 * 1024) req.destroy(); return; }
        if (bytes > 64 * 1024) { tooBig = true; chunks.length = 0; return json(res, 413, { error: 'body too large' }); }
        chunks.push(buf);
      });
      req.on('end', () => {
        if (tooBig) return;
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          let a; try { a = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
          if (!a || typeof a !== 'object' || Array.isArray(a)) return json(res, 400, { error: 'object required' });
          const project = String(a.project || '').replace(/[^a-zA-Z0-9._-]/g, '');
          const id = typeof a.id === 'string' && /^Q\d+$/.test(a.id) ? a.id : null;
          const answer = String(a.answer || '').trim().slice(0, 2000);
          if (!project || !id || !answer) return json(res, 400, { error: 'project, id (Q<n>) and answer required' });
          // Only questions that exist in a known run can be answered — never invent a run.
          const run = currentSnapshot(true).runs.find(r => r.project === project && r.queue.some(q => q.id === id));
          if (!run) return json(res, 404, { error: 'no such open question for that project' });
          const rec = { ts: new Date().toISOString(), project, id, answer, via: 'viewer' };
          try { mkdirSync(join(dataDir, 'answers'), { recursive: true }); appendFileSync(join(dataDir, 'answers', `${project}.jsonl`), JSON.stringify(rec) + '\n'); }
          catch (err) { return json(res, 500, { error: String(err.message) }); }
          // Tell the viewer (and the lead's next `forja answers`) that an answer is waiting.
          const ev = { ts: rec.ts, project, session_id: run.sessions.at(-1), cwd: run.cwd, hook_event_name: 'Forja', forja: { kind: 'answer.pending', run_id: run.runId, id, text: answer, via: 'viewer' } };
          try { appendFileSync(eventsPath, JSON.stringify(ev) + '\n'); } catch {}
          return json(res, 200, { ok: true });
        } catch (err) { console.error(`answers error: ${err && err.message}`); try { json(res, 400, { error: 'bad request' }); } catch {} }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  }

  loadHistory();
  server.listen(port, host, () => {
    // Nunca o token: a saída de `forja serve` / `forja up` é capturada pelo hook
    // para data/events.jsonl (e para data/up.log), e um token impresso aqui fica
    // lá vivo, em claro, para sempre. O endereço chega; o token cola-se na
    // página de entrada e lê-se de data/viewer-token.txt.
    console.log(`Forja viewer: http://${host}:${server.address().port}/`);
    console.log('Token em data\\viewer-token.txt — cola-o na página de entrada.');
    console.log(`Tailing: ${eventsPath} (${lineNo} events, ${state.runs.size} runs)`);
  });
  function shutdown() { unwatchFile(eventsPath); clearInterval(hb); if (wdTimer) clearInterval(wdTimer); peerWatch.stopped = true; if (peerWatch.timer) clearTimeout(peerWatch.timer); for (const c of clients) c.end(); server.close(() => process.exit(0)); }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  return { server, get token() { return token; }, rotateToken() { token = randomBytes(24).toString('hex'); writeFileSync(tokenPath, token + '\n'); return token; }, close: shutdown, snapshot: () => currentSnapshot(true), startPeerWatch };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startServer();
