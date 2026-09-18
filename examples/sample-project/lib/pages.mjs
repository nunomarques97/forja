// Full HTML pages served by the app: histórico, entrar, erro (D14; contract in
// docs/design/DESIGN.md, section "Ecrãs servidos pela aplicação — histórico, entrar, erro").
// Portuguese UI, CSS inline, no client-side JavaScript, no external requests (S0.5). Direction A
// chosen by the Product Designer: on the histórico screen the form comes first, then the list,
// then the chart (D18).
//
// Imports only ./html.mjs, ./chart.mjs, ./stats.mjs, per the task's scope.
import { escapeHtml } from './html.mjs';
import { renderChart } from './chart.mjs';
import { countByDay, localDay, newestFirst } from './stats.mjs';

const MAX_LIST_ITEMS = 100;

// CSS shared by all three pages (DESIGN.md §1 "Escala de tipo e blocos comuns"), copied verbatim
// from the Product Designer's chosen mocks (docs/design/mocks/escolhida-*.html) so pixel geometry
// matches what was already fotografado and picked.
const STYLE = `
    :root {
      --bg: #14171c; --text: #e6e8eb; --muted: #a3aab4; --accent: #6fb3f2; --line: #2a2f37;
      --s-1: 0.25rem; --s-2: 0.5rem; --s-3: 1rem; --s-4: 1.5rem; --s-5: 2.5rem; --s-6: 4rem;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html { background: var(--bg); color: var(--text);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, Cantarell, sans-serif; }
    body { margin: 0; font-size: 1.125rem; line-height: 1.6; overflow-wrap: anywhere; }
    main { max-width: 40rem; margin-inline: auto; padding-block: var(--s-6); padding-inline: var(--s-4); }
    h1 { margin: 0 0 var(--s-3); font-size: 2rem; font-weight: 600; line-height: 1.2; }
    h2 { margin: 0 0 var(--s-3); font-size: 1.25rem; font-weight: 600; line-height: 1.3; }
    p { margin: 0; }
    a { color: var(--accent); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.15em; }
    a.acao { display: inline-block; min-height: 44px; padding-block: var(--s-2); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .lead { color: var(--muted); font-size: 1rem; margin-bottom: var(--s-4); }
    .bloco { margin-top: var(--s-5); }
    form { margin: 0; }
    label { display: block; font-size: 0.9375rem; color: var(--muted); margin-bottom: var(--s-1); }
    input[type="text"], input[type="password"] {
      display: block; width: 100%; max-width: 100%; min-height: 44px;
      padding: var(--s-2) var(--s-3); font: inherit; font-size: 1.125rem;
      color: var(--text); background: var(--bg); border: 1px solid var(--muted); border-radius: 2px; }
    input::placeholder { color: var(--muted); opacity: 1; }
    button { min-height: 44px; margin-top: var(--s-3); padding: var(--s-2) var(--s-4);
      font: inherit; font-size: 1.125rem; font-weight: 600; color: var(--bg);
      background: var(--accent); border: 1px solid var(--accent); border-radius: 2px; cursor: pointer; }
    .erro-campo { margin: 0 0 var(--s-3); padding-left: var(--s-3); border-left: 2px solid var(--accent); font-size: 1rem; }
    .erro-campo strong { font-weight: 600; }
    input[aria-invalid="true"] { border-color: var(--accent); }
    .ajuda { margin-top: var(--s-2); color: var(--muted); font-size: 0.9375rem; }
    .vazio { margin-top: var(--s-3); padding-top: var(--s-3); border-top: 1px solid var(--line); color: var(--muted); font-size: 1rem; }
    .lista { list-style: none; margin: 0; padding: 0; }
    .lista li { padding: var(--s-3) 0; border-bottom: 1px solid var(--line); }
    .lista li:first-child { border-top: 1px solid var(--line); }
    .lista .saudacao { display: block; font-size: 1.125rem; }
    .lista .quando { display: block; color: var(--muted); font-size: 0.9375rem; }
    .total { color: var(--muted); font-size: 0.9375rem; margin-bottom: var(--s-2); }
    .grafico { display: block; }
    .numeros { width: 100%; border-collapse: collapse; margin-top: var(--s-3); font-size: 0.9375rem; }
    .numeros caption { text-align: left; color: var(--muted); font-size: 0.9375rem; margin-bottom: var(--s-2); }
    .numeros th, .numeros td { padding: var(--s-2) 0; border-bottom: 1px solid var(--line); text-align: left; font-weight: 400; }
    .numeros thead th { color: var(--muted); }
    .numeros td { text-align: right; font-variant-numeric: tabular-nums; }
    .codigo { margin-top: var(--s-4); color: var(--muted); font-size: 0.9375rem; }
    code { font-family: ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace; font-size: 0.9375rem; }
    @media (max-width: 480px) { h1 { font-size: 1.5rem; } main { padding-block: var(--s-5); } }
`;

