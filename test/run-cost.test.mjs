// Custo do run lido das transcrições (T8, decisão S6 em
// docs/forja/TECHNOLOGY.md, docs/forja/technology/S6.md): resolveSessionsDir,
// sumSessionsUsage e computeRunCost/runTokenCostStep de lib/run-cost.mjs
// contra fixtures .jsonl numa pasta temporária (nunca contra sessões reais
// desta máquina), mais o ciclo `run checkpoint`/`run finish` pela CLI.
//
// Critério 7 (MEDIÇÃO): o teste "run checkpoint escreve token_usage… bate
// certo com `node tools/usage.mjs`" corre o script à mão (`spawnSync`) sobre a
// mesma fixture e compara byte a byte com o número escrito em RUN.json — é a
// mesma igualdade que o relatório desta task mostra.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'forja.mjs');
const usageScript = join(here, '..', 'tools', 'usage.mjs');
const root = mkdtempSync(join(tmpdir(), 'forja-run-cost-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const tmp = prefix => { const d = join(root, `${prefix}-${++n}`); mkdirSync(d, { recursive: true }); return d; };
const writeJsonl = (dir, name, lines) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), lines.map(l => JSON.stringify(l)).join('\n') + '\n'); };

process.env.FORJA_DATA_DIR = tmp('data-for-lib-tests');

const {
  resolveSessionsDir, sumSessionsUsage, computeRunCost, runTokenCostStep,
  COST_REASON, TOKEN_FIELDS,
} = await import('../lib/run-cost.mjs');

// Uma linha crua (sem JSON.stringify) para as fixtures hostis/malformadas:
// `1e999` e um JSON truncado não se escrevem com JSON.stringify.
const writeRaw = (dir, name, text) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), text); };

// ---------- resolveSessionsDir ----------
describe('resolveSessionsDir — a pasta de sessões do projeto em ~/.claude/projects, sem distinguir caixa', () => {
  test('encontra a pasta cujo nome é o caminho do projeto com tudo o que não é alfanumérico trocado por "-", em qualquer caixa', () => {
    const home = tmp('home');
    const slug = 'C--Fixtures-Ficticio-projeto'.toLowerCase();
    mkdirSync(join(home, '.claude', 'projects', slug), { recursive: true });
    assert.equal(resolveSessionsDir('C:/Fixtures/Ficticio/projeto', home), join(home, '.claude', 'projects', slug));
  });
  test('um projectRoot com separador final encontra a mesma pasta (nit 6: não devolve null em silêncio)', () => {
    const home = tmp('home');
    const slug = 'C--Fixtures-Ficticio-projeto';
    mkdirSync(join(home, '.claude', 'projects', slug), { recursive: true });
    const esperado = join(home, '.claude', 'projects', slug);
    assert.equal(resolveSessionsDir('C:/Fixtures/Ficticio/projeto', home), esperado);
    assert.equal(resolveSessionsDir('C:/Fixtures/Ficticio/projeto/', home), esperado, 'barra no fim');
    assert.equal(resolveSessionsDir('C:\\Fixtures\\Ficticio\\projeto\\', home), esperado, 'barra invertida no fim');
  });
  test('nunca sai de <home>/.claude/projects, mesmo com um projectRoot de travessia', () => {
    const home = tmp('home');
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    for (const mau of ['../../../Windows', String.raw`..\..\..\Windows`, '/etc/passwd', '..', '../'.repeat(20)]) {
      assert.equal(resolveSessionsDir(mau, home), null, mau);
    }
  });
  test('sem pasta correspondente, ou sem ~/.claude/projects: null, nunca uma exceção', () => {
    const home = tmp('home');
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    assert.equal(resolveSessionsDir('C:/Fixtures/Ficticio/outro-projeto', home), null);
    assert.equal(resolveSessionsDir('C:/qualquer', join(home, 'sem-claude-aqui')), null);
    assert.equal(resolveSessionsDir('', home), null);
  });
});

