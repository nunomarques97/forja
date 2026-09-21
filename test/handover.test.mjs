// HANDOVER.md's "## Últimas decisões" section (T3, docs/forja/TECHNOLOGY.md S3,
// run R-20260920-c2b7): the 5 most recent decisions in full, a count-and-path
// line for the rest, and D9's invariant that the other sections never move.
// Run: node --test test/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureBefore = join(here, 'fixtures', 'handover-t3-before.md');

// The env vars every state-files.mjs function reads project/data location
// from. Tests in this file run sequentially (node:test default concurrency is
// 1 within a file), so mutating them between describe blocks is safe.
const root = mkdtempSync(join(tmpdir(), 'forja-handover-test-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function project() {
  const dir = join(root, `p${++n}`);
  mkdirSync(join(dir, 'docs', 'forja'), { recursive: true });
  process.env.FORJA_PROJECT_ROOT = dir;
  process.env.FORJA_DATA_DIR = join(root, `p${n}-data`);
  return dir;
}

// Imported once the env vars exist is not required (the module reads them
// lazily, at call time, via projectRoot()/dataDir()), so a single static
// import at the top of the file is fine.
const {
  writeRun, writeTasks, writeHandover, decisionsPath, queuePath, handoverPath,
  recentDecisionLines, DECISIONS_HEADER, QUEUE_HEADER, withDecisionsIndex, DECISIONS_INDEX_START, DECISIONS_INDEX_END,
} = await import('../lib/state-files.mjs');

// Same run/tasks/queue/decisions as test/fixtures/handover-t3-before.md was
// captured from (scratch script run against the code BEFORE this task's
// change): 12 decisions, a task in each status, one open Sponsor question.
function buildFixtureState() {
  const run = {
    run_id: 'R-FIXTURE-T3',
    project: 'fixture-project',
    goal: 'Testar o handover com um estado fixo de doze decisões.',
    status: 'running',
    model_floor: 'fable',
    forjalvl: 'high',
    autonomy: 'normal',
    driver: 'runner',
    driver_since: '2026-09-01T09:00:00.000Z',
    driver_request: null,
    started_at: '2026-09-01T10:00:00.000Z',
    sessions: ['sess-aaaa-1111', 'sess-bbbb-2222'],
    checkpoints: [
      { ts: '2026-09-01T11:00:00.000Z', note: 'plano inicial' },
      { ts: '2026-09-01T12:00:00.000Z', note: 'T1 done' },
    ],
    fallbacks: [],
  };
  writeRun(run);
  const tasks = [
    { id: 'T1', title: 'Primeira task', owner: 'backend-dev', complexity: 'medium', status: 'done', attempts: 1, after: null },
    { id: 'T2', title: 'Segunda task, em curso', owner: 'backend-dev', complexity: 'hard', status: 'doing', attempts: 2, why: 'REJECT do Reviewer: faltava teste', after: 'T1' },
    { id: 'T3', title: 'Terceira task, à espera de T2', owner: 'frontend-dev', complexity: 'easy', status: 'todo', attempts: 0, after: 'T2' },
    { id: 'T4', title: 'Quarta task, sem dependências', owner: 'backend-dev', complexity: 'medium', status: 'todo', attempts: 0, after: null },
  ];
  writeTasks(tasks);
  const roles = ['Architect', 'Backend Dev', 'Frontend Dev', 'Reviewer', 'Product Manager'];
  let body = DECISIONS_HEADER;
  for (let i = 1; i <= 12; i++) {
    const role = roles[(i - 1) % roles.length];
    const date = `2026-09-${String((i % 28) + 1).padStart(2, '0')} 0${i % 9}:0${i % 6}`;
    body += `- **D${i}** · ${date} · ${role} · run R-FIXTURE-T3 — Decisão de teste número ${i}, texto completo do corpo, nunca um resumo, para provar que a secção final traz o texto na íntegra. Porquê: só para o teste número ${i}. Reversível: ${i % 2 === 0 ? 'sim' : 'não'}.\n`;
  }
  writeFileSync(decisionsPath(), body);
  writeFileSync(queuePath(), QUEUE_HEADER + '## Q1 — Uma pergunta de teste para o Sponsor?\nEstado: aberta\nAberta em: 2026-09-01 10:30\nRun: R-FIXTURE-T3\nDefault aplicado: default de teste\nPorquê só o Sponsor: só para o teste\nResposta:\n\n');
  return { run, tasks, decisionText: body };
}

// The span the D9 invariant covers: run header through the end of "Fila do
// Sponsor", i.e. everything up to (not including) "## Últimas decisões". This
// excludes the "Gerado automaticamente em <hora atual>" line above it, which
// is wall-clock time and was never part of the invariant.
const invariantSpan = text => text.slice(text.indexOf('## Run'), text.indexOf('## Últimas decisões')).replace(/\r\n/g, '\n');

describe('D9 — Tasks / Próxima ação exata / Fila do Sponsor / cabeçalho do run: byte-identical to the fixture captured before this task', () => {
  test('same state as the "before" fixture produces the same bytes in every section except Últimas decisões', () => {
    project();
    buildFixtureState();
    writeHandover('checkpoint de teste');
    const after = readFileSync(handoverPath(), 'utf8');
    const before = readFileSync(fixtureBefore, 'utf8');
    assert.equal(invariantSpan(after), invariantSpan(before));
  });
});

describe('">= 12 decisões" — 5 lines, correct count, identical text to the last 5 corpo lines', () => {
  test('the handover shows exactly 5 decisions, verbatim, plus the count-and-path line', () => {
    project();
    const { decisionText } = buildFixtureState();
    writeHandover();
    const text = readFileSync(handoverPath(), 'utf8');
    const section = text.slice(text.indexOf('## Últimas decisões'));
    const shown = section.split('\n').filter(l => l.startsWith('- **D'));
    assert.equal(shown.length, 5, 'exactly 5 decision lines');
    const last5FromDisk = recentDecisionLines(decisionText).slice(-5);
    assert.deepEqual(shown, last5FromDisk, 'identical, verbatim, to the 5 last decision lines of DECISIONS.md');
    // 12 decisions on disk, 5 shown: 7 left out.
    assert.match(section, /_\(mais 7 decisões em docs\/forja\/DECISIONS\.md\)_/);
  });

  test('the count-and-path line is the accessibility proof (criterion 4): it exists and names the real path', () => {
    project();
    buildFixtureState();
    writeHandover();
    const text = readFileSync(handoverPath(), 'utf8');
    assert.match(text, /mais \d+ decis(õ|o)es em docs\/forja\/DECISIONS\.md/);
  });
});

describe('n = 0 (5 or fewer decisions on disk): no count line', () => {
  test('exactly 5 decisions on disk: all 5 shown, no "(mais …)" line', () => {
    project();
    const run = { run_id: 'R-N0', project: 'p', status: 'running', model_floor: 'fable', started_at: '2026-09-01T10:00:00.000Z', sessions: [], checkpoints: [] };
    writeRun(run);
    writeTasks([]);
    let body = DECISIONS_HEADER;
    for (let i = 1; i <= 5; i++) body += `- **D${i}** · 2026-09-0${i} 00:00 · Backend Dev · run R-N0 — Decisão ${i}. Porquê: teste. Reversível: sim.\n`;
    writeFileSync(decisionsPath(), body);
    writeFileSync(queuePath(), QUEUE_HEADER);
    writeHandover();
    const text = readFileSync(handoverPath(), 'utf8');
    const section = text.slice(text.indexOf('## Últimas decisões'));
    assert.equal(section.split('\n').filter(l => l.startsWith('- **D')).length, 5);
    assert.equal(/_\(mais/.test(section), false, 'no count line when nothing was left out');
  });

  test('fewer than 5 decisions: all shown, still no count line', () => {
    project();
    writeRun({ run_id: 'R-N0B', project: 'p', status: 'running', model_floor: 'fable', started_at: '2026-09-01T10:00:00.000Z', sessions: [], checkpoints: [] });
    writeTasks([]);
    writeFileSync(decisionsPath(), DECISIONS_HEADER + '- **D1** · 2026-09-01 00:00 · Backend Dev · run R-N0B — Uma decisão só. Porquê: teste. Reversível: sim.\n');
    writeFileSync(queuePath(), QUEUE_HEADER);
    writeHandover();
    const section = readFileSync(handoverPath(), 'utf8');
    assert.equal(section.split('\n').filter(l => l.startsWith('- **D')).length, 1);
    assert.equal(/_\(mais/.test(section), false);
  });

  test('no decisions at all: "(nenhuma)", no count line', () => {
    project();
    writeRun({ run_id: 'R-NONE', project: 'p', status: 'running', model_floor: 'fable', started_at: '2026-09-01T10:00:00.000Z', sessions: [], checkpoints: [] });
    writeTasks([]);
    writeFileSync(decisionsPath(), DECISIONS_HEADER);
    writeFileSync(queuePath(), QUEUE_HEADER);
    writeHandover();
    const text = readFileSync(handoverPath(), 'utf8');
    const section = text.slice(text.indexOf('## Últimas decisões'));
    assert.match(section, /\(nenhuma\)/);
    assert.equal(/_\(mais/.test(section), false);
  });
});

describe('extractor never reads a forja:index block (T1 format)', () => {
  test('a DECISIONS.md with a real index block on top still yields only corpo decision lines in the handover', () => {
    project();
    writeRun({ run_id: 'R-IDX', project: 'p', status: 'running', model_floor: 'fable', started_at: '2026-09-01T10:00:00.000Z', sessions: [], checkpoints: [] });
    writeTasks([]);
    let body = DECISIONS_HEADER;
    for (let i = 1; i <= 8; i++) body += `- **D${i}** · 2026-09-0${i} 0${i % 9}:00 · Backend Dev · run R-IDX — Decisão número ${i} com texto suficiente para o índice cortar o título em setenta caracteres, se for preciso. Porquê: teste. Reversível: sim.\n`;
    const withBlock = withDecisionsIndex(body);
    assert.ok(withBlock.includes(DECISIONS_INDEX_START), 'sanity: the fixture really has a real index block');
    assert.notEqual(withBlock, body);
    writeFileSync(decisionsPath(), withBlock);
    writeFileSync(queuePath(), QUEUE_HEADER);
    writeHandover();
    const text = readFileSync(handoverPath(), 'utf8');
    const section = text.slice(text.indexOf('## Últimas decisões'));
    assert.equal(section.split('\n').filter(l => l.startsWith('- **D')).length, 5, 'still 5 corpo decisions, not index rows');
    assert.equal(/^\| D\d+ \|/m.test(section), false, 'no index table row leaked in');
    assert.equal(section.includes(DECISIONS_INDEX_START) || section.includes(DECISIONS_INDEX_END), false, 'no marker leaked in');
    assert.equal(section.includes('Lê esta tabela primeiro'), false, 'the index instruction line is not a decision');
    assert.match(section, /_\(mais 3 decisões em docs\/forja\/DECISIONS\.md\)_/, '8 on disk, 5 shown, 3 left out — the index block does not count as a decision');
  });
});
