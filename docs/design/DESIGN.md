# DESIGN — viewer do Forja (vista de entrada: "Feed de eventos-chave / Voltas")

> **18 set 2026, fim do dia — o que manda hoje (decisão do PO).** A página abre
> no **feed de eventos-chave**, direção **C — Voltas** (secção «Feed de
> eventos-chave», logo abaixo do teste que manda). O viewer de sempre fica como
> segundo separador, **«Modelos e ligações»**, sem alterações a não ser as duas
> remoções: a **linha do tempo** e o **registo bruto** saíram do viewer (o registo
> bruto é o próprio `data/events.jsonl`). O «Centro de controlo / Sala» descrito
> mais abaixo **não foi construído**: fica como proposta à espera de decisão, e
> onde contradiz o feed manda o feed.
>
> **18 set 2026, manhã (proposta, não construída).** O viewer passa de «uma página por run» a
> **centro de controlo de vários projetos ao mesmo tempo**, por encomenda do
> Sponsor («a UI atual é confusa; tenho de ver de relance que projetos estão a
> trabalhar, quem está vivo, quem está parado e o que o Lead está à espera»).
> A direção escolhida pelo Product Designer entre três mocks reais é **A —
> Sala** (`docs/design/mocks/centro-a-sala.html`, razões e alternativas em
> `docs/design/mocks/README-centro.md`). A partir daqui **a secção que manda é
> «Centro de controlo»**, logo abaixo; as secções «Layout (desktop)», «Cena:
> agentes ligados» e «Layout (telemóvel)» ficam como **histórico** — o que
> delas continua em vigor está dito, uma a uma, dentro da secção nova.
> O resto do ficheiro (tokens, tipografia, acessibilidade, fazer/não fazer)
> continua em vigor com as alterações marcadas «18 set 2026».

Decidido em 16 set 2026 pelo Lead da sessão de hardening (o Sponsor delegou a escolha por escrito para o viewer do próprio Forja), entre três direções construídas pelo Frontend Dev como mocks reais em `docs/design/mocks/` (`bancada.html`, `oficina.html`, `painel.html`, screenshots em `docs/design/mocks/screenshots/`): **B — Oficina**. Substitui o desenho claro anterior (Thread/Hub), que fica só como histórico em `git`.

**Porquê Oficina:** o HUD (os cartões do elenco — então cinco, hoje dez) passa sozinho o teste dos 5 segundos — verificado com a cena escondida (`oficina-hud-only-1440.png`) — e a cena da forja por cima dá uma leitura global instantânea de "quem brilha" sem tirar nada ao texto; é a única direção que junta a legibilidade da Bancada ao lado visual que o Sponsor pediu ("three.js-grade", "be creative"). A Bancada é a mais legível mas estática; o Painel é denso (mostradores duplicam números, colunas vazias) e o telemóvel fica comprido. Dois empréstimos da Bancada entram na Oficina: no telemóvel, o elenco aparece primeiro como linhas compactas (hoje dez) (estado + há quanto tempo) e cada linha expande; a fila "precisa do Sponsor" usa bilhetes claros — o único elemento claro do ecrã é o que precisa de um humano.

**Atualização de 17 set 2026 (D-SCENE-2):** a direção «Oficina» mantém-se para a página inteira (fundo escuro, tokens, HUD, tipografia). O que mudou foi **a cena**: deixou de ser a forja com estações e passou a ser um **grafo de agentes ligados**, por direção do Sponsor. O §2 abaixo fica como histórico e a secção que manda é **«Cena: agentes ligados»**.

## O teste que manda em tudo

**Os 3 segundos (18 set 2026, encomenda do Sponsor).** Uma pessoa que não conhece o sistema abre a página e em **menos de 3 segundos**, **sem tocar em nada**, responde a quatro perguntas: *que projetos estão a trabalhar agora* · *quem da equipa está a trabalhar, à espera e parado em cada um* · *o que o Lead está à espera* · *por onde anda o trabalho*. Se essas quatro respostas não saltarem do desenho, a direção falhou, por mais bonita que seja.

**Os 5 segundos (continua em vigor, um nível abaixo).** Aberto um projeto, em 5 segundos lê-se quem está a trabalhar, em quê, desde quando, está mesmo vivo, o que está bloqueado e porquê, o que precisa do Sponsor, o que terminou. Se um elemento visual tornar qualquer destas respostas mais lenta, corta-se o elemento.

**A regra da linguagem (18 set 2026, ordem expressa do Sponsor).** A vista principal é para uma pessoa que não é programador: «quanto mais informativo, menos ruído visual». **Proibido na vista principal**: identificadores de run (`R-20260917-5e1d`), de sessão, de agente ou de ferramenta; texto de prompt; caminhos e nomes de ficheiro; códigos de task (`T7b`); nomes de modelos (`claude-opus-5[1m]`); contadores técnicos como manchete (`3766 eventos · 8 erros`); qualquer coisa que soe a linha de comandos. **Permitido**: nome do projeto, nomes de papéis em inglês (Lead, Frontend Dev…), palavras de estado em português, frases inteiras («O Lead está à espera do Security Reviewer»), tempos em palavras («há 3 h 38 min», «sinal há 4 s»), horas `HH:MM`. Um identificador que faça falta para uma ação técnica rara vive **um clique abaixo**, no painel de detalhe, e mesmo aí em palavras («Modelo forte (o mais capaz)»). Consequência para o resto do sistema: um título de task escrito em língua de programador não pode ser mostrado — quem escreve o plano escreve títulos que uma pessoa entende. **No feed (18 set 2026), o viewer limpa o que vem sujo**: `tituloLegivel` em `viewer/lib/feed.mjs` tira códigos de task no início (`T022a - `, `T9 · Frontend Dev: `), caminhos e nomes de ficheiro (`radar_v08/domain/integrity.py`, `` `lib/runner.mjs:551` ``), e troca uma chamada só com o código («T3 · Reviewer: review») pelo título dessa task («Revisão · Achados legados…»). O que não é caminho fica (`PASS/FAIL/N/A`, `e/ou`).

## Feed de eventos-chave (vista de entrada, 18 set 2026)

Direção **C — Voltas**, escolhida pelo PO entre três mocks sobre dados reais (`docs/design/mocks/feed-a-fio.html`, `feed-b-pistas.html`, `feed-c-voltas.html`; comparação e verificação dos dados em `docs/design/mocks/README-feed.md`). Construído em `viewer/lib/feed.mjs` (servidor, `GET /feed`) + `viewer/assets/feed.js` / `feed.css` (página). Sem biblioteca.

**O que entra — só oito coisas, todas de eventos reais, de todos os projetos de `data/projects.json`:** (1) um agente chama outro · (2) o subagente começa · (3) o subagente termina · (4) o controlo volta a quem chamou · (5) o que ainda não aconteceu · (6) veredito do Reviewer / Security Reviewer · (7) escalada para o Sponsor (pergunta, tarefa ou run bloqueados) · (8) run ou sessão terminados com relatório entregue. Ferramentas nativas nunca entram. Nada é inventado: o (4) nas chamadas em fundo é o gesto seguinte do Lead depois do fim do subagente; o (5) é calculado sobre os mesmos eventos.

**Layout.** Duas colunas a ≥ 981 px: à esquerda **«Voltas e marcos»** (o mais recente em cima, com o dia por extenso a separar), à direita, fixa ao rolar, **«Agora»** (360 px). ≤ 980 px: uma coluna, «Agora» primeiro. Por cima de tudo, a **barra das vistas** (FORJA · EVENTOS · MODELOS E LIGAÇÕES · estado da ligação), colada ao topo; no telemóvel só os dois separadores.

**A volta (assinatura).** Os eventos 1 a 4 de uma delegação são **uma** linha: «Lead → Backend Dev · PROJETO», o título legível, o resultado à direita e a **régua de quatro passos** (Chamou · Começou · Terminou · Voltou ao Lead). Passo feito: ponto e traço cinzentos com a hora; «Começou» a verde e a pulsar enquanto trabalha. Passo que falta: tracejado amarelo, com o que se espera escrito no sítio onde vai acontecer («à espera que o Backend Dev termine», «à espera que o Lead retome») — é aqui que vive o evento 5. Sessão calada há mais de 15 min (`FEED.LIVE_MS`, pela prova da própria sessão, nunca pelo estado do projeto): tracejado vermelho, «não chegou · interrompida». Volta fechada a que falta um passo antigo: «sem registo», cinzento. A 390 a régua dobra em 2×2.

**Selos do resultado:** APROVADO (aço) · REJEITADO (vermelho) · ENTREGOU (cinzento) · BLOQUEADO / NÃO CONSEGUIU (amarelo) · A TRABALHAR (verde) · A ARRANCAR (amarelo) · INTERROMPIDA (vermelho). O veredito do runner (`task.done`/`task.fail`) cola-se à volta do Reviewer que o deu; o texto do veredito aparece por baixo do título.

