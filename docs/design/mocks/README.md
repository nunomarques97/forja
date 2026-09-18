> **18 set 2026 — o que manda hoje está noutro ficheiro.** Este README descreve as
> direções da *cena* de 16–17 set 2026 e fica como histórico. O redesenho do viewer
> como **centro de controlo de vários projetos** (direções «Sala», «Mapa», «Linha»)
> está em **`README-centro.md`**, e o sistema fechado está em
> `docs/design/DESIGN.md` §«Centro de controlo».

# Mocks do novo viewer do Forja (T-UI-1) — três direções

Três mocks estáticos (HTML + CSS + JS vanilla, sem build, sem dependências) do
novo viewer do elenco. Os três carregam o mesmo instantâneo
(`state-all-states.json`, contrato em `viewer/README.md`) por `fetch`, com o
"agora" congelado em `generatedAt` para que os tempos decorridos sejam
determinísticos. Nenhum destes ficheiros é código de produção; o viewer real
continua em `viewer/`.

Os mocks anteriores (`lanes`, `thread`, `overview`, `models-*`) são de rondas
já decididas e ficam como estão.

## Como ver

```
cd docs/design/mocks
node -e "require('http').createServer((q,s)=>{const f=require('fs'),p='.'+decodeURIComponent(q.url.split('?')[0]),m={'.js':'text/javascript','.html':'text/html; charset=utf-8','.json':'application/json'};try{s.setHeader('content-type',m[require('path').extname(p)]||'text/plain');s.end(f.readFileSync(p))}catch{s.statusCode=404;s.end()}}).listen(8765)"
```

Depois: `http://127.0.0.1:8765/bancada.html`, `/oficina.html`, `/painel.html`.
O `content-type` de JS é obrigatório: os mocks usam `<script type="module">`.

Parâmetros de URL (os três mocks):

| Parâmetro | Efeito |
|---|---|
| `?src=state-real.json` | carrega o instantâneo real desta máquina em vez do sintético |
| `?demo=1` | remapeia **só os estados** (nunca o texto) para mostrar `precisa do Sponsor`, `sem resposta`, `morto`, `falhou`, `à espera de review`, `à espera de quota`; faixa âmbar "Demonstração" no topo |
| `?scene=0` | só em `oficina.html`: esconde a cena e deixa o HUD sozinho (prova do teste dos 5 segundos) |

Screenshots (feitos com `tools/shot.mjs`, Chrome headless, `prefers-reduced-motion: reduce`):
`screenshots/<mock>-1440.png`, `screenshots/<mock>-390.png` (os seis de entrega),
mais `<mock>-demo-1440.png` (todos os estados), `oficina-hud-only-1440.png`,
`bancada-real-1440.png` (dados reais) e `bancada-1440-full.png` (página inteira).

## O que é comum aos três (fixo pelo brief)

- Fundo escuro; cinco matizes e mais nada além de neutros: laranja brasa, madeira, índigo, verde pátina, vermelho alarme — mais um âmbar (tinta da brasa) reservado ao sinal de silêncio.
- Elenco fixo, sempre no ecrã, nesta ordem: Ferreiro (lead), Bigorna (decisões de produto), Fundidor (backend), Lapidador (frontend), Contraste (revisor). Cada membro tem a sua cor de identidade: Ferreiro = brasa, Bigorna = madeira, Fundidor = índigo, Lapidador = pátina, Contraste = alarme. `inativo` é um estado, nunca uma ausência. Instâncias paralelas são sub-cartões, nunca uma contagem. "Ferramentas nativas" é um grupo neutro, tracejado, secundário.
- Palavras de estado exatas do instantâneo e a mesma escala de "tom" nos três mocks (`crew-shared.js`):

| Estado | Tom | Tratamento |
|---|---|---|
| inativo | neutro | palavra cinza, peso leve, cartão apagado |
| a trabalhar | brasa | palavra brasa + linha "último sinal há Xs" (ponto verde) |
| a trabalhar com `quiet` > 0 | âmbar | caixa âmbar "silêncio há Xs" |
| à espera de review / input / quota | índigo | palavra índigo |
| terminado | pátina | palavra pátina; veredicto DONE/APPROVE a verde, REJECT a vermelho |
| falhou | alarme | palavra vermelha |
| sem resposta | alarme | palavra vermelha + contorno tracejado vermelho + "sem sinal há X" |
| morto | alarme | palavra vermelha **riscada** + contorno tracejado |
| bloqueado · precisa do Sponsor | alarme, os mais altos | palavra em **barra vermelha sólida**, cartão tingido e contornado a vermelho |