// ---------- sumSessionsUsage ----------
describe('sumSessionsUsage — soma message.usage do Lead e de subagents/, dentro da janela', () => {
  test('soma o ficheiro de topo (Lead) e o de subagents/, e deixa de fora uma sessão cujo mtime é anterior à janela', async () => {
    const dir = tmp('sess');
    writeJsonl(dir, 'lead1.jsonl', [
      { timestamp: '2026-09-20T10:00:00.000Z', message: { usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 20 } } },
      { timestamp: '2026-09-20T10:00:01.000Z', message: { usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 200, output_tokens: 8 } } },
    ]);
    writeJsonl(join(dir, 'lead1', 'subagents'), 'agent-a.jsonl', [
      { timestamp: '2026-09-20T10:05:00.000Z', isSidechain: true, message: { usage: { input_tokens: 7, cache_creation_input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 3 } } },
    ]);
    // Sessão antiga, doutro run: mtime E timestamps anteriores a `from`.
    writeJsonl(dir, 'old.jsonl', [{ timestamp: '2020-01-01T00:00:00.000Z', message: { usage: { input_tokens: 999999, cache_creation_input_tokens: 999999, cache_read_input_tokens: 999999, output_tokens: 999999 } } }]);
    const old = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(join(dir, 'old.jsonl'), old, old);

    const res = await sumSessionsUsage(dir, { from: '2026-09-20T00:00:00.000Z', to: '2026-09-20T23:59:59.000Z' });
    assert.equal(res.input_tokens, 100 + 50 + 7);
    assert.equal(res.cache_creation_input_tokens, 10 + 0 + 1);
    assert.equal(res.cache_read_input_tokens, 5 + 200 + 0);
    assert.equal(res.output_tokens, 20 + 8 + 3);
    assert.equal(res.truncated, false);
    assert.equal(res.filesRead, 2, 'lead1.jsonl + subagents/agent-a.jsonl — old.jsonl fica de fora pelo mtime');
  });

  test('--from/--to filtram por linha, como tools/usage.mjs (linhas fora da janela não entram)', async () => {
    const dir = tmp('sess');
    writeJsonl(dir, 'windowed.jsonl', [
      { timestamp: '2026-09-20T09:00:00.000Z', message: { usage: { input_tokens: 1000 } } },
      { timestamp: '2026-09-20T10:00:00.000Z', message: { usage: { input_tokens: 3 } } },
      { timestamp: '2026-09-20T11:00:00.000Z', message: { usage: { input_tokens: 9000 } } },
    ]);
    const res = await sumSessionsUsage(dir, { from: '2026-09-20T09:30:00.000Z', to: '2026-09-20T10:30:00.000Z' });
    assert.equal(res.input_tokens, 3);
  });

  test('limite de tamanho (maxTotalBytes) escrito no código: passado o orçamento, o resto fica de fora e truncated é true', async () => {
    const dir = tmp('sess');
    writeJsonl(dir, 'a.jsonl', [{ timestamp: '2026-09-20T10:00:00.000Z', message: { usage: { input_tokens: 10 } } }]);
    writeJsonl(dir, 'b.jsonl', [{ timestamp: '2026-09-20T10:00:01.000Z', message: { usage: { input_tokens: 20 } } }]);
    const sizeOfEach = readFileSync(join(dir, 'a.jsonl'), 'utf8').length;
    const res = await sumSessionsUsage(dir, { from: '2026-09-20T00:00:00.000Z', to: '2026-09-20T23:59:59.000Z', maxTotalBytes: sizeOfEach }); // só chega para UM dos dois
    assert.equal(res.truncated, true);
    assert.equal(res.filesRead, 1);
    assert.ok(res.input_tokens === 10 || res.input_tokens === 20, 'um dos dois ficheiros entrou, o outro ficou de fora');
  });

  test('pasta inexistente: atira (o chamador, computeRunCost, é que devolve ok:false)', async () => {
    await assert.rejects(() => sumSessionsUsage(join(root, 'nao-existe-' + Math.random())));
  });
});

// ---------- computeRunCost ----------
describe('computeRunCost — nunca atira; ok:false com o motivo quando não há transcrições legíveis', () => {
  test('sem started_at no run, ou com um started_at que não é data ISO: ok:false, motivo da lista fechada', async () => {
    const home = tmp('home');
    for (const run of [{}, { started_at: 'ontem' }, { started_at: '</script><img src=x>' }, { started_at: 42 }]) {
      const r = await computeRunCost(run, { projectRoot: 'C:/x', home });
      assert.equal(r.ok, false);
      assert.equal(r.reason, COST_REASON.NO_START);
    }
  });
  test('sem pasta de sessões correspondente: ok:false, nunca uma exceção', async () => {
    const home = tmp('home'); mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    const r = await computeRunCost({ started_at: '2026-09-20T00:00:00.000Z' }, { projectRoot: 'C:/projeto/sem/sessoes', home });
    assert.equal(r.ok, false);
    assert.equal(r.reason, COST_REASON.NO_SESSIONS);
  });
  test('caminho feliz: soma o que está na janela e devolve calculated_at/from/to', async () => {
    const home = tmp('home');
    const projectRoot = 'C:/Ficticio/projeto-feliz';
    const slug = projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
    const dir = join(home, '.claude', 'projects', slug);
    writeJsonl(dir, 'lead1.jsonl', [{ timestamp: '2026-09-20T12:00:00.000Z', message: { usage: { input_tokens: 42, cache_creation_input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 } } }]);
    const r = await computeRunCost({ started_at: '2026-09-20T00:00:00.000Z' }, { projectRoot, home, now: '2026-09-20T23:59:59.000Z' });
    assert.equal(r.ok, true);
    assert.equal(r.input_tokens, 42);
    assert.equal(r.cache_creation_input_tokens, 1);
    assert.equal(r.cache_read_input_tokens, 2);
    assert.equal(r.output_tokens, 3);
    assert.equal(r.from, '2026-09-20T00:00:00.000Z');
    assert.equal(r.to, '2026-09-20T23:59:59.000Z');
    assert.ok(r.calculated_at);
  });
});