**Marcos (entre as voltas), por peso:**
- **cheio** (bloco `--surface-2`, barra de 4 px, título 20 px, selo): pergunta para ti (PRECISA DE TI; depois de respondida fica a 60 % com RESPONDIDA), tarefa ou run bloqueados — **só a raiz** —, veredito sem volta, tarefa que falhou de vez, run terminado / sessão terminada com relatório (bilhete claro).
- **médio** (título 17 px, sem selo): a sessão caiu antes de fechar a tarefa; tarefa falhou e vai ser repetida.
- **baixo** (sem fundo, filete de 2 px, texto corrido cinzento): **bloqueios em cascata** («dependência T3 falhou», «dependência T4 está bloqueada») juntam-se numa linha só por run e por hora — «Mais 3 tarefas ficaram paradas por arrasto — dependem de uma que não passou». Nunca três cartões vermelhos seguidos.

**«Agora» (evento 5), um cartão por projeto**, ordem: parou · à espera de ti · em pausa · a trabalhar · terminou · sem run. Projeto com alguma coisa pendente: cartão com a faixa de cima na cor do estado e o selo (`PAROU`, `À ESPERA DE TI`, `EM PAUSA`, `A TRABALHAR`) e uma linha por pendente — «Backend Dev a trabalhar», «À espera que o Lead retome», «À espera do próximo passo do Lead», «À espera da tua decisão» (+ o que acontece se não responderes), «Em pausa… retoma às HH:MM», «O runner saiu a meio do run», «A seguir no plano» (+ «2 de 9 tarefas feitas»). Projeto sem nada pendente: uma linha só, «terminou há 5 h 21 min».

**Cores:** as quatro bandas do §3 do Centro de controlo (verde `--vivo` a trabalhar agora · amarelo `--espera` à espera / o que falta · vermelho `--parado` interrompido, rejeitado, precisa de ti · cinzento `--neutro` já entregou), mais aço (`--steel`) para APROVADO e o bilhete claro (`--ticket`) para o relatório. Texto escuro `#12100E` em todos os selos. Glifos desenhados em SVG (ponto, círculo tracejado, visto, cruz, triângulo, bandeira, quadrado, três riscos), nunca emoji: o estado nunca depende só da cor.

**Tipos:** Barlow Condensed 600/700/800 (títulos, selos, horas, nomes de projeto) + Barlow 400/600 (texto); IBM Plex Mono só no estado da ligação.

**Dados e atualização:** a página pede `GET /feed` de 5 em 5 s (e ao voltar ao separador); o servidor reconstrói no máximo de 3 em 3 s. Janela de 30 h, no mínimo os 20 itens mais recentes, no máximo 160.

**Fazer / não fazer (feed):** fazer — uma delegação é uma linha; o que falta diz-se no passo onde vai acontecer; a raiz de um bloqueio tem o peso, o arrasto não. Não fazer — mostrar cada evento de hook como linha; mostrar identificadores, caminhos, códigos de task, modelos; decidir que uma sessão morreu por causa do estado do projeto (só a prova da própria sessão conta); inventar um evento que o pipeline não produz.

## Centro de controlo (proposta de 18 set 2026 — não construída; ver o topo)

Direção **A — Sala**, escolhida entre três mocks reais (`centro-a-sala.html`, `centro-b-mapa.html`, `centro-c-linha.html`; comparação em `docs/design/mocks/README-centro.md`). Continua tudo a ser **SVG inline + CSS da plataforma, sem biblioteca** (decisão S1 em `docs/forja/TECHNOLOGY.md`): arrastar e aproximar fazem-se a mexer no `viewBox` com eventos de ponteiro, que é plataforma pura. Continua **proibido** layout automático por forças ou física: as posições estão escritas aqui.

### 1. A grelha de projetos

- A página é uma **sala de mesas**: um **painel por projeto ativo**, todos do mesmo tamanho, lado a lado, sem separadores nem abas. Grelha fluida `repeat(auto-fit, minmax(520px, 1fr))`: dois painéis a 1440, um a 390, três ou quatro quando houver três ou quatro projetos.
- **Ordem**: primeiro os que precisam de um humano, depois os que estão a trabalhar (mais recente primeiro), depois os terminados. Um projeto terminado nunca empurra um vivo para baixo da dobra.
- **Mais de quatro projetos**: os painéis para lá do quarto **encolhem** para a forma compacta — cabeçalho + **anel de dez riscos** (um por membro, na cor do sinal; empréstimo da direção B) — e crescem ao serem focados. Nunca se esconde um projeto que esteja `parado` ou que precise de um humano.
- **Um painel nunca é uma aba.** Nada do que é preciso para as quatro perguntas mora atrás de um clique.

### 2. Cabeçalho do painel (o que identifica um projeto)

Por esta ordem, e só isto: **nome do projeto** (Barlow Condensed 30/800) · **palavra de estado** como selo cheio na cor do estado, texto escuro · **«começou há X»** · as **quatro contagens** em números grandes (`a trabalhar` verde · `à espera` amarelo · `parados` vermelho · `em repouso` cinzento) · **barra de tarefas** («4 de 8 tarefas feitas») · **linha das quatro etapas** (Planear · Construir · Rever · Fechar, com a atual acesa — empréstimo da direção C) · os **comandos do painel** (focar · ecrã inteiro · − · + · ajustar).
Nunca: identificador do run, caminho do projeto, modelo, forjalvl, número de eventos.

Palavras de estado do projeto, exatas: `A TRABALHAR` · `À ESPERA DE TI` · `PAROU` · `EM PAUSA` · `TERMINOU` · `FALHOU`.

### 3. As quatro bandas de sinal (o modelo de cor)

A cor do nó é o **estado**, e mais nada. As cores de identidade por papel (aço, ardósia, índigo…) **saem dos nós** e ficam só onde não competem com o sinal (painel de detalhe e listas). Três bandas dominantes, como o Sponsor pediu, e uma quarta neutra:

| Banda | Cor | Quer dizer | Vem do redutor (`viewer/lib/state.mjs`) |
|---|---|---|---|
| **verde** `--vivo` `#45D48A` | disco **cheio** + halo, pulsa | está a trabalhar **agora** | `a trabalhar` com último sinal **< `QUIET_MS`** (90 s) |
| **amarelo** `--espera` `#F0B23F` | anel grosso, interior a 16 %, sem pulso | adormecido: parou de escrever, está à espera, ou teve sinal há pouco | `a trabalhar` em silêncio, `à espera de review`, `à espera de input`, `à espera de quota`, `em pausa`, e `sem resposta` até **`UNRESPONSIVE_MS`** (5 min) |
| **vermelho** `--parado` `#FF4F3E` | anel grosso + **✕ por cima do nó** | parado: sem sinal há mais de **X** (X = `UNRESPONSIVE_MS`, 5 min), morto, falhou | `sem resposta` (passados os 5 min), `morto`, `falhou` |
| **cinzento** `--neutro` `#8A8078` | disco vazio, contorno fino | já entregou o que tinha, ou ainda não foi preciso | `terminado`, `inativo` |

- **X é configurável num só sítio**: `THRESHOLDS.UNRESPONSIVE_MS` em `viewer/lib/state.mjs` (hoje 5 min), e a fronteira verde/amarelo é `THRESHOLDS.QUIET_MS` (hoje 90 s). A página **não** inventa limiares: o mapa banda→estado é uma tabela de dez linhas ao lado de `STATES`, e mudar os 5 minutos é mudar um número.
- **Porquê uma quarta banda** (proposta do Product Designer, decisão reversível): se `terminado` e `inativo` fossem vermelhos, um run bem sucedido apareceria todo em alarme e o vermelho deixava de querer dizer «vai lá ver». Cinzento é ausência de sinal **sem problema**; vermelho é ausência de sinal **com problema**.
- **`bloqueado` e `precisa do Sponsor`** são vermelhos **e** ganham o bilhete claro `--ticket` («Precisa de ti» + a ação em palavras + um botão). Continua a valer a regra antiga: o único elemento claro do ecrã é o que precisa de um humano, no máximo dois por ecrã.
- **Nada depende só da cor**: cada banda tem forma própria (cheio · anel · anel com ✕ · vazio) e uma medalha de glifo no canto superior direito do nó (ponto cheio · barra · ✕ · sem glifo), e a palavra de estado está sempre escrita no cabeçalho do painel e na frase do Lead.

### 4. A constelação dentro do painel

- **Dez nós, sempre os dez.** `viewBox="0 0 680 360"`, `preserveAspectRatio="xMidYMid meet"`. **Lead ao centro** `(340, 180)`, raio 32 — o maior, porque é o único que chama alguém. Os quatro papéis de núcleo em losango à volta, raio 24: Architect à esquerda, Frontend Dev em cima, Backend Dev em baixo, Reviewer à direita. Os cinco a pedido na órbita de fora, raio 18, encostados a quem entregam: Product Manager e Product Designer à esquerda/em cima, Technology Scout e Security Reviewer à direita/em cima, QA em baixo à direita. Posições normalizadas em `docs/design/mocks/centro-dados.js` (`POS`); qualquer mudança tem de manter a propriedade «nenhuma ligação passa por cima de um nó de terceiros».
- **Cada nó leva o nome do papel por baixo** (Barlow Condensed 11/700, maiúsculas) — em cima, nos nós da faixa de topo, para o rótulo nunca cair sobre um vizinho. O monograma de duas letras fica dentro do nó. **Isto revoga a regra antiga «na cena só entram duas letras»**: o Sponsor não tem de decorar que `SR` é o Security Reviewer.
- **Tamanho = quem está sempre no trabalho**; núcleo maior, a pedido mais pequeno e mais longe. Nunca se apaga um papel a pedido para «arrumar a imagem»: a opacidade do halo é igual dentro e fora da órbita.

