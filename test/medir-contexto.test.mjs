// tools/medir-contexto.mjs (T5, docs/forja/TECHNOLOGY.md S3): a guarda que
// recusa escrever fora da pasta temporária, a fixture de recurso (>= 60
// decisões), a extração da tabela de topo do TECHNOLOGY.md (regressão do
// bug do `$` com a flag `m`, que casa antes de QUALQUER linha em branco) e o
// determinismo (duas cópias independentes dão os mesmos números).
//
// FORJA_MEDIR_CORPUS aponta sempre para um caminho que não existe, para esta
// suite nunca depender de C:/Fixtures/User/crypto-radar existir nesta máquina e
// nunca lhe tocar (D11) — exercita sempre o caminho da fixture. O comando real
// contra o corpus do Sponsor foi corrido à mão e fica citado no relatório da
// task, não aqui.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'forja-medir-contexto-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

process.env.FORJA_MEDIR_CORPUS = join(root, 'no-such-corpus-here');

const {
  assertSandboxed, guardedWrite, buildFixtureDecisions, materializeCorpus,
  buildBeforeHandoverText, extractTechTopTable, decisionLinesOf, measure,
  runTwiceAndCompare, formatReport, SPONSOR_CORPUS,
} = await import('../tools/medir-contexto.mjs');

let n = 0;
const sandbox = () => join(root, `sandbox-${++n}`);

describe('assertSandboxed / guardedWrite — a guarda do critério 1', () => {
  test('lê FORJA_MEDIR_CORPUS em vez do corpus real, para esta suite nunca lhe tocar', () => {
    assert.equal(SPONSOR_CORPUS, process.env.FORJA_MEDIR_CORPUS);
    assert.equal(existsSync(SPONSOR_CORPUS), false);
  });

  test('escrita dentro da pasta temporária passa', () => {
    const s = sandbox();
    const p = guardedWrite(s, join(s, 'a', 'b.txt'), 'ola');
    assert.equal(existsSync(p), true);
    assert.equal(readFileSync(p, 'utf8'), 'ola');
  });

  test('escrita fora da pasta temporária recusa-se e diz porquê', () => {
    const s = sandbox();
    const outside = join(root, 'fora-do-sandbox.txt');
    assert.throws(() => guardedWrite(s, outside, 'x'), /recuso escrever fora da pasta temporária/);
    assert.equal(existsSync(outside), false);
  });

  test('assertSandboxed aceita a própria raiz do sandbox, não só ficheiros dentro dela', () => {
    const s = sandbox();
    assert.doesNotThrow(() => assertSandboxed(s, s, 'usar'));
  });
});

describe('a fixture de recurso (critério 1: ">= 60 decisões" quando o corpus real não existe)', () => {
  test('tem pelo menos 60 decisões, formatadas como o corpo real de DECISIONS.md', () => {
    const text = buildFixtureDecisions();
    const lines = decisionLinesOf(text);
    assert.ok(lines.length >= 60, `esperava >= 60, tem ${lines.length}`);
    assert.match(lines[0], /^- \*\*D1\*\* · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · .+ — .+ Reversível: (sim|não)\.$/);
  });

  test('é determinística: duas chamadas dão o mesmo texto byte a byte', () => {
    assert.equal(buildFixtureDecisions(), buildFixtureDecisions());
  });

  test('materializeCorpus usa a fixture quando o corpus real não existe e regista qual usou', () => {
    const s = sandbox();
    const { source, sourcePath, docsForjaDir } = materializeCorpus(s);
    assert.equal(source, 'fixture');
    assert.equal(sourcePath, null);
    assert.ok(existsSync(join(docsForjaDir, 'DECISIONS.md')));
    assert.ok(existsSync(join(docsForjaDir, 'TASKS.json')));
    assert.ok(existsSync(join(docsForjaDir, 'RUN.json')));
    assert.ok(existsSync(join(docsForjaDir, 'PRODUCT-PROFILE.md')));
    assert.ok(existsSync(join(docsForjaDir, 'TECHNOLOGY.md')));
    // D11 / critério 1: nada disto pode ter saído da pasta temporária.
    assert.ok(docsForjaDir.startsWith(s));
  });
});

