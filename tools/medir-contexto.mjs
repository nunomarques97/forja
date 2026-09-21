#!/usr/bin/env node
// `node tools/medir-contexto.mjs` — T5 (docs/forja/TECHNOLOGY.md S3): medição
// antes/depois, em caracteres, do custo de contexto que T1–T3 já mudaram
// (índice no topo de DECISIONS.md, HANDOVER.md com só as 5 últimas decisões).
//
// Corpus: FORJA_MEDIR_CORPUS ou data/context-corpus dentro deste checkout.
// A fonte é só lida: copiada para uma pasta de os.tmpdir() e medida
// sobre a cópia. Se não existir, gera uma fixture equivalente (>= 60 decisões)
// e diz qual dos dois usou. Todas as escritas — a cópia, o HANDOVER.md
// regenerado, o índice regenerado — ficam dentro dessa pasta temporária;
// `guardedWrite`/`assertSandboxed` recusam-se e dizem porquê se alguma vez uma
// escrita tentasse sair dali. `FORJA_PROJECT_ROOT` aponta para a cópia; nunca
// mexe em `stateDir()` deste repositório (lib/state-files.mjs `projectRoot`
// lê o env a cada chamada, nunca em cache).
//
// Determinismo (critério 3): corre a medição duas vezes, em duas cópias
// independentes da mesma fonte, e compara os números — mesma fonte, mesmos
// números, sempre. No fim apaga as duas pastas temporárias (ou, com
// `--keep-tmp`, mantém-nas e imprime os caminhos).
//
// Zero dependências novas (decisão S3 em docs/forja/TECHNOLOGY.md): só
// node:fs, node:path, node:os, node:child_process, node:assert.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  decisionsPath, handoverPath, stateDir, tasksPath, readTasks,
  reindexDecisionsFile, buildDecisionsIndex, recentDecisionLines, writeHandover,
  DECISIONS_HEADER, QUEUE_HEADER,
} from '../lib/state-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const FORJA_ROOT = resolve(here, '..');
export const BIN = join(FORJA_ROOT, 'bin', 'forja.mjs');
// Um corpus externo exige configuração explícita; sem fonte, usa a fixture.
export const SPONSOR_CORPUS = process.env.FORJA_MEDIR_CORPUS || join(FORJA_ROOT, 'data', 'context-corpus');
export const DECISION_LINE_RE = /^- \*\*D\d+\*\*/;

// ---------- the guard (critério 1: "recusa-se a escrever fora da pasta
// temporária e diz porquê") ----------
export function assertSandboxed(sandboxRoot, targetPath, what) {
  const abs = resolve(targetPath);
  const base = resolve(sandboxRoot) + sep;
  if (abs !== resolve(sandboxRoot) && !abs.startsWith(base)) {
    throw new Error(`medir-contexto: recuso ${what || 'escrever'} fora da pasta temporária — ${abs} não está dentro de ${sandboxRoot}`);
  }
  return abs;
}
export function guardedWrite(sandboxRoot, targetPath, content) {
  const abs = assertSandboxed(sandboxRoot, targetPath, 'escrever');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}
export function guardedCopy(sandboxRoot, src, dest) {
  assertSandboxed(sandboxRoot, dest, 'copiar para');
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true }); // src is read-only here — nothing is ever written back to it
}

