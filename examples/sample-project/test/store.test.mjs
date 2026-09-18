import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore, UnreadableDataFile, DataFileWriteFailed } from '../lib/store.mjs';

const onlyWindows = process.platform === 'win32' ? false : 'rename lock behaviour is Windows-only';

let root;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'store-test-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A folder of its own for each test, so one test never sees another test's files. */
async function freshDir() {
  return mkdtemp(path.join(root, 'case-'));
}

async function tmpLeftovers(dir) {
  const names = await readdir(dir);
  return names.filter((name) => name.endsWith('.tmp'));
}

test('load returns [] when the file does not exist', async () => {
  const dir = await freshDir();
  const store = createStore(path.join(dir, 'greetings.json'));
  assert.deepEqual(await store.load(), []);
  assert.deepEqual(await readdir(dir), []); // load created nothing
});

test('load returns [] when the folder does not exist either', async () => {
  const dir = await freshDir();
  const store = createStore(path.join(dir, 'data', 'greetings.json'));
  assert.deepEqual(await store.load(), []);
});

test('load returns [] for an empty file and for a file with only whitespace', async () => {
  const dir = await freshDir();
  const empty = path.join(dir, 'greetings.json');
  await writeFile(empty, '');
  assert.deepEqual(await createStore(empty).load(), []);

  const blank = path.join(dir, 'blank.json');
  await writeFile(blank, '\r\n  \n');
  assert.deepEqual(await createStore(blank).load(), []);
});

test('load throws UnreadableDataFile on invalid JSON and leaves the bytes untouched', async () => {
  const dir = await freshDir();
  const file = path.join(dir, 'greetings.json');
  await writeFile(file, '[{"nome":"Ana"},');
  const before = await readFile(file);

  const store = createStore(file);
  const err = await store.load().then(
    () => null,
    (e) => e,
  );

  assert.ok(err instanceof UnreadableDataFile, `esperava UnreadableDataFile, veio ${err}`);
  assert.equal(err.path, file);
  assert.match(err.message, /Passo seguinte/);
  assert.ok(err.message.includes(file), 'a mensagem tem de dizer o caminho do ficheiro');
  assert.deepEqual(await readFile(file), before); // same bytes after load()
  assert.deepEqual(await tmpLeftovers(dir), []);
});

test('load throws UnreadableDataFile when the JSON is not a list', async () => {
  const dir = await freshDir();
  const file = path.join(dir, 'greetings.json');
  await writeFile(file, '{"nome":"Ana"}');
  const before = await readFile(file);

  await assert.rejects(() => createStore(file).load(), UnreadableDataFile);
  assert.deepEqual(await readFile(file), before);
});

test('append refuses an unreadable file and leaves the bytes untouched', async () => {
  const dir = await freshDir();
  const file = path.join(dir, 'greetings.json');
  await writeFile(file, 'isto não é JSON');
  const before = await readFile(file);

  const store = createStore(file);
  await assert.rejects(() => store.append({ nome: 'Ana' }), UnreadableDataFile);

  assert.deepEqual(await readFile(file), before); // same bytes after append()
  assert.deepEqual(await tmpLeftovers(dir), []); // nothing half-written left behind
  assert.deepEqual(await readdir(dir), ['greetings.json']);
});

