// lib/models.mjs — the three forjalvl (docs/ARCHITECTURE.md §6): name
// normalisation, per-role models, the Dev's model by complexity and attempt,
// and the two invariants that hold at every forjalvl (the Reviewer is never
// weaker than the Dev; nobody but the Architect at `max` ever runs on Fable).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LEVELS, LEVEL_LABEL, EFFORTS, normalizeLevel, modelsFor, devModelFor, effortFor, describeLevel, labelOf, levelOf, policyText, detailOf, readForjalvl } from '../lib/models.mjs';

const RANK = { sonnet: 0, haiku: 0, opus: 1, fable: 2 }; // "fable" is not stronger for review purposes; it is just the Architect's model

describe('forjalvl names', () => {
  test('canonical ids, Portuguese names with and without accent, case and spaces', () => {
    assert.deepEqual(LEVELS, ['max', 'high', 'eco']);
    assert.deepEqual(LEVEL_LABEL, { max: 'máximo', high: 'alto', eco: 'económico' });
    for (const [given, want] of [['max', 'max'], ['máximo', 'max'], ['MAXIMO', 'max'], [' Máximo ', 'max'], ['high', 'high'], ['alto', 'high'], ['Alto', 'high'], ['eco', 'eco'], ['económico', 'eco'], ['economico', 'eco'], ['ECONÓMICO', 'eco']]) {
      assert.equal(normalizeLevel(given), want, `${given} → ${want}`);
    }
    assert.equal(normalizeLevel(undefined), 'high', 'missing forjalvl = the default, high');
    assert.equal(normalizeLevel(null), 'high');
    assert.equal(normalizeLevel(''), 'high');
    assert.equal(labelOf('high'), 'alto');
  });
  test('a forjalvl already stored on disk is read tolerantly: garbage reads as the default, never throws', () => {
    assert.equal(levelOf('económico'), 'eco');
    assert.equal(levelOf('lixo'), 'high');
    assert.equal(levelOf(undefined), 'high');
    assert.equal(labelOf('lixo'), 'alto');
  });
  test('readForjalvl: the new key wins, the pre-rename `model_level` still reads, neither = undefined', () => {
    assert.equal(readForjalvl({ forjalvl: 'eco' }), 'eco');
    assert.equal(readForjalvl({ model_level: 'high' }), 'high', 'a RUN.json/SETTINGS.json written before 17 set 2026');
    assert.equal(readForjalvl({ forjalvl: 'eco', model_level: 'high' }), 'eco', 'the new name wins');
    assert.equal(readForjalvl({}), undefined, 'nothing set is not the same as "high"');
    assert.equal(readForjalvl({ outra_chave: 'x' }), undefined);
    assert.equal(readForjalvl(null), undefined);
    assert.equal(readForjalvl(undefined), undefined);
    assert.equal(readForjalvl('eco'), undefined, 'a string is not a state file');
    assert.equal(levelOf(readForjalvl({ model_level: 'máximo' })), 'max');
  });
  test('an unknown name is refused with a message that says what is accepted', () => {
    assert.throws(() => normalizeLevel('barato'), /forjalvl desconhecido: "barato".*max\|high\|eco/s);
    assert.throws(() => normalizeLevel(true), /forjalvl desconhecido/);
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.throws(() => normalizeLevel(name), /forjalvl desconhecido/, `${name} is a name, not a prototype lookup`);
    }
    assert.throws(() => modelsFor('médio'), /forjalvl desconhecido/);
    assert.throws(() => devModelFor('turbo', { complexity: 'easy' }), /forjalvl desconhecido/);
  });
});

describe('per-role models', () => {
  test('max: Architect follows the floor, every other role on opus', () => {
    assert.deepEqual(modelsFor('max', 'fable'), { architect: 'fable', reviewer: 'opus', 'security-reviewer': 'opus', qa: 'opus', 'product-manager': 'opus', 'product-designer': 'opus', 'technology-scout': 'opus', native: 'sonnet' });
    assert.equal(modelsFor('max', 'opus').architect, 'opus', 'after a fallback the Architect is opus');
    assert.equal(modelsFor('max').architect, 'fable', 'the floor defaults to fable');
  });
  test('high: Architect opus, QA and Technology Scout on sonnet, the rest on opus', () => {
    assert.deepEqual(modelsFor('alto', 'fable'), { architect: 'opus', reviewer: 'opus', 'security-reviewer': 'opus', qa: 'sonnet', 'product-manager': 'opus', 'product-designer': 'opus', 'technology-scout': 'sonnet', native: 'sonnet' });
    assert.equal(modelsFor('high', 'opus').architect, 'opus', 'the floor never changes anything outside max');
  });
  test('eco: only the two review gates stay on opus', () => {
    assert.deepEqual(modelsFor('económico', 'fable'), { architect: 'opus', reviewer: 'opus', 'security-reviewer': 'opus', qa: 'sonnet', 'product-manager': 'sonnet', 'product-designer': 'sonnet', 'technology-scout': 'sonnet', native: 'sonnet' });
  });
});

