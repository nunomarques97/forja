// Dados partilhados pelas três direções do «centro de controlo» (redesenho do
// viewer, 18 set 2026). MOCK: nada aqui é código de produção — o viewer real
// continua em `viewer/`. As três direções carregam exatamente os mesmos
// projetos, os mesmos estados e as mesmas palavras, para a comparação ser
// entre desenhos e não entre conteúdos.
//
// A ORIGEM DOS DADOS É REAL: instantâneo do redutor (`viewer/lib/state.mjs`)
// sobre o `data/events.jsonl` desta máquina, em dois momentos verdadeiros:
//   · cena "agora"  → 17 set 2026, 19:12 (dois runs ao mesmo tempo: juniper-hill
//     e violet-pier; Backend Dev entregou e espera pelo Reviewer)
//   · cena "parado" → 18 set 2026, 00:16 (violet-pier sem sinal há 3h49 — o
//     runner morreu e ninguém avisou; juniper-hill a trabalhar; granite fechado)
// O que foi reescrito à mão: as FRASES. Os títulos de task e as ações do
// redutor vêm em linguagem de programador ("T7b: renderer DOCX em
// services/render/docx.py"); o Sponsor não quer isso na vista principal, por
// isso o mock mostra a mesma verdade em português simples. Ver
// `docs/design/mocks/README.md`, secção «Linguagem».

// ---- as três bandas de sinal + a banda neutra ------------------------------
// VIVO    (verde)    = a trabalhar e com sinal fresco (< 90 s)
// ESPERA  (amarelo)  = a trabalhar em silêncio, à espera de review/input/quota,
//                      em pausa — teve sinal há menos de X (X = 5 min)
// PARADO  (vermelho) = sem sinal há mais de X, morto, falhou, ou o run devia
//                      estar a andar e não anda
// NEUTRO  (cinzento) = já entregou o que tinha para entregar, ou ainda não foi
//                      chamado. Presente, sem sinal, sem problema.
export const BANDAS = {
  vivo:   { cor: 'var(--vivo)',   palavra: 'a trabalhar' },
  espera: { cor: 'var(--espera)', palavra: 'à espera' },
  parado: { cor: 'var(--parado)', palavra: 'parado' },
  neutro: { cor: 'var(--neutro)', palavra: 'em repouso' },
};

// ---- os dez papéis (ordem e chaves do redutor) -----------------------------
export const PAPEIS = [
  { key: 'lead',              mono: 'Le', nome: 'Lead',              nucleo: true },
  { key: 'architect',         mono: 'Ar', nome: 'Architect',         nucleo: true },
  { key: 'frontend-dev',      mono: 'FD', nome: 'Frontend Dev',      nucleo: true },
  { key: 'backend-dev',       mono: 'BD', nome: 'Backend Dev',       nucleo: true },
  { key: 'reviewer',          mono: 'Re', nome: 'Reviewer',          nucleo: true },
  { key: 'product-manager',   mono: 'PM', nome: 'Product Manager',   nucleo: false },
  { key: 'product-designer',  mono: 'PD', nome: 'Product Designer',  nucleo: false },
  { key: 'technology-scout',  mono: 'TS', nome: 'Technology Scout',  nucleo: false },
  { key: 'qa',                mono: 'QA', nome: 'QA',                nucleo: false },
  { key: 'security-reviewer', mono: 'SR', nome: 'Security Reviewer', nucleo: false },
];
export const porKey = k => PAPEIS.find(p => p.key === k);

// ---- ligações: quem chama quem (fixas) e o caminho ativo (do stream) -------
// `chamada` = o Lead é o único que chama alguém (ferramenta `Agent`).
// `fluxo`   = quem entrega trabalho a quem (representação).
// O que muda com o estado é só QUAL destas ligações está ACESA agora: a que
// liga o Lead a quem ele está à espera, e a entrega que acabou de acontecer.
export const LIGACOES = [
  { a: 'lead', b: 'architect',         tipo: 'chamada' },
  { a: 'lead', b: 'frontend-dev',      tipo: 'chamada' },
  { a: 'lead', b: 'backend-dev',       tipo: 'chamada' },
  { a: 'lead', b: 'reviewer',          tipo: 'chamada' },
  { a: 'lead', b: 'product-manager',   tipo: 'chamada' },
  { a: 'lead', b: 'product-designer',  tipo: 'chamada' },
  { a: 'lead', b: 'technology-scout',  tipo: 'chamada' },
  { a: 'lead', b: 'qa',                tipo: 'chamada' },
  { a: 'lead', b: 'security-reviewer', tipo: 'chamada' },
  { a: 'architect',    b: 'frontend-dev',      tipo: 'fluxo' },
  { a: 'architect',    b: 'backend-dev',       tipo: 'fluxo' },
  { a: 'frontend-dev', b: 'reviewer',          tipo: 'fluxo' },
  { a: 'backend-dev',  b: 'reviewer',          tipo: 'fluxo' },
  { a: 'reviewer',     b: 'security-reviewer', tipo: 'fluxo' },
  { a: 'product-manager',  b: 'architect',     tipo: 'fluxo' },
  { a: 'technology-scout', b: 'backend-dev',   tipo: 'fluxo' },
  { a: 'product-designer', b: 'frontend-dev',  tipo: 'fluxo' },
  { a: 'qa',           b: 'lead',              tipo: 'fluxo' },
];

