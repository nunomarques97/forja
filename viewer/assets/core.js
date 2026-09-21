const labels = {
  running: 'Em curso',
  done: 'Concluído',
  blocked: 'Bloqueado',
  failed: 'Falhou',
  todo: 'Por fazer',
  develop: 'Implementação',
  validate: 'Validação',
  review: 'Revisão',
  plan: 'Planeamento',
  approve: 'Aprovado',
  reject: 'Rejeitado',
};
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
const number = (n) =>
  n == null ? '—' : new Intl.NumberFormat('pt-PT').format(n);
const status = (s) =>
  `<span class="status ${esc(s)}">${esc(labels[s] || s)}</span>`;
const metric = (n, label) =>
  `<div class="metric"><strong>${number(n)}</strong><span>${label}</span></div>`;
export function renderProject({ name, core: c }) {
  if (c.error)
    return `<article class="project"><h2>${esc(name)}</h2><p class="warning">${esc(c.error)}</p></article>`;
  const r = c.run,
    u = c.usage.totals;
  const goal = r.goal?.split(/\.\s/)[0] || '';
  return `<article class="project"><div class="project-top"><h2>${esc(name)}</h2>${status(r.status)}</div><p class="goal">${esc(goal.length > 220 ? goal.slice(0, 217) + '…' : goal)}</p>
  <p class="muted">${esc(r.provider)} · ${c.runnerAlive ? 'Processo ou trabalhador ativo' : 'Sem processo ativo'}${c.pending ? ` · ${esc(labels[c.pending.phase] || c.pending.phase)} · ${esc(c.pending.task || 'objetivo')}` : ''}</p>
  <div class="metrics">${metric(c.invocations, 'Sessões iniciadas')}${metric(u.input_tokens_including_cache, 'Tokens de entrada (inclui cache)')}${metric(u.output_tokens, 'Tokens de saída')}${metric(u.cached_input_tokens, 'Entrada servida da cache')}</div>
  <p class="hint">Cobertura de entrada: ${u.input_covered_invocations}/${u.invocations} sessões. Valores em curso podem estar incompletos. ${u.reported_cost_usd == null ? 'Custo monetário indisponível' : `Estimativa nativa: $${u.reported_cost_usd.toFixed(2)} USD (${u.cost_covered_invocations}/${u.invocations} sessões)`}; não representa a fatura da subscrição.${c.ledger_warnings ? ' Há registos incompletos no histórico.' : ''}</p>
  ${c.tasks.map((t) => `<div class="task"><div class="task-title">${esc(t.title)}<small>${esc(t.id)} · ${t.attempts} tentativa(s) · ${t.rotations} rotação(ões) · ${t.checks_passed}/${t.checks_total} verificações · revisão ${esc(labels[t.review] || t.review || 'pendente')}</small></div>${status(t.status)}</div>`).join('')}
  <details><summary>Consumo por agente e tarefa</summary><div class="table-scroll"><table><thead><tr><th>Sessão / fase</th><th>Tarefa</th><th>Modelo / esforço</th><th>Entrada</th><th>Saída</th><th>Cache</th><th>Tempo</th></tr></thead><tbody>${c.usage.rows
    .map((x) => {
      const v = x.normalized;
      return `<tr><td>${x.id} · ${esc(labels[x.phase] || x.phase)}</td><td>${esc(x.task || 'objetivo')}</td><td>${esc(x.reported_model?.trim() || x.model || 'N?o exposto')} / ${esc(x.effort)}</td><td>${number(v?.input)}</td><td>${number(v?.output)}</td><td>${number(v?.cached)}</td><td>${x.duration_ms == null ? '—' : number(Math.round(x.duration_ms / 1000)) + ' s'}</td></tr>`;
    })
    .join(
      '',
    )}</tbody></table></div><p class="muted">Execução ${esc(r.run_id)} · Atualizada ${esc(r.updated_at)}</p></details></article>`;
}
if (typeof document !== 'undefined') {
  let pending = false;
  let rendered = '';
  async function refresh() {
    if (pending) return;
    pending = true;
    try {
      const response = await fetch('/api/core', { cache: 'no-store' });
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? 'Sessão expirada; abre a página inicial para entrar.'
            : 'Ligação indisponível; os últimos dados podem estar desatualizados.',
        );
      const data = await response.json();
      if (!data.ok) throw new Error(data.error);
      const root = document.getElementById('projects');
      const focused = root.contains(document.activeElement)
        ? document.activeElement.closest('article')?.querySelector('h2')?.textContent
        : null;
      const opened = new Set(
        [...root.querySelectorAll('article')]
          .filter((a) => a.querySelector('details[open]'))
          .map((a) => a.querySelector('h2').textContent),
      );
      const html = data.projects.length
        ? data.projects.map(renderProject).join('')
        : '<p class="empty">Ainda não há execuções Core registadas. Inicia uma execução no terminal para a acompanhar aqui.</p>';
      if (html !== rendered) {
        root.innerHTML = html;
        rendered = html;
        for (const article of root.querySelectorAll('article')) {
          const name = article.querySelector('h2').textContent;
          if (opened.has(name)) article.querySelector('details')?.setAttribute('open', '');
          if (focused === name) article.querySelector('summary')?.focus({ preventScroll: true });
        }
      }
      document.getElementById('connection').textContent =
        'Atualizado às ' + new Date(data.at).toLocaleTimeString('pt-PT');
    } catch (e) {
      document.getElementById('connection').textContent = e.message;
    } finally {
      pending = false;
    }
  }
  document.getElementById('refresh').addEventListener('click', refresh);
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 5000);
}
