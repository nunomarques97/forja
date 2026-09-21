// lib/up.mjs — the pure parts (no network, no cloudflared, no ssh): URL parsing
// against real provider output captured on 2026-09-16, tunnel.json shape,
// backoff ladder, provider commands, Startup-folder paths and launcher
// contents; `autostart install|remove` through the CLI against a temp APPDATA
// and a temp data dir (never the real Startup folder or data/).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeClick } from '../lib/notify.mjs';
import { parseTunnelUrl, buildTunnelJson, backoffDelay, tunnelCommands, startupPaths, launcherFiles, cloudflaredPath, killTree, killPidTree, planKillTree, parseProcJson, controlPaths, attributeLeftovers, isOurUp, processInfo, BACKOFF_MS, WRAPPER_RETRY_S, WRAPPER_RETRY_BUSY_S } from '../lib/up.mjs';
import { guardStartupPaths } from '../lib/guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'forja.mjs');

// Verbatim shapes from a real run (values shortened): cloudflared on stderr, localhost.run on stdout+stderr.
const CF_BEFORE = `2026-09-16T17:56:31Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment.
2026-09-16T17:56:31Z INF Requesting new quick Tunnel on trycloudflare.com...
`;
const CF_AFTER = `2026-09-16T17:56:36Z INF +--------------------------------------------------------------------------------------------+
2026-09-16T17:56:36Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-09-16T17:56:36Z INF |  https://exciting-sign-function-reaching.trycloudflare.com                                 |
2026-09-16T17:56:36Z INF +--------------------------------------------------------------------------------------------+
2026-09-16T17:56:36Z INF Registered tunnel connection connIndex=0 connection=bc275779 event=0 ip=2606:4700:a8::7 location=mad05 protocol=http2
`;
const LHR_BANNER = `Pseudo-terminal will not be allocated because stdin is not a terminal.
===============================================================================
Welcome to localhost.run!
To set up and manage custom domains go to https://admin.localhost.run/
More details on custom domains at https://localhost.run/docs/custom-domains
To explore using localhost.run visit the documentation site:
https://localhost.run/docs/
===============================================================================
** your connection id is 89.114.17.167:64053, please mention it if you send me a message about an issue. **
`;
const LHR_URL = `authn: authenticated as anonymous user
78d3007819c227.lhr.life tunneled with tls termination, https://78d3007819c227.lhr.life
create an account and add your key for a longer lasting domain name. see https://localhost.run/docs/forever-free/ for more information.
`;

describe('parseTunnelUrl', () => {
  test('cloudflared: the "Requesting new quick Tunnel" line does not match; the boxed URL does', () => {
    assert.equal(parseTunnelUrl(CF_BEFORE), null);
    assert.equal(parseTunnelUrl(CF_BEFORE + CF_AFTER), 'https://exciting-sign-function-reaching.trycloudflare.com');
    assert.equal(parseTunnelUrl(CF_AFTER), 'https://exciting-sign-function-reaching.trycloudflare.com');
  });
  test('cloudflared: a URL split across two chunks is found once the buffer holds it', () => {
    const a = CF_AFTER.slice(0, CF_AFTER.indexOf('https://') + 12); const b = CF_AFTER.slice(a.length);
    assert.equal(parseTunnelUrl(a), null);
    assert.equal(parseTunnelUrl(a + b), 'https://exciting-sign-function-reaching.trycloudflare.com');
  });
  test('localhost.run: banner decoys (admin.localhost.run, localhost.run/docs) are ignored; the lhr.life URL is found', () => {
    assert.equal(parseTunnelUrl(LHR_BANNER), null);
    assert.equal(parseTunnelUrl(LHR_BANNER + LHR_URL), 'https://78d3007819c227.lhr.life');
    assert.equal(parseTunnelUrl('x https://abc123.localhost.run tunneled'), 'https://abc123.localhost.run');
  });
  test('empty or unrelated text → null', () => {
    assert.equal(parseTunnelUrl(''), null); assert.equal(parseTunnelUrl(undefined), null);
    assert.equal(parseTunnelUrl('https://example.com https://trycloudflare.com'), null);
  });
});

