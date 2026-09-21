// `forja up` and `forja autostart install|remove` (docs/ARCHITECTURE.md §11, §12).
//
// up: starts the viewer (viewer/server.mjs), opens a free, account-less tunnel
// to it and supervises both. Tunnel providers, in order:
//   1. Cloudflare quick tunnel — tools/cloudflared/cloudflared.exe (portable,
//      git-ignored; if missing we print the download URL and skip it);
//   2. ssh -R 80:127.0.0.1:<port> nokey@localhost.run (no install at all).
// The public URL is parsed from the provider's output; when it appears or
// changes we write data/tunnel.json (the viewer reads `hostnames` for its Host
// allow-list and `mobileUrl` for ntfy Click links) and notify the phone with a
// status-only body — the URL travels only in the Click action, and it never
// carries the viewer token (T-SEC-1): the phone pastes it once in the viewer's
// entry page.
// Supervision: a provider that produces no URL within URL_TIMEOUT_MS is killed
// and the next one is tried; when every provider failed we wait with backoff
// (5 s, 15 s, 60 s, 5 min max) and start again from the first. If the viewer
// itself fails we exit non-zero and the autostart wrapper restarts `up`.
// Log: data/up.log, timestamped, never the token.
//
// autostart install: a hidden launcher in the user's Startup folder
// (%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\forja-up.vbs, run by
// Windows at login through wscript with window style 0 = no window at all) that
// starts data/autostart/forja-up.cmd, a small wrapper that runs `forja up` and
// restarts it after 30 s if it exits with an error. Only the .vbs lives in the
// Startup folder: two files there would mean two launches at login. Since the
// guarda dos runners exists (lib/guard.mjs, docs/ARCHITECTURE.md §12) install
// writes FOUR files: the same pair for `up` plus forja-guard.vbs/.cmd for
// `forja guard run`. The two loops are independent — neither wrapper starts the
// other — because the incident that created the guard was the viewer dying at
// the same minute as the runner it should have reported.
// autostart remove: deletes the four files, writes data/guard/guard.stop (the
// guard is asked to stop, never killed), then runs `down`. Both idempotent,
// both print JSON.
//
// Stopping (also a hidden instance): `up` writes data/up.pid on listen and
// removes it (plus data/tunnel.json) on any exit; `forja down` writes
// data/up.stop, kills the up.pid tree (viewer + cloudflared/ssh) — never a
// `forja.mjs runner` in it, nor anything under one: a run started from the phone
// outlives the viewer, and `down` says how many it spared —, kills only
// leftovers it can attribute to us, removes tunnel.json and reports JSON. The
// wrapper deletes up.stop when it starts and exits its loop when it sees it, so
// nothing comes back until the next login or a manual start.
//
// Pure helpers exported for tests (no network, no processes): parseTunnelUrl,
// buildTunnelJson, backoffDelay, tunnelCommands, startupPaths, launcherFiles.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, forjaRoot, nowIso } from './state-files.mjs';
import { notify } from './notify.mjs';
import { RUNNER_CMD_RE } from './runner.mjs';
// The guard's own autostart pair (docs/ARCHITECTURE.md §12). One-way import:
// lib/guard.mjs never imports this file.
import { guardLauncherFiles, guardStartupPaths, writeGuardStop } from './guard.mjs';
// `controlPaths` (up.pid / up.stop / tunnel.json) moved to lib/supervise.mjs
// when the guard started watching the viewer: both sides need the same three
// paths, and two definitions of "where up.stop lives" is how a `down` stops
// meaning "stopped". Re-exported here so every existing caller keeps working.
import { controlPaths } from './supervise.mjs';
export { controlPaths };

export const CLOUDFLARED_DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
export const URL_TIMEOUT_MS = 60_000;      // a provider without a URL by then is killed and the next one tried
export const HEALTHY_MS = 120_000;         // a tunnel that lived this long resets the backoff
export const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];
export const WRAPPER_RETRY_S = 30;         // the autostart wrapper waits this long before restarting `up` after an error
export const WRAPPER_RETRY_BUSY_S = 120;   // ... and this long after exit 3 (port busy: another viewer is up, no point hammering)
// tunnel.json is written the moment the URL appears; the phone is notified this
// much later. trycloudflare.com has a 30 min negative TTL (SOA), so a tap that
// resolves the name before Cloudflare publishes it would poison the phone's
// resolver for half an hour. Measured 2026-09-16: reachable ~15 s after the URL.
export const NOTIFY_GRACE_MS = 10_000;
const isWin = process.platform === 'win32';

// ---------- pure helpers ----------

