import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Ledger } from './ledger.mjs';

export const defaultPath = () => process.env.TALLY_FILE || 'tally.json';

export function loadLedger(path = defaultPath()) {
  if (!existsSync(path)) return new Ledger();
  return new Ledger(JSON.parse(readFileSync(path, 'utf8')).entries);
}

export function saveLedger(ledger, path = defaultPath()) {
  writeFileSync(path, JSON.stringify(ledger, null, 2) + '\n');
}
