import { sumCents } from './money.mjs';
import { TallyError } from './errors.mjs';
import { normalizeCategory } from './categories.mjs';

export class Ledger {
  #entries = [];
  #budgets = new Map();

  constructor(entries = [], budgets = {}) {
    for (const entry of entries) this.add(entry);
    for (const [category, cents] of Object.entries(budgets ?? {})) this.setBudget(category, cents);
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

  // Monthly spending limit of a category, in positive cents.
  setBudget(category, cents) {
    if (!Number.isInteger(cents) || cents <= 0) throw new TallyError('a budget must be a positive whole number of cents');
    this.#budgets.set(normalizeCategory(category), cents);
    return this;
  }

  budgets() {
    return Object.fromEntries(this.#budgets);
  }

  toJSON() {
    return { version: 1, entries: this.entries(), budgets: this.budgets() };
  }
}