// ---------- runTokenCostStep ----------
describe('runTokenCostStep — nunca atira, nunca leva o número inventado, evento sem campo "kind" no payload', () => {
  test('sucesso: devolve o objeto para RUN.json.token_usage e emite run.cost com só números/booleanos', async () => {
    const home = tmp('home');
    const projectRoot = 'C:/Ficticio/passo-feliz';
    const slug = projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
    writeJsonl(join(home, '.claude', 'projects', slug), 'lead1.jsonl', [{ timestamp: '2026-09-20T12:00:00.000Z', message: { usage: { input_tokens: 11, output_tokens: 4 } } }]);
    const events = [];
    const cost = await runTokenCostStep({
      run: { started_at: '2026-09-20T00:00:00.000Z', run_id: 'R-teste' },
      projectRoot, home, now: '2026-09-20T23:59:59.000Z',
      emit: (kind, fields) => events.push({ kind, fields }),
    });
    assert.equal(cost.input_tokens, 11);
    assert.equal(cost.output_tokens, 4);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'run.cost');
    assert.ok(!('kind' in events[0].fields), 'invariante do CLAUDE.md: nenhum campo chamado "kind" no payload');
    assert.ok(!('path' in events[0].fields) && !('run_id' in events[0].fields), 'sem caminhos nem identificadores no payload do evento');
  });

  test('falha (sem transcrições): devolve null, nunca atira, e regista o erro em data/hook-errors.log', async () => {
    const dataDir = tmp('data');
    process.env.FORJA_DATA_DIR = dataDir;
    const home = tmp('home'); mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    const events = [];
    const cost = await runTokenCostStep({
      run: { started_at: '2026-09-20T00:00:00.000Z' },
      projectRoot: 'C:/sem/sessoes/nenhumas', home,
      emit: (kind, fields) => events.push({ kind, fields }),
    });
    assert.equal(cost, null);
    assert.equal(events.length, 1);
    assert.equal(events[0].fields.ok, false);
    const log = readFileSync(join(dataDir, 'hook-errors.log'), 'utf8');
    assert.match(log, /run-cost:/);
  });
});

