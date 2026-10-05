#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { topWords } from './wordfreq.mjs';

const [file, n = '10'] = process.argv.slice(2);
if (!file) {
  console.error('usage: wordfreq <file> [n]');
  process.exit(2);
}
for (const [word, count] of topWords(readFileSync(file, 'utf8'), Number(n))) console.log(`${count}\t${word}`);