- Cada cartão mostra: palavra de estado, "há X · desde HH:MM", detalhe (progresso / última ação / veredicto), id + título da task quando existem (título vem de `tasks[].title`, senão do `task` da instância, senão da linha do tempo `task.add`), e o `resolvedModel` pequeno. Ferreiro mostra "modelo da sessão · mínimo <modelFloor>" porque o instantâneo não traz `resolvedModel` para a sessão principal.
- Fila "Precisa do Sponsor" = perguntas abertas na `queue` + permissões pendentes (`instance.permission`, `main.permission`) + sessão principal em `precisa do Sponsor` + `main.quotaWait`.
- Revisões: o eco do CLI (`final:false`) que repete o handback em < 10 s é fundido numa linha ("confirmado pelo CLI").
- Acessibilidade: foco visível, contraste de texto ≥ 4.5:1 verificado numericamente (menor valor: alarme sobre o cartão tingido, 5.4–5.7:1; `--dim` foi clareado para ≥ 5:1), significado nunca só pela cor (a palavra está sempre presente), `prefers-reduced-motion` respeitado (a cena da Oficina e os LEDs do Painel ficam parados).

---

## A — Bancada (`bancada.html`)

Bancada editorial: o elenco são cinco lâminas horizontais empilhadas como ferramentas numa bancada, a palavra de estado é enorme (Fraunces 40 px), a linha do tempo é um fio fino com marcas por baixo, a fila do Sponsor são bilhetes rasgados numa coluna à direita. 2D, calma, legibilidade máxima.

| Token | Valor |
|---|---|
| `--bg` / `--slab` | `#151210` / `#1D1915` |
| `--brasa` (laranja brasa) | `#FF8A3D` |
| `--madeira` | `#D3A76A` |
| `--indigo` | `#9AA3FF` |
| `--patina` (verde pátina) | `#6CCBAE` |
| `--alarme` (vermelho alarme) | `#FF5B4A` |
| `--ambar` (só silêncio) | `#F2B544` |
| `--ink` / `--muted` / `--dim` | `#F4ECDF` / `#AFA394` / `#948A7D` |
| Tipos | **Fraunces** (palavras de estado, monogramas, objetivo, títulos dos bilhetes) + **Archivo** (tudo o resto, numerais tabulares) |
| Escala de espaço | 4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 |
| Raios | 0 (lâminas e bilhetes), 2 px (chips) |
| Assinatura | as lâminas com a palavra de estado a 40 px + os bilhetes rasgados (máscara CSS `conic-gradient`) em papel claro sobre o fundo escuro |

**Em 5 segundos:** quem trabalha e em quê lê-se nas palavras grandes e nos chips T1/T2/T3; "desde quando" está por baixo da palavra; a vida está no ponto verde / caixa âmbar; o bloqueado é a única lâmina vermelha; o que precisa do Sponsor é a única coisa clara (papel) no ecrã; o que terminou está a verde-pátina com o veredicto. É a direção mais rápida de ler porque só há uma coisa grande por lâmina. Custo: a 1440×1000 a linha do tempo e as revisões ficam abaixo da dobra (visíveis em `bancada-1440-full.png`); a 390 há uma faixa compacta do elenco no topo e os bilhetes vêm logo a seguir.

## B — Oficina (`oficina.html`)

Espetáculo: uma cena de forja a toda a largura (2.5D em SVG inline, sem three.js — decidi não carregar um motor 3D de CDN porque a cena SVG cumpre o brief sem dependência e sem risco de WebGL em headless; se o Sponsor quiser 3D a sério, é uma decisão para o Ferreiro). Cada membro é uma estação (bigorna + cepo) cuja luz codifica o estado: brasa na cor do membro com faíscas = a trabalhar; anel âmbar tracejado = silêncio; luz baça cinza = inativo; clarão vermelho com anel e faixa de perigo = bloqueado / precisa do Sponsor; anel vermelho tracejado e luz apagada = sem resposta; cruz vermelha sobre a estação = morto; luz pátina = terminado. O HUD por baixo de cada estação leva o texto exato. `?scene=0` prova que o HUD sozinho passa o teste.