describe('buildTunnelJson', () => {
  test('exact shape the viewer reads: url, hostnames, mobileUrl, desktopUrl, since — and no token anywhere (T-SEC-1)', () => {
    const t = buildTunnelJson('https://exciting-sign-function-reaching.trycloudflare.com', '2026-09-16T18:00:00.000Z');
    assert.deepEqual(t, {
      url: 'https://exciting-sign-function-reaching.trycloudflare.com',
      hostnames: ['exciting-sign-function-reaching.trycloudflare.com'],
      mobileUrl: 'https://exciting-sign-function-reaching.trycloudflare.com/m',
      desktopUrl: 'https://exciting-sign-function-reaching.trycloudflare.com/',
      since: '2026-09-16T18:00:00.000Z',
    });
    assert.deepEqual(Object.keys(t), ['url', 'hostnames', 'mobileUrl', 'desktopUrl', 'since']);
    assert.ok(!JSON.stringify(t).includes('k='), 'o ficheiro que alimenta o Click do ntfy não leva token nenhum');
  });
  test('a trailing path on the URL is dropped; since defaults to now (ISO)', () => {
    const t = buildTunnelJson('https://x.lhr.life/');
    assert.equal(t.url, 'https://x.lhr.life'); assert.equal(t.mobileUrl, 'https://x.lhr.life/m');
    assert.ok(Date.now() - Date.parse(t.since) < 5000);
  });
});

// The ntfy topic is public: every Click goes through this before it leaves.
describe('sanitizeClick (lib/notify.mjs)', () => {
  // Lista de permissões, não de proibições: o Click é sempre uma página do
  // viewer, por isso só sobrevivem origem e caminho. Nenhum nome de parâmetro
  // futuro (nem `?K=`, nem `?Token=`) pode levar uma credencial para o tópico.
  test('só origem e caminho sobrevivem: query, fragmento e userinfo caem, seja qual for o nome', () => {
    assert.equal(sanitizeClick('https://x.trycloudflare.com/m?k=abc123'), 'https://x.trycloudflare.com/m');
    assert.equal(sanitizeClick('https://x.trycloudflare.com/m?K=abc123'), 'https://x.trycloudflare.com/m');
    assert.equal(sanitizeClick('https://x.trycloudflare.com/m?Token=abc&ACCESS_TOKEN=d&Key=e'), 'https://x.trycloudflare.com/m');
    assert.equal(sanitizeClick('https://x.trycloudflare.com/m?sessao=abc123#Q1'), 'https://x.trycloudflare.com/m', 'um parâmetro que ninguém previu também cai');
    assert.equal(sanitizeClick('https://user:pass@x.trycloudflare.com/m'), 'https://x.trycloudflare.com/m');
    assert.equal(sanitizeClick('https://user:pass@x.trycloudflare.com/m?K=abc&run=R-1'), 'https://x.trycloudflare.com/m');
    assert.equal(sanitizeClick('https://x.trycloudflare.com/m'), 'https://x.trycloudflare.com/m');
  });
  test('anything that is not an http(s) URL carries no Click at all', () => {
    assert.equal(sanitizeClick(undefined), undefined);
    assert.equal(sanitizeClick(''), undefined);
    assert.equal(sanitizeClick('/m?k=abc'), undefined, 'relativa: sem origem, não é um link para o telemóvel');
    assert.equal(sanitizeClick('javascript:alert(1)'), undefined);
    assert.equal(sanitizeClick('file:///C:/Fixtures/User/forja/data/viewer-token.txt'), undefined);
  });
});

describe('backoff and commands', () => {
  test('ladder 5 s, 15 s, 60 s, then 5 min forever', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 50].map(backoffDelay), [5000, 15000, 60000, 300000, 300000, 300000]);
    assert.deepEqual(BACKOFF_MS, [5000, 15000, 60000, 300000]);
  });
  test('cloudflared quick tunnel and ssh localhost.run commands point at the given port', () => {
    const c = tunnelCommands(4317, { forja: 'C:\\f' });
    assert.equal(c.cloudflared.cmd, cloudflaredPath('C:\\f'));
    assert.match(c.cloudflared.cmd, /tools[\\/]cloudflared[\\/]cloudflared(\.exe)?$/);
    assert.deepEqual(c.cloudflared.args, ['tunnel', '--url', 'http://127.0.0.1:4317', '--no-autoupdate', '--protocol', 'http2']);
    assert.equal(c.ssh.cmd, 'ssh');
    assert.ok(c.ssh.args.includes('StrictHostKeyChecking=accept-new') && c.ssh.args.includes('ServerAliveInterval=30'));
    assert.deepEqual(c.ssh.args.slice(-3), ['-R', '80:127.0.0.1:4317', 'nokey@localhost.run']);
  });
});