// ---- cena 1: dois projetos a trabalhar ao mesmo tempo (real, 19:12) --------
const agora = [
  {
    projeto: 'juniper-hill',
    estado: 'vivo',
    palavra: 'A TRABALHAR',
    fase: 'rever',
    desde: 'começou há 3 h 38 min',
    resumo: 'O Lead está à espera do Security Reviewer.',
    aFazer: 'Gerar o relatório em Word',
    ultimo: 'O Reviewer aprovou o gerador de Word há 5 minutos.',
    espera: 'security-reviewer',
    entregaRecente: { a: 'reviewer', b: 'lead' },
    humano: false,
    contagem: { vivo: 2, espera: 1, parado: 0, neutro: 7 },
    tarefas: { feitas: 2, total: 8 },
    equipa: {
      'lead':              { banda: 'vivo',   frase: 'à espera do Security Reviewer', ha: 'sinal há 25 s' },
      'security-reviewer': { banda: 'vivo',   frase: 'a verificar os dados escondidos dentro do ficheiro Word', ha: 'sinal há 4 s' },
      'backend-dev':       { banda: 'espera', frase: 'entregou o gerador de Word — à espera de revisão', ha: 'sinal há 13 min' },
      'reviewer':          { banda: 'neutro', frase: 'aprovou a última entrega', ha: 'há 5 min' },
      'architect':         { banda: 'neutro', frase: 'entregou o plano de 8 tarefas', ha: 'há 3 h' },
      'product-manager':   { banda: 'neutro', frase: 'enquadrou o trabalho no início', ha: 'há 3 h' },
      'technology-scout':  { banda: 'neutro', frase: 'escolheu as ferramentas de exportação', ha: 'há 3 h' },
      'frontend-dev':      { banda: 'neutro', frase: 'ainda não foi preciso', ha: null },
      'product-designer':  { banda: 'neutro', frase: 'ainda não foi preciso', ha: null },
      'qa':                { banda: 'neutro', frase: 'ainda não foi preciso', ha: null },
    },
    linha: [
      { h: '18:06', t: 'O Reviewer aprovou o gerador de Word.' },
      { h: '18:07', t: 'O Security Reviewer começou a verificação de segurança.' },
      { h: '18:12', t: 'A verificar os dados escondidos dentro do ficheiro Word.' },
    ],
  },
  {
    projeto: 'violet-pier',
    estado: 'vivo',
    palavra: 'A TRABALHAR',
    fase: 'fechar',
    desde: 'começou há 7 h 21 min',
    resumo: 'O Lead está à espera do QA.',
    aFazer: 'Validação final antes de publicar',
    ultimo: 'O QA começou a validação final há 9 minutos.',
    espera: 'qa',
    entregaRecente: null,
    humano: false,
    contagem: { vivo: 2, espera: 0, parado: 0, neutro: 8 },
    tarefas: { feitas: 9, total: 10 },
    equipa: {
      'lead':              { banda: 'vivo',   frase: 'à espera do QA', ha: 'sinal há 4 s' },
      'qa':                { banda: 'vivo',   frase: 'a procurar ligações à internet no código', ha: 'sinal há 4 s' },
      'reviewer':          { banda: 'neutro', frase: 'aprovou a última entrega', ha: 'há 10 min' },
      'frontend-dev':      { banda: 'neutro', frase: 'entregou os ecrãs de arranque', ha: 'há 21 min' },
      'backend-dev':       { banda: 'neutro', frase: 'entregou o guia de instalação', ha: 'há 1 h 40' },
      'architect':         { banda: 'neutro', frase: 'entregou o plano de 10 tarefas', ha: 'há 1 h 55' },
      'product-manager':   { banda: 'neutro', frase: 'enquadrou o trabalho no início', ha: 'há 4 h 23' },
      'security-reviewer': { banda: 'neutro', frase: 'aprovou a segurança', ha: 'há 4 h 58' },
      'product-designer':  { banda: 'neutro', frase: 'ainda não foi preciso', ha: null },
      'technology-scout':  { banda: 'neutro', frase: 'ainda não foi preciso', ha: null },
    },
    linha: [
      { h: '18:02', t: 'O Lead retomou o trabalho numa sessão nova.' },
      { h: '18:02', t: 'O QA começou a validação final.' },
      { h: '18:11', t: 'A procurar ligações à internet no código.' },
    ],
  },
];