| Token | Valor |
|---|---|
| `--bg` / `--panel` | `#0E0C0B` / `#151211` |
| `--brasa` | `#FF7A2F` |
| `--madeira` | `#CFA063` |
| `--indigo` | `#93A0FF` |
| `--patina` | `#63C9A9` |
| `--alarme` | `#FF4F3E` |
| `--ambar` (só silêncio) | `#F0B23F` |
| `--ink` / `--muted` / `--dim` | `#F3EBE2` / `#A99C8E` / `#918679` |
| Tipos | **Barlow Condensed** (HUD: nomes, palavras de estado em maiúsculas, rótulos) + **IBM Plex Mono** (corpo, tempos, modelos, linha do tempo) |
| Escala de espaço | 4 · 8 · 12 · 16 · 24 · 32 · 48 |
| Raios | 0 em tudo (painéis de HUD com cantos vivos); só as luzes são círculos |
| Assinatura | a cena: cinco estações com brilho radial na cor do membro, faíscas a subir quando trabalha, clarão vermelho quando bloqueia, cruz vermelha quando morre |
| Movimento | só sem `prefers-reduced-motion`: faíscas a subir (2.4 s), respiração do brilho (1.6 s a trabalhar / 4 s à espera), clarão a pulsar (0.9 s). Com redução: quadros parados, as faíscas ficam estáticas |

**Em 5 segundos:** a cena dá a resposta antes da leitura — cinco luzes, uma vermelha, uma a piscar âmbar — e o HUD confirma com as palavras. Bloqueado e Sponsor gritam (clarão + barra vermelha + "2 para o Sponsor" no topo). Quem e em quê está no HUD, com o chip de task. É a direção que mais se percebe à distância e a que mais custa em altura: a cena come ~310 px e a fila do Sponsor, a linha do tempo e as revisões ficam no convés por baixo (ainda visíveis a 1440×1000). A 390 a cena vira uma faixa de cinco luzes (sem nomes) e os painéis do HUD empilham.

## C — Painel (`painel.html`)

Painel de instrumentos: grelha densa, um LED de estado por membro, dois mostradores por cartão — "no estado" (tempo decorrido, escala 0–60 min) e "silêncio" (escala por patamares lida dos `thresholds` do instantâneo: verde < 90 s, âmbar < 5 min, vermelho até 30 min; "não se aplica" fora de `a trabalhar`) —, faixa kanban das tasks (por fazer / em curso / em review / feito / falhou / bloqueado), revisões em livro-razão (tabela), fila do Sponsor como caixa de entrada com margem vermelha grossa, registo em mono.

| Token | Valor |
|---|---|
| `--bg` / `--panel` | `#101214` / `#171A1E` |
| `--brasa` | `#FF8C42` |
| `--madeira` | `#D4A96A` |
| `--indigo` | `#8E9BFF` |
| `--patina` | `#5FCDA9` |
| `--alarme` | `#FF5147` |
| `--ambar` (só silêncio) | `#F3B940` |
| `--ink` / `--muted` / `--dim` | `#EEF1F4` / `#9AA3AD` / `#8A939D` |
| Tipos | **Familjen Grotesk** (rótulos, palavras de estado, corpo) + **Azeret Mono** (leituras dos mostradores, contadores, horas, registo) |
| Escala de espaço | 4 · 8 · 12 · 16 · 24 · 32 |
| Raios | 3 px (chips, luzes de estado do run), 6 px (painéis, colunas), círculo (LEDs) |
| Assinatura | os dois mostradores de 270° por membro, com o de silêncio a mostrar os três patamares do redutor de estado como zonas coloridas |

**Em 5 segundos:** tudo está no primeiro ecrã a 1440×1000 (elenco, kanban, revisões, caixa do Sponsor, registo) — é a direção mais completa, e o mostrador de silêncio responde literalmente a "está mesmo vivo?" com uma agulha. Custo: é a mais densa e a palavra de estado é a mais pequena das três (22 px); um estranho percebe o bloqueado (cartão vermelho, LED vermelho) e o Sponsor (caixa vermelha) mas demora mais a encontrar "em quê" porque há mais coisas a competir. A 390 os cartões empilham com os dois mostradores lado a lado, o kanban vira faixa horizontal com scroll e a caixa do Sponsor sobe para antes das revisões.