### 5. As ligações (e a regra nova)

| Tipo | Desenho | Significado |
|---|---|---|
| **chamada** | linha cheia 1 px `--line` | o Lead chama cada um dos outros nove (verdade do sistema) |
| **fluxo** | linha tracejada `5 6`, 1 px, 55 % | quem entrega trabalho a quem (representação) |
| **acesa** | 2,4 px na cor da banda + três pontos a meio | **o caminho de agora** |

**Mudança expressa em relação ao `DESIGN.md` de 17 set** («uma aresta não é evidência de nada; nunca muda com o estado»): por requisito do Sponsor, **acendem-se duas ligações, no máximo** — a que liga o Lead a quem ele está **mesmo** à espera (o instantâneo di-lo: `à espera de <papel>`) e a **entrega que acabou de acontecer** (um hand-back recente). Nada mais acende. Continua **proibido** acender um caminho que o sistema não percorreu (p. ex. Architect→Frontend Dev por o Architect estar a trabalhar).
**A ligação acesa toma o pior dos dois estados**: se uma das pontas está parada, a linha é vermelha — um caminho que passa por quem morreu nunca se pinta de verde.

### 6. A frase (o que substitui os painéis de texto)

Debaixo da constelação, um bloco com filete na cor do estado (bloco, não cartão: sem contorno e sem raio) com **duas linhas e nada mais**:
1. **a frase do Lead**, 19/600: «O Lead está à espera do Security Reviewer.» — ou, parado: «Sem sinal nenhum há 3 h 49 min. A validação final ficou a meio.»
2. **o contexto**, 14/dim: «Tarefa de agora: <título em palavras> · <o último acontecimento em palavras>».

Por baixo, **três linhas de cronologia** (hora + frase em português), nunca mais. Os painéis compridos de antes (linha do tempo longa, revisões, tasks, decisões) passam a viver na página de **um projeto** (`focar`), nunca na sala. A sala responde «o que está a acontecer»; o detalhe responde «porquê».

**A fonte da linguagem (18 set 2026, bloqueador apanhado pelo red-team antes do build).** Os mocks têm as frases escritas à mão; o redutor real (`viewer/lib/state.mjs`) não produz texto assim sozinho — `inst.progress?.text`, `describe(rec)` («a correr: `<comando>`», «a procurar `<regex>`»), o `detail` do runner parado («… — forja runner»), e as notas de cronologia (``${labelOf(inst)}: erro em ${rec.tool_name}``) são todas técnicas, e os títulos de task em runs já a decorrer (`T7b: renderer DOCX em services/render/docx.py`) também. Ligados à letra às frases §6, a vista principal volta a mostrar exatamente o que o Sponsor rejeitou. Regras vinculativas para quem implementa:
1. A vista principal **nunca** lê diretamente `lastAction`, o resultado de `describe()`, `permission.message`, o `detail` técnico do runner, nem `inst.error`. Esses campos só entram no separador «Registo» do painel de detalhe (§8).
2. Cada frase da vista principal vem de um **vocabulário fixo**, indexado por tipo de evento + papel + título da tarefa — por exemplo: «<Papel> começou a trabalhar», «<Papel> entregou», «O Reviewer aprovou / rejeitou», «O Lead está à espera do <Papel>», «Sem sinal nenhum há X», «A sessão fechou-se a meio». O runner parado usa sempre a frase fixa «Voltar a arrancar este projeto no PC» — nunca o `detail` literal do evento.
3. Texto escrito por um agente para uma pessoa (`forja progress "…"`) só aparece se passar um **filtro de padrões proibidos** (caminhos, crases, `T\d+`, `R-\d{8}`, fragmentos de UUID, extensões `.mjs/.py/.ts`, barras `/`, a palavra `forja `); se falhar, mostra-se a frase de reserva «<Papel> está a trabalhar na tarefa «<título>»».
4. O **título da tarefa** perde o prefixo `T\d+[a-z]?:` antes de aparecer; se o resto ainda falhar o mesmo filtro, mostra-se «tarefa N de M» em vez do título literal. (Correção paralela, fora do viewer: a `forja-plan` skill do Architect ganha a regra «títulos em português simples, sem caminhos nem códigos» — para os runs novos já nascerem sem precisar do filtro.)
5. **Teste obrigatório**: renderizar a vista principal sobre o `data/events.jsonl` real desta máquina e afirmar zero ocorrências dos padrões proibidos. Sem este teste a promessa da regra da linguagem (linha 28) é uma alegação, não um facto — é o que o red-team apanhou nos mocks (escritos à mão) que o build ainda não garantia.

**Glifo vermelho e nomes de papel — confirmar contra o §3/§4, não contra os screenshots.** O screenshot da direção A mostra o vermelho só como medalha pequena; o §3 já manda **anel grosso + ✕ por cima do nó inteiro** — constrói-se pelo texto desta secção, o screenshot é que ficou atrás. Do mesmo modo, o nome do papel por baixo de cada nó (§4) nunca se abrevia («Security Reviewer» por inteiro, não «SECURITY REV.») — há espaço reservado para isso a 1440 e a 390; se um nome não couber numa linha, quebra para duas, nunca corta.

### 7. Comandos de mapa (requisito 2)

Por painel: **focar** (o painel ocupa a sala inteira) · **ecrã inteiro** · **−** · **+** · **ajustar** (enquadra a constelação). Globais, no cabeçalho: **Sala** (todos) · **Um projeto** · **Ecrã inteiro**. Arrastar com o rato/dedo move a constelação dentro do painel; a roda com `Ctrl` aproxima. Tudo isto é `viewBox` + eventos de ponteiro — **sem biblioteca, sem `requestAnimationFrame` a animar, sem `<canvas>`** (S1). Aproximar e arrastar são movimento **causado por uma pessoa**: não são animação e não caem na regra «idle não mexe».

### 8. Painel de detalhe (secundário, requisito 6)

Abre à direita (380 px) ao tocar num nó, e **nunca é preciso** para responder às quatro perguntas. Abas: *Visão geral* · *O que fez* · *Registo*. Mostra: papel, projeto, banda + palavra de estado, o que está a fazer em palavras, tarefa, desde quando, último sinal, **capacidade** («Modelo forte (o mais capaz)», nunca o nome técnico do modelo) e de quem depende, cada um com a sua banda. É aqui — e só aqui — que pode aparecer o identificador do run, atrás de «Abrir o registo».

### 9. Telemóvel (≤ 720 px)

Os painéis empilham-se, pela mesma ordem. **O primeiro projeto tem de caber inteiro num ecrã de 844 px** — nome, selo, contagens, constelação e frase do Lead — e o segundo começa logo a seguir (medido no mock a 390: o segundo painel começa aos ~740 px). Para isso, no telemóvel: o cabeçalho da página perde o subtítulo e os botões de vista (fica «ecrã inteiro»), o painel perde `−`/`+`/`ajustar` (ficam `focar` e `ecrã inteiro`), a cronologia mostra duas linhas. Alvos ≥ 44 px, corpo ≥ 16 px, sem scroll horizontal, sem identificadores.

### 10. Movimento

Dois momentos, ambos só em `opacity`, ambos presos a evidência: o **pulso do halo** dos nós verdes (2,4 s, 0,45→1) e os **três pontos** sobre a ligação acesa. Mais nada anima — nem painéis a entrar, nem números a rolar, nem linhas a desenharem-se. `prefers-reduced-motion: reduce` desliga os dois e a página fica inteiramente legível: nenhuma informação vive só no movimento.

### 11. Fazer / não fazer (centro de controlo)

- Fazer: um painel por projeto, todos iguais; a palavra de estado e as contagens sempre visíveis; o nome do papel debaixo de cada nó; a cor do nó a ser só o estado; acender no máximo duas ligações, e só com prova; frases inteiras em português.
- Fazer: cinzento para «já entregou» e «ainda não foi preciso»; vermelho só para «devia estar a andar e não anda».
- Não fazer: identificadores, prompts, caminhos, códigos de task ou nomes de modelo na vista principal. Não fazer: esconder um projeto parado. Não fazer: tabs para trocar de projeto. Não fazer: contadores técnicos no cabeçalho. Não fazer: cartões dentro de cartões — os blocos interiores são blocos com filete. Não fazer: física, forças ou layout automático; as posições estão escritas. Não fazer: `<canvas>`, WebGL, SMIL, biblioteca de grafos (S1).

## Layout (desktop, ≥ 1000 px) — HISTÓRICO (até 17 set 2026)

> **Superado em 18 set 2026 pela secção «Centro de controlo».** Esta secção descrevia uma página de **um run de cada vez**, com seletor, HUD de dez cartões e três colunas de texto por baixo. Continua a valer daqui: o ciclo do bilhete do Sponsor (`open` → `pending` → `answered`), o bloco «Novo run» e as suas palavras de estado, e a regra dos elementos claros. Tudo o que diz respeito a **seletor de run, HUD de dez cartões em cinco colunas e três colunas de texto** deixou de valer: passou a haver um painel por projeto e o texto longo vive na vista de um projeto.