describe('startupPaths and launcherFiles', () => {
  test('launcher lives in the APPDATA Startup folder, wrapper in data/autostart', () => {
    const p = startupPaths({ appData: 'C:\\Fixtures\\x\\AppData\\Roaming', data: 'C:\\forja\\data' });
    assert.equal(p.startupDir, join('C:\\Fixtures\\x\\AppData\\Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'));
    assert.equal(p.launcher, join(p.startupDir, 'forja-up.vbs'));
    assert.equal(p.wrapper, join('C:\\forja\\data', 'autostart', 'forja-up.cmd'));
    assert.equal(p.consoleLog, join('C:\\forja\\data', 'up.console.log'));
    assert.equal(p.pid, join('C:\\forja\\data', 'up.pid')); assert.equal(p.stop, join('C:\\forja\\data', 'up.stop'));
    assert.deepEqual(controlPaths('C:\\d'), { pid: join('C:\\d', 'up.pid'), stop: join('C:\\d', 'up.stop'), tunnel: join('C:\\d', 'tunnel.json') });
    assert.throws(() => startupPaths({ appData: '', data: 'x' }), /APPDATA/);
  });
  test('the .cmd references node, <forja>\\bin\\forja.mjs up, cds into the forja repo, loops on error; the .vbs runs it with window style 0', () => {
    const p = startupPaths({ appData: 'C:\\Fixtures\\x\\AppData\\Roaming', data: 'C:\\forja\\data' });
    const files = launcherFiles(p, { forja: 'C:\\forja', node: 'C:\\nodejs\\node.exe' });
    const cmd = files[p.wrapper]; const vbs = files[p.launcher];
    assert.ok(cmd.includes('cd /d "C:\\forja"'));
    assert.ok(cmd.includes('"C:\\nodejs\\node.exe" "C:\\forja\\bin\\forja.mjs" up >> "C:\\forja\\data\\up.console.log" 2>&1'));
    assert.ok(cmd.includes(':loop') && cmd.includes('goto loop') && cmd.includes('if %FORJA_CODE% EQU 0 goto end'));
    assert.ok(cmd.includes(`else ("C:\\nodejs\\node.exe" -e "setTimeout(function(){}, ${WRAPPER_RETRY_S * 1000})")`), '30 s after an error');
    assert.ok(cmd.includes(`if %FORJA_CODE% EQU 3 ("C:\\nodejs\\node.exe" -e "setTimeout(function(){}, ${WRAPPER_RETRY_BUSY_S * 1000})")`), '120 s after exit 3');
    assert.ok(cmd.includes('if exist "C:\\forja\\data\\up.stop" del /q "C:\\forja\\data\\up.stop"'), 'a fresh start clears an old stop file');
    assert.equal((cmd.match(/if exist "C:\\forja\\data\\up\.stop" goto end/g) || []).length, 2, 'stop file checked before and after the wait');
    assert.ok(cmd.includes('\r\n'), 'CRLF for cmd.exe');
    assert.ok(vbs.includes('CreateObject("WScript.Shell")'));
    assert.ok(vbs.includes(`sh.Run "cmd.exe /c ""${p.wrapper}""", 0, False`));
    assert.equal(Object.keys(files).length, 2);
  });
});