describe('the Dev model, level × complexity × attempt', () => {
  test('max and high: sonnet for easy/medium, opus for hard or from the second attempt', () => {
    for (const lv of ['max', 'high']) {
      assert.equal(devModelFor(lv, { complexity: 'easy' }, 1), 'sonnet');
      assert.equal(devModelFor(lv, { complexity: 'medium' }, 1), 'sonnet');
      assert.equal(devModelFor(lv, { complexity: 'hard' }, 1), 'opus');
      assert.equal(devModelFor(lv, { complexity: 'easy' }, 2), 'opus');
      assert.equal(devModelFor(lv, { complexity: 'medium' }, 3), 'opus');
      assert.equal(devModelFor(lv, {}, 1), 'sonnet', 'no complexity = medium');
      assert.equal(devModelFor(lv, null, 1), 'sonnet');
      assert.equal(devModelFor(lv, { complexity: 'HARD' }, 1), 'opus', 'complexity is case-insensitive');
    }
  });
  test('eco: sonnet always, opus only from the third attempt', () => {
    assert.equal(devModelFor('eco', { complexity: 'easy' }, 1), 'sonnet');
    assert.equal(devModelFor('eco', { complexity: 'hard' }, 1), 'sonnet');
    assert.equal(devModelFor('eco', { complexity: 'hard' }, 2), 'sonnet');
    assert.equal(devModelFor('eco', { complexity: 'easy' }, 3), 'opus');
    assert.equal(devModelFor('eco', { complexity: 'medium' }, 3), 'opus');
    assert.equal(devModelFor('eco', { complexity: 'medium' }), 'sonnet', 'attempt defaults to 1');
  });
});

describe('effort per session, level × phase × complexity × attempt', () => {
  test('plan and close: max at max, high at high, medium at eco - and the attempt never moves them', () => {
    for (const phase of ['plan', 'close']) {
      assert.equal(effortFor('max', phase), 'max');
      assert.equal(effortFor('high', phase), 'high');
      assert.equal(effortFor('eco', phase), 'medium');
      for (const lv of LEVELS) assert.equal(effortFor(lv, phase, { complexity: 'hard' }, 3), effortFor(lv, phase), `${lv}/${phase}: a retry only moves task sessions`);
    }
  });
  test('task sessions on the first attempt: the table of the three levels', () => {
    const want = {
      max: { easy: 'medium', medium: 'medium', hard: 'high' },
      high: { easy: 'medium', medium: 'medium', hard: 'high' },
      eco: { easy: 'low', medium: 'medium', hard: 'medium' },
    };
    for (const lv of LEVELS) for (const [complexity, effort] of Object.entries(want[lv])) {
      assert.equal(effortFor(lv, 'task', { complexity }, 1), effort, `${lv}/${complexity}`);
    }
    assert.equal(effortFor('high', 'task', {}, 1), 'medium', 'no complexity = medium');
    assert.equal(effortFor('max', 'task', null), 'medium', 'attempt defaults to 1, complexity to medium');
    assert.equal(effortFor('eco', 'task', { complexity: 'constructor' }, 1), 'medium', 'a complexity that is not in the table falls back to medium, prototype names included');
    assert.equal(effortFor('alto', 'task', { complexity: 'HARD' }, 1), 'high', 'level name and complexity are case-insensitive');
  });
  test('from the second attempt on, one step up, never to max', () => {
    for (const lv of LEVELS) for (const complexity of ['easy', 'medium', 'hard']) {
      const first = effortFor(lv, 'task', { complexity }, 1);
      const expected = { low: 'medium', medium: 'high', high: 'high' }[first];
      for (const attempt of [2, 3]) {
        const up = effortFor(lv, 'task', { complexity }, attempt);
        assert.equal(up, expected, `${lv}/${complexity}/${attempt}: ${first} one step up`);
        assert.notEqual(up, 'max', 'a retry never asks for max effort');
      }
    }
    assert.equal(effortFor('eco', 'task', { complexity: 'easy' }, 2), 'medium', 'eco easy: low one step up');
    assert.equal(effortFor('eco', 'task', { complexity: 'hard' }, 2), 'high', 'eco hard: medium one step up');
    assert.equal(effortFor('max', 'task', { complexity: 'hard' }, 3), 'high', 'high stays high: a task session never asks for max');
  });
  test('every result is one of the four efforts Claude Code accepts', () => {
    for (const lv of LEVELS) for (const phase of ['plan', 'task', 'close']) for (const complexity of ['easy', 'medium', 'hard']) for (const attempt of [1, 2, 3]) {
      assert.ok(EFFORTS.includes(effortFor(lv, phase, { complexity }, attempt)));
    }
  });
});

