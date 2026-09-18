// Instantâneo REAL para os mocks do feed de eventos-chave (18 set 2026).
// Lê data/events*.jsonl e data/projects.json deste PC, fica só com os oito
// eventos-chave e escreve docs/design/mocks/feed-dados.js. Não é código de
// produção: é a prova de que cada linha dos mocks vem de um evento verdadeiro.
//   node docs/design/mocks/feed-extrair.mjs [--horas 30]
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const data = join(root, 'data');
const horas = Number(process.argv[process.argv.indexOf('--horas') + 1]) || 30;

const PAPEL = {
  architect: 'Architect', 'backend-dev': 'Backend Dev', 'frontend-dev': 'Frontend Dev',
  reviewer: 'Reviewer', 'security-reviewer': 'Security Reviewer', qa: 'QA',
  'product-manager': 'Product Manager', 'product-designer': 'Product Designer',
  'technology-scout': 'Technology Scout',
};
const projetos = JSON.parse(readFileSync(join(data, 'projects.json'), 'utf8')).projects;
const nomes = new Set(projetos.map(p => p.name));

const linhas = [];
for (const f of readdirSync(data).filter(f => /^events.*\.jsonl$/.test(f)).sort()) {
  for (const l of readFileSync(join(data, f), 'utf8').split('\n')) {
    if (!l) continue;
    try { const e = JSON.parse(l); if (nomes.has(e.project)) linhas.push(e); } catch {}
  }
}
linhas.sort((a, b) => a.ts.localeCompare(b.ts));
const agora = Date.parse(linhas.at(-1).ts);
const desde = agora - horas * 3600e3;

const limpa = s => String(s || '').replace(/^\s*[A-Z]\d*[a-z]?\s*·\s*[A-Za-z ]+:\s*/, '').replace(/\s+/g, ' ').trim();
const corta = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const primeira = s => String(s || '').trim().split('\n').find(x => x.trim()) || '';

const eventos = [];
const chamadas = new Map();   // agentId -> { papel, texto, projeto, sessao }
const abertos = new Map();    // agentId -> SubagentStart
const fechados = new Set();
const perguntas = new Map();  // run:Q -> ask
const ultimoFimPorSessao = new Map();
const estadoRun = new Map();  // projeto -> { vivo, pausa, fim }
const push = (e, tipo, extra) => { const o = { ts: e.ts, projeto: e.project, tipo, ...extra }; if (Date.parse(e.ts) >= desde) eventos.push(o); return o; };

