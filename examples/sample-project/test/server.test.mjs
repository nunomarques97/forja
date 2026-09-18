// Process-level tests for server.mjs (recipe from docs/forja/TASKS.json T7): a real child process,
// spawned with `child_process.spawn(process.execPath, ['server.mjs'], …)` over a clean environment
// (no GREET_TOKEN; PATH/SystemRoot/TEMP and friends kept so Node itself still works on Windows), and
// GREET_TOKEN_FILE pointing at a path that does not exist inside a temp folder, so nothing here ever
// depends on a real token.local.txt at the project root. Nothing here reads GREET_TOKEN either, so
// `npm test` passes with no token anywhere in the environment and no server already listening.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lanAddresses } from '../lib/lan.mjs';

const ROOT = path.join(import.meta.dirname, '..');

// A made-up token, 32 characters, used nowhere else: a fixture, not a credential.
const TOKEN = 'server-mjs-teste-'.padEnd(32, '0');
assert.equal(TOKEN.length, 32, 'a fixture do teste tem de ter exatamente 32 caracteres');

// Only the environment a Node process needs to run on Windows (and PATH on any OS) survives;
// everything else, including any GREET_* the real shell might have set, is left out on purpose.
const KEEP_ENV = [
  'PATH',
  'Path',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'ComSpec',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];
const BASE_ENV = {};
for (const key of KEEP_ENV) {
  if (typeof process.env[key] === 'string') BASE_ENV[key] = process.env[key];
}

let tmpRoot;
const children = []; // every child this file started, so after() can make sure none survives

before(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'server-test-'));
});

after(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once('exit', resolve));
    }
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

/** Spawns server.mjs, waits for it to exit and collects stdout/stderr as text. */
function runToExit(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: { ...BASE_ENV, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Spawns server.mjs and resolves once its stdout announces the address it is listening on.
 * The child is left running — the caller (or `after()`) is responsible for killing it.
 */
function startAndWaitForAddress(extraEnv, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: { ...BASE_ENV, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`server.mjs não anunciou o endereço a tempo. stderr: ${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = stdout.match(/http:\/\/([\w.-]+):(\d+)\//);
      // Wait for the whole announcement (address + how to stop), not just the first line that
      // arrives — the three stdout.write calls in server.mjs can land in separate chunks.
      if (match && /Ctrl\+C/.test(stdout)) {
        clearTimeout(timer);
        resolve({ child, host: match[1], port: Number(match[2]), stdout: () => stdout, stderr: () => stderr });
      }
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server.mjs saiu antes de anunciar o endereço (code ${code}). stderr: ${stderr}`));
    });
  });
}

// --- sem token ---------------------------------------------------------------------------------

test('sem token -> sai com 1, stderr em português, sem stack trace nem "Error:"', async () => {
  const tokenFile = path.join(tmpRoot, 'nao-existe', 'token.local.txt');

  const { code, stdout, stderr } = await runToExit({
    GREET_TOKEN_FILE: tokenFile,
    GREET_PORT: '0',
  });

  assert.equal(code, 1);
  assert.match(stderr, /Passo seguinte/, 'a frase tem de dizer o passo seguinte');
  assert.match(stderr, /token.local.txt/);
  // Stack-trace lines look like "\n    at Something (file:line:col)" — a literal " at " can appear
  // legitimately inside a Portuguese sentence, so the check targets that exact shape.
  assert.ok(!/\n\s*at\s/.test(stderr), `stderr não pode ter stack trace: ${stderr}`);
  assert.ok(!stderr.includes('Error:'), `stderr não pode ter "Error:": ${stderr}`);
  assert.equal(stdout, '', 'nada deve ir para o stdout quando o arranque falha');
});

// --- arranque com sucesso ------------------------------------------------------------------------