describe('invariants that no level may break', () => {
  test('at every level × complexity × attempt: the Reviewer and the Security Reviewer are at least as strong as the Dev, and no Dev ever runs on fable', () => {
    for (const lv of LEVELS) {
      const m = modelsFor(lv, 'fable');
      for (const complexity of ['easy', 'medium', 'hard']) {
        for (const attempt of [1, 2, 3]) {
          const dev = devModelFor(lv, { complexity }, attempt);
          assert.notEqual(dev, 'fable', `${lv}/${complexity}/${attempt}: a Dev never runs on fable`);
          assert.ok(RANK[m.reviewer] >= RANK[dev], `${lv}/${complexity}/${attempt}: reviewer ${m.reviewer} >= dev ${dev}`);
          assert.ok(RANK[m['security-reviewer']] >= RANK[dev], `${lv}/${complexity}/${attempt}: security reviewer >= dev`);
        }
      }
    }
  });
  test('fable appears only for the Architect at max with the fable floor; native tools are always sonnet', () => {
    for (const lv of LEVELS) {
      for (const floor of ['fable', 'opus']) {
        const m = modelsFor(lv, floor);
        assert.equal(m.native, 'sonnet');
        for (const [role, model] of Object.entries(m)) {
          if (model === 'fable') assert.ok(lv === 'max' && floor === 'fable' && role === 'architect', `fable only for the Architect at max (got ${role} at ${lv}/${floor})`);
        }
      }
    }
  });
});

describe('policyText — the one place the policy is written in words', () => {
  // The expected strings are the sentences the docs, the prompts and the
  // handover carried by hand until T-IMP-1. They are frozen here as real
  // expected values: policyText derives them from modelsFor/devModelFor/
  // effortFor, so a change to the table must be a deliberate change here too.
  const EXPECTED = {
    max: 'Architect em Fable (Opus depois de um fallback); Devs em Sonnet, Opus em tasks hard e a partir da 2.ª tentativa; Reviewer, Security Reviewer, QA, Product Manager, Product Designer e Technology Scout em Opus; ferramentas nativas em Sonnet; effort máximo nas fases de plano e fecho, alto nas tasks hard, médio nas easy/medium',
    high: 'Architect em Opus; Devs em Sonnet, Opus em tasks hard e a partir da 2.ª tentativa; Reviewer, Security Reviewer, Product Manager e Product Designer em Opus; QA e Technology Scout em Sonnet; ferramentas nativas em Sonnet; effort alto nas fases de plano e fecho e nas tasks hard, médio nas easy/medium',
    eco: 'Architect em Opus; Devs em Sonnet, Opus só a partir da 3.ª tentativa; Reviewer e Security Reviewer em Opus; QA, Product Manager, Product Designer e Technology Scout em Sonnet; ferramentas nativas em Sonnet; effort médio nas fases de plano e fecho e nas tasks medium/hard, baixo nas easy',
  };
  test('one line per level, exactly the sentence the Sponsor agreed', () => {
    for (const lv of LEVELS) {
      assert.equal(policyText(lv), EXPECTED[lv], lv);
      assert.equal(policyText(lv).includes('\n'), false, 'exactly one line');
      assert.equal(detailOf(lv), EXPECTED[lv], 'detailOf is the same sentence');
      assert.equal(describeLevel(lv), `${LEVEL_LABEL[lv]} — ${EXPECTED[lv]}`, 'describeLevel is the label plus the sentence');
    }
    assert.equal(policyText('máximo'), EXPECTED.max, 'the Portuguese name is accepted');
    assert.equal(policyText('lixo'), EXPECTED.high, 'a corrupted level on disk reads as the default');
  });
  test('the sentence follows the functions, not a copy: the floor moves the Architect only at max', () => {
    assert.match(policyText('max', 'opus'), /^Architect em Opus;/, 'after a fallback the Architect is Opus');
    assert.equal(policyText('high', 'opus'), EXPECTED.high, 'the floor changes nothing outside max');
    // Every model the table gives the on-demand roles is named in the sentence.
    for (const lv of LEVELS) {
      const m = modelsFor(lv, 'fable');
      const sentence = policyText(lv);
      for (const role of ['Reviewer', 'Security Reviewer', 'QA', 'Product Manager', 'Product Designer', 'Technology Scout']) assert.ok(sentence.includes(role), `${lv}: ${role} named`);
      assert.ok(sentence.includes(`ferramentas nativas em ${m.native === 'sonnet' ? 'Sonnet' : m.native}`));
    }
  });
});

describe('describeLevel', () => {
  test('one line per level, in Portuguese, starting with the label', () => {
    assert.match(describeLevel('max'), /^máximo — Architect em Fable/);
    assert.match(describeLevel('high'), /^alto — Architect em Opus.*QA e Technology Scout em Sonnet/);
    assert.match(describeLevel('eco'), /^económico — .*Opus só a partir da 3\.ª tentativa/);
    assert.match(describeLevel('max'), /effort máximo nas fases de plano e fecho/);
    assert.match(describeLevel('high'), /effort alto nas fases de plano e fecho/);
    assert.match(describeLevel('eco'), /effort médio nas fases de plano e fecho.*baixo nas easy/);
    for (const lv of LEVELS) assert.equal(describeLevel(lv).includes('\n'), false, 'exactly one line');
  });
});
