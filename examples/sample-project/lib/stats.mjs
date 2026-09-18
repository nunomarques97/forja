// Per-day counts for the chart (decision D12, recipe S0.4 in docs/forja/TECHNOLOGY.md).
//
// Rule that must not be relaxed: group by the LOCAL day (Europe/Lisbon by default), never by
// `toISOString().slice(0, 10)` — '2026-06-15T23:30:00Z' is 16 June in Lisbon. The 14-day window is
// built by walking backwards from today's LOCAL day using calendar arithmetic on the day's
// components (`Date.UTC(y, m - 1, d - offset)`), never by subtracting 24h in milliseconds from a
// UTC instant — that breaks across the Lisbon DST change.
//
// Built-ins only: `Intl.DateTimeFormat`. No imports.

/**
 * The local calendar day ('YYYY-MM-DD') of a UTC instant, in the given time zone.
 * @param {string|number|Date} isoUtc an ISO 8601 UTC instant (or anything `Date` accepts)
 * @param {string} [timeZone]
 * @returns {string} 'YYYY-MM-DD'
 */
export function localDay(isoUtc, timeZone = 'Europe/Lisbon') {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(isoUtc));
}

// Decisão por omissão: um registo sem `criado_em` ou com um valor que o Date não consegue ler
// nunca pode rebentar countByDay — é ignorado (não conta em nenhum dia, não pára a contagem dos
// outros). localDay() mantém a fórmula exata do critério (pode lançar em input inválido); esta
// função absorve essa exceção só para uso interno de countByDay.
function localDayOrNull(isoUtc, timeZone) {
  try {
    return localDay(isoUtc, timeZone);
  } catch {
    return null;
  }
}

// Constrói os `days` dias da janela, do mais antigo ao de hoje, andando para trás sobre os
// componentes de calendário do dia local de `today` (S0.4: nunca subtrair 24h em ms a um instante
// UTC — isso parte na mudança de hora de verão em Lisboa).
function windowDays(today, days, timeZone) {
  const anchor = localDay(today, timeZone);
  const [year, month, date] = anchor.split('-').map(Number);
  const result = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const utcInstant = new Date(Date.UTC(year, month - 1, date - offset));
    result.push(new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(utcInstant));
  }
  return result;
}

/**
 * Counts by local calendar day over a fixed window, oldest day first, today last. Days with no
 * records show up with count 0; records outside the window are ignored; records are not assumed
 * to be sorted; a record with a missing or unparseable `criado_em` is ignored (see decision above).
 * @param {Array<{ criado_em?: unknown }>} records
 * @param {{ today?: Date, days?: number, timeZone?: string }} [options]
 * @returns {Array<{ day: string, count: number }>}
 */
export function countByDay(records, { today = new Date(), days = 14, timeZone = 'Europe/Lisbon' } = {}) {
  const order = windowDays(today, days, timeZone);
  const counts = new Map(order.map((day) => [day, 0]));
  for (const record of Array.isArray(records) ? records : []) {
    const day = localDayOrNull(record?.criado_em, timeZone);
    if (day !== null && counts.has(day)) counts.set(day, counts.get(day) + 1);
  }
  return order.map((day) => ({ day, count: counts.get(day) }));
}

/**
 * A copy of `records` ordered by `criado_em` descending (newest first), stable, without touching
 * the array that was passed in. A record with a missing `criado_em` sorts as if it were the empty
 * string (oldest).
 * @param {Array<{ criado_em?: unknown }>} records
 * @returns {Array<object>}
 */
export function newestFirst(records) {
  return [...records].sort((a, b) => {
    const av = String(a?.criado_em ?? '');
    const bv = String(b?.criado_em ?? '');
    if (av > bv) return -1;
    if (av < bv) return 1;
    return 0;
  });
}