1. **Cabeçalho** (1 linha + 1 subtítulo): `FORJA` · projeto · objetivo do run · começou há X · nº de eventos · piso de modelo · forjalvl · permissões; à direita o **estado do run** como selo grande (a trabalhar / precisa do Sponsor / bloqueado / sem resposta / morto / terminado / falhou / à espera de quota) e o contador "N para o Sponsor". Seletor de run quando há mais do que um (o ativo mais recente por omissão). **Desde T-UI-9 o seletor é uma barra própria, logo por baixo do cabeçalho** (`#runsel`), com três coisas: o `<select>` dos **runs verdadeiros** agrupados por projeto («`<projeto> · R-… · <estado>`», id abreviado a 390 para a palavra de estado nunca ser cortada), a dobra «sessões soltas (N)» — sessões do Claude Code no mesmo projeto que nunca pertenceram a nenhum run, com rótulo honesto («sessão interativa» / «sessão sem run»), fechada por omissão — e o botão «pausar atualizações». Uma sessão solta escolhida di-lo no cabeçalho, em palavras: «sessão solta — não é um run», sem os campos que só um run tem (piso, forjalvl, checkpoints, fila do Sponsor). A barra é um **nó estável**: as opções reconciliam-se in-place e o `<select>` nunca é substituído (substituí-lo fechava o menu aberto no telemóvel a cada instantâneo).
2. ~~**Cena da forja**~~ — **SUBSTITUÍDA em 17 set 2026** pela secção «Cena: agentes ligados» (mais abaixo), por direção do Sponsor: em vez de estações de forja, um grafo de agentes com o Lead ao centro. O texto original fica aqui como histórico e **não se implementa**; o que manda para a cena é a secção nova. Continuam em vigor daqui: a cena ocupa uma faixa no topo, não tem cena no telemóvel na forma desktop, e o brilho de estado nunca é apagado por hierarquia visual.

   <details><summary>Histórico — cena da forja (16 set 2026)</summary>

   **Cena da forja** (faixa de ~200 px, SVG 2.5D, sem WebGL): dez estações em **cinco colunas e duas profundidades** — uma coluna por par de papéis, cada coluna exatamente por cima da mesma coluna do HUD. À frente, maiores e ao nível do chão, as cinco de núcleo (Lead · Architect · Frontend Dev · Backend Dev · Reviewer, uma por coluna); atrás, mais pequenas, mais acima e ligeiramente à direita, sobre uma bancada corrida, as cinco a pedido (Product Manager · Product Designer · Technology Scout · QA · Security Reviewer, pela mesma ordem de colunas). **A profundidade substitui o antigo vão horizontal**: "a pedido" lê-se por estar atrás, não por estar à direita. Em cada coluna, a estação grande da frente é o cartão de cima (fila 1) e a pequena de trás é o cartão de baixo (fila 2). O brilho de cada estação codifica o estado (ver tabela); a cena nunca contém texto essencial — nem nomes, nem monogramas, nem o rótulo «a pedido», que vive só no cartão.

   **Geometria** (unidades do `viewBox="0 0 1440 240"`, iguais a px a 1440):
   - **Colunas = as do HUD**, calculadas dos mesmos valores e não à mão: `PAD = 24` (`--s5`, o padding lateral do HUD), `GAP = 8` (`--s2`), `COL = (1440 − 2·PAD − 4·GAP) / 5 = 272`, `cx(i) = PAD + i·(COL+GAP) + COL/2` → **160 · 440 · 720 · 1000 · 1280**. Se o padding ou o gap do HUD mudarem, mudam aqui pela mesma fórmula.
   - **Fila da frente (núcleo)**: linha de chão `150`, escala `.62`, deslocamento `0`, brilho `rx 84 / ry 66`, anéis `rx 56 / ry 14`, corpo a 100 % da opacidade de estado.
   - **Fila de trás (a pedido)**: é a da frente a **68 %** (`DEPTH = .68`, um único número) — linha de chão `100`, escala `.42`, deslocamento **`+58` dentro da própria coluna**, brilho `rx 57 / ry 45`, anéis `rx 38 / ry 9,5`, espessuras (anel, X, faíscas) × .68, corpo × **.75** (névoa de distância).
   - **Bancada corrida**: um `rect` de 1440 × 6 com o topo em `118`, `#2A2321` a 60 %, desenhado antes das estações — a fila da frente tapa-a, e é essa oclusão que se lê como profundidade. Substitui o elemento `bench` do vão, que desaparece.
   - **Ordem de desenho**: parede · chão · bancada de trás · cinco estações de trás · linha do horizonte (`176`) · cinco estações da frente.
   - **Contenção (a regra que impede a troca de dono)**: nenhum brilho sai da sua coluna — frente `cx ± 84`, trás `cx + 1 … cx + 115`, ambos dentro de `cx ± 136`. Qualquer mudança de tamanhos tem de manter esta propriedade.
   - A cena escala com a largura (`preserveAspectRatio="xMidYMax meet"`) enquanto o padding e o gap do HUD são fixos: entre 1000 e 1440 px o desvio entre o centro da coluna na cena e no HUD é ≤ 6 px, contra 280 px de passo. Abaixo de 1000 px não há cena.

   **Honestidade da profundidade:** a profundidade apaga a mobília, nunca o estado. A opacidade do **brilho** vem só da tabela de estados e é igual à frente e atrás — um papel a pedido a trabalhar brilha tanto como um de núcleo. Só o corpo da estação leva o × .75; por isso o caso especial "a pedido `inativo` = .3" desaparece (a fila de trás já diz "a pedido" pela posição) e `inativo` fica em .45 × .75 ≈ .34 para qualquer papel.

   **Duas estações acesas na mesma coluna** (o papel de núcleo e o a pedido a trabalharem ao mesmo tempo): os dois brilhos tocam-se, e é isso que se quer ver. Distinguem-se pelo tamanho, pela altura e pela cor de identidade; a de trás é sempre a mais pequena e a mais alta, e é a do segundo cartão da coluna. Nunca se funde os dois num só brilho nem se baixa a opacidade de um para "arrumar" a imagem. Duas colunas têm identidades vizinhas (coluna 1: brasa/madeira; coluna 5: aço/aço fosco): aí quem distingue é a profundidade, e a atribuição exata está sempre nos dois cartões por baixo — a cena nunca é a fonte.

   </details>
3. **HUD do elenco**: dez cartões em duas filas de cinco (fila 1 núcleo, fila 2 a pedido), cinco colunas de 272 px com padding lateral 24 e gap 8; sempre os dez, mesmo `inativo`. (Desde 17 set 2026 o HUD deixou de mandar na cena: o grafo de «Cena: agentes ligados» tem posições próprias e cada nó identifica-se pelo monograma, não pela coluna por baixo. As cinco colunas de 272 px continuam a valer **para o HUD**.) Cada cartão: nome (cor de identidade), papel em palavras simples, **palavra de estado grande** (Barlow Condensed 32–40 px), "há X · desde HH:MM", linha de vida ("último sinal há Xs" ou selo âmbar "silêncio há X"), depois as instâncias: chip da task (`T3`) + título, estado da instância + há quanto tempo, o que está a fazer (progresso / última ação / veredicto), modelo real pequeno, "em background" quando aplicável. Várias instâncias = vários blocos dentro do cartão, nunca um número. **Cartão sem instâncias (o Lead é a própria sessão):** mostra o `detail` do cartão como "em quê" (ex. "à espera de Backend Dev, Reviewer" ou a última ação), um bloco `run` com o objetivo do run e o selo do estado do run, e a linha "modelo da sessão · mínimo <modelFloor> · N chamadas". Um cartão `inativo` de núcleo diz "ainda não foi chamado neste run"; um cartão `inativo` a pedido diz "a pedido · ainda não foi preciso neste run" (o instantâneo traz `core: true|false` por cartão).
4. **Ferramentas nativas**: uma faixa fina, cinzenta, por baixo do HUD, a listar instâncias nativas em curso (tipo, o que fazem, modelo). Nunca um cartão, nunca nomes próprios.
5. **Três colunas** por baixo: **Precisa do Sponsor** (bilhetes claros: pergunta, "se não responder: <default>", porquê, campo de resposta + botão "Enviar"; também permissões pendentes, a sessão principal parada e a espera de quota; por baixo da fila, a lista curta **Decisões** do Product Manager com id, texto e "reversível"), **Linha do tempo** (mais recente em baixo no desktop, cada entrada com hora, ponto colorido por tipo e texto), **Revisões + Tasks** (livro-razão dos veredictos; tasks com estado, dono, tentativas e último motivo). O cabeçalho leva três contadores com estes rótulos literais: `eventos` · `erros` · `sem resposta ou recusadas` (nunca "recusadas" a seco — o redutor não distingue).

