// test/tools-medicao.test.mjs (T1, docs/forja/TECHNOLOGY.md S6, D31): os
// seis scripts de medição em tools/ correm sobre uma fixture .jsonl escrita
// numa pasta temporária (padrão de test/medir-contexto.test.mjs) — nunca
// sobre sessões reais desta máquina, para a suite nunca depender do que
// está em ~/.claude/projects nem em qualquer repositório de outro projeto.
// (Chamado "tools-medicao", não "token-tools": este repositório ignora
// qualquer ficheiro cujo nome contenha "token" — `.gitignore` linha 13 — por
// ser o padrão de segurança contra credenciais; nada aqui é um segredo, só
// o nome tinha de mudar.)
//
// Critério de aceitação 4: usage.mjs devolve a soma esperada de
// message.usage; par3.mjs devolve a média de ferramentas por jogada
// agrupada por message.id — nunca por linha do ficheiro (contar linhas dá
// sempre 1,00 e está errado: a fixture abaixo tem duas linhas com o mesmo
// message.id, cada uma com uma chamada de ferramenta, para provar a
// diferença).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'forja-token-tools-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const sandbox = () => { const d = join(root, `s${++n}`); mkdirSync(d, { recursive: true }); return d; };
const writeJsonl = (dir, name, lines) => writeFileSync(join(dir, name), lines.map(l => JSON.stringify(l)).join('\n') + '\n');

const { aggregateUsage } = await import('../tools/usage.mjs');
const { collectFirstRequests, windowStats } = await import('../tools/first.mjs');
const { computeMainContent } = await import('../tools/content.mjs');
const { computeSubagentContent } = await import('../tools/subcontent.mjs');
const { collectSessionUsage, loadRuns, aggregateByRun } = await import('../tools/perrun.mjs');
const { turnsPerPlay } = await import('../tools/par3.mjs');

describe('usage.mjs — aggregateUsage (critério 4: soma esperada de message.usage)', () => {
  test('soma input/cache_creation/cache_read/output por ficheiro, main e side separados', async () => {
    const dir = sandbox();
    writeJsonl(dir, 'a.jsonl', [
      { timestamp: '2026-09-20T10:00:00.000Z', message: { model: 'claude-x', usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 20 } } },
      { timestamp: '2026-09-20T10:00:01.000Z', message: { model: 'claude-x', usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 200, output_tokens: 8 } } },
      { timestamp: '2026-09-20T10:00:02.000Z', isSidechain: true, message: { model: 'claude-x', usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } },
      { timestamp: '2026-09-20T10:00:03.000Z', message: { role: 'user', content: 'sem usage, ignorada' } },
    ]);
    const out = await aggregateUsage(dir);
    assert.equal(out.length, 1);
    const [agg] = out;
    assert.equal(agg.file, 'a.jsonl');
    assert.equal(agg.nReq, 2);
    assert.equal(agg.nSide, 1);
    assert.deepEqual(agg.main['claude-x'], { in: 150, cc: 10, cr: 205, out: 28, n: 2 });
    assert.deepEqual(agg.side['claude-x'], { in: 7, cc: 0, cr: 0, out: 1, n: 1 });
  });

  test('--from/--to filtram por timestamp (linhas fora da janela não entram na soma)', async () => {
    const dir = sandbox();
    writeJsonl(dir, 'b.jsonl', [
      { timestamp: '2026-09-20T09:00:00.000Z', message: { model: 'm', usage: { input_tokens: 1000 } } },
      { timestamp: '2026-09-20T10:00:00.000Z', message: { model: 'm', usage: { input_tokens: 3 } } },
      { timestamp: '2026-09-20T11:00:00.000Z', message: { model: 'm', usage: { input_tokens: 9000 } } },
    ]);
    const withoutWindow = await aggregateUsage(dir);
    assert.equal(withoutWindow[0].main['m'].in, 10003, 'sem janela, conta tudo (comportamento original)');
    const withWindow = await aggregateUsage(dir, { from: '2026-09-20T09:30', to: '2026-09-20T10:30' });
    assert.equal(withWindow[0].main['m'].in, 3, 'com janela, só a linha das 10:00 entra');
  });
});