// Pre/Post do Agent emparelham-se pelo tool_use_id; o agentId só vem no Post.
const prePorUso = new Map();
for (const e of linhas) {
  const h = e.hook_event_name;
  const quem = e.agent_type ? (PAPEL[e.agent_type] || null) : 'Lead';
  if (h === 'PreToolUse' && e.tool_name === 'Agent') {
    const para = PAPEL[e.tool_input?.subagent_type];
    if (!para || !quem) continue;
    const texto = corta(limpa(e.tool_input.description));
    prePorUso.set(e.tool_use_id, { para, texto, ev: null, sessao: e.session_id });
    prePorUso.get(e.tool_use_id).ev = push(e, 'chamada', { de: quem, para, texto, fundo: !!e.tool_input.run_in_background });
  } else if (h === 'PostToolUse' && e.tool_name === 'Agent') {
    const pre = prePorUso.get(e.tool_use_id);
    const id = e.tool_response?.agentId;
    if (pre && id) { chamadas.set(id, { ...pre, sessao: e.session_id }); pre.ev.id = id; }
    if (pre && e.tool_response?.status === 'completed') push(e, 'regresso', { id, de: pre.para, para: quem || 'Lead', como: 'direto' });
  } else if (h === 'SubagentStart' && PAPEL[e.agent_type]) {
    abertos.set(e.agent_id, e);
    // Uma chamada síncrona só recebe o agentId quando acaba: liga-a ao arranque pelo papel e pela sessão.
    if (!chamadas.has(e.agent_id)) {
      const pre = [...prePorUso.values()].reverse().find(x => !x.ev?.id && x.sessao === e.session_id && x.para === PAPEL[e.agent_type]);
      if (pre?.ev) { pre.ev.id = e.agent_id; chamadas.set(e.agent_id, { ...pre }); }
    }
    const c = chamadas.get(e.agent_id);
    push(e, 'inicio', { id: e.agent_id, papel: PAPEL[e.agent_type], texto: c?.texto || '' });
  } else if (h === 'SubagentStop' && PAPEL[e.agent_type] && !fechados.has(e.agent_id)) {
    fechados.add(e.agent_id); abertos.delete(e.agent_id);
    const papel = PAPEL[e.agent_type];
    const l1 = primeira(e.last_assistant_message);
    const m = l1.match(/^\W*(SECURITY-APPROVE|SECURITY-REJECT|APPROVE|REJECT|DONE|BLOCKED|FAILED|QA|PLAN|FRAME)\b\W*(.*)$/);
    const palavra = m?.[1] || null;
    const resto = corta(limpa((m?.[2] || l1).replace(/^T\d+[a-z]?\s*[—:-]\s*/, '')));
    if (/APPROVE|REJECT/.test(palavra || '')) push(e, 'veredito', { id: e.agent_id, papel, veredito: palavra, texto: resto });
    else push(e, 'fim', { id: e.agent_id, papel, estado: palavra, texto: resto });
    ultimoFimPorSessao.set(e.session_id, { papel, ts: e.ts, id: e.agent_id });
  } else if (h === 'PreToolUse' && !e.agent_id && ultimoFimPorSessao.has(e.session_id)) {
    const f = ultimoFimPorSessao.get(e.session_id); ultimoFimPorSessao.delete(e.session_id);
    push(e, 'regresso', { id: f.id, de: f.papel, para: 'Lead', como: 'retomou' });
  } else if (h === 'Forja') {
    const f = e.forja || {};
    const r = estadoRun.get(e.project) || {};
    if (f.kind === 'run.start') Object.assign(r, { vivo: true, fim: null, pausa: null });
    if (f.kind === 'run.pause') r.pausa = f.resume_at;
    if (f.kind === 'runner.session') r.pausa = null;
    if (f.kind === 'ask') { perguntas.set(f.run_id + f.id, { ...f, ts: e.ts, projeto: e.project }); push(e, 'escalada', { motivo: 'pergunta', texto: corta(f.text), padrao: corta(f.default || '', 100) }); }
    if (f.kind === 'answer.pending' || f.kind === 'answer') perguntas.delete(f.run_id + f.id);
    if (f.kind === 'task.done' && f.verdict) { const m = String(f.verdict).match(/^(SECURITY-APPROVE|APPROVE)\W*(.*)$/); push(e, 'veredito', { papel: 'Reviewer', veredito: m?.[1] || 'APPROVE', texto: corta(limpa((m?.[2] || '').replace(/^(T\w+\s*[—:-]\s*)+/, ''))), fonte: 'run' }); }
    if (f.kind === 'task.fail') {
      const m = String(f.why || '').match(/^(SECURITY-REJECT|REJECT)\W*(.*)$/);
      if (m) push(e, 'veredito', { papel: m[1].startsWith('SEC') ? 'Security Reviewer' : 'Reviewer', veredito: m[1], texto: corta(m[2]), fonte: 'run' });
      else push(e, 'fim', { papel: 'Lead', estado: 'FAILED', texto: corta(f.why || ''), sessao: true });
    }
    if (f.kind === 'runner.exit') { r.parou = e.ts; r.porque = f.note || f.why || ''; }
    if (f.kind === 'run.resume' || f.kind === 'run.start') r.parou = null;
    if (f.kind === 'task.block') push(e, 'escalada', { motivo: 'bloqueado', texto: corta(f.why) });
    if (f.kind === 'run.finish' || f.kind === 'run.fail') { r.vivo = false; r.fim = e.ts; push(e, 'relatorio', { falhou: f.kind === 'run.fail', texto: corta(f.note || f.why || '', 220) }); }
    estadoRun.set(e.project, r);
  }
}