---

## Notas honestas

- `state-all-states.json` chama-se "todos os estados" mas só traz três (`a trabalhar` ×6, `bloqueado` ×2, `terminado` ×3, um `quiet`). Os restantes oito estados só se veem com `?demo=1` (estados remapeados, texto real) e na legenda de estados de cada mock. Se o Ferreiro quiser um instantâneo sintético completo, é trabalho do Fundidor em `test/fixtures/`.
- Contraste usa o vermelho alarme como cor de identidade porque só há cinco matizes para cinco membros; o estado vermelho é sempre distinguível pela palavra e pela barra/contorno, e a identidade só aparece no monograma, no nome e na barra lateral. Alternativa se incomodar: Contraste em neutro claro.
- Nos dados reais (`?src=state-real.json`) o objetivo do run é o último prompt (goalSource `prompt`), que aqui é um `<agent-message>` — os mocks mostram-no rotulado "último prompt" e truncado; é o que o payload tem.

---

## 16 set 2026 — cena com dez papeis: profundidade em vez de vao (Product Designer)

`cena-dez-papeis.html` nao e uma quarta direcao: e o esboco de geometria que fechou a contradicao
entre a cena (dez estacoes numa faixa, cinco+vao+cinco) e o HUD (dez cartoes em cinco colunas),
que faziam o brilho de um papel cair debaixo do cartao de outro. Decisao, alternativas rejeitadas
e numeros exatos em `docs/design/DESIGN.md` (fim da seccao dos estados, e seccao "Layout (desktop)" 2).
Screenshots: `screenshots/cena-dez-papeis-1440.png` (estado normal),
`screenshots/cena-dez-papeis-guias-1440.png` (com as guias das cinco colunas, `?guides`),
`screenshots/cena-dez-papeis-390.png` (sem cena, como manda o DESIGN).

---

# D-SCENE-2 — a cena passa a ser «agentes ligados» (17 set 2026)

Direção do Sponsor, 17 set 2026, 08:30: «em vez de forjas desenha agentes; que o
agente principal tenha ligações a subagentes; e, para efeito visual, liga
subagentes entre si (ex.: Reviewer ligado ao Dev) para termos um gráfico de
ligações». Três direções novas, construídas como mocks reais e comparáveis:
`agentes-a-pictogramas.html`, `agentes-b-constelacao.html`, `agentes-c-bancada.html`.
Os três partilham os dados (`agentes-dados.js`), o cabeçalho e o HUD
(`agentes-chrome.js`, `agentes-base.css`), para que a única variável em jogo seja
a cena. Nenhum é código de produção.

## Como ver

```
cd docs/design/mocks
node -e "const h=require('http'),f=require('fs'),p=require('path'),m={'.js':'text/javascript','.html':'text/html; charset=utf-8','.css':'text/css','.json':'application/json'};h.createServer((q,s)=>{const x='.'+decodeURIComponent(q.url.split('?')[0]);try{s.setHeader('content-type',m[p.extname(x)]||'text/plain');s.end(f.readFileSync(x))}catch{s.statusCode=404;s.end()}}).listen(4392)"
```

`http://127.0.0.1:4392/agentes-b-constelacao.html` · parâmetro `?cenario=estados`
troca o run normal por um que cobre o resto da tabela de estados (`em pausa`,
`bloqueado`, `sem resposta`, `morto`, `falhou`, `à espera de review`, `terminado`)
e põe o runner parado.

## O inventário (o que a cena tem de mostrar)

Dez papéis, sempre os dez · núcleo (5) contra a pedido (5) · o estado de cada um
(11 palavras do redutor) por cor **e** por forma · se há instâncias ativas e
quantas · `em pausa` · runner vivo ou parado · as ligações fixas (Lead→todos;
Architect→Devs; Devs→Reviewer; Reviewer→Security Reviewer; QA→Lead; Product
Manager→Architect; Technology Scout→Devs; Product Designer→Frontend Dev) ·
funcionar a 1440 e a 390 · nada a depender só de cor · `prefers-reduced-motion`.

## As três direções