describe('first.mjs — primeira mensagem e primeiro usage por sessão', () => {
  test('encontra a primeira mensagem de utilizador e o primeiro usage, ordena por timestamp', async () => {
    const dir = sandbox();
    writeJsonl(dir, '11111111-aaaa-bbbb-cccc-000000000001.jsonl', [
      { timestamp: '2026-09-20T12:00:00.000Z', message: { role: 'user', content: 'ola mundo' } },
      { timestamp: '2026-09-20T12:00:01.000Z', message: { model: 'claude-x', usage: { input_tokens: 40000, cache_creation_input_tokens: 30000, cache_read_input_tokens: 0 } } },
    ]);
    writeJsonl(dir, '22222222-aaaa-bbbb-cccc-000000000002.jsonl', [
      { timestamp: '2026-09-20T11:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'ab' }] } },
      { timestamp: '2026-09-20T11:00:01.000Z', message: { model: 'claude-x', usage: { input_tokens: 20000, cache_creation_input_tokens: 10000, cache_read_input_tokens: 0 } } },
    ]);
    const rows = await collectFirstRequests(dir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, '22222222', 'ordenado por timestamp, a sessão das 11h vem primeiro');
    assert.equal(rows[0].uchars, 2);
    assert.equal(rows[1].id, '11111111');
    assert.equal(rows[1].uchars, 9);
    const stats = windowStats(rows, { from: '2026-09-20T10:00', to: '2026-09-20T13:00' });
    assert.equal(stats.win.length, 2);
    assert.equal(stats.avgCc, 20000);
    assert.equal(windowStats(rows, {}), null, 'sem --from/--to não há bloco de janela');
  });
});

describe('content.mjs / subcontent.mjs — caracteres por ferramenta e por ficheiro lido', () => {
  const sessionLines = (toolResultLen) => [
    { timestamp: '2026-09-20T13:00:00.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a pensar' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:\\proj\\docs\\forja\\TASKS.json' } }] } },
    { timestamp: '2026-09-20T13:00:01.000Z', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(toolResultLen) }] } },
  ];

  test('computeMainContent soma chars do assistente e agrupa tool_result por ficheiro lido', async () => {
    const dir = sandbox();
    writeJsonl(dir, 'main.jsonl', sessionLines(500));
    const r = await computeMainContent(dir);
    assert.equal(r.nSessions, 1);
    assert.equal(r.nToolRes, 1);
    assert.equal(r.assistantChars, 'a pensar'.length + JSON.stringify({ file_path: 'C:\\proj\\docs\\forja\\TASKS.json' }).length);
    assert.equal(r.userChars, 0, 'content.mjs não soma tool_result ao total de userChars (diferença real face a subcontent.mjs)');
    assert.equal(r.byReadFile['forja/TASKS.json'], 500);
  });

  test('--exclude tira um ficheiro do total por inteiro', async () => {
    const dir = sandbox();
    writeJsonl(dir, 'skip-me.jsonl', sessionLines(999));
    const r = await computeMainContent(dir, { exclude: ['skip-me'] });
    assert.equal(r.nSessions, 0);
    assert.deepEqual(r.byReadFile, {});
  });

  test('computeSubagentContent só conta ficheiros dentro de subagents/, e soma tool_result a userChars', async () => {
    const dir = sandbox();
    const subDir = join(dir, '33333333-aaaa-bbbb-cccc-000000000003', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeJsonl(subDir, 'agent-1.jsonl', sessionLines(700));
    writeJsonl(dir, 'not-a-subagent.jsonl', sessionLines(700)); // fora de subagents/, tem de ficar de fora
    const r = await computeSubagentContent(dir);
    assert.equal(r.nS, 1);
    assert.equal(r.userChars, 700, 'subcontent.mjs soma o comprimento do tool_result a userChars');
    assert.equal(r.byRead['forja/TASKS.json'], 700);
  });
});

