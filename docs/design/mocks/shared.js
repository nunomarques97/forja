// Shared by the three design mocks: loads the REAL data/events.jsonl, derives a
// small model from it, and renders the existing raw table (kept one click away).
// Mock-only code; not the production viewer.

export async function loadEvents() {
  const text = await (await fetch('/data/events.jsonl', { cache: 'no-store' })).text();
  const events = [];
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    let rec = null;
    try { rec = JSON.parse(raw); } catch {}
    events.push({ line: i + 1, raw, rec });
  });
  return events;
}

const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

// One short, human line per event, from the fields the payload really has.
export function summarize(rec) {
  const t = rec.tool_input || {};
  switch (rec.tool_name) {
    case 'Read': return base(t.file_path) + (t.limit ? ` (first ${t.limit} lines)` : '');
    case 'Write': case 'Edit': return base(t.file_path);
    case 'Bash': return t.description || String(t.command || '').slice(0, 80);
    case 'Agent': return t.description || 'subagent';
    case 'SubagentHandback': return String(t.message || '').split('\n')[0];
    default: return JSON.stringify(t).slice(0, 80);
  }
}

export function verdictOf(rec) {
  const m = String((rec.tool_input || {}).message || '').match(/^\s*([A-Z_]{3,})\b/);
  return m ? m[1] : null;
}

export const t0 = rec => Date.parse(rec.ts);
export const fmtTime = ms => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });
export const fmtDur = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;

export function model(events) {
  const ok = events.filter(e => e.rec);
  const projects = new Map();
  for (const e of ok) {
    const name = e.rec.project || '(none)';
    if (!projects.has(name)) projects.set(name, { name, events: [], sessions: new Set(), tools: new Map() });
    const p = projects.get(name);
    p.events.push(e);
    p.sessions.add(e.rec.session_id);
    p.tools.set(e.rec.tool_name, (p.tools.get(e.rec.tool_name) || 0) + 1);
  }
  // Handoffs: the payload has no explicit link between the parent's Agent call
  // and the subagent's agent_id, so they are paired by time overlap within the
  // same session: Agent PostToolUse ts minus duration_ms = when it started.
  const handoffs = [];
  for (const e of ok.filter(e => e.rec.tool_name === 'Agent' && !e.rec.agent_type)) {
    const end = t0(e.rec), start = end - (e.rec.duration_ms || 0);
    const inside = ok.filter(x => x.rec.agent_type && x.rec.session_id === e.rec.session_id && t0(x.rec) >= start && t0(x.rec) <= end);
    const back = inside.find(x => x.rec.tool_name === 'SubagentHandback');
    handoffs.push({
      call: e, start, end, project: e.rec.project,
      agentType: inside[0]?.rec.agent_type || null,
      agentId: inside[0]?.rec.agent_id || null,
      events: inside, handback: back, verdict: back ? verdictOf(back.rec) : null,
    });
  }
  const times = ok.map(e => t0(e.rec));
  return { events, ok, projects: [...projects.values()], handoffs, first: Math.min(...times), last: Math.max(...times), bad: events.length - ok.length };
}

// Compressed time axis: idle gaps longer than GAP_MS collapse to a fixed break.
export function timeScale(times, width, { gapMs = 90_000, breakPx = 36 } = {}) {
  const sorted = [...times].sort((a, b) => a - b);
  const segs = [];
  let s = sorted[0], prev = sorted[0];
  for (const t of sorted.slice(1)) {
    if (t - prev > gapMs) { segs.push([s, prev]); s = t; }
    prev = t;
  }
  segs.push([s, prev]);
  const pad = 4000;
  const active = segs.reduce((n, [a, b]) => n + (b - a) + 2 * pad, 0);
  const pxPerMs = (width - breakPx * (segs.length - 1)) / active;
  let x = 0;
  const layout = segs.map(([a, b], i) => {
    const seg = { a: a - pad, b: b + pad, x0: x };
    x += (seg.b - seg.a) * pxPerMs;
    seg.x1 = x;
    if (i < segs.length - 1) x += breakPx;
    return seg;
  });
  const scale = t => {
    for (const g of layout) if (t <= g.b) return g.x0 + Math.max(0, t - g.a) * pxPerMs;
    const g = layout[layout.length - 1];
    return g.x1;
  };
  scale.segments = layout;
  return scale;
}

// The existing viewer's table, same columns and same click-# raw expansion.
const COLS = ['ts', 'project', 'hook_event_name', 'tool_name', 'agent_type', 'agent_id', 'tool_input', 'session_id', 'cwd', 'permission_mode', 'duration_ms', 'tool_use_id'];
const fmt = v => v === undefined ? '' : v === null ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v);

export function renderRawTable(host, events) {
  host.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'raw-wrap';
  const table = document.createElement('table');
  table.className = 'raw';
  table.innerHTML = `<thead><tr><th>#</th>${COLS.map(c => `<th>${c}</th>`).join('')}</tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const e of events) {
    const tr = document.createElement('tr');
    tr.id = `raw-${e.line}`;
    const num = document.createElement('td');
    num.textContent = e.line;
    num.className = 'num';
    tr.appendChild(num);
    for (const c of COLS) {
      const td = document.createElement('td');
      let v = e.rec ? fmt(e.rec[c]) : (c === 'tool_input' ? 'UNPARSEABLE LINE: ' + e.raw : '');
      if (c === 'tool_input') { td.className = 'input'; if (v.length > 300) v = `${v.slice(0, 300)}… (+${v.length - 300} chars, click # for full record)`; }
      td.textContent = v;
      tr.appendChild(td);
    }
    const detail = document.createElement('tr');
    detail.hidden = true;
    detail.innerHTML = `<td colspan="${COLS.length + 1}"><pre></pre></td>`;
    detail.querySelector('pre').textContent = e.rec ? JSON.stringify(e.rec, null, 2) : e.raw;
    num.onclick = () => { detail.hidden = !detail.hidden; };
    tr.detail = detail;
    tbody.append(tr, detail);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  host.appendChild(wrap);
}

export function openRaw(line) {
  const tr = document.getElementById(`raw-${line}`);
  if (!tr) return;
  tr.detail.hidden = false;
  tr.scrollIntoView({ block: 'center' });
  tr.classList.add('flash');
}

// Tabs: "Visual" / "Raw table". The hash keeps the choice, so #table opens it directly
// (not #raw: that matches the section id and would make the browser scroll to it).
export function wireTabs(onRaw) {
  const show = which => {
    document.body.dataset.view = which;
    document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === which)));
  };
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { show(b.dataset.tab); history.replaceState(null, '', b.dataset.tab === 'raw' ? '#table' : '#'); });
  window.jumpToRaw = line => { show('raw'); onRaw?.(); openRaw(line); };
  show(location.hash === '#table' ? 'raw' : 'visual');
}

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
