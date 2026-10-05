#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importCsv } from './importer.mjs';
import { formatReport, monthlyReport } from './report.mjs';
import { loadLedger, saveLedger } from './store.mjs';
import { formatCents } from './money.mjs';

const USAGE = 'usage: tally import <file.csv> | report | balance';

// Returns the exit code; output goes through `write` so tests can capture it.
export function main(argv, { storePath, write = line => console.log(line) } = {}) {
  const [command, ...args] = argv;
  const ledger = loadLedger(storePath);
  if (command === 'import' && args[0]) {
    const entries = importCsv(readFileSync(args[0], 'utf8'));
    for (const entry of entries) ledger.add(entry);
    saveLedger(ledger, storePath);
    write(`imported ${entries.length} entries`);
    return 0;
  }
  if (command === 'report') {
    write(formatReport(monthlyReport(ledger.entries())));
    return 0;
  }
  if (command === 'balance') {
    write(formatCents(ledger.balance()));
    return 0;
  }
  write(USAGE);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
