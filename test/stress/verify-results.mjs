#!/usr/bin/env node
// Validates a committed stress results set (test/stress/results/<label>.json):
//   node test/stress/verify-results.mjs baseline|after
// Every manifest scenario needs exactly one judged record; every failure
// (FORJA did not finish, or the verdict is fail) needs a class, pipeline with
// its area or model, and a one-line evidence reference; the summary must match
// the records; no absolute local path may be committed. Exits 1 with one line
// per problem.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRESS_DIR, loadManifest } from './build-scenarios.mjs';

export const LABELS = ['baseline', 'after'];
export const OUTCOMES = ['done', 'blocked', 'failed', 'capped', 'error'];
export const AREAS = ['controller', 'packets', 'planning', 'review', 'delivery', 'checks', 'recovery'];
// My reading of the saved diff, independent of how FORJA ended.
export const CHANGES = ['correct', 'wrong', 'none'];
export const resultsFile =label => join(STRESS_DIR, 'results', `${label}.json`);
const ABSOLUTE_PATH = /[A-Za-z]:[\\/]|\\\\[A-Za-z]|\/(?:Users|home|tmp)\//;
const isCount = n => Number.isInteger(n) && n >= 0;
const isTokens = n => n === null || isCount(n);

// A scenario failed when FORJA did not end done or the final verdict is fail.
export const failed = record => record.outcome !== 'done' || record.verdict !== 'pass';

export function summarizeRecords(records) {
  const sum = pick => records.reduce((n, r) => n + (pick(r) ?? 0), 0);
  const completed = records.filter(r => !failed(r)).length;
  return {
    scenarios: records.length,
    forja_done: records.filter(r => r.outcome === 'done').length,
    acceptance_passed: records.filter(r => r.acceptance === 'pass').length,
    completed,
    completion_rate: records.length ? Math.round((completed / records.length) * 1000) / 10 : 0,
    failures: { pipeline: records.filter(r => r.failure?.class === 'pipeline').length, model: records.filter(r => r.failure?.class === 'model').length },
    tokens: { input: sum(r => r.tokens?.input), output: sum(r => r.tokens?.output) },
    sessions: sum(r => r.sessions),
    minutes: Math.round(sum(r => r.duration_s) / 60),
  };
}

export function recordProblems(record) {
  const id = record?.id ?? '?', problems = [], bad = text => problems.push(`${id}: ${text}`);
  if (!OUTCOMES.includes(record.outcome)) bad(`outcome ${JSON.stringify(record.outcome)} is not one of ${OUTCOMES.join(', ')}`);
  for (const key of ['acceptance', 'verdict']) if (!['pass', 'fail'].includes(record[key])) bad(`${key} must be pass or fail`);
  if (!record.tokens || !isTokens(record.tokens.input) || !isTokens(record.tokens.output)) bad('tokens.input and tokens.output must be counts or null');
  if (!isCount(record.sessions)) bad('sessions must be a count');
  if (!(typeof record.duration_s === 'number' && record.duration_s >= 0)) bad('duration_s must be a number of seconds');
  if (typeof record.judgement !== 'string' || !record.judgement.trim()) bad('judgement (own inspection of the result) is missing');
  if (record.change !== undefined && !CHANGES.includes(record.change)) bad(`change must be one of ${CHANGES.join(', ')}`);
  if (failed(record)) {
    const f = record.failure;
    if (!f || !['pipeline', 'model'].includes(f.class)) bad('failure lacks a class (pipeline or model)');
    else if (f.class === 'pipeline' && !AREAS.includes(f.area)) bad(`pipeline failure lacks an area (${AREAS.join(', ')})`);
    else if (f.class === 'model' && f.area !== undefined && f.area !== null) bad('a model failure has no pipeline area');
    if (f && (typeof f.evidence !== 'string' || !f.evidence.trim() || /\n/.test(f.evidence) || f.evidence.length > 300)) bad('failure evidence must be one line of at most 300 characters');
  } else if (record.failure) bad('a completed scenario has no failure');
  return problems;
}

export function resultProblems(results, manifest = loadManifest()) {
  if (!results || typeof results !== 'object' || !Array.isArray(results.scenarios)) return ['results: not an object with a scenarios array'];
  const problems = [];
  const ids = manifest.scenarios.map(s => s.id), seen = new Map();
  for (const record of results.scenarios) {
    if (!ids.includes(record?.id)) { problems.push(`${record?.id ?? '?'}: not a manifest scenario`); continue; }
    if (seen.has(record.id)) { problems.push(`${record.id}: more than one record`); continue; }
    seen.set(record.id, record);
    const scenario = manifest.scenarios.find(s => s.id === record.id);
    if (record.category !== scenario.category || record.kind !== scenario.kind) problems.push(`${record.id}: category or kind differs from the manifest`);
    problems.push(...recordProblems(record));
  }
  for (const id of ids) if (!seen.has(id)) problems.push(`${id}: no result`);
  if (!problems.length) {
    const expected = summarizeRecords(ids.map(id => seen.get(id)));
    if (JSON.stringify(results.summary) !== JSON.stringify(expected)) problems.push(`summary does not match the records; expected ${JSON.stringify(expected)}`);
  }
  if (ABSOLUTE_PATH.test(JSON.stringify(results))) problems.push('results hold an absolute local path; commit relative or anonymized references only');
  return problems;
}

function main([label]) {
  if (!LABELS.includes(label)) { console.error(`usage: node test/stress/verify-results.mjs ${LABELS.join('|')}`); return 2; }
  const path = resultsFile(label);
  if (!existsSync(path)) { console.error(`${label}: ${path} does not exist`); return 1; }
  let results;
  try { results = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { console.error(`${label}: not valid JSON (${error.message})`); return 1; }
  const problems = resultProblems(results);
  for (const line of problems) console.error(line);
  if (!problems.length) console.log(`${label}: ${results.scenarios.length} scenarios, completion ${results.summary.completion_rate}%, ${results.summary.failures.pipeline} pipeline and ${results.summary.failures.model} model failures`);
  return problems.length ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = main(process.argv.slice(2));