test('append creates the folder and the file when neither exists', async () => {
  const dir = await freshDir();
  const file = path.join(dir, 'data', 'nested', 'greetings.json');
  const store = createStore(file);

  const written = await store.append({ nome: 'Ana', saudacao: 'Olá, Ana!' });

  assert.deepEqual(written, { nome: 'Ana', saudacao: 'Olá, Ana!' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [
    { nome: 'Ana', saudacao: 'Olá, Ana!' },
  ]);
  assert.deepEqual(await store.load(), [{ nome: 'Ana', saudacao: 'Olá, Ana!' }]);
  assert.deepEqual(await tmpLeftovers(path.dirname(file)), []);
});

test('append keeps the records in order and re-reads what is on disk', async () => {
  const dir = await freshDir();
  const file = path.join(dir, 'greetings.json');
  const store = createStore(file);

  await store.append({ n: 1 });
  await store.append({ n: 2 });
  // another store over the same file sees what the first one wrote
  await createStore(file).append({ n: 3 });

  assert.deepEqual(await store.load(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test('the JSON on disk is indented with 2 spaces', async () => {
  const dir = await freshDir();
  const file = path.join(dir, 'greetings.json');
  const store = createStore(file);

  await store.append({ nome: 'Ana' });
  await store.append({ nome: 'Bruno' });

  const raw = await readFile(file, 'utf8');
  assert.equal(raw, JSON.stringify([{ nome: 'Ana' }, { nome: 'Bruno' }], null, 2));
  assert.equal(raw.split('\n')[1], '  {');
  assert.equal(raw.split('\n')[2], '    "nome": "Ana"');
});

test('10 simultaneous appends write 10 records and leave no .tmp behind', async () => {
  const dir = await freshDir();
  const file = path.join(dir, 'greetings.json');
  const store = createStore(file);

  const nomes = ['Ana', 'Bruno', 'Carla', 'Diogo', 'Eva', 'Filipe', 'Gina', 'Hugo', 'Inês', 'João'];
  await Promise.all(nomes.map((nome, i) => store.append({ i, nome })));

  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.length, 10);
  assert.deepEqual(
    onDisk.map((r) => r.nome).sort(),
    [...nomes].sort(),
  );
  assert.deepEqual(await readdir(dir), ['greetings.json']); // no *.tmp, no other leftovers
});

test('a write that fails before the rename leaves no .tmp and does not touch the file', async () => {
  const dir = await freshDir();
  const file = path.join(dir, 'greetings.json');
  const store = createStore(file);
  await store.append({ n: 1 });
  const before = await readFile(file);

  const circular = { nome: 'Ana' };
  circular.self = circular; // JSON.stringify throws after the temp file is already open
  await assert.rejects(() => store.append(circular), TypeError);

  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readdir(dir), ['greetings.json']); // the .tmp was cleaned up
  assert.deepEqual(await store.load(), [{ n: 1 }]);
});

test('a failed append does not break the appends that follow', async () => {
  const dir = await freshDir();
  const file = path.join(dir, 'greetings.json');
  await writeFile(file, '{ partido');
  const store = createStore(file);

  await assert.rejects(() => store.append({ nome: 'Ana' }), UnreadableDataFile);
  await writeFile(file, '[]'); // the person fixed the file, as the message says
  await store.append({ nome: 'Bruno' });

  assert.deepEqual(await store.load(), [{ nome: 'Bruno' }]);
});

test(
  'rename is retried while another handle holds the file, and succeeds when it is released',
  { skip: onlyWindows },
  async () => {
    const dir = await freshDir();
    const file = path.join(dir, 'greetings.json');
    const store = createStore(file);
    await store.append({ n: 1 });

    const handle = await open(file, 'r'); // on Windows this makes rename fail with EPERM
    const release = setTimeout(() => handle.close(), 150);

    await store.append({ n: 2 });
    clearTimeout(release);
    await handle.close().catch(() => {});

    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [{ n: 1 }, { n: 2 }]);
    assert.deepEqual(await tmpLeftovers(dir), []);
  },
);

test(
  'when rename keeps failing, the previous file is intact and the new data is kept in the .tmp',
  { skip: onlyWindows },
  async () => {
    const dir = await freshDir();
    const file = path.join(dir, 'greetings.json');
    const store = createStore(file);
    await store.append({ n: 1 });
    const before = await readFile(file);

    const handle = await open(file, 'r'); // never released: all 4 attempts fail with EPERM
    const err = await store.append({ n: 2 }).then(
      () => null,
      (e) => e,
    );
    await handle.close();

    assert.ok(err instanceof DataFileWriteFailed, `esperava DataFileWriteFailed, veio ${err}`);
    assert.equal(err.path, file);
    assert.match(err.message, /Passo seguinte/);
    assert.deepEqual(await readFile(file), before); // the old file was not touched
    assert.deepEqual(JSON.parse(await readFile(err.tempPath, 'utf8')), [{ n: 1 }, { n: 2 }]);
    assert.match(path.basename(err.tempPath), /^greetings\.json\.\d+\.[0-9a-f]+\.tmp$/);
    assert.equal(path.dirname(err.tempPath), dir); // same folder as the final file
  },
);
