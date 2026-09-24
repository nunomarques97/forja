// core init: preflight, tracked writes and best-effort rollback.
// Failures are injected deterministically in a child process by patching the
// node:fs builtins and calling syncBuiltinESMExports, so the named imports of
// lib/core/init.mjs reach the patched functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { initCore } from '../lib/core/init.mjs';

const moduleURL = new URL('../lib/core/init.mjs', import.meta.url).href;
const OUTPUTS = ['AGENTS.md', 'CLAUDE.md', '.gitignore'];
const SECRET = 'SECRET-USER-CONTENT-7f3a';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'forja-init-rollback-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

// Every entry below root, recursively: bytes for files, a marker for the rest.
function inventory(root, dir = root, out = {}) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = join(dir, name),
      rel = p.slice(root.length + 1).replaceAll('\\', '/'),
      stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
    else if (stat.isFile()) out[rel] = fs.readFileSync(p).toString('base64');
    else if (stat.isDirectory()) {
      out[rel] = 'directory';
      inventory(root, p, out);
    } else out[rel] = 'other';
  }
  return out;
}

// faults: [{ op, target, nth = 1, code = 'EIO', when = 'before' }].
// The after/partial modes cover failures that already changed the filesystem.
function withFaults(root, faults) {
  const code = `
import fs from 'node:fs';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const faults = JSON.parse(process.env.FAULTS), counts = {}, fired = [];
function faultFor(op, p) {
  const name = basename(String(p)), key = op + ':' + name;
  counts[key] = (counts[key] || 0) + 1;
  const f = faults.find((x) => x.op === op && x.target === name && (x.nth || 1) === counts[key]);
  if (f) {
    fired.push(key + '#' + counts[key]);
  }
  return f;
}
for (const op of ['writeFileSync', 'mkdirSync', 'unlinkSync', 'rmdirSync', 'renameSync', 'rmSync']) {
  const original = fs[op];
  fs[op] = function (p, ...rest) {
    const fault = faultFor(op, op === 'renameSync' ? rest[0] : p);
    if (!fault) return original.call(this, p, ...rest);
    if (fault.when === 'after') original.call(this, p, ...rest);
    if (fault.when === 'partial') original.call(this, p, 'partial write');
    if (fault.populate) fs.writeFileSync(String(p) + '/keep.txt', 'preserve');
    throw Object.assign(new Error('synthetic I/O failure'), { code: fault.code || 'EIO' });
  };
}
syncBuiltinESMExports();
const { initCore } = await import(process.env.INIT_MODULE);
let result;
try {
  result = { ok: true, value: initCore(process.env.INIT_ROOT) };
} catch (error) {
  result = {
    ok: false,
    message: error.message,
    code: error.code,
    cause: error.cause?.message,
    rollback: error.rollback,
  };
}
console.log(JSON.stringify({ ...result, fired, counts }));
`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: {
      ...process.env,
      INIT_ROOT: root,
      INIT_MODULE: moduleURL,
      FAULTS: JSON.stringify(faults),
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

function seed(root, { outputs, state }) {
  fs.writeFileSync(join(root, 'unrelated.txt'), 'keep me\n');
  if (outputs)
    for (const n of OUTPUTS)
      fs.writeFileSync(join(root, n), `# ${n}\r\n${SECRET}\r\nno trailing newline`);
  if (state) {
    fs.mkdirSync(join(root, '.forja'));
    fs.writeFileSync(join(root, '.forja', 'state.json'), '{"keep":true}');
  }
}

const cases = [];
for (const target of OUTPUTS)
  for (const existing of [true, false])
    cases.push({ target, op: 'writeFileSync', existing, state: existing });
// .forja is only created (and so can only fail) when it is absent.
for (const existing of [true, false])
  cases.push({ target: '.forja', op: 'mkdirSync', existing, state: false });

for (const c of cases)
  test(`failure on ${c.target} with outputs ${c.existing ? 'preexisting' : 'absent'} restores the project`, (t) => {
    const root = fixture(t);
    seed(root, { outputs: c.existing, state: c.state });
    const before = inventory(root);
    const r = withFaults(root, [{ op: c.op, target: c.target }]);
    assert.equal(r.ok, false);
    assert.deepEqual(r.fired, [`${c.op}:${c.target}#1`]);
    assert.equal(r.message, 'synthetic I/O failure', 'the original error propagates');
    assert.equal(r.code, 'EIO');
    assert.deepEqual(inventory(root), before);
    if (c.state)
      assert.equal(fs.readFileSync(join(root, '.forja', 'state.json'), 'utf8'), '{"keep":true}');
  });

test('mixed preexisting and absent outputs: restore existing bytes, remove new files', (t) => {
  const root = fixture(t);
  fs.writeFileSync(join(root, 'AGENTS.md'), Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x0d, 0x0a, 0xff]));
  const before = inventory(root);
  const r = withFaults(root, [{ op: 'mkdirSync', target: '.forja' }]);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'synthetic I/O failure');
  assert.deepEqual(inventory(root), before);
  assert.equal(r.counts['writeFileSync:AGENTS.md'], 2, 'written then restored');
  assert.equal(r.counts['unlinkSync:CLAUDE.md'], 1);
  assert.equal(r.counts['unlinkSync:.gitignore'], 1);
});