describe('autostart install/remove via the CLI (temp APPDATA + temp data dir)', () => {
  const root = mkdtempSync(join(tmpdir(), 'forja-autostart-'));
  const appData = join(root, 'Roaming'); const data = join(root, 'data');
  const env = { ...process.env, APPDATA: appData, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9' };
  const forja = (...args) => { const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
  after(() => rmSync(root, { recursive: true, force: true }));

  // Four files since the guarda dos runners exists (lib/guard.mjs, §12): the
  // pair for `up` and the pair for `guard`, two independent loops. The guard's
  // own contents are tested in test/guard.test.mjs; here only the pair is.
  test('install writes the four files (JSON lists them), second install is unchanged, remove deletes, second remove finds nothing', () => {
    const p = startupPaths({ appData, data });
    const g = guardStartupPaths({ appData, data });
    const all = [p.launcher, p.wrapper, g.launcher, g.wrapper].sort();
    const r1 = forja('autostart', 'install');
    assert.equal(r1.code, 0, r1.err); assert.equal(r1.json.ok, true); assert.equal(r1.json.action, 'install');
    assert.deepEqual(r1.json.written.sort(), all); assert.deepEqual(r1.json.unchanged, []);
    for (const f of all) assert.ok(existsSync(f), f);
    const cmd = readFileSync(p.wrapper, 'utf8');
    assert.ok(cmd.includes(`"${process.execPath}" "${join(here, '..', 'bin', 'forja.mjs')}" up`), 'wrapper runs the real bin/forja.mjs with the running node');
    assert.ok(readFileSync(p.launcher, 'utf8').includes(p.wrapper));
    const r2 = forja('autostart', 'install');
    assert.equal(r2.code, 0); assert.deepEqual(r2.json.written, []); assert.deepEqual(r2.json.unchanged.sort(), all);
    const r3 = forja('autostart', 'remove');
    assert.equal(r3.code, 0); assert.deepEqual(r3.json.removed.sort(), all);
    assert.ok(existsSync(r3.json.guardStopFile), 'a guarda é mandada parar, nunca morta');
    for (const f of all) assert.equal(existsSync(f), false, f);
    const r4 = forja('autostart', 'remove');
    assert.equal(r4.code, 0); assert.deepEqual(r4.json.removed, []); assert.deepEqual(r4.json.missing.sort(), all);
  });
  test('unknown action → usage error, non-zero', () => {
    const r = forja('autostart', 'bogus');
    assert.notEqual(r.code, 0); assert.match(r.err, /install\|remove/);
  });
});

describe('killTree (Windows: the child tree dies, live runners in it do not)', () => {
  test('kills the whole tree: the child node and the grandchild node it started are both gone', async () => {
    const child = spawn(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)'], { stdio: 'ignore' }); setTimeout(function(){}, 60000)"], { stdio: 'ignore', windowsHide: true });
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await sleep(1500);
    const grand = () => spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid} AND Name='node.exe'").ProcessId`], { encoding: 'utf8' }).stdout.trim();
    const gpid = grand();
    assert.match(gpid, /^\d+$/, 'the child started a node grandchild');
    killTree(child);
    await sleep(800);
    const alive = pid => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout.includes(` ${pid} `);
    assert.equal(alive(String(child.pid)), false, 'child gone');
    assert.equal(alive(gpid), false, 'grandchild gone');
  });

  // The 17 set 2026 incident: a `down` that killed the viewer's tree killed two
  // live runners with it. A run is never collateral damage of stopping the viewer.
  test('spares a live runner: a process with `forja.mjs runner` on its command line survives the kill', async () => {
    const fake = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)', 'C:\\naoexiste\\forja\\bin\\forja.mjs', 'runner', '--goal', 'x'], { stdio: 'ignore', windowsHide: true });
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const alive = pid => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout.includes(` ${pid} `);
    await sleep(1200);
    try {
      assert.equal(alive(String(fake.pid)), true, 'o runner falso arrancou');
      const r = killTree(fake);
      await sleep(800);
      assert.equal(alive(String(fake.pid)), true, 'o runner continua vivo depois do killTree');
      assert.deepEqual(r.spared, [fake.pid], 'e a chamada diz que o poupou');
    } finally { spawnSync('taskkill', ['/PID', String(fake.pid), '/T', '/F'], { encoding: 'utf8' }); }
  });

  // Without the enumeration there is no way to tell a runner from a viewer, so
  // the old blind `taskkill /T` — the kill that took two runs down — is never
  // the fallback: only the root dies, and the note says the children are alive.
  test('enumeration failed: only the root is stopped, children stay alive and it is written down', async () => {
    // `detached` como um filho que é para sobreviver ao pai (um runner, o túnel):
    // um filho normal morre com o pai pelo Job object do Windows, diga o plano o
    // que disser, e o que está a ser testado aqui é o `/T`.
    const child = "require('node:child_process').spawn(process.execPath,['-e','setTimeout(function(){},60000)'],{stdio:'ignore',windowsHide:true,detached:true}).unref();setTimeout(function(){},60000)";
    const proc = spawn(process.execPath, ['-e', child], { stdio: 'ignore', windowsHide: true });
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const alive = pid => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout.includes(` ${pid} `);
    await sleep(1500);
    const grand = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${proc.pid} AND Name='node.exe'").ProcessId`], { encoding: 'utf8' }).stdout.trim();
    assert.match(grand, /^\d+$/);
    try {
      const r = killPidTree(proc.pid, () => [], () => null); // enumeração vazia e sem resposta sobre o pid
      await sleep(800);
      assert.deepEqual(r.notes, ['enumeração de processos falhou — só o processo raiz foi parado; filhos ficam vivos']);
      assert.equal(r.ok, true); assert.deepEqual(r.spared, []);
      assert.equal(alive(String(proc.pid)), false, 'a raiz foi parada');
      assert.equal(alive(grand), true, 'o filho ficou vivo — nada de `/T` às cegas');
    } finally { spawnSync('taskkill', ['/PID', grand, '/T', '/F'], { encoding: 'utf8' }); killTree(proc); }
  });

  test('enumeration failed and the root itself is a runner: nothing is killed at all', async () => {
    const fake = spawn(process.execPath, ['-e', 'setTimeout(function(){},60000)', 'C:\\naoexiste\\forja\\bin\\forja.mjs', 'runner'], { stdio: 'ignore', windowsHide: true });
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const alive = pid => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout.includes(` ${pid} `);
    await sleep(1200);
    try {
      const r = killPidTree(fake.pid, () => []); // enumeração vazia, processInfo real
      await sleep(600);
      assert.deepEqual(r.spared, [fake.pid]); assert.deepEqual(r.notes, []);
      assert.equal(alive(String(fake.pid)), true);
    } finally { spawnSync('taskkill', ['/PID', String(fake.pid), '/T', '/F'], { encoding: 'utf8' }); }
  });
});