// First public tunnel URL in a chunk of provider output, or null.
// cloudflared: the "Requesting new quick Tunnel on trycloudflare.com..." line
// has no https:// prefix and never matches; the real URL comes ~5 s later in a
// box. localhost.run: "<id>.lhr.life tunneled with tls termination, https://<id>.lhr.life"
// on stdout, while the banner on stderr carries decoys (https://admin.localhost.run/,
// https://localhost.run/docs/) that must never be taken for the tunnel.
const CF_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const LHR_RE = /https:\/\/([a-z0-9-]+)\.(?:lhr\.life|localhost\.run)(?![a-z0-9.-])/g;
const LHR_DECOYS = new Set(['admin', 'www', 'docs', 'api']);
export function parseTunnelUrl(text) {
  const s = String(text || '');
  const cf = s.match(CF_RE);
  if (cf) return cf[0];
  for (const m of s.matchAll(LHR_RE)) if (!LHR_DECOYS.has(m[1])) return m[0];
  return null;
}

// Shape of data/tunnel.json. `hostnames` feeds the viewer's Host allow-list,
// `mobileUrl` its ntfy Click links and the phone notification sent here.
// The token is deliberately NOT in these links (T-SEC-1): they travel in the
// Click header of every notification to a public ntfy topic, and since
// `POST /runs` exists the token starts runs on the PC. The phone pastes the
// token once in the entry page the viewer serves for `/` and `/m`; `?k=` keeps
// working for whoever pastes it. Nothing here ever writes the token to disk.
export function buildTunnelJson(url, since = nowIso()) {
  const u = new URL(url);
  const base = `${u.protocol}//${u.host}`;
  return { url: base, hostnames: [u.host], mobileUrl: `${base}/m`, desktopUrl: `${base}/`, since };
}

// Wait before the (n+1)-th consecutive failed cycle: 5 s, 15 s, 60 s, then 5 min.
export function backoffDelay(failures) {
  return BACKOFF_MS[Math.min(Math.max(0, failures | 0), BACKOFF_MS.length - 1)];
}

export function cloudflaredPath(forja = forjaRoot) {
  return join(forja, 'tools', 'cloudflared', isWin ? 'cloudflared.exe' : 'cloudflared');
}