**Ciclo de um bilhete:** `open` — bilhete claro, campo ativo, conta no "N para o Sponsor"; depois de "Enviar" o servidor responde `{ok:true}` e o instantâneo passa a `pending` — o bilhete fica na fila com o selo "resposta enviada · à espera do Lead", texto da resposta visível, campo desativado, e **deixa de contar** no "N para o Sponsor"; quando o Lead a recolhe (`answered`) o bilhete sai da fila (é a página que filtra `answered`; o instantâneo continua a trazê-los) e a resposta aparece na linha do tempo (kind `answer`). Se o envio falhar (404/413/rede) o bilhete mostra "não foi possível enviar — tenta outra vez" a âmbar e mantém o campo ativo.
6. **Rodapé de ligação**: "ligado · atualizado há Xs" / "a tentar ligar… (a consultar de 5 em 5 s)".

### Novo run

**Decisão do Product Designer, 16 set 2026.** A regra é "o único elemento claro do ecrã é o que precisa de um humano" e continua de pé: o claro marca **território do humano**, não urgência. Quem marca urgência é o `--alarm` (contorno do bilhete) e o contador "N para o Sponsor". «Novo run» é uma **oferta** ao Sponsor, não um pedido do sistema, por isso leva bilhete claro (`--ticket`) com acento **`--wood`** — filete de 1 px e o rótulo pequeno «novo run» — nunca preenchimento de alarme, nunca contorno de alarme, e **nunca conta** no "N para o Sponsor". Aqui a madeira não é identidade nem estado de espera: é "ação do humano, sem pressa"; é o terceiro e último uso permitido do token. No máximo **dois elementos claros** por ecrã (a fila e este); um terceiro elemento de ação nasce escuro com rótulo madeira.

- **Posição.** Desktop: fim da coluna «Precisa do Sponsor», depois de «Decisões» — é a coluna do Sponsor e arrancar é a coisa menos urgente dela, logo fica em último. Telemóvel: a seguir às dez linhas do elenco e **antes** de «Precisa do Sponsor» — sem colunas, é a razão pela qual o Sponsor abre a página quando não há nada pendente, e a prioridade de uma pergunta aberta já é dada pelo contorno de alarme e pelo contador do cabeçalho, não pela ordem.
- **Palavras de estado**, exatas, por projeto, no seletor e por baixo dele (nunca só cor): `sem run` · `a arrancar` · `run a correr, runner vivo` · `run em curso, runner parado` · `terminado` · `falhou` · `bloqueado`. Só `run em curso, runner parado` mostra o botão «Relançar o runner»; `run a correr, runner vivo` não mostra ação nenhuma (nada a fazer é um estado legítimo, não um botão desativado a meio).
- **Objetivo**: 10–600 caracteres, contador em mono (`53/600`) alinhado à direita; fora do intervalo o «Arrancar» fica desativado e o contador passa a âmbar.
- **Dois toques, sem modal**: «Arrancar» troca-se no próprio sítio por «Confirmar» + «Cancelar»; o segundo toque envia. Nada se sobrepõe à página — um diálogo tapava o estado do run, que é o que a página existe para mostrar.
- **Selo depois de enviar**: ocupa o lugar dos botões — «run a arrancar — a notificação chega em menos de um minuto», em madeira, até o servidor confirmar runner vivo; aí o bloco passa a `run a correr, runner vivo`.
- **Erro**: mesmo tratamento da falha de envio de um bilhete — «não foi possível arrancar — tenta outra vez» a **âmbar**, campo ativo com o texto escrito, botão de volta a «Arrancar». Nunca alarme: não há nada partido no run.
- **Nunca aparece**: caminho do projeto, token, linha de comando, id de sessão. O projeto identifica-se pelo nome e mais nada.
- **Acessibilidade**: alvos ≥ 44 px (seletor, campo, os dois botões), corpo ≥ 16 px no telemóvel, `label` no seletor e no campo, foco visível 2 px `--patina`. **Sem `aria-live` novo** — o selo aparece onde o dedo acabou de tocar; as regiões ao vivo continuam a ser só o selo do run e o contador da fila.

## Cena: agentes ligados — HISTÓRICO (17 set 2026)

> **Superada em 18 set 2026 pela secção «Centro de controlo», §4 e §5.** Continua a valer daqui: o Lead ao centro e maior, o losango do núcleo pela ordem do fluxo, a órbita de fora para os papéis a pedido, as dezanove ligações como desenho de base, a proibição de física/layout automático e a proibição de `<canvas>`/WebGL/SMIL. **Deixou de valer**: o anel de identidade por papel (a cor do nó é agora o estado), «na cena só entram duas letras» (cada nó leva o nome do papel), e «uma aresta nunca muda com o estado» (acendem-se, no máximo, a ligação de espera e a entrega recente).

**Direção do Sponsor, 17 set 2026, 08:30** (é decisão dele, `docs/forja/DECISIONS.md` D1): «em vez de forjas desenha agentes; que o agente principal tenha ligações a subagentes; e, para efeito visual, liga subagentes entre si (ex.: Reviewer ligado ao Dev) para termos um gráfico de ligações». **Escolha do Product Designer** entre três direções em mocks reais (`docs/design/mocks/agentes-a-pictogramas.html`, `agentes-b-constelacao.html`, `agentes-c-bancada.html`, screenshots a 1440 e 390 em `docs/design/mocks/screenshots/agentes-*`; razões em `docs/design/mocks/README.md`): **B — constelação** (D2). Esta secção substitui o §2 «Cena da forja», que fica só como histórico.

**O que a cena faz e o que não faz.** Continua a ser decorativa no sentido estrito: responde a "quem está aceso e quem precisa de um humano" num relance e mostra como o trabalho circula. O texto exato — nome, papel, palavra de estado, task, modelo, tempos — vive no HUD e só no HUD. Se um elemento da cena tornar qualquer resposta do teste dos 5 segundos mais lenta, corta-se o elemento.

### Geometria

Um `<svg>` com `viewBox="0 0 1440 240"`, `preserveAspectRatio="xMidYMid meet"`, escondido abaixo de 720 px (onde entra a versão de telemóvel, ver mais abaixo). Nada de biblioteca: SVG inline + CSS, decisão S1 em `docs/forja/TECHNOLOGY.md`, que se mantém intacta.

- **O Lead é o centro**, `(720, 120)`, raio `36` — o maior nó e o maior halo. É a única hierarquia da cena e corresponde à verdade do sistema: só o Lead chama alguém.
- **Os quatro papéis de núcleo restantes formam um losango** à volta dele, **pela ordem do fluxo**: Architect à esquerda `(438, 120)`, Frontend Dev em cima `(720, 42)`, Backend Dev em baixo `(720, 198)`, Reviewer à direita `(1002, 120)`; raio `25`. É esta ordem que faz com que as quatro arestas de fluxo do núcleo sejam os quatro lados do losango — **nenhuma aresta passa por cima de um nó**. Qualquer mudança de posições tem de manter essa propriedade.
- **Os cinco papéis a pedido ficam na órbita de fora**, raio `18`, cada um encostado ao papel a quem entrega: Product Manager `(182, 58)` junto ao Architect, Product Designer `(464, 28)` e Technology Scout `(950, 28)` junto aos Devs, Security Reviewer `(1270, 58)` junto ao Reviewer, QA `(1270, 190)` a fechar o círculo de volta ao Lead. **Mais pequenos e mais afastados**: "a pedido" lê-se pelo tamanho e pela distância ao centro, nunca por estar apagado.
- **Núcleo contra a pedido**: contorno **contínuo** no núcleo (2 px), **tracejado** `7 5` a pedido (1,5 px). A forma do contorno é a segunda pista, além do tamanho e da órbita — e não depende de cor.
- **Arestas**: curvas quadráticas com desvio máximo pequeno (`|bow|/2`, quase sempre ≤ 8 px), recortadas no raio de cada nó para não entrarem no círculo. Três precisam de contornar um nó vizinho (Lead→Product Manager, Lead→Security Reviewer, QA→Lead): aí o desvio sobe a 15 px. Nunca uma aresta por baixo de um nó de terceiros.
- **Correção na implementação (T-UI-7, 17 set 2026):** a aresta Lead→Product Manager passou de `bow` −30 (mock) para **+36** (18 px de desvio, para o lado de fora): com −30 a curva entrava 7,7 px no disco do Architect e lia-se através do nó, contra o invariante desta secção. Com +36 nenhuma aresta chega a menos de um raio do centro de um nó de terceiros (mínimo medido: 17,6 px (aresta lead→qa junto ao Reviewer); a aresta lead→product-manager fica a 25,2 px do Architect além do disco, em `test/viewer-page.test.mjs` por amostragem das quadráticas). Os restantes dezoito `bow` são os do mock.
- **Orçamento**: ≤ 300 elementos SVG e ≤ 30 KB de string por render, como em S1. Medido no mock com os dez papéis e as dezanove arestas: **116 elementos**.

### As arestas: chamadas contra fluxo (a regra da honestidade)

Há **dois tipos**, com desenho e significado diferentes, e a página diz qual é qual por escrito (legenda literal, por baixo da cena): «linha cheia = o Lead chama · tracejado = fluxo de trabalho (representação)».

