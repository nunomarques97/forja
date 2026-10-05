#!/usr/bin/env node
// Stress scenarios (test/stress/manifest.json) as fresh Git projects.
//   node test/stress/build-scenarios.mjs [--lab <dir>] [--out <dir>] [--only id,id]
// Each scenario becomes <out>/<id> (default <lab>/scenarios/<id>): the template
// committed as "initial import", then each overlay as its own commit, so a
// regression scenario has the history that introduced it. Only templates/ is
// ever copied: the hidden acceptance checks and reference solutions under
// acceptance/ never enter a scenario project.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STRESS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(STRESS_DIR, '..', '..');
export const MANIFEST = join(STRESS_DIR, 'manifest.json');
export const TEMPLATES = join(STRESS_DIR, 'templates');
export const ACCEPTANCE = join(STRESS_DIR, 'acceptance');
// Written inside .git, so the scenario's working tree never shows it; a
// rebuild only deletes folders that carry it.
export const MARKER = 'forja-stress.json';
const BUDGET_LIMITS = { runMinutes: [1, 60], maxSessions: [1, 20], maxAttempts: [1, 3] };

export const loadManifest = (path = MANIFEST) => JSON.parse(readFileSync(path, 'utf8'));

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
const isDir = path => existsSync(path) && statSync(path).isDirectory();

export function scenarioBudgets(manifest, scenario) {
  return { ...manifest.defaults?.budgets, ...scenario.budgets };
}

// Every problem of the manifest, one line each; [] when it is valid.
export function manifestProblems(manifest, { stressDir = STRESS_DIR } = {}) {
  const problems = [];
  const templates = join(stressDir, 'templates'), acceptance = join(stressDir, 'acceptance');
  if (manifest?.version !== 1) problems.push('version must be 1');
  if (typeof manifest?.lab !== 'string' || !manifest.lab) problems.push('lab must be a folder');
  if (!Number.isInteger(manifest?.wallClockMinutes) || manifest.wallClockMinutes < 1 || manifest.wallClockMinutes > 1440) problems.push('wallClockMinutes must be in 1..1440');
  for (const key of ['categories', 'kinds']) if (!Array.isArray(manifest?.[key]) || !manifest[key].length) problems.push(`${key} must be a non-empty list`);
  const ids = new Set();
  for (const [index, s] of (manifest?.scenarios ?? []).entries()) {
    const at = `scenario ${s?.id ?? index}`;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s?.id ?? '')) problems.push(`${at}: id must be lower-case words joined by dashes`);
    if (ids.has(s?.id)) problems.push(`${at}: duplicate id`);
    ids.add(s?.id);
    if (!manifest.categories?.includes(s?.category)) problems.push(`${at}: unknown category ${JSON.stringify(s?.category)}`);
    if (!manifest.kinds?.includes(s?.kind)) problems.push(`${at}: unknown kind ${JSON.stringify(s?.kind)}`);
    if (typeof s?.goal !== 'string' || s.goal.length < 40 || s.goal.length > 4000) problems.push(`${at}: goal must have 40..4000 characters`);
    if (typeof s?.template !== 'string' || !isDir(join(templates, s.template)) || s.template.includes('..')) problems.push(`${at}: template must be a folder of test/stress/templates`);
    if (!Array.isArray(s?.overlays)) problems.push(`${at}: overlays must be a list`);
    for (const o of s?.overlays ?? []) {
      if (typeof o?.dir !== 'string' || o.dir.includes('..') || !isDir(join(templates, o.dir))) problems.push(`${at}: overlay ${JSON.stringify(o?.dir)} must be a folder of test/stress/templates`);
      if (typeof o?.commit !== 'string' || !o.commit.trim()) problems.push(`${at}: overlay ${JSON.stringify(o?.dir)} needs a commit message`);
    }
    const args = s?.acceptance?.args;
    const file = Array.isArray(args) && args.length === 2 && args[0] === '--test' ? args[1] : null;
    if (s?.acceptance?.command !== 'node' || !file || !/^test\/stress\/acceptance\/[a-z0-9-]+\.test\.mjs$/.test(file)) problems.push(`${at}: acceptance must be node --test test/stress/acceptance/<name>.test.mjs`);
    else if (!existsSync(join(acceptance, file.slice('test/stress/acceptance/'.length)))) problems.push(`${at}: acceptance file ${file} does not exist`);
    if (typeof s?.solution !== 'string' || !s.solution.startsWith('acceptance/solutions/') || s.solution.includes('..') || !isDir(join(stressDir, s.solution))) problems.push(`${at}: solution must be a folder under test/stress/acceptance/solutions`);
    const budgets = scenarioBudgets(manifest, s ?? {});
    for (const [key, [min, max]] of Object.entries(BUDGET_LIMITS))
      if (!Number.isInteger(budgets[key]) || budgets[key] < min || budgets[key] > max) problems.push(`${at}: budget ${key} must be in ${min}..${max}`);
  }
  if (!ids.size) problems.push('no scenarios');
  return problems;
}

