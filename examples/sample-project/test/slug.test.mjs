import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../lib/slug.mjs';

test('slugify strips accents and punctuation', () => {
  assert.equal(slugify('Olá, São Paulo!'), 'ola-sao-paulo');
  assert.equal(slugify('ação'), 'acao');
});

test('slugify collapses multiple spaces and trims the ends', () => {
  assert.equal(slugify('  dois   espaços '), 'dois-espacos');
  assert.equal(slugify('\tum\n'), 'um');
});

test('slugify turns runs of punctuation into a single hyphen', () => {
  assert.equal(slugify('a & b -- c!!'), 'a-b-c');
  assert.equal(slugify('---x---'), 'x');
});

test('slugify lower-cases everything', () => {
  assert.equal(slugify('Hello WORLD'), 'hello-world');
  assert.equal(slugify('ÀÉÎ'), 'aei');
});

test('slugify keeps digits', () => {
  assert.equal(slugify('Versão 2.0'), 'versao-2-0');
});

test('slugify returns an empty string for empty, null and undefined', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
  assert.equal(slugify('   '), '');
  assert.equal(slugify('!!!'), '');
});