| Tipo | Desenho | Significado | Arestas |
|---|---|---|---|
| **chamada** (`hub`) | linha **cheia**, 1,5 px, `#6E5C4D` | verdade do sistema: o Lead é o único com a ferramenta `Agent` | Lead → cada um dos outros nove |
| **fluxo** (`flow`) | linha **tracejada** `6 6`, 1,5 px, `#4E4238` | **representação** de quem trabalha para quem; o caminho real volta sempre a passar pelo Lead | Architect→Frontend Dev · Architect→Backend Dev · Frontend Dev→Reviewer · Backend Dev→Reviewer · Reviewer→Security Reviewer · QA→Lead · Product Manager→Architect · Technology Scout→Frontend Dev · Technology Scout→Backend Dev · Product Designer→Frontend Dev |

As dezanove arestas são **fixas**: nunca aparecem, desaparecem, mudam de espessura ou de cor por causa do estado. Uma aresta não é evidência de nada — a evidência está nos nós. Não fazer: acender a aresta Architect→Frontend Dev por o Architect estar a trabalhar; isso seria inventar uma chamada que não existe.

### Estado de cada nó — cor **e** forma

A cor e o halo mantêm exatamente a tabela «Estados — palavra, cor, tratamento» (a coluna «Estação (cena)» lê-se agora como «Nó (cena)»). O que muda: **cada nó leva um glifo de estado** numa pequena medalha no quadrante superior direito da coroa, sobre `--bg` com contorno `--line`, para que o estado nunca dependa só de cor.

| Estado | Halo (opacidade) | Glifo | Cor do glifo |
|---|---|---|---|
| a trabalhar, sinal recente | 1, **pulsa** | ponto cheio | `--ember` |
| a trabalhar, silêncio | 0,5, sem pulso | ponto com anel tracejado | `--amber` |
| à espera de review / input / quota, **em pausa** | 0,35 | barra horizontal | `--wood` |
| bloqueado · precisa do Sponsor | 0,55, **na cor `--alarm`** (rouba a identidade) | «!» | `--alarm` |
| sem resposta | 0 | anel vazio | `--amber` |
| morto | 0 | ✕ grande **por cima do nó inteiro** | `--alarm` |
| terminado | 0 | visto | `--patina` |
| falhou | 0 | ✕ pequeno, só na medalha | `--alarm` |
| inativo | 0 | sem glifo, nó a 45 % | — |

- `morto` e `falhou` distinguem-se pelo **tamanho e pelo sítio** do ✕ (o nó inteiro contra a medalha), não pela cor; a palavra exata está sempre no cartão.
- O **anel de identidade nunca muda de cor** com o estado: a cor do papel é do papel. Quem muda é o halo (e só para `--alarm`, quando precisa de um humano).
- **A hierarquia apaga a mobília, nunca o estado**: a opacidade do halo é a mesma na órbita de fora e no centro. Um Technology Scout a trabalhar brilha tanto como o Lead.
- **Instância ativa**: um ponto na coroa de baixo do nó por instância em curso, no máximo **três** (quatro ou mais continuam três pontos — o número exato está no cartão). Nunca um algarismo dentro da cena.
- **Runner parado ou morto**: a cena inteira fica fria — todas as arestas a 35 % de opacidade — e a legenda ganha «runner parado: a rede está fria». Os nós mantêm o seu estado. Isto **nunca** é a única prova: o selo do run no cabeçalho di-lo por palavras e é ele que manda.

### Identificação: o monograma entra na cena

Cada nó leva o seu **monograma de duas letras** (Le · Ar · FD · BD · Re · PM · PD · TS · QA · SR) em Barlow Condensed 700, na cor de identidade, centrado: 26 px no Lead, 22 px no núcleo, 16 px nos a pedido. **Isto revoga a regra antiga «a cena nunca contém texto»** (§2 histórico), que existia porque a estação era identificada pela coluna do HUD por baixo. Um grafo não pode estar alinhado por colunas; o nó identifica-se sozinho. Nomes completos, papéis, palavras de estado e tasks continuam **proibidos** dentro da cena: dois caracteres, mais nada.

### Movimento (só com evidência)

1. **Pulso do halo** — `opacity .5 → 1`, 2,4 s, ease-in-out, **só** nos nós `a trabalhar` com sinal recente (< 90 s). Idle não mexe.
2. **Fluxo de hand-back** — quando um hand-back acabou de acontecer, três pontos `--patina` de raio 4 aparecem sobre a aresta correspondente (em t = 0,3 · 0,5 · 0,7) e acendem-se em cascata (atrasos 0 · 0,32 s · 0,64 s, 1,7 s de ciclo). **Anima só `opacity`** — nada de `stroke-dashoffset`, nada de SMIL, nada de `requestAnimationFrame`, conforme S1. Some quando o evento sai da janela: o movimento é a consequência de um acontecimento, nunca decoração permanente.

Mais nada anima na cena: nós não deslizam, arestas não se desenham, nada faz *fade*. Com `prefers-reduced-motion: reduce`, o pulso e o fluxo desligam-se e a cena fica inteiramente legível — nenhuma informação vive só no movimento.

### Telemóvel (≤ 720 px)

A cena **não desaparece**: encolhe, na mesma linguagem, com `viewBox="0 0 390 230"`.

- **Só o grafo do núcleo**: o mesmo losango, Lead ao centro `(195, 128)` raio 28, Architect `(74, 128)`, Frontend Dev `(195, 54)`, Backend Dev `(195, 202)`, Reviewer `(316, 128)`, raio 21. As curvaturas ficam a metade.
- **Os cinco a pedido ficam dobrados** numa barra por baixo da cena, com altura mínima de 44 px: o rótulo «a pedido» e cinco pastilhas com o glifo de estado e o monograma, mais «abrir os 5 ▾». Aberta, a barra mostra os cinco nós no mesmo desenho. Um papel a pedido em `bloqueado` ou `precisa do Sponsor` **nunca fica escondido**: a sua pastilha mostra o «!» mesmo dobrada, e o contador «N para o Sponsor» do cabeçalho conta-o.
- Depois da cena vem a lista das dez linhas compactas, como já era.

### Acessibilidade

- O `<svg>` tem `role="img"` e um `aria-label` que enumera os dez papéis e o estado de cada um em palavras («Lead: a trabalhar. Architect: terminado. …»). Deixa de ser `aria-hidden`: agora que a cena tem conteúdo próprio, é descrita. **No telemóvel (T-UI-7)** o `aria-label` da cena enumera só os cinco de núcleo, que são os que ela desenha; os cinco a pedido vão no texto de cada pastilha da barra («Product Manager: terminado», visível para quem ouve a página), para a descrição não prometer o que o desenho não mostra.
- **O monograma nunca é apagado** por hierarquia: a opacidade de 45 % do nó aplica-se ao anel e aos pontos de instância, e ao texto só em `inativo` (o estado que o DESIGN manda apagar por inteiro). Em `terminado`, `morto`, `sem resposta` e `falhou` o monograma fica a 100 % — é texto e tem de cumprir o contraste (T-UI-7).
- **Nada depende só de cor**: cada estado tem glifo; núcleo/a pedido tem contorno contínuo/tracejado e tamanho; a identidade tem monograma.
- Contraste: os monogramas usam as cores de identidade sobre `--surface` (o mais fraco é `--ember`, 7,2:1); os glifos são formas, não texto, com 1,4 px mínimos de traço.
- A cena não é interativa e não tem alvos de toque — quem quiser detalhe usa os cartões, que já têm alvos ≥ 44 px. Se um dia um nó ganhar toque, tem de ganhar `≥ 44 px` de alvo e foco visível 2 px `--patina`.

### Fazer / não fazer (cena)

- Fazer: manter o Lead no centro e maior — a geometria é a hierarquia. Manter as dezanove arestas fixas e a legenda que diz que as tracejadas são representação. Pôr sempre glifo junto a cor. Manter a mesma opacidade de halo dentro e fora da órbita. Um monograma por nó e nada mais de texto.
- Fazer: derivar o estado só do instantâneo; um nó sem evidência recente não pulsa.
- Não fazer: mudar uma aresta por causa de um estado; acender um caminho que o sistema não percorreu. Não fazer: esconder um papel a pedido, no desktop ou no telemóvel dobrado, quando ele está `bloqueado` ou `precisa do Sponsor`. Não fazer: apagar o halo de um papel a pedido «para arrumar a imagem». Não fazer: escrever nomes, papéis ou palavras de estado dentro da cena. Não fazer: setas em todas as arestas ao ponto de a cena virar um diagrama de UML. Não fazer: física, forças, nós que se arrastam, layout automático — as posições são fixas e estão escritas aqui.
- Não fazer: three.js, WebGL, `<canvas>`, SMIL, `requestAnimationFrame`, transições CSS na cena ou animar qualquer coisa que não seja `opacity` (S1).

## Layout (telemóvel, ≤ 720 px, página `/m`) — HISTÓRICO (até 17 set 2026)

> **Superado em 18 set 2026 pela secção «Centro de controlo», §9.** Continua a valer daqui: alvos ≥ 44 px, corpo ≥ 16 px, sem scroll horizontal, sem token na página, e os bilhetes do Sponsor com o mesmo ciclo.