export function validManifest(manifest = loadManifest(), options) {
  const problems = manifestProblems(manifest, options);
  if (problems.length) throw Error(`Invalid stress manifest:\n- ${problems.join('\n- ')}`);
  return manifest;
}

export const acceptanceFile = scenario => join(REPO, ...scenario.acceptance.args[1].split('/'));

function git(cwd, args, date) {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'Robin Vale', GIT_AUTHOR_EMAIL: 'robin@example.invalid', GIT_COMMITTER_NAME: 'Robin Vale', GIT_COMMITTER_EMAIL: 'robin@example.invalid' };
  const out = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (out.status !== 0) throw Error(`git ${args[0]} failed in ${cwd}: ${(out.stderr || out.error?.message || '').trim().slice(0, 300)}`);
  return out.stdout;
}

// Builds one scenario at `dest`, which must not exist or be an earlier build.
export function materialize(scenario, dest, { stressDir = STRESS_DIR } = {}) {
  const templates = join(stressDir, 'templates');
  if (existsSync(dest)) {
    if (readdirSync(dest).length && !existsSync(join(dest, '.git', MARKER))) throw Error(`${dest} exists and is not a stress scenario build; refusing to delete it.`);
    rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(dest, { recursive: true });
  cpSync(join(templates, scenario.template), dest, { recursive: true });
  git(dest, ['init', '-q', '-b', 'main'], '2026-09-01T09:00:00Z');
  git(dest, ['config', 'core.autocrlf', 'false'], '2026-09-01T09:00:00Z');
  git(dest, ['add', '-A'], '2026-09-01T09:00:00Z');
  git(dest, ['commit', '-q', '-m', 'initial import'], '2026-09-01T09:00:00Z');
  scenario.overlays.forEach((overlay, i) => {
    const date = `2026-09-${String(2 + i).padStart(2, '0')}T15:30:00Z`;
    cpSync(join(templates, overlay.dir), dest, { recursive: true });
    git(dest, ['add', '-A'], date);
    git(dest, ['commit', '-q', '-m', overlay.commit], date);
  });
  writeFileSync(join(dest, '.git', MARKER), JSON.stringify({ id: scenario.id, template: scenario.template, overlays: scenario.overlays.map(o => o.dir) }) + '\n');
  return dest;
}

// The reference solution, copied over a built scenario (tests only; never committed).
export function applySolution(scenario, dest, { stressDir = STRESS_DIR } = {}) {
  cpSync(join(stressDir, scenario.solution), dest, { recursive: true });
  return dest;
}

export function selectScenarios(manifest, only) {
  if (!only) return manifest.scenarios;
  const wanted = only.split(',').map(id => id.trim()).filter(Boolean);
  const unknown = wanted.filter(id => !manifest.scenarios.some(s => s.id === id));
  if (unknown.length) throw Error(`Unknown scenario ${unknown.join(', ')}.`);
  return manifest.scenarios.filter(s => wanted.includes(s.id));
}

export function parseArgs(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i], value = argv[i + 1];
    if (['--lab', '--out', '--only'].includes(flag) && value && !value.startsWith('--')) { opt[flag.slice(2)] = value; i++; }
    else throw Error(`Unknown or incomplete argument ${JSON.stringify(flag)}; nothing was built.`);
  }
  return opt;
}

function main(argv) {
  const opt = parseArgs(argv);
  const manifest = validManifest();
  const out = resolve(opt.out ?? join(opt.lab ?? manifest.lab, 'scenarios'));
  if (out === REPO || inside(out, REPO)) throw Error('Scenario projects must live outside this repository.');
  for (const scenario of selectScenarios(manifest, opt.only)) {
    materialize(scenario, join(out, scenario.id));
    console.log(`${scenario.id}: ${join(out, scenario.id)}`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`build-scenarios: ${error.message}`); process.exitCode = 2; }
}
