import { parseCsv } from './csv.mjs';
import { parseAmount } from './money.mjs';
import { formatDate, parseDate } from './dates.mjs';
import { normalizeCategory } from './categories.mjs';
import { ParseError } from './errors.mjs';

const COLUMNS = ['date', 'description', 'category', 'amount'];

// CSV with a header row date,description,category,amount -> entries.
export function importCsv(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header || header.map(h => h.toLowerCase()).join() !== COLUMNS.join()) throw new ParseError(`expected header ${COLUMNS.join(',')}`, 1);
  return rows.map((row, i) => {
    if (row.length !== COLUMNS.length) throw new ParseError(`expected ${COLUMNS.length} columns, got ${row.length}`, i + 2);
    const [date, description, category, amount] = row;
    try {
      return { date: formatDate(parseDate(date)), description, category: normalizeCategory(category), amountCents: parseAmount(amount) };
    } catch (error) {
      throw new ParseError(error.message, i + 2);
    }
  });
}