| | A — pictogramas | B — constelação | C — bancada |
|---|---|---|---|
| Lógica de layout | as cinco colunas do HUD, duas filas (mantém o alinhamento cena↔cartão) | radial: Lead no centro, núcleo em losango, a pedido na órbita de fora | cena lateral: núcleo sentado à bancada, a pedido de pé atrás |
| Figura | placa rectangular com monograma | círculo com monograma e halo | silhueta de pessoa com monograma na cabeça |
| Arestas | ortogonais, com pinos no Lead e passagens por baixo nos cruzamentos | curvas, quase retas, recortadas na borda dos nós | arcos que passam por trás das pessoas e rasam o tampo |
| Elemento de assinatura | o barramento de nove corredores que sai do Lead | o halo de estado e o losango de fluxo | as folhas de trabalho pousadas no tampo |
| Screenshots | `agentes-a-1440.png`, `agentes-a-390.png`, `agentes-a-estados-1440.png` | `agentes-b-*` | `agentes-c-*` |

## Escolha: **B — constelação**

1. **É a única em que o agente principal é o centro.** O pedido do Sponsor era
   «o agente principal com ligações a subagentes». Em B o Lead é o nó maior, no
   meio, com o maior halo, e todas as chamadas partem dele para fora: a hierarquia
   é a própria geometria. Em A o Lead é uma placa na coluna 1, igual às outras; em
   C é uma silhueta à cabeceira. Nas duas é preciso seguir as linhas para
   descobrir quem manda.
2. **As arestas de fluxo saem de graça.** Pondo o Architect à esquerda, os dois
   Devs em cima e em baixo e o Reviewer à direita, as quatro arestas do núcleo
   (Architect→Frontend, Architect→Backend, Frontend→Reviewer, Backend→Reviewer)
   são exatamente os quatro lados do losango, e nenhuma passa por cima de outro
   nó. A precisa de nove corredores próprios mais dez passagens por baixo; C
   precisa de dezanove arcos que viram um novelo no ombro do Lead.
3. **Sobrevive aos 390.** O mesmo desenho, com os cinco de núcleo e os cinco a
   pedido dobrados numa barra tocável (`agentes-b-390.png`). A dobra também
   funciona (`agentes-a-390.png`); C, não: uma bancada é larga por natureza, as
   silhuetas encavalitam-se e as ligações deixam de se ver (`agentes-c-390.png`).
4. **O movimento continua honesto.** Um só halo pulsa — o de quem está `a
   trabalhar` com sinal recente — e a única animação nova, três pontos a percorrer
   uma aresta, só aparece quando há um hand-back acabado de acontecer. Anima só
   `opacity`, como manda a decisão S1; com `prefers-reduced-motion` fica tudo
   quieto e nada se perde.
5. **O que B perde, e porquê se aceita.** Perde o alinhamento cena↔cartão que A
   guardava: em B o nó do Backend Dev não está por cima do cartão do Backend Dev.
   Foi o que decidiu o desenho anterior (a «troca de dono» de 16 set) — mas essa
   regra existia porque a cena não tinha texto. Com o monograma dentro do nó, o
   dono deixa de depender da coluna e o problema desaparece. É a troca que um
   grafo obriga a fazer: ou se alinha por colunas e se desiste do grafo, ou se
   identifica cada nó e se ganha a liberdade de o pôr onde a ligação pede.

**A perdeu** por ser a menos diferente do que já existe (uma fila de coisas por
cima de uma fila de cartões) e por o feixe de nove corredores ler-se como cabo de
rede, não como equipa: é correta, legível e aborrecida — e o Lead não se destaca.
**C perdeu** por acrescentar um passo de leitura (olha-se para as pessoas, não
para as ligações), por custar 48 px de tampo vazio, por pôr toda a identidade em
monogramas de 15 px repetidos dez vezes, e por partir aos 390.

Slop check aos três: sem creme + serifa + terracota, sem gradiente roxo-azul, sem
vidro, sem emoji (os glifos de estado são formas SVG desenhadas à mão), sem
cartões dentro de cartões, sem lorem ipsum (o texto é o de um run verdadeiro), sem
grelha de jornal. Contraste: todo o texto usa os tokens já medidos no DESIGN.md; o
monograma mais fraco dentro do nó é `--ember` sobre `--surface`, 7,2:1.

Registo da escolha: `docs/forja/DECISIONS.md` (D1–D4). O sistema fica fechado em
`docs/design/DESIGN.md`, secção «Cena: agentes ligados».
