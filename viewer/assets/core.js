import { createCoreClient } from './core-client.js';
const labels = { running: 'In progress', done: 'Completed', blocked: 'Blocked', failed: 'Failed', todo: 'To do', develop: 'Implementation', validate: 'Validation', review: 'Review', plan: 'Planning', approve: 'Approved', reject: 'Rejected' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = value => value == null ? '—' : new Intl.NumberFormat('en').format(value);
const status = (key, text = labels[key] || key) => `<span class="status ${esc(key)}"><span aria-hidden="true"></span>${esc(text)}</span>`;
const costs = { free: 'No expected cost', paid: 'Paid option', unknown: 'Cost unknown' };
const projectKey = p => JSON.stringify([p.name, p.core.run?.run_id]);
export function projectState(p) {
  const c = p.core;
  if (c.error) return { group: 'attention', key: 'failed', label: 'Status unavailable' };
  if (c.technology?.length) return { group: 'attention', key: 'blocked', label: 'Needs you' };
  if (c.run.status === 'running' && !c.runnerAlive) return { group: 'attention', key: 'blocked', label: 'Interrupted' };
  if (['blocked', 'failed'].includes(c.run.status)) return { group: 'attention', key: c.run.status, label: labels[c.run.status] };
  return { group: c.run.status === 'done' ? 'done' : 'running', key: c.run.status, label: labels[c.run.status] || c.run.status };
}
export function selectProjects(projects, filter = 'all', query = '') {
  const term = query.trim().toLocaleLowerCase('en');
  const rank = { attention: 0, running: 1, done: 2 };
  return projects.filter(p => (filter === 'all' || projectState(p).group === filter) && `${p.name} ${p.core.run?.goal || ''}`.toLocaleLowerCase('en').includes(term))
    .sort((a, b) => rank[projectState(a).group] - rank[projectState(b).group] || a.name.localeCompare(b.name, 'en'));
}
export function renderOverview(projects) {
  const groups = projects.map(projectState);
  return [[projects.length, 'Projects', 'total'], [groups.filter(s => s.group === 'running').length, 'In progress', 'running'], [groups.filter(s => s.group === 'attention').length, 'Needs attention', 'attention'], [groups.filter(s => s.group === 'done').length, 'Completed', 'done']]
    .map(([n, label, kind]) => `<div class="overview-item ${kind}"><span>${label}</span><strong>${number(n)}</strong></div>`).join('');
}
const decisions = (name, c) => (c.technology || []).map(d => `<form class="technology" data-project="${esc(name)}" data-run="${esc(c.run.run_id)}" data-decision="${esc(d.id)}">
  <p class="eyebrow">YOUR DECISION · WORK PAUSED</p><fieldset><legend>${esc(d.capability)}</legend><p>${esc(d.constraints)}</p>
  <div class="options">${d.options.map(o => `<div class="option"><label class="technology-option"><input type="radio" name="choice" value="${esc(o.id)}" required><span><strong>${esc(o.name)}</strong><span class="cost">${esc(costs[o.cost])}</span><span>${esc(o.cost_basis)}</span><span>${esc(o.tradeoffs)}</span>${o.id === d.recommended ? '<span class="recommendation">Recommended by FORJA</span>' : ''}</span></label>${(o.sources || []).map(s => `<a class="source" href="${esc(s)}" target="_blank" rel="noopener noreferrer">View source ↗</a>`).join('')}</div>`).join('')}</div></fieldset>
  <p><strong>Why this recommendation:</strong> ${esc(d.rationale)}</p><p class="hint">Choose an option to continue. This choice does not make any payments.</p><button type="submit">Confirm choice <span aria-hidden="true">↗</span></button><p class="decision-result" role="status"></p></form>`).join('');
export function renderProject(p) {
  const { name, core: c } = p, state = projectState(p), key = esc(projectKey(p));
  if (c.error) return `<article class="project needs-attention" data-key="${key}"><div class="project-top"><h3>${esc(name)}</h3>${status(state.key, state.label)}</div><p class="warning">${esc(c.error)}</p><p class="muted">Could not read this project. Other projects are still available.</p></article>`;
  const r = c.run, u = c.usage.totals, tasks = c.tasks || [], completed = tasks.filter(t => t.status === 'done').length;
  const currentTask = tasks.find(t => t.id === c.pending?.task);
  const activity = r.status === 'done' ? 'Run completed' : c.technology?.length ? 'Waiting for your choice' : !c.runnerAlive ? 'No active process' : c.pending ? `${labels[c.pending.phase] || c.pending.phase}${currentTask ? ' · ' + currentTask.title : ''}` : 'Process active · waiting for the next step';
  return `<article class="project ${state.group === 'attention' ? 'needs-attention' : ''}" data-key="${key}">
    <div class="project-top"><div class="project-name"><span class="project-icon" aria-hidden="true">${esc(name.slice(0, 1).toLocaleUpperCase())}</span><h3>${esc(name)}</h3></div>${status(state.key, state.label)}</div>
    <p class="goal">${esc(r.goal || 'Goal unavailable')}</p>
    <div class="work-progress"><div><p class="activity"><span class="activity-mark ${state.key}" aria-hidden="true"></span>${esc(activity)}</p><p class="muted">${r.status === 'blocked' && !c.technology?.length ? 'Check the tasks and review before resuming in the terminal.' : `${number(c.invocations)} session${c.invocations === 1 ? '' : 's'} started`}</p></div><div class="progress-summary"><span><strong>${completed}</strong> / ${tasks.length} tasks completed</span><progress max="${Math.max(tasks.length, 1)}" value="${completed}" aria-label="Completed tasks in ${esc(name)}"></progress></div></div>
    ${decisions(name, c)}
    <div class="project-details"><details data-section="tasks"><summary data-focus="tasks">Tasks and validation <span class="detail-count">${tasks.length}</span></summary><div class="task-list">${tasks.length ? tasks.map(t => `<div class="task"><span class="task-id">${esc(t.id)}</span><div class="task-title">${esc(t.title)}<small>${t.checks_passed}/${t.checks_total} checks · Review ${esc(labels[t.review] || t.review || 'pending')} · ${t.attempts} attempt${t.attempts === 1 ? '' : 's'}${t.rotations ? ` · ${t.rotations} rotation${t.rotations === 1 ? '' : 's'}` : ''}</small></div>${status(t.status)}</div>`).join('') : '<p class="muted">The task plan is not available yet.</p>'}</div></details>
    <details data-section="sessions"><summary data-focus="sessions">Sessions and usage <span class="detail-count">${c.usage.rows.length}</span></summary>
    <div class="metrics">${[[u.input_tokens_including_cache, 'Input (including cache)'], [u.output_tokens, 'Output'], [u.cached_input_tokens, 'Cached input']].map(([n, label]) => `<div><strong>${number(n)}</strong><span>${label}</span></div>`).join('')}</div>
    <p class="hint">Input coverage: ${u.input_covered_invocations}/${u.invocations} sessions. ${u.reported_cost_usd == null ? 'Monetary cost unavailable.' : `Native estimate: $${u.reported_cost_usd.toFixed(2)} USD (${u.cost_covered_invocations}/${u.invocations} sessions); this is not your subscription bill.`} Measurements for ongoing work may be incomplete.${c.ledger_warnings ? ' Some ledger records are incomplete.' : ''}</p>
    ${c.usage.rows.length ? `<div class="table-scroll" role="region" aria-label="Sessions for ${esc(name)}" tabindex="0"><table><thead><tr><th>Session / phase</th><th>Task</th><th>Model / effort</th><th>Input</th><th>Output</th><th>Cache</th><th>Time</th></tr></thead><tbody>${c.usage.rows.map(x => `<tr><td>${x.id} · ${esc(labels[x.phase] || x.phase)}</td><td>${esc(x.task || 'Goal')}</td><td>${esc(x.reported_model?.trim() || x.model || 'Not reported')} / ${esc(x.effort || '—')}</td><td>${number(x.normalized?.input)}</td><td>${number(x.normalized?.output)}</td><td>${number(x.normalized?.cached)}</td><td>${x.duration_ms == null ? '—' : number(Math.round(x.duration_ms / 1000)) + ' s'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No measured sessions in this run yet.</p>'}
    <p class="run-reference">${esc(r.provider)} · ${esc(r.run_id)}<br>Updated ${esc(r.updated_at)}</p></details></div></article>`;
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
    doc.getElementById('project-count').textContent = `${visible.size} of ${projects.length} projects`;
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
    if (!visible.size) root.insertAdjacentHTML('beforeend', projects.length ? empty('No projects in this view', 'Try another filter or search for a different name.') : empty('It starts with a goal.', 'Start a run in the terminal. Its project, tasks and decisions will appear here automatically.'));
    const states = JSON.stringify(projects.map(p => [projectKey(p), projectState(p).label, p.core.tasks?.map(t => t.status)]));
    if (states !== lastStates) {
      if (!first) announce('Project status updated. ' + projects.filter(p => projectState(p).group === 'attention').length + ' need attention.');
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
        notice.hidden = false; notice.textContent = state.message + (snapshot ? ' Showing the last received data.' : ' Use Refresh to try again.');
        doc.getElementById('connection').textContent = snapshot ? 'Data out of date' : 'Disconnected';
        if (!snapshot) root.innerHTML = empty('Could not load your work', 'Your work has not changed. Check the connection and try again.');
        announce(notice.textContent);
      } else {
        notice.hidden = true;
        doc.getElementById('connection').textContent = state.kind === 'ready' ? 'Updated at ' + new Date(state.at).toLocaleTimeString('en') : state.kind === 'loading' ? 'Connecting to the server…' : 'Refreshing…';
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
    button.disabled = true; fieldset.disabled = true; result.textContent = 'Saving your choice…';
    try {
      const accepted = await client.choose({ project: form.dataset.project, run: form.dataset.run, decision: form.dataset.decision, option });
      if (disposed) return;
      await client.refresh({ force: true });
      if (disposed) return;
      submitting = false;
      const message = accepted.waiting ? 'Choice saved; another decision is still pending.' : accepted.resumed ? 'Choice saved; continuation started.' : 'Choice saved. The run is ready to resume.';
      doc.getElementById('action-status').textContent = message;
      result.textContent = message;
      refreshButton.disabled = false; refreshButton.focus({ preventScroll: true }); render();
    } catch (error) {
      if (!disposed) result.textContent = error.name === 'TimeoutError' ? 'No confirmation from the server. Refresh before trying again.' : error.message || 'Could not confirm the choice.';
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
