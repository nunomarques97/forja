// data/projects.json is read by external read-only tools, so its bytes must not
// drift when the legacy workflow is removed. The expected strings below are the
// exact 0.21.2 output of writeProjects/upsertProject (two-space JSON, LF, one
// trailing newline, keys in the order name, path, bootstrappedAt).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProjects, projectsPath, upsertProject, writeProjects } from '../lib/projects.mjs';

const root = mkdtempSync(join(tmpdir(), 'forja-registry-'));
after(() => rmSync(root, { recursive: true, force: true }));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('writeProjects writes the 0.21.2 registry bytes for a fixed list', () => {
  const dir = join(root, 'fixed');
  const list = [
    { name: 'alpha', path: ['C:', 'work', 'alpha'].join('\\'), bootstrappedAt: '2026-09-17T18:00:00.000Z' },
    { name: 'beta', path: ['', 'srv', 'beta'].join('/'), bootstrappedAt: null },
  ];
  writeProjects(list, dir);
  const expected = '{\n' +
    '  "version": 1,\n' +
    '  "projects": [\n' +
    '    {\n' +
    '      "name": "alpha",\n' +
    '      "path": "C:\\\\work\\\\alpha",\n' +
    '      "bootstrappedAt": "2026-09-17T18:00:00.000Z"\n' +
    '    },\n' +
    '    {\n' +
    '      "name": "beta",\n' +
    '      "path": "/srv/beta",\n' +
    '      "bootstrappedAt": null\n' +
    '    }\n' +
    '  ]\n' +
    '}\n';
  assert.equal(readFileSync(projectsPath(dir), 'utf8'), expected);
});

test('upsertProject writes the same bytes: new entry, same-basename suffix and refresh', () => {
  const dir = join(root, 'upsert');
  const one = join(root, 'a', 'velora'); const two = join(root, 'b', 'velora');
  mkdirSync(one, { recursive: true }); mkdirSync(two, { recursive: true });
  const first = upsertProject({ path: one }, dir);
  const second = upsertProject({ path: two }, dir);
  assert.equal(first.name, 'velora'); assert.equal(second.name, 'velora-2');
  assert.match(first.bootstrappedAt, ISO); assert.match(second.bootstrappedAt, ISO);
  const entry = (name, path, at) => '    {\n' +
    `      "name": "${name}",\n` +
    `      "path": ${JSON.stringify(path)},\n` +
    `      "bootstrappedAt": "${at}"\n` +
    '    }';
  const body = entries => '{\n  "version": 1,\n  "projects": [\n' + entries.join(',\n') + '\n  ]\n}\n';
  assert.equal(readFileSync(projectsPath(dir), 'utf8'), body([entry('velora', one, first.bootstrappedAt), entry('velora-2', two, second.bootstrappedAt)]));
  // A refresh keeps the entry, its name and its position; only the timestamp moves.
  const again = upsertProject({ name: 'other', path: one }, dir);
  assert.equal(again.name, 'velora');
  assert.equal(readFileSync(projectsPath(dir), 'utf8'), body([entry('velora', one, again.bootstrappedAt), entry('velora-2', two, second.bootstrappedAt)]));
  assert.deepEqual(loadProjects(dir), {
    projects: [{ name: 'velora', path: one, bootstrappedAt: again.bootstrappedAt }, { name: 'velora-2', path: two, bootstrappedAt: second.bootstrappedAt }],
    corrupt: false, error: null,
  });
});
