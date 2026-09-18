// Bar chart of greetings per day, plus a text table with the same numbers (D12; contract in
// docs/design/DESIGN.md §3; recipe in docs/forja/TECHNOLOGY.md S0.4). Rendered server-side as
// inline SVG, no client-side JavaScript, no library (S0.4 decision).
//
// Imports only ./html.mjs, per the task's scope.
import { escapeHtml } from './html.mjs';

// Geometry from DESIGN.md §3. Column step 39, bar width 24, 14 columns -> width 546.
const COLUMN_STEP = 39;
const BAR_WIDTH = 24;

// Normal window (at least one day has a count > 0).
const HEIGHT_NORMAL = 240;
const BASE_Y_NORMAL = 190;
const TOP_Y_NORMAL = 28;
const MAX_BAR_HEIGHT = BASE_Y_NORMAL - TOP_Y_NORMAL; // 162
const DAY_LABEL_Y_NORMAL = 212;
const MONTH_LABEL_Y_NORMAL = 230;

// All-14-days-at-zero window (DESIGN.md §3, row "Janela toda a zero").
const HEIGHT_ZERO = 100;
const BASE_Y_ZERO = 50;
const DAY_LABEL_Y_ZERO = 72;
const MONTH_LABEL_Y_ZERO = 90;

const ZERO_BAR_HEIGHT = 2;

const NUMBER_FONT_SIZE = 18;
const DAY_FONT_SIZE = 19;
const MONTH_FONT_SIZE = 15;

// 3-letter Portuguese month abbreviations, exactly as fixed by DESIGN.md §3 (Intl's own 'short'
// style yields 'set.' with a trailing period, which is not what is asked for here).
const MONTH_ABBR_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MONTH_NAME_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

// A 'YYYY-MM-DD' string -> { year, month (1-12), date }.
function parseDay(day) {
  const [year, month, date] = String(day ?? '').split('-').map(Number);
  return { year, month, date };
}

// A UTC instant at noon on the given calendar day, so that Intl formatting with timeZone 'UTC'
// always reads back the same calendar day regardless of the host's local time zone.
function dayInstant({ year, month, date }) {
  return new Date(Date.UTC(year, month - 1, date, 12, 0, 0));
}

function longDatePt({ year, month, date }) {
  return `${date} de ${MONTH_NAME_PT[month - 1]}`;
}

const weekdayFormatter = new Intl.DateTimeFormat('pt-PT', {
  weekday: 'short',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

function pluralSaudacoes(count) {
  return count === 1 ? '1 saudação' : `${count} saudações`;
}

function barHeight(count, max) {
  if (count === 0) return ZERO_BAR_HEIGHT;
  return Math.max(8, Math.round((MAX_BAR_HEIGHT * count) / max));
}

function defaultTitle(days, counts, total, max) {
  if (days.length === 0) return 'Saudações por dia. Os mesmos números estão na tabela a seguir.';
  const first = longDatePt(parseDay(days[0].day));
  const last = longDatePt(parseDay(days[days.length - 1].day));
  if (max === 0) {
    return (
      `Saudações por dia, de ${first} a ${last}. ` +
      `Nenhuma saudação guardada nestes ${days.length} dias. ` +
      'Os mesmos números estão na tabela a seguir.'
    );
  }
  return (
    `Saudações por dia, de ${first} a ${last}. Máximo num dia: ${max}. ` +
    `Total: ${pluralSaudacoes(total)}. Os mesmos números estão na tabela a seguir.`
  );
}

/**
 * Renders the 14-day bar chart as inline SVG, followed by a text table with the same numbers.
 * @param {Array<{ day: string, count: number }>} countsByDay oldest day first, today last
 *   (the shape produced by `countByDay` in lib/stats.mjs)
 * @param {{ title?: string }} [options] `title` overrides the auto-generated SVG `<title>` text
 * @returns {string} HTML fragment: one `<svg>` and one `<table>`
 */
export function renderChart(countsByDay, { title } = {}) {
  const days = Array.isArray(countsByDay) ? countsByDay : [];
  const counts = days.map((d) => {
    const n = Number(d?.count);
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  const total = counts.reduce((sum, c) => sum + c, 0);
  const max = counts.length ? Math.max(...counts) : 0;
  const allZero = max === 0;

  const width = Math.max(COLUMN_STEP * days.length, COLUMN_STEP);
  const height = allZero ? HEIGHT_ZERO : HEIGHT_NORMAL;
  const baseY = allZero ? BASE_Y_ZERO : BASE_Y_NORMAL;
  const dayLabelY = allZero ? DAY_LABEL_Y_ZERO : DAY_LABEL_Y_NORMAL;
  const monthLabelY = allZero ? MONTH_LABEL_Y_ZERO : MONTH_LABEL_Y_NORMAL;

  const titleText = escapeHtml(title ?? defaultTitle(days, counts, total, max));

  const columns = days
    .map((entry, i) => {
      const count = counts[i];
      const { month, date } = parseDay(entry.day);
      const center = COLUMN_STEP * i + COLUMN_STEP / 2;
      const x = center - BAR_WIDTH / 2;
      const h = barHeight(count, max);
      const barTop = baseY - h;
      const barColor = count === 0 ? 'var(--line)' : 'var(--accent)';
      const numberColor = count === 0 ? 'var(--muted)' : 'var(--text)';
      const numberY = barTop - 8;

      return (
        `<rect x="${x}" y="${barTop}" width="${BAR_WIDTH}" height="${h}" fill="${barColor}" />` +
        `<text x="${center}" y="${numberY}" text-anchor="middle" font-size="${NUMBER_FONT_SIZE}" fill="${numberColor}">${count}</text>` +
        `<text x="${center}" y="${dayLabelY}" text-anchor="middle" font-size="${DAY_FONT_SIZE}" fill="var(--muted)">${date}</text>` +
        `<text x="${center}" y="${monthLabelY}" text-anchor="middle" font-size="${MONTH_FONT_SIZE}" fill="var(--muted)">${MONTH_ABBR_PT[month - 1]}</text>`
      );
    })
    .join('');

  const svg =
    `<svg class="grafico" viewBox="0 0 ${width} ${height}" role="img" width="100%" ` +
    `style="max-width:100%" aria-labelledby="grafico-titulo">` +
    `<title id="grafico-titulo">${titleText}</title>${columns}</svg>`;

  const rows = days
    .map((entry, i) => {
      const parsed = parseDay(entry.day);
      const label = escapeHtml(weekdayFormatter.format(dayInstant(parsed)));
      return `<tr><th scope="row">${label}</th><td>${counts[i]}</td></tr>`;
    })
    .join('');

  const table =
    '<table class="numeros">' +
    '<caption>Saudações por dia, os mesmos números do gráfico.</caption>' +
    '<thead><tr><th scope="col">Dia</th><th scope="col">Saudações</th></tr></thead>' +
    `<tbody>${rows}</tbody>` +
    '</table>';

  return svg + table;
}