// Um veredito do run e o Stop do mesmo Reviewer são o mesmo facto: fica o do run.
for (let i = eventos.length - 1; i >= 0; i--) {
  const v = eventos[i];
  if (v.tipo !== 'veredito' || v.fonte === 'run') continue;
  if (eventos.some(o => o.fonte === 'run' && o.projeto === v.projeto && Math.abs(Date.parse(o.ts) - Date.parse(v.ts)) < 10 * 60e3)) eventos.splice(i, 1);
}
// 5 — o que está para acontecer, derivado do mesmo registo (nunca inventado).
const ultimoPorProjeto = new Map();
for (const e of linhas) ultimoPorProjeto.set(e.project, e.ts);
const pendentes = [];
const ultimoPorSessao = new Map();
for (const e of linhas) ultimoPorSessao.set(e.session_id, e.ts);
for (const [id, s] of abertos) {
  const c = chamadas.get(id);
  // Só está «a decorrer» se a sessão dele deu sinal há menos de 15 min e ninguém do mesmo papel arrancou depois.
  if (agora - Date.parse(ultimoPorSessao.get(s.session_id) || s.ts) > 15 * 60e3) continue;
  if ([...abertos.values()].some(o => o !== s && o.project === s.project && o.agent_type === s.agent_type && o.ts > s.ts)) continue;
  pendentes.push({ projeto: s.project, tipo: 'a-decorrer', papel: PAPEL[s.agent_type], desde: s.ts, texto: c?.texto || '' });
}
for (const q of perguntas.values()) if (estadoRun.get(q.projeto)?.vivo) pendentes.push({ projeto: q.projeto, tipo: 'decisao', desde: q.ts, texto: corta(q.text), padrao: corta(q.default || '', 100) });
for (const [p, r] of estadoRun) {
  if (r.vivo && r.parou) { for (let i = pendentes.length - 1; i >= 0; i--) if (pendentes[i].projeto === p && pendentes[i].tipo === "a-decorrer") pendentes.splice(i, 1); pendentes.push({ projeto: p, tipo: 'parado', desde: r.parou, texto: 'O runner parou a meio do run — a guarda relança-o sozinha' }); continue; }
  if (r.vivo && r.pausa) pendentes.push({ projeto: p, tipo: 'pausa', desde: ultimoPorProjeto.get(p), ate: r.pausa, texto: 'Pausa pelo limite de utilização' });
  if (r.vivo && !r.pausa && !pendentes.some(x => x.projeto === p && x.tipo === 'a-decorrer')) {
    pendentes.push({ projeto: p, tipo: 'lead', desde: ultimoPorProjeto.get(p), texto: 'À espera do próximo passo do Lead' });
  }
}
// A seguir no plano (TASKS.json do próprio projeto).
for (const p of projetos) {
  const f = join(p.path, 'docs', 'forja', 'TASKS.json');
  if (!estadoRun.get(p.name)?.vivo || !existsSync(f)) continue;
  try {
    const t = JSON.parse(readFileSync(f, 'utf8'));
    const lista = Array.isArray(t) ? t : t.tasks || [];
    const feitas = lista.filter(x => x.status === 'done').length;
    const prox = lista.find(x => x.status === 'todo' || x.status === 'pending');
    if (prox) pendentes.push({ projeto: p.name, tipo: 'plano', texto: corta(limpa(prox.title).replace(/^T\d+[a-z]?\s*-\s*/, ''), 110), feitas, total: lista.length });
  } catch {}
}

const resumo = projetos.map(p => {
  const r = estadoRun.get(p.name) || {};
  return { nome: p.name, ativo: !!r.vivo, ultimo: ultimoPorProjeto.get(p.name) || null, fim: r.fim || null };
});
eventos.reverse();
const cont = eventos.reduce((a, e) => ((a[e.tipo] = (a[e.tipo] || 0) + 1), a), {});
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'feed-dados.js'),
  `// Gerado por feed-extrair.mjs a partir de data/events*.jsonl deste PC — não editar à mão.\n`
  + `window.FEED = ${JSON.stringify({ agora: new Date(agora).toISOString(), horas, projetos: resumo, pendentes, eventos }, null, 1)};\n`);
console.log({ agora: new Date(agora).toISOString(), eventos: eventos.length, por_tipo: cont, pendentes: pendentes.length, projetos: resumo.map(r => `${r.nome}:${r.ativo ? 'ativo' : '-'}`) });
