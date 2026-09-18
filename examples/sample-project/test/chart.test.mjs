import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../lib/html.mjs';
import { renderChart } from '../lib/chart.mjs';

// 14 consecutive local days, oldest first, today last (the shape lib/stats.mjs's countByDay
// produces), with a clearly distinct maximum on 2026-06-13 (count 9).
const COUNTS = [1, 2, 0, 3, 1, 4, 9, 0, 2, 1, 3, 5, 2, 1];
const DAYS = [
  '2026-06-07', '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13',
  '2026-06-14', '2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20',
];
const COUNTS_BY_DAY = DAYS.map((day, i) => ({ day, count: COUNTS[i] }));

function matchesAll(html, pattern) {
  return [...html.matchAll(pattern)];
}

function tbodyOf(html) {
  return html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
}

test('renderChart draws exactly 14 bars and 14 table rows', () => {
  const html = renderChart(COUNTS_BY_DAY);
  const rects = matchesAll(html, /<rect\b/g);
  assert.equal(rects.length, 14);
  // one <tr> is the header row, 14 are data rows -> 15 total
  assert.equal(matchesAll(html, /<tr>/g).length, 15);
  // and the 14 are really the body rows, one per day
  assert.equal(matchesAll(tbodyOf(html), /<tr>/g).length, 14);
});

test('the table comes after the SVG, has a <caption> and one header row', () => {
  const html = renderChart(COUNTS_BY_DAY);
  assert.ok(html.indexOf('</svg>') < html.indexOf('<table'));
  assert.match(html, /<table[^>]*><caption>Saudações por dia, os mesmos números do gráfico\.<\/caption>/);
  assert.match(html, /<th scope="col">Dia<\/th><th scope="col">Saudações<\/th>/);
});

test('each table row names its day and the numbers are in the same order as the chart', () => {
  const html = renderChart(COUNTS_BY_DAY);
  const rows = matchesAll(tbodyOf(html), /<tr><th scope="row">([^<]+)<\/th><td>(\d+)<\/td><\/tr>/g);
  assert.equal(rows.length, 14);
  assert.deepEqual(rows.map((m) => Number(m[2])), COUNTS);
  // oldest day first, today last: 7 de junho … 20 de junho
  assert.match(rows[0][1], /7 de junho/);
  assert.match(rows[13][1], /20 de junho/);
});

test('the SVG has none of the forbidden features (animation, gradients, foreignObject, tooltips)', () => {
  const html = renderChart(COUNTS_BY_DAY);
  const svg = html.slice(0, html.indexOf('</svg>'));
  for (const forbidden of ['<animate', 'Gradient', '<foreignObject', '<filter', '<style', '<image', 'onclick', 'xlink:href']) {
    assert.ok(!svg.includes(forbidden), `SVG must not contain ${forbidden}`);
  }
  // a hover tooltip inside the SVG would be a <title> that is not the one describing the whole image
  assert.equal(matchesAll(svg, /<title/g).length, 1);
});

test('the table numbers match the counts given, in the same order', () => {
  const html = renderChart(COUNTS_BY_DAY);
  const tableCells = matchesAll(html, /<td>(\d+)<\/td>/g).map((m) => Number(m[1]));
  assert.deepEqual(tableCells, COUNTS);
});

test('the day with the highest count has the tallest bar', () => {
  const html = renderChart(COUNTS_BY_DAY);
  const heights = matchesAll(html, /<rect[^>]*height="(\d+(?:\.\d+)?)"/g).map((m) => Number(m[1]));
  assert.equal(heights.length, 14);
  const maxHeight = Math.max(...heights);
  const indexOfMaxHeight = heights.indexOf(maxHeight);
  const indexOfMaxCount = COUNTS.indexOf(Math.max(...COUNTS));
  assert.equal(indexOfMaxHeight, indexOfMaxCount);
  // and it really is taller than every other bar, not tied
  assert.ok(heights.every((h, i) => i === indexOfMaxHeight || h < maxHeight));
});

test('zero-count days still render a visible bar (a 1-2px stroke), not an invisible one', () => {
  const html = renderChart(COUNTS_BY_DAY);
  const heights = matchesAll(html, /<rect[^>]*height="(\d+(?:\.\d+)?)"/g).map((m) => Number(m[1]));
  // indices of the two zero-count days: 2 (2026-06-09) and 7 (2026-06-14)
  assert.ok(heights[2] >= 1 && heights[2] <= 2);
  assert.ok(heights[7] >= 1 && heights[7] <= 2);
});

test('contains role="img" and a descriptive <title>', () => {
  const html = renderChart(COUNTS_BY_DAY);
  assert.match(html, /role="img"/);
  assert.match(html, /<title id="grafico-titulo">[^<]+<\/title>/);
  // the title is in Portuguese and mentions the totals a screen-reader user needs
  assert.match(html, /Saudações por dia/);
});

test('never contains a <script>, and never an http:// or https:// URL', () => {
  const html = renderChart(COUNTS_BY_DAY);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /http:\/\//);
  assert.doesNotMatch(html, /https:\/\//);
});

test('the SVG has no fixed pixel width/height and only uses the five design tokens as colours', () => {
  const html = renderChart(COUNTS_BY_DAY);
  assert.match(html, /<svg[^>]*viewBox="0 0 \d+ \d+"/);
  const svgTag = html.match(/<svg[^>]*>/)[0];
  assert.match(svgTag, /\swidth="100%"/); // scales with the container, never a fixed px number
  assert.doesNotMatch(svgTag, /\sheight="/); // no fixed height attribute at all
  const colours = matchesAll(html, /(?:fill)="([^"]+)"/g).map((m) => m[1]);
  const allowed = new Set(['var(--bg)', 'var(--text)', 'var(--muted)', 'var(--accent)', 'var(--line)']);
  assert.ok(colours.every((c) => allowed.has(c)));
});

test('a window where every day is at 0 still renders 14 bars, all visible as a thin stroke', () => {
  const zeroDays = DAYS.map((day) => ({ day, count: 0 }));
  const html = renderChart(zeroDays);
  const rects = matchesAll(html, /<rect\b/g);
  assert.equal(rects.length, 14);
  const tableCells = matchesAll(html, /<td>(\d+)<\/td>/g).map((m) => Number(m[1]));
  assert.deepEqual(tableCells, new Array(14).fill(0));
  assert.match(html, /Nenhuma saudação/);
});

test('a custom title overrides the auto-generated one, still escaped', () => {
  const html = renderChart(COUNTS_BY_DAY, { title: 'Título & <perigoso>' });
  assert.match(html, /<title id="grafico-titulo">Título &amp; &lt;perigoso&gt;<\/title>/);
});

// --- escapeHtml -------------------------------------------------------------------------------

test('escapeHtml replaces the five special characters', () => {
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#39;');
  assert.equal(escapeHtml(`<script>alert('oi')</script> & "x" > y`),
    '&lt;script&gt;alert(&#39;oi&#39;)&lt;/script&gt; &amp; &quot;x&quot; &gt; y');
});

test('escapeHtml turns null and undefined into an empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});