test('incomplete rollback continues and reports only file names and codes', (t) => {
  const root = fixture(t);
  seed(root, { outputs: true, state: false });
  const agents = fs.readFileSync(join(root, 'AGENTS.md'));
  const r = withFaults(root, [
    { op: 'writeFileSync', target: '.gitignore' },
    { op: 'writeFileSync', target: 'CLAUDE.md', nth: 2, code: 'EACCES' },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.message, /rollback is incomplete: CLAUDE\.md \(EACCES\)$/);
  assert.equal(r.cause, 'synthetic I/O failure');
  assert.deepEqual(r.rollback, [{ file: 'CLAUDE.md', code: 'EACCES' }]);
  assert.doesNotMatch(JSON.stringify(r), new RegExp(SECRET));
  assert.doesNotMatch(r.message, /FORJA core|forja-core/);
  // Rollback runs in reverse: CLAUDE.md's restore failed, yet AGENTS.md
  // (attempted afterwards) is still restored byte for byte.
  assert.ok(fs.readFileSync(join(root, 'AGENTS.md')).equals(agents));
  assert.equal(fs.existsSync(join(root, '.forja')), false);
});

test('failed removal of a new output is reported and the rest is still removed', (t) => {
  const root = fixture(t);
  seed(root, { outputs: false, state: false });
  const r = withFaults(root, [
    { op: 'mkdirSync', target: '.forja' },
    { op: 'unlinkSync', target: 'CLAUDE.md', code: 'EBUSY' },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.rollback, [{ file: 'CLAUDE.md', code: 'EBUSY' }]);
  assert.equal(r.cause, 'synthetic I/O failure');
  assert.equal(fs.existsSync(join(root, '.gitignore')), false);
  assert.equal(fs.existsSync(join(root, 'AGENTS.md')), false);
  assert.ok(fs.existsSync(join(root, 'CLAUDE.md')), 'the unremovable file is left and reported');
  assert.equal(fs.readFileSync(join(root, 'unrelated.txt'), 'utf8'), 'keep me\n');
});

function trySymlink(t, target, path, type) {
  try {
    fs.symlinkSync(target, path, type);
    return true;
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('file symlinks need a privilege this OS account does not have (EPERM)');
    return false;
  }
}

for (const name of OUTPUTS) {
  test(`preflight rejects a directory at ${name} before any change`, (t) => {
    const root = fixture(t);
    seed(root, { outputs: true, state: false });
    fs.rmSync(join(root, name));
    fs.mkdirSync(join(root, name));
    const before = inventory(root);
    assert.throws(() => initCore(root), new RegExp(`${name.replace('.', '\\.')} must be a regular file, found a directory`));
    assert.deepEqual(inventory(root), before);
  });

  test(`preflight rejects a file symlink at ${name} before any change`, (t) => {
    const root = fixture(t),
      outside = fs.mkdtempSync(join(tmpdir(), 'forja-init-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(join(outside, 'target.md'), 'outside');
    seed(root, { outputs: true, state: false });
    fs.rmSync(join(root, name));
    if (!trySymlink(t, join(outside, 'target.md'), join(root, name), 'file')) return;
    const before = inventory(root);
    assert.throws(() => initCore(root), /must be a regular file, found a symbolic link/);
    assert.deepEqual(inventory(root), before);
    assert.equal(fs.readFileSync(join(outside, 'target.md'), 'utf8'), 'outside');
  });
}

test('preflight rejects a symlink to another file inside the project', (t) => {
  const root = fixture(t);
  seed(root, { outputs: false, state: false });
  if (!trySymlink(t, join(root, 'unrelated.txt'), join(root, '.gitignore'), 'file')) return;
  const before = inventory(root);
  assert.throws(() => initCore(root), /.gitignore must be a regular file, found a symbolic link/);
  assert.deepEqual(inventory(root), before);
});

test('preflight rejects a dangling symlink at an output', (t) => {
  const root = fixture(t);
  if (!trySymlink(t, join(root, 'missing.md'), join(root, 'AGENTS.md'), 'file')) return;
  const before = inventory(root);
  assert.throws(() => initCore(root), /AGENTS\.md must be a regular file/);
  assert.deepEqual(inventory(root), before);
});

test('preflight rejects a junction at an output', (t) => {
  const root = fixture(t),
    outside = fs.mkdtempSync(join(tmpdir(), 'forja-init-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, join(root, 'CLAUDE.md'), 'junction');
  const before = inventory(root);
  assert.throws(() => initCore(root), /CLAUDE\.md must be a regular file, found a symbolic link or junction/);
  assert.deepEqual(inventory(root), before);
  fs.unlinkSync(join(root, 'CLAUDE.md'));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('preflight rejects .forja as a junction and never writes through it', (t) => {
  const root = fixture(t),
    outside = fs.mkdtempSync(join(tmpdir(), 'forja-init-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(join(outside, 'keep'), 'outside');
  seed(root, { outputs: true, state: false });
  fs.symlinkSync(outside, join(root, '.forja'), 'junction');
  const before = inventory(root);
  assert.throws(() => initCore(root), /\.forja must be a real directory, found a symbolic link or junction/);
  assert.deepEqual(inventory(root), before);
  fs.unlinkSync(join(root, '.forja'));
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
});

test('preflight rejects .forja as a regular file or a file symlink', (t) => {
  const root = fixture(t);
  seed(root, { outputs: false, state: false });
  fs.writeFileSync(join(root, '.forja'), 'state file');
  let before = inventory(root);
  assert.throws(() => initCore(root), /\.forja must be a real directory, found a regular file/);
  assert.deepEqual(inventory(root), before);
  fs.rmSync(join(root, '.forja'));
  if (!trySymlink(t, join(root, 'unrelated.txt'), join(root, '.forja'), 'file')) return;
  before = inventory(root);
  assert.throws(() => initCore(root), /\.forja must be a real directory, found a symbolic link/);
  assert.deepEqual(inventory(root), before);
});

test('managed markers of every instruction file are validated before any write', (t) => {
  const root = fixture(t);
  for (const [agents, claude] of [
    ['keep', 'user\n<!-- forja-core:begin -->'],
    ['keep', '<!-- forja-core:end --> <!-- forja-core:begin -->'],
    ['keep', '<!-- forja-core:begin --><!-- forja-core:end --><!-- forja-core:begin --><!-- forja-core:end -->'],
    ['<!-- forja-core:end -->', 'fine'],
  ]) {
    fs.writeFileSync(join(root, 'AGENTS.md'), agents);
    fs.writeFileSync(join(root, 'CLAUDE.md'), claude);
    const before = inventory(root);
    assert.throws(() => initCore(root), /markers/);
    assert.deepEqual(inventory(root), before);
  }
});

test('success keeps the result shape, leaves no temp files and is byte-idempotent', (t) => {
  const root = fixture(t);
  seed(root, { outputs: true, state: true });
  const result = initCore(root);
  assert.deepEqual(result, {
    project: resolve(root),
    files: ['AGENTS.md', 'CLAUDE.md', '.gitignore'],
    legacy_agents: { archived: [], kept: [] },
    note: 'Existing instructions retained; legacy crew agents archived, never deleted; no role catalog or settings copied.',
  });
  assert.deepEqual(fs.readdirSync(root).sort(), ['.forja', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'unrelated.txt']);
  for (const n of ['AGENTS.md', 'CLAUDE.md']) {
    const text = fs.readFileSync(join(root, n), 'utf8');
    assert.ok(text.startsWith(`# ${n}\r\n${SECRET}\r\nno trailing newline\n\n<!-- forja-core:begin -->\n## FORJA core\n`));
    assert.ok(text.endsWith('<!-- forja-core:end -->\n'));
  }
  assert.equal(fs.readFileSync(join(root, '.gitignore'), 'utf8'), `# .gitignore\r\n${SECRET}\r\nno trailing newline\n.forja/\n`);
  const first = inventory(root);
  const again = withFaults(root, []);
  assert.equal(again.ok, true);
  assert.deepEqual(inventory(root), first);
  assert.deepEqual(again.counts, {}, 'unchanged outputs and existing state are not touched');
});

test('fresh project init creates outputs and state, then is byte-idempotent', (t) => {
  const root = fixture(t);
  initCore(root);
  assert.deepEqual(fs.readdirSync(root).sort(), ['.forja', '.gitignore', 'AGENTS.md', 'CLAUDE.md']);
  assert.ok(fs.lstatSync(join(root, '.forja')).isDirectory());
  assert.equal(fs.readFileSync(join(root, '.gitignore'), 'utf8'), '.forja/\n');
  const first = inventory(root);
  initCore(root);
  assert.deepEqual(inventory(root), first);
});

test('a failed legacy skill write restores instructions and every changed skill', (t) => {
  const root = fixture(t);
  seed(root, { outputs: true, state: true });
  for (const skill of ['forja-lead', 'forja-crew']) {
    fs.mkdirSync(join(root, '.claude/skills', skill), { recursive: true });
    fs.writeFileSync(join(root, '.claude/skills', skill, 'SKILL.md'), `---\nname: ${skill}\n---\nCustomized method\n`);
  }
  const before = inventory(root);
  const result = withFaults(root, [{ op: 'writeFileSync', target: 'SKILL.md', nth: 2, when: 'after' }]);
  assert.equal(result.ok, false);
  assert.deepEqual(inventory(root), before);
});

test('unrecognized legacy skill and linked skill ancestor refuse before writing', (t) => {
  const root = fixture(t);
  fs.mkdirSync(join(root, '.claude/skills/forja-lead'), { recursive: true });
  fs.writeFileSync(join(root, '.claude/skills/forja-lead/SKILL.md'), '# User-owned file\n');
  const before = inventory(root);
  assert.throws(() => initCore(root), /Unrecognized legacy skill/);
  assert.deepEqual(inventory(root), before);
  const linked = fixture(t), outside = fixture(t);
  fs.mkdirSync(join(linked, '.claude'));
  fs.symlinkSync(outside, join(linked, '.claude/skills'), 'junction');
  const linkedBefore = inventory(linked);
  assert.throws(() => initCore(linked), /[Ss]ymlink|[Jj]unction|[Ll]ink|outside/);
  assert.deepEqual(inventory(linked), linkedBefore);
});

test('mutating the returned files list cannot affect future initialization', (t) => {
  const root = fixture(t);
  const first = initCore(root);
  first.files.length = 0;
  assert.deepEqual(initCore(root).files, OUTPUTS);
});

test('failure after creating an empty state directory restores the whole project', (t) => {
  const root = fixture(t);
  seed(root, { outputs: true, state: false });
  const before = inventory(root);
  const r = withFaults(root, [{ op: 'mkdirSync', target: '.forja', when: 'after' }]);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'synthetic I/O failure');
  assert.deepEqual(inventory(root), before);
});

test('rollback never removes a newly populated state directory', (t) => {
  const root = fixture(t);
  seed(root, { outputs: true, state: false });
  const before = inventory(root);
  const r = withFaults(root, [{ op: 'mkdirSync', target: '.forja', when: 'after', populate: true }]);
  assert.equal(r.ok, false);
  assert.match(r.message, /rollback is incomplete/);
  assert.deepEqual(r.rollback.map(f => f.file), ['.forja']);
  assert.equal(fs.readFileSync(join(root, '.forja', 'keep.txt'), 'utf8'), 'preserve');
  for (const [name, bytes] of Object.entries(before)) assert.equal(inventory(root)[name], bytes);
});

test('a directory collision during creation is never removed', (t) => {
  const root = fixture(t);
  seed(root, { outputs: true, state: false });
  const before = inventory(root);
  const r = withFaults(root, [{ op: 'mkdirSync', target: '.forja', when: 'after', code: 'EEXIST' }]);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EEXIST');
  assert.equal(r.counts['rmdirSync:.forja'], undefined);
  assert.ok(fs.lstatSync(join(root, '.forja')).isDirectory());
  for (const [name, bytes] of Object.entries(before)) assert.equal(inventory(root)[name], bytes);
});

for (const existing of [true, false]) {
  test(`a partial physical write is rolled back with outputs ${existing ? 'existing' : 'absent'}`, (t) => {
    const root = fixture(t);
    seed(root, { outputs: existing, state: existing });
    const before = inventory(root);
    const r = withFaults(root, [{ op: 'writeFileSync', target: 'CLAUDE.md', when: 'partial' }]);
    assert.equal(r.ok, false);
    assert.equal(r.message, 'synthetic I/O failure');
    assert.deepEqual(inventory(root), before);
  });
}

// Legacy crew agents: archived reversibly, never deleted.
const CREW = '---\nname: architect\ndescription: Architect of the Forja crew.\n---\nBody\n';
function seedCrew(root) {
  fs.mkdirSync(join(root, '.claude/agents'), { recursive: true });
  fs.writeFileSync(join(root, '.claude/agents/architect.md'), CREW);
  fs.writeFileSync(join(root, '.claude/agents/qa.md'), CREW.replace('architect', 'qa'));
  fs.writeFileSync(join(root, '.claude/agents/reviewer.md'), '# my own reviewer\n');
  fs.writeFileSync(join(root, '.claude/agents/helper.md'), '# helper for forja\n');
}

test('init archives legacy crew agents, keeps user agents and is idempotent', (t) => {
  const root = fixture(t);
  seedCrew(root);
  const result = initCore(root);
  assert.deepEqual(result.legacy_agents, {
    archived: [
      { from: '.claude/agents/architect.md', to: 'docs/forja/legacy-agents/architect.md' },
      { from: '.claude/agents/qa.md', to: 'docs/forja/legacy-agents/qa.md' },
    ],
    kept: [],
  });
  assert.deepEqual(fs.readdirSync(join(root, '.claude/agents')).sort(), ['helper.md', 'reviewer.md']);
  assert.equal(fs.readFileSync(join(root, 'docs/forja/legacy-agents/architect.md'), 'utf8'), CREW);
  const first = inventory(root);
  assert.deepEqual(initCore(root).legacy_agents, { archived: [], kept: [] });
  assert.deepEqual(inventory(root), first);
});

test('init keeps crew agents while a legacy run is active and refuses a conflicting archive', (t) => {
  const root = fixture(t);
  seedCrew(root);
  fs.mkdirSync(join(root, 'docs/forja'), { recursive: true });
  fs.writeFileSync(join(root, 'docs/forja/RUN.json'), '{"status":"running"}');
  const kept = initCore(root);
  assert.deepEqual(kept.legacy_agents, { archived: [], kept: ['.claude/agents/architect.md', '.claude/agents/qa.md'], reason: 'active legacy run' });
  assert.ok(fs.existsSync(join(root, '.claude/agents/architect.md')));
  fs.writeFileSync(join(root, 'docs/forja/RUN.json'), '{"status":"failed"}');
  fs.mkdirSync(join(root, 'docs/forja/legacy-agents'));
  fs.writeFileSync(join(root, 'docs/forja/legacy-agents/qa.md'), 'different');
  const before = inventory(root);
  assert.throws(() => initCore(root), /legacy-agents\/qa\.md already exists with different content.*Nothing was written/);
  assert.deepEqual(inventory(root), before);
});

test('a failure while archiving restores agents and removes the archive', (t) => {
  const root = fixture(t);
  seedCrew(root);
  const before = inventory(root);
  const r = withFaults(root, [{ op: 'unlinkSync', target: 'qa.md' }]);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'synthetic I/O failure');
  assert.deepEqual(inventory(root), before);
});

test('dry run reports the changes and writes nothing', (t) => {
  const root = fixture(t);
  seedCrew(root);
  const before = inventory(root);
  const report = initCore(root, { dryRun: true });
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.changes, ['AGENTS.md', 'CLAUDE.md', '.gitignore', '.forja']);
  assert.equal(report.legacy_agents.archived.length, 2);
  assert.deepEqual(inventory(root), before);
});

test('project copies of Core methods become manual-only', (t) => {
  const root = fixture(t);
  fs.mkdirSync(join(root, '.claude/skills/forja-core-planner'), { recursive: true });
  fs.writeFileSync(join(root, '.claude/skills/forja-core-planner/SKILL.md'), '---\nname: forja-core-planner\ndescription: Plan cohesive work.\n---\nBody\n');
  initCore(root);
  assert.equal(fs.readFileSync(join(root, '.claude/skills/forja-core-planner/SKILL.md'), 'utf8'), '---\nname: forja-core-planner\ndescription: Plan cohesive work.\ndisable-model-invocation: true\n---\nBody\n');
});