// ---- cena 2: um projeto parado, um a trabalhar, um fechado (real, 00:16) ---
const parado = [
  {
    projeto: 'juniper-hill',
    estado: 'vivo',
    palavra: 'A TRABALHAR',
    fase: 'construir',
    desde: 'começou há 8 h 43 min',
    resumo: 'O Lead está à espera do Frontend Dev.',
    aFazer: 'Preparar a exportação nos cinco formatos',
    ultimo: 'O Product Designer começou a desenhar o novo centro de controlo.',
    espera: 'frontend-dev',
    entregaRecente: { a: 'security-reviewer', b: 'lead' },
    humano: false,
    contagem: { vivo: 3, espera: 0, parado: 0, neutro: 7 },
    tarefas: { feitas: 4, total: 8 },
    equipa: {
      'lead':              { banda: 'vivo',   frase: 'à espera do Frontend Dev', ha: 'sinal há 4 s' },
      'frontend-dev':      { banda: 'vivo',   frase: 'a preparar a exportação nos cinco formatos', ha: 'sinal há 15 s' },
      'product-designer':  { banda: 'vivo',   frase: 'a desenhar o novo centro de controlo', ha: 'sinal há 30 s' },
      'security-reviewer': { banda: 'neutro', frase: 'aprovou a segurança da última entrega', ha: 'há 2 min' },
      'reviewer':          { banda: 'neutro', frase: 'aprovou a última entrega', ha: 'há 1 min' },
      'backend-dev':       { banda: 'neutro', frase: 'entregou os testes de nome de ficheiro', ha: 'há 7 min' },
      'architect':         { banda: 'neutro', frase: 'entregou o plano de 8 tarefas', ha: 'há 1 h 29' },
      'product-manager':   { banda: 'neutro', frase: 'enquadrou o trabalho no início', ha: 'há 8 h' },
      'technology-scout':  { banda: 'neutro', frase: 'escolheu as ferramentas de exportação', ha: 'há 8 h' },
      'qa':                { banda: 'neutro', frase: 'ainda não foi preciso', ha: null },
    },
    linha: [
      { h: '00:15', t: 'A tarefa dos testes de nome de ficheiro foi aprovada e fechada.' },
      { h: '00:15', t: 'O Product Designer começou a desenhar o centro de controlo.' },
      { h: '00:16', t: 'O Lead abriu a tarefa seguinte com o Frontend Dev.' },
    ],
  },
  {
    projeto: 'violet-pier',
    estado: 'parado',
    palavra: 'PAROU',
    fase: 'fechar',
    desde: 'começou há 13 h 25 min',
    resumo: 'Sem sinal nenhum há 3 h 49 min. A validação final ficou a meio.',
    aFazer: 'Validação final antes de publicar',
    ultimo: 'O QA estava a ler os ficheiros do projeto quando tudo parou.',
    espera: 'qa',
    entregaRecente: null,
    humano: true,
    accao: 'Voltar a arrancar este projeto no PC',
    contagem: { vivo: 0, espera: 0, parado: 1, neutro: 9 },
    tarefas: { feitas: 9, total: 10 },
    equipa: {
      'lead':              { banda: 'parado', frase: 'sem sinal há 3 h 49 min', ha: 'último sinal às 19:26' },
      'qa':                { banda: 'neutro', frase: 'ficou a meio da validação final', ha: 'há 4 h 22' },
      'reviewer':          { banda: 'neutro', frase: 'aprovou a última entrega', ha: 'há 5 h' },
      'frontend-dev':      { banda: 'neutro', frase: 'entregou os ecrãs de arranque', ha: 'há 5 h 20' },
      'backend-dev':       { banda: 'neutro', frase: 'entregou o guia de instalação', ha: 'há 6 h 40' },
      'architect':         { banda: 'neutro', frase: 'entregou o plano de 10 tarefas', ha: 'há 6 h 55' },
      'product-manager':   { banda: 'neutro', frase: 'enquadrou o trabalho no início', ha: 'há 9 h' },
      'security-reviewer': { banda: 'neutro', frase: 'aprovou a segurança', ha: 'há 9 h 58' },
      'product-designer':  { banda: 'neutro', frase: 'ainda não foi preciso', ha: null },
      'technology-scout':  { banda: 'neutro', frase: 'ainda não foi preciso', ha: null },
    },
    linha: [
      { h: '18:41', t: 'O QA começou a validação final.' },
      { h: '18:54', t: 'A sessão fechou-se a meio da validação.' },
      { h: '19:26', t: 'Último sinal do projeto. Desde então, nada.' },
    ],
  },
  {
    projeto: 'granite',
    estado: 'neutro',
    palavra: 'TERMINOU',
    fase: 'fim',
    desde: 'durou 7 h 21 min',
    resumo: 'Trabalho fechado com relatório. Nada por fazer.',
    aFazer: null,
    ultimo: 'O Lead fechou o trabalho e escreveu o relatório.',
    espera: null,
    entregaRecente: null,
    humano: false,
    contagem: { vivo: 0, espera: 0, parado: 0, neutro: 10 },
    tarefas: { feitas: 12, total: 12 },
    equipa: Object.fromEntries(PAPEIS.map(p => [p.key, {
      banda: 'neutro',
      frase: p.key === 'product-designer' ? 'não foi preciso neste trabalho' : 'entregou e fechou',
      ha: 'há 9 h',
    }])),
    linha: [
      { h: '15:28', t: 'O Product Manager entregou o relatório final.' },
      { h: '15:29', t: 'O trabalho foi fechado pelo sistema.' },
    ],
  },
];