// Verbatim shape of the failure this cost us: PowerShell writes the console
// codepage to the pipe, so a live `claude -p` whose prompt carries "→" or "§"
// (every Forja session) lands in the enumeration as a raw 0x1A. JSON.parse threw,
// the list came back empty, and `down` killed the very runners it had to spare.
describe('parseProcJson (pure)', () => {
  test('a raw control character in one command line costs that field, never the whole list', () => {
    const text = `[{"ProcessId":100,"ParentProcessId":1,"Name":"node.exe","CommandLine":"node forja.mjs runner --goal capability \u001a choice"},{"ProcessId":200,"ParentProcessId":100,"Name":"node.exe","CommandLine":"claude -p"}]`;
    assert.throws(() => JSON.parse(text), SyntaxError, 'é mesmo JSON inválido');
    const procs = parseProcJson(text);
    assert.deepEqual(procs.map(p => p.ProcessId), [100, 200]);
    assert.equal(planKillTree(100, procs).spared.length, 1, 'e o runner continua a ser reconhecido');
  });
  test('one object, empty output and garbage all come back as an array', () => {
    assert.deepEqual(parseProcJson('{"ProcessId":7}'), [{ ProcessId: 7 }]);
    assert.deepEqual(parseProcJson(''), []);
    assert.deepEqual(parseProcJson('null'), []);
    assert.deepEqual(parseProcJson('não é json'), []);
  });
});