Mesma informação, 2D, por esta ordem: cabeçalho curto (projeto, objetivo numa linha, selo do run, N para o Sponsor) · **a cena do núcleo** em 390 × 230 com os cinco a pedido dobrados numa barra (secção «Cena: agentes ligados») · **dez linhas compactas** (monograma, nome, palavra de estado, há quanto tempo, sinal de silêncio) — 56 px cada, núcleo primeiro, a pedido com o rótulo. **Desde T-UI-7 as dez já não cabem no primeiro ecrã de 844 px**: a cena, a barra «a pedido» e a legenda ficam acima delas e a primeira linha começa aos **757 px** (medido no browser a 390 × 844 depois da barra do seletor da T-UI-9, que ocupa 113 px em duas linhas: o seletor numa, a dobra e o botão de pausa na outra; em pausa continua em duas linhas — 116 px — porque a hora vai dentro do próprio botão); quem quer só o elenco rola uma vez. O que tem de caber sem rolar é o cabeçalho com o selo do run e o «N para o Sponsor», e esse cabe. Tocar numa linha expande o cartão completo (instâncias, task, modelo; o do Lead mostra o objetivo e o "em quê") · Precisa do Sponsor (bilhetes com campo de resposta, mesmo ciclo `open`/`pending`, incluindo a mensagem de falha) · Tasks (lista) · Decisões (últimas 5) · Linha do tempo (últimas 30, **mais recente primeiro**). Alvos de toque ≥ 44 px, corpo ≥ 16 px, sem scroll horizontal, sem token na página.

## Estados — palavra, cor, tratamento

A palavra está sempre presente; a cor e o brilho só reforçam. Palavras exatas do redutor (`viewer/lib/state.mjs`, `STATES`).

> **18 set 2026:** a coluna «Nó (cena)» desta tabela está **superada** pelas quatro bandas de sinal («Centro de controlo», §3): verde = a trabalhar agora, amarelo = à espera/adormecido, vermelho = parado há mais de 5 minutos/morto/falhou, cinzento = terminado ou ainda não foi preciso. As **palavras** e a coluna «Cartão» continuam a valer, com uma correção: a palavra de estado usa a cor da **banda**, não a cor antiga (`a trabalhar` deixou de ser brasa e passou a verde; `terminado` deixou de ser pátina e passou a cinzento). As cores de identidade por papel continuam a existir para o nome nas listas e no painel de detalhe, mas **nunca no nó**.

| Estado | Palavra | Cor da palavra | Nó (cena) — ver «Cena: agentes ligados» para o glifo | Cartão |
|---|---|---|---|---|
| a trabalhar | a trabalhar | brasa `--ember` | brilho da cor de identidade com faíscas estáticas, **pulsa** devagar (só se último sinal < 90 s) | normal; "último sinal há Xs" a pátina |
| a trabalhar · silêncio | a trabalhar + selo `silêncio há X` | brasa + selo âmbar `--amber` | brilho a meia intensidade, anel tracejado âmbar, sem pulso | selo âmbar visível |
| à espera de review | à espera de review | madeira `--wood` | brilho baixo fixo | chip da task "à espera do Reviewer" |
| bloqueado | bloqueado | fundo alarme `--alarm`, texto escuro | anel vermelho fixo | contorno alarme 2 px, motivo em destaque |
| precisa do Sponsor | precisa do Sponsor | fundo alarme, texto escuro | anel vermelho fixo | contorno alarme, aparece também na fila |
| sem resposta | sem resposta | âmbar `--amber` | brilho apagado, anel âmbar | "último sinal há X" em âmbar |
| morto | morto | alarme (texto), fundo escuro avermelhado, **palavra riscada** | estação apagada, X vermelho | contorno alarme |
| terminado | terminado | pátina `--patina` | apagada, sem brilho | veredicto (APPROVE/REJECT/DONE) |
| falhou | falhou | alarme | apagada, anel vermelho | erro em destaque |
| inativo | inativo | cinza `--dim` | apagada | cartão a 70 % de opacidade, "ainda não foi chamado neste run" |
| à espera de input / à espera de quota | as palavras | madeira | brilho baixo | detalhe do porquê |
| em pausa | em pausa | madeira | brilho baixo | "limite de utilização, retoma às HH:MM"; o selo do run diz o mesmo |

O elenco tem **dez** papéis desde a terceira direção do Sponsor de 16 set 2026, com nomes em inglês simples e sem metáforas (`docs/ARCHITECTURE.md` §2). Ordem fixa: **núcleo** Lead · Architect · Frontend Dev · Backend Dev · Reviewer; **a pedido** Product Manager · Product Designer · Technology Scout · QA · Security Reviewer. Sempre os dez: dez nós no grafo da cena (Lead ao centro, núcleo em losango, a pedido na órbita de fora — secção «Cena: agentes ligados»), dez cartões no HUD em **duas filas de cinco** sobre as mesmas cinco colunas (fila 1 núcleo, fila 2 a pedido com o rótulo pequeno «a pedido» junto ao papel), dez linhas compactas no telemóvel (**56 px cada, medido pelo Frontend Dev** a 390 px com o rótulo «a pedido» a 12 px — 55,6 px, 69 px quando a palavra de estado ocupa duas linhas; núcleo primeiro; as dez cabem no primeiro ecrã com o cabeçalho curto: 10 × 56 + 9 × 4 de intervalo ≈ 596 px, a última linha acaba a 750 px dos 844). Um papel a pedido que ainda não foi chamado é `inativo` e diz «a pedido · ainda não foi preciso neste run»; nunca se esconde nem se agrupa. Os rótulos e estados ficam em português; os nomes dos papéis ficam sempre em inglês. Monogramas (duas letras, na cor de identidade): Le · Ar · FD · BD · Re · PM · PD · TS · QA · SR.

**Decisão do Product Designer, 16 set 2026:** a cena e o HUD contradiziam-se — o §2 pedia dez estações numa faixa horizontal (cinco · vão · cinco, onze fatias de ~126 px) e o §3 pedia dez cartões em duas filas de cinco de 280 px, pelo que as estações caíam em 87 · 214 · 340 · 467 · 593 · 846 · 973 · 1100 · 1226 · 1353 px e as colunas do HUD em 160 · 440 · 720 · 1000 · 1280 px: o brilho de um papel aparecia por baixo do cartão de outro (nas provas, o brilho pátina do Frontend Dev por baixo de «ARCHITECT — INATIVO» e o anel de alarme do Product Manager por baixo do cartão do Frontend Dev). Como o único trabalho da cena é "quem brilha", a troca de dono estragava a página. Escolhida a **profundidade**: cinco colunas, as mesmas do HUD, com o núcleo à frente e os papéis a pedido atrás (§2). Alternativas consideradas e rejeitadas: (a) **duas faixas finas**, uma por fila de cartões — alinha por construção mas parte a cena em duas imagens, obriga a ler duas vezes, rouba altura a meio do HUD e duplica o orçamento de elementos; (b) **dez estações nas cinco colunas com desvio horizontal** (par lado a lado dentro da coluna) — os dois brilhos de `rx 84` ficariam quase concêntricos e o par voltaria a ler-se como duas colunas, além de tocar na coluna vizinha. A profundidade ganha porque dá três pistas ao mesmo tempo (tamanho, altura, oclusão), mantém uma só imagem, não custa altura nenhuma, e é a única em que o significado da posição coincide com o que já distingue os papéis: quem está sempre no run está à frente, quem só é chamado quando é preciso está atrás. Verificada num esboço estático (`docs/design/mocks/cena-dez-papeis.html`, screenshot a 1440), 180 elementos SVG, dentro do orçamento de 300. É uma decisão reversível (é código e números num ficheiro); o Sponsor pode trocá-la pela alternativa (a) sem mexer em mais nada.

Identidades: cada papel a pedido usa uma **variante clara ou fosca da cor do papel de núcleo com que trabalha** (Product Designer ↔ Frontend Dev em pátina, Technology Scout ↔ Backend Dev em índigo, QA ↔ Architect em ardósia, Security Reviewer ↔ Reviewer em aço, Product Manager mantém a madeira), para a paleta não virar um arco-íris; a distinção fica no monograma e no nome, a cor só reforça a família. Valores e contrastes na tabela de tokens.

Regra de honestidade: **idle não mexe** — só um nó `a trabalhar` com sinal recente pulsa. O segundo e último movimento permitido é o fluxo de hand-back sobre uma aresta, e só enquanto o hand-back é recente. Nada replica histórico como animação. `prefers-reduced-motion: reduce` desliga os dois; tudo o resto fica igual.

Dois desvios deliberados em relação aos mocks (que usavam índigo para as esperas e alarme para "sem resposta"): os estados de espera (`à espera de review` / `de input` / `de quota`) usam `--wood`, porque o índigo é a identidade do Backend Dev e uma cor de identidade não pode significar um estado; `sem resposta` usa `--amber`, a família "idade do sinal" (junto com "silêncio há X"), reservando `--alarm` para "precisa de um humano" (bloqueado, precisa do Sponsor, morto, falhou). Qualquer preenchimento `--alarm` (selos, chips `REJECT`, fundos de estado) leva **sempre texto escuro `#1B1512`** — texto claro sobre alarme fica abaixo de 4,5:1.

## Tokens

