#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from './args.mjs';
import { statusLine, summary, summaryData } from './status.mjs';

const USAGE = 'usage: jobtime [--json] [--failed] <jobs.json>';

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}
const jobs = JSON.parse(readFileSync(options.file, 'utf8'));
const shown = options.failed ? jobs.filter(job => !job.ok) : jobs;
if (options.json) console.log(JSON.stringify({ jobs: shown, summary: summaryData(jobs) }, null, 2));
else {
  for (const job of shown) console.log(statusLine(job));
  console.log(summary(jobs));
}
