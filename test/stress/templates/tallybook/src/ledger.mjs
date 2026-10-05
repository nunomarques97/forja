import { sumCents } from './money.mjs';
import { TallyError } from './errors.mjs';

export class Ledger {
  #entries = [];

  constructor(entries = []) {
    for (const entry of entries) this.add(entry);
  }

  add(entry) {
    if (!Number.isInteger(entry?.amountCents)) throw new TallyError('amountCents must be an integer');
    this.#entries.push({ ...entry });
    return this;
  }

  entries() {
    return this.#entries.map(entry => ({ ...entry }));
  }

  balance() {
    return sumCents(this.#entries.map(entry => entry.amountCents));
  }

  toJSON() {
    return { version: 1, entries: this.entries() };
  }
}