// Wraps a page body (already-built HTML for the inside of <main>) with the doctype, head and
// shared CSS every screen needs.
function page(title, bodyHtml) {
  return (
    '<!DOCTYPE html>\n' +
    '<html lang="pt">\n' +
    '<head>\n' +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `  <title>${escapeHtml(title)}</title>\n` +
    `  <style>${STYLE}</style>\n` +
    '</head>\n' +
    '<body>\n' +
    `  <main>\n${bodyHtml}\n  </main>\n` +
    '</body>\n' +
    '</html>\n'
  );
}

const dateTimeFormatter = new Intl.DateTimeFormat('pt-PT', {
  timeZone: 'Europe/Lisbon',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

// A record's `criado_em` formatted as "16 de setembro de 2026 às 15:56" (DESIGN.md §2). A
// record with a missing or unparseable date never breaks the page: it just shows nothing.
function formatWhen(isoUtc) {
  try {
    return dateTimeFormatter.format(new Date(isoUtc));
  } catch {
    return '';
  }
}

function pluralSaudacoes(count) {
  return count === 1 ? '1 saudação' : `${count} saudações`;
}

// Same tolerant read as lib/stats.mjs's own internal helper: a record with a missing or
// unparseable `criado_em` never counts (and never throws), it is simply not "de hoje".
function isToday(record, todayDay) {
  try {
    return localDay(record?.criado_em) === todayDay;
  } catch {
    return false;
  }
}

/**
 * The «histórico» screen (`GET /historico`): form to add a greeting, list of saved greetings
 * (newest first, capped at 100), then the 14-day chart. Direction A (D18): in that order.
 * @param {{ records?: Array<{ nome?: unknown, saudacao?: unknown, criado_em?: unknown }>,
 *   total?: number, today?: Date, error?: unknown }} [options] `total` overrides the count shown
 *   (defaults to `records.length`); `today` anchors both "de hoje" and the 14-day chart window
 *   (defaults to now); a truthy `error` shows the form's validation message.
 * @returns {string} a complete HTML document
 */
export function historyPage({ records, total, today = new Date(), error } = {}) {
  const all = Array.isArray(records) ? records : [];
  const n = Number.isFinite(total) ? total : all.length;
  const shown = newestFirst(all).slice(0, MAX_LIST_ITEMS);
  const todayDay = localDay(today);
  const todayCount = all.filter((record) => isToday(record, todayDay)).length;

  const fieldError = error
    ? '<p class="erro-campo" id="erro-nome"><strong>Não foi possível guardar.</strong> Escreva um nome com 1 a 80 caracteres.</p>\n      '
    : '';
  const inputAttrs = error ? ' aria-invalid="true" aria-describedby="erro-nome" value=""' : '';

  const formHtml =
    '<form method="post" action="/saudacoes">\n' +
    '      <label for="nome">Nome de quem quer cumprimentar</label>\n' +
    `      ${fieldError}<input id="nome" name="nome" type="text" maxlength="80" required autocomplete="off" placeholder="Ana Sofia"${inputAttrs}>\n` +
    '      <button type="submit">Guardar saudação</button>\n' +
    '    </form>';

  let listHtml;
  if (shown.length === 0) {
    listHtml =
      '<p class="vazio">Ainda não há saudações guardadas. Escreva o primeiro nome aqui em cima e ' +
      'carregue em «Guardar saudação»: aparece já a seguir.</p>';
  } else {
    const totalLine =
      n > MAX_LIST_ITEMS
        ? `<p class="total">${pluralSaudacoes(n)} no total, ${todayCount} de hoje. A mostrar as 100 mais recentes.</p>`
        : `<p class="total">${pluralSaudacoes(n)} no total, ${todayCount} de hoje. As mais recentes primeiro.</p>`;
    const items = shown
      .map(
        (record) =>
          `<li><span class="saudacao">${escapeHtml(record?.saudacao)}</span>` +
          `<span class="quando">${escapeHtml(formatWhen(record?.criado_em))}</span></li>`,
      )
      .join('\n        ');
    listHtml = `${totalLine}\n      <ul class="lista">\n        ${items}\n      </ul>`;
  }

  const body =
    '    <h1>Saudações</h1>\n' +
    '    <p class="lead">Escreva um nome, carregue no botão e a saudação fica guardada para toda a equipa.</p>\n' +
    `    ${formHtml}\n` +
    '    <section class="bloco">\n' +
    '      <h2>Saudações guardadas</h2>\n' +
    `      ${listHtml}\n` +
    '    </section>\n' +
    '    <section class="bloco">\n' +
    '      <h2>Saudações por dia</h2>\n' +
    `      ${renderChart(countByDay(all, { today }))}\n` +
    '    </section>';

  return page('Saudações', body);
}

/**
 * The «entrar» screen (`GET /entrar`): a single password field (called "palavra-passe" in the
 * UI, "token" in the HTML `name`, since the server reads that field — DESIGN.md §4). Never shows
 * or hints at the password, and looks the same whether or not one is configured.
 * @param {{ error?: unknown }} [options] a truthy `error` shows the "wrong password" message
 * @returns {string} a complete HTML document
 */
export function loginPage({ error } = {}) {
  const fieldError = error
    ? '<p class="erro-campo" id="erro-token"><strong>Não foi possível entrar.</strong> A palavra-passe ' +
      'não está certa. Confirme-a com quem arrancou o servidor e tente outra vez.</p>\n      '
    : '';
  const inputAttrs = error ? ' aria-invalid="true" aria-describedby="erro-token"' : '';

  const body =
    '    <h1>Entrar</h1>\n' +
    '    <p class="lead">As saudações da equipa estão protegidas por uma palavra-passe, igual para toda ' +
    'a gente. Peça-a a quem arrancou o servidor.</p>\n' +
    '    <form method="post" action="/entrar">\n' +
    '      <label for="token">Palavra-passe</label>\n' +
    `      ${fieldError}<input id="token" name="token" type="password" autocomplete="off" required${inputAttrs}>\n` +
    '      <button type="submit">Entrar</button>\n' +
    '      <p class="ajuda">Fica guardada neste browser até o fechar e nunca sai desta rede.</p>\n' +
    '    </form>';

  return page('Entrar — Saudações', body);
}

// Fixed per-status content (DESIGN.md §5): title, default next-step sentence and default action
// link. `errorPage`'s `message` and `linkToLogin` parameters can override the text and force a
// link to /entrar respectively, for whichever caller (T6) needs it; by default each status shows
// exactly the row DESIGN.md §5 specifies.
const ERROR_INFO = {
  401: {
    title: 'Precisa de entrar',
    message: 'Esta página só abre depois de escrever a palavra-passe da equipa.',
    link: { href: '/entrar', text: 'Ir para a página de entrada' },
  },
  404: {
    title: 'Esta página não existe',
    message: 'O endereço que abriu não faz parte desta aplicação. Volte às saudações e tente outra vez.',
    link: { href: '/historico', text: 'Voltar às saudações' },
  },
  413: {
    title: 'O nome que enviou é demasiado grande',
    message: 'Escreva um nome com 80 caracteres ou menos e guarde outra vez. Nada foi gravado.',
    link: { href: '/historico', text: 'Voltar às saudações' },
  },
  500: {
    title: 'Não foi possível ler as saudações guardadas',
    message:
      'Nenhuma saudação se perdeu: o ficheiro ficou exatamente como estava. Peça a quem arrancou o ' +
      'servidor para o verificar e arrancar outra vez.',
    link: null,
  },
};

const DEFAULT_ERROR_INFO = {
  title: 'Ocorreu um erro',
  message: 'Tente outra vez dentro de momentos.',
  link: null,
};

/**
 * The «erro» screen (401, 404, 413, 500 — DESIGN.md §5): one shape for all four, in plain
 * Portuguese, never a stack trace. `<h1>` and, unless overridden, the next-step sentence and the
 * action link all come from `status`.
 * @param {{ status?: number, message?: string, linkToLogin?: boolean }} [options] `message`
 *   overrides the default next-step sentence; `linkToLogin` forces the "Ir para a página de
 *   entrada" link regardless of `status`
 * @returns {string} a complete HTML document
 */
export function errorPage({ status, message, linkToLogin } = {}) {
  const info = ERROR_INFO[status] ?? DEFAULT_ERROR_INFO;
  const finalMessage = message || info.message;
  const link = linkToLogin ? { href: '/entrar', text: 'Ir para a página de entrada' } : info.link;

  const linkHtml = link
    ? `\n    <p class="bloco"><a class="acao" href="${link.href}">${escapeHtml(link.text)}</a></p>`
    : '';
  const codeHtml = Number.isFinite(status) ? `\n    <p class="codigo">Código ${status}.</p>` : '';

  const body = `    <h1>${escapeHtml(info.title)}</h1>\n    <p>${escapeHtml(finalMessage)}</p>${linkHtml}${codeHtml}`;

  return page(`${info.title} — Saudações`, body);
}
