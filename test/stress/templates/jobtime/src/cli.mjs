#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { statusLine, summary } from './status.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: jobtime <jobs.json>');
  process.exit(2);
}
const jobs = JSON.parse(readFileSync(file, 'utf8'));
for (const job of jobs) console.log(statusLine(job));
console.log(summary(jobs));