test('com token e GREET_PORT=0 -> stdout anuncia http://127.0.0.1:<porta>, /entrar responde e /historico exige token', async () => {
  const dataDir = await mkdtemp(path.join(tmpRoot, 'data-'));
  const dataFile = path.join(dataDir, 'greetings.json');
  const tokenFile = path.join(tmpRoot, 'tambem-nao-existe', 'token.local.txt');

  const { child, host, port, stdout } = await startAndWaitForAddress({
    GREET_TOKEN: TOKEN,
    GREET_TOKEN_FILE: tokenFile,
    GREET_PORT: '0',
    GREET_HOST: '127.0.0.1',
    GREET_DATA: dataFile,
  });

  assert.equal(host, '127.0.0.1');
  assert.match(stdout(), /http:\/\/127\.0\.0\.1:\d+\//);
  assert.match(stdout(), /Ctrl\+C/);
  assert.ok(!stdout().includes(TOKEN), 'o stdout nunca pode conter o token');

  const base = `http://127.0.0.1:${port}`;

  const entrar = await fetch(`${base}/entrar`);
  assert.equal(entrar.status, 200);
  const entrarBody = await entrar.text();
  assert.ok(!entrarBody.includes(TOKEN));

  const historico = await fetch(`${base}/historico`, { redirect: 'manual' });
  assert.equal(historico.status, 401);

  const comToken = await fetch(`${base}/historico`, {
    headers: { 'X-Greet-Token': TOKEN },
    redirect: 'manual',
  });
  assert.equal(comToken.status, 200);

  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
});

// --- ficheiro de dados ilegível ------------------------------------------------------------------

test('GREET_DATA com JSON inválido -> sai com 1 e o ficheiro fica byte a byte igual', async () => {
  const dataDir = await mkdtemp(path.join(tmpRoot, 'data-mau-'));
  const dataFile = path.join(dataDir, 'greetings.json');
  const conteudo = '{ isto não é uma lista de saudações';
  await writeFile(dataFile, conteudo, 'utf8');
  const antes = await readFile(dataFile);

  const tokenFile = path.join(tmpRoot, 'ainda-nao-existe', 'token.local.txt');
  const { code, stdout, stderr } = await runToExit({
    GREET_TOKEN: TOKEN,
    GREET_TOKEN_FILE: tokenFile,
    GREET_PORT: '0',
    GREET_DATA: dataFile,
  });

  assert.equal(code, 1);
  assert.match(stderr, /Passo seguinte/);
  assert.ok(stderr.includes(dataFile), 'a mensagem tem de dizer o caminho do ficheiro');
  assert.ok(!/\n\s*at\s/.test(stderr), `stderr não pode ter stack trace: ${stderr}`);
  assert.ok(!stderr.includes('Error:'), `stderr não pode ter "Error:": ${stderr}`);
  assert.equal(stdout, '');

  const depois = await readFile(dataFile);
  assert.deepEqual(depois, antes, 'o ficheiro ilegível nunca é tocado');
});

// --- GREET_HOST=0.0.0.0: endereços de rede local (T10) --------------------------------------------

test('com GREET_HOST=0.0.0.0 -> stdout anuncia 127.0.0.1, cada endereço de lanAddresses(), diz "palavra-passe" e nunca "token"', async () => {
  const dataDir = await mkdtemp(path.join(tmpRoot, 'data-lan-'));
  const dataFile = path.join(dataDir, 'greetings.json');
  const tokenFile = path.join(tmpRoot, 'ainda-mais-nao-existe', 'token.local.txt');

  const { child, port, stdout } = await startAndWaitForAddress({
    GREET_TOKEN: TOKEN,
    GREET_TOKEN_FILE: tokenFile,
    GREET_PORT: '0',
    GREET_HOST: '0.0.0.0',
    GREET_DATA: dataFile,
  });

  const output = stdout();

  assert.match(output, new RegExp(`http://127\\.0\\.0\\.1:${port}/`));

  const addresses = lanAddresses();
  if (addresses.length > 0) {
    for (const address of addresses) {
      assert.ok(
        output.includes(`Para os colegas na mesma rede: http://${address}:${port}/`),
        `stdout devia anunciar o endereço ${address}: ${output}`,
      );
    }
  } else {
    assert.ok(
      output.includes('Não encontrei nenhum endereço de rede local'),
      `sem endereços de rede local, stdout devia dizer isso: ${output}`,
    );
  }

  assert.match(output, /palavra-passe/);
  assert.ok(!/token/i.test(output), `stdout não pode conter "token": ${output}`);
  assert.ok(!output.includes(TOKEN), 'o stdout nunca pode conter o token');

  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
});