describe('buildBeforeHandoverText — reconstrução do HANDOVER pré-T3 (git show d7fc146)', () => {
  test('troca só a secção "## Últimas decisões" por .slice(-10), sem a linha de contagem', () => {
    const decisions = Array.from({ length: 14 }, (_, i) => `- **D${i + 1}** · 2026-09-10 08:00 · Product Manager · run R-X — decisão ${i + 1} Reversível: sim.`).join('\n') + '\n';
    const after = [
      '# Handover — projeto',
      '',
      '## Run R-X — doing',
      '- Objetivo: x',
      '',
      '## Tasks',
      '- T1 [done] x',
      '',
      '## Próxima ação exata',
      'nada',
      '',
      '## Fila do Sponsor (0 abertas)',
      '(nenhuma pergunta aberta)',
      '',
      '## Últimas decisões',
      '- **D10** · 2026-09-10 08:00 · Product Manager · run R-X — decisão 10 Reversível: sim.',
      '- **D11** · 2026-09-10 08:00 · Product Manager · run R-X — decisão 11 Reversível: sim.',
      '- **D12** · 2026-09-10 08:00 · Product Manager · run R-X — decisão 12 Reversível: sim.',
      '- **D13** · 2026-09-10 08:00 · Product Manager · run R-X — decisão 13 Reversível: sim.',
      '- **D14** · 2026-09-10 08:00 · Product Manager · run R-X — decisão 14 Reversível: sim.',
      '_(mais 9 decisões em docs/forja/DECISIONS.md)_',
      '',
    ].join('\n') + '\n';
    const before = buildBeforeHandoverText(after, decisions);
    // Everything above "## Últimas decisões" is byte-identical (D9: T3 only
    // ever touched the decisions section).
    const prefixEnd = after.indexOf('## Últimas decisões');
    assert.equal(before.slice(0, prefixEnd), after.slice(0, prefixEnd));
    // The old .slice(-10): D5..D14, ten lines, no omitted-count line.
    for (let i = 5; i <= 14; i++) assert.ok(before.includes(`decisão ${i} `), `falta a decisão ${i}`);
    assert.ok(!before.includes('decisão 4 '), 'D4 devia ficar de fora do .slice(-10)');
    assert.ok(!before.includes('(mais'), 'a linha de contagem só existe depois de T3');
    assert.ok(before.length > after.length, 'o "antes" tem de ser mais comprido do que o "depois" (10 decisões > 5)');
  });
});

describe('extractTechTopTable — regressão: uma linha em branco a seguir ao cabeçalho não corta a tabela', () => {
  test('lê até ao próximo "## ", mesmo com a tabela cheia de linhas em branco internas', () => {
    const text = [
      '# Tecnologia',
      '',
      '## Decisões em vigor',
      '',
      'Lê esta tabela primeiro.',
      '',
      '| Capacidade | Escolha | Secção |',
      '|---|---|---|',
      '| a | b | S1 |',
      '',
      '## Outra secção completa',
      '',
      'texto que NUNCA pode entrar na tabela de topo',
    ].join('\n') + '\n';
    const table = extractTechTopTable(text);
    assert.ok(table.includes('| a | b | S1 |'), 'a linha da tabela tem de estar lá');
    assert.ok(!table.includes('Outra secção completa'), 'não pode ultrapassar o próximo cabeçalho');
    assert.ok(!table.includes('NUNCA'), 'não pode ultrapassar o próximo cabeçalho');
  });

  test('ficheiro sem "## Decisões em vigor" devolve string vazia, nunca uma exceção', () => {
    assert.equal(extractTechTopTable('# nada aqui\n'), '');
  });
});

describe('measure() e determinismo (critério 3)', () => {
  test('measure() sobre a fixture: HANDOVER e leitura de decisões mais curtos depois de T1–T3', () => {
    const s = sandbox();
    const m = measure(s);
    assert.equal(m.source, 'fixture');
    assert.ok(m.handover.after < m.handover.before, 'HANDOVER depois de T3 tem de ser mais curto');
    assert.ok(m.decisionsPlan.indexOnlyAfter < m.decisionsPlan.wholeFileBefore, 'o índice tem de ser mais curto que o ficheiro inteiro');
    assert.ok(m.perTask.after < m.perTask.before, 'o estado por task tem de encolher');
    assert.ok(m.decisionCount >= 60);
  });

  test('duas cópias independentes da mesma fixture dão exatamente os mesmos números', () => {
    const result = runTwiceAndCompare({ keepTmp: false });
    assert.equal(result.source, 'fixture');
    assert.ok(formatReport(result).includes('caracteres'));
  });
});
