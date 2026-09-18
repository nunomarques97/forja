// lib/autonomy.mjs — the two autonomies (docs/ARCHITECTURE.md §6b): name
// normalisation, the tolerant read of a value already on disk, and the two
// sentences every prompt, skill, CLI output and doc is built from (what `total`
// frees, what still goes to the Sponsor's queue, and what happens to a money
// question the Sponsor never answers).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTONOMIES, AUTONOMY_LABEL, QUEUE_ALWAYS, ROADMAP_PATH, REPORT_SECTION, ROADMAP_FIELDS, MONEY_DEFAULT,
  normalizeAutonomy, readAutonomy, autonomyOf, autonomyLabelOf, isTotal, autonomyRule, queueAlwaysLine, roadmapRule, describeAutonomy,
} from '../lib/autonomy.mjs';

describe('autonomy names', () => {
  test('the two values, the aliases, case and spaces; missing means normal', () => {
    assert.deepEqual(AUTONOMIES, ['normal', 'total']);
    assert.deepEqual(AUTONOMY_LABEL, { normal: 'normal', total: 'total' });
    for (const [given, want] of [['normal', 'normal'], ['NORMAL', 'normal'], [' Normal ', 'normal'], ['total', 'total'], ['Total', 'total'], ['TOTAL', 'total'], ['completa', 'total'], ['full', 'total']]) {
      assert.equal(normalizeAutonomy(given), want, `${given} → ${want}`);
    }
    // The default is the strict one: a project that never said anything keeps
    // the Sponsor's global rule.
    assert.equal(normalizeAutonomy(undefined), 'normal');
    assert.equal(normalizeAutonomy(null), 'normal');
    assert.equal(normalizeAutonomy(''), 'normal');
  });
  test('an unknown value is refused loudly, and a name from Object.prototype is unknown', () => {
    assert.throws(() => normalizeAutonomy('muita'), /autonomia desconhecida: "muita" — usa normal\|total/);
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.throws(() => normalizeAutonomy(name), /autonomia desconhecida/, name);
    }
  });
  test('a value already on disk is read tolerantly, and garbage falls back to the STRICT value', () => {
    assert.equal(autonomyOf('total'), 'total');
    assert.equal(autonomyOf('lixo'), 'normal', 'a corrupted RUN.json never grants freedom the Sponsor did not give');
    assert.equal(autonomyOf({ a: 1 }), 'normal');
    assert.equal(autonomyOf(undefined), 'normal');
    assert.equal(autonomyLabelOf('completa'), 'total');
    assert.equal(isTotal('total'), true);
    assert.equal(isTotal('normal'), false);
    assert.equal(isTotal('lixo'), false);
  });
  test('readAutonomy tells "not set" from "set", and survives a non-object', () => {
    assert.equal(readAutonomy({ autonomy: 'total' }), 'total');
    assert.equal(readAutonomy({ forjalvl: 'eco' }), undefined, 'a SETTINGS.json with only a forjalvl does not set the autonomy');
    assert.equal(readAutonomy(null), undefined);
    assert.equal(readAutonomy('total'), undefined);
  });
});

