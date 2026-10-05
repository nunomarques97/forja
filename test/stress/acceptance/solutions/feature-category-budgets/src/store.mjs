import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Ledger } from './ledger.mjs';

export const defaultPath = () => process.env.TALLY_FILE || 'tally.json';

export function loadLedger(path = defaultPath()) {
  if (!existsSync(path)) return new Ledger();
  const data = JSON.parse(readFileSync(path, 'utf8'));
  return new Ledger(data.entries, data.budgets);
}

export function saveLedger(ledger, path = defaultPath()) {
  writeFileSync(path, JSON.stringify(ledger, null, 2) + '\n');
}