export const CENAS = { agora, parado };

// ---- as quatro etapas do trabalho (direção C) ------------------------------
// Ordem fixa, igual em todos os projetos: é isso que permite comparar dois
// projetos de relance ("este está a construir, aquele já está a fechar").
export const ETAPAS = [
  { key: 'planear',   nome: 'Planear',   papeis: ['product-manager', 'architect'] },
  { key: 'construir', nome: 'Construir', papeis: ['backend-dev', 'frontend-dev', 'technology-scout', 'product-designer'] },
  { key: 'rever',     nome: 'Rever',     papeis: ['reviewer', 'security-reviewer'] },
  { key: 'fechar',    nome: 'Fechar',    papeis: ['qa'] },
];

// ---- detalhe de um agente (painel secundário, um clique) -------------------
// Só aqui é que podem aparecer coisas técnicas — e mesmo aqui em palavras.
export const DETALHE = {
  papel: 'security-reviewer',
  projeto: 'juniper-hill',
  banda: 'vivo',
  estado: 'A trabalhar',
  aFazer: 'Verificar a segurança do gerador de Word',
  agora: 'A verificar os dados escondidos dentro do ficheiro Word',
  desde: 'Começou há 4 minutos',
  sinal: 'Último sinal há 4 segundos',
  modelo: 'Modelo forte (o mais capaz)',
  depende: [
    { nome: 'Backend Dev', frase: 'entregou o que era preciso', banda: 'espera' },
    { nome: 'Reviewer', frase: 'já aprovou', banda: 'neutro' },
  ],
  abas: ['Visão geral', 'O que fez', 'Registo'],
};

// ---- geometria do grafo (a mesma nas três direções) ------------------------
// Lead ao centro; os quatro papéis de núcleo restantes em losango, pela ordem
// do fluxo; os cinco a pedido na órbita de fora, encostados a quem entregam.
// Coordenadas normalizadas (0..1) para cada direção as escalar como quiser.
export const POS = {
  'lead':              { x: .50, y: .50, r: 1.00 },
  'architect':         { x: .26, y: .50, r: .74 },
  'frontend-dev':      { x: .50, y: .14, r: .74 },
  'backend-dev':       { x: .50, y: .86, r: .74 },
  'reviewer':          { x: .74, y: .50, r: .74 },
  'product-manager':   { x: .07, y: .16, r: .55 },
  'product-designer':  { x: .28, y: .02, r: .55 },
  'technology-scout':  { x: .72, y: .02, r: .55 },
  'security-reviewer': { x: .93, y: .16, r: .55 },
  'qa':                { x: .93, y: .84, r: .55 },
};

// ---- ajudantes -------------------------------------------------------------
export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const contagemFrase = c => {
  const partes = [];
  if (c.vivo) partes.push(`${c.vivo} a trabalhar`);
  if (c.espera) partes.push(`${c.espera} à espera`);
  if (c.parado) partes.push(`${c.parado} parado${c.parado > 1 ? 's' : ''}`);
  partes.push(`${c.neutro} em repouso`);
  return partes.join(' · ');
};