describe('what still goes to the Sponsor queue (rule of 17 set 2026, 05:55)', () => {
  test('the list is his money first, then the four that commit him or cannot be undone', () => {
    assert.equal(QUEUE_ALWAYS.length, 5);
    assert.deepEqual(QUEUE_ALWAYS.map(c => c.en), [
      'his money (purchases, licences, subscriptions, paid certificates)',
      'creating accounts in his name',
      'sending anything at all to a third party',
      'deleting data',
      'publishing, deploying or pushing',
    ]);
    // Two languages, one list: neither may grow a class the other does not have.
    for (const c of QUEUE_ALWAYS) { assert.ok(c.pt && c.en, JSON.stringify(c)); }
    assert.match(QUEUE_ALWAYS[0].pt, /dinheiro dele/);
  });
  test('the line is one sentence, in Portuguese for the Sponsor and English for the prompts', () => {
    const pt = queueAlwaysLine();
    assert.equal(pt, queueAlwaysLine('pt'), 'Portuguese is the default');
    assert.equal(pt.split('\n').length, 1, 'one line');
    assert.match(pt, /^Mesmo em autonomia total continuam a ir à fila do Sponsor: /);
    for (const c of QUEUE_ALWAYS) assert.ok(pt.includes(c.pt), `falta "${c.pt}"`);
    assert.match(pt, /apagar dados e publicar, fazer deploy ou push\.$/, 'Portuguese enumeration: … , … e ….');
    const en = queueAlwaysLine('en');
    for (const c of QUEUE_ALWAYS) assert.ok(en.includes(c.en), `missing "${c.en}"`);
    assert.match(en, /deleting data and publishing, deploying or pushing\.$/);
    assert.equal(queueAlwaysLine('klingon'), pt, 'an unknown language falls back to Portuguese, never to nothing');
  });
  test('a money question: free default, the project roadmap, the close report', () => {
    assert.equal(MONEY_DEFAULT.pt, 'não gasto; alternativa gratuita');
    assert.equal(ROADMAP_PATH, 'docs/forja/SPONSOR-ROADMAP.md');
    assert.equal(REPORT_SECTION, 'Para decidires agora que estás aqui');
    const pt = roadmapRule();
    assert.match(pt, /«não gasto; alternativa gratuita»/);
    assert.ok(pt.includes(ROADMAP_PATH) && pt.includes(REPORT_SECTION));
    for (const f of ROADMAP_FIELDS) assert.ok(pt.includes(f.pt), `falta o campo "${f.pt}"`);
    const en = roadmapRule('en');
    assert.ok(en.includes(ROADMAP_PATH) && en.includes(REPORT_SECTION));
    for (const f of ROADMAP_FIELDS) assert.ok(en.includes(f.en), `missing field "${f.en}"`);
    assert.match(en, /"não gasto; alternativa gratuita"/, 'the default is quoted verbatim, in the Sponsor\'s words');
  });
});

describe('the rule in words', () => {
  test('total frees dependencies, product and design — and still names money, accounts, sending, deleting, publishing', () => {
    for (const l of ['pt', 'en']) {
      const r = autonomyRule('total', l);
      assert.match(r, /NOT go to the Sponsor queue|NÃO vão à fila do Sponsor/);
      assert.ok(r.includes('docs/forja/TECHNOLOGY.md'), 'the Scout still records the choice');
      assert.ok(r.includes('DECISIONS.md'), 'and it is recorded, never silent');
      assert.ok(r.includes('venv') && r.includes('node_modules'), 'the Dev may install in the project environment');
      assert.ok(r.includes('decidido em autonomia total'), 'the exact words a decision is logged with');
      assert.ok(r.includes(queueAlwaysLine(l)), 'the freedom is always stated with its limits');
      assert.ok(r.includes(roadmapRule(l)), 'and with what happens to an unanswered money question');
    }
  });
  test('normal is today\'s behaviour: a free dependency is still a queue entry and nothing is installed', () => {
    const r = autonomyRule('normal', 'en');
    assert.match(r, /a new dependency \(even a free one\)/);
    assert.match(r, /nothing is installed without him/);
    assert.equal(r.includes(queueAlwaysLine('en')), false, 'at `normal` the list of exceptions would be misleading: everything goes');
    assert.match(autonomyRule('normal'), /nada se instala sem ele/);
  });
  test('a corrupted value describes as normal, never as total', () => {
    assert.equal(autonomyRule('lixo'), autonomyRule('normal'));
    assert.equal(describeAutonomy('lixo'), `normal — ${autonomyRule('normal')}`);
    assert.match(describeAutonomy('total'), /^total — /);
  });
});