// ---------- CLI: `run checkpoint` / `run finish` escrevem RUN.json.token_usage ----------
describe('CLI — `run checkpoint`/`run finish` escrevem RUN.json.token_usage das transcrições, sem nunca falhar', () => {
  const dataDir = tmp('data-cli');
  const home = tmp('home-cli');
  const proj = tmp('proj-cli');
  const projSlug = proj.replace(/[^a-zA-Z0-9]/g, '-');
  const sessDir = join(home, '.claude', 'projects', projSlug);
  const env = { ...process.env, FORJA_DATA_DIR: dataDir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9', FORJA_VISIBLE_HOME: home, FORJA_OBSIDIAN_SYNC_DIR: join(root, 'central-que-nao-existe'), CLAUDE_CODE_SESSION_ID: 'sess-cost-1' };
  const forja = (...args) => { const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
  const runJson = () => JSON.parse(readFileSync(join(proj, 'docs/forja/RUN.json'), 'utf8'));

  test('run start, depois transcrições escritas depois de começar o run, checkpoint soma-as e o número bate com tools/usage.mjs corrido à mão', () => {
    const start = forja('run', 'start', '--goal', 'Testar custo do run');
    assert.equal(start.code, 0);
    const startedAt = runJson().started_at;
    // Escritas em tempo real, não uma hora fixa: garantidamente depois de
    // started_at e antes do `to` que o checkpoint vier a usar (nowIso() no
    // momento em que ele correr, mais tarde do que agora).
    const now = () => new Date().toISOString();

    // Sessão do Lead depois do início do run, mais uma subagente.
    writeJsonl(sessDir, 'lead1.jsonl', [
      { timestamp: now(), message: { usage: { input_tokens: 500, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 40 } } },
    ]);
    writeJsonl(join(sessDir, 'lead1', 'subagents'), 'agent-x.jsonl', [
      { timestamp: now(), isSidechain: true, message: { usage: { input_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 10, output_tokens: 5 } } },
    ]);

    const cp = forja('run', 'checkpoint', '--note', 'a meio');
    assert.equal(cp.code, 0);
    const run = runJson();
    assert.ok(run.token_usage, 'campo presente depois de transcrições legíveis');
    assert.equal(run.token_usage.input_tokens, 500 + 60);
    assert.equal(run.token_usage.cache_creation_input_tokens, 20 + 0);
    assert.equal(run.token_usage.cache_read_input_tokens, 300 + 10);
    assert.equal(run.token_usage.output_tokens, 40 + 5);
    assert.equal(cp.json.token_usage.input_tokens, run.token_usage.input_tokens, 'a mesma soma sai na resposta do comando');

    // MEDIÇÃO (critério 7): o mesmo `tools/usage.mjs` corrido à mão, com a
    // MESMA janela exata que RUN.json.token_usage registou (`from`/`to`),
    // sobre o ficheiro de topo (Lead) e sobre a pasta de subagents/, somados —
    // a igualdade com RUN.json.token_usage.input_tokens.
    const { from, to } = run.token_usage;
    const main = JSON.parse(spawnSync(process.execPath, [usageScript, '--dir', sessDir, '--from', from, '--to', to], { encoding: 'utf8' }).stdout);
    const sub = JSON.parse(spawnSync(process.execPath, [usageScript, '--dir', join(sessDir, 'lead1', 'subagents'), '--from', from, '--to', to], { encoding: 'utf8' }).stdout);
    const inMain = main.reduce((s, f) => s + Object.values(f.main).reduce((a, m) => a + m.in, 0), 0);
    const inSub = sub.reduce((s, f) => s + Object.values(f.side).reduce((a, m) => a + m.in, 0), 0);
    assert.equal(inMain + inSub, run.token_usage.input_tokens, 'node tools/usage.mjs corrido à mão, na mesma janela, bate certo com RUN.json.token_usage');
  });

  test('run finish recalcula token_usage e o comando sai a 0', () => {
    const fin = forja('run', 'finish');
    assert.equal(fin.code, 0, fin.err);
    assert.ok(runJson().token_usage);
    assert.equal(runJson().status, 'finished');
  });
});

describe('CLI — sem transcrições legíveis, o campo fica a null e o comando sai a 0 na mesma', () => {
  const dataDir = tmp('data-cli-vazio');
  const home = tmp('home-cli-vazio'); mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  const proj = tmp('proj-cli-vazio');
  const env = { ...process.env, FORJA_DATA_DIR: dataDir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9', FORJA_VISIBLE_HOME: home, FORJA_OBSIDIAN_SYNC_DIR: join(root, 'central-que-nao-existe'), CLAUDE_CODE_SESSION_ID: 'sess-cost-vazio' };
  const forja = (...args) => { const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };
  const runJson = () => JSON.parse(readFileSync(join(proj, 'docs/forja/RUN.json'), 'utf8'));

  test('run start + checkpoint sem nenhuma sessão no ~/.claude/projects deste projeto: token_usage null, saída 0', () => {
    assert.equal(forja('run', 'start', '--goal', 'Sem transcrições').code, 0);
    const cp = forja('run', 'checkpoint');
    assert.equal(cp.code, 0);
    assert.equal(runJson().token_usage, null);
    assert.equal(cp.json.token_usage, null);
    assert.ok(existsSync(join(dataDir, 'hook-errors.log')), 'o erro (sem pasta de sessões) fica registado');
  });
});

// ---------- entrada externa hostil ou malformada (SECURITY-REJECT da tentativa 2) ----------
describe('transcrições hostis ou malformadas — só saem inteiros finitos, nunca o conteúdo externo', () => {
  const ts = '2026-09-20T10:00:00.000Z';
  const MARCA = '</script><img src=x onerror=alert(1)>';
  const hostileLines = [
    `{"timestamp":"${ts}","message":{"usage":{"input_tokens":"${MARCA}","output_tokens":5}}}`,
    `{"timestamp":"${ts}","message":{"usage":{"input_tokens":1e999,"cache_read_input_tokens":1e999,"cache_creation_input_tokens":-1e999}}}`,
    `{"timestamp":"${ts}","message":{"usage":{"input_tokens":{"valueOf":1},"output_tokens":[1,2,3]}}}`,
    `{"timestamp":"${ts}","message":{"usage":{"input_tokens":null,"cache_creation_input_tokens":true}}}`,
    `{"timestamp":"${ts}","message":{"usage":{"input_tokens":-99999,"output_tokens":2.7}}}`,
    `{"timestamp":"${ts}","message":{"usage":"não é objeto"}}`,
    `{"timestamp":"${ts}","message":{"usage":{"__proto__":{"polluted":"yes"},"input_tokens":1}}}`,
    `{"timestamp":"${ts}","message":{"usage":{"input_tokens":10,"output_tokens":1}}}`,
    `{"timestamp":"${ts}","message":{"usa`, // linha truncada, como uma transcrição a meio de uma escrita
  ].join('\n');

  test('string, objeto, array, null, booleano, negativo, decimal e 1e999 contam 0 — e o texto externo não viaja', async () => {
    const dir = tmp('sess-hostil');
    writeRaw(dir, 'hostil.jsonl', hostileLines + '\n');
    const res = await sumSessionsUsage(dir, { from: '2026-09-20T00:00:00.000Z', to: '2026-09-20T23:59:59.000Z' });
    // Só as linhas com números válidos contam: 10 + 1 de entrada; de saída,
    // 5 da 1ª linha, 2 (de 2.7, truncado) e 1. 1e999 é Infinity, não um número.
    assert.equal(res.input_tokens, 11);
    assert.equal(res.output_tokens, 8);
    assert.equal(res.cache_read_input_tokens, 0);
    assert.equal(res.cache_creation_input_tokens, 0);
    for (const k of TOKEN_FIELDS) assert.ok(Number.isSafeInteger(res[k]) && res[k] >= 0, `${k} é inteiro seguro >= 0`);
    assert.ok(!JSON.stringify(res).includes('script'), 'nada do conteúdo externo chega ao resultado');
    assert.equal(Object.prototype.polluted, undefined, 'sem prototype pollution');
  });

  test('computeRunCost/runTokenCostStep sobre a mesma fixture: token_usage só com números, evento sem o texto externo', async () => {
    const home = tmp('home-hostil');
    const projectRoot = 'C:/Ficticio/projeto-hostil';
    writeRaw(join(home, '.claude', 'projects', projectRoot.replace(/[^a-zA-Z0-9]/g, '-')), 'lead1.jsonl', hostileLines + '\n');
    const events = [];
    const cost = await runTokenCostStep({
      run: { started_at: '2026-09-20T00:00:00.000Z' },
      projectRoot, home, now: '2026-09-20T23:59:59.000Z',
      emit: (kind, fields) => events.push({ kind, fields }),
    });
    assert.equal(cost.input_tokens, 11);
    for (const k of TOKEN_FIELDS) assert.ok(Number.isSafeInteger(cost[k]) && cost[k] >= 0);
    const gravado = JSON.stringify({ cost, events });
    assert.ok(!gravado.includes('script') && !gravado.includes('onerror'), 'nada disto entra no RUN.json nem no evento');
    assert.equal(events[0].fields.ok, true);
  });

  test('uma linha acima do teto (COST_MAX_LINE_CHARS) é descartada, marca truncated e não pára a soma', async () => {
    const dir = tmp('sess-linha-gigante');
    const gigante = `{"timestamp":"${ts}","message":{"usage":{"input_tokens":7,"nota":"${'x'.repeat(300000)}"}}}`;
    writeRaw(dir, 'gigante.jsonl', [
      `{"timestamp":"${ts}","message":{"usage":{"input_tokens":3}}}`,
      gigante,
      `{"timestamp":"${ts}","message":{"usage":{"input_tokens":5}}}`,
    ].join('\n') + '\n');
    const res = await sumSessionsUsage(dir, { from: '2026-09-20T00:00:00.000Z', to: '2026-09-20T23:59:59.000Z', maxLineChars: 1000 });
    assert.equal(res.input_tokens, 3 + 5, 'as linhas normais contam; a gigante ficou de fora');
    assert.equal(res.truncated, true, 'algo ficou de fora: o resultado diz isso em vez de calar');
  });

  test('sem teto apertado, a mesma linha grande conta normalmente (o teto é a exceção, não a regra)', async () => {
    const dir = tmp('sess-linha-grande-ok');
    writeRaw(dir, 'grande.jsonl', `{"timestamp":"${ts}","message":{"usage":{"input_tokens":7,"nota":"${'x'.repeat(300000)}"}}}\n`);
    const res = await sumSessionsUsage(dir, { from: '2026-09-20T00:00:00.000Z', to: '2026-09-20T23:59:59.000Z' });
    assert.equal(res.input_tokens, 7);
    assert.equal(res.truncated, false);
  });
});

// ---------- rede de segurança e lista fechada de motivos ----------
describe('rede de segurança de computeRunCost — um total que não é inteiro seguro nunca sai como ok', () => {
  const homeComSessao = () => {
    const home = tmp('home-rede');
    const projectRoot = 'C:/Ficticio/rede';
    writeJsonl(join(home, '.claude', 'projects', projectRoot.replace(/[^a-zA-Z0-9]/g, '-')), 'lead1.jsonl', [
      { timestamp: '2026-09-20T10:00:00.000Z', message: { usage: { input_tokens: 1 } } },
    ]);
    return { home, projectRoot };
  };
  const run = { started_at: '2026-09-20T00:00:00.000Z' };
  const base = { now: '2026-09-20T23:59:59.000Z' };

  for (const [nome, totals] of [
    ['string concatenada (o bug da tentativa 2)', { input_tokens: '00</script>', cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }],
    ['Infinity', { input_tokens: Infinity, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }],
    ['NaN', { input_tokens: NaN, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }],
    ['negativo', { input_tokens: -1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }],
    ['decimal', { input_tokens: 1.5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }],
    ['acima de 2^53', { input_tokens: 2 ** 53 + 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }],
    ['campo em falta', { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }],
  ]) {
    test(`total ${nome}: ok:false com motivo da lista fechada, nunca ok:true`, async () => {
      const { home, projectRoot } = homeComSessao();
      const r = await computeRunCost(run, { ...base, home, projectRoot, sumUsage: async () => ({ ...totals, truncated: false }) });
      assert.equal(r.ok, false);
      assert.equal(r.reason, COST_REASON.INVALID);
    });
  }

  test('um erro do sistema não leva a mensagem (nem o caminho) para o motivo: lista fechada + código errno', async () => {
    const { home, projectRoot } = homeComSessao();
    const err = Object.assign(new Error("ENOENT: no such file or directory, scandir 'C:\\Fixtures\\User\\.claude\\projects\\c--Fixtures-User-x'"), { code: 'ENOENT' });
    const r = await computeRunCost(run, { ...base, home, projectRoot, sumUsage: async () => { throw err; } });
    assert.equal(r.ok, false);
    assert.equal(r.reason, COST_REASON.UNREADABLE);
    assert.equal(r.code, 'ENOENT');
    assert.ok(!r.reason.includes('C:') && !r.reason.includes('\\') && !r.reason.includes('/'), 'nenhum caminho no motivo');
  });

  test('um código de erro que não é errno (texto arbitrário) não passa para o motivo nem para o código', async () => {
    const { home, projectRoot } = homeComSessao();
    const err = Object.assign(new Error('boom'), { code: '</script>alert(1)' });
    const r = await computeRunCost(run, { ...base, home, projectRoot, sumUsage: async () => { throw err; } });
    assert.equal(r.reason, COST_REASON.UNREADABLE);
    assert.equal(r.code, null);
  });

  test('prazo esgotado a meio da leitura: ok:false (tempo), nunca uma soma parcial disfarçada de número', async () => {
    const { home, projectRoot } = homeComSessao();
    const parcial = await computeRunCost(run, { ...base, home, projectRoot, sumUsage: async () => ({ input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, truncated: true, timedOut: true }) });
    assert.equal(parcial.ok, false);
    assert.equal(parcial.reason, COST_REASON.TIMEOUT);
  });

  test('cinto de tempo: uma leitura que nunca responde não fica pendurada — ok:false (tempo)', async () => {
    const { home, projectRoot } = homeComSessao();
    const t0 = Date.now();
    const r = await computeRunCost(run, { ...base, home, projectRoot, timeBudgetMs: 5, graceMs: 5, sumUsage: () => new Promise(() => {}) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, COST_REASON.TIMEOUT);
    assert.ok(Date.now() - t0 < 3000, 'desistiu dentro do orçamento, não ao fim de segundos');
  });

  test('o prazo é vigiado dentro da leitura real (deadline já passado: nada é lido, timedOut)', async () => {
    const dir = tmp('sess-prazo');
    writeJsonl(dir, 'lead1.jsonl', [{ timestamp: '2026-09-20T10:00:00.000Z', message: { usage: { input_tokens: 9 } } }]);
    const res = await sumSessionsUsage(dir, { from: '2026-09-20T00:00:00.000Z', to: '2026-09-20T23:59:59.000Z', deadline: Date.now() - 1 });
    assert.equal(res.timedOut, true);
    assert.equal(res.filesRead, 0);
  });
});

// ---------- «nunca medido» vs «falhou desta vez» (nit 2 do Reviewer) ----------
describe('runTokenCostStep — uma falha não apaga a última medição boa, mas também não a finge nova', () => {
  const boa = { calculated_at: '2026-09-20T12:00:00.000Z', from: '2026-09-20T00:00:00.000Z', to: '2026-09-20T12:00:00.000Z', input_tokens: 500, cache_creation_input_tokens: 20, cache_read_input_tokens: 300, output_tokens: 40, truncated: false };
  const semSessoes = () => { const home = tmp('home-anterior'); mkdirSync(join(home, '.claude', 'projects'), { recursive: true }); return home; };

  test('falha com uma medição anterior boa: mantém os números e acrescenta failed_at/failed_reason', async () => {
    const cost = await runTokenCostStep({
      run: { started_at: '2026-09-20T00:00:00.000Z' },
      projectRoot: 'C:/sem/sessoes', home: semSessoes(), previous: boa, emit: () => {},
    });
    assert.equal(cost.input_tokens, 500);
    assert.equal(cost.calculated_at, boa.calculated_at, 'a hora da medição é a da medição, não a de agora');
    assert.equal(cost.failed_reason, COST_REASON.NO_SESSIONS);
    assert.ok(cost.failed_at, 'diz quando falhou — «nunca medido» é outra coisa');
  });

  test('falha sem medição anterior: null (o comportamento prometido pelo CLAUDE.md)', async () => {
    const cost = await runTokenCostStep({
      run: { started_at: '2026-09-20T00:00:00.000Z' },
      projectRoot: 'C:/sem/sessoes', home: semSessoes(), emit: () => {},
    });
    assert.equal(cost, null);
  });

  test('falha com uma medição anterior corrompida (RUN.json editado à mão, ou escrito sem coerção): null', async () => {
    for (const previous of [
      { ...boa, input_tokens: '00</script><img src=x>' },
      { ...boa, input_tokens: null },
      { ...boa, output_tokens: -5 },
      'não é objeto',
      [1, 2, 3],
    ]) {
      const cost = await runTokenCostStep({
        run: { started_at: '2026-09-20T00:00:00.000Z' },
        projectRoot: 'C:/sem/sessoes', home: semSessoes(), previous, emit: () => {},
      });
      assert.equal(cost, null, JSON.stringify(previous));
    }
  });

  test('sucesso depois de uma falha: valor novo, sem vestígios de failed_at/failed_reason', async () => {
    const home = tmp('home-recupera');
    const projectRoot = 'C:/Ficticio/recupera';
    writeJsonl(join(home, '.claude', 'projects', projectRoot.replace(/[^a-zA-Z0-9]/g, '-')), 'lead1.jsonl', [
      { timestamp: '2026-09-20T13:00:00.000Z', message: { usage: { input_tokens: 77 } } },
    ]);
    const cost = await runTokenCostStep({
      run: { started_at: '2026-09-20T00:00:00.000Z' }, projectRoot, home,
      now: '2026-09-20T23:59:59.000Z', previous: { ...boa, failed_at: '2026-09-20T12:30:00.000Z', failed_reason: COST_REASON.NO_SESSIONS }, emit: () => {},
    });
    assert.equal(cost.input_tokens, 77);
    assert.ok(!('failed_at' in cost) && !('failed_reason' in cost));
  });

  test('o evento de falha leva só ok/reason/code — motivo da lista fechada, sem caminhos nem campo "kind"', async () => {
    const events = [];
    await runTokenCostStep({
      run: { started_at: '2026-09-20T00:00:00.000Z' },
      projectRoot: 'C:/sem/sessoes', home: semSessoes(),
      emit: (kind, fields) => events.push({ kind, fields }),
    });
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0].fields).sort(), ['code', 'ok', 'reason']);
    assert.ok(!('kind' in events[0].fields), 'invariante do CLAUDE.md');
    assert.ok(Object.values(COST_REASON).includes(events[0].fields.reason), 'motivo da lista fechada');
    assert.ok(!/[\\/]|C:/.test(events[0].fields.reason), 'nenhum caminho local no motivo servido ao browser');
  });
});

// ---------- CLI, caminho real: transcrição hostil pelo `run checkpoint` ----------
// É o ataque do veredicto de segurança da tentativa 2, executado pelo comando
// que o Lead corre: um `.jsonl` que este repositório não escreve, com um
// `usage` de texto arbitrário, não pode pôr uma única letra desse texto em
// `docs/forja/RUN.json` (versionado), no stdout que o Lead lê, nem no fluxo de
// eventos que o viewer serve.
describe('CLI — um .jsonl hostil não põe texto externo no RUN.json, no stdout nem nos eventos', () => {
  const dataDir = tmp('data-cli-hostil');
  const home = tmp('home-cli-hostil');
  const proj = tmp('proj-cli-hostil');
  const sessDir = join(home, '.claude', 'projects', proj.replace(/[^a-zA-Z0-9]/g, '-'));
  const env = { ...process.env, FORJA_DATA_DIR: dataDir, FORJA_NTFY_SERVER: 'http://127.0.0.1:9', FORJA_VISIBLE_HOME: home, FORJA_OBSIDIAN_SYNC_DIR: join(root, 'central-que-nao-existe'), CLAUDE_CODE_SESSION_ID: 'sess-cost-hostil' };
  const forja = (...args) => { const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, env, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() }; };

  test('usage com string/objeto/1e999 no meio de uma linha boa: saída 0, só inteiros no RUN.json, marca externa em lado nenhum', () => {
    assert.equal(forja('run', 'start', '--goal', 'Transcrição hostil').code, 0);
    const MARCA = '</script><img src=x onerror=alert(1)>';
    const ts = () => new Date().toISOString();
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(join(sessDir, 'lead1.jsonl'), [
      `{"timestamp":"${ts()}","message":{"usage":{"input_tokens":"${MARCA}","output_tokens":"${MARCA}"}}}`,
      `{"timestamp":"${ts()}","message":{"usage":{"input_tokens":1e999,"cache_read_input_tokens":1e999}}}`,
      `{"timestamp":"${ts()}","message":{"usage":{"input_tokens":{"x":"${MARCA}"},"output_tokens":[1,2]}}}`,
      `{"timestamp":"${ts()}","message":{"usage":{"input_tokens":123,"output_tokens":7}}}`,
    ].join('\n') + '\n');

    const cp = forja('run', 'checkpoint', '--note', 'com transcrição hostil');
    assert.equal(cp.code, 0, cp.err);
    const texto = readFileSync(join(proj, 'docs/forja/RUN.json'), 'utf8');
    const run = JSON.parse(texto);
    assert.equal(run.token_usage.input_tokens, 123, 'só a linha com números válidos conta');
    assert.equal(run.token_usage.output_tokens, 7);
    assert.equal(run.token_usage.cache_read_input_tokens, 0, '1e999 é Infinity, não um número');
    for (const k of TOKEN_FIELDS) assert.ok(Number.isSafeInteger(run.token_usage[k]) && run.token_usage[k] >= 0, k);
    // Nenhum pedaço do conteúdo externo em nada do que sai deste comando.
    for (const [onde, conteudo] of [['RUN.json', texto], ['stdout', cp.out], ['eventos', readFileSync(join(dataDir, 'events.jsonl'), 'utf8')]]) {
      assert.ok(!conteudo.includes('script') && !conteudo.includes('onerror') && !conteudo.includes('img src'), `sem conteúdo externo em ${onde}`);
      assert.ok(!conteudo.includes('null,"input_tokens"'), `sem Infinity gravado como null em ${onde}`);
    }
    // E o valor sai do comando igual ao que ficou em disco.
    assert.equal(cp.json.token_usage.input_tokens, 123);
  });

  test('a seguir, sem transcrições (pasta de sessões apagada): mantém o número medido e diz que falhou, sem o perder', () => {
    rmSync(sessDir, { recursive: true, force: true });
    rmSync(join(home, '.claude', 'projects'), { recursive: true, force: true });
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    const cp = forja('run', 'checkpoint');
    assert.equal(cp.code, 0, cp.err);
    const run = JSON.parse(readFileSync(join(proj, 'docs/forja/RUN.json'), 'utf8'));
    assert.equal(run.token_usage.input_tokens, 123, 'a última medição boa não é substituída por null');
    assert.ok(run.token_usage.failed_at && run.token_usage.failed_reason, 'e diz-se que este recálculo falhou');
    assert.ok(!/[\\/]|C:/.test(run.token_usage.failed_reason), 'motivo sem caminhos locais');
  });
});