describe('perrun.mjs — agrupar tokens por run a partir de docs/forja/archive', () => {
  test('aggregateByRun soma cc/cr/out das sessões cujo timestamp cai dentro de cada run', async () => {
    const sessDir = sandbox();
    writeJsonl(sessDir, 'run1-session.jsonl', [{ timestamp: '2026-09-20T08:00:00.000Z', message: { usage: { cache_creation_input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 5 } } }]);
    writeJsonl(sessDir, 'run2-session.jsonl', [{ timestamp: '2026-09-21T08:00:00.000Z', message: { usage: { cache_creation_input_tokens: 400, cache_read_input_tokens: 40, output_tokens: 9 } } }]);
    const archiveDir = sandbox();
    writeFileSync(join(archiveDir, 'R-1.json'), JSON.stringify({ run: { run_id: 'R-1', started_at: '2026-09-20T00:00:00.000Z', finished_at: '2026-09-20T23:59:59.000Z' }, tasks: [{}, {}] }));
    writeFileSync(join(archiveDir, 'R-2.json'), JSON.stringify({ run: { run_id: 'R-2', started_at: '2026-09-21T00:00:00.000Z', finished_at: '2026-09-21T23:59:59.000Z' }, tasks: [{}] }));
    const sess = await collectSessionUsage(sessDir);
    const runs = loadRuns(archiveDir);
    const agg = aggregateByRun(sess, runs);
    assert.equal(agg.rows.length, 2);
    assert.equal(agg.rows[0].id, 'R-1');
    assert.equal(agg.rows[0].cc, 100);
    assert.equal(agg.rows[1].cc, 400);
    assert.equal(agg.avgInputTotal, (100 + 10 + 400 + 40) / 2);
  });
});

describe('par3.mjs — turnsPerPlay agrupa por message.id, nunca por linha (critério 4)', () => {
  test('duas linhas com o mesmo message.id e uma chamada de ferramenta cada contam como UMA jogada de 2 ferramentas, não duas de 1', async () => {
    const dir = sandbox();
    writeJsonl(dir, 'lead-session.jsonl', [
      { timestamp: '2026-09-20T14:00:00.000Z', type: 'assistant', message: { role: 'assistant', id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      { timestamp: '2026-09-20T14:00:01.000Z', type: 'assistant', message: { role: 'assistant', id: 'msg_1', content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: {} }] } },
    ]);
    const r = await turnsPerPlay(dir);
    assert.equal(r.lead.groups, 1, 'as duas linhas partilham message.id: é UMA jogada, não duas');
    assert.equal(r.lead.calls, 2);
    assert.equal(r.lead.avg, 2, 'média real: 2 ferramentas na única jogada');
    assert.notEqual(r.lead.avg, 1, 'contar por linha daria sempre 1,00 — é exatamente o erro que este critério proíbe');
  });

  test('subagents/ e lead são contados em separado, e --exclude só tira do grupo lead', async () => {
    const dir = sandbox();
    const subDir = join(dir, 'sess', 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeJsonl(subDir, 'agent.jsonl', [
      { timestamp: '2026-09-20T15:00:00.000Z', type: 'assistant', message: { role: 'assistant', id: 'sub_1', content: [{ type: 'tool_use', id: 's1', name: 'Bash', input: {} }] } },
    ]);
    writeJsonl(dir, 'interactive-session.jsonl', [
      { timestamp: '2026-09-20T15:00:00.000Z', type: 'assistant', message: { role: 'assistant', id: 'lead_1', content: [{ type: 'tool_use', id: 'l1', name: 'Bash', input: {} }, { type: 'tool_use', id: 'l2', name: 'Read', input: {} }] } },
    ]);
    const r = await turnsPerPlay(dir, { exclude: ['interactive-session'] });
    assert.equal(r.subagents.groups, 1);
    assert.equal(r.subagents.calls, 1);
    assert.equal(r.lead.groups, 0, 'a única sessão de topo está excluída');
  });

  test('--from/--to filtram jogadas fora da janela', async () => {
    const dir = sandbox();
    writeJsonl(dir, 'windowed.jsonl', [
      { timestamp: '2026-09-20T00:00:00.000Z', type: 'assistant', message: { role: 'assistant', id: 'early', content: [{ type: 'tool_use', id: 'e1', name: 'Bash', input: {} }] } },
    ]);
    const r = await turnsPerPlay(dir, { from: '2026-09-21T00:00:00.000Z' });
    assert.equal(r.lead.groups, 0, 'a única linha tem timestamp anterior a --from');
  });
});