| Papel | Valor | Uso |
|---|---|---|
| `--bg` | `#0E0C0B` | fundo da página |
| `--surface` | `#17130F` | cartões, painéis |
| `--surface-2` | `#211B16` | blocos dentro de cartões, linhas do tempo |
| `--line` | `#3A2F27` | contornos, divisórias |
| `--ink` | `#F3E9DC` | texto principal (contraste ≥ 12:1 em `--bg`) |
| `--dim` | `#A89A8A` | texto secundário (≥ 5:1 em `--surface`) |
| `--ember` | `#FF7A2F` | laranja brasa: identidade do Lead, estado "a trabalhar" |
| `--wood` | `#CFA063` | madeira: identidade do Product Manager, estados de espera |
| `--indigo` | `#93A0FF` | índigo: identidade do Backend Dev |
| `--indigo-2` | `#C3C9FF` | índigo claro: identidade do Technology Scout (12,2:1 em `--bg`, 11,5:1 em `--surface`) |
| `--patina` | `#63C9A9` | verde pátina: identidade do Frontend Dev, "terminado", sinal de vida |
| `--patina-2` | `#A8E3D0` | pátina clara: identidade do Product Designer (13,5:1 / 12,8:1) |
| `--alarm` | `#FF4F3E` | vermelho alarme: **só** estados que exigem atenção (bloqueado, precisa do Sponsor, morto, falhou, REJECT) |
| `--amber` | `#F0B23F` | âmbar: **só** "silêncio há X" e "sem resposta" |
| `--steel` | `#C9D1DA` | aço: identidade do Reviewer (neutra, para o vermelho ficar só para o perigo) |
| `--steel-2` | `#9AA6B2` | aço fosco: identidade do Security Reviewer (7,9:1 / 7,5:1) |
| `--slate` | `#8FB3C9` | ardósia: identidade do Architect (giz de traçar) |
| `--slate-2` | `#B9D3E3` | ardósia clara: identidade do QA (12,5:1 / 11,9:1) |
| `--ticket` | `#F1E7D8` | bilhete claro da fila do Sponsor (texto `#1B1512`) |
| `--vivo` | `#45D48A` | **banda verde**: a trabalhar agora (10,26:1 em `--bg`; texto escuro `#12100E` por cima, 9,98:1) |
| `--espera` | `#F0B23F` | **banda amarela**: à espera, adormecido, em pausa (10,36:1; = `--amber`, que deixa de ser só «silêncio») |
| `--parado` | `#FF4F3E` | **banda vermelha**: parado há mais de 5 min, morto, falhou (5,98:1; = `--alarm`) |
| `--neutro` | `#8A8078` | **banda cinzenta**: já entregou, ou ainda não foi preciso (5,05:1 — só contorno e texto secundário; texto corrido usa `--dim`) |

**18 set 2026 — quem manda na cor:** dentro de um painel de projeto, a cor é **sempre** a banda de sinal. As dez cores de identidade acima continuam a existir para o nome do papel em listas e no painel de detalhe, e desaparecem dos nós, dos anéis e dos halos. Nenhuma cor de identidade pode significar um estado, e nenhuma cor de estado pode marcar uma pessoa.

A cor de identidade de um membro aparece só no seu monograma (no cartão e no nó da cena), nome, barra do cartão, anel do nó e halo do nó. A palavra de estado usa a cor de estado da tabela acima, mesmo quando essa cor coincide com a identidade de alguém (o `a trabalhar` do Backend Dev é `--ember` como o de todos). Cores de estado aparecem sempre com a palavra.

## Tipografia (Google Fonts, $0)

| Uso | Fonte | Tamanho / peso |
|---|---|---|
| Palavra de estado, nomes, selos | Barlow Condensed | 32–40 / 700 (cartão), 22 / 700 (telemóvel linha compacta), maiúsculas nos selos |
| Corpo, tasks, fila | Barlow | 16 / 400 (telemóvel ≥ 16), 15 / 400 (desktop), 600 para ênfase |
| Horas, ids, modelos, contadores | IBM Plex Mono | 12–13 / 400 |
| Cabeçalho `FORJA` | Barlow Condensed | 22 / 800, espaçamento 0.12em |

**18 set 2026 — tamanhos do centro de controlo** (mesmo par de fontes; as outras duas direções experimentaram Space Grotesk + IBM Plex Sans e Archivo + Public Sans e perderam): nome do projeto 30/800 Barlow Condensed · selo de estado 17/800 maiúsculas, texto escuro · contagens 26/800 com rótulo 14/600 · frase do Lead 19/600 Barlow · contexto e cronologia 13,5–14/400 · nome do papel debaixo do nó 11/700 Barlow Condensed maiúsculas · monograma dentro do nó 15/800 · botões 12–14/600 maiúsculas. No telemóvel: nome do projeto 24, contagens 21, frase 16, corpo ≥ 13,5 e nunca abaixo de 16 no texto que se lê a sério.

Escala de espaço: 4 · 8 · 12 · 16 · 24 · 32 · 48 px. Raios: 4 (chips) · 8 (cartões, botões) · 12 (bilhetes). Sem sombras difusas, sem gradientes (exceto na cena: o gradiente radial do halo de cada nó), sem vidro, sem emoji, sem cartões dentro de cartões (as instâncias são blocos separados por linha, não cartões).

## Motion

> **18 set 2026:** ver «Centro de controlo», §10 — os dois momentos continuam a ser exatamente dois (pulso do halo verde e os três pontos da ligação acesa), e aproximar/arrastar não contam como animação por serem movimento causado por uma pessoa.

Dois momentos de movimento, ambos presos a evidência e ambos só em `opacity` (detalhe em «Cena: agentes ligados»): o **pulso do halo** de quem está a trabalhar com sinal recente (2,4 s, ease-in-out, 0,5→1) e o **fluxo de hand-back**, três pontos em cascata sobre uma aresta, enquanto o hand-back é recente. Mais nada anima: contadores mudam de número sem transição; entradas novas na linha do tempo aparecem sem fade. Com `prefers-reduced-motion`, nem pulso nem fluxo.

## Ligação e verdade

- Estado vem do servidor (`/events` por SSE, fallback para `GET /state` a cada 5 s se não chegar `state` em 8 s). O tempo decorrido é calculado no browser com o desfasamento entre `generatedAt` e o relógio local.
- A página só mostra o que o instantâneo traz; "inferido" (fim por handback + silêncio) aparece como "terminou (inferido)".
- Todo o texto vindo do instantâneo é escapado.

## Acessibilidade

Contraste ≥ 4,5:1 em todo o texto (os valores acima foram medidos pelo Frontend Dev nos mocks: 5,4:1–10,6:1 para as cinco cores originais em `--bg`/`--surface`; as quatro identidades a pedido foram calculadas pelo Lead com a fórmula WCAG 2.x e estão na tabela, todas ≥ 7,5:1); foco visível 2 px `--patina`; botões e campos com `label`; estado nunca só por cor; alvos ≥ 44 px no telemóvel; regiões ao vivo não roubam o foco (`aria-live="polite"` só no selo do run e no contador da fila).

## Fazer / não fazer

- Fazer: dez cartões sempre, em duas filas (núcleo / a pedido); instâncias separadas em blocos dentro do cartão do membro; palavra de estado primeiro; motivo do bloqueio visível sem clique; fila do Sponsor com o default aplicado e um campo para responder; "terminou (inferido)" quando o fim veio do handback + silêncio.
- Fazer: linha do tempo curta e legível (hora + frase em português); registo bruto a um clique.
- Fazer: na cena, o Lead ao centro e maior, as dezanove arestas fixas, um glifo de estado por nó e um monograma por nó (secção «Cena: agentes ligados»); as posições são as escritas lá, nunca calculadas por um layout automático.
- Não fazer: mudar uma aresta por causa de um estado; usar a órbita de fora para apagar um estado — um papel a pedido brilha com a mesma intensidade que um de núcleo; escrever nomes, papéis, palavras de estado ou o rótulo «a pedido» dentro da cena (o monograma de duas letras é o único texto permitido, desde 17 set 2026).
- Não fazer: esconder um membro inativo; agregar instâncias em contagens; usar vermelho para identidade; animar o que não está a acontecer; mostrar tokens ou caminhos completos; nomes das ferramentas nativas como se fossem elenco; "recusadas" a seco (é "sem resposta ou recusadas").
- **18 set 2026 — fazer**: um painel por projeto, vários projetos ao mesmo tempo, sem abas; cor de nó = banda de sinal; nome do papel debaixo de cada nó; frases inteiras em português; cinzento para quem entregou.
- **18 set 2026 — não fazer**: identificadores de run/sessão/agente, texto de prompt, caminhos, códigos de task ou nomes de modelo na vista principal (vão para o painel de detalhe, em palavras); esconder um projeto parado; usar vermelho para um trabalho que terminou bem.
- Não fazer: three.js, WebGL, `<canvas>`, SMIL ou animar o que não seja `opacity` (a cena é SVG + CSS, decisão S1; 3D real só se um dia o Sponsor o pedir, é decisão dele). **A proibição antiga de «gráficos de nós e pulsos entre nós» caiu em 17 set 2026**: o grafo é agora a cena, por direção do Sponsor — mas o pulso entre nós continua proibido *exceto* como fluxo de um hand-back recente.
