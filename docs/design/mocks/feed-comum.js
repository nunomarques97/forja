// Partilhado pelos três mocks do feed de eventos-chave. MOCK — não é produção.
// Traduz cada evento real (feed-dados.js) numa frase em português de pessoas,
// com o glifo e a banda de cor do DESIGN.md. Nada aqui inventa eventos.
(function () {
  const F = window.FEED;
  const agora = Date.parse(F.agora);
  const hora = ts => new Date(ts).toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Lisbon' });
  const dia = ts => new Date(ts).toLocaleDateString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Lisbon' });
  function ha(ts) {
    const m = Math.max(0, Math.round((agora - Date.parse(ts)) / 60e3));
    if (m < 1) return 'agora mesmo';
    if (m < 60) return `há ${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return r ? `há ${h} h ${r} min` : `há ${h} h`;
    return `há ${Math.floor(h / 24)} d`;
  }
  function dura(a, b) {
    const m = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 60e3));
    return m < 1 ? 'menos de 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Glifos desenhados (nunca emoji). Um por tipo de evento.
  const G = {
    chamada: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h9M8 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    inicio: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="currentColor"/></svg>',
    fim: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
    regresso: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M14 8H5M8 4 4 8l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    espera: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2.4 2.2"/></svg>',
    aprovou: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    rejeitou: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    escalada: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5 14 13H2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 6.5v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.3" r=".9" fill="currentColor"/></svg>',
    relatorio: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 14V2.5M4 3h8l-2 3 2 3H4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    parado: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4" y="4" width="8" height="8" fill="currentColor"/></svg>',
  };

  const artigo = p => (/^(QA)$/.test(p) ? 'a' : 'o');
  const ESTADO_FIM = { DONE: 'entregou', BLOCKED: 'ficou bloqueado', FAILED: 'não conseguiu', QA: 'entregou a validação', PLAN: 'entregou o plano', FRAME: 'entregou o enquadramento' };

  // Para cada evento: { glifo, banda, titulo, texto, importante, n } — n = qual dos 8 pedidos.
  function frase(e) {
    switch (e.tipo) {
      case 'chamada': return { n: 1, glifo: 'chamada', banda: 'neutro', titulo: `${e.de} chamou ${artigo(e.para)} ${e.para}`, texto: e.texto };
      case 'inicio': return { n: 2, glifo: 'inicio', banda: 'vivo', titulo: `${e.papel} começou`, texto: e.texto };
      case 'fim':
        if (e.sessao) return { n: 3, glifo: 'parado', banda: 'parado', titulo: 'A sessão caiu antes de fechar a tarefa', texto: '' };
        return { n: 3, glifo: 'fim', banda: e.estado === 'BLOCKED' || e.estado === 'FAILED' ? 'espera' : 'neutro', titulo: `${e.papel} ${ESTADO_FIM[e.estado] || 'terminou'}`, texto: e.texto };
      case 'regresso': return { n: 4, glifo: 'regresso', banda: 'neutro', titulo: e.como === 'direto' ? `Voltou ao ${e.para}` : `O ${e.para} retomou`, texto: `depois do ${e.de}` };
      case 'veredito': {
        const ok = /APPROVE/.test(e.veredito);
        return { n: 6, glifo: ok ? 'aprovou' : 'rejeitou', banda: ok ? 'ok' : 'parado', importante: true, titulo: `${e.papel} ${ok ? 'aprovou' : 'rejeitou'}`, selo: ok ? 'APROVADO' : 'REJEITADO', texto: e.texto };
      }
      case 'escalada':
        return e.motivo === 'pergunta'
          ? { n: 7, glifo: 'escalada', banda: 'parado', importante: true, titulo: 'Pergunta para ti', selo: 'PRECISA DE TI', texto: e.texto, extra: e.padrao ? `Enquanto não respondes: ${e.padrao}` : '' }
          : { n: 7, glifo: 'escalada', banda: 'parado', importante: true, titulo: 'Tarefa bloqueada', selo: 'BLOQUEADO', texto: e.texto };
      case 'relatorio': return { n: 8, glifo: 'relatorio', banda: e.falhou ? 'parado' : 'fim', importante: true, titulo: e.falhou ? 'O run falhou' : 'Run terminado — relatório entregue', selo: 'TERMINOU', texto: e.texto };
    }
    return null;
  }

  function pendente(p) {
    switch (p.tipo) {
      case 'a-decorrer': return { glifo: 'inicio', banda: 'vivo', titulo: `${p.papel} a trabalhar`, texto: p.texto, quando: `desde ${hora(p.desde)} · ${dura(p.desde, F.agora)}` };
      case 'lead': return { glifo: 'espera', banda: 'espera', titulo: 'À espera do próximo passo do Lead', texto: '', quando: `último sinal ${ha(p.desde)}` };
      case 'decisao': return { glifo: 'escalada', banda: 'parado', titulo: 'À espera da tua decisão', texto: p.texto, quando: ha(p.desde) };
      case 'pausa': return { glifo: 'espera', banda: 'espera', titulo: 'Em pausa pelo limite de utilização', texto: '', quando: `retoma às ${hora(p.ate)}` };
      case 'parado': return { glifo: 'parado', banda: 'parado', titulo: 'O runner saiu a meio do run', texto: 'O run continua aberto; a guarda dos runners relança-o sozinha.', quando: ha(p.desde) };
      case 'plano': return { glifo: 'espera', banda: 'espera', titulo: 'A seguir no plano', texto: p.texto, quando: `${p.feitas} de ${p.total} tarefas feitas` };
    }
  }

  // Estado de cada projeto, em palavras (a mesma lista do DESIGN.md).
  function estadoProjeto(nome) {
    const pr = F.projetos.find(p => p.nome === nome);
    const pend = F.pendentes.filter(p => p.projeto === nome);
    if (pend.some(p => p.tipo === 'parado')) return { palavra: 'PAROU', banda: 'parado' };
    if (pend.some(p => p.tipo === 'decisao')) return { palavra: 'À ESPERA DE TI', banda: 'parado' };
    if (pend.some(p => p.tipo === 'pausa')) return { palavra: 'EM PAUSA', banda: 'espera' };
    if (pr?.ativo) return { palavra: 'A TRABALHAR', banda: 'vivo' };
    if (pr?.fim) return { palavra: 'TERMINOU', banda: 'neutro', quando: ha(pr.fim) };
    return { palavra: 'SEM RUN', banda: 'neutro', quando: pr?.ultimo ? `último sinal ${ha(pr.ultimo)}` : 'nunca correu' };
  }

  // Projetos com alguma coisa nas últimas horas, os que precisam de alguém primeiro.
  const ORDEM = { parado: 0, espera: 1, vivo: 2, neutro: 3 };
  const projetosVisiveis = F.projetos
    .filter(p => p.ativo || F.eventos.some(e => e.projeto === p.nome))
    .map(p => ({ ...p, estado: estadoProjeto(p.nome) }))
    .sort((a, b) => ORDEM[a.estado.banda] - ORDEM[b.estado.banda] || String(b.ultimo).localeCompare(String(a.ultimo)));

  window.FEEDUI = { F, hora, dia, ha, dura, esc, G, frase, pendente, estadoProjeto, projetosVisiveis };
})();
