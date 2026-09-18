#!/usr/bin/env node
// Forja screenshot helper: drives the local Chrome headless over the DevTools
// protocol and writes a PNG of a URL. Node core only (uses the global
// WebSocket of Node 22+). Used by forja-visual-check (Frontend Dev, Backend Dev,
// Reviewer, Product Designer, QA) so "verified visually" always means a real rendered page.
//
//   node tools/shot.mjs <url> <out.png> [--width 1440] [--height 1000] [--mobile]
//        [--wait 1200] [--full] [--eval "<js>"] [--no-reduced-motion] [--chrome <path>]
//
// --mobile sets a phone device scale factor and a touch/mobile viewport.
// --eval runs JavaScript in the page before the shot (e.g. click a tab).
// --no-reduced-motion forces prefers-reduced-motion: no-preference (Chrome
// headless reports `reduce` by default, which hides motion under test).
// Exit code 0 on success, 1 on any failure (message on stderr).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const opts = { width: 1440, height: 1000, wait: 1200, full: false, mobile: false, eval: null, reducedMotion: true, chrome: null };
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--width') opts.width = Number(args[++i]);
  else if (a === '--height') opts.height = Number(args[++i]);
  else if (a === '--wait') opts.wait = Number(args[++i]);
  else if (a === '--full') opts.full = true;
  else if (a === '--mobile') opts.mobile = true;
  else if (a === '--eval') opts.eval = args[++i];
  else if (a === '--no-reduced-motion') opts.reducedMotion = false;
  else if (a === '--chrome') opts.chrome = args[++i];
  else positional.push(a);
}
const [url, out] = positional;
if (!url || !out) {
  console.error('usage: node tools/shot.mjs <url> <out.png> [--width N] [--height N] [--mobile] [--wait ms] [--full] [--eval js] [--no-reduced-motion]');
  process.exit(1);
}

function findChrome() {
  const candidates = [
    opts.chrome,
    process.env.FORJA_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : null,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find(p => existsSync(p));
}

async function main() {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome not found; pass --chrome <path> or set FORJA_CHROME');
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = resolve(tmpdir(), `forja-shot-${process.pid}-${port}`);
  const proc = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`, `--window-size=${opts.width},${opts.height}`, 'about:blank',
  ], { stdio: 'ignore' });
  try {
    // Wait for the DevTools endpoint.
    let targets = null;
    for (let i = 0; i < 60 && !targets; i++) {
      await sleep(150);
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch {}
    }
    if (!targets) throw new Error('Chrome DevTools endpoint did not come up');
    const page = targets.find(t => t.type === 'page') || targets[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket error')); });
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = m => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); }
      else if (msg.method) events.push(msg);
    };
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: opts.width, height: opts.height, deviceScaleFactor: opts.mobile ? 2 : 1, mobile: opts.mobile,
    });
    if (opts.mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    if (!opts.reducedMotion) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await send('Page.navigate', { url });
    // Wait for load (or bail after 15 s) then the settle time.
    for (let i = 0; i < 100; i++) {
      if (events.some(e => e.method === 'Page.loadEventFired')) break;
      await sleep(150);
    }
    if (opts.eval) {
      const r = await send('Runtime.evaluate', { expression: opts.eval, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('--eval failed: ' + JSON.stringify(r.exceptionDetails));
    }
    await sleep(opts.wait);
    let clip;
    if (opts.full) {
      const m = await send('Page.getLayoutMetrics');
      const h = Math.ceil(m.cssContentSize ? m.cssContentSize.height : m.contentSize.height);
      await send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: h, deviceScaleFactor: opts.mobile ? 2 : 1, mobile: opts.mobile });
      clip = { x: 0, y: 0, width: opts.width, height: h, scale: 1 };
    }
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: opts.full, ...(clip ? { clip } : {}) });
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), Buffer.from(shot.data, 'base64'));
    // Report page errors so a broken page never passes as "verified".
    const errors = events.filter(e => e.method === 'Runtime.exceptionThrown').map(e => e.params.exceptionDetails.text + ' ' + (e.params.exceptionDetails.exception?.description || '')).slice(0, 5);
    console.log(JSON.stringify({ ok: true, out: resolve(out), width: opts.width, height: clip ? clip.height : opts.height, pageErrors: errors }));
    ws.close();
  } finally {
    proc.kill();
    // Best-effort profile cleanup.
    await sleep(200);
    try { const { rmSync } = await import('node:fs'); rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => { console.error(String(err && err.message || err)); process.exit(1); });