describe('planKillTree (pure)', () => {
  const procs = [
    { ProcessId: 100, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node C:\\f\\bin\\forja.mjs up' },
    { ProcessId: 200, ParentProcessId: 100, Name: 'node.exe', CommandLine: 'node C:\\f\\viewer\\server.mjs' },
    { ProcessId: 300, ParentProcessId: 100, Name: 'cloudflared.exe', CommandLine: 'cloudflared tunnel --url http://127.0.0.1:4317' },
    { ProcessId: 400, ParentProcessId: 200, Name: 'node.exe', CommandLine: 'node "C:/f/bin/forja.mjs" runner --goal fazer algo' },
    { ProcessId: 500, ParentProcessId: 400, Name: 'node.exe', CommandLine: 'claude -p --model opus' },
    { ProcessId: 600, ParentProcessId: 1, Name: 'node.exe', CommandLine: 'node C:\\f\\bin\\forja.mjs runner' },
  ];
  test('the tree dies children-first, the runner and everything under it is spared', () => {
    const r = planKillTree(100, procs);
    assert.deepEqual(r.spared, [400], 'o runner é poupado');
    assert.deepEqual(r.kill, [200, 300, 100], 'filhos antes dos pais, e sem a sessão claude do runner');
    assert.equal(r.kill.includes(500), false, 'o que está debaixo do runner também não é tocado');
    assert.equal(r.kill.includes(600), false, 'um runner de outra árvore nem entra no plano');
  });
  test('a runner as the root spares everything; an unknown pid is a plan of one', () => {
    assert.deepEqual(planKillTree(400, procs), { kill: [], spared: [400] });
    assert.deepEqual(planKillTree(999, procs), { kill: [999], spared: [] }, 'sem informação (enumeração falhada) mata-se só o pid pedido');
  });
  test('a "child" older than its parent is a reused pid, not a child: it and its subtree leave the plan', () => {
    const recycled = [
      { ProcessId: 100, ParentProcessId: 1, CommandLine: 'node forja.mjs up', CreationDate: '/Date(1789545493919)/' },
      { ProcessId: 200, ParentProcessId: 100, CommandLine: 'node viewer/server.mjs', CreationDate: '/Date(1789545494000)/' },
      { ProcessId: 300, ParentProcessId: 100, CommandLine: 'explorer.exe', CreationDate: '/Date(1789540000000)/' }, // nasceu antes do pai: o pid 100 é reciclado
      { ProcessId: 400, ParentProcessId: 300, CommandLine: 'notepad.exe', CreationDate: '/Date(1789541000000)/' },
      { ProcessId: 500, ParentProcessId: 100, CommandLine: 'cloudflared tunnel', CreationDate: null }, // sem data: fica no plano (não se inventa)
    ];
    const r = planKillTree(100, recycled);
    assert.deepEqual(r.kill, [200, 500, 100]);
    assert.equal(r.kill.includes(300) || r.kill.includes(400), false, 'o estranho e o que está por baixo dele não são tocados');
  });
  test('a cycle in ParentProcessId (a reused pid) does not hang the walk', () => {
    const cycle = [
      { ProcessId: 10, ParentProcessId: 20, Name: 'node.exe', CommandLine: 'node a' },
      { ProcessId: 20, ParentProcessId: 10, Name: 'node.exe', CommandLine: 'node b' },
    ];
    assert.deepEqual(planKillTree(10, cycle), { kill: [20, 10], spared: [] });
  });
});

describe('attributeLeftovers (pure)', () => {
  test('cloudflared from our tools folder is ours; the same binary elsewhere, or another ssh, is reported not killed', () => {
    const forja = 'C:\\f';
    const procs = [
      { ProcessId: 11, Name: 'cloudflared.exe', ExecutablePath: 'C:\\f\\tools\\cloudflared\\cloudflared.exe', CommandLine: 'cloudflared tunnel --url http://127.0.0.1:4317' },
      { ProcessId: 12, Name: 'cloudflared.exe', ExecutablePath: 'C:\\Program Files\\cloudflared\\cloudflared.exe', CommandLine: 'cloudflared tunnel run corp' },
      { ProcessId: 13, Name: 'cloudflared.exe', ExecutablePath: 'c:/F/TOOLS/cloudflared/CLOUDFLARED.EXE', CommandLine: '' },
    ];
    const r = attributeLeftovers('cloudflared', procs, { forja });
    assert.deepEqual(r.ours.map(p => p.pid), [11, 13]); assert.deepEqual(r.others.map(p => p.pid), [12]);
    const ssh = attributeLeftovers('ssh', [{ ProcessId: 21, Name: 'ssh.exe', CommandLine: 'ssh -R 80:127.0.0.1:4317 nokey@localhost.run' }, { ProcessId: 22, Name: 'ssh.exe', CommandLine: 'ssh me@myserver' }], { forja });
    assert.deepEqual(ssh.ours.map(p => p.pid), [21]); assert.deepEqual(ssh.others.map(p => p.pid), [22]);
    assert.deepEqual(attributeLeftovers('other', procs, { forja }).ours, []);
  });
});

describe('isOurUp (pure)', () => {
  test('only node.exe running <forja>/bin/forja.mjs up (either slash style, quoted or not) is ours', () => {
    const forja = 'C:\\Fixtures\\x\\forja';
    assert.equal(isOurUp({ Name: 'node.exe', CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Fixtures\\x\\forja\\bin\\forja.mjs" up --port 4317' }, { forja }), true);
    assert.equal(isOurUp({ Name: 'node.exe', CommandLine: 'node C:/Fixtures/x/forja/bin/forja.mjs up' }, { forja }), true);
    assert.equal(isOurUp({ Name: 'node.exe', CommandLine: 'node C:/fixtures/X/FORJA/bin/forja.mjs up --no-tunnel' }, { forja }), true);
    assert.equal(isOurUp({ Name: 'node.exe', CommandLine: 'node C:/Fixtures/x/forja/bin/forja.mjs serve' }, { forja }), false, 'serve is not up');
    assert.equal(isOurUp({ Name: 'node.exe', CommandLine: 'node C:/Fixtures/x/forja/bin/forja.mjs update' }, { forja }), false, 'prefix match is not up');
    assert.equal(isOurUp({ Name: 'node.exe', CommandLine: 'node C:/Fixtures/y/other/bin/forja.mjs up' }, { forja }), false, 'another repo');
    assert.equal(isOurUp({ Name: 'node.exe', CommandLine: 'node -e "setTimeout(function(){},60000)"' }, { forja }), false);
    assert.equal(isOurUp({ Name: 'cmd.exe', CommandLine: 'cmd /c node C:/Fixtures/x/forja/bin/forja.mjs up' }, { forja }), false, 'not node.exe');
    assert.equal(isOurUp(null, { forja }), false);
    // relative command line (the Sponsor's own `node bin\\forja.mjs up`): only a matching creation date attributes it
    const rel = { Name: 'node.exe', CommandLine: '"C:\\Program Files\\nodejs\\node.exe" bin/forja.mjs up --port 4317', CreationDate: '/Date(1758043143861)/' };
    assert.equal(isOurUp(rel, { forja }), false);
    assert.equal(isOurUp(rel, { forja, created: '/Date(1758043143861)/' }), true);
    assert.equal(isOurUp(rel, { forja, created: '/Date(1758043199999)/' }), false, 'same pid, different creation time = reused pid');
    assert.equal(isOurUp({ ...rel, Name: 'cmd.exe' }, { forja, created: '/Date(1758043143861)/' }), false);
  });
});

describe('down and the pid/stop protocol (CLI, temp data dir, --no-tunnel, no network)', () => {
  const root = mkdtempSync(join(tmpdir(), 'forja-down-'));
  const data = join(root, 'data'); mkdirSync(data);
  const env = { ...process.env, FORJA_DATA_DIR: data, FORJA_NTFY_SERVER: 'http://127.0.0.1:9', FORJA_NO_WATCHDOG: '1', APPDATA: join(root, 'Roaming') };
  const forja = (...args) => { const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
  const c = controlPaths(data);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const alive = pid => spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout.includes(` ${pid} `);
  after(() => rmSync(root, { recursive: true, force: true }));

  test('down with nothing running: ok, killed [], writes up.stop, says so', () => {
    const r = forja('down');
    assert.equal(r.code, 0, r.err); assert.equal(r.json.ok, true); assert.deepEqual(r.json.killed, []);
    assert.ok(existsSync(c.stop)); assert.match(r.json.note, /não havia nada a correr/); assert.ok(r.json.notes.some(n => /sem data\/up\.pid/.test(n)));
  });
  test('down with a stale up.pid and a tunnel.json: no kill, stale reported, files removed', () => {
    writeFileSync(c.pid, '4000000\n'); writeFileSync(c.tunnel, JSON.stringify({ url: 'https://x.trycloudflare.com', provider: 'none' }));
    const r = forja('down');
    assert.equal(r.code, 0, r.err); assert.deepEqual(r.json.killed, []);
    assert.ok(r.json.notes.some(n => /4000000, que já não existe/.test(n)));
    assert.ok(!existsSync(c.pid) && !existsSync(c.tunnel)); assert.deepEqual(r.json.removed, [c.tunnel]);
  });
  test('up.pid holding the pid of a live process that is not our up (pid reuse): not killed, reported under unattributed, up.pid removed', async () => {
    const stranger = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 60000)'], { stdio: 'ignore', windowsHide: true });
    await sleep(500);
    writeFileSync(c.pid, `${stranger.pid}\n`);
    try {
      const r = forja('down');
      assert.equal(r.code, 0, r.err); assert.deepEqual(r.json.killed, []);
      const entry = (r.json.unattributed || []).find(u => u.pid === stranger.pid); // other entries may exist when unrelated forja processes run on the machine
      assert.ok(entry, 'the stranger is listed'); assert.match(entry.why, /pid reutilizado ou processo alheio/);
      assert.equal(alive(String(stranger.pid)), true, 'the stranger is still alive');
      assert.ok(!existsSync(c.pid), 'the stale up.pid is removed');
      // same pid but a wrong creation date on the second line: still a stranger
      writeFileSync(c.pid, `${stranger.pid}\n/Date(1)/\n`);
      const r2 = forja('down');
      assert.deepEqual(r2.json.killed, []); assert.ok((r2.json.unattributed || []).some(u => u.pid === stranger.pid)); assert.equal(alive(String(stranger.pid)), true);
    } finally { killTree(stranger); }
  });
  test('a live process whose creation date matches the up.pid record is the recorded process: killed even with a relative command line', async () => {
    const proc = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 60000)'], { stdio: 'ignore', windowsHide: true });
    await sleep(500);
    try {
      const info = processInfo(proc.pid);
      writeFileSync(c.pid, `${proc.pid}\n${info.CreationDate}\n`);
      const r = forja('down');
      assert.equal(r.code, 0, r.err); assert.deepEqual(r.json.killed, [proc.pid]);
      assert.equal(alive(String(proc.pid)), false);
    } finally { killTree(proc); }
  });
  // The incident of 17 set 2026: `down` stopped the viewer and took the two runs
  // started from the phone with it. A run is never collateral damage of a `down`.
  test('a `forja.mjs runner` inside the tree survives the down, which says «poupados: N runners»', async () => {
    // `detached` like a real runner: on Windows libuv puts a non-detached child
    // in the parent's Job object, and it would die with the parent whatever the
    // kill plan says (that is the other half of the same incident).
    const child = "require('node:child_process').spawn(process.execPath,['-e','setTimeout(function(){},60000)','C:\\\\naoexiste\\\\bin\\\\forja.mjs','runner','--goal','x'],{stdio:'ignore',windowsHide:true,detached:true}).unref();setTimeout(function(){},60000)";
    const proc = spawn(process.execPath, ['-e', child], { stdio: 'ignore', windowsHide: true }); // stands in for `up`: a tree with a runner in it
    await sleep(1500);
    const runnerPid = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${proc.pid} AND Name='node.exe'").ProcessId`], { encoding: 'utf8' }).stdout.trim();
    assert.match(runnerPid, /^\d+$/, 'o runner falso arrancou dentro da árvore');
    try {
      writeFileSync(c.pid, `${proc.pid}\n${processInfo(proc.pid).CreationDate}\n`);
      const r = forja('down');
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(r.json.killed, [proc.pid], 'o "up" morreu');
      assert.equal(alive(String(proc.pid)), false);
      assert.equal(alive(runnerPid), true, 'o runner que estava na árvore continua vivo');
      assert.equal(r.json.sparedRunners, 1);
      assert.ok((r.json.notes || []).some(n => /^poupados: 1 runner\b/.test(n)), `notas: ${JSON.stringify(r.json.notes)}`);
    } finally { spawnSync('taskkill', ['/PID', String(runnerPid), '/T', '/F'], { encoding: 'utf8' }); killTree(proc); }
  });
  test('up --no-tunnel writes up.pid (its own pid), deletes a stale up.stop; a second up exits 3 on stderr; down kills it, removes up.pid + tunnel.json, leaves up.stop; autostart remove reports killed', async () => {
    writeFileSync(c.stop, 'old\n');
    const port = 44200 + Math.floor(Math.random() * 300);
    const child = spawn(process.execPath, [cli, 'up', '--port', String(port), '--no-tunnel'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let outText = ''; child.stdout.on('data', d => { outText += d; }); child.stderr.on('data', d => { outText += d; });
    try {
    // poll (≤ 10 s) for a complete up.pid: pid line + CreationDate line — never a fixed sleep
    const readPidFile = () => { try { return readFileSync(c.pid, 'utf8').split('\n'); } catch { return []; } };
    for (let i = 0; i < 100 && !/^\/Date\(\d+\)\/$/.test((readPidFile()[1] || '').trim()); i++) await sleep(100);
    assert.ok(outText.includes('Forja viewer'), outText);
    const [pidLine, createdLine] = readPidFile();
    assert.equal(pidLine.trim(), String(child.pid), 'up.pid first line is the up process');
    assert.match(createdLine.trim(), /^\/Date\(\d+\)\/$/, 'second line is its CreationDate');
    assert.equal(createdLine.trim(), String(processInfo(child.pid).CreationDate));
    assert.ok(!existsSync(c.stop), 'stale up.stop deleted at start');
    assert.match(readFileSync(join(data, 'up.log'), 'utf8'), /up\.stop antigo apagado/);
    writeFileSync(c.tunnel, JSON.stringify({ url: 'https://dead.trycloudflare.com', provider: 'none' })); // simulate a stale link file
    const busy = forja('up', '--port', String(port), '--no-tunnel');
    assert.equal(busy.code, 3); assert.match(busy.err, /porta \d+ ocupada/); assert.equal(readFileSync(c.pid, 'utf8').split('\n')[0].trim(), String(child.pid), 'the busy instance left the owner pid file alone');
    assert.ok(existsSync(c.tunnel), "the busy instance must not delete the owner's tunnel.json");
    const exited = new Promise(r => child.on('exit', r));
    const r = forja('down');
    assert.equal(r.code, 0, r.err); assert.deepEqual(r.json.killed, [child.pid]);
    assert.deepEqual(r.json.removed, [c.tunnel], "tunnel.json removed by the owner's down, and only then");
    await exited;
    assert.equal(alive(String(child.pid)), false);
    assert.ok(!existsSync(c.pid) && !existsSync(c.tunnel) && existsSync(c.stop));
    const rm = forja('autostart', 'remove');
    assert.equal(rm.code, 0, rm.err); assert.deepEqual(rm.json.killed, []); assert.ok(!/Ctrl\+C/.test(rm.json.note)); assert.match(rm.json.note, /parados agora/);
    } finally { killTree(child); } // a failed assertion must never leave `up` (and its pipes) alive
  });
  test('down without up.pid never kills a `forja up` by command line: a live up of ANOTHER data dir is only listed', async () => {
    const other = mkdtempSync(join(tmpdir(), 'forja-other-data-'));
    const port = 44500 + Math.floor(Math.random() * 300);
    const child = spawn(process.execPath, [cli, 'up', '--port', String(port), '--no-tunnel'], { env: { ...env, FORJA_DATA_DIR: other }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    try {
      for (let i = 0; i < 100 && !existsSync(join(other, 'up.pid')); i++) await sleep(100);
      assert.ok(existsSync(join(other, 'up.pid')), 'the other up is listening');
      rmSync(c.pid, { force: true });
      const r = forja('down'); // our data dir has no up.pid
      assert.equal(r.code, 0, r.err); assert.deepEqual(r.json.killed, []);
      const listed = (r.json.unattributed || []).find(u => u.pid === child.pid);
      assert.ok(listed, 'listed as a candidate'); assert.equal(listed.why, 'sem up.pid — mata à mão se for este');
      assert.equal(alive(String(child.pid)), true, 'still alive');
    } finally { killTree(child); rmSync(other, { recursive: true, force: true }); }
  });
});