export function tunnelCommands(port, { forja = forjaRoot } = {}) {
  const target = `http://127.0.0.1:${port}`;
  return {
    cloudflared: { cmd: cloudflaredPath(forja), args: ['tunnel', '--url', target, '--no-autoupdate', '--protocol', 'http2'] },
    ssh: { cmd: 'ssh', args: ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run'] },
  };
}

// Where autostart puts its two files. The launcher (.vbs) is the only file in
// the Startup folder; the wrapper (.cmd) lives in <forja>/data/autostart.
export function startupPaths({ appData = process.env.APPDATA, data = dataDir() } = {}) {
  if (!appData) throw new Error('APPDATA não definido — `forja autostart` só funciona no Windows');
  const startupDir = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  return { startupDir, launcher: join(startupDir, 'forja-up.vbs'), wrapper: join(data, 'autostart', 'forja-up.cmd'), consoleLog: join(data, 'up.console.log'), ...controlPaths(data) };
}

// Contents of the two autostart files. CRLF because cmd.exe and wscript read them.
export function launcherFiles(paths, { forja = forjaRoot, node = process.execPath } = {}) {
  const bin = join(forja, 'bin', 'forja.mjs');
  const wrapper = [
    '@echo off',
    'rem Forja: wrapper de arranque automatico, gerado por `forja autostart install` (remover com `forja autostart remove`).',
    'rem Corre `forja up` (viewer + tunel + notificacao) e volta a arranca-lo se sair com erro; sai quando `forja up` termina limpo',
    'rem ou quando existe o ficheiro up.stop (escrito por `forja down` / `forja autostart remove`).',
    'rem Podes correr este ficheiro a mao para ver o que acontece numa janela normal.',
    `cd /d "${forja}"`,
    `if exist "${paths.stop}" del /q "${paths.stop}"`,
    ':loop',
    `"${node}" "${bin}" up >> "${paths.consoleLog}" 2>&1`,
    'set FORJA_CODE=%ERRORLEVEL%',
    'if %FORJA_CODE% EQU 0 goto end',
    `if exist "${paths.stop}" goto end`,
    `if %FORJA_CODE% EQU 3 ("${node}" -e "setTimeout(function(){}, ${WRAPPER_RETRY_BUSY_S * 1000})") else ("${node}" -e "setTimeout(function(){}, ${WRAPPER_RETRY_S * 1000})")`,
    `if exist "${paths.stop}" goto end`,
    'goto loop',
    ':end',
    '',
  ].join('\r\n');
  const launcher = [
    "' Forja: arranque automatico no login, gerado por `forja autostart install` (remover com `forja autostart remove`).",
    "' Windows corre este ficheiro ao entrar; ele lanca o wrapper sem janela nenhuma (estilo 0) e nao espera por ele.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "cmd.exe /c ""${paths.wrapper}""", 0, False`,
    '',
  ].join('\r\n');
  return { [paths.launcher]: launcher, [paths.wrapper]: wrapper };
}

// ---------- autostart ----------
function out(obj) { console.log(JSON.stringify(obj, null, 2)); }

export async function autostart({ pos = [] } = {}) {
  const action = pos[0];
  if (!['install', 'remove'].includes(action)) throw new Error('uso: forja autostart install|remove');
  const paths = startupPaths();
  // Two independent pairs, two independent loops: the viewer + tunnel (`up`) and
  // the guarda dos runners (`guard`, lib/guard.mjs, docs/ARCHITECTURE.md §12).
  // Neither wrapper starts the other — that is the whole point of the guard: on
  // 17 set 2026 the viewer died at the same minute as the runner it should have
  // reported, and one wrapper for both would have died with it.
  const guardPaths = guardStartupPaths();
  const files = { ...launcherFiles(paths), ...guardLauncherFiles(guardPaths) };
  const result = { ok: true, action, launcher: paths.launcher, wrapper: paths.wrapper, guardLauncher: guardPaths.launcher, guardWrapper: guardPaths.wrapper, written: [], unchanged: [], removed: [], missing: [] };
  if (action === 'install') {
    for (const [path, content] of Object.entries(files)) {
      const same = existsSync(path) && readFileSync(path, 'utf8') === content;
      if (same) { result.unchanged.push(path); continue; }
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
      result.written.push(path);
    }
    result.note = 'no próximo login do Windows arrancam sozinhos, sem janela, o viewer com o túnel e a guarda dos runners; para testar já, corre os wrappers (.cmd) à mão';
  } else {
    for (const path of Object.keys(files)) {
      if (existsSync(path)) { rmSync(path, { force: true }); result.removed.push(path); } else result.missing.push(path);
    }
    // The guard is asked to stop, never killed: it is not in the viewer's tree
    // and `down` has no business walking anything of its own.
    result.guardStopFile = writeGuardStop(dataDir(), 'forja autostart remove');
    const d = await downCore();
    result.killed = d.killed; result.sparedRunners = d.sparedRunners; result.stopFile = d.stopFile; result.removedFiles = d.removed;
    if (d.unattributed.length) result.unattributed = d.unattributed;
    if (d.notes.length) result.notes = d.notes;
    result.note = `o arranque automático deixa de existir, a guarda dos runners foi mandada parar, e o viewer e o túnel foram parados agora (${d.killed.length} processo${d.killed.length === 1 ? '' : 's'}); ${d.note}`;
  }
  out(result);
  return result;
}

// ---------- down ----------
function isAlive(pid) {
  if (!isWin) { try { process.kill(pid, 0); return true; } catch { return false; } }
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').includes(` ${pid} `);
}
// A live run is never collateral damage. `down` stops the viewer and the tunnel;
// a runner (and the `claude -p` session under it) only happens to have been
// started by the viewer, and on 17 set 2026 05:15:22Z one `down` took two of
// them with it — taskkill /T walks ParentProcessId, and on Windows `detached`
// does not leave the tree. Since then, two defences: the viewer starts runners
// outside its tree (viewer/runs-api.mjs) AND every kill here skips any process
// whose command line is a `forja.mjs runner`, with everything under it (the
// session it drives hangs from it). The test is the one the runner's own lock
// uses (RUNNER_CMD_RE, lib/runner.mjs), lower-cased because Windows gives the
// command line back as whoever started it typed it.
export const isRunnerCmd = cmd => {
  const line = String(cmd || '').toLowerCase();
  return RUNNER_CMD_RE.test(line) || /forja\.mjs["']?\s+(?:start\b|core\s+(?:start|resume|retry)\b)/.test(line);
};

// Pure: root pid + Win32_Process records → { kill: pids deepest-first, spared }.
// A spared runner takes its whole subtree out of the plan; the rest of the tree
// still dies, children before parents (a parent killed first would orphan them).
// Win32_Process CreationDate as milliseconds ("/Date(1789545493919)/"), or null.
const creationMs = v => { const m = /(\d{10,})/.exec(String(v == null ? '' : v)); return m ? Number(m[1]) : null; };

export function planKillTree(root, procs) {
  const children = new Map(); const cmdOf = new Map(); const bornAt = new Map();
  for (const p of procs || []) {
    const pid = Number(p.ProcessId); const ppid = Number(p.ParentProcessId);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    cmdOf.set(pid, String(p.CommandLine || ''));
    bornAt.set(pid, creationMs(p.CreationDate));
    if (Number.isInteger(ppid) && ppid > 0 && ppid !== pid) {
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
  }
  // A "child" older than its parent is not a child at all: Windows reused the
  // parent's pid and this process belongs to whoever had it before. It leaves
  // the plan with its own subtree — killing it would be killing a stranger.
  const isRealChild = (child, parent) => {
    const c = bornAt.get(child); const p = bornAt.get(parent);
    return c === null || p === null || c >= p;
  };
  const kill = []; const spared = []; const seen = new Set();
  const walk = pid => {
    if (seen.has(pid)) return; // Windows reuses pids: parent links can form a cycle
    seen.add(pid);
    if (isRunnerCmd(cmdOf.get(pid))) { spared.push(pid); return; }
    for (const k of children.get(pid) || []) if (isRealChild(k, pid)) walk(k);
    kill.push(pid);
  };
  walk(Number(root));
  return { kill, spared };
}

// The enumeration is the only thing that tells a runner from a viewer: without
// it there is no safe tree to walk, so nothing is walked.
export const ENUM_FAILED_NOTE = 'enumeração de processos falhou — só o processo raiz foi parado; filhos ficam vivos';
const taskkill = (pid, tree) => spawnSync('taskkill', ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F'], { encoding: 'utf8', windowsHide: true }).status === 0;

// { ok, spared: [pids of live runners left alone], notes }. `list` and `info`
// are the seams the tests use to play the enumeration failing on a real tree.
export function killPidTree(pid, list = listProcesses, info = processInfo) {
  if (!isWin) { try { process.kill(pid, 'SIGTERM'); return { ok: true, spared: [], notes: [] }; } catch { return { ok: false, spared: [], notes: [] }; } }
  const procs = list();
  if (!procs.length) {
    // Enumeration failed (PowerShell missing, timed out, output unusable). Never
    // a blind `/T` here: it is exactly the kill that took two runs down. Ask
    // about this pid alone and stop that one process; children stay alive and
    // the note says so, out loud.
    const one = info(pid);
    if (isRunnerCmd(one && one.CommandLine)) return { ok: false, spared: [pid], notes: [] };
    return { ok: taskkill(pid, false), spared: [], notes: [ENUM_FAILED_NOTE] };
  }
  const { kill, spared } = planKillTree(pid, procs);
  // Nothing to spare, the usual case: one taskkill for the whole tree.
  if (!spared.length) return { ok: taskkill(pid, true), spared, notes: [] };
  let ok = false;
  // Never /T here: the tree is walked above, so the spared subtrees stay out of it.
  for (const p of kill) { const done = taskkill(p, false); if (p === pid) ok = done; }
  return { ok, spared, notes: [] };
}
// Processes of the tunnel provider that are provably ours: cloudflared running
// from <forja>/tools/cloudflared, ssh with nokey@localhost.run on its command
// line. Anything else with the same name is reported, never killed.
export function attributeLeftovers(provider, procs, { forja = forjaRoot } = {}) {
  const ours = []; const others = [];
  const cf = cloudflaredPath(forja).replace(/\\/g, '/').toLowerCase();
  for (const p of procs) {
    const exe = String(p.ExecutablePath || '').replace(/\\/g, '/').toLowerCase();
    const cmd = String(p.CommandLine || '');
    const mine = provider === 'cloudflared' ? exe === cf : provider === 'ssh' ? cmd.includes('nokey@localhost.run') : false;
    (mine ? ours : others).push({ pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId) || null, name: p.Name, cmd: cmd.slice(0, 120) });
  }
  return { ours, others };
}
// Is this process record (Win32_Process shape) a `forja up` of THIS repo? It must be
// node.exe and either (a) its command line carries <forja>/bin/forja.mjs (either
// slash style) followed by ` up`, or (b) `created` — the CreationDate `up` stored in
// up.pid next to its pid — equals the live process's CreationDate (a PID that Windows
// reused after a crash gets a different creation time). (b) is what makes the
// Sponsor's own `node bin\forja.mjs up` (relative path on the command line)
// attributable. A stale up.pid must never make `down` kill a stranger's tree.
export function isOurUp(info, { forja = forjaRoot, created = null } = {}) {
  if (!info || String(info.Name || '').toLowerCase() !== 'node.exe') return false;
  if (created && info.CreationDate && String(info.CreationDate) === String(created)) return true;
  const cmd = String(info.CommandLine || '').replace(/\\/g, '/').toLowerCase();
  const bin = `${forja.replace(/\\/g, '/')}/bin/forja.mjs`.toLowerCase();
  const i = cmd.indexOf(bin);
  if (i < 0) return false;
  return /^["']?\s+up(\s|$)/.test(cmd.slice(i + bin.length));
}
const PROC_FIELDS = 'ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate';
// Without this PowerShell writes the console codepage to the pipe, and a command
// line with anything outside it — a live `claude -p` whose prompt carries "→" or
// "§", which is every Forja session — arrives as raw 0x1A. That is not valid
// JSON, the whole enumeration is lost, and a `down` would then kill exactly the
// runners it must spare (seen on this machine: 8 stray 0x1A in 262 KB, all of
// them inside the command lines of live Forja sessions).
// A PowerShell that hangs must not hang `down` with it: the same 15 s the
// runner's own `commandLineOf` uses. A timeout leaves stdout empty, which is the
// enumeration failure killPidTree already refuses to guess around.
export const PROC_TIMEOUT_MS = 15_000;
const PS_UTF8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8;';
// A control character that still gets through must cost one field, never the list.
export function parseProcJson(text) {
  const t = String(text || '').replace(/[\u0000-\u001F]/g, ' ').trim();
  try { const j = JSON.parse(t || '[]'); return j == null ? [] : Array.isArray(j) ? j : [j]; } catch { return []; }
}
// No filter: every process on the machine (what planKillTree needs to know who
// hangs off whom). That output is bigger than spawnSync's default buffer allows.
function queryProcesses(filter) {
  if (!isWin) return [];
  const where = filter ? ` -Filter "${filter}"` : '';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `${PS_UTF8}Get-CimInstance Win32_Process${where} | Select-Object ${PROC_FIELDS} | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: PROC_TIMEOUT_MS });
  return parseProcJson(r.stdout);
}
export function processInfo(pid) {
  return queryProcesses(`ProcessId=${Number(pid)}`)[0] || null;
}
const listProcesses = name => queryProcesses(name ? `Name='${name}'` : '');

async function downCore() {
  const data = dataDir();
  mkdirSync(data, { recursive: true });
  const c = controlPaths(data);
  const killed = []; const notes = []; const unattributed = []; const removed = [];
  const sparedRunners = new Set(); // live runs found inside a tree we killed: left alone
  const writeStop = () => writeFileSync(c.stop, `${nowIso()} forja down (pid ${process.pid})\n`);
  writeStop();
  const readPid = () => { try { const [p, created] = readFileSync(c.pid, 'utf8').split(/\r?\n/); const n = Number(String(p).trim()); return Number.isInteger(n) && n > 0 ? { pid: n, created: String(created || '').trim() || null } : null; } catch { return null; } };
  const tunnel = (() => { try { return JSON.parse(readFileSync(c.tunnel, 'utf8')); } catch { return null; } })();
  const killFromPidFile = round => {
    const rec = readPid();
    if (!rec) { if (round === 1) notes.push('sem data/up.pid — nenhum `forja up` registado'); return; }
    const { pid, created } = rec;
    if (pid === process.pid) return;
    if (!isAlive(pid)) { notes.push(`data/up.pid apontava para ${pid}, que já não existe (ficheiro antigo)`); try { rmSync(c.pid, { force: true }); } catch {} return; }
    const info = processInfo(pid);
    if (!isOurUp(info, { created })) {
      // A stale up.pid whose number Windows reused for someone else's process: never kill it.
      unattributed.push({ pid, name: info && info.Name || '?', cmd: String(info && info.CommandLine || '').slice(0, 120), why: 'pid reutilizado ou processo alheio (não é `node bin/forja.mjs up` deste repo) — não mexi' });
      try { rmSync(c.pid, { force: true }); } catch {}
      return;
    }
    const r = killPidTree(pid);
    for (const s of r.spared) sparedRunners.add(s);
    for (const n of r.notes) if (!notes.includes(n)) notes.push(n);
    if (r.ok) { killed.push(pid); if (round > 1) notes.push(`o wrapper relançou o \`forja up\` (pid ${pid}) durante o down — morto também`); }
    else notes.push(`taskkill falhou para ${pid}`);
    try { rmSync(c.pid, { force: true }); } catch {}
  };
  killFromPidFile(1);
  // Orphans of the tunnel providers (a `forja up` killed hard leaves cloudflared/ssh alive).
  // Attribution is what makes this safe, so it runs even without tunnel.json; processes
  // of the same name that are not ours are only reported, and only for the provider
  // tunnel.json names (so an unrelated ssh on the machine is not listed on every down).
  // up.pid is the contract. Without it we never kill a `forja up` by command line alone:
  // the same repo can be running `up` for ANOTHER data dir (tests, a second checkout of
  // the Sponsor's setup) and that one is not ours to stop. Candidates are only listed.
  if (!readPid()) {
    for (const p of listProcesses('node.exe')) {
      const pid = Number(p.ProcessId);
      if (pid === process.pid || !isOurUp(p)) continue;
      unattributed.push({ pid, name: p.Name, cmd: String(p.CommandLine || '').slice(0, 120), why: 'sem up.pid — mata à mão se for este' });
    }
  }
  for (const provider of ['cloudflared', 'ssh']) {
    const { ours, others } = attributeLeftovers(provider, listProcesses(provider === 'cloudflared' ? 'cloudflared.exe' : 'ssh.exe'));
    for (const p of ours) {
      if (killed.includes(p.pid) || !isAlive(p.pid)) continue;
      // Orphan = its parent is gone (or was killed just now). A live parent means a live
      // `forja up` still supervising it (e.g. one we could not attribute): report, do not kill.
      const ppid = Number(p.ppid);
      if (ppid && ppid !== process.pid && !killed.includes(ppid) && isAlive(ppid)) { unattributed.push({ pid: p.pid, name: p.name, cmd: p.cmd, why: `tem o processo pai ${ppid} vivo (um \`forja up\` que não consegui atribuir a este repo?) — não mexi; se for teu, fecha-o no terminal dele` }); continue; }
      const r = killPidTree(p.pid);
      for (const s of r.spared) sparedRunners.add(s);
      for (const n of r.notes) if (!notes.includes(n)) notes.push(n);
      if (r.ok) { killed.push(p.pid); notes.push(`${p.name} ${p.pid} (nosso, órfão) morto`); }
    }
    if (tunnel && tunnel.provider === provider) for (const p of others) unattributed.push({ pid: p.pid, name: p.name, cmd: p.cmd, why: 'não é do Forja (não corre de tools/cloudflared nem liga a nokey@localhost.run) — não mexi' });
  }
  if (existsSync(c.tunnel)) { try { rmSync(c.tunnel, { force: true }); removed.push(c.tunnel); } catch {} }
  // Later rounds: the wrapper may have relaunched `up` between our stop file and the kill
  // (a fresh `up` deletes up.stop when it starts and only writes up.pid once it listens).
  // Re-arm the stop file and look again at +1.5 s and +4 s.
  for (const wait of [1500, 2500]) {
    await sleep(wait);
    if (!existsSync(c.stop)) writeStop();
    killFromPidFile(2);
    if (existsSync(c.tunnel)) { try { rmSync(c.tunnel, { force: true }); removed.push(c.tunnel); } catch {} }
  }
  const spared = [...sparedRunners];
  // The Sponsor has to be able to read this and know his run is still going.
  if (spared.length) notes.push(`poupados: ${spared.length} runner${spared.length === 1 ? '' : 's'} (pid ${spared.join(', ')}) — um run em curso não é parado pelo \`down\``);
  const note = killed.length ? 'viewer e túnel parados; o link do telemóvel deixou de funcionar. Se arrancaram sozinhos no login, o wrapper sai ao ver data/up.stop e nada volta até ao próximo login (ou `forja up` à mão)'
    : 'não havia nada a correr; data/up.stop escrito para o wrapper de arranque automático (se existir) sair';
  return { ok: true, killed, stopFile: c.stop, removed, unattributed, notes, note, sparedRunners: spared.length };
}

export async function down() {
  const d = await downCore();
  const result = { ok: d.ok, killed: d.killed, sparedRunners: d.sparedRunners, stopFile: d.stopFile, removed: d.removed, note: d.note };
  if (d.unattributed.length) result.unattributed = d.unattributed;
  if (d.notes.length) result.notes = d.notes;
  out(result);
  return result;
}

// ---------- up ----------
function makeLogger(path) {
  const write = (msg, fatal) => {
    const line = `${nowIso()} ${msg}`;
    try { appendFileSync(path, line + '\n'); } catch {}
    if (fatal) console.error(line); else if (process.stdout.isTTY) console.log(line);
  };
  const log = msg => write(msg, false);
  log.fatal = msg => write(msg, true); // always on stderr, TTY or not (the wrapper's console log must show it)
  return log;
}

// Same rule as `down`: the tunnel provider's tree dies, a `forja.mjs runner`
// inside it (and whatever hangs off it) does not. Returns { ok, spared }.
export function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { ok: false, spared: [] };
  try {
    if (isWin) return killPidTree(child.pid);
    child.kill('SIGTERM');
    return { ok: true, spared: [] };
  } catch { return { ok: false, spared: [] }; }
}

// Runs one provider until it exits. Resolves { url, ms, code, signal, error }.
// onUrl fires once, as soon as the public URL shows up in its output.
function runProvider(name, { cmd, args }, { log, onUrl, urlTimeoutMs, track }) {
  return new Promise(resolve => {
    const started = Date.now();
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
    catch (err) { resolve({ url: null, ms: 0, code: null, signal: null, error: String(err.message || err) }); return; }
    track(child);
    let url = null; let buf = ''; let settled = false; let error = null;
    const finish = (code, signal) => { if (settled) return; settled = true; clearTimeout(timer); track(null); resolve({ url, ms: Date.now() - started, code, signal, error }); };
    const onData = d => {
      buf += String(d);
      if (buf.length > 65_536) buf = buf.slice(-16_384);
      if (!url) { const u = parseTunnelUrl(buf); if (u) { url = u; clearTimeout(timer); onUrl(u); } }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    const timer = setTimeout(() => { if (!url) { log(`túnel: ${name} sem URL ao fim de ${Math.round(urlTimeoutMs / 1000)}s — a terminar`); killTree(child); } }, urlTimeoutMs);
    child.on('error', err => { error = String(err.message || err); log(`túnel: ${name} não arrancou (${error})`); setTimeout(() => finish(null, null), 50); });
    child.on('exit', (code, signal) => finish(code, signal));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function up({ opt = {} } = {}) {
  const port = Number(opt.port || process.env.PORT || 4317);
  const noTunnel = opt['no-tunnel'] === true;
  const data = dataDir();
  mkdirSync(data, { recursive: true });
  const log = makeLogger(join(data, 'up.log'));
  const c = controlPaths(data);
  const tunnelPath = c.tunnel;
  let current = null; let stopping = false; let ownsPid = false;
  const track = child => { current = child; };
  const dropTunnelJson = () => { try { if (existsSync(tunnelPath)) rmSync(tunnelPath, { force: true }); } catch {} };
  // On any exit: the tunnel child dies with us. Only the instance that reached
  // `listening` (ownsPid: it wrote up.pid) may touch tunnel.json and up.pid — an
  // instance that exited 3 on a busy port would otherwise delete the OWNER's files.
  const cleanup = () => {
    killTree(current);
    if (!ownsPid) return;
    dropTunnelJson();
    try { if (readFileSync(c.pid, 'utf8').split(/\r?\n/)[0].trim() === String(process.pid)) rmSync(c.pid, { force: true }); } catch {}
  };
  const shutdown = sig => {
    if (stopping) return;
    stopping = true;
    log(`forja up: ${sig} — a fechar o túnel e o viewer`);
    cleanup();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  // Ctrl+C, kill, Ctrl+Break (Windows) and the console window being closed (Windows maps it to SIGHUP).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => shutdown(sig));
  process.on('exit', cleanup);
  process.on('uncaughtException', err => { log.fatal(`forja up: erro fatal — ${err && err.stack || err}`); cleanup(); process.exit(1); });
  try { if (existsSync(c.stop)) { rmSync(c.stop, { force: true }); log('forja up: data/up.stop antigo apagado'); } } catch {}

  log(`forja up: a arrancar o viewer em 127.0.0.1:${port}${noTunnel ? ' sem túnel (--no-tunnel)' : ''}`);
  const { startServer } = await import('../viewer/server.mjs');
  const srv = startServer({ port, host: opt.host });
  srv.server.on('error', err => {
    const busy = err && err.code === 'EADDRINUSE';
    log.fatal(`forja up: o viewer não conseguiu arrancar — ${busy ? `porta ${port} ocupada (já há um viewer ou outro \`forja up\` a correr?)` : (err && err.message || err)}`);
    killTree(current); // not cleanup(): up.pid and tunnel.json belong to the instance that owns the port
    process.exit(busy ? 3 : 1);
  });
  await new Promise(resolve => srv.server.once('listening', resolve));
  // Segunda leitura do up.stop, agora que estamos mesmo a ouvir. A primeira
  // (lá em cima, antes de arrancar o servidor) apaga um pedido de paragem
  // ANTIGO — é isso que faz um `forja up` à mão voltar a servir. Esta apanha um
  // pedido de paragem NOVO, escrito enquanto arrancávamos, e é a diferença
  // entre «parado» e «parado durante uns segundos»:
  // desde que a guarda relança o viewer (docs/ARCHITECTURE.md §12), um `forja
  // down` dado na janela em que a guarda já decidiu relançar mas o processo
  // novo ainda não escreveu o up.pid não encontrava nada para matar (o viewer
  // velho já estava morto) e dizia «não havia nada a correr» — e segundos
  // depois o viewer novo apagava o up.stop, escrevia o up.pid e reabria o túnel
  // público, sem ninguém para o parar. Quem chega depois do pedido perde:
  // saímos sem servir, sem escrever up.pid e sem apagar o ficheiro de paragem
  // (a guarda continua a vê-lo e também não relança). O `down` que nos apanhe a
  // meio desta janela fecha-a de qualquer modo nas voltas dele (+1,5 s e +4 s),
  // porque aí já há up.pid.
  if (existsSync(c.stop)) {
    log('forja up: apareceu um data/up.stop durante o arranque (um `forja down` a meio) — saio sem servir e deixo o ficheiro de paragem como está');
    try { srv.server.close(); } catch {}
    killTree(current);
    process.exit(0);
  }
  ownsPid = true; // we reached `listening`: from here on up.pid and tunnel.json are ours, whatever happens to the writes below
  // up.pid: our pid now (readers accept a pid-only file), then our CreationDate appended
  // after the PowerShell lookup (~300 ms) so `down` can tell us apart from a process
  // that got the same pid later, whatever our command line looks like.
  try { writeFileSync(c.pid, `${process.pid}\n`); } catch (err) { log(`forja up: não consegui escrever up.pid (${err.message})`); }
  try { const me = processInfo(process.pid); if (me && me.CreationDate) appendFileSync(c.pid, `${String(me.CreationDate)}\n`); } catch (err) { log(`forja up: não consegui guardar a CreationDate em up.pid (${err.message})`); }
  log(`forja up: viewer a ouvir em http://127.0.0.1:${port} (pid ${process.pid} em data/up.pid; token em data/viewer-token.txt)`);
  // Supervisão mútua (docs/ARCHITECTURE.md §12): só AGORA, com o viewer a ouvir
  // e o up.pid escrito, é que este processo é "o viewer" e pode vigiar a guarda.
  // Um `up` que saiu com a porta ocupada, ou um `forja serve` à mão, nunca chega
  // aqui e nunca vigia nada.
  try {
    const watch = srv.startPeerWatch({ forjaRoot });
    log(watch.enabled
      ? 'forja up: a vigiar a guarda dos runners de 30 em 30 s (relanço-a se morrer; `forja guard stop` manda mais do que eu)'
      : 'forja up: vigia da guarda desligada (FORJA_NO_PEER_WATCH / FORJA_NO_WATCHDOG)');
  } catch (err) { log(`forja up: não consegui arrancar a vigia da guarda (${err && err.message})`); }
  if (noTunnel) { await new Promise(() => {}); return; }

  // ---- tunnel supervision ----
  let currentUrl = null; let announcedUrl = null; let notifyTimer = null;
  const publish = (url, provider) => {
    if (url === currentUrl) return;
    const changed = announcedUrl !== null; // the phone already has a link, and it is dead now
    currentUrl = url;
    const t = { ...buildTunnelJson(url), provider };
    try { writeFileSync(tunnelPath, JSON.stringify(t, null, 2) + '\n'); } catch (err) { log(`forja up: não consegui escrever tunnel.json (${err.message})`); }
    log(`túnel: ${changed ? 'URL nova' : 'URL'} ${t.url} via ${provider} — tunnel.json atualizado; ntfy daqui a ${NOTIFY_GRACE_MS / 1000}s`);
    console.log(`Forja: telemóvel → ${t.mobileUrl}`);
    clearTimeout(notifyTimer); // a URL that changed again before the grace period ended is never announced
    notifyTimer = setTimeout(() => {
      if (stopping || currentUrl !== url) return;
      announcedUrl = url;
      notify(changed ? 'Forja: o link do telemóvel mudou — abre o novo link' : 'Forja: viewer no telemóvel disponível — abre o link',
        { title: 'Forja — telemóvel', click: t.mobileUrl, priority: 'high', tags: ['iphone'], dedup: false })
        .then(r => log(`ntfy: ${r.ok ? 'enviado' : `falhou (${r.error || r.status || r.skipped})`}`));
    }, NOTIFY_GRACE_MS);
  };

  const cmds = tunnelCommands(port);
  let failures = 0; let first = true;
  while (!stopping) {
    if (!first) {
      const wait = failures ? backoffDelay(failures - 1) : BACKOFF_MS[0];
      log(`túnel: a tentar outra vez daqui a ${Math.round(wait / 1000)}s${failures ? ` (${failures} ciclo${failures === 1 ? '' : 's'} sem URL)` : ''}`);
      await sleep(wait);
      if (stopping) break;
    }
    first = false;
    const providers = [];
    if (existsSync(cmds.cloudflared.cmd)) providers.push(['cloudflared', cmds.cloudflared]);
    else log(`túnel: cloudflared não está em ${cmds.cloudflared.cmd} — descarrega-o uma vez de ${CLOUDFLARED_DOWNLOAD_URL} para essa pasta; entretanto uso o fallback ssh (localhost.run)`);
    providers.push(['ssh', cmds.ssh]);
    let gotUrl = false; let lived = 0;
    for (const [name, c] of providers) {
      if (stopping) break;
      log(`túnel: a arrancar ${name}`);
      const r = await runProvider(name, c, { log, urlTimeoutMs: URL_TIMEOUT_MS, track, onUrl: u => publish(u, name) });
      if (stopping) break;
      log(`túnel: ${name} terminou (${r.error ? r.error : `código ${r.code ?? r.signal ?? '?'}`}) ${r.url ? `depois de ${Math.round(r.ms / 1000)}s com URL` : 'sem URL'}`);
      if (r.url) { clearTimeout(notifyTimer); currentUrl = null; dropTunnelJson(); log('túnel: URL morta — tunnel.json apagado, notificação pendente cancelada'); }
      if (r.url) { gotUrl = true; lived = r.ms; break; } // restart the cycle from the first provider
    }
    failures = gotUrl && lived >= HEALTHY_MS ? 0 : failures + 1;
  }
}