// ---------- fixture (só quando o corpus real não existir) ----------
// Determinística de propósito (sem Math.random nem Date.now): a mesma fixture,
// byte a byte, em qualquer corrida — é o que o critério de determinismo (3)
// exige mesmo no caminho de recurso.
function fixtureDecisionLine(n) {
  const day = String(10 + (n % 18)).padStart(2, '0');
  const hh = String(8 + (n % 12)).padStart(2, '0');
  const mm = String((n * 7) % 60).padStart(2, '0');
  const roles = ['Product Manager', 'Architect', 'Technology Scout', 'Backend Dev', 'Frontend Dev'];
  const role = roles[n % roles.length];
  const reversible = n % 3 === 0 ? 'não' : 'sim';
  return `- **D${n}** · 2026-09-${day} ${hh}:${mm} · ${role} · run R-FIXTURE-0001 — Decisão sintética número ${n} da fixture de medição de T5: texto de exemplo com detalhe suficiente para imitar uma decisão real de um run do Forja, cobrindo contexto, opções comparadas e o resultado escolhido para a capacidade fictícia número ${n} deste corpus gerado. Porquê: motivo sintético determinístico da decisão ${n}, sem aleatoriedade nenhuma, para a medição ser sempre reprodutível byte a byte. Reversível: ${reversible}.`;
}
const FIXTURE_DECISION_COUNT = 65; // critério 1: ">= 60 decisões"
export function buildFixtureDecisions() {
  const lines = [];
  for (let n = 1; n <= FIXTURE_DECISION_COUNT; n++) lines.push(fixtureDecisionLine(n));
  return DECISIONS_HEADER + lines.join('\n') + '\n';
}
function fixtureTaskCriteria(n) {
  return `Critérios sintéticos da task fictícia ${n}, com detalhe suficiente para imitar uma task real (definição de done, âmbito, testes a correr) — gerado sem aleatoriedade para a medição ser reprodutível.`;
}
export function buildFixtureTasks() {
  const statuses = ['done', 'done', 'blocked', 'done', 'todo', 'done', 'blocked', 'done'];
  const tasks = statuses.map((status, i) => {
    const n = i + 1;
    return {
      id: `T${n}`, title: `Task fictícia ${n} da fixture de medição`, owner: n % 2 ? 'backend-dev' : 'frontend-dev',
      complexity: ['easy', 'medium', 'hard'][n % 3], criteria: fixtureTaskCriteria(n),
      after: n > 1 ? `T${n - 1}` : null, status, attempts: status === 'done' ? 1 : status === 'blocked' ? 2 : 0,
      created_at: '2026-09-10T08:00:00.000Z', updated_at: '2026-09-10T09:00:00.000Z',
      why: status === 'blocked' ? `bloqueada sinteticamente para a fixture (task ${n})` : null,
      verdicts: status === 'done' ? [{ ts: '2026-09-10T09:00:00.000Z', verdict: 'APPROVE', text: `APPROVE sintético da task ${n} — critérios cumpridos na fixture de medição.`, model_floor: 'fable', fallback_review: false }] : [],
      evidence: null,
    };
  });
  return JSON.stringify(tasks, null, 2) + '\n';
}
export function buildFixtureRun() {
  return JSON.stringify({
    run_id: 'R-FIXTURE-0001', project: 'fixture-medir-contexto', goal: 'Fixture determinística de medição para tools/medir-contexto.mjs (T5) — usada só quando o corpus real do Sponsor não existe neste disco.',
    status: 'doing', model_floor: 'fable', forjalvl: 'high', autonomy: 'normal', visible: false, driver: 'runner',
    started_at: '2026-09-10T08:00:00.000Z', sessions: ['fixture-session-1'],
    checkpoints: [{ ts: '2026-09-10T09:00:00.000Z', note: 'fixture' }], fallbacks: [], answers_applied: [], current_task: null,
    updated_at: '2026-09-10T09:00:00.000Z',
  }, null, 2) + '\n';
}
export function buildFixtureProfile() {
  return `# Perfil de produto — fixture de medição\n\nGerado por tools/medir-contexto.mjs (T5) só porque data/context-corpus não existe neste disco. Texto sintético do tamanho aproximado de um PRODUCT-PROFILE.md real, para a soma da composição "(c)" continuar comparável.\n\n## Para quem\n\nUtilizador primário sintético desta fixture, com o mesmo formato de secções de um perfil real: audiência, fasquia de qualidade, prioridades não funcionais por ordem, o que nunca fazer, decisões de produto já tomadas.\n\n## Fasquia de qualidade\n\nTexto de preenchimento determinístico, sem aleatoriedade, repetido o suficiente para o ficheiro ter um tamanho realista: verdade e evidência, nunca perder informação, custo de contexto, robustez sem supervisão, leitura em 5 segundos, dependências zero, acessibilidade e verificação visual real.\n\n## Prioridades não funcionais\n\n1. Verdade e evidência.\n2. Nunca perder informação.\n3. Custo de contexto medido em caracteres.\n4. Robustez sem supervisão.\n5. Leitura em 5 segundos, português simples.\n6. Zero dependências.\n7. Acessibilidade e verificação visual real.\n\n## O que nunca fazer\n\nNunca escrever fora do repositório; nunca instalar sem decisão registada; nunca publicar sem autorização; nunca um papel rever o próprio trabalho.\n`;
}
export function buildFixtureTechnology() {
  return `# Tecnologia — decisões vinculativas (fixture de medição)\n\nEscrito por tools/medir-contexto.mjs (T5) só porque o corpus real não existe neste disco. Formato idêntico ao TECHNOLOGY.md real: uma tabela de topo, depois uma secção por capacidade.\n\n## Decisões em vigor\n\nLê esta tabela primeiro; abre a secção completa só da capacidade de que a tua task precisa.\n\n| Capacidade | Escolha | Secção |\n|---|---|---|\n| Capacidade fictícia 1 | sem biblioteca — Node nativo | S1 |\n| Capacidade fictícia 2 | sem biblioteca — plataforma | S2 |\n\n## Capacidade fictícia 1 (S1)\n\nTexto sintético de uma secção completa, para provar que o extrator da tabela de topo para na próxima secção "## " e não lê isto.\n\n## Capacidade fictícia 2 (S2)\n\nOutro texto sintético de secção completa.\n`;
}
function buildFixtureQueue() {
  return QUEUE_HEADER;
}
export function generateFixtureCorpus(sandboxRoot, docsForjaDir) {
  guardedWrite(sandboxRoot, join(docsForjaDir, 'DECISIONS.md'), buildFixtureDecisions());
  guardedWrite(sandboxRoot, join(docsForjaDir, 'TASKS.json'), buildFixtureTasks());
  guardedWrite(sandboxRoot, join(docsForjaDir, 'RUN.json'), buildFixtureRun());
  guardedWrite(sandboxRoot, join(docsForjaDir, 'PRODUCT-PROFILE.md'), buildFixtureProfile());
  guardedWrite(sandboxRoot, join(docsForjaDir, 'TECHNOLOGY.md'), buildFixtureTechnology());
  guardedWrite(sandboxRoot, join(docsForjaDir, 'SPONSOR-QUEUE.md'), buildFixtureQueue());
}

