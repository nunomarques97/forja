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
const costs = { free: 'Sem custo previsto', paid: 'Opção paga', unknown: 'Custo por esclarecer' };
const decisions = (name, c) => (c.technology || []).map(d => `<form class="technology" data-project="${esc(name)}" data-run="${esc(c.run.run_id)}" data-decision="${esc(d.id)}">
  <p class="eyebrow">PRECISA DA TUA DECISÃO · TRABALHO PARADO</p>
  <fieldset><legend>${esc(d.capability)}</legend><p>${esc(d.constraints)}</p>
  ${d.options.map(o => `<label class="technology-option"><input type="radio" name="choice" value="${esc(o.id)}" required><span><strong>${esc(o.name)}</strong> <span class="cost">${esc(costs[o.cost])}</span><span>${esc(o.cost_basis)}</span><span>${esc(o.tradeoffs)}</span>${o.id === d.recommended ? '<span class="recommendation">Recomendação do FORJA</span>' : ''}</span></label>${(o.sources || []).map(s => `<a class="source" href="${esc(s)}" target="_blank" rel="noopener noreferrer">Consultar fonte</a>`).join('')}`).join('')}
  </fieldset><p><strong>Motivo da recomendação:</strong> ${esc(d.rationale)}</p>
  <p class="hint">Escolhe uma alternativa para continuar. Esta escolha não efetua pagamentos.</p>
  <button type="submit">Confirmar escolha</button><p class="decision-result" role="status"></p>
  </form>`).join('');
export function renderProject({ name, core: c }) {
  if (c.error)
    return `<article class="project"><h2>${esc(name)}</h2><p class="warning">${esc(c.error)}</p></article>`;
  const r = c.run,
    u = c.usage.totals;
  const goal = r.goal?.split(/\.\s/)[0] || '';
  return `<article class="project"><div class="project-top"><h2>${esc(name)}</h2>${status(r.status)}</div><p class="goal">${esc(goal.length > 220 ? goal.slice(0, 217) + '…' : goal)}</p>
  <p class="muted">${esc(r.provider)} · ${c.runnerAlive ? 'Processo ou trabalhador ativo' : 'Sem processo ativo'}${c.pending ? ` · ${esc(labels[c.pending.phase] || c.pending.phase)} · ${esc(c.pending.task || 'objetivo')}` : ''}</p>
  ${decisions(name, c)}
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
  let submitting = false;
  async function refresh(force = false) {
    if (pending) return;
    if (submitting || (!force && document.activeElement?.closest('form.technology'))) return;
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
      if (submitting || (!force && document.activeElement?.closest('form.technology'))) return;
      const choices = new Map([...root.querySelectorAll('form.technology')].map(f => [`${f.dataset.run}:${f.dataset.decision}`, f.querySelector('input:checked')?.value]));
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
        for (const form of root.querySelectorAll('form.technology')) {
          const chosen = choices.get(`${form.dataset.run}:${form.dataset.decision}`);
          for (const input of form.querySelectorAll('input')) input.checked = input.value === chosen;
        }
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
  document.getElementById('projects').addEventListener('submit', async event => {
    const form = event.target.closest('form.technology');
    if (!form) return;
    event.preventDefault();
    if (submitting || !form.reportValidity()) return;
    const option = form.querySelector('input:checked')?.value;
    if (!option) return;
    submitting = true;
    const button = form.querySelector('button'), result = form.querySelector('.decision-result');
    button.disabled = true;
    form.querySelector('fieldset').disabled = true;
    result.textContent = 'A guardar a tua escolha…';
    let accepted;
    try {
      const response = await fetch('/api/core/decision', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: form.dataset.project, run: form.dataset.run, decision: form.dataset.decision, option }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw Error(data.error || 'Não foi possível guardar a escolha.');
      accepted = data;
    } catch (e) { result.textContent = e.name === 'TimeoutError' ? 'Sem confirmação do servidor. Atualiza a página antes de tentar novamente.' : e.message || 'Ligação indisponível. A escolha não foi confirmada.'; }
    finally { submitting = false; button.disabled = false; form.querySelector('fieldset').disabled = false; }
    if (accepted) {
      await refresh(true);
      document.getElementById('connection').textContent = accepted.waiting ? 'Escolha guardada; falta outra decisão.' : accepted.resumed ? 'Escolha guardada; continuação iniciada.' : 'Escolha guardada. A execução está disponível para retoma.';
      document.getElementById('refresh').focus({ preventScroll: true });
    }
  });
  document.getElementById('refresh').addEventListener('click', () => refresh(true));
  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, 5000);
}
