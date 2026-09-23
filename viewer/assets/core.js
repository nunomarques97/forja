import { createCoreClient } from './core-client.js';
const labels = { running: 'Em curso', done: 'Concluído', blocked: 'Bloqueado', failed: 'Falhou', todo: 'Por fazer', develop: 'Implementação', validate: 'Validação', review: 'Revisão', plan: 'Planeamento', approve: 'Aprovada', reject: 'Rejeitada' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = value => value == null ? '—' : new Intl.NumberFormat('pt-PT').format(value);
const status = (key, text = labels[key] || key) => `<span class="status ${esc(key)}"><span aria-hidden="true"></span>${esc(text)}</span>`;
const costs = { free: 'Sem custo previsto', paid: 'Opção paga', unknown: 'Custo por esclarecer' };
const projectKey = p => JSON.stringify([p.name, p.core.run?.run_id]);
export function projectState(p) {
  const c = p.core;
  if (c.error) return { group: 'attention', key: 'failed', label: 'Estado indisponível' };
  if (c.technology?.length) return { group: 'attention', key: 'blocked', label: 'Precisa de ti' };
  if (c.run.status === 'running' && !c.runnerAlive) return { group: 'attention', key: 'blocked', label: 'Interrompido' };
  if (['blocked', 'failed'].includes(c.run.status)) return { group: 'attention', key: c.run.status, label: labels[c.run.status] };
  return { group: c.run.status === 'done' ? 'done' : 'running', key: c.run.status, label: labels[c.run.status] || c.run.status };
}
export function selectProjects(projects, filter = 'all', query = '') {
  const term = query.trim().toLocaleLowerCase('pt-PT');
  const rank = { attention: 0, running: 1, done: 2 };
  return projects.filter(p => (filter === 'all' || projectState(p).group === filter) && `${p.name} ${p.core.run?.goal || ''}`.toLocaleLowerCase('pt-PT').includes(term))
    .sort((a, b) => rank[projectState(a).group] - rank[projectState(b).group] || a.name.localeCompare(b.name));
}
export function renderOverview(projects) {
  const groups = projects.map(projectState);
  return [[projects.length, 'Projetos', 'total'], [groups.filter(s => s.group === 'running').length, 'Em curso', 'running'], [groups.filter(s => s.group === 'attention').length, 'Precisam de atenção', 'attention'], [groups.filter(s => s.group === 'done').length, 'Concluídos', 'done']]
    .map(([n, label, kind]) => `<div class="overview-item ${kind}"><span>${label}</span><strong>${number(n)}</strong></div>`).join('');
}
const decisions = (name, c) => (c.technology || []).map(d => `<form class="technology" data-project="${esc(name)}" data-run="${esc(c.run.run_id)}" data-decision="${esc(d.id)}">
  <p class="eyebrow">A TUA DECISÃO · TRABALHO EM PAUSA</p><fieldset><legend>${esc(d.capability)}</legend><p>${esc(d.constraints)}</p>
  <div class="options">${d.options.map(o => `<div class="option"><label class="technology-option"><input type="radio" name="choice" value="${esc(o.id)}" required><span><strong>${esc(o.name)}</strong><span class="cost">${esc(costs[o.cost])}</span><span>${esc(o.cost_basis)}</span><span>${esc(o.tradeoffs)}</span>${o.id === d.recommended ? '<span class="recommendation">Recomendação do FORJA</span>' : ''}</span></label>${(o.sources || []).map(s => `<a class="source" href="${esc(s)}" target="_blank" rel="noopener noreferrer">Consultar fonte ↗</a>`).join('')}</div>`).join('')}</div></fieldset>
  <p><strong>Motivo da recomendação:</strong> ${esc(d.rationale)}</p><p class="hint">Escolhe uma alternativa para continuar. Esta escolha não efetua pagamentos.</p><button type="submit">Confirmar escolha <span aria-hidden="true">↗</span></button><p class="decision-result" role="status"></p></form>`).join('');
export function renderProject(p) {
  const { name, core: c } = p, state = projectState(p), key = esc(projectKey(p));
  if (c.error) return `<article class="project needs-attention" data-key="${key}"><div class="project-top"><h3>${esc(name)}</h3>${status(state.key, state.label)}</div><p class="warning">${esc(c.error)}</p><p class="muted">Os dados deste projeto não puderam ser lidos. Os restantes projetos continuam disponíveis.</p></article>`;
  const r = c.run, u = c.usage.totals, tasks = c.tasks || [], completed = tasks.filter(t => t.status === 'done').length;
  const currentTask = tasks.find(t => t.id === c.pending?.task);
  const activity = r.status === 'done' ? 'Execução concluída' : c.technology?.length ? 'À espera da tua escolha' : !c.runnerAlive ? 'Sem processo ativo' : c.pending ? `${labels[c.pending.phase] || c.pending.phase}${currentTask ? ' · ' + currentTask.title : ''}` : 'Processo ativo · a aguardar a próxima etapa';
  return `<article class="project ${state.group === 'attention' ? 'needs-attention' : ''}" data-key="${key}">
    <div class="project-top"><div class="project-name"><span class="project-icon" aria-hidden="true">${esc(name.slice(0, 1).toLocaleUpperCase())}</span><h3>${esc(name)}</h3></div>${status(state.key, state.label)}</div>
    <p class="goal">${esc(r.goal || 'Objetivo indisponível')}</p>
    <div class="work-progress"><div><p class="activity"><span class="activity-mark ${state.key}" aria-hidden="true"></span>${esc(activity)}</p><p class="muted">${r.status === 'blocked' && !c.technology?.length ? 'Consulta as tarefas e a revisão antes de retomar no terminal.' : `${number(c.invocations)} sessão(ões) iniciada(s)`}</p></div><div class="progress-summary"><span><strong>${completed}</strong> / ${tasks.length} tarefas concluídas</span><progress max="${Math.max(tasks.length, 1)}" value="${completed}" aria-label="Tarefas concluídas em ${esc(name)}"></progress></div></div>
    ${decisions(name, c)}
    <div class="project-details"><details data-section="tasks"><summary data-focus="tasks">Tarefas e validação <span class="detail-count">${tasks.length}</span></summary><div class="task-list">${tasks.length ? tasks.map(t => `<div class="task"><span class="task-id">${esc(t.id)}</span><div class="task-title">${esc(t.title)}<small>${t.checks_passed}/${t.checks_total} verificações · Revisão ${esc(labels[t.review] || t.review || 'pendente')} · ${t.attempts} tentativa(s)${t.rotations ? ` · ${t.rotations} rotação(ões)` : ''}</small></div>${status(t.status)}</div>`).join('') : '<p class="muted">O plano de tarefas ainda não está disponível.</p>'}</div></details>
    <details data-section="sessions"><summary data-focus="sessions">Sessões e consumo <span class="detail-count">${c.usage.rows.length}</span></summary>
    <div class="metrics">${[[u.input_tokens_including_cache, 'Entrada (inclui cache)'], [u.output_tokens, 'Saída'], [u.cached_input_tokens, 'Entrada em cache']].map(([n, label]) => `<div><strong>${number(n)}</strong><span>${label}</span></div>`).join('')}</div>
    <p class="hint">Cobertura de entrada: ${u.input_covered_invocations}/${u.invocations} sessões. ${u.reported_cost_usd == null ? 'Custo monetário indisponível.' : `Estimativa nativa: $${u.reported_cost_usd.toFixed(2)} USD (${u.cost_covered_invocations}/${u.invocations} sessões); não representa a fatura da subscrição.`} Valores em curso podem estar incompletos.${c.ledger_warnings ? ' Há registos incompletos no histórico.' : ''}</p>
    ${c.usage.rows.length ? `<div class="table-scroll" role="region" aria-label="Sessões de ${esc(name)}" tabindex="0"><table><thead><tr><th>Sessão / etapa</th><th>Tarefa</th><th>Modelo / esforço</th><th>Entrada</th><th>Saída</th><th>Cache</th><th>Tempo</th></tr></thead><tbody>${c.usage.rows.map(x => `<tr><td>${x.id} · ${esc(labels[x.phase] || x.phase)}</td><td>${esc(x.task || 'Objetivo')}</td><td>${esc(x.reported_model?.trim() || x.model || 'Não exposto')} / ${esc(x.effort || '—')}</td><td>${number(x.normalized?.input)}</td><td>${number(x.normalized?.output)}</td><td>${number(x.normalized?.cached)}</td><td>${x.duration_ms == null ? '—' : number(Math.round(x.duration_ms / 1000)) + ' s'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Ainda não há sessões medidas nesta execução.</p>'}
    <p class="run-reference">${esc(r.provider)} · ${esc(r.run_id)}<br>Atualizada ${esc(r.updated_at)}</p></details></div></article>`;
}
const empty = (title, body) => `<div class="empty"><span class="empty-symbol" aria-hidden="true">◇</span><h3>${title}</h3><p>${body}</p></div>`;
export function bootCore({ doc = document, fetchImpl = globalThis.fetch, intervalMs = 5000, timeoutMs = 10000 } = {}) {
  const root = doc.getElementById('projects'), refreshButton = doc.getElementById('refresh'), life = new AbortController();
  let snapshot = null, filter = 'all', query = '', disposed = false, submitting = false, lastStates = '', first = true;
  const rendered = new Map(), choices = new Map();
  const listen = (target, event, handler) => target.addEventListener(event, handler, { signal: life.signal });
  const announce = message => { doc.getElementById('announcements').textContent = message; };
  function render() {
    if (!snapshot || disposed) return;
    const projects = selectProjects(snapshot.projects), visible = new Set(selectProjects(projects, filter, query).map(projectKey));
    const active = doc.activeElement, inside = root.contains(active);
    for (const form of root.querySelectorAll('form.technology')) {
      const value = form.querySelector('input:checked')?.value;
      if (value) choices.set(JSON.stringify([form.dataset.project, form.dataset.run, form.dataset.decision]), value);
    }
    doc.getElementById('overview').hidden = !projects.length;
    const overview = renderOverview(projects);
    if (doc.getElementById('overview').innerHTML !== overview) doc.getElementById('overview').innerHTML = overview;
    doc.getElementById('project-count').textContent = `${visible.size} de ${projects.length} projeto(s)`;
    root.querySelector('.empty')?.remove();
    for (const article of [...root.querySelectorAll('article.project')]) if (!projects.some(p => projectKey(p) === article.dataset.key)) {
      if (article.contains(active)) refreshButton.focus({ preventScroll: true });
      rendered.delete(article.dataset.key); article.remove();
    }
    const liveDecisions = new Set();
    for (const p of projects) {
      const key = projectKey(p), html = renderProject(p);
      for (const d of p.core.technology || []) liveDecisions.add(JSON.stringify([p.name, p.core.run.run_id, d.id]));
      let article = [...root.querySelectorAll('article.project')].find(a => a.dataset.key === key);
      const focusedForm = article?.contains(active) && active.closest('form.technology');
      const stillPending = focusedForm && (p.core.technology || []).some(d => d.id === focusedForm.dataset.decision);
      if (rendered.get(key) !== html && !(focusedForm && stillPending) && !submitting) {
        const open = [...(article?.querySelectorAll('details[open]') || [])].map(d => d.dataset.section);
        const focusKey = article?.contains(active) ? active.dataset.focus : null;
        const wrapper = doc.createElement('div'); wrapper.innerHTML = html;
        const replacement = wrapper.firstElementChild;
        if (article) article.replaceWith(replacement); else root.appendChild(replacement);
        article = replacement; rendered.set(key, html);
        for (const detail of article.querySelectorAll('details')) detail.open = open.includes(detail.dataset.section);
        for (const form of article.querySelectorAll('form.technology')) {
          const choice = choices.get(JSON.stringify([form.dataset.project, form.dataset.run, form.dataset.decision]));
          for (const input of form.querySelectorAll('input')) input.checked = input.value === choice;
        }
        if (focusKey) [...article.querySelectorAll('[data-focus]')].find(n => n.dataset.focus === focusKey)?.focus({ preventScroll: true });
        else if (focusedForm) refreshButton.focus({ preventScroll: true });
      }
      if (article) article.hidden = !visible.has(key);
    }
    for (const key of choices.keys()) if (!liveDecisions.has(key)) choices.delete(key);
    if (!inside) {
      let next = root.firstElementChild;
      for (const p of projects) {
        const article = [...root.querySelectorAll('article.project')].find(a => a.dataset.key === projectKey(p));
        if (!article) continue;
        if (article !== next) root.insertBefore(article, next);
        next = article.nextElementSibling;
      }
    }
    if (!visible.size) root.insertAdjacentHTML('beforeend', projects.length ? empty('Nenhum projeto nesta vista', 'Experimenta outro filtro ou pesquisa por um nome diferente.') : empty('Tudo começa com um objetivo.', 'Inicia uma execução no terminal. O projeto, as tarefas e as decisões aparecem aqui automaticamente.'));
    const states = JSON.stringify(projects.map(p => [projectKey(p), projectState(p).label, p.core.tasks?.map(t => t.status)]));
    if (states !== lastStates) {
      if (!first) announce('Estado dos projetos atualizado. ' + projects.filter(p => projectState(p).group === 'attention').length + ' precisam de atenção.');
      lastStates = states; first = false;
    }
  }
  const client = createCoreClient({ fetchImpl, timeoutMs,
    onSnapshot(data) { snapshot = data; render(); },
    onState(state) {
      if (disposed) return;
      const notice = doc.getElementById('notice');
      root.setAttribute('aria-busy', String(state.kind === 'loading'));
      doc.body.dataset.connection = state.kind;
      if (['error', 'stale'].includes(state.kind)) {
        notice.hidden = false; notice.textContent = state.message + (snapshot ? ' A mostrar os últimos dados recebidos.' : ' Usa Atualizar para tentar novamente.');
        doc.getElementById('connection').textContent = snapshot ? 'Dados desatualizados' : 'Sem ligação';
        if (!snapshot) root.innerHTML = empty('Não foi possível carregar', 'O trabalho não foi alterado. Verifica a ligação e tenta novamente.');
        announce(notice.textContent);
      } else {
        notice.hidden = true;
        doc.getElementById('connection').textContent = state.kind === 'ready' ? 'Atualizado às ' + new Date(state.at).toLocaleTimeString('pt-PT') : state.kind === 'loading' ? 'A ligar ao servidor…' : 'A atualizar…';
      }
    },
  });
  listen(refreshButton, 'click', () => client.refresh({ force: true }));
  listen(doc.getElementById('search'), 'input', event => { query = event.target.value; render(); });
  for (const button of doc.querySelectorAll('[data-filter]')) listen(button, 'click', () => {
    filter = button.dataset.filter;
    for (const b of doc.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b === button));
    render();
  });
  listen(root, 'change', event => {
    const form = event.target.closest('form.technology');
    if (form) choices.set(JSON.stringify([form.dataset.project, form.dataset.run, form.dataset.decision]), form.querySelector('input:checked')?.value);
  });
  listen(root, 'focusout', () => queueMicrotask(() => { if (!root.contains(doc.activeElement)) render(); }));
  listen(root, 'submit', async event => {
    const form = event.target.closest('form.technology');
    if (!form) return;
    event.preventDefault();
    if (submitting || !form.reportValidity()) return;
    const option = form.querySelector('input:checked')?.value;
    if (!option) return;
    submitting = true; refreshButton.disabled = true;
    const button = form.querySelector('button'), fieldset = form.querySelector('fieldset'), result = form.querySelector('.decision-result');
    button.disabled = true; fieldset.disabled = true; result.textContent = 'A guardar a tua escolha…';
    try {
      const accepted = await client.choose({ project: form.dataset.project, run: form.dataset.run, decision: form.dataset.decision, option });
      if (disposed) return;
      await client.refresh({ force: true });
      if (disposed) return;
      submitting = false;
      const message = accepted.waiting ? 'Escolha guardada; falta outra decisão.' : accepted.resumed ? 'Escolha guardada; continuação iniciada.' : 'Escolha guardada. A execução está disponível para retoma.';
      doc.getElementById('action-status').textContent = message;
      result.textContent = message;
      refreshButton.disabled = false; refreshButton.focus({ preventScroll: true }); render();
    } catch (error) {
      if (!disposed) result.textContent = error.name === 'TimeoutError' ? 'Sem confirmação do servidor. Atualiza antes de tentar novamente.' : error.message || 'Não foi possível confirmar a escolha.';
    } finally {
      submitting = false; button.disabled = false; fieldset.disabled = false; refreshButton.disabled = false;
    }
  });
  const timer = setInterval(() => { if (!doc.hidden) client.refresh(); }, intervalMs);
  client.refresh();
  function dispose() { disposed = true; clearInterval(timer); life.abort(); client.dispose(); }
  return { refresh: () => client.refresh({ force: true }), dispose };
}
if (typeof document !== 'undefined') {
  let app = bootCore();
  window.addEventListener('pagehide', () => app.dispose());
  window.addEventListener('pageshow', event => { if (event.persisted) app = bootCore(); });
}