// ---------- copiar o corpus (real, de preferência) para a sandbox ----------
export function materializeCorpus(sandboxRoot) {
  const projectRoot = join(sandboxRoot, 'project');
  const docsForjaDir = join(projectRoot, 'docs', 'forja');
  if (existsSync(SPONSOR_CORPUS)) {
    guardedCopy(sandboxRoot, SPONSOR_CORPUS, docsForjaDir);
    return { projectRoot, docsForjaDir, source: 'real', sourcePath: SPONSOR_CORPUS };
  }
  mkdirSync(docsForjaDir, { recursive: true });
  generateFixtureCorpus(sandboxRoot, docsForjaDir);
  return { projectRoot, docsForjaDir, source: 'fixture', sourcePath: null };
}

// ---------- funções puras de medição ----------
// A composição do HANDOVER "antes" de T3 (git show d7fc146 — a única mudança
// foi a secção "## Últimas decisões": .slice(-10), sem a linha de contagem).
// Tudo o resto do ficheiro é byte a byte igual ao "depois", por isso a
// reconstrução parte do texto "depois" real e troca só essa secção.
export function buildBeforeHandoverText(afterText, decisionsText) {
  const marker = '## Últimas decisões';
  const idx = afterText.indexOf(marker);
  if (idx === -1) throw new Error('medir-contexto: HANDOVER.md gerado sem a secção "## Últimas decisões" — não devia acontecer');
  const prefix = afterText.slice(0, idx);
  const allLines = recentDecisionLines(decisionsText);
  const before10 = allLines.slice(-10);
  const body = (before10.length ? before10 : ['(nenhuma)']).join('\n');
  return `${prefix}${marker}\n${body}\n\n`;
}
// A tabela de topo do TECHNOLOGY.md: de "## Decisões em vigor" até ao próximo
// "## " (ou ao fim do ficheiro). Mesma extração que um Lead/Dev faz à mão.
// (Nota: um `$` com a flag `m` casa antes de QUALQUER quebra de linha, não só
// no fim do ficheiro — por isso a procura do próximo cabeçalho é feita à
// parte, nunca dentro de um "(?=…|$)" lazy, que pararia na primeira linha em
// branco da tabela.)
export function extractTechTopTable(text) {
  const str = String(text || '');
  const start = str.match(/^## Decisões em vigor[^\n]*\n/m);
  if (!start) return '';
  const from = start.index;
  const afterHeader = from + start[0].length;
  const rest = str.slice(afterHeader);
  const nextHeader = rest.match(/^## /m);
  const to = nextHeader ? afterHeader + nextHeader.index : str.length;
  return str.slice(from, to);
}
export function decisionLinesOf(text) {
  return String(text || '').split(/\r?\n/).filter(l => DECISION_LINE_RE.test(l));
}
function average(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; }

// `forja task show <id>` real, tal como uma sessão do Lead o lê — subprocesso
// só de leitura (bin/forja.mjs `task show`: "changes nothing and emits
// nothing"), com FORJA_PROJECT_ROOT a apontar para a cópia.
export function taskShowChars(projectRoot, id) {
  const r = spawnSync(process.execPath, [BIN, 'task', 'show', id], {
    cwd: projectRoot, encoding: 'utf8', env: { ...process.env, FORJA_PROJECT_ROOT: projectRoot },
  });
  if (r.status !== 0) throw new Error(`medir-contexto: "forja task show ${id}" falhou (status ${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout.replace(/\n$/, '').length;
}

// ---------- a medição completa, sobre uma cópia ----------
export function measure(sandboxRoot) {
  const { projectRoot, docsForjaDir, source, sourcePath } = materializeCorpus(sandboxRoot);
  const prevRoot = process.env.FORJA_PROJECT_ROOT;
  process.env.FORJA_PROJECT_ROOT = projectRoot;
  try {
    assertSandboxed(sandboxRoot, stateDir(), 'gerar estado em');

    // (b) decisões: DECISIONS.md inteiro vs. só o índice, vs. índice + 2 decisões
    const decisionsBeforeText = readFileSync(decisionsPath(), 'utf8');
    const decisionCount = decisionLinesOf(decisionsBeforeText).length;
    const reindexResult = reindexDecisionsFile(decisionsPath()); // escreve o índice na cópia, nunca no corpo
    const decisionsAfterText = readFileSync(decisionsPath(), 'utf8');
    const indexBlock = buildDecisionsIndex(decisionsAfterText);
    const lastTwoDecisions = decisionLinesOf(decisionsAfterText).slice(-2);
    const twoDecisionsChars = lastTwoDecisions.reduce((s, l) => s + l.length, 0);

    // (a) HANDOVER.md: código atual (depois de T3) vs. reconstrução do código antes de T3
    writeHandover(); // regenera sobre a cópia — dentro do sandbox, nunca em stateDir() deste repo
    const handoverAfterText = readFileSync(handoverPath(), 'utf8');
    const handoverBeforeText = buildBeforeHandoverText(handoverAfterText, decisionsAfterText);

    // (c) o estado que o Lead lê por task: HANDOVER + PRODUCT-PROFILE + tabela de topo do TECHNOLOGY + "task show" médio
    const profileText = readFileSync(join(docsForjaDir, 'PRODUCT-PROFILE.md'), 'utf8');
    const technologyText = readFileSync(join(docsForjaDir, 'TECHNOLOGY.md'), 'utf8');
    const techTopTable = extractTechTopTable(technologyText);
    const tasks = readTasks();
    const taskIds = tasks.map(t => t.id);
    const taskShowLens = taskIds.map(id => taskShowChars(projectRoot, id));
    const taskShowAvg = average(taskShowLens);

    const perTaskBefore = handoverBeforeText.length + profileText.length + techTopTable.length + taskShowAvg;
    const perTaskAfter = handoverAfterText.length + profileText.length + techTopTable.length + taskShowAvg;

    return {
      source, sourcePath, projectRoot,
      decisionCount, decisionsIndexEntries: reindexResult.count, decisionsIndexOverBudget: reindexResult.overBudget,
      taskCount: taskIds.length, taskIds, taskShowLens,
      handover: { before: handoverBeforeText.length, after: handoverAfterText.length },
      decisionsPlan: {
        wholeFileBefore: decisionsBeforeText.length,
        indexOnlyAfter: indexBlock.length,
        indexPlusTwoAfter: indexBlock.length + twoDecisionsChars,
        lastTwoDecisionIds: lastTwoDecisions.map(l => (l.match(/^- \*\*(D\d+)\*\*/) || [])[1] || '?'),
      },
      perTask: {
        before: perTaskBefore, after: perTaskAfter,
        handover: { before: handoverBeforeText.length, after: handoverAfterText.length },
        profile: profileText.length, techTopTable: techTopTable.length, taskShowAvg,
      },
    };
  } finally {
    if (prevRoot === undefined) delete process.env.FORJA_PROJECT_ROOT; else process.env.FORJA_PROJECT_ROOT = prevRoot;
  }
}

// ---------- impressão ----------
function fmt(n) { return Math.round(n).toLocaleString('pt-PT'); }
export function formatReport(m) {
  const lines = [];
  lines.push(`Corpus: ${m.source === 'real' ? m.sourcePath : '(fixture determinística — corpus real ausente neste disco)'} (${m.decisionCount} decisões, ${m.taskCount} tasks)`);
  lines.push('');
  lines.push('(a) HANDOVER.md gerado do mesmo estado');
  lines.push(`  antes (.slice(-10), código pré-T3) : ${fmt(m.handover.before)} caracteres`);
  lines.push(`  depois (5 últimas + contagem, T3)   : ${fmt(m.handover.after)} caracteres`);
  lines.push('');
  lines.push('(b) O que a fase PLAN lê de decisões');
  lines.push(`  antes — DECISIONS.md inteiro        : ${fmt(m.decisionsPlan.wholeFileBefore)} caracteres`);
  lines.push(`  depois — só o bloco de índice        : ${fmt(m.decisionsPlan.indexOnlyAfter)} caracteres`);
  lines.push(`  depois — índice + 2 decisões (${m.decisionsPlan.lastTwoDecisionIds.join(', ')}) : ${fmt(m.decisionsPlan.indexPlusTwoAfter)} caracteres`);
  lines.push('');
  lines.push('(c) Estado total que o Lead lê por task (HANDOVER + PRODUCT-PROFILE + tabela de topo do TECHNOLOGY + "task show" médio)');
  lines.push(`  antes : ${fmt(m.perTask.before)} caracteres`);
  lines.push(`  depois: ${fmt(m.perTask.after)} caracteres`);
  lines.push(`  composição: PRODUCT-PROFILE.md ${fmt(m.perTask.profile)} + tabela de topo TECHNOLOGY.md ${fmt(m.perTask.techTopTable)} + "task show" médio ${fmt(m.perTask.taskShowAvg)} (${m.taskCount} tasks) + HANDOVER.md`);
  return lines.join('\n');
}

// ---------- ponto de entrada ----------
export function runTwiceAndCompare({ keepTmp = false } = {}) {
  const roots = [];
  const results = [];
  for (let i = 0; i < 2; i++) {
    const root = mkdtempSync(join(tmpdir(), 'forja-medir-contexto-'));
    roots.push(root);
    results.push(measure(root));
  }
  const [a, b] = results;
  // Determinismo (critério 3): as duas cópias independentes têm de dar
  // exatamente os mesmos números — se não derem, isto tem de falhar alto,
  // nunca imprimir um número que não se pode repetir.
  assert.deepEqual(
    { handover: a.handover, decisionsPlan: a.decisionsPlan, perTask: a.perTask, decisionCount: a.decisionCount, taskCount: a.taskCount },
    { handover: b.handover, decisionsPlan: b.decisionsPlan, perTask: b.perTask, decisionCount: b.decisionCount, taskCount: b.taskCount },
    'medir-contexto: duas corridas independentes deram números diferentes — não é determinístico',
  );
  for (const root of roots) {
    if (keepTmp) console.log(`(pasta temporária mantida: ${root})`);
    else rmSync(root, { recursive: true, force: true });
  }
  return a;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const keepTmp = process.argv.includes('--keep-tmp');
  const result = runTwiceAndCompare({ keepTmp });
  console.log('medir-contexto: duas corridas independentes, mesmos números (determinístico).');
  console.log('');
  console.log(formatReport(result));
}
