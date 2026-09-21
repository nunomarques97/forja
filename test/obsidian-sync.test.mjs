// O sync da Central de Projetos no fecho do run (T4, D12/D13, decisão S3 em
// docs/forja/TECHNOLOGY.md): a metade pura que decide e a metade que corre.
//
// Nada aqui precisa de Python instalado e nada aqui toca na Central real do
// Sponsor: o `sync.py` é um ficheiro falso numa pasta temporária e o
// interpretador injetado é o `process.execPath` (o Node que corre os testes),
// que executa esse ficheiro como JavaScript. Escrita: só dentro de `tmpdir()`.
// Run: node --test test/
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_ARGS, REQUIRED_ARG, SETTINGS_KEY, SETTINGS_DIR_KEY, SYNC_TIMEOUT_MS,
  defaultSyncDir, describeObsidianSync, normalizePath, obsidianSync, planObsidianSync,
  resolveSyncDir, runObsidianSync, samePath, settingsOrError, syncOn,
} from '../lib/obsidian-sync.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'forja.mjs');
const root = mkdtempSync(join(tmpdir(), 'forja-obsidian-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const tmp = name => { const d = join(root, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d; };

// Uma Central falsa: `sync.py` com um corpo JavaScript (o `process.execPath`
// corre um ficheiro de extensão desconhecida como CommonJS) e um `config.json`
// no formato do Sponsor — a lista `projetos`, cada entrada com `id` e `caminho`.
function central({ projects = [], syncPyBody = 'process.exit(0);', withSyncPy = true, withConfig = true, configText = null } = {}) {
  const dir = tmp('central');
  if (withSyncPy) writeFileSync(join(dir, 'sync.py'), `${syncPyBody}\n`);
  if (withConfig) writeFileSync(join(dir, 'config.json'), configText ?? JSON.stringify({ vault: '..\\Obsidian', projetos: projects }, null, 2));
  return dir;
}

describe('planObsidianSync — a decisão, sem correr nada', () => {
  test('caminho que casa com maiúsculas e barras trocadas → id, comando, argumentos, pasta e limite de tempo', () => {
    const proj = tmp('projeto');
    // O config.json do Sponsor guarda `C:\Fixtures\...`; aqui a entrada leva o
    // mesmo caminho com as barras ao contrário e a caixa trocada, que é
    // exatamente o que o PROCEDIMENTO.md §6.1 manda ignorar.
    const torto = proj.replace(/\\/g, '/').toUpperCase();
    const dir = central({ projects: [{ id: 'outro', caminho: 'C:\\nao\\e\\este' }, { id: 'projeto-certo', caminho: torto }] });
    const plan = planObsidianSync({ projectRoot: proj, syncDir: dir, settings: {}, python: 'python-de-teste' });
    assert.equal(plan.run, true);
    assert.equal(plan.id, 'projeto-certo');
    assert.equal(plan.command, 'python-de-teste');
    assert.deepEqual(plan.args, [join(dir, 'sync.py'), '--projetos', 'projeto-certo']);
    assert.equal(plan.cwd, dir);
    assert.equal(plan.timeoutMs, SYNC_TIMEOUT_MS);
    // D12: nunca sem --projetos, nunca --forcar, nunca --marcar-revisto.
    assert.ok(plan.args.includes(REQUIRED_ARG));
    for (const bad of FORBIDDEN_ARGS) assert.ok(!plan.args.includes(bad), bad);
  });

  test('entrada que não casa → salta com o caminho no motivo', () => {
    const proj = tmp('projeto');
    const dir = central({ projects: [{ id: 'outro', caminho: join(root, 'um-projeto-qualquer') }] });
    const plan = planObsidianSync({ projectRoot: proj, syncDir: dir, settings: {} });
    assert.equal(plan.run, false);
    assert.equal(plan.skipped, true);
    assert.match(plan.reason, /não está na Central/);
    assert.ok(plan.reason.includes(proj));
  });

  test('sync.py ausente → salta; config.json ausente → salta; config.json ilegível → salta', () => {
    const proj = tmp('projeto');
    const semPy = central({ withSyncPy: false, projects: [{ id: 'x', caminho: proj }] });
    assert.match(planObsidianSync({ projectRoot: proj, syncDir: semPy, settings: {} }).reason, /não encontrei o programa da Central/);
    const semConfig = central({ withConfig: false });
    assert.match(planObsidianSync({ projectRoot: proj, syncDir: semConfig, settings: {} }).reason, /não encontrei .*config\.json/);
    const mau = central({ configText: '{ isto não é json' });
    assert.match(planObsidianSync({ projectRoot: proj, syncDir: mau, settings: {} }).reason, /não é JSON válido/);
    // A pasta inteira ausente também salta, em vez de rebentar.
    assert.equal(planObsidianSync({ projectRoot: proj, syncDir: join(root, 'central-que-nao-existe'), settings: {} }).run, false);
  });

  test('interruptor desligado no SETTINGS.json → salta, mesmo com tudo o resto no sítio', () => {
    const proj = tmp('projeto');
    const dir = central({ projects: [{ id: 'projeto-certo', caminho: proj }] });
    for (const off of [false, 'false', 'não', 'nao', 'off', 'desligado', '0', 'no']) {
      const plan = planObsidianSync({ projectRoot: proj, syncDir: dir, settings: { [SETTINGS_KEY]: off } });
      assert.equal(plan.run, false, String(off));
      assert.match(plan.reason, /desligado neste projeto/);
    }
    // Ligado por omissão (D13): sem ficheiro, sem chave, ou com a chave a true.
    for (const on of [{}, { forjalvl: 'high' }, { [SETTINGS_KEY]: true }, { [SETTINGS_KEY]: 'sim' }]) {
      assert.equal(planObsidianSync({ projectRoot: proj, syncDir: dir, settings: on }).run, true, JSON.stringify(on));
    }
  });

  test('SETTINGS.json ilegível (SettingsError) → salta com motivo, nunca atira', () => {
    const proj = tmp('projeto');
    const dir = central({ projects: [{ id: 'projeto-certo', caminho: proj }] });
    const err = settingsOrError(() => { throw new Error('SETTINGS.json ilegível: Unexpected token — corrige-o à mão'); });
    const plan = planObsidianSync({ projectRoot: proj, syncDir: dir, settings: err });
    assert.equal(plan.run, false);
    assert.match(plan.reason, /não consegui ler as definições do projeto/);
  });

  test('sem raiz de projeto → salta; a função nunca atira, seja qual for o argumento', () => {
    assert.equal(planObsidianSync().run, false);
    assert.equal(planObsidianSync({ projectRoot: '' }).run, false);
    assert.equal(planObsidianSync({ projectRoot: tmp('projeto'), syncDir: null }).run, false);
    assert.equal(planObsidianSync({ projectRoot: 1234, syncDir: 5678, settings: 'nada disto é um objeto' }).run, false);
  });

  test('comparação de caminhos: insensível a maiúsculas, a / vs \\ e à barra final', () => {
    assert.ok(samePath('C:\\Fixtures\\User\\Repos\\forja', 'c:/fixtures/user/repos/forja/'));
    assert.ok(samePath('C:/a//b/', 'C:\\A\\B'));
    assert.ok(!samePath('C:/a/b', 'C:/a/bc'));
    assert.ok(!samePath('', ''));
    assert.equal(normalizePath('C:\\A\\B\\'), 'c:/a/b');
  });

  test('a pasta da Central: variável de ambiente > SETTINGS.json > a pasta do Sponsor', () => {
    const antes = process.env.FORJA_OBSIDIAN_SYNC_DIR;
    delete process.env.FORJA_OBSIDIAN_SYNC_DIR;
    try {
      assert.equal(resolveSyncDir({}), defaultSyncDir());
      assert.equal(defaultSyncDir(), join(homedir(), 'Desktop', 'Central de Projetos', '_obsidian-sync'));
      assert.equal(resolveSyncDir({ [SETTINGS_DIR_KEY]: 'D:\\outra' }), 'D:\\outra');
      process.env.FORJA_OBSIDIAN_SYNC_DIR = 'E:\\ambiente';
      assert.equal(resolveSyncDir({ [SETTINGS_DIR_KEY]: 'D:\\outra' }), 'E:\\ambiente');
    } finally {
      if (antes === undefined) delete process.env.FORJA_OBSIDIAN_SYNC_DIR; else process.env.FORJA_OBSIDIAN_SYNC_DIR = antes;
    }
    assert.equal(syncOn(new Error('ilegível')), true, 'um Error não desliga o interruptor: quem decide é o plano');
  });
});

describe('runObsidianSync — correr sem nunca atirar', () => {
  // Três casos contra um interpretador injetável: sai 0, sai 3, fica preso até
  // ao limite de tempo. Nenhum deles atira; todos devolvem valor e emitem um
  // evento `obsidian.sync` com ok/salto/motivo/duração.
  const scenario = (body, { timeoutMs = SYNC_TIMEOUT_MS, settings = {} } = {}) => {
    const proj = tmp('projeto');
    const dir = central({ projects: [{ id: 'projeto-certo', caminho: proj }], syncPyBody: body });
    const plan = planObsidianSync({ projectRoot: proj, syncDir: dir, settings, python: process.execPath, timeoutMs });
    const events = [];
    const result = runObsidianSync(plan, { emit: (kind, fields, opts) => events.push({ kind, fields, opts }) });
    return { proj, dir, plan, result, events };
  };

  test('script que sai 0 → ok, com duração e evento obsidian.sync', () => {
    const { result, events } = scenario('console.log("central atualizada"); process.exit(0);');
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.equal(result.status, 0);
    assert.equal(result.reason, null);
    assert.match(result.stdout, /central atualizada/);
    assert.ok(Number.isFinite(result.ms));
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'obsidian.sync');
    assert.deepEqual(Object.keys(events[0].fields).sort(), ['ms', 'ok', 'project_id', 'reason', 'skipped', 'status']);
    assert.equal(events[0].fields.ok, true);
    assert.equal(events[0].fields.project_id, 'projeto-certo');
    // Invariante do CLAUDE.md: nunca um campo chamado `kind` no payload.
    assert.ok(!('kind' in events[0].fields));
  });

  test('script que sai 3 → devolve valor com o código e o stderr, sem atirar', () => {
    const { result, events } = scenario('console.error("o bloqueio está tomado"); process.exit(3);');
    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.equal(result.status, 3);
    assert.match(result.reason, /saiu com código 3/);
    assert.match(result.reason, /bloqueio está tomado/);
    assert.equal(events[0].fields.ok, false);
    assert.equal(events[0].fields.status, 3);
  });

  test('script preso → termina no limite de tempo e devolve valor', () => {
    const { result, events } = scenario('setTimeout(() => {}, 60_000);', { timeoutMs: 400 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.reason, /excedeu 400 ms e foi terminado/);
    assert.ok(result.ms >= 300, `duração medida: ${result.ms}`);
    assert.equal(events[0].fields.ok, false);
    assert.match(events[0].fields.reason, /excedeu/);
  });

  test('interpretador que não existe → valor com motivo, nunca exceção', () => {
    const proj = tmp('projeto');
    const dir = central({ projects: [{ id: 'projeto-certo', caminho: proj }] });
    const plan = planObsidianSync({ projectRoot: proj, syncDir: dir, settings: {}, python: 'python-que-nao-existe-em-lado-nenhum' });
    const events = [];
    const result = runObsidianSync(plan, { emit: (k, f) => events.push({ k, f }) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /não encontrei o interpretador de Python/);
    assert.equal(events[0].f.ok, false);
  });

  test('um plano de salto nunca lança processo nenhum e mantém o motivo', () => {
    let lancou = 0;
    const events = [];
    const result = runObsidianSync({ run: false, skipped: true, reason: 'desligado neste projeto (obsidian_sync em docs/forja/SETTINGS.json)' },
      { spawn: () => { lancou++; return { status: 0 }; }, emit: (k, f) => events.push(f) });
    assert.equal(lancou, 0);
    assert.equal(result.skipped, true);
    assert.equal(result.ok, false);
    assert.equal(events[0].skipped, true);
    assert.match(events[0].reason, /desligado neste projeto/);
  });

  test('D12 imposto em código: um plano com --forcar ou --marcar-revisto é recusado antes do processo', () => {
    const proj = tmp('projeto');
    const dir = central({ projects: [{ id: 'projeto-certo', caminho: proj }] });
    const base = planObsidianSync({ projectRoot: proj, syncDir: dir, settings: {}, python: process.execPath });
    for (const bad of [...FORBIDDEN_ARGS]) {
      let lancou = 0;
      const r = runObsidianSync({ ...base, args: [...base.args, bad] }, { spawn: () => { lancou++; return { status: 0 }; }, emit: () => {} });
      assert.equal(lancou, 0, bad);
      assert.equal(r.skipped, true);
      assert.match(r.reason, /plano recusado/);
    }
    let lancou = 0;
    const semFiltro = runObsidianSync({ ...base, args: [base.args[0]] }, { spawn: () => { lancou++; return { status: 0 }; }, emit: () => {} });
    assert.equal(lancou, 0, 'sem --projetos não corre');
    assert.match(semFiltro.reason, /plano recusado/);
  });

  test('um emit que atira não derruba o passo; um spawn que atira vira valor', () => {
    const proj = tmp('projeto');
    const dir = central({ projects: [{ id: 'projeto-certo', caminho: proj }], syncPyBody: 'process.exit(0);' });
    const plan = planObsidianSync({ projectRoot: proj, syncDir: dir, settings: {}, python: process.execPath });
    const r1 = runObsidianSync(plan, { emit: () => { throw new Error('disco cheio'); } });
    assert.equal(r1.ok, true);
    const r2 = runObsidianSync(plan, { spawn: () => { throw new Error('spawn rebentou'); }, emit: () => {} });
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /exceção ao correr o sync/);
  });

  test('obsidianSync junta tudo e a frase para o Sponsor diz o que aconteceu', () => {
    const proj = tmp('projeto');
    const dir = central({ projects: [{ id: 'projeto-certo', caminho: proj }] });
    const ok = obsidianSync({ projectRoot: proj, syncDir: dir, python: process.execPath, emit: () => {} });
    assert.equal(ok.ok, true);
    assert.match(describeObsidianSync(ok), /^Sync do Obsidian: a ficha de «projeto-certo» foi atualizada/);
    const off = obsidianSync({ projectRoot: proj, syncDir: dir, settings: { [SETTINGS_KEY]: false }, python: process.execPath, emit: () => {} });
    assert.match(describeObsidianSync(off), /^Sync do Obsidian: saltado — desligado neste projeto/);
    const mau = obsidianSync({ projectRoot: proj, syncDir: central({ projects: [{ id: 'projeto-certo', caminho: proj }], syncPyBody: 'process.exit(2);' }), python: process.execPath, emit: () => {} });
    assert.match(describeObsidianSync(mau), /falhou — o sync saiu com código 2\. O run não é afetado\./);
  });
});

describe('o fecho do run (bin/forja.mjs run finish)', () => {
  // O CLI num projeto temporário, com a Central apontada por variável de
  // ambiente para uma pasta temporária: a Central real do Sponsor nunca é
  // tocada por este teste.
  function project({ syncPyBody = 'process.exit(0);', inConfig = true, settings = null, central: centralDir = null } = {}) {
    const proj = tmp('cli-proj');
    const data = tmp('cli-data');
    const dir = centralDir || central({ projects: inConfig ? [{ id: 'projeto-do-teste', caminho: proj }] : [], syncPyBody });
    if (settings) { mkdirSync(join(proj, 'docs', 'forja'), { recursive: true }); writeFileSync(join(proj, 'docs', 'forja', 'SETTINGS.json'), settings); }
    const env = {
      ...process.env,
      FORJA_DATA_DIR: data,
      FORJA_NTFY_SERVER: 'http://127.0.0.1:9',
      CLAUDE_CODE_SESSION_ID: 'sess-obsidian-test',
      FORJA_OBSIDIAN_SYNC_DIR: dir,
      FORJA_OBSIDIAN_PYTHON: process.execPath,
    };
    const forja = (...args) => {
      const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, env, encoding: 'utf8' });
      return { code: r.status, out: r.stdout, err: r.stderr, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
    };
    const events = () => (existsSync(join(data, 'events.jsonl')) ? readFileSync(join(data, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
    return { proj, data, dir, forja, events };
  }

  test('um sync que falha não muda o código de saída do run finish nem o RUN.json', () => {
    const { proj, forja, events } = project({ syncPyBody: 'console.error("falhou de propósito"); process.exit(3);' });
    assert.equal(forja('run', 'start', '--goal', 'fechar com o sync a falhar').code, 0);
    const antes = readFileSync(join(proj, 'docs/forja/RUN.json'), 'utf8');
    const r = forja('run', 'finish', '--note', 'fim');
    assert.equal(r.code, 0, `saída: ${r.err}`);
    assert.equal(r.json.ok, true);
    assert.match(r.json.obsidian, /falhou — o sync saiu com código 3/);
    assert.match(r.json.obsidian, /O run não é afetado/);
    const depois = JSON.parse(readFileSync(join(proj, 'docs/forja/RUN.json'), 'utf8'));
    assert.equal(depois.status, 'finished');
    // O RUN.json é o do fecho, não o de antes: o sync não lhe acrescentou nem
    // lhe tirou nada (as chaves são as mesmas do fecho normal, mais nada —
    // `finished_at` do fecho e `token_usage` do passo de custo, lib/run-cost.mjs).
    assert.deepEqual(Object.keys(depois).sort(), [...new Set([...Object.keys(JSON.parse(antes)), 'finished_at', 'token_usage'])].sort());
    const ev = events().filter(e => e.forja && e.forja.kind === 'obsidian.sync');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].forja.ok, false);
    assert.equal(ev[0].forja.status, 3);
    assert.equal(ev[0].hook_event_name, 'Forja');
    // O evento do fecho continua a ser o último estado gravado antes deste.
    assert.ok(events().some(e => e.forja && e.forja.kind === 'run.finish'));
  });

  test('sync bem sucedido no fecho; a ficha do projeto identificada pelo caminho', () => {
    const { forja, events } = project({ syncPyBody: 'console.log("ok"); process.exit(0);' });
    forja('run', 'start', '--goal', 'fechar com o sync a correr');
    const r = forja('run', 'finish');
    assert.equal(r.code, 0);
    assert.match(r.json.obsidian, /a ficha de «projeto-do-teste» foi atualizada/);
    assert.equal(events().filter(e => e.forja.kind === 'obsidian.sync')[0].forja.project_id, 'projeto-do-teste');
  });

  test('projeto fora do config.json: o fecho salta em silêncio registado', () => {
    const { forja, events } = project({ inConfig: false });
    forja('run', 'start', '--goal', 'projeto que não está na Central');
    const r = forja('run', 'finish');
    assert.equal(r.code, 0);
    assert.match(r.json.obsidian, /saltado — este projeto não está na Central/);
    assert.equal(events().filter(e => e.forja.kind === 'obsidian.sync')[0].forja.skipped, true);
  });

  test('SETTINGS.json ilegível salta o sync e nunca faz falhar o run finish', () => {
    // O run arranca com o ficheiro são (um SETTINGS.json ilegível faz o
    // `run start` recusar, e com razão: o forjalvl viria errado). Parte-se
    // depois, que é o caso real — alguém editou o ficheiro à mão a meio do run.
    const { proj, forja, events } = project({ settings: JSON.stringify({ forjalvl: 'high' }, null, 2) });
    assert.equal(forja('run', 'start', '--goal', 'settings partido a meio').code, 0);
    writeFileSync(join(proj, 'docs', 'forja', 'SETTINGS.json'), '{ isto não é json');
    const r = forja('run', 'finish');
    assert.equal(r.code, 0, `saída: ${r.err}`);
    assert.match(r.json.obsidian, /saltado — não consegui ler as definições do projeto/);
    assert.equal(events().filter(e => e.forja.kind === 'obsidian.sync')[0].forja.skipped, true);
  });

  test('o interruptor por projeto desliga o passo no fecho', () => {
    const { forja } = project({ settings: JSON.stringify({ forjalvl: 'high', [SETTINGS_KEY]: false }, null, 2) });
    forja('run', 'start', '--goal', 'sync desligado neste projeto');
    const r = forja('run', 'finish');
    assert.equal(r.code, 0);
    assert.match(r.json.obsidian, /saltado — desligado neste projeto/);
  });

  test('`forja obsidian sync` corre o mesmo passo à mão e imprime uma linha', () => {
    const { proj, forja, events } = project({ syncPyBody: 'process.exit(0);' });
    const r = forja('obsidian', 'sync');
    assert.equal(r.code, 0);
    assert.match(r.out.trim(), /^Sync do Obsidian: a ficha de «projeto-do-teste» foi atualizada pelo programa da Central em \d+ (ms|s)\.$/);
    assert.equal(events().filter(e => e.forja.kind === 'obsidian.sync').length, 1);
    // Correu sem run aberto: o comando não exige RUN.json e não o criou.
    assert.ok(!existsSync(join(proj, 'docs/forja/RUN.json')));
    // Um subcomando desconhecido é recusado com o usage, como os outros.
    const mau = forja('obsidian', 'inventado');
    assert.equal(mau.code, 2);
    assert.match(mau.err, /obsidian sync/);
  });
});
